// =============================================================================
// routes/recognize — the Recognize drill (pattern matching, no code)
// =============================================================================
//   GET  /api/recognize/session?n=5|10   the cards: statement + 4 choices   free
//   POST /api/recognize/reveal           {problemId, picked}                 free*
//   POST /api/recognize/code             {problemId}  full reference code    free, WRITES the reveal ledger
//   POST /api/recognize/check            {problemId, picked, approach}       ONE small model call, on click
//   POST /api/recognize/grade            {problemId, picked, approach, selfGrade, …}  free
//   GET  /api/recognize/stats            per-pattern accuracy, due counts    free
//
// * a topic with no cached primer yet generates one, once, ever (shared cache).
// None of these is a solve: no attempts, skill_state, tier credit or review_queue.

import { Hono, type Context } from 'hono';
import { RecognizeError, check, grade, reveal, showCode, startSession, stats } from '../services/recognize.service.js';
import { errorBody } from '../services/explain.service.js';

export const recognizeRoutes = new Hono();

function fail(c: Context, tag: string, err: unknown) {
  if (err instanceof RecognizeError) return c.json({ error: err.message }, err.status);
  return c.json(errorBody(tag, err), tag === 'recognize-check' ? 502 : 500);
}

const body = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

recognizeRoutes.get('/recognize/session', (c) => {
  try {
    return c.json(startSession(c.req.query('n')));
  } catch (err) {
    return fail(c, 'recognize-session', err);
  }
});

recognizeRoutes.post('/recognize/reveal', async (c) => {
  try {
    const b = await body(c);
    return c.json(await reveal(b.problemId, b.picked));
  } catch (err) {
    return fail(c, 'recognize-reveal', err);
  }
});

recognizeRoutes.post('/recognize/code', async (c) => {
  try {
    const b = await body(c);
    return c.json(showCode(b.problemId));
  } catch (err) {
    return fail(c, 'recognize-code', err);
  }
});

recognizeRoutes.post('/recognize/check', async (c) => {
  try {
    return c.json(await check(await body(c)));
  } catch (err) {
    return fail(c, 'recognize-check', err);
  }
});

recognizeRoutes.post('/recognize/grade', async (c) => {
  try {
    return c.json(grade(await body(c)));
  } catch (err) {
    return fail(c, 'recognize-grade', err);
  }
});

recognizeRoutes.get('/recognize/stats', (c) => {
  try {
    return c.json(stats());
  } catch (err) {
    return fail(c, 'recognize-stats', err);
  }
});
