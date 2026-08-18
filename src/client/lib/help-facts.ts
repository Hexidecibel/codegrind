// =============================================================================
// help-facts — the numbers the Help tab is allowed to say out loud
// =============================================================================
// The Help tab explains mechanisms, and a mechanism explained with the wrong
// number is worse than no explanation: it teaches a rule the app does not
// follow, and nothing about a paragraph of prose fails a build when the rule
// underneath it changes.
//
// So every number Help prints comes from here, and every value here is one of
// exactly two kinds:
//
//   IMPORTED   the constant already lives somewhere the browser can reach
//              (`@/shared/types`, `@/shared/languages`, `client/lib/assistance`).
//              Re-exported, never retyped. These cannot rot.
//
//   MIRRORED   the constant lives somewhere the browser CANNOT reach — a server
//              module that opens SQLite at import time (`db.ts`), a service that
//              pulls in the sandbox (`bank.service.ts`), or a bash table that
//              docker reads (`bin/lib/languages.sh`). Those are copied here and
//              PINNED by help-facts.test.ts, which reads the real source and
//              fails if the two disagree.
//
// The test is the whole point of the split. "Do not hardcode" is not achievable
// for a bash associative array, but "hardcode it once, in a file that a test
// watches" is — and it keeps the client from importing a module that would drag
// better-sqlite3 into a Vite bundle.

import { DIFFICULTIES, TIER_LEVELS } from '@/shared/types';
import type { Difficulty, SchedulerIntentKind, TierLevel, Verdict } from '@/shared/types';
import { LANGUAGE_META, type Language } from '@/shared/languages';
import { LEVEL_META, type AssistanceLevel } from '@/client/lib/assistance';

// -----------------------------------------------------------------------------
// IMPORTED — the ladders themselves
// -----------------------------------------------------------------------------

/** none → easy → medium → hard → expert. The tuple order IS the ladder. */
export const TIER_LADDER: readonly TierLevel[] = TIER_LEVELS;

/** easy → medium → hard → expert: the difficulties a tier can be completed at. */
export const DIFFICULTY_LADDER: readonly Difficulty[] = DIFFICULTIES;

/**
 * Completed tiers that fill the 0..1 mastery bar — four, so a quarter of the
 * bar is one tier. Derived exactly the way `curriculum.tierProgress` derives it
 * (`TIER_LEVELS.length - 1`), rather than written as `4`.
 */
export const MASTERY_TIERS = TIER_LEVELS.length - 1;

/** The four assistance presets, in ladder order, with the app's own copy. */
export const ASSISTANCE_LADDER: readonly {
  level: AssistanceLevel;
  label: string;
  blurb: string;
}[] = ([1, 2, 3, 4] as AssistanceLevel[]).map((level) => ({
  level,
  label: LEVEL_META[level].label,
  blurb: LEVEL_META[level].blurb,
}));

// -----------------------------------------------------------------------------
// MIRRORED — curriculum.ts (pure, but server-side; see the header)
// -----------------------------------------------------------------------------

/** Distinct hint-free solves that complete one tier. `curriculum.TIER_REQUIREMENT`. */
export const TIER_REQUIREMENT = 3;

/** The tier a topic must complete before its dependents open. `curriculum.UNLOCK_TIER`. */
export const UNLOCK_TIER: Difficulty = 'easy';

// -----------------------------------------------------------------------------
// MIRRORED — db.ts (imports better-sqlite3 and opens the database at module
// scope, so it is unreachable from the browser by construction)
// -----------------------------------------------------------------------------

/**
 * The per-PROBLEM review ladder: attempts 0 → due now, 1 → +2d, 2 → +5d, 3+ →
 * +10d. `db.REVIEW_LADDER_DAYS`.
 */
export const REVIEW_LADDER_DAYS: readonly number[] = [0, 2, 5, 10];

/**
 * The per-TOPIC spaced-repetition boxes, in hours. A clean solve pushes the
 * topic one box further out; a miss pulls it back. `db.BOX_INTERVALS_MS`,
 * converted from ms.
 *
 * Different mechanism to REVIEW_LADDER_DAYS and worth keeping straight in the
 * prose: this one decides when a TOPIC starts biasing the scheduler toward
 * `reinforce`, the other decides when one specific PROBLEM comes back cold.
 */
