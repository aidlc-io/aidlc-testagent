/**
 * LLM provider factory. Maps `llm.provider` config to a concrete provider.
 *
 * `claude-cli` is the fully-featured default (structured output via
 * `--json-schema`, cost reporting). `gemini-cli` / `codex-cli` / `ollama` reuse
 * the same contract through command templates; any other local CLI is reachable
 * via `provider: custom`. `core/` only ever sees the LlmProvider interface.
 */

import type { LlmConfig } from '../../config/schema.js';
import type { LlmProvider } from './provider.js';
import { ClaudeCliProvider } from './claude-cli.js';
import { CustomCliProvider } from './custom-cli.js';

export * from './provider.js';
export { ClaudeCliProvider } from './claude-cli.js';
export { CustomCliProvider } from './custom-cli.js';

export function createLlmProvider(cfg: LlmConfig): LlmProvider {
  switch (cfg.provider) {
    case 'claude-cli':
      return new ClaudeCliProvider({
        model: cfg.model,
        bare: cfg.bare,
        timeoutMs: cfg.timeout_ms,
      });

    case 'gemini-cli':
      return new CustomCliProvider({
        id: 'gemini-cli',
        command: ['gemini', ...(cfg.model ? ['-m', cfg.model] : [])],
        promptVia: 'stdin',
        output: 'text',
      });

    case 'codex-cli':
      return new CustomCliProvider({
        id: 'codex-cli',
        command: ['codex', ...(cfg.model ? ['-m', cfg.model] : [])],
        promptVia: 'stdin',
        output: 'text',
      });

    case 'ollama':
      return new CustomCliProvider({
        id: 'ollama',
        command: ['ollama', 'run', cfg.model ?? 'llama3'],
        promptVia: 'stdin',
        output: 'text',
      });

    case 'custom':
      return new CustomCliProvider({
        command: cfg.command ?? [],
        promptVia: cfg.prompt_via ?? 'stdin',
        output: cfg.output ?? 'text',
        jsonPath: cfg.json_path,
      });

    default: {
      const _exhaustive: never = cfg.provider;
      throw new Error(`Unknown llm.provider: ${String(_exhaustive)}`);
    }
  }
}
