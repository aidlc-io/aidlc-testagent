/**
 * The adapter contract — the single most important abstraction in the codebase.
 *
 * `core/` reasons only against these types and the {@link TestAdapter} interface;
 * it never imports Playwright, Appium, or any surface-specific library. Each
 * surface (web, Electron, REST, iOS) lives entirely behind one adapter that
 * implements this contract. Two things vary per surface and stay inside the
 * adapter: **perception** (how the target is observed) and **driving** (how it
 * is acted upon). See PRD §4 and §6.
 *
 * These are also the canonical shapes for config (`TargetConfig`, `AuthConfig`,
 * …). The Zod schemas in `src/config/schema.ts` validate raw YAML and the loader
 * returns these exact types — schema and contract are kept structurally in sync.
 */

import type { LlmProvider } from '../core/llm/provider.js';

// ---------------------------------------------------------------------------
// Configuration shapes (canonical; mirrored by Zod in src/config/schema.ts)
// ---------------------------------------------------------------------------

export type AdapterKind =
  | 'playwright-web'
  | 'playwright-electron'
  | 'rest-api'
  | 'appium-ios';

export type PerceptionKind = 'dom' | 'schema' | 'accessibility';

/** How the agent authenticates against a target. Credentials are NEVER in YAML;
 *  `credentialsEnv` names the env vars to read at run time (PRD §7, §13). */
export interface AuthConfig {
  strategy: 'form' | 'none' | 'api' | 'reuse-state' | 'external';
  /** Optional natural-language description of the login flow (a Markdown file). */
  stepsFrom?: string;
  /** Names of env vars holding the credentials, in order (e.g. user, pass). */
  credentialsEnv?: string[];
  /** Where to persist/reuse the session (Playwright storageState). Gitignored. */
  storeState?: string;
  /** For `strategy: external` — a user-supplied pre-auth command run BEFORE the
   *  app is launched (e.g. seed an app-data token). Keeps bespoke auth out of
   *  the generic agent. Credentials reach it via the environment. */
  command?: string[];
  /** Working directory for the external command (relative to the config base). */
  cwd?: string;
}

/** Grounding context sources, ordered by trust: intent before implementation
 *  (requirements → manual tests → business → source). See PRD §3. */
export interface ContextConfig {
  requirements?: string[];
  manualTests?: string[];
  business?: string[];
  source?: string[];
}

/** Restrict generation to a single feature or a git diff instead of the whole
 *  target. May be supplied via the config file or overridden by CLI flags. */
export interface ScopeConfig {
  feature?: string;
  requirement?: string;
  /** Git base ref — only flows near changed files. Phase 3 wires this fully. */
  diff?: string;
}

/** What "success" means for a target (PRD §8). */
export interface SuccessConfig {
  minScenarios?: number;
  mustPass?: boolean;
  maxHealAttempts?: number;
}

/** Conservative action guardrail hook (PRD §13). Phase 1 ships a default + this
 *  config field; the full policy engine is a later phase. */
export interface GuardrailConfig {
  /** Verbs that require confirmation / are blocked on staging (delete, pay, …). */
  destructiveVerbs?: string[];
  /** 'confirm' (default) | 'block' | 'allow' — what to do on a destructive verb. */
  onDestructive?: 'confirm' | 'block' | 'allow';
}

/** A single target: what it is, how to reach it, what to ground on, how to
 *  authenticate, and what success means (PRD §7). */
export interface TargetConfig {
  name: string;
  adapter: AdapterKind;
  perception: PerceptionKind;

  // How to reach it — adapter-specific, all optional at the type level and
  // refined per-adapter by the config schema.
  url?: string;
  executable?: string; // playwright-electron
  spec?: string; // rest-api (OpenAPI/Swagger)
  baseUrl?: string; // rest-api
  platform?: string; // appium-ios
  device?: string; // appium-ios
  app?: string; // appium-ios

  auth?: AuthConfig;
  context?: ContextConfig;
  scope?: ScopeConfig;
  success?: SuccessConfig;
  guardrails?: GuardrailConfig;
}

// ---------------------------------------------------------------------------
// Auth / session
// ---------------------------------------------------------------------------

/** A reusable authenticated session. For Playwright surfaces this wraps a
 *  `storageState` (cookies + localStorage); other surfaces may use tokens. */
export interface SessionState {
  strategy: AuthConfig['strategy'];
  /** Path to the persisted storageState JSON on disk (under `.auth/`). */
  storageStatePath?: string;
  /** Inline Playwright storageState (cookies/origins), when not file-backed. */
  storageState?: unknown;
  /** Opaque tokens/headers for API auth. */
  tokens?: Record<string, string>;
  createdAt: string;
  /** True when this session was restored from disk rather than freshly created. */
  reused: boolean;
}

// ---------------------------------------------------------------------------
// Perception
// ---------------------------------------------------------------------------

/** One element the adapter perceived in the target (UI surfaces). */
export interface PerceivedElement {
  role: string;
  name?: string;
  /** A stable selector the generator can reference (test id, role+name, …). */
  selector?: string;
  attributes?: Record<string, string>;
}

/** One endpoint the adapter perceived (REST surfaces; Phase 2). */
export interface PerceivedEndpoint {
  method: string;
  path: string;
  summary?: string;
  requestSchema?: unknown;
  responseSchema?: unknown;
}

/** A normalized observation of the running target. Adapter-independent so the
 *  core and LLM prompts stay surface-agnostic (PRD §6). */
