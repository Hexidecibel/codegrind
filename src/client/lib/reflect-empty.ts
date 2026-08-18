// =============================================================================
// Is there anything on the Reflect page yet — and what is already true?
// =============================================================================
// Reflect is the tab that sells the whole premise: the memory a chatbot cannot
// offer. On a fresh install it rendered the entire dashboard unconditionally —
// an empty skill tree, six zeros, two blank trend charts and the bare line "No
// attempts recorded yet." Somebody who opened it first read that as broken
// software, which is the opposite of what the page is for.
//
// THE FIX IS NOT TO HIDE THE DASHBOARD. An empty skill tree is genuinely
// informative: it is the map of everything that unlocks, and the tier ladder
// underneath says what opening each one costs. So the page still renders; it
// just gets a sentence at the top saying what will appear here and what to do
// to fill it.
//
// WHICH MAKES *THIS* MODULE THE CAREFUL PART, because two of the six tiles are
// GLOBAL, not per-language (see routes/reflect.ts, which computes them from
// tables that carry no language at all):
//
//   lessonsRead   the lesson corpus is shared, so a lesson you read is read
//   streak        a habit metric — Python yesterday and Go today is two
//                 consecutive days of practice, not two broken streaks
//
// So a user who has spent an evening in Study, or who has been grinding another
// language all week, is NOT at zero everywhere — and telling them "nothing here
// yet" would be the app failing to notice work they actually did. `earned` is
// the list of things that are already true, and the copy is built from it.
//
// Pure and tested, like grind-snapshot.ts and provider-source.ts, because the
// client has no DOM test setup and this is the part with a rule in it.

import type { ReflectTiles, ReflectTreeNode } from '@/shared/types';

export interface ReflectEmptiness {
  /**
   * Nothing has ever been *submitted* in this language.
   *
   * All-time, not "in the last 84 days": it is derived from the per-topic
   * counters on the tree, which never roll off, so somebody returning after a
   * three-month gap is not greeted as a first-time user.
   */
  fresh: boolean;
  /** `fresh`, and nothing global has happened either. A genuine blank slate. */
  blank: boolean;
  /**
   * The global things that are already true, phrased for a sentence. Empty when
   * there really is nothing. NEVER claim the page is empty while this is not.
   */
  earned: string[];
  /** Topics playable right now — the roots of the tree, before anything unlocks. */
  openTopics: number;
}

/** `n thing` / `n things`, the one plural rule this file needs. */
function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export function reflectEmptiness(input: {
  tiles: ReflectTiles;
  /** The tree as the API returns it; only the attempt counters are read. */
  tree: readonly Pick<ReflectTreeNode, 'attempts'>[];
}): ReflectEmptiness {
  const { tiles, tree } = input;

  // Three independent witnesses to "you have done something here", because each
  // one alone has a hole: attempts is per-topic and a submission could in
  // principle land under none, solved counts distinct problems, and tiersCleared
  // is what survives a database that has been pruned of old attempts.
  const attempts = tree.reduce((n, t) => n + t.attempts, 0);
  const fresh = attempts === 0 && tiles.solved === 0 && tiles.tiersCleared === 0;

  const earned: string[] = [];
  if (tiles.lessonsRead > 0) earned.push(`${count(tiles.lessonsRead, 'lesson')} read in Study`);
  // Hyphenated, not `count()`: "a 9 days streak" is the kind of copy that
  // makes an app feel machine-written.
  if (tiles.streak > 0) earned.push(`a ${tiles.streak}-day streak`);

  return {
    fresh,
    blank: fresh && earned.length === 0,
    earned,
    openTopics: tiles.topicsReached,
  };
}

/**
 * The sentence that lists what is already true, or null when nothing is.
 *
 * Here rather than in the component so the "do not claim zero" rule is asserted
 * by a test rather than read off a screenshot.
 */
export function earnedSentence(e: ReflectEmptiness): string | null {
  if (e.earned.length === 0) return null;
  // Index, not `.at(-1)`: the tsconfig target is ES2020 and `Array.prototype.at`
  // is ES2022, so it does not typecheck here.
  const list =
    e.earned.length === 1
      ? e.earned[0]
      : `${e.earned.slice(0, -1).join(', ')} and ${e.earned[e.earned.length - 1]}`;
  // Singular/plural on the trailing clause too: "Both of those are global" in
  // front of one item is exactly the kind of small lie this module exists to
  // stop the page telling.
  const tail =
    e.earned.length === 1
      ? 'That one is global: it counts'
      : 'Those are global: they count';
  return `Not everything here is at zero — you already have ${list}. ${tail} across every language, not just this one.`;
}
