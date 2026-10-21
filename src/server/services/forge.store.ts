// =============================================================================
// forge.store — story_forge_sessions (Phase H4)
// =============================================================================
// Same connection as db.ts; statements prepared lazily.

import { db } from './db.js';
import type { ForgeBeat, ForgeSeed, ForgeStatus, ForgeTurn, StoryDraft } from '../../shared/story-forge.js';

/** The seed as stored: the rendering is frozen at start so every turn sees the same material. */
export interface StoredSeed extends ForgeSeed {
  /** For the coach: CONFIRMED and OPEN QUESTIONS kept apart. '' = none. */
  text: string;
  /** Confirmed text only: its numbers count as said. */
  confirmed: string;
}

export interface ForgeRow {
  id: string;
  day: string;
  seed: StoredSeed;
  status: ForgeStatus;
  turns: ForgeTurn[];
  covered: ForgeBeat[];
  draft: StoryDraft | null;
  savedStoryId: string | null;
  cardId: number | null;
  costUsd: number;
  calls: number;
  createdAt: string;
  updatedAt: string;
}

interface Raw {
  id: string;
  day: string;
  seed: string;
  status: string;
  turns: string;
  covered: string;
  draft: string | null;
  savedStoryId: string | null;
  cardId: number | null;
  costUsd: number;
  calls: number;
  createdAt: string;
  updatedAt: string;
}

function parse<T>(s: string | null, dflt: T): T {
  if (!s) return dflt;
  try {
    return JSON.parse(s) as T;
  } catch {
    return dflt;
  }
}

function toRow(r: Raw): ForgeRow {
  return {
    ...r,
    seed: parse<StoredSeed>(r.seed, { competency: 'influence-without-authority', candidate: null, text: '', confirmed: '' }),
    status: r.status as ForgeStatus,
    turns: parse<ForgeTurn[]>(r.turns, []),
    covered: parse<ForgeBeat[]>(r.covered, []),
    draft: parse<StoryDraft | null>(r.draft, null),
  };
}

let stmts: ReturnType<typeof prepare> | null = null;
function prepare() {
  return {
    insert: db.prepare(`
      INSERT INTO story_forge_sessions (id, day, seed, status, turns, covered, draft, savedStoryId, cardId, costUsd, calls, createdAt, updatedAt)
      VALUES (@id, @day, @seed, @status, @turns, @covered, @draft, @savedStoryId, @cardId, @costUsd, @calls, @createdAt, @updatedAt)
    `),
    update: db.prepare(`
      UPDATE story_forge_sessions SET status = @status, turns = @turns, covered = @covered, draft = @draft,
        savedStoryId = @savedStoryId, cardId = @cardId, costUsd = @costUsd, calls = @calls, updatedAt = @updatedAt
      WHERE id = @id
    `),
    get: db.prepare(`SELECT * FROM story_forge_sessions WHERE id = ?`),
    ofDay: db.prepare(`SELECT * FROM story_forge_sessions WHERE day = ? ORDER BY createdAt ASC`),
    recent: db.prepare(`SELECT * FROM story_forge_sessions WHERE status <> 'abandoned' ORDER BY updatedAt DESC LIMIT ?`),
    callsOfDay: db.prepare(`SELECT COALESCE(SUM(calls), 0) AS n FROM story_forge_sessions WHERE day = ?`),
  };
}
const S = () => (stmts ??= prepare());

const ser = (r: ForgeRow) => ({
  ...r,
  seed: JSON.stringify(r.seed),
  turns: JSON.stringify(r.turns),
  covered: JSON.stringify(r.covered),
  draft: r.draft ? JSON.stringify(r.draft) : null,
});

export function insertSession(r: ForgeRow): void {
  S().insert.run(ser(r));
}

export function updateSession(r: ForgeRow): void {
  S().update.run(ser(r));
}

export function getSession(id: string): ForgeRow | null {
  const r = S().get.get(id) as Raw | undefined;
  return r ? toRow(r) : null;
}

export function sessionsOfDay(day: string): ForgeRow[] {
  return (S().ofDay.all(day) as Raw[]).map(toRow);
}

export function recentSessions(n = 6): ForgeRow[] {
  return (S().recent.all(n) as Raw[]).map(toRow);
}

export function callsOfDay(day: string): number {
  return (S().callsOfDay.get(day) as { n: number }).n;
}
