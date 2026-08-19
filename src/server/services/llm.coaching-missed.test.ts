// =============================================================================
// coerceMissed — the layer that decides how badly a weak model can fail
// =============================================================================
// `missed` used to be a `string[]`. It is now an array of objects carrying a
// quoted line, a line number and a corrected snippet, and that is the single
// hardest shape to ask a grammar-constrained local decoder for — which matters,
// because running on a local model is a feature of this app rather than an edge
// case (see the settings/wizard work: it runs keyless against llama.cpp).
//
// THE MOST IMPORTANT TEST IN THIS FILE IS THE STRING ONE. A model that answers
// `["you never reset left", "…"]` — ignoring the object schema entirely, which
// small models reliably do — must still produce a complete brief. Without that
// branch every item fails the object check and "What you missed" renders EMPTY:
// the feature would not degrade to its predecessor, it would delete it.
//
// Everything is driven through the real `coach()` with the SDK faked, the same
// way llm.golden.test.ts and llm.toolcall-leak.test.ts do it. No key, no
// network, no database, no cost. Going through `coach()` rather than exporting
// `coerceMissed` keeps the test honest about the thing that actually ships: the
// anchors are resolved against the source that was really passed in, not
// against a hand-picked string.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProblemRecord, TestResult } from '../../shared/types.js';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: mocks.create };
    constructor(_opts: unknown) {}
  }
  return { default: FakeAnthropic };
});

process.env.ANTHROPIC_API_KEY = 'test-key-not-used';

const llm = await import('./llm.service.js');

// -----------------------------------------------------------------------------
// The submission every quote below is resolved against.
// -----------------------------------------------------------------------------
// Line 4 and line 8 are BOTH `  }` — deliberately, because a duplicate line is
// the entire reason the model is asked for a line number at all.
const USER_CODE = [
  'function longest(s) {',          // 1
  '  let left = 0;',                // 2
  '  let best = 0;',                // 3
  '  const seen = new Set();',      // 4
  '  for (let r = 0; r < s.length; r++) {', // 5
  '    while (seen.has(s[r])) {',   // 6
  '      seen.delete(s[left]);',    // 7
  '    }',                          // 8
  '    seen.add(s[r]);',            // 9
  '    best = Math.max(best, r - left + 1);', // 10
  '  }',                            // 11
  '  return best;',                 // 12
  '}',                              // 13
].join('\n');

const PROBLEM: ProblemRecord = {
  id: 'missed-fixture',
  language: 'javascript',
  title: 'Longest Substring',
  prompt: 'Longest substring without repeating characters.',
  examples: [{ input: '"abcabcbb"', output: '3' }],
  constraints: ['0 <= n <= 1000'],
  difficulty: 'medium',
  topic: 'sliding-window',
  pattern: 'sliding-window',
  starterCode: 'function longest(s) {}',
  functionName: 'longest',
  sampleTests: [{ name: 's1', args: ['abc'], expected: 3 }],
  hiddenTests: [{ name: 'h1', args: [''], expected: 0 }],
  referenceSolution: 'function longest(s) { return 0; }',
  canonicalized: true,
  used: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const RESULTS: TestResult[] = [{ name: 'h1', passed: false, timeMs: 4 }];

/** The fields `coach()` needs beyond `missed`, so the guard has nothing to trip on. */
const REST = {
  approach: 'You slide a window and track the best length.',
  pattern: 'sliding-window',
  patternRecognition: 'A substring question with a "no repeats" constraint.',
  complexity: { yours: 'O(n)', optimal: 'O(n)' },
  improvement: 'Reset the left pointer with the window, not after it.',
  mistakeTags: [],
};

/** Answer the forced tool call with this `missed`, the way a real 200 would. */
async function coachWith(missed: unknown) {
  mocks.create.mockReset();
  mocks.create.mockImplementation(async (body: Record<string, unknown>) => ({
    model: 'claude-fixture',
    stop_reason: 'tool_use',
    usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 0 },
    content: [
      {
        type: 'tool_use',
        name: (body.tool_choice as { name?: string } | undefined)?.name,
        input: { ...REST, missed },
      },
    ],
  }));
  return llm.coach(PROBLEM, USER_CODE, RESULTS);
}

