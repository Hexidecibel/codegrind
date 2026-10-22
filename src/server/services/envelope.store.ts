// =============================================================================
// envelope.store — the Envelope drill's rows (envelope_* tables)
// =============================================================================
// Same connection as db.ts; statements prepared lazily. Writes only its own two
// tables.

import { db } from './db.js';
import type { GapCardGrade, GapCardSchedule } from '../../shared/gap-cards.js';
import type { EnvelopeItem, EnvelopeNote } from '../../shared/envelope.js';

let stmts: ReturnType<typeof prepare> | null = null;
function prepare() {
  return {
    getCard: db.prepare(`SELECT * FROM envelope_cards WHERE key = ?`),
    dueCards: db.prepare(`
      SELECT * FROM envelope_cards WHERE retiredAt IS NULL AND dueAt <= ? ORDER BY dueAt ASC, createdAt ASC
    `),
    counts: db.prepare(`
      SELECT
        SUM(CASE WHEN retiredAt IS NULL AND dueAt <= @now THEN 1 ELSE 0 END) AS due,
        SUM(CASE WHEN retiredAt IS NULL THEN 1 ELSE 0 END) AS live
      FROM envelope_cards
    `),
    insertCard: db.prepare(`
      INSERT OR IGNORE INTO envelope_cards (key, item, source, mockId, step, dueAt, reps, lapses, lastGrade, lastReviewedAt, retiredAt, createdAt)
      VALUES (@key, @item, @source, @mockId, @step, @dueAt, @reps, @lapses, @lastGrade, @lastReviewedAt, @retiredAt, @now)
    `),
    updateSchedule: db.prepare(`
      UPDATE envelope_cards SET step = @step, dueAt = @dueAt, reps = @reps, lapses = @lapses, lastGrade = @lastGrade,
        lastReviewedAt = @lastReviewedAt, retiredAt = @retiredAt
      WHERE key = @key
    `),
    insertAttempt: db.prepare(`
      INSERT INTO envelope_attempts (itemKey, cardKey, kind, question, answer, working, expected, given, ok, orders, cause, mode, failedStep, createdAt)
      VALUES (@itemKey, @cardKey, @kind, @question, @answer, @working, @expected, @given, @ok, @orders, @cause, @mode, @failedStep, @now)
    `),
    insertStep: db.prepare(`
      INSERT INTO envelope_steps (itemKey, stepType, stepIndex, prompt, answer, ok, slip, feedback, counted, createdAt)
      VALUES (@itemKey, @stepType, @stepIndex, @prompt, @answer, @ok, @slip, @feedback, @counted, @now)
    `),
    recentSteps: db.prepare(`SELECT stepType AS type, ok FROM envelope_steps ORDER BY createdAt DESC, id DESC LIMIT 400`),
    countedSteps: db.prepare(`SELECT stepType AS type, ok, slip FROM envelope_steps WHERE counted = 1 ORDER BY createdAt DESC, id DESC`),
    itemStepsSince: db.prepare(`
      SELECT * FROM envelope_steps WHERE itemKey = ? AND createdAt > ? AND counted = 1 ORDER BY createdAt ASC, id ASC
    `),
    kindRows: db.prepare(`SELECT kind, ok FROM envelope_attempts ORDER BY createdAt DESC LIMIT 400`),
    attemptDays: db.prepare(`SELECT createdAt FROM envelope_attempts WHERE createdAt < ? ORDER BY createdAt ASC`),
    anchorRows: db.prepare(`SELECT * FROM envelope_anchor_cards`),
    getAnchor: db.prepare(`SELECT * FROM envelope_anchor_cards WHERE id = ?`),
    upsertAnchor: db.prepare(`
      INSERT INTO envelope_anchor_cards (id, step, dueAt, reps, lapses, lastGrade, lastReviewedAt, retiredAt, createdAt)
      VALUES (@id, @step, @dueAt, @reps, @lapses, @lastGrade, @lastReviewedAt, @retiredAt, @now)
      ON CONFLICT(id) DO UPDATE SET step = excluded.step, dueAt = excluded.dueAt, reps = excluded.reps, lapses = excluded.lapses,
        lastGrade = excluded.lastGrade, lastReviewedAt = excluded.lastReviewedAt, retiredAt = excluded.retiredAt
    `),
    insertSpeed: db.prepare(`
      INSERT INTO envelope_speed_rounds (score, correct, attempted, bestStreak, createdAt) VALUES (@score, @right, @attempted, @bestStreak, @now)
    `),
    speedHistory: db.prepare(`SELECT score, attempted, createdAt FROM envelope_speed_rounds ORDER BY createdAt DESC LIMIT 20`),
    speedBest: db.prepare(`SELECT MAX(score) AS best FROM envelope_speed_rounds`),
    getAttempt: db.prepare(`SELECT * FROM envelope_attempts WHERE id = ?`),
    putNote: db.prepare(`UPDATE envelope_attempts SET aiNote = ? WHERE id = ?`),
    attempts: db.prepare(`SELECT ok, orders, cause, createdAt FROM envelope_attempts ORDER BY createdAt DESC`),
    since: db.prepare(`SELECT * FROM envelope_attempts WHERE createdAt >= ? ORDER BY createdAt ASC`),
  };
}
const S = () => (stmts ??= prepare());

