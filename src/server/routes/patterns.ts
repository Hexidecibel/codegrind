// =============================================================================
// routes/patterns — the /patterns page (pattern shapes) — all free
// =============================================================================
//   GET  /api/patterns                 recall cards + what is due
//   POST /api/patterns/:id/view        a card was opened (Today's Re-learn)
//   POST /api/patterns/:id/recall      {grade: got|shaky|missed, answer?} self-grade

import { Hono, type Context } from 'hono';
import { PatternsError, gradeRecall, patternsState, viewPattern } from '../services/patterns.service.js';
import { errorBody } from '../services/explain.service.js';

export const patternsRoutes = new Hono();

function fail(c: Context, tag: string, err: unknown) {
  if (err instanceof PatternsError) return c.json({ error: err.message }, err.status);
  return c.json(errorBody(tag, err), 500);
}

patternsRoutes.get('/patterns', (c) => {
  try {
    return c.json(patternsState());
  } catch (err) {
    return fail(c, 'patterns', err);
  }
});

patternsRoutes.post('/patterns/:id/view', (c) => {
  try {
    return c.json(viewPattern(c.req.param('id')));
  } catch (err) {
    return fail(c, 'patterns-view', err);
  }
});

patternsRoutes.post('/patterns/:id/recall', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { grade?: unknown; answer?: unknown };
    return c.json(gradeRecall(c.req.param('id'), body));
  } catch (err) {
    return fail(c, 'patterns-recall', err);
  }
});
