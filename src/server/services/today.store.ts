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
import { isTodayStep, type Debrief, type DebriefUsage, type TodayStepId } from '../../shared/today.js';
import type { TodayAttemptRow, TodayMockRow } from './today.compute.js';

export interface DailySessionRow {
  date: string;
  mockKind: string | null;
  skips: TodayStepId[];
  endedEarlyAt: string | null;
  debrief: Debrief | null;
  debriefUsage: DebriefUsage | null;
  debriefAt: string | null;
}

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
      ON CONFLICT(date) DO NOTHING
    `),
    setSkips: db.prepare(`UPDATE daily_sessions SET skips = @skips, updatedAt = @now WHERE date = @date`),
    setEnded: db.prepare(`UPDATE daily_sessions SET endedEarlyAt = @at, updatedAt = @now WHERE date = @date`),
    setDebrief: db.prepare(`
      UPDATE daily_sessions SET debrief = @debrief, debriefUsage = @usage, debriefAt = @now, updatedAt = @now
      WHERE date = @date
    `),
    attemptsSince: db.prepare(`
      SELECT a.problemId, COALESCE(p.title, '(deleted problem)') AS title, a.pattern, a.difficulty,
             a.solved, a.hintsUsed, a.testsPassed, a.testsTotal, a.prediction, a.mistakeTags, a.createdAt,
             (SELECT MIN(b.createdAt) FROM attempts b WHERE b.problemId = a.problemId) AS firstAt
      FROM attempts a LEFT JOIN problems p ON p.id = a.problemId
      WHERE a.createdAt >= ?
      ORDER BY a.createdAt ASC
    `),
    mocksSince: db.prepare(`
      SELECT m.id, m.kind, m.status, m.createdAt, m.prompt, g.verdict AS verdict, g.grade AS grade
      FROM mocks m LEFT JOIN mock_grades g ON g.mockId = m.id
      WHERE m.createdAt >= ?
      ORDER BY m.createdAt ASC
    `),
    gradeHistory: db.prepare(`
      SELECT m.kind AS kind, g.verdict AS verdict FROM mock_grades g JOIN mocks m ON m.id = g.mockId
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
  };
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
      firstAt: r.firstAt,
    };
  });
}

export interface TodayMockFull extends TodayMockRow {
  prompt: string;
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
  }>;
  return rows.map((r) => ({ ...r, grade: safeJson(r.grade) }));
}

export function gradeHistory(limit = 30): { kind: string; verdict: MockVerdict }[] {
  return S().gradeHistory.all(limit) as { kind: string; verdict: MockVerdict }[];
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
