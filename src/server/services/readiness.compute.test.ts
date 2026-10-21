import { describe, it, expect } from 'vitest';
import {
  ALGO_MIN_EVIDENCE,
  algorithmsArea,
  computeReadiness,
  mockArea,
  normComplexity,
  type ReadinessAttempt,
  type ReadinessInput,
} from './readiness.compute.js';

const NOW = Date.parse('2026-10-21T19:00:00.000Z');
const DAY = 86_400_000;
const ago = (d: number, h = 0) => new Date(NOW - d * DAY + h * 3600_000).toISOString();

const att = (problemId: string, at: string, over: Partial<ReadinessAttempt> = {}): ReadinessAttempt => ({
  problemId,
  difficulty: 'medium',
  solved: true,
  hintsUsed: 0,
  createdAt: at,
  confidence: null,
  predTime: null,
  refTime: null,
  ...over,
});

const base = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
  now: NOW,
  attempts: [],
  grades: [],
  cardReviews: [],
  nextLoop: null,
  ...over,
});

describe('readiness — algorithms (Phase H2)', () => {
  it('not enough evidence below the floor, with how many more', () => {
    const a = algorithmsArea(base({ attempts: [att('p1', ago(2)), att('p2', ago(3), { difficulty: 'easy' })] }));
    expect(a.verdict).toBe('not-enough');
    expect(a.evidence).toBe('1 unseen medium');
    expect(a.hint).toMatch(new RegExp(`Solve ${ALGO_MIN_EVIDENCE - 1} more unseen mediums`));
  });

  it('ready on a high first-try pass rate; a hint-assisted solve is a fail', () => {
    const attempts = [1, 2, 3, 4, 5, 6].map((i) => att(`p${i}`, ago(i)));
    expect(algorithmsArea(base({ attempts })).verdict).toBe('ready');
    const hinted = attempts.map((a, i) => (i < 3 ? { ...a, hintsUsed: 1 } : a));
    const r = algorithmsArea(base({ attempts: hinted }));
    // 3 of 6 passed, but the 3 failures are the most recent: weighted 48% < 50%
    expect(r.signals.find((s) => s.id === 'pass')!.value).toBe('48%');
    expect(r.verdict).toBe('not-yet');
    const olderHinted = attempts.map((a, i) => (i >= 4 ? { ...a, hintsUsed: 1 } : a));
    expect(algorithmsArea(base({ attempts: olderHinted })).verdict).toBe('close'); // 4/6, recent ones passed
  });

  it('weights recent evidence more (old passes, recent fails = not yet)', () => {
    const attempts = [
      ...[60, 61, 62].map((d, i) => att(`old${i}`, ago(d))),
      ...[1, 2, 3].map((d, i) => att(`new${i}`, ago(d), { solved: false })),
    ];
    const r = algorithmsArea(base({ attempts }));
    expect(r.verdict).toBe('not-yet');
    expect(r.signals.find((s) => s.id === 'pass')!.value).toBe('12%');
    expect(r.hint).toMatch(/bar 70%/);
  });

  it('a solve after a fail in the first session still passes only if unaided; a later session is retention', () => {
    const attempts = [
      ...[1, 2, 3, 4, 5].map((i) => att(`p${i}`, ago(20 + i))),
      // p1 re-solved cold 15+ days later: retention
      att('p1', ago(2)),
      att('p2', ago(2), { solved: false }),
      att('p3', ago(2), { solved: false }),
    ];
    const r = algorithmsArea(base({ attempts }));
    expect(r.signals.find((s) => s.id === 'retention')).toMatchObject({ value: '33%', n: 3 });
    expect(r.verdict).toBe('close'); // pass is fine, retention holds it back
    expect(r.hint).toMatch(/Cold re-solves/);
  });

  it('calibration: confidence vs result and predicted vs reference complexity', () => {
    expect(normComplexity('O(n log n)')).toBe('nlogn');
    const attempts = [1, 2, 3, 4, 5].map((i) =>
      att(`p${i}`, ago(i), { solved: false, confidence: 5, predTime: 'O(n)', refTime: 'O(n log n)' })
    );
    const r = algorithmsArea(base({ attempts }));
    expect(r.signals.find((s) => s.id === 'calibration')!.value).toBe('0%');
  });

  it('names the countdown when the area is in the loop and not ready', () => {
    const r = algorithmsArea(base({ nextLoop: { company: 'Acme', daysLeft: 9, rounds: ['coding'] } }));
    expect(r.inLoop).toBe(true);
    expect(r.hint).toMatch(/— 9 days to Acme$/);
    expect(algorithmsArea(base({ nextLoop: { company: 'Acme', daysLeft: 9, rounds: ['behavioral'] } })).inLoop).toBe(false);
  });
});

describe('readiness — mock areas (Phase H2)', () => {
  it('not enough evidence below 3 mocks, never a percentage', () => {
    const r = mockArea(base({ grades: [{ kind: 'behavioral', verdict: 'above' }] }), 'behavioral');
    expect(r).toMatchObject({ verdict: 'not-enough', evidence: '1 of 3 mocks' });
    expect(r.hint).toMatch(/2 more behavioral mocks.*last: above level/);
  });

  it('ready at level with a flat-or-up trend', () => {
    const grades = [
      { kind: 'system-design', verdict: 'at' as const },
      { kind: 'system-design', verdict: 'at' as const },
      { kind: 'system-design', verdict: 'below' as const },
    ];
    const r = mockArea(base({ grades }), 'system-design');
    expect(r.verdict).toBe('close'); // mean 0.67 < 1
    const better = [{ kind: 'system-design', verdict: 'above' as const }, ...grades];
    expect(mockArea(base({ grades: better }), 'system-design').verdict).toBe('ready'); // at,at,above → 1.33, trend +1
  });

  it('latest below = not ready, and says so', () => {
    const grades = [
      { kind: 'coding', verdict: 'below' as const },
      { kind: 'coding', verdict: 'above' as const },
      { kind: 'coding', verdict: 'above' as const },
    ];
    const r = mockArea(base({ grades }), 'coding');
    expect(r.verdict).toBe('close');
    expect(r.hint).toMatch(/graded below level/);
    const worse = [{ kind: 'coding', verdict: 'below' as const }, { kind: 'coding', verdict: 'below' as const }, { kind: 'coding', verdict: 'at' as const }];
    expect(mockArea(base({ grades: worse }), 'coding').verdict).toBe('not-yet');
  });

  it('card retention at 5+ days holds a ready back', () => {
    const grades = [1, 2, 3].map(() => ({ kind: 'system-design', verdict: 'at' as const }));
    const cards = [
      { kind: 'system-design', grade: 'missed', intervalDays: 6 },
      { kind: 'system-design', grade: 'missed', intervalDays: 7 },
      { kind: 'system-design', grade: 'got', intervalDays: 10 },
      { kind: 'system-design', grade: 'got', intervalDays: 1 }, // too soon to count
    ];
    const r = mockArea(base({ grades, cardReviews: cards }), 'system-design');
    expect(r.signals.find((s) => s.id === 'retention')).toMatchObject({ value: '33%', n: 3 });
    expect(r.verdict).toBe('close');
    expect(r.hint).toMatch(/Drill cards fade/);
  });

  it('every area, in order', () => {
    expect(computeReadiness(base()).map((a) => [a.id, a.verdict])).toEqual([
      ['algos', 'not-enough'],
      ['system-design', 'not-enough'],
      ['behavioral', 'not-enough'],
      ['coding', 'not-enough'],
    ]);
  });
});
