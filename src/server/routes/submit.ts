import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { SubmitResponse, AskResponse, ChatTurn, Prediction } from '../../shared/types.js';
import {
  getProblem,
  insertAttempt,
  updateSkillOnAttempt,
  enqueueReview,
  bumpReviewOnFail,
  clearReview,
  isReviewQueued,
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
    const hintsUsed = typeof body.hintsUsed === 'number' ? body.hintsUsed : 0;
    const prediction = coercePrediction(body.prediction);

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
      hintsUsed,
      testsPassed: result.passed,
      testsTotal: result.total,
      code,
      createdAt: new Date().toISOString(),
      prediction: prediction ?? null,
      mistakeTags: coaching.mistakeTags ?? null,
    });

    // Update per-topic spaced-repetition / progression state (keyed on topic).
    updateSkillOnAttempt(problem.topic, problem.difficulty, solved, hintsUsed);

    // Retrieval loop: a clean unaided solve clears the review; a miss or a
    // hint-assisted solve (re-)queues it on the spaced ladder.
    if (solved && hintsUsed === 0) {
      clearReview(problem.id);
    } else if (isReviewQueued(problem.id)) {
      bumpReviewOnFail(problem.id);
    } else {
      enqueueReview(problem.id, hintsUsed > 0 && solved ? 'hinted' : 'failed');
    }

    const payload: SubmitResponse = { result, coaching };
    return c.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[submit]', message);
    return c.json({ error: message }, 500);
  }
});

// POST /api/ask { problemId, code, question, history? } — free-form tutor Q&A.
submitRoutes.post('/ask', async (c) => {
  try {
    const body = await c.req.json<{
      problemId?: string;
      code?: string;
      question?: string;
      history?: ChatTurn[];
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

    const answer = await askFollowup(problem, code, question, history);
    const payload: AskResponse = { answer };
    return c.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[ask]', message);
    return c.json({ error: message }, 500);
  }
});
