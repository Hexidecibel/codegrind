// =============================================================================
// routes/mock — mock interviews over HTTP
// =============================================================================
//   GET  /api/mocks                 list            free
//   GET  /api/mock/prompts?kind=    the prompt bank free (kind absent = system design)
//   GET  /api/mock/plan?kind=       a planned kind's preview   free (behavioral reads the story bank; no model)
//   GET  /api/mock/projects         deep-dive project options  free (story bank + master resume; no model)
//   GET  /api/mock/cards            due drill cards free
//   POST /api/mock/cards/:id/grade  {grade: got|shaky|missed}      free (the user's grade, no model)
//   POST /api/mock/cards/:id/check  {answer}                       ONE small call (AI grade, moves nothing;
//                                                                  "I don't know" = missed, free)
//   GET  /api/mock/:id              one mock        free
//   POST /api/mock/start            {kind?, level?, promptId?, project?}  ONE model call
//   POST /api/mock/:id/turn         {expectedSeq, content, action?} ONE model call
//   POST /api/mock/:id/end          {code?} NDJSON: wrapup → grade  ONE model call (two on a retry)
//                                   (coding: the final code runs against the hidden tests first —
//                                   sandbox, not a model — unless the last mock Submit already did)
//   POST /api/mock/:id/abandon      free
//
// Every model call is a POST the candidate clicked; every GET is a database read.
// 409 = the mock moved on (or is not active), 429 = a call for it is in flight.

import { mockPickOptions } from '../services/concept.service.js';
import { Hono, type Context } from 'hono';
import { stream } from 'hono/streaming';
import { mockKindInfo } from '../../shared/mock-kinds.js';
import type { MockEndEvent, MockListResponse } from '../../shared/mock.js';
import {
  MockError,
  abandonMock,
  gapCards,
  getMockView,
  gradeGapCard,
  checkGapCard,
  deepDiveProjects,
  parseEnd,
  parseKind,
  prepareEnd,
  previewPlan,
  runEnd,
  startMock,
  takeTurn,
} from '../services/mock.service.js';
import { listMocks } from '../services/mock.store.js';
import { errorBody } from '../services/explain.service.js';

export const mockRoutes = new Hono();

function fail(c: Context, tag: string, err: unknown) {
  if (err instanceof MockError) return c.json({ error: err.message }, err.status);
  // A model failure: the candidate's message was NOT stored, so the client
  // keeps it in the composer and can simply send again.
  return c.json(errorBody(tag, err), 502);
}

mockRoutes.get('/mocks', (c) => {
  const body: MockListResponse = { mocks: listMocks() };
  return c.json(body);
});

mockRoutes.get('/mock/prompts', (c) => {
  try {
    const kind = parseKind(c.req.query('kind'));
    const { prompts } = mockKindInfo(kind);
    // Phase H3: AI prompts carry `ai`; `aiUnlocked` says whether they are in the
    // random pick yet (the start card labels them practice until then).
    const aiUnlocked = kind === 'system-design' ? mockPickOptions().aiUnlocked === true : false;
    return c.json({
      prompts: prompts.map(({ id, title, brief, familiar, ai }) => ({ id, title, brief, familiar, ...(ai ? { ai: true } : {}) })),
      aiUnlocked,
    });
  } catch (err) {
    return fail(c, 'mock-prompts', err);
  }
});

// Registered BEFORE /mock/:id, which would otherwise read "plan" as a mock id.
mockRoutes.get('/mock/plan', async (c) => {
  try {
    return c.json(await previewPlan(c.req.query('kind'), c.req.query('level')));
  } catch (err) {
    return fail(c, 'mock-plan', err);
  }
});

// Phase H4. Registered BEFORE /mock/:id, which would otherwise read "projects" as a mock id.
mockRoutes.get('/mock/projects', async (c) => {
  try {
    return c.json(await deepDiveProjects());
  } catch (err) {
    return fail(c, 'mock-projects', err);
  }
});

// Registered BEFORE /mock/:id, which would otherwise read "cards" as a mock id.
mockRoutes.get('/mock/cards', (c) => c.json(gapCards()));

mockRoutes.post('/mock/cards/:id/grade', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'No such card.' }, 404);
    const body = await c.req.json().catch(() => null);
    return c.json(gradeGapCard(id, body));
  } catch (err) {
    return fail(c, 'mock-card', err);
  }
});

mockRoutes.post('/mock/cards/:id/check', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'No such card.' }, 404);
    const body = await c.req.json().catch(() => null);
    return c.json(await checkGapCard(id, body));
  } catch (err) {
    return fail(c, 'mock-card-check', err);
  }
});

mockRoutes.get('/mock/:id', (c) => {
  try {
    return c.json(getMockView(c.req.param('id')));
  } catch (err) {
    return fail(c, 'mock', err);
  }
});

mockRoutes.post('/mock/start', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await startMock(body ?? {}));
  } catch (err) {
    return fail(c, 'mock-start', err);
  }
});

mockRoutes.post('/mock/:id/turn', async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    return c.json(await takeTurn(c.req.param('id'), body));
  } catch (err) {
    return fail(c, 'mock-turn', err);
  }
});

mockRoutes.post('/mock/:id/abandon', (c) => {
  try {
    return c.json(abandonMock(c.req.param('id')));
  } catch (err) {
    return fail(c, 'mock-abandon', err);
  }
});

mockRoutes.post('/mock/:id/end', async (c) => {
  let mock;
  let end;
  try {
    // Validated BEFORE the stream opens, so "nothing to grade" is a 409 and not
    // an error line inside a 200.
    end = parseEnd(await c.req.json().catch(() => null));
    mock = prepareEnd(c.req.param('id'));
  } catch (err) {
    return fail(c, 'mock-end', err);
  }
  c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
  c.header('Cache-Control', 'no-store');
  c.header('X-Accel-Buffering', 'no');
  return stream(c, async (s) => {
    for await (const event of runEnd(mock, end)) {
      try {
        await s.write(JSON.stringify(event satisfies MockEndEvent) + '\n');
      } catch {
        // The tab went away. Keep iterating: the grade is still stored, and the
        // next GET shows it.
      }
    }
  });
});
