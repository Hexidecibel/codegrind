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
// CONTROL NOTES GO IN USER TURNS, NOT IN SYSTEM MESSAGES. Mid-conversation
// `role: "system"` messages exist on Sonnet 5.5 but NOT on Sonnet 5, and the
// seam has no such role anyway. The interviewer system prompt below tells the
// model what `[server: …]` and `[control: …]` lines mean.

import {
  SD_STAGES,
  SD_CONCEPTS,
  INTERVIEWER_MODES,
  CONCEPT_SIGNALS,
  GAP_TYPES,
  MOCK_LEVEL_LABEL,
  isGapType,
  isSdStage,
  isSdConcept,
  type MockLevel,
  type SdConcept,
  type SdStage,
  type InterviewerMode,
} from '../../shared/sd.js';
import type {
  MockDrill,
  MockGrade,
  MockGradeGap,
  MockObservation,
  MockStageGrade,
  MockVerdict,
} from '../../shared/mock.js';
import { structured } from './llm.client.js';
import { LlmToolCallError, looksLikeToolCallFraming, type CallMeta, type LlmMessage, type ToolSpec } from './llm.types.js';
import { CANDIDATE_CARD, WARM_UP_RULE } from './sd-candidate.js';
import { RUBRIC_TEXT } from './sd-rubric.js';
import type { InterviewerReply, SuppliedGap } from './mock.state.js';

// ===========================================================================
// 1. interviewerTurn
// ===========================================================================

/**
 * A constant — the same bytes for every mock and every turn, so the cached
 * prefix (tools, then this) is shared across mocks as well as across turns.
 * Nothing per-mock goes here: the prompt and the level are in the first user
 * message (mock.state.buildContext).
 */
export const INTERVIEWER_SYSTEM = `You are a senior engineer running a live system-design interview over chat. You are realistic: you ask, listen, probe and move the candidate forward. You do not lecture during interview mode, you do not solve the problem for them, and you keep each message short — usually one to four sentences, ending with one question.

STAGES, in order: ${SD_STAGES.join(' → ')}. Move forward when a stage is adequately covered or time demands it. It is fine to revisit. Report the stage your reply belongs to, and every stage the candidate has adequately covered so far.

MODES (pick one per reply):
- interview: the normal case. Ask the next question, react to what they said, introduce a twist when a happy path exists.
- nudge: they are stuck or heading somewhere unproductive. Ask a question that points the way. Never give the answer in a nudge (if you end up giving it anyway, it is a gap — see GAPS).
- offer_teach: they have missed the same concept twice, are clearly stuck, or hit one of their honest gaps. Briefly say what you noticed and OFFER a short lesson; the app shows them "Teach me" and "Keep going" buttons. Fill teach.concept with what you would teach.
- teach: break out of interviewer character and teach. Use this when the candidate asks ("wait, explain X", "what is X?", "I don't know what X means") or a [control: TEACH ME] line arrives. Explain plainly, with one concrete example tied to THIS design, in a short markdown lesson (a few short paragraphs or bullets, at most ~250 words). Then end the message with "Back to the interview:" followed by the question that resumes where you were. Fill teach.concept and teach.gapSummary (one sentence: what they did not know), and resumePoint.
- wrap_up: only after a [control: END] line, or when every stage is covered. One or two sentences closing the interview. No new question.

LINES THE APP ADDS TO THE CANDIDATE'S MESSAGES — they come from the app, not the candidate; never quote them back:
- [server: …] facts: the clock, the turn count, the current stage, stages the server noticed were skipped, a time warning.
- [control: …] a button the candidate pressed (TEACH ME, I'M STUCK, MOVE ON, KEEP GOING) or END. Obey it.

ANSWER BEFORE YOU REDIRECT. When the candidate's last message asks a conceptual or clarifying question, or voices confusion ("I guess that's where I get confused on…", "what's the difference between…", "not sure how that works"), your reply OPENS by answering it directly in one or two sentences, plainly and tied to this design — and only then continues with your next question, nudge or offer. Never ignore an explicit question, never answer it with a different topic, and never jump to an offer or a lesson on something else while their question hangs. If answering properly needs more than two sentences, use teach mode on that question. Example (a chat app): "does a sent message have to show up right away?" → "For the sender, yes — they must read their own write the moment it is sent; other people's unread counts can lag a few seconds. So: …".

REASONING OVER RECALL. When the candidate says they do not know a fact but reasons about the trade-off anyway ("not sure which status code, but it's browser caching against seeing every click"), that is the Staff move — credit it in your observations (the reasoning concept, not missing), supply the fact in a sentence, record the fact in gaps, and carry on. Do not treat a missing fact as a failed stage.

GAPS: on every reply, list in gaps every fact or reasoning move YOU handed over in this reply that the candidate did not have — taught in teach mode, explained while answering their question, or given away in a nudge or a follow-up ("a 301 is cached by the browser permanently, so…"). If you told them something they did not know, it is a gap; no exceptions.
- type fact: domain knowledge — status codes, unit shortcuts (seconds in a month), encodings (base62), what a particular technology guarantees.
- type skill: a reasoning move — ranking failures, running the estimate, committing to a trade-off, choosing where to deep-dive.
- title: the drill-card front, a self-contained question someone could answer cold in two weeks, naming the context ("URL shortener redirect: 301 or 302 — and what does the choice do to click analytics?").
- answer: the card back, two to four sentences: the answer AND why it matters / how it connects to the rest of this design.
An empty list when you handed nothing over.

OBSERVATIONS: on every reply, record what the candidate's LAST message showed about specific concepts — nailed (did it well, unprompted), weak (partly, or only when pushed), missing (should have, did not). Only concepts from the closed list in the tool schema. Zero observations is a fine answer for a message that showed nothing. Never record an observation about something you just taught them.

${WARM_UP_RULE}

STYLE: plain language, no headings in interview mode, no bullet lists unless teaching. Do not praise every answer. When they say "right?" or "correct?" reflexively, do not answer the tag — respond to the substance. When they ask a question you would answer in a real interview (scale, users, constraints), answer it concretely with numbers.

${CANDIDATE_CARD}

Return every reply by calling the interviewer_turn tool exactly once. The candidate sees only "say".`;

