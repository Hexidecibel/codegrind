import { Hono, type Context } from 'hono';
import { stream } from 'hono/streaming';
import { nanoid } from 'nanoid';
import type {
  ProblemRecord,
  SubmitEvent,
  AskResponse,
  RevealResponse,
  ChatTurn,
  CoachingBrief,
  CoachFixResponse,
  Prediction,
  TestCase,
  TestResult,
  RunResult,
} from '../../shared/types.js';
import {
  getProblem,
  insertAttempt,
  updateSkillOnAttempt,
  enqueueReview,
  bumpReviewOnFail,
  clearReview,
  isReviewQueued,
  isSolutionRevealed,
  markSolutionRevealed,
  countSubmitsSince,
} from '../services/db.js';
import { SUBMIT_SOFT_CAP } from '../services/review-ladder.js';
import { dayStartMs, localDay, todayTz } from '../services/today.compute.js';
import { runTests } from '../services/sandbox.service.js';
import { coach, askFollowup } from '../services/llm.service.js';
import { todayCarryNotes } from '../services/today.service.js';
import { stashFix, getFix } from '../services/coachfix.service.js';
import { errorBody } from '../services/explain.service.js';
import { MockError, codingSubmitTarget, recordCodingSubmit } from '../services/mock.service.js';

/** Validate/normalize a client-supplied prediction, or undefined if absent/invalid. */
function coercePrediction(raw: unknown): Prediction | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;
  const approach = typeof p.approach === 'string' ? p.approach : '';
  const predTime = typeof p.predTime === 'string' ? p.predTime : '';
  const predSpace = typeof p.predSpace === 'string' ? p.predSpace : '';
  // Ignore an empty shell (all blank) — treat as "no prediction".
  if (!approach.trim() && !predTime.trim() && !predSpace.trim()) return undefined;
  let confidence = typeof p.confidence === 'number' ? Math.round(p.confidence) : 3;
  confidence = Math.max(1, Math.min(5, confidence));
  return { approach, predTime, predSpace, confidence };
}

/** Cap a stringified value so a pathological test payload can't blow up the prompt. */
function clip(s: string, max = 500): string {
  return s.length > max ? `${s.slice(0, max)}… (truncated)` : s;
}

/** Validate client-supplied per-test results (the tutor's view of what failed). */
function coerceTestResults(raw: unknown): TestResult[] {
  if (!Array.isArray(raw)) return [];
  const out: TestResult[] = [];
  for (const entry of raw.slice(0, 60)) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.name !== 'string' || typeof r.passed !== 'boolean') continue;
    out.push({
      name: clip(r.name, 120),
      passed: r.passed,
      expected: typeof r.expected === 'string' ? clip(r.expected) : undefined,
      actual: typeof r.actual === 'string' ? clip(r.actual) : undefined,
      stderr: typeof r.stderr === 'string' ? clip(r.stderr) : undefined,
      timeMs: typeof r.timeMs === 'number' && Number.isFinite(r.timeMs) ? r.timeMs : 0,
    });
  }
  return out;
}

/**
 * Put each result's `expected` back, from the problem's own test cases.
 *
 * The stored `expected` is a value; the runner reports a JSON string, and
 * `summarizeResults` formats what it is given — so this must serialize the same
 * way the harness does or the tutor would be shown two different notations for
 * the same answer. Matched on the test NAME because that is the only identifier
 * that crosses the sandbox boundary; an unmatched result (a renamed problem, a
 * stale tab) simply keeps whatever it arrived with rather than being dropped.
 */
export function rehydrateExpected(
  problem: { sampleTests: TestCase[]; hiddenTests: TestCase[] },
  results: TestResult[]
): TestResult[] {
  const byName = new Map<string, TestCase>();
  for (const t of [...problem.sampleTests, ...problem.hiddenTests]) {
    if (!byName.has(t.name)) byName.set(t.name, t);
  }
  return results.map((r) => {
    if (r.expected !== undefined) return r;
    const source = byName.get(r.name);
    if (!source) return r;
    let encoded: string;
    try {
      encoded = JSON.stringify(source.expected) ?? 'undefined';
    } catch {
      return r;
    }
    return { ...r, expected: clip(encoded) };
  });
}

