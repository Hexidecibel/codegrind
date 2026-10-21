// =============================================================================
// story-forge — drafting a behavioral story by voice, with a coach (Phase H4)
// =============================================================================
// A guided interview, one question per turn, over six beats:
//
//   situation → role → actions → obstacles → result → change
//
// The coach (one workhorse call per answer) pushes back on "we" without "I",
// vague scope, a result with no number, and framing below Staff (influence,
// ambiguity, cross-team). It NEVER invents a detail: it asks, and anything
// uncertain goes into the draft's `unconfirmed[]` — never into the story text.
//
// Output: a STAR draft in resume-builder's Story shape. "Save to story bank"
// appends it as status 'draft' (only on an explicit click), then mints a
// "2-minute retell" drill card.
//
// Pure: no I/O. The rules here are unit-tested (story-forge.test.ts).

import { BQ_COMPETENCIES, BQ_QUESTIONS, type BqCompetency } from './behavioral-questions.js';

export const FORGE_BEATS = ['situation', 'role', 'actions', 'obstacles', 'result', 'change'] as const;
export type ForgeBeat = (typeof FORGE_BEATS)[number];

export const FORGE_BEAT_LABEL: Readonly<Record<ForgeBeat, string>> = {
  situation: 'Situation',
  role: 'Your role',
  actions: 'What YOU did',
  obstacles: 'Obstacles & pushback',
  result: 'Result (a number)',
  change: "What you'd change",
};

/** Answers per session. Bounded: a forge is ~6 beats + a few pushbacks. */
export const FORGE_MAX_TURNS = 12;
/** Model calls per local day across sessions (each answer is one). */
export const FORGE_MAX_CALLS_PER_DAY = 30;
export const FORGE_MAX_ANSWER_CHARS = 6000;

export const PUSHBACK_KINDS = ['i-vs-we', 'vague-scope', 'no-number', 'staff-framing', 'hypothetical', 'other'] as const;
export type PushbackKind = (typeof PUSHBACK_KINDS)[number];

export const PUSHBACK_LABEL: Readonly<Record<PushbackKind, string>> = {
  'i-vs-we': '"I" vs "we"',
  'vague-scope': 'Vague scope',
  'no-number': 'No number',
  'staff-framing': 'Staff framing',
  hypothetical: 'Hypothetical',
  other: 'Note',
};

/** The STAR draft, in resume-builder's Story field names. */
export interface StoryDraft {
  title: string;
  /** The interviewer's question this story answers: "Tell me about a time you…". */
  question: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  complication: string;
  /** Three result-first beats for the 2-minute retell. */
  beats: string[];
  /** Only numbers the candidate SAID. */
  numbers: string[];
  caveats: string[];
  /** Open questions, NOT facts. */
  unconfirmed: string[];
  fits: string[];
}

export interface ForgeTurn {
  role: 'coach' | 'you';
  content: string;
  /** coach: the beat the question targets. */
  beat?: ForgeBeat;
  pushback?: { kind: PushbackKind; note: string }[];
  createdAt: string;
}

export type ForgeStatus = 'active' | 'drafted' | 'saved' | 'abandoned';

/** What the forge started from. */
export interface ForgeSeed {
  competency: BqCompetency;
  /** A story-bank candidate's title or an existing story id the user wants to deepen. */
  candidate: { kind: 'candidate' | 'story'; ref: string; title: string } | null;
}

export interface ForgeSessionView {
  id: string;
  day: string;
  seed: ForgeSeed;
  status: ForgeStatus;
  turns: ForgeTurn[];
  covered: ForgeBeat[];
  draft: StoryDraft | null;
  /** Answers given / the cap. */
  answers: number;
  maxTurns: number;
  savedStoryId: string | null;
  cardId: number | null;
  costUsd: number;
  createdAt: string;
  updatedAt: string;
}

/** GET /api/forge/options — what the forge can start from. Free. */
export interface ForgeOptions {
  competencies: { id: BqCompetency; label: string; gap: 'open' | 'partial' | null }[];
  /** resume-builder's candidates[] (not captured yet). */
  candidates: { title: string; note: string; fits: string[] }[];
  /** Existing stories (to deepen one — the save is still a NEW draft). */
  stories: { id: string; title: string; status: string }[];
  /** The default competency: the first open gap, influence-without-authority otherwise. */
  defaultCompetency: BqCompetency;
  bank: { loaded: boolean; error?: string };
  recent: ForgeSessionView[];
  estimateUsd: number | null;
}

// -----------------------------------------------------------------------------
// The never-invent rule, deterministic half
// -----------------------------------------------------------------------------

/** Numeric tokens in text: "3,000", "90%", "$300", "5-10", "2.5x". Normalized to bare digits. */
export function numberTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = m[0].replace(/,/g, '').replace(/\.0+$/, '');
    if (n) out.push(n);
  }
  return out;
}

/**
 * The coach may only keep a number the candidate SAID. A draft field (numbers[],
 * or the story text) carrying a number absent from every answer is a coach
 * invention: the numbers[] entry is moved to unconfirmed[], and a prose field
 * with one gets an unconfirmed line asking the candidate to confirm it. Pure.
 */
