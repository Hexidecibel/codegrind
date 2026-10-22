// =============================================================================
// today.service — the Today routine: derive the day, record skips, debrief
// =============================================================================
// GET itself is a handful of indexed reads folded by today.compute. Phase F
// added automatic `small` calls behind it (see kickAiReviews at the bottom):
// one step review per finished step, and the debrief once the day is settled —
// each at most once per day, deduped, with a failure budget, and gated by the
// Settings "AI reviews" toggle. POST /api/today/debrief still works on click.

import type { Topic } from '../../shared/types.js';
import { MOCK_KINDS, ROTATION_MOCK_KINDS, isMockKind, mockKindInfo } from '../../shared/mock-kinds.js';
import { costOf } from '../../shared/mock.js';
import {
  QUICK_ENVELOPE_REPS,
  QUICK_OFF_STEPS,
  SKIPPABLE_STEPS,
  STEP_NOTE_LABEL,
  TODAY_STEPS,
  applicableNotes,
  isTodayStep,
  type AiReviewTarget,
  type CarryNote,
  type DebriefUsage,
  type ReadinessArea,
  type StepNote,
  type StepNoteId,
  type TodayState,
  type TodayStepId,
} from '../../shared/today.js';
import { getActiveLanguage, getAttemptsByProblem, getProblem, getTaggedAttempts, listLoops } from './db.js';
import type { Language } from '../../shared/languages.js';
import { biasKinds, loopCountdown, type LoopCountdown } from '../../shared/loops.js';
import { computeReadiness } from './readiness.compute.js';
import { computeTrend, splitMistakes } from './reflect.compute.js';
import {
  MAX_DEBRIEF_REGENS,
  MAX_NOTE_REFRESHES,
  bumpFailure,
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
import { SMALL_CALL_SHAPES, aiReviewsEnabled, aiSpend, costOfMeta, smallCallEstimateUsd } from './ai-usage.service.js';
import { runStepReview, type StepReviewInput } from './llm.review.js';
import { todayRecognize } from './recognize.service.js';
import { envelopeDigest, todayEnvelope } from './envelope.service.js';
import { conceptDigest, readinessReps, todayConcept, track } from './concept.service.js';
import { forgeDigest, isForgeDayNow, todayForge } from './forge.service.js';

/** Phase H4: whether today's concept step is a story forge, and what it did. Never throws. */
function forgeStep(now: Date): { day: boolean; doneToday: number; last: { title: string; status: string } | null } {
  const f = todayForge(now);
  return { day: isForgeDayNow(todayConcept(now).doneToday > 0, now), ...f };
}
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

/** A typical debrief (~1.8k tokens in, ~600 out), priced on the model `small` routes to; 0 when local. */
export function debriefEstimateUsd(): number {
  return smallCallEstimateUsd(SMALL_CALL_SHAPES.debrief) ?? 0;
}

interface DayContext {
  date: string;
  dayStart: string;
  row: store.DailySessionRow;
}

/** The nearest upcoming interview loop for a local day. Never throws. */
export function nextLoopFor(date: string): LoopCountdown | null {
  try {
    return loopCountdown(listLoops(), date);
  } catch {
    return null;
  }
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
      rotation: ROTATION_MOCK_KINDS,
      lastKind: last?.mockKind ?? null,
      grades: store.gradeHistory(),
      focusKind: focusRow?.debrief?.tomorrowFocus.mockKind ?? null,
      // Phase H2: within LOOP_BIAS_DAYS of an interview, rehearse its rounds.
      loopKinds: biasKinds(nextLoopFor(date)),
    });
    row = store.ensureDay(date, kind, now);
  }
  // Phase H2: the loop's final-review day pulls every open item due — once.
  const loop = nextLoopFor(date);
  if (loop?.isFinalReviewDay && !row.finalReviewAt) {
    try {
      if (store.runFinalReview(date, dayStart, now)) row = store.getDay(date)!;
    } catch (err) {
      console.error('[today] final review failed:', err instanceof Error ? err.message : err);
    }
  }
  return { date, dayStart, row };
}

/**
 * Phase H2 breadth floor: is the next grind problem the day's Problem 2? True
 * when exactly one NEW problem was attempted today and Problem 2 is still
 * wanted (not skipped, not a 30-min day, the day not ended). Returns Problem 1's
 * topic so the pick avoids it. Never throws — a broken read means "no".
 */
