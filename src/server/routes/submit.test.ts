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
import type { CoachFix } from '../services/coachfix.service.js';

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
const { clearFixes } = await import('../services/coachfix.service.js');

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
  missed: [{ note: 'the O(n) hash-map pass' }],
  pattern: 'hash map',
  patternRecognition: 'Pairs summing to a target.',
  complexity: { yours: 'O(n^2)', optimal: 'O(n)' },
  improvement: 'Reach for a map.',
  mistakeTags: ['brute-force'],
};

// The corrected code the coach generated for missed[0]. It is the string the
// withhold test greps the wire for, so it must be distinctive enough that a
// coincidental match is impossible.
const FIX_TEXT = 'const seen = new Map(); // THE ANSWER';
const FIX_BEFORE = 'for (const b of nums) {';

/**
 * What `coach()` now resolves to: the brief plus a SIDECAR of fixes keyed by
 * index into `missed`. A fresh brief object per call, because the route writes
 * `fixId` onto the items and a shared object would leak that between tests.
 */
function coachResult(fixes: Array<[number, CoachFix]> = []) {
  return {
    brief: { ...BRIEF, missed: BRIEF.missed.map((m) => ({ ...m })) },
    fixes: new Map<number, CoachFix>(fixes),
  };
}

/** The default: one bullet, anchored, with a fix waiting behind it. */
function coachResultWithFix() {
  return coachResult([[0, { before: FIX_BEFORE, after: FIX_TEXT }]]);
}

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
  mocks.coach.mockImplementation(async () => coachResultWithFix());
  clearFixes();
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
    let resolveCoach: (r: ReturnType<typeof coachResult>) => void = () => {};
    mocks.coach.mockImplementation(
      () => new Promise<ReturnType<typeof coachResult>>((r) => { resolveCoach = r; }),
    );
    const pending = submit();
    // Let the route reach the coaching call, then release it.
    await new Promise((r) => setTimeout(r, 10));
    expect(mocks.coach).toHaveBeenCalledTimes(1);
    resolveCoach(coachResult());
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

