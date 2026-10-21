// =============================================================================
// breadth.compute — the breadth floor (Phase H2), pure
// =============================================================================
// The adaptive scheduler deepens what you already practise, which is how 14 of
// 18 topics went untouched. Two floors push the other way:
//
//   Problem 2   the day's second problem is the LEAST-SEEN topic in the active
//               language (fewest attempts; ties in curriculum order), at easy
//               until it has one clean solve, then medium.
//   Recognize   a topic with no bank problem at all cannot appear in a
//               Recognize session. Starting a session may stock ONE such topic
//               a day (an easy problem through the normal generation path,
//               leak filter included) — bounded, on demand, never a loop.

import { TOPICS, type Difficulty, type Topic } from '../../shared/types.js';

export interface BreadthTopic {
  topic: Topic;
  /** Grind submits on the topic in the active language. */
  attempts: number;
  /** Distinct hint-free solves on the topic, any difficulty. */
  cleanSolves: number;
}

export interface BreadthPick {
  topic: Topic;
  difficulty: Difficulty;
  attempts: number;
  rationale: string;
}

/**
 * The least-seen topic. `avoid` (Problem 1's topic) is skipped when anything
 * else is available. Input order is the tie-break, so pass TOPICS order.
 */
export function pickBreadth(topics: readonly BreadthTopic[], avoid?: string | null): BreadthPick | null {
  const pool = topics.filter((t) => t.topic !== avoid);
  const list = pool.length ? pool : topics;
  if (!list.length) return null;
  let best = list[0];
  for (const t of list) if (t.attempts < best.attempts) best = t;
  const difficulty: Difficulty = best.cleanSolves > 0 ? 'medium' : 'easy';
  const rationale =
    best.attempts === 0
      ? `Breadth: ${best.topic} is a topic you have never practised — an easy one to start.`
      : `Breadth: ${best.topic} is your least-practised topic (${best.attempts} attempt${best.attempts === 1 ? '' : 's'})${
          difficulty === 'medium' ? ' — one clean solve banked, so medium now' : ''
        }.`;
  return { topic: best.topic, difficulty, attempts: best.attempts, rationale };
}

/** Bank problems generated per local day so Recognize can reach an empty topic. */
export const RECOGNIZE_STOCK_PER_DAY = 1;

/**
 * The topic Recognize should stock next: the first (curriculum order) with no
 * bank problem in ANY language, or null when every topic has one.
 */
export function recognizeStockTopic(problemsPerTopic: ReadonlyMap<string, number>): Topic | null {
  return TOPICS.find((t) => (problemsPerTopic.get(t) ?? 0) === 0) ?? null;
}
