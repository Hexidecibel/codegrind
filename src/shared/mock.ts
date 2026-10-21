// =============================================================================
// mock — the wire contract for mock interviews, plus the limits and the price
// =============================================================================
// Shared by routes/mock.ts and the Mock page. Everything a mock persists is in
// here, because Phase 2 (knowledge state, drills, retire-after-3) folds over
// exactly these shapes: per-turn `observations` and the grade's
// `conceptObservations` are the raw events that fold will read.

import type { MockGap } from './gap-cards.js';
import type { ConceptSignal, GapType, InterviewerMode, MockLevel } from './sd.js';
import { MOCK_KIND_INFO, type MockConcept, type MockKind, type MockStage } from './mock-kinds.js';
import type { CodingMockOptions } from './coding-mock.js';
import type { DdProjectChoice, DdProjectSource } from './deep-dive.js';

export type { MockConcept, MockKind, MockStage } from './mock-kinds.js';

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
  concept: MockConcept;
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
  stage: MockStage;
  createdAt: string;
  /** Interviewer turns only. */
  mode?: InterviewerMode;
  /** A teach turn's lesson subject, or an offer's. */
  teach?: { concept: MockConcept; gapSummary: string } | null;
  /** Candidate turns only: which button, if any. */
  action?: MockAction;
}

export interface MockState {
  stage: MockStage;
  covered: MockStage[];
  skipped: MockStage[];
  /** ISO; the 45-minute clock runs from here. */
  startedAt: string;
  /** Candidate turns taken. The cap counts these. */
  candidateTurns: number;
  /** The concept the interviewer last offered to teach, until answered. */
  pendingOffer: MockConcept | null;
  /** Concepts taught so far, in order. */
  taught: MockConcept[];
  /** A skip the next user message must announce, then clear. */
  pendingSkipNote: MockStage[];
  /** Set once the END control note has been sent. */
  endNoteSent: boolean;
  /** Kinds that plan at start (behavioral): what was planned, frozen with the mock. */
  plan?: MockPlan;
  /**
   * SERVER ONLY — stripped from MockView. Text the GRADER gets on top of the
   * rubric (behavioral: the story bank as it was at start). Frozen here so the
   * grade judges the bank the mock was run against, and the interviewer never
   * sees it.
   */
  graderContext?: string;
  /** Coding only: the problem, what the interviewer last saw of the editor, and the test results. */
  coding?: MockCodingState;
  /** Project deep-dive: the project the mock drills into, as chosen at start. */
  project?: { source: DdProjectSource; id: string | null; title: string };
}

/** One hidden-test run inside a coding mock (a mock Submit, or the run at End). */
export interface MockCodeResult {
  verdict: string;
  passed: number;
  total: number;
  /** Names of failing hidden tests, at most a handful. Never the expected values. */
  failing: string[];
  /** Hash of the code that ran. */
  codeHash: string;
  at: string;
  /** The sandbox could not run it at all. */
  error?: string;
}

/**
 * A coding mock's own state — deliberately NOT `plan` (behavioral's planner
 * reads past plans of its own kind; a coding mock has no plan).
 */
export interface MockCodingState {
  problemId: string;
  title: string;
  topic: string;
  difficulty: string;
  pattern: string;
  language: string;
  /** How the problem was chosen: the weakest topic, or the start card's pick. */
  chosenBy: 'weakest' | 'pick';
  /** Hash of the starter code: End never runs code nobody wrote. */
  starterHash: string;
  /**
   * Hash of the editor as the interviewer last saw it (the starter code at
   * start). A turn shows the editor again only when this changes.
   */
  codeHash: string;
  /** The code the interviewer last saw — run at End when nothing was submitted. */
  lastCode: string | null;
  /** Hash of the last [run] line shown, so the same result is never repeated. */
  runHash: string | null;
  /** Mock Submits so far, and the latest one's hidden-test result. */
  submits: number;
  lastSubmit: MockCodeResult | null;
  /** The result the grade used: the last Submit, or the code run at End. */
  final?: (MockCodeResult & { source: 'submit' | 'end' }) | null;
  /** Set once the grade put the problem on the review queue. */
  reviewQueued?: boolean;
}

