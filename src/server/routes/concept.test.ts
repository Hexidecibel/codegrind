// =============================================================================
// routes/concept — concept reps over HTTP, against a real (temporary) database
// =============================================================================
// The grade and lesson calls are faked; everything else is real. Pinned: the
// daily pick is frozen, teach-first on a new concept, a miss mints ONE drill card
// due tomorrow on the hidden anchor (never in the mock list), the daily cap, the
// "I don't know" no-call path, the coercers, and the concept step on Today.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fake = vi.hoisted(() => ({ runConceptGrade: vi.fn(), generateConceptLesson: vi.fn() }));
vi.mock('../services/llm.concept.js', async (orig) => ({
  ...(await orig<typeof import('../services/llm.concept.js')>()),
  runConceptGrade: fake.runConceptGrade,
  generateConceptLesson: fake.generateConceptLesson,
}));

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-concept-test-'));
if (!TEST_DATA_DIR.startsWith(tmpdir())) throw new Error('refusing to run outside tmpdir');
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.CODEGRIND_TZ = 'America/Los_Angeles';

const { conceptRoutes } = await import('./concept.js');
const { todayRoutes } = await import('./today.js');
const { db, setSetting } = await import('../services/db.js');
const svc = await import('../services/concept.service.js');
const { listMocks, CONCEPT_REPS_ANCHOR } = await import('../services/mock.store.js');
const { coerceConceptGrade, coerceConceptLesson } = await import('../services/llm.concept.js');
const { deriveSteps } = await import('../services/today.compute.js');

const app = new Hono();
app.route('/api', conceptRoutes);
app.route('/api', todayRoutes);

const NOW = new Date('2026-10-21T20:00:00.000Z');
const META = { servedModel: 'claude-sonnet-5', usage: { inputTokens: 1500, outputTokens: 1200, cachedInputTokens: 0 } };

const post = (url: string, body?: unknown) =>
  app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

