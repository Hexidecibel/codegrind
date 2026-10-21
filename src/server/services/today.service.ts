// =============================================================================
// today.service — the Today routine: derive the day, record skips, debrief
// =============================================================================
// GET itself is a handful of indexed reads folded by today.compute. Phase F
// added automatic `small` calls behind it (see kickAiReviews at the bottom):
// one step review per finished step, and the debrief once the day is settled —
// each at most once per day, deduped, with a failure budget, and gated by the
// Settings "AI reviews" toggle. POST /api/today/debrief still works on click.

import { TOPICS, type Topic } from '../../shared/types.js';
import { MOCK_KINDS, isMockKind, mockKindInfo } from '../../shared/mock-kinds.js';
import { costOf } from '../../shared/mock.js';
import {
  SKIPPABLE_STEPS,
  STEP_NOTE_LABEL,
  TODAY_STEPS,
  carryNotesOf,
  isTodayStep,
  type AiReviewTarget,
  type CarryNote,
  type DebriefUsage,
  type StepNoteId,
  type TodayState,
  type TodayStepId,
} from '../../shared/today.js';
import {
  getActiveLanguage,
  getAttemptsByProblem,
  getCleanSolvesByTopic,
  getSkillState,
  getTaggedAttempts,
} from './db.js';
import { tierProgress } from './curriculum.js';
import { computeTrend, splitMistakes } from './reflect.compute.js';
import {
  bumpFailure,
  computeReadiness,
  dayStartMs,
  deriveSteps,
  localDay,
  localDayStreak,
  missTopicsToday,
  newProblemsToday,
  pendingReviews,
  pickMockKind,
  previousDay,
  todayTz,
} from './today.compute.js';
import { aiReviewsEnabled, aiSpend, costOfMeta } from './ai-usage.service.js';
import { runStepReview, type StepReviewInput } from './llm.review.js';
import { todayRecognize } from './recognize.service.js';
import * as store from './today.store.js';
import { runDebrief, type DebriefInput } from './llm.debrief.js';

export class TodayError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 429
  ) {
    super(message);
  }
}

/** A typical debrief: ~1.8k tokens in, ~600 out, on the default model. */
export const DEBRIEF_ESTIMATE_USD =
  costOf('claude-sonnet-5', { inputTokens: 1800, outputTokens: 600, cacheReadTokens: 0, cacheWriteTokens: 0 }) ?? 0.01;

interface DayContext {
  date: string;
  dayStart: string;
  row: store.DailySessionRow;
}

/** The local day, with its row (created on first touch, mock kind frozen then). */
function dayContext(now: Date): DayContext {
  const tz = todayTz();
  const date = localDay(now.getTime(), tz);
  const dayStart = new Date(dayStartMs(date, tz)).toISOString();
  let row = store.getDay(date);
  if (!row || !row.mockKind) {
    const last = store.lastDayBefore(date);
    const focusRow = store.lastDebriefBefore(date);
    const kind = pickMockKind({
      kinds: MOCK_KINDS,
      lastKind: last?.mockKind ?? null,
      grades: store.gradeHistory(),
      focusKind: focusRow?.debrief?.tomorrowFocus.mockKind ?? null,
    });
    row = store.ensureDay(date, kind, now);
  }
  return { date, dayStart, row };
}

/**
 * The topics the scheduler leans toward today: the most recent debrief before
 * today's tomorrowFocus. Read by routes/session.ts. Never throws — a lean is
 * optional, a broken grind is not.
 */
export function dailyFocus(now = new Date()): Topic[] {
  try {
    const date = localDay(now.getTime(), todayTz());
    return store.lastDebriefBefore(date)?.debrief?.tomorrowFocus.patterns ?? [];
  } catch {
    return [];
  }
}

