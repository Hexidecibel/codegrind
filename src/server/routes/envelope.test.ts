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
  for (const t of ['envelope_cards', 'envelope_attempts', 'envelope_steps', 'envelope_anchor_cards', 'envelope_speed_rounds', 'daily_sessions', 'settings'])
    db.prepare(`DELETE FROM ${t}`).run();
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

describe('the double-answer guard (Phase H)', () => {
  it('refuses the same item twice inside a few seconds', async () => {
    svc.seedEnvelopeCards(NOW);
    expect((await post('/api/envelope/check', { key: 'seed:20gb-day-to-year', answer: '8 TB' })).status).toBe(200);
    expect((await post('/api/envelope/check', { key: 'seed:20gb-day-to-year', answer: '8 TB' })).status).toBe(409);
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
    // Another item: the same one again inside a few seconds is a double tap (Phase H).
    const miss2 = await (await post('/api/envelope/check', { key: 'seed:300-sec-to-day', answer: '300' })).json();
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
    // Phase I: a beginner (no answers yet) gets the guided warm-up, 3 reps,
    // on today's one skill; the 5 due cards still lead it.
    expect(t.envelope).toMatchObject({ daily: 3, doneToday: 0, due: 5, remaining: 5, done: false, guided: true });
    expect(t.envelope.skill).toEqual({ id: 'per-second', label: 'per day → per second' });
    expect(t.current).toBe('warmup');
    expect(t.steps[0].detail).toBe('Envelope ×5');
    expect(t.steps[0].href).toMatch(/^\/envelope\?from=today&step=warmup&n=5&guided=1&skill=per-second$/);

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

// -----------------------------------------------------------------------------
// Phase I: guided steps, fading, drill picker, anchors, speed round, Reflect
// -----------------------------------------------------------------------------
describe('guided mode over HTTP', () => {
  const KEY = 'seed:50m-day-to-sec';
  const step = (index: number, answer: string) => Promise.resolve(post('/api/envelope/step', { key: KEY, index, answer })).then((r: Response) => r.json());

  it('checks each step, names the slip, records it; the final miss names the broken step for the AI note', async () => {
    svc.seedEnvelopeCards(NOW);
    const g = await (await app.request(`/api/envelope/guided?key=${KEY}`)).json();
    expect(g.steps.map((s: { type: string }) => s.type)).toEqual(['direction', 'split', 'split', 'small', 'exponent', 'back', 'unit']);
    expect(g.steps.every((s: { auto: boolean; answer: unknown }) => !s.auto && s.answer === null)).toBe(true);

    let r = await step(0, 'multiply');
    expect(r).toMatchObject({ ok: false, slip: 'direction', answer: 'divide' });
    r = await step(1, '5 x 10^6');
    expect(r).toMatchObject({ ok: false, slip: 'own-zeros', answer: '5 × 10⁷' });
    r = await step(2, '10^5');
    expect(r.ok).toBe(true);

    fake.runEnvelopeNote.mockResolvedValue({ result: { slip: 'Step 1: multiplied.', fix: 'Say divide first.' }, meta: META });
    const c = await (await post('/api/envelope/check', { key: KEY, answer: '500 TB', mode: 'guided' })).json();
    expect(c.ok).toBe(false);
    expect(c.cause).toBe('wrong-unit');
    expect(c.verdict).toMatch(/count, not data/);
    expect(c.failedStep).toMatch(/^Divide or multiply\?: asked ".*", typed "multiply"\. /);
    await post('/api/envelope/note', { attemptId: c.attemptId });
    expect(fake.runEnvelopeNote.mock.calls[0][0].step).toBe(c.failedStep);

    const stats = await (await app.request('/api/envelope/stats')).json();
    const by = Object.fromEntries(stats.steps.map((s: { type: string }) => [s.type, s]));
    expect(by.direction).toMatchObject({ n: 1, missed: 1, topSlip: 'direction' });
    expect(by.split).toMatchObject({ n: 2, missed: 1, topSlip: 'own-zeros' });
    expect(by.unit).toMatchObject({ n: 1, missed: 1, topSlip: 'wrong-unit' });
  });

  it('a plain-mode check sends no step to the note', async () => {
    svc.seedEnvelopeCards(NOW);
    fake.runEnvelopeNote.mockResolvedValue({ result: { slip: 'x', fix: 'y' }, meta: META });
    const c = await (await post('/api/envelope/check', { key: KEY, answer: '5' })).json();
    expect(c.failedStep).toBeNull();
    await post('/api/envelope/note', { attemptId: c.attemptId });
    expect(fake.runEnvelopeNote.mock.calls[0][0].step).toBeUndefined();
  });

  it('a step type right 3 times in a row comes auto-filled; a final miss that points at it brings it back', async () => {
    svc.seedEnvelopeCards(NOW);
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(new Date(NOW.getTime() + i * 60_000));
      const r = await step(3, '5');
      expect(r.ok).toBe(true);
      if (i === 2) expect(r.fadesNow).toBe(true);
    }
    let g = await (await app.request(`/api/envelope/guided?key=${KEY}`)).json();
    expect(g.steps[3]).toMatchObject({ type: 'small', auto: true, answer: '5' });
    expect(g.steps[0].auto).toBe(false);

    // 50 million a day → 579/s. "2000" is off by ~3.5×: an arithmetic slip → 'small' returns.
    vi.setSystemTime(new Date(NOW.getTime() + 10 * 60_000));
    const c = await (await post('/api/envelope/check', { key: KEY, answer: '2000', mode: 'guided' })).json();
    expect(c.cause).toBe('arithmetic');
    g = await (await app.request(`/api/envelope/guided?key=${KEY}`)).json();
    expect(g.steps[3].auto).toBe(false);
    // The reset is not an error: the error rate for 'small' is still 0 of 3.
    const stats = await (await app.request('/api/envelope/stats')).json();
    expect(stats.steps.find((s: { type: string }) => s.type === 'small')).toMatchObject({ n: 3, missed: 0 });
  });
});

describe('drill picker, skill and endless sessions', () => {
  it('kind= serves only that kind (new quick kinds included), no due cards', async () => {
    svc.seedEnvelopeCards(NOW);
    for (const kind of ['words-to-sci', 'direction', 'sci-to-number', 'gbps-to-mbs']) {
      const s = await (await app.request(`/api/envelope/session?n=4&kind=${kind}`)).json();
      expect(s.items).toHaveLength(4);
      expect(s.items.every((i: { kind: string; card: boolean }) => i.kind === kind && !i.card)).toBe(true);
    }
    expect((await app.request('/api/envelope/session?kind=nope')).status).toBe(400);
  });

  it('skill= keeps due cards first, then the skill’s kinds; mode=endless fills from the weights', async () => {
    svc.seedEnvelopeCards(NOW);
    let s = await (await app.request('/api/envelope/session?n=8&skill=bits-bytes')).json();
    expect(s.items.slice(0, 5).every((i: { card: boolean }) => i.card)).toBe(true);
    expect(s.items.slice(5).every((i: { kind: string }) => ['gbps-to-mbs', 'mbs-to-gbps', 'direction', 'bandwidth'].includes(i.kind))).toBe(true);
    s = await (await app.request('/api/envelope/session?n=8&mode=endless')).json();
    expect(s.items).toHaveLength(8);
    expect(s.items[0].guided).toBe(true); // the seed cards plan
  });

  it('quick kinds are graded exactly, and the form is asked for', async () => {
    const s = await (await app.request('/api/envelope/session?n=1&kind=words-to-sci')).json();
    const key = s.items[0].key;
    const bad = await post('/api/envelope/check', { key, answer: '123456' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/small × 10ⁿ/);
    const d = await (await app.request('/api/envelope/session?n=1&kind=direction')).json();
    const r = await (await post('/api/envelope/check', { key: d.items[0].key, answer: 'divide' })).json();
    expect(typeof r.ok).toBe('boolean');
    if (!r.ok) expect(r.cause).toBe('direction');
  });
});

describe('anchor flashcards over HTTP', () => {
  it('all new at first; right in time moves a card on, slow counts as a miss', async () => {
    let a = await (await app.request('/api/envelope/anchors')).json();
    expect(a.cards).toHaveLength(10);
    expect(a.seconds).toBe(10);
    let r = await (await post('/api/envelope/anchors/check', { id: 'day', answer: '10^5', ms: 4000 })).json();
    expect(r).toMatchObject({ ok: true, grade: 'got' });
    r = await (await post('/api/envelope/anchors/check', { id: 'gbps', answer: '125', ms: 30_000 })).json();
    expect(r).toMatchObject({ ok: true, grade: 'missed' });
    a = await (await app.request('/api/envelope/anchors')).json();
    expect(a.cards.map((c: { id: string }) => c.id)).not.toContain('day');
    expect((await post('/api/envelope/anchors/check', { id: 'nope', answer: '1' })).status).toBe(404);
  });
});

describe('speed round over HTTP', () => {
  it('re-grades on the server, keeps the best and the history', async () => {
    const s = await (await app.request('/api/envelope/speed')).json();
    expect(s.items).toHaveLength(60);
    expect(s.best).toBeNull();
    const answers = s.items.slice(0, 6).map((i: { key: string; answerText: string }, n: number) => ({
      key: i.key,
      answer: n === 5 ? 'nonsense' : i.answerText.replace(/^≈ /, '').replace(/ \(.*\)$/, ''),
      atMs: n === 4 ? 70_000 : 5_000 * (n + 1),
    }));
    const r = await (await post('/api/envelope/speed', { answers })).json();
    expect(r).toMatchObject({ score: 4, attempted: 5, best: 4, newBest: true });
    const again = await (await app.request('/api/envelope/speed')).json();
    expect(again.best).toBe(4);
    expect(again.history).toHaveLength(1);
  });
});
