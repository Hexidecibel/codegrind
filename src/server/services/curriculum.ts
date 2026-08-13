// =============================================================================
// curriculum — the skill tree and the tier ladder. Constants + pure functions.
// =============================================================================
// This module deliberately imports NOTHING but the shared types. It is the one
// place the prerequisite DAG and the tier arithmetic are written down, and every
// consumer pulls from here:
//
//   scheduler.service — picks the next PROBLEM (and re-exports these for
//                       backwards compatibility with existing importers)
//   study.order       — picks the next LESSON
//   reflect.compute   — tree state, unlocks, the dashboard
//   db                — difficulty escalation on submit
//
// It is split out from scheduler.service so the pure ordering logic can be
// imported — and unit-tested — without dragging in `db.js`, which opens SQLite
// at module scope. Keep it dependency-free.

import {
  DIFFICULTIES,
  TIER_LEVELS,
  type Difficulty,
  type TierLevel,
  type Topic,
} from '../../shared/types.js';

// -----------------------------------------------------------------------------
// Skill tree — prerequisites-of each topic. Roots (empty) are available from the
// start. A topic is eligible for `new-pattern` once ≥1 prerequisite has
// completed the UNLOCK_TIER.
// -----------------------------------------------------------------------------
export const PREREQS: Record<Topic, Topic[]> = {
  // roots
  arrays: [],
  hashing: [],
  math: [],
  'bit-manipulation': [],
  // built on arrays
  'two-pointer': ['arrays'],
  'sliding-window': ['arrays', 'two-pointer'],
  'binary-search': ['arrays'],
  intervals: ['arrays', 'two-pointer'],
  stack: ['arrays'],
  'linked-list': ['arrays'],
  greedy: ['arrays', 'intervals'],
  // structural
  trees: ['linked-list'],
  'bfs-dfs': ['trees'],
  graphs: ['bfs-dfs'],
  backtracking: ['trees'],
  'dynamic-programming': ['backtracking'],
  heap: ['trees'],
  trie: ['trees'],
};

export const ROOT_TOPICS: Topic[] = ['arrays', 'hashing', 'math', 'bit-manipulation'];
export const FOUNDATIONAL_START: Topic = 'arrays';

// =============================================================================
// The tier ladder — ONE definition of progress, used everywhere.
// =============================================================================
// The old rule was `masteryScore = solveRate*0.8 + recency*0.2 >= 0.6`. Grinding
// daily pins recency at ~1.0, so it collapsed to "solve rate >= 0.5" — a coin
// flip. Worse, being a *ratio* it was polluted by re-submitting a solution that
// already passed, and it said nothing about difficulty: you could be "mastered"
// having only ever seen easy problems.
//
// The replacement is countable and difficulty-aware:
//
//   TIER CREDIT = one DISTINCT problem solved with ZERO hints.
//
// Deduped by problemId, so re-submitting a passing solution five times is worth
// exactly one credit — the same exploit that walked this user's `binary-search`
// up to medium. TIER_REQUIREMENT credits at a difficulty complete that tier, and
// tiers are cumulative: none -> easy -> medium -> hard -> expert.

/**
 * The difficulty ladder. ONE copy — this used to be duplicated as `DIFF_ORDER`
 * in both db.ts and scheduler.service.ts. The shared DIFFICULTIES tuple is
 * already in ascending order, so it *is* the ladder.
 */
export const DIFF_ORDER: readonly Difficulty[] = DIFFICULTIES;

/** Distinct hint-free solves that complete one tier. */
export const TIER_REQUIREMENT = 3;

/**
 * A topic opens its dependents once it has completed AT LEAST this tier. This
 * replaced `MASTERY_THRESHOLD = 0.6`, which is gone: there is no score
 * comparison in the unlock path any more, only a tier comparison.
 */
export const UNLOCK_TIER: Difficulty = 'easy';

/**
 * A topic counts as "weak" (reinforce / Study-bias candidate) below this display
 * score — i.e. it has been attempted but has not completed the easy tier. One
 * completed tier is worth 0.25, so this is exactly `tier === 'none'`.
 */
export const WEAK_SCORE = 0.25;

/** Distinct hint-free solves per difficulty. Missing keys read as 0. */
export type CleanSolves = Readonly<Partial<Record<Difficulty, number>>>;

/** A zeroed count map — every difficulty present, so callers never see holes. */
export function emptyCleanSolves(): Record<Difficulty, number> {
  const out = {} as Record<Difficulty, number>;
  for (const d of DIFF_ORDER) out[d] = 0;
  return out;
}

/** Normalize a partial/untrusted count map into a dense, non-negative one. */
export function toCleanSolves(counts?: CleanSolves): Record<Difficulty, number> {
  const out = emptyCleanSolves();
  if (!counts) return out;
  for (const d of DIFF_ORDER) {
    const n = counts[d];
    out[d] = typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  }
  return out;
}

/**
 * One recorded attempt, as the tier counter sees it. Deliberately the RAW row:
 * the "solved, zero hints, and I haven't counted this problem yet" rule is
 * applied here, in one pure place, rather than half in SQL and half in TS.
 */
export interface AttemptCredit {
  problemId: string;
  /** The problem's difficulty. Unrecognised values earn nothing. */
  difficulty: string;
  solved: boolean;
  hintsUsed: number;
}

const DIFFICULTY_SET: ReadonlySet<string> = new Set<string>(DIFF_ORDER);

