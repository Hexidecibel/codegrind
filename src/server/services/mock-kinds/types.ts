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
import type { MockGrade, MockObservation, MockPlan, MockState } from '../../../shared/mock.js';
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
}

export interface MockPrep {
  plan: MockPlan;
  /** Grader-only text, frozen into state.graderContext. */
  graderContext: string;
  /** Why each concept was weighted up (the start card's preview). */
  reasons: Record<string, string[]>;
}
