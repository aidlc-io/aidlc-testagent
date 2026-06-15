/**
 * Default LLM provider: the locally-installed, already-authenticated `claude`
 * CLI (PRD §7a). Spawns (flags below match the installed Claude Code CLI):
 *
 *   claude -p --output-format json [--json-schema <inline-json>] \
 *          [--system-prompt <s>] [--model <model>] [--strict-mcp-config]
 *
 * and feeds the prompt on stdin (avoids ARG_MAX on large grounded prompts).
 * Parses the JSON envelope: reads `.result`, checks `.is_error`, surfaces
 * `.total_cost_usd` to the cost guard. No API key or model SDK is involved —
 * auth/billing are the CLI's responsibility.
 *
 * Note vs PRD §7a: the PRD wrote `--bare` and `--max-turns 1` and a `--json-schema
 * <file>`. The shipped CLI has no `--bare`/`--max-turns`, and `--json-schema`
 * takes inline JSON. We map `bare: true` → `--strict-mcp-config` (ignore the
 * user's MCP config for reproducibility), pass the schema inline, and rely on
 * `-p` (single-shot print) instead of `--max-turns 1`.
 */

import { runCommand } from './spawn.js';
import type { CompletionRequest, CompletionResult, LlmProvider } from './provider.js';

interface ClaudeEnvelope {
  result?: string;
  /** Present when `--json-schema` is used; `.result` is empty in that case. */
  structured_output?: unknown;
  is_error?: boolean;
  total_cost_usd?: number;
  subtype?: string;
  error?: string;
}

export interface ClaudeCliOptions {
  command?: string; // default "claude"
  model?: string;
  bare?: boolean;
  timeoutMs?: number;
}

export class ClaudeCliProvider implements LlmProvider {
  readonly id = 'claude-cli';
  private readonly command: string;
  private readonly model?: string;
  private readonly bare: boolean;
  private readonly timeoutMs: number;

  constructor(opts: ClaudeCliOptions = {}) {
    this.command = opts.command ?? 'claude';
    this.model = opts.model;
    this.bare = opts.bare ?? false;
    this.timeoutMs = opts.timeoutMs ?? 240_000;
  }

  async preflight(): Promise<void> {
    try {
      const res = await runCommand(this.command, ['--version'], { timeoutMs: 15_000 });
      if (res.code !== 0) {
        throw new Error(res.stderr || `exit ${res.code}`);
      }
    } catch (e) {
      throw new Error(
        `LLM CLI "${this.command}" is not available or not authenticated.\n` +
          `aidlc-testagent delegates reasoning to a locally logged-in CLI and stores no API keys.\n` +
          `Install Claude Code and sign in:  https://docs.claude.com/claude-code\n` +
          `Then verify:  ${this.command} --version\n` +
          `Underlying error: ${(e as Error).message}`,
      );
    }
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const args = ['-p', '--output-format', 'json'];
    const model = req.model ?? this.model;
    if (model) args.push('--model', model);
    if (req.system) args.push('--system-prompt', req.system);
    if (req.schema) args.push('--json-schema', JSON.stringify(req.schema));
    if (this.bare) args.push('--strict-mcp-config');

    const res = await runCommand(this.command, args, {
      stdin: req.prompt,
      timeoutMs: this.timeoutMs,
    });

    if (res.timedOut) {
      throw new Error(`claude CLI timed out after ${this.timeoutMs}ms`);
    }

    const envelope = this.parseEnvelope(res.stdout, res.stderr, res.code);
    if (envelope.is_error) {
      throw new Error(`claude CLI reported an error: ${envelope.result ?? envelope.error ?? 'unknown'}`);
    }

    // With --json-schema the validated object is in `structured_output` and
    // `.result` is empty; otherwise the text is in `.result`.
    let text: string;
    if (req.schema && envelope.structured_output !== undefined) {
      text = JSON.stringify(envelope.structured_output);
    } else if (typeof envelope.result === 'string') {
      text = envelope.result;
    } else {
      throw new Error(`claude CLI envelope had no usable output. Raw: ${res.stdout.slice(0, 500)}`);
    }

    return {
      text,
      raw: envelope,
      costUsd: typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : undefined,
    };
  }

  private parseEnvelope(stdout: string, stderr: string, code: number | null): ClaudeEnvelope {
    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new Error(
        `claude CLI returned no output (exit ${code}). stderr: ${stderr.slice(0, 500) || '(empty)'}`,
      );
    }
    try {
      return JSON.parse(trimmed) as ClaudeEnvelope;
    } catch {
      throw new Error(
        `Could not parse claude CLI JSON output (exit ${code}). ` +
          `First 500 chars: ${trimmed.slice(0, 500)}`,
      );
    }
  }
}
