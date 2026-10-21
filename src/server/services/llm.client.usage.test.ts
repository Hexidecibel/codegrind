// =============================================================================
// llm.client — failed calls still land in the spend ledger (Phase H)
// =============================================================================
// A mock grade that came back unusable, and its unusable retry, were billed
// ($0.095) but never recorded: the recorder only ran on success. A failure that
// carries the reply's `meta` is a paid call and must be counted.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: mocks.create };
    constructor(_opts: unknown) {}
  }
  return { default: FakeAnthropic };
});
process.env.ANTHROPIC_API_KEY = 'test-key-not-used';

const { structured, useUsageRecorder } = await import('./llm.client.js');
type Event = import('./llm.client.js').UsageEvent;

const TOOL = {
  name: 'emit_x',
  description: 'x',
  schema: { type: 'object' as const, properties: { a: { type: 'string' } }, required: ['a'] },
};
const reply = (over: Record<string, unknown>) => ({
  model: 'claude-haiku-5-5',
  stop_reason: 'end_turn',
  usage: { input_tokens: 500, output_tokens: 80 },
  content: [{ type: 'text', text: 'prose instead of a tool call' }],
  ...over,
});

describe('usage of failed calls', () => {
  const seen: Event[] = [];
  beforeEach(() => {
    seen.length = 0;
    mocks.create.mockReset();
    useUsageRecorder((e) => seen.push(e));
  });

  it('records a call that answered without the tool, then rethrows', async () => {
    mocks.create.mockResolvedValue(reply({}));
    await expect(structured({ role: 'small', system: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 100, tool: TOOL })).rejects.toThrow(
      /did not call emit_x/
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ source: 'emit_x', role: 'small' });
    expect(seen[0].meta.usage.inputTokens).toBe(500);
  });

  it('records a refusal (a paid 200)', async () => {
    mocks.create.mockResolvedValue(reply({ stop_reason: 'refusal', content: [] }));
    await expect(structured({ role: 'small', system: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 100, tool: TOOL })).rejects.toThrow(
      /declined/
    );
    expect(seen).toHaveLength(1);
  });

  it('records nothing for a failure with no reply (no tokens were billed)', async () => {
    mocks.create.mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }));
    await expect(structured({ role: 'small', system: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 100, tool: TOOL })).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });
});
