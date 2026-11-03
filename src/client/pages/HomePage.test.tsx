// Home's top card: one Start / Continue for the current step; the step list's
// default open state. Static render, no jsdom.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { TodayState, TodayStep } from '@/shared/today';
import { CurrentStepCard, stepsOpenByDefault } from './HomePage';

function step(id: TodayStep['id'], status: TodayStep['status']): TodayStep {
  return { id, label: `Label ${id}`, status, href: `/x?from=today&step=${id}`, detail: `Detail ${id}`, result: null, ok: null };
}

function state(steps: TodayStep[], current: TodayState['current'], completed = 0): TodayState {
  return {
    steps,
    current,
    completed,
    total: steps.length,
    envelope: null,
    recognize: null,
    refresh: { on: false },
    stepNotes: {},
    aiPending: [],
  } as unknown as TodayState;
}

const render = (s: TodayState) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <CurrentStepCard state={s} busy={false} onSkip={() => undefined} />
    </MemoryRouter>,
  );

describe('stepsOpenByDefault', () => {
  it('closed before the first step, open mid-day, closed once complete', () => {
    expect(stepsOpenByDefault(state([step('warmup', 'current')], 'warmup', 0))).toBe(false);
    expect(stepsOpenByDefault(state([step('warmup', 'done'), step('problem1', 'current')], 'problem1', 1))).toBe(true);
    expect(stepsOpenByDefault(state([step('mock', 'in-progress')], 'mock', 0))).toBe(true);
    expect(stepsOpenByDefault(state([step('warmup', 'done')], null, 1))).toBe(false);
  });
});

describe('CurrentStepCard', () => {
  it('one big Start for the current step, with Skip', () => {
    const out = render(state([step('warmup', 'done'), step('problem1', 'current')], 'problem1', 1));
    expect(out).toContain('Label problem1');
    expect(out).toContain('href="/x?from=today&amp;step=problem1"');
    expect(out).toContain('Start');
    expect(out).toContain('Skip step');
    expect(out).not.toContain('Label warmup');
  });
  it('an in-progress step says Continue', () => {
    expect(render(state([step('mock', 'in-progress')], 'mock'))).toContain('Continue');
  });
  it('the day complete: a calm line and the debrief button', () => {
    const out = render(state([step('warmup', 'done'), step('debrief', 'done')], null, 2));
    expect(out).toContain('Day complete.');
    expect(out).toContain('Read the debrief');
  });
});
