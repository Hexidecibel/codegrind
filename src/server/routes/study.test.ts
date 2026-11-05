// =============================================================================
// study routes — the coach-ordered feed, stubs, and the ONE write path
// =============================================================================
// The rule under test is cost: a fix lesson is written only by an explicit
// POST /study/lesson/:id/write, never by serving the feed. The feed shows an
// unwritten fix as a stub instead of stalling on it.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Lesson, StudyFeedResponse } from '../../shared/types.js';
import type { CoachState } from '../services/coach.brain.js';

const NOW = Date.parse('2026-08-11T00:00:00.000Z');

const mocks = vi.hoisted(() => {
  const lessons = new Map<string, unknown>();
  return {
    lessons,
    state: { current: null as unknown },
    ensureLesson: vi.fn(),
    warmAhead: vi.fn(),
  };
});

vi.mock('../services/db.js', () => ({
  getLesson: vi.fn((_lang: string, id: string) => mocks.lessons.get(id) ?? null),
  markLessonRead: vi.fn(),
  getLessonReadCounts: vi.fn(() => new Map()),
  getCachedLessonMeta: vi.fn(() => []),
  getCleanSolvesByTopic: vi.fn(() => new Map()),
  getActiveLanguage: vi.fn(() => 'javascript'),
}));

vi.mock('../services/study.service.js', async () => {
  const order = await import('../services/study.order.js');
  return {
    ...order,
    buildStudyState: vi.fn(() => mocks.state.current),
    ensureLesson: mocks.ensureLesson,
    warmAhead: mocks.warmAhead,
    isSlotWarming: vi.fn(() => false),
    isSlotFailed: vi.fn(() => false),
  };
});

vi.mock('../services/coach.service.js', () => ({
  buildCoachState: vi.fn(() => mocks.state.current),
}));

const { studyRoutes } = await import('./study.js');

function lesson(id: string, over: Partial<Lesson> = {}): Lesson {
  return { id, topic: 'arrays', kind: 'concept', seq: 0, title: id, body: 'b', takeaway: 't', ...over };
}

function coachState(over: Partial<CoachState> = {}): CoachState {
  return {
    language: 'javascript',
    outlines: new Map(),
    cached: [{ id: 'arrays:0', topic: 'arrays', kind: 'concept', seq: 0, title: 'arrays 0' }],
    reads: [],
    skills: [{ topic: 'binary-search', attempts: 2, mastery: 0.3 }],
    slips: [
      { tag: 'search-boundary', topic: 'binary-search', at: new Date(NOW - 2 * 864e5).toISOString() },
      { tag: 'search-boundary', topic: 'binary-search', at: new Date(NOW - 864e5).toISOString() },
    ],
    tiers: new Map([['arrays', 'easy']]),
    reviews: [],
    now: NOW,
    ...over,
  };
}

beforeEach(() => {
  mocks.lessons.clear();
  mocks.lessons.set('arrays:0', lesson('arrays:0'));
  mocks.ensureLesson.mockReset();
  mocks.warmAhead.mockReset();
  mocks.state.current = coachState();
});

describe('GET /study/feed', () => {
  it('serves an unwritten fix as a stub ahead of the ladder, without generating it', async () => {
    const res = await studyRoutes.request('/study/feed?limit=3');
    const body = (await res.json()) as StudyFeedResponse;

    expect(body.items?.[0]).toMatchObject({
      lessonId: 'fix:search-boundary:binary-search',
      intent: 'fix',
      reason: 'Because you slipped on search boundaries',
      stub: { tag: 'search-boundary', topic: 'binary-search' },
      practice: { topic: 'binary-search', tag: 'search-boundary' },
    });
    // The stub does not stall the feed: the cached ladder lesson follows it.
    expect(body.lessons.map((l) => l.id)).toContain('arrays:0');
    expect(body.position.topic).toBe('arrays');
    expect(mocks.ensureLesson).not.toHaveBeenCalled();
  });

  it('skips ids the client already holds', async () => {
    const res = await studyRoutes.request('/study/feed?limit=3&seen=fix:search-boundary:binary-search');
    const body = (await res.json()) as StudyFeedResponse;
    expect(body.items?.some((i) => i.lessonId === 'fix:search-boundary:binary-search')).toBe(false);
  });

  it('?start= opens at a planned lesson (an unwritten fix stays a stub)', async () => {
    const res = await studyRoutes.request('/study/feed?limit=3&start=fix:search-boundary:binary-search');
    const body = (await res.json()) as StudyFeedResponse;
    expect(body.items?.[0]).toMatchObject({ lessonId: 'fix:search-boundary:binary-search', stub: { tag: 'search-boundary' } });
    expect(mocks.ensureLesson).not.toHaveBeenCalled();
  });

  it('?start= starts at a later planned lesson, skipping what is ahead of it', async () => {
    const res = await studyRoutes.request('/study/feed?limit=3&start=arrays:0');
    const body = (await res.json()) as StudyFeedResponse;
    expect(body.items?.[0]?.lessonId).toBe('arrays:0');
  });

  it('?start= with an unknown id falls back to the normal feed', async () => {
    const res = await studyRoutes.request('/study/feed?limit=3&start=nope:9');
    const body = (await res.json()) as StudyFeedResponse;
    expect(body.items?.[0]?.lessonId).toBe('fix:search-boundary:binary-search');
  });
});

describe('POST /study/lesson/:id/write', () => {
  const FIX = 'fix:search-boundary:binary-search';

  it('writes a planned fix lesson on request', async () => {
    mocks.ensureLesson.mockImplementation(async (slot: { id: string }) => {
      mocks.lessons.set(slot.id, lesson(slot.id, { kind: 'mistake' }));
    });
    const res = await studyRoutes.request(`/study/lesson/${encodeURIComponent(FIX)}/write`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(mocks.ensureLesson).toHaveBeenCalledTimes(1);
    expect(mocks.ensureLesson.mock.calls[0][0]).toMatchObject({ id: FIX, source: 'fix', tag: 'search-boundary' });
    expect(((await res.json()) as { lesson: Lesson }).lesson.id).toBe(FIX);
  });

  it('returns an already-written lesson with no call', async () => {
    mocks.lessons.set(FIX, lesson(FIX));
    const res = await studyRoutes.request(`/study/lesson/${encodeURIComponent(FIX)}/write`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(mocks.ensureLesson).not.toHaveBeenCalled();
  });

  it('refuses anything that is not a planned fix', async () => {
    const res = await studyRoutes.request('/study/lesson/hashing:0/write', { method: 'POST' });
    expect(res.status).toBe(404);
    const other = await studyRoutes.request('/study/lesson/fix:off-by-one:arrays/write', { method: 'POST' });
    expect(other.status).toBe(404);
    expect(mocks.ensureLesson).not.toHaveBeenCalled();
  });

  it('is a 502 when generation fails', async () => {
    mocks.ensureLesson.mockResolvedValue(undefined);
    const res = await studyRoutes.request(`/study/lesson/${encodeURIComponent(FIX)}/write`, { method: 'POST' });
    expect(res.status).toBe(502);
  });
});
