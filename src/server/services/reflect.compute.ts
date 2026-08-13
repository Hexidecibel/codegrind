// =============================================================================
// reflect.compute — the PURE brain behind GET /api/reflect
// =============================================================================
// Depth, tree state, the next-unlock search, the trend metrics, the heatmap
// window and the mistake split are all pure functions over injected state: no
// database, no clock it cannot be handed.
//
// Like ./study.order.js, this module imports ONLY shared types and
// ./curriculum.js (constants + the mastery formula). It must never import
// ./db.js, directly or transitively: db.ts opens SQLite at module scope, so
// merely importing it would make the unit tests read and write the live
// database and pin the suite to one better-sqlite3 native ABI. The stateful
// half — reading the tables — stays in db.ts, and ../routes/reflect.ts glues
// the two together.

import {
  TOPICS,
  type Topic,
  type Difficulty,
  type TierLevel,
  type ReflectTreeState,
  type ReflectNextUnlock,
  type ReflectActivityDay,
  type ReflectTrendPoint,
  type ReflectMistake,
} from '../../shared/types.js';
import {
  PREREQS,
  TIER_REQUIREMENT,
  UNLOCK_TIER,
  levelAtLeast,
  masteryScore,
  tierLevel,
  tierProgress,
  type TierProgress,
} from './curriculum.js';

// -----------------------------------------------------------------------------
// Injected state
// -----------------------------------------------------------------------------
/**
 * One topic's live skill row, as the reflect layer needs it.
 *
 * `cleanSolves` is the ONLY progress input — tier, display score and served
 * difficulty are all derived from it here, so a caller cannot hand this layer a
 * mastery number that disagrees with the tier it claims.
 */
export interface ReflectSkill {
  topic: Topic;
  attempts: number;
  solved: number;
  /** Distinct hint-free solves per difficulty. */
  cleanSolves: Partial<Record<Difficulty, number>>;
  box: number;
  streak: number;
  lastSeenAt: string | null;
}

/** The tier picture for one topic — `tierProgress` over its clean solves. */
export function skillTier(skill: ReflectSkill): TierProgress {
  return tierProgress(skill.cleanSolves);
}

/** One recorded submit against a problem. */
export interface ReflectAttempt {
  solved: boolean;
  testsPassed: number;
  testsTotal: number;
  createdAt: string;
}

/** Every attempt against one problem, oldest first. */
export interface ReflectProblemAttempts {
  problemId: string;
  title: string;
  topic: Topic;
  /** Chronological (oldest first). */
  attempts: ReflectAttempt[];
}

/** An attempt that carried coach-emitted mistake tags. */
export interface ReflectTaggedAttempt {
  mistakeTags: string[];
  createdAt: string;
}

/** A day that had activity (days with none are simply absent). */
export interface ReflectActivityRow {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  attempts: number;
  solved: number;
}

// -----------------------------------------------------------------------------
// Tunables
// -----------------------------------------------------------------------------
// There is no unlock-search cap any more: an unlock now costs at most
// TIER_REQUIREMENT distinct clean solves, so the answer is bounded by
// construction rather than by a loop budget.

/** Days of history the activity heatmap covers. */
export const ACTIVITY_DAYS = 84;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const TOPIC_INDEX = new Map<Topic, number>(TOPICS.map((t, i) => [t, i]));

// -----------------------------------------------------------------------------
// Depth — the tree's layer index.
// -----------------------------------------------------------------------------
/**
 * Longest path from a root topic to each topic through PREREQS. Roots are 0.
 * Longest (not shortest) is what the tree layout wants: a node must render
 * below EVERY prerequisite, so its layer is one past the deepest of them.
 *
 * PREREQS is a DAG; the `visiting` guard only exists so a hand-edit that
 * introduces a cycle degrades to depth 0 instead of blowing the stack.
 */
export function topicDepth(): Record<Topic, number> {
  const depth = {} as Record<Topic, number>;
  const visiting = new Set<Topic>();

  const walk = (t: Topic): number => {
    const memo = depth[t];
    if (memo !== undefined) return memo;
    if (visiting.has(t)) return 0; // cycle guard
    visiting.add(t);
    const prereqs = PREREQS[t] ?? [];
    let d = 0;
    for (const p of prereqs) d = Math.max(d, walk(p) + 1);
    visiting.delete(t);
    depth[t] = d;
    return d;
  };

  for (const t of TOPICS) walk(t);
  return depth;
}

/**
 * Curriculum order for the tree: by depth, then by the canonical TOPICS order.
 * Because a topic's depth is strictly greater than every prerequisite's, this
 * is always a valid topological order — prerequisites list before dependents.
 */
export function curriculumOrder(): Topic[] {
  const depth = topicDepth();
  return [...TOPICS].sort(
    (a, b) => depth[a] - depth[b] || (TOPIC_INDEX.get(a) ?? 0) - (TOPIC_INDEX.get(b) ?? 0)
  );
}

