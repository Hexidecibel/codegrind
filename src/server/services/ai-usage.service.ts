// =============================================================================
// ai-usage.service — the spend ledger and the "AI reviews" switch
// =============================================================================
// Every model call passes through llm.client's `structured` / `text`, which hand
// each call's usage to the recorder installed here: one `ai_usage` row per call,
// priced with costOf. The Today header sums it for "today" and "this month".
// Mock and debrief usage from before the ledger existed was backfilled into it
// by the migration that created it (db.migrate.ts), so it is the ONE source the
// spend sum reads — summing mocks.usage as well would count those calls twice.
//
// The switch: `ai.reviews` in settings, default ON. It gates the AUTOMATIC calls
// Phase F added (warm-up card grading, the Recognize check on reveal, step
// reviews, the auto debrief). Click-only calls (Debrief me, AI check) still work.

import { costOf } from '../../shared/mock.js';
import type { AiSpend } from '../../shared/today.js';
import { db, getSetting, setSetting } from './db.js';
import { routingFor, useUsageRecorder, type UsageEvent } from './llm.client.js';

export const AI_REVIEWS_KEY = 'ai.reviews';

export function aiReviewsEnabled(): boolean {
  try {
    return getSetting<unknown>(AI_REVIEWS_KEY) !== false;
  } catch {
    return true;
  }
}

export function setAiReviews(on: boolean): void {
  setSetting(AI_REVIEWS_KEY, on);
}

let stmts: ReturnType<typeof prepare> | null = null;
function prepare() {
  return {
    insert: db.prepare(`
      INSERT INTO ai_usage (at, source, role, model, inputTokens, outputTokens, cacheRead, cacheWrite, costUsd)
      VALUES (@at, @source, @role, @model, @inputTokens, @outputTokens, @cacheRead, @cacheWrite, @costUsd)
    `),
    sumSince: db.prepare(`SELECT COALESCE(SUM(costUsd), 0) AS usd, COUNT(*) AS n FROM ai_usage WHERE at >= ?`),
  };
}
const S = () => (stmts ??= prepare());

/** The dollars for one call's meta (null for an unpriced model). Pure. */
export function costOfMeta(meta: UsageEvent['meta']): number | null {
  return costOf(meta.servedModel, {
    inputTokens: meta.usage.inputTokens,
    outputTokens: meta.usage.outputTokens,
    cacheReadTokens: meta.usage.cachedInputTokens,
    cacheWriteTokens: meta.usage.cacheWriteInputTokens ?? 0,
  });
}

export function recordAiUsage(e: UsageEvent, now = new Date()): void {
  S().insert.run({
    at: now.toISOString(),
    source: e.source.slice(0, 64),
    role: e.role,
    model: e.meta.servedModel || 'unknown',
    inputTokens: e.meta.usage.inputTokens || 0,
    outputTokens: e.meta.usage.outputTokens || 0,
    cacheRead: e.meta.usage.cachedInputTokens || 0,
    cacheWrite: e.meta.usage.cacheWriteInputTokens ?? 0,
    costUsd: costOfMeta(e.meta),
  });
}

/**
 * A pre-flight estimate for one `small` call of a typical shape, priced on the
 * model that role is ROUTED to right now (Haiku 5.5 by default since Phase H) —
 * so the "~$" on a button follows the routing instead of a hard-coded model.
 * Null when that model has no known price (a local endpoint: free). Never throws.
 */
export function smallCallEstimateUsd(shape: { inputTokens: number; outputTokens: number }): number | null {
  try {
    return costOf(routingFor('small').model, { ...shape, cacheReadTokens: 0, cacheWriteTokens: 0 });
  } catch {
    return null;
  }
}

/** Typical small-call shapes, measured on the 2026-10-21 live samples (rounded up). */
export const SMALL_CALL_SHAPES = {
  debrief: { inputTokens: 1800, outputTokens: 600 },
  recognizeCheck: { inputTokens: 1600, outputTokens: 400 },
} as const;

/** Called once at server boot. */
export function installUsageRecorder(): void {
  try {
    useUsageRecorder((e) => recordAiUsage(e));
  } catch {
    // A test that replaced llm.client wholesale has no recorder slot. Fine.
  }
}

/** Spend since two instants (ISO): local midnight and the 1st of the local month. */
export function aiSpend(dayStart: string, monthStart: string): AiSpend {
  const day = S().sumSince.get(dayStart) as { usd: number; n: number };
  const month = S().sumSince.get(monthStart) as { usd: number; n: number };
  return { todayUsd: day.usd, monthUsd: month.usd, todayCalls: day.n, monthCalls: month.n };
}
