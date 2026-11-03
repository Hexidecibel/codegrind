// =============================================================================
// weekly.compute — the numbers behind Home's "This week" and bin/progress-report
// =============================================================================
// PURE: rows in, numbers out. Like reflect.compute.ts this must never import
// ./db.js — db.ts runs the migration on import (a write), and the progress
// report opens the database READ-ONLY on its own connection. weekly.rows.ts
// holds the SELECTs; it takes the handle as an argument.
//
// Grind vs free: attempts carry NO session id. A problem is "grind" when it was
// first submitted inside a sitting: after a `sessions` row was created, and
// among the first `served` distinct problems that began after it (within 8h).
// Everything else is "free". A heuristic; the app itself treats both the same
// (submit.ts: skill_state, review_queue).

import { isNearMiss } from '../../shared/closeness.js';
import { patternHref, practiceHref, type PatternId } from '../../shared/pattern-shapes.js';
import { TOPICS, type Topic } from '../../shared/types.js';
import type {
  WeeklyDay,
  WeeklyRecognize,
  WeeklyReview,
  WeeklyTarget,
  WeeklyTopic,
} from '../../shared/weekly.js';
import { localDay } from './today.compute.js';

const DAY = 86_400_000;
/** How long after a sitting starts its problems still count as that sitting's. */
export const SITTING_SPAN_MS = 8 * 3600_000;

export interface WeeklyAttempt {
  id: string;
  problemId: string;
  pattern: string;
  difficulty: string;
  solved: number;
  hintsUsed: number;
  testsPassed: number;
  testsTotal: number;
  createdAt: string;
  language: string;
}

export interface WeeklySession {
  createdAt: string;
  served: number;
}

export interface WeeklyRecognizeRow {
  topic: string;
  patternCorrect: number;
  grade: string;
  createdAt: string;
  /** The problem's language; null when the problem row is gone. */
  language: string | null;
}

export interface WeeklyEnvelopeRow {
  ok: number;
  mode?: string;
  createdAt: string;
}

export interface WeeklyMockRow {
  status: string;
  createdAt: string;
  endedAt: string | null;
}

/** A mock that reached the end of the interview (graded, or the grade is pending/failed). */
export const FINISHED_MOCK_STATUSES: readonly string[] = ['graded', 'grading', 'grade_failed'];

export function mockFinishedAt(m: WeeklyMockRow): string | null {
  if (!FINISHED_MOCK_STATUSES.includes(m.status)) return null;
  return m.endedAt ?? m.createdAt;
}

/**
 * The attempt ids that happened inside a grind sitting. Moved as-is from
 * bin/progress-report: for each session, the first `served` distinct problems
 * submitted within SITTING_SPAN_MS of its creation are its problems, and every
 * attempt on one of them inside that span is a grind attempt.
 *
 * `attempts` must be ordered by createdAt.
 */
export function classifyGrind(attempts: readonly WeeklyAttempt[], sessions: readonly WeeklySession[]): Set<string> {
  const grindProblems = new Set<string>();
  for (const s of sessions) {
    const start = Date.parse(s.createdAt);
    const seen: string[] = [];
    for (const a of attempts) {
      const t = Date.parse(a.createdAt);
      if (t < start || t > start + SITTING_SPAN_MS) continue;
      if (!seen.includes(a.problemId)) seen.push(a.problemId);
    }
    seen.slice(0, s.served).forEach((p) => grindProblems.add(`${s.createdAt}|${p}`));
  }
  const grindAttempt = new Set<string>();
  for (const s of sessions) {
    const start = Date.parse(s.createdAt);
    const picked = [...grindProblems].filter((k) => k.startsWith(s.createdAt + '|')).map((k) => k.split('|')[1]);
    for (const a of attempts) {
      const t = Date.parse(a.createdAt);
      if (t >= start && t <= start + SITTING_SPAN_MS && picked.includes(a.problemId)) grindAttempt.add(a.id);
    }
  }
  return grindAttempt;
}

/** Calendar arithmetic on `YYYY-MM-DD`, in UTC so no DST can bite. */
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY).toISOString().slice(0, 10);
}

