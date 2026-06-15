/**
 * Adapter registry. Maps an adapter kind to its factory.
 *
 * Phase 1 ships `playwright-web` and `playwright-electron` (which share
 * perception + generation code). `rest-api` (Phase 2) and `appium-ios`
 * (Phase 4) are declared so config validates, but fail loudly if run.
 */

import type { AdapterDeps, TestAdapter } from './adapter.js';
import { createWebAdapter } from './playwright-web/index.js';
import { createElectronAdapter } from './playwright-electron/index.js';

export * from './adapter.js';

export async function createAdapter(deps: AdapterDeps): Promise<TestAdapter> {
  switch (deps.target.adapter) {
    case 'playwright-web':
      return createWebAdapter(deps);
    case 'playwright-electron':
      return createElectronAdapter(deps);
    case 'rest-api':
      throw new Error(
        `adapter "rest-api" is not implemented in Phase 1 (planned for Phase 2). Target: ${deps.target.name}`,
      );
    case 'appium-ios':
      throw new Error(
        `adapter "appium-ios" is not implemented in Phase 1 (planned for Phase 4). Target: ${deps.target.name}`,
      );
    default: {
      const _exhaustive: never = deps.target.adapter;
      throw new Error(`Unknown adapter: ${String(_exhaustive)}`);
    }
  }
}
