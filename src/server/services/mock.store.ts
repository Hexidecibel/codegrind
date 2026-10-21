// =============================================================================
// mock.store — the four mock tables, read and written
// =============================================================================
// Kept out of db.ts (already ~1900 lines) but on the SAME connection: it imports
// the handle db.ts opened and migrated, so there is still one SQLite file, one
// WAL and one migration path. Statements are prepared lazily rather than at
// import, so a module that imports this for its types does not prepare
// statements against a table it never touches.

import { db } from './db.js';
import type {
  MockGrade,
  MockKind,
  MockState,
  MockStatus,
  MockSummary,
  MockTurn,
  MockUsage,
  MockVerdict,
} from '../../shared/mock.js';
import type { GapType, MockLevel } from '../../shared/sd.js';
import { mockPromptTitle, type MockConcept } from '../../shared/mock-kinds.js';
import {
  gapKey,
  newCardSchedule,
  type GapCard,
  type GapCardGrade,
  type GapCardSchedule,
  type GapSource,
  type MockGap,
} from '../../shared/gap-cards.js';
import type { StoredTurn } from './mock.state.js';

export interface MockRow {
  id: string;
  kind: MockKind;
  level: MockLevel;
  promptId: string | null;
  prompt: string;
  status: MockStatus;
  context: string;
  digest: string | null;
  state: MockState;
  usage: MockUsage;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

/** A turn as stored: the wire shape plus the exact bytes it was sent as. */
export interface StoredMockTurn extends MockTurn {
  rendered: string;
  /** Interviewer turns: what the reply observed. Phase 2 folds these. */
  observations?: unknown[];
}

export function emptyUsage(): MockUsage {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    models: [],
  };
}

interface RawMock extends Omit<MockRow, 'state' | 'usage'> {
  state: string;
  usage: string;
}

function parseMock(r: RawMock | undefined): MockRow | null {
  if (!r) return null;
  return { ...r, state: JSON.parse(r.state) as MockState, usage: JSON.parse(r.usage) as MockUsage };
}

