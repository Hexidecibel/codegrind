// =============================================================================
// problem-repair.test — the patch format behind bin/repair-problem
// =============================================================================
// The sandbox half (canonicalize, validateExamples) is tested where it lives;
// this holds the patch reader to refusing what a typo would silently do.

import { describe, it, expect } from 'vitest';
import { parsePatch, applyPatch, testDiff, type RepairableProblem } from './problem-repair.js';

const base = (): RepairableProblem => ({
  prompt: 'Return the sum.',
  constraints: ['1 <= n'],
  starterCode: 'function f(a) {}',
  referenceSolution: 'function f(a) { return a; }',
  examples: [{ input: 'a = 1', output: '1' }],
  sampleTests: [{ name: 's1', args: [1], expected: 1 }],
  hiddenTests: [
    { name: 'h1', args: [2], expected: 2 },
    { name: 'h2', args: [1, 2, 3], expected: null },
  ],
});

describe('parsePatch', () => {
  it('accepts every documented field', () => {
    const p = parsePatch({
      id: 'x',
      note: 'why',
      prompt: 'p',
      constraints: ['c'],
      starterCode: 's',
      referenceSolution: 'r',
      examples: [{ input: 'a = 1', output: '1', explanation: 'e' }],
      dropTests: ['h2'],
      retire: false,
    });
    expect(p.dropTests).toEqual(['h2']);
  });

  it('refuses unknown fields, wrong types, empty edits — all at once', () => {
    expect(() => parsePatch({ promt: 'typo' })).toThrow(/unknown field "promt"/);
    expect(() => parsePatch({ id: 'x' })).toThrow(/changes nothing/);
    expect(() => parsePatch({ examples: [{ input: 'a = 1' }] })).toThrow(/examples\[0\]/);
    expect(() => parsePatch({ prompt: '  ', retire: 'yes' })).toThrow(/prompt must be.*retire must be/);
    expect(() => parsePatch([])).toThrow(/JSON object/);
  });
});

describe('applyPatch', () => {
  it('replaces only the fields given and says what needs re-deriving', () => {
    const r = applyPatch(base(), { prompt: 'New.' });
    expect(r.problem.prompt).toBe('New.');
    expect(r.problem.referenceSolution).toBe(base().referenceSolution);
    expect(r).toMatchObject({ refChanged: false, testsChanged: false });

    expect(applyPatch(base(), { referenceSolution: 'function f(a) { return a + 0; }' }).refChanged).toBe(true);
    expect(applyPatch(base(), { referenceSolution: base().referenceSolution }).refChanged).toBe(false);
  });

  it('drops named tests from either set, and refuses a name that does not exist', () => {
    const r = applyPatch(base(), { dropTests: ['h2'] });
    expect(r.problem.hiddenTests.map((t) => t.name)).toEqual(['h1']);
    expect(r.problem.sampleTests).toHaveLength(1);
    expect(r.testsChanged).toBe(true);
    expect(() => applyPatch(base(), { dropTests: ['h3'] })).toThrow(/no test named "h3"/);
  });
});

describe('testDiff', () => {
  it('lists changed and dropped tests, nothing else', () => {
    const before = base().hiddenTests;
    const after = [{ name: 'h1', args: [2], expected: 3 }];
    expect(testDiff(before, after)).toEqual(['  - "h1": 2 → 3', '  - "h2": dropped']);
    expect(testDiff(before, before)).toEqual([]);
  });
});