// =============================================================================
// The corrected code, and the fact that it is NOT on the wire
// =============================================================================
// This is the test the whole withhold-the-fix design exists for, and it is
// written the same way `redactHiddenExpected` is tested: against the RAW
// response body, not against the parsed event. A rule that only holds after
// JSON.parse is a rule about the UI, and the UI is not where assistance is
// decided.
//
// If this ever fails, the fix is never to hide the text in the client. It means
// the corrected code has become a field on the brief somewhere, and it is
// readable in devtools without anybody clicking, which makes the reveal ledger
// theatre.
suite('POST /api/submit — the fix is withheld until it is paid for', () => {
  it('never puts the corrected code on the wire', async () => {
    mocks.runTests.mockResolvedValue(sandboxResult('wrong_answer'));
    const { raw } = await submit();
    expect(raw).not.toContain(FIX_TEXT);
    // Nor the "before" — that one is the player's own code and harmless, but
    // its absence is what proves the whole sidecar stayed server-side rather
    // than half of it leaking.
    expect(raw).not.toContain(FIX_BEFORE);
  });

  it('ships an opaque handle in its place', async () => {
    mocks.runTests.mockResolvedValue(sandboxResult('wrong_answer'));
    const { events } = await submit();
    const [item] = events[1].coaching.missed;
    expect(typeof item.fixId).toBe('string');
    expect(item.fixId.length).toBeGreaterThan(0);
    expect(item.note).toBe('the O(n) hash-map pass');
  });

  it('leaves items with no fix alone rather than minting an empty handle', async () => {
    mocks.coach.mockImplementation(async () => coachResult());
    mocks.runTests.mockResolvedValue(sandboxResult('wrong_answer'));
    const { events } = await submit();
    expect(events[1].coaching.missed[0].fixId).toBeUndefined();
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

  it('climbs the review ladder on clean solves on LATER days, never the same day (Phase H)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const DAY = 86_400_000;
      // Noon Pacific, so +N days never crosses a local-day edge by accident.
      const t0 = Date.parse('2026-10-21T19:00:00.000Z');
      vi.setSystemTime(t0);
      mocks.runTests.mockResolvedValue(sandboxResult('wrong_answer'));
      await submit();
      expect(db.getReviewRow(PROBLEM_ID)).toMatchObject({ rung: 0, clearedAt: null });

      // Minutes later, solved clean: the same day, so nothing moves.
      vi.setSystemTime(t0 + 10 * 60_000);
      mocks.runTests.mockResolvedValue(sandboxResult('accepted'));
      await submit();
      expect(db.isReviewQueued(PROBLEM_ID)).toBe(true);
      expect(db.getReviewRow(PROBLEM_ID)!.rung).toBe(0);

      // Each later-day clean solve climbs a rung: 1 → 3 → 7 → 14 days.
      let t = t0;
      for (const [wait, rung] of [[1, 1], [3, 2], [7, 3]] as const) {
        t += wait * DAY;
        vi.setSystemTime(t);
        await submit();
        const row = db.getReviewRow(PROBLEM_ID)!;
        expect(row.rung).toBe(rung);
        expect(row.clearedAt).toBeNull();
      }
      // A clean solve at the top rung clears it.
      t += 14 * DAY;
      vi.setSystemTime(t);
      await submit();
      expect(db.isReviewQueued(PROBLEM_ID)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a lapse drops ONE rung, and several misses on one day are one lapse', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const DAY = 86_400_000;
      const t0 = Date.parse('2026-10-21T19:00:00.000Z');
      vi.setSystemTime(t0);
      mocks.runTests.mockResolvedValue(sandboxResult('wrong_answer'));
      await submit();
      mocks.runTests.mockResolvedValue(sandboxResult('accepted'));
      vi.setSystemTime(t0 + 1 * DAY);
      await submit();
      vi.setSystemTime(t0 + 4 * DAY);
      await submit();
      expect(db.getReviewRow(PROBLEM_ID)!.rung).toBe(2);
      mocks.runTests.mockResolvedValue(sandboxResult('wrong_answer'));
      vi.setSystemTime(t0 + 11 * DAY);
      await submit();
      await submit({ problemId: PROBLEM_ID, code: 'y', override: true });
      const row = db.getReviewRow(PROBLEM_ID)!;
      expect(row.rung).toBe(1);
      expect(Date.parse(row.dueAt) - (t0 + 11 * DAY)).toBeGreaterThanOrEqual(3 * DAY - 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('soft-caps Submit at three a day per problem; `override` gets past it', async () => {
    mocks.runTests.mockResolvedValue(sandboxResult('wrong_answer'));
    for (let i = 0; i < 3; i++) expect((await submit()).status).toBe(200);
    const capped = await submit();
    expect(capped.status).toBe(409);
    expect(JSON.parse(capped.raw)).toMatchObject({ code: 'submit-cap' });
    expect(db.getHistory('javascript')).toHaveLength(3);
    expect((await submit({ problemId: PROBLEM_ID, code: 'x', override: true })).status).toBe(200);
    expect(db.getHistory('javascript')).toHaveLength(4);
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

// =============================================================================
// POST /api/coaching/fix — the reveal that costs the same as the other reveal
// =============================================================================
// A fix is CORRECTED CODE, so it is a reveal rather than a hint, and it shares
// /api/reveal's ledger for the reason db.ts states at that table: so a reload, a
// second tab or a hand-rolled POST cannot launder a revealed problem back into
// tier credit. The three properties asserted here are the whole contract —
// written before the body is returned, NOT written when there is nothing to
// return, and actually visible to the next submit.
suite('POST /api/coaching/fix', () => {
  /** Run a submit and hand back the fixId the coach's first bullet was stashed under. */
  async function submitAndGetFixId(): Promise<string> {
    mocks.runTests.mockResolvedValue(sandboxResult('wrong_answer'));
    const { events } = await submit();
    return events[1].coaching.missed[0].fixId as string;
  }

  function revealFix(fixId: unknown) {
    return app.request('/api/coaching/fix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixId }),
    });
  }

  it('returns the before/after and records the reveal', async () => {
    const fixId = await submitAndGetFixId();
    expect(db.isSolutionRevealed(PROBLEM_ID)).toBe(false);

    const res = await revealFix(fixId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      before: FIX_BEFORE,
      after: FIX_TEXT,
      assisted: true,
    });
    // The ledger row is keyed on the PROBLEM the fix came from — which is why
    // the stash carries a problemId rather than the route holding a second map.
    expect(db.isSolutionRevealed(PROBLEM_ID)).toBe(true);
  });

  it('404s an unknown id and writes NOTHING to the ledger', async () => {
    await submitAndGetFixId();
    const res = await revealFix('not-a-real-handle');
    expect(res.status).toBe(404);
    // The half that actually matters: a 404 that still charged would let a
    // guessed id cost somebody their clean solve.
    expect(db.isSolutionRevealed(PROBLEM_ID)).toBe(false);
  });

  it('404s a missing or non-string id without charging either', async () => {
    await submitAndGetFixId();
    expect((await revealFix(undefined)).status).toBe(404);
    expect((await revealFix(42)).status).toBe(404);
    expect(db.isSolutionRevealed(PROBLEM_ID)).toBe(false);
  });

  it('404s after the stash is gone, which is the honest answer to a restart', async () => {
    const fixId = await submitAndGetFixId();
    clearFixes(); // stands in for the process restart that really does this
    expect((await revealFix(fixId)).status).toBe(404);
    expect(db.isSolutionRevealed(PROBLEM_ID)).toBe(false);
  });

  it('is idempotent — a double-click does not 404 on what was just paid for', async () => {
    const fixId = await submitAndGetFixId();
    expect((await revealFix(fixId)).status).toBe(200);
    expect((await revealFix(fixId)).status).toBe(200);
  });

  it('makes the NEXT submit of that problem count as assisted', async () => {
    // THE ONE ACCEPTED CONSEQUENCE, asserted rather than described: the brief
    // only exists after the attempt row is written, so a peek prices the next
    // submit and never the one that produced it. Exactly how the Answer button
    // already behaves.
    const fixId = await submitAndGetFixId();
    await revealFix(fixId);

    mocks.runTests.mockResolvedValue(sandboxResult('accepted'));
    await submit({ problemId: PROBLEM_ID, code: 'x', hintsUsed: 0 });

    const history = db.getHistory('javascript');
    expect(history[0].hintsUsed).toBeGreaterThanOrEqual(1);
    // An assisted solve keeps the review queued — it cannot earn tier credit.
    expect(db.isReviewQueued(PROBLEM_ID)).toBe(true);
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

suite('POST /api/submit — mode: mock (a Submit inside a coding mock interview)', () => {
  async function codingMock(status: 'active' | 'graded' = 'active', problemId = PROBLEM_ID) {
    const { insertMock, emptyUsage } = await import('../services/mock.store.js');
    const { initialState } = await import('../services/mock.state.js');
    const id = `mock-${Math.random().toString(36).slice(2)}`;
    const now = new Date();
    insertMock({
      id, kind: 'coding', level: 'staff', promptId: null, prompt: 'Two Sum (easy)', status, context: 'ctx', digest: null,
      state: {
        ...initialState(now, 'coding'),
        coding: {
          problemId, title: 'Two Sum', topic: 'arrays', difficulty: 'easy', pattern: 'hash map', language: 'javascript',
          chosenBy: 'weakest', starterHash: 'a', codeHash: 'a', lastCode: null, runHash: null, submits: 0, lastSubmit: null,
        },
      },
      usage: emptyUsage(), turnCount: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(), endedAt: null,
    });
    return id;
  }
  const count = (table: string) => (db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  it('runs the hidden tests and records them on the mock — and writes NO attempt, skill, SRS or review row', async () => {
    mocks.runTests.mockResolvedValue(sandboxResult('wrong_answer'));
    const mockId = await codingMock();
    const { status, events } = await submit({ mode: 'mock', mockId, problemId: PROBLEM_ID, code: 'function twoSum(){}' });
    expect(status).toBe(200);
    expect(events.map((e) => e.type)).toEqual(['result']);
    expect(events[0].result).toMatchObject({ passed: 1, total: 2, verdict: 'wrong_answer' });
    // Hidden values stay off the wire, as on a normal submit.
    expect(JSON.stringify(events)).not.toContain('"expected"');
    expect(mocks.runTests).toHaveBeenCalledWith(expect.objectContaining({ tests: expect.arrayContaining([expect.objectContaining({ name: 'hidden 2' })]) }));
    expect(mocks.coach).not.toHaveBeenCalled();
    expect(count('attempts')).toBe(0);
    expect(count('skill_state')).toBe(0);
    expect(count('review_queue')).toBe(0);
    const { getMock } = await import('../services/mock.store.js');
    const coding = getMock(mockId)!.state.coding!;
    expect(coding.submits).toBe(1);
    expect(coding.lastSubmit).toMatchObject({ verdict: 'wrong_answer', passed: 1, total: 2, failing: ['hidden 2'] });
  });

  it('never hands back the reference solution, even on a pass', async () => {
    mocks.runTests.mockResolvedValue(sandboxResult('accepted'));
    const mockId = await codingMock();
    const { events, raw } = await submit({ mode: 'mock', mockId, problemId: PROBLEM_ID, code: 'x' });
    expect(events[0].result.verdict).toBe('accepted');
    expect(events[0].referenceSolution).toBeUndefined();
    expect(raw).not.toContain(REFERENCE);
    expect(count('attempts')).toBe(0);
  });

  it('refuses a mock that is not active, an unknown mock, or another problem — before the sandbox runs', async () => {
    const graded = await codingMock('graded');
    expect((await submit({ mode: 'mock', mockId: graded, problemId: PROBLEM_ID, code: 'x' })).status).toBe(409);
    expect((await submit({ mode: 'mock', mockId: 'nope', problemId: PROBLEM_ID, code: 'x' })).status).toBe(404);
    const active = await codingMock();
    expect((await submit({ mode: 'mock', mockId: active, problemId: 'p-other', code: 'x' })).status).toBe(400);
    expect(mocks.runTests).not.toHaveBeenCalled();
    expect(count('attempts')).toBe(0);
  });
});
