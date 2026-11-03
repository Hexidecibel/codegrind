import { Hono } from 'hono';
import type { ProgressStats, HistoryResponse } from '../../shared/types.js';
import {
  getProgress,
  getHistory,
  getReviewDueCount,
  getActiveLanguage,
  getClosenessAttempts,
} from '../services/db.js';
import { aggregateCloseness, CLOSENESS_WEEKS, type ClosenessStats } from '../../shared/closeness.js';
import { todayTz } from '../services/today.compute.js';

export const progressRoutes = new Hono();

// GET /api/progress — per-pattern mastery derived from attempts + review-due count.
progressRoutes.get('/progress', (c) => {
  const language = getActiveLanguage();
  const payload: ProgressStats = {
    patterns: getProgress(language),
    reviewDue: getReviewDueCount(language),
  };
  return c.json(payload);
});

// GET /api/history — recent attempts.
progressRoutes.get('/history', (c) => {
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.max(1, Math.min(200, parseInt(limitRaw, 10) || 50)) : 50;
  const payload: HistoryResponse = { attempts: getHistory(getActiveLanguage(), limit) };
  return c.json(payload);
});

// GET /api/progress/closeness — how close failed submits came, per local week:
// mean closeness, near misses, near misses fixed the same day (hints or not)
// and the unaided subset of those (shared/closeness). Free; the active language only.
progressRoutes.get('/progress/closeness', (c) => {
  const now = Date.now();
  // One week of slack on the cut-off: the window starts on a local Monday, and
  // the aggregation drops anything older than that itself.
  const since = new Date(now - (CLOSENESS_WEEKS + 1) * 7 * 86_400_000).toISOString();
  const payload: ClosenessStats = aggregateCloseness(getClosenessAttempts(getActiveLanguage(), since), now, todayTz());
  return c.json(payload);
});
