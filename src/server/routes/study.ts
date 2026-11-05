import { Hono } from 'hono';
import {
  TOPICS,
  type Topic,
  type Lesson,
  type StudyFeedItem,
  type StudyFeedResponse,
  type StudyIndexResponse,
  type StudyWriteResponse,
  type StudyPosition,
  type StudyReadResponse,
} from '../../shared/types.js';
import type { Language } from '../../shared/languages.js';
import {
  getLesson,
  markLessonRead,
  getLessonReadCounts,
  getCachedLessonMeta,
  getCleanSolvesByTopic,
  getActiveLanguage,
} from '../services/db.js';
import { masteryScore } from '../services/curriculum.js';
import {
  buildStudyState,
  ensureLesson,
  studyQueue,
  topicOrder,
  trackSlotCount,
  warmAhead,
  isSlotWarming,
  isSlotFailed,
  type StudySlot,
  type StudyQueueState,
} from '../services/study.service.js';
import { annotateSlot, coachFeed, type CoachFeedSlot, type CoachState } from '../services/coach.brain.js';
import { buildCoachState } from '../services/coach.service.js';

export const studyRoutes = new Hono();

function isTopic(v: unknown): v is Topic {
  return typeof v === 'string' && (TOPICS as readonly string[]).includes(v);
}

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 10;

function parseLimit(raw: string | undefined): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/** Total planned lessons in a topic's track (seq 0 + its outline items). */
function totalFor(topic: Topic, state: StudyQueueState): number {
  return trackSlotCount(state.outlines.get(topic));
}

function positionFor(slot: StudySlot | undefined, state: StudyQueueState): StudyPosition {
  if (!slot) {
    const first = topicOrder(state.skills)[0];
    return { topic: first, seq: 0, total: totalFor(first, state) };
  }
  return { topic: slot.topic, seq: slot.seq, total: totalFor(slot.topic, state) };
}

/** Uncached slots that are only ever written on an explicit click. */
function isStubSource(slot: StudySlot): boolean {
  return slot.source === 'fix' || slot.source === 'mistake';
}

/** Comma-separated ids the client already holds (capped). */
const MAX_SEEN = 50;
function parseSeen(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_SEEN)
  );
}

function itemFor(slot: CoachFeedSlot, stub: boolean): StudyFeedItem {
  const item: StudyFeedItem = {
    lessonId: slot.id,
    reason: slot.reason,
    intent: slot.intent,
    practice: { ...slot.then },
  };
  if (stub) {
    item.stub = { lessonId: slot.id, topic: slot.topic, title: slot.title, kind: slot.kind };
    if (slot.tag) item.stub.tag = slot.tag;
  }
  return item;
}

/**
 * Serve the leading run of ALREADY-CACHED slots, stopping at the first hole we
 * intend to fill so curriculum order is preserved (the client renders a skeleton
 * for that hole). Holes whose generation recently failed are stepped over rather
 * than stalled on forever. An unwritten FIX lesson is not a hole: it is served
 * as a stub the reader can choose to write (one AI call, on click), so it never
 * stalls the feed and never costs anything by itself.
 */
function serveFrom(
  language: Language,
  queue: CoachFeedSlot[],
  start: number,
  limit: number,
  seen: ReadonlySet<string>
): { lessons: Lesson[]; items: StudyFeedItem[]; served: CoachFeedSlot[]; nextIndex: number } {
  const lessons: Lesson[] = [];
  const items: StudyFeedItem[] = [];
  const served: CoachFeedSlot[] = [];
  let i = start;

  for (; i < queue.length; i++) {
    if (items.length >= limit) break;
    const slot = queue[i];
    if (seen.has(slot.id)) continue; // the client already shows it
    if (!slot.cached) {
      if (isStubSource(slot)) {
        items.push(itemFor(slot, true));
        served.push(slot);
        continue;
      }
      if (isSlotFailed(slot)) continue; // don't stall on a dead slot
      break;
    }
    const lesson = getLesson(language, slot.id);
    if (!lesson) continue; // planner/cache raced — skip rather than 500
    lessons.push(lesson);
    items.push(itemFor(slot, false));
    served.push(slot);
  }

  return { lessons, items, served, nextIndex: i };
}

