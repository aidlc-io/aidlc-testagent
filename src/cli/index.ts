#!/usr/bin/env node
/**
 * aidlc-testagent CLI (PRD §11). Binary: `aidlc-testagent` (alias `ata`).
 *
 *   ata validate                 run all targets, PASS/FAIL table, gate CI
 *   ata plan <target>            propose a pipeline + write plan.md (no generation)
 *   ata run <target>             plan → confirm → generate → execute → heal
 *   ata list                     list configured targets
 *   ata config [add|target|show] interactive wizard (PRD §11a)
 *   ata report <target>          requirement → test matrix (Phase 2)
 *
 * No telemetry, no model API keys (PRD §13).
 */

import { Command } from 'commander';
import { loadConfig, ConfigError, type ResolvedConfig } from '../config/loader.js';
import { createLlmProvider } from '../core/llm/index.js';
import type { LlmProvider } from '../core/llm/provider.js';
import { ConsoleLogger } from '../core/logger.js';
import { runTarget, type OrchestratorDeps, type RunOptions, type TargetRunResult } from '../core/orchestrator.js';
import type { TargetConfig } from '../adapters/adapter.js';
import { isCi, isInteractiveTty } from './env.js';
import { renderRunResult, renderTargetList, renderValidateTable } from './render.js';
import { runWizard } from './wizard.js';

const program = new Command();

program
  .name('aidlc-testagent')
  .description('AI test agent for web, desktop, API & mobile. No telemetry. No model API keys.')
  .version('0.1.0')
  .option('-c, --config <path>', 'path to testagent.config.yaml');

function loadCfg(cmd: Command): ResolvedConfig {
  const opts = program.opts<{ config?: string }>();
  void cmd;
  return loadConfig(process.cwd(), opts.config);
}

function findTarget(cfg: ResolvedConfig, name: string): TargetConfig {
  const t = cfg.targets.find((x) => x.name === name);
  if (!t) {
    const names = cfg.targets.map((x) => x.name).join(', ') || '(none)';
    throw new ConfigError(`No target named "${name}". Configured targets: ${names}`);
  }
  return t;
}

async function makeDeps(cfg: ResolvedConfig, opts: { preflight: boolean }): Promise<OrchestratorDeps> {
  const logger = new ConsoleLogger(Boolean(process.env.ATA_VERBOSE));
  const llm: LlmProvider = createLlmProvider(cfg.llm);
  if (opts.preflight) {
    await llm.preflight();
  }
  return { cfg, llm, logger };
}

function baseRunOptions(): Pick<RunOptions, 'isTty' | 'isCi'> {
  return { isTty: isInteractiveTty(), isCi: isCi() };
}

// --- validate --------------------------------------------------------------
program
  .command('validate')
  .description('run all targets, print a PASS/FAIL table, exit non-zero on any failure')
  .option('--headed', 'run browsers headed (debug)')
  .action(async (cmdOpts: { headed?: boolean }, cmd: Command) => {
    const cfg = loadCfg(cmd);
    if (cfg.targets.length === 0) {
      console.error('No targets configured. Run `ata config` to add one.');
      process.exit(1);
    }
    const deps = await makeDeps(cfg, { preflight: true });
    const results: TargetRunResult[] = [];
    for (const target of cfg.targets) {
      console.error(`\n▶ ${target.name} (${target.adapter})`);
      const res = await runTarget(
        target,
        { ...baseRunOptions(), mode: 'run', yes: true, headed: cmdOpts.headed, isCi: true },
        deps,
      );
      results.push(res);
    }
    console.log('\n' + renderValidateTable(results));
    const anyFail = results.some((r) => r.status === 'fail');
    process.exit(anyFail ? 1 : 0);
  });

// --- plan ------------------------------------------------------------------
program
  .command('plan <target>')
  .description('plan only: propose a pipeline and write plan.md (never generates)')
  .option('--feature <requirement-file>', 'scope to one feature described by a requirement file')
  .option('--scope <feature-name>', 'scope by a declared feature name')
  .option('--diff <base-ref>', 'scope to flows near a git diff (Phase 3; best-effort)')
  .action(async (name: string, cmdOpts: ScopeFlags, cmd: Command) => {
    const cfg = loadCfg(cmd);
    const target = findTarget(cfg, name);
    const deps = await makeDeps(cfg, { preflight: true });
    const res = await runTarget(target, { ...baseRunOptions(), mode: 'plan', scope: toScope(cmdOpts) }, deps);
    console.log(renderRunResult(res));
  });

