// =============================================================================
// mock-kinds/common — the tool schemas and coercers every kind shares
// =============================================================================
// The interviewer_turn and emit_mock_grade SHAPES are the same for every kind;
// only the closed enums (stages, concepts) differ. So the schemas are built from
// a kind's vocabulary here, and a kind that needs a different shape can still
// hand-write its own ToolSpec in its spec.
//
// BYTE STABILITY: the system-design request bodies are pinned by a golden
// fixture (llm.mock.test.ts). Property order, descriptions and the
// exactSchema/leakSink fields below are part of what is pinned — reorder
// nothing without regenerating it deliberately.

import {
  CONCEPT_SIGNALS,
  GAP_TYPES,
  INTERVIEWER_MODES,
  isGapType,
  type InterviewerMode,
  type MockLevel,
} from '../../../shared/sd.js';
import type { MockConcept, MockKindInfo, MockStage } from '../../../shared/mock-kinds.js';
import type {
  MockDrill,
  MockGrade,
  MockGradeGap,
  MockObservation,
  MockStageGrade,
  MockVerdict,
} from '../../../shared/mock.js';
import { LlmToolCallError, cutToolCallFraming, looksLikeToolCallFraming, type ToolSpec } from '../llm.types.js';
import type { InterviewerReply, SuppliedGap } from '../mock.state.js';

/** A kind's closed vocabulary, as the schemas and coercers need it. */
export interface Vocab {
  stages: readonly MockStage[];
  concepts: readonly MockConcept[];
}

// ===========================================================================
// Schemas
// ===========================================================================

/** Shared by the interviewer's per-turn observations and the grader's. */
function observationItem(v: Vocab) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      concept: { type: 'string', enum: [...v.concepts] },
      signal: { type: 'string', enum: [...CONCEPT_SIGNALS] },
      note: { type: 'string', description: 'One short clause of evidence.' },
    },
    required: ['concept', 'signal', 'note'],
  };
}

/**
 * How a drill-card FRONT is worded, for every kind's interviewer and grader.
 * The user tripped over fronts written as notes ("Capacity out loud: turn 100M
 * new links/month and 10B redirects/month into rps…"); a front is read cold
 * days later, so it must sound like the question an interviewer would ask.
 */
export const CARD_FRONT_STYLE = `Word every card front the way an interviewer would actually ask it out loud: a full, plain-English question that sets up the situation ("Say a URL shortener gets 100 million new links and 10 billion redirects a month. Roughly how many redirects per second is that?"). Never terse note-speak ("Capacity out loud: 100M links/month → rps"), never a "Topic:" label in front, and no unexplained abbreviations (say "requests per second", not "rps").`;

/** A gap the interviewer handed over: a drill card's front and back. */
function gapItem(v: Vocab) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      concept: { type: 'string', enum: [...v.concepts] },
      type: { type: 'string', enum: [...GAP_TYPES] },
      title: { type: 'string', description: 'Drill-card front: a self-contained question, worded the way an interviewer would ask it out loud.' },
      answer: { type: 'string', description: 'Drill-card back: 2–4 sentences, including why it matters.' },
    },
    required: ['concept', 'type', 'title', 'answer'],
  };
}

/**
 * `say` is LAST, and that is the same lesson emit_coaching paid for: the model
 * writes fields in schema order, and the trailing string is where post-call
 * drift lands (ToolSpec.leakSink). Everything structural is committed before
 * the long free-text field starts.
 */
export function interviewerTool(v: Vocab): ToolSpec {
  const STAGE_ENUM = [...v.stages];
  const CONCEPT_ENUM = [...v.concepts];
  return {
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
          items: observationItem(v),
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
          items: gapItem(v),
        },
        say: { type: 'string', description: 'What the candidate sees. Markdown allowed in teach mode.' },
      },
      required: ['observations', 'stage', 'stagesCovered', 'mode', 'teach', 'resumePoint', 'gaps', 'say'],
    },
  };
}

function stageGradeItem(v: Vocab) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      stage: { type: 'string', enum: [...v.stages] },
      score: { type: 'integer', description: '0 (not reached) to 4.' },
      evidence: { type: 'string', description: 'What they said, with turn numbers.' },
      atLevel: { type: 'boolean' },
      staffWouldAdd: { type: 'string' },
      principalWouldAdd: { type: 'string' },
    },
    required: ['stage', 'score', 'evidence', 'atLevel', 'staffWouldAdd', 'principalWouldAdd'],
  };
}

export function gradeTool(v: Vocab, lean: boolean): ToolSpec {
  const STAGE_ENUM = [...v.stages];
  const CONCEPT_ENUM = [...v.concepts];
  return {
    name: 'emit_mock_grade',
    description: 'The grade for this mock interview.',
    // The full schema is nested several levels deep — exactly the shape
    // emit_coaching measured breaking without strict validation. The LEAN
    // retry is strict too (Phase H): unstrict, it failed the same way the full
    // call had, on the same field, and the retry was money for nothing.
    exactSchema: true,
    // `summary` is LAST: the free-text field where post-call markup lands
    // (ToolSpec.leakSink). It used to be second, so a live grade with tool
    // markup in it (2026-10-21) was rejected as "the rest of the fields were
    // serialized into it" — twice — although strict mode had delivered them.
    leakSink: 'summary',
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        verdict: { type: 'string', enum: ['below', 'at', 'above'] },
        stages: { type: 'array', items: stageGradeItem(v), description: 'One entry per stage, in order.' },
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
              conceptObservations: { type: 'array', items: observationItem(v) },
            }),
        drills: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
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
            additionalProperties: false,
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
        summary: { type: 'string', description: 'Three or four sentences: the overall picture, written as a finished interview.' },
      },
      required: lean
        ? ['verdict', 'stages', 'skipped', 'gapsTaught', 'drills', 'gaps', 'summary']
        : ['verdict', 'stages', 'skipped', 'gapsTaught', 'conceptObservations', 'drills', 'gaps', 'summary'],
    },
  };
}

