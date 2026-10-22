// =============================================================================
// Pattern Refresh over HTTP, against a real (temporary) database
// =============================================================================
// GET /api/today with the refresh on: day 1 = hash map, the day advances only
// once its core steps are done (a missed calendar day repeats the pattern),
// the cold review is yesterday's pattern, mocks are off, and after day 9 the
// mode turns itself off. Plus the /patterns recall + view routes. All free.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fake = vi.hoisted(() => ({ runDebrief: vi.fn() }));
vi.mock('../services/llm.debrief.js', () => fake);

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-refresh-test-'));
if (!TEST_DATA_DIR.startsWith(tmpdir())) throw new Error('refusing to run outside tmpdir');
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.CODEGRIND_TZ = 'America/Los_Angeles';

const { todayRoutes } = await import('./today.js');
const { patternsRoutes } = await import('./patterns.js');
const { db, setSetting } = await import('../services/db.js');

const app = new Hono();
app.route('/api', todayRoutes);
app.route('/api', patternsRoutes);

// Tuesday 1pm in Los Angeles; DAY(n) = n days later, same time.
const NOW = new Date('2026-10-21T20:00:00.000Z');
const DAY = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

afterAll(() => {
  vi.useRealTimers();
  db.close();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const post = (url: string, body?: unknown) =>
  app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const today = async () => (await app.request('/api/today')).json();

let seq = 0;
function solve(topic: string, at: Date, difficulty = 'easy', createdAt = '2026-10-01T00:00:00.000Z'): string {
  const id = `p${++seq}`;
  db.prepare(
    `INSERT INTO problems (id, title, prompt, examples, constraints, difficulty, topic, pattern, starterCode,
       functionName, sampleTests, hiddenTests, referenceSolution, used, createdAt, language)
     VALUES (?, ?, 'p', '[]', '[]', ?, ?, ?, '', 'f', '[]', '[]', '', 1, ?, 'javascript')`
  ).run(id, `Problem ${id}`, difficulty, topic, topic, createdAt);
  db.prepare(
    `INSERT INTO attempts (id, problemId, pattern, difficulty, solved, hintsUsed, testsPassed, testsTotal, code, createdAt, language)
     VALUES (?, ?, ?, ?, 1, 0, 3, 3, '', ?, 'javascript')`
  ).run(`a${seq}`, id, topic, difficulty, at.toISOString());
  return id;
}

/** Re-learn + recall + practice for the day's pattern. */
async function finishPatternDay(pattern: string, topic: string, at: Date) {
  expect((await post(`/api/patterns/${pattern}/view`)).status).toBe(200);
  expect((await post(`/api/patterns/${pattern}/recall`, { grade: 'got', answer: 'for ...' })).status).toBe(200);
  solve(topic, at);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  for (const t of [
    'daily_sessions', 'mock_gaps', 'mocks', 'attempts', 'review_queue', 'problems', 'recognize_attempts',
    'refresh_days', 'pattern_views', 'pattern_recall_cards', 'pattern_recall_reviews',
  ]) db.prepare(`DELETE FROM ${t}`).run();
  setSetting('ai.reviews', false);
  setSetting('envelope.daily', 0);
  setSetting('today.refresh', { on: false, completedThrough: 0, startedAt: null, finishedAt: null });
});

describe('Pattern Refresh on Today', () => {
  it('is off by default; turning it on makes today Refresh day 1 — Hash map, with no mock', async () => {
    expect((await today()).refresh.on).toBe(false);
    const body = await (await post('/api/today/refresh', { on: true })).json();
    expect(body.refresh).toMatchObject({ on: true, day: 1, total: 9, label: 'Hash map', pattern: 'hash-map' });
    expect(body.steps.map((s: { id: string }) => s.id)).toEqual(['warmup', 'relearn', 'recall', 'practice', 'cold', 'recognize', 'debrief']);
    expect(body.current).toBe('relearn');
    expect(body.total).toBe(7);
  });

  it('the day advances only when its core steps are done; a missed day repeats the pattern', async () => {
    await post('/api/today/refresh', { on: true });
    vi.setSystemTime(DAY(1));
    expect((await today()).refresh.day).toBe(1); // nothing done yesterday → still hash map
    vi.setSystemTime(DAY(2));
    await finishPatternDay('hash-map', 'hashing', DAY(2));
    const done = await today();
    expect(done.refresh.day).toBe(1);
    expect(done.refresh.dayComplete).toBe(true);
    vi.setSystemTime(DAY(3));
    const d2 = await today();
    expect(d2.refresh).toMatchObject({ day: 2, label: 'Two pointers', prevLabel: 'Hash map' });
  });

  it('the cold review is yesterday’s pattern: an older problem of that topic, topic hidden', async () => {
    const old = solve('hashing', new Date('2026-09-01T18:00:00.000Z'));
    await post('/api/today/refresh', { on: true });
    await finishPatternDay('hash-map', 'hashing', NOW);
    vi.setSystemTime(DAY(1));
    const body = await today();
    const cold = body.steps.find((s: { id: string }) => s.id === 'cold');
    expect(cold.href).toBe(`/manual?problem=${old}&hide=1&from=today&step=cold`);
    expect(cold.status).toBe('todo');
    solve('hashing', DAY(1));
    expect((await today()).steps.find((s: { id: string }) => s.id === 'cold').status).toBe('done');
  });

  it('a skip by hand settles a core step; End day early does not advance the day', async () => {
    await post('/api/today/refresh', { on: true });
    await post('/api/today/end', { ended: true });
    vi.setSystemTime(DAY(1));
    expect((await today()).refresh.day).toBe(1);
    for (const step of ['relearn', 'recall', 'practice']) await post('/api/today/skip', { step });
    expect((await today()).refresh.dayComplete).toBe(true);
  });

  it('after day 9 the toggle turns itself off and Today is back to normal, with a note', async () => {
    setSetting('today.refresh', { on: true, completedThrough: 8, startedAt: NOW.toISOString(), finishedAt: null });
    const d9 = await today();
    expect(d9.refresh).toMatchObject({ on: true, day: 9, label: 'Mixed day' });
    expect(d9.steps.map((s: { id: string }) => s.id)).toEqual(['warmup', 'mixed1', 'mixed2', 'mixed3', 'recognize', 'debrief']);
    for (let i = 0; i < 3; i++) solve('stack', NOW, 'medium');
    expect((await today()).refresh.dayComplete).toBe(true);
    vi.setSystemTime(DAY(1));
    const after = await today();
    expect(after.refresh.on).toBe(false);
    expect(after.refresh.finishedAt).toBeTruthy();
    expect(after.steps.map((s: { id: string }) => s.id)).toContain('mock');
  });
});

describe('/api/patterns', () => {
  it('a recall self-grade schedules a card on the gap-card ladder; unknown ids 404', async () => {
    const s = await (await post('/api/patterns/sliding-window/recall', { grade: 'got' })).json();
    expect(s.cards).toEqual([expect.objectContaining({ id: 'sliding-window', step: 1, due: false })]);
    const missed = await (await post('/api/patterns/sliding-window/recall', { grade: 'missed' })).json();
    expect(missed.due).toEqual(['sliding-window']);
    expect((await post('/api/patterns/nope/recall', { grade: 'got' })).status).toBe(404);
    expect((await post('/api/patterns/heap/recall', { grade: 'maybe' })).status).toBe(400);
  });
});