/** Whether the story bank (resume-builder) loaded when the mock started. */
export interface StoryBankStatus {
  loaded: boolean;
  stories: number;
  confirmed: number;
  /** Open or partly covered story-bank gaps, as resume-builder names them. */
  openGaps: string[];
  /** Why it did not load. */
  error?: string;
}

/** A planned mock: which concept each stage targets, and with what question. */
export interface MockPlan {
  items: { stage: MockStage; concept: MockConcept; questionId: string; question: string }[];
  storyBank?: StoryBankStatus;
}

/** GET /api/mock/plan?kind= — the start card's preview. No questions: those stay a surprise. */
export interface MockPlanPreview {
  kind: MockKind;
  concepts: MockConcept[];
  /** Why each concept was weighted up, by concept ("open story-bank gap", …). */
  reasons: Record<MockConcept, string[]>;
  storyBank: StoryBankStatus | null;
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
  stage: MockStage;
  /** 1..4 against the rubric anchors. 0 = not reached. */
  score: number;
  evidence: string;
  atLevel: boolean;
  staffWouldAdd: string;
  principalWouldAdd: string;
}

export interface MockDrill {
  concept: MockConcept;
  prompt: string;
  why: string;
}

export type MockVerdict = 'below' | 'at' | 'above';

/**
 * A gap the GRADER found in the transcript that the turn-by-turn capture missed
 * (the interviewer handed over a fact mid-nudge and did not record it). Stored
 * as a drill card like any other gap.
 */
export interface MockGradeGap {
  concept: MockConcept;
  type: GapType;
  title: string;
  answer: string;
  /** The interviewer turn that supplied it, or null. */
  turn: number | null;
}

export interface MockGrade {
  level: MockLevel;
  verdict: MockVerdict;
  summary: string;
  stages: MockStageGrade[];
  skipped: MockStage[];
  gapsTaught: { concept: MockConcept; summary: string }[];
  conceptObservations: MockObservation[];
  drills: MockDrill[];
  /** Gaps the grader added on top of the recorded ones. Absent on Phase-1 grades. */
  gaps?: MockGradeGap[];
  /** True when the second, simpler schema had to be used. */
  degraded?: boolean;
  /** Behavioral: one entry per question stage the interview reached. */
  questions?: MockQuestionGrade[];
  /** Behavioral: competencies with no good story — capture one in resume-builder. */
  storyGaps?: { concept: MockConcept; note: string }[];
  /** Coding: the grader's read of the solution, plus the hidden-test result it was given. */
  coding?: MockCodingGrade;
  /** Project deep-dive: the rubric dimensions, 1–4 each, with one line of evidence. */
  dimensions?: { concept: MockConcept; score: number; note: string }[];
  /**
   * Project deep-dive: claims checked against the story bank and master resume —
   * unverified (not in confirmed material), contradicted framing, or an open
   * question stated as fact. Empty when everything said was confirmed.
   */
  fidelity?: { claim: string; status: 'unverified' | 'contradicted' | 'open-question'; note: string }[];
}

export interface MockCodingGrade {
  /** The pattern itself was the miss: not recognised without the interviewer's help. */
  patternMissed: boolean;
  patternNote: string;
  /** As the candidate stated it, and the optimal. */
  complexityStated: string;
  complexityOptimal: string;
  /** Hidden tests at the end (filled by the server, never the model). Null = never ran. */
  tests: (MockCodeResult & { source: 'submit' | 'end' }) | null;
  /** True when the problem was put on the review queue because the pattern was missed. */
  reviewQueued: boolean;
}

/** One behavioral question, graded. */
export interface MockQuestionGrade {
  stage: MockStage;
  concept: MockConcept;
  /** As the interviewer asked it. */
  question: string;
  /** The story-bank id the answer told, or null (none fits / bank unavailable / a new story). */
  storyId: string | null;
  storyFit: 'strong' | 'ok' | 'weak' | 'none';
  star: { situation: boolean; task: boolean; action: boolean; result: boolean };
  /** Scope and impact against the level's bar, 1–4. */
  scope: number;
  ownership: 'i' | 'we' | 'mixed';
  quantified: boolean;
  /** The candidate's main answer, in words (from the transcript's counts). */
  words: number;
  length: 'short' | 'ok' | 'long';
  /** Against the bank: numbers left out, claims past a caveat, open questions stated as fact. '' when clean. */
  fidelity: string;
  /** The one change that would most improve this answer. */
  fix: string;
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
  /** Every gap recorded for this mock — each one is also a drill card. */
  gaps: MockGap[];
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
  /** Absent = system design. */
  kind?: MockKind;
  /** Planned kinds: the concepts the start card previewed. Invalid or absent = the server picks. */
  plan?: { concepts: MockConcept[] };
  level?: MockLevel;
  /** A prompt-bank id. Absent = the server picks. */
  promptId?: string;
  /** Coding: how to pick the problem. Absent = the weakest topic, medium. */
  coding?: CodingMockOptions;
  /** Project deep-dive: which project. Required for that kind. */
  project?: DdProjectChoice;
}

