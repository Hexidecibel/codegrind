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

import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
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

  it('takes an explicit kind, and stores and threads it', async () => {
    const view = await start({ kind: 'system-design', promptId: 'url-shortener' });
    expect(view.kind).toBe('system-design');
    expect(view.limits).toEqual({ turnCap: 40, minutes: 45 });
    // The kind reaches the model call, so its spec (prompts, tools) is used.
    expect(fake.interviewerTurn.mock.calls[0][2]).toBe('system-design');
    const list = await (await app.request('/api/mocks')).json();
    expect(list.mocks[0]).toMatchObject({ kind: 'system-design', promptTitle: 'A URL shortener' });
  });

  it('rejects an unknown kind with a 400 before spending anything', async () => {
    for (const kind of ['behavioral-ish', 42, 'SYSTEM-DESIGN']) {
      const res = await post('/api/mock/start', { kind });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/kind must be one of/);
    }
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

describe('GET /api/mock/prompts', () => {
  it('serves the system-design bank with no kind and with kind=system-design', async () => {
    const plain = await (await app.request('/api/mock/prompts')).json();
    const explicit = await (await app.request('/api/mock/prompts?kind=system-design')).json();
    expect(explicit).toEqual(plain);
    expect(plain.prompts.map((p: { id: string }) => p.id)).toContain('event-ticketing');
    expect(Object.keys(plain.prompts[0])).toEqual(['id', 'title', 'brief', 'familiar']);
  });

  it('is a 400 for an unknown kind', async () => {
    expect((await app.request('/api/mock/prompts?kind=nope')).status).toBe(400);
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

describe('behavioral', () => {
  const BANK = {
    stories: [
      {
        id: 'story-secret', title: 'T', status: 'confirmed', situation: 'SITUATION-TEXT', task: 't', action: 'a', result: 'r',
        numbers: [], caveats: ['CAVEAT-TEXT'], unconfirmed: ['UNCONFIRMED-TEXT'], fits: ['influence without authority'], doesNotFit: [],
      },
    ],
    gaps: [{ type: 'disagreement or conflict', status: 'open' }],
  };
  const fetchUrls: string[] = [];
  function bankUp() {
    vi.stubGlobal('fetch', async (u: string) => {
      fetchUrls.push(u);
      return new Response(JSON.stringify(BANK), { status: 200 });
    });
  }
  function bankDown() {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('connect ECONNREFUSED 127.0.0.1:9410');
    });
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchUrls.length = 0;
  });

  async function startB(body: Record<string, unknown> = {}) {
    fake.interviewerTurn.mockResolvedValueOnce(replyWith({ stage: 'intro', say: 'Tell me about yourself.' }));
    const res = await post('/api/mock/start', { kind: 'behavioral', ...body });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, any>;
  }

  it('previews the plan for the start card for free: four competencies and the bank status, no questions', async () => {
    bankUp();
    const res = await app.request('/api/mock/plan?kind=behavioral');
    expect(res.status).toBe(200);
    const p = await res.json();
    expect(p.concepts).toHaveLength(4);
    expect(new Set(p.concepts).size).toBe(4);
    expect(p.storyBank).toMatchObject({ loaded: true, stories: 1, confirmed: 1 });
    expect(JSON.stringify(p)).not.toMatch(/question|SITUATION-TEXT/i);
    expect(fake.interviewerTurn).not.toHaveBeenCalled();
    // A kind that does not plan answers with an empty preview.
    expect((await (await app.request('/api/mock/plan?kind=system-design')).json()).concepts).toEqual([]);
  });

  it('starts with kind=behavioral: the plan is frozen into the context, the bank goes to state for the grader only', async () => {
    bankUp();
    const concepts = ['conflict', 'influence-without-authority', 'ownership', 'exec-communication'];
    const view = await startB({ plan: { concepts } });
    expect(view.kind).toBe('behavioral');
    expect(view.limits).toEqual({ turnCap: 30, minutes: 35 });
    expect(view.state.stage).toBe('intro');
    expect(view.state.plan.items.map((i: { concept: string }) => i.concept)).toEqual(concepts);
    expect(view.state.plan.storyBank).toMatchObject({ loaded: true });
    // The bank never crosses the wire, and never reaches the interviewer.
    expect(view.state.graderContext).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('SITUATION-TEXT');
    const [messages, stage, kind] = fake.interviewerTurn.mock.calls[0];
    expect(kind).toBe('behavioral');
    expect(stage).toBe('intro');
    expect(messages[0].content).toContain('competency conflict');
    expect(JSON.stringify(messages)).not.toMatch(/SITUATION-TEXT|CAVEAT-TEXT|UNCONFIRMED-TEXT|story-secret/);
    expect(fetchUrls[0]).toBe('http://127.0.0.1:9410/api/data/read?file=stories.json');

    // Turn 2 replays the same frozen context (prefix stability through the store).
    fake.interviewerTurn.mockResolvedValueOnce(replyWith({ stage: 'q1', say: 'Tell me about a disagreement.' }));
    await post(`/api/mock/${view.id}/turn`, { expectedSeq: 1, content: 'I build backends.' });
    const second = fake.interviewerTurn.mock.calls[1][0];
    expect(second[0]).toEqual(messages[0]);
    expect(second[1]).toEqual({ role: 'assistant', content: 'Tell me about yourself.' });

    // End & grade: the grader gets the frozen bank and a word-counted transcript.
    fake.gradeMock.mockResolvedValueOnce({ grade: { ...GRADE, questions: [], storyGaps: [] }, metas: [META] });
    await readEvents(await post(`/api/mock/${view.id}/end`));
    const input = fake.gradeMock.mock.calls[0][0];
    expect(input.kind).toBe('behavioral');
    expect(input.graderContext).toContain('<story id="story-secret">');
    expect(input.graderContext.indexOf('UNCONFIRMED-TEXT')).toBeGreaterThan(input.graderContext.indexOf('OPEN QUESTIONS'));
    expect(input.transcript).toContain('#2 CANDIDATE (3 words): I build backends.');
  });

  it('still starts when resume-builder is down, and records why', async () => {
    bankDown();
    const view = await startB();
    expect(view.state.plan.items).toHaveLength(4);
    expect(view.state.plan.storyBank).toMatchObject({ loaded: false, error: expect.stringMatching(/ECONNREFUSED/) });
    fake.interviewerTurn.mockResolvedValueOnce(replyWith({ stage: 'intro', say: 'And?' }));
    await post(`/api/mock/${view.id}/turn`, { expectedSeq: 1, content: 'hi' });
    fake.gradeMock.mockResolvedValueOnce({ grade: GRADE, metas: [META] });
    await readEvents(await post(`/api/mock/${view.id}/end`));
    expect(fake.gradeMock.mock.calls[0][0].graderContext).toMatch(/^STORY BANK: UNAVAILABLE/);
  });

  it('weights the next plan by past weak grades (the history reaches the planner)', async () => {
    bankUp();
    const view = await startB();
    fake.interviewerTurn.mockResolvedValueOnce(replyWith({ stage: 'intro', say: 'And?' }));
    await post(`/api/mock/${view.id}/turn`, { expectedSeq: 1, content: 'hi' });
    fake.gradeMock.mockResolvedValueOnce({
      grade: { ...GRADE, conceptObservations: [{ concept: 'prioritization', signal: 'missing', note: 'n' }] },
      metas: [META],
    });
    await readEvents(await post(`/api/mock/${view.id}/end`));
    const p = await (await app.request('/api/mock/plan?kind=behavioral')).json();
    // Reasons are reported for the concepts that were picked; prioritization is
    // only sometimes picked, so check the weight reached the planner via the service.
    const { recentConceptSignals } = await import('../services/mock.store.js');
    expect(recentConceptSignals('behavioral')).toEqual([{ concept: 'prioritization', signal: 'missing', note: 'n' }]);
    expect(p.concepts).toHaveLength(4);
  });
});

describe('coding', () => {
  const STARTER = 'function twoSum(nums, target) {\n}\n';
  const runHidden = vi.fn();
  let svc: typeof import('../services/mock.service.js');

  beforeEach(async () => {
    svc = await import('../services/mock.service.js');
    svc.setHiddenRunnerForTest(runHidden);
    runHidden.mockReset();
    db.exec(`DELETE FROM review_queue; DELETE FROM attempts; DELETE FROM skill_state; DELETE FROM problems;`);
    const { insertProblem } = await import('../services/db.js');
    // No skill rows → the weakest topic is `arrays`; medium is the default.
    insertProblem({
      id: 'p-mock-1', language: 'javascript', title: 'Two Sum', prompt: 'Find the pair.', examples: [], constraints: [],
      difficulty: 'medium', topic: 'arrays', pattern: 'hash map', starterCode: STARTER, functionName: 'twoSum',
      sampleTests: [], hiddenTests: [{ name: 'hidden 1', args: [], expected: 1 }],
      referenceSolution: 'function twoSum(){ /* REF */ }', canonicalized: true, used: false, createdAt: new Date().toISOString(),
    });
  });

  async function startC(body: Record<string, unknown> = {}) {
    fake.interviewerTurn.mockResolvedValueOnce(replyWith({ stage: 'clarify', say: 'Talk me through the problem.' }));
    const res = await post('/api/mock/start', { kind: 'coding', ...body });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, any>;
  }

  it('starts with kind=coding on a bank problem: state.coding, the reference in the context only', async () => {
    const view = await startC();
    expect(view.kind).toBe('coding');
    expect(view.prompt).toBe('Two Sum (medium)');
    expect(view.limits).toEqual({ turnCap: 40, minutes: 45 });
    expect(view.state.stage).toBe('clarify');
    expect(view.state.coding).toMatchObject({ problemId: 'p-mock-1', chosenBy: 'weakest', submits: 0 });
    expect(view.state.plan).toBeUndefined();
    // The reference (frozen into graderContext and the context) never crosses the wire.
    expect(JSON.stringify(view)).not.toContain('REF');
    const [messages, , kind] = fake.interviewerTurn.mock.calls[0];
    expect(kind).toBe('coding');
    expect(messages[0].content).toContain('/* REF */');
    // Marked used, like any served problem.
    const { getProblem } = await import('../services/db.js');
    expect(getProblem('p-mock-1')!.used).toBe(true);
    // The list shows the problem title.
    const list = await (await app.request('/api/mocks')).json();
    expect(list.mocks[0].promptTitle).toBe('Two Sum (medium)');
  });

  it('shows the interviewer the editor only when it changed, and keeps the snapshot for the grader', async () => {
    const view = await startC();
    const code = 'function twoSum(nums, target) {\n  return [0, 1];\n}\n';
    fake.interviewerTurn.mockResolvedValueOnce(replyWith({ stage: 'clarify', say: 'Duplicates are allowed.' }));
    let res = await post(`/api/mock/${view.id}/turn`, { expectedSeq: 1, content: 'Can there be duplicates?', code: STARTER });
    expect(res.status).toBe(200);
    expect(fake.interviewerTurn.mock.calls[1][0].at(-1).content).not.toContain('[editor');

    fake.interviewerTurn.mockResolvedValueOnce(replyWith({ stage: 'code', say: 'Walk me through it.' }));
    res = await post(`/api/mock/${view.id}/turn`, {
      expectedSeq: 3, content: 'Here is a first cut.', code,
      lastRun: { kind: 'run', verdict: 'wrong_answer', passed: 0, total: 2, firstFailure: 'sample 1: expected 1, got 2' },
    });
    const last = fake.interviewerTurn.mock.calls[2][0].at(-1).content as string;
    expect(last).toContain('[editor');
    expect(last).toContain('return [0, 1];');
    expect(last).toContain('[run: Run (sample tests): 0/2 passed, wrong answer');
    const v = await res.json();
    expect(v.state.coding.lastCode).toBe(code);
    // The snapshot is server-side only.
    expect(JSON.stringify(v.turns)).not.toContain('[editor');

    fake.interviewerTurn.mockResolvedValueOnce(replyWith({ stage: 'code', say: 'OK.' }));
    await post(`/api/mock/${view.id}/turn`, { expectedSeq: 5, content: 'No changes yet.', code });
    expect(fake.interviewerTurn.mock.calls[3][0].at(-1).content).not.toContain('[editor');

    // End: the code was never submitted → it runs against the hidden tests now.
    runHidden.mockResolvedValueOnce({ verdict: 'accepted', passed: 1, total: 1, results: [{ name: 'hidden 1', passed: true, timeMs: 1 }] });
    fake.gradeMock.mockResolvedValueOnce({
      grade: { ...GRADE, coding: { patternMissed: false, patternNote: 'found it', complexityStated: 'O(n)', complexityOptimal: 'O(n)', tests: null, reviewQueued: false } },
      metas: [META],
    });
    const events = await readEvents(await post(`/api/mock/${view.id}/end`, { code }));
    expect(runHidden).toHaveBeenCalledWith('p-mock-1', code);
    const input = fake.gradeMock.mock.calls[0][0];
    expect(input.kind).toBe('coding');
    expect(input.transcript).toContain('[editor');
    expect(input.graderContext).toContain('/* REF */');
    expect(input.graderContext).toMatch(/1\/1 passed, accepted — the final editor contents, run at End/);
    const graded = events.find((e: any) => e.type === 'grade');
    expect(graded.grade.coding.tests).toMatchObject({ passed: 1, total: 1, source: 'end' });
    expect(graded.grade.coding.reviewQueued).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM review_queue').get()).toEqual({ n: 0 });
  });

  it('a missed pattern puts the problem on the review queue — the one grind side effect', async () => {
    const view = await startC();
    fake.interviewerTurn.mockResolvedValueOnce(replyWith({ stage: 'approach', say: 'Hm.' }));
    await post(`/api/mock/${view.id}/turn`, { expectedSeq: 1, content: 'Two loops?', code: STARTER });
    fake.gradeMock.mockResolvedValueOnce({
      grade: { ...GRADE, coding: { patternMissed: true, patternNote: 'never saw the map', complexityStated: 'O(n^2)', complexityOptimal: 'O(n)', tests: null, reviewQueued: false } },
      metas: [META],
    });
    const events = await readEvents(await post(`/api/mock/${view.id}/end`, { code: STARTER }));
    // Untouched starter code: nothing ran.
    expect(runHidden).not.toHaveBeenCalled();
    const graded = events.find((e: any) => e.type === 'grade');
    expect(graded.grade.coding).toMatchObject({ reviewQueued: true, tests: null });
    expect(db.prepare('SELECT problemId, reason FROM review_queue').all()).toEqual([{ problemId: 'p-mock-1', reason: 'failed' }]);
    // …and nothing else in the grind.
    expect(db.prepare('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM skill_state').get()).toEqual({ n: 0 });
  });

  it('does not preview a plan (that would fetch or generate a problem)', async () => {
    const p = await (await app.request('/api/mock/plan?kind=coding')).json();
    expect(p).toEqual({ kind: 'coding', concepts: [], reasons: {}, storyBank: null });
    const { getProblem } = await import('../services/db.js');
    expect(getProblem('p-mock-1')!.used).toBe(false);
  });

  it('refuses an oversized editor before spending anything', async () => {
    const view = await startC();
    const res = await post(`/api/mock/${view.id}/turn`, { expectedSeq: 1, content: 'hi', code: 'x'.repeat(50_001) });
    expect(res.status).toBe(400);
    expect(fake.interviewerTurn).toHaveBeenCalledTimes(1);
  });
});
