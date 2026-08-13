import { describe, it, expect } from 'vitest';
import { TOPICS, type Topic, type Primer, type TrackOutlineItem } from '../../shared/types.js';
import { PREREQS, ROOT_TOPICS } from './curriculum.js';
import {
  studyQueue,
  topicOrder,
  planTrackSlots,
  trackSlotCount,
  primerToLesson,
  type StudyQueueState,
  type StudySkill,
} from './study.order.js';

const NOW = Date.parse('2026-08-11T00:00:00.000Z');

/** A track outline of `n` lessons for a topic (seq 1..n; seq 0 is primer-derived). */
function outline(n: number): TrackOutlineItem[] {
  return Array.from({ length: n }, (_, i) => ({
    seq: i + 1,
    kind: 'concept' as const,
    title: `lesson ${i + 1}`,
    brief: 'covers something',
  }));
}

function state(over: Partial<StudyQueueState> = {}): StudyQueueState {
  return {
    outlines: new Map(),
    cached: [],
    reads: [],
    skills: [],
    now: NOW,
    ...over,
  };
}

/** Position of a topic's first slot in the queue. */
function topicIndex(queue: ReturnType<typeof studyQueue>, topic: Topic): number {
  return queue.findIndex((s) => s.topic === topic);
}

describe('topicOrder — the curriculum spine', () => {
  it('puts every root topic before any dependent topic', () => {
    const order = topicOrder([]);
    const lastRoot = Math.max(...ROOT_TOPICS.map((t) => order.indexOf(t)));
    const firstDependent = Math.min(
      ...TOPICS.filter((t) => PREREQS[t].length > 0).map((t) => order.indexOf(t))
    );
    expect(lastRoot).toBeLessThan(firstDependent);
  });

  it('starts at the foundational topic', () => {
    expect(topicOrder([])[0]).toBe('arrays');
  });

  it('covers every topic exactly once', () => {
    const order = topicOrder([]);
    expect(order).toHaveLength(TOPICS.length);
    expect(new Set(order).size).toBe(TOPICS.length);
  });

  it('places every prerequisite before the topic that needs it', () => {
    const order = topicOrder([]);
    for (const topic of TOPICS) {
      for (const prereq of PREREQS[topic]) {
        expect(order.indexOf(prereq)).toBeLessThan(order.indexOf(topic));
      }
    }
  });

  it('still respects prerequisites when a deep topic is pulled forward', () => {
    const skills: StudySkill[] = [{ topic: 'dynamic-programming', attempts: 4, mastery: 0.1 }];
    const order = topicOrder(skills);
    for (const topic of TOPICS) {
      for (const prereq of PREREQS[topic]) {
        expect(order.indexOf(prereq)).toBeLessThan(order.indexOf(topic));
      }
    }
  });

  it('pulls a weak, attempted topic forward (with its prerequisite chain)', () => {
    const neutral = topicOrder([]);
    const weak = topicOrder([{ topic: 'dynamic-programming', attempts: 4, mastery: 0.1 }]);
    expect(weak.indexOf('dynamic-programming')).toBeLessThan(
      neutral.indexOf('dynamic-programming')
    );
    // The chain that unlocks it comes along for the ride.
    for (const t of ['linked-list', 'trees', 'backtracking'] as Topic[]) {
      expect(weak.indexOf(t)).toBeLessThan(neutral.indexOf(t));
    }
  });

  it('does not pull forward a weak topic that has never been attempted', () => {
    const neutral = topicOrder([]);
    const untried = topicOrder([{ topic: 'dynamic-programming', attempts: 0, mastery: 0 }]);
    expect(untried.indexOf('dynamic-programming')).toBe(
      neutral.indexOf('dynamic-programming')
    );
  });
});

describe('trackSlotCount — the denominator behind "lesson N of M"', () => {
  it('counts the primer-derived slot alone before the outline exists', () => {
    expect(trackSlotCount(undefined)).toBe(1);
    expect(trackSlotCount([])).toBe(1);
  });

  it('is the outline length plus the primer slot', () => {
    expect(trackSlotCount(outline(1))).toBe(2);
    expect(trackSlotCount(outline(6))).toBe(7);
  });

  it('matches the number of slots actually planned for the track', () => {
    // The total shown on every card must be the same number the feed plans, or
    // the reader sees "lesson 7 of 6".
    for (const n of [0, 1, 3, 6]) {
      const items = outline(n);
      expect(trackSlotCount(items)).toBe(planTrackSlots('arrays', items, new Set()).length);
    }
    expect(trackSlotCount(undefined)).toBe(
      planTrackSlots('arrays', undefined, new Set()).length
    );
  });
});

