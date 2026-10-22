// =============================================================================
// patterns.store — pattern-shape recall cards, card views, and the Pattern
// Refresh's stored state (refresh_days + the progress setting)
// =============================================================================
// Same connection as db.ts; statements prepared lazily. Tables are created by
// db.migrate.ts's always-run block.

import { db, getSetting, setSetting } from './db.js';
import type { Language } from '../../shared/languages.js';
import type { GapCardGrade, GapCardSchedule } from '../../shared/gap-cards.js';
import { coerceProgress, type RefreshAttempt, type RefreshProgress } from './refresh.compute.js';

let stmts: ReturnType<typeof prepare> | null = null;
function prepare() {
  return {
    cards: db.prepare(`SELECT * FROM pattern_recall_cards`),
    getCard: db.prepare(`SELECT * FROM pattern_recall_cards WHERE id = ?`),
    upsertCard: db.prepare(`
      INSERT INTO pattern_recall_cards (id, step, dueAt, reps, lapses, lastGrade, lastReviewedAt, retiredAt, createdAt)
      VALUES (@id, @step, @dueAt, @reps, @lapses, @lastGrade, @lastReviewedAt, @retiredAt, @now)
      ON CONFLICT(id) DO UPDATE SET step = excluded.step, dueAt = excluded.dueAt, reps = excluded.reps, lapses = excluded.lapses,
        lastGrade = excluded.lastGrade, lastReviewedAt = excluded.lastReviewedAt, retiredAt = excluded.retiredAt
    `),
    insertReview: db.prepare(
      `INSERT INTO pattern_recall_reviews (pattern, grade, answer, createdAt) VALUES (@pattern, @grade, @answer, @now)`
    ),
    lastReviewSince: db.prepare(
      `SELECT grade, createdAt FROM pattern_recall_reviews WHERE pattern = ? AND createdAt >= ? AND createdAt < ? ORDER BY createdAt DESC LIMIT 1`
    ),
    reviewsSince: db.prepare(`SELECT COUNT(*) AS n FROM pattern_recall_reviews WHERE createdAt >= ?`),
    dueBefore: db.prepare(
      `SELECT COUNT(*) AS n FROM pattern_recall_cards WHERE retiredAt IS NULL AND dueAt <= @now AND createdAt < @dayStart`
    ),
    insertView: db.prepare(`INSERT INTO pattern_views (pattern, createdAt) VALUES (?, ?)`),
    viewedSince: db.prepare(`SELECT 1 FROM pattern_views WHERE pattern = ? AND createdAt >= ? AND createdAt < ? LIMIT 1`),
    getRefreshDay: db.prepare(`SELECT * FROM refresh_days WHERE date = ?`),
    insertRefreshDay: db.prepare(
      `INSERT OR IGNORE INTO refresh_days (date, day, coldProblemId, createdAt) VALUES (@date, @day, @cold, @now)`
    ),
    setCold: db.prepare(`UPDATE refresh_days SET coldProblemId = @cold WHERE day = @day AND coldProblemId IS NULL`),
    datesOfDay: db.prepare(`SELECT date, coldProblemId FROM refresh_days WHERE day = ? ORDER BY date ASC`),
    attemptsSince: db.prepare(`
      SELECT a.problemId, COALESCE(p.title, '(deleted problem)') AS title, p.topic AS topic, a.difficulty,
             a.solved, a.hintsUsed, a.createdAt
      FROM attempts a LEFT JOIN problems p ON p.id = a.problemId
      WHERE a.createdAt >= ? AND a.createdAt < ? ORDER BY a.createdAt ASC
    `),
    // The cold review: an OLDER problem of the topic, the longest since its
    // last attempt, not touched since `since` (so not yesterday's practice).
    // Easy first. Free — no generation.
    coldCandidate: db.prepare(`
      SELECT p.id FROM problems p JOIN attempts a ON a.problemId = p.id
      WHERE p.language = @language AND p.topic = @topic AND p.difficulty IN ('easy', 'medium')
      GROUP BY p.id
      HAVING MAX(a.createdAt) < @since
      ORDER BY CASE p.difficulty WHEN 'easy' THEN 0 ELSE 1 END, MAX(a.createdAt) ASC
      LIMIT 1
    `),
  };
}
const S = () => (stmts ??= prepare());