const STAGE_ENUM = [...SD_STAGES];
const CONCEPT_ENUM = [...SD_CONCEPTS];

/** Shared by the interviewer's per-turn observations and the grader's. */
const OBSERVATION_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    concept: { type: 'string', enum: CONCEPT_ENUM },
    signal: { type: 'string', enum: [...CONCEPT_SIGNALS] },
    note: { type: 'string', description: 'One short clause of evidence.' },
  },
  required: ['concept', 'signal', 'note'],
};

/** A gap the interviewer handed over: a drill card's front and back. */
const GAP_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    concept: { type: 'string', enum: CONCEPT_ENUM },
    type: { type: 'string', enum: [...GAP_TYPES] },
    title: { type: 'string', description: 'Drill-card front: a self-contained question.' },
    answer: { type: 'string', description: 'Drill-card back: 2–4 sentences, including why it matters.' },
  },
  required: ['concept', 'type', 'title', 'answer'],
};

/**
 * `say` is LAST, and that is the same lesson emit_coaching paid for: the model
 * writes fields in schema order, and the trailing string is where post-call
 * drift lands (ToolSpec.leakSink). Everything structural is committed before
 * the long free-text field starts.
 */
export const INTERVIEWER_TOOL: ToolSpec = {
  name: 'interviewer_turn',
  description: 'Your next message in the interview, plus what the candidate’s last message showed.',
  exactSchema: true,
  leakSink: 'say',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      observations: {
        type: 'array',
        description: 'What the candidate’s LAST message showed. Empty when it showed nothing.',
        items: OBSERVATION_ITEM,
      },
      stage: { type: 'string', enum: STAGE_ENUM, description: 'The stage this reply belongs to.' },
      stagesCovered: {
        type: 'array',
        items: { type: 'string', enum: STAGE_ENUM },
        description: 'Every stage the candidate has adequately covered so far, including earlier ones.',
      },
      mode: { type: 'string', enum: [...INTERVIEWER_MODES] },
      // anyOf rather than `type: ['object', 'null']`: strict validation documents
      // anyOf, and the nullable-array spelling is only proven here on scalars.
      teach: {
        description: 'For teach and offer_teach only; null otherwise.',
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              concept: { type: 'string', enum: CONCEPT_ENUM },
              gapSummary: { type: 'string', description: 'One sentence: what they did not know.' },
            },
            required: ['concept', 'gapSummary'],
          },
          { type: 'null' },
        ],
      },
      resumePoint: {
        type: 'string',
        description: 'teach mode: the question you resume with. Empty string otherwise.',
      },
      gaps: {
        type: 'array',
        description: 'Every fact or reasoning move you handed over in THIS reply. Empty when none.',
        items: GAP_ITEM,
      },
      say: { type: 'string', description: 'What the candidate sees. Markdown allowed in teach mode.' },
    },
    required: ['observations', 'stage', 'stagesCovered', 'mode', 'teach', 'resumePoint', 'gaps', 'say'],
  },
};

