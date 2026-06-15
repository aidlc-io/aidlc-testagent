/**
 * Interactive config wizard (PRD §11a).
 *
 * Users should never need to learn the YAML schema by hand. The wizard
 * auto-detects sensible defaults, prompts for the rest, renders YAML, validates
 * it with the SAME Zod schemas the loader uses, summarizes, and confirms before
 * writing. Existing files are never silently overwritten. Non-TTY use is refused
 * with clear guidance (no silent failure).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import * as clack from '@clack/prompts';
import { stringify as toYaml, parse as fromYaml } from 'yaml';
import { rootSchema, targetSchema } from '../config/schema.js';
import { isInteractiveTty } from './env.js';

export interface WizardArgs {
  mode: 'init' | 'add' | 'edit';
  target?: string;
  configPath?: string;
  cmd: Command;
}

const ROOT_FILENAME = 'testagent.config.yaml';

interface Detection {
  adapter: 'playwright-web' | 'playwright-electron' | 'rest-api';
  electronBuild?: string;
  openapiSpec?: string;
  contextGlobs: { requirements?: string[]; manual_tests?: string[]; business?: string[] };
}

function detect(cwd: string): Detection {
  const detection: Detection = { adapter: 'playwright-web', contextGlobs: {} };

  const pkgPath = join(cwd, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if (deps.electron) {
        detection.adapter = 'playwright-electron';
        detection.electronBuild = './dist/app';
      }
    } catch {
      /* ignore */
    }
  }
  for (const spec of ['openapi.yaml', 'openapi.json', 'swagger.yaml', 'swagger.json']) {
    if (existsSync(join(cwd, spec))) {
      detection.adapter = 'rest-api';
      detection.openapiSpec = `./${spec}`;
      break;
    }
  }
  if (existsSync(join(cwd, 'docs/requirements'))) detection.contextGlobs.requirements = ['docs/requirements/**/*.md'];
  if (existsSync(join(cwd, 'test-cases'))) detection.contextGlobs.manual_tests = ['test-cases/**/*.md'];
  if (existsSync(join(cwd, 'docs/domain'))) detection.contextGlobs.business = ['docs/domain/*.md'];

  return detection;
}

function assertNotCancel<T>(value: T | symbol): T {
  if (clack.isCancel(value)) {
    clack.cancel('Cancelled. No files were written.');
    process.exit(0);
  }
  return value as T;
}

/** Build a snake_case target object (the on-disk YAML shape) from answers. */
async function gatherTarget(cwd: string, prefill?: Record<string, any>): Promise<Record<string, any>> {
  const det = detect(cwd);

  const name = assertNotCancel(
    await clack.text({
      message: 'Target name (slug)',
      placeholder: 'my-app',
      initialValue: prefill?.name,
      validate: (v) => (/^[a-z0-9][a-z0-9-_]*$/i.test(v) ? undefined : 'letters, digits, -, _ only'),
    }),
  );

  const adapter = assertNotCancel(
    await clack.select({
      message: 'Adapter',
      initialValue: prefill?.adapter ?? det.adapter,
      options: [
        { value: 'playwright-web', label: 'playwright-web (a URL)' },
        { value: 'playwright-electron', label: 'playwright-electron (a desktop build)' },
        { value: 'rest-api', label: 'rest-api (OpenAPI spec) — Phase 2' },
      ],
    }),
  ) as string;

  const target: Record<string, any> = { name, adapter };

  if (adapter === 'playwright-web') {
    target.url = assertNotCancel(
      await clack.text({ message: 'URL (staging/public)', placeholder: 'https://staging.example.com', initialValue: prefill?.url }),
    );
  } else if (adapter === 'playwright-electron') {
    target.executable = assertNotCancel(
      await clack.text({ message: 'Path to the app executable', initialValue: prefill?.executable ?? det.electronBuild }),
    );
  } else if (adapter === 'rest-api') {
    target.spec = assertNotCancel(
      await clack.text({ message: 'Path to the OpenAPI spec', initialValue: prefill?.spec ?? det.openapiSpec }),
    );
    target.base_url = assertNotCancel(
      await clack.text({ message: 'API base URL (staging)', initialValue: prefill?.base_url }),
    );
  }

  // Auth
  const authStrategy = assertNotCancel(
    await clack.select({
      message: 'Authentication',
      initialValue: prefill?.auth?.strategy ?? 'none',
      options: [
        { value: 'none', label: 'none (no login)' },
        { value: 'form', label: 'form (log in once, reuse session)' },
        { value: 'reuse-state', label: 'reuse-state (use an existing stored session)' },
      ],
    }),
  ) as string;
  if (authStrategy !== 'none') {
    const auth: Record<string, any> = { strategy: authStrategy };
    if (authStrategy === 'form') {
      const envNames = assertNotCancel(
        await clack.text({
          message: 'Credential env var names (comma-separated; never stored in YAML)',
          placeholder: 'APP_USER, APP_PASS',
          initialValue: (prefill?.auth?.credentials_env as string) ?? '',
        }),
      ) as string;
      if (envNames.trim()) auth.credentials_env = envNames;
    }
    auth.store_state = `.auth/${name}.json`;
    target.auth = auth;
  }

  // Context
  const wantContext = assertNotCancel(
    await clack.confirm({
      message: `Add grounding context sources?${det.contextGlobs.requirements ? ' (detected docs/)' : ''}`,
      initialValue: Boolean(det.contextGlobs.requirements || prefill?.context),
    }),
  ) as boolean;
  if (wantContext) {
    const context: Record<string, any> = { ...det.contextGlobs, ...(prefill?.context ?? {}) };
    if (Object.keys(context).length === 0) context.requirements = ['docs/requirements/**/*.md'];
    target.context = context;
  }

  // Scope
  const wantScope = assertNotCancel(
    await clack.confirm({ message: 'Restrict to a single feature (scope)?', initialValue: Boolean(prefill?.scope) }),
  ) as boolean;
  if (wantScope) {
    const feature = assertNotCancel(await clack.text({ message: 'Feature name', initialValue: prefill?.scope?.feature })) as string;
    const reqFile = assertNotCancel(
      await clack.text({ message: 'Requirement file for this feature (optional)', initialValue: prefill?.scope?.requirement, placeholder: '' }),
    ) as string;
    target.scope = { feature, ...(reqFile.trim() ? { requirement: reqFile } : {}) };
  }

  // Success
  const minScenarios = assertNotCancel(
    await clack.text({ message: 'Minimum scenarios for PASS', initialValue: String(prefill?.success?.min_scenarios ?? 3), validate: (v) => (/^\d+$/.test(v) ? undefined : 'a number') }),
  ) as string;
  target.success = { min_scenarios: Number(minScenarios), must_pass: true, max_heal_attempts: 2 };

  return target;
}

