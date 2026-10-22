// =============================================================================
// routes/envelope — the Envelope math drill (Phase G)
// =============================================================================
//   GET  /api/envelope/session?n=5   due cards first, then fresh reps       free
//   POST /api/envelope/check         {key, answer, working?}                 free
//   POST /api/envelope/note          {attemptId}  ONE small call on a miss   gated by "AI reviews"
//   GET  /api/envelope/stats         accuracy + mean |orders| over time      free
//   Phase I (all free, all deterministic):
//   GET  /api/envelope/guided?key=   the item's guided steps (faded ones filled in)
//   POST /api/envelope/step          {key, index, answer} one step, checked + recorded
//   GET  /api/envelope/anchors       due anchor flashcards
//   POST /api/envelope/anchors/check {id, answer, ms}
//   GET  /api/envelope/speed         a 60 s speed round's items + best + history
//   POST /api/envelope/speed         {answers: [{key, answer, atMs}]} → score

import { Hono, type Context } from 'hono';
import {
  EnvelopeError,
  anchorSession,
  check,
  checkAnchorCard,
  checkGuidedStep,
  guidedSteps,
  note,
  speedFinish,
  speedStart,
  startSession,
  stats,
} from '../services/envelope.service.js';
import { errorBody } from '../services/explain.service.js';

export const envelopeRoutes = new Hono();

function fail(c: Context, tag: string, err: unknown) {
  if (err instanceof EnvelopeError) return c.json({ error: err.message }, err.status);
  return c.json(errorBody(tag, err), tag === 'envelope-note' ? 502 : 500);
}

const body = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

envelopeRoutes.get('/envelope/session', (c) => {
  try {
    return c.json(startSession(c.req.query('n'), new Date(), { kind: c.req.query('kind'), skill: c.req.query('skill'), mode: c.req.query('mode') }));
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

const route = (method: 'get' | 'post', path: string, tag: string, fn: (c: Context) => unknown | Promise<unknown>) =>
  envelopeRoutes[method](path, async (c) => {
    try {
      return c.json(await fn(c));
    } catch (err) {
      return fail(c, tag, err);
    }
  });

route('get', '/envelope/guided', 'envelope-guided', (c) => guidedSteps(c.req.query('key')));
route('post', '/envelope/step', 'envelope-step', async (c) => checkGuidedStep(await body(c)));
route('get', '/envelope/anchors', 'envelope-anchors', () => anchorSession());
route('post', '/envelope/anchors/check', 'envelope-anchors', async (c) => checkAnchorCard(await body(c)));
route('get', '/envelope/speed', 'envelope-speed', () => speedStart());
route('post', '/envelope/speed', 'envelope-speed', async (c) => speedFinish(await body(c)));
