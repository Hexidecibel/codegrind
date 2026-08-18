// =============================================================================
// functionName — the one model-authored string that becomes SOURCE
// =============================================================================
// Everything else the generation tool call returns is displayed: a title, a
// prompt, a list of constraints. `functionName` is different — two of the three
// runners paste it verbatim into generated code (Go writes it into shim.go, the
// JavaScript runner interpolates it into a `new Function` body), and only the
// Go one used to check it.
//
// Read the failure right, because it is easy to oversell: this is NOT a sandbox
// escape. The `new Function` next to the interpolation already evaluates the
// whole of the player's `userCode`, and all of it runs inside the network-less
// throwaway container. What a bad name costs is a BAFFLING failure — a syntax
// error in machinery the player never wrote, reported against their solution —
// which is why the fix is one check at the point of ACCEPTANCE, where every
// language gets it, rather than a third copy per runner.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Language } from '../../shared/languages.js';

const mocks = vi.hoisted(() => ({ structured: vi.fn() }));
vi.mock('./llm.client.js', () => ({
  structured: mocks.structured,
  text: vi.fn(),
}));

const { validateFunctionName, generateProblem } = await import('./llm.service.js');

describe('validateFunctionName accepts what a real problem is called', () => {
  it.each([
    'solve',
    'twoSum',
    'two_sum',
    '_private',
    'maxSubArray2',
    'A',
  ])('accepts %s', (name) => {
    expect(validateFunctionName(name, 'javascript')).toBe(name);
  });

  it('accepts a name that is a keyword in some OTHER language', () => {
    // The reserved list is per language on purpose. `map`, `range` and `type`
    // are Go keywords and completely ordinary JavaScript function names; a
    // shared union would reject a legitimate `map(...)` problem to save one Set.
    expect(validateFunctionName('map', 'javascript')).toBe('map');
    expect(validateFunctionName('pass', 'go')).toBe('pass');
    expect(validateFunctionName('is', 'go')).toBe('is');
  });
});

describe('validateFunctionName rejects anything that is not a bare identifier', () => {
  // The literals below are the shapes that actually break an interpolation:
  // a quote closes the surrounding string, a newline ends the statement, a
  // backtick opens a template. Each one currently reaches `new Function`.
  it.each([
    ['a quote', 'sol"ve'],
    ['a single quote', "sol've"],
    ['a backtick', 'sol`ve'],
    ['a newline', 'solve\nmalicious()'],
    ['a semicolon and a call', 'solve;process.exit(9);//'],
    ['a space', 'two sum'],
    ['a leading digit', '2sum'],
    ['a hyphen', 'two-sum'],
    ['parentheses', 'solve()'],
    ['a dot', 'obj.solve'],
    ['nothing at all', ''],
    ['non-ASCII letters', 'résoudre'],
  ])('rejects %s', (_label, name) => {
    expect(() => validateFunctionName(name, 'javascript')).toThrow(/functionName/);
    expect(() => validateFunctionName(name, 'javascript')).toThrow(/plain identifier/);
  });

  it('names the field and quotes the offending value, so the log is actionable', () => {
    expect(() => validateFunctionName('two sum', 'javascript')).toThrow(
      'Generated problem has an unusable functionName "two sum"'
    );
  });

  it.each<[Language, string]>([
    ['javascript', 'class'],
    ['javascript', 'return'],
    ['python', 'def'],
    ['python', 'lambda'],
    ['go', 'func'],
    ['go', 'range'],
    ['java', 'static'],
  ])('rejects the reserved word %s in %s', (language, name) => {
    expect(() => validateFunctionName(name, language)).toThrow(/reserved word/);
  });
});

describe('generateProblem applies it, so no runner has to', () => {
  // The check is only worth anything if it sits on the path the model's answer
  // actually takes. This drives the real function with a faked tool call.
  const reply = (functionName: unknown) => ({
    input: {
      title: 'T',
      prompt: 'p',
      functionName,
      starterCode: 'function solve() {}',
      referenceSolution: 'function solve() {}',
      sampleTests: [{ name: 's1', args: [1], expected: 1 }],
      hiddenTests: [{ name: 'h1', args: [1], expected: 1 }],
    },
    meta: { servedModel: 'fake', stop: 'tool_use', latencyMs: 1, usage: {} },
  });

  beforeEach(() => mocks.structured.mockReset());

  it('rejects a name carrying a newline before it can reach a runner', async () => {
    mocks.structured.mockResolvedValue(reply('solve\nwhile(1){}'));
    await expect(generateProblem('javascript', 'arrays', 'easy')).rejects.toThrow(/functionName/);
  });

  it('rejects a Go keyword on a Go problem', async () => {
    mocks.structured.mockResolvedValue(reply('type'));
    await expect(generateProblem('go', 'arrays', 'easy')).rejects.toThrow(/reserved word/);
  });

  it('lets a good name through', async () => {
    mocks.structured.mockResolvedValue(reply('twoSum'));
    const problem = await generateProblem('javascript', 'arrays', 'easy');
    expect(problem.functionName).toBe('twoSum');
  });

  it('still falls back to `solve` when the model omitted the field', async () => {
    // An OMISSION is a shape the fallback can honestly cover. A name that is
    // present and unusable is not: silently renaming it would leave the starter
    // code, the reference solution and the prompt calling something else.
    mocks.structured.mockResolvedValue(reply(undefined));
    const problem = await generateProblem('javascript', 'arrays', 'easy');
    expect(problem.functionName).toBe('solve');
  });
});
