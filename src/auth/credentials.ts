/**
 * Credential resolution (PRD §7, §13).
 *
 * Credentials NEVER live in YAML. `auth.credentials_env` names the env vars to
 * read at run time; this module reads them and fails loudly if any are missing,
 * so a login can't silently proceed with blank credentials.
 */

import type { AuthConfig } from '../adapters/adapter.js';

export interface ResolvedCredentials {
  /** Values in the declared env-var order. */
  values: string[];
  /** Convenience: first value (common username slot). */
  username?: string;
  /** Convenience: second value (common password slot). */
  password?: string;
  /** Map of env-var name -> value, for templated login flows. */
  byName: Record<string, string>;
}

/** Read the env vars named in `auth.credentials_env`. Throws on any missing. */
export function readCredentials(auth: AuthConfig): ResolvedCredentials {
  const names = auth.credentialsEnv ?? [];
  if (names.length === 0) {
    throw new Error(
      `auth.strategy "${auth.strategy}" needs credentials but no credentials_env was declared. ` +
        `List the env var names (e.g. credentials_env: USER, PASS).`,
    );
  }
  const missing: string[] = [];
  const byName: Record<string, string> = {};
  const values: string[] = [];
  for (const name of names) {
    const v = process.env[name];
    if (v === undefined || v === '') {
      missing.push(name);
      continue;
    }
    byName[name] = v;
    values.push(v);
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing credential env var(s): ${missing.join(', ')}. ` +
        `Set them in your shell or CI secrets (never in YAML).`,
    );
  }
  return {
    values,
    username: values[0],
    password: values[1],
    byName,
  };
}