/** "No upper bound" for the [since, until) reads. */
const FAR = '9999-12-31T00:00:00.000Z';

// -----------------------------------------------------------------------------
// Recall cards
// -----------------------------------------------------------------------------
export interface RecallCardRow extends GapCardSchedule {
  id: string;
  createdAt: string;
}

function rowToCard(r: Record<string, unknown>): RecallCardRow {
  return {
    id: String(r.id),
    step: Number(r.step),
    dueAt: String(r.dueAt),
    reps: Number(r.reps),
    lapses: Number(r.lapses),
    lastGrade: (r.lastGrade as GapCardGrade | null) ?? null,
    lastReviewedAt: (r.lastReviewedAt as string | null) ?? null,
    retiredAt: (r.retiredAt as string | null) ?? null,
    createdAt: String(r.createdAt),
  };
}

export function recallCards(): RecallCardRow[] {
  return (S().cards.all() as Record<string, unknown>[]).map(rowToCard);
}

export function getRecallCard(id: string): RecallCardRow | null {
  const r = S().getCard.get(id) as Record<string, unknown> | undefined;
  return r ? rowToCard(r) : null;
}

export function putRecallCard(id: string, s: GapCardSchedule, grade: GapCardGrade, answer: string, now: Date): void {
  db.transaction(() => {
    S().upsertCard.run({ id, ...s, now: now.toISOString() });
    S().insertReview.run({ pattern: id, grade, answer: answer.slice(0, 8000), now: now.toISOString() });
  })();
}

/** The latest self-grade of a pattern since an instant, or null. */
export function recallGradeSince(pattern: string, since: string, until = FAR): { grade: string } | null {
  const r = S().lastReviewSince.get(pattern, since, until) as { grade: string } | undefined;
  return r ? { grade: r.grade } : null;
}

export function recallReviewsSince(since: string): number {
  return (S().reviewsSince.get(since) as { n: number }).n;
}

/** Recall cards due now that existed before today (today's new card does not reopen the warm-up). */
export function recallDueBefore(dayStart: string, now: Date): number {
  return (S().dueBefore.get({ dayStart, now: now.toISOString() }) as { n: number }).n;
}

// -----------------------------------------------------------------------------
// Views
// -----------------------------------------------------------------------------
export function recordView(pattern: string, now: Date): void {
  S().insertView.run(pattern, now.toISOString());
}

export function viewedSince(pattern: string, since: string, until = FAR): boolean {
  return !!S().viewedSince.get(pattern, since, until);
}

// -----------------------------------------------------------------------------
// The refresh
// -----------------------------------------------------------------------------
const PROGRESS_KEY = 'today.refresh';

export function getProgress(): RefreshProgress {
  return coerceProgress(getSetting(PROGRESS_KEY));
}

export function setProgress(p: RefreshProgress): void {
  setSetting(PROGRESS_KEY, p);
}

export function getRefreshDay(date: string): { date: string; day: number; coldProblemId: string | null } | null {
  const r = S().getRefreshDay.get(date) as { date: string; day: number; coldProblemId: string | null } | undefined;
  return r ?? null;
}

export function insertRefreshDay(date: string, day: number, now: Date): void {
  S().insertRefreshDay.run({ date, day, cold: null, now: now.toISOString() });
}

/** Every local date that was this refresh day, oldest first. */
export function datesOfDay(day: number): { date: string; coldProblemId: string | null }[] {
  return S().datesOfDay.all(day) as { date: string; coldProblemId: string | null }[];
}

/** Freeze the cold-review problem for a refresh day (first writer wins). */
export function setColdProblem(day: number, problemId: string): void {
  S().setCold.run({ day, cold: problemId });
}

export function coldCandidate(language: Language, topic: string, since: string): string | null {
  const r = S().coldCandidate.get({ language, topic, since }) as { id: string } | undefined;
  return r?.id ?? null;
}

export function refreshAttemptsSince(since: string, until = FAR): RefreshAttempt[] {
  return (S().attemptsSince.all(since, until) as Array<Omit<RefreshAttempt, 'solved'> & { solved: number }>).map((r) => ({
    ...r,
    solved: r.solved === 1,
  }));
}
