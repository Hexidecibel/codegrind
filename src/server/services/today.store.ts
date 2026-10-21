// =============================================================================
// today.store — the reads behind the Today routine, and daily_sessions
// =============================================================================
// Same connection as db.ts and mock.store.ts; statements prepared lazily. Every
// read here is a window over rows other features already write — attempts,
// mocks, mock_gaps, review_queue — so the routine can never disagree with them.
// daily_sessions holds only what cannot be derived (see db.migrate.ts).

import { db } from './db.js';
import type { Language } from '../../shared/languages.js';
import type { MockVerdict } from '../../shared/mock.js';
import {
  STEP_NOTE_IDS,
  isTodayStep,
  type AiReviewTarget,
  type Debrief,
  type DebriefUsage,
  type StepNote,
  type StepNotes,
  type TodayStepId,
} from '../../shared/today.js';
import type { TodayAttemptRow, TodayMockRow } from './today.compute.js';

export interface DailySessionRow {
  date: string;
  mockKind: string | null;
  skips: TodayStepId[];
  endedEarlyAt: string | null;
  debrief: Debrief | null;
  debriefUsage: DebriefUsage | null;
  debriefAt: string | null;
  /** Automatic regenerations of the debrief today (today.compute.MAX_DEBRIEF_REGENS). */
  debriefRegens: number;
  stepNotes: StepNotes;
  /** Failed automatic attempts per target: the retry budget (today.compute.pendingReviews). */
  aiFailures: AiFailures;
  /** Phase H2: the "30-min day" toggle. */
  quick: boolean;
  /** When the final review pulled every open item due (once per day). */
  finalReviewAt: string | null;
  /** Bank problems generated today so Recognize reaches an empty topic. */
  recognizeStocked: number;
}

export type AiFailures = Partial<Record<AiReviewTarget, { n: number; at: string }>>;

