// =============================================================================
// A tool call that collapsed into one of its own string fields
// =============================================================================
// THE BUG THIS PINS SHIPPED, and it shipped in the app's headline feature.
//
// On 4 of 6 real submits — reproduced on two different models, which is what
// rules out one model having a bad day — the coaching brief came back with
// `patternRecognition` ending like this:
//
//     …nested loops.</patternRecognition> <parameter name="complexity">{"yours": "O(n)…
//
// The model had written a well-formed tool call for the first few fields and
// then serialized the REMAINING fields as tool-call markup inside the last
// string it was writing. Nothing in the transport objects: it is a valid
// `tool_use` block holding a valid string. So CoachPanel rendered that markup
// straight to the player, and `complexity` — never emitted as a real field —
// fell through to the "unknown"/"unknown" default, which is exactly the pairing
// that was reported.
//
// The app-side defect was that `structured()` validated TYPE and never CONTENT.
// See findLeakedToolCallFraming in llm.types.ts for why the fix is a guard
// rather than a repair, and why it detects a shape instead of stripping tags.
//
// The payload below is the observed shape, not an invention. It is the fixture
// the whole file is built on, and the property that matters most is the third
// describe block: a lesson that legitimately teaches XML must still get through.

import { describe, it, expect, vi } from 'vitest';
import type { ProblemRecord, TestResult } from '../../shared/types.js';
import { findLeakedToolCallFraming, LlmToolCallError, type ToolSpec } from './llm.types.js';

// -----------------------------------------------------------------------------
// The tools involved, as the app defines them. Named fields matter: the detector
// is schema-aware on purpose, so a test against a made-up schema would prove
// nothing about the real one.
// -----------------------------------------------------------------------------
const COACHING_TOOL: ToolSpec = {
  name: 'emit_coaching',
  description: 'Emit the structured coaching brief.',
  schema: {
    type: 'object',
    properties: {
      approach: { type: 'string' },
      missed: { type: 'array', items: { type: 'string' } },
      pattern: { type: 'string' },
      patternRecognition: { type: 'string' },
      complexity: { type: 'object' },
      improvement: { type: 'string' },
      mistakeTags: { type: 'array', items: { type: 'string' } },
      calibration: { type: 'string' },
    },
    required: ['approach', 'missed', 'pattern', 'patternRecognition', 'complexity', 'improvement'],
  },
};

/** A lesson body plus a code snippet — the shape a lesson about XML lands in. */
const LESSON_TOOL: ToolSpec = {
  name: 'emit_lesson',
  description: 'Emit one lesson.',
  schema: {
    type: 'object',
    properties: {
      body: { type: 'string' },
      code: { type: 'string' },
      takeaway: { type: 'string' },
    },
    required: ['body', 'code', 'takeaway'],
  },
};

// -----------------------------------------------------------------------------
// THE FIXTURE. The observed malformed payload.
// -----------------------------------------------------------------------------
// `complexity`, `improvement` and `mistakeTags` are ABSENT — that is the whole
// point. They were written, but into `patternRecognition` rather than alongside
// it, which is why the UI showed markup in one panel and "unknown" in the next.
const LEAKED_COACHING: Record<string, unknown> = {
  approach: 'You scan every pair with two nested loops and return the first match.',
  missed: ['the empty-input case', 'duplicate values at the same index'],
  pattern: 'two-pointer',
  patternRecognition:
    'A sorted array plus a target sum is the cue: walk one pointer in from each end ' +
    'and let the ordering tell you which to move, instead of restarting the inner ' +
    'scan on every element the way nested loops do.</patternRecognition> ' +
    '<parameter name="complexity">{"yours": "O(n^2) time, O(1) space", "optimal": ' +
    '"O(n) time, O(1) space"}</parameter> <parameter name="improvement">Reach for the ' +
    'two-pointer invariant before you write the second loop.</parameter>',
};

/** The same brief, whole — the happy path the guard must not touch. */
const CLEAN_COACHING: Record<string, unknown> = {
  approach: 'You scan every pair with two nested loops and return the first match.',
  missed: ['the empty-input case'],
  pattern: 'two-pointer',
  patternRecognition: 'A sorted array plus a target sum is the cue to walk two pointers inward.',
  complexity: { yours: 'O(n^2) time, O(1) space', optimal: 'O(n) time, O(1) space' },
  improvement: 'Reach for the two-pointer invariant before you write the second loop.',
  mistakeTags: [],
  calibration: '',
};