export interface PerceptionSnapshot {
  target: string;
  kind: 'ui' | 'schema';
  url?: string;
  title?: string;
  /** Serialized accessibility tree (preferred grounding for UI generation). */
  accessibilityTree?: string;
  /** Trimmed/structural DOM summary, when an a11y tree is insufficient. */
  domSummary?: string;
  elements?: PerceivedElement[];
  endpoints?: PerceivedEndpoint[];
  capturedAt: string;
  notes?: string[];
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type PlanStageId = 'setup' | 'smoke' | 'core' | 'edge' | 'teardown';
export type TestLayer = 'ui' | 'api';
export type Priority = 'p0' | 'p1' | 'p2';

/** Which grounding source a scenario traces to, so coverage is auditable
 *  (PRD §3, §5). Enables the Phase 2 traceability matrix via `traces_to`. */
export interface TraceRef {
  kind: 'requirement' | 'manual_test' | 'business' | 'source' | 'exploration';
  /** File path or short label of the source. */
  ref: string;
}

export interface PlanScenario {
  id: string;
  title: string;
  description?: string;
  stage: PlanStageId;
  layer: TestLayer;
  priority: Priority;
  /** What context source(s) this scenario verifies. */
  tracesTo: TraceRef[];
  /** Scenario ids this one depends on (e.g. auth/setup). */
  dependsOn: string[];
  /** High-level steps in plain language (the generator turns these into code). */
  steps: string[];
}

export interface PlanStage {
  id: PlanStageId;
  title: string;
  scenarioIds: string[];
}

/** The structured test plan produced by the planner and confirmed at the gate
 *  (PRD §5). Rendered to `generated/<target>/plan.md` for human review. */
export interface TestPlan {
  target: string;
  summary: string;
  stages: PlanStage[];
  scenarios: PlanScenario[];
  /** Explicitly not covered, surfaced for transparency at the confirmation gate. */
  outOfScope: string[];
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** A supporting artifact emitted alongside a spec (e.g. a Page Object Model). */
export interface GeneratedArtifact {
  /** Path relative to the target's generated/ directory. */
  path: string;
  code: string;
}

/** A runnable, committable test produced by the generator (PRD §5.3, §2). */
export interface GeneratedTest {
  scenarioId: string;
  name: string;
  /** Path relative to the target's generated/ directory (e.g. `tests/login.spec.ts`). */
  filePath: string;
  code: string;
  layer: TestLayer;
  /** Page Object Models / request builders shared by this test. */
  artifacts: GeneratedArtifact[];
}

// ---------------------------------------------------------------------------
// Execution + stability gate
// ---------------------------------------------------------------------------

export interface ExecOpts {
  /** Stability-gate runs: each new test runs N times; accept only if all pass. */
  runs: number;
  timeoutMs: number;
  /** Absolute directory the specs are materialized into and run from. */
  workdir: string;
  headed?: boolean;
  session?: SessionState;
}

export interface SingleRun {
  index: number;
  ok: boolean;
  durationMs?: number;
  error?: string;
}

export interface TestRunResult {
  test: GeneratedTest;
  runs: SingleRun[];
  /** pass = all runs green; fail = all/most runs red; flaky = mixed. */
  status: 'pass' | 'fail' | 'flaky';
  error?: string;
}

/** Aggregate result of executing a suite through the stability gate (PRD §5.4). */
export interface ExecutionResult {
  /** Stable, accepted tests (all N runs passed). */
  passed: TestRunResult[];
  /** Tests that failed outright. */
  failed: TestRunResult[];
  /** Flaky tests — kept OUT of the green suite, reported separately. */
  quarantined: TestRunResult[];
  total: number;
  artifactsDir?: string;
}

// ---------------------------------------------------------------------------
// The contract + adapter construction
// ---------------------------------------------------------------------------

/** A minimal logger the core injects into adapters (no telemetry; local only). */
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

/** Dependencies the core wires into an adapter at construction time. The
 *  adapter receives the LLM only via the provider interface (PRD §7a) and never
 *  a concrete CLI. */
export interface AdapterDeps {
  target: TargetConfig;
  llm: LlmProvider;
  logger: Logger;
  /** Absolute directory for this target's generated output (specs + POMs). */
  workdir: string;
  /** Absolute path to this target's persisted session (`.auth/<name>.json`).
   *  Adapters load it during explore/execute when present, and `authenticate`
   *  writes it. Keeps session handling out of `core/`. */
  authStatePath: string;
}

/**
 * Every adapter implements this interface (PRD §6). Observation (`explore` /
 * `observe`) is kept strictly separate from code generation (`generate`) to cut
 * hallucination and token cost — the generator reasons over the plan + the
 * structured {@link PerceptionSnapshot}, never raw pixels by default (PRD §5).
 */
export interface TestAdapter {
  /** Observe the running target from a cold start (navigate/launch + perceive). */
  explore(target: TargetConfig): Promise<PerceptionSnapshot>;
  /** Re-observe the current target state (after auth or a step). */
  observe(): Promise<PerceptionSnapshot>;
  /** Log in once and return a reusable session (PRD §6). */
  authenticate(auth: AuthConfig): Promise<SessionState>;
  /** Turn an approved plan + perception into runnable test code + POMs. */
  generate(plan: TestPlan, perception: PerceptionSnapshot): Promise<GeneratedTest[]>;
  /** Run the suite through the stability gate, capturing artifacts. */
  execute(tests: GeneratedTest[], opts: ExecOpts): Promise<ExecutionResult>;
  /** Release resources (browsers, processes, temp dirs). */
  dispose(): Promise<void>;
}

/** Factory signature every adapter module exports as `createAdapter`. */
export type AdapterFactory = (deps: AdapterDeps) => TestAdapter | Promise<TestAdapter>;
