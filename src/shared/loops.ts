// =============================================================================
// loops — target interview loops (Phase H2), and the pure date rules on them
// =============================================================================
// A loop is one company's interview day: a date and the round types it will
// have. The nearest upcoming loop drives four things:
//
//   countdown      Today and the debrief say "9 days to Acme".
//   spacing cap    no review item or drill card is scheduled PAST the loop's
//                  final-review day (capDueAtMs), so the last rung of a ladder
//                  cannot jump over the interview.
//   final review   1-2 days before the loop every open review problem and drill
//                  card is pulled due, once (finalReviewDay).
//   mock bias      within LOOP_BIAS_DAYS of the loop, the day's mock kind comes
//                  from the loop's round types (loopMockKinds).
//
// Everything here is pure: days are `YYYY-MM-DD` strings, instants are ms.

import { MOCK_KINDS, type MockKind } from './mock-kinds.js';

export const ROUND_TYPES = ['coding', 'system-design', 'behavioral', 'project-deep-dive', 'other'] as const;
export type RoundType = (typeof ROUND_TYPES)[number];

export const ROUND_LABEL: Readonly<Record<RoundType, string>> = {
  coding: 'Coding',
  'system-design': 'System design',
  behavioral: 'Behavioral',
  'project-deep-dive': 'Project deep-dive',
  other: 'Other',
};

export function isRoundType(x: unknown): x is RoundType {
  return typeof x === 'string' && (ROUND_TYPES as readonly string[]).includes(x);
}

export interface InterviewLoop {
  id: string;
  company: string;
  /** The interview day, `YYYY-MM-DD` (local). */
  date: string;
  rounds: RoundType[];
  /** A resume-builder job posting this loop is for (job-postings.json `id`). */
  postingId: string | null;
  /** The posting's title, copied when linked (shown even when resume-builder is down). */
  postingTitle: string | null;
  /**
   * Phase H3: the company is AI-focused (hand-set; hard to detect). Its system
   * design round is likely an AI/LLM system, so concept reps and the AI-systems
   * track are prioritised, and AI mock prompts favoured once unlocked.
   */
  aiFocus: boolean;
  createdAt: string;
}

/** A resume-builder posting, as the link picker shows it. */
export interface JobPosting {
  id: string;
  company: string;
  title: string;
  url: string | null;
}

export interface LoopsResponse {
  loops: InterviewLoop[];
}

export interface PostingsResponse {
  postings: JobPosting[];
  /** False when resume-builder could not be reached (the picker says so). */
  available: boolean;
}

/** The nearest upcoming loop, as Today shows it. */
export interface LoopCountdown {
  id: string;
  company: string;
  date: string;
  /** 0 = today. */
  daysLeft: number;
  rounds: RoundType[];
  postingTitle: string | null;
  /** The day open items are pulled due (1-2 days before), or null when past. */
  finalReviewDay: string | null;
  /** Today is that day. */
  isFinalReviewDay: boolean;
}

/** Within this many days of a loop, the mock rotation favours its round types. */
export const LOOP_BIAS_DAYS = 3;
/** The final review lands this many days before the loop (or today, if later). */
export const FINAL_REVIEW_DAYS_BEFORE = 2;

const DAY_MS = 86_400_000;

function dayNum(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** `YYYY-MM-DD` plus n calendar days. */
export function addDays(day: string, n: number): string {
  return new Date((dayNum(day) + n) * DAY_MS).toISOString().slice(0, 10);
}

/** Calendar days from `a` to `b` (b - a). */
export function daysBetween(a: string, b: string): number {
  return dayNum(b) - dayNum(a);
}

export function isDay(x: unknown): x is string {
  if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x)) return false;
  return addDays(x, 0) === x; // rejects 2026-02-30
}

/** The earliest loop on or after `today`, or null. Ties: the first listed. */
export function nearestLoop<T extends Pick<InterviewLoop, 'date'>>(loops: readonly T[], today: string): T | null {
  let best: T | null = null;
  for (const l of loops) {
    if (l.date < today) continue;
    if (!best || l.date < best.date) best = l;
  }
  return best;
}

