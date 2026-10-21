// =============================================================================
// llm.review — the small automatic reviews (Phase F)
// =============================================================================
// Same contract as llm.debrief.ts and llm.recognize.ts (llm.structural.test.ts
// holds this file to it): a prompt and a schema in, a coerced answer out, and
// not one word about who answers. Two call sites, both role `small`, thinking
// OFF, forced tool:
//
//   runCardCheck    a warm-up drill card: the user's typed / dictated answer vs
//                   the card back → got | shaky | missed, one line of why, what
//                   was missing. ~400-900 tokens in (dictated answers run long),
//                   ~120 out. The user can override; the final grade is theirs.
//   runStepReview   one finished Today step → a 2-3 line note and ONE concrete
//                   thing to carry into the next step. ~500-900 in, ~150 out.
//                   Runs once per step per day (today.service owns the dedupe,
//                   the cooldown and the retry budget).
//
// Pure helpers (renderers, coercers, the "no answer" test) are exported for
// tests and the golden fixture.

import { GAP_CARD_GRADES, type GapCardGrade } from '../../shared/gap-cards.js';
import { structured } from './llm.client.js';
import { cutToolCallFraming, type CallMeta, type ToolSpec } from './llm.types.js';

const str = (x: unknown, max = 300): string => (typeof x === 'string' ? x.trim().replace(/\s+/g, ' ').slice(0, max) : '');

// -----------------------------------------------------------------------------
// Warm-up card grading
// -----------------------------------------------------------------------------
export const CARD_CHECK_SYSTEM = `You grade one spaced-repetition drill card for a candidate preparing for Staff engineer interviews. The card came from a gap a mock interview exposed. You get the card's question, the stored model answer (the card back), and the candidate's answer — often dictated, so ignore filler, false starts and transcription noise. Judge whether they KNOW it, not how it is phrased.

- grade: "got" if the answer carries the essential idea of the card back (wording may differ; extra correct detail is fine); "shaky" if the core is there but a key part is missing, vague or partly wrong; "missed" if the essential idea is absent or wrong.
- why: ONE line, specific: what made it got/shaky/missed.
- missing: 0-3 short items from the card back the answer left out that matter. Empty when nothing important is missing.

Be strict but fair: a confident answer that names the right mechanism is "got" even if terse. Call emit_card_grade exactly once.`;

// Strict (exactSchema): every property required, no extras, so the endpoint
// guarantees the types — a `missing` that arrived as a STRING failed two of two
// live calls before this (2026-10-21). The free-text `why` is LAST, the slot
// where a model's post-call markup lands (see ToolSpec.leakSink).
export const EMIT_CARD_GRADE_TOOL: ToolSpec = {
  name: 'emit_card_grade',
  description: 'Emit the grade for one drill-card answer.',
  exactSchema: true,
  leakSink: 'why',
  schema: {
    type: 'object',
    properties: {
      grade: { type: 'string', enum: ['got', 'shaky', 'missed'] },
      missing: { type: 'array', items: { type: 'string' }, description: '0-3 things the answer left out.' },
      why: { type: 'string', description: 'One specific line.' },
    },
    required: ['grade', 'missing', 'why'],
    additionalProperties: false,
  },
};

export interface CardCheckInput {
  /** The card front (the question). */
  question: string;
  /** The card back. May be '' on cards that predate stored answers. */
  reference: string;
  /** What the mock saw, for context. */
  summary: string;
  answer: string;
}

export interface CardCheckResult {
  grade: GapCardGrade;
  why: string;
  missing: string[];
}