// -----------------------------------------------------------------------------
// Tree state
// -----------------------------------------------------------------------------
/**
 * Whether a topic's gate is open, per the `new-pattern` rule in
 * scheduler.service: roots are always available, and a non-root opens as soon
 * as AT LEAST ONE prerequisite has completed the UNLOCK_TIER. (Any, not every —
 * the scheduler has always been willing to start `intervals` off the back of
 * `arrays` alone.)
 *
 * The gate is a TIER comparison, not a score comparison: three distinct
 * hint-free easy solves on a prerequisite, and the dependent opens.
 */
export function isUnlocked(topic: Topic, levels: ReadonlyMap<Topic, TierLevel>): boolean {
  const prereqs = PREREQS[topic] ?? [];
  if (prereqs.length === 0) return true; // roots
  return prereqs.some((p) => levelAtLeast(levels.get(p) ?? 'none', UNLOCK_TIER));
}

/**
 * A topic's tree state. Ordinal and mutually exclusive, most-advanced first:
 *
 *   tiered    — has completed at least one tier (so it opens its dependents)
 *   practiced — attempted at least once, no tier completed yet
 *   available — untouched, but its prerequisite gate is open
 *   locked    — untouched and gated
 *
 * There is no "mastered": a topic is at a tier, and there is always a next one.
 */
export function treeState(
  skill: ReflectSkill,
  levels: ReadonlyMap<Topic, TierLevel>
): ReflectTreeState {
  if (levelAtLeast(tierLevel(skill.cleanSolves), UNLOCK_TIER)) return 'tiered';
  if (skill.attempts > 0) return 'practiced';
  return isUnlocked(skill.topic, levels) ? 'available' : 'locked';
}

/** Tier lookup keyed by topic, for the prerequisite checks. */
export function levelMap(skills: ReflectSkill[]): Map<Topic, TierLevel> {
  return new Map(skills.map((s) => [s.topic, tierLevel(s.cleanSolves)]));
}

/** Every topic's state in one pass. */
export function treeStates(skills: ReflectSkill[]): Map<Topic, ReflectTreeState> {
  const levels = levelMap(skills);
  return new Map(skills.map((s) => [s.topic, treeState(s, levels)]));
}

// -----------------------------------------------------------------------------
// nextUnlock — the headline number.
// -----------------------------------------------------------------------------
/**
 * Distinct NEW problems this topic must be solved on, hint-free at UNLOCK_TIER,
 * to complete that tier and open its dependents. 0 once it already has.
 *
 * No search and no cap: a tier is a counter, so the answer is just what's left
 * of it. Note "distinct" — re-solving a problem that already counted moves this
 * number not at all, which is the whole point of the rule.
 */
export function solvesToUnlock(skill: ReflectSkill): number {
  const banked = skill.cleanSolves[UNLOCK_TIER] ?? 0;
  return Math.max(0, TIER_REQUIREMENT - banked);
}

/**
 * The cheapest single move that opens new territory.
 *
 * For every locked topic, look at its prerequisites; for each prerequisite that
 * the user can actually practice right now (i.e. is not itself locked), work out
 * how many distinct clean solves would take it to the unlock tier, then take the
 * global minimum. Ties go to the candidate that opens the most topics, then the
 * shallower one, then canonical order — so the answer is deterministic.
 *
 * Returns null when nothing is locked.
 */
export function computeNextUnlock(skills: ReflectSkill[]): ReflectNextUnlock | null {
  const levels = levelMap(skills);
  const states = treeStates(skills);
  const depth = topicDepth();
  const order = curriculumOrder();

  const locked = order.filter((t) => states.get(t) === 'locked');
  if (locked.length === 0) return null;

  // Prerequisites of locked topics that are themselves practisable and not yet
  // at the unlock tier — telling someone to grind a topic they can't reach is
  // no advice.
  const candidates = new Set<Topic>();
  for (const t of locked) {
    for (const p of PREREQS[t] ?? []) {
      if (states.get(p) === 'locked') continue;
      if (levelAtLeast(levels.get(p) ?? 'none', UNLOCK_TIER)) continue;
      candidates.add(p);
    }
  }

  const byTopic = new Map<Topic, ReflectSkill>(skills.map((s) => [s.topic, s]));

  let best: ReflectNextUnlock | null = null;
  let bestDepth = Infinity;

  for (const topic of order) {
    if (!candidates.has(topic)) continue;
    const skill = byTopic.get(topic);
    if (!skill) continue;

    const k = solvesToUnlock(skill);
    if (k === 0) continue;

    // What opens if this topic (and only this topic) reaches the unlock tier.
    const after = new Map(levels);
    after.set(topic, UNLOCK_TIER);
    const unlocks = locked.filter((t) => isUnlocked(t, after));
    if (unlocks.length === 0) continue;

    const better =
      best === null ||
      k < best.cleanSolvesNeeded ||
      (k === best.cleanSolvesNeeded &&
        (unlocks.length > best.unlocks.length ||
          (unlocks.length === best.unlocks.length && depth[topic] < bestDepth)));

    if (better) {
      best = {
        topic,
        cleanSolvesNeeded: k,
        currentMastery: masteryScore(skill.cleanSolves),
        unlocks,
      };
      bestDepth = depth[topic];
    }
  }

  return best;
}

