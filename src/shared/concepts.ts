// =============================================================================
// concepts — concept reps and the AI-systems learning state (Phase H3), pure
// =============================================================================
// A CONCEPT REP is one Today step (~10 min, between the warm-up and Problem 1):
// one system-design or AI-systems concept, asked the way an interviewer asks it,
// explained back by dictation (~2 min), graded by one call against the
// concept's hand-written rubric (concept-rubrics.ts). Misses become drill cards.
//
// LEARNED BEFORE TESTED. Every concept has a learning state:
//
//   new        never studied. The rep opens with a PRIMER (a 2-minute read:
//              what it is, key points, a worked example) and only then asks.
//              Acknowledging the primer — or reading the concept's lesson in
//              the AI-systems track — sets `learnedAt`.
//   learning   learnedAt is set, but no COLD rep has been got yet. Later reps go
//              straight to the question (spaced retrieval, no primer).
//   known      the latest cold rep was graded `got`. A cold rep is one without a
//              primer, at least KNOWN_AFTER_DAYS after learnedAt — remembering
//              it the same afternoon you read it does not count. A later cold
//              miss drops it back to learning.
//
// THE AI GATE. AI system-design prompts enter the random mock pick only once
// AI_UNLOCK_KNOWN AI concepts are known (aiPromptsUnlocked). Until then they can
// still be picked by hand, labelled as practice.
//
// THE DAILY PICK (pickConcept). While any AI concept is still being learned,
// the rep ALTERNATES AI / classic by the previous rep — so classic system design
// (where the last mock graded below Staff) keeps getting reps. An AI-focused
// interview loop tilts it to AI two days in three. Within the category: due
// concepts first (spacing), weighted toward the weakest — mock grade/turn
// observations plus past rep grades — and new AI concepts in track order.
//
// Pure: no clock it is not handed, no database.

import { AI_SD_CONCEPTS, conceptLabel, isAiSdConcept, type SdConcept } from './sd.js';
import { CLASSIC_REP_CONCEPTS, REP_CONCEPTS, conceptRubric } from './concept-rubrics.js';
import type { GapCardGrade } from './gap-cards.js';

export type ConceptLearningState = 'new' | 'learning' | 'known';
export type ConceptCategory = 'ai' | 'classic';

/** A cold rep must come at least this long after learning to make a concept known. */
export const KNOWN_AFTER_DAYS = 2;
/** AI concepts that must be known before AI prompts enter the random mock pick. */
export const AI_UNLOCK_KNOWN = 5;
/** Graded reps per local day (the step needs one; "another one" allows a couple more). */
export const MAX_REPS_PER_DAY = 3;
/** Grading calls per local day, failures included — the retry bound. */
export const MAX_GRADE_CALLS_PER_DAY = 5;

const DAY_MS = 86_400_000;

/** One graded rep, as the pure rules read it. */
export interface RepFact {
  concept: string;
  grade: GapCardGrade;
  /** The rep opened with the primer (a teach-first rep, never a cold one). */
  primed: boolean;
  createdAt: string;
}

export function categoryOf(concept: string): ConceptCategory {
  return isAiSdConcept(concept) ? 'ai' : 'classic';
}

/** A concept's learning state. `reps` in any order. Pure. */
export function learningState(learnedAt: string | null, reps: readonly RepFact[], concept: string): ConceptLearningState {
  if (!learnedAt) return 'new';
  const floor = Date.parse(learnedAt) + KNOWN_AFTER_DAYS * DAY_MS;
  const cold = reps
    .filter((r) => r.concept === concept && !r.primed && Date.parse(r.createdAt) >= floor)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return cold[0]?.grade === 'got' ? 'known' : 'learning';
}

export function learningStates(
  learned: Readonly<Record<string, string>>,
  reps: readonly RepFact[],
  concepts: readonly string[] = REP_CONCEPTS
): Record<string, ConceptLearningState> {
  return Object.fromEntries(concepts.map((c) => [c, learningState(learned[c] ?? null, reps, c)]));
}

export function knownAiCount(states: Readonly<Record<string, ConceptLearningState>>): number {
  return AI_SD_CONCEPTS.filter((c) => states[c] === 'known').length;
}

