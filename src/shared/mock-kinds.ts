// =============================================================================
// mock-kinds — what each KIND of mock interview is, as the client may know it
// =============================================================================
// A mock interview is a kind (system design today; behavioral and live coding
// next) run through ONE set of plumbing: turns, the clock, End & grade, gaps →
// drill cards. Everything that differs per kind and is safe to ship to the
// browser lives here — the stages and their chips, the concept vocabulary and
// its labels, the prompt catalog, the clock and the turn cap, the start-card
// copy. The prompts, tool schemas and rubric the MODEL sees are server-side, in
// src/server/services/mock-kinds/.
//
// Stages and concepts are plain strings on the wire (MockStage / MockConcept)
// and CLOSED per kind: a value outside the kind's list is coerced or refused,
// never stored, exactly as the system-design vocabulary always was (sd.ts).
//
// Adding a kind: add its id to MOCK_KINDS, its entry to MOCK_KIND_INFO, and its
// spec to the server registry — the Record types make a missing half a compile
// error rather than a runtime 500.

import {
  SD_CONCEPTS,
  SD_STAGES,
  SD_STAGE_META,
  conceptLabel as sdConceptLabel,
} from './sd.js';
import { SD_PROMPTS, pickPrompt as pickSdPrompt, sdPrompt } from './sd-prompts.js';
import {
  BQ_COMPETENCIES,
  BQ_PROMPTS,
  BQ_STAGES,
  BQ_STAGE_META,
  competencyLabel,
} from './behavioral-questions.js';

/** The kinds a mock can be started as. */
export const MOCK_KINDS = ['system-design', 'behavioral'] as const;
export type MockKind = (typeof MOCK_KINDS)[number];
export const DEFAULT_MOCK_KIND: MockKind = 'system-design';

export function isMockKind(x: unknown): x is MockKind {
  return typeof x === 'string' && (MOCK_KINDS as readonly string[]).includes(x);
}

/** Kinds the start card shows, disabled, until they ship. */
export const UPCOMING_MOCK_KINDS: readonly { id: string; label: string }[] = [
  { id: 'coding', label: 'Coding' },
];

/** A stage id, closed per kind (MockKindInfo.stages). */
export type MockStage = string;
/** A concept id, closed per kind (MockKindInfo.concepts). */
export type MockConcept = string;

/** One entry in a kind's prompt catalog, as the start card lists it. */
export interface MockPrompt {
  id: string;
  title: string;
  /** What the interviewer opens with. */
  brief: string;
  /** A system / story / problem the candidate has done before (the warm-up pool). */
  familiar: boolean;
}

export interface MockKindInfo {
  kind: MockKind;
  /** "System design" — the switcher label, and the title of a mock with no prompt. */
  label: string;
  /** In interview order. The order is used: a forward jump past one is a skip. */
  stages: readonly MockStage[];
  stageMeta: Readonly<Record<MockStage, { label: string; goal: string }>>;
  concepts: readonly MockConcept[];
  conceptLabel(c: MockConcept): string;
  /** The static catalog behind GET /api/mock/prompts?kind=. */
  prompts: readonly MockPrompt[];
  promptById(id: string): MockPrompt | null;
  /** The server's choice when the candidate did not pick (`recentIds` newest first). */
  pickPrompt(recentIds: readonly string[], rand?: () => number): MockPrompt;
  /** The interview clock. Past it the interviewer is told to wrap up. */
  minutes: number;
  /** Candidate turns per mock. A cap, not a target. */
  turnCap: number;
  /** Turns in a typical mock, for the start card's estimate. */
  typicalTurns: number;
  /**
   * The shape behind estimateMockCost (tokens): the frozen prefix, what each
   * exchange adds to the history, an interviewer reply's output, the grader's
   * fixed input (system + tool + rubric + anything the kind appends) and its
   * output including thinking.
   */
  cost: { prefix: number; perExchange: number; replyOut: number; gradeFixed: number; gradeOut: number };
  /**
   * The start card asks GET /api/mock/plan before starting (behavioral: the
   * planned competencies and whether the story bank loaded) and sends the plan
   * back with the start request.
   */
  planned?: boolean;
  /** The grader's transcript shows each candidate turn's word count (behavioral: answer length). */
  wordCounts?: boolean;
  /** Start-card copy. */
  start: {
    blurb: string;
    /** The hint under the prompt picker when "Pick one for me" is selected. */
    pickHint: string;
    /** Appended to a familiar prompt's option. */
    familiarTag: string;
  };
}

