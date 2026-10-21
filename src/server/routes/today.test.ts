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
const review = vi.hoisted(() => ({ runStepReview: vi.fn() }));
vi.mock('../services/llm.review.js', async (orig) => ({
  ...(await orig<typeof import('../services/llm.review.js')>()),
  runStepReview: review.runStepReview,
}));

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-today-test-'));
if (!TEST_DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run: test DATA_DIR ${TEST_DATA_DIR} is not under ${tmpdir()}`);
}
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.CODEGRIND_TZ = 'America/Los_Angeles';

const { todayRoutes } = await import('./today.js');
const { db, setSetting } = await import('../services/db.js');
const todaySvc = await import('../services/today.service.js');

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
  review.runStepReview.mockReset();
  for (const t of ['daily_sessions', 'mock_gaps', 'mock_grades', 'mocks', 'attempts', 'review_queue', 'problems', 'recognize_attempts', 'ai_usage']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  // The pre-Phase-F tests pin click-only behaviour; Phase F's own block turns reviews on.
  setSetting('ai.reviews', false);
  // Phase G's Envelope ×5 is part of the warm-up; these tests pin the rest of
  // it, so it is off here and on in its own block below.
  setSetting('envelope.daily', 0);
  db.prepare(`DELETE FROM envelope_cards`).run();
  db.prepare(`DELETE FROM envelope_attempts`).run();
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

// =============================================================================
// Phase F: step reviews, the auto debrief, carry-forward, spend, the toggle
// =============================================================================
describe('automatic step reviews (Phase F)', () => {
  const META = {
    servedModel: 'claude-sonnet-5',
    stop: 'tool_use',
    latencyMs: 5,
    usage: { inputTokens: 600, outputTokens: 120, cachedInputTokens: 0 },
  };
  const REVIEW = { result: { note: 'Passed Problem p1 with no hints.', carry: 'State the invariant before coding.' }, meta: META };
  const DEBRIEF = {
    verdict: 'Thin day.',
    wins: [],
    fixes: [{ issue: 'x', action: 'y' }],
    tomorrowFocus: { patterns: [], mockKind: null },
  };
  const get = async () => (await app.request('/api/today')).json();
  const idle = () => todaySvc.aiReviewsIdle();

  beforeEach(() => setSetting('ai.reviews', true));

  it('reviews a finished step once, stores the note, and never re-pays for it', async () => {
    review.runStepReview.mockResolvedValue(REVIEW);
    insertProblem('p1');
    insertAttempt('a1', 'p1', '2026-10-21T16:10:00.000Z', true);

    const first = await get();
    expect(first.aiPending).toEqual(['problem1']);
    // A second GET during the job: deduped, no second call.
    await get();
    await idle();
    expect(review.runStepReview).toHaveBeenCalledTimes(1);
    const input = review.runStepReview.mock.calls[0][0];
    expect(input.step).toBe('Problem 1');
    expect(input.digest[0]).toMatch(/Problem p1.*PASSED/);

    const body = await get();
    await idle();
    expect(body.aiPending).toEqual([]);
    expect(body.stepNotes.problem1).toMatchObject({ note: REVIEW.result.note, carry: REVIEW.result.carry, model: 'claude-sonnet-5' });
    expect(body.stepNotes.problem1.costUsd).toBeCloseTo((600 * 2 + 120 * 10) / 1e6, 8);
    expect(review.runStepReview).toHaveBeenCalledTimes(1);
  });

  it('a failing model costs at most MAX_AI_ATTEMPTS calls a day, spaced by the cooldown — never a loop', async () => {
    review.runStepReview.mockRejectedValue(new Error('model down'));
    insertProblem('p1');
    insertAttempt('a1', 'p1', '2026-10-21T16:10:00.000Z', true);

    for (let i = 0; i < 5; i++) {
      await get();
      await idle();
    }
    expect(review.runStepReview).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(NOW.getTime() + 6 * 60_000)); // past the cooldown
    await get();
    await idle();
    expect(review.runStepReview).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date(NOW.getTime() + 60 * 60_000)); // budget spent
    for (let i = 0; i < 5; i++) {
      await get();
      await idle();
    }
    expect(review.runStepReview).toHaveBeenCalledTimes(2);
    expect((await get()).stepNotes.problem1).toBeUndefined();
  });

  it('a job still running past midnight writes to ITS day, not the next one (Phase H)', async () => {
    const before = new Date('2026-10-21T06:59:50.000Z'); // 23:59:50 PDT, Oct 20
    vi.setSystemTime(before);
    insertProblem('p1');
    insertAttempt('a1', 'p1', '2026-10-21T06:30:00.000Z', true);
    review.runStepReview.mockImplementation(async () => {
      vi.setSystemTime(new Date('2026-10-21T07:00:20.000Z')); // the call lands after midnight
      return REVIEW;
    });
    expect((await get()).date).toBe('2026-10-20');
    await todaySvc.aiReviewsIdle(before);
    const row = (d: string) => db.prepare(`SELECT stepNotes FROM daily_sessions WHERE date = ?`).get(d) as { stepNotes: string | null } | undefined;
    expect(JSON.parse(row('2026-10-20')!.stepNotes!).problem1.note).toBe(REVIEW.result.note);
    expect(row('2026-10-21')?.stepNotes ?? null).toBeNull();
  });

  it('the auto debrief waits for an open mock, then regenerates ONCE when a later grade lands (Phase H)', async () => {
    review.runStepReview.mockResolvedValue(REVIEW);
    fake.runDebrief.mockResolvedValue({ debrief: DEBRIEF, meta: META });
    insertProblem('p1');
    insertAttempt('a1', 'p1', '2026-10-21T16:10:00.000Z', true);
    insertMock('m1', 'active', '2026-10-21T17:00:00.000Z');
    await post('/api/today/end');
    await idle();
    // Every step is settled, but a mock is still running: no debrief yet.
    expect(fake.runDebrief).not.toHaveBeenCalled();

    db.prepare(`UPDATE mocks SET status = 'graded' WHERE id = 'm1'`).run();
    db.prepare(
      `INSERT INTO mock_grades (mockId, level, verdict, grade, usage, createdAt) VALUES ('m1', 'staff', 'at', '{}', '{}', '2026-10-21T19:30:00.000Z')`
    ).run();
    await get();
    await idle();
    expect(fake.runDebrief).toHaveBeenCalledTimes(1);

    // A second mock graded AFTER the debrief makes it stale: rewritten once.
    vi.setSystemTime(new Date('2026-10-21T21:00:00.000Z'));
    insertMock('m2', 'graded', '2026-10-21T20:30:00.000Z', 'below');
    db.prepare(`UPDATE mock_grades SET createdAt = '2026-10-21T20:55:00.000Z' WHERE mockId = 'm2'`).run();
    await get();
    await idle();
    expect(fake.runDebrief).toHaveBeenCalledTimes(2);

    // ...and never again automatically, whatever lands later.
    vi.setSystemTime(new Date('2026-10-21T22:00:00.000Z'));
    insertMock('m3', 'graded', '2026-10-21T21:30:00.000Z', 'at');
    db.prepare(`UPDATE mock_grades SET createdAt = '2026-10-21T21:55:00.000Z' WHERE mockId = 'm3'`).run();
    for (let i = 0; i < 3; i++) {
      await get();
      await idle();
    }
    expect(fake.runDebrief).toHaveBeenCalledTimes(2);
  });

  it('ending the day early writes the step notes, then the debrief with them as input', async () => {
    review.runStepReview.mockResolvedValue(REVIEW);
    fake.runDebrief.mockResolvedValue({ debrief: DEBRIEF, meta: META });
    insertProblem('p1');
    insertAttempt('a1', 'p1', '2026-10-21T16:10:00.000Z', true);

    const ended = await (await post('/api/today/end')).json();
    expect(ended.aiPending).toEqual(['problem1', 'debrief']);
    await idle();
    expect(review.runStepReview).toHaveBeenCalledTimes(1);
    expect(fake.runDebrief).toHaveBeenCalledTimes(1);
    // Notes only: a carry is an instruction, not evidence (Phase H).
    expect(fake.runDebrief.mock.calls[0][0].stepNotes).toEqual([{ step: 'Problem 1', note: REVIEW.result.note, carry: '' }]);
    const body = await get();
    await idle();
    expect(body.debrief.verdict).toBe('Thin day.');
    expect(fake.runDebrief).toHaveBeenCalledTimes(1);
  });

  it('no auto debrief for a day with nothing done', async () => {
    await post('/api/today/end');
    await idle();
    await get();
    await idle();
    expect(fake.runDebrief).not.toHaveBeenCalled();
    expect(review.runStepReview).not.toHaveBeenCalled();
  });

  it('the toggle gates every automatic call', async () => {
    setSetting('ai.reviews', false);
    review.runStepReview.mockResolvedValue(REVIEW);
    fake.runDebrief.mockResolvedValue({ debrief: DEBRIEF, meta: META });
    insertProblem('p1');
    insertAttempt('a1', 'p1', '2026-10-21T16:10:00.000Z', true);
    const body = await (await post('/api/today/end')).json();
    await idle();
    expect(body.aiReviews).toBe(false);
    expect(body.aiPending).toEqual([]);
    expect(review.runStepReview).not.toHaveBeenCalled();
    expect(fake.runDebrief).not.toHaveBeenCalled();
    // The click still works.
    expect((await post('/api/today/debrief')).status).toBe(200);
    expect(fake.runDebrief).toHaveBeenCalledTimes(1);
  });

  it('carries today\'s notes into later context', async () => {
    review.runStepReview.mockResolvedValue(REVIEW);
    insertProblem('p1');
    insertAttempt('a1', 'p1', '2026-10-21T16:10:00.000Z', true);
    await get();
    await idle();
    expect(todaySvc.todayCarryNotes()).toEqual([{ step: 'Problem 1', note: REVIEW.result.note, carry: REVIEW.result.carry }]);
    // The second problem's review sees the first one's note.
    insertProblem('p2');
    insertAttempt('a2', 'p2', '2026-10-21T17:10:00.000Z', false);
    await get();
    await idle();
    expect(review.runStepReview.mock.calls[1][0].earlier).toEqual([
      { step: 'Problem 1', note: REVIEW.result.note, carry: REVIEW.result.carry },
    ]);
    // Tomorrow starts clean.
    expect(todaySvc.todayCarryNotes(new Date('2026-10-22T20:00:00.000Z'))).toEqual([]);
  });

  it('sums AI spend for today and this month from the ledger', async () => {
    const ins = db.prepare(
      `INSERT INTO ai_usage (at, source, role, model, inputTokens, outputTokens, costUsd) VALUES (?, 'x', 'small', 'm', 1, 1, ?)`
    );
    ins.run('2026-10-21T16:00:00.000Z', 0.25); // today (LA)
    ins.run('2026-10-21T03:00:00.000Z', 0.5); // yesterday evening in LA, same month
    ins.run('2026-10-01T08:00:00.000Z', 1); // Oct 1, 1am LA
    ins.run('2026-10-01T06:00:00.000Z', 2); // Sep 30, 11pm LA: last month
    ins.run('2026-10-21T17:00:00.000Z', null); // an unpriced local call: counted, $0
    const body = await get();
    expect(body.spend.todayUsd).toBeCloseTo(0.25, 8);
    expect(body.spend.todayCalls).toBe(2);
    expect(body.spend.monthUsd).toBeCloseTo(1.75, 8);
    expect(body.spend.monthCalls).toBe(4);
  });

  it('today\'s Recognize misses become the scheduler\'s miss focus', () => {
    insertProblem('p1');
    const ins = db.prepare(
      `INSERT INTO recognize_attempts (problemId, topic, picked, patternCorrect, approach, selfGrade, grade, createdAt)
       VALUES ('p1', ?, NULL, 0, '', ?, ?, ?)`
    );
    ins.run('heap', 'missed', 'missed', '2026-10-21T16:00:00.000Z');
    ins.run('trie', 'got', 'got', '2026-10-21T16:01:00.000Z');
    ins.run('graphs', 'missed', 'missed', '2026-10-20T16:00:00.000Z'); // yesterday
    expect(todaySvc.todayMissTopics()).toEqual(['heap']);
  });
});

describe('smarter picks: today\'s misses bias problem1/2 (Phase F)', () => {
  it('adds a small, deterministic lean to a missed topic and nothing else', async () => {
    const { buildCandidates } = await import('../services/scheduler.service.js');
    const { tierProgress } = await import('../services/curriculum.js');
    const { MISS_FOCUS_BIAS, DAILY_FOCUS_BIAS } = await import('../services/today.compute.js');
    const view = (topic: 'heap' | 'trie') => ({
      topic,
      attempts: 3,
      solved: 2,
      mastery: 0.3,
      tier: tierProgress(),
      currentDifficulty: 'easy' as const,
      box: 1,
      streak: 1,
      lastResult: 'solved' as const,
      lastSeenAt: '2026-10-20T00:00:00.000Z',
      dueAt: null,
      overdue: false,
      staleDays: 1,
      failedLast: false,
    });
    const views = [view('heap'), view('trie')];
    const plain = buildCandidates(views);
    const biased = buildCandidates(views, undefined, undefined, ['heap']);
    expect(buildCandidates(views, undefined, undefined, ['heap'])).toEqual(biased); // deterministic
    expect(biased.map((c) => c.kind)).toEqual(plain.map((c) => c.kind));
    biased.forEach((c, i) => {
      expect(c.score - plain[i].score).toBeCloseTo(c.topic === 'heap' ? MISS_FOCUS_BIAS : 0, 10);
    });
    const top = [...biased].sort((a, b) => b.score - a.score)[0];
    expect(top.topic).toBe('heap');
    expect(MISS_FOCUS_BIAS).toBeLessThan(DAILY_FOCUS_BIAS);
  });
});
