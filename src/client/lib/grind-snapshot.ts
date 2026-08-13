// =============================================================================
// The persisted grind session, and the one question worth asking about it
// =============================================================================
// GrindPage keeps a whole session in localStorage under `codegrind.grind` so a
// refresh does not lose your place. That snapshot holds a whole `Problem` — its
// prompt, its starter code, its tests — and the language picker lives on
// another page entirely.
//
// So there is a state the app can reach that looks completely normal and is
// not: switch to Python in /manual, come back to /grind, and the resumed
// session puts a JavaScript problem on screen while everything scheduled,
// generated and graded after it is Python. Nothing errors. The snippet just
// quietly belongs to the wrong language.
//
// `staleForLanguage` is the check that closes it, kept out of the component and
// pure so it can be tested without a browser.

import type { Language } from '@/shared/languages';
import type { Problem, SessionPlan, SchedulerWhy, Topic } from '@/shared/types';

/** Everything needed to resume a grind session across a refresh. */
export interface GrindSnapshot {
  sessionId: string;
  plan: SessionPlan;
  problem: Problem;
  why: SchedulerWhy;
  upNext?: string;
  solved: number;
  streak: number;
  topics: Topic[];
}

/**
 * Should this snapshot be thrown away because the app has changed language?
 *
 * The PROBLEM's own language is the answer, not the session's: a problem's
 * language is baked into its reference solution and every `expected` value
 * derived from running it, which is exactly why `Problem.language` crosses the
 * API boundary at all.
 *
 * `active` may be null — that is "the settings request failed", not "no
 * language". An unreachable server must not be read as a mismatch and cost the
 * user a live session, so an unknown active language keeps the snapshot.
 */
export function staleForLanguage(
  snapshot: GrindSnapshot | null,
  active: Language | null
): boolean {
  if (!snapshot || active === null) return false;
  return snapshot.problem.language !== active;
}
