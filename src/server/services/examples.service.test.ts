// =============================================================================
// examples.service.test — reading the stored example formats, and judging them
// =============================================================================
// Every input below is a shape found in the real bank (2026-10-29): named args
// in signature order, a bare value for a one-argument function, single quotes,
// bare object keys, Python True/None, Go signatures with grouped params. The
// sandbox is mocked; what is under test is the reading and the verdicts.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ runTests: vi.fn() }));
vi.mock('./sandbox.service.js', () => ({ runTests: mocks.runTests }));

const ex = await import('./examples.service.js');
type ExampleProblem = import('./examples.service.js').ExampleProblem;

describe('paramNames', () => {
  it('reads JavaScript, Python and Go signatures', () => {
    expect(ex.paramNames('javascript', 'function minDrains(tankA, tankB, tolerance) {\n}', 'minDrains')).toEqual([
      'tankA',
      'tankB',
      'tolerance',
    ]);
    expect(ex.paramNames('javascript', 'const f = (a, b = 2) => {}', 'f')).toEqual(['a', 'b']);
    expect(
      ex.paramNames('python', 'def top_k(self, nums: List[int], k: int = 1) -> List[int]:\n    pass', 'top_k')
    ).toEqual(['nums', 'k']);
    expect(ex.paramNames('go', 'package main\n\nfunc F(grid [][]int, a, b int, m map[string]int) int {', 'F')).toEqual([
      'grid',
      'a',
      'b',
      'm',
    ]);
  });

  it('returns nothing for a starter with no parameters', () => {
    expect(ex.paramNames('javascript', 'function f() {}', 'f')).toEqual([]);
  });
});

describe('parseExampleInput', () => {
  it('reads named args into signature order', () => {
    expect(ex.parseExampleInput('tankA = [1, 2, 10], tankB = [9, 9, 9], tolerance = 0', ['tankA', 'tankB', 'tolerance'])).toEqual([
      [1, 2, 10],
      [9, 9, 9],
      0,
    ]);
    expect(ex.parseExampleInput('k = 2, nums = [3, 1]', ['nums', 'k'])).toEqual([[3, 1], 2]);
  });

  it('reads a bare value for a one-argument function', () => {
    expect(ex.parseExampleInput('[[1,4],[2,6],[8,10]]', ['intervals'])).toEqual([[[1, 4], [2, 6], [8, 10]]]);
    expect(ex.parseExampleInput('null', ['root'])).toEqual([null]);
  });

  it('reads single quotes, bare keys and Python literals', () => {
    expect(ex.parseExampleInput("words = ['a', 'b,c']", ['words'])).toEqual([['a', 'b,c']]);
    expect(ex.parseExampleInput('{ val: 1, left: null, right: null }', ['root'])).toEqual([{ val: 1, left: null, right: null }]);
    expect(ex.parseExampleInput('flags = [True, False, None], s = "True"', ['flags', 's'])).toEqual([
      [true, false, null],
      'True',
    ]);
  });

  it('takes mismatched names positionally when the count is right', () => {
    expect(ex.parseExampleInput('numList = [1], target = 3', ['nums', 'k'])).toEqual([[1], 3]);
  });

  it('refuses what it cannot read rather than guessing', () => {
    expect(ex.parseExampleInput('nums = [1, 2, ..., n]', ['nums'])).toBeNull();
    expect(ex.parseExampleInput('1 -> 2 -> 3', ['head'])).toBeNull();
    expect(ex.parseExampleInput('root = TreeNode(1)', ['root'])).toBeNull();
    expect(ex.parseExampleInput('letters = "aab"', ['letters', 'width'])).toBeNull();
  });
});

describe('outputMatches', () => {
  it('forgives formatting, float noise and display rounding, not a different answer', () => {
    expect(ex.outputMatches('[1,2]', [1, 2], 'javascript')).toBe(true);
    expect(ex.outputMatches('True', true, 'python')).toBe(true);
    expect(ex.outputMatches('5.0', 5, 'python')).toBe(true);
    expect(ex.outputMatches('0.33', 1 / 3, 'javascript')).toBe(true);
    expect(ex.outputMatches("'abc'", 'abc', 'python')).toBe(true);
    expect(ex.outputMatches('abc', 'abc', 'javascript')).toBe(true);
    expect(ex.outputMatches('{ a: 1 }', { a: 1 }, 'javascript')).toBe(true);
    expect(ex.outputMatches('0', 2, 'javascript')).toBe(false);
    expect(ex.outputMatches('[2,1]', [1, 2], 'javascript')).toBe(false);
  });
});

