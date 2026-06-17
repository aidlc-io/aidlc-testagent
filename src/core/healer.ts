/**
 * Healer (PRD §5.5).
 *
 * On failure, feeds failure context (the failing spec + its error + supporting
 * artifacts) back to the LLM to repair selectors / assertions / timing, rewrites
 * the spec, and re-runs through the stability gate — up to `max_heal_attempts`.
 */

import { isAbsolute, join } from 'node:path';
import { readFileSync } from 'node:fs';
import type {
  ExecOpts,
  GeneratedTest,
  Logger,
  PerceptionSnapshot,
  SessionState,
  TestAdapter,
  TestRunResult,
} from '../adapters/adapter.js';
import type { LlmProvider } from './llm/provider.js';
import { rewriteTest } from './generator.js';

const HEAL_SYSTEM = `You are the HEALER for aidlc-testagent.
A generated Playwright test failed. Repair it so it passes, fixing selectors, assertions, waits/timing, or imports.
Keep the test's INTENT identical — do not weaken assertions just to make it pass.
Prefer robust, role/test-id based locators over brittle CSS/XPath.
Return JSON: { "code": "<full corrected spec file contents>", "rationale": "<one line>" }.`;

const HEAL_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['code'],
  properties: {
    code: { type: 'string', description: 'The full corrected spec file contents.' },
    rationale: { type: 'string' },
  },
};

export interface HealArgs {
  adapter: TestAdapter;
  llm: LlmProvider;
  perception: PerceptionSnapshot;
  failing: TestRunResult[];
  maxAttempts: number;
  workdir: string;
  outputDir?: string;
  runs: number;
  timeoutMs: number;
  session?: SessionState;
  logger: Logger;
}

export interface HealResult {
  healed: TestRunResult[];
  stillFailing: TestRunResult[];
  attemptsUsed: number;
}

export async function heal(args: HealArgs): Promise<HealResult> {
  const { adapter, llm, perception, maxAttempts, workdir, runs, timeoutMs, session, logger } = args;

  const healed: TestRunResult[] = [];
  let pending = [...args.failing];
  let attemptsUsed = 0;

  if (maxAttempts <= 0 || pending.length === 0) {
    return { healed, stillFailing: pending, attemptsUsed };
  }

  for (let attempt = 1; attempt <= maxAttempts && pending.length > 0; attempt++) {
    attemptsUsed = attempt;
    logger.info(`Healing attempt ${attempt}/${maxAttempts} for ${pending.length} test(s)…`);

    const repaired: GeneratedTest[] = [];
    for (const failure of pending) {
      const newCode = await repairOne(llm, perception, failure, workdir, logger);
      if (!newCode) continue;
      const updated: GeneratedTest = { ...failure.test, code: newCode };
      rewriteTest(workdir, updated);
      repaired.push(updated);
    }

    if (repaired.length === 0) break;

    const opts: ExecOpts = { runs, timeoutMs, workdir, outputDir: args.outputDir, session };
    const result = await adapter.execute(repaired, opts);

    // Anything that now passes the stability gate is healed.
    const nowPassingIds = new Set(result.passed.map((r) => r.test.scenarioId));
    healed.push(...result.passed);

    // Carry forward whatever still fails (or went flaky).
    const stillBad = [...result.failed, ...result.quarantined];
    pending = pending
      .filter((p) => !nowPassingIds.has(p.test.scenarioId))
      .map((p) => stillBad.find((b) => b.test.scenarioId === p.test.scenarioId) ?? p);

    logger.info(`After attempt ${attempt}: ${healed.length} healed, ${pending.length} still failing.`);
  }

  return { healed, stillFailing: pending, attemptsUsed };
}

async function repairOne(
  llm: LlmProvider,
  perception: PerceptionSnapshot,
  failure: TestRunResult,
  workdir: string,
  logger: Logger,
): Promise<string | undefined> {
  // Prefer the on-disk content (it may have been healed already this run).
  let currentCode = failure.test.code;
  try {
    const absPath = isAbsolute(failure.test.filePath)
      ? failure.test.filePath
      : join(workdir, failure.test.filePath);
    currentCode = readFileSync(absPath, 'utf8');
  } catch {
    /* fall back to in-memory code */
  }

  const errorText =
    failure.error ?? failure.runs.find((r) => !r.ok)?.error ?? 'unknown failure (no error captured)';

  const prompt = [
    `# Failing test: ${failure.test.name} (${failure.test.filePath})`,
    '',
    '## Failure output',
    '```',
    errorText.slice(0, 6_000),
    '```',
    '',
    '## Current spec',
    '```ts',
    currentCode,
    '```',
    '',
    '## Observed elements (for correct locators)',
    (perception.elements ?? [])
      .slice(0, 60)
      .map((e) => `- ${e.role}${e.name ? ` "${e.name}"` : ''}${e.selector ? ` [${e.selector}]` : ''}`)
      .join('\n') || '(none captured)',
    '',
    'Return the corrected full spec as JSON per the schema.',
  ].join('\n');

  try {
    const res = await llm.complete({ system: HEAL_SYSTEM, prompt, schema: HEAL_JSON_SCHEMA });
    const parsed = JSON.parse(extractJson(res.text)) as { code?: string; rationale?: string };
    if (typeof parsed.code === 'string' && parsed.code.trim().length > 0) {
      if (parsed.rationale) logger.debug(`Heal "${failure.test.name}": ${parsed.rationale}`);
      return parsed.code;
    }
  } catch (e) {
    logger.warn(`Heal failed to produce code for ${failure.test.name}: ${(e as Error).message}`);
  }
  return undefined;
}

function extractJson(text: string): string {
  const t = text.trim();
  if (t.startsWith('{')) return t;
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  return start >= 0 && end > start ? t.slice(start, end + 1) : t;
}