export function getToday(now = new Date()): TodayState {
  const { date, dayStart, row } = dayContext(now);
  const language = getActiveLanguage();
  const mockKind = isMockKind(row.mockKind) ? row.mockKind : MOCK_KINDS[0];

  const attempts = store.attemptsSince(dayStart);
  const mocks = store.mocksSince(dayStart);
  const derived = deriveSteps({
    dayStart,
    attempts,
    mocks,
    cardsDue: store.cardsDueBefore(dayStart, now),
    reviewsDue: store.reviewsDue(language, dayStart, now),
    cardsReviewedToday: store.cardsReviewedSince(dayStart).length,
    skips: row.skips,
    endedEarly: !!row.endedEarlyAt,
    mockKind,
    mockKindLabel: mockKindInfo(mockKind).label,
    hasDebrief: !!row.debrief,
    debriefVerdict: row.debrief?.verdict ?? null,
  });

  const skill = new Map(getSkillState(language).map((s) => [s.topic, s]));
  const clean = getCleanSolvesByTopic(language);
  const readiness = computeReadiness({
    topics: TOPICS.map((t) => {
      const tier = tierProgress(clean.get(t));
      return { topic: t, attempts: skill.get(t)?.attempts ?? 0, score: tier.score, tiered: tier.level !== 'none' };
    }),
    grades: store.gradeHistory(),
  });

  const since = new Date(now.getTime() - 130 * 86_400_000).toISOString();
  const monthStart = new Date(dayStartMs(`${date.slice(0, 7)}-01`, todayTz())).toISOString();
  return {
    date,
    steps: derived.steps,
    current: derived.current,
    completed: derived.completed,
    total: TODAY_STEPS.length,
    endedEarly: !!row.endedEarlyAt,
    streak: localDayStreak(store.activitySince(since), now.getTime(), todayTz()),
    mockKind,
    readiness,
    attemptedProblemIds: [...new Set(attempts.map((a) => a.problemId))],
    debrief: row.debrief,
    debriefUsage: row.debriefUsage,
    focus: dailyFocus(now),
    debriefEstimateUsd: DEBRIEF_ESTIMATE_USD,
    recognize: todayRecognize(
      dayStart,
      // "the last 3 local days" = from local midnight two days ago
      new Date(dayStartMs(previousDay(previousDay(date)), todayTz())).toISOString(),
      now
    ),
    stepNotes: row.stepNotes,
    aiPending: [...(running.get(date) ?? [])],
    aiReviews: aiReviewsEnabled(),
    spend: aiSpend(dayStart, monthStart),
  };
}

/** Skip (or un-skip) one step. */
export function setSkip(step: unknown, skip: boolean, now = new Date()): TodayState {
  if (!isTodayStep(step) || !SKIPPABLE_STEPS.includes(step)) {
    throw new TodayError(`step must be one of: ${SKIPPABLE_STEPS.join(', ')}`, 400);
  }
  const { date, row } = dayContext(now);
  const skips = new Set<TodayStepId>(row.skips);
  if (skip) skips.add(step);
  else skips.delete(step);
  store.setSkips(date, TODAY_STEPS.filter((s) => skips.has(s)), now);
  return getToday(now);
}

/** End the day early (every unfinished step is skipped, the debrief unlocks), or undo it. */
export function setEndedEarly(ended: boolean, now = new Date()): TodayState {
  const { date } = dayContext(now);
  store.setEndedEarly(date, ended ? now.toISOString() : null, now);
  return getToday(now);
}

