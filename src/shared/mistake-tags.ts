// =============================================================================
// mistake-tags — what each MISTAKE_TAGS entry means, and where it is fixed
// =============================================================================
// PURE, shared by client and server. The vocabulary itself lives in
// ./types.ts (MISTAKE_TAGS, append-only); this module only describes it:
//
//   label      — display text ("search boundaries")
//   hint       — the one-line definition the coaching prompt is given, so the
//                model can tell a slip apart from a concept gap
//   level      — 'slip' = a mechanical bug in an otherwise right approach;
//                'concept' = the approach or understanding was the problem
//   homeTopics — where a fix lesson for this tag belongs when the attempt that
//                carried it has no usable topic (first entry wins)
//   scope      — 'topic': one fix lesson per (tag, topic);
//                'language': one per (tag, language), e.g. for...in vs for...of
//                is the same slip in every topic

import { TOPICS, type MistakeTag, type Topic } from './types.js';

export type TagLevel = 'slip' | 'concept';
export type TagScope = 'topic' | 'language';

export interface TagInfo {
  label: string;
  hint: string;
  level: TagLevel;
  homeTopics: Topic[];
  scope: TagScope;
}

/**
 * The fallback topic when nothing better is known. Mirrors
 * curriculum.FOUNDATIONAL_START (asserted equal in coach.brain.test.ts); it is
 * restated here because shared/ must not import server code.
 */
const FALLBACK_TOPIC: Topic = 'arrays';

export const TAG_INFO: Record<MistakeTag, TagInfo> = {
  'off-by-one': {
    label: 'Off-by-one',
    hint: 'a loop bound or index is one too far or one short',
    level: 'slip',
    homeTopics: ['arrays'],
    scope: 'topic',
  },
  'empty-input': {
    label: 'Empty input',
    hint: 'breaks or returns the wrong thing on an empty input',
    level: 'slip',
    homeTopics: ['arrays'],
    scope: 'topic',
  },
  'single-element': {
    label: 'Single element',
    hint: 'breaks on a one-element input',
    level: 'slip',
    homeTopics: ['arrays'],
    scope: 'topic',
  },
  duplicates: {
    label: 'Duplicates',
    hint: 'mishandles repeated values',
    level: 'slip',
    homeTopics: ['hashing'],
    scope: 'topic',
  },
  'negative-or-overflow': {
    label: 'Negative / overflow',
    hint: 'negative numbers, zero, or overflow are not handled',
    level: 'slip',
    homeTopics: ['math'],
    scope: 'topic',
  },
  'wrong-data-structure': {
    label: 'Wrong data structure',
    hint: 'the chosen structure cannot do the job efficiently or at all',
    level: 'concept',
    homeTopics: ['hashing'],
    scope: 'topic',
  },
  'brute-force-only': {
    label: 'Brute force only',
    hint: 'correct but brute force; the intended pattern was not used',
    level: 'concept',
    homeTopics: [],
    scope: 'topic',
  },
  'complexity-misjudged': {
    label: 'Complexity misjudged',
    hint: 'the time or space complexity was misjudged',
    level: 'concept',
    homeTopics: [],
    scope: 'topic',
  },
  'runtime-error': {
    label: 'Runtime error',
    hint: 'the code throws at runtime (null or missing property access, bad call)',
    level: 'slip',
    homeTopics: [],
    scope: 'topic',
  },
  'syntax-error': {
    label: 'Syntax error',
    hint: 'the code does not parse or compile',
    level: 'slip',
    homeTopics: [],
    scope: 'topic',
  },
  'edge-case-missed': {
    label: 'Edge case missed',
    hint: 'some other edge case was missed (use a more specific tag when one fits)',
    level: 'slip',
    homeTopics: [],
    scope: 'topic',
  },
  // --- slip-level tags -------------------------------------------------------
  'misread-input-shape': {
    label: 'Input shape misread',
    hint: 'misread the input or output shape (e.g. indices vs values, sorted assumed, 1-based vs 0-based, matrix vs list)',
    level: 'slip',
    homeTopics: [],
    scope: 'topic',
  },
  'bounds-guard-order': {
    label: 'Grid bounds order',
    hint: 'indexed a grid or array BEFORE checking the bounds (guard must come first)',
    level: 'slip',
    homeTopics: ['bfs-dfs', 'graphs'],
    scope: 'topic',
  },
  'iteration-idiom': {
    label: 'Iteration idiom',
    hint: 'used the wrong loop idiom for the language (e.g. JS for...in over an array instead of for...of, Python range off by one)',
    level: 'slip',
    homeTopics: [],
    scope: 'language',
  },
  'pointer-update-order': {
    label: 'Pointer update order',
    hint: 'updated pointers in the wrong order and lost a reference (e.g. overwrote next before saving it)',
    level: 'slip',
    homeTopics: ['linked-list'],
    scope: 'topic',
  },
  'search-boundary': {
    label: 'Search boundaries',
    hint: 'binary-search boundary mistake: lo/hi update direction, < vs <=, or returning the wrong side',
    level: 'slip',
    homeTopics: ['binary-search'],
    scope: 'topic',
  },
  'visited-timing': {
    label: 'Visited timing',
    hint: 'marked nodes visited at the wrong time (on pop instead of on push), causing duplicates or loops',
    level: 'slip',
    homeTopics: ['bfs-dfs', 'graphs'],
    scope: 'topic',
  },
  'copy-vs-reference': {
    label: 'Copy vs reference',
    hint: 'pushed a reference to a mutable array/object instead of a copy, so later changes corrupted the result',
    level: 'slip',
    homeTopics: ['backtracking'],
    scope: 'topic',
  },
  'recursion-return': {
    label: 'Recursion return',
    hint: 'dropped or mis-combined a recursive call\'s return value (forgot to return it, or ignored it)',
    level: 'slip',
    homeTopics: ['trees', 'backtracking', 'dynamic-programming'],
    scope: 'topic',
  },
};

const TOPIC_SET: ReadonlySet<string> = new Set<string>(TOPICS);

/** TAG_INFO for a tag, or null when the string is outside the vocabulary. */
export function tagInfo(tag: string): TagInfo | null {
  return Object.prototype.hasOwnProperty.call(TAG_INFO, tag)
    ? TAG_INFO[tag as MistakeTag]
    : null;
}

/**
 * The topic a fix lesson for `tag` belongs to: the attempt's own topic when it
 * is a real one, else the tag's first home topic, else the foundational start.
 */
export function fixTopic(tag: string, attemptTopic: string | null | undefined): Topic {
  if (attemptTopic && TOPIC_SET.has(attemptTopic)) return attemptTopic as Topic;
  return tagInfo(tag)?.homeTopics[0] ?? FALLBACK_TOPIC;
}
