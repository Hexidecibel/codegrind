import { describe, it, expect } from 'vitest';
import {
  classifyGrind,
  localDates,
  pickTarget,
  reviewsByTopic,
  summarizeWindow,
  type TargetInput,
  type WeeklyAttempt,
  type WindowInput,
} from './weekly.compute.js';
import { curriculumOrder } from './reflect.compute.js';
import { TOPICS } from '../../shared/types.js';

const TZ = 'America/Chicago';
const H = 3600_000;
const DAY = 24 * H;

let seq = 0;
function att(over: Partial<WeeklyAttempt> & { createdAt: string }): WeeklyAttempt {
  return {
    id: `a${++seq}`,
    problemId: 'p1',
    pattern: 'arrays',
    difficulty: 'easy',
    solved: 1,
    hintsUsed: 0,
    testsPassed: 10,
    testsTotal: 10,
    language: 'javascript',
    ...over,
  };
}

function base(over: Partial<WindowInput> = {}): WindowInput {
  return {
    attempts: [],
    grindIds: new Set(),
    recognize: [],
    envelope: [],
    mocks: [],
    since: Date.parse('2026-10-28T05:00:00Z'), // local midnight Oct 28 (CDT)
    now: Date.parse('2026-11-03T20:00:00Z'),
    tz: TZ,
    ...over,
  };
}

describe('classifyGrind', () => {
  it('takes only the first `served` distinct problems of a sitting', () => {
    const s = { createdAt: '2026-11-02T15:00:00.000Z', served: 2 };
    const a = [
      att({ problemId: 'x', createdAt: '2026-11-02T15:05:00.000Z' }),
      att({ problemId: 'y', createdAt: '2026-11-02T15:20:00.000Z' }),
      att({ problemId: 'x', createdAt: '2026-11-02T15:25:00.000Z' }),
      att({ problemId: 'z', createdAt: '2026-11-02T15:40:00.000Z' }),
    ];
    const ids = classifyGrind(a, [s]);
    expect([...ids].sort()).toEqual([a[0].id, a[1].id, a[2].id].sort());
  });

  it('the 8h span is inclusive at the edge and excludes before the sitting', () => {
    const s = { createdAt: '2026-11-02T10:00:00.000Z', served: 5 };
    const before = att({ problemId: 'b', createdAt: '2026-11-02T09:59:59.000Z' });
    const edge = att({ problemId: 'e', createdAt: '2026-11-02T18:00:00.000Z' });
    const after = att({ problemId: 'l', createdAt: '2026-11-02T18:00:01.000Z' });
    const ids = classifyGrind([before, edge, after], [s]);
    expect(ids.has(edge.id)).toBe(true);
    expect(ids.has(before.id)).toBe(false);
    expect(ids.has(after.id)).toBe(false);
  });
});