/** Validate a target object with the loader's schema before writing. */
function validateTarget(obj: Record<string, any>): void {
  const parsed = targetSchema.safeParse(obj);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Generated target failed validation (this is a wizard bug if you used defaults):\n${issues}`);
  }
}

function writeFileSafe(path: string, content: string): boolean {
  if (existsSync(path)) {
    return false; // never overwrite silently
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return true;
}

async function gatherLlm(cwd: string): Promise<Record<string, any>> {
  void cwd;
  const provider = assertNotCancel(
    await clack.select({
      message: 'LLM provider (a locally logged-in CLI; no API keys stored)',
      initialValue: 'claude-cli',
      options: [
        { value: 'claude-cli', label: 'claude-cli (Claude Code)' },
        { value: 'gemini-cli', label: 'gemini-cli' },
        { value: 'codex-cli', label: 'codex-cli' },
        { value: 'ollama', label: 'ollama (local)' },
        { value: 'custom', label: 'custom (any CLI)' },
      ],
    }),
  ) as string;

  const llm: Record<string, any> = { provider };
  const model = assertNotCancel(
    await clack.text({ message: 'Model (passed to the CLI; blank = CLI default)', initialValue: provider === 'claude-cli' ? 'claude-sonnet-4-6' : '' }),
  ) as string;
  if (model.trim()) llm.model = model.trim();
  if (provider === 'custom') {
    const command = assertNotCancel(await clack.text({ message: 'Command (space-separated)', placeholder: 'llm -m gpt-4o' })) as string;
    llm.command = command.split(/\s+/).filter(Boolean);
  }
  llm.bare = assertNotCancel(await clack.confirm({ message: 'Use --bare in CI (reproducible runs)?', initialValue: true })) as boolean;
  llm.max_turns = 1;
  return llm;
}

export async function runWizard(args: WizardArgs): Promise<void> {
  if (!isInteractiveTty()) {
    throw new Error(
      'ata config requires an interactive terminal. ' +
        'On CI / non-TTY, edit testagent.config.yaml and target files directly — they share the same schema.',
    );
  }

  const cwd = process.cwd();
  const rootPath = args.configPath ? resolve(cwd, args.configPath) : join(cwd, ROOT_FILENAME);

  clack.intro('aidlc-testagent — config wizard');

  // --- init: create the root manifest + first target ----------------------
  if (args.mode === 'init') {
    if (existsSync(rootPath)) {
      const cont = assertNotCancel(
        await clack.confirm({ message: `${ROOT_FILENAME} already exists. Add a target instead?`, initialValue: true }),
      ) as boolean;
      if (!cont) {
        clack.outro('Nothing to do.');
        return;
      }
      args.mode = 'add';
    } else {
      const llm = await gatherLlm(cwd);
      const approval = assertNotCancel(
        await clack.select({
          message: 'Default approval mode',
          initialValue: 'prompt',
          options: [
            { value: 'prompt', label: 'prompt (ask before generating)' },
            { value: 'auto', label: 'auto (no prompt)' },
            { value: 'manual-edit', label: 'manual-edit (edit plan.md, re-run)' },
          ],
        }),
      ) as string;
      const budget = assertNotCancel(
        await clack.text({ message: 'Max budget USD per run (0 = unlimited)', initialValue: '2.00', validate: (v) => (/^\d+(\.\d+)?$/.test(v) ? undefined : 'a number') }),
      ) as string;

      const root = {
        version: 1,
        env: 'staging-only',
        llm,
        defaults: {
          max_heal_attempts: 2,
          timeout_ms: 30000,
          approval,
          max_budget_usd: Number(budget),
          stability: { runs: 3, quarantine: true },
        },
        targets: [{ include: 'targets/public/*.target.yaml' }, { include: 'targets/private/*.target.yaml' }],
      };
      // Validate the root with the loader's schema.
      const parsed = rootSchema.safeParse(root);
      if (!parsed.success) {
        throw new Error('Internal: generated root config failed validation: ' + parsed.error.message);
      }
      const wrote = writeFileSafe(rootPath, headerComment() + toYaml(root));
      clack.log.success(wrote ? `Wrote ${ROOT_FILENAME}` : `${ROOT_FILENAME} already exists — left untouched`);
    }
  }

  // --- add / edit / (init's first target) ---------------------------------
  if (args.mode === 'edit') {
    const targetFile = findTargetFile(cwd, args.target!);
    if (!targetFile) throw new Error(`Could not find a target file for "${args.target}".`);
    const prefill = JSON.parse(JSON.stringify(parseYamlFile(targetFile)));
    const obj = await gatherTarget(cwd, prefill);
    validateTarget(obj);
    await confirmAndWrite(obj, targetFile, true);
    clack.outro('Done.');
    return;
  }

  // init (first target) and add both gather one new target now.
  do {
    const obj = await gatherTarget(cwd);
    validateTarget(obj);

    const visibility = assertNotCancel(
      await clack.select({
        message: 'Visibility',
        initialValue: 'public',
        options: [
          { value: 'public', label: 'public (committed; reproducible by anyone)' },
          { value: 'private', label: 'private (gitignored; internal apps/URLs)' },
        ],
      }),
    ) as string;
    const dir = visibility === 'public' ? 'targets/public' : 'targets/private';
    const file = join(cwd, dir, `${obj.name}.target.yaml`);
    await confirmAndWrite(obj, file, false);

    const again = assertNotCancel(await clack.confirm({ message: 'Add another target?', initialValue: false })) as boolean;
    if (!again) break;
  } while (true);

  clack.outro('Done. Run `ata list` to see your targets, then `ata validate`.');
}

async function confirmAndWrite(obj: Record<string, any>, file: string, allowOverwrite: boolean): Promise<void> {
  const yaml = toYaml(obj);
  clack.note(yaml, `${obj.name}.target.yaml`);
  const ok = assertNotCancel(await clack.confirm({ message: `Write ${file}?`, initialValue: true })) as boolean;
  if (!ok) {
    clack.log.warn('Skipped.');
    return;
  }
  if (existsSync(file) && !allowOverwrite) {
    const over = assertNotCancel(await clack.confirm({ message: `${file} exists. Overwrite?`, initialValue: false })) as boolean;
    if (!over) {
      clack.log.warn('Left existing file untouched.');
      return;
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, yaml, 'utf8');
  clack.log.success(`Wrote ${file}`);
}

function headerComment(): string {
  return `# testagent.config.yaml — generated by \`ata config\`. Safe to hand-edit (same schema).\n# No telemetry. No model API keys: reasoning is delegated to a local LLM CLI.\n`;
}

function parseYamlFile(path: string): unknown {
  return fromYaml(readFileSync(path, 'utf8'));
}

function findTargetFile(cwd: string, name: string): string | undefined {
  for (const dir of ['targets/public', 'targets/private', 'targets']) {
    const candidate = join(cwd, dir, `${name}.target.yaml`);
    if (existsSync(candidate)) return candidate;
  }
  // fall back to scanning
  for (const dir of ['targets/public', 'targets/private']) {
    const abs = join(cwd, dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) {
      if (f.endsWith('.target.yaml') && f.startsWith(name)) return join(abs, f);
    }
  }
  return undefined;
}
