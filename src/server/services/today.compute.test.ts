import { describe, it, expect } from 'vitest';
import {
  DAILY_FOCUS_BIAS,
  coerceDebrief,
  computeReadiness,
  dailyFocusBias,
  dayStartMs,
  deriveSteps,
  localDay,
  localDayStreak,
  pickMockKind,
  pendingReviews,
  bumpFailure,
  missTopicsToday,
  missFocusBias,
  MISS_FOCUS_BIAS,
  MAX_AI_ATTEMPTS,
  FAILURE_COOLDOWN_MS,
  MAX_DEBRIEF_REGENS,
  MAX_NOTE_REFRESHES,
  READINESS_MIN_MOCKS,
  type PendingReviewsInput,
  type DeriveInput,
  type TodayAttemptRow,
} from './today.compute.js';

const TZ = 'America/Los_Angeles';
const DAY_START = '2026-10-21T07:00:00.000Z'; // local midnight, PDT

function input(over: Partial<DeriveInput> = {}): DeriveInput {
  return {
    dayStart: DAY_START,
    attempts: [],
    mocks: [],
    cardsDue: 0,
    reviewsDue: 0,
    cardsReviewedToday: 0,
    skips: [],
    endedEarly: false,
    mockKind: 'system-design',
    mockKindLabel: 'System design',
    hasDebrief: false,
    debriefVerdict: null,
    ...over,
  };
}

const att = (problemId: string, at: string, over: Partial<TodayAttemptRow> = {}): TodayAttemptRow => ({
  problemId,
  title: `T-${problemId}`,
  solved: true,
  hintsUsed: 0,
  createdAt: at,
  firstAt: at,
  ...over,
});

const status = (d: ReturnType<typeof deriveSteps>) => Object.fromEntries(d.steps.map((s) => [s.id, s.status]));

describe('the local day', () => {
  it('cuts at local midnight, not UTC', () => {
    // 2026-10-22T03:00Z is 8pm on the 21st in Los Angeles.
    expect(localDay(Date.parse('2026-10-22T03:00:00Z'), TZ)).toBe('2026-10-21');
    expect(new Date(dayStartMs('2026-10-21', TZ)).toISOString()).toBe(DAY_START);
  });

  it('survives a DST change (PST after Nov 1)', () => {
    expect(new Date(dayStartMs('2026-11-02', TZ)).toISOString()).toBe('2026-11-02T08:00:00.000Z');
  });

  it('streak: local days in a row, today grace', () => {
    const now = Date.parse('2026-10-21T20:00:00Z');
    const acts = ['2026-10-20T16:00:00Z', '2026-10-19T16:00:00Z', '2026-10-17T16:00:00Z'];
    expect(localDayStreak(acts, now, TZ)).toBe(2); // today empty, 20 + 19
    expect(localDayStreak([...acts, '2026-10-21T18:00:00Z'], now, TZ)).toBe(3);
    // 02:00Z on the 21st is the evening of the 20th locally — it does not count as today
    expect(localDayStreak(['2026-10-21T02:00:00Z'], now, TZ)).toBe(1);
  });
});

