// =============================================================================
// today.compute — the PURE brain behind GET /api/today
// =============================================================================
// Day boundaries, step derivation, mock-kind rotation, readiness, the debrief's
// coercion and the scheduler's daily-focus bias. No database and no clock it is
// not handed — like reflect.compute.ts, this must never import ./db.js (db.ts
// opens SQLite at module scope), so every rule here is unit-tested on fixtures.
// today.store.ts reads the rows; today.service.ts glues the two.

import { TOPICS, type Topic } from '../../shared/types.js';
import { MOCK_KINDS, isMockKind, type MockKind } from '../../shared/mock-kinds.js';
import type { MockVerdict } from '../../shared/mock.js';
import {
  SKIPPABLE_STEPS,
  TODAY_STEPS,
  TODAY_STEP_LABEL,
  type Debrief,
  type ReadinessArea,
  type TodayStep,
  type TodayStepId,
  type TodayStepStatus,
} from '../../shared/today.js';
import { computeDayStreak } from './reflect.compute.js';

// -----------------------------------------------------------------------------
// The local day
// -----------------------------------------------------------------------------
/**
 * The user's timezone. A routine's "today" has to be the user's day: a UTC
 * boundary falls at 5pm Pacific and would split an evening session in two.
 * Override with CODEGRIND_TZ (systemd `Environment=`, not .env).
 */
export const DEFAULT_TZ = 'America/Los_Angeles';
export function todayTz(): string {
  return process.env.CODEGRIND_TZ || DEFAULT_TZ;
}

/** `YYYY-MM-DD` of an instant in a timezone. */
export function localDay(ms: number, tz: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/** Offset (local - UTC) in ms of a timezone at an instant. */
function tzOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant of local midnight starting `day` (`YYYY-MM-DD`) in `tz`. DST-safe. */
export function dayStartMs(day: string, tz: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d);
  // Two passes: the offset at the guess can differ from the offset at the
  // answer when a DST change falls between them.
  let guess = naive - tzOffsetMs(naive, tz);
  guess = naive - tzOffsetMs(guess, tz);
  return guess;
}

/** The previous calendar day of a `YYYY-MM-DD`. */
export function previousDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 86_400_000).toISOString().slice(0, 10);
}

/**
 * Consecutive local days with practice, counting back from today; today being
 * empty does not break it (the day isn't over). Reuses reflect's rule over a
 * dense LOCAL-day grid built from raw activity instants.
 */
export function localDayStreak(instants: readonly string[], now: number, tz: string, days = 120): number {
  const active = new Set(instants.map((iso) => localDay(Date.parse(iso), tz)));
  const grid: { date: string; attempts: number; solved: number }[] = [];
  let day = localDay(now, tz);
  for (let i = 0; i < days; i++) {
    grid.unshift({ date: day, attempts: active.has(day) ? 1 : 0, solved: 0 });
    day = previousDay(day);
  }
  return computeDayStreak(grid);
}

// -----------------------------------------------------------------------------
// Step derivation
// -----------------------------------------------------------------------------
export interface TodayAttemptRow {
  problemId: string;
  title: string;
  solved: boolean;
  hintsUsed: number;
  createdAt: string;
  /** The first attempt EVER on this problem — earlier than today = a review re-solve. */
  firstAt: string;
}

export interface TodayMockRow {
  id: string;
  kind: string;
  status: string;
  verdict: MockVerdict | null;
  createdAt: string;
}

export interface DeriveInput {
  /** ISO of local midnight starting today. */
  dayStart: string;
  attempts: TodayAttemptRow[];
  mocks: TodayMockRow[];
  /** Drill cards due now that existed before today (today's mock's new cards don't reopen the warm-up). */
  cardsDue: number;
  /** Due review-queue problems not already attempted today. */
  reviewsDue: number;
  cardsReviewedToday: number;
  skips: readonly TodayStepId[];
  endedEarly: boolean;
  mockKind: MockKind;
  mockKindLabel: string;
  hasDebrief: boolean;
  debriefVerdict: string | null;
}

