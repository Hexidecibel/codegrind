import { describe, it, expect } from 'vitest';
import { closenessHeadline, thresholdAsTests } from './CloseCalls';

const w = (avgCloseness: number | null, nearMisses = 0, recovered = 0) => ({
  weeks: 4,
  failed: avgCloseness === null ? 0 : 5,
  avgCloseness,
  nearMisses,
  recovered,
});

describe('Close calls copy', () => {
  it('pictures the threshold as tests', () => {
    expect(thresholdAsTests(0.75)).toBe('9/12');
  });

  it('compares the windows without scolding', () => {
    expect(closenessHeadline(w(0.54, 6, 4), w(0.25))).toBe(
      'Last 4 weeks: your failed runs passed 54% of tests on average, up from 25% the 4 weeks before. 6 close calls, 4 fixed the same day.'
    );
    expect(closenessHeadline(w(0.4), w(0.5))).toBe(
      'Last 4 weeks: your failed runs passed 40% of tests on average, against 50% the 4 weeks before.'
    );
    expect(closenessHeadline(w(0.6, 1, 1), w(null))).toBe(
      'Last 4 weeks: your failed runs passed 60% of tests on average. 1 close call, 1 fixed the same day.'
    );
    expect(closenessHeadline(w(null), w(0.3))).toBe('No failed runs in the last 4 weeks.');
  });
});
