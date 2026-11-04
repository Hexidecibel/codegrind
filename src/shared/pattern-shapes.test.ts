import { describe, it, expect } from 'vitest';
import { PATTERN_IDS, PATTERN_SHAPES, WHICH_ONE, isPatternId, patternForTopic } from './pattern-shapes.js';
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
});
