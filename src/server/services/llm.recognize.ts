// =============================================================================
// llm.recognize — the Recognize drill's one (optional) model call
// =============================================================================
// Same contract as llm.debrief.ts (llm.structural.test.ts holds this file to
// it): a prompt and a schema in, a coerced answer out, and not one word about
// who answers.
//
//   runRecognizeCheck   ONLY when the user clicks "AI check my approach" on a
//                       revealed card. role `small`, thinking OFF, forced tool
//                       `emit_recognize_check`, 600 output tokens. Never called
//                       in the background; self-grading stays the free default.
//
// The input is the statement, the reference solution (so the judge is grounded
// rather than guessing the intended approach) and the user's 1-3 sentences —
// roughly 1k tokens in, ~200 out.

import type { ProblemRecord } from '../../shared/types.js';
import type { RecognizeNote, RecognizeVerdict } from '../../shared/recognize.js';
import { structured } from './llm.client.js';
import { cutToolCallFraming, type CallMeta, type ToolSpec } from './llm.types.js';
import { coerceVerdict } from './recognize.compute.js';

export const RECOGNIZE_CHECK_SYSTEM = `You check a candidate's quick read of an algorithm problem. They did NOT write code: they named the pattern and wrote 1-3 sentences of approach plus time/space complexity, in about two minutes. Judge the IDEA, not the prose.

- verdict: "correct" if the approach would work at the optimal (or an acceptable) complexity; "partly" if the core idea is right but a key step, the invariant, or the complexity is off; "wrong" if it would not solve the problem or is badly suboptimal.
- missing: 0-3 short items the approach left out that actually matter (the invariant, a sort step, what the hash map stores). Not style.
- edgeCaseThatBites: the one input most likely to break THIS approach, in one line.
- oneLineFix: the single sentence that turns their approach into the reference one.
- keyInsight: one or two sentences — the tell in the statement that points at the pattern, and why the pattern works. About the problem, not the candidate.
- optimalTime / optimalSpace: the reference solution's complexity, e.g. "O(n log n)", "O(1)".

Be terse and specific. Call emit_recognize_check exactly once.`;

// Strict (exactSchema): all required, no extras. The longest free text,
// keyInsight, is last — the leak sink (see ToolSpec.leakSink).
export const EMIT_RECOGNIZE_CHECK_TOOL: ToolSpec = {
  name: 'emit_recognize_check',
  description: 'Emit the verdict on the candidate\'s approach.',
  exactSchema: true,
  leakSink: 'keyInsight',
  schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['correct', 'partly', 'wrong'] },
      missing: { type: 'array', items: { type: 'string' }, description: '0-3 things the approach left out.' },
      optimalTime: { type: 'string', description: 'Reference time complexity.' },
      optimalSpace: { type: 'string', description: 'Reference space complexity.' },
      edgeCaseThatBites: { type: 'string', description: 'One input that breaks this approach.' },
      oneLineFix: { type: 'string', description: 'One sentence that fixes the approach.' },
      keyInsight: { type: 'string', description: 'The tell + why the pattern works, 1-2 sentences.' },
    },
    required: ['verdict', 'missing', 'optimalTime', 'optimalSpace', 'edgeCaseThatBites', 'oneLineFix', 'keyInsight'],
    additionalProperties: false,
  },
};

export interface RecognizeCheckInput {
  problem: Pick<ProblemRecord, 'title' | 'prompt' | 'examples' | 'constraints' | 'topic' | 'referenceSolution' | 'language'>;
  picked: string | null;
  approach: string;
}

/** The message as the model reads it. Pure; exported for tests and the fixture. */
export function renderRecognizeCheckInput(i: RecognizeCheckInput): string {
  const ex = i.problem.examples
    .slice(0, 2)
    .map((e, n) => `Example ${n + 1}: input ${e.input} → output ${e.output}`)
    .join('\n');
  return [
    `Problem: ${i.problem.title}`,
    i.problem.prompt.trim(),
    ex,
    i.problem.constraints.length ? `Constraints: ${i.problem.constraints.join('; ')}` : '',
    '',
    `Intended pattern: ${i.problem.topic}`,
    `Reference solution (${i.problem.language}):`,
    i.problem.referenceSolution.trim(),
    '',
    `Candidate's pattern pick: ${i.picked ?? '(none)'}`,
    `Candidate's approach: ${i.approach.trim() || '(left blank)'}`,
  ]
    .filter((l, n, a) => l !== '' || a[n - 1] !== '')
    .join('\n');
}

export interface RecognizeCheckResult {
  verdict: RecognizeVerdict;
  missing: string[];
  edgeCaseThatBites: string;
  oneLineFix: string;
  note: RecognizeNote;
}

const str = (x: unknown, max = 300): string => (typeof x === 'string' ? x.trim().slice(0, max) : '');

/** Whatever the model sent → a well-formed result. Never throws. */
export function coerceRecognizeCheck(raw: unknown): RecognizeCheckResult {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    verdict: coerceVerdict(o.verdict),
    missing: (Array.isArray(o.missing) ? o.missing : typeof o.missing === 'string' ? [o.missing] : [])
      .map((m) => str(m, 200))
      .filter(Boolean)
      .slice(0, 3),
    edgeCaseThatBites: str(o.edgeCaseThatBites),
    oneLineFix: str(o.oneLineFix),
    note: {
      keyInsight: str(cutToolCallFraming(typeof o.keyInsight === 'string' ? o.keyInsight : ''), 500),
      time: str(o.optimalTime, 40),
      space: str(o.optimalSpace, 40),
    },
  };
}

export async function runRecognizeCheck(input: RecognizeCheckInput): Promise<{ result: RecognizeCheckResult; meta: CallMeta }> {
  const call = await structured({
    role: 'small',
    // A verdict, a few short strings; ~200 tokens of answer. 600 is headroom.
    maxTokens: 600,
    // Off: comparing two sketches of an approach is a read, not a puzzle.
    thinking: 'off',
    system: RECOGNIZE_CHECK_SYSTEM,
    tool: EMIT_RECOGNIZE_CHECK_TOOL,
    messages: [{ role: 'user', content: renderRecognizeCheckInput(input) }],
  });
  return { result: coerceRecognizeCheck(call.input), meta: call.meta };
}
