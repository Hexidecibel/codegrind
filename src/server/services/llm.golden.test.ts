// =============================================================================
// llm.golden.test — the request bodies, byte for byte, key order included
// =============================================================================
// THIS IS THE CHECKPOINT FOR THE PROVIDER ABSTRACTION.
//
// Every LLM call in this app is one `messages.create` whose body was, until the
// abstraction landed, written out by hand at the call site. Moving those bodies
// behind an adapter is the one change that can silently regress the incumbent:
// nothing downstream would notice a dropped `cache_control`, a `thinking` that
// became adaptive, or — most expensively — a body whose keys came out in a
// different ORDER.
//
// Key order is load-bearing, not cosmetic. Anthropic's prompt cache keys on a
// PREFIX of the serialized request, and `tools` sits in front of `system`
// (llm.service.ts documents this at the precomputation of
// EMIT_PROBLEM_TOOL_BY_LANGUAGE). Reordering the body silently invalidates the
// cache on every request and nothing reports it — the app still works, and the
// bill goes up. So the assertion here is on the SERIALIZED body, not on a deep
// equality that would consider {a,b} and {b,a} the same thing.
//
// The fixture was captured from the pre-abstraction code, with a fake transport
// standing in for the SDK. Regenerate it — deliberately, never to make a red
// test go green — with:
//
//     bin/capture-llm-bodies
//
// The fake transport also stands in for the network, so this test costs nothing
// and needs no key beyond the presence check.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type {
  ProblemRecord,
  TestResult,
  Prediction,
  Primer,
  TrackOutlineItem,
  ChatTurn,
} from '../../shared/types.js';

const FIXTURE = fileURLToPath(
  new URL('./__fixtures__/llm-request-bodies.json', import.meta.url)
);
const UPDATE = process.env.CG_UPDATE_GOLDEN === '1';

// -----------------------------------------------------------------------------
// The fake transport.
// -----------------------------------------------------------------------------
// It records the outgoing body and answers with whatever the forced tool asked
// for, so every call site runs its real happy path — the body is captured AND
// the unwrapping still has to work.
const mocks = vi.hoisted(() => {
  const create = vi.fn();
  return { create };
});

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: mocks.create };
    constructor(_opts: unknown) {}
  }
  return { default: FakeAnthropic };
});

process.env.ANTHROPIC_API_KEY = 'test-key-not-used';

/** One canned tool result per tool name — enough for the real unwrapping to pass. */
const TOOL_RESULTS: Record<string, Record<string, unknown>> = {
  emit_problem: {
    title: 'Fixture Problem',
    prompt: 'Do the thing.',
    pattern: 'two-pointer',
    examples: [{ input: '[1,2]', output: '3' }],
    constraints: ['1 <= n <= 10'],
    functionName: 'solve',
    starterCode: 'function solve(a) {}',
    sampleTests: [{ name: 's1', args: [[1, 2]], expected: 3 }],
    hiddenTests: [{ name: 'h1', args: [[1, 2, 3]], expected: 6 }],
    referenceSolution: 'function solve(a) { return a.reduce((x, y) => x + y, 0); }',
  },
  emit_coaching: {
    approach: 'You scanned the array twice.',
    missed: ['the empty case'],
    pattern: 'two-pointer',
    patternRecognition: 'Sorted input plus a target sum.',
    complexity: { yours: 'O(n^2) time, O(1) space', optimal: 'O(n) time, O(1) space' },
    improvement: 'Reach for the two-pointer invariant first.',
    mistakeTags: ['off-by-one'],
    calibration: 'You predicted O(n) but wrote O(n^2).',
  },
  emit_hint: { text: 'Think about what the sortedness buys you.' },
  emit_session_plan: {
    theme: 'Pointer discipline',
    coachIntro: "We'll drill the two-pointer invariant today.",
    focus: ['arrays', 'two-pointer'],
  },
  emit_primer: {
    recognitionCues: ['sorted input', 'pair sums'],
    template: 'let lo = 0, hi = n - 1;',
    pitfalls: ['moving both pointers at once'],
    example: { title: 'Two Sum II', insight: 'Sortedness makes the scan monotone.' },
  },
  emit_outline: {
    lessons: [{ kind: 'concept', title: 'The invariant', brief: 'What the two pointers maintain.' }],
  },
  emit_lesson: {
    body: 'The two pointers maintain an invariant.',
    code: 'let lo = 0;',
    takeaway: 'The invariant is the algorithm.',
  },
  emit_translations: {
    translations: [
      { id: 'primer:arrays', code: 'i = 0' },
      { id: 'lesson:arrays:1', code: 'total = sum(nums)' },
    ],
  },
};

mocks.create.mockImplementation(async (body: Record<string, unknown>) => {
  const choice = body.tool_choice as { name?: string } | undefined;
  const name = choice?.name;
  const usage = { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 0 };
  if (!name) {
    return {
      model: 'claude-fixture',
      stop_reason: 'end_turn',
      usage,
      content: [{ type: 'text', text: 'Here is the whole algorithm.' }],
    };
  }
  return {
    model: 'claude-fixture',
    stop_reason: 'tool_use',
    usage,
    content: [{ type: 'tool_use', name, input: TOOL_RESULTS[name] ?? {} }],
  };
});

const llm = await import('./llm.service.js');