/** The digest the debrief reads. Exported for the dry-run/tests. */
export function buildDebriefInput(now = new Date()): DebriefInput {
  const { date, dayStart, row } = dayContext(now);
  const attempts = store.attemptsSince(dayStart);
  const mocks = store.mocksSince(dayStart);
  const cards = store.cardsReviewedSince(dayStart);
  const state = getToday(now);
  const language = getActiveLanguage();

  const graded = [...mocks].reverse().find((m) => m.status === 'graded') ?? [...mocks].reverse()[0] ?? null;

  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const trend = computeTrend(getAttemptsByProblem(language)).filter((p) => p.at >= weekAgo);
  const weekAttempts = store.attemptsSince(weekAgo);
  const activeDays = new Set(weekAttempts.map((a) => localDay(Date.parse(a.createdAt), todayTz()))).size;
  const mistakes = splitMistakes(getTaggedAttempts(language).filter((t) => t.createdAt >= weekAgo));

  // One line per problem, its LAST submit today (the outcome), hints maxed.
  const byProblem = new Map<string, (typeof attempts)[number] & { hintsMax: number; solvedAny: boolean }>();
  for (const a of attempts) {
    const prev = byProblem.get(a.problemId);
    byProblem.set(a.problemId, {
      ...a,
      prediction: prev?.prediction ?? a.prediction,
      mistakeTags: [...new Set([...(prev?.mistakeTags ?? []), ...a.mistakeTags])],
      hintsMax: Math.max(prev?.hintsMax ?? 0, a.hintsUsed),
      solvedAny: (prev?.solvedAny ?? false) || a.solved,
    });
  }

  return {
    date,
    attempts: [...byProblem.values()].map((a) => ({
      title: a.title,
      pattern: a.pattern,
      difficulty: a.difficulty,
      solved: a.solvedAny,
      hints: a.hintsMax,
      testsPassed: a.testsPassed,
      testsTotal: a.testsTotal,
      review: a.firstAt < dayStart,
      predicted: a.prediction
        ? {
            time: a.prediction.predTime ?? '',
            space: a.prediction.predSpace ?? '',
            confidence: typeof a.prediction.confidence === 'number' ? a.prediction.confidence : null,
          }
        : null,
      mistakeTags: a.mistakeTags,
    })),
    mock: graded
      ? {
          kind: graded.kind,
          verdict: graded.verdict,
          summary: (graded.grade?.summary ?? '').slice(0, 600),
          gaps: (graded.grade?.gaps ?? []).map((g) => g.title).filter(Boolean).slice(0, 6),
        }
      : null,
    skipped: state.steps.filter((s) => s.status === 'skipped').map((s) => s.label),
    cards: {
      reviewed: cards.length,
      got: cards.filter((c) => c.lastGrade === 'got').length,
      shaky: cards.filter((c) => c.lastGrade === 'shaky').length,
      missed: cards.filter((c) => c.lastGrade === 'missed').length,
    },
    week: {
      activeDays,
      attempts: weekAttempts.length,
      solved: weekAttempts.filter((a) => a.solved).length,
      firstSubmitPassPct: trend.length
        ? Math.round((trend.reduce((s, p) => s + p.firstSubmitRatio, 0) / trend.length) * 100)
        : null,
      topMistakes: mistakes.slice(0, 3).map((m) => m.tag),
    },
    stepNotes: carryNotesOf(row.stepNotes),
  };
}

let debriefInFlight = false;

/** The one debrief call + store, shared by the button and the auto debrief. */
async function writeDebrief(date: string, now: Date): Promise<void> {
  if (debriefInFlight) throw new TodayError('A debrief is already being written.', 429);
  debriefInFlight = true;
  try {
    const { debrief: d, meta } = await runDebrief(buildDebriefInput(now));
    const usage: DebriefUsage = {
      model: meta.servedModel,
      inputTokens: meta.usage.inputTokens,
      outputTokens: meta.usage.outputTokens,
      costUsd: costOf(meta.servedModel, {
        inputTokens: meta.usage.inputTokens,
        outputTokens: meta.usage.outputTokens,
        cacheReadTokens: meta.usage.cachedInputTokens,
        cacheWriteTokens: meta.usage.cacheWriteInputTokens ?? 0,
      }),
    };
    store.putDebrief(date, d, usage, now);
  } finally {
    debriefInFlight = false;
  }
}

/**
 * The day's debrief. Cached: a second call returns the stored one for free
 * unless `regenerate` is set. Locked until the mock is done/skipped or the day
 * was ended early — the same rule the step list shows.
 */
export async function debrief(opts: { regenerate?: boolean } = {}, now = new Date()): Promise<TodayState> {
  const state = getToday(now);
  if (state.debrief && !opts.regenerate) return state;
  const step = state.steps.find((s) => s.id === 'debrief')!;
  if (step.status === 'locked') {
    throw new TodayError('Finish or skip the mock (or end the day early) to unlock the debrief.', 409);
  }
  await writeDebrief(state.date, now);
  return getToday(now);
}

// =============================================================================
// Phase F: automatic step reviews + the auto debrief
// =============================================================================
// Triggered lazily: every GET /api/today (and skip / end) calls kickAiReviews,
// which works out — purely, in today.compute.pendingReviews — which finished
// steps still lack a note, and runs them in ONE background job per day:
//
//   * dedupe   one job per local day (`jobs`); a GET during it just reports
//              `aiPending` and returns.
//   * budget   a failure is recorded in daily_sessions.aiFailures; a target is
//              retried only after FAILURE_COOLDOWN_MS and at most
//              MAX_AI_ATTEMPTS times a day. So a dead model costs at most two
//              calls per step per day however often the page polls — never a
//              retry loop.
//   * gate     the Settings "AI reviews" toggle (default on). Off = no job.

