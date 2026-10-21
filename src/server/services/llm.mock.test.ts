// =============================================================================
// llm.mock — the two mock-interview calls, against a fake transport
// =============================================================================
// Costs nothing: the SDK is replaced by a fake that records the body and answers
// with whatever the test hands it. Three things are pinned:
//
//   1. THE BODIES, byte for byte, in their own golden fixture
//      (__fixtures__/mock-request-bodies.json). Same discipline as
//      llm.golden.test.ts: regenerate deliberately with bin/capture-llm-bodies,
//      never to turn a red test green.
//   2. THE CACHE MARKERS. `cacheConversation: 'long'` must put a 1-hour marker
//      on the system block AND on the last message, and on no other message —
//      and every call that does not ask must serialize exactly as before.
//   3. THE LADDERS. A truncated reply or grade is an error, never a partial
//      answer; a structurally broken grade retries ONCE with the lean schema;
//      a truncated grade does not retry at all.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const FIXTURE = fileURLToPath(new URL('./__fixtures__/mock-request-bodies.json', import.meta.url));
const UPDATE = process.env.CG_UPDATE_GOLDEN === '1';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: mocks.create };
    constructor(_opts: unknown) {}
  }
  return { default: FakeAnthropic };
});

process.env.ANTHROPIC_API_KEY = 'test-key-not-used';
// Pin the routing so the fixture names a model regardless of the environment.
delete process.env.CODEGRIND_PROVIDER;
delete process.env.ANTHROPIC_MODEL;

const { interviewerTurn, gradeMock, coerceReply, INTERVIEWER_TOOL, EMIT_MOCK_GRADE_TOOL, INTERVIEWER_SYSTEM, GRADE_SYSTEM } =
  await import('./llm.mock.js');
const { createAnthropicClient } = await import('./llm.anthropic.js');
const { buildContext, buildMessages } = await import('./mock.state.js');
const { sdPrompt } = await import('../../shared/sd-prompts.js');
const { LlmToolCallError } = await import('./llm.types.js');

const REPLY = {
  observations: [{ concept: 'clarifying-questions', signal: 'nailed', note: 'asked who the users are' }],
  stage: 'requirements',
  stagesCovered: [],
  mode: 'interview',
  teach: null,
  resumePoint: '',
  say: 'Good. How many tickets go on sale at once?',
};

const GRADE = {
  verdict: 'at',
  summary: 'Solid requirements, thin deep dive.',
  stages: [{ stage: 'requirements', score: 3, evidence: '#2', atLevel: true, staffWouldAdd: 'x', principalWouldAdd: 'y' }],
  skipped: [],
  gapsTaught: [{ concept: 'idempotency', summary: 'did not know idempotency keys' }],
  conceptObservations: [{ concept: 'failure-ranking', signal: 'weak', note: 'listed, not ranked' }],
  drills: [{ concept: 'failure-ranking', prompt: 'Rank the failures for a URL shortener.', why: 'weak twice' }],
};

function answer(input: Record<string, unknown>, stop = 'tool_use', name = 'interviewer_turn') {
  return {
    model: 'claude-sonnet-5',
    stop_reason: stop,
    usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 40 },
    content: [{ type: 'tool_use', name, input }],
  };
}

const CONTEXT = buildContext(sdPrompt('event-ticketing')!, 'staff');
const MESSAGES = buildMessages(
  CONTEXT,
  [
    { seq: 1, role: 'interviewer', rendered: 'Design a ticketing system. Where would you start?' },
    { seq: 2, role: 'candidate', rendered: 'Who buys tickets?\n\n[server: 1 of 45 min]' },
    { seq: 3, role: 'interviewer', rendered: 'Members of the public, on phones.' },
  ],
  'How many at once?\n\n[server: 2 of 45 min]'
);

beforeEach(() => mocks.create.mockReset());

