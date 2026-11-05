import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { TrackOutlineItem } from '../../shared/types.js';
import { FOUNDATIONAL_START } from './curriculum.js';
import { fixTopic } from '../../shared/mistake-tags.js';
import {
  coachPlan,
  coachFeed,
  grindGate,
  fixOffer,
  fixLessonId,
  fixTopics,
  toNudge,
  SLIP_WINDOW_DAYS,
  type CoachState,
  type CoachSlip,
} from './coach.brain.js';

const NOW = Date.parse('2026-08-11T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function outline(n: number): TrackOutlineItem[] {
  return Array.from({ length: n }, (_, i) => ({
    seq: i + 1,
    kind: 'concept' as const,
    title: `lesson ${i + 1}`,
    brief: 'covers something',
  }));
}

function state(over: Partial<CoachState> = {}): CoachState {
  return {
    language: 'javascript',
    outlines: new Map(),
    cached: [],
    reads: [],
    skills: [],
    slips: [],
    tiers: new Map(),
    reviews: [],
    now: NOW,
    ...over,
  };
}

function slip(tag: string, topic: string, daysAgo: number, extra: Partial<CoachSlip> = {}): CoachSlip {
  return { tag, topic, at: ago(daysAgo), ...extra };
}

/** A state where binary-search is unlocked and has had two boundary slips. */
function slippedState(over: Partial<CoachState> = {}): CoachState {
  return state({
    tiers: new Map([['arrays', 'easy']]),
    skills: [
      { topic: 'arrays', attempts: 5, mastery: 0.3 },
      { topic: 'binary-search', attempts: 2, mastery: 0.3 },
    ],
    outlines: new Map([['arrays', outline(3)]]),
    slips: [slip('search-boundary', 'binary-search', 2), slip('search-boundary', 'binary-search', 1)],
    ...over,
  });
}

describe('pure-layer contract', () => {
  it('never imports db.ts, directly or transitively', () => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/^import[^'"]*['"](\.[^'"]+)['"]/gm)) {
        walk(path.resolve(path.dirname(file), m[1].replace(/\.js$/, '.ts')));
      }
    };
    walk(path.resolve(__dirname, 'coach.brain.ts'));
    expect([...seen].some((f) => /services\/db\.ts$/.test(f))).toBe(false);
    expect(seen.size).toBeGreaterThan(3);
  });

  it('shares the foundational fallback with mistake-tags', () => {
    expect(fixTopic('misread-input-shape', null)).toBe(FOUNDATIONAL_START);
  });
});

describe('fixLessonId', () => {
  it('is per (tag, topic) for topic-scoped tags and per language for language-scoped', () => {
    expect(fixLessonId('search-boundary', 'binary-search', 'javascript')).toBe(
      'fix:search-boundary:binary-search'
    );
    expect(fixLessonId('iteration-idiom', 'arrays', 'python')).toBe('fix:iteration-idiom:python');
  });
});

