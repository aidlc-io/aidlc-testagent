/**
 * Plan I/O for the `--plan` path (PRD §5.2, §11).
 *
 * `plan.md` is the human-readable, editable artifact; `plan.json` is the
 * machine form the generator consumes. `--plan` accepts either: a `.json` plan
 * is loaded directly; a `.md` resolves to its sibling `.json`. (Round-tripping
 * free-form Markdown back into structure is intentionally avoided — edit the
 * structure-bearing fields and the agent regenerates from the approved plan.)
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { TestPlan } from '../adapters/adapter.js';

const planSchema = z.object({
  target: z.string(),
  summary: z.string(),
  stages: z.array(
    z.object({ id: z.string(), title: z.string(), scenarioIds: z.array(z.string()) }),
  ),
  scenarios: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string().optional(),
      stage: z.enum(['setup', 'smoke', 'core', 'edge', 'teardown']),
      layer: z.enum(['ui', 'api']),
      priority: z.enum(['p0', 'p1', 'p2']),
      tracesTo: z.array(z.object({ kind: z.string(), ref: z.string() })),
      dependsOn: z.array(z.string()),
      steps: z.array(z.string()),
    }),
  ),
  outOfScope: z.array(z.string()),
  generatedAt: z.string(),
});

export function loadPlanFromFile(planPath: string, expectedTarget: string): TestPlan {
  const abs = isAbsolute(planPath) ? planPath : resolve(process.cwd(), planPath);
  const jsonPath = abs.endsWith('.json') ? abs : abs.replace(/\.md$/, '.json');

  if (!existsSync(jsonPath)) {
    throw new Error(
      `--plan: could not find a machine plan at ${jsonPath}. ` +
        `Pass the plan.json (or its sibling plan.md) produced by a previous \`ata plan\`/\`ata run\`.`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    throw new Error(`--plan: malformed JSON in ${jsonPath}: ${(e as Error).message}`);
  }

  const parsed = planSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`--plan: ${jsonPath} is not a valid plan:\n${issues}`);
  }
  const plan = parsed.data as TestPlan;
  if (plan.target !== expectedTarget) {
    throw new Error(`--plan: plan is for target "${plan.target}" but you ran "${expectedTarget}".`);
  }
  return plan;
}
