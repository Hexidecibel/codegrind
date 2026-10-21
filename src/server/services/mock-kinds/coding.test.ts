// =============================================================================
// mock-kinds/coding — start, the editor helpers, End, and the grade
// =============================================================================
// Pure: the bank, the skill state and the hidden-test runner are injected, so
// nothing here touches a database, a sandbox or a model.

import { describe, it, expect, vi } from 'vitest';
import type { ProblemRecord, RunResult } from '../../../shared/types.js';
import type { MockGrade, MockState } from '../../../shared/mock.js';
import { initialState } from '../mock.state.js';
import {
  CODING_INTERVIEWER_SYSTEM,
  CODING_SPEC,
  buildCodingContext,
  coerceCodingGrade,
  coerceCodingOptions,
  coerceRunSummary,
  codingTurnExtras,
  hashCode,
  renderRunLine,
  weakestTopicOf,
} from './coding.js';

const PROBLEM: ProblemRecord = {
  id: 'p-two-sum',
  language: 'javascript',
  title: 'Two Sum',
  prompt: 'Return the indices of the two numbers that add up to target.',
  examples: [{ input: 'nums = [2,7,11,15], target = 9', output: '[0,1]' }],
  constraints: ['2 <= nums.length <= 10^4'],
  difficulty: 'medium',
  topic: 'hashing',
  pattern: 'hash map',
  starterCode: 'function twoSum(nums, target) {\n}\n',
  functionName: 'twoSum',
  sampleTests: [{ name: 'sample 1', args: [[2, 7], 9], expected: [0, 1] }],
  hiddenTests: [
    { name: 'hidden 1', args: [[2, 7], 9], expected: [0, 1] },
    { name: 'hidden 2', args: [[3, 3], 6], expected: [0, 1] },
  ],
  referenceSolution: 'function twoSum(nums, target) { const SEEN_REFERENCE = new Map(); }',
  canonicalized: true,
  used: false,
  createdAt: '2026-10-21T00:00:00Z',
};

const T0 = new Date('2026-10-21T10:00:00Z');

async function prep(options?: unknown) {
  const fetchProblem = vi.fn().mockResolvedValue(PROBLEM);
  const weakestTopic = vi.fn().mockReturnValue('hashing');
  const p = await CODING_SPEC.prepare!({
    level: 'staff', requested: undefined, history: [], recentQuestionIds: [], options,
    coding: { fetchProblem, weakestTopic },
  });
  return { p, fetchProblem, weakestTopic };
}

function stateWith(p: Awaited<ReturnType<typeof prep>>['p']): MockState {
  return { ...initialState(T0, 'coding'), graderContext: p.graderContext, coding: p.coding };
}

const result = (passed: number, total = 2): RunResult => ({
  verdict: passed === total ? 'accepted' : 'wrong_answer',
  passed,
  total,
  results: Array.from({ length: total }, (_, i) => ({ name: `hidden ${i + 1}`, passed: i < passed, expected: 'SECRET', timeMs: 1 })),
});