// -----------------------------------------------------------------------------
// 1. Golden bodies
// -----------------------------------------------------------------------------
mocks.create.mockResolvedValueOnce(answer(REPLY));
await interviewerTurn(MESSAGES, 'requirements');
const interviewerBody = mocks.create.mock.calls[0][0];
mocks.create.mockReset();
mocks.create.mockResolvedValueOnce(answer(GRADE, 'tool_use', 'emit_mock_grade'));
await gradeMock({
  level: 'staff',
  promptTitle: 'A ticketing system for events',
  brief: 'Design a ticketing system.',
  transcript: '#1 INTERVIEWER: Go.\n#2 CANDIDATE: Who buys?',
  skipped: ['capacity'],
  taught: ['idempotency'],
  recordedGaps: [{ seq: 19, type: 'skill', title: 'Rank the failures for a ticketing system.', summary: 's' }],
});
const gradeBody = mocks.create.mock.calls[0][0];

// Behavioral: the same two calls with the behavioral spec. The grade carries
// the frozen story bank (graderContext) after the rubric; the interviewer never does.
const { BEHAVIORAL_SPEC } = await import('./mock-kinds/behavioral.js');
const { renderGraderContext, normalizeBank } = await import('./story-bank.js');
const B_PLAN = {
  items: [
    { stage: 'q1', concept: 'conflict', questionId: 'con-peer', question: 'Tell me about a time you strongly disagreed with a peer on a technical decision. How was it resolved?' },
    { stage: 'q2', concept: 'influence-without-authority', questionId: 'iwa-adopt', question: 'Describe a technical direction you championed that other teams adopted. How did you get buy-in?' },
    { stage: 'q3', concept: 'failure-learning', questionId: 'fail-underestimate', question: 'Describe a project where you badly underestimated something. What did you change afterwards?' },
    { stage: 'q4', concept: 'exec-communication', questionId: 'exec-bad-news', question: 'Describe a time you had to tell leadership something they did not want to hear.' },
  ],
};
const B_BANK = normalizeBank({
  stories: [
    {
      id: 'story-saas-rebuild', title: 'Rebuilding as multi-tenant SaaS', status: 'confirmed',
      situation: 'Each customer had its own environment.', task: 'Assigned the replacement.', action: 'Led the architecture.', result: '50+ tenants.',
      numbers: ['~$3,000 -> ~$300/month per environment'], caveats: ['Approximate; say roughly.'], unconfirmed: ['Customers per environment'],
      fits: ['long-horizon architecture'], doesNotFit: [],
    },
  ],
  gaps: [{ type: 'disagreement or conflict', status: 'open' }],
});
const B_GRADER = renderGraderContext({ ok: true, bank: B_BANK });
const B_CONTEXT = BEHAVIORAL_SPEC.buildContext(BEHAVIORAL_SPEC.info.pickPrompt([]), 'staff', {
  plan: B_PLAN,
  graderContext: B_GRADER,
  reasons: {},
});
mocks.create.mockReset();
mocks.create.mockResolvedValueOnce(answer({ ...REPLY, observations: [], stage: 'intro', say: 'Tell me about yourself.' }));
await interviewerTurn(
  buildMessages(B_CONTEXT, [
    { seq: 1, role: 'interviewer', rendered: 'Tell me about yourself.' },
    { seq: 2, role: 'candidate', rendered: 'I lead backend architecture.\n\n[server: 1 of 35 min]' },
    { seq: 3, role: 'interviewer', rendered: 'Thanks. Tell me about a time you strongly disagreed with a peer.' },
  ], 'We disagreed about tenancy.\n\n[server: 4 of 35 min]'),
  'q1',
  'behavioral'
);
const behavioralInterviewerBody = mocks.create.mock.calls[0][0];
mocks.create.mockReset();
mocks.create.mockResolvedValueOnce(answer({ ...GRADE, stages: [], gapsTaught: [], conceptObservations: [], drills: [], questions: [], storyGaps: [] }, 'tool_use', 'emit_mock_grade'));
await gradeMock({
  kind: 'behavioral',
  level: 'staff',
  promptTitle: 'Staff behavioral loop',
  brief: 'Tell me about yourself, then four questions.',
  transcript: '--- stage: q1 (Q1) ---\n#3 INTERVIEWER: Tell me about a time you disagreed.\n#4 CANDIDATE (5 words): We disagreed about tenancy.',
  skipped: [],
  taught: [],
  recordedGaps: [],
  graderContext: B_GRADER,
});
const behavioralGradeBody = mocks.create.mock.calls[0][0];
mocks.create.mockReset();

