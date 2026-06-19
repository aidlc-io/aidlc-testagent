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
import { createLlmProvider, ClaudeCliProvider } from '../core/llm/index.js';
import type { LlmProvider } from '../core/llm/provider.js';
import { ConsoleLogger } from '../core/logger.js';
import { runTarget, exploreTarget, type OrchestratorDeps, type RunOptions, type TargetRunResult } from '../core/orchestrator.js';
import type { TargetConfig } from '../adapters/adapter.js';
import { isCi, isInteractiveTty } from './env.js';
import { renderRunResult, renderTargetList, renderValidateTable } from './render.js';
import { runWizard } from './wizard.js';

const program = new Command();

program
  .name('aidlc-testagent')
  .description('AI test agent for web, desktop, API & mobile. No telemetry. No model API keys.')
  .version('0.4.1')
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

// --- explore ---------------------------------------------------------------
program
  .command('explore <target>')
  .description('explore only: observe the target and save perception.json for reuse')
  .option('--manual', 'override explore strategy to manual (navigate freely, press Enter when done)')
  .option('--headed', 'run browsers headed (debug)')
  .option('--refresh-auth', 'ignore any stored session and re-authenticate')
  .action(async (name: string, cmdOpts: { manual?: boolean; headed?: boolean; refreshAuth?: boolean }, cmd: Command) => {
    const cfg = loadCfg(cmd);
    const target = findTarget(cfg, name);
    const logger = new ConsoleLogger(Boolean(process.env.ATA_VERBOSE));
    const llm = createLlmProvider(cfg.llm);
    await llm.preflight();
    const result = await exploreTarget(
      target,
      {
        strategy: cmdOpts.manual ? 'manual' : undefined,
        headed: cmdOpts.headed,
        forceAuthRefresh: cmdOpts.refreshAuth,
        logger,
      },
      { cfg, llm, logger },
    );
    const extras: string[] = [];
    if (result.checkpointCount) extras.push(`${result.checkpointCount} checkpoint(s)`);
    if (result.useCaseCount) extras.push(`${result.useCaseCount} use-case doc(s)`);
    const extrasLine = extras.length ? `  Extras: ${extras.join(', ')} saved.\n` : '';
    console.error(
      `\n✔ Explored "${result.target}" — ${result.stepCount} step(s) captured (${result.strategy}).\n` +
        `  Saved to: ${result.perceptionPath}\n` +
        extrasLine +
        `  Use --reuse-perception on plan/run to skip re-exploring.\n`,
    );
  });