export interface InterviewerResult {
  reply: InterviewerReply;
  observations: MockObservation[];
  meta: CallMeta;
}

/** Cut a leaked tool-call tail off the user-visible line, rather than show it. */
function cleanSay(raw: string): string {
  if (!looksLikeToolCallFraming(raw)) return raw.trim();
  const at = raw.search(/<\/?\s*(?:antml\s*[:.]?\s*)?(?:function_calls|invoke|parameter)\b|<\/\s*antml\b/i);
  return (at > 0 ? raw.slice(0, at) : raw).trim();
}

export function coerceObservations(raw: unknown): MockObservation[] {
  if (!Array.isArray(raw)) return [];
  const out: MockObservation[] = [];
  for (const o of raw) {
    const r = (o ?? {}) as Record<string, unknown>;
    if (!isSdConcept(r.concept)) continue;
    const signal = (CONCEPT_SIGNALS as readonly string[]).includes(r.signal as string)
      ? (r.signal as MockObservation['signal'])
      : null;
    if (!signal) continue;
    out.push({ concept: r.concept, signal, note: typeof r.note === 'string' ? r.note.slice(0, 300) : '' });
  }
  return out;
}

/** A drill card needs a front and a back; a gap missing either is dropped. */
export function coerceSuppliedGaps(raw: unknown): SuppliedGap[] {
  if (!Array.isArray(raw)) return [];
  const out: SuppliedGap[] = [];
  for (const g of raw) {
    const r = (g ?? {}) as Record<string, unknown>;
    if (!isSdConcept(r.concept)) continue;
    const title = typeof r.title === 'string' ? r.title.trim().slice(0, 300) : '';
    const answer = typeof r.answer === 'string' ? r.answer.trim().slice(0, 1500) : '';
    if (!title || !answer) continue;
    // An unknown type is a skill: the heavier weight is the safe default.
    out.push({ concept: r.concept, type: isGapType(r.type) ? r.type : 'skill', title, answer });
  }
  return out.slice(0, 6);
}

/**
 * The tool input, as a reply the state machine can trust. `fallbackStage` is
 * the stage the mock was in: an unknown stage is "no change", never a jump.
 */