// Coding: the problem AND the reference in the frozen context (interviewer
// only, with the never-leak rule); candidate turns carry the [editor] block and
// the [run] line; the grader gets the reference and the hidden-test result.
const { CODING_SPEC } = await import('./mock-kinds/coding.js');
const C_PROBLEM = {
  id: 'p-two-sum', language: 'javascript' as const, title: 'Two Sum',
  prompt: 'Given an array of integers and a target, return the indices of the two numbers that add up to the target.',
  examples: [{ input: 'nums = [2,7,11,15], target = 9', output: '[0,1]' }],
  constraints: ['2 <= nums.length <= 10^4', 'exactly one answer exists'],
  difficulty: 'medium' as const, topic: 'hashing' as const, pattern: 'hash map',
  starterCode: 'function twoSum(nums, target) {\n}\n', functionName: 'twoSum',
  sampleTests: [], hiddenTests: [{ name: 'hidden 1', args: [], expected: [0, 1] }],
  referenceSolution: 'function twoSum(nums, target) {\n  const seen = new Map();\n  for (let i = 0; i < nums.length; i++) {\n    const j = seen.get(target - nums[i]);\n    if (j !== undefined) return [j, i];\n    seen.set(nums[i], i);\n  }\n}',
  canonicalized: true, used: true, createdAt: '2026-10-21T00:00:00Z',
};
const C_PREP = await CODING_SPEC.prepare!({
  level: 'staff', requested: undefined, history: [], recentQuestionIds: [],
  coding: { weakestTopic: () => 'hashing', fetchProblem: async () => C_PROBLEM },
});
const C_CONTEXT = CODING_SPEC.buildContext(CODING_SPEC.info.pickPrompt([]), 'staff', C_PREP);
mocks.create.mockResolvedValueOnce(answer({ ...REPLY, observations: [], stage: 'approach', say: 'What are you recomputing in that inner loop?' }));
await interviewerTurn(
  buildMessages(C_CONTEXT, [
    { seq: 1, role: 'interviewer', rendered: 'Hi — the problem is beside your editor. Talk me through your understanding of it.' },
    { seq: 2, role: 'candidate', rendered: 'Can the array have duplicates?\n\n[server: 1 of 45 min]' },
    { seq: 3, role: 'interviewer', rendered: 'Yes, it can.' },
  ], 'Brute force is two loops, O(n^2).\n\n[editor — the candidate\'s code now (javascript, 5 lines); changed since you last saw it]\n```javascript\nfunction twoSum(nums, target) {\n  for (let i = 0; i < nums.length; i++)\n    for (let j = i + 1; j < nums.length; j++)\n      if (nums[i] + nums[j] === target) return [i, j];\n}\n```\n\n[run: Run (sample tests): 2/2 passed, accepted]\n\n[server: 9 of 45 min]'),
  'approach',
  'coding'
);
const codingInterviewerBody = mocks.create.mock.calls[0][0];
mocks.create.mockReset();
mocks.create.mockResolvedValueOnce(answer({ ...GRADE, stages: [], gapsTaught: [], conceptObservations: [], drills: [], coding: { patternMissed: false, patternNote: 'n', complexityStated: 'O(n)', complexityOptimal: 'O(n)' } }, 'tool_use', 'emit_mock_grade'));
await gradeMock({
  kind: 'coding',
  level: 'staff',
  promptTitle: 'Live coding',
  brief: 'Two Sum (medium)',
  transcript: '--- stage: code (Code) ---\n#8 CANDIDATE: done\n[editor — x]\n```javascript\nreturn [0, 1];\n```',
  skipped: [],
  taught: [],
  recordedGaps: [],
  graderContext: CODING_SPEC.graderContext!({
    stage: 'test', covered: [], skipped: [], startedAt: '', candidateTurns: 8, pendingOffer: null, taught: [], pendingSkipNote: [], endNoteSent: false,
    graderContext: C_PREP.graderContext,
    coding: { ...C_PREP.coding!, submits: 1, final: { verdict: 'wrong_answer', passed: 7, total: 9, failing: ['hidden 4', 'hidden 8'], codeHash: 'h', at: '', source: 'submit' } },
  }),
});
const codingGradeBody = mocks.create.mock.calls[0][0];
mocks.create.mockReset();

