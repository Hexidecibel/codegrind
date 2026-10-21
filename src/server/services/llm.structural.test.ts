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
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE = fileURLToPath(new URL('./llm.service.ts', import.meta.url));
const SOURCE = readFileSync(SERVICE, 'utf8');
// The mock interviewer's two calls live in their own file and are held to the
// same rules — a second file is the obvious way for the rule to stop applying.
const MOCK_SOURCE = readFileSync(fileURLToPath(new URL('./llm.mock.ts', import.meta.url)), 'utf8');
// The Today debrief's one call, same rules.
const DEBRIEF_SOURCE = readFileSync(fileURLToPath(new URL('./llm.debrief.ts', import.meta.url)), 'utf8');
// The Recognize drill's optional AI check, same rules.
const RECOGNIZE_SOURCE = readFileSync(fileURLToPath(new URL('./llm.recognize.ts', import.meta.url)), 'utf8');
// The per-kind specs (mock-kinds/) hold the mock prompts and schemas — the same
// "what to ask" half — so they are held to the same rules, every file of them.
const KIND_DIR = fileURLToPath(new URL('./mock-kinds/', import.meta.url));
const KIND_SOURCES = readdirSync(KIND_DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => ({ file: f, source: readFileSync(path.join(KIND_DIR, f), 'utf8') }));

/** Lines matching a pattern, reported with their numbers so a failure is actionable. */
function hits(pattern: RegExp, source = SOURCE): string[] {
  return source.split('\n')
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

describe('llm.mock.ts stays vendor-free too', () => {
  const mockHits = (p: RegExp) => hits(p, MOCK_SOURCE);

  it('has no "provider", no SDK, no wire format and no model name', () => {
    expect(mockHits(/provider/i)).toEqual([]);
    expect(mockHits(/@anthropic-ai\/sdk|openai|from '\.\/llm\.anthropic/)).toEqual([]);
    expect(mockHits(/messages\.create|input_schema|cache_control|type: 'ephemeral'/)).toEqual([]);
    expect(mockHits(/claude-|ANTHROPIC_MODEL|ANTHROPIC_API_KEY/)).toEqual([]);
  });

  it('makes its two calls through structured(), each stating role, thinking and budget', () => {
    const calls = MOCK_SOURCE.match(/await structured\(\{[\s\S]*?\n\s*\}\);/g) ?? [];
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toMatch(/thinking: '(off|adaptive)'/);
      expect(call).toMatch(/role: 'workhorse'/);
      expect(call).toMatch(/maxTokens: \d+/);
    }
  });
});

describe('llm.debrief.ts stays vendor-free too', () => {
  const h = (p: RegExp) => hits(p, DEBRIEF_SOURCE);

  it('has no "provider", no SDK, no wire format and no model name', () => {
    expect(h(/provider/i)).toEqual([]);
    expect(h(/@anthropic-ai\/sdk|openai|from '\.\/llm\.anthropic/)).toEqual([]);
    expect(h(/messages\.create|input_schema|cache_control|type: 'ephemeral'/)).toEqual([]);
    expect(h(/claude-|ANTHROPIC_MODEL|ANTHROPIC_API_KEY/)).toEqual([]);
  });

  it('makes exactly one call, small role, thinking off, explicit budget', () => {
    const calls = DEBRIEF_SOURCE.match(/await structured\(\{[\s\S]*?\n\s*\}\);/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/role: 'small'/);
    expect(calls[0]).toMatch(/thinking: 'off'/);
    expect(calls[0]).toMatch(/maxTokens: \d+/);
  });
});

describe('llm.recognize.ts stays vendor-free too', () => {
  const h = (p: RegExp) => hits(p, RECOGNIZE_SOURCE);

  it('has no "provider", no SDK, no wire format and no model name', () => {
    expect(h(/provider/i)).toEqual([]);
    expect(h(/@anthropic-ai\/sdk|openai|from '\.\/llm\.anthropic/)).toEqual([]);
    expect(h(/messages\.create|input_schema|cache_control|type: 'ephemeral'/)).toEqual([]);
    expect(h(/claude-|ANTHROPIC_MODEL|ANTHROPIC_API_KEY/)).toEqual([]);
  });

  it('makes exactly one call, small role, thinking off, explicit budget', () => {
    const calls = RECOGNIZE_SOURCE.match(/await structured\(\{[\s\S]*?\n\s*\}\);/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/role: 'small'/);
    expect(calls[0]).toMatch(/thinking: 'off'/);
    expect(calls[0]).toMatch(/maxTokens: \d+/);
  });
});

describe('mock-kinds/ stays vendor-free, and never calls a model itself', () => {
  it('finds the spec files (an empty scan would pass vacuously)', () => {
    expect(KIND_SOURCES.map((k) => k.file)).toEqual(expect.arrayContaining(['system-design.ts', 'behavioral.ts', 'coding.ts']));
  });

  for (const { file, source } of KIND_SOURCES) {
    it(`${file}: no "provider", no SDK, no wire format, no model name, no model call`, () => {
      const h = (p: RegExp) => hits(p, source).map((l) => `${file}:${l}`);
      expect(h(/provider/i)).toEqual([]);
      expect(h(/@anthropic-ai\/sdk|openai|from '\.\.\/llm\.anthropic/)).toEqual([]);
      expect(h(/messages\.create|input_schema|cache_control|type: 'ephemeral'/)).toEqual([]);
      expect(h(/claude-|ANTHROPIC_MODEL|ANTHROPIC_API_KEY/)).toEqual([]);
      // Specs hold prompts and schemas; llm.mock.ts is the one place that calls.
      expect(h(/\b(structured|textCall)\(|from '\.\.\/llm\.client/)).toEqual([]);
    });
  }
});