export const SRS_BOX_HOURS: readonly number[] = [4, 24, 72, 168, 336, 720];

// -----------------------------------------------------------------------------
// MIRRORED — bank.service.ts / routes/hints.ts (both import the sandbox or the
// database transitively)
// -----------------------------------------------------------------------------

/** Sample tests that must survive canonicalization. `bank.MIN_SAMPLE_TESTS`. */
export const MIN_SAMPLE_TESTS = 1;

/** Hidden tests that must survive canonicalization. `bank.MIN_HIDDEN_TESTS`. */
export const MIN_HIDDEN_TESTS = 4;

/** Regeneration attempts before generation gives up. `bank.MAX_GEN_ATTEMPTS`. */
export const MAX_GEN_ATTEMPTS = 3;

/** The top hint rung. `routes/hints.ts` clamps to it; `HintLevel` is 1 | 2 | 3. */
export const MAX_HINT_LEVEL = 3;

// -----------------------------------------------------------------------------
// MIRRORED — bin/lib/languages.sh + bin/run-submission (bash, because bash is
// what invokes docker)
// -----------------------------------------------------------------------------

/** Per-language hard wall-clock cap in seconds. `CG_TIMEOUT`. */
export const SANDBOX_TIMEOUT_SECONDS: Readonly<Record<Language, number>> = {
  javascript: 12,
  python: 12,
  go: 30,
  java: 30,
};

/** Per-language memory ceiling, as docker spells it. `CG_MEMORY`. */
export const SANDBOX_MEMORY: Readonly<Record<Language, string>> = {
  javascript: '256m',
  python: '256m',
  go: '512m',
  java: '512m',
};

/** Cores available to a submission. Not per-language. `CG_CPUS`. */
export const SANDBOX_CPUS = 1;

/**
 * The containment flags every runner container is started with, verbatim from
 * `bin/run-submission`. Printed as-is in Help: a reader who wants to check the
 * claim can grep for exactly this string.
 */
export const SANDBOX_FLAGS: readonly string[] = [
  '--network none',
  '--read-only',
  '--cap-drop=ALL',
  '--security-opt no-new-privileges',
];

/**
 * The languages Help talks about when it talks about the sandbox: the ones with
 * a harness image in this repo. Java is in the registry and deliberately has no
 * `test-harness/java/`, so it is not one of them — see supported-languages.ts.
 */
export const SANDBOX_LANGUAGES: readonly Language[] = ['javascript', 'python', 'go'];

/** Display name for a language, from the shared registry. */
export function languageName(language: Language): string {
  return LANGUAGE_META[language].displayName;
}

// -----------------------------------------------------------------------------
// Derived phrasing — one place, so two sections cannot word the same rule twice
// -----------------------------------------------------------------------------

/** `"4 hours"`, `"1 day"`, `"30 days"` — an SRS box interval, humanised. */
export function boxIntervalLabel(hours: number): string {
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = hours / 24;
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** `"0, 2, 5 then 10 days"` — the review ladder as one readable phrase. */
export function reviewLadderPhrase(): string {
  const days = [...REVIEW_LADDER_DAYS];
  const last = days.pop();
  return `${days.join(', ')} then ${last} days`;
}

// -----------------------------------------------------------------------------
// The closed vocabularies Help enumerates
// -----------------------------------------------------------------------------
// These are unions in `@/shared/types` — types, which have no runtime value to
// import. Listing them by hand is the only option; help-facts.test.ts parses the
// union out of the source so an added verdict or intent kind fails the build
// rather than quietly going undocumented.

/** Every scheduler intent kind, in the order Help introduces them. */
export const SCHEDULER_INTENT_KINDS: readonly SchedulerIntentKind[] = [
  'review',
  'warm-up',
  'reinforce',
  'variation',
  'level-up',
  'new-pattern',
];

/** Every verdict a run or a submit can end in. */
export const VERDICTS: readonly Verdict[] = [
  'accepted',
  'wrong_answer',
  'runtime_error',
  'compile_error',
  'timeout',
  'error',
];
