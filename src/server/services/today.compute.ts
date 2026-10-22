// =============================================================================
// today.compute — the PURE brain behind GET /api/today
// =============================================================================
// Day boundaries, step derivation, mock-kind rotation, readiness, the debrief's
// coercion and the scheduler's daily-focus bias. No database and no clock it is
// not handed — like reflect.compute.ts, this must never import ./db.js (db.ts
// opens SQLite at module scope), so every rule here is unit-tested on fixtures.
// today.store.ts reads the rows; today.service.ts glues the two.

import { TOPICS, type Topic } from '../../shared/types.js';
import { MOCK_KINDS, isMockKind, mockKindInfo, type MockKind } from '../../shared/mock-kinds.js';
import type { MockVerdict } from '../../shared/mock.js';
import {
  SKIPPABLE_STEPS,
  TODAY_STEPS,
  TODAY_STEP_LABEL,
  type AiReviewTarget,
  type Debrief,
  type TodayStep,
  type TodayStepId,
  type TodayStepStatus,
} from '../../shared/today.js';
import { computeDayStreak } from './reflect.compute.js';
import { cutToolCallFraming } from './llm.types.js';
import { clipAtBoundary } from '../../shared/clip.js';

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
  /**
   * Envelope ×N (Phase G): what is left of today's reps (due envelope cards
   * lead them) and how many were answered. Absent = no envelope part.
   */
  envelope?: { remaining: number; doneToday: number; query?: string };
  skips: readonly TodayStepId[];
  endedEarly: boolean;
  mockKind: MockKind;
  mockKindLabel: string;
  hasDebrief: boolean;
  debriefVerdict: string | null;
  /**
   * Phase H2 "30-min day": warm-up (cards + Envelope ×3, no review problems —
   * they stay due), ONE problem (a new one or a due review re-solve), the
   * debrief. Problem 2 and the mock are off for the day, not failed.
   */
  quick?: boolean;
  /** Today is a loop's final-review day: every open item was pulled due. */
  finalReview?: { company: string; daysLeft: number } | null;
  /**
   * Phase H3 concept rep: graded reps today and the last one. Absent = none
   * yet (the step is still to do).
   */
  concept?: { doneToday: number; last: { label: string; grade: string } | null };
  /**
   * Phase H4: today's concept step is a STORY-FORGE session instead
   * (shared/story-forge.forgeDay decides), and what the forge did today.
   */
  forge?: { day: boolean; doneToday: number; last: { title: string; status: string } | null };
}

export interface DerivedSteps {
  steps: TodayStep[];
  current: TodayStepId | null;
  completed: number;
}

const from = (step: TodayStepId) => `from=today&step=${step}`;

const mockKindLabelOf = (kind: string): string => (isMockKind(kind) ? mockKindInfo(kind).label : kind);

interface ProblemOutcome {
  problemId: string;
  title: string;
  solved: boolean;
  submits: number;
  hints: number;
}

/** Today's NEW problems (first attempted today), in the order they were first submitted. */
export function newProblemsToday(input: Pick<DeriveInput, 'attempts' | 'dayStart'>): ProblemOutcome[] {
  return problemsToday(input, false);
}

/**
 * Today's problems in first-submit order: NEW ones only, or (the 30-min day's
 * single problem) review re-solves too.
 */
