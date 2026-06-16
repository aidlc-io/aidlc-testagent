/**
 * playwright-electron adapter (PRD §10, Phase 1).
 *
 * Reuses the web adapter wholesale — perception, generation, and the stability
 * runner are shared (PRD: "Web and Electron share the Playwright driver and DOM
 * perception"). Only launch/connect differs: instead of a browser + URL, it
 * launches the Electron app via `_electron.launch()` and treats its first window
 * as the page.
 */

import { dirname, isAbsolute, resolve } from 'node:path';
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
import { perceive } from '../playwright-web/perception.js';
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

  private surfaceGuide(): string {
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
    const { _electron } = await import('playwright');
    this.deps.logger.debug(`Launching Electron app: ${this.resolveExecutable()}`);
    this.app = await _electron.launch({ executablePath: this.resolveExecutable() });
    this.window = await this.app.firstWindow();
    return this.window;
  }

  override async explore(target: TargetConfig): Promise<PerceptionSnapshot> {
    const window = await this.ensureWindow();
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
      },
      plan,
      perception,
    );
  }

  override async execute(tests: GeneratedTest[], opts: ExecOpts): Promise<ExecutionResult> {
    // Electron specs self-launch; no baseURL or storageState injection.
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
