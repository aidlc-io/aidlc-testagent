/**
 * Session storage (PRD §6, §13).
 *
 * Persists a reusable authenticated session (Playwright `storageState`) under
 * `.auth/` (gitignored) so flows behind login don't re-authenticate every run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { TargetConfig } from '../adapters/adapter.js';

/** Resolve where a target's session state is stored. */
export function sessionStatePath(target: TargetConfig, baseDir: string): string {
  const declared = target.auth?.storeState;
  const rel = declared ?? join('.auth', `${target.name}.json`);
  return isAbsolute(rel) ? rel : resolve(baseDir, rel);
}

export function hasStoredSession(path: string): boolean {
  return existsSync(path);
}

/** Age of a stored session in milliseconds, or Infinity if absent. */
export function storedSessionAgeMs(path: string, now: number): number {
  if (!existsSync(path)) return Infinity;
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return Infinity;
  }
}

/** Load a persisted Playwright storageState object. */
export function loadStorageState(path: string): unknown {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw);
}

/** Persist a Playwright storageState object to disk, creating `.auth/`. */
export function saveStorageState(path: string, storageState: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(storageState, null, 2), 'utf8');
}
