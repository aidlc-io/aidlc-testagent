/**
 * Zod schemas for `testagent.config.yaml` and per-target files (PRD §7).
 *
 * Schemas accept the snake_case YAML the user writes and transform to the
 * camelCase domain types in `adapters/adapter.ts`, which are the canonical
 * shapes. The wizard validates with these EXACT schemas before writing, so
 * hand-edited and generated config can never diverge (PRD §11a).
 *
 * Everything fails loudly: malformed input throws a Zod error the loader turns
 * into a readable, actionable message.
 */

import { z } from 'zod';
import type {
  AuthConfig,
  ContextConfig,
  GuardrailConfig,
  ScopeConfig,
  SuccessConfig,
  TargetConfig,
} from '../adapters/adapter.js';

// --- helpers ---------------------------------------------------------------

/** Accept `"A, B"` or `["A","B"]` and normalize to a trimmed string[]. */
const envNameList = z
  .union([z.string(), z.array(z.string())])
  .transform((v) =>
    (Array.isArray(v) ? v : v.split(','))
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

const globList = z.array(z.string()).optional();

// --- auth ------------------------------------------------------------------

export const authSchema = z
  .object({
    strategy: z.enum(['form', 'none', 'api', 'reuse-state', 'external']),
    steps_from: z.string().optional(),
    credentials_env: envNameList.optional(),
    store_state: z.string().optional(),
    command: z.array(z.string()).optional(),
    cwd: z.string().optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.strategy === 'external' && (!a.command || a.command.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'auth.strategy "external" requires a non-empty "command" array',
        path: ['command'],
      });
    }
  })
  .transform(
    (a): AuthConfig => ({
      strategy: a.strategy,
      stepsFrom: a.steps_from,
      credentialsEnv: a.credentials_env,
      storeState: a.store_state,
      command: a.command,
      cwd: a.cwd,
    }),
  );

// --- context ---------------------------------------------------------------

export const contextSchema = z
  .object({
    requirements: globList,
    manual_tests: globList,
    business: globList,
    source: globList,
  })
  .strict()
  .transform(
    (c): ContextConfig => ({
      requirements: c.requirements,
      manualTests: c.manual_tests,
      business: c.business,
      source: c.source,
    }),
  );

// --- scope -----------------------------------------------------------------

export const scopeSchema = z
  .object({
    feature: z.string().optional(),
    requirement: z.string().optional(),
    diff: z.string().optional(),
  })
  .strict()
  .transform((s): ScopeConfig => ({ ...s }));

// --- success ---------------------------------------------------------------

export const successSchema = z
  .object({
    min_scenarios: z.number().int().positive().optional(),
    must_pass: z.boolean().optional(),
    max_heal_attempts: z.number().int().nonnegative().optional(),
  })
  .strict()
  .transform(
    (s): SuccessConfig => ({
      minScenarios: s.min_scenarios,
      mustPass: s.must_pass,
      maxHealAttempts: s.max_heal_attempts,
    }),
  );

// --- guardrails ------------------------------------------------------------

export const guardrailSchema = z
  .object({
    destructive_verbs: z.array(z.string()).optional(),
    on_destructive: z.enum(['confirm', 'block', 'allow']).optional(),
  })
  .strict()
  .transform(
    (g): GuardrailConfig => ({
      destructiveVerbs: g.destructive_verbs,
      onDestructive: g.on_destructive,
    }),
  );

// --- target ----------------------------------------------------------------

export const adapterKindSchema = z.enum([
  'playwright-web',
  'playwright-electron',
  'rest-api',
  'appium-ios',
]);

export const perceptionSchema = z.enum(['dom', 'schema', 'accessibility']);

/** Default perception per adapter when the field is omitted. */
function defaultPerception(adapter: z.infer<typeof adapterKindSchema>) {
  switch (adapter) {
    case 'rest-api':
      return 'schema' as const;
    case 'appium-ios':
      return 'accessibility' as const;
    default:
      return 'dom' as const;
  }
}

