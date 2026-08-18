import { Hono } from 'hono';
import {
  TOPICS,
  DIFFICULTIES,
  toPlayerProblem,
  type Topic,
  type Difficulty,
} from '../../shared/types.js';
import { generateAndStore, getNextProblem, getProblem } from '../services/bank.service.js';
import { getActiveLanguage } from '../services/db.js';
import { errorBody } from '../services/explain.service.js';

export const problemsRoutes = new Hono();

function isTopic(v: unknown): v is Topic {
  return typeof v === 'string' && (TOPICS as readonly string[]).includes(v);
}
function isDifficulty(v: unknown): v is Difficulty {
  return typeof v === 'string' && (DIFFICULTIES as readonly string[]).includes(v);
}

// POST /api/problems/generate { topic, difficulty } — generate + store, return player-safe view.
problemsRoutes.post('/problems/generate', async (c) => {
  try {
    const body = await c.req.json<{ topic?: string; difficulty?: string }>();
    if (!isTopic(body.topic)) {
      return c.json({ error: `topic must be one of: ${TOPICS.join(', ')}` }, 400);
    }
    if (!isDifficulty(body.difficulty)) {
      return c.json({ error: `difficulty must be one of: ${DIFFICULTIES.join(', ')}` }, 400);
    }
    // The language comes from the server-side setting, never from the request:
    // language is chosen at GENERATION time (it binds the reference solution and
    // every `expected` value), so a client cannot ask for one bank and be graded
    // against another's harness.
    const record = await generateAndStore(getActiveLanguage(), body.topic, body.difficulty);
    return c.json(toPlayerProblem(record));
  } catch (err) {
    // Explained, not echoed: a cold generation that fails does so with an
    // internal sentence about canonicalization, max_tokens or raw docker
    // output, and this route is the one a player is staring at when it happens.
    // Full detail still reaches the journal and rides along as `detail`.
    return c.json(errorBody('problems/generate', err), 500);
  }
});

// GET /api/problems/next?topic&difficulty — unused from bank, else generate.
problemsRoutes.get('/problems/next', async (c) => {
  try {
    const topic = c.req.query('topic');
    const difficulty = c.req.query('difficulty');
    if (!isTopic(topic)) {
      return c.json({ error: `topic must be one of: ${TOPICS.join(', ')}` }, 400);
    }
    if (!isDifficulty(difficulty)) {
      return c.json({ error: `difficulty must be one of: ${DIFFICULTIES.join(', ')}` }, 400);
    }
    const record = await getNextProblem(getActiveLanguage(), topic, difficulty);
    return c.json(toPlayerProblem(record));
  } catch (err) {
    // Explained, not echoed: a cold generation that fails does so with an
    // internal sentence about canonicalization, max_tokens or raw docker
    // output, and this route is the one a player is staring at when it happens.
    // Full detail still reaches the journal and rides along as `detail`.
    return c.json(errorBody('problems/next', err), 500);
  }
});

// GET /api/problems/:id — player-safe view.
problemsRoutes.get('/problems/:id', (c) => {
  const id = c.req.param('id');
  const record = getProblem(id);
  if (!record) return c.json({ error: 'problem not found' }, 404);
  return c.json(toPlayerProblem(record));
});
