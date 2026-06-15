/**
 * The plan output contract shared by the LLM (`--json-schema`) and the parser.
 *
 * The model returns a flat list of scenarios; the planner derives the staged
 * pipeline (setup → smoke → core → edge → teardown) from them. Keeping the
 * model's output shape small makes structured generation reliable.
 */

import { z } from 'zod';
import type {
  PlanStage,
  PlanStageId,
  TestPlan,
  TraceRef,
} from '../adapters/adapter.js';

/** JSON Schema handed to the LLM CLI via `--json-schema`. */
export const PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'scenarios', 'outOfScope'],
  properties: {
    summary: { type: 'string', description: 'One-paragraph overview of the test plan.' },
    scenarios: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'stage', 'layer', 'priority', 'tracesTo', 'dependsOn', 'steps'],
        properties: {
          id: { type: 'string', description: 'kebab-case unique id, e.g. "login-valid".' },
          title: { type: 'string' },
          description: { type: 'string' },
          stage: { type: 'string', enum: ['setup', 'smoke', 'core', 'edge', 'teardown'] },
          layer: { type: 'string', enum: ['ui', 'api'] },
          priority: { type: 'string', enum: ['p0', 'p1', 'p2'] },
          tracesTo: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'ref'],
              properties: {
                kind: {
                  type: 'string',
                  enum: ['requirement', 'manual_test', 'business', 'source', 'exploration'],
                },
                ref: { type: 'string', description: 'File path or short label of the source.' },
              },
            },
          },
          dependsOn: { type: 'array', items: { type: 'string' } },
          steps: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    outOfScope: {
      type: 'array',
      items: { type: 'string' },
      description: 'Things deliberately NOT covered, surfaced for transparency.',
    },
  },
};

const traceRefSchema = z.object({
  kind: z.enum(['requirement', 'manual_test', 'business', 'source', 'exploration']),
  ref: z.string(),
});

const scenarioSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  stage: z.enum(['setup', 'smoke', 'core', 'edge', 'teardown']),
  layer: z.enum(['ui', 'api']),
  priority: z.enum(['p0', 'p1', 'p2']),
  tracesTo: z.array(traceRefSchema).default([]),
  dependsOn: z.array(z.string()).default([]),
  steps: z.array(z.string()).default([]),
});

export const planOutputSchema = z.object({
  summary: z.string(),
  scenarios: z.array(scenarioSchema),
  outOfScope: z.array(z.string()).default([]),
});

export type PlanOutput = z.infer<typeof planOutputSchema>;

const STAGE_ORDER: PlanStageId[] = ['setup', 'smoke', 'core', 'edge', 'teardown'];
const STAGE_TITLES: Record<PlanStageId, string> = {
  setup: 'Setup / Auth',
  smoke: 'Smoke',
  core: 'Core Flows',
  edge: 'Edge / Negative',
  teardown: 'Teardown',
};

/**
 * Parse + validate raw LLM text into a structured {@link TestPlan}, deriving the
 * staged pipeline from the scenario list. Throws on malformed model output.
 */
export function parseTestPlan(target: string, rawText: string, generatedAt: string): TestPlan {
  let json: unknown;
  try {
    json = JSON.parse(extractJson(rawText));
  } catch (e) {
    throw new Error(`Planner returned non-JSON output: ${(e as Error).message}\n${rawText.slice(0, 500)}`);
  }
  const parsed = planOutputSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Planner output failed validation:\n${issues}`);
  }
  const out = parsed.data;

  // Ensure scenario ids are unique; de-dupe defensively.
  const seen = new Set<string>();
  const scenarios = out.scenarios.map((s, idx) => {
    let id = s.id;
    if (seen.has(id)) id = `${id}-${idx}`;
    seen.add(id);
    const tracesTo: TraceRef[] = s.tracesTo.length
      ? s.tracesTo
      : [{ kind: 'exploration', ref: 'live exploration' }];
    return { ...s, id, tracesTo };
  });

  const stages: PlanStage[] = STAGE_ORDER.map((id) => ({
    id,
    title: STAGE_TITLES[id],
    scenarioIds: scenarios.filter((s) => s.stage === id).map((s) => s.id),
  })).filter((stage) => stage.scenarioIds.length > 0);

  return {
    target,
    summary: out.summary,
    stages,
    scenarios,
    outOfScope: out.outOfScope,
    generatedAt,
  };
}

/** Pull the first balanced JSON object out of text, tolerating prose wrappers. */
function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}
