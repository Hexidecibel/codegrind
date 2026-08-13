import { Hono } from 'hono';
import {
  TOPICS,
  type Topic,
  type Lesson,
  type StudyFeedResponse,
  type StudyIndexResponse,
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
  studyQueue,
  topicOrder,
  trackSlotCount,
  warmAhead,
  isSlotWarming,
  isSlotFailed,
  type StudySlot,
  type StudyQueueState,
} from '../services/study.service.js';

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

/**
 * Serve the leading run of ALREADY-CACHED slots, stopping at the first hole we
 * intend to fill so curriculum order is preserved (the client renders a skeleton
 * for that hole). Holes whose generation recently failed are stepped over rather
 * than stalled on forever.
 */
function serveFrom(
  language: Language,
  queue: StudySlot[],
  start: number,
  limit: number
): { lessons: Lesson[]; served: StudySlot[]; nextIndex: number } {
  const lessons: Lesson[] = [];
  const served: StudySlot[] = [];
  let i = start;

  for (; i < queue.length; i++) {
    if (lessons.length >= limit) break;
    const slot = queue[i];
    if (!slot.cached) {
      if (isSlotFailed(slot)) continue; // don't stall on a dead slot
      break;
    }
    const lesson = getLesson(language, slot.id);
    if (!lesson) continue; // planner/cache raced — skip rather than 500
    lessons.push(lesson);
    served.push(slot);
  }

  return { lessons, served, nextIndex: i };
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
  queue: StudySlot[],
  start: number,
  limit: number
): StudyFeedResponse {
  const { lessons, served, nextIndex } = serveFrom(language, queue, start, limit);

  // Warm the holes ahead BEFORE reading `warming`, but never await any of it.
  warmAhead(language, queue.slice(Math.max(start, 0)));

  const next = queue[nextIndex];
  const warming = !!next && !next.cached && isSlotWarming(next);

  const anchor = served[0] ?? queue[start] ?? next;
  const missingOutlines = TOPICS.filter((t) => !state.outlines.has(t)).length;

  return {
    lessons,
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
    const limit = parseLimit(c.req.query('limit'));

    const language = getActiveLanguage();
    const state = buildStudyState(language);
    const queue = studyQueue(state);

    let start = 0;
    if (after) {
      const idx = queue.findIndex((s) => s.id === after);
      if (idx >= 0) start = idx + 1;
    }

    return c.json(buildFeed(language, state, queue, start, limit));
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
    const state = buildStudyState(language);
    let queue = studyQueue(state);

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
    const reread: StudySlot[] = getCachedLessonMeta()
      .filter((m) => m.topic === topic)
      .map((m) => ({
        id: m.id,
        topic: m.topic,
        kind: m.kind,
        seq: m.seq,
        title: m.title,
        cached: true,
        source: 'reread' as const,
      }));
    const seen = new Set(reread.map((s) => s.id));
    queue = [...reread, ...queue.filter((s) => !seen.has(s.id))];

    return c.json(buildFeed(language, state, queue, 0, DEFAULT_LIMIT));
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
