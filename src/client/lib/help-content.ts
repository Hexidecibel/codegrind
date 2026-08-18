// =============================================================================
// help-content — the Help tab's table of contents, and every contextual hint
// =============================================================================
// Two things live here because they are the same thing seen from two distances:
//
//   HELP_SECTIONS   the anchors the Help page is built out of. Declaring them
//                   as data (rather than as eight <h2>s) is what lets a test
//                   assert that the page actually renders every one of them,
//                   and what lets a hint link to one by id instead of by a
//                   hand-typed `#fragment` that nobody would notice going stale.
//
//   HELP_HINTS      the small popovers scattered through the app. Each is two
//                   or three sentences and a pointer INTO a section — never a
//                   second, shorter explanation that can disagree with the long
//                   one. If a hint needs a fourth sentence, the section it
//                   points at is where the fourth sentence belongs.
//
// The prose here is deliberately plain and names real numbers; the numbers
// themselves all come from help-facts.ts, which a test pins to the code. See
// HelpPage.tsx for the long form.

import {
  MAX_HINT_LEVEL,
  MIN_HIDDEN_TESTS,
  TIER_REQUIREMENT,
  UNLOCK_TIER,
  reviewLadderPhrase,
} from '@/client/lib/help-facts';

// -----------------------------------------------------------------------------
// Sections
// -----------------------------------------------------------------------------

export type HelpSectionId =
  | 'loop'
  | 'scheduler'
  | 'problems'
  | 'run-submit'
  | 'hints'
  | 'numbers'
  | 'assistance'
  | 'sandbox'
  | 'models';

export interface HelpSection {
  id: HelpSectionId;
  /** The heading, and the link text a hint uses to point here. */
  title: string;
  /** One line for the contents list at the top of the page. */
  summary: string;
}

/**
 * Reading order, and it is an argument rather than a list: what the app does
 * when you sit down, then where the problem came from, then how it is graded,
 * then what the app records about you, then the three things you can turn up or
 * down (assistance, containment, model).
 */
export const HELP_SECTIONS: readonly HelpSection[] = [
  {
    id: 'loop',
    title: 'The loop',
    summary: 'Five tabs, and what each one is for.',
  },
  {
    id: 'scheduler',
    title: 'Why you got this problem',
    summary: 'The scheduler picks from your own history, and it costs nothing.',
  },
  {
    id: 'problems',
    title: 'How a problem is made',
    summary:
      'The model writes it; the sandbox decides what the right answers actually are.',
  },
  {
    id: 'run-submit',
    title: 'Run and Submit',
    summary: 'Sample tests versus hidden tests, and the six verdicts.',
  },
  {
    id: 'hints',
    title: 'Hints, the answer, and cold review',
    summary: 'What each hint level gives you, and what asking costs.',
  },
  {
    id: 'numbers',
    title: 'What the numbers mean',
    summary: 'Tiers, mastery, the review queue, and which stats are global.',
  },
  {
    id: 'assistance',
    title: 'The assistance ladder',
    summary: 'Practise on anything from a blank editor to a full IDE.',
  },
  {
    id: 'sandbox',
    title: 'Where your code runs',
    summary: 'A throwaway container with no network and a hard timeout.',
  },
  {
    id: 'models',
    title: 'Choosing a model, and what it costs',
    summary: 'Claude or your own hardware, and the two jobs a model does here.',
  },
];

const SECTION_BY_ID = new Map(HELP_SECTIONS.map((s) => [s.id, s]));

/** A section by id. Throws rather than returning undefined — ids are a closed set. */
export function helpSection(id: HelpSectionId): HelpSection {
  const section = SECTION_BY_ID.get(id);
  if (!section) throw new Error(`unknown help section: ${id}`);
  return section;
}

/**
 * The route + fragment for a section. One function so the day Help stops living
 * at `/help` there is exactly one line to change, and so no component builds the
 * URL by string-concatenating an id it might have misspelled.
 */
export const HELP_ROUTE = '/help';

export function helpHref(id: HelpSectionId): string {
  return `${HELP_ROUTE}#${id}`;
}

// -----------------------------------------------------------------------------
// Hints
// -----------------------------------------------------------------------------

export type HelpHintId =
  // Reflect
  | 'mastery'
  | 'tiers-cleared'
  | 'hint-free'
  | 'review-due'
  | 'skill-tree'
  // Grind
  | 'why-this-problem'
  | 'cold-review'
  // Solve surface
  | 'verdict'
  | 'assistance-level';