export const submitRoutes = new Hono();

// POST /api/run { problemId, code } — sample tests only, sandbox, no AI.
submitRoutes.post('/run', async (c) => {
  try {
    const body = await c.req.json<{ problemId?: string; code?: string }>();
    const problem = body.problemId ? getProblem(body.problemId) : null;
    if (!problem) return c.json({ error: 'problem not found' }, 404);
    const code = typeof body.code === 'string' ? body.code : '';

    // The language comes off the PROBLEM, never off the request — /api/run and
    // /api/submit carry no language at all, which is what makes handing one
    // language's source to another's harness structurally impossible.
    const result = await runTests({
      language: problem.language,
      functionName: problem.functionName,
      userCode: code,
      tests: problem.sampleTests,
    });
    return c.json(result);
  } catch (err) {
    return c.json(errorBody('run', err), 500);
  }
});

/**
 * Hidden test results, with the answers taken out.
 *
 * A failed SUBMIT used to render `expected` for every hidden case, which handed
 * the player the exact output the grader wanted — enough to hardcode a green
 * run and enough to make the next attempt worthless as retrieval practice.
 * Sample tests (the Run path) are published in the problem statement and stay
 * fully visible; only the hidden suite is redacted, and only here.
 *
 * The value is dropped from the WIRE, not merely hidden in the UI: it was
 * visible in the network response regardless of what the panel drew, which made
 * the UI rule a decoration rather than a rule. Nothing downstream needs it —
 * `coach()` is called with the unredacted results above, the attempt row stores
 * code and counts rather than per-test values, and /api/ask re-attaches expected
 * from the problem record server-side (see below) so the tutor still answers
 * "why did mine fail?" from the real numbers.
 */
export function redactHiddenExpected(results: TestResult[]): TestResult[] {
  return results.map(({ expected: _expected, ...rest }) => rest);
}

/** The coaching brief shown when the coaching call itself failed. */
function coachingUnavailable(problem: ProblemRecord): CoachingBrief {
  return {
    approach: '',
    missed: [],
    pattern: problem.pattern,
    patternRecognition: '',
    complexity: { yours: 'unknown', optimal: 'unknown' },
    improvement: 'Coaching is temporarily unavailable — your test results are above.',
    mistakeTags: [],
  };
}