/** Every local date from `since`'s to `now`'s, oldest first. */
export function localDates(since: number, now: number, tz: string): string[] {
  const last = localDay(now, tz);
  const out: string[] = [];
  for (let d = localDay(since, tz); d <= last && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

const roundPct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);

export interface WindowInput {
  /** Every attempt the caller has (ordered by createdAt); filtered to the window here. */
  attempts: readonly WeeklyAttempt[];
  /** classifyGrind's output. */
  grindIds: ReadonlySet<string>;
  recognize: readonly WeeklyRecognizeRow[];
  envelope: readonly WeeklyEnvelopeRow[];
  mocks: readonly WeeklyMockRow[];
  /** Window start (inclusive) and end, epoch ms. */
  since: number;
  now: number;
  tz: string;
  /**
   * Scope topics, near misses and Recognize to this language (Home: the active
   * one, like Reflect). Volume, daily and active days always count every
   * language — a habit is a habit. Omitted = every language (the report).
   */
  language?: string;
}

export interface WindowSummary {
  since: number;
  now: number;
  /** Window attempts, every language. */
  subs: number;
  problems: number;
  /** Local days with a submission (every language) — the report's count. */
  activeDays: number;
  /** Local days with any practice: submissions, Recognize, Envelope, mocks. */
  practiceDays: number;
  grind: { subs: number; problems: number };
  free: { subs: number; problems: number };
  /** Every local date in the window, oldest first. */
  daily: WeeklyDay[];
  /** Topics with attempts (most first); ties keep TOPICS order. */
  topics: WeeklyTopic[];
  /** Topics with no attempt, TOPICS order (then any legacy pattern). */
  untouched: string[];
  nearMisses: { count: number; fixed: number; fixedUnaided: number };
  /** Recognize cards graded in the window; `language` scopes it when set. */
  recognizeTotal: number;
  recognize: WeeklyRecognize[];
  envelope: { n: number; ok: number; okPct: number; days: number };
  mocks: { inWindow: number; lastAt: string | null };
}

export function summarizeWindow(input: WindowInput): WindowSummary {
  const { attempts, grindIds, since, now, tz, language } = input;
  const day = (iso: string) => localDay(Date.parse(iso), tz);
  const mid = since + (now - since) / 2;
  const inW = attempts.filter((a) => Date.parse(a.createdAt) >= since);
  const scoped = language ? inW.filter((a) => a.language === language) : inW;

  const g = inW.filter((a) => grindIds.has(a.id));
  const f = inW.filter((a) => !grindIds.has(a.id));

  // --- daily -----------------------------------------------------------------
  const dates = localDates(since, now, tz);
  const byDay = new Map<string, WeeklyDay>(dates.map((d) => [d, { date: d, subs: 0, grind: 0, solved: 0, practiced: false }]));
  const touch = (iso: string) => {
    const d = byDay.get(day(iso));
    if (d) d.practiced = true;
    return d;
  };
  for (const a of inW) {
    const d = touch(a.createdAt);
    if (!d) continue;
    d.subs++;
    if (grindIds.has(a.id)) d.grind++;
    d.solved += a.solved;
  }
  const rec = input.recognize.filter((r) => Date.parse(r.createdAt) >= since);
  const env = input.envelope.filter((e) => Date.parse(e.createdAt) >= since);
  const finished = input.mocks.map(mockFinishedAt).filter((x): x is string => x !== null);
  const mocksIn = finished.filter((iso) => Date.parse(iso) >= since);
  for (const r of rec) touch(r.createdAt);
  for (const e of env) touch(e.createdAt);
  for (const iso of mocksIn) touch(iso);

  // --- per topic -------------------------------------------------------------
  const topicIds = [...new Set<string>([...TOPICS, ...attempts.map((a) => a.pattern)])];
  const rows = topicIds.map((t) => ({ t, r: scoped.filter((a) => a.pattern === t) }));
  const sorted = [...rows].sort((a, b) => b.r.length - a.r.length);
  const untouched: string[] = [];
  const topics: WeeklyTopic[] = [];
  for (const { t, r } of sorted) {
    if (r.length === 0) {
      untouched.push(t);
      continue;
    }
    const solved = r.filter((a) => a.solved);
    const hinted = solved.filter((a) => a.hintsUsed > 0).length;
    const h1 = r.filter((a) => Date.parse(a.createdAt) < mid);
    const h2 = r.filter((a) => Date.parse(a.createdAt) >= mid);
    topics.push({
      topic: t,
      attempts: r.length,
      free: r.filter((a) => !grindIds.has(a.id)).length,
      solved: solved.length,
      solvedPct: roundPct(solved.length, r.length),
      nearMisses: r.filter(isNearMissRow).length,
      hinted,
      unaided: solved.length - hinted,
      trend: {
        before: { n: h1.length, solved: h1.filter((a) => a.solved).length },
        after: { n: h2.length, solved: h2.filter((a) => a.solved).length },
      },
    });
  }

  // --- near misses fixed the same local day (closeness.ts rule) --------------
  const pending = new Set<string>();
  const fixed = new Set<string>();
  const unaided = new Set<string>();
  let nearCount = 0;
  for (const a of scoped) {
    const key = `${a.problemId}|${day(a.createdAt)}`;
    if (!a.solved) {
      if (isNearMissRow(a)) {
        nearCount++;
        pending.add(key);
      }
    } else if (pending.has(key)) {
      fixed.add(key);
      if (a.hintsUsed === 0) unaided.add(key);
    }
  }

  // --- Recognize ---------------------------------------------------------------
  const recScoped = language ? rec.filter((r) => r.language === language) : rec;
  const rt = new Map<string, { n: number; ok: number; got: number }>();
  for (const r of recScoped) {
    const v = rt.get(r.topic) ?? { n: 0, ok: 0, got: 0 };
    v.n++;
    v.ok += r.patternCorrect;
    v.got += r.grade === 'got' ? 1 : 0;
    rt.set(r.topic, v);
  }
  const recognize = [...rt]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([topic, v]) => ({ topic, n: v.n, patternCorrect: v.ok, got: v.got, patternCorrectPct: roundPct(v.ok, v.n) }));

  const envOk = env.filter((e) => e.ok).length;
  return {
    since,
    now,
    subs: inW.length,
    problems: new Set(inW.map((a) => a.problemId)).size,
    activeDays: new Set(inW.map((a) => day(a.createdAt))).size,
    practiceDays: [...byDay.values()].filter((d) => d.practiced).length,
    grind: { subs: g.length, problems: new Set(g.map((a) => a.problemId)).size },
    free: { subs: f.length, problems: new Set(f.map((a) => a.problemId)).size },
    daily: dates.map((d) => byDay.get(d)!),
    topics,
    untouched,
    nearMisses: { count: nearCount, fixed: fixed.size, fixedUnaided: unaided.size },
    recognizeTotal: recScoped.length,
    recognize,
    envelope: { n: env.length, ok: envOk, okPct: roundPct(envOk, env.length), days: new Set(env.map((e) => day(e.createdAt))).size },
    mocks: { inWindow: mocksIn.length, lastAt: finished.length ? finished.reduce((a, b) => (a > b ? a : b)) : null },
  };
}

