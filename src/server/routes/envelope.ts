// =============================================================================
// routes/envelope — the Envelope math drill (Phase G)
// =============================================================================
//   GET  /api/envelope/session?n=5   due cards first, then fresh reps       free
//   POST /api/envelope/check         {key, answer, working?}                 free
//   POST /api/envelope/note          {attemptId}  ONE small call on a miss   gated by "AI reviews"
//   GET  /api/envelope/stats         accuracy + mean |orders| over time      free

import { Hono, type Context } from 'hono';
import { EnvelopeError, check, note, startSession, stats } from '../services/envelope.service.js';
import { errorBody } from '../services/explain.service.js';

export const envelopeRoutes = new Hono();

function fail(c: Context, tag: string, err: unknown) {
  if (err instanceof EnvelopeError) return c.json({ error: err.message }, err.status);
  return c.json(errorBody(tag, err), tag === 'envelope-note' ? 502 : 500);
}

const body = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

envelopeRoutes.get('/envelope/session', (c) => {
  try {
    return c.json(startSession(c.req.query('n')));
  } catch (err) {
    return fail(c, 'envelope-session', err);
  }
});

envelopeRoutes.post('/envelope/check', async (c) => {
  try {
    return c.json(check(await body(c)));
  } catch (err) {
    return fail(c, 'envelope-check', err);
  }
});

envelopeRoutes.post('/envelope/note', async (c) => {
  try {
    return c.json(await note(await body(c)));
  } catch (err) {
    return fail(c, 'envelope-note', err);
  }
});

envelopeRoutes.get('/envelope/stats', (c) => {
  try {
    return c.json(stats());
  } catch (err) {
    return fail(c, 'envelope-stats', err);
  }
});
