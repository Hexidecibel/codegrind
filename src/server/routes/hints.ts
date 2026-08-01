import { Hono } from 'hono';
import type { HintLevel } from '../../shared/types.js';
import { getProblem } from '../services/db.js';
import { hint } from '../services/llm.service.js';

export const hintsRoutes = new Hono();

// POST /api/hint { problemId, code, level } — level-scoped nudge (1|2|3).
hintsRoutes.post('/hint', async (c) => {
  try {
    const body = await c.req.json<{ problemId?: string; code?: string; level?: number }>();
    const problem = body.problemId ? getProblem(body.problemId) : null;
    if (!problem) return c.json({ error: 'problem not found' }, 404);

    const rawLevel = typeof body.level === 'number' ? body.level : 1;
    const level = (rawLevel < 1 ? 1 : rawLevel > 3 ? 3 : rawLevel) as HintLevel;
    const code = typeof body.code === 'string' ? body.code : '';

    const result = await hint(problem, code, level);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[hint]', message);
    return c.json({ error: message }, 500);
  }
});