let stmts: ReturnType<typeof prepare> | null = null;
function prepare() {
  return {
    insertMock: db.prepare(`
      INSERT INTO mocks (id, kind, level, promptId, prompt, status, context, digest, state, usage, turnCount, createdAt, updatedAt, endedAt)
      VALUES (@id, @kind, @level, @promptId, @prompt, @status, @context, @digest, @state, @usage, @turnCount, @createdAt, @updatedAt, @endedAt)
    `),
    getMock: db.prepare(`SELECT * FROM mocks WHERE id = ?`),
    deleteMock: db.prepare(`DELETE FROM mocks WHERE id = ?`),
    updateMock: db.prepare(`
      UPDATE mocks SET status = @status, state = @state, usage = @usage, turnCount = @turnCount,
        digest = @digest, updatedAt = @updatedAt, endedAt = @endedAt
      WHERE id = @id
    `),
    listMocks: db.prepare(`
      SELECT m.*, g.verdict AS verdict FROM mocks m
      LEFT JOIN mock_grades g ON g.mockId = m.id
      ORDER BY m.createdAt DESC LIMIT ?
    `),
    recentPromptIds: db.prepare(`
      SELECT promptId FROM mocks WHERE promptId IS NOT NULL AND kind = ? ORDER BY createdAt DESC LIMIT ?
    `),
    insertTurn: db.prepare(`
      INSERT INTO mock_turns (mockId, seq, role, kind, content, rendered, stage, meta, createdAt)
      VALUES (@mockId, @seq, @role, @kind, @content, @rendered, @stage, @meta, @createdAt)
    `),
    getTurns: db.prepare(`SELECT * FROM mock_turns WHERE mockId = ? ORDER BY seq ASC`),
    insertGap: db.prepare(`
      INSERT INTO mock_gaps (mockId, seq, concept, type, title, summary, answer, source,
        step, dueAt, reps, lapses, lastGrade, lastReviewedAt, retiredAt, createdAt)
      VALUES (@mockId, @seq, @concept, @type, @title, @summary, @answer, @source,
        @step, @dueAt, @reps, @lapses, @lastGrade, @lastReviewedAt, @retiredAt, @createdAt)
    `),
    getGaps: db.prepare(`SELECT * FROM mock_gaps WHERE mockId = ? ORDER BY COALESCE(seq, 1e9), id`),
    getCard: db.prepare(`
      SELECT g.*, m.kind AS mockKind, m.promptId AS mockPromptId, m.prompt AS mockPrompt
      FROM mock_gaps g JOIN mocks m ON m.id = g.mockId WHERE g.id = ?
    `),
    dueCards: db.prepare(`
      SELECT g.*, m.kind AS mockKind, m.promptId AS mockPromptId, m.prompt AS mockPrompt
      FROM mock_gaps g JOIN mocks m ON m.id = g.mockId
      WHERE g.retiredAt IS NULL AND g.dueAt <= ?
      ORDER BY g.dueAt ASC, g.id ASC LIMIT ?
    `),
    cardCounts: db.prepare(`
      SELECT
        SUM(CASE WHEN retiredAt IS NULL AND dueAt > @now THEN 1 ELSE 0 END) AS upcoming,
        SUM(CASE WHEN retiredAt IS NOT NULL THEN 1 ELSE 0 END) AS retired,
        MIN(CASE WHEN retiredAt IS NULL AND dueAt > @now THEN dueAt END) AS nextDueAt
      FROM mock_gaps
    `),
    updateSchedule: db.prepare(`
      UPDATE mock_gaps SET step = @step, dueAt = @dueAt, reps = @reps, lapses = @lapses,
        lastGrade = @lastGrade, lastReviewedAt = @lastReviewedAt, retiredAt = @retiredAt
      WHERE id = @id
    `),
    putGrade: db.prepare(`
      INSERT OR REPLACE INTO mock_grades (mockId, level, verdict, grade, usage, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    getGrade: db.prepare(`SELECT grade FROM mock_grades WHERE mockId = ?`),
  };
}
const S = () => (stmts ??= prepare());

export function insertMock(m: MockRow): void {
  S().insertMock.run({ ...m, state: JSON.stringify(m.state), usage: JSON.stringify(m.usage) });
}

export function getMock(id: string): MockRow | null {
  return parseMock(S().getMock.get(id) as RawMock | undefined);
}

export function deleteMock(id: string): void {
  S().deleteMock.run(id);
}

export function updateMock(
  m: Pick<MockRow, 'id' | 'status' | 'state' | 'usage' | 'turnCount' | 'digest' | 'endedAt'>
): void {
  S().updateMock.run({
    ...m,
    state: JSON.stringify(m.state),
    usage: JSON.stringify(m.usage),
    updatedAt: new Date().toISOString(),
  });
}

/** The kind's most recent prompt ids, newest first (prompt ids are per kind). */
export function recentPromptIds(kind: MockKind = 'system-design', limit = 5): string[] {
  return (S().recentPromptIds.all(kind, limit) as { promptId: string }[]).map((r) => r.promptId);
}

export function listMocks(limit = 30): MockSummary[] {
  const rows = S().listMocks.all(limit) as (RawMock & { verdict: MockVerdict | null })[];
  return rows.map((r) => {
    const m = parseMock(r)!;
    return {
      id: m.id,
      kind: m.kind,
      level: m.level,
      promptTitle: mockPromptTitle(m.kind, m.promptId) || m.prompt.slice(0, 80),
      status: m.status,
      candidateTurns: m.state.candidateTurns,
      verdict: r.verdict ?? null,
      costUsd: m.usage.costUsd,
      createdAt: m.createdAt,
    };
  });
}

interface RawTurn {
  mockId: string;
  seq: number;
  role: MockTurn['role'];
  kind: MockTurn['kind'];
  content: string;
  rendered: string;
  stage: MockTurn['stage'];
  meta: string | null;
  createdAt: string;
}

export function getTurns(mockId: string): StoredMockTurn[] {
  return (S().getTurns.all(mockId) as RawTurn[]).map((r) => {
    const meta = r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : {};
    return {
      seq: r.seq,
      role: r.role,
      kind: r.kind,
      content: r.content,
      rendered: r.rendered,
      stage: r.stage,
      createdAt: r.createdAt,
      ...(meta.mode ? { mode: meta.mode as MockTurn['mode'] } : {}),
      ...(meta.teach !== undefined ? { teach: meta.teach as MockTurn['teach'] } : {}),
      ...(meta.action ? { action: meta.action as MockTurn['action'] } : {}),
      ...(meta.observations ? { observations: meta.observations as unknown[] } : {}),
    };
  });
}

export function toStoredTurns(turns: readonly StoredMockTurn[]): StoredTurn[] {
  return turns.map((t) => ({ seq: t.seq, role: t.role, rendered: t.rendered }));
}

export interface NewTurn {
  seq: number;
  role: MockTurn['role'];
  kind: MockTurn['kind'];
  content: string;
  rendered: string;
  stage: MockTurn['stage'];
  meta: Record<string, unknown>;
}

/**
 * Append turns and the mock's new state in ONE transaction. A candidate turn is
 * only ever stored together with the interviewer reply to it — a half-written
 * exchange would leave the transcript ending on a user message, and the next
 * request would have nowhere to put its own.
 */
export const appendExchange = db.transaction(
  (
    mock: Pick<MockRow, 'id' | 'status' | 'state' | 'usage' | 'turnCount' | 'digest' | 'endedAt'>,
    turns: NewTurn[],
    gaps: NewGap[]
  ) => {
    const now = new Date().toISOString();
    for (const t of turns) {
      S().insertTurn.run({ ...t, mockId: mock.id, meta: JSON.stringify(t.meta), createdAt: now });
    }
    for (const g of gaps) insertGap(mock.id, g, new Date(now));
    updateMock(mock);
  }
);

// -----------------------------------------------------------------------------
// Gaps — each one is also a drill card (src/shared/gap-cards.ts)
// -----------------------------------------------------------------------------

export interface NewGap {
  seq: number | null;
  concept: MockConcept;
  type: GapType;
  title: string;
  summary: string;
  answer: string;
  source?: GapSource;
}

/** Insert one gap as a fresh card, due now. */
export function insertGap(mockId: string, g: NewGap, now: Date): void {
  S().insertGap.run({
    mockId,
    seq: g.seq,
    concept: g.concept,
    type: g.type,
    title: g.title,
    summary: g.summary,
    answer: g.answer,
    source: g.source ?? 'turn',
    ...newCardSchedule(now),
    createdAt: now.toISOString(),
  });
}

interface RawGap extends Omit<GapCard, 'mockTitle'> {
  mockKind?: string;
  mockPromptId?: string | null;
  mockPrompt?: string;
}

function toGap(r: RawGap): MockGap {
  return {
    id: r.id,
    mockId: r.mockId,
    seq: r.seq ?? null,
    concept: r.concept,
    type: r.type,
    title: r.title,
    summary: r.summary,
    answer: r.answer,
    source: r.source,
    createdAt: r.createdAt,
  };
}

function toCard(r: RawGap): GapCard {
  return {
    ...toGap(r),
    step: r.step,
    dueAt: r.dueAt,
    reps: r.reps,
    lapses: r.lapses,
    lastGrade: (r.lastGrade as GapCardGrade | null) ?? null,
    lastReviewedAt: r.lastReviewedAt ?? null,
    retiredAt: r.retiredAt ?? null,
    mockTitle: mockPromptTitle(r.mockKind, r.mockPromptId) || (r.mockPrompt ?? '').slice(0, 80),
  };
}

export function getGaps(mockId: string): MockGap[] {
  return (S().getGaps.all(mockId) as RawGap[]).map(toGap);
}

/** Gap keys already recorded for a mock — the grader's additions are deduped against these. */
export function gapKeys(mockId: string): Set<string> {
  return new Set(getGaps(mockId).map((g) => gapKey(g.title)).filter(Boolean));
}

export function getCard(id: number): GapCard | null {
  const r = S().getCard.get(id) as RawGap | undefined;
  return r ? toCard(r) : null;
}

export function dueCards(now: Date, limit = 50): GapCard[] {
  return (S().dueCards.all(now.toISOString(), limit) as RawGap[]).map(toCard);
}

export function cardCounts(now: Date): { upcoming: number; retired: number; nextDueAt: string | null } {
  const r = S().cardCounts.get({ now: now.toISOString() }) as {
    upcoming: number | null;
    retired: number | null;
    nextDueAt: string | null;
  };
  return { upcoming: r.upcoming ?? 0, retired: r.retired ?? 0, nextDueAt: r.nextDueAt ?? null };
}

export function updateCardSchedule(id: number, s: GapCardSchedule): void {
  S().updateSchedule.run({ id, ...s });
}

export function putGrade(mockId: string, grade: MockGrade, usage: MockUsage): void {
  S().putGrade.run(mockId, grade.level, grade.verdict, JSON.stringify(grade), JSON.stringify(usage), new Date().toISOString());
}

export function getGrade(mockId: string): MockGrade | null {
  const r = S().getGrade.get(mockId) as { grade: string } | undefined;
  return r ? (JSON.parse(r.grade) as MockGrade) : null;
}