export interface DerivedSteps {
  steps: TodayStep[];
  current: TodayStepId | null;
  completed: number;
}

const from = (step: TodayStepId) => `from=today&step=${step}`;

interface ProblemOutcome {
  problemId: string;
  title: string;
  solved: boolean;
  submits: number;
  hints: number;
}

/** Today's NEW problems (first attempted today), in the order they were first submitted. */
export function newProblemsToday(input: Pick<DeriveInput, 'attempts' | 'dayStart'>): ProblemOutcome[] {
  const byProblem = new Map<string, ProblemOutcome & { first: string }>();
  const sorted = [...input.attempts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const a of sorted) {
    if (a.firstAt < input.dayStart) continue; // a review re-solve — the warm-up's
    const o = byProblem.get(a.problemId);
    if (o) {
      o.solved ||= a.solved;
      o.submits += 1;
      o.hints = Math.max(o.hints, a.hintsUsed);
    } else {
      byProblem.set(a.problemId, {
        problemId: a.problemId,
        title: a.title,
        solved: a.solved,
        submits: 1,
        hints: a.hintsUsed,
        first: a.createdAt,
      });
    }
  }
  return [...byProblem.values()].sort((a, b) => a.first.localeCompare(b.first));
}

function problemResult(p: ProblemOutcome): string {
  const verdict = p.solved ? 'Passed' : 'Failed';
  const extra = [
    p.submits > 1 ? `${p.submits} submits` : null,
    p.hints > 0 ? `${p.hints} hint${p.hints === 1 ? '' : 's'}` : 'no hints',
  ].filter(Boolean);
  return `${verdict} · ${p.title} · ${extra.join(', ')}`;
}

