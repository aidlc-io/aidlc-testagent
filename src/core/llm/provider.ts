/**
 * The LLM provider contract (PRD §7a).
 *
 * `core/` depends ONLY on this interface — never on Claude Code, `claude`, or
 * any specific CLI — so swapping reasoning engines is a one-line config change.
 * `aidlc-testagent` does not call any model API directly and manages no API
 * keys: every provider shells out to a locally-installed, already-authenticated
 * CLI whose auth/billing are its own responsibility.
 */

/** A JSON Schema object passed to the CLI to demand schema-conforming output. */
export type JsonSchema = Record<string, unknown>;

/** Spawn config for one MCP server (stdio transport). */
export interface McpServerConfig {
  type: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface CompletionRequest {
  /** System / role framing for the model. */
  system?: string;
  /** The user prompt. */
  prompt: string;
  /** When set, demand output conforming to this JSON Schema.
   *  Mutually exclusive with `mcpServers` — omit when using MCP tool calls. */
  schema?: JsonSchema;
  /** Optional per-call model override (else the provider default is used). */
  model?: string;
  /** MCP servers to inject for this call. When present, the provider passes
   *  them to the CLI so the model can drive browser/tool actions.
   *  Incompatible with `schema` (structured-output mode). */
  mcpServers?: Record<string, McpServerConfig>;
  /** Per-call timeout override in ms. Falls back to the provider default. */
  timeoutMs?: number;
}

export interface CompletionResult {
  /** The model's textual result (the `.result` field of the CLI envelope). */
  text: string;
  /** The raw parsed envelope, for debugging. */
  raw?: unknown;
  /** Cost reported by the CLI, fed to the cost guard (PRD §7). */
  costUsd?: number;
}

export interface LlmProvider {
  /** Identifier for logs/diagnostics (e.g. `claude-cli`). */
  readonly id: string;
  /** Verify the underlying CLI is installed and authenticated (preflight). */
  preflight(): Promise<void>;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}
