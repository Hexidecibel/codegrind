// =============================================================================
// refresh.compute — Pattern Refresh rules, pure
// =============================================================================
import { describe, it, expect } from 'vitest';
import {
  REFRESH_OFF,
  completeDay,
  coerceProgress,
  deriveRefreshSteps,
  mixedTopicsFor,
  nextRefreshDay,
  previousPlan,
  turnOn,
  type RefreshDeriveInput,
} from './refresh.compute.js';
import { REFRESH_DAYS, REFRESH_TOPICS } from '../../shared/pattern-shapes.js';

const SINCE = '2026-10-21T07:00:00.000Z';
const at = (h: number) => `2026-10-21T${String(8 + h).padStart(2, '0')}:00:00.000Z`;

const input = (over: Partial<RefreshDeriveInput> = {}): RefreshDeriveInput => ({
  day: 1,
  since: SINCE,
  dayStart: SINCE,
  attempts: [],
  cardsDue: 0,
  reviewsDue: 5, // ignored on a refresh day
  cardsReviewedToday: 0,
  envelope: { remaining: 0, doneToday: 0 },
  refreshAttempts: [],
  viewed: false,
  recall: null,
  coldProblemId: null,
  mixedTopics: ['hashing', 'stack', 'heap'],
  recognize: { done: false, doneToday: 0 },
  skips: [],
  endedEarly: false,
  hasDebrief: false,
  ...over,
});

const attempt = (topic: string, h: number, difficulty = 'easy', id = `${topic}-${h}`) => ({
  problemId: id,
  title: `P ${id}`,
  topic,
  difficulty,
  solved: true,
  hintsUsed: 0,
  createdAt: at(h),
});

const ids = (d: ReturnType<typeof deriveRefreshSteps>) => d.steps.map((s) => s.id);
const status = (d: ReturnType<typeof deriveRefreshSteps>, id: string) => d.steps.find((s) => s.id === id)?.status;

describe('day progression', () => {
  it('a new date gets the first uncompleted day; past the last day the refresh is over', () => {
    expect(nextRefreshDay(0)).toBe(1);
    expect(nextRefreshDay(4)).toBe(5);
    expect(nextRefreshDay(REFRESH_DAYS - 1)).toBe(REFRESH_DAYS);
    expect(nextRefreshDay(REFRESH_DAYS)).toBeNull();
  });

  it('completion latches forward only', () => {
    const p = turnOn(REFRESH_OFF, new Date('2026-10-21T20:00:00Z'));
    expect(completeDay(p, 1).completedThrough).toBe(1);
    expect(completeDay({ ...p, completedThrough: 3 }, 2).completedThrough).toBe(3);
  });

  it('turning on resumes a paused run, and restarts a finished one', () => {
    const now = new Date('2026-10-21T20:00:00Z');
    expect(turnOn({ on: false, completedThrough: 3, startedAt: 'x', finishedAt: null }, now)).toMatchObject({ on: true, completedThrough: 3, startedAt: 'x' });
    expect(turnOn({ on: false, completedThrough: REFRESH_DAYS, startedAt: 'x', finishedAt: 'y' }, now)).toMatchObject({
      on: true,
      completedThrough: 0,
      finishedAt: null,
    });
  });

  it('coerces a junk settings row to off', () => {
    expect(coerceProgress(null)).toEqual(REFRESH_OFF);
    expect(coerceProgress({ on: true, completedThrough: 99 }).completedThrough).toBe(REFRESH_DAYS);
  });
});

describe('deriveRefreshSteps', () => {
  it('day 1: the refresh steps, no mock or concept rep, cold review off', () => {
    const d = deriveRefreshSteps(input());
    expect(ids(d)).toEqual(['warmup', 'relearn', 'recall', 'practice', 'cold', 'recognize', 'debrief']);
    expect(ids(d)).not.toContain('mock');
    expect(ids(d)).not.toContain('concept');
    expect(d.current).toBe('relearn');
    expect(status(d, 'cold')).toBe('skipped');
    expect(d.steps.find((s) => s.id === 'cold')!.off).toBe(true);
    expect(status(d, 'debrief')).toBe('locked');
    // Review problems stay due: not part of a refresh warm-up.
    expect(status(d, 'warmup')).toBe('done');
    expect(d.steps.find((s) => s.id === 'practice')!.href).toBe('/manual?topic=hashing&difficulty=easy&from=today&step=practice');
  });

  it('no skipping: the day is complete only when every core step is done or skipped by hand', () => {
    expect(deriveRefreshSteps(input({ viewed: true, recall: { grade: 'got' } })).coreSettled).toBe(false);
    const done = deriveRefreshSteps(input({ viewed: true, recall: { grade: 'shaky' }, refreshAttempts: [attempt('hashing', 1)] }));
    expect(done.coreSettled).toBe(true);
    expect(status(done, 'debrief')).not.toBe('locked');
    // Skipped by hand counts...
    expect(deriveRefreshSteps(input({ viewed: true, recall: { grade: 'got' }, skips: ['practice'] })).coreSettled).toBe(true);
    // ...End day early's sweep does not: the same pattern comes back.
    const ended = deriveRefreshSteps(input({ endedEarly: true }));
    expect(status(ended, 'practice')).toBe('skipped');
    expect(ended.coreSettled).toBe(false);
  });

  it('practice counts only today’s topic; the cold review only yesterday’s', () => {
    const d = deriveRefreshSteps(
      input({ day: 3, refreshAttempts: [attempt('hashing', 1), attempt('two-pointer', 2)], coldProblemId: 'old-tp' })
    );
    // Day 3 = sliding window; yesterday = two pointers.
    expect(previousPlan(3)!.topic).toBe('two-pointer');
    expect(status(d, 'practice')).toBe('todo');
    expect(status(d, 'cold')).toBe('done');
    expect(d.steps.find((s) => s.id === 'cold')!.result).toContain('Two pointers');
    const fresh = deriveRefreshSteps(input({ day: 3 }));
    expect(fresh.steps.find((s) => s.id === 'cold')!.href).toBe('/manual?topic=two-pointer&difficulty=easy&hide=1&from=today&step=cold');
    expect(deriveRefreshSteps(input({ day: 3, coldProblemId: 'old-tp' })).steps.find((s) => s.id === 'cold')!.href).toBe(
      '/manual?problem=old-tp&hide=1&from=today&step=cold'
    );
  });

  it('day 9 is the mixed day: three hidden mediums', () => {
    const d = deriveRefreshSteps(input({ day: 9, refreshAttempts: [attempt('stack', 1, 'medium'), attempt('heap', 2, 'easy')] }));
    expect(ids(d)).toEqual(['warmup', 'mixed1', 'mixed2', 'mixed3', 'recognize', 'debrief']);
    expect(status(d, 'mixed1')).toBe('done');
    expect(status(d, 'mixed2')).toBe('current');
    expect(d.steps.find((s) => s.id === 'mixed2')!.href).toContain('difficulty=medium&hide=1');
  });

  it('mixed topics are three distinct refresh topics, stable per seed', () => {
    const a = mixedTopicsFor('2026-10-29');
    expect(new Set(a).size).toBe(3);
    for (const t of a) expect(REFRESH_TOPICS).toContain(t);
    expect(mixedTopicsFor('2026-10-29')).toEqual(a);
  });
});