// POST /api/submit { problemId, code } — hidden tests, sandbox, coach, store attempt.
//
// THE RESPONSE IS NDJSON: one `SubmitEvent` per line, `result` then `coaching`.
//
// It used to be a single JSON body, which meant the verdict — already computed,
// already sitting in a variable — was held behind the coaching call. That call
// is `role: 'workhorse'`, `maxTokens: 10000`, `thinking: 'adaptive'`, with a
// budget of 180s on Anthropic and 300s on a local endpoint, and the whole wait
// was covered by one static line of UI: "Running hidden tests and coaching your
// solution…". Two minutes of not knowing whether you passed.
//
// The shape is lifted from POST /api/setup/seed, which chose NDJSON for exactly
// this situation: a money-spending POST cannot use EventSource, and a stream of
// whole lines needs no reconnection semantics.
//
// WHAT DELIBERATELY DID NOT CHANGE: the attempt row, the skill/SRS update and
// the review-queue move still happen exactly once, in the same order, with the
// same values — AFTER coaching, because the attempt row stores its mistakeTags.
// Streaming moved when the client is TOLD things, not when anything is written.
//
// THE ONE ACCEPTED CONSEQUENCE. Because the recording still trails the coaching
// call, a player who reads the verdict and immediately hits "Next problem" can
// have the scheduler pick before this attempt's skill row and review entry
// exist, so that one pick is computed from pre-submit state. The alternatives
// were both worse: recording early would store null mistakeTags on every
// attempt, and splitting it into an insert plus a later UPDATE would turn "one
// write, one set of values" — the property most likely to break silently here —
// into two. The client compensates for the visible half (the "N due for review"
// pill waits for the stream to end; see SolveSurface's onSubmitRecorded).
submitRoutes.post('/submit', async (c) => {
  // MOCK MODE (a Submit inside a coding mock interview) is its own short path:
  // hidden tests, the result recorded on the MOCK, one `result` line — and
  // nothing else. No coaching call, no attempt row, no skill/SRS update, no
  // review-queue move, no reference solution even on a pass. The mock's grade
  // judges the solution; its only grind side effect lives there.
  const raw = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (raw && raw.mode === 'mock') return submitInMock(c, raw);
  // Everything that can fail before a byte is written stays an ordinary HTTP
  // error, with a status code and an explained message. Only what happens after
  // the first line is committed to the stream. This is also why the sandbox run
  // is here rather than inside the stream callback: a sandbox failure deserves a
  // 500 and a sentence, not a 200 carrying an error event.
  let problem: ProblemRecord;
  let code: string;
  let assistedHints: number;
  let prediction: Prediction | undefined;
  let result;
  try {
    const body = (raw ?? {}) as {
      problemId?: string;
      code?: string;
      hintsUsed?: number;
      prediction?: unknown;
      override?: unknown;
    };
    const found = body.problemId ? getProblem(body.problemId) : null;
    if (!found) return c.json({ error: 'problem not found' }, 404);
    problem = found;

    // The soft Submit cap: hammering Submit turns the hidden tests into the
    // debugger (a real log: 12 submits of one problem in 18 minutes). After
    // SUBMIT_SOFT_CAP today the client asks first and resends with `override`.
    if (body.override !== true) {
      const tz = todayTz();
      const dayStart = new Date(dayStartMs(localDay(Date.now(), tz), tz)).toISOString();
      if (countSubmitsSince(problem.id, dayStart) >= SUBMIT_SOFT_CAP) {
        return c.json(
          {
            error: `You've submitted this problem ${SUBMIT_SOFT_CAP} times today. Use Run on the samples (and trace an edge case) before submitting again — or submit anyway.`,
            code: 'submit-cap',
          },
          409
        );
      }
    }
    code = typeof body.code === 'string' ? body.code : '';
    const clientHints = typeof body.hintsUsed === 'number' ? body.hintsUsed : 0;
    prediction = coercePrediction(body.prediction);

    // Reading the answer is assistance, and the ledger for it is server-side.
    // Counting a reveal as one hint is enough to disqualify the attempt from
    // every clean-solve path below (tier credit, review clearing, streaks).
    assistedHints = Math.max(clientHints, isSolutionRevealed(problem.id) ? 1 : 0);

    result = await runTests({
      language: problem.language,
      functionName: problem.functionName,
      userCode: code,
      tests: problem.hiddenTests,
    });
  } catch (err) {
    return c.json(errorBody('submit', err), 500);
  }

  const solved = result.verdict === 'accepted';

  c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
  c.header('Cache-Control', 'no-store');
  // Same ask as /api/setup/seed: nothing in this stack buffers by default, but a
  // proxy in front of it might, and a buffered stream is just the old blocking
  // response with extra steps.
  c.header('X-Accel-Buffering', 'no');

  return stream(c, async (s) => {
    // A write that fails means the tab was closed, and that must NOT skip the
    // recording below: the tests ran, the attempt happened, and a player who
    // navigated away still solved it. Swallow, keep going.
    const write = async (event: SubmitEvent) => {
      try {
        await s.write(JSON.stringify(event) + '\n');
      } catch (err) {
        console.warn('[submit] client went away mid-stream:', err instanceof Error ? err.message : err);
      }
    };

    // Solved it — so stop hiding the answer. The coach already discusses the
    // reference solution; withholding the text of it here was the infuriating
    // part. Still absent on every unsolved submit.
    await write(
      solved
        ? {
            type: 'result',
            result: { ...result, results: redactHiddenExpected(result.results) },
            referenceSolution: problem.referenceSolution,
          }
        : { type: 'result', result: { ...result, results: redactHiddenExpected(result.results) } }
    );

    // Coach on the REAL results — unredacted, because the tutor is the one
    // party that is supposed to know the expected values. Best-effort: a
    // coaching failure must not lose the run.
    let coaching: CoachingBrief;
    try {
      // `coach` hands back the brief and a SIDECAR of corrected code keyed by
      // its index in `missed`. The corrected code never touches this stream:
      // it is stashed server-side and the brief carries only the opaque handle
      // it was stashed under, which is what POST /api/coaching/fix trades for
      // the text after writing the reveal to the ledger. The sidecar is a
      // separate return value rather than a field to be deleted here, because
      // a field to be deleted is one forgotten code path away from shipping
      // the answer to devtools.
      const { brief, fixes } = await coach(problem, code, result.results, prediction, todayCarryNotes());
      coaching = brief;
      for (const [index, fix] of fixes) {
        const item = coaching.missed[index];
        if (item) item.fixId = stashFix(problem.id, fix);
      }
    } catch (err) {
      console.error('[submit] coaching failed:', err instanceof Error ? err.message : err);
      coaching = coachingUnavailable(problem);
    }

    insertAttempt({
      id: nanoid(),
      problemId: problem.id,
      // From the PROBLEM, not from the active setting. A submit belongs to the
      // language the problem was written in even if the setting was flipped
      // while this tab sat open.
      language: problem.language,
      pattern: problem.pattern,
      difficulty: problem.difficulty,
      solved,
      hintsUsed: assistedHints,
      testsPassed: result.passed,
      testsTotal: result.total,
      code,
      createdAt: new Date().toISOString(),
      prediction: prediction ?? null,
      mistakeTags: coaching.mistakeTags ?? null,
    });

    // Update per-topic spaced-repetition / progression state (keyed on topic).
    // AFTER insertAttempt on purpose — the tier derivation counts this attempt.
    updateSkillOnAttempt(problem.language, problem.topic, solved, assistedHints);

    // Retrieval loop (review-ladder.ts): a clean unaided solve climbs a queued
    // review one rung — never on the same day as its miss; a miss or an
    // assisted solve (hint or revealed answer) (re-)queues it on the ladder.
    if (solved && assistedHints === 0) {
      clearReview(problem.id);
    } else if (isReviewQueued(problem.id)) {
      bumpReviewOnFail(problem.id);
    } else {
      enqueueReview(problem.id, assistedHints > 0 && solved ? 'hinted' : 'failed');
    }

    await write({ type: 'coaching', coaching });
  });
});

