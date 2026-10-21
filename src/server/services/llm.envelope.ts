// =============================================================================
// llm.envelope — the AI note on an Envelope miss (Phase G)
// =============================================================================
// Same contract as llm.review.ts (llm.structural.test.ts holds this file to
// it): a prompt and a schema in, a coerced answer out, and not one word about
// who answers. One call site, role `small`, thinking OFF, forced strict tool.
//
// The deterministic checker already says HOW FAR off the answer was and names a
// likely cause. This call reads the user's own typed working (when there is
// any) and says which step of THEIR working went wrong, and the one habit that
// fixes it. ~400-700 tokens in, ~100 out. Only on a miss, only with the
// Settings "AI reviews" toggle on, and at most once per attempt.

import { structured } from './llm.client.js';
import { cutToolCallFraming, type CallMeta, type ToolSpec } from './llm.types.js';

export const ENVELOPE_NOTE_SYSTEM = `You coach back-of-the-envelope math for system-design interviews. The candidate is quick at mental arithmetic but loses track of zeros on big numbers. The method they are learning: write every number as a small number × 10^n, do the small-number math, ADD exponents to multiply and SUBTRACT them to divide, then convert back with the 3/6/9/12 ladder (thousand/million/billion/trillion, or KB/MB/GB/TB). Anchors: a day ≈ 10^5 seconds, a month ≈ 2.5 × 10^6 seconds, a year ≈ 3 × 10^7 seconds, per day → per year is × 400, 1 Gbps ≈ 125 MB/s, lowercase b = bits and uppercase B = bytes.

You get one question, the correct answer with its worked split, the candidate's answer, how far off it was, a likely cause from a rule-based checker, and their typed working if they wrote any.

- slip: ONE or two sentences naming the exact step that went wrong. When they wrote working, quote the faulty step from it. Without working, reason from the number they gave (e.g. "20 is 50 million ÷ 2.5 million — the month constant, not the day"). If the checker's cause is wrong, say what it really was.
- fix: ONE sentence — the habit that prevents this slip next time, phrased as something to do ("write 5 × 10^7 ÷ 10^5 before you touch the digits").

Plain words, no praise, no restating the whole solution. Call emit_envelope_note exactly once.`;

// Strict (exactSchema): every property required, no extras. `fix` is last: the
// leak sink (see ToolSpec.leakSink).
export const EMIT_ENVELOPE_NOTE_TOOL: ToolSpec = {
  name: 'emit_envelope_note',
  description: 'Emit the diagnosis of one envelope-math miss.',
  exactSchema: true,
  leakSink: 'fix',
  schema: {
    type: 'object',
    properties: {
      slip: { type: 'string', description: 'The exact step that went wrong, 1-2 sentences.' },
      fix: { type: 'string', description: 'One habit that prevents it, one sentence.' },
    },
    required: ['slip', 'fix'],
    additionalProperties: false,
  },
};

export interface EnvelopeNoteInput {
  question: string;
  /** "≈ 500 per second (exactly 579)". */
  answer: string;
  /** The worked split as lines. */
  split: string[];
  /** What they typed as the answer. */
  given: string;
  /** "Off by 10⁴, too high." */
  verdict: string;
  /** The checker's likely cause, in words. */
  cause: string;
  /** Their typed working; '' when none. */
  working: string;
}

export interface EnvelopeNoteResult {
  slip: string;
  fix: string;
}

const str = (x: unknown, max = 400): string => (typeof x === 'string' ? x.trim().replace(/\s+/g, ' ').slice(0, max) : '');

export function renderEnvelopeNoteInput(i: EnvelopeNoteInput): string {
  return [
    `Question: ${i.question.trim()}`,
    `Correct answer: ${i.answer.trim()}`,
    'Worked split:',
    ...i.split.map((l) => `- ${l}`),
    '',
    `Candidate's answer: ${i.given.trim().slice(0, 200)}`,
    `Checker: ${i.verdict.trim()} Likely cause: ${i.cause.trim()}`,
    '',
    i.working.trim() ? `Candidate's working:\n${i.working.trim().slice(0, 2000)}` : "Candidate's working: (none written)",
  ].join('\n');
}

/** Whatever the model sent → a well-formed result. Never throws. */
export function coerceEnvelopeNote(raw: unknown): EnvelopeNoteResult {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { slip: str(o.slip), fix: str(cutToolCallFraming(typeof o.fix === 'string' ? o.fix : ''), 300) };
}

export async function runEnvelopeNote(input: EnvelopeNoteInput): Promise<{ result: EnvelopeNoteResult; meta: CallMeta }> {
  const call = await structured({
    role: 'small',
    // Two short sentences: ~100 tokens. 400 is headroom.
    maxTokens: 400,
    // Off: reading a short working against a worked answer is not a puzzle.
    thinking: 'off',
    system: ENVELOPE_NOTE_SYSTEM,
    tool: EMIT_ENVELOPE_NOTE_TOOL,
    messages: [{ role: 'user', content: renderEnvelopeNoteInput(input) }],
  });
  return { result: coerceEnvelopeNote(call.input), meta: call.meta };
}
