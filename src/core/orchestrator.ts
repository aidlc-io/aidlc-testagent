/**
 * Orchestrator (PRD §5) — the one shared agent loop, surface-agnostic.
 *
 *   explore → plan → [CONFIRM gate] → generate → execute (+stability) → heal
 *
 * It talks only to the adapter contract and the LlmProvider interface; it never
 * imports Playwright. The cost guard meters every LLM call and aborts a run that
 * exceeds the budget. A target PASSES per PRD §8.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  ExecutionResult,
  Logger,
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
import { generate } from './generator.js';
import { execute } from './executor.js';
import { heal } from './healer.js';
import { loadPlanFromFile } from './plan-io.js';

export type RunMode = 'plan' | 'run';

export interface RunOptions {
  mode: RunMode;
  /** Generate but skip execution. */
  dryRun?: boolean;
  /** Approve without prompting. */
  yes?: boolean;
  /** Generate from an edited/approved plan file (plan.json or plan.md sibling). */
  editedPlanPath?: string;
  scope?: { feature?: string; requirementFile?: string; diffBase?: string };
  headed?: boolean;
  forceAuthRefresh?: boolean;
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

  const maxBudget = cfg.defaults.max_budget_usd;
  const guard = new CostGuard(maxBudget);
  const llm = meteredProvider(deps.llm, guard);

  const minScenarios = target.success?.minScenarios ?? 3;
  const mustPass = target.success?.mustPass ?? true;
  const maxHeal = target.success?.maxHealAttempts ?? cfg.defaults.max_heal_attempts;

  const planMdPath = join(workdir, 'plan.md');
  const planJsonPath = join(workdir, 'plan.json');

  const reasons: string[] = [];
  let adapter: TestAdapter | undefined;

  try {
    adapter = await createAdapter({ target, llm, logger, workdir, authStatePath });

    // --- Auth (login once, reuse) -----------------------------------------
    const session = await ensureSession({
      adapter,
      target,
      baseDir: cfg.baseDir,
      logger,
      forceRefresh: opts.forceAuthRefresh,
    });

    // --- Explore (observe the running target) -----------------------------
    logger.info('Exploring target…');
    const perception = await adapter.explore(target);

    // --- Plan (or load an edited plan) ------------------------------------
    let testPlan: TestPlan;
    let fromEditedPlan = false;
    if (opts.editedPlanPath) {
      testPlan = loadPlanFromFile(opts.editedPlanPath, target.name);
      fromEditedPlan = true;
      logger.info(`Loaded edited plan: ${opts.editedPlanPath}`);
    } else {
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

    // --- Plan-only mode: stop here ----------------------------------------
    if (opts.mode === 'plan') {
      const { renderPlanTable } = await import('./pipeline.js');
      console.error('\n' + renderPlanTable(testPlan) + '\n');
      logger.info(`Wrote plan: ${planMdPath}`);
      return baseResult(target.name, 'planned', testPlan, guard, planMdPath, [
        'plan-only mode (no generation)',
      ]);
    }

    // --- Confirmation gate ------------------------------------------------
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

    // --- Generate ---------------------------------------------------------
    const tests = await generate({ adapter, plan: testPlan, perception, workdir, logger });

    if (opts.dryRun) {
      return baseResult(target.name, 'planned', testPlan, guard, planMdPath, [
        `dry-run: generated ${tests.length} spec(s), execution skipped`,
      ]);
    }

    // --- Execute (+ stability gate) ---------------------------------------
    let result: ExecutionResult = await execute({
      adapter,
      tests,
      workdir,
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
      const healResult = await heal({
        adapter,
        llm,
        perception,
        failing: result.failed,
        maxAttempts: maxHeal,
        workdir,
        runs: cfg.defaults.stability.runs,
        timeoutMs: cfg.defaults.timeout_ms,
        session,
        logger,
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