function isNearMissRow(a: WeeklyAttempt) {
  return isNearMiss({ solved: !!a.solved, testsPassed: a.testsPassed, testsTotal: a.testsTotal });
}

// -----------------------------------------------------------------------------
// Review queue, per topic
// -----------------------------------------------------------------------------
export interface ReviewRow {
  topic: string;
  dueAt: string;
  language?: string | null;
}

/** Open review-queue rows → due / overdue (>1 day) per topic, most due first. */
export function reviewsByTopic(rows: readonly ReviewRow[], now: number, language?: string): WeeklyReview[] {
  const nowIso = new Date(now).toISOString();
  const by = new Map<string, WeeklyReview>();
  for (const r of rows) {
    if (language && r.language && r.language !== language) continue;
    const due = r.dueAt <= nowIso;
    if (!due) continue;
    const v = by.get(r.topic) ?? { topic: r.topic, due: 0, overdue: 0 };
    v.due++;
    if (Date.parse(r.dueAt) < now - DAY) v.overdue++;
    by.set(r.topic, v);
  }
  return [...by.values()].sort((a, b) => b.due - a.due);
}

// -----------------------------------------------------------------------------
// Target next — one card, first match wins
// -----------------------------------------------------------------------------
export interface TargetInput {
  summary: Pick<WindowSummary, 'topics' | 'untouched'>;
  reviews: readonly WeeklyReview[];
  /** Readiness areas; only `algos` is read. */
  readiness: readonly { id: string; verdict: string }[];
  refresh: { on: boolean; dayComplete: boolean; pattern: PatternId | null; topic: string | null; label: string } | null;
  /** Curriculum order (ties break by it) — reflect.compute.curriculumOrder(). */
  order: readonly string[];
  /** Topics whose gate is open; the untouched fallback only offers these. */
  unlocked: ReadonlySet<string>;
  /** Last difficulty attempted per topic (window attempts, latest wins). */
  lastDifficulty?: ReadonlyMap<string, string>;
}