const CAPTURED = {
  interviewerTurn: interviewerBody,
  gradeMock: gradeBody,
  behavioralInterviewerTurn: behavioralInterviewerBody,
  behavioralGradeMock: behavioralGradeBody,
  codingInterviewerTurn: codingInterviewerBody,
  codingGradeMock: codingGradeBody,
};
if (UPDATE) {
  mkdirSync(dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, `${JSON.stringify(CAPTURED, null, 2)}\n`);
}
const GOLDEN = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;

describe('the mock request bodies', () => {
  for (const name of Object.keys(CAPTURED) as (keyof typeof CAPTURED)[]) {
    it(`${name} — serializes identically to the golden capture`, () => {
      expect(JSON.stringify(CAPTURED[name], null, 2)).toBe(JSON.stringify(GOLDEN[name], null, 2));
    });
  }

  it('keeps the cache-relevant key order', () => {
    expect(Object.keys(interviewerBody)).toEqual([
      'model',
      'max_tokens',
      'thinking',
      'system',
      'tools',
      'tool_choice',
      'messages',
    ]);
  });

  it('runs the interviewer on the workhorse, thinking off, forced tool, strict schema', () => {
    expect(interviewerBody.model).toBe('claude-sonnet-5');
    expect(interviewerBody.thinking).toEqual({ type: 'disabled' });
    expect(interviewerBody.tool_choice).toEqual({ type: 'tool', name: 'interviewer_turn' });
    expect(interviewerBody.tools[0].strict).toBe(true);
    expect(interviewerBody.max_tokens).toBe(3000);
  });

  it('runs the grader with adaptive thinking and 16000 tokens, and no conversation marker', () => {
    expect(gradeBody.thinking).toEqual({ type: 'adaptive' });
    expect(gradeBody.max_tokens).toBe(16000);
    expect(gradeBody.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(typeof gradeBody.messages[0].content).toBe('string');
  });
});

// -----------------------------------------------------------------------------
// 2. Cache markers
// -----------------------------------------------------------------------------
describe('cacheConversation', () => {
  it("'long' puts a 1-hour marker on the system and the LAST message only", () => {
    expect(interviewerBody.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    const msgs = interviewerBody.messages as { content: { cache_control?: unknown }[] }[];
    expect(msgs).toHaveLength(MESSAGES.length);
    msgs.forEach((m, i) => {
      expect(Array.isArray(m.content)).toBe(true);
      expect(m.content).toHaveLength(1);
      if (i === msgs.length - 1) expect(m.content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
      else expect(m.content[0].cache_control).toBeUndefined();
    });
  });

  it('passes the message text through byte for byte', () => {
    const msgs = interviewerBody.messages as { role: string; content: { text: string }[] }[];
    expect(msgs.map((m) => ({ role: m.role, content: m.content[0].text }))).toEqual(MESSAGES);
  });

  const client = createAnthropicClient('claude-sonnet-5');
  const base = {
    role: 'workhorse' as const,
    system: 'S',
    tool: INTERVIEWER_TOOL,
    maxTokens: 10,
    messages: [
      { role: 'user' as const, content: 'a' },
      { role: 'assistant' as const, content: 'b' },
      { role: 'user' as const, content: 'c' },
    ],
  };

  it("'short' marks the last message with a 5-minute marker and leaves the system marker alone", async () => {
    mocks.create.mockResolvedValueOnce(answer(REPLY));
    await client.structured({ ...base, cacheConversation: 'short' });
    const body = mocks.create.mock.calls[0][0];
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.messages[2].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.messages[0].content[0].cache_control).toBeUndefined();
  });

  it('absent, the messages go out exactly as handed over (the golden-fixture path)', async () => {
    mocks.create.mockResolvedValueOnce(answer(REPLY));
    await client.structured(base);
    const body = mocks.create.mock.calls[0][0];
    expect(body.messages).toEqual(base.messages);
    expect(body.system).toEqual([{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }]);
  });

  it('reports cache writes alongside cache reads', async () => {
    mocks.create.mockResolvedValueOnce(answer(REPLY));
    const res = await client.structured(base);
    expect(res.meta.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cachedInputTokens: 300,
      cacheWriteInputTokens: 40,
    });
  });
});

// -----------------------------------------------------------------------------
// 3. Coercion and ladders
// -----------------------------------------------------------------------------
describe('the interviewer reply', () => {
  it('coerces unknown stages to "no change" and drops a teach without a concept', () => {
    const r = coerceReply({ ...REPLY, stage: 'nonsense', mode: 'teach', teach: null }, 'api');
    expect(r.stage).toBe('api');
    expect(r.mode).toBe('interview');
    expect(r.teach).toBeNull();
  });

  it('keeps a teach turn with its concept', () => {
    const r = coerceReply(
      { ...REPLY, mode: 'teach', teach: { concept: 'idempotency', gapSummary: 'g' }, resumePoint: 'Back: …' },
      'api'
    );
    expect(r.mode).toBe('teach');
    expect(r.teach).toEqual({ concept: 'idempotency', gapSummary: 'g' });
  });

  it('cuts leaked tool-call markup off the visible line', () => {
    const r = coerceReply({ ...REPLY, say: 'How many buyers?</antml :parameter>\n' }, 'requirements');
    expect(r.say).toBe('How many buyers?');
  });

  it('refuses an empty line rather than storing an empty turn', async () => {
    mocks.create.mockResolvedValueOnce(answer({ ...REPLY, say: '   ' }));
    await expect(interviewerTurn(MESSAGES, 'requirements')).rejects.toBeInstanceOf(LlmToolCallError);
  });

  it('treats a truncated reply as an error', async () => {
    mocks.create.mockResolvedValueOnce(answer(REPLY, 'max_tokens'));
    await expect(interviewerTurn(MESSAGES, 'requirements')).rejects.toThrow(/truncated at max_tokens/);
  });

  it('drops observations outside the closed vocabulary', async () => {
    mocks.create.mockResolvedValueOnce(
      answer({
        ...REPLY,
        observations: [
          { concept: 'vibes', signal: 'nailed', note: 'x' },
          { concept: 'idempotency', signal: 'great', note: 'x' },
          { concept: 'idempotency', signal: 'weak', note: 'only when pushed' },
        ],
      })
    );
    const { observations } = await interviewerTurn(MESSAGES, 'requirements');
    expect(observations).toEqual([{ concept: 'idempotency', signal: 'weak', note: 'only when pushed' }]);
  });
});

describe('the grade', () => {
  const input = {
    level: 'staff' as const,
    promptTitle: 'T',
    brief: 'B',
    transcript: '#1 INTERVIEWER: Go.',
    skipped: [],
    taught: [],
  };

  it('fills every stage, in order, even when the model forgot some', async () => {
    mocks.create.mockResolvedValueOnce(answer(GRADE, 'tool_use', 'emit_mock_grade'));
    const { grade, metas } = await gradeMock(input);
    expect(grade.stages.map((s) => s.stage)).toEqual([
      'requirements',
      'capacity',
      'api',
      'data-model',
      'high-level',
      'deep-dive',
      'tradeoffs',
    ]);
    expect(grade.stages[1]).toMatchObject({ score: 0, evidence: 'not reached' });
    expect(grade.drills).toHaveLength(1);
    expect(metas).toHaveLength(1);
  });

  it('is an error when truncated, and does not retry', async () => {
    mocks.create.mockResolvedValueOnce(answer(GRADE, 'max_tokens', 'emit_mock_grade'));
    await expect(gradeMock(input)).rejects.toThrow(/Grade truncated/);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('retries a structurally broken grade ONCE with the lean schema', async () => {
    mocks.create
      .mockResolvedValueOnce({ ...answer({}, 'end_turn'), content: [{ type: 'text', text: 'prose' }] })
      .mockResolvedValueOnce(
        answer({ ...GRADE, gapsTaught: ['idempotency'], conceptObservations: undefined }, 'tool_use', 'emit_mock_grade')
      );
    const { grade, metas } = await gradeMock(input);
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.create.mock.calls[0][0].tools[0].strict).toBe(true);
    expect(mocks.create.mock.calls[1][0].tools[0].strict).toBeUndefined();
    expect(grade.degraded).toBe(true);
    expect(grade.gapsTaught).toEqual([{ concept: 'idempotency', summary: '' }]);
    expect(metas).toHaveLength(2);
  });

  it('does not retry twice', async () => {
    const prose = { ...answer({}, 'end_turn'), content: [{ type: 'text', text: 'prose' }] };
    mocks.create.mockResolvedValueOnce(prose).mockResolvedValueOnce(prose);
    await expect(gradeMock(input)).rejects.toBeInstanceOf(LlmToolCallError);
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it('uses a strict schema that names every property as required', () => {
    const walk = (node: Record<string, unknown>) => {
      if (node.type === 'object' && node.properties) {
        expect(node.additionalProperties).toBe(false);
        expect(new Set(node.required as string[])).toEqual(new Set(Object.keys(node.properties)));
        for (const v of Object.values(node.properties as Record<string, Record<string, unknown>>)) walk(v);
      }
      if (node.items) walk(node.items as Record<string, unknown>);
      if (node.anyOf) for (const n of node.anyOf as Record<string, unknown>[]) walk(n);
    };
    walk(EMIT_MOCK_GRADE_TOOL.schema as unknown as Record<string, unknown>);
    walk(INTERVIEWER_TOOL.schema as unknown as Record<string, unknown>);
  });
});

// -----------------------------------------------------------------------------
// Gaps: fact vs skill, recorded whenever the interviewer hands something over
// -----------------------------------------------------------------------------
const FACT_GAP = {
  concept: 'api-design',
  type: 'fact',
  title: 'URL shortener redirect: 301 or 302 — and what does the choice do to click analytics?',
  answer: '302. A 301 is cached by the browser permanently, so repeat clicks never reach you and go uncounted.',
};

describe('gaps on the interviewer reply', () => {
  it('keeps typed gaps with a front and a back', () => {
    const r = coerceReply({ ...REPLY, gaps: [FACT_GAP] }, 'api');
    expect(r.gaps).toEqual([FACT_GAP]);
  });

  it('drops gaps with no title or answer or an unknown concept, and reads an unknown type as skill', () => {
    const r = coerceReply(
      {
        ...REPLY,
        gaps: [
          { ...FACT_GAP, title: ' ' },
          { ...FACT_GAP, answer: '' },
          { ...FACT_GAP, concept: 'vibes' },
          { ...FACT_GAP, type: 'trivia' },
        ],
      },
      'api'
    );
    expect(r.gaps).toEqual([{ ...FACT_GAP, type: 'skill' }]);
  });

  it('treats a missing gaps field as no gaps', () => {
    expect(coerceReply(REPLY, 'api').gaps).toEqual([]);
  });

  it('asks for gaps in the schema, before the trailing say', () => {
    const props = Object.keys((INTERVIEWER_TOOL.schema as { properties: object }).properties);
    expect(props).toContain('gaps');
    expect(props[props.length - 1]).toBe('say');
    expect(props.indexOf('gaps')).toBeLessThan(props.indexOf('say'));
  });
});

describe('the interviewer system prompt', () => {
  it('answers a question before redirecting, and never ignores one', () => {
    expect(INTERVIEWER_SYSTEM).toContain('ANSWER BEFORE YOU REDIRECT');
    expect(INTERVIEWER_SYSTEM).toMatch(/Never ignore an explicit question/);
  });

  it('records every handed-over fact or move as a typed gap', () => {
    expect(INTERVIEWER_SYSTEM).toMatch(/If you told them something they did not know, it is a gap/);
    expect(INTERVIEWER_SYSTEM).toMatch(/type fact:/);
    expect(INTERVIEWER_SYSTEM).toMatch(/type skill:/);
  });

  it('credits reasoning over recall', () => {
    expect(INTERVIEWER_SYSTEM).toContain('REASONING OVER RECALL');
  });
});

describe('gaps in the grade', () => {
  const input = {
    level: 'staff' as const,
    promptTitle: 'T',
    brief: 'B',
    transcript: '#1 INTERVIEWER: Go.',
    skipped: [],
    taught: [],
  };

  it('weighs fact gaps less than skill gaps and credits reasoning without the fact', () => {
    expect(GRADE_SYSTEM).toMatch(/fact gap .* weighs LITTLE/);
    expect(GRADE_SYSTEM).toMatch(/skill gap .* weighs heavily/);
    expect(GRADE_SYSTEM).toContain('REASONING WITHOUT THE FACT IS A POSITIVE STAFF SIGNAL');
    expect(GRADE_SYSTEM).toMatch(/practice areas .* cheap fixes/);
  });

  it('tells the grader which gaps are already recorded', async () => {
    mocks.create.mockResolvedValueOnce(answer(GRADE, 'tool_use', 'emit_mock_grade'));
    await gradeMock({
      ...input,
      recordedGaps: [{ seq: 37, type: 'fact', title: FACT_GAP.title, summary: 's' }],
    });
    const user = mocks.create.mock.calls[0][0].messages[0].content as string;
    expect(user).toContain('RECORDED GAPS');
    expect(user).toContain(`- #37 [fact] ${FACT_GAP.title}`);
  });

  it('coerces the grader\'s extra gaps, with a turn or null', async () => {
    mocks.create.mockResolvedValueOnce(
      answer(
        { ...GRADE, gaps: [{ ...FACT_GAP, turn: 37 }, { ...FACT_GAP, title: 'Seconds in a month?', turn: 'x' }, { concept: 'nope' }] },
        'tool_use',
        'emit_mock_grade'
      )
    );
    const { grade } = await gradeMock(input);
    expect(grade.gaps).toEqual([
      { ...FACT_GAP, turn: 37 },
      { ...FACT_GAP, title: 'Seconds in a month?', turn: null },
    ]);
  });

  it('an old grade with no gaps field coerces to an empty list', async () => {
    mocks.create.mockResolvedValueOnce(answer(GRADE, 'tool_use', 'emit_mock_grade'));
    expect((await gradeMock(input)).grade.gaps).toEqual([]);
  });
});

describe('the coding calls', () => {
  it('gives the interviewer the reference with the never-leak rule, and the editor in the user turn', () => {
    const ctx = JSON.stringify(codingInterviewerBody.messages[0].content);
    expect(ctx).toContain('REFERENCE SOLUTION — FOR YOU ONLY');
    expect(ctx).toContain('const seen = new Map();');
    const last = JSON.stringify(codingInterviewerBody.messages.at(-1).content);
    expect(last).toContain('[editor — ');
    expect(last).toContain('[run: Run (sample tests): 2/2 passed, accepted]');
    expect(codingInterviewerBody.model).toBe('claude-sonnet-5');
    expect(codingInterviewerBody.tool_choice).toEqual({ type: 'tool', name: 'interviewer_turn' });
  });

  it('gives the grader the reference and the hidden-test result after the rubric', () => {
    const user = JSON.stringify(codingGradeBody.messages[0].content);
    const rubric = user.indexOf('RUBRIC — live coding');
    const tests = user.indexOf('HIDDEN-TEST RESULT AT THE END');
    expect(rubric).toBeGreaterThan(-1);
    expect(tests).toBeGreaterThan(rubric);
    expect(tests).toBeLessThan(user.indexOf('TRANSCRIPT'));
    expect(user).toContain('7/9 passed, wrong answer');
    expect(JSON.stringify(codingGradeBody.tools[0])).toContain('patternMissed');
  });
});

describe('the behavioral calls', () => {
  it('keeps the story bank out of the interviewer request entirely', () => {
    const body = JSON.stringify(behavioralInterviewerBody);
    expect(body).not.toContain('story-saas-rebuild');
    expect(body).not.toContain('STORY BANK');
    expect(body).toContain('competency conflict');
    expect(behavioralInterviewerBody.model).toBe('claude-sonnet-5');
  });

  it('puts the story bank in the grade request after the rubric and before the transcript', () => {
    const user = behavioralGradeBody.messages[0].content as string;
    const rubric = user.indexOf('RUBRIC — behavioral');
    const bank = user.indexOf('STORY BANK (from resume-builder');
    const transcript = user.indexOf('TRANSCRIPT');
    expect(rubric).toBeGreaterThan(0);
    expect(bank).toBeGreaterThan(rubric);
    expect(transcript).toBeGreaterThan(bank);
    expect(behavioralGradeBody.tools[0].name).toBe('emit_mock_grade');
    expect(JSON.stringify(behavioralGradeBody.tools[0])).toContain('storyGaps');
  });

  it('adds nothing to the system-design grade request', () => {
    expect((gradeBody.messages[0].content as string)).not.toContain('STORY BANK');
  });
});
