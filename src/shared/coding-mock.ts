// =============================================================================
// coding-mock — the live-coding mock's vocabulary
// =============================================================================
// Client-safe. Stages walk a CoderPad-style round in order; the concepts are the
// coding kind's closed vocabulary. Every concept id here is distinct from every
// system-design and behavioral id (a drill card carries a concept and no kind;
// anyConceptLabel looks it up in every kind), which mock-kinds.test.ts pins.
// Hence `clarifying` (system design has `clarifying-questions`) and
// `edge-cases` (never a reuse of `tradeoffs`-style ids).

import type { Difficulty, Topic } from './types.js';

export const CODING_STAGES = ['clarify', 'examples', 'approach', 'complexity', 'code', 'test', 'follow-up'] as const;
export type CodingStage = (typeof CODING_STAGES)[number];

export const CODING_STAGE_META: Readonly<Record<CodingStage, { label: string; goal: string }>> = {
  clarify: { label: 'Clarify', goal: 'Restate the problem; ask about input sizes, edge cases and what to return.' },
  examples: { label: 'Examples', goal: 'Walk one example by hand, including an edge case, before any code.' },
  approach: { label: 'Approach', goal: 'Brute force first, then name the pattern and the better approach — out loud.' },
  complexity: { label: 'Complexity', goal: 'State time and space for the approach you will code, and why.' },
  code: { label: 'Code', goal: 'Write it cleanly while narrating; good names, small helpers.' },
  test: { label: 'Test', goal: 'Trace your code on an example and an edge case; Run, fix, Submit.' },
  'follow-up': { label: 'Follow-up', goal: 'One Staff-style extension: scale it, stream it, or change a constraint.' },
};

export const CODING_CONCEPTS = [
  'clarifying',
  'edge-cases',
  'brute-force-first',
  'pattern-recognition',
  'complexity',
  'code-clarity',
  'testing',
  'debugging',
  'optimization',
  'communication',
  'time-management',
] as const;
export type CodingConcept = (typeof CODING_CONCEPTS)[number];

export function isCodingConcept(x: unknown): x is CodingConcept {
  return typeof x === 'string' && (CODING_CONCEPTS as readonly string[]).includes(x);
}

const CODING_CONCEPT_LABEL: Readonly<Record<CodingConcept, string>> = {
  clarifying: 'Clarifying the problem',
  'edge-cases': 'Edge cases',
  'brute-force-first': 'Brute force first',
  'pattern-recognition': 'Pattern recognition',
  complexity: 'Complexity analysis',
  'code-clarity': 'Code clarity',
  testing: 'Testing your code',
  debugging: 'Debugging',
  optimization: 'Optimization',
  communication: 'Thinking out loud',
  'time-management': 'Time management',
};

export function codingConceptLabel(c: string): string {
  return isCodingConcept(c) ? CODING_CONCEPT_LABEL[c] : c.replace(/-/g, ' ');
}

/** The one catalog entry: the problem itself comes from the bank at start. */
export const CODING_PROMPTS = [
  {
    id: 'live-coding',
    title: 'Live coding',
    brief: 'One problem from your bank, CoderPad-style: clarify, approach, code, test, then a Staff follow-up.',
    familiar: false,
  },
] as const;

/** How the start card asks for the problem. */
export interface CodingMockOptions {
  /** `weakest` = the weakest topic in skill_state for the active language. */
  mode?: 'weakest' | 'pick';
  topic?: Topic;
  difficulty?: Difficulty;
}

export const DEFAULT_CODING_DIFFICULTY: Difficulty = 'medium';

/** The cap on the editor snapshot the interviewer is shown each turn, in characters. */
export const MOCK_EDITOR_CHARS = 8000;
/** The most code a turn or the End request may carry at all. */
export const MOCK_MAX_CODE_CHARS = 50_000;