// --- run -------------------------------------------------------------------
program
  .command('run <target>')
  .description('plan → confirm → generate → execute → heal')
  .option('--feature <requirement-file>', 'scope to one feature described by a requirement file')
  .option('--scope <feature-name>', 'scope by a declared feature name')
  .option('--diff <base-ref>', 'scope to flows near a git diff (Phase 3; best-effort)')
  .option('--yes', 'approve the proposed pipeline without prompting')
  .option('--plan <plan-file>', 'generate from an edited/approved plan (plan.json or plan.md)')
  .option('--dry-run', 'plan + generate only, skip execution')
  .option('--headed', 'run browsers headed (debug)')
  .option('--refresh-auth', 'ignore any stored session and re-authenticate')
  .action(async (name: string, cmdOpts: RunFlags, cmd: Command) => {
    const cfg = loadCfg(cmd);
    const target = findTarget(cfg, name);
    const deps = await makeDeps(cfg, { preflight: true });
    const res = await runTarget(
      target,
      {
        ...baseRunOptions(),
        mode: 'run',
        scope: toScope(cmdOpts),
        yes: cmdOpts.yes,
        editedPlanPath: cmdOpts.plan,
        dryRun: cmdOpts.dryRun,
        headed: cmdOpts.headed,
        forceAuthRefresh: cmdOpts.refreshAuth,
      },
      deps,
    );
    console.log(renderRunResult(res));
    process.exit(res.status === 'fail' ? 1 : 0);
  });

// --- list ------------------------------------------------------------------
program
  .command('list')
  .description('list configured targets and their adapters')
  .action((_cmdOpts: unknown, cmd: Command) => {
    const cfg = loadCfg(cmd);
    console.log(renderTargetList(cfg.targets));
  });

// --- config (wizard) -------------------------------------------------------
const config = program
  .command('config')
  .description('interactive wizard: configure the project (PRD §11a)')
  .action(async (_cmdOpts: unknown, cmd: Command) => {
    await runWizard({ mode: 'init', configPath: program.opts<{ config?: string }>().config, cmd });
  });
config
  .command('add')
  .description('add one target via guided prompts')
  .action(async (_o: unknown, cmd: Command) => {
    await runWizard({ mode: 'add', configPath: program.opts<{ config?: string }>().config, cmd });
  });
config
  .command('target <name>')
  .description('edit an existing target via prompts')
  .action(async (name: string, _o: unknown, cmd: Command) => {
    await runWizard({ mode: 'edit', target: name, configPath: program.opts<{ config?: string }>().config, cmd });
  });
config
  .command('show')
  .description('print the resolved effective config')
  .action((_o: unknown, cmd: Command) => {
    const cfg = loadCfg(cmd);
    console.log(
      JSON.stringify(
        {
          configPath: cfg.configPath,
          env: cfg.env,
          allowHosts: cfg.allowHosts,
          llm: cfg.llm,
          defaults: cfg.defaults,
          targets: cfg.targets,
        },
        null,
        2,
      ),
    );
  });

// --- report (Phase 2 stub) -------------------------------------------------
program
  .command('report <target>')
  .description('requirement → test traceability matrix (Phase 2)')
  .action((name: string) => {
    console.error(
      `report is a Phase 2 feature (the traceability matrix). The data is already captured: ` +
        `each scenario in generated/${name}/plan.json records its "tracesTo" sources.`,
    );
  });

// --- scope helpers ---------------------------------------------------------
interface ScopeFlags {
  feature?: string;
  scope?: string;
  diff?: string;
}
interface RunFlags extends ScopeFlags {
  yes?: boolean;
  plan?: string;
  dryRun?: boolean;
  headed?: boolean;
  refreshAuth?: boolean;
}
function toScope(f: ScopeFlags): RunOptions['scope'] {
  if (!f.feature && !f.scope && !f.diff) return undefined;
  return { requirementFile: f.feature, feature: f.scope, diffBase: f.diff };
}

// --- entrypoint ------------------------------------------------------------
async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`\n✖ Config error:\n${e.message}\n`);
    } else {
      console.error(`\n✖ ${(e as Error).message}\n`);
    }
    process.exit(1);
  }
}

void main();