export function coerceReply(input: Record<string, unknown>, fallbackStage: SdStage): InterviewerReply {
  const mode: InterviewerMode = (INTERVIEWER_MODES as readonly string[]).includes(input.mode as string)
    ? (input.mode as InterviewerMode)
    : 'interview';
  const t = input.teach as Record<string, unknown> | null | undefined;
  const teach =
    t && isSdConcept(t.concept)
      ? { concept: t.concept as SdConcept, gapSummary: typeof t.gapSummary === 'string' ? t.gapSummary : '' }
      : null;
  const say = typeof input.say === 'string' ? cleanSay(input.say) : '';
  if (!say) {
    // An empty line cannot be shown, and storing it would put an empty
    // assistant turn into every later request. Same channel as a missing call.
    throw new LlmToolCallError('interviewer_turn came back with nothing to say.', {
      servedModel: 'unknown',
      stop: null,
      latencyMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    });
  }
  return {
    stage: isSdStage(input.stage) ? input.stage : fallbackStage,
    stagesCovered: Array.isArray(input.stagesCovered) ? input.stagesCovered.filter(isSdStage) : [],
    // teach/offer without a concept degrade to a plain interview turn: the
    // lesson card and the Teach-me buttons both need one.
    mode: (mode === 'teach' || mode === 'offer_teach') && !teach ? 'interview' : mode,
    teach: mode === 'teach' || mode === 'offer_teach' ? teach : null,
    resumePoint: typeof input.resumePoint === 'string' ? input.resumePoint : '',
    gaps: coerceSuppliedGaps(input.gaps),
    say,
  };
}

/**
 * One interviewer reply. `messages` comes from mock.state.buildMessages and is
 * passed through untouched — its byte stability is the cache.
 */
export async function interviewerTurn(
  messages: LlmMessage[],
  currentStage: SdStage
): Promise<InterviewerResult> {
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
    system: INTERVIEWER_SYSTEM,
    tool: INTERVIEWER_TOOL,
    messages,
  });
  if (call.meta.stop === 'max_tokens') {
    throw new Error(
      `Interviewer reply truncated at max_tokens after ${call.meta.usage.outputTokens} output tokens.`
    );
  }
  let reply: InterviewerReply;
  try {
    reply = coerceReply(call.input, currentStage);
  } catch (err) {
    if (err instanceof LlmToolCallError) throw new LlmToolCallError(err.message, call.meta);
    throw err;
  }
  return { reply, observations: coerceObservations(call.input.observations), meta: call.meta };
}

// ===========================================================================
// 2. gradeMock
// ===========================================================================

export const GRADE_SYSTEM = `You grade a completed system-design mock interview against a rubric, at a stated level. You are the hiring-committee reviewer, not the interviewer: be specific, cite what the candidate actually said (by turn number), and be honest about the level.

Rules:
- Score each of the seven stages 1–4 against its anchors. A stage the interview never reached scores 0 with evidence "not reached".
- TAUGHT MATERIAL IS NOT EVIDENCE. Turns marked [TAUGHT: concept] are the interviewer teaching. Anything the candidate says about that concept afterwards shows they listened, not that they knew it. List each taught concept in gapsTaught and do not let it raise a score.
- Nudges count against "unprompted": an answer that arrived only after a [NUDGE] is at best weak.
- GAPS ARE NOT EQUAL. A fact gap (did not know 301 vs 302, seconds in a month, base62) is a cheap fix and weighs LITTLE — a Staff engineer may look a fact up. A skill gap (could not rank failures, could not run the estimate, would not commit to a trade-off) is what the level is judged on and weighs heavily. Never hold a stage below level for a missing fact alone; do hold it below level for a missing skill.
- REASONING WITHOUT THE FACT IS A POSITIVE STAFF SIGNAL. When the candidate says they do not know a fact but reasons about the trade-off correctly ("not sure which code, but it's browser caching against seeing every click"), credit the reasoning in the evidence. Wherever a fact was missing, model that phrasing in staffWouldAdd: "I don't remember X offhand, but the trade-off is A against B, and here I'd pick A because…".
- atLevel is judged against the level's bar for that stage, not against the score alone.
- staffWouldAdd / principalWouldAdd: the one or two concrete things a Staff (and a Principal) answer would have added at that stage. Concrete — a sentence they could have said — not "more depth".
- verdict: below / at / above the stated level overall.
- conceptObservations: the concepts the transcript gives evidence on, each nailed / weak / missing, from the closed list.
- drills: 3 to 6 short follow-up drills, most valuable first, each targeting one concept. A drill is a prompt the candidate can answer in a few minutes ("You're designing X. The worst failure is Y. Say your ranking sentence."), plus why it is on the list.
- summary: name the skill gaps as the practice areas and the fact gaps as cheap fixes, separately.
- gaps: every fact or reasoning move the INTERVIEWER handed over that is NOT already in RECORDED GAPS below — including ones given away inside a nudge, a follow-up or an answer to the candidate's question. Each with type (fact or skill), title (a self-contained drill-card question naming the context), answer (two to four sentences: the answer and why it matters to the design) and turn (the interviewer turn number, or null). An empty list when the recorded gaps are complete.
- Write in plain language and use the candidate's own framework (seven questions, six failures, ranking sentence, principal phrases) where it applies.

Return the grade by calling emit_mock_grade exactly once.`;