/** POST /api/submit { mode: 'mock', mockId, problemId, code } — see the top of the submit route. */
async function submitInMock(c: Context, body: Record<string, unknown>) {
  let result: RunResult;
  let code: string;
  let mockId: string;
  try {
    const mock = codingSubmitTarget(body.mockId, body.problemId);
    mockId = mock.id;
    const problem = getProblem(mock.state.coding!.problemId);
    if (!problem) return c.json({ error: 'problem not found' }, 404);
    code = typeof body.code === 'string' ? body.code : '';
    result = await runTests({
      language: problem.language,
      functionName: problem.functionName,
      userCode: code,
      tests: problem.hiddenTests,
    });
  } catch (err) {
    if (err instanceof MockError) return c.json({ error: err.message }, err.status);
    return c.json(errorBody('submit', err), 500);
  }
  recordCodingSubmit(mockId, result, code);
  c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
  c.header('Cache-Control', 'no-store');
  c.header('X-Accel-Buffering', 'no');
  const event: SubmitEvent = { type: 'result', result: { ...result, results: redactHiddenExpected(result.results) } };
  return c.body(JSON.stringify(event) + '\n');
}

// POST /api/ask { problemId, code, question, history?, results? } — tutor Q&A.
// `results` are the per-test outcomes of the last submit: without them the
// tutor cannot see which test failed and answers "why did mine fail?" by
// guessing from the code.
submitRoutes.post('/ask', async (c) => {
  try {
    const body = await c.req.json<{
      problemId?: string;
      code?: string;
      question?: string;
      history?: ChatTurn[];
      results?: unknown;
    }>();
    const problem = body.problemId ? getProblem(body.problemId) : null;
    if (!problem) return c.json({ error: 'problem not found' }, 404);

    const code = typeof body.code === 'string' ? body.code : '';
    const question = typeof body.question === 'string' ? body.question : '';
    const history = Array.isArray(body.history)
      ? body.history.filter(
          (t): t is ChatTurn =>
            !!t &&
            (t.role === 'user' || t.role === 'assistant') &&
            typeof t.content === 'string'
        )
      : [];

    // Re-attach what the submit response deliberately withheld. The client no
    // longer HAS the hidden tests' expected values (redactHiddenExpected strips
    // them from the wire), and without them `summarizeResults` shows the tutor
    // "expected: —", which is exactly the fact it needs to answer "why did mine
    // fail?" from evidence instead of by re-deriving the answer from the code.
    // Server-side lookup, keyed on the test name the runner itself emitted.
    const results = rehydrateExpected(problem, coerceTestResults(body.results));

    const answer = await askFollowup(problem, code, question, history, results);
    const payload: AskResponse = { answer };
    return c.json(payload);
  } catch (err) {
    return c.json(errorBody('ask', err), 500);
  }
});