afterAll(() => {
  vi.useRealTimers();
  db.close();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fake.runConceptGrade.mockReset();
  fake.generateConceptLesson.mockReset();
  svc.resetConceptBudgetForTest();
  for (const t of ['concept_reps', 'concept_learning', 'concept_lessons', 'daily_sessions', 'mock_gaps', 'mocks', 'interview_loops']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  setSetting('ai.reviews', false);
  setSetting('envelope.daily', 0);
});

const graded = (grade: string, missed: string[] = []) => ({
  result: { grade, hit: ['delete on write'], missed, modelAnswer: 'I would…', followUp: 'And then?', why: 'Because.' },
  meta: META,
});

describe('GET /api/concept/today', () => {
  it('a first day: an AI concept, new, teach-first with the primer, frozen for the day', async () => {
    const a = await (await app.request('/api/concept/today')).json();
    expect(a.category).toBe('ai');
    expect(a.state).toBe('new');
    expect(a.primer.keyPoints.length).toBeGreaterThanOrEqual(4);
    expect(a.lessonHref).toBe(`/concepts/${a.concept}`);
    const b = await (await app.request('/api/concept/today')).json();
    expect(b.concept).toBe(a.concept);
    // Acknowledging the primer learns it, but the day's rep keeps its primer.
    await post('/api/concept/learn', { concept: a.concept });
    const c = await (await app.request('/api/concept/today')).json();
    expect(c.state).toBe('learning');
    expect(c.primer).not.toBeNull();
  });
});

describe('POST /api/concept/grade', () => {
  it('a miss mints one drill card due tomorrow on the hidden anchor; a repeat miss reuses it', async () => {
    fake.runConceptGrade.mockResolvedValue(graded('missed', ['TTL as the safety net']));
    const res = await post('/api/concept/grade', { concept: 'caching-invalidation', promptIdx: 0, answer: 'you just cache it', primed: false });
    expect(res.status).toBe(200);
    const rep = await res.json();
    expect(rep.grade).toBe('missed');
    expect(rep.cardId).toEqual(expect.any(Number));
    const card = db.prepare(`SELECT * FROM mock_gaps WHERE id = ?`).get(rep.cardId) as Record<string, string>;
    expect(card.mockId).toBe(CONCEPT_REPS_ANCHOR);
    expect(card.source).toBe('rep');
    expect(card.concept).toBe('caching-invalidation');
    expect(card.title).toMatch(/^Walk me through how you would keep a cache consistent/);
    expect(card.answer).toMatch(/A Staff answer also covers: TTL as the safety net\./);
    expect(card.dueAt).toBe('2026-10-22T20:00:00.000Z');
    expect(listMocks().map((m) => m.id)).not.toContain(CONCEPT_REPS_ANCHOR);

    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const again = await (await post('/api/concept/grade', { concept: 'caching-invalidation', answer: 'still just cache it' })).json();
    expect(again.cardId).toBe(rep.cardId);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM mock_gaps`).get() as { n: number }).n).toBe(1);
  });

  it('a got mints nothing; a primed rep marks the concept learned', async () => {
    fake.runConceptGrade.mockResolvedValue(graded('got'));
    const rep = await (await post('/api/concept/grade', { concept: 'eval-design', answer: 'a versioned eval set…', primed: true })).json();
    expect(rep.cardId).toBeNull();
    expect(rep.primed).toBe(true);
    const track = await (await app.request('/api/concept/track')).json();
    expect(track.items.find((i: { concept: string }) => i.concept === 'eval-design').state).toBe('learning');
    expect(track.aiUnlocked).toBe(false);
    expect(fake.runConceptGrade.mock.calls[0][0]).toMatchObject({ primed: true, label: 'eval design' });
  });

  it('"I don\'t know" is missed with no call, the primer as the model answer', async () => {
    const rep = await (await post('/api/concept/grade', { concept: 'idempotency', answer: "I don't know" })).json();
    expect(fake.runConceptGrade).not.toHaveBeenCalled();
    expect(rep.grade).toBe('missed');
    expect(rep.modelAnswer).toMatch(/Idempotency makes a repeat/);
  });

  it('caps reps per day, refuses a double tap and an unknown concept', async () => {
    fake.runConceptGrade.mockResolvedValue(graded('got'));
    expect((await post('/api/concept/grade', { concept: 'nope', answer: 'x' })).status).toBe(400);
    expect((await post('/api/concept/grade', { concept: 'idempotency', answer: '' })).status).toBe(400);
    expect((await post('/api/concept/grade', { concept: 'idempotency', answer: 'keys' })).status).toBe(200);
    expect((await post('/api/concept/grade', { concept: 'idempotency', answer: 'keys' })).status).toBe(409); // double tap
    for (let i = 1; i <= 2; i++) {
      vi.setSystemTime(new Date(NOW.getTime() + i * 60_000));
      expect((await post('/api/concept/grade', { concept: 'replication', answer: 'leader' })).status).toBe(200);
    }
    vi.setSystemTime(new Date(NOW.getTime() + 10 * 60_000));
    expect((await post('/api/concept/grade', { concept: 'replication', answer: 'leader' })).status).toBe(409);
  });

  it('a model failure is a 502 and counts against the daily call budget', async () => {
    fake.runConceptGrade.mockRejectedValue(new Error('model down'));
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(new Date(NOW.getTime() + i * 60_000));
      expect((await post('/api/concept/grade', { concept: 'idempotency', answer: 'keys' })).status).toBe(502);
    }
    expect((await post('/api/concept/grade', { concept: 'idempotency', answer: 'keys' })).status).toBe(429);
    expect(fake.runConceptGrade).toHaveBeenCalledTimes(5);
  });
});

describe('the concept step on Today', () => {
  it('current after the warm-up; done with the grade once a rep lands', async () => {
    let t = await (await app.request('/api/today')).json();
    expect(t.current).toBe('concept');
    fake.runConceptGrade.mockResolvedValue(graded('shaky', ['a TTL']));
    await post('/api/concept/grade', { concept: 'idempotency', answer: 'keys' });
    t = await (await app.request('/api/today')).json();
    expect(t.steps[1]).toMatchObject({ status: 'done', result: 'Shaky · idempotency', ok: null });
    expect(t.current).toBe('problem1');
  });

  it('deriveSteps: 30-min day turns it off; a rep already done still counts', () => {
    const input = {
      dayStart: '2026-10-21T07:00:00.000Z',
      attempts: [],
      mocks: [],
      cardsDue: 0,
      reviewsDue: 0,
      cardsReviewedToday: 0,
      skips: [],
      endedEarly: false,
      mockKind: 'system-design' as const,
      mockKindLabel: 'System design',
      hasDebrief: false,
      debriefVerdict: null,
    };
    const off = deriveSteps({ ...input, quick: true });
    expect(off.steps[1]).toMatchObject({ id: 'concept', status: 'skipped' });
    expect(off.steps[1].detail).toMatch(/^Off today/);
    expect(off.current).toBe('problem1');
    const done = deriveSteps({ ...input, quick: true, concept: { doneToday: 1, last: { label: 'eval design', grade: 'missed' } } });
    expect(done.steps[1]).toMatchObject({ status: 'done', result: 'Missed · eval design', ok: false });
    expect(deriveSteps(input).current).toBe('concept');
    expect(deriveSteps({ ...input, skips: ['concept'] }).current).toBe('problem1');
  });
});

describe('lessons', () => {
  it('generated once, then cached; classic concepts have none', async () => {
    fake.generateConceptLesson.mockResolvedValue({
      result: { card: 'x', inInterview: 'y', failureModes: ['z'], workedExample: 'w', drawOn: [], staffAnswer: 's' },
      meta: META,
    });
    const a = await (await app.request('/api/concept/lesson/eval-design')).json();
    expect(a.label).toBe('eval design');
    await app.request('/api/concept/lesson/eval-design');
    expect(fake.generateConceptLesson).toHaveBeenCalledTimes(1);
    expect((await app.request('/api/concept/lesson/idempotency')).status).toBe(404);
  });
});

describe('coercion', () => {
  it('coerceConceptGrade: a bad grade is shaky, a string list is one item, markup is cut', () => {
    const g = coerceConceptGrade({ grade: 'GOT', hit: 'one point', missed: [1, '', 'b'], modelAnswer: 'm', followUp: 'f', why: 'w' });
    expect(g).toEqual({ grade: 'got', hit: ['one point'], missed: ['b'], modelAnswer: 'm', followUp: 'f', why: 'w' });
    expect(coerceConceptGrade(null).grade).toBe('shaky');
    expect(coerceConceptGrade({ grade: 'meh' }).grade).toBe('shaky');
  });

  it('coerceConceptLesson keeps only "You could draw on" items — never a claim about the user', () => {
    const l = coerceConceptLesson({
      card: 'c',
      inInterview: 'i',
      failureModes: ['a', 'b'],
      workedExample: 'e',
      drawOn: ['You could draw on your model router.', 'At dox, 40 customers used this.'],
      staffAnswer: 's',
    });
    expect(l.drawOn).toEqual(['You could draw on your model router.']);
    expect(l.failureModes).toEqual(['a', 'b']);
  });

  it('cardBackFor / mintsCard', () => {
    expect(svc.mintsCard('missed')).toBe(true);
    expect(svc.mintsCard('shaky')).toBe(true);
    expect(svc.mintsCard('got')).toBe(false);
    expect(svc.cardBackFor('idempotency', ['the in-flight case.'])).toMatch(/also covers: the in-flight case\.$/);
  });
});
