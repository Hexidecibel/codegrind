import { describe, it, expect } from 'vitest';
import {
  addDays,
  biasKinds,
  capDueAtIso,
  capDueAtMs,
  daysBetween,
  finalReviewDay,
  isDay,
  loopCountdown,
  loopMockKinds,
  nearestLoop,
  parseLoopBody,
  type InterviewLoop,
} from './loops.js';

const loop = (id: string, date: string, rounds: InterviewLoop['rounds'] = ['coding']): InterviewLoop => ({
  id,
  company: `Co-${id}`,
  date,
  rounds,
  postingId: null,
  postingTitle: null,
  createdAt: '2026-10-01T00:00:00.000Z',
});

describe('loop dates', () => {
  it('day arithmetic across month ends', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
    expect(daysBetween('2026-10-21', '2026-11-02')).toBe(12);
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('2026-10-21')).toBe(true);
  });
  it('the nearest loop is the earliest on or after today', () => {
    const loops = [loop('a', '2026-10-10'), loop('b', '2026-11-05'), loop('c', '2026-10-25')];
    expect(nearestLoop(loops, '2026-10-21')?.id).toBe('c');
    expect(nearestLoop(loops, '2026-10-25')?.id).toBe('c'); // the day itself still counts
    expect(nearestLoop(loops, '2026-11-06')).toBeNull();
  });
});

describe('final-review scheduling', () => {
  it('lands two days before the loop', () => {
    expect(finalReviewDay('2026-10-30', '2026-10-21')).toBe('2026-10-28');
  });
  it('is today when the loop is only one or two days out', () => {
    expect(finalReviewDay('2026-10-23', '2026-10-21')).toBe('2026-10-21');
    expect(finalReviewDay('2026-10-22', '2026-10-21')).toBe('2026-10-21');
  });
  it('never on or after the interview day', () => {
    expect(finalReviewDay('2026-10-21', '2026-10-21')).toBeNull();
    expect(finalReviewDay('2026-10-20', '2026-10-21')).toBeNull();
  });
  it('the countdown flags the final-review day', () => {
    const c = loopCountdown([loop('a', '2026-10-30')], '2026-10-28')!;
    expect(c).toMatchObject({ daysLeft: 2, finalReviewDay: '2026-10-28', isFinalReviewDay: true });
    expect(loopCountdown([loop('a', '2026-10-30')], '2026-10-21')!.isFinalReviewDay).toBe(false);
  });
});

describe('spacing cap', () => {
  const now = Date.parse('2026-10-21T19:00:00.000Z');
  it('pulls a later due date back to the deadline, leaves earlier ones', () => {
    expect(capDueAtMs(now + 10e8, now, now + 5e8)).toBe(now + 5e8);
    expect(capDueAtMs(now + 1e8, now, now + 5e8)).toBe(now + 1e8);
    expect(capDueAtMs(now + 10e8, now, null)).toBe(now + 10e8);
    expect(capDueAtMs(now + 10e8, now, now - 1)).toBe(now + 10e8);
    expect(capDueAtIso('garbage', now, now + 1)).toBe('garbage');
  });
});

describe('mock rotation kinds', () => {
  it('maps rounds to built kinds only (project-deep-dive / other ignored)', () => {
    expect(loopMockKinds(['project-deep-dive', 'coding', 'other', 'behavioral'])).toEqual(['behavioral', 'coding']);
  });
  it('biases only within 3 days', () => {
    expect(biasKinds({ daysLeft: 3, rounds: ['system-design'] })).toEqual(['system-design']);
    expect(biasKinds({ daysLeft: 4, rounds: ['system-design'] })).toEqual([]);
    expect(biasKinds(null)).toEqual([]);
  });
});

describe('parseLoopBody', () => {
  it('validates and normalises', () => {
    expect(parseLoopBody({ company: ' Acme ', date: '2026-11-02', rounds: ['behavioral', 'coding', 'bogus', 'coding'] })).toEqual({
      ok: true,
      value: { company: 'Acme', date: '2026-11-02', rounds: ['coding', 'behavioral'], postingId: null, postingTitle: null },
    });
    expect(parseLoopBody({ company: '', date: '2026-11-02', rounds: ['coding'] }).ok).toBe(false);
    expect(parseLoopBody({ company: 'A', date: '11/02', rounds: ['coding'] }).ok).toBe(false);
    expect(parseLoopBody({ company: 'A', date: '2026-11-02', rounds: [] }).ok).toBe(false);
  });
});