describe('the observed malformed coaching payload is detected', () => {
  it('names the field that swallowed the rest', () => {
    const leak = findLeakedToolCallFraming(LEAKED_COACHING, COACHING_TOOL);
    expect(leak).not.toBeNull();
    expect(leak?.field).toBe('patternRecognition');
  });

  it('reports the marker that gave it away, so an operator can recognize it', () => {
    const leak = findLeakedToolCallFraming(LEAKED_COACHING, COACHING_TOOL);
    // Either half of the observed shape is a legitimate catch; what must not
    // happen is a null, or a marker naming a field this tool does not have.
    expect(leak?.marker).toMatch(/complexity|patternRecognition/);
  });

  it('catches the wrapper-only form, where the model opens a whole tool call', () => {
    const leak = findLeakedToolCallFraming(
      { ...CLEAN_COACHING, improvement: 'Drill it.\n<invoke name="emit_coaching">' },
      COACHING_TOOL
    );
    expect(leak?.field).toBe('improvement');
  });

  it('catches a leak inside an ARRAY member, not just a top-level string', () => {
    // `missed` is a string[]; a collapse can land in any element, and a check
    // that only walked the top level would sail past it.
    const leak = findLeakedToolCallFraming(
      {
        ...CLEAN_COACHING,
        missed: ['the empty case', 'off-by-one</missed> <parameter name="pattern">two-pointer'],
      },
      COACHING_TOOL
    );
    expect(leak?.field).toBe('missed[1]');
  });

  it('catches a leak nested inside an object field', () => {
    const leak = findLeakedToolCallFraming(
      {
        ...CLEAN_COACHING,
        complexity: { yours: 'O(n)</complexity> <parameter name="improvement">go', optimal: 'O(n)' },
      },
      COACHING_TOOL
    );
    expect(leak?.field).toBe('complexity.yours');
  });
});