describe('deriveSteps', () => {
  it('a fresh day: nothing due → warm-up done, problem 1 current, debrief locked', () => {
    const d = deriveSteps(input());
    expect(status(d)).toEqual({ warmup: 'done', problem1: 'current', problem2: 'todo', mock: 'todo', debrief: 'locked' });
    expect(d.current).toBe('problem1');
    expect(d.completed).toBe(1);
  });

  it('a due pile makes the warm-up current and links to the cards first', () => {
    const d = deriveSteps(input({ cardsDue: 2, reviewsDue: 1 }));
    expect(d.current).toBe('warmup');
    expect(d.steps[0].href).toBe('/mock?from=today&step=warmup#cards');
    expect(d.steps[0].detail).toBe('2 drill cards + 1 review problem due');
    expect(deriveSteps(input({ reviewsDue: 1 })).steps[0].href).toBe('/grind?from=today&step=warmup');
  });

  it('review re-solves count for the warm-up, not as problem 1', () => {
    const d = deriveSteps(
      input({
        cardsReviewedToday: 3,
        attempts: [att('old', '2026-10-21T15:00:00Z', { firstAt: '2026-10-10T00:00:00Z' })],
      })
    );
    expect(d.steps[0].result).toBe('Cleared 4 (3 cards, 1 review)');
    expect(d.current).toBe('problem1');
  });

  it('new problems fill problem 1 then 2, with pass/fail results', () => {
    const d = deriveSteps(
      input({
        attempts: [
          att('a', '2026-10-21T15:00:00Z', { solved: false, hintsUsed: 1 }),
          att('a', '2026-10-21T15:10:00Z', { firstAt: '2026-10-21T15:00:00Z', solved: true }),
          att('b', '2026-10-21T16:00:00Z', { solved: false }),
        ],
      })
    );
    expect(status(d)).toMatchObject({ problem1: 'done', problem2: 'done', mock: 'current' });
    expect(d.steps[1].result).toBe('Passed · T-a · 2 submits, 1 hint');
    expect(d.steps[1].ok).toBe(true);
    expect(d.steps[2].result).toBe('Failed · T-b · no hints');
    expect(d.steps[2].ok).toBe(false);
  });

  it('an active mock is in progress and links back into it', () => {
    const d = deriveSteps(
      input({
        attempts: [att('a', '2026-10-21T15:00:00Z'), att('b', '2026-10-21T16:00:00Z')],
        mocks: [{ id: 'm1', kind: 'system-design', status: 'active', verdict: null, createdAt: '2026-10-21T17:00:00Z' }],
      })
    );
    expect(d.current).toBe('mock');
    expect(d.steps[3].status).toBe('in-progress');
    expect(d.steps[3].href).toBe('/mock/m1?from=today&step=mock');
  });

  it('a graded mock unlocks the debrief and shows the verdict', () => {
    const d = deriveSteps(
      input({
        attempts: [att('a', '2026-10-21T15:00:00Z'), att('b', '2026-10-21T16:00:00Z')],
        mocks: [{ id: 'm1', kind: 'system-design', status: 'graded', verdict: 'below', createdAt: '2026-10-21T17:00:00Z' }],
      })
    );
    expect(status(d)).toMatchObject({ mock: 'done', debrief: 'current' });
    expect(d.steps[3].result).toBe('below level');
    expect(d.steps[3].ok).toBe(false);
  });

  it('skips move the current step on; a skipped mock unlocks the debrief', () => {
    const d = deriveSteps(input({ skips: ['problem1', 'mock'] }));
    expect(status(d)).toEqual({ warmup: 'done', problem1: 'skipped', problem2: 'current', mock: 'skipped', debrief: 'todo' });
  });

  it('a skip is overridden by doing the step', () => {
    const d = deriveSteps(input({ skips: ['problem1'], attempts: [att('a', '2026-10-21T15:00:00Z')] }));
    expect(d.steps[1].status).toBe('done');
  });

  it('end day early skips every unfinished step and makes the debrief current', () => {
    const d = deriveSteps(input({ endedEarly: true, attempts: [att('a', '2026-10-21T15:00:00Z')] }));
    expect(status(d)).toEqual({ warmup: 'done', problem1: 'done', problem2: 'skipped', mock: 'skipped', debrief: 'current' });
  });

  it('a debrief finishes the day', () => {
    const d = deriveSteps(input({ endedEarly: true, hasDebrief: true, debriefVerdict: 'Solid.' }));
    expect(d.current).toBeNull();
    expect(d.completed).toBe(5);
    // The verdict is the first line of the panel below; the row only points at it.
    expect(d.steps[4].result).toBe('Written — read it below');
  });

  it('Skip wins over an open mock (Phase H: Skip did nothing while one was active)', () => {
    const d = deriveSteps(
      input({ skips: ['mock'], mocks: [{ id: 'm1', kind: 'system-design', status: 'grade_failed', verdict: null, createdAt: DAY_START }] })
    );
    expect(d.steps.find((s) => s.id === 'mock')!.status).toBe('skipped');
  });

  it("a graded mock of another kind than the day's pick says so", () => {
    const d = deriveSteps(
      input({ mocks: [{ id: 'm1', kind: 'coding', status: 'graded', verdict: 'at', createdAt: DAY_START }] })
    );
    const mock = d.steps.find((s) => s.id === 'mock')!;
    expect(mock.status).toBe('done');
    expect(mock.result).toBe("at level · Coding (today's pick was System design)");
  });
});