/**
 * The final-review day for a loop: FINAL_REVIEW_DAYS_BEFORE days before it, or
 * today when that has already passed — but never the loop day itself or later
 * (the morning of the interview is not a review day). Null once the loop is today
 * or past.
 */
export function finalReviewDay(loopDate: string, today: string): string | null {
  if (loopDate <= today) return null;
  const planned = addDays(loopDate, -FINAL_REVIEW_DAYS_BEFORE);
  return planned >= today ? planned : today;
}

export function loopCountdown(loops: readonly InterviewLoop[], today: string): LoopCountdown | null {
  const l = nearestLoop(loops, today);
  if (!l) return null;
  const fr = finalReviewDay(l.date, today);
  return {
    id: l.id,
    company: l.company,
    date: l.date,
    daysLeft: daysBetween(today, l.date),
    rounds: l.rounds,
    postingTitle: l.postingTitle,
    finalReviewDay: fr,
    isFinalReviewDay: fr === today,
  };
}

/**
 * The mock kinds a loop's rounds map to — only kinds that exist. Unknown round
 * types without a mock kind (other) are ignored; project-deep-dive maps to its kind (Phase H4).
 */
export function loopMockKinds(rounds: readonly string[]): MockKind[] {
  return (MOCK_KINDS as readonly MockKind[]).filter((k) => rounds.includes(k));
}

/** The kinds the day's mock should come from, when the nearest loop is close enough. */
export function biasKinds(countdown: Pick<LoopCountdown, 'daysLeft' | 'rounds'> | null): MockKind[] {
  if (!countdown || countdown.daysLeft > LOOP_BIAS_DAYS) return [];
  return loopMockKinds(countdown.rounds);
}

/**
 * The spacing cap: a due date past the deadline (the start of the final-review
 * day) is pulled back to it. A deadline that is already here or past caps
 * nothing — the final review itself covers those items. Null = no loop.
 */
export function capDueAtMs(naturalMs: number, nowMs: number, deadlineMs: number | null): number {
  if (deadlineMs === null || !Number.isFinite(deadlineMs) || deadlineMs <= nowMs) return naturalMs;
  return Math.min(naturalMs, deadlineMs);
}

export function capDueAtIso(naturalIso: string, nowMs: number, deadlineMs: number | null): string {
  const t = Date.parse(naturalIso);
  if (!Number.isFinite(t)) return naturalIso;
  const capped = capDueAtMs(t, nowMs, deadlineMs);
  return capped === t ? naturalIso : new Date(capped).toISOString();
}

/** "today", "tomorrow", "in 9 days". */
export function countdownPhrase(daysLeft: number): string {
  if (daysLeft <= 0) return 'today';
  if (daysLeft === 1) return 'tomorrow';
  return `in ${daysLeft} days`;
}

/** Validate a loop body from the client. Returns an error string or the clean fields. */
export function parseLoopBody(
  body: unknown
): { ok: true; value: { company: string; date: string; rounds: RoundType[]; postingId: string | null; postingTitle: string | null; aiFocus: boolean } } | { ok: false; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const company = typeof b.company === 'string' ? b.company.trim().slice(0, 80) : '';
  if (!company) return { ok: false, error: 'company is required' };
  if (!isDay(b.date)) return { ok: false, error: 'date must be YYYY-MM-DD' };
  const rounds = [...new Set(Array.isArray(b.rounds) ? b.rounds.filter(isRoundType) : [])];
  if (!rounds.length) return { ok: false, error: `rounds: pick at least one of ${ROUND_TYPES.join(', ')}` };
  const postingId = typeof b.postingId === 'string' && b.postingId.trim() ? b.postingId.trim().slice(0, 80) : null;
  const postingTitle =
    postingId && typeof b.postingTitle === 'string' && b.postingTitle.trim() ? b.postingTitle.trim().slice(0, 160) : null;
  return {
    ok: true,
    value: { company, date: b.date, rounds: ROUND_TYPES.filter((r) => rounds.includes(r)), postingId, postingTitle, aiFocus: b.aiFocus === true },
  };
}

/** Any upcoming loop (today or later) is AI-focused. */
export function anyAiFocusedLoop(loops: readonly Pick<InterviewLoop, 'date' | 'aiFocus'>[], today: string): boolean {
  return loops.some((l) => l.date >= today && l.aiFocus);
}
