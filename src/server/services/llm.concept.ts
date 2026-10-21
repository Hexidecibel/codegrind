// =============================================================================
// llm.concept — concept-rep grading and AI-systems lessons (Phase H3)
// =============================================================================
// Same contract as llm.review.ts (llm.structural.test.ts holds this file to it):
// a prompt and a schema in, a coerced answer out, and not one word about who
// answers. Two call sites, both role `workhorse` (Sonnet 5):
//
//   runConceptGrade      one dictated explanation vs the concept's hand-written
//                        rubric → got/shaky/missed, key points hit/missed, a
//                        model answer, one follow-up question. Reasoning-heavy
//                        (judging a rambling spoken answer point by point), so
//                        thinking is ADAPTIVE. ~1.5k in, ~1-2k out incl.
//                        thinking. User-initiated, one per Submit.
//   generateConceptLesson one AI-systems track lesson per concept, generated
//                        ONCE and cached (concept_lessons), seeded with the same
//                        rubric so the lesson and the grader agree. Thinking
//                        off: cached content, like the algorithm lessons.

import type { ConceptRubric } from '../../shared/concept-rubrics.js';
import { GAP_CARD_GRADES, type GapCardGrade } from '../../shared/gap-cards.js';
import { clipAtBoundary } from '../../shared/clip.js';
import { structured } from './llm.client.js';
import { cutToolCallFraming, type CallMeta, type ToolSpec } from './llm.types.js';

const str = (x: unknown, max = 600): string =>
  typeof x === 'string' ? clipAtBoundary(x.trim().replace(/[ \t]+/g, ' '), max) : '';
const list = (x: unknown, n: number, max = 300): string[] =>
  (Array.isArray(x) ? x : typeof x === 'string' ? [x] : []).map((v) => str(v, max)).filter(Boolean).slice(0, n);

// -----------------------------------------------------------------------------
// Grading
// -----------------------------------------------------------------------------
export const CONCEPT_GRADE_SYSTEM = `You grade one "concept rep" for a candidate preparing for Staff engineer system-design interviews at AI- and agent-focused companies. The candidate was asked one interviewer-style question about one concept and answered OUT LOUD by dictation — ignore filler words, false starts, repetition and transcription noise. Judge whether they could explain it to an interviewer, not how polished it sounds.

You get the question, the concept's rubric (the key points a Staff answer contains, the common mistake, a worked example), whether the candidate read a primer on it just before answering, and their answer.

- hit: the rubric key points the answer actually covered, each restated in a few words. Credit a point when the idea is there in different words; do not credit a point that is only gestured at ("you'd handle failures").
- missed: the key points absent, wrong or too vague to count, each in a few words. Also add, as a missed item, the common mistake if the answer MAKES it.
- grade: "got" when the answer covers most key points (at least 3 of 4-5) with no central claim wrong; "shaky" when the core idea is right but two or more key points are missing or vague; "missed" when the core idea is absent or wrong, or the answer makes the common mistake as its main move. A short answer that hits the points is "got"; a long one that circles them is not.
- modelAnswer: what a strong Staff candidate would SAY in about 60-90 seconds — spoken, first person, concrete, with a number where the rubric's example has one. Plain prose, no headings or bullets.
- followUp: ONE follow-up question an interviewer would ask next, aimed at the weakest part of this answer (or one level deeper if the answer was strong).
- why: ONE line, specific: what made it got / shaky / missed.

Never invent facts about the candidate's own work. Call emit_concept_grade exactly once.`;

// Strict: every property required, no extras; the free-text `why` is LAST, the
// slot where post-call markup lands (ToolSpec.leakSink).
export const EMIT_CONCEPT_GRADE_TOOL: ToolSpec = {
  name: 'emit_concept_grade',
  description: 'Emit the grade for one concept rep.',
  exactSchema: true,
  leakSink: 'why',
  schema: {
    type: 'object',
    properties: {
      grade: { type: 'string', enum: ['got', 'shaky', 'missed'] },
      hit: { type: 'array', items: { type: 'string' }, description: 'Rubric key points the answer covered.' },
      missed: { type: 'array', items: { type: 'string' }, description: 'Key points absent, wrong or too vague; the common mistake if made.' },
      modelAnswer: { type: 'string', description: 'A strong spoken Staff answer, 60-90 seconds.' },
      followUp: { type: 'string', description: 'One follow-up question an interviewer would ask next.' },
      why: { type: 'string', description: 'One specific line.' },
    },
    required: ['grade', 'hit', 'missed', 'modelAnswer', 'followUp', 'why'],
    additionalProperties: false,
  },
};