let stmts: ReturnType<typeof prepare> | null = null;
function prepare() {
  return {
    getDay: db.prepare(`SELECT * FROM daily_sessions WHERE date = ?`),
    lastDayBefore: db.prepare(`
      SELECT * FROM daily_sessions WHERE date < ? AND mockKind IS NOT NULL ORDER BY date DESC LIMIT 1
    `),
    lastDebriefBefore: db.prepare(`
      SELECT * FROM daily_sessions WHERE date < ? AND debrief IS NOT NULL ORDER BY date DESC LIMIT 1
    `),
    ensureDay: db.prepare(`
      INSERT INTO daily_sessions (date, mockKind, createdAt, updatedAt) VALUES (@date, @mockKind, @now, @now)
      ON CONFLICT(date) DO UPDATE SET mockKind = COALESCE(daily_sessions.mockKind, excluded.mockKind)
    `),
    setSkips: db.prepare(`UPDATE daily_sessions SET skips = @skips, updatedAt = @now WHERE date = @date`),
    setEnded: db.prepare(`UPDATE daily_sessions SET endedEarlyAt = @at, updatedAt = @now WHERE date = @date`),
    setDebrief: db.prepare(`
      UPDATE daily_sessions SET debrief = @debrief, debriefUsage = @usage, debriefAt = @now, updatedAt = @now
      WHERE date = @date
    `),
    bumpDebriefRegens: db.prepare(
      `UPDATE daily_sessions SET debriefRegens = COALESCE(debriefRegens, 0) + 1, updatedAt = @now WHERE date = @date`
    ),
    setStepNotes: db.prepare(`UPDATE daily_sessions SET stepNotes = @notes, updatedAt = @now WHERE date = @date`),
    setAiFailures: db.prepare(`UPDATE daily_sessions SET aiFailures = @failures, updatedAt = @now WHERE date = @date`),
    setQuick: db.prepare(`UPDATE daily_sessions SET quick = @quick, updatedAt = @now WHERE date = @date`),
    bumpRecognizeStocked: db.prepare(
      `UPDATE daily_sessions SET recognizeStocked = COALESCE(recognizeStocked, 0) + 1, updatedAt = @now WHERE date = @date`
    ),
    // The final review: claim the day (only the first caller wins), then pull
    // every open review problem and drill card due at local midnight.
    claimFinalReview: db.prepare(
      `UPDATE daily_sessions SET finalReviewAt = @now, updatedAt = @now WHERE date = @date AND finalReviewAt IS NULL`
    ),
    pullReviews: db.prepare(`UPDATE review_queue SET dueAt = @dayStart WHERE clearedAt IS NULL AND dueAt > @dayStart`),
    pullCards: db.prepare(`UPDATE mock_gaps SET dueAt = @dayStart WHERE retiredAt IS NULL AND dueAt > @dayStart`),
    readinessAttempts: db.prepare(`
      SELECT a.problemId, a.difficulty, a.solved, a.hintsUsed, a.createdAt, a.prediction, n.time AS refTime
      FROM attempts a LEFT JOIN recognize_notes n ON n.problemId = a.problemId
      WHERE a.language = @language AND a.createdAt >= @since
      ORDER BY a.createdAt ASC
    `),
    cardReviews: db.prepare(`
      SELECT COALESCE(m.kind, '') AS kind, r.grade, r.intervalDays
      FROM card_reviews r LEFT JOIN mock_gaps g ON g.id = r.cardId LEFT JOIN mocks m ON m.id = g.mockId
      WHERE r.at >= @since
    `),
    recognizeSince: db.prepare(`
      SELECT r.problemId, COALESCE(p.title, '') AS title, r.topic, r.picked, r.patternCorrect, r.approach, r.grade, r.aiVerdict
      FROM recognize_attempts r LEFT JOIN problems p ON p.id = r.problemId
      WHERE r.createdAt >= ? ORDER BY r.createdAt ASC
    `),
    cardsDetailSince: db.prepare(`
      SELECT g.concept, g.title, g.summary, g.answer, g.lastGrade, COALESCE(m.kind, '') AS kind
      FROM mock_gaps g LEFT JOIN mocks m ON m.id = g.mockId
      WHERE g.lastReviewedAt >= ? ORDER BY g.lastReviewedAt ASC
    `),
    attemptsSince: db.prepare(`
      SELECT a.problemId, COALESCE(p.title, '(deleted problem)') AS title, a.pattern, a.difficulty,
             a.solved, a.hintsUsed, a.testsPassed, a.testsTotal, a.prediction, a.mistakeTags, a.createdAt,
             (SELECT MIN(b.createdAt) FROM attempts b WHERE b.problemId = a.problemId) AS firstAt,
             (SELECT MIN(m.createdAt) FROM mocks m
               WHERE m.kind = 'coding' AND json_valid(m.state)
                 AND json_extract(m.state, '$.coding.problemId') = a.problemId) AS mockAt
      FROM attempts a LEFT JOIN problems p ON p.id = a.problemId
      WHERE a.createdAt >= ?
      ORDER BY a.createdAt ASC
    `),
    mocksSince: db.prepare(`
      SELECT m.id, m.kind, m.status, m.createdAt, m.prompt, g.verdict AS verdict, g.grade AS grade, g.createdAt AS gradedAt
      FROM mocks m LEFT JOIN mock_grades g ON g.mockId = m.id
      WHERE m.createdAt >= ?
      ORDER BY m.createdAt ASC
    `),
    gradeHistory: db.prepare(`
      SELECT m.kind AS kind, g.verdict AS verdict, g.createdAt AS createdAt FROM mock_grades g JOIN mocks m ON m.id = g.mockId
      ORDER BY g.createdAt DESC LIMIT ?
    `),
    cardsDueBefore: db.prepare(`
      SELECT COUNT(*) AS n FROM mock_gaps WHERE retiredAt IS NULL AND dueAt <= @now AND createdAt < @dayStart
    `),
    cardsReviewedSince: db.prepare(`
      SELECT concept, title, lastGrade FROM mock_gaps WHERE lastReviewedAt >= ? ORDER BY lastReviewedAt ASC
    `),
    reviewsDue: db.prepare(`
      SELECT COUNT(*) AS n
      FROM review_queue r JOIN problems p ON p.id = r.problemId
      WHERE p.language = @language AND r.clearedAt IS NULL AND r.dueAt <= @now
        AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.problemId = r.problemId AND a.createdAt >= @dayStart)
    `),
    activitySince: db.prepare(`
      SELECT createdAt AS at FROM attempts WHERE createdAt >= @since
      UNION ALL SELECT createdAt FROM mocks WHERE createdAt >= @since
      UNION ALL SELECT lastReviewedAt FROM mock_gaps WHERE lastReviewedAt >= @since
      UNION ALL SELECT createdAt FROM recognize_attempts WHERE createdAt >= @since
      UNION ALL SELECT createdAt FROM envelope_attempts WHERE createdAt >= @since
    `),
  };
}
const S = () => (stmts ??= prepare());

interface RawDay {
  date: string;
  mockKind: string | null;
  skips: string;
  endedEarlyAt: string | null;
  debrief: string | null;
  debriefUsage: string | null;
  debriefAt: string | null;
  debriefRegens?: number | null;
  stepNotes?: string | null;
  aiFailures?: string | null;
  quick?: number | null;
  finalReviewAt?: string | null;
  recognizeStocked?: number | null;
}

