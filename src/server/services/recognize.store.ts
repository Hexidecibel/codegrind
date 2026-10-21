// =============================================================================
// recognize.store — the Recognize drill's rows (recognize_* tables)
// =============================================================================
// Same connection as db.ts; statements prepared lazily. Reads `problems`,
// `attempts` and `revealed_solutions`; WRITES only its own three tables. The
// one write outside them (the reveal ledger) goes through db.ts's
// markSolutionRevealed, from the service, so there is one ledger writer.

import { db } from './db.js';
import type { GapCardGrade, GapCardSchedule } from '../../shared/gap-cards.js';
import type { RecognizeNote, RecognizeVerdict } from '../../shared/recognize.js';
import type { Topic } from '../../shared/types.js';
import type { RecognizeAttemptLite } from './recognize.compute.js';

let stmts: ReturnType<typeof prepare> | null = null;
function prepare() {
  return {
    candidates: db.prepare(`
      SELECT p.id AS problemId, p.title, p.topic, p.pattern, p.language, p.used,
             EXISTS (SELECT 1 FROM attempts a WHERE a.problemId = p.id) AS attempted,
             EXISTS (SELECT 1 FROM revealed_solutions r WHERE r.problemId = p.id) AS revealed,
             (SELECT MAX(x.createdAt) FROM recognize_attempts x WHERE x.problemId = p.id) AS lastRecognizedAt
      FROM problems p
    `),
    dueCards: db.prepare(`
      SELECT problemId, topic, dueAt FROM recognize_cards
      WHERE retiredAt IS NULL AND dueAt <= ? ORDER BY dueAt ASC
    `),
    cardCounts: db.prepare(`
      SELECT
        SUM(CASE WHEN retiredAt IS NULL AND dueAt <= @now THEN 1 ELSE 0 END) AS due,
        SUM(CASE WHEN retiredAt IS NULL AND dueAt >  @now THEN 1 ELSE 0 END) AS upcoming
      FROM recognize_cards
    `),
    getCard: db.prepare(`SELECT * FROM recognize_cards WHERE problemId = ?`),
    upsertCard: db.prepare(`
      INSERT INTO recognize_cards (problemId, topic, step, dueAt, reps, lapses, lastGrade, lastReviewedAt, retiredAt, createdAt)
      VALUES (@problemId, @topic, @step, @dueAt, @reps, @lapses, @lastGrade, @lastReviewedAt, @retiredAt, @now)
      ON CONFLICT(problemId) DO UPDATE SET
        step = @step, dueAt = @dueAt, reps = @reps, lapses = @lapses, lastGrade = @lastGrade,
        lastReviewedAt = @lastReviewedAt, retiredAt = @retiredAt
    `),
    insertAttempt: db.prepare(`
      INSERT INTO recognize_attempts
        (problemId, topic, picked, patternCorrect, approach, selfGrade, grade, codeShown, aiVerdict, durationMs, createdAt)
      VALUES (@problemId, @topic, @picked, @patternCorrect, @approach, @selfGrade, @grade, @codeShown, @aiVerdict, @durationMs, @now)
    `),
    attempts: db.prepare(`
      SELECT topic, patternCorrect, grade, createdAt FROM recognize_attempts ORDER BY createdAt DESC
    `),
    countSince: db.prepare(`SELECT COUNT(*) AS n FROM recognize_attempts WHERE createdAt >= ?`),
    grindSince: db.prepare(`SELECT COUNT(*) AS n FROM attempts WHERE createdAt >= ?`),
    getNote: db.prepare(`SELECT keyInsight, time, space FROM recognize_notes WHERE problemId = ?`),
    putNote: db.prepare(`
      INSERT INTO recognize_notes (problemId, keyInsight, time, space, createdAt)
      VALUES (@problemId, @keyInsight, @time, @space, @now)
      ON CONFLICT(problemId) DO UPDATE SET keyInsight = @keyInsight, time = @time, space = @space
    `),
    getCheck: db.prepare(`SELECT result FROM recognize_checks WHERE key = ?`),
    putCheck: db.prepare(`
      INSERT OR REPLACE INTO recognize_checks (key, problemId, result, createdAt) VALUES (@key, @problemId, @result, @now)
    `),
  };
}
const S = () => (stmts ??= prepare());