describe('pickMockKind', () => {
  const kinds = ['system-design', 'behavioral', 'coding'] as never;

  it('one kind → that kind, whatever else is going on', () => {
    expect(pickMockKind({ kinds: ['system-design'], lastKind: 'system-design', grades: [], focusKind: 'coding' })).toBe(
      'system-design'
    );
  });

  it('rotates in MOCK_KINDS order, wrapping', () => {
    expect(pickMockKind({ kinds, lastKind: null, grades: [], focusKind: null })).toBe('system-design');
    expect(pickMockKind({ kinds, lastKind: 'system-design', grades: [], focusKind: null })).toBe('behavioral');
    expect(pickMockKind({ kinds, lastKind: 'coding', grades: [], focusKind: null })).toBe('system-design');
  });

  it("the debrief's focus kind wins, if it exists", () => {
    expect(pickMockKind({ kinds, lastKind: 'system-design', grades: [], focusKind: 'coding' })).toBe('coding');
    expect(pickMockKind({ kinds, lastKind: 'system-design', grades: [], focusKind: 'nope' })).toBe('behavioral');
  });

  it('a kind trending below level jumps the queue — but not two days running', () => {
    const grades = [
      { kind: 'coding', verdict: 'below' as const },
      { kind: 'system-design', verdict: 'at' as const },
    ];
    expect(pickMockKind({ kinds, lastKind: 'system-design', grades, focusKind: null })).toBe('coding');
    expect(pickMockKind({ kinds, lastKind: 'coding', grades, focusKind: null })).toBe('system-design');
  });
});

describe('computeReadiness', () => {
  it('shows every area, "not started" without data', () => {
    const r = computeReadiness({ topics: [{ topic: 'arrays', attempts: 0, score: 0, tiered: false }], grades: [] });
    expect(r.map((a) => [a.id, a.pct, a.note])).toEqual([
      ['algos', null, 'not started'],
      ['system-design', null, 'not started'],
      ['behavioral', null, 'not started'],
      ['coding', null, 'not started'],
    ]);
  });

  it('algos from tier scores, mocks from the last three verdicts', () => {
    const r = computeReadiness({
      topics: [
        { topic: 'arrays', attempts: 3, score: 0.5, tiered: true },
        { topic: 'hashing', attempts: 0, score: 0, tiered: false },
      ],
      grades: [
        { kind: 'system-design', verdict: 'at' },
        { kind: 'system-design', verdict: 'below' },
        { kind: 'system-design', verdict: 'above' },
        { kind: 'system-design', verdict: 'below' }, // 4th: ignored
      ],
    });
    expect(r[0]).toMatchObject({ pct: 25, note: '1/2 topics tiered' });
    expect(r[1]).toMatchObject({ pct: 50, note: '4 mocks · last: at level' });
  });

  it('shows an evidence count, not a percentage, until there are READINESS_MIN_MOCKS grades (Phase H)', () => {
    const r = computeReadiness({ topics: [], grades: [{ kind: 'behavioral', verdict: 'above' }] });
    const b = r.find((a) => a.id === 'behavioral')!;
    expect(b.pct).toBeNull();
    expect(b.note).toBe(`1 of ${READINESS_MIN_MOCKS} mocks · last: above level`);
  });
});

