import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type {
  SubmitResponse,
  AskResponse,
  RevealResponse,
  ChatTurn,
  Prediction,
  TestResult,
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
} from '../services/db.js';
import { runTests } from '../services/sandbox.service.js';
import { coach, askFollowup } from '../services/llm.service.js';

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

export const submitRoutes = new Hono();

// POST /api/run { problemId, code } — sample tests only, sandbox, no AI.
submitRoutes.post('/run', async (c) => {
  try {
    const body = await c.req.json<{ problemId?: string; code?: string }>();
    const problem = body.problemId ? getProblem(body.problemId) : null;
    if (!problem) return c.json({ error: 'problem not found' }, 404);
    const code = typeof body.code === 'string' ? body.code : '';

    const result = await runTests(problem.functionName, code, problem.sampleTests);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[run]', message);
    return c.json({ error: message }, 500);
  }
});

// POST /api/submit { problemId, code } — hidden tests, sandbox, coach, store attempt.
submitRoutes.post('/submit', async (c) => {
  try {
    const body = await c.req.json<{
      problemId?: string;
      code?: string;
      hintsUsed?: number;
      prediction?: unknown;
    }>();
    const problem = body.problemId ? getProblem(body.problemId) : null;
    if (!problem) return c.json({ error: 'problem not found' }, 404);
    const code = typeof body.code === 'string' ? body.code : '';
    const clientHints = typeof body.hintsUsed === 'number' ? body.hintsUsed : 0;
    const prediction = coercePrediction(body.prediction);

    // Reading the answer is assistance, and the ledger for it is server-side.
    // Counting a reveal as one hint is enough to disqualify the attempt from
    // every clean-solve path below (tier credit, review clearing, streaks).
    const assistedHints = Math.max(clientHints, isSolutionRevealed(problem.id) ? 1 : 0);

    const result = await runTests(problem.functionName, code, problem.hiddenTests);
    const solved = result.verdict === 'accepted';

    // Coach on the real results (best-effort — a coaching failure must not lose the run).
    let coaching;
    try {
      coaching = await coach(problem, code, result.results, prediction);
    } catch (err) {
      console.error('[submit] coaching failed:', err instanceof Error ? err.message : err);
      coaching = {
        approach: '',
        missed: [],
        pattern: problem.pattern,
        patternRecognition: '',
        complexity: { yours: 'unknown', optimal: 'unknown' },
        improvement: 'Coaching is temporarily unavailable — your test results are above.',
        mistakeTags: [],
      };
    }

    insertAttempt({
      id: nanoid(),
      problemId: problem.id,
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
    updateSkillOnAttempt(problem.topic, solved, assistedHints);

    // Retrieval loop: a clean unaided solve clears the review; a miss or an
    // assisted solve (hint or revealed answer) (re-)queues it on the ladder.
    if (solved && assistedHints === 0) {
      clearReview(problem.id);
    } else if (isReviewQueued(problem.id)) {
      bumpReviewOnFail(problem.id);
    } else {
      enqueueReview(problem.id, assistedHints > 0 && solved ? 'hinted' : 'failed');
    }

    // Solved it — so stop hiding the answer. The coach already discusses the
    // reference solution; withholding the text of it here was the infuriating
    // part. Still absent on every unsolved submit.
    const payload: SubmitResponse = solved
      ? { result, coaching, referenceSolution: problem.referenceSolution }
      : { result, coaching };
    return c.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[submit]', message);
    return c.json({ error: message }, 500);
  }
});

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

    const results = coerceTestResults(body.results);

    const answer = await askFollowup(problem, code, question, history, results);
    const payload: AskResponse = { answer };
    return c.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[ask]', message);
    return c.json({ error: message }, 500);
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
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[reveal]', message);
    return c.json({ error: message }, 500);
  }
});
