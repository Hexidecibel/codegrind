// =============================================================================
// llm.mock — the mock interviewer's two model calls
// =============================================================================
// Same contract as llm.service.ts, and llm.structural.test.ts holds this file to
// it too: prompts and schemas in, coerced answers out, and not one word about
// who answers. It is a separate file only because llm.service.ts is already the
// longest file in the server and these two calls share nothing with the eleven
// in there except the seam.
//
//   interviewerTurn   one per candidate turn (plus the opening). workhorse role,
//                     thinking OFF, conversation cache 'long'. The cheap call,
//                     made up to 41 times a mock.
//   gradeMock         once per mock. workhorse role, thinking ADAPTIVE, 16000
//                     tokens, the whole transcript, truncation is an error.
//
// ROLE: workhorse, not tutor. The user's decision — Sonnet, not Opus — and the
// arithmetic agrees: an interviewer reply is a short line plus a few
// observations, and the call happens dozens of times per mock.
//
// FORCED TOOL USE IS FINE ON THE CURRENT WORKHORSE, AND THAT WAS CHECKED. The
// planner's note said forced `tool_choice` 400s on Sonnet 5.5; that is true of
// Sonnet 5.5 (and Opus 5.5 / Fable 5.1), but the workhorse default is Sonnet 5
// (see llm.client.ts), which accepts it on the Claude API — with thinking off or
// adaptive (the Bedrock-only restriction does not apply here). Every other call
// in the app relies on the same fact, so a move to a 5.5 model is an app-wide
// migration, not a mock problem.
//
// KIND-BLIND. What the model is told — system prompts, tool schemas, rubric,
// coercion into a closed vocabulary — comes from the mock's kind spec
// (mock-kinds/). This file only makes the calls. The system-design constants are
// re-exported below under their old names for the tests and bin/mock-dry-run.
//
// CONTROL NOTES GO IN USER TURNS, NOT IN SYSTEM MESSAGES. Mid-conversation
// `role: "system"` messages exist on Sonnet 5.5 but NOT on Sonnet 5, and the
// seam has no such role anyway. Each kind's interviewer system prompt tells the
// model what `[server: …]` and `[control: …]` lines mean.

import { MOCK_LEVEL_LABEL, type MockLevel } from '../../shared/sd.js';
import type { MockConcept, MockKind, MockStage } from '../../shared/mock-kinds.js';
import type { MockGrade, MockObservation } from '../../shared/mock.js';
import { structured } from './llm.client.js';
import { LlmToolCallError, type CallMeta, type LlmMessage, type ToolSpec } from './llm.types.js';
import type { InterviewerReply } from './mock.state.js';
import { mockKindSpec } from './mock-kinds/index.js';
import { SYSTEM_DESIGN_SPEC } from './mock-kinds/system-design.js';

export { INTERVIEWER_SYSTEM, GRADE_SYSTEM } from './mock-kinds/system-design.js';
export const INTERVIEWER_TOOL: ToolSpec = SYSTEM_DESIGN_SPEC.interviewerTool;
export const EMIT_MOCK_GRADE_TOOL: ToolSpec = SYSTEM_DESIGN_SPEC.gradeTool;
/** The second rung: no strict validation, flatter taught list, no observations. */
export const EMIT_MOCK_GRADE_TOOL_LEAN: ToolSpec = SYSTEM_DESIGN_SPEC.gradeToolLean;
export const coerceReply = SYSTEM_DESIGN_SPEC.coerceReply;
export const coerceObservations = SYSTEM_DESIGN_SPEC.coerceObservations;
export const coerceGrade = SYSTEM_DESIGN_SPEC.coerceGrade;

// ===========================================================================
// 1. interviewerTurn
// ===========================================================================

export interface InterviewerResult {
  reply: InterviewerReply;
  observations: MockObservation[];
  meta: CallMeta;
}

/**
 * One interviewer reply. `messages` comes from mock.state.buildMessages and is
 * passed through untouched — its byte stability is the cache.
 */
