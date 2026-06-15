/**
 * Action guardrails (PRD §13) — STUB for Phase 1.
 *
 * The agent drives real apps on staging; destructive flows (delete, pay, send)
 * are risky. Phase 1 ships a conservative default + this config hook. A full
 * policy engine (allow/deny lists, per-verb confirmation, dry-run sandboxing)
 * is a later phase — see PRD §10, §5+.
 *
 * Today this only classifies a planned step's intent so generation can flag
 * destructive scenarios; it does not yet intercept the live driver.
 */

import type { GuardrailConfig } from './adapter.js';

const DEFAULT_DESTRUCTIVE_VERBS = [
  'delete',
  'remove',
  'destroy',
  'pay',
  'purchase',
  'checkout',
  'send',
  'submit payment',
  'transfer',
  'cancel subscription',
  'deactivate',
  'wipe',
];

export type GuardrailDecision = 'allow' | 'confirm' | 'block';

export interface ResolvedGuardrails {
  verbs: string[];
  onDestructive: 'confirm' | 'block' | 'allow';
}

export function resolveGuardrails(cfg?: GuardrailConfig): ResolvedGuardrails {
  return {
    verbs: (cfg?.destructiveVerbs ?? DEFAULT_DESTRUCTIVE_VERBS).map((v) => v.toLowerCase()),
    onDestructive: cfg?.onDestructive ?? 'confirm',
  };
}

/** Classify a natural-language step against the (stub) policy. */
export function classifyStep(step: string, guardrails: ResolvedGuardrails): GuardrailDecision {
  const lower = step.toLowerCase();
  const isDestructive = guardrails.verbs.some((v) => lower.includes(v));
  return isDestructive ? guardrails.onDestructive : 'allow';
}
