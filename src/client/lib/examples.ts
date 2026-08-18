import type { Example } from '@/shared/types';

// =============================================================================
// Which structured examples the statement has not already shown
// =============================================================================
// THE BUG: the problem pane rendered its examples TWICE. A generated problem
// carries both a markdown `prompt` and a structured `examples[]` array, the
// model was never told to keep them apart, and ProblemPanel rendered both — so
// a statement with its own "## Examples" section was followed by a second,
// differently-styled EXAMPLES block repeating the same Example 1 and Example 2.
//
// THE PROMPT IS NOW FIXED so new problems put examples only in `examples[]`
// (see GENERATE_SYSTEM_BY_LANGUAGE in llm.service.ts). That alone is not enough,
// and the reason it is not is the whole design constraint here: the bank already
// holds 64 problems written under the old prompt, and they are not regenerable
// for free — regenerating them is a paid call each and throws away problems
// people have already practised on. Measured against that bank:
//
//     12 problems  the markdown shows ALL of the structured examples
//     19 problems  the markdown shows SOME of them (usually 1 of 3)
//     33 problems  the markdown shows none
//
// The 19 are what rules out both of the simple fixes. "Stop rendering the
// structured block" blanks the examples for the 33 that only have them there.
// "Strip the examples section out of the markdown" means cutting prose apart on
// a heading — and the markdown lead-ins in the real bank are `## Examples`,
// `### Example`, `**Example:**`, `**Example walk-through:**` and eight other
// spellings, so it would cut in the wrong place often enough to matter, and when
// it did it would delete a piece of the problem statement.
//
// So the rule is per-example and content-based: DROP A STRUCTURED EXAMPLE THAT
// THE STATEMENT ALREADY SHOWS, and keep the rest. It duplicates nothing, deletes
// nothing, needs no migration, and reads correctly for both eras of problem — a
// statement that shows one example still gets the other two rendered underneath
// it, and a statement that shows all three renders no second block at all.
//
// It fails toward RENDERING. A comparison that cannot tell keeps the example,
// because a duplicate is untidy and a missing example is a problem you cannot
// solve.

/**
 * Text reduced to what is being compared: no whitespace, no markdown emphasis,
 * no case.
 *
 * The two copies are never byte-identical — the statement writes
 * `` `tiers = [10, 20, 35]`,  price = 35 `` inside a fenced block while the
 * structured field holds `tiers = [10, 20, 35], price = 35`. Whitespace and the
 * backtick/asterisk/underscore run are the entire difference in every case
 * observed in the bank, so removing exactly those is what makes the comparison
 * work without making it fuzzy enough to match things that are not the same.
 */
function comparable(s: string): string {
  return s.toLowerCase().replace(/[\s`*_]+/g, '');
}

/**
 * Below this many comparable characters an `input` is not evidence of anything.
 * `n=5` would match a statement that merely mentions `n = 5` in a sentence, and
 * dropping a real example over that is the one outcome worth avoiding.
 */
const MIN_MATCHABLE = 6;

/** True if `prompt` already shows this example's input. */
function alreadyShown(comparablePrompt: string, example: Example): boolean {
  const input = comparable(example.input ?? '');
  if (input.length < MIN_MATCHABLE) return false;
  return comparablePrompt.includes(input);
}

/**
 * The examples worth rendering under the statement: those the statement itself
 * has not already spelled out.
 */
export function unshownExamples(prompt: string, examples: Example[]): Example[] {
  if (!examples.length) return examples;
  const haystack = comparable(prompt ?? '');
  if (!haystack) return examples;
  return examples.filter((e) => !alreadyShown(haystack, e));
}