const jobs = new Map<string, Promise<void>>();
/** What the running job still has to do, per day — GET reports it as aiPending. */
const running = new Map<string, Set<AiReviewTarget>>();

const NEXT_OF: Readonly<Record<StepNoteId, string>> = {
  warmup: 'Problem 1 (an adaptive algorithm problem)',
  recognize: 'Problem 1 (an adaptive algorithm problem)',
  problem1: 'Problem 2 (another adaptive algorithm problem)',
  problem2: 'the mock interview',
  mock: "the debrief and tomorrow's practice",
};

/** The short digest of one finished step, for its review. Exported for tests. */
export function stepDigest(id: StepNoteId, now = new Date()): string[] {
  const { dayStart } = dayContext(now);
  const attempts = store.attemptsSince(dayStart);
  if (id === 'warmup') {
    const lines = store.cardsDetailSince(dayStart).map((c) => `Drill card "${c.title || c.summary}" (${c.concept}): ${c.lastGrade ?? 'ungraded'}`);
    const reviews = new Map<string, (typeof attempts)[number] & { hints: number; solvedAny: boolean }>();
    for (const a of attempts.filter((x) => x.firstAt < dayStart)) {
      const prev = reviews.get(a.problemId);
      reviews.set(a.problemId, { ...a, hints: Math.max(prev?.hints ?? 0, a.hintsUsed), solvedAny: (prev?.solvedAny ?? false) || a.solved });
    }
    for (const r of reviews.values()) {
      lines.push(`Review re-solve "${r.title}" (${r.pattern}, ${r.difficulty}): ${r.solvedAny ? 'passed' : 'failed'}, ${r.hints} hints`);
    }
    return lines.slice(0, 16);
  }
  if (id === 'recognize') {
    return store
      .recognizeSince(dayStart)
      .slice(-10)
      .map(
        (r) =>
          `${r.title || 'a problem'}: picked ${r.picked ?? 'nothing'} (answer: ${r.topic}) — ${r.patternCorrect ? 'right' : 'WRONG'} pattern, graded ${r.grade}${
            r.aiVerdict ? `, AI verdict ${r.aiVerdict}` : ''
          }${r.approach.trim() ? `; approach: "${r.approach.trim().replace(/\s+/g, ' ').slice(0, 160)}"` : ''}`
      );
  }
  if (id === 'problem1' || id === 'problem2') {
    const p = newProblemsToday({ attempts, dayStart })[id === 'problem1' ? 0 : 1];
    if (!p) return [];
    const mine = attempts.filter((a) => a.problemId === p.problemId);
    const last = mine[mine.length - 1];
    const pred = mine.find((a) => a.prediction)?.prediction ?? null;
    const tags = [...new Set(mine.flatMap((a) => a.mistakeTags))];
    return [
      `"${p.title}" (${last.pattern}, ${last.difficulty}): ${p.solved ? 'PASSED' : 'FAILED'} after ${p.submits} submit${p.submits === 1 ? '' : 's'}, ${p.hints} hints, last run ${last.testsPassed}/${last.testsTotal} tests`,
      pred
        ? `Predicted ${pred.predTime || '?'} time / ${pred.predSpace || '?'} space${typeof pred.confidence === 'number' ? `, confidence ${pred.confidence}/5` : ''}${pred.approach ? `; planned: "${pred.approach.slice(0, 160)}"` : ''}`
        : 'No complexity prediction',
      tags.length ? `Coach-tagged mistakes: ${tags.join(', ')}` : 'No mistakes tagged by the coach',
    ];
  }
  // mock
  const graded = [...store.mocksSince(dayStart)].reverse().find((m) => m.status === 'graded');
  if (!graded) return [];
  return [
    `${graded.kind} mock: ${graded.verdict ?? 'graded'} level`,
    ...(graded.grade?.summary ? [`Grader summary: ${graded.grade.summary.slice(0, 500)}`] : []),
    ...((graded.grade?.gaps ?? []).length ? [`Gaps: ${(graded.grade?.gaps ?? []).map((g) => g.title).filter(Boolean).slice(0, 6).join('; ')}`] : []),
  ];
}

