/**
 * Orchestrator (PRD §5) — the one shared agent loop, surface-agnostic.
 *
 *   explore → plan → [CONFIRM gate] → generate → execute (+stability) → heal
 *
 * It talks only to the adapter contract and the LlmProvider interface; it never
 * imports Playwright. The cost guard meters every LLM call and aborts a run that
 * exceeds the budget. A target PASSES per PRD §8.
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  ExploreUseCase,
  ExecutionResult,
  Logger,
  PerceptionSnapshot,
  TargetConfig,
  TestAdapter,
  TestPlan,
  TestRunResult,
} from '../adapters/adapter.js';
import type { ResolvedConfig } from '../config/loader.js';
import { resolveFromBase } from '../config/loader.js';
import type { LlmProvider } from './llm/provider.js';
import { CostGuard, BudgetExceededError, meteredProvider } from './budget.js';
import { createAdapter } from '../adapters/index.js';
import { sessionStatePath, ensureSession } from '../auth/index.js';
import { plan as planTarget, resolveScope } from './planner.js';
import { confirmPlan, writePlanMarkdown, type ApprovalMode } from './pipeline.js';
import { generate, hasExistingSpecs, loadExistingSpecs } from './generator.js';
import { execute } from './executor.js';
import { heal } from './healer.js';
import { loadPlanFromFile } from './plan-io.js';

export type RunMode = 'plan' | 'run';

export interface RunOptions {
  mode: RunMode;
  /** Generate but skip execution. */
  dryRun?: boolean;
  /** Skip plan + generate if spec files already exist under the target's output dir. */
  reuseScripts?: boolean;
  /** Approve without prompting. */
  yes?: boolean;
  /** Generate from an edited/approved plan file (plan.json or plan.md sibling). */
  editedPlanPath?: string;
  scope?: { feature?: string; requirementFile?: string; diffBase?: string };
  headed?: boolean;
  forceAuthRefresh?: boolean;
  /** Load perception from generated/<target>/perception.json instead of re-exploring. */
  reusePerception?: boolean;
  /** Override explore strategy for this run only. */
  exploreStrategy?: 'auto' | 'manual' | 'mcp';
  isTty: boolean;
  isCi: boolean;
}

export interface TargetRunResult {
  target: string;
  status: 'pass' | 'fail' | 'planned' | 'aborted';
  reasons: string[];
  scenarioCount: number;
  accepted: number;
  failed: number;
  quarantined: number;
  healed: number;
  costSummary: string;
  planPath?: string;
}

export interface OrchestratorDeps {
  cfg: ResolvedConfig;
  llm: LlmProvider;
  logger: Logger;
}