function safeJson<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function parseDay(r: RawDay | undefined): DailySessionRow | null {
  if (!r) return null;
  const skips = safeJson<unknown[]>(r.skips);
  return {
    date: r.date,
    mockKind: r.mockKind,
    skips: Array.isArray(skips) ? skips.filter(isTodayStep) : [],
    endedEarlyAt: r.endedEarlyAt,
    debrief: safeJson<Debrief>(r.debrief),
    debriefUsage: safeJson<DebriefUsage>(r.debriefUsage),
    debriefAt: r.debriefAt,
    debriefRegens: r.debriefRegens ?? 0,
    stepNotes: parseNotes(safeJson<Record<string, unknown>>(r.stepNotes ?? null)),
    aiFailures: safeJson<AiFailures>(r.aiFailures ?? null) ?? {},
    quick: r.quick === 1,
    finalReviewAt: r.finalReviewAt ?? null,
    recognizeStocked: r.recognizeStocked ?? 0,
  };
}

function parseNotes(raw: Record<string, unknown> | null): StepNotes {
  const out: StepNotes = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const id of STEP_NOTE_IDS) {
    const n = raw[id] as StepNote | undefined;
    if (n && typeof n.note === 'string' && typeof n.carry === 'string') out[id] = n;
  }
  return out;
}

export function setStepNotes(date: string, notes: StepNotes, now: Date): void {
  S().setStepNotes.run({ date, notes: JSON.stringify(notes), now: now.toISOString() });
}

export function bumpDebriefRegens(date: string, now: Date): void {
  S().bumpDebriefRegens.run({ date, now: now.toISOString() });
}

export function setAiFailures(date: string, failures: AiFailures, now: Date): void {
  S().setAiFailures.run({ date, failures: JSON.stringify(failures), now: now.toISOString() });
}

export interface TodayRecognizeRow {
  problemId: string;
  title: string;
  topic: string;
  picked: string | null;
  patternCorrect: boolean;
  approach: string;
  grade: string;
  aiVerdict: string | null;
}

export function recognizeSince(iso: string): TodayRecognizeRow[] {
  return (S().recognizeSince.all(iso) as Array<Omit<TodayRecognizeRow, 'patternCorrect'> & { patternCorrect: number }>).map(
    (r) => ({ ...r, patternCorrect: r.patternCorrect === 1 })
  );
}

export function cardsDetailSince(
  iso: string
): { concept: string; title: string; summary: string; answer: string; lastGrade: string | null; kind: string }[] {
  return S().cardsDetailSince.all(iso) as {
    kind: string;
    concept: string;
    title: string;
    summary: string;
    answer: string;
    lastGrade: string | null;
  }[];
}

export function getDay(date: string): DailySessionRow | null {
  return parseDay(S().getDay.get(date) as RawDay | undefined);
}

/** The day's row, created (with its mock kind frozen) on first touch. */
export function ensureDay(date: string, mockKind: string, now: Date): DailySessionRow {
  S().ensureDay.run({ date, mockKind, now: now.toISOString() });
  return getDay(date)!;
}

export function lastDayBefore(date: string): DailySessionRow | null {
  return parseDay(S().lastDayBefore.get(date) as RawDay | undefined);
}

export function lastDebriefBefore(date: string): DailySessionRow | null {
  return parseDay(S().lastDebriefBefore.get(date) as RawDay | undefined);
}

export function setSkips(date: string, skips: TodayStepId[], now: Date): void {
  S().setSkips.run({ date, skips: JSON.stringify(skips), now: now.toISOString() });
}

export function setEndedEarly(date: string, at: string | null, now: Date): void {
  S().setEnded.run({ date, at, now: now.toISOString() });
}

export function putDebrief(date: string, debrief: Debrief, usage: DebriefUsage, now: Date): void {
  S().setDebrief.run({ date, debrief: JSON.stringify(debrief), usage: JSON.stringify(usage), now: now.toISOString() });
}

export interface TodayAttemptFull extends TodayAttemptRow {
  pattern: string;
  difficulty: string;
  testsPassed: number;
  testsTotal: number;
  prediction: { predTime?: string; predSpace?: string; confidence?: number; approach?: string } | null;
  mistakeTags: string[];
}

/** The `firstAt` of a problem first met in a coding mock: earlier than every day. */
export const MOCK_FIRST_MET = '1970-01-01T00:00:00.000Z';