/** Every step's state for the day. Pure. */
export function deriveSteps(input: DeriveInput): DerivedSteps {
  const skipped = new Set(input.skips);
  const base = new Map<TodayStepId, { status: 'done' | 'skipped' | 'in-progress' | 'todo'; href: string; detail: string; result: string | null; ok: boolean | null }>();

  // --- warm-up --------------------------------------------------------------
  const reviewsCleared = input.attempts.filter((a) => a.firstAt < input.dayStart);
  const reviewedProblems = new Set(reviewsCleared.map((a) => a.problemId)).size;
  const pile = input.cardsDue + input.reviewsDue;
  const warmHref =
    input.cardsDue > 0
      ? `/mock?${from('warmup')}#cards`
      : input.reviewsDue > 0
        ? `/grind?${from('warmup')}`
        : '/today';
  const cleared = input.cardsReviewedToday + reviewedProblems;
  base.set('warmup', {
    status: pile === 0 ? 'done' : skipped.has('warmup') ? 'skipped' : 'todo',
    href: warmHref,
    detail:
      pile === 0
        ? 'Nothing due.'
        : [
            input.cardsDue ? `${input.cardsDue} drill card${input.cardsDue === 1 ? '' : 's'}` : null,
            input.reviewsDue ? `${input.reviewsDue} review problem${input.reviewsDue === 1 ? '' : 's'}` : null,
          ]
            .filter(Boolean)
            .join(' + ') + ' due',
    result:
      pile === 0
        ? cleared > 0
          ? `Cleared ${cleared} (${input.cardsReviewedToday} card${input.cardsReviewedToday === 1 ? '' : 's'}, ${reviewedProblems} review${reviewedProblems === 1 ? '' : 's'})`
          : 'Nothing was due'
        : null,
    ok: pile === 0 ? true : null,
  });

  // --- problems ---------------------------------------------------------------
  const problems = newProblemsToday(input);
  (['problem1', 'problem2'] as const).forEach((id, i) => {
    const p = problems[i];
    base.set(id, {
      status: p ? 'done' : skipped.has(id) ? 'skipped' : 'todo',
      href: `/grind?${from(id)}`,
      detail: 'Adaptive pick · Minimal editor · predict before you solve',
      result: p ? problemResult(p) : null,
      ok: p ? p.solved : null,
    });
  });

  // --- mock -------------------------------------------------------------------
  const mocks = [...input.mocks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const graded = mocks.find((m) => m.status === 'graded');
  const open = mocks.find((m) => m.status === 'active' || m.status === 'grading' || m.status === 'grade_failed');
  base.set('mock', {
    status: graded ? 'done' : open ? 'in-progress' : skipped.has('mock') ? 'skipped' : 'todo',
    href: graded
      ? `/mock/${graded.id}?${from('mock')}`
      : open
        ? `/mock/${open.id}?${from('mock')}`
        : `/mock?${from('mock')}&kind=${input.mockKind}`,
    detail: `${input.mockKindLabel} — today's kind`,
    result: graded ? `${graded.verdict ?? 'graded'} level` : null,
    ok: graded ? graded.verdict !== 'below' : null,
  });

  // --- the sweep: end day early skips every unfinished step -----------------
  if (input.endedEarly) {
    for (const id of SKIPPABLE_STEPS) {
      const s = base.get(id)!;
      if (s.status !== 'done') s.status = 'skipped';
    }
  }

  // --- debrief ----------------------------------------------------------------
  const mockSettled = ['done', 'skipped'].includes(base.get('mock')!.status);
  base.set('debrief', {
    status: input.hasDebrief ? 'done' : 'todo',
    href: '/today#debrief',
    detail: 'One short AI read of the day: wins, fixes, tomorrow\'s focus.',
    result: input.hasDebrief ? input.debriefVerdict : null,
    ok: null,
  });

  // --- current = the first unfinished step ----------------------------------
  let current: TodayStepId | null = null;
  const steps: TodayStep[] = TODAY_STEPS.map((id) => {
    const s = base.get(id)!;
    let status: TodayStepStatus = s.status;
    if (id === 'debrief' && status !== 'done' && !mockSettled && !input.endedEarly) {
      status = 'locked';
    } else if ((status === 'todo' || status === 'in-progress') && current === null) {
      current = id;
      if (status === 'todo') status = 'current';
    }
    return { id, label: TODAY_STEP_LABEL[id], status, href: s.href, detail: s.detail, result: s.result, ok: s.ok };
  });
  const completed = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  return { steps, current, completed };
}

// -----------------------------------------------------------------------------
// Mock kind rotation
// -----------------------------------------------------------------------------
export interface MockKindPickInput {
  /** The kinds that exist (MOCK_KINDS) — unbuilt kinds are never picked. */
  kinds: readonly MockKind[];
  /** The most recent previous day's chosen kind, if any. */
  lastKind: string | null;
  /** Graded mocks, newest first. */
  grades: readonly { kind: string; verdict: MockVerdict }[];
  /** The last debrief's tomorrowFocus.mockKind. */
  focusKind: string | null;
}

const VERDICT_SCORE: Record<MockVerdict, number> = { below: 0, at: 1, above: 2 };

/** Mean verdict score (0..2) over a kind's last three grades, or null with none. */
export function kindStrength(grades: MockKindPickInput['grades'], kind: string): number | null {
  const mine = grades.filter((g) => g.kind === kind).slice(0, 3);
  if (!mine.length) return null;
  return mine.reduce((s, g) => s + VERDICT_SCORE[g.verdict], 0) / mine.length;
}

/**
 * Today's mock kind. In order:
 *   1. one kind → that kind
 *   2. the last debrief named a (still existing) kind → that kind
 *   3. the weakest-graded kind, when it is trending below level (mean < 1 over
 *      its last three) and was not yesterday's → it jumps the queue
 *   4. rotation: the kind after the last day's, in MOCK_KINDS order
 */
export function pickMockKind(input: MockKindPickInput): MockKind {
  const kinds = input.kinds.length ? input.kinds : MOCK_KINDS;
  if (kinds.length === 1) return kinds[0];
  if (input.focusKind && (kinds as readonly string[]).includes(input.focusKind)) return input.focusKind as MockKind;

  const lastIdx = input.lastKind ? (kinds as readonly string[]).indexOf(input.lastKind) : -1;
  const rotation = kinds[(lastIdx + 1) % kinds.length];

  let weakest: MockKind | null = null;
  let weakestScore = Infinity;
  for (const k of kinds) {
    const s = kindStrength(input.grades, k);
    if (s !== null && s < weakestScore) {
      weakest = k;
      weakestScore = s;
    }
  }
  if (weakest && weakestScore < 1 && weakest !== rotation && weakest !== input.lastKind) return weakest;
  return rotation;
}

// -----------------------------------------------------------------------------
// Readiness — no LLM, from mastery + mock grades
// -----------------------------------------------------------------------------
export interface ReadinessInput {
  /** Per topic: attempts and tier score 0..1. */
  topics: readonly { topic: string; attempts: number; score: number; tiered: boolean }[];
  grades: MockKindPickInput['grades'];
}

const AREA_KINDS = [
  { id: 'system-design', label: 'System design' },
  { id: 'behavioral', label: 'Behavioral' },
  { id: 'coding', label: 'Coding' },
] as const;

export function computeReadiness(input: ReadinessInput): ReadinessArea[] {
  const practiced = input.topics.filter((t) => t.attempts > 0);
  const algos: ReadinessArea = practiced.length
    ? {
        id: 'algos',
        label: 'Algorithms',
        pct: Math.round((input.topics.reduce((s, t) => s + t.score, 0) / Math.max(1, input.topics.length)) * 100),
        note: `${input.topics.filter((t) => t.tiered).length}/${input.topics.length} topics tiered`,
      }
    : { id: 'algos', label: 'Algorithms', pct: null, note: 'not started' };

  const mocks = AREA_KINDS.map(({ id, label }): ReadinessArea => {
    const s = kindStrength(input.grades, id);
    if (s === null) return { id, label, pct: null, note: 'not started' };
    const latest = input.grades.find((g) => g.kind === id)!;
    return { id, label, pct: Math.round((s / 2) * 100), note: `last: ${latest.verdict} level` };
  });
  return [algos, ...mocks];
}

// -----------------------------------------------------------------------------
// Debrief coercion
// -----------------------------------------------------------------------------
const str = (x: unknown, max = 400): string => (typeof x === 'string' ? x.trim().slice(0, max) : '');

/** Whatever the model sent → a well-formed Debrief. Never throws. */
export function coerceDebrief(raw: unknown): Debrief {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const wins = (Array.isArray(o.wins) ? o.wins : []).map((w) => str(w)).filter(Boolean).slice(0, 4);
  const fixes = (Array.isArray(o.fixes) ? o.fixes : [])
    .map((f) => {
      const r = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
      return { issue: str(r.issue), action: str(r.action) };
    })
    .filter((f) => f.issue && f.action)
    .slice(0, 4);
  const tf = (o.tomorrowFocus && typeof o.tomorrowFocus === 'object' ? o.tomorrowFocus : {}) as Record<string, unknown>;
  const valid = new Set<string>(TOPICS as readonly string[]);
  const patterns = [
    ...new Set((Array.isArray(tf.patterns) ? tf.patterns : []).filter((p): p is Topic => typeof p === 'string' && valid.has(p))),
  ].slice(0, 3);
  return {
    verdict: str(o.verdict, 200) || 'Day logged.',
    wins,
    fixes,
    tomorrowFocus: { patterns, mockKind: isMockKind(tf.mockKind) ? tf.mockKind : null },
  };
}

// -----------------------------------------------------------------------------
// The scheduler hook
// -----------------------------------------------------------------------------
/**
 * How much the last debrief's tomorrowFocus leans the scheduler toward a topic.
 * Half the session plan's own +0.5: a nudge between otherwise-close candidates,
 * never enough to outrank a failed-last or overdue topic.
 */
export const DAILY_FOCUS_BIAS = 0.25;

export function dailyFocusBias(topic: string, focus: readonly string[] | undefined): number {
  return focus?.includes(topic) ? DAILY_FOCUS_BIAS : 0;
}
