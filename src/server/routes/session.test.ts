// =============================================================================
// session route — "Next" on a review you did not attempt is a skip
// =============================================================================
// THE BUG THIS PINS: a due review outranks everything, and a review only left
// the due set on a clean solve or a failed submit. Clicking "Next problem" did
// neither, so POST /session/:id/next found the same earliest-due row and served
// the same problem back, every time, with every other review and all normal
// scheduling stuck behind it.
//
// The fix is one write before the pick: the client names the review it is
// leaving and the route snoozes it if it is still due. The tests below are about
// what that write must NOT do as much as what it does — it must not count as a
// miss, must not touch a row a verdict already moved, and must not fire for a
// client that sends no body at all.

import { describe as suite, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SchedulerIntent } from '../services/scheduler.service.js';

// No model and no sandbox in a unit test. A review is re-served straight from
// the bank, so the real getAdaptiveProblem handles it; any OTHER intent would
// generate a problem, and that is stubbed to a marker record instead.
const GENERATED_ID = 'p-generated-stub';
vi.mock('../services/sandbox.service.js', () => ({ runTests: vi.fn() }));
vi.mock('../services/llm.service.js', () => ({ planSession: vi.fn() }));
vi.mock('../services/bank.service.js', async () => {
  const dbMod = await import('../services/db.js');
  return {
    getAdaptiveProblem: vi.fn(async (intent: SchedulerIntent) => {
      if (intent.kind === 'review' && intent.reviewProblemId) {
        const existing = dbMod.getProblem(intent.reviewProblemId);
        if (existing) return existing;
      }
      return { ...dbMod.getProblem('p-review-a')!, id: GENERATED_ID, topic: intent.topic };
    }),
  };
});

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-session-test-'));
if (!TEST_DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run: test DATA_DIR ${TEST_DATA_DIR} is not under ${tmpdir()}`);
}
process.env.DATA_DIR = TEST_DATA_DIR;

const { sessionRoutes } = await import('./session.js');
const db = await import('../services/db.js');

const app = new Hono();
app.route('/api', sessionRoutes);

const A = 'p-review-a';
const B = 'p-review-b';
const SESSION = 'sess-1';
const DAY = 24 * 60 * 60 * 1000;
const PLAN = { theme: 't', coachIntro: 'i', focus: [] };

function bankProblem(id: string, topic: 'arrays' | 'hashing' = 'arrays'): void {
  db.insertProblem({
    id,
    language: 'javascript',
    title: `Problem ${id}`,
    prompt: 'Do the thing.',
    examples: [],
    constraints: [],
    difficulty: 'easy',
    topic,
    pattern: 'hash map',
    starterCode: 'function f() {}',
    functionName: 'f',
    sampleTests: [{ name: 'sample 1', args: [1], expected: 1 }],
    hiddenTests: [{ name: 'hidden 1', args: [1], expected: 1 }],
    referenceSolution: 'function f(x){ return x; }',
    canonicalized: true,
    used: true,
    createdAt: new Date().toISOString(),
  });
}

interface Row {
  problemId: string;
  dueAt: string;
  attempts: number;
  clearedAt: string | null;
}
function row(id: string): Row {
  return db.db.prepare('SELECT * FROM review_queue WHERE problemId = ?').get(id) as Row;
}

/** Put a review row in an exact state — the ladder is under test, so no helpers. */
function setReview(id: string, dueAt: string, attempts: number, clearedAt: string | null = null): void {
  db.db
    .prepare(
      `INSERT OR REPLACE INTO review_queue (problemId, reason, dueAt, attempts, clearedAt, createdAt)
       VALUES (?, 'failed', ?, ?, ?, ?)`,
    )
    .run(id, dueAt, attempts, clearedAt, new Date().toISOString());
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
const daysFromNow = (iso: string) => (Date.parse(iso) - Date.now()) / DAY;

async function next(body?: unknown, raw?: string) {
  const init: RequestInit = { method: 'POST' };
  if (raw !== undefined) {
    init.body = raw;
    init.headers = { 'Content-Type': 'application/json' };
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const res = await app.request(`/api/session/${SESSION}/next`, init);
  return { status: res.status, json: (await res.json()) as any };
}

beforeEach(() => {
  for (const table of ['attempts', 'skill_state', 'review_queue', 'problems', 'sessions']) {
    db.db.prepare(`DELETE FROM ${table}`).run();
  }
  bankProblem(A);
  bankProblem(B, 'hashing');
  db.createSession('javascript', SESSION, PLAN);
});

afterAll(() => {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

suite('snoozeReview', () => {
  it('pushes a due review out and does not count it as a miss', () => {
    setReview(A, ago(26 * DAY), 2);
    expect(db.snoozeReview(A)).toBe(true);
    const r = row(A);
    expect(r.attempts).toBe(2);
    expect(r.clearedAt).toBeNull();
    // attempts 2 is the +5d rung.
    expect(daysFromNow(r.dueAt)).toBeGreaterThan(4.99);
    expect(daysFromNow(r.dueAt)).toBeLessThan(5.01);
  });

  it('snoozes a never-missed review by the first real rung, not by zero', () => {
    // attempts 0 reads rung 0 = "due now", which would snooze nothing and
    // re-serve the same problem — the original bug by another road.
    setReview(A, ago(1000), 0);
    expect(db.snoozeReview(A)).toBe(true);
    const r = row(A);
    expect(r.attempts).toBe(0);
    expect(daysFromNow(r.dueAt)).toBeGreaterThan(1.99);
    expect(daysFromNow(r.dueAt)).toBeLessThan(2.01);
    expect(db.getDueReview('javascript')).toBeNull();
  });

  it('leaves a cleared row alone', () => {
    const due = ago(DAY);
    const cleared = ago(1000);
    setReview(A, due, 1, cleared);
    expect(db.snoozeReview(A)).toBe(false);
    expect(row(A)).toMatchObject({ dueAt: due, attempts: 1, clearedAt: cleared });
  });

  it('leaves a row that is not due yet alone', () => {
    // The state a failed submit leaves behind: already pushed out. A skip on
    // top of that must not push it again.
    const due = ahead(2 * DAY);
    setReview(A, due, 1);
    expect(db.snoozeReview(A)).toBe(false);
    expect(row(A)).toMatchObject({ dueAt: due, attempts: 1, clearedAt: null });
  });

  it('is a no-op for a problem that was never queued', () => {
    expect(db.snoozeReview('p-nope')).toBe(false);
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM review_queue').get()).toEqual({ n: 0 });
  });
});

suite('POST /api/session/:id/next — skipping a due review', () => {
  it('serves the second due review when the first is named as skipped', async () => {
    setReview(A, ago(26 * DAY), 1);
    setReview(B, ago(3 * DAY), 0);

    const { status, json } = await next({ skipProblemId: A });
    expect(status).toBe(200);
    expect(json.why.kind).toBe('review');
    expect(json.problem.id).toBe(B);

    expect(row(A).attempts).toBe(1);
    expect(daysFromNow(row(A).dueAt)).toBeGreaterThan(1.99);
    // B was served, not skipped — still due until it is submitted.
    expect(daysFromNow(row(B).dueAt)).toBeLessThan(0);
  });

  it('moves on to normal scheduling once the only due review is skipped', async () => {
    setReview(A, ago(26 * DAY), 1);
    const { status, json } = await next({ skipProblemId: A });
    expect(status).toBe(200);
    expect(json.why.kind).not.toBe('review');
    expect(json.problem.id).toBe(GENERATED_ID);
    // Computed AFTER the snooze: nothing is due, so the peek must not promise one.
    expect(json.upNext).not.toBe('a review problem to solve cold');
  });

  it('does not stop skipping at one: three clicks walk three reviews', async () => {
    // The reported symptom, end to end — each click names what is on screen.
    setReview(A, ago(26 * DAY), 1);
    setReview(B, ago(3 * DAY), 1);
    const first = await next();
    expect(first.json.problem.id).toBe(A);
    const second = await next({ skipProblemId: first.json.problem.id });
    expect(second.json.problem.id).toBe(B);
    const third = await next({ skipProblemId: second.json.problem.id });
    expect(third.json.why.kind).not.toBe('review');
  });

  it('with no body, serves the earliest due review exactly as before', async () => {
    setReview(A, ago(26 * DAY), 1);
    setReview(B, ago(3 * DAY), 0);
    const before = [row(A), row(B)];

    const { status, json } = await next();
    expect(status).toBe(200);
    expect(json.problem.id).toBe(A);
    expect(json.why.kind).toBe('review');
    expect(json.upNext).toBe('a review problem to solve cold');
    expect([row(A), row(B)]).toEqual(before);
  });

  it('treats `{}` (a client cached from before the field existed) the same', async () => {
    setReview(A, ago(26 * DAY), 1);
    const before = row(A);
    const { status, json } = await next({});
    expect(status).toBe(200);
    expect(json.problem.id).toBe(A);
    expect(row(A)).toEqual(before);
  });

  it('ignores a malformed body or a non-string id rather than failing', async () => {
    setReview(A, ago(26 * DAY), 1);
    const before = row(A);
    for (const attempt of [
      () => next(undefined, '{not json'),
      () => next({ skipProblemId: 42 }),
      () => next({ skipProblemId: '' }),
      () => next({ skipProblemId: 'p-does-not-exist' }),
      () => next([A]),
    ]) {
      const { status, json } = await attempt();
      expect(status).toBe(200);
      expect(json.problem.id).toBe(A);
    }
    expect(row(A)).toEqual(before);
  });

  it('does not snooze a review that was just solved clean', async () => {
    // What submit leaves behind on a clean solve: cleared. "Next" then names it.
    setReview(A, ago(26 * DAY), 1);
    setReview(B, ago(3 * DAY), 0);
    db.clearReview(A);
    const before = row(A);
    const { json } = await next({ skipProblemId: A });
    expect(row(A)).toEqual(before);
    expect(json.problem.id).toBe(B);
  });

  it('does not push a review further after a failed submit already did', async () => {
    setReview(A, ago(26 * DAY), 1);
    db.bumpReviewOnFail(A); // attempts 2, +5d
    const before = row(A);
    expect(before.attempts).toBe(2);
    await next({ skipProblemId: A });
    expect(row(A)).toEqual(before);
  });

  it('still 404s an unknown session, and snoozes nothing on the way', async () => {
    setReview(A, ago(26 * DAY), 1);
    const before = row(A);
    const res = await app.request('/api/session/nope/next', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipProblemId: A }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'session not found' });
    expect(row(A)).toEqual(before);
  });
});
