// =============================================================================
// gap-cards — the drill-card schedule, pinned
// =============================================================================
import { describe, it, expect } from 'vitest';
import {
  GAP_CARD_LADDER_DAYS,
  describeOutcome,
  gapKey,
  isGapCardGrade,
  isDoubleGrade,
  DOUBLE_GRADE_MS,
  newCardSchedule,
  scheduleGapCard,
  type GapCardSchedule,
} from './gap-cards';

const DAY = 86_400_000;
const T0 = new Date('2026-10-16T09:00:00.000Z');
const at = (days: number) => new Date(T0.getTime() + days * DAY);

describe('the drill-card schedule', () => {
  it('uses the review queue ladder: now, +2d, +5d, +10d', () => {
    expect([...GAP_CARD_LADDER_DAYS]).toEqual([0, 2, 5, 10]);
  });

  it('starts a new card on the bottom rung, due now', () => {
    expect(newCardSchedule(T0)).toEqual({
      step: 0,
      dueAt: T0.toISOString(),
      reps: 0,
      lapses: 0,
      lastGrade: null,
      lastReviewedAt: null,
      retiredAt: null,
    });
  });

  it('"got it" climbs the ladder and retires the card after the 10-day rung', () => {
    let c: GapCardSchedule = newCardSchedule(T0);
    c = scheduleGapCard(c, 'got', T0);
    expect(c).toMatchObject({ step: 1, dueAt: at(2).toISOString(), retiredAt: null, reps: 1 });
    c = scheduleGapCard(c, 'got', at(2));
    expect(c).toMatchObject({ step: 2, dueAt: at(7).toISOString(), retiredAt: null });
    c = scheduleGapCard(c, 'got', at(7));
    expect(c).toMatchObject({ step: 3, dueAt: at(17).toISOString(), retiredAt: null });
    c = scheduleGapCard(c, 'got', at(17));
    expect(c).toMatchObject({ step: 3, retiredAt: at(17).toISOString(), reps: 4, lastGrade: 'got' });
  });

  it('"shaky" repeats the same rung tomorrow — never a longer gap', () => {
    const c = scheduleGapCard({ ...newCardSchedule(T0), step: 2 }, 'shaky', T0);
    expect(c).toMatchObject({ step: 2, dueAt: at(1).toISOString(), lapses: 0, retiredAt: null, lastGrade: 'shaky' });
  });

  it('"missed" drops to the bottom rung, due again now, and counts a lapse', () => {
    const c = scheduleGapCard({ ...newCardSchedule(T0), step: 3, reps: 3 }, 'missed', at(17));
    expect(c).toMatchObject({ step: 0, dueAt: at(17).toISOString(), lapses: 1, reps: 4, retiredAt: null });
  });

  it('clamps a corrupt step instead of indexing off the ladder', () => {
    const c = scheduleGapCard({ ...newCardSchedule(T0), step: 99 }, 'shaky', T0);
    expect(c.step).toBe(3);
    const d = scheduleGapCard({ ...newCardSchedule(T0), step: -4 }, 'got', T0);
    expect(d).toMatchObject({ step: 1, dueAt: at(2).toISOString() });
  });

  it('does not mutate the card it was given', () => {
    const c = newCardSchedule(T0);
    const copy = { ...c };
    scheduleGapCard(c, 'got', T0);
    expect(c).toEqual(copy);
  });

  it('describes each outcome for the buttons', () => {
    const fresh = newCardSchedule(T0);
    expect(describeOutcome(fresh, 'got')).toBe('again in 2 days');
    expect(describeOutcome({ ...fresh, step: 3 }, 'got')).toBe('retires it');
    expect(describeOutcome(fresh, 'shaky')).toBe('again tomorrow');
    expect(describeOutcome(fresh, 'missed')).toBe('again now');
  });

  it('accepts only the three grades', () => {
    expect(['got', 'shaky', 'missed'].every(isGapCardGrade)).toBe(true);
    expect(isGapCardGrade('easy')).toBe(false);
    expect(isGapCardGrade(undefined)).toBe(false);
  });
});

describe('gapKey', () => {
  it('ignores case, punctuation and spacing, so a re-worded duplicate is caught', () => {
    expect(gapKey('301 vs 302: which, and why?')).toBe(gapKey('  301 VS 302 — which and why '));
    expect(gapKey('')).toBe('');
  });
});

describe('isDoubleGrade (Phase H)', () => {
  const now = new Date('2026-10-21T20:00:00.000Z');
  it('refuses a second grade inside the window, allows one after it', () => {
    expect(isDoubleGrade(null, now)).toBe(false);
    expect(isDoubleGrade(new Date(now.getTime() - 1_000).toISOString(), now)).toBe(true);
    expect(isDoubleGrade(new Date(now.getTime() - DOUBLE_GRADE_MS).toISOString(), now)).toBe(false);
    expect(isDoubleGrade(new Date(now.getTime() - 60_000).toISOString(), now)).toBe(false);
  });
});