describe('coerceDebrief', () => {
  it('keeps the good parts and drops the rest', () => {
    const d = coerceDebrief({
      verdict: '  Good day.  ',
      wins: ['a', 3, '', 'b'],
      fixes: [{ issue: 'x', action: 'drill y' }, { issue: 'no action' }, 'junk'],
      tomorrowFocus: { patterns: ['arrays', 'not-a-topic', 'arrays', 'hashing'], mockKind: 'system-design' },
    });
    expect(d).toEqual({
      verdict: 'Good day.',
      wins: ['a', 'b'],
      fixes: [{ issue: 'x', action: 'drill y' }],
      tomorrowFocus: { patterns: ['arrays', 'hashing'], mockKind: 'system-design' },
    });
  });

  it('never throws on garbage', () => {
    expect(coerceDebrief(null)).toEqual({
      verdict: 'Day logged.',
      wins: [],
      fixes: [],
      tomorrowFocus: { patterns: [], mockKind: null },
    });
    expect(coerceDebrief({ tomorrowFocus: { mockKind: 'behavioral-not-built' } }).tomorrowFocus.mockKind).toBeNull();
  });
});

describe('the scheduler hook', () => {
  it('leans toward focus topics, lighter than the session plan', () => {
    expect(dailyFocusBias('arrays', ['arrays'])).toBe(DAILY_FOCUS_BIAS);
    expect(dailyFocusBias('arrays', ['hashing'])).toBe(0);
    expect(dailyFocusBias('arrays', undefined)).toBe(0);
    expect(DAILY_FOCUS_BIAS).toBeLessThan(0.5);
  });
});

describe('pendingReviews (Phase F)', () => {
  const NOW = Date.parse('2026-10-21T20:00:00.000Z');
  const st = (statuses: Record<string, string>) =>
    (['warmup', 'problem1', 'problem2', 'mock', 'debrief'] as const).map((id) => ({
      id,
      status: (statuses[id] ?? 'todo') as PendingReviewsInput['steps'][number]['status'],
    }));
  const base = (over: Partial<PendingReviewsInput> = {}): PendingReviewsInput => ({
    steps: st({ warmup: 'done', problem1: 'done', problem2: 'current' }),
    warmupActivity: 2,
    recognizeDone: false,
    noted: [],
    hasDebrief: false,
    failures: {},
    enabled: true,
    now: NOW,
    ...over,
  });

  it('reviews finished steps with real activity, in order', () => {
    expect(pendingReviews(base())).toEqual(['warmup', 'problem1']);
    expect(pendingReviews(base({ warmupActivity: 0 }))).toEqual(['problem1']); // nothing was due
    expect(pendingReviews(base({ recognizeDone: true }))).toEqual(['warmup', 'recognize', 'problem1']);
  });

  it('skips what already has a note, and everything when the toggle is off', () => {
    expect(pendingReviews(base({ noted: ['warmup', 'problem1'] }))).toEqual([]);
    expect(pendingReviews(base({ enabled: false }))).toEqual([]);
  });

  it('adds the debrief LAST once every step is settled and something was done', () => {
    const settled = st({ warmup: 'done', problem1: 'done', problem2: 'skipped', mock: 'skipped' });
    expect(pendingReviews(base({ steps: settled }))).toEqual(['warmup', 'problem1', 'debrief']);
    expect(pendingReviews(base({ steps: settled, hasDebrief: true }))).toEqual(['warmup', 'problem1']);
    const empty = st({ warmup: 'done', problem1: 'skipped', problem2: 'skipped', mock: 'skipped' });
    expect(pendingReviews(base({ steps: empty, warmupActivity: 0 }))).toEqual([]);
  });

  it('a failure waits out the cooldown, and MAX_AI_ATTEMPTS failures end it for the day', () => {
    const at = new Date(NOW - 60_000);
    let failures = bumpFailure({}, 'problem1', at);
    expect(pendingReviews(base({ failures }))).toEqual(['warmup']);
    expect(pendingReviews(base({ failures, now: at.getTime() + FAILURE_COOLDOWN_MS }))).toEqual(['warmup', 'problem1']);
    for (let i = 1; i < MAX_AI_ATTEMPTS; i++) failures = bumpFailure(failures, 'problem1', at);
    expect(failures.problem1?.n).toBe(MAX_AI_ATTEMPTS);
    expect(pendingReviews(base({ failures, now: NOW + 86_400_000 }))).toEqual(['warmup']);
  });
});