async function reviewStep(id: StepNoteId, now: Date): Promise<void> {
  const { date, row } = dayContext(now);
  const input: StepReviewInput = {
    step: STEP_NOTE_LABEL[id],
    next: NEXT_OF[id],
    digest: stepDigest(id, now),
    earlier: carryNotesOf(row.stepNotes),
  };
  const { result, meta } = await runStepReview(input);
  if (!result.note) throw new Error('empty step review');
  const fresh = store.getDay(date)!;
  store.setStepNotes(
    date,
    {
      ...fresh.stepNotes,
      [id]: { note: result.note, carry: result.carry, at: now.toISOString(), model: meta.servedModel, costUsd: costOfMeta(meta) },
    },
    now
  );
}

/** What pendingReviews says to run right now. */
function pendingFor(state: TodayState, now: Date): AiReviewTarget[] {
  const row = store.getDay(state.date);
  if (!row) return [];
  const { dayStart } = dayContext(now);
  const reviewedProblems = new Set(store.attemptsSince(dayStart).filter((a) => a.firstAt < dayStart).map((a) => a.problemId)).size;
  return pendingReviews({
    steps: state.steps,
    warmupActivity: store.cardsReviewedSince(dayStart).length + reviewedProblems,
    recognizeDone: state.recognize.done,
    noted: Object.keys(row.stepNotes),
    hasDebrief: !!row.debrief,
    failures: row.aiFailures,
    enabled: state.aiReviews,
    now: now.getTime(),
  });
}

/**
 * Start the day's review job if there is anything to do and none is running.
 * Never throws, never awaits the model on the caller's path. Returns the job
 * (tests await it) or null when there was nothing to start.
 */
export function kickAiReviews(state: TodayState, now = new Date()): Promise<void> | null {
  try {
    const existing = jobs.get(state.date);
    if (existing) return existing;
    const todo = pendingFor(state, now);
    if (!todo.length) return null;
    const date = state.date;
    const left = new Set(todo);
    running.set(date, left);
    const job = (async () => {
      for (const target of todo) {
        // Real time per call, so a long job stamps honest times; the day is fixed.
        const at = new Date(Math.max(now.getTime(), Date.now()));
        try {
          if (target === 'debrief') {
            // A click already writing it is not a failure; it just is not ours.
            if (!store.getDay(date)?.debrief && !debriefInFlight) await writeDebrief(date, at);
          } else {
            await reviewStep(target, at);
          }
        } catch (err) {
          const row = store.getDay(date);
          if (row) store.setAiFailures(date, bumpFailure(row.aiFailures, target, at), at);
          console.error(`[today] auto ${target} review failed:`, err instanceof Error ? err.message : err);
        } finally {
          left.delete(target);
        }
      }
    })().finally(() => {
      jobs.delete(date);
      running.delete(date);
    });
    jobs.set(date, job);
    return job;
  } catch (err) {
    console.error('[today] could not start reviews:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** GET /api/today: the day, with the review job kicked and reported. */
export function getTodayAndKick(now = new Date()): TodayState {
  const state = getToday(now);
  if (kickAiReviews(state, now)) return { ...state, aiPending: [...(running.get(state.date) ?? [])] };
  return state;
}

/** Today's notes as carry-forward context (coaching, mock start). Never throws. */
export function todayCarryNotes(now = new Date()): CarryNote[] {
  try {
    const date = localDay(now.getTime(), todayTz());
    const row = store.getDay(date);
    return row ? carryNotesOf(row.stepNotes) : [];
  } catch {
    return [];
  }
}

/**
 * Topics missed today in Recognize or on a drill card: the scheduler's small
 * same-day lean (today.compute.MISS_FOCUS_BIAS). Never throws.
 */
export function todayMissTopics(now = new Date()): Topic[] {
  try {
    const dayStart = new Date(dayStartMs(localDay(now.getTime(), todayTz()), todayTz())).toISOString();
    return missTopicsToday({ recognize: store.recognizeSince(dayStart), cards: store.cardsDetailSince(dayStart) });
  } catch {
    return [];
  }
}

/** Resolves when the day's review job (if any) has finished. For tests and scripts. */
export function aiReviewsIdle(now = new Date()): Promise<void> {
  return jobs.get(localDay(now.getTime(), todayTz())) ?? Promise.resolve();
}
