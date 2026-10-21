import { describe, it, expect } from 'vitest';
import { carryInto, isGrindLink, nextStepLink, todayStepFrom } from './today-flow';
import type { StepNote, TodayState, TodayStep, TodayStepId } from '@/shared/today';
import { carryNotesOf, renderCarryBlock } from '@/shared/today';

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
    expect(link).toEqual({ label: 'Next: Problem 1', href: '/grind?from=today&step=problem1', step: 'problem1', carry: null });
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
      carry: null,
    });
  });
});

const note = (n: string, carry: string): StepNote => ({ note: n, carry, at: '2026-10-21T17:00:00.000Z', model: 'm', costUsd: 0.004 });

describe('carry-forward (Phase F)', () => {
  it('the Next bar carries the latest EARLIER note into the current step', () => {
    const s = {
      ...state('problem2'),
      stepNotes: { warmup: note('Cards ok.', 'Name the invariant first.'), problem1: note('Off-by-one.', 'Trace the empty input before Submit.') },
    } as TodayState;
    const link = nextStepLink(s, 'problem1', '/mock');
    expect(link?.carry).toEqual({ from: 'Problem 1', text: 'Trace the empty input before Submit.' });
  });

  it('never carries a note from the current or a later step', () => {
    const s = { ...state('problem1'), stepNotes: { problem1: note('x', 'y'), mock: note('a', 'b') } } as TodayState;
    expect(carryInto(s, 'problem1')).toBeNull();
    expect(carryInto(s, 'problem2')).toEqual({ from: 'Problem 1', text: 'y' });
    // recognize rides with the warm-up: it carries into Problem 1
    expect(carryInto({ stepNotes: { recognize: note('r', 'Say the tell first.') } }, 'problem1')).toEqual({
      from: 'Recognize',
      text: 'Say the tell first.',
    });
    expect(carryInto({ stepNotes: {} }, null)).toBeNull();
  });

  it('renders the prompt block in step order, and nothing at all without notes', () => {
    expect(renderCarryBlock([])).toBe('');
    const block = renderCarryBlock(
      carryNotesOf({ problem1: note('Passed, 2 hints.', 'Predict first.'), warmup: note('3 cards.', 'Slow down.') })
    );
    expect(block.startsWith('\n\nEARLIER TODAY')).toBe(true);
    expect(block.indexOf('- Warm-up: 3 cards. Carry: Slow down.')).toBeGreaterThan(0);
    expect(block.indexOf('- Warm-up')).toBeLessThan(block.indexOf('- Problem 1: Passed, 2 hints. Carry: Predict first.'));
  });
});
