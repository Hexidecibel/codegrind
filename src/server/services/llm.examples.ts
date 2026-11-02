// =============================================================================
// llm.examples — the two model calls behind example checking and bin/audit-problems
// =============================================================================
// Same contract as llm.service.ts (llm.structural.test.ts holds this file to
// it): a prompt and a schema in, a coerced answer out, and not one word about
// who answers. A separate file for the same reason llm.recognize.ts is one —
// llm.service.ts is already the longest file in the server, and these share
// nothing with it but the seam.
//
//   rewriteExampleExplanation   once per example whose output was WRONG and
//                               has been replaced by the reference's
//                               (examples.service fixExamples). small role,
//                               thinking OFF, ~100 tokens out.
//   writeBruteForce             bin/audit-problems --crosscheck only. An
//                               INDEPENDENT second opinion on a reference: it
//                               sees the statement and the signature, never the
//                               reference or the tests, so agreeing with them
//                               is evidence rather than an echo. workhorse
//                               role, thinking OFF.

import { stripPatternLeaks } from '../../shared/pattern-leak.js';
import type { ProblemRecord } from '../../shared/types.js';
import { profileFor } from './llm.language.js';
import { structured } from './llm.client.js';
import { cutToolCallFraming, type ToolSpec } from './llm.types.js';

// ===========================================================================
// 1. rewriteExampleExplanation
// ===========================================================================
export const EXPLAIN_EXAMPLE_SYSTEM = `You write the one-paragraph explanation under a worked example of a coding problem. You are given the problem statement, the reference solution, and one example's input and its CORRECT output — the output is authoritative (it is what the reference returns); never argue with it or hedge.

- 1-3 sentences, plain prose, walking through why this input gives this output.
- Do not name the algorithm, technique or data structure used to solve it.
- Do not restate the input or say "the answer is" more than once.

Call emit_explanation exactly once.`;

export const EMIT_EXPLANATION_TOOL: ToolSpec = {
  name: 'emit_explanation',
  description: 'Emit the explanation for one worked example.',
  exactSchema: true,
  leakSink: 'explanation',
  schema: {
    type: 'object',
    properties: {
      explanation: { type: 'string', description: '1-3 sentences: why this input gives this output.' },
    },
    required: ['explanation'],
    additionalProperties: false,
  },
};

type ProblemForExamples = Pick<ProblemRecord, 'language' | 'title' | 'prompt' | 'referenceSolution'>;

export async function rewriteExampleExplanation(
  problem: ProblemForExamples,
  example: { input: string; output: string }
): Promise<string> {
  const fence = profileFor(problem.language).promptFence;
  const call = await structured({
    role: 'small',
    // Three sentences; 500 is headroom.
    maxTokens: 500,
    // Off: tracing one input through a given solution is a read, not a puzzle.
    thinking: 'off',
    system: EXPLAIN_EXAMPLE_SYSTEM,
    tool: EMIT_EXPLANATION_TOOL,
    messages: [
      {
        role: 'user',
        content: [
          `Problem: ${problem.title}`,
          problem.prompt.trim(),
          '',
          'Reference solution:',
          '```' + fence,
          problem.referenceSolution.trim(),
          '```',
          '',
          `Example input: ${example.input}`,
          `Correct output: ${example.output}`,
        ].join('\n'),
      },
    ],
  });
  const raw = typeof call.input.explanation === 'string' ? call.input.explanation : '';
  return stripPatternLeaks(cutToolCallFraming(raw).trim());
}

// ===========================================================================
// 2. writeBruteForce
// ===========================================================================
export const BRUTE_FORCE_SYSTEM = `You write a deliberately naive, obviously-correct solution to a coding problem, to be used as an independent check on another solution. Correctness is everything; speed is irrelevant (inputs will be small).

- Read the statement and constraints literally. Where the statement is ambiguous, follow its most literal reading.
- Prefer exhaustive enumeration (all pairs, all subsets, all orders, plain simulation) over anything clever.
- Keep EXACTLY the function name and parameter list of the given signature. Define any helpers you need in the same source. No I/O, no printing, no imports beyond the language's standard library.

Call emit_brute_force exactly once.`;

export const EMIT_BRUTE_FORCE_TOOL: ToolSpec = {
  name: 'emit_brute_force',
  description: 'Emit the complete brute-force solution source.',
  exactSchema: true,
  leakSink: 'notes',
  schema: {
    type: 'object',
    properties: {
      solution: { type: 'string', description: 'Complete source: the function with the given signature, plus helpers.' },
      notes: { type: 'string', description: 'One sentence: how you read any ambiguous part of the statement.' },
    },
    required: ['solution', 'notes'],
    additionalProperties: false,
  },
};

export async function writeBruteForce(
  problem: Pick<ProblemRecord, 'language' | 'title' | 'prompt' | 'constraints' | 'starterCode' | 'functionName'>
): Promise<{ solution: string; notes: string }> {
  const profile = profileFor(problem.language);
  const call = await structured({
    role: 'workhorse',
    // A short function plus helpers; 4000 leaves room for a verbose language.
    maxTokens: 4000,
    // Off: a brute force is the straightforward reading, and the budget is
    // spent on the code.
    thinking: 'off',
    system: BRUTE_FORCE_SYSTEM,
    tool: EMIT_BRUTE_FORCE_TOOL,
    messages: [
      {
        role: 'user',
        content: [
          `Language: ${profile.displayName}`,
          `Problem: ${problem.title}`,
          problem.prompt.trim(),
          '',
          problem.constraints.length ? `Constraints:\n${problem.constraints.map((c) => `- ${c}`).join('\n')}` : '',
          '',
          `Signature (function \`${problem.functionName}\`):`,
          '```' + profile.promptFence,
          problem.starterCode.trim(),
          '```',
        ].join('\n'),
      },
    ],
  });
  const solution = typeof call.input.solution === 'string' ? call.input.solution : '';
  const notes = typeof call.input.notes === 'string' ? cutToolCallFraming(call.input.notes).trim() : '';
  // A model that wraps its source in a fence anyway.
  const unfenced = solution.replace(/^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/, '$1');
  // A model that exports the function anyway (`module.exports = f;`): the
  // JavaScript runner loads the source as a plain script, where that line
  // fails with "module is not defined" and every test errors — 18 of 243
  // cross-checks came back inconclusive for exactly this (2026-10-30).
  const unexported =
    problem.language === 'javascript' ? stripJsExports(unfenced) : unfenced;
  return { solution: unexported, notes };
}

/** Drop CommonJS / ESM export statements from a plain-script JavaScript solution. */
export function stripJsExports(src: string): string {
  return src
    .replace(/^[ \t]*module\.exports(?:\.\w+)?\s*=[^\n]*\n?/gm, '')
    .replace(/^[ \t]*export\s+default\s+[A-Za-z_$][\w$]*\s*;?[ \t]*\n?/gm, '')
    .replace(/^([ \t]*)export\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/gm, '$1');
}
