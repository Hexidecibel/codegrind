// =============================================================================
// routes/mock — the HTTP contract, against a real (temporary) database
// =============================================================================
// The two model calls are replaced by fakes; everything else is real — the
// service, the store, the migration, the state machine. What is pinned:
//
//   * GETs never call a model.
//   * A failed model call stores NOTHING, so the transcript never ends on an
//     orphaned candidate turn and a resend is clean.
//   * A stale expectedSeq is a 409; a call already in flight is a 429; the turn
//     cap is a 409.
//   * End & grade streams wrapup → grade; a truncated or failed grade is an
//     error event and leaves the mock re-gradable.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fake = vi.hoisted(() => ({ interviewerTurn: vi.fn(), gradeMock: vi.fn() }));
vi.mock('../services/llm.mock.js', () => fake);

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-mock-test-'));
if (!TEST_DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run: test DATA_DIR ${TEST_DATA_DIR} is not under ${tmpdir()}`);
}
process.env.DATA_DIR = TEST_DATA_DIR;

const { mockRoutes } = await import('./mock.js');
const { db } = await import('../services/db.js');
const { MOCK_TURN_CAP } = await import('../../shared/mock.js');
const { LlmToolCallError } = await import('../services/llm.types.js');

const app = new Hono();
app.route('/api', mockRoutes);

afterAll(() => {
  db.close();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const META = {
  servedModel: 'claude-sonnet-5',
  stop: 'tool_use',
  latencyMs: 5,
  usage: { inputTokens: 100, outputTokens: 200, cachedInputTokens: 1000, cacheWriteInputTokens: 300 },
};

function replyWith(over: Record<string, unknown> = {}) {
  return {
    reply: {
      stage: 'requirements',
      stagesCovered: [],
      mode: 'interview',
      teach: null,
      resumePoint: '',
      say: 'Who uses it?',
      ...over,
    },
    observations: [{ concept: 'clarifying-questions', signal: 'nailed', note: 'n' }],
    meta: META,
  };
}

const GRADE = {
  level: 'staff',
  verdict: 'at',
  summary: 'ok',
  stages: [],
  skipped: [],
  gapsTaught: [],
  conceptObservations: [],
  drills: [{ concept: 'failure-ranking', prompt: 'Rank them.', why: 'weak' }],
};

const post = (url: string, body?: unknown) =>
  app.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function start(body: Record<string, unknown> = {}) {
  fake.interviewerTurn.mockResolvedValueOnce(replyWith({ say: 'Design a ticketing system.' }));
  const res = await post('/api/mock/start', body);
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string; turns: { seq: number }[]; [k: string]: unknown };
}

beforeEach(() => {
  fake.interviewerTurn.mockReset();
  fake.gradeMock.mockReset();
  db.exec(`DELETE FROM mock_grades; DELETE FROM mock_gaps; DELETE FROM mock_turns; DELETE FROM mocks;`);
});

describe('start', () => {
  it('opens a Staff mock by default, with the interviewer’s first line', async () => {
    const view = await start();
    expect(view.level).toBe('staff');
    expect(view.status).toBe('active');
    expect(view.turns).toEqual([
      expect.objectContaining({ seq: 1, role: 'interviewer', content: 'Design a ticketing system.' }),
    ]);
    // The control-note bytes never cross the wire.
    expect(JSON.stringify(view)).not.toContain('rendered');
    expect(fake.interviewerTurn).toHaveBeenCalledTimes(1);
  });

  it('picks a familiar prompt for the first mock, and accepts a chosen one', async () => {
    const first = await start();
    expect(['event-ticketing', 'telecom-inventory', 'wedding-jukebox', 'hiker-photos']).toContain(first.promptId);
    const chosen = await start({ promptId: 'url-shortener', level: 'principal' });
    expect(chosen.promptId).toBe('url-shortener');
    expect(chosen.level).toBe('principal');
  });

  it('rejects a bad level or prompt before spending anything', async () => {
    expect((await post('/api/mock/start', { level: 'cto' })).status).toBe(400);
    expect((await post('/api/mock/start', { promptId: 'nope' })).status).toBe(400);
    expect(fake.interviewerTurn).not.toHaveBeenCalled();
  });

  it('leaves no mock behind when the opening call fails', async () => {
    fake.interviewerTurn.mockRejectedValueOnce(new Error('boom'));
    expect((await post('/api/mock/start', {})).status).toBe(502);
    const list = await (await app.request('/api/mocks')).json();
    expect(list.mocks).toEqual([]);
  });
});

describe('reads are free', () => {
  it('GET /api/mocks, /api/mock/:id and /api/mock/prompts make no model call', async () => {
    const view = await start();
    fake.interviewerTurn.mockClear();
    expect((await app.request('/api/mocks')).status).toBe(200);
    expect((await app.request(`/api/mock/${view.id}`)).status).toBe(200);
    expect((await app.request('/api/mock/prompts')).status).toBe(200);
    expect((await app.request('/api/mock/missing')).status).toBe(404);
    expect(fake.interviewerTurn).not.toHaveBeenCalled();
    expect(fake.gradeMock).not.toHaveBeenCalled();
  });
});

describe('a turn', () => {
  it('stores the answer and the reply together, and accounts the usage', async () => {
    const view = await start();
    fake.interviewerTurn.mockResolvedValueOnce(replyWith({ say: 'How many buyers?', stagesCovered: ['requirements'] }));
    const res = await post(`/api/mock/${view.id}/turn`, { expectedSeq: 1, content: 'Who buys tickets?' });
    expect(res.status).toBe(200);
    const next = await res.json();
    expect(next.turns.map((t: { seq: number; role: string }) => [t.seq, t.role])).toEqual([
      [1, 'interviewer'],
      [2, 'candidate'],
      [3, 'interviewer'],
    ]);
    expect(next.state.candidateTurns).toBe(1);
    expect(next.state.covered).toEqual(['requirements']);
    expect(next.usage.calls).toBe(2);
    expect(next.usage.costUsd).toBeGreaterThan(0);

    // What the model was sent: context, opening, and the rendered answer with
    // its clock note.
    const sent = fake.interviewerTurn.mock.calls[1][0] as { role: string; content: string }[];
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(sent[2].content).toMatch(/^Who buys tickets\?\n\n\[server: \d+ of 45 min/);
  });

  it('replays earlier turns byte for byte on the next request', async () => {
    const view = await start();
    fake.interviewerTurn.mockResolvedValueOnce(replyWith({ say: 'A' }));
    await post(`/api/mock/${view.id}/turn`, { expectedSeq: 1, content: 'one' });
    fake.interviewerTurn.mockResolvedValueOnce(replyWith({ say: 'B' }));
    await post(`/api/mock/${view.id}/turn`, { expectedSeq: 3, content: 'two' });
    const first = fake.interviewerTurn.mock.calls[1][0];
    const second = fake.interviewerTurn.mock.calls[2][0];
    expect(second.slice(0, first.length)).toEqual(first);
  });

  it('stores NOTHING when the model call fails, so a resend is clean', async () => {
    const view = await start();
    fake.interviewerTurn.mockRejectedValueOnce(new LlmToolCallError('broken', META));
    const res = await post(`/api/mock/${view.id}/turn`, { expectedSeq: 1, content: 'hello' });
    expect(res.status).toBe(502);
    const after = await (await app.request(`/api/mock/${view.id}`)).json();
    expect(after.turns).toHaveLength(1);
    expect(after.state.candidateTurns).toBe(0);
    // Same expectedSeq still works.
    fake.interviewerTurn.mockResolvedValueOnce(replyWith());
    expect((await post(`/api/mock/${view.id}/turn`, { expectedSeq: 1, content: 'hello' })).status).toBe(200);
  });

  it('answers a stale expectedSeq with 409 and spends nothing', async () => {
    const view = await start();
    fake.interviewerTurn.mockClear();
    expect((await post(`/api/mock/${view.id}/turn`, { expectedSeq: 0, content: 'x' })).status).toBe(409);
    expect(fake.interviewerTurn).not.toHaveBeenCalled();
  });

  it('answers a second turn while one is in flight with 429', async () => {
    const view = await start();
    let release!: (v: unknown) => void;
    fake.interviewerTurn.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const first = post(`/api/mock/${view.id}/turn`, { expectedSeq: 1, content: 'one' });
    await new Promise((r) => setTimeout(r, 10));
    const second = await post(`/api/mock/${view.id}/turn`, { expectedSeq: 1, content: 'two' });
    expect(second.status).toBe(429);
    release(replyWith());
    expect((await first).status).toBe(200);
  });

  it('validates the body before spending', async () => {
    const view = await start();
    fake.interviewerTurn.mockClear();
    expect((await post(`/api/mock/${view.id}/turn`, { content: 'x' })).status).toBe(400);
    expect((await post(`/api/mock/${view.id}/turn`, { expectedSeq: 1, content: '  ' })).status).toBe(400);
    expect((await post(`/api/mock/${view.id}/turn`, { expectedSeq: 1, content: 'x', action: 'cheat' })).status).toBe(400);
    expect(fake.interviewerTurn).not.toHaveBeenCalled();
  });

  it('accepts a button press with no text, and records a taught gap', async () => {
    const view = await start();
    fake.interviewerTurn.mockResolvedValueOnce(
      replyWith({ mode: 'teach', teach: { concept: 'idempotency', gapSummary: 'did not know keys' } })
    );
    const res = await post(`/api/mock/${view.id}/turn`, { expectedSeq: 1, content: '', action: 'teach_me', concept: 'idempotency' });
    expect(res.status).toBe(200);
    const next = await res.json();
    expect(next.turns[1]).toMatchObject({ role: 'candidate', kind: 'control', action: 'teach_me' });
    expect(next.turns[2]).toMatchObject({ kind: 'teach', teach: { concept: 'idempotency' } });
    expect(next.state.taught).toEqual(['idempotency']);
    const sent = fake.interviewerTurn.mock.calls[1][0] as { content: string }[];
    expect(sent[2].content).toContain('[control: TEACH ME');
    expect(db.prepare(`SELECT concept FROM mock_gaps`).all()).toEqual([{ concept: 'idempotency' }]);
  });

  it('refuses turns past the cap', async () => {
    const view = await start();
    const row = db.prepare(`SELECT state FROM mocks WHERE id = ?`).get(view.id) as { state: string };
    const state = { ...JSON.parse(row.state), candidateTurns: MOCK_TURN_CAP };
    db.prepare(`UPDATE mocks SET state = ? WHERE id = ?`).run(JSON.stringify(state), view.id);
    fake.interviewerTurn.mockClear();
    const res = await post(`/api/mock/${view.id}/turn`, { expectedSeq: 1, content: 'x' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/End & grade/);
    expect(fake.interviewerTurn).not.toHaveBeenCalled();
  });
});

async function readEvents(res: Response) {
  return (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('end & grade', () => {
  async function oneTurn() {
    const view = await start();
    fake.interviewerTurn.mockResolvedValueOnce(replyWith());
    await post(`/api/mock/${view.id}/turn`, { expectedSeq: 1, content: 'hi' });
    return view.id;
  }

  it('refuses to grade an empty mock with a plain 409', async () => {
    const view = await start();
    expect((await post(`/api/mock/${view.id}/end`)).status).toBe(409);
    expect(fake.gradeMock).not.toHaveBeenCalled();
  });

  it('streams wrapup then grade, and stores the grade', async () => {
    const id = await oneTurn();
    fake.gradeMock.mockResolvedValueOnce({ grade: GRADE, metas: [META] });
    const res = await post(`/api/mock/${id}/end`);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const events = await readEvents(res);
    expect(events.map((e) => e.type)).toEqual(['wrapup', 'grade']);
    expect(events[1].grade.drills).toHaveLength(1);
    const view = await (await app.request(`/api/mock/${id}`)).json();
    expect(view.status).toBe('graded');
    expect(view.grade.verdict).toBe('at');
    expect(view.usage.calls).toBe(3);
    const list = await (await app.request('/api/mocks')).json();
    expect(list.mocks[0]).toMatchObject({ id, status: 'graded', verdict: 'at' });
    // Graded is final.
    expect((await post(`/api/mock/${id}/end`)).status).toBe(409);
    expect((await post(`/api/mock/${id}/turn`, { expectedSeq: 3, content: 'x' })).status).toBe(409);
  });

  it('turns a truncated grade into an error event and leaves the mock re-gradable', async () => {
    const id = await oneTurn();
    fake.gradeMock.mockRejectedValueOnce(new Error('Grade truncated at max_tokens after 16000 output tokens'));
    const events = await readEvents(await post(`/api/mock/${id}/end`));
    expect(events.map((e) => e.type)).toEqual(['wrapup', 'error']);
    const view = await (await app.request(`/api/mock/${id}`)).json();
    expect(view.status).toBe('grade_failed');
    expect(view.grade).toBeNull();
    // Press it again.
    fake.gradeMock.mockResolvedValueOnce({ grade: GRADE, metas: [META] });
    const retry = await readEvents(await post(`/api/mock/${id}/end`));
    expect(retry.map((e) => e.type)).toEqual(['wrapup', 'grade']);
  });

  it('hands the grader the marked-up transcript and what was skipped and taught', async () => {
    const id = await oneTurn();
    fake.gradeMock.mockResolvedValueOnce({ grade: GRADE, metas: [META] });
    await readEvents(await post(`/api/mock/${id}/end`));
    const input = fake.gradeMock.mock.calls[0][0];
    expect(input.level).toBe('staff');
    expect(input.transcript).toContain('#2 CANDIDATE: hi');
    expect(input.transcript).not.toContain('[server:');
  });
});

describe('abandon', () => {
  it('marks it abandoned without a model call', async () => {
    const view = await start();
    fake.interviewerTurn.mockClear();
    const res = await post(`/api/mock/${view.id}/abandon`);
    expect((await res.json()).status).toBe('abandoned');
    expect(fake.interviewerTurn).not.toHaveBeenCalled();
    expect((await post(`/api/mock/${view.id}/turn`, { expectedSeq: 1, content: 'x' })).status).toBe(409);
  });
});

// -----------------------------------------------------------------------------
// Gaps and drill cards
// -----------------------------------------------------------------------------
const FACT = {
  concept: 'api-design',
  type: 'fact',
  title: 'URL shortener redirect: 301 or 302 — and why?',
  answer: '302, so every click passes through you and can be counted.',
};
const SKILL = {
  concept: 'failure-ranking',
  type: 'skill',
  title: 'Say the ranking sentence for a URL shortener.',
  answer: 'Worst is down; accept stale analytics to get it.',
};

describe('gaps', () => {
  it('records every gap the interviewer handed over, typed, on any mode — not only teach', async () => {
    const view = await start();
    fake.interviewerTurn.mockResolvedValueOnce(replyWith({ mode: 'nudge', gaps: [FACT, SKILL] }));
    const res = await post(`/api/mock/${view.id}/turn`, { expectedSeq: 1, content: '301 i guess' });
    const next = await res.json();
    expect(next.gaps).toHaveLength(2);
    expect(next.gaps[0]).toMatchObject({ seq: 3, type: 'fact', title: FACT.title, answer: FACT.answer, source: 'turn' });
    expect(next.gaps[1]).toMatchObject({ seq: 3, type: 'skill', concept: 'failure-ranking' });
  });

  it('a teach turn that lists its lesson is not recorded twice', async () => {
    const view = await start();
    fake.interviewerTurn.mockResolvedValueOnce(
      replyWith({ mode: 'teach', teach: { concept: 'failure-ranking', gapSummary: 'would not rank' }, gaps: [SKILL] })
    );
    const next = await (await post(`/api/mock/${view.id}/turn`, { expectedSeq: 1, content: '', action: 'teach_me' })).json();
    expect(next.gaps).toHaveLength(1);
    expect(next.gaps[0]).toMatchObject({ type: 'skill', title: SKILL.title, summary: 'would not rank' });
  });

  it('stores the grader’s extra gaps as cards, minus ones already recorded, and a re-grade does not double them', async () => {
    const view = await start();
    fake.interviewerTurn.mockResolvedValueOnce(replyWith({ gaps: [FACT] }));
    await post(`/api/mock/${view.id}/turn`, { expectedSeq: 1, content: 'hi' });
    const extra = { concept: 'scale-estimation', type: 'fact', title: 'Seconds in a month, roughly?', answer: '~2.5M.', turn: 5 };
    const grade = { ...GRADE, gaps: [{ ...FACT, title: FACT.title.toUpperCase(), turn: 3 }, extra] };
    fake.gradeMock.mockResolvedValueOnce({ grade, metas: [META] });
    await readEvents(await post(`/api/mock/${view.id}/end`));
    const input = fake.gradeMock.mock.calls[0][0];
    expect(input.recordedGaps).toEqual([{ seq: 3, type: 'fact', title: FACT.title, summary: FACT.title }]);
    const after = await (await app.request(`/api/mock/${view.id}`)).json();
    expect(after.gaps.map((g: { title: string; source: string }) => [g.title, g.source])).toEqual([
      [FACT.title, 'turn'],
      [extra.title, 'grade'],
    ]);
    const { storeGradeGaps } = await import('../services/mock.service.js');
    expect(storeGradeGaps(view.id, grade as never)).toBe(0);
  });
});

describe('drill cards', () => {
  async function withCards() {
    const view = await start();
    fake.interviewerTurn.mockResolvedValueOnce(replyWith({ gaps: [FACT, SKILL] }));
    await post(`/api/mock/${view.id}/turn`, { expectedSeq: 1, content: 'hi' });
    fake.interviewerTurn.mockReset();
    return view.id;
  }

  it('lists due cards with the mock they came from, and makes no model call', async () => {
    await withCards();
    const res = await app.request('/api/mock/cards');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.due).toHaveLength(2);
    expect(body.due[0]).toMatchObject({ title: FACT.title, step: 0, retiredAt: null });
    expect(typeof body.due[0].mockTitle).toBe('string');
    expect(body).toMatchObject({ upcoming: 0, retired: 0, nextDueAt: null });
    expect(fake.interviewerTurn).not.toHaveBeenCalled();
    expect(fake.gradeMock).not.toHaveBeenCalled();
  });

  it('self-grading advances the schedule with no model call', async () => {
    await withCards();
    const [card] = (await (await app.request('/api/mock/cards')).json()).due;
    const res = await post(`/api/mock/cards/${card.id}/grade`, { grade: 'got' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: card.id, step: 1, reps: 1, lastGrade: 'got' });
    const after = await (await app.request('/api/mock/cards')).json();
    expect(after.due).toHaveLength(1);
    expect(after.upcoming).toBe(1);
    expect(after.nextDueAt).toBeTruthy();
    expect(fake.interviewerTurn).not.toHaveBeenCalled();
    expect(fake.gradeMock).not.toHaveBeenCalled();
  });

  it('retires a card after "got it" on the top rung, and refuses to grade it again', async () => {
    await withCards();
    const [card] = (await (await app.request('/api/mock/cards')).json()).due;
    db.prepare(`UPDATE mock_gaps SET step = 3 WHERE id = ?`).run(card.id);
    expect(await (await post(`/api/mock/cards/${card.id}/grade`, { grade: 'got' })).json()).toMatchObject({
      retiredAt: expect.any(String),
    });
    expect((await (await app.request('/api/mock/cards')).json()).retired).toBe(1);
    expect((await post(`/api/mock/cards/${card.id}/grade`, { grade: 'got' })).status).toBe(409);
  });

  it('validates the grade and the card id', async () => {
    await withCards();
    const [card] = (await (await app.request('/api/mock/cards')).json()).due;
    expect((await post(`/api/mock/cards/${card.id}/grade`, { grade: 'easy' })).status).toBe(400);
    expect((await post(`/api/mock/cards/999999/grade`, { grade: 'got' })).status).toBe(404);
    expect((await post(`/api/mock/cards/abc/grade`, { grade: 'got' })).status).toBe(404);
  });

  it('does not shadow GET /api/mock/:id', async () => {
    const id = await withCards();
    expect((await app.request(`/api/mock/${id}`)).status).toBe(200);
  });
});
