// =============================================================================
// mock-kinds/types — what a kind of mock must supply to the shared plumbing
// =============================================================================
// The plumbing (mock.service, mock.state, llm.mock) is kind-blind: it renders
// turns, keeps the clock, makes the two model calls and stores what comes back.
// Everything it cannot know — what the interviewer is told, the tool schemas,
// the rubric, how the first message is framed, how a model answer is coerced
// into the kind's closed vocabulary — comes from a spec.
//
// Specs hold PROMPTS AND SCHEMAS ONLY. No spec calls a model; llm.mock.ts stays
// the one seam, and llm.structural.test.ts holds these files to the same
// vendor-free rules as it.

import type { MockKind, MockKindInfo, MockPrompt, MockStage } from '../../../shared/mock-kinds.js';
import type {
  MockCodingState,
  MockGrade,
  MockObservation,
  MockPlan,
  MockState,
} from '../../../shared/mock.js';
import type { Difficulty, ProblemRecord, RunResult, Topic } from '../../../shared/types.js';
import type { ConceptSignal, MockLevel } from '../../../shared/sd.js';
import type { ToolSpec } from '../llm.types.js';
import type { InterviewerReply } from '../mock.state.js';

export interface MockKindSpec {
  kind: MockKind;
  /** The client-safe half: stages, concepts, prompts, clock, cap. */
  info: MockKindInfo;

  // --- the interviewer ------------------------------------------------------
  /** A constant: the same bytes for every mock and turn of this kind (the cache). */
  interviewerSystem: string;
  interviewerTool: ToolSpec;
  /**
   * Kinds that plan before the first call (behavioral: read the story bank,
   * pick the competencies). Async, and the only spec hook allowed I/O — never a
   * model call. Its result is frozen into the mock (state.plan,
   * state.graderContext) and handed to buildContext.
   */
  prepare?(args: MockPrepareArgs): Promise<MockPrep>;
  /** The frozen first user message for a mock (stored as mocks.context). */
  buildContext(prompt: MockPrompt, level: MockLevel, prep?: MockPrep): string;
  /** The `[server: …]` line added once the clock or the cap is nearly spent. */
  nearlyOutNote: string;

  // --- the grader -----------------------------------------------------------
  gradeSystem: string;
  /** Strict schema first; `lean` is the one retry after a structural failure. */
  gradeTool: ToolSpec;
  gradeToolLean: ToolSpec;
  /** The rubric block for a level, rendered once and byte-stable. */
  rubric(level: MockLevel): string;
  /**
   * Extra text for the GRADER only, appended after the rubric (behavioral: the
   * story bank frozen at start). Absent or null = nothing appended, which keeps
   * the system-design grade request byte-identical.
   */
  graderContext?(state: MockState): string | null;
  /**
   * Async, before the grade call, I/O allowed (never a model): settle what the
   * grader must be told that the turns did not record (coding: run the final
   * code against the hidden tests unless the last Submit already did). Returns
   * the state to store and grade from.
   */
  finalize?(state: MockState, end: { code?: string }, deps: MockFinalizeDeps): Promise<MockState>;
  /**
   * After a successful grade: attach server-known facts to it and make the
   * kind's deliberate side effects (coding: a missed pattern puts the problem
   * on the review queue). Returns the grade and state to store.
   */
  afterGrade?(state: MockState, grade: MockGrade, deps: MockAfterGradeDeps): { grade: MockGrade; state: MockState };

  // --- coercion into the kind's closed vocabulary ---------------------------
  /** `fallbackStage`: an unknown stage is "no change", never a jump. */
  coerceReply(input: Record<string, unknown>, fallbackStage: MockStage): InterviewerReply;
  coerceObservations(raw: unknown): MockObservation[];
  coerceGrade(input: Record<string, unknown>, level: MockLevel, degraded: boolean): MockGrade;
}

export interface MockPrepareArgs {
  level: MockLevel;
  /** MockStartRequest.plan, unvalidated. */
  requested: unknown;
  /** Concept observations from this kind's recent grades, newest first. */
  history: { concept: string; signal: ConceptSignal }[];
  /** Question ids this kind asked recently. */
  recentQuestionIds: string[];
  rand?: () => number;
  fetchImpl?: typeof fetch;
  /** MockStartRequest.coding (coding) or .project (project deep-dive), unvalidated. */
  options?: unknown;
  /**
   * Coding: the problem source and the skill state, injected by mock.service so
   * the spec itself never touches the bank (which may call a model to generate).
   */
  coding?: {
    weakestTopic(): Topic;
    fetchProblem(topic: Topic, difficulty: Difficulty): Promise<ProblemRecord>;
  };
}

export interface MockFinalizeDeps {
  runHidden(problemId: string, code: string): Promise<RunResult>;
}

export interface MockAfterGradeDeps {
  /** Put a problem on the grind review queue (the existing ladder). */
  enqueueReview(problemId: string): void;
}

export interface MockPrep {
  /** Planned kinds (behavioral). */
  plan?: MockPlan;
  /** Grader-only text, frozen into state.graderContext. */
  graderContext: string;
  /** Why each concept was weighted up (the start card's preview). */
  reasons: Record<string, string[]>;
  /** Coding: the problem the mock runs on, frozen into state.coding. */
  coding?: MockCodingState;
  /** Overrides the stored mock's prompt text (coding: the problem title). */
  brief?: string;
  /** Coding: the full problem, for buildContext only (never stored on the state). */
  problem?: ProblemRecord;
  /** Project deep-dive: the chosen project (`line` is what the interviewer is told). */
  project?: { source: 'story' | 'resume' | 'typed'; id: string | null; title: string; line: string };
}

/** A prepare hook refusing the start request's input (a bad project choice): a 400, not a 502. */
export class MockPrepError extends Error {}
