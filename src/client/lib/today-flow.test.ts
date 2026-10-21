import { describe, it, expect } from 'vitest';
import { isGrindLink, nextStepLink, todayStepFrom } from './today-flow';
import type { TodayState, TodayStep, TodayStepId } from '@/shared/today';

function state(current: TodayStepId | null, hrefs: Partial<Record<TodayStepId, string>> = {}): TodayState {
  const ids: TodayStepId[] = ['warmup', 'problem1', 'problem2', 'mock', 'debrief'];
  const steps: TodayStep[] = ids.map((id) => ({
    id,
    label: id === 'problem1' ? 'Problem 1' : id,
    status: id === current ? 'current' : 'todo',
    href: hrefs[id] ?? (id.startsWith('problem') ? `/grind?from=today&step=${id}` : `/mock?from=today&step=${id}`),
    detail: '',
    result: null,
    ok: null,
  }));
  return { current, steps } as TodayState;
}

describe('todayStepFrom', () => {
  it('reads from=today&step', () => {
    expect(todayStepFrom('?from=today&step=problem1')).toBe('problem1');
    expect(todayStepFrom('?step=problem1')).toBeNull();
    expect(todayStepFrom('?from=today&step=nap')).toBeNull();
  });
});

describe('nextStepLink', () => {
  it('nothing while this screen is still the current step', () => {
    expect(nextStepLink(state('problem1'), 'problem1', '/grind')).toBeNull();
  });

  it('points at the current step once this one is done', () => {
    const link = nextStepLink(state('problem1'), 'warmup', '/mock');
    expect(link).toEqual({ label: 'Next: Problem 1', href: '/grind?from=today&step=problem1', step: 'problem1' });
    expect(isGrindLink(link)).toBe(true);
  });

  it('continues the same step on another screen (cards done, reviews left)', () => {
    const s = state('warmup', { warmup: '/grind?from=today&step=warmup' });
    expect(nextStepLink(s, 'warmup', '/mock')?.label).toBe('Continue: warmup');
    expect(nextStepLink(s, 'warmup', '/grind')).toBeNull();
  });

  it('day complete → back to Today', () => {
    expect(nextStepLink(state(null), 'mock', '/mock')).toEqual({
      label: 'Day complete — back to Today',
      href: '/today',
      step: null,
    });
  });
});
