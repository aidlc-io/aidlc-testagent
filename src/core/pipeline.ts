/**
 * Proposed pipeline + confirmation gate (PRD §5.2, §11).
 *
 * Renders the plan as a staged pipeline table, writes `generated/<target>/plan.md`,
 * and gates generation on approval. Approval honors `approval` (prompt | auto |
 * manual-edit) plus `--yes`/`--plan`, and auto-approves in non-TTY/CI so
 * pipelines never hang on stdin.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as clack from '@clack/prompts';
import type { Logger, TestPlan } from '../adapters/adapter.js';

export type ApprovalMode = 'prompt' | 'auto' | 'manual-edit';

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

/** Render the plan as a printable pipeline table. */
export function renderPlanTable(plan: TestPlan): string {
  const lines: string[] = [];
  lines.push(`Proposed pipeline for "${plan.target}" — ${plan.scenarios.length} scenario(s)`);
  lines.push('');
  const header = `${pad('STAGE', 10)} ${pad('ID', 22)} ${pad('LAYER', 6)} ${pad('PRI', 4)} ${pad('TRACES TO', 28)} TITLE`;
  lines.push(header);
  lines.push('-'.repeat(header.length));
  for (const stage of plan.stages) {
    for (const id of stage.scenarioIds) {
      const s = plan.scenarios.find((x) => x.id === id);
      if (!s) continue;
      const traces = s.tracesTo.map((t) => `${t.kind}:${t.ref}`).join(', ');
      const deps = s.dependsOn.length ? ` (deps: ${s.dependsOn.join(', ')})` : '';
      lines.push(
        `${pad(stage.id, 10)} ${pad(s.id, 22)} ${pad(s.layer, 6)} ${pad(s.priority, 4)} ${pad(traces, 28)} ${s.title}${deps}`,
      );
    }
  }
  if (plan.outOfScope.length) {
    lines.push('');
    lines.push('Out of scope / not covered:');
    for (const o of plan.outOfScope) lines.push(`  - ${o}`);
  }
  return lines.join('\n');
}

/** Render the full plan as Markdown for `plan.md` (the human-editable artifact). */
export function planToMarkdown(plan: TestPlan): string {
  const md: string[] = [];
  md.push(`# Test plan — ${plan.target}`);
  md.push('');
  md.push(`_Generated ${plan.generatedAt}. Edit this file and re-run with \`--plan <this file>\` to regenerate from an approved plan._`);
  md.push('');
  md.push(`## Summary`);
  md.push(plan.summary);
  md.push('');
  for (const stage of plan.stages) {
    md.push(`## ${stage.title} (\`${stage.id}\`)`);
    for (const id of stage.scenarioIds) {
      const s = plan.scenarios.find((x) => x.id === id);
      if (!s) continue;
      md.push(`### ${s.title}  \`${s.id}\``);
      md.push(`- **Layer:** ${s.layer} · **Priority:** ${s.priority}`);
      if (s.dependsOn.length) md.push(`- **Depends on:** ${s.dependsOn.join(', ')}`);
      md.push(`- **Traces to:** ${s.tracesTo.map((t) => `${t.kind}:\`${t.ref}\``).join(', ')}`);
      if (s.description) md.push(`- ${s.description}`);
      if (s.steps.length) {
        md.push(`- **Steps:**`);
        s.steps.forEach((step, i) => md.push(`  ${i + 1}. ${step}`));
      }
      md.push('');
    }
  }
  if (plan.outOfScope.length) {
    md.push(`## Out of scope / not covered`);
    for (const o of plan.outOfScope) md.push(`- ${o}`);
    md.push('');
  }
  return md.join('\n');
}

/** Write `plan.md` for the target, creating parent dirs. Returns the path. */
export function writePlanMarkdown(plan: TestPlan, planPath: string): string {
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, planToMarkdown(plan), 'utf8');
  return planPath;
}

export interface ConfirmArgs {
  plan: TestPlan;
  approval: ApprovalMode;
  /** `--yes`: approve without prompting. */
  yes: boolean;
  /** True when an edited plan was explicitly supplied via `--plan`. */
  fromEditedPlan?: boolean;
  isTty: boolean;
  isCi: boolean;
  logger: Logger;
  planPath: string;
}

export interface ConfirmResult {
  approved: boolean;
  reason: string;
}

/**
 * The confirmation gate. Returns whether generation may proceed. Prints the
 * table first; the caller has already written plan.md.
 */
export async function confirmPlan(args: ConfirmArgs): Promise<ConfirmResult> {
  const { approval, yes, fromEditedPlan, isTty, isCi, logger, planPath } = args;

  console.error('\n' + renderPlanTable(args.plan) + '\n');
  logger.info(`Wrote plan: ${planPath}`);

  // An explicitly supplied, edited plan is already approved.
  if (fromEditedPlan) return { approved: true, reason: 'edited plan supplied via --plan' };

  // CI / non-interactive always auto-approves so it never hangs on stdin.
  if (isCi || !isTty) return { approved: true, reason: 'non-interactive (CI/non-TTY) auto-approve' };

  if (yes || approval === 'auto') return { approved: true, reason: yes ? '--yes' : 'approval: auto' };

  if (approval === 'manual-edit') {
    logger.warn(
      `approval: manual-edit — review/edit ${planPath}, then re-run with \`--plan ${planPath}\` to generate.`,
    );
    return { approved: false, reason: 'manual-edit: awaiting edited plan' };
  }

  // approval: prompt — ask interactively.
  const answer = await clack.confirm({
    message: 'Approve this pipeline and generate tests?',
    initialValue: true,
  });
  if (clack.isCancel(answer) || answer === false) {
    return { approved: false, reason: 'declined at prompt' };
  }
  return { approved: true, reason: 'approved at prompt' };
}
