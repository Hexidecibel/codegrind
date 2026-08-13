// =============================================================================
// curriculum.test — the tier ladder
// =============================================================================
// PURE: this file's import graph is `curriculum.ts -> shared/types.ts` and
// nothing else. It must never reach `db.js`, which opens SQLite at module scope
// (see the header of study.order.ts). That is what lets the suite run on the
// default node with no native-module ABI to match.

import { describe, it, expect } from 'vitest';
import { DIFFICULTIES, TIER_LEVELS, type Difficulty } from '../../shared/types.js';
import {
  DIFF_ORDER,
  TIER_REQUIREMENT,
  UNLOCK_TIER,
  WEAK_SCORE,
  countCleanSolves,
  easierDifficulty,
  emptyCleanSolves,
  levelAtLeast,
  levelIndex,
  masteryScore,
  nextDifficulty,
  nextTier,
  tierLabel,
  tierLevel,
  tierProgress,
  workingDifficulty,
  type AttemptCredit,
} from './curriculum.js';

/** A clean (solved, hint-free) attempt on `problemId`. */
function clean(problemId: string, difficulty: Difficulty): AttemptCredit {
  return { problemId, difficulty, solved: true, hintsUsed: 0 };
}

/** `n` clean attempts on `n` DIFFERENT problems at one difficulty. */
function distinct(n: number, difficulty: Difficulty, prefix = 'p'): AttemptCredit[] {
  return Array.from({ length: n }, (_, i) => clean(`${prefix}-${difficulty}-${i}`, difficulty));
}

/** Shorthand for a count map. */
function counts(over: Partial<Record<Difficulty, number>>): Record<Difficulty, number> {
  return { ...emptyCleanSolves(), ...over };
}

// -----------------------------------------------------------------------------
describe('the ladder itself', () => {
  it('runs none -> easy -> medium -> hard -> expert, with expert on top', () => {
    expect([...TIER_LEVELS]).toEqual(['none', 'easy', 'medium', 'hard', 'expert']);
    expect([...DIFFICULTIES]).toEqual(['easy', 'medium', 'hard', 'expert']);
    expect(DIFF_ORDER).toEqual(DIFFICULTIES);
    expect(UNLOCK_TIER).toBe('easy');
  });

  it('steps up and down, saturating at both ends', () => {
    expect(nextDifficulty('easy')).toBe('medium');
    expect(nextDifficulty('hard')).toBe('expert');
    expect(nextDifficulty('expert')).toBe('expert'); // nowhere higher to go
    expect(easierDifficulty('expert')).toBe('hard');
    expect(easierDifficulty('medium')).toBe('easy');
    expect(easierDifficulty('easy')).toBe('easy'); // warm-ups floor at easy
  });
});

// -----------------------------------------------------------------------------
describe('countCleanSolves — one credit per DISTINCT problem', () => {
  it('gives three distinct clean solves three credits', () => {
    expect(countCleanSolves(distinct(3, 'easy')).easy).toBe(3);
  });

  it('THE EXPLOIT: the same problem solved cleanly five times counts once', () => {
    const spam = Array.from({ length: 5 }, () => clean('same-problem', 'easy'));
    expect(countCleanSolves(spam)).toEqual(counts({ easy: 1 }));
    // ...and one credit is nowhere near a tier, which is the point.
    expect(tierLevel(countCleanSolves(spam))).toBe('none');
  });

  it('earns nothing for a solve that used a hint', () => {
    const hinted: AttemptCredit[] = [
      { problemId: 'a', difficulty: 'easy', solved: true, hintsUsed: 1 },
      { problemId: 'b', difficulty: 'easy', solved: true, hintsUsed: 3 },
    ];
    expect(countCleanSolves(hinted)).toEqual(emptyCleanSolves());
  });

  it('earns nothing for a failed attempt', () => {
    expect(
      countCleanSolves([{ problemId: 'a', difficulty: 'easy', solved: false, hintsUsed: 0 }])
    ).toEqual(emptyCleanSolves());
  });

  it('does not let a hinted solve burn the credit for a later clean one', () => {
    expect(
      countCleanSolves([
        { problemId: 'a', difficulty: 'medium', solved: true, hintsUsed: 2 },
        { problemId: 'a', difficulty: 'medium', solved: false, hintsUsed: 0 },
        clean('a', 'medium'), // finally solved it cold
      ])
    ).toEqual(counts({ medium: 1 }));
  });

  it('keeps difficulties in separate buckets and ignores unknown ones', () => {
    expect(
      countCleanSolves([
        ...distinct(2, 'easy'),
        ...distinct(1, 'expert'),
        { problemId: 'legacy', difficulty: 'insane', solved: true, hintsUsed: 0 },
      ])
    ).toEqual(counts({ easy: 2, expert: 1 }));
  });
});

