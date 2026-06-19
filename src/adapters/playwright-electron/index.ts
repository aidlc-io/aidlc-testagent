/**
 * playwright-electron adapter (PRD §10, Phase 1).
 *
 * Reuses the web adapter wholesale — perception, generation, and the stability
 * runner are shared (PRD: "Web and Electron share the Playwright driver and DOM
 * perception"). Only launch/connect differs: instead of a browser + URL, it
 * launches the Electron app via `_electron.launch()` and treats its first window
 * as the page.
 */

import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { globSync } from 'glob';
import type { ElectronApplication, Page } from 'playwright';
import type {
  AdapterDeps,
  AuthConfig,
  ExecOpts,
  ExecutionResult,
  GeneratedTest,
  PerceptionSnapshot,
  SessionState,
  TargetConfig,
  TestAdapter,
} from '../adapter.js';
import { WebAdapter } from '../playwright-web/index.js';
import { exploreManual, perceive } from '../playwright-web/perception.js';
import { generateTests } from '../playwright-web/generate.js';
import { runStabilitySuite } from '../playwright-web/runner.js';
import { formLogin } from '../playwright-web/login.js';
import { readCredentials } from '../../auth/credentials.js';

export class ElectronAdapter extends WebAdapter {
  private app?: ElectronApplication;
  private window?: Page;

  /** Resolve the app executable relative to the config base dir. */
  private resolveExecutable(): string {
    const exe = this.deps.target.executable;
    if (!exe) throw new Error(`electron target "${this.deps.target.name}" requires an "executable".`);
    if (isAbsolute(exe)) return exe;
    // workdir is <baseDir>/generated/<name>; recover baseDir.
    const baseDir = dirname(dirname(this.deps.workdir));
    return resolve(baseDir, exe);
  }

  /** Load up to 8 oracle spec files from manual_tests context to give the LLM
   *  real selectors and PageHelper usage patterns to copy from. */
  private loadOracleSpecs(): string {
    const manualTests = this.deps.target.context?.manualTests;
    if (!manualTests?.length) return '';
    const baseDir = this.deps.baseDir;

    const seen = new Set<string>();
    const parts: string[] = [];

    for (const pattern of manualTests) {
      const matches = globSync(pattern, { cwd: baseDir, absolute: true, nodir: true });
      for (const abs of matches.sort()) {
        if (seen.has(abs)) continue;
        if (parts.length >= 8) break;
        seen.add(abs);
        try {
          let content = readFileSync(abs, 'utf8');
          if (content.length > 2_500) content = content.slice(0, 2_500) + '\n…[truncated]';
          parts.push(`### ${relative(baseDir, abs)}\n\`\`\`typescript\n${content}\n\`\`\``);
        } catch { /* skip unreadable */ }
      }
    }
    return parts.join('\n\n');
  }

  private surfaceGuide(): string {
    if (this.deps.target.surface_guide) return this.deps.target.surface_guide;
    return `This is an ELECTRON desktop target. In each spec:
- import { test, expect, _electron as electron } from '@playwright/test';
- launch the app in the test: const app = await electron.launch({ executablePath: ${JSON.stringify(this.resolveExecutable())} });
- get the window: const window = await app.firstWindow();
- drive "window" like a page (window.getByRole(...), window.click(...));
- close it at the end: await app.close();
Do NOT use baseURL or page.goto — Electron has no URL.`;
  }