describe('start', () => {
  it('defaults to the weakest topic at medium; a pick needs a real topic', () => {
    expect(coerceCodingOptions(undefined)).toEqual({ mode: 'weakest', difficulty: 'medium' });
    expect(coerceCodingOptions({ mode: 'pick', topic: 'graphs', difficulty: 'hard' })).toEqual({ mode: 'pick', topic: 'graphs', difficulty: 'hard' });
    expect(coerceCodingOptions({ mode: 'pick', topic: 'nope', difficulty: 'impossible' })).toEqual({ mode: 'weakest', difficulty: 'medium' });
  });

  it('finds the weakest topic: a recent failure, then the lowest clean rate', () => {
    const row = (topic: string, attempts: number, solved: number, lastResult: string | null = 'solved') =>
      ({ topic, attempts, solved, hintsSum: 0, box: 1, lastResult });
    expect(weakestTopicOf([])).toBe('arrays');
    expect(weakestTopicOf([row('arrays', 5, 5), row('graphs', 4, 1), row('trees', 3, 3)])).toBe('graphs');
    expect(weakestTopicOf([row('arrays', 5, 5, 'failed'), row('graphs', 4, 1)])).toBe('arrays');
    expect(weakestTopicOf([row('not-a-topic', 4, 0), row('trees', 3, 3)])).toBe('trees');
  });

  it('fetches through the injected bank and freezes the problem into state.coding (no plan)', async () => {
    const { p, fetchProblem, weakestTopic } = await prep();
    expect(weakestTopic).toHaveBeenCalledOnce();
    expect(fetchProblem).toHaveBeenCalledWith('hashing', 'medium');
    expect(p.plan).toBeUndefined();
    expect(p.coding).toMatchObject({
      problemId: 'p-two-sum', title: 'Two Sum', language: 'javascript', chosenBy: 'weakest',
      codeHash: hashCode(PROBLEM.starterCode), starterHash: hashCode(PROBLEM.starterCode), lastCode: null, submits: 0, lastSubmit: null,
    });
    expect(p.brief).toBe('Two Sum (medium)');
    const picked = await prep({ mode: 'pick', topic: 'graphs', difficulty: 'easy' });
    expect(picked.fetchProblem).toHaveBeenCalledWith('graphs', 'easy');
    expect(picked.weakestTopic).not.toHaveBeenCalled();
  });

  it('gives the interviewer the problem and the reference, with the never-leak rule', async () => {
    const { p } = await prep();
    const ctx = buildCodingContext('staff', p);
    expect(ctx).toContain('Return the indices of the two numbers');
    expect(ctx).toContain('SEEN_REFERENCE');
    expect(ctx).toMatch(/REFERENCE SOLUTION — FOR YOU ONLY\. Never show, paste/);
    expect(ctx.indexOf('THE PROBLEM')).toBeLessThan(ctx.indexOf('REFERENCE SOLUTION'));
    expect(CODING_INTERVIEWER_SYSTEM).toMatch(/NEVER show it, paste it, paraphrase it line by line/);
    expect(CODING_INTERVIEWER_SYSTEM).toMatch(/exactly ONE Staff-style extension/);
    // Hidden tests' expected values never reach the interviewer.
    expect(ctx).not.toContain('hidden 2');
  });

  it('keeps the interviewer system prompt a constant (the cache is shared across mocks)', () => {
    expect(CODING_SPEC.interviewerSystem).toBe(CODING_INTERVIEWER_SYSTEM);
    expect(CODING_INTERVIEWER_SYSTEM).not.toContain('Two Sum');
  });
});

describe('the editor helpers', () => {
  it('validates a client run summary and refuses junk', () => {
    expect(coerceRunSummary(null)).toBeNull();
    expect(coerceRunSummary({ kind: 'deploy', verdict: 'accepted', passed: 1, total: 1 })).toBeNull();
    expect(coerceRunSummary({ kind: 'run', verdict: 'wrong_answer', passed: 5, total: 3, firstFailure: '  a\n b ' })).toEqual({
      kind: 'run', verdict: 'wrong_answer', passed: 3, total: 3, firstFailure: 'a b',
    });
    expect(coerceRunSummary({ kind: 'submit', verdict: 'accepted<script>', passed: 2, total: 2 })!.verdict).toBe('acceptedscript');
  });

  it('renders a run line, with the first failure only when something failed', () => {
    expect(renderRunLine({ kind: 'submit', verdict: 'accepted', passed: 9, total: 9, firstFailure: 'x' })).toBe(
      '[run: Submit (hidden tests): 9/9 passed, accepted]'
    );
    expect(renderRunLine({ kind: 'run', verdict: 'runtime_error', passed: 0, total: 2, firstFailure: 'sample 1 — TypeError' })).toBe(
      '[run: Run (sample tests): 0/2 passed, runtime error — first failure: sample 1 — TypeError]'
    );
  });

  it('moves the hashes only for what it showed', async () => {
    const { p } = await prep();
    const same = codingTurnExtras({ code: PROBLEM.starterCode }, p.coding!);
    expect(same).toEqual({ parts: [], patch: {} });
    const changed = codingTurnExtras({ code: 'x' }, p.coding!);
    expect(changed.patch).toEqual({ codeHash: hashCode('x'), lastCode: 'x' });
  });
});

