// =============================================================================
// routes/recognize — the drill over HTTP, against a real (temporary) database
// =============================================================================
// The AI check and primer generation are faked; everything else is real. Pinned:
//   * a served card leaks no title, topic or code;
//   * the reveal is free and does NOT write the ledger; showing code DOES;
//   * grading never touches attempts / skill_state / review_queue;
//   * a wrong pick is a miss and lands on the ladder; due cards lead the next session;
//   * the AI check runs only on its route and caches the note for later reveals;
//   * Today derives the Recognize add-on from rows.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fake = vi.hoisted(() => ({
  runRecognizeCheck: vi.fn(),
  generatePrimer: vi.fn(),
  runDebrief: vi.fn(),
}));
vi.mock('../services/llm.recognize.js', () => ({ runRecognizeCheck: fake.runRecognizeCheck }));
vi.mock('../services/llm.service.js', () => ({ generatePrimer: fake.generatePrimer }));
vi.mock('../services/llm.debrief.js', () => ({ runDebrief: fake.runDebrief }));

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-recognize-test-'));
if (!TEST_DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run: test DATA_DIR ${TEST_DATA_DIR} is not under ${tmpdir()}`);
}
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.CODEGRIND_TZ = 'America/Los_Angeles';

const { recognizeRoutes } = await import('./recognize.js');
const { todayRoutes } = await import('./today.js');
const { db, insertPrimer } = await import('../services/db.js');

const app = new Hono();
app.route('/api', recognizeRoutes);
app.route('/api', todayRoutes);

afterAll(() => {
  db.close();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const post = (url: string, body?: unknown) =>
  app.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

function insertProblem(id: string, topic: string, used = 1) {
  db.prepare(
    `INSERT INTO problems (id, title, prompt, examples, constraints, difficulty, topic, pattern, starterCode,
       functionName, sampleTests, hiddenTests, referenceSolution, used, createdAt, language)
     VALUES (?, ?, 'Find the thing.', '[{"input":"[1]","output":"1"}]', '["n <= 10"]', 'easy', ?, ?, '', 'f', '[]', '[]',
       'function f() { return 42; }', ?, '2026-10-01T00:00:00.000Z', 'javascript')`
  ).run(id, `Title ${id}`, topic, topic, used);
}

const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  for (const t of ['recognize_attempts', 'recognize_cards', 'recognize_notes', 'revealed_solutions', 'attempts', 'problems', 'pattern_primers', 'skill_state', 'review_queue']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  fake.runRecognizeCheck.mockReset();
  fake.generatePrimer.mockReset();
  const topics = ['arrays', 'hashing', 'two-pointer', 'binary-search', 'math', 'heap'];
  topics.forEach((t) => insertProblem(`p-${t}`, t));
  insertPrimer({
    pattern: 'arrays',
    recognitionCues: ['single pass over a list'],
    template: 'for (const x of xs) {}',
    pitfalls: ['off by one'],
    example: { title: 'Max Sum', insight: 'Track a running best.' },
  });
});

describe('GET /api/recognize/session', () => {
  it('serves N interleaved cards with four choices and no answer', async () => {
    const res = await app.request('/api/recognize/session?n=5');
    expect(res.status).toBe(200);
    const s = await res.json();
    expect(s.cards).toHaveLength(5);
    const raw = JSON.stringify(s);
    expect(raw).not.toContain('Title p-');
    expect(raw).not.toContain('return 42');
    for (const c of s.cards) {
      expect(c.choices).toHaveLength(4);
      expect(c).not.toHaveProperty('topic');
      expect(c).not.toHaveProperty('title');
    }
    expect(new Set(s.cards.map((c: { problemId: string }) => c.problemId)).size).toBe(5);
  });

  it('defaults an unknown size to 5', async () => {
    const s = await (await app.request('/api/recognize/session?n=37')).json();
    expect(s.cards).toHaveLength(5);
  });
});

describe('reveal / code — the ledger', () => {
  it('reveal is free, carries the primer, and writes no ledger row', async () => {
    const res = await post('/api/recognize/reveal', { problemId: 'p-arrays', picked: 'hashing' });
    const r = await res.json();
    expect(r).toMatchObject({ topic: 'arrays', title: 'Title p-arrays', patternCorrect: false, picked: 'hashing' });
    expect(r.primer.skeleton).toBe('for (const x of xs) {}');
    expect(r).not.toHaveProperty('referenceSolution');
    expect(count('revealed_solutions')).toBe(0);
    expect(fake.generatePrimer).not.toHaveBeenCalled();
  });

  it('a topic with no primer generates one once and caches it', async () => {
    fake.generatePrimer.mockResolvedValue({
      pattern: 'heap',
      recognitionCues: ['k-th largest'],
      template: 'heap.push(x)',
      pitfalls: [],
      example: { title: 'Kth', insight: 'Keep k.' },
    });
    await post('/api/recognize/reveal', { problemId: 'p-heap', picked: 'heap' });
    const r = await (await post('/api/recognize/reveal', { problemId: 'p-heap', picked: 'heap' })).json();
    expect(r.patternCorrect).toBe(true);
    expect(r.primer.cues).toEqual(['k-th largest']);
    expect(fake.generatePrimer).toHaveBeenCalledTimes(1);
  });

  it('showing code writes the reveal ledger, so a later grind counts as assisted', async () => {
    const r = await (await post('/api/recognize/code', { problemId: 'p-math' })).json();
    expect(r.referenceSolution).toBe('function f() { return 42; }');
    expect(db.prepare(`SELECT problemId FROM revealed_solutions`).all()).toEqual([{ problemId: 'p-math' }]);
  });

  it('404s an unknown problem', async () => {
    expect((await post('/api/recognize/code', { problemId: 'nope' })).status).toBe(404);
  });
});

describe('POST /api/recognize/grade', () => {
  it('never touches attempts, skill_state or review_queue', async () => {
    const before = ['attempts', 'skill_state', 'review_queue'].map(count);
    const res = await post('/api/recognize/grade', { problemId: 'p-arrays', picked: 'arrays', approach: 'scan', selfGrade: 'got' });
    expect(await res.json()).toEqual({ grade: 'got', outcome: expect.stringMatching(/not scheduled/) });
    expect(['attempts', 'skill_state', 'review_queue'].map(count)).toEqual(before);
    expect(count('recognize_attempts')).toBe(1);
    expect(count('recognize_cards')).toBe(0);
  });

  it('a wrong pick is a miss on the ladder, and the card leads a session once due', async () => {
    const r = await (
      await post('/api/recognize/grade', { problemId: 'p-math', picked: 'greedy', approach: '', selfGrade: 'got' })
    ).json();
    expect(r.grade).toBe('missed');
    const card = db.prepare(`SELECT * FROM recognize_cards WHERE problemId = 'p-math'`).get() as { dueAt: string; step: number };
    expect(card.step).toBe(0);
    expect(Date.parse(card.dueAt)).toBeGreaterThan(Date.now() + 23 * 3600_000);

    db.prepare(`UPDATE recognize_cards SET dueAt = '2026-01-01T00:00:00.000Z'`).run();
    const s = await (await app.request('/api/recognize/session?n=5')).json();
    expect(s.cards[0]).toMatchObject({ problemId: 'p-math', due: true });
  });

  it('rejects a bad self-grade', async () => {
    expect((await post('/api/recognize/grade', { problemId: 'p-math', selfGrade: 'meh' })).status).toBe(400);
  });
});

describe('POST /api/recognize/check', () => {
  it('makes one call, suggests a grade, and caches the note for later reveals', async () => {
    fake.runRecognizeCheck.mockResolvedValue({
      result: {
        verdict: 'partly',
        missing: ['the invariant'],
        edgeCaseThatBites: 'empty input',
        oneLineFix: 'Track the best so far.',
        note: { keyInsight: 'One pass suffices.', time: 'O(n)', space: 'O(1)' },
      },
      meta: { servedModel: 'local-model', stop: 'tool_use', latencyMs: 1, usage: { inputTokens: 900, outputTokens: 150, cachedInputTokens: 0 } },
    });
    const r = await (await post('/api/recognize/check', { problemId: 'p-arrays', picked: 'arrays', approach: 'scan once' })).json();
    expect(r).toMatchObject({ verdict: 'partly', suggested: 'shaky', costUsd: null });
    expect(fake.runRecognizeCheck).toHaveBeenCalledTimes(1);
    expect(count('revealed_solutions')).toBe(0); // the code went to the model, not the user

    const rev = await (await post('/api/recognize/reveal', { problemId: 'p-arrays', picked: 'arrays' })).json();
    expect(rev.note).toEqual({ keyInsight: 'One pass suffices.', time: 'O(n)', space: 'O(1)' });
    expect(fake.runRecognizeCheck).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty approach without calling the model', async () => {
    expect((await post('/api/recognize/check', { problemId: 'p-arrays', approach: '  ' })).status).toBe(400);
    expect(fake.runRecognizeCheck).not.toHaveBeenCalled();
  });
});

describe('stats + Today', () => {
  it('per-pattern accuracy', async () => {
    await post('/api/recognize/grade', { problemId: 'p-math', picked: 'math', selfGrade: 'got' });
    await post('/api/recognize/grade', { problemId: 'p-heap', picked: 'greedy', selfGrade: 'got' });
    const s = await (await app.request('/api/recognize/stats')).json();
    expect(s.total).toBe(2);
    expect(s.byTopic[0]).toMatchObject({ topic: 'heap', patternAccuracy: 0 });
    expect(s.due).toBe(0);
    expect(s.upcoming).toBe(1);
  });

  it('recommends Recognize when there was no grind in 3 days, and marks it done after 5 cards', async () => {
    let t = await (await app.request('/api/today')).json();
    expect(t.recognize).toMatchObject({ recommended: true, done: false, doneToday: 0 });
    expect(t.recognize.href).toContain('/recognize?from=today&step=warmup');
    const totalBefore = t.total;

    for (const p of ['arrays', 'hashing', 'two-pointer', 'binary-search', 'math']) {
      await post('/api/recognize/grade', { problemId: `p-${p}`, picked: p, selfGrade: 'got' });
    }
    t = await (await app.request('/api/today')).json();
    expect(t.recognize).toMatchObject({ done: true, doneToday: 5 });
    expect(t.total).toBe(totalBefore); // never a step
    expect(t.streak).toBeGreaterThanOrEqual(1); // recognize practice counts as a day of practice
  });

  it('is optional when you ground recently and are accurate', async () => {
    db.prepare(
      `INSERT INTO attempts (id, problemId, pattern, difficulty, solved, hintsUsed, testsPassed, testsTotal, code, createdAt, language)
       VALUES ('a1', 'p-arrays', 'arrays', 'easy', 1, 0, 3, 3, '', ?, 'javascript')`
    ).run(new Date().toISOString());
    const t = await (await app.request('/api/today')).json();
    expect(t.recognize.recommended).toBe(false);
  });
});
