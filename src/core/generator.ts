/**
 * Generator (PRD §5.3).
 *
 * Turns the approved plan + perception into runnable test code via the adapter,
 * then materializes the specs and Page Object Models to disk so they are real,
 * committable artifacts (not runtime magic). The core owns file materialization;
 * the adapter owns code synthesis.
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  GeneratedTest,
  Logger,
  PerceptionSnapshot,
  TestAdapter,
  TestPlan,
} from '../adapters/adapter.js';

export interface GenerateArgs {
  adapter: TestAdapter;
  plan: TestPlan;
  perception: PerceptionSnapshot;
  workdir: string;
  logger: Logger;
}

/** Generate tests and write them (plus their artifacts) under `workdir`. */
export async function generate(args: GenerateArgs): Promise<GeneratedTest[]> {
  const { adapter, plan, perception, workdir, logger } = args;

  logger.info(`Generating ${plan.scenarios.length} test(s)…`);

  // Clean prior specs/POMs so a re-run's stale files don't get executed.
  for (const dir of ['tests', 'pages']) {
    rmSync(join(workdir, dir), { recursive: true, force: true });
  }

  const tests = await adapter.generate(plan, perception);

  const writtenArtifacts = new Set<string>();
  for (const test of tests) {
    materialize(workdir, test.filePath, test.code);
    for (const art of test.artifacts) {
      // Page Object Models are often shared; write each path once.
      if (writtenArtifacts.has(art.path)) continue;
      writtenArtifacts.add(art.path);
      materialize(workdir, art.path, art.code);
    }
  }

  logger.info(`Wrote ${tests.length} spec(s) + ${writtenArtifacts.size} artifact(s) to ${workdir}`);
  return tests;
}

/** Overwrite a single generated test file on disk (used by the healer). */
export function rewriteTest(workdir: string, test: GeneratedTest): void {
  materialize(workdir, test.filePath, test.code);
}

function materialize(workdir: string, relPath: string, code: string): void {
  const abs = join(workdir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, code, 'utf8');
}
