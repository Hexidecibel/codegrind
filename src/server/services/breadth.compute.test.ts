import { describe, it, expect } from 'vitest';
import { pickBreadth, recognizeStockTopic, type BreadthTopic } from './breadth.compute.js';
import { TOPICS } from '../../shared/types.js';

const topics = (over: Partial<Record<string, Partial<BreadthTopic>>> = {}): BreadthTopic[] =>
  TOPICS.map((t) => ({ topic: t, attempts: 0, cleanSolves: 0, ...over[t] }));

describe('pickBreadth (Phase H2 breadth floor)', () => {
  it('picks the least-seen topic, curriculum order breaking ties, at easy', () => {
    const p = pickBreadth(
      topics({ arrays: { attempts: 26 }, hashing: { attempts: 3 }, 'two-pointer': { attempts: 30 }, 'sliding-window': { attempts: 7 }, 'binary-search': { attempts: 24 } })
    )!;
    expect(p.topic).toBe('stack'); // first never-practised topic
    expect(p.difficulty).toBe('easy');
    expect(p.rationale).toMatch(/never practised/);
  });
  it('steps up to medium once the topic has one clean solve', () => {
    const all = topics(Object.fromEntries(TOPICS.map((t) => [t, { attempts: 10 }])));
    all.find((t) => t.topic === 'heap')!.attempts = 2;
    all.find((t) => t.topic === 'heap')!.cleanSolves = 1;
    const p = pickBreadth(all)!;
    expect(p).toMatchObject({ topic: 'heap', difficulty: 'medium' });
  });
  it("avoids Problem 1's topic when anything else is available", () => {
    const all = topics(Object.fromEntries(TOPICS.map((t) => [t, { attempts: 5 }])));
    all.find((t) => t.topic === 'trie')!.attempts = 0;
    expect(pickBreadth(all, 'trie')!.topic).toBe('arrays');
    expect(pickBreadth([{ topic: 'trie', attempts: 0, cleanSolves: 0 }], 'trie')!.topic).toBe('trie');
    expect(pickBreadth([])).toBeNull();
  });
});

describe('recognizeStockTopic', () => {
  it('names the first topic with no bank problem, or null when all are covered', () => {
    expect(recognizeStockTopic(new Map([['arrays', 3], ['hashing', 1]]))).toBe('two-pointer');
    expect(recognizeStockTopic(new Map(TOPICS.map((t) => [t, 1])))).toBeNull();
  });
});
