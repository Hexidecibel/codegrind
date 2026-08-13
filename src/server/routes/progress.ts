import { Hono } from 'hono';
import type { ProgressStats, HistoryResponse } from '../../shared/types.js';
import { getProgress, getHistory, getReviewDueCount } from '../services/db.js';

export const progressRoutes = new Hono();

// GET /api/progress — per-pattern mastery derived from attempts + review-due count.
progressRoutes.get('/progress', (c) => {
  const payload: ProgressStats = { patterns: getProgress(), reviewDue: getReviewDueCount() };
  return c.json(payload);
});

// GET /api/history — recent attempts.
progressRoutes.get('/history', (c) => {
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.max(1, Math.min(200, parseInt(limitRaw, 10) || 50)) : 50;
  const payload: HistoryResponse = { attempts: getHistory(limit) };
  return c.json(payload);
});
