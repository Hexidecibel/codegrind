// =============================================================================
// routes/loops — target interview loops (Phase H2)
// =============================================================================
//   GET    /api/loops             every loop, soonest first                 free
//   POST   /api/loops             {company, date, rounds[], postingId?, postingTitle?}
//   PUT    /api/loops/:id         same body
//   DELETE /api/loops/:id
//   GET    /api/loops/postings    resume-builder's job postings, for the link
//                                 picker. A down resume-builder is
//                                 {available: false, postings: []}, never a 500.

import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { deleteLoop, insertLoop, listLoops, updateLoop } from '../services/db.js';
import { parseLoopBody, type JobPosting, type LoopsResponse, type PostingsResponse } from '../../shared/loops.js';
import { DEFAULT_STORY_BANK_URL } from '../services/story-bank.js';
import { errorBody } from '../services/explain.service.js';

export const loopsRoutes = new Hono();

const POSTINGS_TIMEOUT_MS = 2500;

/** resume-builder's postings file, same host as the story bank. */
export function postingsUrl(): string {
  const base = (process.env.CODEGRIND_STORY_BANK_URL || DEFAULT_STORY_BANK_URL).replace(/\/+$/, '');
  return `${base}/api/data/read?file=job-postings.json`;
}

/** Whatever resume-builder sent → JobPosting[]. Never throws. */
export function normalizePostings(raw: unknown): JobPosting[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data) ? (raw as { data: unknown[] }).data : [];
  const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '');
  return list.flatMap((p): JobPosting[] => {
    const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    const id = str(o.id);
    if (!id) return [];
    return [{ id, company: str(o.company).slice(0, 80), title: str(o.title).slice(0, 160), url: str(o.url) || null }];
  });
}

export async function fetchPostings(fetchImpl: typeof fetch = fetch): Promise<PostingsResponse> {
  try {
    const res = await fetchImpl(postingsUrl(), { signal: AbortSignal.timeout(POSTINGS_TIMEOUT_MS) });
    if (!res.ok) return { postings: [], available: false };
    return { postings: normalizePostings(await res.json()), available: true };
  } catch {
    return { postings: [], available: false };
  }
}

loopsRoutes.get('/loops', (c) => {
  try {
    const body: LoopsResponse = { loops: listLoops() };
    return c.json(body);
  } catch (err) {
    return c.json(errorBody('loops', err), 500);
  }
});

loopsRoutes.get('/loops/postings', async (c) => c.json(await fetchPostings()));

loopsRoutes.post('/loops', async (c) => {
  const parsed = parseLoopBody(await c.req.json().catch(() => null));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  try {
    insertLoop(nanoid(), parsed.value);
    return c.json({ loops: listLoops() } satisfies LoopsResponse);
  } catch (err) {
    return c.json(errorBody('loops', err), 500);
  }
});

loopsRoutes.put('/loops/:id', async (c) => {
  const parsed = parseLoopBody(await c.req.json().catch(() => null));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  try {
    if (!updateLoop(c.req.param('id'), parsed.value)) return c.json({ error: 'loop not found' }, 404);
    return c.json({ loops: listLoops() } satisfies LoopsResponse);
  } catch (err) {
    return c.json(errorBody('loops', err), 500);
  }
});

loopsRoutes.delete('/loops/:id', (c) => {
  try {
    if (!deleteLoop(c.req.param('id'))) return c.json({ error: 'loop not found' }, 404);
    return c.json({ loops: listLoops() } satisfies LoopsResponse);
  } catch (err) {
    return c.json(errorBody('loops', err), 500);
  }
});
