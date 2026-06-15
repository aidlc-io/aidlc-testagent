/**
 * Cost guard (PRD §5, §7).
 *
 * Accumulates `total_cost_usd` reported by the LLM CLI across a run and aborts
 * if it exceeds `max_budget_usd`. A budget of 0 means unlimited. The guard is
 * checked AFTER each call returns its cost (we can't know a call's cost before
 * making it), so the next call is the one refused once the ceiling is crossed.
 */

import type { CompletionRequest, CompletionResult, LlmProvider } from './llm/provider.js';

export class BudgetExceededError extends Error {
  override name = 'BudgetExceededError';
  constructor(
    public readonly spentUsd: number,
    public readonly limitUsd: number,
  ) {
    super(
      `Cost budget exceeded: spent $${spentUsd.toFixed(4)} of $${limitUsd.toFixed(2)} limit. Run aborted.`,
    );
  }
}

export class CostGuard {
  private spent = 0;
  private calls = 0;

  /** @param limitUsd per-run ceiling; 0 = unlimited. */
  constructor(private readonly limitUsd: number) {}

  get unlimited(): boolean {
    return this.limitUsd <= 0;
  }

  get spentUsd(): number {
    return this.spent;
  }

  get callCount(): number {
    return this.calls;
  }

  get limit(): number {
    return this.limitUsd;
  }

  /** Throw if the budget is already exhausted (call before an LLM request). */
  assertWithinBudget(): void {
    if (!this.unlimited && this.spent >= this.limitUsd) {
      throw new BudgetExceededError(this.spent, this.limitUsd);
    }
  }

  /** Record the cost of a completed call. */
  record(costUsd: number | undefined): void {
    this.calls += 1;
    if (typeof costUsd === 'number' && Number.isFinite(costUsd)) {
      this.spent += costUsd;
    }
  }

  summary(): string {
    const limit = this.unlimited ? 'unlimited' : `$${this.limitUsd.toFixed(2)}`;
    return `${this.calls} LLM call(s), $${this.spent.toFixed(4)} spent (limit ${limit})`;
  }
}

/**
 * Wrap a provider so every completion is metered against the guard. The guard
 * is checked before each call (aborting once over budget) and the returned cost
 * is recorded after.
 */
export function meteredProvider(provider: LlmProvider, guard: CostGuard): LlmProvider {
  return {
    id: provider.id,
    preflight: () => provider.preflight(),
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      guard.assertWithinBudget();
      const result = await provider.complete(req);
      guard.record(result.costUsd);
      return result;
    },
  };
}
