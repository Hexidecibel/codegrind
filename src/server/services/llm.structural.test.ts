// =============================================================================
// llm.structural.test — the rule that keeps the abstraction an abstraction
// =============================================================================
// An LLM seam does not rot by being deleted. It rots by acquiring ONE innocent
// `if` inside ONE function, which is then copied into the next function with a
// small variation, and six months later every call site knows which endpoint it
// is talking to and no two of them agree about what that implies.
//
// That is not hypothetical: it is what happened to the other local-LLM consumer
// on this box (soulseek-helper's llm.service.ts), which is why this test exists
// rather than a paragraph in a README asking people to be careful.
//
// So the rule is mechanical and therefore enforceable: llm.service.ts writes
// prompts and unwraps answers. It never learns who answers. The word this test
// greps for is the one that shows up first when that stops being true.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SERVICE = fileURLToPath(new URL('./llm.service.ts', import.meta.url));
const SOURCE = readFileSync(SERVICE, 'utf8');

/** Lines matching a pattern, reported with their numbers so a failure is actionable. */
function hits(pattern: RegExp): string[] {
  return SOURCE.split('\n')
    .map((line, i) => `${i + 1}: ${line.trim()}`)
    .filter((line) => pattern.test(line));
}

describe('llm.service.ts stays vendor-free', () => {
  it('contains zero occurrences of the word "provider", in any case', () => {
    // If this fails, the fix is almost never to reword the line. It is that a
    // decision about WHO answers has leaked into a file about WHAT to ask —
    // move it into llm.client.ts, which exists for exactly that.
    expect(hits(/provider/i)).toEqual([]);
  });

  it('never imports a vendor SDK', () => {
    expect(hits(/@anthropic-ai\/sdk|openai|from '\.\/llm\.anthropic/)).toEqual([]);
  });

  it('never builds a request body itself', () => {
    // `messages.create`, `max_tokens`, `input_schema`, `cache_control` and a
    // literal thinking block are all wire format. They belong to the adapter.
    expect(hits(/messages\.create|input_schema|cache_control|type: 'ephemeral'/)).toEqual([]);
  });

  it('never names a model', () => {
    expect(hits(/claude-|ANTHROPIC_MODEL|ANTHROPIC_CHAT_MODEL|ANTHROPIC_API_KEY/)).toEqual([]);
  });

  it('still routes every call through the two client entry points', () => {
    // Eleven call sites: ten forced tool calls plus the one prose call.
    expect(SOURCE.match(/await structured\(\{/g)).toHaveLength(10);
    expect(SOURCE.match(/await textCall\(\{/g)).toHaveLength(1);
  });

  it('states thinking explicitly at every call site', () => {
    // Omitting it runs ADAPTIVE thinking on both model defaults, and max_tokens
    // caps thinking and visible output together — so an omission is a silently
    // truncated tool call, not a stylistic lapse.
    const calls = SOURCE.match(/await (?:structured|textCall)\(\{[\s\S]*?\n\s*\}\);/g) ?? [];
    expect(calls).toHaveLength(11);
    for (const call of calls) {
      expect(call).toMatch(/thinking: '(off|adaptive)'/);
      expect(call).toMatch(/role: '(workhorse|small|tutor)'/);
      expect(call).toMatch(/maxTokens: \d+/);
    }
  });
});