describe('coachPlan — FIX', () => {
  it('puts a recent slip fix ahead of unread track lessons (the regression)', () => {
    const s = slippedState({
      cached: [{ id: 'arrays:0', topic: 'arrays', kind: 'concept', seq: 0, title: 'a' }],
    });
    const plan = coachPlan(s);
    expect(plan[0].intent).toBe('fix');
    expect(plan[0].tag).toBe('search-boundary');
    expect(plan[0].read?.lessonId).toBe('fix:search-boundary:binary-search');
    expect(plan[0].read?.cached).toBe(false);
    expect(plan[0].reason).toBe('Because you slipped on search boundaries');

    const feed = coachFeed(s);
    expect(feed[0].id).toBe('fix:search-boundary:binary-search');
    expect(feed[0].source).toBe('fix');
    expect(feed.findIndex((f) => f.id === 'arrays:0')).toBeGreaterThan(0);
  });

  it('ignores slips outside the window and tags outside the vocabulary', () => {
    const s = state({
      slips: [
        slip('search-boundary', 'binary-search', SLIP_WINDOW_DAYS + 1),
        slip('made-up', 'arrays', 1),
      ],
    });
    expect(coachPlan(s).some((p) => p.intent === 'fix' && p.tag)).toBe(false);
  });

  it('reuses a cached fix lesson rather than planning a new one', () => {
    const s = slippedState({
      cached: [
        { id: 'fix:search-boundary:binary-search', topic: 'binary-search', kind: 'mistake', seq: 1000, title: 'fix' },
      ],
    });
    const step = coachPlan(s)[0];
    expect(step.read).toMatchObject({ lessonId: 'fix:search-boundary:binary-search', cached: true });
  });

  it('lets a cached legacy mistake lesson stand in for the fix', () => {
    const s = slippedState({
      cached: [
        { id: 'mistake:search-boundary:2', topic: 'binary-search', kind: 'mistake', seq: 1002, title: 'old 2' },
        { id: 'mistake:search-boundary:1', topic: 'binary-search', kind: 'mistake', seq: 1001, title: 'old 1' },
      ],
    });
    expect(coachPlan(s)[0].read?.lessonId).toBe('mistake:search-boundary:1');
    expect(coachFeed(s)[0].source).toBe('mistake');
  });

  it('is satisfied by reading the fix (or a legacy lesson) after the latest slip', () => {
    const fixRead = slippedState({
      cached: [{ id: 'fix:search-boundary:binary-search', topic: 'binary-search', kind: 'mistake', seq: 1000, title: 'f' }],
      reads: [{ lessonId: 'fix:search-boundary:binary-search', readAt: ago(0.5), fuzzy: false }],
    });
    expect(coachPlan(fixRead).some((p) => p.tag === 'search-boundary')).toBe(false);

    const legacyRead = slippedState({
      cached: [{ id: 'mistake:search-boundary:1', topic: 'binary-search', kind: 'mistake', seq: 1001, title: 'o' }],
      reads: [{ lessonId: 'mistake:search-boundary:1', readAt: ago(0.5), fuzzy: false }],
    });
    expect(coachPlan(legacyRead).some((p) => p.tag === 'search-boundary')).toBe(false);
  });

  it('resurfaces the same fix lesson when the slip recurs after reading it', () => {
    const s = slippedState({
      slips: [slip('search-boundary', 'binary-search', 3), slip('search-boundary', 'binary-search', 0.1)],
      cached: [{ id: 'fix:search-boundary:binary-search', topic: 'binary-search', kind: 'mistake', seq: 1000, title: 'f' }],
      reads: [{ lessonId: 'fix:search-boundary:binary-search', readAt: ago(1), fuzzy: false }],
    });
    expect(coachPlan(s)[0].read?.lessonId).toBe('fix:search-boundary:binary-search');
  });

  it('groups a language-scoped tag across topics', () => {
    const s = state({
      slips: [slip('iteration-idiom', 'arrays', 2), slip('iteration-idiom', 'hashing', 1)],
    });
    const fixes = coachPlan(s).filter((p) => p.tag === 'iteration-idiom');
    expect(fixes).toHaveLength(1);
    expect(fixes[0].read?.lessonId).toBe('fix:iteration-idiom:javascript');
  });

  it('turns a failed or shaky topic into a struggling fix with its next unread lesson', () => {
    const s = state({
      skills: [{ topic: 'arrays', attempts: 3, mastery: 0.1 }],
      reads: [{ lessonId: 'arrays:0', readAt: ago(1), fuzzy: false }],
      outlines: new Map([['arrays', outline(2)]]),
    });
    const step = coachPlan(s).find((p) => p.intent === 'fix');
    expect(step?.read?.lessonId).toBe('arrays:1');
    expect(step?.reason).toMatch(/arrays is still shaky/);

    const failed = state({ skills: [{ topic: 'hashing', attempts: 4, mastery: 0.5, lastFailed: true }] });
    expect(coachPlan(failed).find((p) => p.intent === 'fix')?.reason).toMatch(/last hashing problem didn't pass/);
  });
});

describe('coachPlan — DUE, PRE-READ, PUSH', () => {
  it('surfaces due reviews and fuzzy re-reads', () => {
    const s = state({
      cached: [{ id: 'arrays:0', topic: 'arrays', kind: 'concept', seq: 0, title: 'a' }],
      reads: [{ lessonId: 'arrays:0', readAt: ago(1), fuzzy: true }],
      reviews: [{ problemId: 'p1', topic: 'arrays', difficulty: 'easy', dueAt: ago(1) }],
    });
    const due = coachPlan(s).filter((p) => p.intent === 'due');
    expect(due[0].then.reviewProblemId).toBe('p1');
    expect(due[0].reason).toBe('Due for a re-solve');
    expect(due[1].read?.lessonId).toBe('arrays:0');
    expect(due[1].reason).toBe('You marked this fuzzy');
  });

  it('pre-reads the next unlocked topic, never a locked one', () => {
    const cold = coachPlan(state());
    const pre = cold.find((p) => p.intent === 'pre-read');
    expect(pre?.topic).toBe('arrays');
    expect(pre?.read?.lessonId).toBe('arrays:0');
    expect(pre?.then).toEqual({ topic: 'arrays', difficulty: 'easy' });

    // binary-search is locked until arrays clears the easy tier.
    const locked = coachPlan(state(), { topic: 'binary-search' });
    expect(locked.some((p) => p.intent === 'pre-read')).toBe(false);
  });

  it('pushes only as the fallback', () => {
    expect(coachPlan(state()).some((p) => p.intent === 'push')).toBe(false);

    const allRead = state({
      reads: ['arrays', 'hashing', 'math', 'bit-manipulation'].map((t) => ({
        lessonId: `${t}:0`,
        readAt: ago(1),
        fuzzy: false,
      })),
      skills: ['arrays', 'hashing', 'math', 'bit-manipulation'].map((t) => ({
        topic: t as 'arrays',
        attempts: 3,
        mastery: 0.5,
      })),
      tiers: new Map([['arrays', 'easy']]),
    });
    const plan = coachPlan(allRead, { topic: 'arrays' });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ intent: 'push', topic: 'arrays', then: { difficulty: 'medium' } });
    expect(plan[0].reason).toBe('Keep climbing arrays');
  });

  it('gives every step a then, and is deterministic', () => {
    const s = slippedState({
      reviews: [{ problemId: 'p1', topic: 'arrays', difficulty: 'easy', dueAt: ago(1) }],
    });
    const a = coachPlan(s, { limit: 20 });
    for (const step of a) expect(step.then.topic).toBeTruthy();
    expect(coachPlan(s, { limit: 20 })).toEqual(a);
    expect(coachFeed(s)).toEqual(coachFeed(s));
  });

  it('respects the limit', () => {
    expect(coachPlan(slippedState(), { limit: 1 })).toHaveLength(1);
  });
});