export interface HelpHint {
  /** Heading inside the popover. Short — it sits above two or three sentences. */
  title: string;
  /** One paragraph per entry. Plain text; no markup, no links. */
  body: readonly string[];
  /** The section the "read more" link goes to. */
  section: HelpSectionId;
}

export const HELP_HINTS: Readonly<Record<HelpHintId, HelpHint>> = {
  // --- Reflect ---------------------------------------------------------------
  mastery: {
    title: 'Mastery',
    body: [
      `Each quarter of a bar is one completed tier. A tier is completed by solving ${TIER_REQUIREMENT} distinct problems at that difficulty with zero hints, and the tiers are cumulative — you cannot be at medium without having finished easy.`,
      'The percentage is for reading, not for gating. Nothing in the app compares against it; unlocking and difficulty both compare tiers.',
    ],
    section: 'numbers',
  },
  'tiers-cleared': {
    title: 'Tiers cleared',
    body: [
      'Every tier you have ever completed, added up across all topics. It is the one number here with no ceiling — once the whole tree is open, this is what still moves.',
      'Re-solving something you already solved does not move it. Credit is counted per distinct problem.',
    ],
    section: 'numbers',
  },
  'hint-free': {
    title: 'Hint-free',
    body: [
      'The share of your submissions in this language made without taking a hint or revealing the answer. Every submission counts, including the ones that failed — this is not a solve rate.',
      'Only a hint-free solve earns tier credit, so this number and your tier progress move together.',
    ],
    section: 'numbers',
  },
  'review-due': {
    title: 'Review due',
    body: [
      'Problems you missed, or leaned on, waiting to come back. A due review is served ahead of everything else the scheduler might have picked.',
      `Miss it again and it goes further out on a ${reviewLadderPhrase()} ladder. Solve it clean and unaided and it leaves the queue.`,
    ],
    section: 'numbers',
  },
  'skill-tree': {
    title: 'How topics unlock',
    body: [
      `A topic opens once at least one of its prerequisites has completed the ${UNLOCK_TIER} tier — ${TIER_REQUIREMENT} distinct problems solved with no hints.`,
      'The four roots (arrays, hashing, math, bit manipulation) have no prerequisites and are open from the start.',
    ],
    section: 'numbers',
  },

  // --- Grind -----------------------------------------------------------------
  'why-this-problem': {
    title: 'Why this problem',
    body: [
      'A scheduler picked it from your own history — what you have cleared, what you missed last time, what has gone stale, and what a completed tier just opened up.',
      'It is arithmetic over your database, not a model deciding. The label says which of the six reasons applied.',
    ],
    section: 'scheduler',
  },
  'cold-review': {
    title: 'Cold review',
    body: [
      'You already saw this problem and either missed it or took help. It comes back with the hint button gone, because the point is to find out whether you can now do it unaided.',
      'Solve it clean and it leaves the review queue for good. The Answer button is still there if you are stuck — it just costs the same as it always does.',
    ],
    section: 'hints',
  },

  // --- Solve surface ---------------------------------------------------------
  verdict: {
    title: 'The verdict',
    body: [
      'Run checks the sample tests printed in the problem statement. Submit checks the hidden ones, records the attempt, and calls the coach.',
      `Hidden tests show you your own output but never their expected value — that is what keeps a failed submit from turning into a copying exercise. There are at least ${MIN_HIDDEN_TESTS} of them.`,
    ],
    section: 'run-submit',
  },
  'assistance-level': {
    title: 'Editor assistance',
    body: [
      'How much the editor helps: from a plain buffer with no highlighting to full IntelliSense. Interviews run the whole range, from a bare shared text pad to your own IDE, so this is a dial rather than a default.',
      'It changes the editor only. Nothing about it is recorded, and it never affects grading, hints or tier credit.',
    ],
    section: 'assistance',
  },
};

/** Every hint id, for tests and for anything that wants to enumerate them. */
export const HELP_HINT_IDS = Object.keys(HELP_HINTS) as HelpHintId[];

/**
 * The heading a hint's "read more" link should carry, so the link text names a
 * real destination instead of saying "learn more".
 */
export function hintDestination(id: HelpHintId): HelpSection {
  return helpSection(HELP_HINTS[id].section);
}

/** Sanity: nothing here should be quietly empty. Used by the tests and the page. */
export const MAX_HINT_PARAGRAPHS = 3;

/**
 * Exported purely so the Help page and the hint copy cannot disagree about how
 * many hint rungs there are — the "1 to N" phrasing appears in both.
 */
export const HINT_LEVELS = Array.from({ length: MAX_HINT_LEVEL }, (_, i) => i + 1);