  private async ensureWindow(): Promise<Page> {
    if (this.window) return this.window;
    const exe = this.resolveExecutable();

    // Kill any lingering instance first (mirrors lhappautotest/electron-fixture.ts).
    // Without this, a leftover process from a previous interrupted run causes
    // `electron.launch()` to fail with "Process failed to launch!".
    const appBaseName = exe.split('/').pop() ?? 'Kelvin';
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /F /IM "${appBaseName}.exe" /T`, { stdio: 'ignore' });
      } else {
        execSync(`pkill -f "${appBaseName}" || true`, { stdio: 'ignore' });
      }
      this.deps.logger.debug(`Killed any existing "${appBaseName}" processes`);
      await new Promise((r) => setTimeout(r, 2_000));
    } catch {
      // No process running — fine
    }

    const { _electron } = await import('playwright');
    this.deps.logger.debug(`Launching Electron app: ${exe}`);
    // Strip ELECTRON_RUN_AS_NODE (set by the Claude Code / Electron shell that
    // may be our parent process). When inherited, it makes Electron treat itself
    // as a bare Node.js process instead of launching the GUI app, causing
    // Playwright's CDP connection to fail with "Process failed to launch!".
    const launchEnv = { ...process.env };
    delete launchEnv['ELECTRON_RUN_AS_NODE'];
    delete launchEnv['ELECTRON_NO_ATTACH_CONSOLE'];
    this.app = await _electron.launch({ executablePath: exe, env: launchEnv as Record<string, string>, timeout: 200_000 });
    this.window = await this.app.firstWindow();
    return this.window;
  }

  override async explore(target: TargetConfig): Promise<PerceptionSnapshot> {
    const window = await this.ensureWindow();
    if (target.explore?.strategy === 'manual') {
      return exploreManual(window, target, this.deps.workdir);
    }
    await window.waitForLoadState('domcontentloaded').catch(() => undefined);
    return perceive(window, target.name);
  }

  override async observe(): Promise<PerceptionSnapshot> {
    const window = await this.ensureWindow();
    return perceive(window, this.deps.target.name);
  }

  override async authenticate(auth: AuthConfig): Promise<SessionState> {
    const createdAt = new Date().toISOString();
    const logger = this.deps.logger;

    if (auth.strategy === 'none') {
      return { strategy: 'none', reused: false, createdAt };
    }
    if (auth.strategy !== 'form') {
      logger.warn(`electron auth strategy "${auth.strategy}" is not supported in Phase 1; skipping login.`);
      return { strategy: auth.strategy, reused: false, createdAt };
    }

    const creds = readCredentials(auth);
    const window = await this.ensureWindow();
    const app = this.app!;

    // The login screen typically shows a "LOG IN" / "Sign in" trigger that may
    // either navigate this window or open a new (SSO) window.
    const trigger = window
      .getByRole('button', { name: /log ?in|sign ?in/i })
      .or(window.getByText(/^\s*(log ?in|sign ?in)\s*$/i))
      .first();

    const hasTrigger = (await trigger.count().catch(() => 0)) > 0;
    if (!hasTrigger) {
      logger.info('No login trigger found — Kelvin appears already authenticated.');
    } else {
      logger.info('Clicking the login trigger…');
      const newWindowPromise = app.waitForEvent('window', { timeout: 12_000 }).catch(() => null);
      await trigger.click().catch(() => undefined);
      const ssoWindow = await newWindowPromise;
      const loginSurface = ssoWindow ?? window;
      if (ssoWindow) logger.info('SSO opened a new window; driving the login form there.');

      try {
        await loginSurface.waitForLoadState('domcontentloaded').catch(() => undefined);
        await formLogin(loginSurface, creds.username ?? '', creds.password ?? '', logger);
        logger.info('Submitted credentials; waiting for the app to return…');
      } catch (e) {
        logger.warn(
          `Could not complete the Electron login automatically: ${(e as Error).message}. ` +
            `The flow may hand off to the external system browser, which Phase 1 cannot drive.`,
        );
      }
      await window.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    }

    // Best-effort session capture. Electron also persists its own session in the
    // app's userData, so a later relaunch is typically still authenticated.
    let storageState: unknown;
    try {
      storageState = await app.context().storageState();
    } catch {
      /* not all Electron apps expose a capturable storageState */
    }

    return {
      strategy: auth.strategy,
      storageState,
      storageStatePath: this.deps.authStatePath,
      reused: false,
      createdAt,
    };
  }

  override async generate(
    plan: Parameters<TestAdapter['generate']>[0],
    perception: PerceptionSnapshot,
  ): Promise<GeneratedTest[]> {
    return generateTests(
      {
        llm: this.deps.llm,
        logger: this.deps.logger,
        target: this.deps.target,
        surfaceGuide: this.surfaceGuide(),
        oracleSpecs: this.loadOracleSpecs(),
      },
      plan,
      perception,
    );
  }

  override async execute(tests: GeneratedTest[], opts: ExecOpts): Promise<ExecutionResult> {
    // When specs live in an external repo (outputDir set), their beforeAll calls
    // getElectronApp() via lhappautotest fixtures — close ata's own window first
    // so the fixture doesn't race against an already-running Kelvin instance.
    if (opts.outputDir && this.app) {
      this.deps.logger.debug('Closing ata-managed Electron window before handing off to fixture-managed run…');
      await this.app.close().catch(() => undefined);
      this.app = undefined;
      this.window = undefined;
      // Brief pause to let the OS release the process socket before re-launch.
      await new Promise((r) => setTimeout(r, 2_000));
    }
    return runStabilitySuite(tests, opts, { logger: this.deps.logger });
  }

  override async dispose(): Promise<void> {
    await this.app?.close().catch(() => undefined);
    this.app = undefined;
    this.window = undefined;
    await super.dispose();
  }
}

export function createElectronAdapter(deps: AdapterDeps): TestAdapter {
  return new ElectronAdapter(deps);
}