export function attemptsSince(iso: string): TodayAttemptFull[] {
  const rows = S().attemptsSince.all(iso) as Array<{
    problemId: string;
    title: string;
    pattern: string;
    difficulty: string;
    solved: number;
    hintsUsed: number;
    testsPassed: number;
    testsTotal: number;
    prediction: string | null;
    mistakeTags: string | null;
    createdAt: string;
    firstAt: string;
    mockAt: string | null;
  }>;
  return rows.map((r) => {
    const tags = safeJson<unknown[]>(r.mistakeTags);
    return {
      problemId: r.problemId,
      title: r.title,
      pattern: r.pattern,
      difficulty: r.difficulty,
      solved: r.solved === 1,
      hintsUsed: r.hintsUsed,
      testsPassed: r.testsPassed,
      testsTotal: r.testsTotal,
      prediction: safeJson(r.prediction),
      mistakeTags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [],
      createdAt: r.createdAt,
      // A problem first met in a CODING MOCK is a review when it is re-solved
      // in the grind, even the same day (Phase H: the re-solve was counted as
      // Problem 1). Its "first attempt" is pinned before any day so every
      // `firstAt < dayStart` review test downstream sees it as one.
      firstAt: r.mockAt && r.mockAt < r.firstAt ? MOCK_FIRST_MET : r.firstAt,
    };
  });
}

export interface TodayMockFull extends TodayMockRow {
  prompt: string;
  /** When the grade row was written; null until graded. */
  gradedAt: string | null;
  grade: { summary?: string; drills?: { concept: string; prompt: string }[]; gaps?: { concept: string; title: string }[] } | null;
}

export function mocksSince(iso: string): TodayMockFull[] {
  const rows = S().mocksSince.all(iso) as Array<{
    id: string;
    kind: string;
    status: string;
    createdAt: string;
    prompt: string;
    verdict: MockVerdict | null;
    grade: string | null;
    gradedAt: string | null;
  }>;
  return rows.map((r) => ({ ...r, grade: safeJson(r.grade) }));
}

export function gradeHistory(limit = 30): { kind: string; verdict: MockVerdict; createdAt: string }[] {
  return S().gradeHistory.all(limit) as { kind: string; verdict: MockVerdict; createdAt: string }[];
}

export function setQuick(date: string, quick: boolean, now: Date): void {
  S().setQuick.run({ date, quick: quick ? 1 : 0, now: now.toISOString() });
}

export function bumpRecognizeStocked(date: string, now: Date): void {
  S().bumpRecognizeStocked.run({ date, now: now.toISOString() });
}

/**
 * The final review, once per day: claim it on the day's row, and only if this
 * call won the claim pull every open review problem and drill card due at
 * `dayStart`. Returns how many items moved (null = already done today).
 */
export const runFinalReview = (date: string, dayStart: string, now: Date): { reviews: number; cards: number } | null =>
  db.transaction(() => {
    if (S().claimFinalReview.run({ date, now: now.toISOString() }).changes === 0) return null;
    return {
      reviews: S().pullReviews.run({ dayStart }).changes,
      cards: S().pullCards.run({ dayStart }).changes,
    };
  })();

export interface ReadinessAttemptRow {
  problemId: string;
  difficulty: string;
  solved: boolean;
  hintsUsed: number;
  createdAt: string;
  confidence: number | null;
  predTime: string | null;
  refTime: string | null;
}

export function readinessAttempts(language: Language, since: string): ReadinessAttemptRow[] {
  const rows = S().readinessAttempts.all({ language, since }) as Array<{
    problemId: string;
    difficulty: string;
    solved: number;
    hintsUsed: number;
    createdAt: string;
    prediction: string | null;
    refTime: string | null;
  }>;
  return rows.map((r) => {
    const p = safeJson<{ predTime?: unknown; confidence?: unknown }>(r.prediction);
    return {
      problemId: r.problemId,
      difficulty: r.difficulty,
      solved: r.solved === 1,
      hintsUsed: r.hintsUsed,
      createdAt: r.createdAt,
      confidence: typeof p?.confidence === 'number' ? p.confidence : null,
      predTime: typeof p?.predTime === 'string' ? p.predTime : null,
      refTime: r.refTime,
    };
  });
}

export function cardReviews(since: string): { kind: string; grade: string; intervalDays: number }[] {
  return S().cardReviews.all({ since }) as { kind: string; grade: string; intervalDays: number }[];
}

export function cardsDueBefore(dayStart: string, now: Date): number {
  return (S().cardsDueBefore.get({ dayStart, now: now.toISOString() }) as { n: number }).n;
}

export function cardsReviewedSince(iso: string): { concept: string; title: string; lastGrade: string | null }[] {
  return S().cardsReviewedSince.all(iso) as { concept: string; title: string; lastGrade: string | null }[];
}

export function reviewsDue(language: Language, dayStart: string, now: Date): number {
  return (S().reviewsDue.get({ language, dayStart, now: now.toISOString() }) as { n: number }).n;
}

export function activitySince(iso: string): string[] {
  return (S().activitySince.all({ since: iso }) as { at: string }[]).map((r) => r.at);
}