describe('planTrackSlots — one topic track, seq 0 first', () => {
  it('plans the primer-derived slot even with no outline', () => {
    const slots = planTrackSlots('arrays', undefined, new Set());
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      id: 'arrays:0',
      topic: 'arrays',
      seq: 0,
      kind: 'concept',
      source: 'track',
      cached: false,
    });
  });

  it('carries each outline item through as its own slot', () => {
    const slots = planTrackSlots('hashing', outline(3), new Set());
    expect(slots.map((s) => s.id)).toEqual([
      'hashing:0',
      'hashing:1',
      'hashing:2',
      'hashing:3',
    ]);
    expect(slots[1]).toMatchObject({
      seq: 1,
      title: 'lesson 1',
      brief: 'covers something',
      source: 'track',
    });
    expect(slots.every((s) => s.topic === 'hashing')).toBe(true);
  });

  it('flags exactly the ids that are cached', () => {
    const slots = planTrackSlots('arrays', outline(2), new Set(['arrays:0', 'arrays:2']));
    expect(slots.map((s) => s.cached)).toEqual([true, false, true]);
  });

  it('orders by seq even when the outline is out of order', () => {
    const scrambled: TrackOutlineItem[] = [
      { seq: 3, kind: 'concept', title: 'c', brief: '' },
      { seq: 1, kind: 'pitfall', title: 'a', brief: '' },
      { seq: 2, kind: 'template', title: 'b', brief: '' },
    ];
    const slots = planTrackSlots('arrays', scrambled, new Set());
    expect(slots.map((s) => s.seq)).toEqual([0, 1, 2, 3]);
    expect(slots.map((s) => s.kind)).toEqual(['concept', 'pitfall', 'template', 'concept']);
  });

  it('drops outline items at seq < 1 so the primer slot is never duplicated', () => {
    const withZero: TrackOutlineItem[] = [
      { seq: 0, kind: 'template', title: 'a stray seq 0', brief: '' },
      { seq: 1, kind: 'concept', title: 'real first lesson', brief: '' },
    ];
    const slots = planTrackSlots('arrays', withZero, new Set());
    expect(slots.map((s) => s.id)).toEqual(['arrays:0', 'arrays:1']);
    expect(slots.filter((s) => s.seq === 0)).toHaveLength(1);
    // seq 0 stays the primer-derived slot, not the outline's version of it.
    expect(slots[0].title).toBe('arrays — recognize and apply');
    expect(slots[0].kind).toBe('concept');
  });
});

