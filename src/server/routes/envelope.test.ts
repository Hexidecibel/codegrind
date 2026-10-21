// =============================================================================
// routes/envelope — the drill over HTTP, against a real (temporary) database
// =============================================================================
// The AI note is faked; everything else is real. Pinned:
//   * seeded cards are idempotent and lead the session; fresh reps fill it;
//   * a check records an attempt; a miss makes a card due TOMORROW; a seeded
//     card answered right moves up the ladder;
//   * the AI note runs only on a miss, only with AI reviews on, once per attempt;
//   * Today's warm-up includes Envelope ×5 and is done only when it is;
//   * a mock's capacity gap becomes an interviewer-phrased Envelope card.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fake = vi.hoisted(() => ({ runEnvelopeNote: vi.fn() }));
vi.mock('../services/llm.envelope.js', () => ({ runEnvelopeNote: fake.runEnvelopeNote }));

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-envelope-test-'));
if (!TEST_DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run: test DATA_DIR ${TEST_DATA_DIR} is not under ${tmpdir()}`);
}
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.CODEGRIND_TZ = 'America/Los_Angeles';

const { envelopeRoutes } = await import('./envelope.js');
const { todayRoutes } = await import('./today.js');
const { db, setSetting } = await import('../services/db.js');
const svc = await import('../services/envelope.service.js');

const app = new Hono();
app.route('/api', envelopeRoutes);
app.route('/api', todayRoutes);

// Tuesday 1pm in Los Angeles.
const NOW = new Date('2026-10-21T20:00:00.000Z');

afterAll(() => {
  vi.useRealTimers();
  db.close();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const post = (url: string, body?: unknown) =>
  app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

const META = { servedModel: 'claude-haiku-4-5', stop: 'tool_use', latencyMs: 5, usage: { inputTokens: 600, outputTokens: 80, cachedInputTokens: 0 } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fake.runEnvelopeNote.mockReset();
  for (const t of ['envelope_cards', 'envelope_attempts', 'daily_sessions', 'settings']) db.prepare(`DELETE FROM ${t}`).run();
  setSetting('ai.reviews', true);
});

describe('session + seeding', () => {
  it('seeds the five diagnostic cards once; due cards lead the session', async () => {
    expect(svc.seedEnvelopeCards(NOW)).toBe(5);
    expect(svc.seedEnvelopeCards(NOW)).toBe(0);
    const s = await (await app.request('/api/envelope/session?n=7')).json();
    expect(s.due).toBe(5);
    expect(s.items).toHaveLength(7);
    expect(s.items.slice(0, 5).every((i: { card: boolean }) => i.card)).toBe(true);
    expect(s.items[0].question).toMatch(/^Say your service handles 50 million requests a day/);
    // No answers leak to the client before it answers.
    expect(JSON.stringify(s)).not.toMatch(/answerText|expected|split/);
  });
});

describe('check', () => {
  it('a seeded card answered right moves up the ladder; wrong goes back with a diagnosis', async () => {
    svc.seedEnvelopeCards(NOW);
    let r = await (await post('/api/envelope/check', { key: 'seed:50m-day-to-sec', answer: '500/s' })).json();
    expect(r).toMatchObject({ ok: true, schedule: 'again in 2 days', noteAvailable: false });
    expect(r.split.zeros).toContain('10⁷ ÷ 10⁵');

    r = await (await post('/api/envelope/check', { key: 'seed:300-sec-to-day', answer: '300 billion', working: '300 x 1000000000' })).json();
    expect(r).toMatchObject({ ok: false, cause: 'zeros', verdict: 'Off by 10⁴, too high.', noteAvailable: true, schedule: 'again tomorrow' });
    const card = db.prepare(`SELECT dueAt, lapses FROM envelope_cards WHERE key = 'seed:300-sec-to-day'`).get() as { dueAt: string; lapses: number };
    expect(card.lapses).toBe(1);
    expect(Date.parse(card.dueAt)).toBeGreaterThanOrEqual(NOW.getTime() + 86_400_000);
  });

  it('a missed fresh rep becomes a review card due tomorrow; a right one makes none', async () => {
    const { itemFromKey } = await import('../../shared/envelope.js');
    const cards = () => (db.prepare(`SELECT COUNT(*) AS n FROM envelope_cards`).get() as { n: number }).n;
    const right = itemFromKey('g:qps:3')!;
    expect((await (await post('/api/envelope/check', { key: right.key, answer: String(right.expected.value) })).json()).ok).toBe(true);
    expect(cards()).toBe(0);
    const r = await (await post('/api/envelope/check', { key: 'g:day-to-sec:1', answer: '1' })).json();
    expect(r).toMatchObject({ ok: false, schedule: 'new review card — again tomorrow' });
    expect(cards()).toBe(1);
    // The card now leads tomorrow's session.
    vi.setSystemTime(new Date(NOW.getTime() + 86_400_000));
    const s = await (await app.request('/api/envelope/session?n=3')).json();
    expect(s.items[0]).toMatchObject({ key: 'g:day-to-sec:1', card: true });
    expect((await post('/api/envelope/check', { key: 'g:day-to-sec:1', answer: 'lots' })).status).toBe(400);
    expect((await post('/api/envelope/check', { key: 'g:nope:1', answer: '5' })).status).toBe(404);
  });
});

describe('the AI note', () => {
  it('runs once on a miss, is cached, and obeys the toggle', async () => {
    fake.runEnvelopeNote.mockResolvedValue({ result: { slip: 'You used the month constant.', fix: 'Write day = 10^5 first.' }, meta: META });
    svc.seedEnvelopeCards(NOW);
    const miss = await (await post('/api/envelope/check', { key: 'seed:50m-day-to-sec', answer: '20', working: '50M / 2.5M = 20' })).json();
    expect(miss.cause).toBe('month-for-day');
    const n1 = await (await post('/api/envelope/note', { attemptId: miss.attemptId })).json();
    expect(n1.slip).toMatch(/month/);
    expect(fake.runEnvelopeNote).toHaveBeenCalledTimes(1);
    expect(fake.runEnvelopeNote.mock.calls[0][0]).toMatchObject({ working: '50M / 2.5M = 20', given: '20' });
    await post('/api/envelope/note', { attemptId: miss.attemptId });
    expect(fake.runEnvelopeNote).toHaveBeenCalledTimes(1); // cached

    const right = await (await post('/api/envelope/check', { key: 'seed:2b-month-to-sec', answer: '800' })).json();
    expect((await post('/api/envelope/note', { attemptId: right.attemptId })).status).toBe(409);

    setSetting('ai.reviews', false);
    const miss2 = await (await post('/api/envelope/check', { key: 'seed:2b-month-to-sec', answer: '80' })).json();
    expect(miss2.noteAvailable).toBe(false);
    expect((await post('/api/envelope/note', { attemptId: miss2.attemptId })).status).toBe(409);
    expect(fake.runEnvelopeNote).toHaveBeenCalledTimes(1);
  });
});

describe('stats', () => {
  it('accuracy and mean |orders of magnitude| per day', async () => {
    svc.seedEnvelopeCards(NOW);
    await post('/api/envelope/check', { key: 'seed:50m-day-to-sec', answer: '500' });
    await post('/api/envelope/check', { key: 'seed:300-sec-to-day', answer: '300 billion' });
    const s = await (await app.request('/api/envelope/stats')).json();
    expect(s.total).toBe(2);
    expect(s.recentAccuracy).toBe(0.5);
    expect(s.byDay).toHaveLength(1);
    expect(s.byDay[0].date).toBe('2026-10-21');
    expect(s.byDay[0].meanAbsOrders).toBeGreaterThan(2);
    expect(s.causes).toEqual([{ cause: 'zeros', n: 1 }]);
  });
});

describe("Today's warm-up includes Envelope ×5", () => {
  it('derived from rows: seeded cards make it the warm-up; five answers finish it', async () => {
    setSetting('ai.reviews', false); // no automatic step review from this test
    svc.seedEnvelopeCards(new Date('2026-10-20T20:00:00.000Z'));
    let t = await (await app.request('/api/today')).json();
    expect(t.envelope).toMatchObject({ daily: 5, doneToday: 0, due: 5, remaining: 5, done: false });
    expect(t.current).toBe('warmup');
    expect(t.steps[0].detail).toBe('Envelope ×5');
    expect(t.steps[0].href).toMatch(/^\/envelope\?from=today&step=warmup/);

    const keys = ['seed:50m-day-to-sec', 'seed:2b-month-to-sec', 'seed:300-sec-to-day', 'seed:20gb-day-to-year', 'seed:500m-users-photos'];
    const answers = ['500', '80', '30M', '8000 GB', '200 TB'];
    for (let i = 0; i < 5; i++) await post('/api/envelope/check', { key: keys[i], answer: answers[i] });

    t = await (await app.request('/api/today')).json();
    expect(t.envelope).toMatchObject({ doneToday: 5, correctToday: 4, due: 0, remaining: 0, done: true });
    expect(t.steps[0].status).toBe('done');
    expect(t.steps[0].result).toMatch(/5 envelope/);
  });

  it('a daily setting of 0 takes it out of the warm-up', async () => {
    setSetting('envelope.daily', 0);
    const t = await (await app.request('/api/today')).json();
    expect(t.envelope.remaining).toBe(0);
    expect(t.steps[0].status).toBe('done');
  });
});

describe('mock gaps → Envelope cards', () => {
  it('a capacity gap with a monthly volume becomes an interviewer-phrased card, once', () => {
    const gaps = [
      { id: 2, concept: 'capacity', title: 'Say a URL shortener gets 100 million new links and 10 billion redirects a month. Talk me through the rough numbers.', summary: '', answer: '' },
      { id: 3, concept: 'api-design', title: 'For a URL shortener, 301 or 302?', summary: '', answer: '' },
      { id: 5, concept: 'scale-estimation', title: 'Roughly how many seconds are there in a month?', summary: '', answer: '' },
    ];
    expect(svc.envelopeCardsFromGaps('m1', gaps, NOW)).toBe(1);
    expect(svc.envelopeCardsFromGaps('m1', gaps, NOW)).toBe(0);
    const row = db.prepare(`SELECT key, source, item FROM envelope_cards`).get() as { key: string; source: string; item: string };
    expect(row).toMatchObject({ key: 'mock:2', source: 'mock' });
    expect(JSON.parse(row.item).question).toBe('Say you get 10 billion redirects a month. Roughly how many is that per second?');
  });
});
