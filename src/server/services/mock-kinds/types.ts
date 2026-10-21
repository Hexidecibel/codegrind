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
import type { MockGrade, MockObservation } from '../../../shared/mock.js';
import type { MockLevel } from '../../../shared/sd.js';
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
  /** The frozen first user message for a mock (stored as mocks.context). */
  buildContext(prompt: MockPrompt, level: MockLevel): string;
  /** The `[server: …]` line added once the clock or the cap is nearly spent. */
  nearlyOutNote: string;

  // --- the grader -----------------------------------------------------------
  gradeSystem: string;
  /** Strict schema first; `lean` is the one retry after a structural failure. */
  gradeTool: ToolSpec;
  gradeToolLean: ToolSpec;
  /** The rubric block for a level, rendered once and byte-stable. */
  rubric(level: MockLevel): string;

  // --- coercion into the kind's closed vocabulary ---------------------------
  /** `fallbackStage`: an unknown stage is "no change", never a jump. */
  coerceReply(input: Record<string, unknown>, fallbackStage: MockStage): InterviewerReply;
  coerceObservations(raw: unknown): MockObservation[];
  coerceGrade(input: Record<string, unknown>, level: MockLevel, degraded: boolean): MockGrade;
}
