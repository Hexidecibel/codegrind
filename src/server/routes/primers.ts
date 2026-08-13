import { Hono } from 'hono';
import { TOPICS, type Topic, type Primer } from '../../shared/types.js';
import { getPrimer, insertPrimer, getActiveLanguage } from '../services/db.js';
import { generatePrimer } from '../services/llm.service.js';

export const primersRoutes = new Hono();

function isTopic(v: unknown): v is Topic {
  return typeof v === 'string' && (TOPICS as readonly string[]).includes(v);
}

// GET /api/primer/:topic — cached primer, generated + cached on a miss.
primersRoutes.get('/primer/:topic', async (c) => {
  const topic = c.req.param('topic');
  if (!isTopic(topic)) {
    return c.json({ error: `topic must be one of: ${TOPICS.join(', ')}` }, 400);
  }
  try {
    // The card is SHARED and its skeleton is not: this is a read path, so it
    // gets the active language's overlay, falling back to the stored snippet
    // when nothing has translated this pattern yet.
    const language = getActiveLanguage();
    const cached = getPrimer(language, topic);
    if (cached) return c.json(cached);

    // A cold generate authors in the corpus language, so what it stores is the
    // original. Re-reading through the overlay serves the translation when one
    // already exists for a primer that was somehow only just cached.
    const primer: Primer = await generatePrimer(topic);
    insertPrimer(primer);
    return c.json(getPrimer(language, topic) ?? primer);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[primer]', message);
    return c.json({ error: message }, 500);
  }
});
