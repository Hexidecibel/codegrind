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
const scheduler = await import('../services/scheduler.service.js');
const llm = await import('../services/llm.service.js');

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
function setReview(id: string, dueAt: string, attempts: number, clearedAt: string | null = null, rung = 0): void {
  db.db
    .prepare(
      `INSERT OR REPLACE INTO review_queue (problemId, reason, dueAt, attempts, clearedAt, createdAt, rung)
       VALUES (?, 'failed', ?, ?, ?, ?, ?)`,
    )
    .run(id, dueAt, attempts, clearedAt, new Date().toISOString(), rung);
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
    setReview(A, ago(26 * DAY), 2, null, 2);
    expect(db.snoozeReview(A)).toBe(true);
    const r = row(A);
    expect(r.attempts).toBe(2);
    expect(r.clearedAt).toBeNull();
    // rung 2 is the +7d rung (review-ladder RUNG_DAYS).
    expect(daysFromNow(r.dueAt)).toBeGreaterThan(6.99);
    expect(daysFromNow(r.dueAt)).toBeLessThan(7.01);
  });

  it('snoozes a bottom-rung review by a whole day, never by zero', () => {
    // Rung 0 is +1 day: a snooze can never re-serve the same problem at once.
    setReview(A, ago(1000), 0);
    expect(db.snoozeReview(A)).toBe(true);
    const r = row(A);
    expect(r.attempts).toBe(0);
    expect(daysFromNow(r.dueAt)).toBeGreaterThan(0.99);
    expect(daysFromNow(r.dueAt)).toBeLessThan(1.01);
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
    expect(daysFromNow(row(A).dueAt)).toBeGreaterThan(0.99);
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

  it('does not stop skipping at one: skipped reviews walk on, under the per-sitting cap', async () => {
    // The reported symptom, end to end — each click names what is on screen.
    // A skipped review still counts as served for the cap (R, x, x, R), so B
    // waits two problems rather than coming straight back.
    setReview(A, ago(26 * DAY), 1);
    setReview(B, ago(3 * DAY), 1);
    const first = await next();
    expect(first.json.problem.id).toBe(A);
    const second = await next({ skipProblemId: first.json.problem.id });
    expect(second.json.why.kind).not.toBe('review');
    expect(daysFromNow(row(A).dueAt)).toBeGreaterThan(0.99);
    const third = await next();
    expect(third.json.why.kind).not.toBe('review');
    const fourth = await next();
    expect(fourth.json.problem.id).toBe(B);
    const fifth = await next({ skipProblemId: fourth.json.problem.id });
    expect(fifth.json.why.kind).not.toBe('review');
  });

  it('with no body, serves the earliest due review exactly as before', async () => {
    setReview(A, ago(26 * DAY), 1);
    setReview(B, ago(3 * DAY), 0);
    const before = [row(A), row(B)];

    const { status, json } = await next();
    expect(status).toBe(200);
    expect(json.problem.id).toBe(A);
    expect(json.why.kind).toBe('review');
    // B is due too, but the sitting just served a review: the cap holds the
    // next slot, and the peek has to agree with that.
    expect(json.upNext).not.toBe('a review problem to solve cold');
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
      // A fresh sitting each time: the per-sitting review cap is not under test.
      db.db.prepare('DELETE FROM sessions').run();
      db.createSession('javascript', SESSION, PLAN);
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

// =============================================================================
// Grind's per-sitting review cap — at most one review per REVIEW_CAP_WINDOW
// problems. A due review used to outrank everything, so a long queue made a
// whole sitting of reviews: the same few problems, every day.
// =============================================================================
const C = 'p-review-c';
const D = 'p-review-d';

suite('reviewAllowed — the cap rule', () => {
  it('is R, x, x, R: allowed first, then only after REVIEW_CAP_WINDOW - 1 non-reviews', () => {
    expect(scheduler.REVIEW_CAP_WINDOW).toBe(3);
    expect(scheduler.reviewAllowed(0, null)).toBe(true);
    expect(scheduler.reviewAllowed(5, null)).toBe(true);
    // A review went out as problem 1.
    expect(scheduler.reviewAllowed(1, 1)).toBe(false);
    expect(scheduler.reviewAllowed(2, 1)).toBe(false);
    expect(scheduler.reviewAllowed(3, 1)).toBe(true);
    expect(scheduler.reviewAllowed(4, 4)).toBe(false);
    expect(scheduler.reviewAllowed(6, 4)).toBe(true);
  });
});

suite('nextIntent / peekUpNext — allowReview', () => {
  it('serves (and peeks) the due review when allowed, which is also the default', () => {
    setReview(A, ago(DAY), 0);
    expect(scheduler.nextIntent({ language: 'javascript' }).reviewProblemId).toBe(A);
    expect(scheduler.nextIntent({ language: 'javascript', allowReview: true }).kind).toBe('review');
    expect(scheduler.peekUpNext({ language: 'javascript' })).toBe('a review problem to solve cold');
    expect(scheduler.peekUpNext({ language: 'javascript', allowReview: true })).toBe('a review problem to solve cold');
  });

  it('skips the review branch when not allowed, and leaves the review due', () => {
    const due = ago(DAY);
    setReview(A, due, 0);
    const before = row(A);
    expect(scheduler.nextIntent({ language: 'javascript', allowReview: false }).kind).not.toBe('review');
    expect(scheduler.peekUpNext({ language: 'javascript', allowReview: false })).not.toBe('a review problem to solve cold');
    expect(row(A)).toEqual(before);
    expect(db.getDueReview('javascript')?.problemId).toBe(A);
  });
});

suite('POST /api/session — a sitting with many due reviews', () => {
  beforeEach(() => {
    bankProblem(C);
    bankProblem(D, 'hashing');
    setReview(A, ago(4 * DAY), 3);
    setReview(B, ago(3 * DAY), 2);
    setReview(C, ago(2 * DAY), 1);
    setReview(D, ago(1 * DAY), 0);
  });

  it('serves R, fresh, fresh, R — and the peek agrees with every pick', async () => {
    const served: Array<{ kind: string; id: string; upNext: string }> = [];
    for (let i = 0; i < 6; i++) {
      const { status, json } = await next();
      expect(status).toBe(200);
      served.push({ kind: json.why.kind, id: json.problem.id, upNext: json.upNext });
    }
    const isReview = served.map((s) => s.kind === 'review');
    expect(isReview).toEqual([true, false, false, true, false, false]);
    // Nothing was submitted, so A is still the earliest due review when the
    // window reopens — the cap delays reviews, it does not reorder them.
    expect(served[0].id).toBe(A);
    expect(served[3].id).toBe(A);
    expect(served[1].id).toBe(GENERATED_ID);
    // upNext after pick i must describe pick i+1's review-ness.
    for (let i = 0; i < 5; i++) {
      expect(served[i].upNext === 'a review problem to solve cold').toBe(isReview[i + 1]);
    }
    // Waiting is not snoozing: C and D are still due, untouched.
    expect(db.getReviewDueCount('javascript')).toBe(4); // nothing was submitted
    expect(db.getSession(SESSION)).toMatchObject({ served: 6, lastReviewServed: 4 });
  });

  it('/session/start may serve a review first; the next pick is fresh', async () => {
    vi.mocked(llm.planSession).mockResolvedValue(PLAN);
    const res = await app.request('/api/session/start', { method: 'POST' });
    expect(res.status).toBe(200);
    const start = (await res.json()) as any;
    expect(start.why.kind).toBe('review');
    expect(start.problem.id).toBe(A);
    expect(start.upNext).not.toBe('a review problem to solve cold');
    expect(db.getSession(start.sessionId)).toMatchObject({ served: 1, lastReviewServed: 1 });

    const after = await app.request(`/api/session/${start.sessionId}/next`, { method: 'POST' });
    const json = (await after.json()) as any;
    expect(json.why.kind).not.toBe('review');
  });
});