export interface ConceptGradeInput {
  label: string;
  question: string;
  rubric: Pick<ConceptRubric, 'keyPoints' | 'mistake' | 'example'>;
  /** The candidate read the primer just before answering. */
  primed: boolean;
  answer: string;
}

export interface ConceptGradeResult {
  grade: GapCardGrade;
  hit: string[];
  missed: string[];
  modelAnswer: string;
  followUp: string;
  why: string;
}

export function renderConceptGradeInput(i: ConceptGradeInput): string {
  return [
    `Concept: ${i.label}`,
    `Question: ${i.question.trim()}`,
    '',
    'RUBRIC',
    'Key points a Staff answer contains:',
    ...i.rubric.keyPoints.map((k, n) => `${n + 1}. ${k}`),
    `Common mistake: ${i.rubric.mistake}`,
    `Worked example: ${i.rubric.example}`,
    '',
    i.primed
      ? 'The candidate read a short primer on this concept (the key points and the example) just before answering: this is a first explain-back, not a cold recall.'
      : 'Cold recall: no primer was shown for this rep.',
    '',
    "Candidate's answer (dictated):",
    i.answer.trim().slice(0, 6000),
  ].join('\n');
}

/** Whatever the model sent → a well-formed result. Never throws. */
export function coerceConceptGrade(raw: unknown): ConceptGradeResult {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const g = typeof o.grade === 'string' ? o.grade.trim().toLowerCase() : '';
  return {
    grade: (GAP_CARD_GRADES as readonly string[]).includes(g) ? (g as GapCardGrade) : 'shaky',
    hit: list(o.hit, 6, 200),
    missed: list(o.missed, 6, 200),
    modelAnswer: str(o.modelAnswer, 2000),
    followUp: str(o.followUp, 400),
    why: str(cutToolCallFraming(typeof o.why === 'string' ? o.why : ''), 400),
  };
}

export async function runConceptGrade(input: ConceptGradeInput): Promise<{ result: ConceptGradeResult; meta: CallMeta }> {
  const call = await structured({
    role: 'workhorse',
    // Thinking + a ~200-word model answer + two short lists. The mock grader's
    // budget is 16000 for seven stages; one concept needs far less.
    maxTokens: 6000,
    // Adaptive: matching a rambling spoken answer to rubric points is judgement.
    thinking: 'adaptive',
    system: CONCEPT_GRADE_SYSTEM,
    tool: EMIT_CONCEPT_GRADE_TOOL,
    messages: [{ role: 'user', content: renderConceptGradeInput(input) }],
  });
  return { result: coerceConceptGrade(call.input), meta: call.meta };
}

// -----------------------------------------------------------------------------
// AI-systems track lessons
// -----------------------------------------------------------------------------
/**
 * The candidate's REAL experience, the only material a lesson may tie to
 * (user-supplied 2026-10-21). Phrased as "you could draw on…" in lessons; never
 * embellished. dox/supdox has NO live customers — never claim usage.
 */
export const CANDIDATE_EXPERIENCE = `THE CANDIDATE'S OWN WORK (the only facts you may use about them):
- dox / supdox: their own document-processing product — COA/spec extraction for food-safety teams, a self-hosted Qwen model, a human review queue, built on a Cloudflare stack. It has NO live customers: never claim usage, users, volume or results.
- An LLM model router across a fleet of local GPU hosts, with honest backpressure: 429 (busy, retry later) vs 503 (no healthy host) and capacity headers so clients back off.
- codegrind (this practice app): forced tool use with strict schemas, golden request-body fixtures, a vendor-agnostic model seam, and a live per-call-site quality comparison of a small model (Haiku) against a larger one (Sonnet) before moving calls to the cheaper model — a real eval story.
- sentinel: a self-healing ops agent that had a runaway-spend incident (re-diagnosing one dead service every 10 minutes drained its API budget), fixed with fingerprint dedupe, escalating backoff and a spend cap — agent-safety and cost material.
- Jarvis (on OpenClaw): a homelab ops agent that runs commands only with per-command human approval.`;