// The instrumentation is asserted, not just tolerated — see the last block.
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

// =============================================================================
describe('a model that ignores the object schema still produces a brief', () => {
  it('accepts a plain string[] and turns every entry into a note', async () => {
    // THE ONE THAT MATTERS. `missed` renders from `note`, so a dropped string
    // here is a silently empty section, not a visibly broken one.
    const { brief, fixes } = await coachWith([
      'You never reset `left` when the window shrinks.',
      'The empty-string case returns undefined.',
    ]);
    expect(brief.missed).toEqual([
      { note: 'You never reset `left` when the window shrinks.' },
      { note: 'The empty-string case returns undefined.' },
    ]);
    // No anchors and no fixes: a string carries no quote, so there is nothing
    // to resolve and nothing to charge for. The section is complete, just not
    // clickable — which is exactly the behaviour that shipped before this.
    expect(fixes.size).toBe(0);
  });

  it('handles a half-converted answer — some strings, some objects', async () => {
    const { brief } = await coachWith([
      'A bare string the model fell back to.',
      { note: 'A proper object.', quote: '  let best = 0;', line: 3 },
    ]);
    expect(brief.missed.map((m) => m.note)).toEqual([
      'A bare string the model fell back to.',
      'A proper object.',
    ]);
    expect(brief.missed[0].anchor).toBeUndefined();
    expect(brief.missed[1].anchor).toEqual({ startLine: 3, endLine: 3 });
  });

  it('REJECTS a `missed` that is a string, and tries the plain schema once', async () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE, and the reversal is the bug fix.
    // It read "returns an empty list rather than throwing when `missed` is not
    // an array", on the theory that a prose blob where an array was asked for is
    // nothing to salvage but must not take the brief with it.
    //
    // It takes the brief with it either way. Five live calls proved what that
    // shape actually is: not a small model being vague, but a capable one
    // breaking out of JSON at exactly the field where the schema stops being
    // flat and serializing the REST OF THE TOOL CALL into it. Every field after
    // `missed` is then missing, and "an empty list" renders as a confident,
    // complete-looking brief with nothing in "What you missed" and
    // "unknown / unknown" beside it. That panel shipped to a real user.
    //
    // So it is now a structural failure: rejected, retried ONCE with the
    // plain-string schema (which the fake answers the same broken way here, so
    // it fails again), and surfaced. routes/submit.ts turns that into "coaching
    // is temporarily unavailable", which is honest about what happened.
    await expect(coachWith('you missed the empty case')).rejects.toThrow(/missed/);
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it('drops entries that are neither strings nor objects', async () => {
    const { brief } = await coachWith([null, 42, ['nested'], { note: 'the real one' }]);
    // An array IS an object, so the array entry reaches the object branch and
    // dies on the blank-note rule — which is the intended outcome either way.
    expect(brief.missed).toEqual([{ note: 'the real one' }]);
  });
});

describe('notes', () => {
  it('drops an item with a blank note — an anchor is not a sentence', async () => {
    const { brief } = await coachWith([
      { note: '   ', quote: '  let left = 0;', line: 2, fix: '  let left = 1;' },
      { note: 'kept' },
    ]);
    expect(brief.missed).toEqual([{ note: 'kept' }]);
  });

  it('drops a blank string entry too', async () => {
    const { brief } = await coachWith(['', '   ', 'kept']);
    expect(brief.missed).toEqual([{ note: 'kept' }]);
  });

  it('caps the list at eight, because nobody acts on a twenty-item list', async () => {
    const { brief } = await coachWith(
      Array.from({ length: 20 }, (_, i) => `item ${i + 1}`)
    );
    expect(brief.missed).toHaveLength(8);
    expect(brief.missed[7].note).toBe('item 8');
  });
});

describe('anchors', () => {
  it('resolves a quote to the lines it was copied from', async () => {
    const { brief } = await coachWith([
      { note: 'the delete uses the wrong index', quote: '      seen.delete(s[left]);', line: 7 },
    ]);
    expect(brief.missed[0].anchor).toEqual({ startLine: 7, endLine: 7 });
  });

  it('uses `line` to pick between duplicate lines', async () => {
    // `  }` is line 8 and line 11. The quote alone is ambiguous; the hint is
    // the only thing that makes an answer possible.
    const a = await coachWith([{ note: 'inner', quote: '    }', line: 8 }]);
    expect(a.brief.missed[0].anchor).toEqual({ startLine: 8, endLine: 8 });
    const b = await coachWith([{ note: 'outer', quote: '  }', line: 11 }]);
    expect(b.brief.missed[0].anchor).toEqual({ startLine: 11, endLine: 11 });
  });

  it('accepts a numeric STRING line, which is what a constrained decoder emits', async () => {
    const { brief } = await coachWith([
      { note: 'outer brace', quote: '  }', line: '11' },
    ]);
    expect(brief.missed[0].anchor).toEqual({ startLine: 11, endLine: 11 });
  });

  it('ignores a garbage line rather than letting it poison the resolve', async () => {
    // Unique quote: the hint is never consulted, so "line seven-ish" costs
    // nothing. The item must still anchor.
    const { brief } = await coachWith([
      { note: 'the delete', quote: '      seen.delete(s[left]);', line: 'seven-ish' },
    ]);
    expect(brief.missed[0].anchor).toEqual({ startLine: 7, endLine: 7 });
  });

  it('keeps the item when the quote resolves to nothing', async () => {
    // The most likely bad quote in practice: an item about ABSENT code, where
    // the model invents the guard it wishes were there. The note is still worth
    // reading, so the item survives — it just is not clickable.
    const { brief } = await coachWith([
      { note: 'no guard for the empty string', quote: '  if (!s) return 0;', line: 2 },
    ]);
    expect(brief.missed).toHaveLength(1);
    expect(brief.missed[0].anchor).toBeUndefined();
  });
});

describe('fixes', () => {
  it('is a sidecar keyed by index, and never a field on the brief', async () => {
    const { brief, fixes } = await coachWith([
      { note: 'unanchored' },
      {
        note: 'reset left inside the loop',
        quote: '      seen.delete(s[left]);',
        line: 7,
        fix: '      seen.delete(s[left]);\n      left++;',
      },
    ]);
    expect(fixes.size).toBe(1);
    expect(fixes.get(1)).toEqual({
      before: '      seen.delete(s[left]);',
      after: '      seen.delete(s[left]);\n      left++;',
    });
    // The corrected code is not reachable from the brief at all — the whole
    // point. Only the route's stash turns it into a `fixId`.
    expect(JSON.stringify(brief)).not.toContain('left++');
  });

  it('slices `before` out of the submission, not out of the model\'s quote', async () => {
    // The model reindented its quote. `before` must still be the player's own
    // bytes, or the diff shows them a line they never typed.
    const { fixes } = await coachWith([
      {
        note: 'wrong index',
        quote: 'seen.delete(s[left]);',
        line: 7,
        fix: 'seen.delete(s[left]); left++;',
      },
    ]);
    expect(fixes.get(0)?.before).toBe('      seen.delete(s[left]);');
  });

  it('drops the fix when the anchor did not resolve', async () => {
    // A correction with no "before" to sit against is not a diff, it is a code
    // sample — and the popup this feeds draws a diff.
    const { brief, fixes } = await coachWith([
      { note: 'add a guard', quote: '  if (!s) return 0;', fix: '  if (!s) return 0;' },
    ]);
    expect(brief.missed).toHaveLength(1);
    expect(fixes.size).toBe(0);
  });

  it('drops a fix identical to the line it replaces', async () => {
    // What a model emits when it has run out of things to say and is filling a
    // field. Charging a reveal for the player's own line back would be a con.
    const { fixes } = await coachWith([
      { note: 'this line', quote: '  let best = 0;', line: 3, fix: '  let best = 0;' },
    ]);
    expect(fixes.size).toBe(0);
  });

  it('drops a blank fix', async () => {
    const { fixes } = await coachWith([
      { note: 'this line', quote: '  let best = 0;', line: 3, fix: '   \n  ' },
    ]);
    expect(fixes.size).toBe(0);
  });

  it('keeps a multi-line fix against a multi-line anchor', async () => {
    const { brief, fixes } = await coachWith([
      {
        note: 'the two initializers',
        quote: '  let left = 0;\n  let best = 0;',
        line: 2,
        fix: '  let left = 0;\n  let best = -1;',
      },
    ]);
    expect(brief.missed[0].anchor).toEqual({ startLine: 2, endLine: 3 });
    expect(fixes.get(0)?.before).toBe('  let left = 0;\n  let best = 0;');
  });
});

describe('the unresolved-quote instrumentation', () => {
  // Quote fidelity is the assumption the whole feature rests on, and it fails
  // SILENTLY — an unresolved anchor renders as ordinary prose, indistinguishable
  // from a bullet the coach never tried to anchor. This warn is the only way
  // "why is nothing clickable?" is ever answerable.
  it('warns with counts when a quote was given and did not resolve', async () => {
    await coachWith([
      { note: 'a', quote: '  let best = 0;', line: 3 },   // resolves
      { note: 'b', quote: '  if (!s) return 0;' },        // does not
      { note: 'c', quote: 'totally invented line' },      // does not
    ]);
    expect(warn).toHaveBeenCalledWith('[coach] anchor unresolved (2/3)');
  });

  it('stays quiet when every quote resolved', async () => {
    await coachWith([{ note: 'a', quote: '  let best = 0;', line: 3 }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays quiet when nothing was quoted at all', async () => {
    // A string[] brief is not an anchoring failure — nothing was attempted.
    await coachWith(['a note', 'another note']);
    expect(warn).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Truncation, which used to render as a complete brief
// =============================================================================
// A live binary-search submit came back with `approach` and `pattern` filled and
// everything after them empty: no "what you missed", no recognition text, and
// complexity showing "unknown / unknown". Nothing errored, because a truncated
// tool call is not an error — the API returns the PARTIAL input and every field
// the model never reached takes its default. Parsed, that is indistinguishable
// from a terse brief, so the only place it can be caught is the stop reason.
describe('a truncated tool call', () => {
  /** Same 200 shape as `coachWith`, but stopped for length rather than tool_use. */
  async function coachTruncated() {
    mocks.create.mockReset();
    mocks.create.mockImplementation(async (body: Record<string, unknown>) => ({
      model: 'claude-fixture',
      stop_reason: 'max_tokens',
      usage: { input_tokens: 100, output_tokens: 16000, cache_read_input_tokens: 0 },
      content: [
        {
          type: 'tool_use',
          name: (body.tool_choice as { name?: string } | undefined)?.name,
          // What the wire actually carries: the fields it got to, and no others.
          input: { approach: REST.approach, pattern: REST.pattern },
        },
      ],
    }));
    return llm.coach(PROBLEM, USER_CODE, RESULTS);
  }

  it('throws rather than returning the half of the brief that arrived', async () => {
    await expect(coachTruncated()).rejects.toThrow(/truncated at max_tokens/i);
  });

  it('names the problem and the output tokens, so the budget can be judged', async () => {
    await expect(coachTruncated()).rejects.toThrow(/Longest Substring/);
    await expect(coachTruncated()).rejects.toThrow(/16000 output tokens/);
  });

  // The point of throwing: submit.ts turns it into "coaching is temporarily
  // unavailable". A partial brief would instead have rendered an empty "what
  // you missed" and unknown/unknown complexity as though the coach meant them.
  it('does not quietly succeed with empty fields', async () => {
    const result = await coachTruncated().catch(() => null);
    expect(result).toBeNull();
  });
});