const STAGE_GRADE_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    stage: { type: 'string', enum: STAGE_ENUM },
    score: { type: 'integer', description: '0 (not reached) to 4.' },
    evidence: { type: 'string', description: 'What they said, with turn numbers.' },
    atLevel: { type: 'boolean' },
    staffWouldAdd: { type: 'string' },
    principalWouldAdd: { type: 'string' },
  },
  required: ['stage', 'score', 'evidence', 'atLevel', 'staffWouldAdd', 'principalWouldAdd'],
};

function gradeTool(lean: boolean): ToolSpec {
  return {
    name: 'emit_mock_grade',
    description: 'The grade for this mock interview.',
    // The full schema is nested several levels deep — exactly the shape
    // emit_coaching measured breaking without strict validation.
    exactSchema: !lean,
    schema: {
      type: 'object',
      ...(lean ? {} : { additionalProperties: false }),
      properties: {
        verdict: { type: 'string', enum: ['below', 'at', 'above'] },
        summary: { type: 'string', description: 'Three or four sentences: the overall picture.' },
        stages: { type: 'array', items: STAGE_GRADE_ITEM, description: 'One entry per stage, in order.' },
        skipped: { type: 'array', items: { type: 'string', enum: STAGE_ENUM } },
        gapsTaught: lean
          ? { type: 'array', items: { type: 'string', enum: CONCEPT_ENUM } }
          : {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  concept: { type: 'string', enum: CONCEPT_ENUM },
                  summary: { type: 'string' },
                },
                required: ['concept', 'summary'],
              },
            },
        ...(lean
          ? {}
          : {
              conceptObservations: { type: 'array', items: OBSERVATION_ITEM },
            }),
        drills: {
          type: 'array',
          items: {
            type: 'object',
            ...(lean ? {} : { additionalProperties: false }),
            properties: {
              concept: { type: 'string', enum: CONCEPT_ENUM },
              prompt: { type: 'string' },
              why: { type: 'string' },
            },
            required: ['concept', 'prompt', 'why'],
          },
        },
        gaps: {
          type: 'array',
          description: 'Gaps the interviewer handed over that RECORDED GAPS does not already list.',
          items: {
            type: 'object',
            ...(lean ? {} : { additionalProperties: false }),
            properties: {
              concept: { type: 'string', enum: CONCEPT_ENUM },
              type: { type: 'string', enum: [...GAP_TYPES] },
              title: { type: 'string' },
              answer: { type: 'string' },
              // anyOf for the same reason as interviewer_turn.teach.
              turn: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
            },
            required: ['concept', 'type', 'title', 'answer', 'turn'],
          },
        },
      },
      required: lean
        ? ['verdict', 'summary', 'stages', 'skipped', 'gapsTaught', 'drills', 'gaps']
        : ['verdict', 'summary', 'stages', 'skipped', 'gapsTaught', 'conceptObservations', 'drills', 'gaps'],
    },
  };
}

export const EMIT_MOCK_GRADE_TOOL = gradeTool(false);
/** The second rung: no strict validation, flatter taught list, no observations. */
export const EMIT_MOCK_GRADE_TOOL_LEAN = gradeTool(true);