/** Answers that mean "I don't know": graded `missed` with no call. */
export function isNoAnswer(answer: string): boolean {
  const t = answer.trim().toLowerCase().replace(/[.!?,…'’]/g, '').replace(/\s+/g, ' ');
  if (!t) return true;
  return /^(i )?(do ?nt|dont|don t|do not) (really )?know( it)?$|^(idk|dunno|no idea|not sure|no clue|pass|skip|i forgot|forgot|no)$|^i (have )?no idea$|^i dont remember$|^i do not remember$/.test(
    t
  );
}

export function renderCardCheckInput(i: CardCheckInput): string {
  return [
    `Card question: ${i.question.trim()}`,
    i.summary.trim() && i.summary.trim() !== i.question.trim() ? `What the mock exposed: ${i.summary.trim()}` : '',
    `Card back (model answer): ${i.reference.trim() || '(none stored — judge against the question alone)'}`,
    '',
    `Candidate's answer:`,
    i.answer.trim().slice(0, 4000),
  ]
    .filter((l, n) => l !== '' || n === 3)
    .join('\n');
}

/** Whatever the model sent → a well-formed result. Never throws. */
export function coerceCardCheck(raw: unknown): CardCheckResult {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const g = typeof o.grade === 'string' ? o.grade.trim().toLowerCase() : '';
  const grade: GapCardGrade = (GAP_CARD_GRADES as readonly string[]).includes(g) ? (g as GapCardGrade) : 'shaky';
  // A string `missing` (a lax endpoint) is one item, not nothing.
  const missing = Array.isArray(o.missing) ? o.missing : typeof o.missing === 'string' ? [o.missing] : [];
  return {
    grade,
    why: str(cutToolCallFraming(typeof o.why === 'string' ? o.why : ''), 240),
    missing: missing.map((m) => str(m, 160)).filter(Boolean).slice(0, 3),
  };
}

export async function runCardCheck(input: CardCheckInput): Promise<{ result: CardCheckResult; meta: CallMeta }> {
  const call = await structured({
    role: 'small',
    // A grade, a line, three short items: ~120 tokens. 500 is headroom.
    maxTokens: 500,
    // Off: comparing an answer to a stored answer is a read, not a puzzle.
    thinking: 'off',
    system: CARD_CHECK_SYSTEM,
    tool: EMIT_CARD_GRADE_TOOL,
    messages: [{ role: 'user', content: renderCardCheckInput(input) }],
  });
  return { result: coerceCardCheck(call.input), meta: call.meta };
}

// -----------------------------------------------------------------------------
// Step review
// -----------------------------------------------------------------------------
export const STEP_REVIEW_SYSTEM = `You are an interview-prep coach watching ONE day of practice, step by step, for a candidate targeting Staff engineer roles. The day: a warm-up (drill cards from past mocks, review problems), an optional Recognize set (name the pattern of a problem, no code), two adaptive algorithm problems (predict complexity first), and one mock interview.

One step just finished. You get what happened in it, plus the notes from earlier steps today. Write:
- note: 2-3 short lines on what happened in THIS step — specific, grounded in the digest (names, counts, the pattern, the mistake). No praise padding.
- carry: ONE concrete thing to watch in the NEXT step (named below), phrased as an instruction the candidate can act on in the first five minutes of it. E.g. "Before coding, state the loop invariant out loud" — not "keep practising".

If an earlier note's carry was or was not followed here, say so in the note. Call emit_step_review exactly once.`;

// Strict, like the card grade. `note` (the longer free text) is last: the leak sink.
export const EMIT_STEP_REVIEW_TOOL: ToolSpec = {
  name: 'emit_step_review',
  description: 'Emit the review of one finished step.',
  exactSchema: true,
  leakSink: 'note',
  schema: {
    type: 'object',
    properties: {
      carry: { type: 'string', description: 'One concrete thing to watch in the next step.' },
      note: { type: 'string', description: 'What happened, 2-3 short lines.' },
    },
    required: ['carry', 'note'],
    additionalProperties: false,
  },
};

export interface StepReviewInput {
  /** "Problem 1" */
  step: string;
  /** "Problem 2", or "tomorrow" after the last step. */
  next: string;
  /** The step's digest, already rendered as short lines. */
  digest: string[];
  /** Earlier notes today, in step order. */
  earlier: { step: string; note: string; carry: string }[];
}

export interface StepReviewResult {
  note: string;
  carry: string;
}

export function renderStepReviewInput(i: StepReviewInput): string {
  const lines = [`Step just finished: ${i.step}`, `Next step: ${i.next}`, '', 'What happened:'];
  for (const d of i.digest.length ? i.digest : ['(nothing recorded)']) lines.push(`- ${d}`);
  if (i.earlier.length) {
    lines.push('', 'Earlier today:');
    for (const e of i.earlier) lines.push(`- ${e.step}: ${e.note} Carry: ${e.carry}`);
  }
  return lines.join('\n');
}

export function coerceStepReview(raw: unknown): StepReviewResult {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { note: str(cutToolCallFraming(typeof o.note === 'string' ? o.note : ''), 500), carry: str(o.carry, 240) };
}

export async function runStepReview(input: StepReviewInput): Promise<{ result: StepReviewResult; meta: CallMeta }> {
  const call = await structured({
    role: 'small',
    // Three lines and a sentence: ~150 tokens. 600 is headroom.
    maxTokens: 600,
    thinking: 'off',
    system: STEP_REVIEW_SYSTEM,
    tool: EMIT_STEP_REVIEW_TOOL,
    messages: [{ role: 'user', content: renderStepReviewInput(input) }],
  });
  return { result: coerceStepReview(call.input), meta: call.meta };
}
