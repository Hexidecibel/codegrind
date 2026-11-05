import { describe, it, expect } from 'vitest';
import { phoneNext, splitByPlace, stepPlace } from './phone';
import { MIXED_STEPS, REFRESH_STEPS, TODAY_STEPS, ALL_STEP_IDS, type TodayStep, type TodayStepId, type TodayStepStatus } from './today';

function day(ids: readonly TodayStepId[], status: Partial<Record<TodayStepId, TodayStepStatus>> = {}): TodayStep[] {
  let seen = false;
  return ids.map((id) => {
    let st = status[id] ?? 'todo';
    if (id === 'debrief' && !status.debrief) st = 'locked';
    if (st === 'todo' && !seen) { st = 'current'; seen = true; }
    if (st === 'in-progress') seen = true;
    return { id, label: id, status: st, href: `/${id}`, detail: '', result: null, ok: null };
  });
}

describe('stepPlace', () => {
  it('sorts every step id', () => {
    const phone = ALL_STEP_IDS.filter((id) => stepPlace(id, 'system-design') === 'phone');
    expect(phone).toEqual(['warmup', 'concept', 'read', 'mock', 'relearn', 'recall', 'recognize', 'debrief']);
  });

  it('sends a coding mock to the iPad, and every other kind to the phone', () => {
    expect(stepPlace('mock', 'coding')).toBe('ipad');
    for (const k of ['system-design', 'behavioral', 'project-deep-dive'] as const) expect(stepPlace('mock', k)).toBe('phone');
  });
});

describe('phoneNext', () => {
  it('a normal day: warm-up, then the concept, then past both problems to the mock', () => {
    expect(phoneNext(day(TODAY_STEPS), 'behavioral')?.id).toBe('warmup');
    const after = day(TODAY_STEPS, { warmup: 'done', concept: 'done', read: 'done' });
    expect(after.find((s) => s.status === 'current')?.id).toBe('problem1');
    expect(phoneNext(after, 'behavioral')?.id).toBe('mock');
  });

  it('the read step is the phone\'s: offered after the concept rep', () => {
    expect(phoneNext(day(TODAY_STEPS, { warmup: 'done', concept: 'done' }), 'coding')?.id).toBe('read');
  });

  it('a coding mock is skipped over, and a locked debrief is not offered', () => {
    expect(phoneNext(day(TODAY_STEPS, { warmup: 'done', concept: 'done', read: 'done' }), 'coding')).toBeNull();
  });

  it('an unlocked debrief is offered', () => {
    const d = day(TODAY_STEPS, { warmup: 'done', concept: 'done', read: 'done', problem1: 'done', problem2: 'done', mock: 'skipped', debrief: 'todo' });
    expect(phoneNext(d, 'coding')?.id).toBe('debrief');
  });

  it('a mock in progress stays the next one', () => {
    expect(phoneNext(day(TODAY_STEPS, { warmup: 'done', concept: 'done', read: 'done', mock: 'in-progress' }), 'system-design')?.id).toBe('mock');
  });

  it('a refresh day: relearn and recall, then recognize past practice and cold', () => {
    const d = day(REFRESH_STEPS, { warmup: 'done', relearn: 'done', recall: 'done' });
    expect(phoneNext(d, 'coding')?.id).toBe('recognize');
    expect(splitByPlace(d, 'coding').ipad.map((s) => s.id)).toEqual(['practice', 'cold']);
  });

  it('a mixed day: only the warm-up, recognize and the debrief are the phone\'s', () => {
    const d = day(MIXED_STEPS);
    expect(splitByPlace(d, 'system-design').phone.map((s) => s.id)).toEqual(['warmup', 'recognize', 'debrief']);
    expect(phoneNext(day(MIXED_STEPS, { warmup: 'done' }), 'system-design')?.id).toBe('recognize');
  });

  it('all done: nothing', () => {
    const all = Object.fromEntries(TODAY_STEPS.map((id) => [id, 'done'])) as Record<TodayStepId, TodayStepStatus>;
    expect(phoneNext(day(TODAY_STEPS, all), 'behavioral')).toBeNull();
  });

  it('a warm-up down to its review problems waits for the iPad', () => {
    const d = day(TODAY_STEPS);
    d[0].href = '/grind?from=today&step=warmup';
    expect(phoneNext(d, 'behavioral')?.id).toBe('concept');
    expect(splitByPlace(d, 'behavioral').ipad.map((s) => s.id)).toEqual(['warmup', 'problem1', 'problem2']);
  });

  it('skipped steps are not offered', () => {
    expect(phoneNext(day(TODAY_STEPS, { warmup: 'skipped' }), 'behavioral')?.id).toBe('concept');
  });
});
