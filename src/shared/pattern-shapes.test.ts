import { describe, it, expect } from 'vitest';
import { PATTERN_IDS, PATTERN_SHAPES, WHICH_ONE, isPatternId, patternForTopic, practiceHref, practiceTopicOf } from './pattern-shapes.js';
import { TOPICS } from './types.js';

describe('pattern shapes', () => {
  it('has one card per id, in PATTERN_IDS order', () => {
    expect(PATTERN_SHAPES.map((p) => p.id)).toEqual([...PATTERN_IDS]);
  });

  it('has one "Which one?" row per pattern', () => {
    expect(WHICH_ONE.map((r) => r.pattern).sort()).toEqual([...PATTERN_IDS].sort());
  });

  it('only uses real topics', () => {
    for (const p of PATTERN_SHAPES) for (const t of p.topics) expect(TOPICS).toContain(t);
  });

  it('accepts the new ids', () => {
    for (const id of ['monotonic-stack', 'topo-sort', 'union-find', 'greedy', 'linked-list-reversal', 'bit-manipulation'])
      expect(isPatternId(id)).toBe(true);
  });

  it('a shared topic resolves to the older general card', () => {
    expect(patternForTopic('stack')?.id).toBe('stack');
    expect(patternForTopic('graphs')?.id).toBe('bfs');
    expect(patternForTopic('bfs-dfs')?.id).toBe('bfs');
    expect(patternForTopic('greedy')?.id).toBe('greedy');
    expect(patternForTopic('linked-list')?.id).toBe('linked-list-reversal');
    expect(patternForTopic('bit-manipulation')?.id).toBe('bit-manipulation');
  });

  it('every card has a real "Practice this" topic', () => {
    for (const p of PATTERN_SHAPES) expect(TOPICS).toContain(practiceTopicOf(p));
    expect(practiceTopicOf(PATTERN_SHAPES.find((p) => p.id === 'prefix-sum')!)).toBe('hashing');
    expect(practiceTopicOf(PATTERN_SHAPES.find((p) => p.id === 'fast-slow')!)).toBe('linked-list');
  });

  it('practiceTopic never moves a topic off its general card', () => {
    expect(patternForTopic('hashing')?.id).toBe('hash-map');
    expect(patternForTopic('linked-list')?.id).toBe('linked-list-reversal');
  });

  it('practiceHref carries the pattern id', () => {
    expect(practiceHref('stack', 'easy', 'monotonic-stack')).toBe('/manual?topic=stack&difficulty=easy&pattern=monotonic-stack');
    expect(practiceHref('stack', 'medium')).toBe('/manual?topic=stack&difficulty=medium');
  });
});
