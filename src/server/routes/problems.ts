import { Hono } from 'hono';
import {
  TOPICS,
  DIFFICULTIES,
  toPlayerProblem,
  type Topic,
  type Difficulty,
} from '../../shared/types.js';
import { generateAndStore, getNextProblem, getProblem } from '../services/bank.service.js';

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
    const record = await generateAndStore(body.topic, body.difficulty);
    return c.json(toPlayerProblem(record));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[problems/generate]', message);
    return c.json({ error: message }, 500);
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
    const record = await getNextProblem(topic, difficulty);
    return c.json(toPlayerProblem(record));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[problems/next]', message);
    return c.json({ error: message }, 500);
  }
});

// GET /api/problems/:id — player-safe view.
problemsRoutes.get('/problems/:id', (c) => {
  const id = c.req.param('id');
  const record = getProblem(id);
  if (!record) return c.json({ error: 'problem not found' }, 404);
  return c.json(toPlayerProblem(record));
});