/** AI SD prompts may enter the random mock pick. */
export function aiPromptsUnlocked(states: Readonly<Record<string, ConceptLearningState>>): boolean {
  return knownAiCount(states) >= AI_UNLOCK_KNOWN;
}

/** Days until a concept is due again after its last rep. */
export function repIntervalDays(grade: GapCardGrade, state: ConceptLearningState): number {
  if (grade === 'missed') return 1;
  if (grade === 'shaky') return 3;
  return state === 'known' ? 14 : 7;
}

/** A concept's due instant (ms): never repped = now; learned but not yet repped cold = learnedAt + KNOWN_AFTER_DAYS. */
export function conceptDueMs(
  concept: string,
  learnedAt: string | null,
  reps: readonly RepFact[],
  state: ConceptLearningState,
  now: number
): number {
  const mine = reps.filter((r) => r.concept === concept).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const last = mine[0];
  const learnedFloor = learnedAt ? Date.parse(learnedAt) + KNOWN_AFTER_DAYS * DAY_MS : null;
  if (!last) return learnedFloor ?? now;
  const due = Date.parse(last.createdAt) + repIntervalDays(last.grade, state) * DAY_MS;
  // Still learning and not yet cold-tested: the first cold rep waits for the floor.
  if (state === 'learning' && learnedFloor !== null && last.primed) return Math.max(due, learnedFloor);
  return due;
}

export interface ConceptPickInput {
  now: number;
  /** `YYYY-MM-DD`, for the stable tie-break. */
  day: string;
  /** Every graded rep, any order. */
  reps: readonly RepFact[];
  /** concept → learnedAt. */
  learned: Readonly<Record<string, string>>;
  /** Mock evidence, newest first: grade conceptObservations and turn observations. */
  signals: readonly { concept: string; signal: 'nailed' | 'weak' | 'missing' }[];
  /** An upcoming interview loop is AI-focused. */
  aiFocus: boolean;
  /** Concepts already repped today (a second rep picks another). */
  exclude?: readonly string[];
}

export interface ConceptPick {
  concept: SdConcept;
  category: ConceptCategory;
  state: ConceptLearningState;
  /** Index into the rubric's prompts. */
  promptIdx: number;
  /** One line: why this one today. */
  why: string;
}

/** Stable 0..1 from a string (the tie-break). */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

/** Which category today's rep comes from, or null for "either". Pure. */
export function pickCategory(input: Pick<ConceptPickInput, 'reps' | 'aiFocus'>, states: Readonly<Record<string, ConceptLearningState>>): ConceptCategory | null {
  const recent = [...input.reps].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => categoryOf(r.concept));
  const aiLearning = AI_SD_CONCEPTS.some((c) => states[c] !== 'known');
  if (input.aiFocus) {
    // Two days in three: AI, unless the last two were both AI.
    return recent[0] === 'ai' && recent[1] === 'ai' ? 'classic' : 'ai';
  }
  if (aiLearning) return recent[0] === 'ai' ? 'classic' : 'ai';
  return null;
}