// -----------------------------------------------------------------------------
describe('tierLevel', () => {
  it('completes a tier at exactly TIER_REQUIREMENT distinct clean solves', () => {
    expect(tierLevel(counts({ easy: TIER_REQUIREMENT - 1 }))).toBe('none');
    expect(tierLevel(counts({ easy: TIER_REQUIREMENT }))).toBe('easy');
    expect(tierLevel(countCleanSolves(distinct(3, 'easy')))).toBe('easy');
  });

  it('climbs the whole ladder', () => {
    expect(tierLevel(counts({ easy: 3, medium: 3 }))).toBe('medium');
    expect(tierLevel(counts({ easy: 3, medium: 3, hard: 3 }))).toBe('hard');
    expect(tierLevel(counts({ easy: 3, medium: 3, hard: 3, expert: 3 }))).toBe('expert');
  });

  it('is cumulative — a skipped tier stops the climb', () => {
    expect(tierLevel(counts({ easy: 1, medium: 9 }))).toBe('none');
    expect(tierLevel(counts({ easy: 3, medium: 2, hard: 9 }))).toBe('easy');
  });

  it('is `none` for a topic that has never been touched', () => {
    expect(tierLevel()).toBe('none');
    expect(tierLevel(emptyCleanSolves())).toBe('none');
  });
});

// -----------------------------------------------------------------------------
describe('expert never plateaus', () => {
  it('stops escalating at expert but keeps counting', () => {
    for (const n of [3, 4, 10, 137]) {
      const c = counts({ easy: 3, medium: 3, hard: 3, expert: n });
      const p = tierProgress(c);
      expect(p.level).toBe('expert'); // no higher tier exists
      expect(p.next).toBeNull(); // nothing to escalate to
      expect(p.working).toBe('expert'); // still served expert problems
      expect(p.towardNext).toBe(0);
      expect(p.topTierSolves).toBe(n); // ...and the count keeps rising
      expect(tierLabel(p)).toBe(`expert ×${n}`);
      expect(p.score).toBe(1); // the score clamps; the number does not
    }
  });

  it('never proposes a difficulty above expert', () => {
    expect(workingDifficulty('expert')).toBe('expert');
    expect(nextTier('expert')).toBeNull();
  });
});

// -----------------------------------------------------------------------------
describe('tierProgress / masteryScore — the display ordinal', () => {
  it('spends a quarter of the bar per completed tier', () => {
    expect(masteryScore(emptyCleanSolves())).toBe(0);
    expect(masteryScore(counts({ easy: 3 }))).toBeCloseTo(0.25, 10);
    expect(masteryScore(counts({ easy: 3, medium: 3 }))).toBeCloseTo(0.5, 10);
    expect(masteryScore(counts({ easy: 3, medium: 3, hard: 3 }))).toBeCloseTo(0.75, 10);
    expect(masteryScore(counts({ easy: 3, medium: 3, hard: 3, expert: 3 }))).toBe(1);
  });

  it('fills in fractionally toward the next tier', () => {
    expect(masteryScore(counts({ easy: 1 }))).toBeCloseTo(1 / 12, 10);
    expect(masteryScore(counts({ easy: 3, medium: 2 }))).toBeCloseTo(0.25 + 2 / 12, 10);
  });

  it('puts WEAK_SCORE exactly at "has not completed the easy tier"', () => {
    expect(masteryScore(counts({ easy: TIER_REQUIREMENT - 1 }))).toBeLessThan(WEAK_SCORE);
    expect(masteryScore(counts({ easy: TIER_REQUIREMENT }))).toBeGreaterThanOrEqual(WEAK_SCORE);
  });

  it('serves the tier being worked on', () => {
    expect(tierProgress(emptyCleanSolves()).working).toBe('easy');
    expect(tierProgress(counts({ easy: 3 })).working).toBe('medium');
    expect(tierProgress(counts({ easy: 3, medium: 3 })).working).toBe('hard');
    expect(tierProgress(counts({ easy: 3, medium: 3, hard: 3 })).working).toBe('expert');
  });

  it('never exceeds 1, whatever nonsense it is handed', () => {
    expect(masteryScore({ easy: 99, medium: 99, hard: 99, expert: 99 })).toBe(1);
    expect(masteryScore({ easy: -5 })).toBe(0);
    expect(masteryScore({ easy: Number.NaN })).toBe(0);
  });
});

// -----------------------------------------------------------------------------
describe('tierLabel', () => {
  it('never says "mastered"', () => {
    const labels = [
      tierLabel(tierProgress(emptyCleanSolves())),
      tierLabel(tierProgress(counts({ easy: 3 }))),
      tierLabel(tierProgress(counts({ easy: 3, medium: 3 }))),
      tierLabel(tierProgress(counts({ easy: 3, medium: 3, hard: 3 }))),
      tierLabel(tierProgress(counts({ easy: 3, medium: 3, hard: 3, expert: 5 }))),
    ];
    expect(labels).toEqual(['unranked', 'easy', 'medium', 'hard', 'expert ×5']);
    for (const l of labels) expect(l).not.toMatch(/master/i);
  });
});

// -----------------------------------------------------------------------------
describe('levelAtLeast — the unlock comparison', () => {
  it('orders the ladder', () => {
    expect(levelIndex('none')).toBe(0);
    expect(levelIndex('expert')).toBe(TIER_LEVELS.length - 1);
    expect(levelAtLeast('easy', UNLOCK_TIER)).toBe(true);
    expect(levelAtLeast('expert', UNLOCK_TIER)).toBe(true);
    expect(levelAtLeast('none', UNLOCK_TIER)).toBe(false);
  });
});
