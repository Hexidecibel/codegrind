// =============================================================================
// gap-cards — every gap a mock exposed becomes a spaced-repetition drill card
// =============================================================================
// The same ladder the problem review queue uses (db.ts REVIEW_LADDER_DAYS:
// now → +2d → +5d → +10d), applied to mock gaps. A card is due immediately, and
// each "got it" moves it one rung up; "got it" on the top rung retires it.
//
//   got     advance one rung. Past the top rung = retired (answered confidently
//           at a 10-day gap — the point at which the review queue clears too).
//   shaky   no advance: the same rung again tomorrow. Shaky is not a failure,
//           but it is not confidence either, so it never earns a longer gap.
//   missed  back to the bottom rung, due again now (the back of today's pile).
//
// The grade that moves the schedule is always the user's. Phase F adds an
// optional AI grade first (POST /api/mock/cards/:id/check, one `small` call on
// the typed / dictated answer) that pre-selects a grade the user confirms or
// overrides with one tap; self-grading stays the fallback when the AI is off,
// errors, or the answer is "I don't know" (missed, no call).
//
// Pure — `now` is always passed in — so the whole schedule is unit-tested.

import type { GapType } from './sd.js';
import type { MockConcept } from './mock-kinds.js';

export const GAP_CARD_LADDER_DAYS = [0, 2, 5, 10] as const;
export const GAP_CARD_GRADES = ['got', 'shaky', 'missed'] as const;
export type GapCardGrade = (typeof GAP_CARD_GRADES)[number];

export function isGapCardGrade(x: unknown): x is GapCardGrade {
  return typeof x === 'string' && (GAP_CARD_GRADES as readonly string[]).includes(x);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where a gap was recorded from. */
export type GapSource = 'turn' | 'grade' | 'backfill' | 'rep';

/** One gap, as a mock's view and the drill list both show it. */
export interface MockGap {
  id: number;
  mockId: string;
  /** The turn it surfaced on; null when the grader found it with no turn to cite. */
  seq: number | null;
  concept: MockConcept;
  type: GapType;
  /** The card front: a self-contained question. '' on gaps recorded before cards existed. */
  title: string;
  /** What the candidate did not know, in one sentence. */
  summary: string;
  /** The card back: 2–4 sentences including why it matters. '' on old gaps. */
  answer: string;
  source: GapSource;
  createdAt: string;
}

/** The schedule half of a card. */
export interface GapCardSchedule {
  /** Index into GAP_CARD_LADDER_DAYS of the rung the card is on. */
  step: number;
  dueAt: string;
  reps: number;
  lapses: number;
  lastGrade: GapCardGrade | null;
  lastReviewedAt: string | null;
  retiredAt: string | null;
}

export interface GapCard extends MockGap, GapCardSchedule {
  /** The mock's prompt title, for "from: URL shortener". */
  mockTitle: string;
}

export interface GapCardsResponse {
  /** Due now, oldest-due first. */
  due: GapCard[];
  /** Live cards not yet due. */
  upcoming: number;
  /** Cards answered confidently at the top rung. */
  retired: number;
  /** When the next not-yet-due card comes up, or null. */
  nextDueAt: string | null;
  /** The Settings "AI reviews" toggle: offer the AI grade on answers. */
  aiReviews: boolean;
}

/** POST /api/mock/cards/:id/check — the AI's read of one answer. Moves nothing. */
export interface GapCardCheck {
  grade: GapCardGrade;
  /** One line. */
  why: string;
  missing: string[];
  /** False when no call was made (an empty / "I don't know" answer). */
  ai: boolean;
  costUsd: number | null;
}

/** The schedule a brand-new card starts with: bottom rung, due now. */
export function newCardSchedule(now: Date): GapCardSchedule {
  return {
    step: 0,
    dueAt: now.toISOString(),
    reps: 0,
    lapses: 0,
    lastGrade: null,
    lastReviewedAt: null,
    retiredAt: null,
  };
}

/** Apply one self-grade. Pure. */
export function scheduleGapCard(card: GapCardSchedule, grade: GapCardGrade, now: Date): GapCardSchedule {
  const top = GAP_CARD_LADDER_DAYS.length - 1;
  const step = Math.max(0, Math.min(card.step, top));
  const base = {
    ...card,
    reps: card.reps + 1,
    lastGrade: grade,
    lastReviewedAt: now.toISOString(),
  };
  if (grade === 'got') {
    if (step >= top) return { ...base, step: top, retiredAt: now.toISOString() };
    const next = step + 1;
    return { ...base, step: next, dueAt: new Date(now.getTime() + GAP_CARD_LADDER_DAYS[next] * DAY_MS).toISOString() };
  }
  if (grade === 'shaky') {
    return { ...base, step, dueAt: new Date(now.getTime() + DAY_MS).toISOString() };
  }
  return { ...base, step: 0, lapses: card.lapses + 1, dueAt: now.toISOString(), retiredAt: null };
}

/** What a grade would do, in words, for the buttons ("in 5 days", "retires"). */
export function describeOutcome(card: GapCardSchedule, grade: GapCardGrade): string {
  const top = GAP_CARD_LADDER_DAYS.length - 1;
  const step = Math.max(0, Math.min(card.step, top));
  if (grade === 'got') return step >= top ? 'retires it' : `again in ${GAP_CARD_LADDER_DAYS[step + 1]} days`;
  if (grade === 'shaky') return 'again tomorrow';
  return 'again now';
}

/**
 * The one comparison used to stop the grader re-recording a gap the turn-level
 * capture already has: case, punctuation and spacing do not make a new card.
 */
export function gapKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Two grades of one card closer together than this are one double tap. */
export const DOUBLE_GRADE_MS = 5_000;

/**
 * The server-side double-grade guard (Phase H): the client cleared its busy
 * flag before the next card loaded, so a fast second tap graded the SAME card
 * twice and moved it two rungs. True when the card was graded within
 * DOUBLE_GRADE_MS of `now`. Pure.
 */
export function isDoubleGrade(lastGradedAt: string | null | undefined, now: Date, windowMs = DOUBLE_GRADE_MS): boolean {
  if (!lastGradedAt) return false;
  const t = Date.parse(lastGradedAt);
  return Number.isFinite(t) && now.getTime() - t >= 0 && now.getTime() - t < windowMs;
}
