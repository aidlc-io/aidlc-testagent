/**
 * Auth orchestration (PRD §5, §6).
 *
 * Decides whether to reuse a stored session or perform a fresh login via the
 * adapter, then persists the result. The actual browser/API login lives in the
 * adapter (which may use {@link readCredentials}); this module owns the
 * env-credential contract, the reuse decision, and session persistence. It
 * never imports Playwright.
 */

import type { Logger, SessionState, TargetConfig, TestAdapter } from '../adapters/adapter.js';
import { readCredentials } from './credentials.js';
import {
  hasStoredSession,
  loadStorageState,
  saveStorageState,
  sessionStatePath,
} from './session-store.js';

export * from './credentials.js';
export * from './session-store.js';

export interface EnsureSessionArgs {
  adapter: TestAdapter;
  target: TargetConfig;
  baseDir: string;
  logger: Logger;
  /** Ignore any stored session and re-authenticate. */
  forceRefresh?: boolean;
}

/**
 * Return a usable session for the target, or `undefined` when no auth is
 * required. Reuses a stored session when possible; otherwise logs in via the
 * adapter and persists the result under `.auth/`.
 */
export async function ensureSession(args: EnsureSessionArgs): Promise<SessionState | undefined> {
  const { adapter, target, baseDir, logger, forceRefresh } = args;
  const auth = target.auth;

  if (!auth || auth.strategy === 'none') {
    return undefined;
  }

  const statePath = sessionStatePath(target, baseDir);
  const stored = hasStoredSession(statePath);

  // Reuse path: reuse-state always reuses; other strategies reuse opportunistically.
  if (!forceRefresh && stored) {
    logger.info(`Reusing stored session: ${statePath}`);
    return {
      strategy: auth.strategy,
      storageStatePath: statePath,
      storageState: safeLoad(statePath),
      reused: true,
      createdAt: new Date().toISOString(),
    };
  }

  if (auth.strategy === 'reuse-state' && !stored) {
    throw new Error(
      `auth.strategy "reuse-state" for "${target.name}" but no stored session at ${statePath}. ` +
        `Run an authenticated flow once (strategy: form) to create it, or commit a session generator.`,
    );
  }

  // Fresh login. Validate credentials are present before driving the adapter.
  if (auth.strategy === 'form' || auth.strategy === 'api') {
    readCredentials(auth); // throws loudly if env vars are missing
  }

  logger.info(`Authenticating "${target.name}" via strategy "${auth.strategy}"…`);
  const session = await adapter.authenticate(auth);

  // Persist whatever storageState the adapter produced.
  if (session.storageState !== undefined) {
    saveStorageState(statePath, session.storageState);
    logger.info(`Saved session: ${statePath}`);
  }

  return {
    ...session,
    storageStatePath: session.storageStatePath ?? statePath,
    reused: false,
  };
}

function safeLoad(path: string): unknown {
  try {
    return loadStorageState(path);
  } catch {
    return undefined;
  }
}
