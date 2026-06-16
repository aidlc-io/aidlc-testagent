/**
 * External pre-auth (PRD §13 spirit: keep bespoke auth out of the generic agent).
 *
 * `auth.strategy: external` runs a user-supplied command BEFORE the app is
 * launched — e.g. log into an SSO web flow and seed a token into the app's data
 * files. The agent never learns the app's secrets; the script owns them and
 * reads credentials from the environment.
 */

import { isAbsolute, resolve } from 'node:path';
import type { AuthConfig, Logger } from '../adapters/adapter.js';
import { runCommand } from '../core/llm/spawn.js';
import { readCredentials } from './credentials.js';

export interface RunExternalArgs {
  auth: AuthConfig;
  baseDir: string;
  logger: Logger;
  timeoutMs?: number;
}

/** Run the configured external pre-auth command. Throws on non-zero exit. */
export async function runExternalAuth(args: RunExternalArgs): Promise<void> {
  const { auth, baseDir, logger } = args;
  const command = auth.command ?? [];
  if (command.length === 0) {
    throw new Error('auth.strategy "external" requires a "command" to run.');
  }

  // Validate any declared credential env vars are present before running, so the
  // script doesn't fail halfway with a cryptic error.
  if (auth.credentialsEnv && auth.credentialsEnv.length > 0) {
    readCredentials(auth);
  }

  const [bin, ...rest] = command;
  const cwd = auth.cwd ? (isAbsolute(auth.cwd) ? auth.cwd : resolve(baseDir, auth.cwd)) : baseDir;

  logger.info(`Running external pre-auth: ${command.join(' ')} (cwd ${cwd})`);
  const res = await runCommand(bin!, rest, {
    cwd,
    timeoutMs: args.timeoutMs ?? 300_000,
  });

  // Surface the script's output to the user (it often logs progress).
  if (res.stdout.trim()) logger.debug(`pre-auth stdout:\n${res.stdout.trim().slice(-2_000)}`);
  if (res.timedOut) {
    throw new Error(`External pre-auth command timed out: ${command.join(' ')}`);
  }
  if (res.code !== 0) {
    throw new Error(
      `External pre-auth command failed (exit ${res.code}): ${command.join(' ')}\n` +
        `${(res.stderr || res.stdout).trim().slice(-2_000) || '(no output)'}`,
    );
  }
  logger.info('External pre-auth completed.');
}