export async function runTarget(
  target: TargetConfig,
  opts: RunOptions,
  deps: OrchestratorDeps,
): Promise<TargetRunResult> {
  const { cfg, logger } = deps;

  const workdir = resolveFromBase(cfg, join('generated', target.name));
  const authStatePath = sessionStatePath(target, cfg.baseDir);
  mkdirSync(workdir, { recursive: true });

  // Resolve the optional external spec output dir (e.g. lhappautotest/tests/ata-generated).
  const outputDir = target.output_dir
    ? isAbsolute(target.output_dir)
      ? target.output_dir
      : resolve(cfg.baseDir, target.output_dir)
    : undefined;

  const maxBudget = cfg.defaults.max_budget_usd;
  const guard = new CostGuard(maxBudget);
  const llm = meteredProvider(deps.llm, guard);

  const minScenarios = target.success?.minScenarios ?? 3;
  const mustPass = target.success?.mustPass ?? true;
  const maxHeal = target.success?.maxHealAttempts ?? cfg.defaults.max_heal_attempts;

  const planMdPath = join(workdir, 'plan.md');
  const planJsonPath = join(workdir, 'plan.json');
  const perceptionJsonPath = join(workdir, 'perception.json');

  const reasons: string[] = [];
  let adapter: TestAdapter | undefined;

  try {
    adapter = await createAdapter({ target, llm, logger, workdir, authStatePath, baseDir: cfg.baseDir, headed: opts.headed });

    // --- Auth (login once, reuse) -----------------------------------------
    logger.info('[auth] Authenticating…');
    const session = await ensureSession({
      adapter,
      target,
      baseDir: cfg.baseDir,
      logger,
      forceRefresh: opts.forceAuthRefresh,
    });

    // Determine specs location early (used for reuse check).
    const specsDir = outputDir ?? join(workdir, 'tests');
    const reuseExisting = opts.reuseScripts === true && hasExistingSpecs(specsDir);

    let perception: import('../adapters/adapter.js').PerceptionSnapshot;
    let testPlan: TestPlan;
    let fromEditedPlan = false;

    if (reuseExisting) {
      // --- Reuse mode: skip explore + LLM plan + generate ------------------
      logger.info('[reuse] Existing specs found — skipping plan and generation…');
      // Explore is still called to open the browser (needed for session context),
      // but its output is not used for planning.
      perception = await adapter.explore(target);

      // Load the existing machine plan for result metadata; fall back to a stub.
      if (existsSync(planJsonPath)) {
        testPlan = loadPlanFromFile(planJsonPath, target.name);
        logger.info(`[reuse] Loaded existing plan: ${planJsonPath}`);
      } else {
        testPlan = {
          target: target.name,
          summary: '(reused — no plan.json available)',
          stages: [],
          scenarios: [],
          outOfScope: [],
          generatedAt: new Date().toISOString(),
        };
      }
    } else {
      // --- Explore (observe the running target) ----------------------------
      if (opts.reusePerception && existsSync(perceptionJsonPath)) {
        logger.info(`[explore] Reusing saved perception: ${perceptionJsonPath}`);
        perception = JSON.parse(readFileSync(perceptionJsonPath, 'utf8')) as PerceptionSnapshot;
      } else {
        const effectiveTarget = opts.exploreStrategy
          ? { ...target, explore: { ...target.explore, strategy: opts.exploreStrategy } }
          : target;
        logger.info('[explore] Observing target…');
        perception = await adapter.explore(effectiveTarget);
        writeFileSync(perceptionJsonPath, JSON.stringify(perception, null, 2));
        logger.debug(`[explore] Perception saved: ${perceptionJsonPath}`);
      }

      // --- Plan (or load an edited plan) -----------------------------------
      if (opts.editedPlanPath) {
        testPlan = loadPlanFromFile(opts.editedPlanPath, target.name);
        fromEditedPlan = true;
        logger.info(`[plan] Loaded edited plan: ${opts.editedPlanPath}`);
      } else {
        logger.info('[plan] Planning test scenarios…');
        const scope = resolveScope(cfg, target, opts.scope);
        testPlan = await planTarget({
          cfg,
          target,
          perception,
          llm,
          logger,
          scope,
          minScenarios,
          generatedAt: new Date().toISOString(),
        });
      }

      // Persist the plan (human + machine forms).
      writePlanMarkdown(testPlan, planMdPath);
      writePlanJson(testPlan, planJsonPath);
    }

    // --- Plan-only mode: stop here ----------------------------------------
    if (opts.mode === 'plan') {
      const { renderPlanTable } = await import('./pipeline.js');
      console.error('\n' + renderPlanTable(testPlan) + '\n');
      logger.info(`Wrote plan: ${planMdPath}`);
      return baseResult(target.name, 'planned', testPlan, guard, planMdPath, [
        'plan-only mode (no generation)',
      ]);
    }

    // --- Generate (or reuse existing specs) --------------------------------
    let tests: import('../adapters/adapter.js').GeneratedTest[];

    if (reuseExisting) {
      tests = loadExistingSpecs(specsDir, !!outputDir);
      logger.info(`[reuse] Using ${tests.length} existing spec(s) from ${specsDir}`);
    } else {
      // Confirmation gate (only for fresh generation).
      const approval = cfg.defaults.approval as ApprovalMode;
      const confirm = await confirmPlan({
        plan: testPlan,
        approval,
        yes: opts.yes ?? false,
        fromEditedPlan,
        isTty: opts.isTty,
        isCi: opts.isCi,
        logger,
        planPath: planMdPath,
      });
      if (!confirm.approved) {
        return baseResult(target.name, 'aborted', testPlan, guard, planMdPath, [
          `not approved: ${confirm.reason}`,
        ]);
      }

      logger.info(`[generate] Generating ${testPlan.scenarios.length} test spec(s)…`);
      tests = await generate({ adapter, plan: testPlan, perception, workdir, outputDir, logger });
    }

    if (opts.dryRun) {
      return baseResult(target.name, 'planned', testPlan, guard, planMdPath, [
        `dry-run: generated ${tests.length} spec(s), execution skipped`,
      ]);
    }

    // --- Execute (+ stability gate) ---------------------------------------
    logger.info(`[execute] Running ${tests.length} test(s) (${cfg.defaults.stability.runs} run(s) each)…`);
    let result: ExecutionResult = await execute({
      adapter,
      tests,
      workdir,
      outputDir,
      runs: cfg.defaults.stability.runs,
      timeoutMs: cfg.defaults.timeout_ms,
      quarantine: cfg.defaults.stability.quarantine,
      session,
      headed: opts.headed,
      logger,
    });

    // --- Heal -------------------------------------------------------------
    let healedCount = 0;
    if (result.failed.length > 0 && maxHeal > 0) {
      logger.info(`[heal] Attempting to repair ${result.failed.length} failing test(s)…`);
      const useMcpHeal = target.explore?.strategy === 'mcp' && !!target.url;
      const healResult = await heal({
        adapter,
        llm,
        perception,
        failing: result.failed,
        maxAttempts: maxHeal,
        workdir,
        outputDir,
        runs: cfg.defaults.stability.runs,
        timeoutMs: cfg.defaults.timeout_ms,
        session,
        logger,
        ...(useMcpHeal
          ? { mcpServers: { playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp'] } }, targetUrl: target.url }
          : {}),
      });
      healedCount = healResult.healed.length;
      result = {
        ...result,
        passed: [...result.passed, ...healResult.healed],
        failed: healResult.stillFailing,
      };
    }

    // --- Verdict (PRD §8) -------------------------------------------------
    const accepted = result.passed.length;
    const failed = result.failed.length;
    if (accepted < minScenarios) {
      reasons.push(`accepted ${accepted} scenario(s) < required min_scenarios ${minScenarios}`);
    }
    if (mustPass && failed > 0) {
      reasons.push(`${failed} test(s) still failing after healing (must_pass: true)`);
    }
    const status: TargetRunResult['status'] = reasons.length === 0 ? 'pass' : 'fail';
    if (result.quarantined.length > 0) {
      reasons.push(`${result.quarantined.length} flaky test(s) quarantined (excluded from green suite)`);
    }

    return {
      target: target.name,
      status,
      reasons: reasons.length ? reasons : ['all checks passed'],
      scenarioCount: testPlan.scenarios.length,
      accepted,
      failed,
      quarantined: result.quarantined.length,
      healed: healedCount,
      costSummary: guard.summary(),
      planPath: planMdPath,
    };
  } catch (e) {
    if (e instanceof BudgetExceededError) {
      return baseResultErr(target.name, guard, planMdPath, [e.message]);
    }
    return baseResultErr(target.name, guard, planMdPath, [`error: ${(e as Error).message}`]);
  } finally {
    if (adapter) {
      try {
        await adapter.dispose();
      } catch {
        /* ignore dispose errors */
      }
    }
  }
}

function baseResult(
  target: string,
  status: TargetRunResult['status'],
  plan: TestPlan,
  guard: CostGuard,
  planPath: string,
  reasons: string[],
): TargetRunResult {
  return {
    target,
    status,
    reasons,
    scenarioCount: plan.scenarios.length,
    accepted: 0,
    failed: 0,
    quarantined: 0,
    healed: 0,
    costSummary: guard.summary(),
    planPath,
  };
}

function baseResultErr(
  target: string,
  guard: CostGuard,
  planPath: string,
  reasons: string[],
): TargetRunResult {
  return {
    target,
    status: 'fail',
    reasons,
    scenarioCount: 0,
    accepted: 0,
    failed: 0,
    quarantined: 0,
    healed: 0,
    costSummary: guard.summary(),
    planPath,
  };
}

function writePlanJson(plan: TestPlan, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(plan, null, 2), 'utf8');
}

export type { TestRunResult };

async function generateUseCaseDoc(
  uc: ExploreUseCase,
  steps: PerceptionSnapshot[],
  llm: LlmProvider,
): Promise<string> {
  const stepsText = steps.map((s, i) => {
    const tree = s.accessibilityTree?.slice(0, 1200) ?? s.domSummary?.slice(0, 800) ?? '(no snapshot)';
    return `### Step ${uc.fromStepIndex + i + 1}: ${s.url ?? ''} — ${s.title ?? ''}\n${tree}`;
  }).join('\n\n');

  const res = await llm.complete({
    system: 'You are a QA writer producing concise manual test cases in Markdown.',
    prompt: `Document the following manually-explored user flow as a formal manual test case.

Use case: "${uc.name}"
Captured steps (${steps.length}):

${stepsText}

Write a Markdown document with:
- **h2 title** matching the use case name
- **Preconditions** section (bullet list)
- **Steps** (numbered; each as "Action → Expected result")
- **Pass criteria** (bullet list)

Keep it under 500 words. Return only the Markdown, no preamble.`,
  });

  return res.text.trim();
}

export interface ExploreResult {
  target: string;
  perceptionPath: string;
  stepCount: number;
  strategy: 'auto' | 'manual' | 'mcp';
  checkpointCount: number;
  useCaseCount: number;
}

/**
 * Standalone explore: open the target, capture a PerceptionSnapshot (auto or
 * manual), and persist it to `generated/<target>/perception.json` so that
 * subsequent `plan`/`run` calls can load it with `--reuse-perception`.
 */
export async function exploreTarget(
  target: TargetConfig,
  opts: {
    strategy?: 'auto' | 'manual' | 'mcp';
    headed?: boolean;
    forceAuthRefresh?: boolean;
    logger: Logger;
  },
  deps: OrchestratorDeps,
): Promise<ExploreResult> {
  const { cfg, logger } = deps;

  const workdir = resolveFromBase(cfg, join('generated', target.name));
  mkdirSync(workdir, { recursive: true });
  const authStatePath = sessionStatePath(target, cfg.baseDir);
  const perceptionJsonPath = join(workdir, 'perception.json');

  const guard = new CostGuard(0);
  const llm = meteredProvider(deps.llm, guard);

  let adapter: TestAdapter | undefined;
  try {
    adapter = await createAdapter({ target, llm, logger, workdir, authStatePath, baseDir: cfg.baseDir, headed: opts.headed });

    // For manual explore with reuse-state: skip ensureSession if no file yet —
    // the user will authenticate manually in the browser, and we save afterward.
    const isManual = (opts.strategy ?? target.explore?.strategy) === 'manual';
    const sessionMissing = target.auth?.strategy === 'reuse-state' && !existsSync(authStatePath);
    if (isManual && sessionMissing) {
      logger.info('[auth] No saved session yet — you will authenticate manually in the browser.');
    } else {
      logger.info('[auth] Authenticating…');
      await ensureSession({
        adapter,
        target,
        baseDir: cfg.baseDir,
        logger,
        forceRefresh: opts.forceAuthRefresh,
      });
    }

    const effectiveTarget = opts.strategy
      ? { ...target, explore: { ...target.explore, strategy: opts.strategy } }
      : target;

    const strategy = effectiveTarget.explore?.strategy ?? 'auto';
    logger.info(`[explore] Observing target (strategy: ${strategy})…`);
    const perception = await adapter.explore(effectiveTarget);

    writeFileSync(perceptionJsonPath, JSON.stringify(perception, null, 2));
    logger.info(`[explore] Saved: ${perceptionJsonPath}`);

    // Save checkpoint snapshots
    if (perception.checkpoints?.length) {
      const cpDir = join(workdir, 'checkpoints');
      mkdirSync(cpDir, { recursive: true });
      for (const cp of perception.checkpoints) {
        const snapshot = perception.steps?.[cp.stepIndex] ?? perception;
        writeFileSync(join(cpDir, `${cp.name}.json`), JSON.stringify({ ...cp, snapshot }, null, 2));
        logger.info(`[explore] 📌 Checkpoint saved: checkpoints/${cp.name}.json`);
      }
    }

    // Generate use-case markdown docs via LLM
    if (perception.useCases?.length) {
      const ucDir = join(workdir, 'use-cases');
      mkdirSync(ucDir, { recursive: true });
      for (const uc of perception.useCases) {
        const ucSteps = (perception.steps ?? []).slice(uc.fromStepIndex, uc.toStepIndex + 1);
        logger.info(`[explore] 🎬 Generating doc for "${uc.name}" (${ucSteps.length} step(s))…`);
        try {
          const md = await generateUseCaseDoc(uc, ucSteps, llm);
          writeFileSync(join(ucDir, `${uc.name}.md`), md);
          logger.info(`[explore] ✅ Use case saved: use-cases/${uc.name}.md`);
        } catch (e) {
          logger.warn(`[explore] Could not generate doc for "${uc.name}": ${(e as Error).message}`);
        }
      }
    }

    // After manual explore, persist whatever session the user authenticated into.
    if (isManual && adapter.getStorageState) {
      const state = await adapter.getStorageState();
      if (state) {
        mkdirSync(dirname(authStatePath), { recursive: true });
        writeFileSync(authStatePath, JSON.stringify(state, null, 2));
        logger.info(`[auth] Session saved: ${authStatePath}`);
      }
    }

    const stepCount = perception.steps?.length ?? 1;
    return {
      target: target.name,
      perceptionPath: perceptionJsonPath,
      stepCount,
      strategy,
      checkpointCount: perception.checkpoints?.length ?? 0,
      useCaseCount: perception.useCases?.length ?? 0,
    };
  } finally {
    if (adapter) {
      try { await adapter.dispose(); } catch { /* ignore */ }
    }
  }
}