export interface MockTurnRequest {
  /** The seq of the last turn the client has. A mismatch is a 409. */
  expectedSeq: number;
  content: string;
  action?: MockAction;
  /** For teach_me: which concept, when the client knows it (an offer). */
  concept?: MockConcept;
  /** Coding: the editor right now. Shown to the interviewer only when it changed. */
  code?: string;
  /** Coding: the newest Run/Submit result the interviewer has not heard about. */
  lastRun?: MockRunSummary;
}

/** A one-line Run or Submit result, as the client summarises it for the interviewer. */
export interface MockRunSummary {
  kind: 'run' | 'submit';
  verdict: string;
  passed: number;
  total: number;
  /** "sample 2: expected 5, got 4" — the first failure, short. Never for hidden tests' values. */
  firstFailure?: string;
}

/** POST /api/mock/:id/end body. */
export interface MockEndRequest {
  /** Coding: the editor at End — run against the hidden tests unless it was just submitted. */
  code?: string;
}

/** NDJSON lines from POST /api/mock/:id/end. */
export type MockEndEvent =
  | { type: 'wrapup'; status: 'grading'; candidateTurns: number }
  | { type: 'grade'; grade: MockGrade; usage: MockUsage }
  | { type: 'error'; error: string; detail?: string };

// -----------------------------------------------------------------------------
// Limits
// -----------------------------------------------------------------------------

/**
 * Candidate turns per SYSTEM-DESIGN mock. A cap, not a target — real mocks end
 * well before it. Per kind in MOCK_KIND_INFO; these are the system-design values.
 */
export const MOCK_TURN_CAP = MOCK_KIND_INFO['system-design'].turnCap;
/** The system-design interview clock. Past it the interviewer is told to wrap up. */
export const MOCK_MINUTES = MOCK_KIND_INFO['system-design'].minutes;
/** How long before the end the interviewer is warned. */
export const MOCK_WARN_MINUTES = 5;
/** The longest answer accepted in one turn, in characters. */
// Dictated answers (Wispr Flow into the textarea) run long; 8000 is ~1,300
// spoken words — several minutes of talking, well past any one turn.
export const MOCK_MAX_ANSWER_CHARS = 8000;

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
  // The `small` role's default (Phase H). Prompts up to 100K tokens, which
  // every small call is by two orders of magnitude.
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite1h: 0.2 },
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
 * The assumptions, all deliberately on the generous side (system-design
 * numbers below; each kind's are in MockKindInfo.cost — behavioral answers are
 * about twice as long and its grader also reads the story bank):
 *   - a frozen prefix (tools + system + context) of ~4,000 tokens
 *   - each exchange adds ~320 tokens to the history (answer + reply)
 *   - each interviewer reply costs ~400 output tokens (the tool call carries
 *     observations as well as the line it says)
 *   - the grade reads the whole transcript once and writes ~8,000 tokens
 *     including its own thinking
 */
export function estimateMockCost(
  turns: number,
  price: ModelPrice = MODEL_PRICES['claude-sonnet-5'],
  kind: MockKind = 'system-design'
): { usd: number; tokens: TokenCounts } {
  // Per kind (MockKindInfo.cost); the system-design shape is the original one.
  const shape = MOCK_KIND_INFO[kind].cost;
  const PREFIX = shape.prefix;
  const PER_EXCHANGE = shape.perExchange;
  const REPLY_OUT = shape.replyOut;
  const GRADE_SYSTEM = shape.gradeFixed;
  const GRADE_OUT = shape.gradeOut;
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
