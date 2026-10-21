import { describe, it, expect } from 'vitest';
import { applicableNotes, type StepNotes } from './today.js';

const n = (note: string, carry: string, extra: Record<string, unknown> = {}) => ({ note, carry, at: '', model: 'm', costUsd: 0, ...extra });

// The 2026-10-21 snowball: a warm-up carry about stating rps (envelope advice)
// was judged against Problem 1, became "skipped 3 times", then the debrief's top fix.
const NOTES: StepNotes = {
  warmup: n('Envelope 4/5.', 'State the requests per second before coding.'),
  problem1: n('Passed on the 2nd submit.', 'Trace an edge case before submitting.'),
  problem2: n('Failed 3/10.', 'Clarify the input sizes first.'),
  mock: n('System design at level.', 'Name the bottleneck before the boxes.', { kind: 'system-design' }),
};

describe('carry applicability (Phase H)', () => {
  it('a step review sees earlier notes, but only the carry written FOR it', () => {
    const forP2 = applicableNotes(NOTES, 'problem2');
    expect(forP2.map((e) => e.step)).toEqual(['Warm-up', 'Problem 1']);
    expect(forP2.find((e) => e.step === 'Warm-up')!.carry).toBe('');
    expect(forP2.find((e) => e.step === 'Problem 1')!.carry).toBe('Trace an edge case before submitting.');
    // Nothing from later steps.
    expect(applicableNotes(NOTES, 'warmup')).toEqual([]);
  });

  it('the debrief reads notes, never carries', () => {
    const d = applicableNotes(NOTES, 'debrief');
    expect(d).toHaveLength(4);
    expect(d.every((e) => e.carry === '')).toBe(true);
  });

  it('an algorithm context never gets system-design or behavioral mock advice', () => {
    const algo = applicableNotes(NOTES, 'algorithm');
    expect(algo.map((e) => e.step)).not.toContain('Mock interview');
    // Carries that targeted an algorithm step survive; problem2's targeted the mock.
    expect(algo.find((e) => e.step === 'Problem 1')!.carry).toMatch(/Trace/);
    expect(algo.find((e) => e.step === 'Problem 2')!.carry).toBe('');
    const coding = applicableNotes({ ...NOTES, mock: n('Coding below level.', 'x', { kind: 'coding' }) }, 'algorithm');
    expect(coding.map((e) => e.step)).toContain('Mock interview');
  });

  it("a non-coding mock's setup gets notes only", () => {
    expect(applicableNotes(NOTES, 'mock').every((e) => e.carry === '')).toBe(true);
  });
});
