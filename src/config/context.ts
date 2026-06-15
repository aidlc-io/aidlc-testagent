/**
 * Grounding context loader (PRD §3, §5).
 *
 * Reads a target's context sources (requirements → manual tests → business →
 * source) in trust order, so the planner can treat human-authored intent as
 * higher-trust than implementation. v1 ingests everything as text; structured
 * importers (TestRail/Zephyr/Xray) come later.
 */

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { globSync } from 'glob';
import type { ContextConfig, TargetConfig } from '../adapters/adapter.js';
import type { ResolvedConfig } from './loader.js';

export type TrustTier = 'requirements' | 'manual_tests' | 'business' | 'source';

/** Numeric trust order — lower = higher trust (intent before implementation). */
export const TRUST_ORDER: TrustTier[] = ['requirements', 'manual_tests', 'business', 'source'];

export interface ContextDoc {
  tier: TrustTier;
  /** Path relative to the config base dir, used as the trace ref. */
  ref: string;
  content: string;
}

export interface ContextBundle {
  docs: ContextDoc[];
  /** True if any grounding doc was found (vs exploration-only). */
  hasGrounding: boolean;
}

/** Truncate a single doc so one huge file can't blow the token budget. */
const MAX_CHARS_PER_DOC = 24_000;

function tierGlobs(ctx: ContextConfig, tier: TrustTier): string[] {
  switch (tier) {
    case 'requirements':
      return ctx.requirements ?? [];
    case 'manual_tests':
      return ctx.manualTests ?? [];
    case 'business':
      return ctx.business ?? [];
    case 'source':
      return ctx.source ?? [];
  }
}

/** Load the grounding bundle for a target, in trust order. */
export function loadContextBundle(cfg: ResolvedConfig, target: TargetConfig): ContextBundle {
  const ctx = target.context;
  const docs: ContextDoc[] = [];
  if (!ctx) return { docs, hasGrounding: false };

  const seen = new Set<string>();
  for (const tier of TRUST_ORDER) {
    const globs = tierGlobs(ctx, tier);
    for (const pattern of globs) {
      const matches = globSync(pattern, { cwd: cfg.baseDir, absolute: true, nodir: true });
      for (const abs of matches.sort()) {
        if (seen.has(abs)) continue;
        seen.add(abs);
        let content: string;
        try {
          content = readFileSync(abs, 'utf8');
        } catch {
          continue; // skip unreadable files rather than fail the whole run
        }
        if (content.length > MAX_CHARS_PER_DOC) {
          content = content.slice(0, MAX_CHARS_PER_DOC) + '\n…[truncated]';
        }
        docs.push({ tier, ref: relative(cfg.baseDir, abs), content });
      }
    }
  }
  return { docs, hasGrounding: docs.length > 0 };
}

/** Map a trust tier to the plan's trace-ref kind. */
export function tierToTraceKind(tier: TrustTier): 'requirement' | 'manual_test' | 'business' | 'source' {
  switch (tier) {
    case 'requirements':
      return 'requirement';
    case 'manual_tests':
      return 'manual_test';
    case 'business':
      return 'business';
    case 'source':
      return 'source';
  }
}

/** Render the bundle as a labeled, trust-ordered prompt section. */
export function renderContextForPrompt(bundle: ContextBundle): string {
  if (!bundle.hasGrounding) {
    return '(no grounding context provided — exploration-only planning)';
  }
  const tierLabel: Record<TrustTier, string> = {
    requirements: 'REQUIREMENTS (highest trust — intended behavior)',
    manual_tests: 'MANUAL TEST CASES (human oracle for what to verify)',
    business: 'BUSINESS / DOMAIN RULES (the why)',
    source: 'SOURCE CODE (lowest trust — implementation detail)',
  };
  const parts: string[] = [];
  for (const tier of TRUST_ORDER) {
    const tierDocs = bundle.docs.filter((d) => d.tier === tier);
    if (tierDocs.length === 0) continue;
    parts.push(`## ${tierLabel[tier]}`);
    for (const d of tierDocs) {
      parts.push(`### ${d.ref}\n${d.content}`);
    }
  }
  return parts.join('\n\n');
}