describe('End', () => {
  it('reuses the last Submit when the code has not changed since', async () => {
    const { p } = await prep();
    const code = 'function twoSum(){ return [0,1]; }';
    const lastSubmit = { verdict: 'accepted', passed: 2, total: 2, failing: [], codeHash: hashCode(code), at: T0.toISOString() };
    const state = { ...stateWith(p), coding: { ...p.coding!, submits: 1, lastSubmit } };
    const runHidden = vi.fn();
    const next = await CODING_SPEC.finalize!(state, { code }, { runHidden });
    expect(runHidden).not.toHaveBeenCalled();
    expect(next.coding!.final).toEqual({ ...lastSubmit, source: 'submit' });
  });

  it('runs the final code when it changed (or was never submitted), names failures, never values', async () => {
    const { p } = await prep();
    const runHidden = vi.fn().mockResolvedValue(result(1));
    const next = await CODING_SPEC.finalize!(stateWith(p), { code: 'function twoSum(){}' }, { runHidden });
    expect(runHidden).toHaveBeenCalledWith('p-two-sum', 'function twoSum(){}');
    expect(next.coding!.final).toMatchObject({ source: 'end', passed: 1, total: 2, failing: ['hidden 2'] });
    expect(JSON.stringify(next.coding!.final)).not.toContain('SECRET');
    // A re-grade of the same code does not run it again.
    runHidden.mockClear();
    await CODING_SPEC.finalize!(next, { code: 'function twoSum(){}' }, { runHidden });
    expect(runHidden).not.toHaveBeenCalled();
    // The grader is told.
    expect(CODING_SPEC.graderContext!(next)).toMatch(/HIDDEN-TEST RESULT AT THE END[\s\S]*1\/2 passed, wrong answer — the final editor contents, run at End\.\nFailing tests: hidden 2\./);
  });

  it('runs nothing for untouched starter code, and survives a sandbox failure', async () => {
    const { p } = await prep();
    const runHidden = vi.fn().mockRejectedValue(new Error('docker is down'));
    const untouched = await CODING_SPEC.finalize!(stateWith(p), { code: PROBLEM.starterCode }, { runHidden });
    expect(untouched.coding!.final).toBeNull();
    expect(CODING_SPEC.graderContext!(untouched)).toContain('none — the candidate never changed the starter code');
    const broken = await CODING_SPEC.finalize!(stateWith(p), { code: 'return 1' }, { runHidden });
    expect(broken.coding!.final).toMatchObject({ verdict: 'error', error: 'docker is down', source: 'end' });
  });

  it('puts a missed-pattern problem on the review queue exactly once and attaches the tests', async () => {
    const { p } = await prep();
    const final = { verdict: 'accepted', passed: 2, total: 2, failing: [], codeHash: 'h', at: '', source: 'end' as const };
    const state = { ...stateWith(p), coding: { ...p.coding!, final } };
    const grade = CODING_SPEC.coerceGrade(
      { verdict: 'below', summary: 's', stages: [], coding: { patternMissed: true, patternNote: 'needed the hash map nudge', complexityStated: 'O(n)', complexityOptimal: 'O(n)' } },
      'staff',
      false
    );
    const enqueueReview = vi.fn();
    const after = CODING_SPEC.afterGrade!(state, grade, { enqueueReview });
    expect(enqueueReview).toHaveBeenCalledWith('p-two-sum');
    expect(after.grade.coding).toMatchObject({ patternMissed: true, reviewQueued: true, tests: final });
    // A re-grade does not queue it twice.
    CODING_SPEC.afterGrade!(after.state, grade, { enqueueReview });
    expect(enqueueReview).toHaveBeenCalledTimes(1);
    // Found it themselves: nothing queued.
    const found: MockGrade = { ...grade, coding: { ...grade.coding!, patternMissed: false } };
    const enqueue2 = vi.fn();
    expect(CODING_SPEC.afterGrade!(state, found, { enqueueReview: enqueue2 }).grade.coding!.reviewQueued).toBe(false);
    expect(enqueue2).not.toHaveBeenCalled();
  });
});

describe('the grade', () => {
  it('coerces the coding block, defaulting what is missing', () => {
    expect(coerceCodingGrade(undefined)).toEqual({
      patternMissed: false, patternNote: '', complexityStated: 'not stated', complexityOptimal: '', tests: null, reviewQueued: false,
    });
    const g = CODING_SPEC.coerceGrade(
      { verdict: 'at', summary: 's', stages: [{ stage: 'code', score: 3, evidence: 'e', atLevel: true, staffWouldAdd: '', principalWouldAdd: '' }], coding: { patternMissed: 'yes' } },
      'staff',
      false
    );
    expect(g.coding!.patternMissed).toBe(false);
    expect(g.stages.map((s) => s.stage)).toEqual(['clarify', 'examples', 'approach', 'complexity', 'code', 'test', 'follow-up']);
  });

  it('asks for the coding block right after the stages, in both schemas', () => {
    for (const tool of [CODING_SPEC.gradeTool, CODING_SPEC.gradeToolLean]) {
      const keys = Object.keys(tool.schema.properties);
      expect(keys.indexOf('coding')).toBe(keys.indexOf('stages') + 1);
      expect(tool.schema.required).toContain('coding');
    }
  });
});
