// =============================================================================
// routes/home — GET /api/home/weekly against a real (temporary) database
// =============================================================================
// Pinned: the payload shape, the ?days clamp, an empty database, and that the
// mock nudge fields read real mock rows. No model call is made by this route.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-home-test-'));
if (!TEST_DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run: test DATA_DIR ${TEST_DATA_DIR} is not under ${tmpdir()}`);
}
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.CODEGRIND_TZ = 'America/Los_Angeles';

const { homeRoutes } = await import('./home.js');
const { db, setSetting } = await import('../services/db.js');

const app = new Hono();
app.route('/api', homeRoutes);

// Tuesday 1pm in Los Angeles.
const NOW = new Date('2026-10-21T20:00:00.000Z');

afterAll(() => {
  vi.useRealTimers();
  db.close();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function insertProblem(id: string, topic = 'arrays') {
  db.prepare(
    `INSERT INTO problems (id, title, prompt, examples, constraints, difficulty, topic, pattern, starterCode,
       functionName, sampleTests, hiddenTests, referenceSolution, used, createdAt, language)
     VALUES (?, ?, 'p', '[]', '[]', 'easy', ?, ?, '', 'f', '[]', '[]', '', 1, ?, 'javascript')`
  ).run(id, `Problem ${id}`, topic, topic, '2026-10-01T00:00:00.000Z');
}

function insertAttempt(id: string, problemId: string, at: string, solved = true, pattern = 'arrays', passed = 3) {
  db.prepare(
    `INSERT INTO attempts (id, problemId, pattern, difficulty, solved, hintsUsed, testsPassed, testsTotal, code, createdAt, language)
     VALUES (?, ?, ?, 'easy', ?, 0, ?, 4, '', ?, 'javascript')`
  ).run(id, problemId, pattern, solved ? 1 : 0, passed, at);
}

function insertMock(id: string, status: string, at: string) {
  db.prepare(
    `INSERT INTO mocks (id, kind, level, promptId, prompt, status, context, state, usage, createdAt, updatedAt, endedAt)
     VALUES (?, 'system-design', 'staff', NULL, 'Design a thing', ?, '', '{}', '{}', ?, ?, ?)`
  ).run(id, status, at, at, at);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  for (const t of ['daily_sessions', 'mock_gaps', 'mock_grades', 'mocks', 'attempts', 'review_queue', 'problems', 'recognize_attempts', 'sessions', 'envelope_attempts']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  setSetting('ai.reviews', false);
});

describe('GET /api/home/weekly', () => {
  it('an empty database: a full 7-day window of zeros and a target', async () => {
    const res = await app.request('/api/home/weekly');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      days: 7,
      from: '2026-10-15',
      to: '2026-10-21',
      activeDays: 0,
      volume: { subs: 0, problems: 0, grindSubs: 0, freeSubs: 0 },
      topics: [],
      nearMisses: { count: 0, fixed: 0, fixedUnaided: 0 },
      recognize: [],
      envelope: { n: 0, ok: 0, okPct: 0, days: 0 },
      reviewDue: [],
      mocks: { thisWeek: 0, lastAt: null },
    });
    expect(body.daily).toHaveLength(7);
    expect(body.daily[6]).toEqual({ date: '2026-10-21', subs: 0, grind: 0, solved: 0, practiced: false });
    expect(typeof body.target.reason).toBe('string');
    expect(body.target.href).toMatch(/^\//);
    expect(Array.isArray(body.untouched)).toBe(true);
  });

  it('clamps ?days to 1..60 and falls back to 7', async () => {
    expect((await (await app.request('/api/home/weekly?days=0')).json()).days).toBe(1);
    expect((await (await app.request('/api/home/weekly?days=999')).json()).days).toBe(60);
    expect((await (await app.request('/api/home/weekly?days=abc')).json()).days).toBe(7);
    const one = await (await app.request('/api/home/weekly?days=1')).json();
    expect(one.daily).toHaveLength(1);
  });

  it('counts attempts, near misses and the mocks of the week', async () => {
    insertProblem('p1');
    insertProblem('p2');
    insertAttempt('a1', 'p1', '2026-10-20T17:00:00.000Z', false, 'arrays', 3); // near miss 3/4
    insertAttempt('a2', 'p1', '2026-10-20T17:30:00.000Z', true);
    insertAttempt('a3', 'p2', '2026-10-21T17:00:00.000Z', true);
    insertAttempt('old', 'p2', '2026-09-01T17:00:00.000Z', true); // outside the window
    insertMock('m1', 'graded', '2026-10-19T18:00:00.000Z');
    insertMock('m0', 'abandoned', '2026-10-20T18:00:00.000Z');

    const body = await (await app.request('/api/home/weekly')).json();
    expect(body.volume).toEqual({ subs: 3, problems: 2, grindSubs: 0, freeSubs: 3 });
    expect(body.activeDays).toBe(3); // Oct 19 (mock), 20, 21
    expect(body.topics[0]).toMatchObject({ topic: 'arrays', attempts: 3, solved: 2, nearMisses: 1 });
    expect(body.nearMisses).toEqual({ count: 1, fixed: 1, fixedUnaided: 1 });
    expect(body.mocks).toEqual({ thisWeek: 1, lastAt: '2026-10-19T18:00:00.000Z' });
    expect(body.untouched).not.toContain('arrays');
  });

  it('an overdue review becomes the target', async () => {
    insertProblem('r1', 'stack');
    db.prepare(`INSERT INTO review_queue (problemId, reason, dueAt, createdAt) VALUES ('r1', 'failed', ?, ?)`).run(
      '2026-10-18T00:00:00.000Z',
      '2026-10-17T00:00:00.000Z',
    );
    const body = await (await app.request('/api/home/weekly')).json();
    expect(body.reviewDue).toEqual([{ topic: 'stack', due: 1, overdue: 1 }]);
    expect(body.target).toMatchObject({ kind: 'review', topic: 'stack', href: '/grind' });
  });
});