describe('summarizeWindow', () => {
  it('splits grind vs free volume', () => {
    const a = [att({ problemId: 'x', createdAt: '2026-11-02T15:05:00.000Z' }), att({ problemId: 'y', createdAt: '2026-11-02T20:00:00.000Z' })];
    const s = summarizeWindow(base({ attempts: a, grindIds: new Set([a[0].id]) }));
    expect(s.subs).toBe(2);
    expect(s.grind).toEqual({ subs: 1, problems: 1 });
    expect(s.free).toEqual({ subs: 1, problems: 1 });
  });

  it('counts active days on local-day edges in CODEGRIND_TZ', () => {
    // 04:59Z Oct 29 is still Oct 28 in Chicago (CDT, UTC-5); 05:00Z is Oct 29.
    const a = [att({ createdAt: '2026-10-29T04:59:00.000Z' }), att({ createdAt: '2026-10-29T05:00:00.000Z' })];
    const s = summarizeWindow(base({ attempts: a }));
    expect(s.activeDays).toBe(2);
    expect(s.daily[0].date).toBe('2026-10-28');
    expect(s.daily[0].subs).toBe(1);
    expect(s.daily[1].subs).toBe(1);
    expect(s.daily[s.daily.length - 1].date).toBe('2026-11-03');
    expect(s.daily).toHaveLength(7);
  });

  it('practice days include Recognize, Envelope and finished mocks; active days only submits', () => {
    const s = summarizeWindow(
      base({
        attempts: [att({ createdAt: '2026-11-01T15:00:00.000Z' })],
        recognize: [{ topic: 'arrays', patternCorrect: 1, grade: 'got', createdAt: '2026-10-30T15:00:00.000Z', language: 'javascript' }],
        envelope: [{ ok: 1, createdAt: '2026-10-31T15:00:00.000Z' }],
        mocks: [
          { status: 'graded', createdAt: '2026-11-02T15:00:00.000Z', endedAt: '2026-11-02T16:00:00.000Z' },
          { status: 'abandoned', createdAt: '2026-11-03T15:00:00.000Z', endedAt: null },
        ],
      }),
    );
    expect(s.activeDays).toBe(1);
    expect(s.practiceDays).toBe(4);
    expect(s.mocks).toEqual({ inWindow: 1, lastAt: '2026-11-02T16:00:00.000Z' });
  });

  it('mock nudge fields: an old mock is lastAt but not in the window', () => {
    const s = summarizeWindow(base({ mocks: [{ status: 'graded', createdAt: '2026-10-01T15:00:00.000Z', endedAt: '2026-10-01T16:00:00.000Z' }] }));
    expect(s.mocks).toEqual({ inWindow: 0, lastAt: '2026-10-01T16:00:00.000Z' });
    expect(summarizeWindow(base()).mocks).toEqual({ inWindow: 0, lastAt: null });
  });

  it('near misses, hinted/unaided and same-day fixes', () => {
    const a = [
      att({ problemId: 'n', solved: 0, testsPassed: 8, testsTotal: 10, createdAt: '2026-11-02T15:00:00.000Z' }), // near miss
      att({ problemId: 'n', solved: 1, hintsUsed: 0, createdAt: '2026-11-02T15:30:00.000Z' }), // fixed unaided
      att({ problemId: 'm', solved: 0, testsPassed: 9, testsTotal: 10, createdAt: '2026-11-02T16:00:00.000Z' }), // near miss
      att({ problemId: 'm', solved: 1, hintsUsed: 2, createdAt: '2026-11-02T16:30:00.000Z' }), // fixed with hint
      att({ problemId: 'w', solved: 0, testsPassed: 2, testsTotal: 10, createdAt: '2026-11-02T17:00:00.000Z' }), // not near
    ];
    const s = summarizeWindow(base({ attempts: a }));
    expect(s.nearMisses).toEqual({ count: 2, fixed: 2, fixedUnaided: 1 });
    const t = s.topics.find((x) => x.topic === 'arrays')!;
    expect(t).toMatchObject({ attempts: 5, solved: 2, solvedPct: 40, nearMisses: 2, hinted: 1, unaided: 1 });
  });

  it('scopes topics and Recognize to a language, but not volume', () => {
    const a = [att({ createdAt: '2026-11-02T15:00:00.000Z' }), att({ pattern: 'stack', language: 'python', createdAt: '2026-11-02T16:00:00.000Z' })];
    const s = summarizeWindow(
      base({
        attempts: a,
        language: 'javascript',
        recognize: [
          { topic: 'heap', patternCorrect: 1, grade: 'got', createdAt: '2026-11-02T15:00:00.000Z', language: 'python' },
          { topic: 'trie', patternCorrect: 0, grade: 'missed', createdAt: '2026-11-02T15:00:00.000Z', language: 'javascript' },
        ],
      }),
    );
    expect(s.subs).toBe(2);
    expect(s.topics.map((t) => t.topic)).toEqual(['arrays']);
    expect(s.untouched).toContain('stack');
    expect(s.recognize.map((r) => r.topic)).toEqual(['trie']);
  });

  it('untouched keeps TOPICS order; topics sort by attempts', () => {
    const a = [
      att({ pattern: 'stack', createdAt: '2026-11-02T15:00:00.000Z' }),
      att({ pattern: 'heap', createdAt: '2026-11-02T15:00:00.000Z' }),
      att({ pattern: 'heap', createdAt: '2026-11-02T16:00:00.000Z' }),
    ];
    const s = summarizeWindow(base({ attempts: a }));
    expect(s.topics.map((t) => t.topic)).toEqual(['heap', 'stack']);
    expect(s.untouched).toEqual(TOPICS.filter((t) => t !== 'heap' && t !== 'stack'));
  });

  it('trend halves split at the window midpoint', () => {
    const since = Date.parse('2026-10-28T00:00:00Z');
    const now = since + 8 * DAY;
    const a = [
      att({ solved: 0, testsPassed: 0, createdAt: new Date(since + 1 * DAY).toISOString() }),
      att({ solved: 1, createdAt: new Date(since + 4 * DAY - 1).toISOString() }),
      att({ solved: 1, createdAt: new Date(since + 4 * DAY).toISOString() }),
    ];
    const t = summarizeWindow(base({ attempts: a, since, now })).topics[0];
    expect(t.trend).toEqual({ before: { n: 2, solved: 1 }, after: { n: 1, solved: 1 } });
  });

  it('ignores attempts before the window', () => {
    const s = summarizeWindow(base({ attempts: [att({ createdAt: '2026-10-01T15:00:00.000Z' })] }));
    expect(s.subs).toBe(0);
    expect(s.topics).toEqual([]);
  });
});