/**
 * Fold attempts into tier credits: **one credit per DISTINCT problem solved
 * with zero hints**.
 *
 * This dedupe is the whole rule. Re-submitting a solution that already passes
 * appends rows to `attempts` and earns nothing — which is exactly the exploit
 * that used to walk a topic's difficulty up three notches for free. Only a row
 * that actually earns a credit marks the problem as counted, so a hinted solve
 * followed later by a clean one still earns its credit.
 */
export function countCleanSolves(attempts: Iterable<AttemptCredit>): Record<Difficulty, number> {
  const counts = emptyCleanSolves();
  const credited = new Set<string>();
  for (const a of attempts) {
    if (!a.solved || a.hintsUsed > 0) continue;
    if (!DIFFICULTY_SET.has(a.difficulty)) continue;
    if (credited.has(a.problemId)) continue;
    credited.add(a.problemId);
    counts[a.difficulty as Difficulty] += 1;
  }
  return counts;
}

/** Position on the ladder: none=0, easy=1, medium=2, hard=3, expert=4. */
export function levelIndex(level: TierLevel): number {
  const i = TIER_LEVELS.indexOf(level);
  return i < 0 ? 0 : i;
}

/** Ordinal comparison — `levelAtLeast(level, UNLOCK_TIER)` is the unlock test. */
export function levelAtLeast(level: TierLevel, min: TierLevel): boolean {
  return levelIndex(level) >= levelIndex(min);
}

/**
 * The highest tier COMPLETED. Cumulative on purpose: the walk stops at the first
 * unfinished tier, so three medium credits with only one easy credit is still
 * `none`. Escalation is tier-gated (see db.updateSkillOnAttempt), so the
 * scheduler never serves a tier whose predecessor is unfinished anyway.
 */
export function tierLevel(counts?: CleanSolves): TierLevel {
  const c = toCleanSolves(counts);
  let level: TierLevel = 'none';
  for (const d of DIFF_ORDER) {
    if (c[d] < TIER_REQUIREMENT) break;
    level = d;
  }
  return level;
}

/** The tier above `level`, or null once the top tier is complete. */
export function nextTier(level: TierLevel): Difficulty | null {
  const next = TIER_LEVELS[levelIndex(level) + 1];
  return next === undefined ? null : (next as Difficulty);
}

/**
 * The difficulty to actually serve: the tier being worked on. Past the top tier
 * it pins there — you never stop being served expert problems, you just stop
 * escalating. This is what makes the ladder never plateau.
 */
export function workingDifficulty(level: TierLevel): Difficulty {
  return nextTier(level) ?? DIFF_ORDER[DIFF_ORDER.length - 1];
}

/** One tier below `d`, floored at the bottom rung (warm-up difficulty). */
export function easierDifficulty(d: Difficulty): Difficulty {
  return DIFF_ORDER[Math.max(0, DIFF_ORDER.indexOf(d) - 1)];
}

/** One tier above `d`, capped at the top rung. */
export function nextDifficulty(d: Difficulty): Difficulty {
  return DIFF_ORDER[Math.min(DIFF_ORDER.indexOf(d) + 1, DIFF_ORDER.length - 1)];
}

/** Everything derived from one topic's clean-solve counts. */
export interface TierProgress {
  /** Highest tier completed. */
  level: TierLevel;
  /** The tier being worked on, or null once the top tier is complete. */
  next: Difficulty | null;
  /** The difficulty to serve (`next`, pinned at the top rung). */
  working: Difficulty;
  /** Distinct hint-free solves banked toward `next` (0 when it is null). */
  towardNext: number;
  /** Distinct hint-free solves at the TOP tier — the number that never stops. */
  topTierSolves: number;
  /** Display-only 0..1 ordinal. */
  score: number;
  counts: Record<Difficulty, number>;
}

const TOP_TIER: Difficulty = DIFF_ORDER[DIFF_ORDER.length - 1];
/** Completed tiers that map onto the 0..1 display scale (none..expert = 4). */
const SCORE_TIERS = TIER_LEVELS.length - 1;

/**
 * The display score, 0..1: `(levelIndex + towardNext / TIER_REQUIREMENT) / 4`.
 *
 * DISPLAY ONLY. Nothing gates on it except WEAK_SCORE (a "reinforce this"
 * nudge) — unlocking, escalation and tree state all compare TIERS. It exists so
 * the bars, ramps and weakness bias that already speak 0..1 keep working, and
 * so a quarter of the bar means exactly one completed tier.
 */
export function tierProgress(counts?: CleanSolves): TierProgress {
  const c = toCleanSolves(counts);
  const level = tierLevel(c);
  const next = nextTier(level);
  const towardNext = next ? Math.min(c[next], TIER_REQUIREMENT) : 0;
  const score = Math.min(
    1,
    (levelIndex(level) + Math.min(towardNext / TIER_REQUIREMENT, 1)) / SCORE_TIERS
  );
  return {
    level,
    next,
    working: workingDifficulty(level),
    towardNext,
    topTierSolves: c[TOP_TIER],
    score,
    counts: c,
  };
}

/**
 * Display-only 0..1 ordinal for a topic/pattern. Same scale everywhere:
 * PatternStat.masteryScore, ReflectTreeNode.mastery, StudyIndexEntry.mastery.
 */
export function masteryScore(counts?: CleanSolves): number {
  return tierProgress(counts).score;
}

/**
 * Short human label for a tier. Never the word "mastered" — a topic is at a
 * tier, it is not finished. Past the top tier the count keeps climbing
 * (`expert ×7`), which is the visible promise that there is always a next rep.
 */
export function tierLabel(progress: TierProgress): string {
  if (progress.level === TOP_TIER) return `${TOP_TIER} ×${progress.topTierSolves}`;
  if (progress.level === 'none') return 'unranked';
  return progress.level;
}