describe('coachFeed', () => {
  it('lists each lesson once, fix first, then the ladder', () => {
    const s = slippedState();
    const feed = coachFeed(s);
    expect(new Set(feed.map((f) => f.id)).size).toBe(feed.length);
    const firstLadder = feed.findIndex((f) => f.intent === 'ladder');
    expect(feed.slice(0, firstLadder).every((f) => f.intent === 'fix' || f.intent === 'due' || f.intent === 'pre-read')).toBe(true);
    expect(feed.find((f) => f.id === 'arrays:1')?.reason).toBe('Up next in your ladder');
    expect(feed.every((f) => f.then.topic)).toBe(true);
  });
});

describe('grindGate', () => {
  it('asks for the primer before a topic is first attempted', () => {
    const gate = grindGate(state(), 'arrays');
    expect(gate).toMatchObject({ intent: 'pre-read', topic: 'arrays', read: { lessonId: 'arrays:0' } });
  });

  it('stays out of the way once read or attempted', () => {
    expect(grindGate(state({ reads: [{ lessonId: 'arrays:0', readAt: ago(1), fuzzy: false }] }), 'arrays')).toBeNull();
    expect(grindGate(state({ skills: [{ topic: 'arrays', attempts: 1, mastery: 0 }] }), 'arrays')).toBeNull();
  });
});