// --- plan ------------------------------------------------------------------
program
  .command('plan <target>')
  .description('plan only: propose a pipeline and write plan.md (never generates)')
  .option('--feature <requirement-file>', 'scope to one feature described by a requirement file')
  .option('--scope <feature-name>', 'scope by a declared feature name')
  .option('--diff <base-ref>', 'scope to flows near a git diff (Phase 3; best-effort)')
  .option('--manual', 'explore manually (navigate + press Enter) before planning')
  .option('--reuse-perception', 'skip explore; load perception.json saved by `ata explore`')
  .action(async (name: string, cmdOpts: ScopeFlags & { manual?: boolean; reusePerception?: boolean }, cmd: Command) => {
    const cfg = loadCfg(cmd);
    const target = findTarget(cfg, name);
    const deps = await makeDeps(cfg, { preflight: true });
    const res = await runTarget(
      target,
      {
        ...baseRunOptions(),
        mode: 'plan',
        scope: toScope(cmdOpts),
        exploreStrategy: cmdOpts.manual ? 'manual' : undefined,
        reusePerception: cmdOpts.reusePerception,
      },
      deps,
    );
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
  .option('--reuse', 'skip plan + generate if spec files already exist; run existing scripts')
  .option('--manual', 'explore manually (navigate + press Enter) before planning')
  .option('--reuse-perception', 'skip explore; load perception.json saved by `ata explore`')
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
        reuseScripts: cmdOpts.reuse,
        exploreStrategy: cmdOpts.manual ? 'manual' : undefined,
        reusePerception: cmdOpts.reusePerception,
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

// --- ask -------------------------------------------------------------------
const CONFIG_SCHEMA_REFERENCE = `
## testagent.config.yaml (root manifest)
\`\`\`yaml
version: 1
env: staging-only          # staging-only | any  (staging-only blocks prod URLs)
allow_hosts: []            # extra hosts to allow under staging-only
llm:
  provider: claude-cli     # claude-cli | gemini-cli | codex-cli | ollama | custom
  model: claude-sonnet-4-6 # optional model override
  bare: false
  max_turns: 1
defaults:
  max_heal_attempts: 2
  timeout_ms: 30000
  approval: prompt         # prompt | auto | manual-edit
  max_budget_usd: 2.00
  stability:
    runs: 3
    quarantine: true
targets:
  - include: targets/public/*.target.yaml
  - include: targets/private/*.target.yaml   # gitignored
\`\`\`

## targets/<name>.target.yaml (per-target)
\`\`\`yaml
name: my-app               # slug: letters, digits, -, _
adapter: playwright-web    # playwright-web | playwright-electron | rest-api | appium-ios
url: https://staging.myapp.com    # required for playwright-web
# executable: /path/to/app       # required for playwright-electron
# spec: openapi.yaml             # required for rest-api
# base_url: https://...          # required for rest-api
# app: MyApp.app                 # required for appium-ios
perception: dom            # dom | accessibility | schema

auth:
  strategy: form           # form | none | api | reuse-state | external
  credentials_env: [MY_USER_ENV, MY_PASS_ENV]   # env var NAMES — never values
  store_state: .auth/my-app.json                # reusable session cache

context:                   # trust order: requirements > manual_tests > business > source
  requirements: [docs/requirements/*.md]
  manual_tests: [test-cases/*.md]
  business: [docs/business-rules.md]
  source: [src/**/*.ts]

scope:
  feature: checkout        # restrict to one named feature
  requirement: docs/requirements/checkout.md

explore:
  strategy: manual        # auto (default) | manual — navigate freely, agent auto-snaps
  idle_timeout_ms: 2000   # ms of DOM quiet before snapping (default 2000)

success:
  min_scenarios: 3
  must_pass: true
  max_heal_attempts: 2

output_dir: ../other-repo/tests/ata-generated   # write specs to an external repo
\`\`\`

## Key rules
- Credentials: always env var names in credentials_env, NEVER hardcoded values
- output_dir: use when ata writes specs into a separate codebase (e.g. Kelvin lhappautotest)
- context.requirements has highest trust — put your spec/PRD files here
- staging-only blocks production URLs to prevent accidental prod writes
- .auth/ directory should be in .gitignore
- explore.strategy: manual — opens a headed browser; you navigate, agent auto-snaps each DOM-idle state; click "✅ Done" when finished; saves perception.json + .auth/<target>.json
- --reuse-perception — skips re-exploring on plan/run by loading the saved perception.json
- auth.strategy: reuse-state — pair with manual explore; session is auto-saved after "Done"
`;

program
  .command('ask <prompt>')
  .description('ask the AI a question about ata config or setup')
  .action(async (userPrompt: string, _opts: unknown, cmd: Command) => {
    // Try loading the project config; fall back gracefully if not set up yet.
    let cfg: ResolvedConfig | null = null;
    let llm: LlmProvider;
    try {
      cfg = loadCfg(cmd);
      llm = createLlmProvider(cfg.llm);
    } catch {
      // No config yet — use default claude-cli so the user can still ask questions.
      llm = new ClaudeCliProvider({});
    }

    // Preflight — make sure the CLI is available.
    try {
      await llm.preflight();
    } catch (e) {
      console.error(`✖ LLM not available: ${(e as Error).message}`);
      process.exit(1);
    }

    // Build system context.
    const currentConfigSection = cfg
      ? `\n## Current project config\n\`\`\`json\n${JSON.stringify(
          {
            env: cfg.env,
            llm: cfg.llm,
            defaults: cfg.defaults,
            targets: cfg.targets,
          },
          null,
          2,
        )}\n\`\`\`\n`
      : '\n## Current project config\n(no config found — user may be setting up from scratch)\n';

    const system =
      `You are a configuration advisor for ata (aidlc-testagent), an AI test agent that ` +
      `observes a running target (web, Electron, REST API, or iOS), proposes a test plan, generates ` +
      `real test specs, and executes them with a stability gate and self-healing.\n` +
      `Answer the user's question concisely and practically. When showing config, output ` +
      `valid YAML the user can copy directly. Prefer concrete examples over abstract descriptions.` +
      CONFIG_SCHEMA_REFERENCE +
      currentConfigSection;

    process.stderr.write('\n');
    try {
      const result = await llm.complete({ system, prompt: userPrompt });
      console.log(result.text);
    } catch (e) {
      console.error(`✖ ${(e as Error).message}`);
      process.exit(1);
    }
  });

// --- guide -----------------------------------------------------------------
program
  .command('guide')
  .description('step-by-step getting-started reference')
  .action(() => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║          aidlc-testagent  —  Getting Started         ║
╚══════════════════════════════════════════════════════╝

ata observes a running target, proposes a test plan, generates
real test specs, and executes them with a stability gate and
self-healing.

Supported surfaces:
  • Web        (playwright-web)       — any browser-based app
  • Electron   (playwright-electron)  — desktop apps via Electron
  • REST API   (rest-api)             — OpenAPI/Swagger endpoints
  • iOS        (appium-ios)           — native iOS apps via Appium

── Step 1: Configure ─────────────────────────────────
  ata config          interactive wizard (first time)
  ata config add      add another target
  ata list            see all configured targets
  ata config show     print the resolved config

── Step 1b: Explore (for apps needing manual auth) ───
  ata explore <target> --manual --headed
                        navigate in browser, click ✅ Done when finished
                        saves perception.json + .auth/<target>.json
  ata explore <target>  auto explore (default, no browser interaction needed)

── Step 2: Plan (no generation, no cost) ─────────────
  ata plan <target>               propose + write plan.md
  ata plan <target> --scope cart  scope to one feature
  ata plan <target> --reuse-perception   reuse saved perception, skip browser
  ata plan <target> --manual --headed    explore manually then plan in one shot

── Step 3: Run ───────────────────────────────────────
  ata run <target>                full loop (plan → generate → test)
  ata run <target> --yes          auto-approve the plan
  ata run <target> --reuse        skip generate, run existing specs
  ata run <target> --dry-run      generate only, skip execution
  ata run <target> --headed       open a visible browser (debug)
  ata run <target> --plan p.md    generate from an edited plan
  ata run <target> --reuse-perception    reuse saved perception, skip browser
  ata run <target> --manual --headed     explore manually then run in one shot

── Step 4: CI gate ───────────────────────────────────
  ata validate        run all targets, PASS/FAIL table, exit 1 on fail

── Generated artifacts ───────────────────────────────
  generated/<target>/plan.md          edit and re-run with --plan
  generated/<target>/tests/*.spec.ts  committable Playwright specs
  generated/<target>/perception.json     multi-step journey; reuse with --reuse-perception

── Useful env vars ───────────────────────────────────
  ATA_VERBOSE=1        verbose logging (debug adapters, LLM calls)

Run \`ata <command> --help\` for all flags on any command.
`);
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
  reuse?: boolean;
  manual?: boolean;
  reusePerception?: boolean;
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