// -----------------------------------------------------------------------------
// Trend — per-problem improvement signal.
// -----------------------------------------------------------------------------
/**
 * One point per problem, chronological by first submit.
 *
 * - firstSubmitRatio — how much of the hidden suite passed on the FIRST try.
 *   That is the cold-recall signal; later submits are debugging, not recall.
 * - submitsToPass — 1-indexed position of the first solved submit, null if the
 *   problem was never solved.
 * - minutesToSolve — wall clock from first submit to the solving one, null if
 *   never solved. Zero when it went in first try.
 */
export function computeTrend(attemptsByProblem: ReflectProblemAttempts[]): ReflectTrendPoint[] {
  const points: ReflectTrendPoint[] = [];

  for (const entry of attemptsByProblem) {
    const attempts = [...entry.attempts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (attempts.length === 0) continue;

    const first = attempts[0];
    const firstSubmitRatio =
      first.testsTotal > 0 ? first.testsPassed / first.testsTotal : first.solved ? 1 : 0;

    const passIndex = attempts.findIndex((a) => a.solved);
    const submitsToPass = passIndex >= 0 ? passIndex + 1 : null;
    const minutesToSolve =
      passIndex >= 0
        ? Math.round(
            ((new Date(attempts[passIndex].createdAt).getTime() -
              new Date(first.createdAt).getTime()) /
              MINUTE_MS) *
              10
          ) / 10
        : null;

    points.push({
      problemId: entry.problemId,
      title: entry.title,
      topic: entry.topic,
      firstSubmitRatio,
      submitsToPass,
      minutesToSolve,
      at: first.createdAt,
    });
  }

  return points.sort((a, b) => a.at.localeCompare(b.at));
}

// -----------------------------------------------------------------------------
// Mistakes — is the ledger shrinking or not?
// -----------------------------------------------------------------------------
/**
 * Tag counts split into the earlier and more recent halves of tagged history,
 * so the UI can show a direction rather than just a total. With an odd number
 * of tagged attempts the extra one lands in `recent`.
 *
 * Ranked by total count descending, then tag ascending (stable across calls).
 */
export function splitMistakes(attempts: ReflectTaggedAttempt[]): ReflectMistake[] {
  const chronological = [...attempts].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const mid = Math.floor(chronological.length / 2);

  const agg = new Map<string, ReflectMistake>();
  chronological.forEach((attempt, i) => {
    const isRecent = i >= mid;
    for (const tag of attempt.mistakeTags) {
      if (typeof tag !== 'string' || !tag) continue;
      let row = agg.get(tag);
      if (!row) {
        row = { tag, count: 0, recent: 0, earlier: 0 };
        agg.set(tag, row);
      }
      row.count += 1;
      if (isRecent) row.recent += 1;
      else row.earlier += 1;
    }
  });

  return [...agg.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// -----------------------------------------------------------------------------
// Activity — the heatmap window.
// -----------------------------------------------------------------------------
/** `YYYY-MM-DD` for a UTC instant. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Exactly `days` calendar days ending today (UTC), oldest first, with every gap
 * filled by a zero row — a heatmap has to be a dense grid, and letting the
 * client infer missing days is how off-by-one week alignment bugs happen.
 */
export function buildActivity(
  rows: ReflectActivityRow[],
  days: number = ACTIVITY_DAYS,
  now: number = Date.now()
): ReflectActivityDay[] {
  const byDate = new Map<string, ReflectActivityRow>();
  for (const r of rows) byDate.set(r.date, r);

  // Anchor on the UTC midnight of "today" so the arithmetic is DST-proof.
  const todayMs = Date.parse(`${utcDay(now)}T00:00:00.000Z`);
  const out: ReflectActivityDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = utcDay(todayMs - i * DAY_MS);
    const row = byDate.get(date);
    out.push({ date, attempts: row?.attempts ?? 0, solved: row?.solved ?? 0 });
  }
  return out;
}

/**
 * Consecutive days with at least one attempt, counting back from today. Today
 * being empty does not break the streak (the day isn't over); the day before it
 * being empty does.
 */
export function computeDayStreak(activity: ReflectActivityDay[]): number {
  let streak = 0;
  for (let i = activity.length - 1; i >= 0; i--) {
    if (activity[i].attempts > 0) {
      streak++;
      continue;
    }
    // Grace for today only.
    if (i === activity.length - 1) continue;
    break;
  }
  return streak;
}