describe('debrief timing and stale notes (Phase H)', () => {
  const NOW = Date.parse('2026-10-21T20:00:00.000Z');
  const settled = (['warmup', 'problem1', 'problem2', 'mock', 'debrief'] as const).map((id) => ({
    id,
    status: (id === 'debrief' ? 'todo' : id === 'mock' ? 'done' : 'done') as PendingReviewsInput['steps'][number]['status'],
  }));
  const base = (over: Partial<PendingReviewsInput> = {}): PendingReviewsInput => ({
    steps: settled,
    warmupActivity: 2,
    recognizeDone: false,
    noted: ['warmup', 'problem1', 'problem2', 'mock'],
    hasDebrief: false,
    failures: {},
    enabled: true,
    now: NOW,
    ...over,
  });

  it('the auto debrief waits while a mock is still running or grading, though every step is done', () => {
    expect(pendingReviews(base())).toEqual(['debrief']);
    expect(pendingReviews(base({ mockOpen: true }))).toEqual([]);
  });

  it('a written debrief is regenerated only when a later mock grade made it stale', () => {
    expect(pendingReviews(base({ hasDebrief: true }))).toEqual([]);
    expect(pendingReviews(base({ hasDebrief: true, debriefStale: true }))).toEqual(['debrief']);
    // ...and not while that new mock's day is still open.
    expect(pendingReviews(base({ hasDebrief: true, debriefStale: true, mockOpen: true }))).toEqual([]);
    expect(MAX_DEBRIEF_REGENS).toBe(1);
  });

  it('a stale warm-up note is rewritten; a fresh one is not', () => {
    expect(pendingReviews(base({ hasDebrief: true }))).toEqual([]);
    expect(pendingReviews(base({ hasDebrief: true, staleNotes: ['warmup'] }))).toEqual(['warmup']);
    expect(MAX_NOTE_REFRESHES).toBe(1);
  });
});

describe('miss focus (Phase F)', () => {
  it('collects today\'s recognize misses and pattern-naming card misses, deduped and ordered', () => {
    expect(
      missTopicsToday({
        recognize: [
          { topic: 'heap', grade: 'missed' },
          { topic: 'trie', grade: 'got' },
          { topic: 'sliding-window', grade: 'shaky' },
          { topic: 'heap', grade: 'missed' },
          { topic: 'not-a-topic', grade: 'missed' },
        ],
        cards: [
          { kind: 'coding', title: 'When does a sliding window fail?', summary: '', answer: 'Use binary search on the answer.', lastGrade: 'missed' },
          { kind: 'coding', title: 'Explain graphs', summary: '', answer: '', lastGrade: 'got' },
          // A system-design card naming "hashing" is not a hash-map miss.
          { kind: 'system-design', title: 'Consistent hashing ring', summary: '', answer: '', lastGrade: 'shaky' },
        ],
      })
    ).toEqual(['heap', 'sliding-window', 'binary-search']);
  });

  it('is a small lean', () => {
    expect(missFocusBias('heap', ['heap'])).toBe(MISS_FOCUS_BIAS);
    expect(missFocusBias('heap', [])).toBe(0);
    expect(missFocusBias('heap', undefined)).toBe(0);
    expect(MISS_FOCUS_BIAS).toBeLessThan(DAILY_FOCUS_BIAS);
  });
});