/**
 * Shared body for /feed and /jump/:topic once the start index is decided.
 *
 * `language` reaches two places and no others: the snippet each served lesson
 * carries, and the translation job warmAhead schedules for the topics right
 * behind it. The prose, the ordering and the read receipts are shared corpus.
 */
function buildFeed(
  language: Language,
  state: StudyQueueState,
  queue: CoachFeedSlot[],
  start: number,
  limit: number,
  seen: ReadonlySet<string> = new Set()
): StudyFeedResponse {
  const { lessons, items, served, nextIndex } = serveFrom(language, queue, start, limit, seen);

  // Warm the holes ahead BEFORE reading `warming`, but never await any of it.
  // warmAhead skips fix/mistake slots: those are written only on a click.
  warmAhead(language, queue.slice(Math.max(start, 0)));

  const next = queue[nextIndex];
  const warming = !!next && !next.cached && isSlotWarming(next);

  // Position reads as "where am I in the ladder": prefer a track lesson over a
  // fix or re-read that happens to sit at the top of the feed.
  const anchor =
    served.find((s) => s.source === 'track') ?? served[0] ?? queue[start] ?? next;
  const missingOutlines = TOPICS.filter((t) => !state.outlines.has(t)).length;

  return {
    lessons,
    items,
    position: positionFor(anchor, state),
    warming,
    exhausted: queue.length === 0 && missingOutlines === 0,
  };
}

// GET /api/study/feed?after=<lessonId>&limit=3 — the never-ending reading feed.
// `after` omitted (or already read, so no longer in the queue) resumes at the
// first unread lesson in curriculum order.
studyRoutes.get('/study/feed', (c) => {
  try {
    const after = c.req.query('after');
    const startId = c.req.query('start')?.trim();
    const limit = parseLimit(c.req.query('limit'));
    const seen = parseSeen(c.req.query('seen'));

    const language = getActiveLanguage();
    const state = buildCoachState(language);
    let queue = coachFeed(state);

    let start = 0;
    if (after) {
      const idx = queue.findIndex((s) => s.id === after);
      if (idx >= 0) start = idx + 1;
    } else if (startId) {
      // `?start=<lessonId>` (Today's read step links here): open AT that
      // lesson. Planned = start there (an unwritten fix is served as its stub,
      // never written). Not planned but written (already read) = re-read it
      // first, then the normal queue. Unknown = the normal resume.
      const idx = queue.findIndex((s) => s.id === startId);
      if (idx >= 0) start = idx;
      else {
        const meta = getCachedLessonMeta().find((m) => m.id === startId);
        if (meta) {
          const slot = annotateSlot(state, { ...meta, cached: true, source: 'reread' });
          queue = [slot, ...queue];
        }
      }
    }

    return c.json(buildFeed(language, state, queue, start, limit, seen));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[study]', message);
    return c.json({ error: message }, 500);
  }
});