describe('studyQueue — the reading order', () => {
  it('orders a topic track by seq, starting at the primer-derived lesson 0', () => {
    const queue = studyQueue(state({ outlines: new Map([['arrays', outline(3)]]) }));
    const arrays = queue.filter((s) => s.topic === 'arrays');
    expect(arrays.map((s) => s.id)).toEqual([
      'arrays:0',
      'arrays:1',
      'arrays:2',
      'arrays:3',
    ]);
  });

  it('plans lesson 0 for every topic even before its outline exists', () => {
    const queue = studyQueue(state());
    expect(queue).toHaveLength(TOPICS.length);
    expect(queue.every((s) => s.seq === 0)).toBe(true);
  });

  it('skips lessons that have already been read', () => {
    const queue = studyQueue(
      state({
        outlines: new Map([['arrays', outline(3)]]),
        cached: [
          { id: 'arrays:0', topic: 'arrays', kind: 'concept', seq: 0, title: 'a' },
          { id: 'arrays:1', topic: 'arrays', kind: 'concept', seq: 1, title: 'b' },
          { id: 'arrays:2', topic: 'arrays', kind: 'concept', seq: 2, title: 'c' },
        ],
        reads: [
          { lessonId: 'arrays:0', readAt: '2026-08-10T00:00:00.000Z', fuzzy: false },
          { lessonId: 'arrays:1', readAt: '2026-08-10T00:00:00.000Z', fuzzy: false },
        ],
      })
    );
    const ids = queue.map((s) => s.id);
    expect(ids).not.toContain('arrays:0');
    expect(ids).not.toContain('arrays:1');
    expect(ids).toContain('arrays:2');
    // Recently read and not marked fuzzy — no re-read slot yet.
    expect(queue.filter((s) => s.source === 'reread')).toHaveLength(0);
  });

  it('marks slots cached only when a lesson body exists', () => {
    const queue = studyQueue(
      state({
        outlines: new Map([['arrays', outline(2)]]),
        cached: [{ id: 'arrays:0', topic: 'arrays', kind: 'concept', seq: 0, title: 'a' }],
      })
    );
    const byId = new Map(queue.map((s) => [s.id, s]));
    expect(byId.get('arrays:0')?.cached).toBe(true);
    expect(byId.get('arrays:1')?.cached).toBe(false);
  });

  it('pulls a weak attempted topic ahead of the untouched ones', () => {
    const outlines = new Map<Topic, TrackOutlineItem[]>([
      ['arrays', outline(2)],
      ['trees', outline(2)],
    ]);
    const neutral = studyQueue(state({ outlines }));
    const weak = studyQueue(
      state({ outlines, skills: [{ topic: 'trees', attempts: 3, mastery: 0.2 }] })
    );
    expect(topicIndex(weak, 'trees')).toBeLessThan(topicIndex(neutral, 'trees'));
    // ...but never ahead of what it is built on.
    expect(topicIndex(weak, 'linked-list')).toBeLessThan(topicIndex(weak, 'trees'));
    expect(topicIndex(weak, 'arrays')).toBeLessThan(topicIndex(weak, 'trees'));
  });

  it('appends the personalized phase after the tracks', () => {
    const queue = studyQueue(
      state({
        mistakes: [{ tag: 'off-by-one', count: 4, topic: 'binary-search' }],
        walkthroughs: [{ problemId: 'p1', title: 'Two Sum', topic: 'hashing' }],
      })
    );
    const mistake = queue.findIndex((s) => s.source === 'mistake');
    const walkthrough = queue.findIndex((s) => s.source === 'walkthrough');
    const lastTrack = queue.map((s) => s.source).lastIndexOf('track');
    expect(mistake).toBeGreaterThan(lastTrack);
    expect(walkthrough).toBeGreaterThan(mistake);
    expect(queue[mistake].id).toBe('mistake:off-by-one:1');
  });

  it('advances the mistake counter so the generator never runs dry', () => {
    const queue = studyQueue(
      state({
        mistakes: [{ tag: 'off-by-one', count: 4, topic: 'binary-search' }],
        reads: [
          { lessonId: 'mistake:off-by-one:1', readAt: '2026-08-10T00:00:00.000Z', fuzzy: false },
          { lessonId: 'mistake:off-by-one:2', readAt: '2026-08-10T00:00:00.000Z', fuzzy: false },
        ],
      })
    );
    expect(queue.find((s) => s.source === 'mistake')?.id).toBe('mistake:off-by-one:3');
  });

  it('ignores mistake tags outside the closed vocabulary', () => {
    const queue = studyQueue(
      state({ mistakes: [{ tag: 'vibes-were-off', count: 9, topic: 'arrays' }] })
    );
    expect(queue.some((s) => s.source === 'mistake')).toBe(false);
  });

  it('resurfaces fuzzy and stale reads at the tail', () => {
    const cached = [
      { id: 'arrays:0', topic: 'arrays' as Topic, kind: 'concept' as const, seq: 0, title: 'a' },
      { id: 'hashing:0', topic: 'hashing' as Topic, kind: 'concept' as const, seq: 0, title: 'h' },
    ];
    const queue = studyQueue(
      state({
        cached,
        reads: [
          // Marked "didn't stick" — comes back regardless of age.
          { lessonId: 'arrays:0', readAt: '2026-08-10T00:00:00.000Z', fuzzy: true },
          // Read months ago — comes back on staleness.
          { lessonId: 'hashing:0', readAt: '2026-01-01T00:00:00.000Z', fuzzy: false },
        ],
      })
    );
    const rereads = queue.filter((s) => s.source === 'reread');
    expect(rereads.map((s) => s.id)).toEqual(['arrays:0', 'hashing:0']);
    expect(rereads.every((s) => s.cached)).toBe(true);
  });
});

describe('primerToLesson — seq 0 derived from the cached primer, no API call', () => {
  const primer: Primer = {
    pattern: 'binary-search',
    recognitionCues: ['sorted input', 'find the boundary', 'O(log n) is expected'],
    template: 'function search(arr, target) {\n  let lo = 0, hi = arr.length - 1;\n}',
    pitfalls: ['mid overflow', 'wrong loop invariant'],
    example: { title: 'First Bad Version', insight: 'Shrink to the smallest true index.' },
  };

  it('produces a well-formed lesson 0', () => {
    const lesson = primerToLesson(primer);
    expect(lesson.id).toBe('binary-search:0');
    expect(lesson.topic).toBe('binary-search');
    expect(lesson.seq).toBe(0);
    expect(lesson.kind).toBe('concept');
    expect(lesson.title).toContain('binary-search');
  });

  it('renders every primer section into the markdown body', () => {
    const { body } = primerToLesson(primer);
    expect(body).toContain('## When to reach for it');
    expect(body).toContain('- sorted input');
    expect(body).toContain('## The shape');
    expect(body).toContain('## Where it goes wrong');
    expect(body).toContain('- mid overflow');
    expect(body).toContain('## Canonical example');
    expect(body).toContain('First Bad Version');
    // The snippet lives in `code`, never inline in the body.
    expect(body).not.toContain('```');
  });

  it('carries the template through as the code block and the insight as the takeaway', () => {
    const lesson = primerToLesson(primer);
    expect(lesson.code).toBe(primer.template);
    expect(lesson.takeaway).toBe('Shrink to the smallest true index.');
  });

  it('survives an empty primer without emitting empty sections', () => {
    const lesson = primerToLesson({
      pattern: 'greedy',
      recognitionCues: [],
      template: '',
      pitfalls: [],
      example: { title: '', insight: '' },
    });
    expect(lesson.code).toBeUndefined();
    expect(lesson.body).not.toContain('## When to reach for it');
    expect(lesson.body).not.toContain('## The shape');
    expect(lesson.takeaway).toBeTruthy();
  });
});