describe('a whole, well-formed answer is left alone', () => {
  it('passes the clean coaching brief', () => {
    expect(findLeakedToolCallFraming(CLEAN_COACHING, COACHING_TOOL)).toBeNull();
  });

  it('passes a brief containing ordinary angle brackets and comparisons', () => {
    expect(
      findLeakedToolCallFraming(
        {
          ...CLEAN_COACHING,
          approach: 'You loop while `lo < hi` and compare `nums[lo] + nums[hi] > target`.',
          improvement: 'Prefer `a <= b` over `!(a > b)` — it reads as the invariant it is.',
        },
        COACHING_TOOL
      )
    ).toBeNull();
  });

  it('passes an empty result rather than treating "nothing" as a leak', () => {
    expect(findLeakedToolCallFraming({}, COACHING_TOOL)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// The property that decides whether this guard is acceptable at all
// -----------------------------------------------------------------------------
// codegrind teaches programming. A lesson about parsing XML, or about escaping
// HTML, legitimately contains tags — including tags whose names collide with
// this app's own schema fields (`title` in emit_problem, `code` in emit_lesson).
// A guard that stripped or rejected tags in prose would fail those lessons, and
// it would fail them silently, on the exact material the app exists to teach.
describe('content that legitimately contains markup still gets through', () => {
  it('passes a lesson that teaches XML parsing', () => {
    const lesson = {
      body:
        'An XML element is written `<book>` and closed with `</book>`. A parser that ' +
        'matches `<title>` against `</title>` by scanning for the next `>` breaks the ' +
        'moment an attribute value contains one.',
      code: 'const m = xml.match(/<title>(.*?)<\\/title>/);',
      takeaway: 'Never parse nested markup with a regex.',
    };
    expect(findLeakedToolCallFraming(lesson, LESSON_TOOL)).toBeNull();
  });

  it('passes a lesson holding a bare, unmatched `</code>` — a real HTML tag AND a field name', () => {
    // `code` is a property of emit_lesson, so the unmatched-close-tag rule could
    // have fired here. It does not, because nothing tool-call-shaped follows it —
    // which is the corroboration that separates torn markup from prose.
    const lesson = {
      body: 'Authors often forget the closing `</code>` when hand-writing HTML.',
      code: 'x = 1',
      takeaway: 'Let the serializer close your tags.',
    };
    expect(findLeakedToolCallFraming(lesson, LESSON_TOOL)).toBeNull();
  });

  it('passes prose that merely mentions a `<parameter>` element by that name', () => {
    // Named after no field of this tool, so it is somebody else's XML, not ours.
    const lesson = {
      body: 'Ant build files nest a `<parameter name="verbose">` inside a task.',
      code: 'x = 1',
      takeaway: 'Configuration formats are data, not code.',
    };
    expect(findLeakedToolCallFraming(lesson, LESSON_TOOL)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// End to end: what a player actually gets
// -----------------------------------------------------------------------------
// Driven through the real llm.service -> llm.client -> adapter path with the SDK
// faked, exactly as llm.golden.test.ts does. Nothing here reaches the network,
// so it needs no key and costs nothing.
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

const PROBLEM: ProblemRecord = {
  id: 'leak-fixture',
  language: 'javascript',
  title: 'Pair Sum',
  prompt: 'Find the pair that sums to the target.',
  examples: [{ input: '[1,2,3], 5', output: '[1,2]' }],
  constraints: ['1 <= n <= 1000'],
  difficulty: 'easy',
  topic: 'two-pointer',
  pattern: 'two-pointer',
  starterCode: 'function pairSum(nums, target) {}',
  functionName: 'pairSum',
  sampleTests: [{ name: 's1', args: [[1, 2, 3], 5], expected: [1, 2] }],
  hiddenTests: [{ name: 'h1', args: [[], 0], expected: [] }],
  referenceSolution: 'function pairSum(nums, target) { return []; }',
  canonicalized: true,
  used: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const RESULTS: TestResult[] = [{ name: 'h1', passed: false, timeMs: 4 }];

/** Answer the forced tool call with `input`, the way a real 200 would. */
function answerWith(input: Record<string, unknown>) {
  mocks.create.mockReset();
  mocks.create.mockImplementation(async (body: Record<string, unknown>) => ({
    model: 'claude-fixture',
    stop_reason: 'tool_use',
    usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 0 },
    content: [
      {
        type: 'tool_use',
        name: (body.tool_choice as { name?: string } | undefined)?.name,
        input,
      },
    ],
  }));
}

describe('coach() rejects the collapsed brief instead of rendering it', () => {
  it('throws LlmToolCallError rather than returning markup and two "unknown"s', async () => {
    answerWith(LEAKED_COACHING);
    await expect(llm.coach(PROBLEM, 'function pairSum() {}', RESULTS)).rejects.toBeInstanceOf(
      LlmToolCallError
    );
  });

  it('says which field collapsed, because that is the whole diagnosis', async () => {
    answerWith(LEAKED_COACHING);
    await expect(llm.coach(PROBLEM, 'function pairSum() {}', RESULTS)).rejects.toThrow(
      /patternRecognition/
    );
  });

  it('is a SEMANTIC failure — one call, never retried at the transport layer', async () => {
    answerWith(LEAKED_COACHING);
    await expect(llm.coach(PROBLEM, 'function pairSum() {}', RESULTS)).rejects.toThrow();
    // Three attempts here would be three paid calls re-sending a prompt that
    // just failed. routes/submit.ts catches this and shows the "coaching is
    // temporarily unavailable" brief; bank generation varies the prompt itself.
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('still returns the brief when the model answers properly', async () => {
    answerWith(CLEAN_COACHING);
    const brief = await llm.coach(PROBLEM, 'function pairSum() {}', RESULTS);
    expect(brief.patternRecognition).toContain('two pointers');
    expect(brief.complexity.yours).toBe('O(n^2) time, O(1) space');
    expect(brief.complexity.optimal).toBe('O(n) time, O(1) space');
  });
});

describe('the guard covers every forced tool call, not just coaching', () => {
  it('rejects a generated problem whose statement swallowed the later fields', async () => {
    // Same failure, different call site — which is the reason the check lives in
    // llm.client.structured() rather than inside coach().
    answerWith({
      title: 'Pair Sum',
      prompt:
        'Find the pair.</prompt> <parameter name="functionName">pairSum</parameter>',
      pattern: 'two-pointer',
      examples: [],
      constraints: [],
      functionName: 'pairSum',
      starterCode: 'function pairSum() {}',
      sampleTests: [{ name: 's1', args: [[]], expected: [] }],
      hiddenTests: [{ name: 'h1', args: [[]], expected: [] }],
      referenceSolution: 'function pairSum() { return []; }',
    });
    await expect(llm.generateProblem('javascript', 'arrays', 'easy')).rejects.toThrow(/prompt/);
  });
});
