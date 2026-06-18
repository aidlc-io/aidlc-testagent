/**
 * Planner (PRD §5.1).
 *
 * Assembles a grounding bundle from the target's context sources in trust order
 * (requirements → manual tests → business → source), combines it with the
 * adapter's live perception, optionally restricts to a scope (feature / diff),
 * and asks the LLM for a structured test plan. Each scenario records what it
 * traces to, so coverage is auditable.
 *
 * Observation (explore) is kept strictly separate from generation: the planner
 * reasons over the structured perception snapshot, never raw pixels.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { PerceptionSnapshot, ScopeConfig, TargetConfig, TestPlan } from '../adapters/adapter.js';
import type { LlmProvider } from './llm/provider.js';
import type { Logger } from '../adapters/adapter.js';
import type { ResolvedConfig } from '../config/loader.js';
import { loadContextBundle, renderContextForPrompt } from '../config/context.js';
import { PLAN_JSON_SCHEMA, parseTestPlan } from './plan-schema.js';

export interface ResolvedScope {
  feature?: string;
  /** Inline requirement text (read from the requirement file). */
  requirementText?: string;
  requirementRef?: string;
  diffBase?: string;
}

const PLANNER_SYSTEM = `You are the PLANNER for aidlc-testagent, an AI test agent.
Your job is to produce a structured end-to-end test plan for a target application.

Rules:
- Treat human-authored intent (requirements > manual test cases > business rules) as HIGHER trust than source code or live exploration. Source/exploration tell you HOW to drive and locate things; requirements tell you WHAT must be true.
- If intent and the observed implementation disagree, surface that as a scenario/outOfScope note rather than silently trusting the code.
- Cover meaningful user flows: setup/auth, smoke, core flows, edge/negative, teardown. Not every stage is required.
- Each scenario MUST record what it traces to (a requirement / manual_test / business rule / source / exploration) for auditability.
- Be concrete and runnable: steps should reference real, observed UI elements or endpoints.
- Respond ONLY with JSON conforming to the provided schema. No prose outside the JSON.`;

export interface PlanArgs {
  cfg: ResolvedConfig;
  target: TargetConfig;
  perception: PerceptionSnapshot;
  llm: LlmProvider;
  logger: Logger;
  scope?: ResolvedScope;
  minScenarios: number;
  generatedAt: string;
}

/** Resolve the effective scope from the target config + CLI overrides. */
export function resolveScope(
  cfg: ResolvedConfig,
  target: TargetConfig,
  overrides: { feature?: string; requirementFile?: string; diffBase?: string } = {},
): ResolvedScope | undefined {
  const declared: ScopeConfig | undefined = target.scope;
  const feature = overrides.feature ?? declared?.feature;
  const reqFile = overrides.requirementFile ?? declared?.requirement;
  const diffBase = overrides.diffBase ?? declared?.diff;

  if (!feature && !reqFile && !diffBase) return undefined;

  let requirementText: string | undefined;
  let requirementRef: string | undefined;
  if (reqFile) {
    const abs = isAbsolute(reqFile) ? reqFile : resolve(cfg.baseDir, reqFile);
    try {
      requirementText = readFileSync(abs, 'utf8');
      requirementRef = reqFile;
    } catch {
      throw new Error(`scope requirement file not found: ${reqFile}`);
    }
  }
  return { feature, requirementText, requirementRef, diffBase };
}

