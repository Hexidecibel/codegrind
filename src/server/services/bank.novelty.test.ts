// =============================================================================
// bank.novelty.test — the instrument must ask the same question as the app
// =============================================================================
// `dryRunGenerate` exists to judge a model. It used to call `generateProblem`
// with no options at all, while the path a player actually travels
// (`getAdaptiveProblem`) passes an avoid-list and a digest of what has already
// been served. So the instrument was measuring a request the app never makes —
// and it showed: eight consecutive local-model dry runs of easy/arrays came back
// as "find the maximum" under six different titles, while the same model on the
// real path produced eight different problems. The narrowness was the ruler.
//
// These tests pin the property that fixes it and keeps it fixed: BOTH callers
// build their anti-repetition options from the same function, and for the same
// database state they come out the same. A future edit that steers one path
// without the other fails here rather than in a measurement six months later.
//
// Like db.language.test, this suite imports db.ts for real, after pointing
// DATA_DIR at a throwaway directory — the accessors' actual SQL is what decides
// what the generator is shown, and a hand-built stand-in would prove nothing.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProblemRecord } from '../../shared/types.js';
import type { GeneratedProblem, GenerateProblemOpts } from './llm.service.js';

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-novelty-test-'));
if (!TEST_DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run: test DATA_DIR ${TEST_DATA_DIR} is not under ${tmpdir()}`);
}
process.env.DATA_DIR = TEST_DATA_DIR;

// The two things bank.service reaches outside itself for. Neither is under test
// here: what is under test is the OPTIONS handed to the first one.
const mocks = vi.hoisted(() => ({
  generateProblem: vi.fn(),
  runTests: vi.fn(),
}));

vi.mock('./llm.service.js', () => ({ generateProblem: mocks.generateProblem }));
vi.mock('./sandbox.service.js', () => ({ runTests: mocks.runTests }));

const db = await import('./db.js');
const bank = await import('./bank.service.js');

afterAll(() => {
  db.db.close();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------
function generated(title: string, prompt: string): GeneratedProblem {
  return {
    title,
    prompt,
    pattern: 'scan',
    examples: [{ input: '[1]', output: '1' }],
    constraints: ['1 <= n <= 10'],
    functionName: 'solve',
    starterCode: 'def solve(nums):\n    pass\n',
    sampleTests: [{ name: 's1', args: [[1, 2]], expected: 2 }],
    hiddenTests: [1, 2, 3, 4, 5].map((n) => ({ name: `h${n}`, args: [[n]], expected: n })),
    referenceSolution: 'def solve(nums):\n    return max(nums)\n',
  };
}

/** A reference run that agrees with every hand-authored `expected`. */
function sandboxAgrees() {
  mocks.runTests.mockImplementation(
    async ({ tests }: { tests: Array<{ expected: unknown }> }) => ({
      results: tests.map((t) => ({ stderr: '', actual: JSON.stringify(t.expected) })),
    })
  );
}

function banked(id: string, title: string, prompt: string, createdAt: string): ProblemRecord {
  return {
    id,
    language: 'python',
    title,
    prompt,
    examples: [],
    constraints: [],
    difficulty: 'easy',
    topic: 'arrays',
    pattern: 'scan',
    starterCode: '',
    functionName: 'solve',
    sampleTests: [],
    hiddenTests: [],
    referenceSolution: '',
    canonicalized: true,
    used: false,
    createdAt,
  };
}

/** The options the (single) generation call was made with. */
function optsOfLastCall(): GenerateProblemOpts | undefined {
  const calls = mocks.generateProblem.mock.calls;
  const last = calls[calls.length - 1];
  return last?.[3] as GenerateProblemOpts | undefined;
}

beforeEach(() => {
  db.db.exec('DELETE FROM problems');
  mocks.generateProblem.mockReset();
  mocks.runTests.mockReset();
  sandboxAgrees();
});

// =============================================================================
describe('noveltyOpts', () => {
  it('asks for nothing extra when the slot has never been served', () => {
    expect(bank.noveltyOpts('python', 'arrays')).toEqual({});
  });

  it('names the banked titles and quotes the recent statements', () => {
    db.insertProblem(banked('p1', 'Find the Maximum', 'Return the largest value.', '2026-01-01'));
    db.insertProblem(banked('p2', 'Contains Duplicate', 'Return true if repeated.', '2026-01-02'));

    const opts = bank.noveltyOpts('python', 'arrays');
    // The avoid-list is the bank in table order — it is a set of names, and
    // nothing about it is a ranking. The DIGEST is the ordered one.
    expect(opts.avoidTitles).toEqual(['Find the Maximum', 'Contains Duplicate']);
    expect(opts.noveltyHint).toContain('Already served for "arrays"');
    expect(opts.noveltyHint).toContain('Return the largest value.');
    expect(opts.noveltyHint).toContain('Contains Duplicate');
    // The demand that the ALGORITHM differ, not merely the name — the whole
    // reason a digest exists alongside the avoid-list.
    expect(opts.noveltyHint).toContain('the solution shape itself must differ');
  });

  it('shows a caller-carried history the database has never seen, newest first', () => {
    db.insertProblem(banked('p1', 'Find the Maximum', 'Return the largest value.', '2026-01-01'));

    const opts = bank.noveltyOpts('python', 'arrays', {
      extraRecent: [{ title: 'Sum of Elements', prompt: 'Add them all up.' }],
    });
    expect(opts.avoidTitles).toEqual(['Sum of Elements', 'Find the Maximum']);
    expect(opts.noveltyHint?.indexOf('Sum of Elements')).toBeLessThan(
      opts.noveltyHint?.indexOf('Find the Maximum') ?? -1
    );
  });

  it('never lists the same problem twice when a caller both carries and stores it', () => {
    db.insertProblem(banked('p1', 'Find the Maximum', 'Return the largest value.', '2026-01-01'));

    const opts = bank.noveltyOpts('python', 'arrays', {
      extraRecent: [{ title: 'Find the Maximum', prompt: 'Return the largest value.' }],
    });
    expect(opts.avoidTitles).toEqual(['Find the Maximum']);
    expect(opts.noveltyHint?.match(/Find the Maximum/g)).toHaveLength(1);
  });

  it('lets an explicit avoid-list win, because the scheduler computes its own', () => {
    db.insertProblem(banked('p1', 'Find the Maximum', 'Return the largest value.', '2026-01-01'));
    const opts = bank.noveltyOpts('python', 'arrays', { avoidTitles: ['Only This One'] });
    expect(opts.avoidTitles).toEqual(['Only This One']);
  });

  it('keeps the digest bounded, so one topic cannot crowd out the request', () => {
    for (let i = 1; i <= 9; i++) {
      db.insertProblem(banked(`p${i}`, `Problem ${i}`, `Statement ${i}.`, `2026-01-0${i}`));
    }
    const hint = bank.noveltyOpts('python', 'arrays').noveltyHint ?? '';
    expect(hint.match(/^- "/gm)).toHaveLength(4);
    // The four most RECENT, not the four oldest.
    expect(hint).toContain('Problem 9');
    expect(hint).not.toContain('Problem 5');
    // The avoid-list is unbounded on purpose: a title is one short line, and
    // re-serving a name the player has already seen is the cheapest failure to
    // prevent.
    expect(bank.noveltyOpts('python', 'arrays').avoidTitles).toHaveLength(9);
  });
});

// =============================================================================
describe('dryRunGenerate asks what the app asks', () => {
  it('steers away from what is already banked, instead of generating in a vacuum', async () => {
    db.insertProblem(banked('p1', 'Find the Maximum', 'Return the largest value.', '2026-01-01'));
    mocks.generateProblem.mockResolvedValue(generated('Something Else', 'Do a different thing.'));

    const res = await bank.dryRunGenerate('python', 'arrays', 'easy');
    expect(res.ok).toBe(true);
    const opts = optsOfLastCall();
    expect(opts?.avoidTitles).toEqual(['Find the Maximum']);
    expect(opts?.noveltyHint).toContain('Return the largest value.');
  });

  it('carries its own history across a sequence it deliberately does not store', async () => {
    mocks.generateProblem.mockResolvedValue(generated('Third Problem', 'Third statement.'));

    await bank.dryRunGenerate('python', 'arrays', 'easy', {
      recent: [
        { title: 'Second Problem', prompt: 'Second statement.' },
        { title: 'First Problem', prompt: 'First statement.' },
      ],
    });

    const opts = optsOfLastCall();
    expect(opts?.avoidTitles).toEqual(['Second Problem', 'First Problem']);
    expect(opts?.noveltyHint).toContain('Second statement.');
    expect(opts?.noveltyHint).toContain('First statement.');
    // And it still stored nothing — that is the other half of what makes it a
    // dry run, and a `recent` that leaked into the bank would break it.
    expect(db.getBankTitles('python', 'arrays')).toEqual([]);
  });

  it('builds the SAME steer the adaptive path builds for the same bank', async () => {
    db.insertProblem(banked('p1', 'Find the Maximum', 'Return the largest value.', '2026-01-01'));
    db.insertProblem(banked('p2', 'Contains Duplicate', 'Return true if repeated.', '2026-01-02'));
    mocks.generateProblem.mockResolvedValue(generated('Fresh One', 'A new statement.'));

    // The dry run first: it stores nothing, so both calls see one bank.
    await bank.dryRunGenerate('python', 'arrays', 'easy');
    const dry = optsOfLastCall();

    await bank.getAdaptiveProblem({
      kind: 'new-pattern',
      language: 'python',
      topic: 'arrays',
      difficulty: 'easy',
      rationale: 'test',
    });
    const real = optsOfLastCall();

    expect(dry?.avoidTitles).toEqual(real?.avoidTitles);
    // The adaptive path prepends a per-intent steer ("introduce this pattern
    // gently…") that has no meaning for a probe, and nothing else differs. If
    // this stops being true, one path has been tuned and the other has not.
    expect(real?.noveltyHint?.endsWith(dry?.noveltyHint ?? '')).toBe(true);
    expect(real?.noveltyHint).toContain('Introduce this pattern gently');
  });
});
