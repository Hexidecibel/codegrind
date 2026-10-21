import { describe, it, expect } from 'vitest';
import { RUNG_DAYS, ladderOnCleanSolve, ladderOnMiss, ladderSnoozeDue, type LadderRow } from './review-ladder.js';

const TZ = 'America/Los_Angeles';
const DAY = 86_400_000;
const T0 = Date.parse('2026-10-21T19:00:00.000Z'); // noon PDT
const days = (from: number, iso: string) => (Date.parse(iso) - from) / DAY;

describe('the review ladder (Phase H)', () => {
  it('climbs 1 → 3 → 7 → 14 days on later-day clean solves, then clears', () => {
    expect([...RUNG_DAYS]).toEqual([1, 3, 7, 14]);
    let row: LadderRow = { ...ladderOnMiss(null, T0, TZ), clearedAt: null };
    expect(row.rung).toBe(0);
    expect(days(T0, row.dueAt)).toBe(1);
    let t = T0;
    for (const rung of [1, 2, 3]) {
      t = Date.parse(row.dueAt);
      const m = ladderOnCleanSolve(row, t, TZ)!;
      expect(m.rung).toBe(rung);
      expect(m.clearedAt).toBeNull();
      expect(days(t, m.dueAt)).toBe(RUNG_DAYS[rung]);
      row = m;
    }
    t = Date.parse(row.dueAt);
    expect(ladderOnCleanSolve(row, t, TZ)!.clearedAt).not.toBeNull();
  });

  it('a solve the same local day as the miss does not climb or clear', () => {
    const row: LadderRow = { ...ladderOnMiss(null, T0, TZ), dueAt: new Date(T0).toISOString() };
    expect(ladderOnCleanSolve(row, T0 + 20 * 60_000, TZ)).toBeNull();
  });

  it('a solve before the item is due does not climb', () => {
    const row = ladderOnMiss(null, T0, TZ);
    expect(ladderOnCleanSolve({ ...row, lastMissAt: new Date(T0 - 3 * DAY).toISOString() }, T0, TZ)).toBeNull();
  });

  it('a lapse drops one rung; a second miss the same day does not drop another', () => {
    const row: LadderRow = { rung: 3, lastMissAt: new Date(T0 - 30 * DAY).toISOString(), clearedAt: null, dueAt: new Date(T0).toISOString() };
    const first = ladderOnMiss(row, T0, TZ);
    expect(first.rung).toBe(2);
    expect(days(T0, first.dueAt)).toBe(7);
    const second = ladderOnMiss({ ...first }, T0 + 60_000, TZ);
    expect(second.rung).toBe(2);
  });

  it('a cleared item that is missed again starts at the bottom', () => {
    const row: LadderRow = { rung: 3, lastMissAt: null, clearedAt: new Date(T0 - DAY).toISOString(), dueAt: new Date(T0).toISOString() };
    expect(ladderOnMiss(row, T0, TZ).rung).toBe(0);
  });

  it('a snooze pushes by the current rung, never by zero', () => {
    expect(days(T0, ladderSnoozeDue({ rung: 0, lastMissAt: null, clearedAt: null, dueAt: '' }, T0))).toBe(1);
    expect(days(T0, ladderSnoozeDue({ rung: 2, lastMissAt: null, clearedAt: null, dueAt: '' }, T0))).toBe(7);
  });
});

describe('the review ladder — capped by the next interview loop (Phase H2)', () => {
  it('a rung interval past the loop deadline lands ON the deadline', () => {
    const deadline = T0 + 4 * DAY; // the final-review day starts in 4 days
    const row: LadderRow = { rung: 1, lastMissAt: '2026-10-01T00:00:00.000Z', clearedAt: null, dueAt: new Date(T0).toISOString() };
    const m = ladderOnCleanSolve(row, T0, TZ, deadline)!; // rung 2 = 7 days, capped
    expect(m.rung).toBe(2);
    expect(Date.parse(m.dueAt)).toBe(deadline);
    // without a loop it is the full interval
    expect(days(T0, ladderOnCleanSolve(row, T0, TZ, null)!.dueAt)).toBe(7);
  });
  it('an interval already inside the deadline is untouched', () => {
    const m = ladderOnMiss(null, T0, TZ, T0 + 4 * DAY);
    expect(days(T0, m.dueAt)).toBe(1);
  });
  it('a deadline already passed caps nothing (the final review covers it)', () => {
    const m = ladderOnMiss(null, T0, TZ, T0 - DAY);
    expect(days(T0, m.dueAt)).toBe(1);
  });
  it('a skip is capped too', () => {
    const row: LadderRow = { rung: 3, lastMissAt: null, clearedAt: null, dueAt: new Date(T0).toISOString() };
    expect(Date.parse(ladderSnoozeDue(row, T0, T0 + 2 * DAY))).toBe(T0 + 2 * DAY);
  });
});