function coerceStages(raw: unknown): MockStageGrade[] {
  const byStage = new Map<SdStage, MockStageGrade>();
  if (Array.isArray(raw)) {
    for (const r of raw as Record<string, unknown>[]) {
      if (!r || !isSdStage(r.stage) || byStage.has(r.stage)) continue;
      const score = Number.isFinite(r.score as number) ? Math.max(0, Math.min(4, Math.round(r.score as number))) : 0;
      byStage.set(r.stage, {
        stage: r.stage,
        score,
        evidence: typeof r.evidence === 'string' ? r.evidence : '',
        atLevel: r.atLevel === true,
        staffWouldAdd: typeof r.staffWouldAdd === 'string' ? r.staffWouldAdd : '',
        principalWouldAdd: typeof r.principalWouldAdd === 'string' ? r.principalWouldAdd : '',
      });
    }
  }
  // Every stage, in order — a grade that forgot one shows it as not reached
  // rather than leaving a hole in the report.
  return SD_STAGES.map(
    (s) =>
      byStage.get(s) ?? {
        stage: s,
        score: 0,
        evidence: 'not reached',
        atLevel: false,
        staffWouldAdd: '',
        principalWouldAdd: '',
      }
  );
}

function coerceDrills(raw: unknown): MockDrill[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[])
    .filter((d) => d && isSdConcept(d.concept) && typeof d.prompt === 'string' && d.prompt.trim())
    .slice(0, 8)
    .map((d) => ({ concept: d.concept as SdConcept, prompt: d.prompt as string, why: typeof d.why === 'string' ? d.why : '' }));
}

function coerceGradeGaps(raw: unknown): MockGradeGap[] {
  if (!Array.isArray(raw)) return [];
  const out: MockGradeGap[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const [g] = coerceSuppliedGaps([r]);
    if (!g) continue;
    const turn = r.turn;
    out.push({ ...g, turn: Number.isInteger(turn) && (turn as number) > 0 ? (turn as number) : null });
  }
  return out.slice(0, 12);
}

export function coerceGrade(input: Record<string, unknown>, level: MockLevel, degraded: boolean): MockGrade {
  const verdict: MockVerdict = ['below', 'at', 'above'].includes(input.verdict as string)
    ? (input.verdict as MockVerdict)
    : 'below';
  const gaps = Array.isArray(input.gapsTaught) ? input.gapsTaught : [];
  return {
    level,
    verdict,
    summary: typeof input.summary === 'string' ? input.summary : '',
    stages: coerceStages(input.stages),
    skipped: Array.isArray(input.skipped) ? input.skipped.filter(isSdStage) : [],
    gapsTaught: gaps
      .map((g) =>
        typeof g === 'string'
          ? isSdConcept(g)
            ? { concept: g, summary: '' }
            : null
          : g && isSdConcept((g as Record<string, unknown>).concept)
            ? {
                concept: (g as Record<string, unknown>).concept as SdConcept,
                summary: String((g as Record<string, unknown>).summary ?? ''),
              }
            : null
      )
      .filter((g): g is { concept: SdConcept; summary: string } => g !== null),
    conceptObservations: coerceObservations(input.conceptObservations),
    drills: coerceDrills(input.drills),
    gaps: coerceGradeGaps(input.gaps),
    ...(degraded ? { degraded: true } : {}),
  };
}

export interface GradeInput {
  level: MockLevel;
  promptTitle: string;
  brief: string;
  /** mock.state.renderTranscript output. */
  transcript: string;
  skipped: SdStage[];
  taught: SdConcept[];
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
    RUBRIC_TEXT[input.level],
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
      system: GRADE_SYSTEM,
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
    return { grade: coerceGrade(await ask(EMIT_MOCK_GRADE_TOOL), input.level, false), metas };
  } catch (err) {
    if (!(err instanceof LlmToolCallError) || err.meta.stop === 'max_tokens') throw err;
    console.warn(
      `[mock] emit_mock_grade failed structurally on ${err.meta.servedModel} ` +
        `(${err.message.slice(0, 200)}) — retrying once with the lean schema.`
    );
    if (err.meta.servedModel !== 'unknown') metas.push(err.meta);
    return { grade: coerceGrade(await ask(EMIT_MOCK_GRADE_TOOL_LEAN), input.level, true), metas };
  }
}
