import { describe, it, expect } from 'vitest';
import { MISTAKE_TAGS, TOPICS } from './types.js';
import { TAG_INFO, fixTopic, tagInfo } from './mistake-tags.js';
import { mistakeLabel } from '../client/lib/format.js';
import { FOUNDATIONAL_START } from '../server/services/curriculum.js';

// The vocabulary only ever grows: stored attempts and cached `mistake:<tag>:n`
// lessons name these strings, so reordering or renaming one orphans real data.
const ORIGINAL_ELEVEN = [
  'off-by-one',
  'empty-input',
  'single-element',
  'duplicates',
  'negative-or-overflow',
  'wrong-data-structure',
  'brute-force-only',
  'complexity-misjudged',
  'runtime-error',
  'syntax-error',
  'edge-case-missed',
];

const SLIP_TAGS = [
  'misread-input-shape',
  'bounds-guard-order',
  'iteration-idiom',
  'pointer-update-order',
  'search-boundary',
  'visited-timing',
  'copy-vs-reference',
  'recursion-return',
];

describe('MISTAKE_TAGS — append-only vocabulary', () => {
  it('keeps the original eleven as an unchanged prefix', () => {
    expect(MISTAKE_TAGS.slice(0, ORIGINAL_ELEVEN.length)).toEqual(ORIGINAL_ELEVEN);
  });

  it('appends the slip-level tags at the end', () => {
    expect(MISTAKE_TAGS.slice(ORIGINAL_ELEVEN.length)).toEqual(SLIP_TAGS);
  });

  it('has no duplicates', () => {
    expect(new Set(MISTAKE_TAGS).size).toBe(MISTAKE_TAGS.length);
  });
});

describe('TAG_INFO', () => {
  it('describes every tag, and nothing else', () => {
    expect(Object.keys(TAG_INFO).sort()).toEqual([...MISTAKE_TAGS].sort());
  });

  it('gives every tag a label and a one-line hint', () => {
    for (const tag of MISTAKE_TAGS) {
      expect(TAG_INFO[tag].label.trim()).not.toBe('');
      expect(TAG_INFO[tag].hint.trim()).not.toBe('');
    }
  });

  it('only names real topics as home topics', () => {
    for (const tag of MISTAKE_TAGS) {
      for (const t of TAG_INFO[tag].homeTopics) {
        expect(TOPICS).toContain(t);
      }
    }
  });

  it('marks the new tags as slips and the old ones keep their meaning', () => {
    for (const tag of SLIP_TAGS) expect(TAG_INFO[tag as keyof typeof TAG_INFO].level).toBe('slip');
    expect(TAG_INFO['brute-force-only'].level).toBe('concept');
  });

  it('scopes iteration-idiom to the language, everything else to a topic', () => {
    expect(TAG_INFO['iteration-idiom'].scope).toBe('language');
    for (const tag of MISTAKE_TAGS) {
      if (tag !== 'iteration-idiom') expect(TAG_INFO[tag].scope).toBe('topic');
    }
  });

  it('maps the slip tags to their home topics', () => {
    expect(TAG_INFO['search-boundary'].homeTopics).toEqual(['binary-search']);
    expect(TAG_INFO['pointer-update-order'].homeTopics).toEqual(['linked-list']);
    expect(TAG_INFO['bounds-guard-order'].homeTopics).toEqual(['bfs-dfs', 'graphs']);
    expect(TAG_INFO['visited-timing'].homeTopics).toEqual(['bfs-dfs', 'graphs']);
    expect(TAG_INFO['copy-vs-reference'].homeTopics).toEqual(['backtracking']);
    expect(TAG_INFO['recursion-return'].homeTopics).toEqual([
      'trees',
      'backtracking',
      'dynamic-programming',
    ]);
    expect(TAG_INFO['misread-input-shape'].homeTopics).toEqual([]);
  });
});

describe('labels', () => {
  it('the client label for every tag is the TAG_INFO label', () => {
    for (const tag of MISTAKE_TAGS) expect(mistakeLabel(tag)).toBe(TAG_INFO[tag].label);
  });
});

describe('tagInfo', () => {
  it('returns null for a tag outside the vocabulary', () => {
    expect(tagInfo('indentation')).toBeNull();
    expect(tagInfo('search-boundary')?.label).toBe(TAG_INFO['search-boundary'].label);
  });
});

describe('fixTopic', () => {
  it('uses the attempt topic when there is one', () => {
    expect(fixTopic('search-boundary', 'two-pointer')).toBe('two-pointer');
  });

  it('falls back to the first home topic', () => {
    expect(fixTopic('search-boundary', undefined)).toBe('binary-search');
    expect(fixTopic('search-boundary', 'not-a-topic')).toBe('binary-search');
  });

  it('falls back to the foundational start when the tag has no home', () => {
    expect(fixTopic('misread-input-shape', undefined)).toBe('arrays');
    expect(fixTopic('made-up-tag', null)).toBe('arrays');
    expect(FOUNDATIONAL_START).toBe('arrays');
  });
});
