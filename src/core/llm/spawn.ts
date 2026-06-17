/**
 * Thin `child_process` helper for LLM CLI providers.
 *
 * No model SDK, no API key — providers only ever shell out to a local CLI.
 * Supports delivering the prompt via stdin (default; avoids ARG_MAX on large
 * grounded prompts) or as an argument.
 */

import { spawn } from 'node:child_process';

export interface SpawnOptions {
  /** Text to write to the child's stdin (if any). */
  stdin?: string;
  /** Milliseconds before the child is killed. */
  timeoutMs?: number;
  /** Extra environment variables (merged on top of process.env after omitEnv is applied). */
  env?: NodeJS.ProcessEnv;
  /** Env var names to strip from the inherited process.env before merging `env`. */
  omitEnv?: string[];
  /** Working directory for the child process. */
  cwd?: string;
}

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class SpawnError extends Error {
  override name = 'SpawnError';
}

/** Spawn a command, optionally feed stdin, capture stdout/stderr with a timeout. */
export function runCommand(
  command: string,
  args: string[],
  opts: SpawnOptions = {},
): Promise<SpawnResult> {
  const { stdin, timeoutMs = 120_000, env, omitEnv, cwd } = opts;

  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      const baseEnv: NodeJS.ProcessEnv = { ...process.env };
      if (omitEnv) omitEnv.forEach((k) => delete baseEnv[k]);
      child = spawn(command, args, {
        env: { ...baseEnv, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(cwd ? { cwd } : {}),
      });
    } catch (e) {
      reject(new SpawnError(`Failed to spawn "${command}": ${(e as Error).message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));

    child.on('error', (e) => {
      clearTimeout(timer);
      // ENOENT etc. — the CLI is not installed / not on PATH.
      reject(new SpawnError(`Failed to run "${command}": ${(e as Error).message}`));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr, timedOut });
    });

    if (stdin !== undefined) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }
  });
}