export interface CandidateRow {
  problemId: string;
  title: string;
  topic: string;
  pattern: string;
  language: string;
  used: boolean;
  attempted: boolean;
  revealed: boolean;
  lastRecognizedAt: string | null;
}

export function candidates(): CandidateRow[] {
  const rows = S().candidates.all() as Array<Omit<CandidateRow, 'used' | 'attempted' | 'revealed'> & {
    used: number;
    attempted: number;
    revealed: number;
  }>;
  return rows.map((r) => ({ ...r, used: r.used === 1, attempted: r.attempted === 1, revealed: r.revealed === 1 }));
}

export function dueCards(now: Date): { problemId: string; topic: Topic; dueAt: string }[] {
  return S().dueCards.all(now.toISOString()) as { problemId: string; topic: Topic; dueAt: string }[];
}

export function cardCounts(now: Date): { due: number; upcoming: number } {
  const r = S().cardCounts.get({ now: now.toISOString() }) as { due: number | null; upcoming: number | null };
  return { due: r.due ?? 0, upcoming: r.upcoming ?? 0 };
}

export function getCard(problemId: string): GapCardSchedule | null {
  const r = S().getCard.get(problemId) as (GapCardSchedule & { lastGrade: string | null }) | undefined;
  if (!r) return null;
  return {
    step: r.step,
    dueAt: r.dueAt,
    reps: r.reps,
    lapses: r.lapses,
    lastGrade: (r.lastGrade as GapCardGrade | null) ?? null,
    lastReviewedAt: r.lastReviewedAt,
    retiredAt: r.retiredAt,
  };
}

export function putCard(problemId: string, topic: string, card: GapCardSchedule, now: Date): void {
  S().upsertCard.run({ problemId, topic, ...card, now: now.toISOString() });
}

export interface RecognizeAttemptInsert {
  problemId: string;
  topic: string;
  picked: string | null;
  patternCorrect: boolean;
  approach: string;
  selfGrade: GapCardGrade;
  grade: GapCardGrade;
  codeShown: boolean;
  aiVerdict: RecognizeVerdict | null;
  durationMs: number | null;
}

export function insertAttempt(a: RecognizeAttemptInsert, now: Date): void {
  S().insertAttempt.run({
    ...a,
    patternCorrect: a.patternCorrect ? 1 : 0,
    codeShown: a.codeShown ? 1 : 0,
    now: now.toISOString(),
  });
}

export function allAttempts(): RecognizeAttemptLite[] {
  const rows = S().attempts.all() as Array<{ topic: string; patternCorrect: number; grade: GapCardGrade; createdAt: string }>;
  return rows.map((r) => ({ ...r, patternCorrect: r.patternCorrect === 1 }));
}

export function attemptsSinceCount(iso: string): number {
  return (S().countSince.get(iso) as { n: number }).n;
}

/** GRIND attempts (the `attempts` table) since an instant — Today's rust signal. */
export function grindAttemptsSince(iso: string): number {
  return (S().grindSince.get(iso) as { n: number }).n;
}

export function getNote(problemId: string): RecognizeNote | null {
  return (S().getNote.get(problemId) as RecognizeNote | undefined) ?? null;
}

export function putNote(problemId: string, note: RecognizeNote, now: Date): void {
  S().putNote.run({ problemId, ...note, now: now.toISOString() });
}

/** A cached AI check for this exact (problem, pick, answer) key, or null. */
export function getCheck<T>(key: string): T | null {
  const row = S().getCheck.get(key) as { result: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.result) as T;
  } catch {
    return null;
  }
}

export function putCheck(key: string, problemId: string, result: unknown, now: Date): void {
  S().putCheck.run({ key, problemId, result: JSON.stringify(result), now: now.toISOString() });
}
