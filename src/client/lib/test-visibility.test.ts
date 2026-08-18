// The owner's rule, in one place: a hidden test's expected value is never shown,
// a sample test's always is, and the hidden case is EXPLICIT rather than absent
// so it reads as deliberate instead of broken.

import { describe as suite, it, expect } from 'vitest';
import { expectedDisplay, suiteFor } from './test-visibility';

suite('expectedDisplay — sample tests are meant to be read', () => {
  it('shows the value', () => {
    expect(expectedDisplay('sample', '[1,2]')).toEqual({
      kind: 'value',
      text: '[1,2]',
    });
  });

  it('shows nothing at all when the runner never reported one', () => {
    // A crash before the comparison — there is no expectation to render, and an
    // "— hidden —" here would be a lie about a sample test.
    expect(expectedDisplay('sample', undefined)).toEqual({ kind: 'none' });
  });
});

suite('expectedDisplay — hidden tests keep their answers', () => {
  it('withholds the value explicitly', () => {
    expect(expectedDisplay('hidden', undefined)).toEqual({ kind: 'hidden' });
  });

  it('withholds it even if one somehow arrived', () => {
    // Defence in depth against a stale client, a cached response or a future
    // re-hydration path: the suite decides, never the payload.
    expect(expectedDisplay('hidden', '10')).toEqual({ kind: 'hidden' });
  });
});

suite('suiteFor', () => {
  it('maps the two results panels onto the two suites', () => {
    expect(suiteFor('run')).toBe('sample');
    expect(suiteFor('submit')).toBe('hidden');
  });
});
