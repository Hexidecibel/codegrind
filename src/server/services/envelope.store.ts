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
      INSERT INTO envelope_attempts (itemKey, cardKey, kind, question, answer, working, expected, given, ok, orders, cause, createdAt)
      VALUES (@itemKey, @cardKey, @kind, @question, @answer, @working, @expected, @given, @ok, @orders, @cause, @now)
    `),
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
}

export function insertAttempt(a: EnvelopeAttemptInsert, now: Date): number {
  const r = S().insertAttempt.run({ ...a, ok: a.ok ? 1 : 0, now: now.toISOString() });
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