// GET /api/study/jump/:topic — same shape as /feed, repositioned to a topic.
studyRoutes.get('/study/jump/:topic', (c) => {
  const topic = c.req.param('topic');
  if (!isTopic(topic)) {
    return c.json({ error: `topic must be one of: ${TOPICS.join(', ')}` }, 400);
  }
  try {
    const language = getActiveLanguage();
    const state: CoachState = buildCoachState(language);
    const annotate = (s: StudySlot) => annotateSlot(state, s);
    let queue: CoachFeedSlot[] = studyQueue(state).map(annotate);

    // Only the topic's own TRACK counts as "somewhere to jump to" — a
    // personalized slot that happens to be tagged with this topic is not the
    // track, and landing on it would look like the jump did nothing.
    const idx = queue.findIndex((s) => s.topic === topic && s.source === 'track');
    if (idx >= 0) {
      // Unread material left in this topic — start there.
      return c.json(buildFeed(language, state, queue, idx, DEFAULT_LIMIT));
    }

    // Fully read: re-read the topic from the top, then fall back into the
    // normal queue so the feed keeps going past the end of the track.
    const reread: CoachFeedSlot[] = getCachedLessonMeta()
      .filter((m) => m.topic === topic)
      .map((m) => ({
        id: m.id,
        topic: m.topic,
        kind: m.kind,
        seq: m.seq,
        title: m.title,
        cached: true,
        source: 'reread' as const,
      }))
      .map(annotate);
    const seen = new Set(reread.map((s) => s.id));
    queue = [...reread, ...queue.filter((s) => !seen.has(s.id))];

    return c.json(buildFeed(language, state, queue, 0, DEFAULT_LIMIT));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[study]', message);
    return c.json({ error: message }, 500);
  }
});

// POST /api/study/lesson/:id/write — write ONE fix lesson, on an explicit
// click ("Write this lesson (1 AI call)"). The only path that generates a
// fix/mistake lesson: the prefetcher never does. Already written = returned
// as-is with no call. Anything that is not a fix/mistake slot the coach
// currently plans is 404: this is not a general "generate anything" endpoint.
studyRoutes.post('/study/lesson/:id/write', async (c) => {
  try {
    const id = c.req.param('id');
    const language = getActiveLanguage();

    const existing = getLesson(language, id);
    if (existing) {
      const payload: StudyWriteResponse = { lesson: existing };
      return c.json(payload);
    }

    const slot = coachFeed(buildCoachState(language)).find((s) => s.id === id);
    if (!slot || !isStubSource(slot)) {
      return c.json({ error: `no writable lesson ${id}` }, 404);
    }

    await ensureLesson(slot);
    const lesson = getLesson(language, id);
    if (!lesson) return c.json({ error: 'lesson generation failed, try again' }, 502);
    const payload: StudyWriteResponse = { lesson };
    return c.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[study]', message);
    return c.json({ error: message }, 500);
  }
});

// POST /api/study/read — { lessonId, fuzzy? }. Upsert into lesson_reads.
studyRoutes.post('/study/read', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      lessonId?: unknown;
      fuzzy?: unknown;
    };
    const lessonId = typeof body.lessonId === 'string' ? body.lessonId.trim() : '';
    if (!lessonId) return c.json({ error: 'lessonId is required' }, 400);

    markLessonRead(lessonId, body.fuzzy === true);
    const payload: StudyReadResponse = { ok: true };
    return c.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[study]', message);
    return c.json({ error: message }, 500);
  }
});

// GET /api/study/index — per-topic { total, read, mastery } for the jump grid.
studyRoutes.get('/study/index', (c) => {
  try {
    // Curriculum order, not TOPICS tuple order — the jump grid should show the
    // same path the feed will walk, so prerequisites read above their dependents
    // (e.g. bfs-dfs above graphs). Listing in tuple order was the old Library's
    // failing: it ignored the skill tree entirely.
    // One read of the setting for the whole handler — the grid and the skills
    // it orders by must not be able to describe two different languages.
    const language = getActiveLanguage();
    const state = buildStudyState(language);
    const reads = getLessonReadCounts();

    // Topic-keyed, exactly like Reflect — the jump grid and the skill tree must
    // never show two different numbers for the same topic.
    const clean = getCleanSolvesByTopic(language);

    const payload: StudyIndexResponse = {
      topics: topicOrder(state.skills).map((topic) => ({
        topic,
        total: trackSlotCount(state.outlines.get(topic)),
        read: reads.get(topic) ?? 0,
        mastery: masteryScore(clean.get(topic)),
      })),
    };
    return c.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[study]', message);
    return c.json({ error: message }, 500);
  }
});
