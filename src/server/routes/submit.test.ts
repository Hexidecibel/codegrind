// =============================================================================
// submit route — the split, and everything it must NOT have changed
// =============================================================================
// POST /api/submit used to await the coaching call before answering at all, so
// a verdict that was computed in two seconds was delivered after up to three
// minutes. It now streams NDJSON: `result` first, `coaching` when it lands.
//
// THE INTERESTING TESTS ARE THE SIDE EFFECTS, NOT THE STREAM. Streaming is the
// visible change and the cheap one; the risk is that moving the response out
// from under the recording silently changed WHAT gets recorded — an attempt
// written twice, a skill row bumped per event, a review cleared before the
// verdict is known. Every one of those fails quietly and corrupts the ladder,
// so each is asserted by counting rows rather than by trusting the shape.
//
// The other rule under test is the hidden suite's `expected`. A failed submit
// used to hand back the exact outputs the grader wanted; those are stripped
// from the WIRE now, not merely hidden in the UI, and /api/ask re-attaches them
// server-side so the tutor still sees the real numbers.

import { describe as suite, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CoachingBrief, RunResult, TestResult } from '../../shared/types.js';

// Neither the sandbox nor the model may actually run in a unit test: one needs
// Docker, the other spends money. Both are the seam this route is built around,
// so both are controlled here.
const mocks = vi.hoisted(() => ({
  runTests: vi.fn(),
  coach: vi.fn(),
  askFollowup: vi.fn(),
}));
vi.mock('../services/sandbox.service.js', () => ({ runTests: mocks.runTests }));
vi.mock('../services/llm.service.js', () => ({
  coach: mocks.coach,
  askFollowup: mocks.askFollowup,
}));

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-submit-test-'));
if (!TEST_DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run: test DATA_DIR ${TEST_DATA_DIR} is not under ${tmpdir()}`);
}
process.env.DATA_DIR = TEST_DATA_DIR;

const { submitRoutes, redactHiddenExpected, rehydrateExpected } = await import('./submit.js');
const db = await import('../services/db.js');

const app = new Hono();
app.route('/api', submitRoutes);

const PROBLEM_ID = 'p-submit-1';
const REFERENCE = 'function twoSum(){ return 42; }';

function bankProblem(id = PROBLEM_ID): void {
  db.insertProblem({
    id,
    language: 'javascript',
    title: 'Two Sum',
    prompt: 'Add two numbers.',
    examples: [],
    constraints: [],
    difficulty: 'easy',
    topic: 'arrays',
    pattern: 'hash map',
    starterCode: 'function twoSum() {}',
    functionName: 'twoSum',
    sampleTests: [{ name: 'sample 1', args: [1, 2], expected: 3 }],
    hiddenTests: [
      { name: 'hidden 1', args: [1, 2], expected: 3 },
      { name: 'hidden 2', args: [5, 5], expected: 10 },
    ],
    referenceSolution: REFERENCE,
    canonicalized: true,
    used: false,
    createdAt: new Date().toISOString(),
  });
}

/** A sandbox result whose per-test rows carry the answers, as the runner does. */
function sandboxResult(verdict: RunResult['verdict']): RunResult {
  const passed = verdict === 'accepted';
  const results: TestResult[] = [
    { name: 'hidden 1', passed: true, expected: '3', actual: '3', timeMs: 1 },
    {
      name: 'hidden 2',
      passed,
      expected: '10',
      actual: passed ? '10' : '9',
      stderr: passed ? undefined : 'off by one',
      timeMs: 2,
    },
  ];
  return { results, passed: passed ? 2 : 1, total: 2, verdict };
}

const BRIEF: CoachingBrief = {
  approach: 'You looped twice.',
  missed: ['the O(n) hash-map pass'],
  pattern: 'hash map',
  patternRecognition: 'Pairs summing to a target.',
  complexity: { yours: 'O(n^2)', optimal: 'O(n)' },
  improvement: 'Reach for a map.',
  mistakeTags: ['brute-force'],
};

/** POST a submit and collect the NDJSON lines it streams back. */
async function submit(
  body: Record<string, unknown> = { problemId: PROBLEM_ID, code: 'x' },
): Promise<{ status: number; events: any[]; raw: string }> {
  const res = await app.request('/api/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (res.status !== 200) return { status: res.status, events: [], raw };
  const events = raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  return { status: res.status, events, raw };
}

beforeEach(() => {
  for (const table of ['attempts', 'skill_state', 'review_queue', 'problems', 'revealed_solutions']) {
    db.db.prepare(`DELETE FROM ${table}`).run();
  }
  mocks.runTests.mockReset();
  mocks.coach.mockReset();
  mocks.askFollowup.mockReset();
  mocks.coach.mockResolvedValue(BRIEF);
  mocks.askFollowup.mockResolvedValue('because you compared the wrong thing');
  bankProblem();
});

afterAll(() => {
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

suite('POST /api/submit — the stream', () => {
  it('streams the result first and the coaching second', async () => {
    mocks.runTests.mockResolvedValue(sandboxResult('accepted'));
    const { events } = await submit();
    expect(events.map((e) => e.type)).toEqual(['result', 'coaching']);
  });

  it('answers NDJSON, one whole event per line', async () => {
    mocks.runTests.mockResolvedValue(sandboxResult('accepted'));
    const { raw } = await submit();
    // Two lines, each independently parseable — that is the entire contract a
    // client streams against.
    const lines = raw.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('computes the verdict without waiting on the coaching call', async () => {
    mocks.runTests.mockResolvedValue(sandboxResult('wrong_answer'));
    // A coach that never resolves would hang the OLD route forever. Here the
    // result must already be a complete, correct event before it is even asked.
    let resolveCoach: (b: CoachingBrief) => void = () => {};
    mocks.coach.mockImplementation(
      () => new Promise<CoachingBrief>((r) => { resolveCoach = r; }),
    );
    const pending = submit();
    // Let the route reach the coaching call, then release it.
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.coach).toHaveBeenCalledTimes(1);
    resolveCoach(BRIEF);
    const { events } = await pending;
    expect(events[0].type).toBe('result');
    expect(events[0].result.verdict).toBe('wrong_answer');
  });

  it('returns 404 for an unknown problem, not a stream', async () => {
    const { status } = await submit({ problemId: 'nope', code: 'x' });
    expect(status).toBe(404);
  });

  it('reports a sandbox failure as an HTTP error with an explained message', async () => {
    mocks.runTests.mockRejectedValue(new Error('docker: no such image runner-go'));
    const { status, raw } = await submit();
    expect(status).toBe(500);
    const body = JSON.parse(raw);
    expect(body.error).toMatch(/sandbox could not run/i);
    expect(body.error).toMatch(/bin\/build-runner-image/);
    // Nothing is deleted: the raw cause rides along for whoever is fixing it.
    expect(body.detail).toContain('no such image');
  });
});

suite('POST /api/submit — the reference solution', () => {
  it('returns it on an accepted submit', async () => {
    mocks.runTests.mockResolvedValue(sandboxResult('accepted'));
    const { events } = await submit();
    expect(events[0].referenceSolution).toBe(REFERENCE);
  });

  it('withholds it on every unsolved submit', async () => {
    mocks.runTests.mockResolvedValue(sandboxResult('wrong_answer'));
    const { events, raw } = await submit();
    expect(events[0].referenceSolution).toBeUndefined();
    // Belt and braces: the text of it must not be anywhere on the wire.
    expect(raw).not.toContain('return 42');
  });
});

suite('POST /api/submit — hidden tests keep their answers', () => {
  it('strips `expected` from every hidden result, passed or failed', async () => {
    mocks.runTests.mockResolvedValue(sandboxResult('wrong_answer'));
    const { events, raw } = await submit();
    for (const t of events[0].result.results) {
      expect(t).not.toHaveProperty('expected');
    }
    // The failing case's expected value was "10". It must not survive anywhere
    // in the response body — a UI-only rule would still ship it here.
    expect(raw).not.toMatch(/"expected"/);
  });

  it('keeps the player\'s own output and stderr — only the answer is withheld', async () => {
    mocks.runTests.mockResolvedValue(sandboxResult('wrong_answer'));
    const { events } = await submit();
    const failed = events[0].result.results.find((t: TestResult) => !t.passed);
    expect(failed.actual).toBe('9');
    expect(failed.stderr).toBe('off by one');
    expect(failed.name).toBe('hidden 2');
  });

  it('still shows the coach the real expected values', async () => {
    mocks.runTests.mockResolvedValue(sandboxResult('wrong_answer'));
    await submit();
    const passedResults = mocks.coach.mock.calls[0][2] as TestResult[];
    expect(passedResults.map((r) => r.expected)).toEqual(['3', '10']);
  });
});

suite('redactHiddenExpected', () => {
  it('removes the key rather than blanking it', () => {
    const [out] = redactHiddenExpected([
      { name: 't', passed: false, expected: '10', actual: '9', timeMs: 1 },
    ]);
    expect('expected' in out).toBe(false);
    expect(out.actual).toBe('9');
  });

  it('leaves an empty list alone', () => {
    expect(redactHiddenExpected([])).toEqual([]);
  });
});

suite('rehydrateExpected', () => {
  const problem = {
    sampleTests: [{ name: 'sample 1', args: [], expected: 3 }],
    hiddenTests: [{ name: 'hidden 2', args: [], expected: [1, 2] }],
  };

  it('puts back a stripped hidden expected, serialized the way the runner reports it', () => {
    const [out] = rehydrateExpected(problem, [
      { name: 'hidden 2', passed: false, actual: 'null', timeMs: 1 },
    ]);
    expect(out.expected).toBe('[1,2]');
  });

  it('never overwrites an expected the client already had', () => {
    const [out] = rehydrateExpected(problem, [
      { name: 'sample 1', passed: false, expected: 'kept', timeMs: 1 },
    ]);
    expect(out.expected).toBe('kept');
  });

  it('leaves an unmatched test alone rather than dropping it', () => {
    const out = rehydrateExpected(problem, [
      { name: 'renamed', passed: false, timeMs: 1 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].expected).toBeUndefined();
  });
});

// =============================================================================
// The side effects. One submit must write exactly one of each.
// =============================================================================
suite('POST /api/submit — recording, exactly once', () => {
  it('writes one attempt row per submit, carrying the coach\'s mistake tags', async () => {
    mocks.runTests.mockResolvedValue(sandboxResult('wrong_answer'));
    await submit();

    const history = db.getHistory('javascript');
    expect(history).toHaveLength(1);
    expect(history[0].problemId).toBe(PROBLEM_ID);
    expect(history[0].solved).toBe(false);
    expect(history[0].testsPassed).toBe(1);
    expect(history[0].testsTotal).toBe(2);

    // mistakeTags are why the attempt row is still written AFTER coaching: the
    // brief supplies them, so recording early would store null for every submit.
    expect(db.getTaggedAttempts('javascript')).toEqual([
      expect.objectContaining({ mistakeTags: ['brute-force'] }),
    ]);
  });

  it('bumps the skill row once, not once per streamed event', async () => {
    mocks.runTests.mockResolvedValue(sandboxResult('accepted'));
    await submit();
    const skill = db.getSkillForTopic('javascript', 'arrays');
    expect(skill?.attempts).toBe(1);
    expect(skill?.solved).toBe(1);
  });

  it('records the prediction it was given', async () => {
    mocks.runTests.mockResolvedValue(sandboxResult('accepted'));
    await submit({
      problemId: PROBLEM_ID,
      code: 'x',
      prediction: { approach: 'hash map', predTime: 'O(n)', predSpace: 'O(n)', confidence: 4 },
    });
    const passedPrediction = mocks.coach.mock.calls[0][3];
    expect(passedPrediction).toEqual({
      approach: 'hash map',
      predTime: 'O(n)',
      predSpace: 'O(n)',
      confidence: 4,
    });
  });

  it('queues a review on a miss', async () => {
    mocks.runTests.mockResolvedValue(sandboxResult('wrong_answer'));
    await submit();
    expect(db.isReviewQueued(PROBLEM_ID)).toBe(true);
  });

  it('clears the review on a clean unaided solve', async () => {
    mocks.runTests.mockResolvedValue(sandboxResult('wrong_answer'));
    await submit();
    expect(db.isReviewQueued(PROBLEM_ID)).toBe(true);

    mocks.runTests.mockResolvedValue(sandboxResult('accepted'));
    await submit();
    expect(db.isReviewQueued(PROBLEM_ID)).toBe(false);
    expect(db.getHistory('javascript')).toHaveLength(2);
  });

  it('keeps the review queued when the solve was assisted', async () => {
    mocks.runTests.mockResolvedValue(sandboxResult('accepted'));
    await submit({ problemId: PROBLEM_ID, code: 'x', hintsUsed: 2 });
    expect(db.isReviewQueued(PROBLEM_ID)).toBe(true);
    expect(db.getSkillForTopic('javascript', 'arrays')?.hintsSum).toBe(2);
  });

  it('counts a server-recorded reveal as assistance even when the client says zero', async () => {
    db.markSolutionRevealed(PROBLEM_ID);
    mocks.runTests.mockResolvedValue(sandboxResult('accepted'));
    await submit({ problemId: PROBLEM_ID, code: 'x', hintsUsed: 0 });
    expect(db.isReviewQueued(PROBLEM_ID)).toBe(true);
    expect(db.getSkillForTopic('javascript', 'arrays')?.hintsSum).toBe(1);
  });
});

suite('POST /api/submit — coaching failure degrades, never loses the run', () => {
  beforeEach(() => {
    mocks.runTests.mockResolvedValue(sandboxResult('accepted'));
    mocks.coach.mockRejectedValue(new Error('endpoint went away'));
  });

  it('still streams both events, with the stub brief', async () => {
    const { events } = await submit();
    expect(events.map((e) => e.type)).toEqual(['result', 'coaching']);
    expect(events[1].coaching.improvement).toMatch(/temporarily unavailable/i);
    expect(events[1].coaching.pattern).toBe('hash map');
  });

  it('still records the attempt, the skill bump and the review move', async () => {
    await submit();
    expect(db.getHistory('javascript')).toHaveLength(1);
    expect(db.getSkillForTopic('javascript', 'arrays')?.attempts).toBe(1);
    expect(db.isReviewQueued(PROBLEM_ID)).toBe(false); // clean solve clears it
  });

  it('leaves the attempt untagged rather than inventing tags', async () => {
    await submit();
    expect(db.getTaggedAttempts('javascript')).toEqual([]);
  });
});

suite('POST /api/ask', () => {
  it('re-attaches the expected values the submit response withheld', async () => {
    await app.request('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        problemId: PROBLEM_ID,
        code: 'x',
        question: 'why did mine fail?',
        // Exactly what a client now holds: no expected anywhere.
        results: [{ name: 'hidden 2', passed: false, actual: '9', timeMs: 2 }],
      }),
    });
    const results = mocks.askFollowup.mock.calls[0][4] as TestResult[];
    expect(results[0].expected).toBe('10');
  });

  it('explains an LLM failure instead of echoing it', async () => {
    mocks.askFollowup.mockRejectedValue(new Error('fetch failed: ECONNREFUSED 127.0.0.1:9600'));
    const res = await app.request('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problemId: PROBLEM_ID, code: 'x', question: 'hi' }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/could not reach the model endpoint/i);
    expect(body.detail).toContain('ECONNREFUSED');
  });
});
