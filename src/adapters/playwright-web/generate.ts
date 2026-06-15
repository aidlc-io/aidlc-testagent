/**
 * Test generation (shared by playwright-web and playwright-electron).
 *
 * Converts the approved plan + structured perception into real, committable
 * `@playwright/test` specs with Page Object Models. The generator reasons only
 * over the plan and the perception snapshot — never raw pixels (PRD §5).
 */

import type {
  GeneratedTest,
  Logger,
  PerceptionSnapshot,
  TargetConfig,
  TestPlan,
} from '../adapter.js';
import type { LlmProvider } from '../../core/llm/provider.js';
import { classifyStep, resolveGuardrails } from '../guardrails.js';

const GENERATOR_SYSTEM = `You are the GENERATOR for aidlc-testagent.
Convert an approved test plan into runnable @playwright/test specs with Page Object Models (POMs).

Hard rules:
- Use ONLY @playwright/test ("import { test, expect } from '@playwright/test'").
- Use role/label/test-id based locators (getByRole, getByLabel, getByTestId, getByText). Avoid brittle CSS/XPath.
- Do NOT write login/auth code: an authenticated session is injected via storageState. Navigate with relative paths (page.goto('/...')); baseURL is configured.
- Put POMs under "pages/" and specs under "tests/". One spec file per scenario.
- Specs must be self-contained, deterministic, and assert real, observable outcomes from the plan steps.
- Each scenario's spec file imports any POM it needs by relative path.
- Return JSON only, matching the schema. The "code" fields are complete file contents.`;

const GEN_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['files'],
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scenarioId', 'name', 'filePath', 'layer', 'code'],
        properties: {
          scenarioId: { type: 'string' },
          name: { type: 'string' },
          filePath: { type: 'string', description: 'Relative path, e.g. tests/login-valid.spec.ts' },
          layer: { type: 'string', enum: ['ui', 'api'] },
          code: { type: 'string', description: 'Full spec file contents.' },
          artifacts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'code'],
              properties: {
                path: { type: 'string', description: 'Relative path, e.g. pages/LoginPage.ts' },
                code: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
};

interface GenFile {
  scenarioId: string;
  name: string;
  filePath: string;
  layer: 'ui' | 'api';
  code: string;
  artifacts?: { path: string; code: string }[];
}

/** Keep generated paths inside the workdir (no absolute paths, no `..`). */
function sanitizeRelPath(p: string): string {
  const cleaned = p.replace(/^[/\\]+/, '').replace(/\.\.[/\\]/g, '');
  return cleaned || 'tests/test.spec.ts';
}

export interface GenerateDeps {
  llm: LlmProvider;
  logger: Logger;
  target: TargetConfig;
  /** Surface-specific guidance appended to the prompt. Lets web and Electron
   *  share this generator while emitting correct page-acquisition code. */
  surfaceGuide?: string;
}

export async function generateTests(
  deps: GenerateDeps,
  plan: TestPlan,
  perception: PerceptionSnapshot,
): Promise<GeneratedTest[]> {
  const { llm, logger, target } = deps;
  const guardrails = resolveGuardrails(target.guardrails);

  // Phase-1 guardrail stub: drop scenarios whose steps are destructive when the
  // policy is "block"; annotate them when "confirm".
  const scenarios = plan.scenarios.filter((s) => {
    const decisions = s.steps.map((step) => classifyStep(step, guardrails));
    if (decisions.includes('block')) {
      logger.warn(`Guardrail blocked destructive scenario "${s.id}" (onDestructive: block).`);
      return false;
    }
    return true;
  });

  const elementList = (perception.elements ?? [])
    .slice(0, 100)
    .map((e) => `- ${e.role}${e.name ? ` "${e.name}"` : ''}${e.selector ? ` [${e.selector}]` : ''}`)
    .join('\n');

  // Generate ONE spec per LLM call: a single call emitting many full spec files
  // easily exceeds the model's max output tokens (truncating the JSON) and the
  // call timeout. Per-scenario calls stay bounded, and we run them with limited
  // concurrency to keep wall-clock reasonable.
  const CONCURRENCY = 4;
  const treeSnippet = (perception.accessibilityTree ?? '(none)').slice(0, 6_000);

  logger.info(`Generating ${scenarios.length} spec(s) via ${llm.id} (concurrency ${CONCURRENCY})…`);

  const buildPrompt = (s: (typeof scenarios)[number]): string => {
    const guard = s.steps.some((step) => classifyStep(step, guardrails) === 'confirm')
      ? ' (NOTE: contains a destructive step — add a code comment flagging it; do not perform irreversible actions if avoidable)'
      : '';
    const scenarioBlock = [
      `### ${s.id} — ${s.title} [${s.layer}/${s.priority}]${guard}`,
      s.description ?? '',
      s.steps.length ? `Steps:\n${s.steps.map((x, i) => `  ${i + 1}. ${x}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    return [
      `# Generate ONE Playwright spec for: ${target.name} (${target.adapter})`,
      target.url ? `Base URL: ${target.url}` : '',
      `Accessibility tree:\n${treeSnippet}`,
      '',
      `## Observed elements (use these for locators)`,
      elementList || '(none captured)',
      '',
      deps.surfaceGuide ? `## Surface-specific guidance\n${deps.surfaceGuide}` : '',
      '',
      `## Scenario to generate (one self-contained spec file; keep helpers inline; no shared POMs)`,
      scenarioBlock,
      '',
      `Return JSON per the schema with EXACTLY ONE file for this scenario.`,
    ]
      .filter(Boolean)
      .join('\n');
  };

  const generateOne = async (s: (typeof scenarios)[number]): Promise<GenFile[]> => {
    const res = await llm.complete({ system: GENERATOR_SYSTEM, prompt: buildPrompt(s), schema: GEN_JSON_SCHEMA });
    try {
      const parsed = JSON.parse(extractJson(res.text)) as { files?: GenFile[] };
      return parsed.files ?? [];
    } catch (e) {
      logger.warn(`Generator returned non-JSON for "${s.id}": ${(e as Error).message}`);
      return [];
    }
  };

  // Simple bounded-concurrency pool that preserves scenario order.
  const files: GenFile[] = [];
  const results: GenFile[][] = new Array(scenarios.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= scenarios.length) return;
      results[i] = await generateOne(scenarios[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, scenarios.length) }, () => worker()));
  for (const r of results) if (r) files.push(...r);

  if (files.length === 0) {
    throw new Error('Generator produced no test files.');
  }

  const seenPaths = new Set<string>();
  return files.map((f) => {
    let filePath = sanitizeRelPath(f.filePath);
    if (!/\.spec\.(t|j)s$/.test(filePath)) filePath = filePath.replace(/\.(t|j)s$/, '') + '.spec.ts';
    while (seenPaths.has(filePath)) filePath = filePath.replace(/\.spec\.ts$/, '') + '-1.spec.ts';
    seenPaths.add(filePath);
    return {
      scenarioId: f.scenarioId,
      name: f.name,
      filePath,
      layer: f.layer,
      code: f.code,
      artifacts: (f.artifacts ?? []).map((a) => ({ path: sanitizeRelPath(a.path), code: a.code })),
    };
  });
}

function extractJson(text: string): string {
  const t = text.trim();
  if (t.startsWith('{')) return t;
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  return start >= 0 && end > start ? t.slice(start, end + 1) : t;
}