const label = (t: string) => t.replace(/-/g, ' ');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 *   1. Pattern Refresh on and today's not done  → today's refresh pattern
 *   2. a review overdue > 1 day                 → the topic with the most overdue
 *   3. ≥3 attempts and < 50% solved, or ≥2 near misses → that topic
 *   4. algorithms readiness not ready            → one unseen medium, no hints
 *   5. else                                      → first untouched unlocked topic
 * Ties break by curriculum order. Hrefs are deep links the pages accept: /grind
 * (the scheduler serves due reviews first), /manual?topic=&difficulty=, and
 * /patterns#<id>.
 */
export function pickTarget(input: TargetInput): WeeklyTarget {
  const rank = (t: string) => {
    const i = input.order.indexOf(t);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const r = input.refresh;
  if (r?.on && !r.dayComplete) {
    return {
      kind: 'refresh',
      topic: r.topic,
      reason: r.pattern ? `Refresh day: ${r.label}. Re-learn its shape first.` : 'Mixed refresh day: name the pattern before you code.',
      href: r.pattern ? patternHref(r.pattern) : '/patterns',
    };
  }

  const overdue = input.reviews.filter((v) => v.overdue > 0).sort((a, b) => b.overdue - a.overdue || rank(a.topic) - rank(b.topic));
  if (overdue.length) {
    const top = overdue[0];
    return { kind: 'review', topic: top.topic, reason: `Clear ${plural(top.overdue, 'overdue review')} in ${label(top.topic)}.`, href: '/grind' };
  }

  const struggling = input.summary.topics
    .filter((t) => (t.attempts >= 3 && t.solvedPct < 50) || t.nearMisses >= 2)
    .sort((a, b) => rank(a.topic) - rank(b.topic));
  if (struggling.length) {
    const t = struggling[0];
    const diff = input.lastDifficulty?.get(t.topic) ?? 'easy';
    return {
      kind: 'struggling',
      topic: t.topic,
      reason:
        t.nearMisses >= 2
          ? `${t.nearMisses} near-misses in ${label(t.topic)}. One clean solve locks it in.`
          : `${label(t.topic)} is at ${t.solvedPct}% solved this week. One more, slowly.`,
      href: practiceHref(t.topic as Topic, diff),
    };
  }

  const algos = input.readiness.find((a) => a.id === 'algos');
  if (algos && algos.verdict !== 'ready') {
    return { kind: 'unseen', topic: null, reason: 'One unseen medium, no hints. That moves readiness most.', href: '/grind' };
  }

  const untouched = new Set(input.summary.untouched);
  const fresh = input.order.find((t) => untouched.has(t) && input.unlocked.has(t));
  if (fresh) {
    return { kind: 'untouched', topic: fresh, reason: `You haven't touched ${label(fresh)} this week.`, href: practiceHref(fresh as Topic, 'easy') };
  }
  return { kind: 'grind', topic: null, reason: 'Keep the daily grind going.', href: '/grind' };
}
