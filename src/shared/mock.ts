// =============================================================================
// mock — the wire contract for mock interviews, plus the limits and the price
// =============================================================================
// Shared by routes/mock.ts and the Mock page. Everything a mock persists is in
// here, because Phase 2 (knowledge state, drills, retire-after-3) folds over
// exactly these shapes: per-turn `observations` and the grade's
// `conceptObservations` are the raw events that fold will read.

import type {
  ConceptSignal,
  InterviewerMode,
  MockLevel,
  SdConcept,
  SdStage,
} from './sd.js';

export type MockKind = 'system-design';

/**
 * `grading` is held only while POST /end is in flight. `grade_failed` keeps the
 * transcript and lets End & grade be pressed again — a grade that failed must
 * not cost the 30 turns in front of it.
 */
export type MockStatus = 'active' | 'grading' | 'graded' | 'grade_failed' | 'abandoned';

export type MockTurnRole = 'interviewer' | 'candidate';

/**
 * `control` is a candidate turn that is only a button press (Teach me, I'm
 * stuck, Move on, Keep going) with no typed text.
 */
export type MockTurnKind =
  | 'answer'
  | 'control'
  | 'question'
  | 'nudge'
  | 'offer'
  | 'teach'
  | 'wrap_up';

/** The candidate's buttons. `answer` is plain typing. */
export const MOCK_ACTIONS = ['answer', 'teach_me', 'stuck', 'move_on', 'keep_going'] as const;
export type MockAction = (typeof MOCK_ACTIONS)[number];

export interface MockObservation {
  concept: SdConcept;
  signal: ConceptSignal;
  note: string;
}

export interface MockTurn {
  seq: number;
  role: MockTurnRole;
  kind: MockTurnKind;
  /** What was said. For a candidate turn, what they typed (may be '' for a button). */
  content: string;
  /** The stage this turn belongs to. */
  stage: SdStage;
  createdAt: string;
  /** Interviewer turns only. */
  mode?: InterviewerMode;
  /** A teach turn's lesson subject, or an offer's. */
  teach?: { concept: SdConcept; gapSummary: string } | null;
  /** Candidate turns only: which button, if any. */
  action?: MockAction;
}

export interface MockState {
  stage: SdStage;
  covered: SdStage[];
  skipped: SdStage[];
  /** ISO; the 45-minute clock runs from here. */
  startedAt: string;
  /** Candidate turns taken. The cap counts these. */
  candidateTurns: number;
  /** The concept the interviewer last offered to teach, until answered. */
  pendingOffer: SdConcept | null;
  /** Concepts taught so far, in order. */
  taught: SdConcept[];
  /** A skip the next user message must announce, then clear. */
  pendingSkipNote: SdStage[];
  /** Set once the END control note has been sent. */
  endNoteSent: boolean;
}

export interface MockUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Null when a call was served by a model with no known price (a local endpoint). */
  costUsd: number | null;
  /** The model(s) that actually answered, as reported by the endpoint. */
  models: string[];
}

export interface MockStageGrade {
  stage: SdStage;
  /** 1..4 against the rubric anchors. 0 = not reached. */
  score: number;
  evidence: string;
  atLevel: boolean;
  staffWouldAdd: string;
  principalWouldAdd: string;
}

export interface MockDrill {
  concept: SdConcept;
  prompt: string;
  why: string;
}

export type MockVerdict = 'below' | 'at' | 'above';

export interface MockGrade {
  level: MockLevel;
  verdict: MockVerdict;
  summary: string;
  stages: MockStageGrade[];
  skipped: SdStage[];
  gapsTaught: { concept: SdConcept; summary: string }[];
  conceptObservations: MockObservation[];
  drills: MockDrill[];
  /** True when the second, simpler schema had to be used. */
  degraded?: boolean;
}

export interface MockView {
  id: string;
  kind: MockKind;
  level: MockLevel;
  promptId: string | null;
  prompt: string;
  status: MockStatus;
  state: MockState;
  usage: MockUsage;
  turns: MockTurn[];
  grade: MockGrade | null;
  createdAt: string;
  endedAt: string | null;
  limits: { turnCap: number; minutes: number };
}

export interface MockSummary {
  id: string;
  kind: MockKind;
  level: MockLevel;
  promptTitle: string;
  status: MockStatus;
  candidateTurns: number;
  verdict: MockVerdict | null;
  costUsd: number | null;
  createdAt: string;
}

export interface MockListResponse {
  mocks: MockSummary[];
}

export interface MockStartRequest {
  level?: MockLevel;
  /** A prompt-bank id. Absent = the server picks. */
  promptId?: string;
}