export interface EnvelopeCardRow extends GapCardSchedule {
  key: string;
  item: EnvelopeItem;
  source: 'seed' | 'miss' | 'mock';
  mockId: string | null;
  createdAt: string;
}

function rowToCard(r: Record<string, unknown> | undefined): EnvelopeCardRow | null {
  if (!r) return null;
  let item: EnvelopeItem;
  try {
    item = JSON.parse(String(r.item)) as EnvelopeItem;
  } catch {
    return null;
  }
  return {
    key: String(r.key),
    item,
    source: r.source as EnvelopeCardRow['source'],
    mockId: (r.mockId as string | null) ?? null,
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

export function getCard(key: string): EnvelopeCardRow | null {
  return rowToCard(S().getCard.get(key) as Record<string, unknown> | undefined);
}

export function dueCards(now: Date): EnvelopeCardRow[] {
  return (S().dueCards.all(now.toISOString()) as Record<string, unknown>[]).map(rowToCard).filter((c): c is EnvelopeCardRow => !!c);
}

export function cardCounts(now: Date): { due: number; live: number } {
  const r = S().counts.get({ now: now.toISOString() }) as { due: number | null; live: number | null };
  return { due: r.due ?? 0, live: r.live ?? 0 };
}

/** Insert a card if its key is new. Returns true when a row was written. */
export function insertCard(
  c: { key: string; item: EnvelopeItem; source: EnvelopeCardRow['source']; mockId?: string | null },
  schedule: GapCardSchedule,
  now: Date
): boolean {
  const r = S().insertCard.run({
    key: c.key,
    item: JSON.stringify(c.item),
    source: c.source,
    mockId: c.mockId ?? null,
    ...schedule,
    now: now.toISOString(),
  });
  return r.changes > 0;
}

export function updateSchedule(key: string, s: GapCardSchedule): void {
  S().updateSchedule.run({ key, ...s });
}

export interface EnvelopeAttemptInsert {
  itemKey: string;
  cardKey: string | null;
  kind: string;
  question: string;
  answer: string;
  working: string;
  expected: number;
  given: number;
  ok: boolean;
  orders: number;
  cause: string | null;
  /** Phase I: plain | guided, and the guided step that broke. */
  mode?: 'plain' | 'guided';
  failedStep?: string | null;
}

export function insertAttempt(a: EnvelopeAttemptInsert, now: Date): number {
  const r = S().insertAttempt.run({ ...a, mode: a.mode ?? 'plain', failedStep: a.failedStep ?? null, ok: a.ok ? 1 : 0, now: now.toISOString() });
  return Number(r.lastInsertRowid);
}

export interface EnvelopeAttemptRow extends Omit<EnvelopeAttemptInsert, 'ok'> {
  id: number;
  ok: boolean;
  aiNote: EnvelopeNote | null;
  createdAt: string;
}

function rowToAttempt(r: Record<string, unknown>): EnvelopeAttemptRow {
  let aiNote: EnvelopeNote | null = null;
  if (typeof r.aiNote === 'string') {
    try {
      aiNote = JSON.parse(r.aiNote) as EnvelopeNote;
    } catch {
      aiNote = null;
    }
  }
  return { ...(r as unknown as EnvelopeAttemptRow), ok: r.ok === 1, aiNote };
}

export function getAttempt(id: number): EnvelopeAttemptRow | null {
  const r = S().getAttempt.get(id) as Record<string, unknown> | undefined;
  return r ? rowToAttempt(r) : null;
}

export function putNote(id: number, note: EnvelopeNote): void {
  S().putNote.run(JSON.stringify(note), id);
}

export function allAttempts(): { ok: boolean; orders: number; cause: string | null; createdAt: string }[] {
  return (S().attempts.all() as { ok: number; orders: number; cause: string | null; createdAt: string }[]).map((r) => ({
    ...r,
    ok: r.ok === 1,
  }));
}

export function attemptsSince(iso: string): EnvelopeAttemptRow[] {
  return (S().since.all(iso) as Record<string, unknown>[]).map(rowToAttempt);
}

/** When this item was last answered, or null (the double-answer guard). */
export function lastAttemptAt(itemKey: string): string | null {
  const row = db.prepare(`SELECT MAX(createdAt) AS at FROM envelope_attempts WHERE itemKey = ?`).get(itemKey) as
    | { at: string | null }
    | undefined;
  return row?.at ?? null;
}

// -----------------------------------------------------------------------------
// Phase I: guided steps, anchors, speed rounds
// -----------------------------------------------------------------------------
export interface EnvelopeStepInsert {
  itemKey: string;
  stepType: string;
  stepIndex: number;
  prompt: string;
  answer: string;
  ok: boolean;
  slip: string | null;
  feedback: string;
  /** false = a streak reset only (a final miss un-faded this step type). */
  counted: boolean;
}

export function insertStep(s: EnvelopeStepInsert, now: Date): void {
  S().insertStep.run({ ...s, ok: s.ok ? 1 : 0, counted: s.counted ? 1 : 0, now: now.toISOString() });
}

/** Step results, newest first (streaks; resets included). */
export function recentSteps(): { type: string; ok: boolean }[] {
  return (S().recentSteps.all() as { type: string; ok: number }[]).map((r) => ({ type: r.type, ok: r.ok === 1 }));
}

/** Counted step results, newest first (error rates). */
export function countedSteps(): { type: string; ok: boolean; slip: string | null }[] {
  return (S().countedSteps.all() as { type: string; ok: number; slip: string | null }[]).map((r) => ({ ...r, ok: r.ok === 1 }));
}

export interface EnvelopeStepRow extends Omit<EnvelopeStepInsert, 'ok' | 'counted'> {
  id: number;
  ok: boolean;
  createdAt: string;
}

export function itemStepsSince(itemKey: string, iso: string): EnvelopeStepRow[] {
  return (S().itemStepsSince.all(itemKey, iso) as Record<string, unknown>[]).map((r) => ({ ...(r as unknown as EnvelopeStepRow), ok: r.ok === 1 }));
}

/** Recent attempts' kind + ok, newest first (endless practice weights). */
export function kindRows(): { kind: string; ok: boolean }[] {
  return (S().kindRows.all() as { kind: string; ok: number }[]).map((r) => ({ kind: r.kind, ok: r.ok === 1 }));
}

/** createdAt of every attempt before `iso` (distinct practice days). */
export function attemptTimesBefore(iso: string): string[] {
  return (S().attemptDays.all(iso) as { createdAt: string }[]).map((r) => r.createdAt);
}

export interface AnchorCardRow extends GapCardSchedule {
  id: string;
  createdAt: string;
}

function rowToAnchor(r: Record<string, unknown>): AnchorCardRow {
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

export function anchorRows(): AnchorCardRow[] {
  return (S().anchorRows.all() as Record<string, unknown>[]).map(rowToAnchor);
}

export function getAnchor(id: string): AnchorCardRow | null {
  const r = S().getAnchor.get(id) as Record<string, unknown> | undefined;
  return r ? rowToAnchor(r) : null;
}

export function putAnchor(id: string, s: GapCardSchedule, now: Date): void {
  S().upsertAnchor.run({ id, ...s, now: now.toISOString() });
}

export function insertSpeedRound(r: { score: number; right: number; attempted: number; bestStreak: number }, now: Date): void {
  S().insertSpeed.run({ ...r, now: now.toISOString() });
}

export function speedHistory(): { score: number; attempted: number; createdAt: string }[] {
  return S().speedHistory.all() as { score: number; attempted: number; createdAt: string }[];
}

export function speedBest(): number | null {
  return (S().speedBest.get() as { best: number | null }).best ?? null;
}
