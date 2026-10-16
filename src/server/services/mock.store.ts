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
import type { MockLevel, SdConcept } from '../../shared/sd.js';
import type { StoredTurn } from './mock.state.js';
import { sdPrompt } from '../../shared/sd-prompts.js';

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
      SELECT promptId FROM mocks WHERE promptId IS NOT NULL ORDER BY createdAt DESC LIMIT ?
    `),
    insertTurn: db.prepare(`
      INSERT INTO mock_turns (mockId, seq, role, kind, content, rendered, stage, meta, createdAt)
      VALUES (@mockId, @seq, @role, @kind, @content, @rendered, @stage, @meta, @createdAt)
    `),
    getTurns: db.prepare(`SELECT * FROM mock_turns WHERE mockId = ? ORDER BY seq ASC`),
    insertGap: db.prepare(`
      INSERT OR REPLACE INTO mock_gaps (mockId, seq, concept, summary, createdAt)
      VALUES (?, ?, ?, ?, ?)
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

export function recentPromptIds(limit = 5): string[] {
  return (S().recentPromptIds.all(limit) as { promptId: string }[]).map((r) => r.promptId);
}

export function listMocks(limit = 30): MockSummary[] {
  const rows = S().listMocks.all(limit) as (RawMock & { verdict: MockVerdict | null })[];
  return rows.map((r) => {
    const m = parseMock(r)!;
    return {
      id: m.id,
      kind: m.kind,
      level: m.level,
      promptTitle: (m.promptId && sdPrompt(m.promptId)?.title) || m.prompt.slice(0, 80),
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
    gaps: { seq: number; concept: SdConcept; summary: string }[]
  ) => {
    const now = new Date().toISOString();
    for (const t of turns) {
      S().insertTurn.run({ ...t, mockId: mock.id, meta: JSON.stringify(t.meta), createdAt: now });
    }
    for (const g of gaps) S().insertGap.run(mock.id, g.seq, g.concept, g.summary, now);
    updateMock(mock);
  }
);

export function putGrade(mockId: string, grade: MockGrade, usage: MockUsage): void {
  S().putGrade.run(mockId, grade.level, grade.verdict, JSON.stringify(grade), JSON.stringify(usage), new Date().toISOString());
}

export function getGrade(mockId: string): MockGrade | null {
  const r = S().getGrade.get(mockId) as { grade: string } | undefined;
  return r ? (JSON.parse(r.grade) as MockGrade) : null;
}