describe('localDates', () => {
  it('covers since..now inclusive in local days', () => {
    // DST ends Nov 1 2026: 05:30Z Nov 3 is still Nov 2 (23:30 CST).
    expect(localDates(Date.parse('2026-11-01T05:00:00Z'), Date.parse('2026-11-03T05:30:00Z'), TZ)).toEqual(['2026-11-01', '2026-11-02']);
  });
});

describe('reviewsByTopic', () => {
  it('counts due and >1-day overdue per topic, filtered by language', () => {
    const now = Date.parse('2026-11-03T20:00:00Z');
    const r = reviewsByTopic(
      [
        { topic: 'stack', dueAt: '2026-11-01T00:00:00.000Z', language: 'javascript' },
        { topic: 'stack', dueAt: '2026-11-03T19:00:00.000Z', language: 'javascript' },
        { topic: 'heap', dueAt: '2026-11-05T00:00:00.000Z', language: 'javascript' },
        { topic: 'trie', dueAt: '2026-10-01T00:00:00.000Z', language: 'python' },
      ],
      now,
      'javascript',
    );
    expect(r).toEqual([{ topic: 'stack', due: 2, overdue: 1 }]);
  });
});

describe('pickTarget', () => {
  const order = curriculumOrder();
  const topic = (t: string, attempts: number, solvedPct: number, nearMisses = 0) => ({
    topic: t,
    attempts,
    free: 0,
    solved: 0,
    solvedPct,
    nearMisses,
    hinted: 0,
    unaided: 0,
    trend: { before: { n: 0, solved: 0 }, after: { n: 0, solved: 0 } },
  });
  const input = (over: Partial<TargetInput> = {}): TargetInput => ({
    summary: { topics: [], untouched: [] },
    reviews: [],
    readiness: [{ id: 'algos', verdict: 'ready' }],
    refresh: null,
    order,
    unlocked: new Set(order),
    ...over,
  });

  it('1. refresh on and not done → the refresh pattern', () => {
    const t = pickTarget(
      input({
        refresh: { on: true, dayComplete: false, pattern: 'hash-map', topic: 'hashing', label: 'Hash map' },
        reviews: [{ topic: 'stack', due: 3, overdue: 3 }],
      }),
    );
    expect(t.kind).toBe('refresh');
    expect(t.href).toBe('/patterns#hash-map');
  });

  it('a finished refresh day falls through', () => {
    const t = pickTarget(input({ refresh: { on: true, dayComplete: true, pattern: null, topic: null, label: 'Mixed' } }));
    expect(t.kind).not.toBe('refresh');
  });

  it('2. overdue reviews → most overdue, ties by curriculum order', () => {
    const [first, second] = [order[3], order[1]];
    const t = pickTarget(
      input({
        reviews: [
          { topic: first, due: 2, overdue: 2 },
          { topic: second, due: 2, overdue: 2 },
          { topic: order[0], due: 5, overdue: 0 },
        ],
      }),
    );
    expect(t).toMatchObject({ kind: 'review', topic: second, href: '/grind' });
    expect(t.reason).toContain('2 overdue reviews');
  });

  it('3. struggling: ≥3 attempts under 50%, or ≥2 near misses; tie by curriculum order', () => {
    const t = pickTarget(
      input({
        summary: { topics: [topic(order[5], 4, 25), topic(order[2], 1, 100, 2), topic(order[0], 2, 0)], untouched: [] },
        lastDifficulty: new Map([[order[2], 'medium']]),
      }),
    );
    expect(t).toMatchObject({ kind: 'struggling', topic: order[2], href: `/manual?topic=${order[2]}&difficulty=medium` });
  });

  it('4. algorithms readiness not ready → one unseen medium', () => {
    const t = pickTarget(input({ readiness: [{ id: 'algos', verdict: 'close' }] }));
    expect(t).toMatchObject({ kind: 'unseen', href: '/grind' });
  });

  it('5. first untouched unlocked topic in curriculum order', () => {
    const t = pickTarget(input({ summary: { topics: [], untouched: [order[4], order[2], order[1]] }, unlocked: new Set([order[2], order[4]]) }));
    expect(t).toMatchObject({ kind: 'untouched', topic: order[2], href: `/manual?topic=${order[2]}&difficulty=easy` });
  });

  it('nothing left → the daily grind', () => {
    expect(pickTarget(input()).kind).toBe('grind');
  });
});