const targetBase = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-_]*$/i, 'name must be a slug (letters, digits, -, _)'),
    adapter: adapterKindSchema,
    perception: perceptionSchema.optional(),
    url: z.string().url().optional(),
    executable: z.string().optional(),
    spec: z.string().optional(),
    base_url: z.string().url().optional(),
    platform: z.string().optional(),
    device: z.string().optional(),
    app: z.string().optional(),
    auth: authSchema.optional(),
    context: contextSchema.optional(),
    scope: scopeSchema.optional(),
    success: successSchema.optional(),
    guardrails: guardrailSchema.optional(),
  })
  .strict();

export const targetSchema = targetBase
  .transform(
    (t): TargetConfig => ({
      name: t.name,
      adapter: t.adapter,
      perception: t.perception ?? defaultPerception(t.adapter),
      url: t.url,
      executable: t.executable,
      spec: t.spec,
      baseUrl: t.base_url,
      platform: t.platform,
      device: t.device,
      app: t.app,
      auth: t.auth,
      context: t.context,
      scope: t.scope,
      success: t.success,
      guardrails: t.guardrails,
    }),
  )
  .superRefine((t, ctx) => {
    const requireField = (field: keyof TargetConfig, label: string) => {
      if (!t[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `target "${t.name}" (${t.adapter}) requires "${label}"`,
          path: [label],
        });
      }
    };
    switch (t.adapter) {
      case 'playwright-web':
        requireField('url', 'url');
        break;
      case 'playwright-electron':
        requireField('executable', 'executable');
        break;
      case 'rest-api':
        requireField('spec', 'spec');
        requireField('baseUrl', 'base_url');
        break;
      case 'appium-ios':
        requireField('app', 'app');
        break;
    }
  });

// --- llm -------------------------------------------------------------------

export const llmSchema = z
  .object({
    provider: z
      .enum(['claude-cli', 'gemini-cli', 'codex-cli', 'ollama', 'custom'])
      .default('claude-cli'),
    model: z.string().optional(),
    bare: z.boolean().default(false),
    max_turns: z.number().int().positive().default(1),
    // custom-provider fields (PRD §7a)
    command: z.array(z.string()).optional(),
    prompt_via: z.enum(['stdin', 'arg']).optional(),
    output: z.enum(['text', 'json']).optional(),
    json_path: z.string().optional(),
  })
  .strict()
  .superRefine((l, ctx) => {
    if (l.provider === 'custom' && (!l.command || l.command.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'llm.provider "custom" requires a non-empty "command" array',
        path: ['command'],
      });
    }
  });

export type LlmConfig = z.infer<typeof llmSchema>;

// --- defaults --------------------------------------------------------------

export const stabilitySchema = z
  .object({
    runs: z.number().int().positive().default(3),
    quarantine: z.boolean().default(true),
  })
  .strict();

export const defaultsSchema = z
  .object({
    max_heal_attempts: z.number().int().nonnegative().default(2),
    timeout_ms: z.number().int().positive().default(30000),
    approval: z.enum(['prompt', 'auto', 'manual-edit']).default('prompt'),
    max_budget_usd: z.number().nonnegative().default(0),
    stability: stabilitySchema.default({ runs: 3, quarantine: true }),
  })
  .strict();

export type DefaultsConfig = z.infer<typeof defaultsSchema>;

// --- root manifest ---------------------------------------------------------

export const rootSchema = z
  .object({
    version: z.literal(1),
    env: z.enum(['staging-only', 'any']).default('staging-only'),
    /** Extra hosts explicitly allowed under staging-only (PRD §13). */
    allow_hosts: z.array(z.string()).optional(),
    llm: llmSchema,
    defaults: defaultsSchema.default({}),
    targets: z
      .array(z.object({ include: z.string() }).strict())
      .default([]),
  })
  .strict();

export type RootConfigRaw = z.infer<typeof rootSchema>;