// ===========================================================================
// Coercion
// ===========================================================================

/** Cut a leaked tool-call tail off the user-visible line, rather than show it. */
function cleanSay(raw: string): string {
  if (!looksLikeToolCallFraming(raw)) return raw.trim();
  const at = raw.search(/<\/?\s*(?:antml\s*[:.]?\s*)?(?:function_calls|invoke|parameter)\b|<\/\s*antml\b/i);
  return (at > 0 ? raw.slice(0, at) : raw).trim();
}

export interface Coercers {
  coerceObservations(raw: unknown): MockObservation[];
  coerceSuppliedGaps(raw: unknown): SuppliedGap[];
  coerceReply(input: Record<string, unknown>, fallbackStage: MockStage): InterviewerReply;
  coerceGrade(input: Record<string, unknown>, level: MockLevel, degraded: boolean): MockGrade;
}

/** The coercers for one kind's closed vocabulary. */
export function coercers(info: Pick<MockKindInfo, 'stages' | 'concepts'>): Coercers {
  const isStage = (x: unknown): x is MockStage => typeof x === 'string' && info.stages.includes(x);
  const isConcept = (x: unknown): x is MockConcept => typeof x === 'string' && info.concepts.includes(x);

  function coerceObservations(raw: unknown): MockObservation[] {
    if (!Array.isArray(raw)) return [];
    const out: MockObservation[] = [];
    for (const o of raw) {
      const r = (o ?? {}) as Record<string, unknown>;
      if (!isConcept(r.concept)) continue;
      const signal = (CONCEPT_SIGNALS as readonly string[]).includes(r.signal as string)
        ? (r.signal as MockObservation['signal'])
        : null;
      if (!signal) continue;
      out.push({ concept: r.concept, signal, note: typeof r.note === 'string' ? r.note.slice(0, 300) : '' });
    }
    return out;
  }

  /** A drill card needs a front and a back; a gap missing either is dropped. */
  function coerceSuppliedGaps(raw: unknown): SuppliedGap[] {
    if (!Array.isArray(raw)) return [];
    const out: SuppliedGap[] = [];
    for (const g of raw) {
      const r = (g ?? {}) as Record<string, unknown>;
      if (!isConcept(r.concept)) continue;
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
  function coerceReply(input: Record<string, unknown>, fallbackStage: MockStage): InterviewerReply {
    const mode: InterviewerMode = (INTERVIEWER_MODES as readonly string[]).includes(input.mode as string)
      ? (input.mode as InterviewerMode)
      : 'interview';
    const t = input.teach as Record<string, unknown> | null | undefined;
    const teach =
      t && isConcept(t.concept)
        ? { concept: t.concept, gapSummary: typeof t.gapSummary === 'string' ? t.gapSummary : '' }
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
      stage: isStage(input.stage) ? input.stage : fallbackStage,
      stagesCovered: Array.isArray(input.stagesCovered) ? input.stagesCovered.filter(isStage) : [],
      // teach/offer without a concept degrade to a plain interview turn: the
      // lesson card and the Teach-me buttons both need one.
      mode: (mode === 'teach' || mode === 'offer_teach') && !teach ? 'interview' : mode,
      teach: mode === 'teach' || mode === 'offer_teach' ? teach : null,
      resumePoint: typeof input.resumePoint === 'string' ? input.resumePoint : '',
      gaps: coerceSuppliedGaps(input.gaps),
      say,
    };
  }

  function coerceStages(raw: unknown): MockStageGrade[] {
    const byStage = new Map<MockStage, MockStageGrade>();
    if (Array.isArray(raw)) {
      for (const r of raw as Record<string, unknown>[]) {
        if (!r || !isStage(r.stage) || byStage.has(r.stage)) continue;
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
    return info.stages.map(
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
      .filter((d) => d && isConcept(d.concept) && typeof d.prompt === 'string' && d.prompt.trim())
      .slice(0, 8)
      .map((d) => ({ concept: d.concept as MockConcept, prompt: d.prompt as string, why: typeof d.why === 'string' ? d.why : '' }));
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

  function coerceGrade(input: Record<string, unknown>, level: MockLevel, degraded: boolean): MockGrade {
    const verdict: MockVerdict = ['below', 'at', 'above'].includes(input.verdict as string)
      ? (input.verdict as MockVerdict)
      : 'below';
    const gaps = Array.isArray(input.gapsTaught) ? input.gapsTaught : [];
    return {
      level,
      verdict,
      // The leak sink: whatever tool markup trails the real summary is cut off.
      summary: typeof input.summary === 'string' ? cutToolCallFraming(input.summary).trim() : '',
      stages: coerceStages(input.stages),
      skipped: Array.isArray(input.skipped) ? input.skipped.filter(isStage) : [],
      gapsTaught: gaps
        .map((g) =>
          typeof g === 'string'
            ? isConcept(g)
              ? { concept: g, summary: '' }
              : null
            : g && isConcept((g as Record<string, unknown>).concept)
              ? {
                  concept: (g as Record<string, unknown>).concept as MockConcept,
                  summary: String((g as Record<string, unknown>).summary ?? ''),
                }
              : null
        )
        .filter((g): g is { concept: MockConcept; summary: string } => g !== null),
      conceptObservations: coerceObservations(input.conceptObservations),
      drills: coerceDrills(input.drills),
      gaps: coerceGradeGaps(input.gaps),
      ...(degraded ? { degraded: true } : {}),
    };
  }

  return { coerceObservations, coerceSuppliedGaps, coerceReply, coerceGrade };
}
