// =============================================================================
// routes/today — the guided daily routine
// =============================================================================
//   GET  /api/today                  the day, derived from real rows. Also
//                                    kicks the day's automatic reviews (step
//                                    notes, auto debrief) in the BACKGROUND —
//                                    at most once per step per day; see
//                                    today.service.kickAiReviews
//   (skip / end kick them too: ending the day early is a completion event)
//   POST /api/today/skip             {step, skip?: boolean}                free
//   POST /api/today/end              {ended?: boolean}  end day early      free
//   POST /api/today/debrief          {regenerate?: boolean}                ONE small model call
//                                    (cached per local day: a repeat without
//                                    `regenerate` is a free read)

import { Hono, type Context } from 'hono';
import { TodayError, debrief, getTodayAndKick, kickAiReviews, setEndedEarly, setSkip } from '../services/today.service.js';
import type { TodayState } from '../../shared/today.js';
import { errorBody } from '../services/explain.service.js';

export const todayRoutes = new Hono();

function fail(c: Context, tag: string, err: unknown) {
  if (err instanceof TodayError) return c.json({ error: err.message }, err.status);
  return c.json(errorBody(tag, err), tag === 'today-debrief' ? 502 : 500);
}

function kicked(state: TodayState): TodayState {
  return kickAiReviews(state) ? getTodayAndKick() : state;
}

todayRoutes.get('/today', (c) => {
  try {
    return c.json(getTodayAndKick());
  } catch (err) {
    return fail(c, 'today', err);
  }
});

todayRoutes.post('/today/skip', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { step?: unknown; skip?: unknown };
    return c.json(kicked(setSkip(body.step, body.skip !== false)));
  } catch (err) {
    return fail(c, 'today-skip', err);
  }
});

todayRoutes.post('/today/end', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { ended?: unknown };
    return c.json(kicked(setEndedEarly(body.ended !== false)));
  } catch (err) {
    return fail(c, 'today-end', err);
  }
});

todayRoutes.post('/today/debrief', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { regenerate?: unknown };
    return c.json(await debrief({ regenerate: body.regenerate === true }));
  } catch (err) {
    return fail(c, 'today-debrief', err);
  }
});