export function problemsToday(input: Pick<DeriveInput, 'attempts' | 'dayStart'>, includeReviews: boolean): ProblemOutcome[] {
  const byProblem = new Map<string, ProblemOutcome & { first: string }>();
  const sorted = [...input.attempts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const a of sorted) {
    if (!includeReviews && a.firstAt < input.dayStart) continue; // a review re-solve — the warm-up's
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
  const base = new Map<TodayStepId, { status: 'done' | 'skipped' | 'in-progress' | 'todo'; href: string; detail: string; result: string | null; ok: boolean | null; label?: string }>();

  // --- warm-up --------------------------------------------------------------
  const reviewsCleared = input.attempts.filter((a) => a.firstAt < input.dayStart);
  const reviewedProblems = new Set(reviewsCleared.map((a) => a.problemId)).size;
  const env = input.envelope ?? { remaining: 0, doneToday: 0 };
  // A 30-min day leaves review problems due (spacing kept) — its one problem
  // is served from the queue first anyway.
  const reviewsDue = input.quick ? 0 : input.reviewsDue;
  const pile = input.cardsDue + env.remaining + reviewsDue;
  const warmHref =
    input.cardsDue > 0
      ? `/mock?${from('warmup')}#cards`
      : env.remaining > 0
        ? `/envelope?${from('warmup')}&n=${env.remaining}${env.query ?? ''}`
        : reviewsDue > 0
          ? `/grind?${from('warmup')}`
          : '/today';
  const cleared = input.cardsReviewedToday + reviewedProblems + env.doneToday;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  base.set('warmup', {
    status: pile === 0 ? 'done' : skipped.has('warmup') ? 'skipped' : 'todo',
    href: warmHref,
    detail:
      (input.finalReview && pile > 0
        ? `Final review before ${input.finalReview.company} (${input.finalReview.daysLeft === 1 ? 'tomorrow' : `in ${input.finalReview.daysLeft} days`}): every open item. `
        : '') +
      (pile === 0
        ? 'Nothing due.'
        : [
            input.cardsDue || reviewsDue
              ? [
                  input.cardsDue ? plural(input.cardsDue, 'drill card') : null,
                  reviewsDue ? plural(reviewsDue, 'review problem') : null,
                ]
                  .filter(Boolean)
                  .join(' + ') + ' due'
              : null,
            env.remaining ? `Envelope ×${env.remaining}` : null,
          ]
            .filter(Boolean)
            .join(' + ')),
    result:
      pile === 0
        ? cleared > 0
          ? `Cleared ${cleared} (${plural(input.cardsReviewedToday, 'card')}, ${plural(reviewedProblems, 'review')}${env.doneToday ? `, ${env.doneToday} envelope` : ''})`
          : 'Nothing was due'
        : null,
    ok: pile === 0 ? true : null,
  });

  // --- concept rep (Phase H3) -------------------------------------------------
  // Off on a 30-min day (a planned skip, like Problem 2 and the mock) — unless
  // a rep was already done, which still counts.
  const rep = input.concept ?? { doneToday: 0, last: null };
  const repDone = rep.doneToday > 0;
  const forge = input.forge?.day ? input.forge : null;
  if (forge) {
    // Phase H4: a story-forge day. Same slot, same skip / 30-min-day rules.
    const forged = forge.doneToday > 0;
    base.set('concept', {
      status: forged ? 'done' : skipped.has('concept') || input.quick ? 'skipped' : 'todo',
      href: `/stories?${from('concept')}`,
      detail: input.quick
        ? 'Off today — a 30-min day has no story forge.'
        : 'Story forge: draft one behavioral story by voice for an open story-bank gap; the coach pushes back on "we", scope and numbers · ~15 min',
      result: forged && forge.last ? `${forge.last.status === 'saved' ? 'Saved' : 'Drafted'} · ${forge.last.title}${forge.doneToday > 1 ? ` · ${forge.doneToday} stories` : ''}` : null,
      ok: forged ? true : null,
      label: 'Story forge',
    });
  } else base.set('concept', {
    status: repDone ? 'done' : skipped.has('concept') || input.quick ? 'skipped' : 'todo',
    href: `/concept?${from('concept')}`,
    detail: input.quick
      ? 'Off today — a 30-min day has no concept rep.'
      : 'Explain one system-design or AI-systems concept out loud (~2 min), graded against a rubric · ~10 min',
    result: repDone && rep.last ? `${rep.last.grade === 'got' ? 'Got' : rep.last.grade === 'shaky' ? 'Shaky' : 'Missed'} · ${rep.last.label}${rep.doneToday > 1 ? ` · ${rep.doneToday} reps` : ''}` : null,
    ok: repDone && rep.last ? (rep.last.grade === 'got' ? true : rep.last.grade === 'missed' ? false : null) : null,
  });

  // --- problems ---------------------------------------------------------------
  const problems = newProblemsToday(input);
  // The 30-min day's one problem may be a due review re-solve: that is what
  // the grind serves first, and spacing is the point of the short day.
  const quickOne = input.quick ? problemsToday(input, true)[0] : undefined;
  (['problem1', 'problem2'] as const).forEach((id, i) => {
    const p = id === 'problem1' && input.quick ? quickOne : problems[i];
    const off = input.quick && id === 'problem2';
    base.set(id, {
      status: p ? 'done' : skipped.has(id) || off ? 'skipped' : 'todo',
      href: `/grind?${from(id)}`,
      detail: off
        ? 'Off today — a 30-min day is one problem.'
        : id === 'problem2'
          ? 'Breadth pick: your least-practised topic · predict before you solve'
          : 'Adaptive pick · Minimal editor · predict before you solve',
      result: p ? problemResult(p) : null,
      ok: p ? p.solved : null,
    });
  });

  // --- mock -------------------------------------------------------------------
  const mocks = [...input.mocks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const graded = mocks.find((m) => m.status === 'graded');
  const open = mocks.find((m) => m.status === 'active' || m.status === 'grading' || m.status === 'grade_failed');
  // A skip wins over an open (active / grade_failed) mock: the user said they
  // are done with it (Phase H: Skip did nothing while one was open).
  const offRotation = graded && graded.kind !== input.mockKind;
  base.set('mock', {
    status: graded ? 'done' : skipped.has('mock') ? 'skipped' : open ? 'in-progress' : input.quick ? 'skipped' : 'todo',
    href: graded
      ? `/mock/${graded.id}?${from('mock')}`
      : open
        ? `/mock/${open.id}?${from('mock')}`
        : `/mock?${from('mock')}&kind=${input.mockKind}`,
    detail: input.quick && !graded && !open ? 'Off today — a 30-min day has no mock.' : `${input.mockKindLabel} — today's kind`,
    // A different kind than the day's pick is fine — but say so.
    result: graded
      ? `${graded.verdict ?? 'graded'} level${offRotation ? ` · ${mockKindLabelOf(graded.kind)} (today's pick was ${input.mockKindLabel})` : ''}`
      : null,
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
    // The verdict itself is the first line of the debrief panel right below;
    // repeating it here printed it twice.
    result: input.hasDebrief ? 'Written — read it below' : null,
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
    return { id, label: s.label ?? TODAY_STEP_LABEL[id], status, href: s.href, detail: s.detail, result: s.result, ok: s.ok };
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
  /**
   * Phase H2: the nearest interview loop's kinds when it is within
   * LOOP_BIAS_DAYS (shared/loops.biasKinds). Non-empty = the pick comes from
   * these, ahead of the debrief's focus and the rotation.
   */
  loopKinds?: readonly MockKind[];
  /**
   * Phase H4: the kinds the plain rotation (and the weakest-kind jump) cycle
   * through. Absent = every kind. The project deep-dive exists but is not
   * rotated: a loop's rounds or the debrief's focus pick it.
   */
  rotation?: readonly MockKind[];
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
 *   1b. an interview loop within LOOP_BIAS_DAYS → one of its round kinds
 *   2. the last debrief named a (still existing) kind → that kind
 *   3. the weakest-graded kind, when it is trending below level (mean < 1 over
 *      its last three) and was not yesterday's → it jumps the queue
 *   4. rotation: the kind after the last day's, in MOCK_KINDS order
 */
export function pickMockKind(input: MockKindPickInput): MockKind {
  const kinds = input.kinds.length ? input.kinds : MOCK_KINDS;
  if (kinds.length === 1) return kinds[0];
  // An interview in a few days: rehearse ITS rounds. Rotate among them so a
  // loop with coding + system design alternates rather than repeating one; a
  // kind not yesterday's wins, the weakest of them breaking the tie.
  const loopKinds = (input.loopKinds ?? []).filter((k) => (kinds as readonly string[]).includes(k));
  if (loopKinds.length === 1) return loopKinds[0];
  if (loopKinds.length > 1) {
    const fresh = loopKinds.filter((k) => k !== input.lastKind);
    const score = (k: MockKind) => kindStrength(input.grades, k) ?? -1; // never graded = weakest
    return [...fresh].sort((a, b) => score(a) - score(b) || loopKinds.indexOf(a) - loopKinds.indexOf(b))[0];
  }
  if (input.focusKind && (kinds as readonly string[]).includes(input.focusKind)) return input.focusKind as MockKind;

  const rotated = input.rotation?.length ? kinds.filter((k) => input.rotation!.includes(k)) : kinds;
  const cycle = rotated.length ? rotated : kinds;
  const lastIdx = input.lastKind ? (cycle as readonly string[]).indexOf(input.lastKind) : -1;
  const rotation = cycle[(lastIdx + 1) % cycle.length];

  let weakest: MockKind | null = null;
  let weakestScore = Infinity;
  for (const k of cycle) {
    const s = kindStrength(input.grades, k);
    if (s !== null && s < weakestScore) {
      weakest = k;
      weakestScore = s;
    }
  }
  if (weakest && weakestScore < 1 && weakest !== rotation && weakest !== input.lastKind) return weakest;
  return rotation;
}

// Readiness moved to readiness.compute.ts (Phase H2: a verdict per area).

// -----------------------------------------------------------------------------
// Debrief coercion
// -----------------------------------------------------------------------------
const str = (x: unknown, max = 600): string => (typeof x === 'string' ? clipAtBoundary(x.trim(), max) : '');

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
    verdict: str(cutToolCallFraming(typeof o.verdict === 'string' ? o.verdict : ''), 300) || 'Day logged.',
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

// -----------------------------------------------------------------------------
// Phase F: which automatic reviews to run, and the miss bias
// -----------------------------------------------------------------------------
/** Failed automatic attempts per target per day before it gives up for the day. */
export const MAX_AI_ATTEMPTS = 2;
/** Automatic rewrites of a stale warm-up note per day. */
export const MAX_NOTE_REFRESHES = 1;
/** Automatic regenerations of a debrief made stale by a later mock grade, per day. */
export const MAX_DEBRIEF_REGENS = 1;
/** Minimum wait after a failure before the next attempt (study.service's number). */
export const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

export interface PendingReviewsInput {
  /** The steps derived for the day. */
  steps: readonly Pick<TodayStep, 'id' | 'status'>[];
  /** Warm-up things actually cleared today (cards graded + review re-solves). */
  warmupActivity: number;
  /** The Recognize add-on reached its set size today. */
  recognizeDone: boolean;
  /** Ids that already have a note. */
  noted: readonly string[];
  /** Noted ids whose note is stale and may be rewritten (budgeted by the caller). */
  staleNotes?: readonly AiReviewTarget[];
  hasDebrief: boolean;
  /** A mock is active, grading or grade_failed today: the day is not settled. */
  mockOpen?: boolean;
  /** The debrief predates a later mock grade and may be regenerated once. */
  debriefStale?: boolean;
  failures: Partial<Record<AiReviewTarget, { n: number; at: string }>>;
  enabled: boolean;
  now: number;
}

/**
 * The automatic reviews to run now, in order (step reviews first, the debrief
 * last so it reads their notes). Pure. Never returns a target that has a
 * result, that failed MAX_AI_ATTEMPTS times today, or that failed inside the
 * cooldown — so polling GET /api/today can never become a retry loop.
 */
export function pendingReviews(input: PendingReviewsInput): AiReviewTarget[] {
  if (!input.enabled) return [];
  const status = new Map(input.steps.map((s) => [s.id, s.status]));
  const eligible: AiReviewTarget[] = [];
  if (status.get('warmup') === 'done' && input.warmupActivity > 0) eligible.push('warmup');
  if (input.recognizeDone) eligible.push('recognize');
  if (status.get('concept') === 'done') eligible.push('concept');
  for (const id of ['problem1', 'problem2', 'mock'] as const) if (status.get(id) === 'done') eligible.push(id);

  // Settled = every step done or skipped AND no mock still running or grading
  // (a second mock started after the first was graded leaves the mock step
  // "done" while the day is plainly not over).
  const allSettled =
    SKIPPABLE_STEPS.every((id) => ['done', 'skipped'].includes(status.get(id) ?? '')) && !input.mockOpen;
  // Real activity, not just "done": a warm-up with nothing due is done but empty.
  const anyDone =
    input.warmupActivity > 0 ||
    input.recognizeDone ||
    status.get('concept') === 'done' ||
    (['problem1', 'problem2', 'mock'] as const).some((id) => status.get(id) === 'done');
  if (allSettled && anyDone && (!input.hasDebrief || input.debriefStale)) eligible.push('debrief');

  const allowed = (t: AiReviewTarget) => {
    const f = input.failures[t];
    if (!f) return true;
    if (f.n >= MAX_AI_ATTEMPTS) return false;
    return input.now - Date.parse(f.at) >= FAILURE_COOLDOWN_MS;
  };
  const stale = new Set(input.staleNotes ?? []);
  return eligible.filter((t) => (t === 'debrief' || !input.noted.includes(t) || stale.has(t)) && allowed(t));
}

/** One more failure for a target. Pure. */
export function bumpFailure(
  failures: PendingReviewsInput['failures'],
  target: AiReviewTarget,
  now: Date
): PendingReviewsInput['failures'] {
  return { ...failures, [target]: { n: (failures[target]?.n ?? 0) + 1, at: now.toISOString() } };
}

/**
 * How much a topic missed TODAY (a Recognize miss/shaky, a drill card graded
 * missed/shaky that names the pattern) leans problem1/2 toward it. Smaller
 * than DAILY_FOCUS_BIAS: a same-day nudge, never a takeover.
 */
export const MISS_FOCUS_BIAS = 0.15;

export function missFocusBias(topic: string, misses: readonly string[] | undefined): number {
  return misses?.includes(topic) ? MISS_FOCUS_BIAS : 0;
}

const topicWords = (t: string) => t.replace(/-/g, ' ');

/**
 * Today's missed topics, deterministic and ordered (recognize first, then cards,
 * each in the order missed; deduped). Cards carry mock concepts, not topics, so
 * a card counts only when it came from a CODING mock and its text names a
 * topic ("sliding window", "heap") — a system-design card about "consistent
 * hashing" is not a hash-map problem.
 */
export function missTopicsToday(input: {
  recognize: readonly { topic: string; grade: string }[];
  cards: readonly { title: string; summary: string; answer: string; lastGrade: string | null; kind: string }[];
}): Topic[] {
  const valid = new Set<string>(TOPICS as readonly string[]);
  const out: Topic[] = [];
  const add = (t: string) => {
    if (valid.has(t) && !out.includes(t as Topic)) out.push(t as Topic);
  };
  for (const r of input.recognize) if (r.grade === 'missed' || r.grade === 'shaky') add(r.topic);
  for (const c of input.cards) {
    if (c.kind !== 'coding' || (c.lastGrade !== 'missed' && c.lastGrade !== 'shaky')) continue;
    const text = ` ${`${c.title} ${c.summary} ${c.answer}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
    for (const t of TOPICS) {
      if (text.includes(` ${topicWords(t)} `) || text.includes(` ${t} `)) add(t);
    }
  }
  return out.slice(0, 4);
}
