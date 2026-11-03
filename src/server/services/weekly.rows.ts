// =============================================================================
// weekly.rows — the SELECTs behind weekly.compute, on a handle the caller owns
// =============================================================================
// The handle is PASSED IN, never imported: bin/progress-report opens the
// database { readonly: true } on its own connection (importing db.ts would run
// the migration), and routes/home.ts passes the app's connection. Read-only.

import type Database from 'better-sqlite3';
import type {
  WeeklyAttempt,
  WeeklyEnvelopeRow,
  WeeklyMockRow,
  WeeklyRecognizeRow,
  WeeklySession,
  ReviewRow,
} from './weekly.compute.js';
import { SITTING_SPAN_MS } from './weekly.compute.js';

export interface WeeklyRows {
  attempts: WeeklyAttempt[];
  sessions: WeeklySession[];
  recognize: WeeklyRecognizeRow[];
  envelope: WeeklyEnvelopeRow[];
  /** Every mock (a small table): the window count and the latest finish. */
  mocks: WeeklyMockRow[];
}

/**
 * Rows from `sinceIso` on. Attempts and sessions start one sitting earlier
 * (since − 8h) so classifyGrind sees every sitting that can reach into the
 * window: a sitting that started before that cannot own an in-window attempt.
 * Pass an empty string for everything.
 */
export function loadWeeklyRows(db: Database.Database, sinceIso: string): WeeklyRows {
  const q = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];
  const early = sinceIso ? new Date(Date.parse(sinceIso) - SITTING_SPAN_MS).toISOString() : '';
  return {
    attempts: q<WeeklyAttempt>(
      `SELECT id, problemId, pattern, difficulty, solved, hintsUsed, testsPassed, testsTotal, createdAt, language FROM attempts WHERE createdAt >= ? ORDER BY createdAt`,
      early,
    ),
    sessions: q<WeeklySession>(`SELECT createdAt, served FROM sessions WHERE createdAt >= ? ORDER BY createdAt`, early),
    recognize: q<WeeklyRecognizeRow>(
      `SELECT r.topic, r.patternCorrect, r.grade, r.createdAt, p.language AS language
         FROM recognize_attempts r LEFT JOIN problems p ON p.id = r.problemId
        WHERE r.createdAt >= ? ORDER BY r.createdAt, r.id`,
      sinceIso,
    ),
    envelope: q<WeeklyEnvelopeRow>(`SELECT ok, mode, createdAt FROM envelope_attempts WHERE createdAt >= ? ORDER BY createdAt, id`, sinceIso),
    mocks: q<WeeklyMockRow>(`SELECT status, createdAt, endedAt FROM mocks ORDER BY createdAt`),
  };
}

/** Open review-queue rows with their problem's topic and language. */
export function loadReviewRows(db: Database.Database): (ReviewRow & { reason: string; rung: number })[] {
  return db
    .prepare(
      `SELECT p.topic, r.reason, r.rung, r.dueAt, p.language FROM review_queue r JOIN problems p ON p.id = r.problemId WHERE r.clearedAt IS NULL`,
    )
    .all() as (ReviewRow & { reason: string; rung: number })[];
}