export async function interviewerTurn(
  messages: LlmMessage[],
  currentStage: MockStage,
  kind: MockKind = 'system-design'
): Promise<InterviewerResult> {
  const spec = mockKindSpec(kind);
  const call = await structured({
    role: 'workhorse',
    // A reply is a few sentences plus observations; a lesson is ~250 words.
    // 3000 is several times the largest legitimate reply — it exists to stop a
    // runaway, not to be reached.
    maxTokens: 3000,
    // Off: the reply is short, the call is frequent, and thinking would compete
    // with the tool call for the same budget. It is also part of the cached
    // prefix on some models, so it must never vary between turns.
    thinking: 'off',
    cacheConversation: 'long',
    system: spec.interviewerSystem,
    tool: spec.interviewerTool,
    messages,
  });
  if (call.meta.stop === 'max_tokens') {
    throw new Error(
      `Interviewer reply truncated at max_tokens after ${call.meta.usage.outputTokens} output tokens.`
    );
  }
  let reply: InterviewerReply;
  try {
    reply = spec.coerceReply(call.input, currentStage);
  } catch (err) {
    if (err instanceof LlmToolCallError) throw new LlmToolCallError(err.message, call.meta);
    throw err;
  }
  return { reply, observations: spec.coerceObservations(call.input.observations), meta: call.meta };
}

// ===========================================================================
// 2. gradeMock
// ===========================================================================

export interface GradeInput {
  /** Absent = system design. */
  kind?: MockKind;
  level: MockLevel;
  promptTitle: string;
  brief: string;
  /** mock.state.renderTranscript output. */
  transcript: string;
  skipped: MockStage[];
  taught: MockConcept[];
  /** Gaps already recorded turn by turn, so the grader only adds what they missed. */
  recordedGaps?: { seq: number | null; type: string; title: string; summary: string }[];
}

export interface GradeResult {
  grade: MockGrade;
  /** One entry per call actually made (a retry is two). */
  metas: CallMeta[];
}

/**
 * Grade a finished mock. The retry ladder is coach()'s: ONE retry, on a
 * structurally broken answer only, with a simpler schema — never on truncation,
 * because a smaller schema does not buy back a budget.
 */
export async function gradeMock(input: GradeInput): Promise<GradeResult> {
  const spec = mockKindSpec(input.kind ?? 'system-design');
  const user = [
    `Level: ${MOCK_LEVEL_LABEL[input.level]}`,
    `Prompt: ${input.promptTitle} — ${input.brief}`,
    `Stages the server recorded as skipped: ${input.skipped.length ? input.skipped.join(', ') : 'none'}`,
    `Concepts the interviewer taught: ${input.taught.length ? input.taught.join(', ') : 'none'}`,
    '',
    'RECORDED GAPS (already drill cards — do not repeat these in gaps):',
    ...(input.recordedGaps?.length
      ? input.recordedGaps.map(
          (g) => `- ${g.seq != null ? `#${g.seq} ` : ''}[${g.type}] ${g.title || g.summary}`
        )
      : ['- none']),
    '',
    spec.rubric(input.level),
    '',
    'TRANSCRIPT',
    input.transcript,
  ].join('\n');
  const metas: CallMeta[] = [];

  const ask = async (tool: ToolSpec): Promise<Record<string, unknown>> => {
    const call = await structured({
      role: 'workhorse',
      // Thinking + a seven-stage grade with evidence and drills. coach() needed
      // 16000 for a smaller brief after a live truncation; the same budget.
      maxTokens: 16000,
      thinking: 'adaptive',
      system: spec.gradeSystem,
      tool,
      messages: [{ role: 'user', content: user }],
    });
    metas.push(call.meta);
    // A truncated tool call arrives as PARTIAL input whose missing fields
    // coerce to plausible defaults ("not reached", no drills). That would be a
    // confident wrong grade, so it is an error instead.
    if (call.meta.stop === 'max_tokens') {
      throw new Error(
        `Grade truncated at max_tokens after ${call.meta.usage.outputTokens} output tokens — ` +
          'the report would have shown stages as not reached rather than ungraded.'
      );
    }
    return call.input;
  };

  try {
    return { grade: spec.coerceGrade(await ask(spec.gradeTool), input.level, false), metas };
  } catch (err) {
    if (!(err instanceof LlmToolCallError) || err.meta.stop === 'max_tokens') throw err;
    console.warn(
      `[mock] emit_mock_grade failed structurally on ${err.meta.servedModel} ` +
        `(${err.message.slice(0, 200)}) — retrying once with the lean schema.`
    );
    if (err.meta.servedModel !== 'unknown') metas.push(err.meta);
    return { grade: spec.coerceGrade(await ask(spec.gradeToolLean), input.level, true), metas };
  }
}
