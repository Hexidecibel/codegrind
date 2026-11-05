import { describe, it, expect } from 'vitest';
import {
  DAILY_FOCUS_BIAS,
  coerceDebrief,
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
  type PendingReviewsInput,
  type DeriveInput,
  type TodayAttemptRow,
} from './today.compute.js';
import { MIXED_STEPS, QUICK_OFF_STEPS, REFRESH_STEPS } from '../../shared/today.js';

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
    // Phase H3: the concept rep is done in the default fixture, so the tests
    // that predate it still read the problem/mock flow they were written for.
    // The concept-rep tests below set it explicitly.
    concept: { doneToday: 1, last: { label: 'idempotency', grade: 'got' } },
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
    expect(status(d)).toEqual({ warmup: 'done', concept: 'done', problem1: 'current', problem2: 'todo', mock: 'todo', debrief: 'locked' });
    expect(d.current).toBe('problem1');
    expect(d.completed).toBe(2);
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
    expect(d.steps[2].result).toBe('Passed · T-a · 2 submits, 1 hint');
    expect(d.steps[2].ok).toBe(true);
    expect(d.steps[3].result).toBe('Failed · T-b · no hints');
    expect(d.steps[3].ok).toBe(false);
  });

  it('an active mock is in progress and links back into it', () => {
    const d = deriveSteps(
      input({
        attempts: [att('a', '2026-10-21T15:00:00Z'), att('b', '2026-10-21T16:00:00Z')],
        mocks: [{ id: 'm1', kind: 'system-design', status: 'active', verdict: null, createdAt: '2026-10-21T17:00:00Z' }],
      })
    );
    expect(d.current).toBe('mock');
    expect(d.steps[4].status).toBe('in-progress');
    expect(d.steps[4].href).toBe('/mock/m1?from=today&step=mock');
  });

  it('a graded mock unlocks the debrief and shows the verdict', () => {
    const d = deriveSteps(
      input({
        attempts: [att('a', '2026-10-21T15:00:00Z'), att('b', '2026-10-21T16:00:00Z')],
        mocks: [{ id: 'm1', kind: 'system-design', status: 'graded', verdict: 'below', createdAt: '2026-10-21T17:00:00Z' }],
      })
    );
    expect(status(d)).toMatchObject({ mock: 'done', debrief: 'current' });
    expect(d.steps[4].result).toBe('below level');
    expect(d.steps[4].ok).toBe(false);
  });

  it('skips move the current step on; a skipped mock unlocks the debrief', () => {
    const d = deriveSteps(input({ skips: ['problem1', 'mock'] }));
    expect(status(d)).toEqual({ warmup: 'done', concept: 'done', problem1: 'skipped', problem2: 'current', mock: 'skipped', debrief: 'todo' });
  });

  it('a skip is overridden by doing the step', () => {
    const d = deriveSteps(input({ skips: ['problem1'], attempts: [att('a', '2026-10-21T15:00:00Z')] }));
    expect(d.steps[2].status).toBe('done');
  });

  it('end day early skips every unfinished step and makes the debrief current', () => {
    const d = deriveSteps(input({ endedEarly: true, attempts: [att('a', '2026-10-21T15:00:00Z')] }));
    expect(status(d)).toEqual({ warmup: 'done', concept: 'done', problem1: 'done', problem2: 'skipped', mock: 'skipped', debrief: 'current' });
  });

  it('a debrief finishes the day', () => {
    const d = deriveSteps(input({ endedEarly: true, hasDebrief: true, debriefVerdict: 'Solid.' }));
    expect(d.current).toBeNull();
    expect(d.completed).toBe(6);
    // The verdict is the first line of the panel below; the row only points at it.
    expect(d.steps[5].result).toBe('Written — read it below');
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
    (['warmup', 'concept', 'problem1', 'problem2', 'mock', 'debrief'] as const).map((id) => ({
      id,
      // The concept rep (Phase H3) reads as skipped unless a test sets it.
      status: (statuses[id] ?? (id === 'concept' ? 'skipped' : 'todo')) as PendingReviewsInput['steps'][number]['status'],
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
  const settled = (['warmup', 'concept', 'problem1', 'problem2', 'mock', 'debrief'] as const).map((id) => ({
    id,
    status: (id === 'debrief' ? 'todo' : id === 'mock' ? 'done' : 'done') as PendingReviewsInput['steps'][number]['status'],
  }));
  const base = (over: Partial<PendingReviewsInput> = {}): PendingReviewsInput => ({
    steps: settled,
    warmupActivity: 2,
    recognizeDone: false,
    noted: ['warmup', 'concept', 'problem1', 'problem2', 'mock'],
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

// -----------------------------------------------------------------------------
// Phase H2
// -----------------------------------------------------------------------------
describe('pickMockKind — interview-loop bias (Phase H2)', () => {
  const kinds = ['system-design', 'behavioral', 'coding'] as const;
  it('a loop with one known round type wins over the debrief focus and rotation', () => {
    expect(pickMockKind({ kinds, lastKind: 'system-design', grades: [], focusKind: 'behavioral', loopKinds: ['coding'] })).toBe('coding');
  });
  it('rotates among the loop kinds: not yesterday\'s, weakest first', () => {
    const grades = [
      { kind: 'coding', verdict: 'above' as const },
      { kind: 'system-design', verdict: 'below' as const },
    ];
    // yesterday was coding → system design (the only other loop kind)
    expect(pickMockKind({ kinds, lastKind: 'coding', grades, focusKind: null, loopKinds: ['coding', 'system-design'] })).toBe('system-design');
    // yesterday was behavioral (not in the loop) → the weaker loop kind
    expect(pickMockKind({ kinds, lastKind: 'behavioral', grades, focusKind: null, loopKinds: ['coding', 'system-design'] })).toBe('system-design');
    // never graded counts as weakest
    expect(pickMockKind({ kinds, lastKind: null, grades: [{ kind: 'system-design', verdict: 'at' }], focusKind: null, loopKinds: ['system-design', 'behavioral'] })).toBe('behavioral');
  });
  it('no loop kinds (no loop, too far, or only unbuilt rounds) = the old rule', () => {
    expect(pickMockKind({ kinds, lastKind: 'system-design', grades: [], focusKind: null, loopKinds: [] })).toBe('behavioral');
  });
});

describe('deriveSteps — 30-min day (Phase H2)', () => {
  const at = (h: number) => new Date(Date.parse(DAY_START) + h * 3600_000).toISOString();
  it('turns Problem 2 and the mock off, keeps review problems out of the warm-up', () => {
    const d = deriveSteps(input({ quick: true, reviewsDue: 2, cardsDue: 0 }));
    const byId = Object.fromEntries(d.steps.map((s) => [s.id, s]));
    expect(byId.warmup.status).toBe('done'); // reviews stay due, but are not the warm-up's on a short day
    expect(byId.problem2.status).toBe('skipped');
    expect(byId.problem2.detail).toMatch(/30-min day/);
    expect(byId.mock.status).toBe('skipped');
    expect(d.current).toBe('problem1');
    // the debrief is not locked: the mock is settled (off)
    expect(byId.debrief.status).not.toBe('locked');
  });
  it('a due review re-solve counts as the one problem', () => {
    const attempts: TodayAttemptRow[] = [
      { problemId: 'r1', title: 'Old one', solved: true, hintsUsed: 0, createdAt: at(1), firstAt: '2026-10-01T00:00:00.000Z' },
    ];
    const quick = deriveSteps(input({ quick: true, attempts }));
    expect(quick.steps.find((s) => s.id === 'problem1')!.status).toBe('done');
    expect(quick.current).toBe('debrief');
    const full = deriveSteps(input({ attempts }));
    expect(full.steps.find((s) => s.id === 'problem1')!.status).not.toBe('done');
  });
  it('an open mock on a short day still shows as in progress', () => {
    const d = deriveSteps(input({ quick: true, mocks: [{ id: 'm', kind: 'coding', status: 'active', verdict: null, createdAt: at(1) }] }));
    expect(d.steps.find((s) => s.id === 'mock')!.status).toBe('in-progress');
  });
  it('says when the warm-up is a final review', () => {
    const d = deriveSteps(input({ cardsDue: 3, finalReview: { company: 'Acme', daysLeft: 2 } }));
    expect(d.steps[0].detail).toMatch(/^Final review before Acme \(in 2 days\)/);
  });
});

describe('deriveSteps — the coach read step (Phase 4)', () => {
  const pick = (over: { cached?: boolean } = {}) => ({
    reason: 'Because you slipped on search boundaries',
    read: { lessonId: 'fix:search-boundary:binary-search', title: 'Search boundaries', cached: over.cached ?? true },
  });

  it('no read input (or nothing to read) = no read step', () => {
    expect(deriveSteps(input()).steps.map((s) => s.id)).not.toContain('read');
    expect(deriveSteps(input({ read: { step: null, readToday: 0 } })).steps.map((s) => s.id)).not.toContain('read');
    expect(deriveSteps(input({ read: { step: { reason: 'Due for a re-solve' }, readToday: 0 } })).steps.map((s) => s.id)).not.toContain('read');
  });

  it('todo: sits after the concept rep, is current once the concept is done, links to the lesson', () => {
    const d = deriveSteps(input({ read: { step: pick(), readToday: 0 } }));
    expect(d.steps.map((s) => s.id)).toEqual(['warmup', 'concept', 'read', 'problem1', 'problem2', 'mock', 'debrief']);
    const read = d.steps.find((s) => s.id === 'read')!;
    expect(read.status).toBe('current');
    expect(d.current).toBe('read');
    expect(read.label).toBe('One lesson');
    expect(read.href).toBe('/study?lesson=fix%3Asearch-boundary%3Abinary-search&from=today&step=read');
    expect(read.detail).toBe('Because you slipped on search boundaries · Search boundaries');
    expect(d.steps).toHaveLength(7);
  });

  it('an unwritten fix lesson still links to it (Learn shows the stub; written on click only)', () => {
    const d = deriveSteps(input({ read: { step: pick({ cached: false }), readToday: 0 } }));
    expect(d.steps.find((s) => s.id === 'read')!.href).toContain('lesson=fix%3Asearch-boundary');
  });

  it('done once any lesson is read today, even with nothing left to pick', () => {
    const d = deriveSteps(input({ read: { step: pick(), readToday: 2, lastTitle: 'Two pointers' } }));
    const read = d.steps.find((s) => s.id === 'read')!;
    expect(read.status).toBe('done');
    expect(read.result).toBe('Read 2 lessons · Two pointers');
    expect(read.ok).toBe(true);
    expect(d.current).toBe('problem1');
    expect(d.completed).toBe(3);
    const none = deriveSteps(input({ read: { step: null, readToday: 1 } }));
    expect(none.steps.find((s) => s.id === 'read')!.status).toBe('done');
  });

  it('skipped by hand moves the day on; doing it overrides the skip', () => {
    const d = deriveSteps(input({ skips: ['read'], read: { step: pick(), readToday: 0 } }));
    expect(status(d)).toMatchObject({ concept: 'done', read: 'skipped', problem1: 'current' });
    expect(deriveSteps(input({ skips: ['read'], read: { step: pick(), readToday: 1 } })).steps.find((s) => s.id === 'read')!.status).toBe('done');
  });

  it('does not change the other steps: same statuses and current with the step done', () => {
    const cases: Partial<DeriveInput>[] = [
      {},
      { cardsDue: 2 },
      { concept: undefined },
      { attempts: [att('a', '2026-10-21T15:00:00Z')] },
      { skips: ['problem1', 'mock'] },
      { endedEarly: true },
      { quick: true },
    ];
    for (const c of cases) {
      const without = deriveSteps(input(c));
      const withRead = deriveSteps(input({ ...c, read: { step: pick(), readToday: 1 } }));
      expect(withRead.current).toBe(without.current);
      expect(withRead.steps.filter((s) => s.id !== 'read')).toEqual(without.steps);
    }
  });

  it('a todo read step is a normal step in sequence: it waits behind the warm-up and concept', () => {
    expect(deriveSteps(input({ cardsDue: 1, read: { step: pick(), readToday: 0 } })).current).toBe('warmup');
    expect(deriveSteps(input({ concept: undefined, read: { step: pick(), readToday: 0 } })).current).toBe('concept');
  });

  it('stays on a 30-min day (not in QUICK_OFF_STEPS); end day early sweeps it', () => {
    expect(status(deriveSteps(input({ quick: true, read: { step: pick(), readToday: 0 } }))).read).toBe('current');
    expect(status(deriveSteps(input({ endedEarly: true, read: { step: pick(), readToday: 0 } }))).read).toBe('skipped');
  });

  it('hidden on refresh days: no refresh or mixed day has a read step', () => {
    expect(REFRESH_STEPS).not.toContain('read');
    expect(MIXED_STEPS).not.toContain('read');
    expect(QUICK_OFF_STEPS).not.toContain('read');
  });

  it('a read alone is not practice: it never earns the debrief by itself', () => {
    const d = deriveSteps(input({ concept: undefined, endedEarly: true, read: { step: pick(), readToday: 1 } }));
    const due = pendingReviews({
      enabled: true,
      steps: d.steps,
      warmupActivity: 0,
      recognizeDone: false,
      mockOpen: false,
      hasDebrief: false,
      noted: [],
      failures: {},
      now: Date.parse('2026-10-21T20:00:00Z'),
    } as unknown as PendingReviewsInput);
    expect(due).not.toContain('debrief');
  });
});