export interface MockTurnRequest {
  /** The seq of the last turn the client has. A mismatch is a 409. */
  expectedSeq: number;
  content: string;
  action?: MockAction;
  /** For teach_me: which concept, when the client knows it (an offer). */
  concept?: SdConcept;
}

/** NDJSON lines from POST /api/mock/:id/end. */
export type MockEndEvent =
  | { type: 'wrapup'; status: 'grading'; candidateTurns: number }
  | { type: 'grade'; grade: MockGrade; usage: MockUsage }
  | { type: 'error'; error: string; detail?: string };

// -----------------------------------------------------------------------------
// Limits
// -----------------------------------------------------------------------------

/** Candidate turns per mock. A cap, not a target — real mocks end well before it. */
export const MOCK_TURN_CAP = 40;
/** The interview clock. Past it the interviewer is told to wrap up. */
export const MOCK_MINUTES = 45;
/** How long before the end the interviewer is warned. */
export const MOCK_WARN_MINUTES = 5;
/** The longest answer accepted in one turn, in characters. */
export const MOCK_MAX_ANSWER_CHARS = 6000;

// -----------------------------------------------------------------------------
// Price
// -----------------------------------------------------------------------------
// Per million tokens, Anthropic first-party rates (checked 2026-10-15 against
// the Claude API reference). Cache READS are 0.1x input; cache WRITES are 1.25x
// input for a 5-minute entry and 2x for a 1-hour entry. The mock conversation
// cache is 1-hour (see llm.types.cacheConversation), so writes are priced at 2x.
// The grader's call has no conversation marker and writes its system at 1.25x;
// that difference is a fraction of a cent and is not modelled.
//
// Keyed on the model id the ENDPOINT REPORTED, so a router that substitutes a
// model is priced as what actually ran. An unknown id is `null`, never a guess.

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite1h: number;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite1h: 4 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite1h: 4 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite1h: 10 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite1h: 8 },
};

export function priceFor(model: string): ModelPrice | null {
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  // A dated snapshot id ("claude-sonnet-5-20260…") is the same model.
  const base = Object.keys(MODEL_PRICES)
    .sort((a, b) => b.length - a.length)
    .find((k) => model.startsWith(`${k}-2`));
  return base ? MODEL_PRICES[base] : null;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Dollars for one call's usage, or null for an unpriced model. */
export function costOf(model: string, t: TokenCounts): number | null {
  const p = priceFor(model);
  if (!p) return null;
  return (
    (t.inputTokens * p.input +
      t.outputTokens * p.output +
      t.cacheReadTokens * p.cacheRead +
      t.cacheWriteTokens * p.cacheWrite1h) /
    1_000_000
  );
}

/**
 * A pre-flight estimate for the start card, from the shape of a mock rather
 * than from a measurement. bin/mock-dry-run --dry-run prints the same model
 * turn by turn; the first real mock's `usage` is what replaces it.
 *
 * The assumptions, all deliberately on the generous side:
 *   - a frozen prefix (tools + system + context) of ~4,000 tokens
 *   - each exchange adds ~320 tokens to the history (answer + reply)
 *   - each interviewer reply costs ~400 output tokens (the tool call carries
 *     observations as well as the line it says)
 *   - the grade reads the whole transcript once and writes ~8,000 tokens
 *     including its own thinking
 */
export function estimateMockCost(
  turns: number,
  price: ModelPrice = MODEL_PRICES['claude-sonnet-5']
): { usd: number; tokens: TokenCounts } {
  const PREFIX = 4000;
  const PER_EXCHANGE = 320;
  const REPLY_OUT = 400;
  const GRADE_SYSTEM = 3000;
  const GRADE_OUT = 8000;
  let cacheRead = 0;
  let cacheWrite = PREFIX; // the opening call writes the whole frozen prefix
  let output = REPLY_OUT;
  for (let i = 1; i <= turns; i++) {
    cacheRead += PREFIX + PER_EXCHANGE * (i - 1);
    cacheWrite += PER_EXCHANGE;
    output += REPLY_OUT;
  }
  const gradeInput = GRADE_SYSTEM + PER_EXCHANGE * turns;
  const tokens: TokenCounts = {
    inputTokens: gradeInput,
    outputTokens: output + GRADE_OUT,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
  const usd =
    (tokens.inputTokens * price.input +
      tokens.outputTokens * price.output +
      tokens.cacheReadTokens * price.cacheRead +
      tokens.cacheWriteTokens * price.cacheWrite1h) /
    1_000_000;
  return { usd, tokens };
}