export function breadthSlot(now = new Date()): { avoidTopic: string | null } | null {
  try {
    const { dayStart, row } = dayContext(now);
    if (row.quick || row.endedEarlyAt || row.skips.includes('problem2')) return null;
    const attempts = store.attemptsSince(dayStart);
    const fresh = newProblemsToday({ attempts, dayStart });
    if (fresh.length !== 1) return null;
    return { avoidTopic: getProblem(fresh[0].problemId)?.topic ?? null };
  } catch {
    return null;
  }
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
  const envelope = todayEnvelope(dayStart, now, row.quick ? QUICK_ENVELOPE_REPS : undefined);
  const nextLoop = nextLoopFor(date);
  const derived = deriveSteps({
    dayStart,
    attempts,
    mocks,
    cardsDue: store.cardsDueBefore(dayStart, now),
    reviewsDue: store.reviewsDue(language, dayStart, now),
    cardsReviewedToday: store.cardsReviewedSince(dayStart).length,
    envelope: { remaining: envelope.remaining, doneToday: envelope.doneToday, query: envelope.query },
    skips: row.skips,
    endedEarly: !!row.endedEarlyAt,
    mockKind,
    mockKindLabel: mockKindInfo(mockKind).label,
    hasDebrief: !!row.debrief,
    debriefVerdict: row.debrief?.verdict ?? null,
    quick: row.quick,
    concept: todayConcept(now),
    forge: forgeStep(now),
    finalReview: nextLoop?.isFinalReviewDay ? { company: nextLoop.company, daysLeft: nextLoop.daysLeft } : null,
  });

  const readiness = readinessNow(language, nextLoop, now);

  const monthStart = new Date(dayStartMs(`${date.slice(0, 7)}-01`, todayTz())).toISOString();
  return {
    date,
    steps: derived.steps,
    current: derived.current,
    completed: derived.completed,
    total: TODAY_STEPS.length,
    endedEarly: !!row.endedEarlyAt,
    streak: practiceStreak(now),
    mockKind,
    readiness,
    attemptedProblemIds: [...new Set(attempts.map((a) => a.problemId))],
    debrief: row.debrief,
    debriefUsage: row.debriefUsage,
    focus: dailyFocus(now),
    debriefEstimateUsd: debriefEstimateUsd(),
    recognize: todayRecognize(
      dayStart,
      // "the last 3 local days" = from local midnight two days ago
      new Date(dayStartMs(previousDay(previousDay(date)), todayTz())).toISOString(),
      now
    ),
    envelope,
    stepNotes: row.stepNotes,
    aiPending: [...(running.get(date) ?? [])],
    aiReviews: aiReviewsEnabled(),
    spend: aiSpend(dayStart, monthStart),
    quick: row.quick,
    nextLoop,
  };
}

/** The readiness strip (readiness.compute), from the last 120 days of evidence. */
function readinessNow(language: Language, nextLoop: LoopCountdown | null, now: Date) {
  const since = new Date(now.getTime() - 120 * 86_400_000).toISOString();
  return computeReadiness({
    now: now.getTime(),
    attempts: store.readinessAttempts(language, since),
    grades: store.gradeHistory(60),
    cardReviews: store.cardReviews(since),
    conceptReps: readinessReps(since),
    nextLoop: nextLoop ? { company: nextLoop.company, daysLeft: nextLoop.daysLeft, rounds: nextLoop.rounds } : null,
  });
}

/** GET /api/today/readiness — what resume-builder's held lane reads. */
export interface ReadinessSnapshot {
  date: string;
  readiness: Pick<ReadinessArea, 'id' | 'label' | 'verdict' | 'evidence' | 'hint'>[];
  concepts: { knownAi: number; unlockAt: number; totalAi: number; knownClassic: number; totalClassic: number };
}

/**
 * The readiness verdicts and the concept-rep counts, and nothing else. Unlike
 * GET /api/today this never kicks the automatic AI reviews and writes nothing,
 * so a timer can poll it for free (resume-builder's bin/readiness-sync).
 */
