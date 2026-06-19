/**
 * playwright-web adapter (PRD §10, Phase 1).
 *
 * Implements the full {@link TestAdapter} contract for web targets:
 * perception via accessibility tree / DOM, real `@playwright/test` spec
 * generation with Page Object Models, and execution through the stability gate.
 * Perception, generation, and the runner are shared with playwright-electron.
 */

import { existsSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from 'playwright';
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
import { exploreManual, perceive } from './perception.js';
import { generateTests } from './generate.js';
import { runStabilitySuite } from './runner.js';
import { formLogin } from './login.js';
import { readCredentials } from '../../auth/credentials.js';

const WEB_SURFACE_GUIDE = `This is a WEB target. The @playwright/test "page" fixture is provided to each test.
baseURL is configured, so navigate with page.goto('/') or page.goto('/path'). Do not launch a browser yourself.`;

export class WebAdapter implements TestAdapter {
  protected browser?: Browser;
  protected context?: BrowserContext;
  protected page?: Page;

  constructor(protected readonly deps: AdapterDeps) {}

  /** Lazily import Playwright so `core/` never pulls it in. */
  protected async launchBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    const { chromium } = await import('playwright');
    this.browser = await chromium.launch({ headless: !this.deps.headed });
    return this.browser;
  }

  protected async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    const browser = await this.launchBrowser();
    const useState = existsSync(this.deps.authStatePath) ? this.deps.authStatePath : undefined;
    if (useState) this.deps.logger.debug(`Loading stored session into context: ${useState}`);
    this.context = await browser.newContext(useState ? { storageState: useState } : {});
    return this.context;
  }

  protected async ensurePage(): Promise<Page> {
    if (this.page) return this.page;
    const ctx = await this.ensureContext();
    this.page = await ctx.newPage();
    return this.page;
  }

  async explore(target: TargetConfig): Promise<PerceptionSnapshot> {
    const page = await this.ensurePage();
    if (target.explore?.strategy === 'manual') {
      return exploreManual(page, target, this.deps.workdir);
    }
    if (target.url) {
      await page.goto(target.url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    }
    return perceive(page, target.name);
  }

  async observe(): Promise<PerceptionSnapshot> {
    const page = await this.ensurePage();
    return perceive(page, this.deps.target.name);
  }

  async authenticate(auth: AuthConfig): Promise<SessionState> {
    const target = this.deps.target;
    if (auth.strategy === 'none') {
      return { strategy: 'none', reused: false, createdAt: new Date().toISOString() };
    }

    // Fresh, unauthenticated context for the login.
    const browser = await this.launchBrowser();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    if (!target.url) throw new Error(`web target "${target.name}" needs a url to authenticate.`);
    await page.goto(target.url, { waitUntil: 'domcontentloaded' });

    if (auth.strategy === 'form') {
      const creds = readCredentials(auth);
      await formLogin(page, creds.username ?? '', creds.password ?? '', this.deps.logger);
    } else if (auth.strategy === 'api') {
      throw new Error(`auth.strategy "api" is not implemented for web in Phase 1 (use "form").`);
    }

    const storageState = await ctx.storageState();

    // Adopt the logged-in context for subsequent explore/observe.
    await this.context?.close().catch(() => undefined);
    this.context = ctx;
    this.page = page;

    return {
      strategy: auth.strategy,
      storageState,
      storageStatePath: this.deps.authStatePath,
      reused: false,
      createdAt: new Date().toISOString(),
    };
  }

  async getStorageState(): Promise<unknown> {
    return this.context?.storageState();
  }

  async generate(plan: Parameters<TestAdapter['generate']>[0], perception: PerceptionSnapshot): Promise<GeneratedTest[]> {
    return generateTests(
      { llm: this.deps.llm, logger: this.deps.logger, target: this.deps.target, surfaceGuide: WEB_SURFACE_GUIDE },
      plan,
      perception,
    );
  }

  async execute(tests: GeneratedTest[], opts: ExecOpts): Promise<ExecutionResult> {
    const storageStatePath = existsSync(this.deps.authStatePath) ? this.deps.authStatePath : undefined;
    return runStabilitySuite(tests, opts, {
      baseURL: this.deps.target.url,
      storageStatePath,
      logger: this.deps.logger,
    });
  }

  async dispose(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = undefined;
    this.page = undefined;
    this.browser = undefined;
  }
}

export function createWebAdapter(deps: AdapterDeps): TestAdapter {
  return new WebAdapter(deps);
}
