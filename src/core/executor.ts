/**
 * Executor + stability gate (PRD §5.4).
 *
 * Runs the generated suite through the adapter. Each new test is run N times
 * (`stability.runs`); only tests that pass ALL N runs are accepted. Flaky tests
 * (mixed results) are quarantined — kept OUT of the green suite and reported
 * separately — rather than allowed to rot it. The adapter performs the actual
 * runs; this module owns the policy (runs count, quarantine) and reporting.
 */

import type {
  ExecutionResult,
  GeneratedTest,
  Logger,
  SessionState,
  TestAdapter,
} from '../adapters/adapter.js';

export interface ExecuteArgs {
  adapter: TestAdapter;
  tests: GeneratedTest[];
  workdir: string;
  runs: number;
  timeoutMs: number;
  quarantine: boolean;
  session?: SessionState;
  headed?: boolean;
  logger: Logger;
}

export async function execute(args: ExecuteArgs): Promise<ExecutionResult> {
  const { adapter, tests, workdir, runs, timeoutMs, quarantine, session, headed, logger } = args;

  if (tests.length === 0) {
    return { passed: [], failed: [], quarantined: [], total: 0 };
  }

  logger.info(`Executing ${tests.length} test(s), ${runs} run(s) each (stability gate)…`);
  const result = await adapter.execute(tests, {
    runs,
    timeoutMs,
    workdir,
    session,
    headed,
  });

  // If quarantine is disabled, flaky tests are treated as failures.
  if (!quarantine && result.quarantined.length > 0) {
    result.failed.push(...result.quarantined);
    result.quarantined = [];
  }

  logger.info(
    `Stability gate: ${result.passed.length} passed, ${result.failed.length} failed, ${result.quarantined.length} quarantined (flaky).`,
  );
  for (const q of result.quarantined) {
    logger.warn(`Quarantined (flaky): ${q.test.name} — ${describeRuns(q)}`);
  }
  return result;
}

function describeRuns(r: { runs: { ok: boolean }[] }): string {
  const ok = r.runs.filter((x) => x.ok).length;
  return `${ok}/${r.runs.length} runs passed`;
}
