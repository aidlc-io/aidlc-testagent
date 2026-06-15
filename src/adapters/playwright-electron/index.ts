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
    // Electron apps persist their own session state; Phase 1 supports no-auth
    // and best-effort in-window login without external storageState.
    if (auth.strategy !== 'none') {
      this.deps.logger.warn(
        `electron auth strategy "${auth.strategy}" is best-effort in Phase 1 (no storageState persistence).`,
      );
    }
    return { strategy: auth.strategy, reused: false, createdAt: new Date().toISOString() };
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
