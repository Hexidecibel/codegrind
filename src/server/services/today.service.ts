// =============================================================================
// today.service — the Today routine: derive the day, record skips, debrief
// =============================================================================
// GET is free: a handful of indexed reads folded by today.compute. The only
// model call is runDebrief, behind POST /api/today/debrief, which only a click
// reaches — and its answer is cached per local day.

import { TOPICS, type Topic } from '../../shared/types.js';
import { MOCK_KINDS, isMockKind, mockKindInfo } from '../../shared/mock-kinds.js';
import { costOf } from '../../shared/mock.js';
import {
  SKIPPABLE_STEPS,
  TODAY_STEPS,
  isTodayStep,
  type DebriefUsage,
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
  computeReadiness,
  dayStartMs,
  deriveSteps,
  localDay,
  localDayStreak,
  pickMockKind,
  previousDay,
  todayTz,
} from './today.compute.js';
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
  const { date, dayStart } = dayContext(now);
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
  };
}

let debriefInFlight = false;

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
    store.putDebrief(state.date, d, usage, now);
  } finally {
    debriefInFlight = false;
  }
  return getToday(now);
}
