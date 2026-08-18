// =============================================================================
// reflect-empty — the rule is "never tell somebody their work does not exist"
// =============================================================================
// Two of Reflect's six tiles are GLOBAL, computed in routes/reflect.ts from
// tables that carry no language: lessonsRead (the lesson corpus is shared) and
// streak (a habit metric — Python yesterday and Go today is two consecutive
// days of practice). Every other number on the page is per-language.
//
// So the first-run copy has one way to be wrong that matters more than looking
// plain: greeting somebody with "nothing here yet" when they spent last night in
// Study, or have a nine-day streak from another language. These tests are that
// rule, plus the "fresh" decision the whole page branches on.

import { describe, it, expect } from 'vitest';
import type { ReflectTiles } from '@/shared/types';
import { reflectEmptiness, earnedSentence } from './reflect-empty';

const ZERO: ReflectTiles = {
  solved: 0,
  topicsReached: 3,
  streak: 0,
  hintFreeRate: 0,
  tiersCleared: 0,
  lessonsRead: 0,
  reviewDue: 0,
};

/** A tree of `n` untouched topics — what a fresh install actually returns. */
const untouched = (n: number) => Array.from({ length: n }, () => ({ attempts: 0 }));

describe('deciding the page is fresh', () => {
  it('a brand-new install is fresh and blank', () => {
    const e = reflectEmptiness({ tiles: ZERO, tree: untouched(18) });
    expect(e.fresh).toBe(true);
    expect(e.blank).toBe(true);
    expect(e.earned).toEqual([]);
    // The roots of the tree are open before anything is solved, and the copy
    // quotes this number.
    expect(e.openTopics).toBe(3);
  });

  it('one attempt that never passed is still not fresh', () => {
    const tree = [...untouched(17), { attempts: 1 }];
    expect(reflectEmptiness({ tiles: ZERO, tree }).fresh).toBe(false);
  });

  it('a solve with no attempt rows left is not fresh either', () => {
    // Three independent witnesses on purpose: attempts can be pruned, solved
    // counts distinct problems, tiersCleared survives both.
    expect(reflectEmptiness({ tiles: { ...ZERO, solved: 1 }, tree: untouched(18) }).fresh).toBe(
      false,
    );
    expect(
      reflectEmptiness({ tiles: { ...ZERO, tiersCleared: 1 }, tree: untouched(18) }).fresh,
    ).toBe(false);
  });

  it('is fresh regardless of how long ago that was — it reads all-time counters', () => {
    // The activity heatmap only spans 84 days. Deriving "fresh" from it would
    // greet a returning user as a first-timer, so it is derived from the tree.
    const tree = [...untouched(17), { attempts: 40 }];
    expect(reflectEmptiness({ tiles: { ...ZERO, solved: 12 }, tree }).fresh).toBe(false);
  });
});

describe('never claiming zero over work that happened', () => {
  it('lessons read in Study count, even with nothing solved here', () => {
    const e = reflectEmptiness({ tiles: { ...ZERO, lessonsRead: 4 }, tree: untouched(18) });
    expect(e.fresh).toBe(true);
    expect(e.blank).toBe(false);
    expect(e.earned).toEqual(['4 lessons read in Study']);
  });

  it('a streak from another language counts', () => {
    const e = reflectEmptiness({ tiles: { ...ZERO, streak: 9 }, tree: untouched(18) });
    expect(e.blank).toBe(false);
    expect(e.earned).toEqual(['a 9-day streak']);
  });

  it('singulars are singular — "1 lesson", "a 1-day streak"', () => {
    const e = reflectEmptiness({
      tiles: { ...ZERO, lessonsRead: 1, streak: 1 },
      tree: untouched(18),
    });
    expect(e.earned).toEqual(['1 lesson read in Study', 'a 1-day streak']);
  });

  it('the per-language tiles never appear in `earned`', () => {
    // reviewDue and hintFreeRate are this language's own; listing them as
    // "already true, and global" would be the same lie in reverse.
    const e = reflectEmptiness({
      tiles: { ...ZERO, reviewDue: 5, hintFreeRate: 1 },
      tree: untouched(18),
    });
    expect(e.earned).toEqual([]);
    expect(e.blank).toBe(true);
  });
});

describe('the sentence built from it', () => {
  it('is null when there is genuinely nothing', () => {
    expect(earnedSentence(reflectEmptiness({ tiles: ZERO, tree: untouched(18) }))).toBeNull();
  });

  it('agrees with itself about number', () => {
    const one = earnedSentence(
      reflectEmptiness({ tiles: { ...ZERO, lessonsRead: 2 }, tree: untouched(18) }),
    )!;
    expect(one).toContain('2 lessons read in Study');
    expect(one).toContain('That one is global');
    expect(one).not.toContain('Those are');

    const two = earnedSentence(
      reflectEmptiness({ tiles: { ...ZERO, lessonsRead: 2, streak: 3 }, tree: untouched(18) }),
    )!;
    expect(two).toContain('2 lessons read in Study and a 3-day streak');
    expect(two).toContain('Those are global');
  });
});