describe('fixOffer', () => {
  it('offers the fix on the second slip of a tag in the window', () => {
    const offer = fixOffer(slippedState(), ['search-boundary'], 'binary-search');
    expect(offer?.read?.lessonId).toBe('fix:search-boundary:binary-search');
  });

  it('does not offer on a first slip, an unrelated tag, or once read', () => {
    const one = slippedState({ slips: [slip('search-boundary', 'binary-search', 1)] });
    expect(fixOffer(one, ['search-boundary'], 'binary-search')).toBeNull();
    expect(fixOffer(slippedState(), ['off-by-one'], 'binary-search')).toBeNull();
    const read = slippedState({
      reads: [{ lessonId: 'fix:search-boundary:binary-search', readAt: ago(0.5), fuzzy: false }],
    });
    expect(fixOffer(read, ['search-boundary'], 'binary-search')).toBeNull();
  });
});

describe('grindGate — Phase 3', () => {
  it('fires only for a topic with no attempts whose skeleton lesson is unread', () => {
    // Other topics practised, this one untouched and unread: the gate fires.
    const other = state({ skills: [{ topic: 'hashing', attempts: 4, mastery: 0.6 }] });
    expect(grindGate(other, 'arrays')?.read?.lessonId).toBe('arrays:0');
    // Attempted (even once, even failed) → never gated, read or not.
    expect(grindGate(state({ skills: [{ topic: 'arrays', attempts: 1, mastery: 0 }] }), 'arrays')).toBeNull();
    // Skeleton read → no gate, even with zero attempts.
    const read = state({ reads: [{ lessonId: 'arrays:0', readAt: ago(30), fuzzy: false }] });
    expect(grindGate(read, 'arrays')).toBeNull();
    // Reading some OTHER lesson of the topic does not count as the skeleton.
    const otherLesson = state({
      outlines: new Map([['arrays', outline(2)]]),
      reads: [{ lessonId: 'arrays:1', readAt: ago(1), fuzzy: false }],
    });
    expect(grindGate(otherLesson, 'arrays')?.read?.lessonId).toBe('arrays:0');
  });
});

describe('fixOffer — Phase 3', () => {
  it('offers on 2 slips of the same tag', () => {
    const offer = fixOffer(slippedState(), ['search-boundary'], 'binary-search');
    expect(offer).toMatchObject({ intent: 'fix', tag: 'search-boundary', topic: 'binary-search' });
  });

  it('does not offer on 1 slip, or when the earlier slip fell outside the window', () => {
    const one = slippedState({ slips: [slip('search-boundary', 'binary-search', 0.1)] });
    expect(fixOffer(one, ['search-boundary'], 'binary-search')).toBeNull();
    const stale = slippedState({
      slips: [slip('search-boundary', 'binary-search', SLIP_WINDOW_DAYS + 1), slip('search-boundary', 'binary-search', 0.1)],
    });
    expect(fixOffer(stale, ['search-boundary'], 'binary-search')).toBeNull();
  });

  it('a read AFTER the latest slip suppresses it; a read before it does not', () => {
    const after = slippedState({
      reads: [{ lessonId: 'fix:search-boundary:binary-search', readAt: ago(0.5), fuzzy: false }],
    });
    expect(fixOffer(after, ['search-boundary'], 'binary-search')).toBeNull();
    const before = slippedState({
      reads: [{ lessonId: 'fix:search-boundary:binary-search', readAt: ago(3), fuzzy: false }],
    });
    expect(fixOffer(before, ['search-boundary'], 'binary-search')).not.toBeNull();
  });
});

describe('fixTopics + toNudge', () => {
  it('lists the topics of current FIX steps once each', () => {
    const topics = fixTopics(slippedState());
    expect(topics).toContain('binary-search');
    expect(new Set(topics).size).toBe(topics.length);
    expect(fixTopics(state())).toEqual([]);
  });

  it('flattens a step into the wire shape', () => {
    const n = toNudge(fixOffer(slippedState(), ['search-boundary'], 'binary-search')!);
    expect(n).toMatchObject({
      intent: 'fix',
      topic: 'binary-search',
      tag: 'search-boundary',
      lessonId: 'fix:search-boundary:binary-search',
      cached: false,
      practice: { topic: 'binary-search', tag: 'search-boundary' },
    });
    const gate = toNudge(grindGate(state(), 'arrays')!);
    expect(gate).toMatchObject({ intent: 'pre-read', lessonId: 'arrays:0', practice: { topic: 'arrays' } });
    expect(gate && 'tag' in gate).toBe(false);
  });
});
