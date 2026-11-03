import { describe, it, expect } from 'vitest';
import {
  NEAR_MISS_THRESHOLD,
  aggregateCloseness,
  closeness,
  isNearMiss,
  mondayOf,
  type ClosenessAttempt,
} from './closeness';

const TZ = 'UTC';
// Wednesday 2026-11-04 12:00 UTC — its week starts Monday 2026-11-02.
const NOW = Date.parse('2026-11-04T12:00:00Z');

function att(at: string, problemId: string, passed: number, total: number, solved = false, hintsUsed = 0): ClosenessAttempt {
  return { problemId, solved, testsPassed: passed, testsTotal: total, hintsUsed, createdAt: at };
}

describe('closeness / isNearMiss', () => {
  it('is passed / total, null without tests', () => {
    expect(closeness(9, 12)).toBe(0.75);
    expect(closeness(0, 0)).toBeNull();
    expect(closeness(13, 12)).toBe(1);
  });

  it('a near miss is a FAILED run at or above the threshold', () => {
    expect(NEAR_MISS_THRESHOLD).toBe(0.75);
    expect(isNearMiss({ solved: false, testsPassed: 9, testsTotal: 12 })).toBe(true);
    expect(isNearMiss({ solved: false, testsPassed: 8, testsTotal: 12 })).toBe(false);
    expect(isNearMiss({ solved: true, testsPassed: 12, testsTotal: 12 })).toBe(false);
    expect(isNearMiss({ solved: false, testsPassed: 0, testsTotal: 0 })).toBe(false);
  });

  it('mondayOf walks back to the Monday', () => {
    expect(mondayOf('2026-11-04')).toBe('2026-11-02');
    expect(mondayOf('2026-11-02')).toBe('2026-11-02');
    expect(mondayOf('2026-11-08')).toBe('2026-11-02'); // Sunday
  });
});

describe('aggregateCloseness', () => {
  it('buckets failed runs per local week: mean closeness, near misses, same-day fixes', () => {
    const stats = aggregateCloseness(
      [
        // This week: a near miss on p1 fixed clean the same day…
        att('2026-11-03T10:00:00Z', 'p1', 11, 12),
        att('2026-11-03T10:05:00Z', 'p1', 10, 12), // a second near miss, same problem-day
        att('2026-11-03T10:10:00Z', 'p1', 12, 12, true),
        // …a near miss on p2 fixed WITH a hint: still fixed, not unaided…
        att('2026-11-03T11:00:00Z', 'p2', 9, 12),
        att('2026-11-03T11:10:00Z', 'p2', 12, 12, true, 1),
        // …and a real miss.
        att('2026-11-04T09:00:00Z', 'p3', 3, 12),
        // Last week: a near miss on p4 fixed the NEXT day — not same-day.
        att('2026-10-28T23:00:00Z', 'p4', 10, 10 + 2),
        att('2026-10-29T09:00:00Z', 'p4', 12, 12, true),
        // Solved runs never count toward closeness.
        att('2026-10-29T10:00:00Z', 'p5', 12, 12, true),
        // Outside the 12-week window: ignored.
        att('2026-01-01T10:00:00Z', 'p6', 1, 12),
      ],
      NOW,
      TZ
    );
    expect(stats.weeks).toHaveLength(12);
    expect(stats.weeks[11].weekStart).toBe('2026-11-02');
    expect(stats.weeks[10].weekStart).toBe('2026-10-26');
    const thisWeek = stats.weeks[11];
    expect(thisWeek.failed).toBe(4);
    expect(thisWeek.avgCloseness).toBeCloseTo((11 + 10 + 9 + 3) / 48);
    expect(thisWeek.nearMisses).toBe(3);
    expect(thisWeek.fixed).toBe(2); // p1 (counted once) and p2
    expect(thisWeek.fixedUnaided).toBe(1); // p1 only
    const lastWeek = stats.weeks[10];
    expect(lastWeek).toMatchObject({ failed: 1, nearMisses: 1, fixed: 0, fixedUnaided: 0 });
    expect(stats.weeks[0]).toMatchObject({ failed: 0, avgCloseness: null });
  });

  it('compares the last 4 weeks with the 4 before', () => {
    const stats = aggregateCloseness(
      [
        att('2026-11-03T10:00:00Z', 'a', 9, 12), // recent window
        att('2026-10-13T10:00:00Z', 'b', 6, 12), // recent window (4th week back)
        att('2026-10-05T10:00:00Z', 'c', 3, 12), // prior window
        att('2026-09-15T10:00:00Z', 'd', 0, 12), // prior window (8th week back)
        att('2026-09-08T10:00:00Z', 'e', 12, 24), // older than both: chart only
      ],
      NOW,
      TZ
    );
    expect(stats.recent).toMatchObject({ weeks: 4, failed: 2, nearMisses: 1, fixed: 0, fixedUnaided: 0 });
    expect(stats.recent.avgCloseness).toBeCloseTo(0.625);
    expect(stats.prior).toMatchObject({ weeks: 4, failed: 2, nearMisses: 0 });
    expect(stats.prior.avgCloseness).toBeCloseTo(0.125);
  });

  it('uses LOCAL days for weeks and for "the same day"', () => {
    // 23:30 Sunday in Los Angeles is Monday in UTC.
    const la = 'America/Los_Angeles';
    const stats = aggregateCloseness(
      [att('2026-11-02T07:30:00Z', 'p', 10, 12), att('2026-11-02T08:30:00Z', 'p', 12, 12, true)],
      NOW,
      la
    );
    // Both instants fall on Sunday Nov 1 / Mon Nov 2 local: 23:30 and 00:30.
    expect(stats.weeks[10]).toMatchObject({ weekStart: '2026-10-26', nearMisses: 1, fixed: 0, fixedUnaided: 0 });
    expect(stats.weeks[11].failed).toBe(0);
  });

  it('counts a hinted fix as fixed but not unaided; an unaided fix as both', () => {
    const stats = aggregateCloseness(
      [
        // Hinted fix: near miss, then a solve that asked for a hint.
        att('2026-11-03T10:00:00Z', 'hinted', 10, 12),
        att('2026-11-03T10:20:00Z', 'hinted', 12, 12, true, 2),
        // Unaided fix: near miss, then a clean solve.
        att('2026-11-03T11:00:00Z', 'clean', 11, 12),
        att('2026-11-03T11:15:00Z', 'clean', 12, 12, true, 0),
        // Hinted first, clean re-solve later the same day: one fix, unaided.
        att('2026-11-03T12:00:00Z', 'both', 9, 12),
        att('2026-11-03T12:10:00Z', 'both', 12, 12, true, 1),
        att('2026-11-03T12:40:00Z', 'both', 12, 12, true, 0),
        // A solve BEFORE the near miss fixes nothing.
        att('2026-11-03T13:00:00Z', 'early', 12, 12, true, 0),
        att('2026-11-03T13:10:00Z', 'early', 10, 12),
      ],
      NOW,
      TZ
    );
    expect(stats.weeks[11]).toMatchObject({ nearMisses: 4, fixed: 3, fixedUnaided: 2 });
    expect(stats.recent).toMatchObject({ nearMisses: 4, fixed: 3, fixedUnaided: 2 });
    expect(stats.prior).toMatchObject({ fixed: 0, fixedUnaided: 0 });
  });

  it('is empty, not broken, with no attempts', () => {
    const stats = aggregateCloseness([], NOW, TZ);
    expect(stats.weeks.every((w) => w.failed === 0)).toBe(true);
    expect(stats.recent.avgCloseness).toBeNull();
  });
});