// POST /api/reveal { problemId } — "show me the answer".
//
// Always available, unconditionally. The price is recorded, not charged at the
// door: the reveal is written to the ledger BEFORE the solution is returned, so
// the subsequent submit counts as assisted no matter what the client does next.
submitRoutes.post('/reveal', async (c) => {
  try {
    const body = await c.req.json<{ problemId?: string }>();
    const problem = body.problemId ? getProblem(body.problemId) : null;
    if (!problem) return c.json({ error: 'problem not found' }, 404);

    markSolutionRevealed(problem.id);

    const payload: RevealResponse = {
      referenceSolution: problem.referenceSolution,
      assisted: true,
    };
    return c.json(payload);
  } catch (err) {
    return c.json(errorBody('reveal', err), 500);
  }
});

// POST /api/coaching/fix { fixId } — "show me what that line should have been".
//
// A sibling of /api/reveal, not a variant of it: that one takes a problemId and
// returns the whole reference solution, this one takes an opaque handle and
// returns a few lines. Same ledger, though, and deliberately so — a fix is
// CORRECTED CODE, which makes it a reveal rather than a hint, and the ledger is
// server-side for the reason db.ts states at the reveal table: so that a
// reload, a second tab, or a hand-rolled POST cannot launder a revealed problem
// back into tier credit. Written BEFORE the body is returned, same as /reveal.
//
// It is not given its own ledger column. `markSolutionRevealed` is idempotent
// and every consumer only ever asks `hintsUsed > 0` — `max(a, 1, 1)` is
// `max(a, 1)` — so a `kind` column would be a distinction nothing reads.
//
// THE ONE ACCEPTED CONSEQUENCE. A coaching brief only exists AFTER the attempt
// row for that submit is written, so peeking at a fix prices the NEXT submit of
// this problem and never the one that produced the brief. If the player never
// submits this problem again, the peek is free in practice; `countCleanSolves`
// dedupes by problemId, so a tier credit already banked cannot be clawed back
// either. That is exactly how the Answer button behaves today — reveal, then
// look, then move on — and making the fix behave differently would mean
// charging retroactively for something already recorded. Deliberately NOT
// paired with an `enqueueReview(problem.id, 'hinted')` to make the price bite:
// that would be a review-queue write happening outside a submit, which is a new
// kind of surprise for three lines of gain.
submitRoutes.post('/coaching/fix', async (c) => {
  try {
    const body = await c.req.json<{ fixId?: string }>();
    const fixId = typeof body.fixId === 'string' ? body.fixId : '';
    const fix = fixId ? getFix(fixId) : null;
    // A 404 here is honest and expected, not an error condition: the fixes live
    // in memory for the same reason the brief itself is never persisted, so a
    // restart (or a very old tab) legitimately has nothing to hand back. The
    // ledger is NOT written on this path — nothing was revealed.
    if (!fix) return c.json({ error: 'that fix is no longer available' }, 404);

    markSolutionRevealed(fix.problemId);

    const payload: CoachFixResponse = { before: fix.before, after: fix.after, assisted: true };
    return c.json(payload);
  } catch (err) {
    return c.json(errorBody('coaching fix', err), 500);
  }
});
