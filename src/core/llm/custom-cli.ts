/**
 * Custom LLM provider (PRD §7a): drive ANY local CLI via a command template.
 *
 *   llm:
 *     provider: custom
 *     command: ["llm", "-m", "gpt-4o"]   # Simon Willison's llm, aichat, etc.
 *     prompt_via: stdin                   # or "arg"
 *     output: text                        # or "json" with json_path to .result
 *
 * Covers gemini-cli / codex-cli / ollama too — same contract, different command.
 * Cost is unknown for arbitrary CLIs, so costUsd is omitted (the cost guard
 * simply treats it as 0 / unlimited unless the CLI emits a parseable field).
 */

import { runCommand } from './spawn.js';
import type { CompletionRequest, CompletionResult, LlmProvider } from './provider.js';

export interface CustomProviderOptions {
  id?: string;
  command: string[];
  promptVia?: 'stdin' | 'arg';
  output?: 'text' | 'json';
  /** Dotted path to the result field when output is json (default "result"). */
  jsonPath?: string;
  timeoutMs?: number;
}

function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

export class CustomCliProvider implements LlmProvider {
  readonly id: string;
  private readonly command: string[];
  private readonly promptVia: 'stdin' | 'arg';
  private readonly output: 'text' | 'json';
  private readonly jsonPath: string;
  private readonly timeoutMs: number;

  constructor(opts: CustomProviderOptions) {
    if (!opts.command || opts.command.length === 0) {
      throw new Error('custom LLM provider requires a non-empty command array');
    }
    this.id = opts.id ?? `custom:${opts.command[0]}`;
    this.command = opts.command;
    this.promptVia = opts.promptVia ?? 'stdin';
    this.output = opts.output ?? 'text';
    this.jsonPath = opts.jsonPath ?? 'result';
    this.timeoutMs = opts.timeoutMs ?? 180_000;
  }

  async preflight(): Promise<void> {
    const bin = this.command[0]!;
    try {
      // Most CLIs accept --version or --help; tolerate non-zero but require it runs.
      await runCommand(bin, ['--version'], { timeoutMs: 15_000 });
    } catch (e) {
      throw new Error(
        `Custom LLM CLI "${bin}" is not available on PATH.\n` +
          `Install it and ensure it is authenticated. Underlying error: ${(e as Error).message}`,
      );
    }
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const [bin, ...baseArgs] = this.command;
    const fullPrompt = req.system ? `${req.system}\n\n---\n\n${req.prompt}` : req.prompt;

    const args = [...baseArgs];
    const spawnOpts: { stdin?: string; timeoutMs: number } = { timeoutMs: this.timeoutMs };
    if (this.promptVia === 'arg') {
      args.push(fullPrompt);
    } else {
      spawnOpts.stdin = fullPrompt;
    }

    const res = await runCommand(bin!, args, spawnOpts);
    if (res.timedOut) throw new Error(`${bin} timed out after ${this.timeoutMs}ms`);
    if (res.code !== 0) {
      throw new Error(`${bin} exited ${res.code}: ${res.stderr.slice(0, 500) || '(no stderr)'}`);
    }

    if (this.output === 'text') {
      return { text: res.stdout.trim() };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout.trim());
    } catch {
      throw new Error(`Expected JSON from ${bin} but could not parse it: ${res.stdout.slice(0, 500)}`);
    }
    const value = getByPath(parsed, this.jsonPath);
    if (typeof value !== 'string') {
      throw new Error(`json_path "${this.jsonPath}" did not resolve to a string in ${bin} output`);
    }
    const cost = getByPath(parsed, 'total_cost_usd');
    return {
      text: value,
      raw: parsed,
      costUsd: typeof cost === 'number' ? cost : undefined,
    };
  }
}