export const CONCEPT_LESSON_SYSTEM = `You write one lesson in an "AI systems" study track for a senior engineer preparing for Staff system-design interviews at AI- and agent-focused companies. They have built some LLM systems but have not had to explain these concepts under interview pressure. The lesson is read once, in about five minutes, and must leave them able to explain the concept out loud.

You get the concept and its rubric (the key points a Staff answer contains, the common mistake, a worked example). The lesson MUST teach every key point and warn about the common mistake; it may go beyond them.

Fields:
- card: the concept card, markdown. One plain sentence on what it is, then the key points as 4-6 short bullets. No headings.
- inInterview: 2-4 sentences — how it shows up in an AI system-design round: which prompts bring it up and what the interviewer is probing for.
- failureModes: 3-5 short items — how it goes wrong in production, each one line.
- workedExample: one concrete example with numbers, walked through in 4-8 sentences (build on the rubric's example; keep its numbers consistent).
- drawOn: 0-2 items, each starting "You could draw on …", tying the concept to the candidate's OWN work listed below where it genuinely fits. Use only those facts; never invent usage, customers, scale or results. Empty when nothing fits.
- staffAnswer: what a Staff answer sounds like — a spoken paragraph of 80-140 words, first person, to the question given below, with a decision and a number.

${CANDIDATE_EXPERIENCE}

Plain language, no hype, no filler. Call emit_concept_lesson exactly once.`;

// staffAnswer LAST: the free-text leak sink.
export const EMIT_CONCEPT_LESSON_TOOL: ToolSpec = {
  name: 'emit_concept_lesson',
  description: 'Emit one AI-systems track lesson.',
  exactSchema: true,
  leakSink: 'staffAnswer',
  schema: {
    type: 'object',
    properties: {
      card: { type: 'string', description: 'One sentence, then 4-6 markdown bullets.' },
      inInterview: { type: 'string' },
      failureModes: { type: 'array', items: { type: 'string' } },
      workedExample: { type: 'string' },
      drawOn: { type: 'array', items: { type: 'string' }, description: '0-2 "You could draw on …" items.' },
      staffAnswer: { type: 'string', description: 'A spoken Staff answer, 80-140 words.' },
    },
    required: ['card', 'inInterview', 'failureModes', 'workedExample', 'drawOn', 'staffAnswer'],
    additionalProperties: false,
  },
};

export interface ConceptLessonInput {
  label: string;
  question: string;
  rubric: Pick<ConceptRubric, 'keyPoints' | 'mistake' | 'example'>;
}

export interface ConceptLessonResult {
  card: string;
  inInterview: string;
  failureModes: string[];
  workedExample: string;
  drawOn: string[];
  staffAnswer: string;
}

export function renderConceptLessonInput(i: ConceptLessonInput): string {
  return [
    `Concept: ${i.label}`,
    `The question for staffAnswer: ${i.question}`,
    '',
    'RUBRIC',
    'Key points:',
    ...i.rubric.keyPoints.map((k, n) => `${n + 1}. ${k}`),
    `Common mistake: ${i.rubric.mistake}`,
    `Worked example: ${i.rubric.example}`,
  ].join('\n');
}

export function coerceConceptLesson(raw: unknown): ConceptLessonResult {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const keep = (x: unknown, max: number) => (typeof x === 'string' ? clipAtBoundary(x.trim(), max) : '');
  return {
    card: keep(o.card, 3000),
    inInterview: keep(o.inInterview, 1500),
    failureModes: list(o.failureModes, 5, 300),
    workedExample: keep(o.workedExample, 3000),
    // Only items that are framed as the candidate's option, never a claim.
    drawOn: list(o.drawOn, 2, 500).filter((d) => /^you could draw on/i.test(d)),
    staffAnswer: keep(cutToolCallFraming(typeof o.staffAnswer === 'string' ? o.staffAnswer : ''), 2000),
  };
}

export async function generateConceptLesson(input: ConceptLessonInput): Promise<{ result: ConceptLessonResult; meta: CallMeta }> {
  const call = await structured({
    role: 'workhorse',
    // ~900-1300 words of lesson. 5000 leaves headroom for the tokenizer; a
    // truncated lesson is cached forever.
    maxTokens: 5000,
    // Off: cached one-time content, like the algorithm lessons.
    thinking: 'off',
    system: CONCEPT_LESSON_SYSTEM,
    tool: EMIT_CONCEPT_LESSON_TOOL,
    messages: [{ role: 'user', content: renderConceptLessonInput(input) }],
  });
  return { result: coerceConceptLesson(call.input), meta: call.meta };
}
