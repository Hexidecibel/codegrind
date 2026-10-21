// =============================================================================
// routes/concept — concept reps and the AI-systems track (Phase H3)
// =============================================================================
//   GET  /api/concept/today[?next=1]   the day's pick, its question, the primer
//                                      when the concept is new              free
//   POST /api/concept/learn            {concept, via: primer|lesson}         free
//   POST /api/concept/grade            {concept, promptIdx, answer, primed}  ONE workhorse call
//   GET  /api/concept/track            learning state per concept + AI gate  free
//   GET  /api/concept/lesson/:concept  an AI-systems lesson; generated ONCE  one workhorse call, then free

import { Hono, type Context } from 'hono';
import { ConceptError, conceptToday, grade, learn, lesson, track } from '../services/concept.service.js';
import { errorBody } from '../services/explain.service.js';

export const conceptRoutes = new Hono();

function fail(c: Context, tag: string, err: unknown) {
  if (err instanceof ConceptError) return c.json({ error: err.message }, err.status);
  return c.json(errorBody(tag, err), tag === 'concept-grade' || tag === 'concept-lesson' ? 502 : 500);
}

const body = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

conceptRoutes.get('/concept/today', (c) => {
  try {
    return c.json(conceptToday({ next: c.req.query('next') === '1' }));
  } catch (err) {
    return fail(c, 'concept-today', err);
  }
});

conceptRoutes.post('/concept/learn', async (c) => {
  try {
    return c.json(learn(await body(c)));
  } catch (err) {
    return fail(c, 'concept-learn', err);
  }
});

conceptRoutes.post('/concept/grade', async (c) => {
  try {
    return c.json(await grade(await body(c)));
  } catch (err) {
    return fail(c, 'concept-grade', err);
  }
});

conceptRoutes.get('/concept/track', (c) => {
  try {
    return c.json(track());
  } catch (err) {
    return fail(c, 'concept-track', err);
  }
});

conceptRoutes.get('/concept/lesson/:concept', async (c) => {
  try {
    return c.json(await lesson(c.req.param('concept')));
  } catch (err) {
    return fail(c, 'concept-lesson', err);
  }
});