describe('renderValue', () => {
  it('writes a value the way the problem language would', () => {
    expect(ex.renderValue([true, null, 'x'], 'python')).toBe('[True, None, "x"]');
    expect(ex.renderValue([true, null, 'x'], 'javascript')).toBe('[true, null, "x"]');
    expect(ex.renderValue({ a: [1, 2] }, 'javascript')).toBe('{"a": [1, 2]}');
  });
});

// -----------------------------------------------------------------------------
function problem(over: Partial<ExampleProblem> = {}): ExampleProblem {
  return {
    language: 'javascript',
    title: 'Largest',
    prompt: 'Return the largest value.',
    functionName: 'largest',
    starterCode: 'function largest(nums) {\n}',
    referenceSolution: 'function largest(nums) { return Math.max(...nums); }',
    examples: [],
    sampleTests: [{ name: 's1', args: [[1, 2]], expected: 2 }],
    ...over,
  };
}

/** The reference is max(nums); an input containing 13 makes it throw. */
function sandboxIsMax() {
  mocks.runTests.mockImplementation(async ({ tests }: { tests: Array<{ args: unknown[] }> }) => ({
    verdict: 'wrong_answer',
    results: tests.map((t) => {
      const nums = t.args[0] as number[];
      return nums.includes(13)
        ? { stderr: 'Error: unlucky' }
        : { stderr: '', actual: JSON.stringify(Math.max(...nums)) };
    }),
  }));
}

beforeEach(() => {
  mocks.runTests.mockReset();
});

describe('validateExamples + fixExamples', () => {
  it('sorts each example into ok / wrong / unparseable / ref-error in one sandbox run', async () => {
    sandboxIsMax();
    const p = problem({
      examples: [
        { input: 'nums = [3, 9]', output: '9' },
        { input: 'nums = [3, 9, 4]', output: '4', explanation: 'wrong' },
        { input: 'nums = [1, ..., n]', output: 'n' },
        { input: 'nums = [13]', output: '13' },
        { input: 'nums = {"a": 1}', output: '1' },
      ],
    });
    const checks = await ex.validateExamples(p);
    expect(checks.map((c) => c.status)).toEqual(['ok', 'wrong', 'unparseable', 'ref-error', 'unparseable']);
    expect(checks[1].actual).toBe(9);
    expect(checks[4].reason).toBe('nums: object where the tests pass an array');
    expect(mocks.runTests).toHaveBeenCalledTimes(1);

    const fix = await ex.fixExamples(p, checks, { explain: async () => 'Nine is largest.' });
    expect(fix.changed).toBe(true);
    expect(fix.examples).toEqual([
      { input: 'nums = [3, 9]', output: '9' },
      { input: 'nums = [3, 9, 4]', output: '9', explanation: 'Nine is largest.' },
    ]);

    // Idempotent: the fixed set validates clean and fixes to itself.
    const again = await ex.validateExamples({ ...p, examples: fix.examples });
    expect(again.every((c) => c.status === 'ok')).toBe(true);
    expect((await ex.fixExamples({ ...p, examples: fix.examples }, again)).changed).toBe(false);
  });

  it('without an explainer, a corrected example simply loses the stale explanation', async () => {
    sandboxIsMax();
    const p = problem({ examples: [{ input: 'nums = [5, 1]', output: '1', explanation: 'One wins.' }] });
    const fix = await ex.fixExamples(p, await ex.validateExamples(p));
    expect(fix.examples).toEqual([{ input: 'nums = [5, 1]', output: '5' }]);
  });

  it('throws SandboxUnavailableError when even the control test cannot run', async () => {
    mocks.runTests.mockResolvedValue({ verdict: 'error', results: [{ stderr: 'docker: not found' }, { stderr: 'docker: not found' }] });
    await expect(ex.validateExamples(problem({ examples: [{ input: 'nums = [1]', output: '1' }] }))).rejects.toBeInstanceOf(
      ex.SandboxUnavailableError
    );
  });
});
