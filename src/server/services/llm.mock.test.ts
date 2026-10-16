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

const { interviewerTurn, gradeMock, coerceReply, INTERVIEWER_TOOL, EMIT_MOCK_GRADE_TOOL } = await import(
  './llm.mock.js'
);
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
});
const gradeBody = mocks.create.mock.calls[0][0];

const CAPTURED = { interviewerTurn: interviewerBody, gradeMock: gradeBody };
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