export function enforceSaidNumbers(draft: StoryDraft, answers: readonly string[]): { draft: StoryDraft; moved: string[] } {
  const said = new Set(answers.flatMap(numberTokens));
  const unsaid = (t: string) => numberTokens(t).filter((n) => !said.has(n));
  const moved: string[] = [];
  const numbers: string[] = [];
  const unconfirmed = [...draft.unconfirmed];
  for (const n of draft.numbers) {
    if (unsaid(n).length) {
      moved.push(n);
      unconfirmed.push(`Confirm the number (the coach wrote it, you did not say it): ${n}`);
    } else numbers.push(n);
  }
  for (const field of ['situation', 'task', 'action', 'result', 'complication', 'title'] as const) {
    const bad = unsaid(draft[field]);
    if (bad.length) {
      moved.push(...bad);
      unconfirmed.push(`Confirm ${bad.join(', ')} in the ${field} — you did not say ${bad.length === 1 ? 'it' : 'them'}.`);
    }
  }
  return { draft: { ...draft, numbers, unconfirmed: [...new Set(unconfirmed)] }, moved };
}

/** Whether a draft has enough to save: what happened, what you did, how it ended. */
export function draftSavable(d: StoryDraft | null): boolean {
  return !!d && !!d.title.trim() && !!d.situation.trim() && !!d.action.trim() && !!d.result.trim();
}

// -----------------------------------------------------------------------------
// Retell cards
// -----------------------------------------------------------------------------

/** Two minutes spoken ≈ 250–350 words; the band the length check accepts. */
export const RETELL_WORDS = { min: 180, target: [250, 350] as const, max: 420 };

export function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export interface RetellLength {
  words: number;
  verdict: 'short' | 'ok' | 'long';
  note: string;
}

/** The dictated retell's length against the 2-minute band. Pure. */
export function retellLength(answer: string): RetellLength {
  const words = countWords(answer);
  if (words < RETELL_WORDS.min) {
    return { words, verdict: 'short', note: `${words} words — under a minute and a half spoken. Aim for ${RETELL_WORDS.target[0]}–${RETELL_WORDS.target[1]}: all three beats and the number.` };
  }
  if (words > RETELL_WORDS.max) {
    return { words, verdict: 'long', note: `${words} words — about ${Math.round(words / 150)} minutes spoken. Cut to ${RETELL_WORDS.target[1]} or fewer: lead with the result, drop the setup.` };
  }
  return { words, verdict: 'ok', note: `${words} words — about two minutes spoken.` };
}

/** The interviewer's phrasing when the coach gave none: the catalog's "Tell me about a time…" question. */
export function defaultRetellQuestion(c: BqCompetency): string {
  const q = BQ_QUESTIONS.find((x) => x.competency === c && /^Tell me about a time/i.test(x.text));
  return q?.text ?? 'Tell me about a time you had to bring other people along on a decision you could not make alone.';
}

/** The retell card: front = the question, back = three beats + the number. Pure. */
export function retellCard(draft: StoryDraft, competency: BqCompetency): { title: string; answer: string; summary: string } {
  const q = /^tell me about a time/i.test(draft.question.trim()) ? draft.question.trim() : defaultRetellQuestion(competency);
  const firstSentence = (t: string) => (t.match(/^[^.!?]+[.!?]?/)?.[0] ?? t).trim();
  const beats = (draft.beats.filter((b) => b.trim()).length >= 3
    ? draft.beats.filter((b) => b.trim())
    : [firstSentence(draft.result), firstSentence(draft.situation), firstSentence(draft.action)]
  ).slice(0, 3);
  const number = draft.numbers[0] ?? 'none confirmed yet — find one before you tell it';
  return {
    title: `2-minute retell: ${q}`,
    answer: [
      `Story: ${draft.title}.`,
      ...beats.map((b, i) => `${i + 1}) ${b.replace(/\s+/g, ' ').trim()}`),
      `The number: ${number}.`,
    ].join(' '),
    summary: `Retell "${draft.title}" in about two minutes (${RETELL_WORDS.target[0]}–${RETELL_WORDS.target[1]} words), result first.`,
  };
}

// -----------------------------------------------------------------------------
// Today: when the concept-rep step is a story-forge session instead
// -----------------------------------------------------------------------------

export interface ForgeDayInput {
  /** Local YYYY-MM-DD. */
  date: string;
  /** Open + partial story-bank gaps; null = unknown (bank never read). */
  openGaps: number | null;
  /** Days to the nearest loop with a behavioral or deep-dive round; null = none. */
  behavioralLoopDays: number | null;
  /** Already done today (whichever was done wins the day). */
  repDoneToday: boolean;
  forgeDoneToday: boolean;
}

/** Within this many days of a behavioral round, every other day is a forge day. */
export const FORGE_LOOP_DAYS = 7;

/**
 * The rule (Phase H4), in order:
 *   - whatever was already done today keeps the day (a rep → concept, a forge → forge)
 *   - a behavioral / deep-dive round within 7 days → every OTHER day is a forge day
 *   - open story gaps (or unknown) → every THIRD day
 *   - no gaps → concept reps every day
 * Day parity is from the local date, so it is stable for the whole day. Pure.
 */
export function forgeDay(i: ForgeDayInput): boolean {
  if (i.forgeDoneToday) return true;
  if (i.repDoneToday) return false;
  const n = Math.floor(Date.parse(`${i.date}T00:00:00Z`) / 86_400_000);
  if (i.behavioralLoopDays !== null && i.behavioralLoopDays >= 0 && i.behavioralLoopDays <= FORGE_LOOP_DAYS) return n % 2 === 0;
  if (i.openGaps === null || i.openGaps > 0) return n % 3 === 0;
  return false;
}

export function isForgeCompetency(x: unknown): x is BqCompetency {
  return typeof x === 'string' && (BQ_COMPETENCIES as readonly string[]).includes(x);
}
