// =============================================================================
// routes/forge — the story forge (Phase H4)
// =============================================================================
//   GET  /api/forge/options          competencies (gaps first), candidates, stories   free
//   GET  /api/forge/:id              one session                                       free
//   POST /api/forge/start            {competency, candidate?: {kind, ref}}             free (the first question is static)
//   POST /api/forge/:id/turn         {answer, expectedAnswers}                         ONE workhorse call
//   POST /api/forge/:id/save         {confirm: true}  backup → append as status 'draft' → retell card   free
//   POST /api/forge/:id/abandon                                                        free

import { Hono, type Context } from 'hono';
import { ForgeError, abandonForge, forgeOptions, forgeTurn, getForge, saveForge, startForge } from '../services/forge.service.js';
import { errorBody } from '../services/explain.service.js';

export const forgeRoutes = new Hono();

function fail(c: Context, tag: string, err: unknown) {
  if (err instanceof ForgeError) return c.json({ error: err.message }, err.status);
  // A model failure on a turn: the answer was NOT stored; the client keeps it.
  return c.json(errorBody(tag, err), 502);
}

const body = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

forgeRoutes.get('/forge/options', async (c) => {
  try {
    return c.json(await forgeOptions());
  } catch (err) {
    return fail(c, 'forge-options', err);
  }
});

forgeRoutes.post('/forge/start', async (c) => {
  try {
    return c.json(await startForge(await body(c)));
  } catch (err) {
    return fail(c, 'forge-start', err);
  }
});

forgeRoutes.get('/forge/:id', (c) => {
  try {
    return c.json(getForge(c.req.param('id')));
  } catch (err) {
    return fail(c, 'forge', err);
  }
});

forgeRoutes.post('/forge/:id/turn', async (c) => {
  try {
    return c.json(await forgeTurn(c.req.param('id'), await body(c)));
  } catch (err) {
    return fail(c, 'forge-turn', err);
  }
});

forgeRoutes.post('/forge/:id/save', async (c) => {
  try {
    return c.json(await saveForge(c.req.param('id'), await body(c)));
  } catch (err) {
    return fail(c, 'forge-save', err);
  }
});

forgeRoutes.post('/forge/:id/abandon', (c) => {
  try {
    return c.json(abandonForge(c.req.param('id')));
  } catch (err) {
    return fail(c, 'forge-abandon', err);
  }
});
