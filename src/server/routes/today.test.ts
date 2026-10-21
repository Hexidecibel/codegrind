// =============================================================================
// routes/today — the routine over HTTP, against a real (temporary) database
// =============================================================================
// The debrief's one model call is faked; everything else is real. Pinned:
//   * GET derives the day from rows other features wrote — no stored step state.
//   * skip / end-early persist and move the current step.
//   * the debrief is locked until the mock is settled, is cached per day, and
//     only a `regenerate` makes a second call.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fake = vi.hoisted(() => ({ runDebrief: vi.fn() }));
vi.mock('../services/llm.debrief.js', () => fake);

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-today-test-'));
if (!TEST_DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run: test DATA_DIR ${TEST_DATA_DIR} is not under ${tmpdir()}`);
}
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.CODEGRIND_TZ = 'America/Los_Angeles';

const { todayRoutes } = await import('./today.js');
const { db } = await import('../services/db.js');

const app = new Hono();
app.route('/api', todayRoutes);

// Tuesday 1pm in Los Angeles.
const NOW = new Date('2026-10-21T20:00:00.000Z');

afterAll(() => {
  vi.useRealTimers();
  db.close();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const post = (url: string, body?: unknown) =>
  app.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

function insertProblem(id: string) {
  db.prepare(
    `INSERT INTO problems (id, title, prompt, examples, constraints, difficulty, topic, pattern, starterCode,
       functionName, sampleTests, hiddenTests, referenceSolution, used, createdAt, language)
     VALUES (?, ?, 'p', '[]', '[]', 'easy', 'arrays', 'arrays', '', 'f', '[]', '[]', '', 1, ?, 'javascript')`
  ).run(id, `Problem ${id}`, '2026-10-01T00:00:00.000Z');
}

function insertAttempt(id: string, problemId: string, at: string, solved = true) {
  db.prepare(
    `INSERT INTO attempts (id, problemId, pattern, difficulty, solved, hintsUsed, testsPassed, testsTotal, code, createdAt, language)
     VALUES (?, ?, 'arrays', 'easy', ?, 0, 3, 3, '', ?, 'javascript')`
  ).run(id, problemId, solved ? 1 : 0, at);
}

function insertMock(id: string, status: string, at: string, verdict?: 'below' | 'at' | 'above') {
  db.prepare(
    `INSERT INTO mocks (id, kind, level, promptId, prompt, status, context, state, usage, createdAt, updatedAt)
     VALUES (?, 'system-design', 'staff', NULL, 'Design a thing', ?, '', '{}', '{}', ?, ?)`
  ).run(id, status, at, at);
  if (verdict) {
    db.prepare(
      `INSERT INTO mock_grades (mockId, level, verdict, grade, usage, createdAt) VALUES (?, 'staff', ?, ?, '{}', ?)`
    ).run(id, verdict, JSON.stringify({ summary: 'Solid on scale.', gaps: [{ concept: 'x', title: 'Shard keys?' }] }), at);
  }
}

function insertCard(mockId: string, createdAt: string, dueAt: string) {
  db.prepare(
    `INSERT INTO mock_gaps (mockId, concept, summary, dueAt, createdAt) VALUES (?, 'caching', 's', ?, ?)`
  ).run(mockId, dueAt, createdAt);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fake.runDebrief.mockReset();
  for (const t of ['daily_sessions', 'mock_gaps', 'mock_grades', 'mocks', 'attempts', 'review_queue', 'problems']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

describe('GET /api/today', () => {
  it('a fresh day: warm-up done (nothing due), problem 1 current, debrief locked', async () => {
    const body = await (await app.request('/api/today')).json();
    expect(body.date).toBe('2026-10-21');
    expect(body.current).toBe('problem1');
    expect(body.mockKind).toBe('system-design');
    expect(body.steps.map((s: { status: string }) => s.status)).toEqual(['done', 'current', 'todo', 'todo', 'locked']);
    expect(body.readiness.map((a: { id: string }) => a.id)).toEqual(['algos', 'system-design', 'behavioral', 'coding']);
  });

  it('derives every step from real rows', async () => {
    // Yesterday's mock left a card due now; today's mock made a card that must NOT reopen the warm-up.
    insertMock('old', 'graded', '2026-10-19T18:00:00.000Z', 'at');
    insertCard('old', '2026-10-19T18:30:00.000Z', '2026-10-21T00:00:00.000Z');

    let body = await (await app.request('/api/today')).json();
    expect(body.current).toBe('warmup');
    expect(body.steps[0].href).toContain('#cards');

    db.prepare(`UPDATE mock_gaps SET dueAt = ?, lastReviewedAt = ?, lastGrade = 'got'`).run(
      '2026-10-23T00:00:00.000Z',
      '2026-10-21T16:00:00.000Z'
    );
    insertProblem('p1');
    insertProblem('p2');
    insertAttempt('a1', 'p1', '2026-10-21T16:10:00.000Z', true);
    insertAttempt('a2', 'p2', '2026-10-21T16:40:00.000Z', false);
    // 3am UTC today is still YESTERDAY in Los Angeles: not today's.
    insertProblem('p0');
    insertAttempt('a0', 'p0', '2026-10-21T03:00:00.000Z', true);
    insertMock('m1', 'graded', '2026-10-21T17:00:00.000Z', 'above');
    insertCard('m1', '2026-10-21T18:00:00.000Z', '2026-10-21T18:00:00.000Z');

    body = await (await app.request('/api/today')).json();
    expect(body.steps.map((s: { status: string }) => s.status)).toEqual(['done', 'done', 'done', 'done', 'current']);
    expect(body.steps[0].result).toMatch(/Cleared 1/);
    expect(body.steps[1].result).toMatch(/^Passed · Problem p1/);
    expect(body.steps[2].result).toMatch(/^Failed · Problem p2/);
    expect(body.steps[3].result).toBe('above level');
    expect(body.attemptedProblemIds).toEqual(['p1', 'p2']);
    expect(body.streak).toBeGreaterThanOrEqual(2);
  });
});

describe('skip and end early', () => {
  it('a skip persists and moves the current step; un-skip restores it', async () => {
    let body = await (await post('/api/today/skip', { step: 'problem1' })).json();
    expect(body.current).toBe('problem2');
    body = await (await app.request('/api/today')).json();
    expect(body.steps[1].status).toBe('skipped');
    body = await (await post('/api/today/skip', { step: 'problem1', skip: false })).json();
    expect(body.current).toBe('problem1');
  });

  it('refuses to skip the debrief or a made-up step', async () => {
    expect((await post('/api/today/skip', { step: 'debrief' })).status).toBe(400);
    expect((await post('/api/today/skip', { step: 'nap' })).status).toBe(400);
  });

  it('ending early skips the rest and unlocks the debrief', async () => {
    const body = await (await post('/api/today/end')).json();
    expect(body.endedEarly).toBe(true);
    expect(body.current).toBe('debrief');
    expect(body.steps.slice(1, 4).map((s: { status: string }) => s.status)).toEqual(['skipped', 'skipped', 'skipped']);
  });
});

describe('POST /api/today/debrief', () => {
  const DEBRIEF = {
    verdict: 'Good reps, shaky complexity calls.',
    wins: ['Passed p1 first try'],
    fixes: [{ issue: 'Predicted O(n) wrote O(n^2)', action: 'Two sliding-window problems tomorrow' }],
    tomorrowFocus: { patterns: ['sliding-window'], mockKind: null },
  };
  const META = {
    servedModel: 'claude-sonnet-5',
    stop: 'tool_use',
    latencyMs: 5,
    usage: { inputTokens: 1500, outputTokens: 400, cachedInputTokens: 0 },
  };

  it('is locked until the mock is settled, and never calls the model then', async () => {
    const res = await post('/api/today/debrief');
    expect(res.status).toBe(409);
    expect(fake.runDebrief).not.toHaveBeenCalled();
  });

  it('calls once, caches for the day, and regenerates only on request', async () => {
    fake.runDebrief.mockResolvedValue({ debrief: DEBRIEF, meta: META });
    await post('/api/today/end');
    insertProblem('p1');
    insertAttempt('a1', 'p1', '2026-10-21T16:10:00.000Z', true);

    let body = await (await post('/api/today/debrief')).json();
    expect(fake.runDebrief).toHaveBeenCalledTimes(1);
    expect(body.debrief.verdict).toBe(DEBRIEF.verdict);
    expect(body.debriefUsage.costUsd).toBeCloseTo((1500 * 2 + 400 * 10) / 1e6, 6);
    expect(body.current).toBeNull();

    // The digest it read: today's problem, nothing from the model's side.
    const digest = fake.runDebrief.mock.calls[0][0];
    expect(digest.attempts).toHaveLength(1);
    expect(digest.attempts[0]).toMatchObject({ title: 'Problem p1', solved: true, review: false });

    body = await (await post('/api/today/debrief')).json();
    expect(fake.runDebrief).toHaveBeenCalledTimes(1); // cached
    expect(body.debrief.verdict).toBe(DEBRIEF.verdict);

    await post('/api/today/debrief', { regenerate: true });
    expect(fake.runDebrief).toHaveBeenCalledTimes(2);
  });

  it('a failed call stores nothing', async () => {
    fake.runDebrief.mockRejectedValue(new Error('model down'));
    await post('/api/today/end');
    const res = await post('/api/today/debrief');
    expect(res.status).toBe(502);
    const body = await (await app.request('/api/today')).json();
    expect(body.debrief).toBeNull();
  });

  it("tomorrow's day leans on today's focus", async () => {
    fake.runDebrief.mockResolvedValue({ debrief: DEBRIEF, meta: META });
    await post('/api/today/end');
    await post('/api/today/debrief');
    vi.setSystemTime(new Date('2026-10-22T20:00:00.000Z'));
    const body = await (await app.request('/api/today')).json();
    expect(body.date).toBe('2026-10-22');
    expect(body.focus).toEqual(['sliding-window']);
    expect(body.debrief).toBeNull();
    const { dailyFocus } = await import('../services/today.service.js');
    expect(dailyFocus()).toEqual(['sliding-window']);
  });
});
