// =============================================================================
// The problem pane printed its examples twice
// =============================================================================
// The captured screenshot: a markdown "Examples" section with Example 1/2/3, a
// "Notes" heading, and then a second, differently-styled EXAMPLES block
// repeating Example 1 and Example 2. Both came from the same generated problem —
// the markdown `prompt` and the structured `examples[]` array — and ProblemPanel
// rendered each of them.
//
// The generation prompt now forbids examples in the markdown body, so new
// problems have them in one place. This file pins the OTHER half, which is the
// half that has to be right for the 64 problems already in the bank: they were
// written under the old prompt, they are not regenerable for free, and 19 of
// them show SOME but not all of their examples in the statement. See
// client/lib/examples.ts for why that 19 rules out every simpler fix.
//
// The two fixtures below are real bank problems, quoted rather than invented.

import { describe, it, expect } from 'vitest';
import type { Example } from '@/shared/types';
import { unshownExamples } from './examples';

/**
 * "Ticket Booth Price Lookup" — the pure-duplication case. The statement lists
 * all three examples in a fenced block under `## Examples`, and `examples[]`
 * repeats all three. This is the screenshot.
 */
const TICKET_BOOTH_PROMPT = `# Ticket Booth Price Lookup

Given the sorted array \`tiers\` and an integer \`price\`, return the **index** of
\`price\` in \`tiers\` if it exists, or \`-1\` if that price tier is not offered.

## Examples

\`\`\`
tiers = [10, 20, 35, 50, 75, 100],  price = 35   →  2
tiers = [5, 15, 25, 40, 60],        price = 30   → -1
tiers = [100],                       price = 100  →  0
\`\`\`
`;

const TICKET_BOOTH_EXAMPLES: Example[] = [
  {
    input: 'tiers = [10, 20, 35, 50, 75, 100], price = 35',
    output: '2',
    explanation: '35 is at index 2 in the sorted tiers array.',
  },
  {
    input: 'tiers = [5, 15, 25, 40, 60], price = 30',
    output: '-1',
    explanation: '30 is not present in the tiers array.',
  },
  { input: 'tiers = [100], price = 100', output: '0', explanation: 'Single-element array.' },
];

/**
 * "Rotate Array Left by K Steps" — the case that rules out a heading-based fix.
 * The statement has a bold `**Example:**` lead-in, so any "does the markdown
 * mention examples" test fires; but it is one sentence of prose that shares no
 * input with the structured array, and suppressing all three would leave the
 * player with strictly less than they have today.
 */
const ROTATE_PROMPT = `# Rotate Array Left by K Steps

Given an array of integers \`nums\` and a non-negative integer \`k\`, return a
**new array** rotated to the **left** by \`k\` positions.

**Example:** Rotating \`[1, 2, 3, 4, 5]\` left by \`2\` gives \`[3, 4, 5, 1, 2]\`.
`;

const ROTATE_EXAMPLES: Example[] = [
  { input: 'nums = [1, 2, 3, 4, 5], k = 2', output: '[3, 4, 5, 1, 2]' },
  { input: 'nums = [7, 11, 3, 8], k = 1', output: '[11, 3, 8, 7]' },
  { input: 'nums = [4, 2, 9], k = 6', output: '[4, 2, 9]' },
];

describe('a statement that already shows every example', () => {
  it('renders no second block at all — this is the screenshot bug', () => {
    expect(unshownExamples(TICKET_BOOTH_PROMPT, TICKET_BOOTH_EXAMPLES)).toEqual([]);
  });

  it('matches across the formatting differences the two copies actually have', () => {
    // The statement pads inside a fenced block (`[10, 20, 35, 50, 75, 100],  price`,
    // two spaces) and wraps values in backticks elsewhere; the structured field
    // does neither. Whitespace and emphasis are the whole difference in the bank,
    // which is why they are the whole normalization.
    expect(
      unshownExamples('input: `tiers = [100]`,   price   =   100', [
        { input: 'tiers = [100], price = 100', output: '0' },
      ])
    ).toEqual([]);
  });
});

describe('a statement that shows some of them', () => {
  it('keeps the ones it did not show, and drops only the repeat', () => {
    const prompt = `${TICKET_BOOTH_PROMPT.split('## Examples')[0]}
**Example:** \`tiers = [5, 15, 25, 40, 60], price = 30\` returns \`-1\`.`;
    const kept = unshownExamples(prompt, TICKET_BOOTH_EXAMPLES);
    expect(kept.map((e) => e.input)).toEqual([
      'tiers = [10, 20, 35, 50, 75, 100], price = 35',
      'tiers = [100], price = 100',
    ]);
  });
});

describe('a statement whose prose example is not one of the structured ones', () => {
  it('keeps all three — a bold "**Example:**" is not evidence of duplication', () => {
    // The heading-based fix fails exactly here: it would blank three good
    // examples because the statement contains the word "Example".
    expect(unshownExamples(ROTATE_PROMPT, ROTATE_EXAMPLES)).toEqual(ROTATE_EXAMPLES);
  });
});

describe('it fails toward rendering', () => {
  it('keeps everything when the statement shows nothing', () => {
    const examples: Example[] = [{ input: 'nums = [1, 2, 3], target = 5', output: '[0, 2]' }];
    expect(unshownExamples('Find the pair that sums to the target.', examples)).toEqual(examples);
  });

  it('keeps an example whose input is too short to be evidence', () => {
    // `n = 5` appearing in a sentence is not the statement "showing the example",
    // and dropping a real example over a five-character coincidence is the one
    // outcome worth avoiding.
    const examples: Example[] = [{ input: 'n = 5', output: '120' }];
    expect(unshownExamples('For any n = 5 or greater the recursion is worth memoizing.', examples))
      .toEqual(examples);
  });

  it('survives an empty prompt and an empty array without throwing', () => {
    expect(unshownExamples('', ROTATE_EXAMPLES)).toEqual(ROTATE_EXAMPLES);
    expect(unshownExamples(ROTATE_PROMPT, [])).toEqual([]);
  });

  it('does not mutate what it was given', () => {
    const examples = [...TICKET_BOOTH_EXAMPLES];
    unshownExamples(TICKET_BOOTH_PROMPT, examples);
    expect(examples).toHaveLength(3);
  });
});