const SYSTEM_DESIGN: MockKindInfo = {
  kind: 'system-design',
  label: 'System design',
  stages: SD_STAGES,
  stageMeta: SD_STAGE_META,
  concepts: SD_CONCEPTS,
  conceptLabel: (c) => sdConceptLabel(c as (typeof SD_CONCEPTS)[number]),
  prompts: SD_PROMPTS,
  promptById: sdPrompt,
  pickPrompt: pickSdPrompt,
  // MOCK_MINUTES / MOCK_TURN_CAP in mock.ts predate kinds and are now read from
  // here. This module must not import mock.ts, which imports it.
  minutes: 45,
  turnCap: 40,
  typicalTurns: 25,
  cost: { prefix: 4000, perExchange: 320, replyOut: 400, gradeFixed: 3000, gradeOut: 8000 },
  start: {
    blurb:
      'A system-design interview over chat. The interviewer asks, pushes and moves you through the stages; ask it to explain anything and it will break off to teach, then pick up where you were. At the end it grades every stage at the level you choose and gives you drills.',
    pickHint:
      'Your first mock starts on a system you have built before; after that, one you have not done recently.',
    familiarTag: ' (one you have built)',
  },
};

const BEHAVIORAL_PROMPT = BQ_PROMPTS[0];

const BEHAVIORAL: MockKindInfo = {
  kind: 'behavioral',
  label: 'Behavioral',
  stages: BQ_STAGES,
  stageMeta: BQ_STAGE_META,
  concepts: BQ_COMPETENCIES,
  conceptLabel: competencyLabel,
  prompts: BQ_PROMPTS,
  promptById: (id) => BQ_PROMPTS.find((p) => p.id === id) ?? null,
  pickPrompt: () => BEHAVIORAL_PROMPT,
  minutes: 35,
  turnCap: 30,
  // intro (2) + four questions × (answer + ~3 probes) + wrap (1).
  typicalTurns: 19,
  // Answers are long (~250–350 words; probe answers shorter) so an exchange adds
  // more than a system-design one; the grader also reads the frozen story bank
  // (~7k tokens for the live 8-story bank). Measured prefix: ~2.7k.
  cost: { prefix: 3000, perExchange: 450, replyOut: 350, gradeFixed: 11500, gradeOut: 9000 },
  planned: true,
  wordCounts: true,
  start: {
    blurb:
      'A Staff behavioral interview over chat: tell me about yourself, four questions probed two to four levels deep, then your questions. The interviewer has not seen your stories; the grader has — it checks story choice, STAR, scope, "I" vs "we", numbers and length against your story bank, and turns each miss into a drill card.',
    pickHint: 'Competencies are weighted toward your open story-bank gaps, weak past grades, and influence without authority.',
    familiarTag: '',
  },
};

export const MOCK_KIND_INFO: Readonly<Record<MockKind, MockKindInfo>> = {
  'system-design': SYSTEM_DESIGN,
  behavioral: BEHAVIORAL,
};

/** The registry entry for a kind. An unknown kind (an old or hand-edited row) reads as system design. */
export function mockKindInfo(kind: string | null | undefined): MockKindInfo {
  return isMockKind(kind) ? MOCK_KIND_INFO[kind] : MOCK_KIND_INFO[DEFAULT_MOCK_KIND];
}

export function isMockStage(kind: MockKind, x: unknown): x is MockStage {
  return typeof x === 'string' && MOCK_KIND_INFO[kind].stages.includes(x);
}

export function isMockConcept(kind: MockKind, x: unknown): x is MockConcept {
  return typeof x === 'string' && MOCK_KIND_INFO[kind].concepts.includes(x);
}

/** A prompt's title, or null when the id is not in that kind's catalog. */
export function mockPromptTitle(kind: string | null | undefined, promptId: string | null | undefined): string | null {
  if (!promptId) return null;
  return mockKindInfo(kind).promptById(promptId)?.title ?? null;
}

/**
 * A concept label when the kind is not at hand (a drill card). Concept ids are
 * looked up in every kind; an id no kind knows is de-hyphenated.
 */
export function anyConceptLabel(c: MockConcept): string {
  for (const k of MOCK_KINDS) {
    if (MOCK_KIND_INFO[k].concepts.includes(c)) return MOCK_KIND_INFO[k].conceptLabel(c);
  }
  return c.replace(/-/g, ' ');
}

/** A stage's label in a kind, falling back to the raw id. */
export function stageLabel(kind: string | null | undefined, s: MockStage): string {
  return mockKindInfo(kind).stageMeta[s]?.label ?? s;
}
