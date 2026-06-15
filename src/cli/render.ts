/**
 * Terminal rendering for CLI output: the validate PASS/FAIL table and run
 * summaries. No color dependency — plain, CI-log-friendly text.
 */

import type { TargetRunResult } from '../core/orchestrator.js';
import type { TargetConfig } from '../adapters/adapter.js';

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

const STATUS_MARK: Record<TargetRunResult['status'], string> = {
  pass: '✓ PASS',
  fail: '✗ FAIL',
  planned: '• PLAN',
  aborted: '⊘ ABORT',
};

/** Render the aggregate validate table (PRD §8). */
export function renderValidateTable(results: TargetRunResult[]): string {
  const lines: string[] = [];
  const header = `${pad('TARGET', 20)} ${pad('STATUS', 8)} ${pad('SCN', 4)} ${pad('OK', 4)} ${pad('FAIL', 5)} ${pad('FLAKY', 6)} ${pad('HEAL', 5)} NOTES`;
  lines.push(header);
  lines.push('─'.repeat(header.length));
  for (const r of results) {
    lines.push(
      `${pad(r.target, 20)} ${pad(STATUS_MARK[r.status], 8)} ${pad(String(r.scenarioCount), 4)} ` +
        `${pad(String(r.accepted), 4)} ${pad(String(r.failed), 5)} ${pad(String(r.quarantined), 6)} ` +
        `${pad(String(r.healed), 5)} ${r.reasons[0] ?? ''}`,
    );
  }
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  lines.push('─'.repeat(header.length));
  lines.push(`${passed}/${results.length} passed, ${failed} failed`);
  return lines.join('\n');
}

/** Render a single run/plan result block. */
export function renderRunResult(r: TargetRunResult): string {
  const lines: string[] = [];
  lines.push(`\n${STATUS_MARK[r.status]}  ${r.target}`);
  lines.push(
    `  scenarios: ${r.scenarioCount} · accepted: ${r.accepted} · failed: ${r.failed} · ` +
      `quarantined: ${r.quarantined} · healed: ${r.healed}`,
  );
  lines.push(`  cost: ${r.costSummary}`);
  for (const reason of r.reasons) lines.push(`  - ${reason}`);
  if (r.planPath) lines.push(`  plan: ${r.planPath}`);
  return lines.join('\n');
}

/** Render the `ata list` output. */
export function renderTargetList(targets: TargetConfig[]): string {
  if (targets.length === 0) return 'No targets configured. Run `ata config` to add one.';
  const lines: string[] = [];
  const header = `${pad('NAME', 20)} ${pad('ADAPTER', 22)} ${pad('PERCEPTION', 12)} REACH`;
  lines.push(header);
  lines.push('─'.repeat(header.length));
  for (const t of targets) {
    const reach = t.url ?? t.executable ?? t.spec ?? t.app ?? '(n/a)';
    const scope = t.scope?.feature ? `  [scope: ${t.scope.feature}]` : '';
    lines.push(`${pad(t.name, 20)} ${pad(t.adapter, 22)} ${pad(t.perception, 12)} ${reach}${scope}`);
  }
  return lines.join('\n');
}