// -----------------------------------------------------------------------------
// Fixed inputs. Every one of these is a constant on purpose: a body that varies
// between runs cannot be a golden fixture.
// -----------------------------------------------------------------------------
const PROBLEM: ProblemRecord = {
  id: 'fixture-problem',
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

const RESULTS: TestResult[] = [
  { name: 's1', passed: true, timeMs: 3 },
  { name: 'h1', passed: false, expected: '[]', actual: 'null', stderr: 'TypeError: nope', timeMs: 5 },
];

const PREDICTION: Prediction = {
  approach: 'two pointers from both ends',
  predTime: 'O(n)',
  predSpace: 'O(1)',
  confidence: 4,
};

const PRIMER: Primer = {
  pattern: 'two-pointer',
  recognitionCues: ['sorted input', 'pair sums'],
  template: 'let lo = 0, hi = n - 1;',
  pitfalls: ['moving both pointers at once'],
  example: { title: 'Two Sum II', insight: 'Sortedness makes the scan monotone.' },
};

const OUTLINE_ITEM: TrackOutlineItem = {
  seq: 3,
  kind: 'template',
  title: 'The invariant',
  brief: 'What the two pointers maintain, and why it holds.',
};

const HISTORY: ChatTurn[] = [
  { role: 'user', content: 'Why is mine O(n^2)?' },
  { role: 'assistant', content: 'Because the inner scan restarts.' },
  { role: 'user', content: '   ' },
];

const USER_CODE = 'function pairSum(nums, target) { return null; }';

/** Run one call site with the fake transport and hand back the body it sent. */
async function capture(run: () => Promise<unknown>): Promise<unknown> {
  mocks.create.mockClear();
  await run();
  expect(mocks.create).toHaveBeenCalledTimes(1);
  return mocks.create.mock.calls[0][0];
}

// -----------------------------------------------------------------------------
// The eleven call sites. `generateProblem` appears twice: once plain, once with
// every steering option set, because the options are the only part of a body
// that is assembled rather than constant.
// -----------------------------------------------------------------------------
const CAPTURED: Record<string, unknown> = {
  'generateProblem javascript/arrays/easy': await capture(() =>
    llm.generateProblem('javascript', 'arrays', 'easy')
  ),
  'generateProblem go/binary-search/expert +opts': await capture(() =>
    llm.generateProblem('go', 'binary-search', 'expert', {
      variationOf: { title: 'Old One', pattern: 'binary-search', prompt: 'The old statement.' },
      avoidTitles: ['Old One', 'Older One'],
      noveltyHint: 'Introduce this pattern gently.',
    })
  ),
  coach: await capture(() => llm.coach(PROBLEM, USER_CODE, RESULTS, PREDICTION)),
  hint: await capture(() => llm.hint(PROBLEM, USER_CODE, 2)),
  planSession: await capture(() =>
    llm.planSession([
      {
        topic: 'arrays',
        attempted: 4,
        solved: 3,
        tier: 'easy',
        towardNext: 2,
        tierRequirement: 3,
        nextTier: 'medium',
        currentDifficulty: 'medium',
        due: true,
        weak: false,
      },
    ])
  ),
  askFollowup: await capture(() =>
    llm.askFollowup(PROBLEM, USER_CODE, 'Why does the invariant hold?', HISTORY, RESULTS)
  ),
  generatePrimer: await capture(() => llm.generatePrimer('two-pointer')),
  generateTrackOutline: await capture(() => llm.generateTrackOutline('two-pointer')),
  generateLessonBody: await capture(() =>
    llm.generateLessonBody('two-pointer', OUTLINE_ITEM, PRIMER)
  ),
  generateMistakeLesson: await capture(() =>
    llm.generateMistakeLesson('off-by-one', 'arrays', 7, {
      problemTitle: 'Pair Sum',
      prompt: 'Find the pair that sums to the target.',
    })
  ),
  generateWalkthroughLesson: await capture(() => llm.generateWalkthroughLesson(PROBLEM, 4)),
  translateSnippets: await capture(() =>
    llm.translateSnippets(
      [
        { id: 'primer:arrays', code: 'let i = 0;' },
        { id: 'lesson:arrays:1', code: 'const total = nums.reduce((a, b) => a + b, 0);' },
      ],
      'javascript',
      'python'
    )
  ),
};

if (UPDATE) {
  mkdirSync(dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, `${JSON.stringify(CAPTURED, null, 2)}\n`);
}

const GOLDEN = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;

// =============================================================================
describe('the request body of every LLM call site', () => {
  it('covers all eleven call sites', () => {
    // Twelve entries, eleven sites: generateProblem is captured twice. If a
    // twelfth site is added, it belongs here before it ships.
    expect(Object.keys(CAPTURED)).toHaveLength(12);
    expect(Object.keys(GOLDEN)).toEqual(Object.keys(CAPTURED));
  });

  for (const name of Object.keys(CAPTURED)) {
    it(`${name} — serializes identically to the golden capture`, () => {
      // JSON.stringify, not toEqual: object key ORDER is the property under
      // test, and a structural comparison cannot see it.
      expect(JSON.stringify(CAPTURED[name], null, 2)).toBe(
        JSON.stringify(GOLDEN[name], null, 2)
      );
    });
  }

  it('puts tools in front of system, which is what the prompt cache keys on', () => {
    const body = CAPTURED['generateProblem javascript/arrays/easy'] as Record<string, unknown>;
    expect(Object.keys(body)).toEqual([
      'model',
      'max_tokens',
      'thinking',
      'system',
      'tools',
      'tool_choice',
      'messages',
    ]);
  });

  it('still marks the system prompt ephemeral on every call', () => {
    for (const [name, body] of Object.entries(CAPTURED)) {
      const system = (body as { system?: unknown[] }).system;
      expect(system, name).toEqual([
        expect.objectContaining({ type: 'text', cache_control: { type: 'ephemeral' } }),
      ]);
    }
  });
});
