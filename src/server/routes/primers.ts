import { Hono } from 'hono';
import { TOPICS, type Topic, type Primer } from '../../shared/types.js';
import { getPrimer, insertPrimer, getPrimerPatterns } from '../services/db.js';
import { generatePrimer } from '../services/llm.service.js';

export const primersRoutes = new Hono();

function isTopic(v: unknown): v is Topic {
  return typeof v === 'string' && (TOPICS as readonly string[]).includes(v);
}

// GET /api/primers — topics that already have a cached primer (library page).
primersRoutes.get('/primers', (c) => {
  const payload: string[] = getPrimerPatterns();
  return c.json(payload);
});

// GET /api/primer/:topic — cached primer, generated + cached on a miss.
primersRoutes.get('/primer/:topic', async (c) => {
  const topic = c.req.param('topic');
  if (!isTopic(topic)) {
    return c.json({ error: `topic must be one of: ${TOPICS.join(', ')}` }, 400);
  }
  try {
    const cached = getPrimer(topic);
    if (cached) return c.json(cached);

    const primer: Primer = await generatePrimer(topic);
    insertPrimer(primer);
    return c.json(primer);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[primer]', message);
    return c.json({ error: message }, 500);
  }
});