function renderSingleSnapshot(p: PerceptionSnapshot, tokenBudget = 12_000): string {
  const parts: string[] = [];
  if (p.url) parts.push(`URL: ${p.url}`);
  if (p.title) parts.push(`Title: ${p.title}`);
  if (p.accessibilityTree) {
    parts.push(`Accessibility tree:\n${p.accessibilityTree.slice(0, tokenBudget)}`);
  } else if (p.domSummary) {
    parts.push(`DOM summary:\n${p.domSummary.slice(0, tokenBudget)}`);
  }
  if (p.elements?.length) {
    const els = p.elements
      .slice(0, 80)
      .map((e) => `- ${e.role}${e.name ? ` "${e.name}"` : ''}${e.selector ? ` [${e.selector}]` : ''}`)
      .join('\n');
    parts.push(`Key elements:\n${els}`);
  }
  if (p.endpoints?.length) {
    parts.push(
      `Endpoints:\n${p.endpoints.map((e) => `- ${e.method} ${e.path}${e.summary ? ` — ${e.summary}` : ''}`).join('\n')}`,
    );
  }
  if (p.notes?.length) parts.push(`Notes:\n${p.notes.map((n) => `- ${n}`).join('\n')}`);
  return parts.join('\n');
}

function renderPerception(p: PerceptionSnapshot): string {
  // Manual explore: render each step so the planner sees the full journey and
  // can infer preconditions (e.g. "step 2 requires auth from step 1").
  if (p.steps?.length) {
    const perStepBudget = Math.floor(8_000 / p.steps.length);
    const lines = [
      `Target: ${p.target} (${p.kind})`,
      `Manual exploration session — ${p.steps.length} step(s) recorded:`,
    ];
    for (const [i, step] of p.steps.entries()) {
      lines.push(`\n--- Step ${i + 1} ---`);
      lines.push(renderSingleSnapshot(step, perStepBudget));
    }
    return lines.join('\n');
  }

  // Auto explore: single snapshot (original behaviour).
  return [`Target: ${p.target} (${p.kind})`, renderSingleSnapshot(p)].join('\n');
}

function renderScope(scope: ResolvedScope | undefined): string {
  if (!scope) return 'SCOPE: whole target — cover all meaningful flows.';
  const lines = ['SCOPE: restrict the plan to the following:'];
  if (scope.feature) lines.push(`- Feature: ${scope.feature}`);
  if (scope.diffBase) lines.push(`- Only flows near changes since git ref "${scope.diffBase}" (best effort).`);
  if (scope.requirementText) {
    lines.push(`- Requirement (authoritative for this scope), from ${scope.requirementRef}:`);
    lines.push(scope.requirementText.slice(0, 8_000));
  }
  lines.push('Do NOT plan scenarios outside this scope; list anything skipped under outOfScope.');
  return lines.join('\n');
}

/** Produce a validated {@link TestPlan} for the target. */
export async function plan(args: PlanArgs): Promise<TestPlan> {
  const { cfg, target, perception, llm, logger, scope, minScenarios, generatedAt } = args;

  const bundle = loadContextBundle(cfg, target);
  logger.debug(`Grounding docs: ${bundle.docs.length} (${bundle.hasGrounding ? 'grounded' : 'exploration-only'})`);

  const prompt = [
    `# Target to plan: ${target.name} (adapter: ${target.adapter})`,
    '',
    '## Grounding context (trust order: intent before implementation)',
    renderContextForPrompt(bundle),
    '',
    '## Live perception (how to drive & locate — lowest trust)',
    renderPerception(perception),
    '',
    `## ${renderScope(scope)}`,
    '',
    `## Requirements for the plan`,
    `- Produce AT LEAST ${minScenarios} distinct scenarios.`,
    `- Order scenarios by dependency (auth/setup first).`,
    `- Prefer UI layer for ${target.adapter.startsWith('playwright') ? 'this UI target' : 'interactive flows'}.`,
    `- Return JSON only, matching the schema.`,
  ].join('\n');

  logger.info('Planning…');
  const res = await llm.complete({
    system: PLANNER_SYSTEM,
    prompt,
    schema: PLAN_JSON_SCHEMA,
  });

  const testPlan = parseTestPlan(target.name, res.text, generatedAt);
  logger.info(`Planned ${testPlan.scenarios.length} scenario(s) across ${testPlan.stages.length} stage(s).`);
  return testPlan;
}
