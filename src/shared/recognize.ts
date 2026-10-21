// =============================================================================
// recognize — the "Recognize" drill, as the client sees it
// =============================================================================
// Pattern matching without code, for rusty days: read a problem statement,
// pick the pattern from four choices, type 1-3 sentences of approach +
// complexity, then reveal the reference approach and grade yourself.
//
//   free     the session, the pattern check (auto), the reveal (stored primer +
//            cached note), the self-grade, the SRS ladder
//   1 call   the AI check, role `small`: automatic on reveal when "AI reviews"
//            is on (Phase F) and the approach is not blank, else on click.
//            Cached per (problem, pick, answer): an identical answer is free.
//
// It is NOT grinding. A recognize card never writes `attempts`, `skill_state`,
// tier credit or `review_queue`. Its only footprint outside its own tables is
// the reveal ledger, written when the full reference CODE is shown (see
// recognize.service.ts for why).

import type { Example, Topic } from './types.js';
import type { GapCardGrade } from './gap-cards.js';

/** The session sizes the page offers. */
export const RECOGNIZE_SIZES = [5, 10] as const;
export const DEFAULT_RECOGNIZE_SIZE = 5;
/** The soft per-card timer. A nudge, never an action. */
export const RECOGNIZE_SOFT_SECONDS = 120;

/** One card as served: the statement only — no title, no topic, no code. */
export interface RecognizeCard {
  problemId: string;
  prompt: string;
  examples: Example[];
  constraints: string[];
  difficulty: string;
  /** Four topics, shuffled: the answer and three plausible distractors. */
  choices: Topic[];
  /** Served because its recognize card is due (a previous miss / shaky). */
  due: boolean;
  /**
   * The full code has already been seen for this problem (ledger), or the
   * problem was attempted before — so "show code" costs nothing new.
   */
  codeFree: boolean;
}

export interface RecognizeSession {
  cards: RecognizeCard[];
  /** Due recognize cards that did not fit in this session. */
  dueLeft: number;
}

/** The free reveal: everything except the reference code. */
export interface RecognizeReveal {
  problemId: string;
  title: string;
  topic: Topic;
  /** The problem's own pattern string (usually == topic). */
  pattern: string;
  picked: Topic | null;
  patternCorrect: boolean;
  /** From the topic's cached primer. Null only if no primer could be had. */
  primer: {
    cues: string[];
    skeleton: string;
    pitfalls: string[];
    example: { title: string; insight: string };
  } | null;
  /** Problem-specific insight + optimal complexity, cached from an earlier AI check. */
  note: RecognizeNote | null;
  language: string;
  /** "AI reviews" is on: the page runs the check automatically after reveal. */
  autoCheck: boolean;
}

export interface RecognizeNote {
  keyInsight: string;
  time: string;
  space: string;
}

export interface RecognizeCode {
  problemId: string;
  language: string;
  referenceSolution: string;
}

export type RecognizeVerdict = 'correct' | 'partly' | 'wrong';

export interface RecognizeCheck {
  verdict: RecognizeVerdict;
  missing: string[];
  edgeCaseThatBites: string;
  oneLineFix: string;
  /** Also cached on the problem (recognize_notes) so later reveals show it free. */
  note: RecognizeNote;
  /** The grade the verdict suggests; the user still clicks. */
  suggested: GapCardGrade;
  /** What THIS request cost: 0 when served from the cache. */
  costUsd: number | null;
  /** Served from the per-answer cache, no call made. */
  cached?: boolean;
}

export interface RecognizeGradeRequest {
  problemId: string;
  picked: string | null;
  approach: string;
  selfGrade: GapCardGrade;
  codeShown?: boolean;
  aiVerdict?: RecognizeVerdict | null;
  durationMs?: number;
}

export interface RecognizeGradeResponse {
  /** The grade that went on the ladder: a wrong pattern is always `missed`. */
  grade: GapCardGrade;
  /** "again in 2 days", "retires it", "not scheduled" … */
  outcome: string;
}

export interface RecognizeTopicStat {
  topic: Topic;
  n: number;
  /** Fraction 0..1 of cards where the pattern pick was right. */
  patternAccuracy: number;
  /** Fraction 0..1 graded `got`. */
  gotRate: number;
}

export interface RecognizeStats {
  byTopic: RecognizeTopicStat[];
  /** Over the last RECENT_WINDOW cards; null with none. */
  recentAccuracy: number | null;
  recentN: number;
  due: number;
  upcoming: number;
  total: number;
}

/** Today's optional Recognize add-on, under the warm-up. */
export interface TodayRecognize {
  recommended: boolean;
  /** Why it is (or is not) recommended, one line. */
  reason: string;
  /** Recognize cards graded today. */
  doneToday: number;
  done: boolean;
  due: number;
  href: string;
}

/** A self-grade from an AI verdict. */
export function gradeFromVerdict(v: RecognizeVerdict): GapCardGrade {
  return v === 'correct' ? 'got' : v === 'partly' ? 'shaky' : 'missed';
}