export function readinessSnapshot(now = new Date()): ReadinessSnapshot {
  const date = localDay(now.getTime(), todayTz());
  const readiness = readinessNow(getActiveLanguage(), nextLoopFor(date), now);
  const t = track(now);
  const of = (category: string) => t.items.filter((i) => i.category === category);
  return {
    date,
    readiness: readiness.map(({ id, label, verdict, evidence, hint }) => ({ id, label, verdict, evidence, hint })),
    concepts: {
      knownAi: t.knownAi,
      unlockAt: t.unlockAt,
      totalAi: of('ai').length,
      knownClassic: of('classic').filter((i) => i.state === 'known').length,
      totalClassic: of('classic').length,
    },
  };
}

/** Turn the day's "30-min day" mode on or off. */
export function setQuick(on: boolean, now = new Date()): TodayState {
  const { date } = dayContext(now);
  store.setQuick(date, on, now);
  return getToday(now);
}

/**
 * Consecutive LOCAL days with any practice (grind, mock, card, Recognize,
 * Envelope). The one streak: Today and Reflect both show this number, so the
 * two can no longer disagree across a UTC midnight. Never throws.
 */
export function practiceStreak(now = new Date()): number {
  try {
    const since = new Date(now.getTime() - 130 * 86_400_000).toISOString();
    return localDayStreak(store.activitySince(since), now.getTime(), todayTz());
  } catch {
    return 0;
  }
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
    // A 30-min day's Problem 2 and mock were planned off, not skipped.
    skipped: state.steps
      .filter((s) => s.status === 'skipped' && !(state.quick && QUICK_OFF_STEPS.includes(s.id)))
      .map((s) => s.label),
    ...(state.quick ? { quick: true } : {}),
    ...(state.nextLoop
      ? {
          nextLoop: {
            company: state.nextLoop.company,
            date: state.nextLoop.date,
            daysLeft: state.nextLoop.daysLeft,
            rounds: state.nextLoop.rounds,
          },
        }
      : {}),
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
    // Notes only, never carries: a carry is an instruction, not evidence.
    stepNotes: applicableNotes(row.stepNotes, 'debrief'),
    // Phase H3: '' → absent, so a day without a rep renders as before.
    ...(conceptDigest(now).length ? { conceptReps: conceptDigest(now) } : {}),
    ...(forgeDigest(now).length ? { storyForge: forgeDigest(now) } : {}),
  };
}

let debriefInFlight = false;

/**
 * The one debrief call + store, shared by the button and the auto debrief.
 * `day` is any instant inside the day being debriefed (a job that runs past
 * midnight must still read ITS day); `stamp` is the real time of the write.
 */
async function writeDebrief(date: string, day: Date, stamp: Date = day, auto: 'first' | 'regen' | null = null): Promise<void> {
  if (debriefInFlight) throw new TodayError('A debrief is already being written.', 429);
  debriefInFlight = true;
  try {
    const { debrief: d, meta } = await runDebrief(buildDebriefInput(day));
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
    store.putDebrief(date, d, usage, stamp);
    if (auto === 'regen') store.bumpDebriefRegens(date, stamp);
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
  concept: "the next system-design conversation (today's mock if it is system design; otherwise tomorrow's concept rep)",
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
    lines.push(...envelopeDigest(dayStart));
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
  if (id === 'concept') return [...conceptDigest(now), ...forgeDigest(now)];
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
    // A behavioral summary retells the candidate's STORIES; those facts must
    // not travel into the note, and from there into later prompts.
    ...(graded.grade?.summary && graded.kind !== 'behavioral' ? [`Grader summary: ${graded.grade.summary.slice(0, 500)}`] : []),
    ...((graded.grade?.gaps ?? []).length ? [`Gaps: ${(graded.grade?.gaps ?? []).map((g) => g.title).filter(Boolean).slice(0, 6).join('; ')}`] : []),
  ];
}

/**
 * One step review. `day` is an instant inside the day being reviewed — the
 * job's own start, so a job still running after midnight writes to ITS day,
 * not tomorrow's (Phase H) — and `stamp` is the real time of the write.
 */