/** Today's concept. Pure. */
export function pickConcept(input: ConceptPickInput): ConceptPick {
  const states = learningStates(input.learned, input.reps);
  const category = pickCategory(input, states);
  const exclude = new Set(input.exclude ?? []);
  const pool = (cat: ConceptCategory | null) =>
    REP_CONCEPTS.filter((c) => !exclude.has(c) && (cat === null || categoryOf(c) === cat));
  let candidates = pool(category);
  if (!candidates.length) candidates = pool(null);
  if (!candidates.length) candidates = [...REP_CONCEPTS];

  // Weakness from mock evidence, newest weighing most.
  const weakness = new Map<string, number>();
  input.signals.slice(0, 60).forEach((s, i) => {
    const w = i < 20 ? 1 : 0.5;
    const v = s.signal === 'missing' ? 2 : s.signal === 'weak' ? 1 : -0.5;
    weakness.set(s.concept, (weakness.get(s.concept) ?? 0) + v * w);
  });

  const scored = candidates.map((c) => {
    const state = states[c];
    const mine = input.reps.filter((r) => r.concept === c).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const last = mine[0];
    const due = conceptDueMs(c, input.learned[c] ?? null, input.reps, state, input.now);
    const isDue = due <= input.now;
    let score = 0;
    const reasons: string[] = [];
    if (!isDue) score -= 100;
    else score += Math.min((input.now - due) / DAY_MS, 10) * 0.1;
    const mockW = Math.max(-2, Math.min(4, weakness.get(c) ?? 0));
    score += mockW;
    if (mockW >= 1) reasons.push('weak in recent mocks');
    if (last) {
      score += last.grade === 'missed' ? 2 : last.grade === 'shaky' ? 1 : -1;
      if (last.grade !== 'got' && isDue) reasons.push(`last rep ${last.grade}`);
    }
    if (state === 'new') {
      if (categoryOf(c) === 'ai') {
        // New AI concepts in track order, after any learning one that is due for its cold rep.
        const idx = (AI_SD_CONCEPTS as readonly string[]).indexOf(c);
        score += 0.5 + (AI_SD_CONCEPTS.length - idx) * 0.05;
        reasons.push('next in the AI-systems track');
      } else {
        score += 1;
        reasons.push('not practised yet');
      }
    } else if (state === 'learning' && isDue) {
      score += 1.5;
      reasons.push('due for a cold rep');
    }
    score += hash01(`${input.day}:${c}`) * 0.01;
    return { c, state, score, reasons, reps: mine.length };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const rubric = conceptRubric(best.c)!;
  return {
    concept: best.c,
    category: categoryOf(best.c),
    state: best.state,
    promptIdx: best.reps % rubric.prompts.length,
    why: best.reasons[0] ?? (best.state === 'known' ? 'spaced review' : 'due'),
  };
}

// -----------------------------------------------------------------------------
// Wire shapes
// -----------------------------------------------------------------------------

/** The teach-first primer, rendered from the rubric. */
export interface ConceptPrimer {
  primer: string;
  keyPoints: string[];
  example: string;
  mistake: string;
}

/** GET /api/concept/today. */
export interface ConceptToday {
  date: string;
  concept: SdConcept;
  label: string;
  category: ConceptCategory;
  state: ConceptLearningState;
  why: string;
  /** The interviewer's question. */
  question: string;
  promptIdx: number;
  /** Set when the rep is teach-first (state new): read this, then answer. */
  primer: ConceptPrimer | null;
  /** The AI-systems track lesson for this concept, when it has one. */
  lessonHref: string | null;
  /** Graded reps today, and the cap. */
  doneToday: number;
  maxPerDay: number;
  /** Today's graded reps, oldest first. */
  today: ConceptRepView[];
  /** The model grading runs on, priced, for the button. */
  estimateUsd: number | null;
}

/** One graded rep, as the page and Today show it. */
export interface ConceptRepView {
  id: number;
  concept: SdConcept;
  label: string;
  question: string;
  answer: string;
  primed: boolean;
  grade: GapCardGrade;
  hit: string[];
  missed: string[];
  /** One line: why got / shaky / missed. */
  why: string;
  modelAnswer: string;
  followUp: string;
  /** A drill card was minted (missed or shaky). */
  cardId: number | null;
  costUsd: number | null;
  createdAt: string;
}

/** One row of the AI-systems track (and the classic list) on Study. */
export interface ConceptTrackItem {
  concept: SdConcept;
  label: string;
  category: ConceptCategory;
  state: ConceptLearningState;
  /** A lesson has been generated (reading it is free). */
  lessonCached: boolean;
  lastGrade: GapCardGrade | null;
  reps: number;
}

export interface ConceptTrack {
  items: ConceptTrackItem[];
  knownAi: number;
  unlockAt: number;
  aiUnlocked: boolean;
  /** An upcoming loop is AI-focused. */
  aiFocus: boolean;
}

/** One AI-systems lesson (generated once per concept, cached). */
export interface ConceptLesson {
  concept: SdConcept;
  label: string;
  /** What it is and the key points. Markdown. */
  card: string;
  /** How it shows up in an interview. */
  inInterview: string;
  failureModes: string[];
  workedExample: string;
  /** What a Staff answer sounds like, as a short spoken paragraph. */
  staffAnswer: string;
  /** "You could draw on…" ties to the candidate's own work (may be empty). */
  drawOn: string[];
  model: string;
  createdAt: string;
}

/** Labels, re-exported for the client. */
export { conceptLabel, CLASSIC_REP_CONCEPTS, REP_CONCEPTS };
