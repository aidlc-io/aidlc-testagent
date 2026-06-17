/**
 * Generator (PRD §5.3).
 *
 * Turns the approved plan + perception into runnable test code via the adapter,
 * then materializes the specs and Page Object Models to disk so they are real,
 * committable artifacts (not runtime magic). The core owns file materialization;
 * the adapter owns code synthesis.
 */

import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
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
  /** When set, spec files (*.spec.ts) are written here instead of workdir/tests.
   *  Artifacts (POMs) still go to workdir. The returned test.filePath values are
   *  updated to absolute paths so the runner can locate them. */
  outputDir?: string;
  logger: Logger;
}

/** Generate tests and write them (plus their artifacts) under `workdir`. */
export async function generate(args: GenerateArgs): Promise<GeneratedTest[]> {
  const { adapter, plan, perception, workdir, outputDir, logger } = args;

  logger.info(`Generating ${plan.scenarios.length} test(s)…`);

  // Clean prior specs so a re-run's stale files don't get executed.
  if (outputDir) {
    rmSync(outputDir, { recursive: true, force: true });
    mkdirSync(outputDir, { recursive: true });
  } else {
    for (const dir of ['tests', 'pages']) {
      rmSync(join(workdir, dir), { recursive: true, force: true });
    }
  }

  const tests = await adapter.generate(plan, perception);

  const writtenArtifacts = new Set<string>();
  const result: GeneratedTest[] = [];
  for (const test of tests) {
    let specPath: string;
    if (outputDir) {
      // Write spec to the external output dir; update filePath to absolute so
      // the runner's sameFile() match works against the playwright report.
      specPath = join(outputDir, basename(test.filePath));
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(specPath, test.code, 'utf8');
      result.push({ ...test, filePath: specPath });
    } else {
      materialize(workdir, test.filePath, test.code);
      result.push(test);
    }
    for (const art of test.artifacts) {
      // Page Object Models are often shared; write each path once.
      if (writtenArtifacts.has(art.path)) continue;
      writtenArtifacts.add(art.path);
      materialize(workdir, art.path, art.code);
    }
  }

  const specLocation = outputDir ?? workdir;
  logger.info(`Wrote ${result.length} spec(s) + ${writtenArtifacts.size} artifact(s) to ${specLocation}`);
  return result;
}

/** Check whether a specs directory already has materialized spec files. */
export function hasExistingSpecs(specsDir: string): boolean {
  if (!existsSync(specsDir)) return false;
  try {
    return readdirSync(specsDir).some((f) => f.endsWith('.spec.ts'));
  } catch {
    return false;
  }
}

/** Load already-written spec files from disk (used by --reuse mode). */
export function loadExistingSpecs(specsDir: string, absolutePaths: boolean): GeneratedTest[] {
  if (!existsSync(specsDir)) return [];
  const files = readdirSync(specsDir).filter((f) => f.endsWith('.spec.ts'));
  return files.map((file) => {
    const absPath = join(specsDir, file);
    return {
      scenarioId: file.replace('.spec.ts', ''),
      name: file.replace('.spec.ts', '').replace(/-/g, ' '),
      filePath: absolutePaths ? absPath : join('tests', file),
      code: readFileSync(absPath, 'utf8'),
      layer: 'ui' as const,
      artifacts: [],
    };
  });
}

/** Overwrite a single generated test file on disk (used by the healer). */
export function rewriteTest(workdir: string, test: GeneratedTest): void {
  if (isAbsolute(test.filePath)) {
    // Spec was written to an external outputDir — write directly.
    mkdirSync(dirname(test.filePath), { recursive: true });
    writeFileSync(test.filePath, test.code, 'utf8');
  } else {
    materialize(workdir, test.filePath, test.code);
  }
}

function materialize(workdir: string, relPath: string, code: string): void {
  const abs = join(workdir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, code, 'utf8');
}