async function reviewStep(id: StepNoteId, day: Date, stamp: Date = day): Promise<void> {
  const { date, row } = dayContext(day);
  const input: StepReviewInput = {
    step: STEP_NOTE_LABEL[id],
    next: NEXT_OF[id],
    digest: stepDigest(id, day),
    earlier: applicableNotes(row.stepNotes, id),
  };
  const { result, meta } = await runStepReview(input);
  if (!result.note) throw new Error('empty step review');
  const fresh = store.getDay(date)!;
  const prev = fresh.stepNotes[id];
  const extra: Partial<StepNote> = {};
  if (id === 'mock') {
    const graded = [...store.mocksSince(dayContext(day).dayStart)].reverse().find((m) => m.status === 'graded');
    if (graded) extra.kind = graded.kind;
  }
  if (id === 'warmup') {
    extra.evidence = warmupEvidence(day);
    if (prev) extra.refreshes = (prev.refreshes ?? 0) + 1;
  }
  store.setStepNotes(
    date,
    {
      ...fresh.stepNotes,
      [id]: { note: result.note, carry: result.carry, at: stamp.toISOString(), model: meta.servedModel, costUsd: costOfMeta(meta), ...extra },
    },
    stamp
  );
}

/** Warm-up items cleared so far today: cards graded + review re-solves + envelope reps. */
function warmupEvidence(day: Date): number {
  const { dayStart } = dayContext(day);
  const reviewedProblems = new Set(store.attemptsSince(dayStart).filter((a) => a.firstAt < dayStart).map((a) => a.problemId)).size;
  return store.cardsReviewedSince(dayStart).length + reviewedProblems + todayEnvelope(dayStart, day).doneToday;
}

/** What pendingReviews says to run right now. */
function pendingFor(state: TodayState, now: Date): AiReviewTarget[] {
  const row = store.getDay(state.date);
  if (!row) return [];
  const { dayStart } = dayContext(now);
  const mocks = store.mocksSince(dayStart);
  const warmupActivity = warmupEvidence(now);
  const warm = row.stepNotes.warmup;
  // The warm-up note goes stale when warm-up evidence grew after it was
  // written (envelope reps done later, a card graded later) — rewritten at most
  // MAX_NOTE_REFRESHES times a day.
  const staleNotes: AiReviewTarget[] =
    warm && typeof warm.evidence === 'number' && warmupActivity > warm.evidence && (warm.refreshes ?? 0) < MAX_NOTE_REFRESHES
      ? ['warmup']
      : [];
  return pendingReviews({
    steps: state.steps,
    warmupActivity,
    recognizeDone: state.recognize.done,
    noted: Object.keys(row.stepNotes),
    staleNotes,
    hasDebrief: !!row.debrief,
    mockOpen: mocks.some((m) => OPEN_MOCK.has(m.status)),
    debriefStale: debriefIsStale(row, mocks),
    failures: row.aiFailures,
    enabled: state.aiReviews,
    now: now.getTime(),
  });
}

// Running or grading. A grade_failed mock is stuck, not running — it must not
// hold the day open forever (its retry is on the mock page).
const OPEN_MOCK = new Set(['active', 'grading']);

/**
 * The debrief was written before a mock grade that landed later the same day,
 * and has not been auto-regenerated yet (MAX_DEBRIEF_REGENS). Then it is
 * missing the day's biggest event and is rewritten once, automatically.
 */
function debriefIsStale(row: store.DailySessionRow, mocks: store.TodayMockFull[]): boolean {
  if (!row.debrief || !row.debriefAt) return false;
  if (row.debriefRegens >= MAX_DEBRIEF_REGENS) return false;
  return mocks.some((m) => m.status === 'graded' && !!m.gradedAt && m.gradedAt > row.debriefAt!);
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
            const day = store.getDay(date);
            const regen = !!day?.debrief;
            if ((!regen || (day && debriefIsStale(day, store.mocksSince(dayContext(now).dayStart)))) && !debriefInFlight) {
              await writeDebrief(date, now, at, regen ? 'regen' : 'first');
            }
          } else {
            // `now` fixes the DAY, `at` stamps the write (see reviewStep).
            await reviewStep(target, now, at);
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

/**
 * Today's notes as carry-forward context, filtered for what applies there
 * (shared/today.applicableNotes): 'algorithm' for coaching a grind submit and a
 * coding mock's setup, 'mock' for any other mock's setup. Never throws.
 */
export function todayCarryNotes(now = new Date(), target: 'algorithm' | 'mock' = 'algorithm'): CarryNote[] {
  try {
    const date = localDay(now.getTime(), todayTz());
    const row = store.getDay(date);
    return row ? applicableNotes(row.stepNotes, target) : [];
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
