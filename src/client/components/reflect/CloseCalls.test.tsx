import { describe, it, expect } from 'vitest';
import { closenessHeadline, thresholdAsTests, unaidedPhrase } from './CloseCalls';

const w = (avgCloseness: number | null, nearMisses = 0, fixed = 0, fixedUnaided = 0) => ({
  weeks: 4,
  failed: avgCloseness === null ? 0 : 5,
  avgCloseness,
  nearMisses,
  fixed,
  fixedUnaided,
});

describe('Close calls copy', () => {
  it('pictures the threshold as tests', () => {
    expect(thresholdAsTests(0.75)).toBe('9/12');
  });

  it('phrases the unaided subset', () => {
    expect(unaidedPhrase(1)).toBe('1 without a hint');
    expect(unaidedPhrase(2)).toBe('2 without hints');
  });

  it('compares the windows without scolding', () => {
    expect(closenessHeadline(w(0.54, 6, 4, 1), w(0.25))).toBe(
      'Last 4 weeks: your failed runs passed 54% of tests on average, up from 25% the 4 weeks before. 6 close calls, 4 fixed the same day (1 without a hint).'
    );
    expect(closenessHeadline(w(0.4), w(0.5))).toBe(
      'Last 4 weeks: your failed runs passed 40% of tests on average, against 50% the 4 weeks before.'
    );
    expect(closenessHeadline(w(0.6, 1, 1), w(null))).toBe(
      'Last 4 weeks: your failed runs passed 60% of tests on average. 1 close call, 1 fixed the same day.'
    );
    expect(closenessHeadline(w(0.8, 3, 3, 3), w(null))).toBe(
      'Last 4 weeks: your failed runs passed 80% of tests on average. 3 close calls, 3 fixed the same day (3 without hints).'
    );
    expect(closenessHeadline(w(null), w(0.3))).toBe('No failed runs in the last 4 weeks.');
  });
});
