// =============================================================================
// llm.anthropic.test — the budget, and what may be retried
// =============================================================================
// Two properties are asserted here, and both are about failure rather than
// success.
//
// 1. A CALL CANNOT HANG. routes/submit.ts already wraps `coach()` in a graceful
//    fallback so a candidate still sees their passing tests when coaching fails
//    — and that fallback was unreachable, because there was no bound on the
//    call. A request that never answers never fails, so the graceful path never
//    ran. The budget is what makes that existing code work.
//
// 2. A BAD ANSWER IS NOT RETRIED BY THE TRANSPORT. bank.service.generateAndStore
//    already retries generation three times, varying the prompt. A transport
//    that also retried three times would make one bad completion into nine
//    calls, each re-sending the prompt that just failed.
//
// The hang is proven against a REAL socket — a local HTTP server that accepts
// the connection and then says nothing, which is exactly the shape of a
// llama.cpp model swap or a wedged gateway. No fake fetch, no black-holed
// address, no reliance on the SDK's own timeout.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import { createAnthropicClient } from './llm.anthropic.js';
import { LlmTimeoutError, LlmToolCallError, type StructuredRequest, type ToolSpec } from './llm.types.js';

const TOOL: ToolSpec = {
  name: 'emit_thing',
  description: 'Emit the thing.',
  schema: { type: 'object', properties: { thing: { type: 'string' } }, required: ['thing'] },
};

function request(over: Partial<StructuredRequest> = {}): StructuredRequest {
  return {
    role: 'workhorse',
    system: 'You emit things.',
    tool: TOOL,
    messages: [{ role: 'user', content: 'Emit a thing.' }],
    maxTokens: 100,
    thinking: 'off',
    ...over,
  };
}

describe('the wall-clock budget', () => {
  let server: Server;
  let sockets: Socket[] = [];
  let baseURL = '';

  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-used-the-server-never-answers';
    // Accepts, then never responds. Held open on purpose.
    server = createServer(() => {});
    server.on('connection', (s) => sockets.push(s));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    sockets = [];
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fails inside its budget instead of hanging, and names the model and the endpoint', async () => {
    const client = createAnthropicClient('claude-timeout-probe', { baseURL });
    const startedAt = Date.now();

    const err = await client
      .structured(request({ timeoutMs: 400 }))
      .then(() => null)
      .catch((e: unknown) => e);

    const elapsed = Date.now() - startedAt;
    expect(err).toBeInstanceOf(LlmTimeoutError);
    // The model, because on a router the served model is not the asked-for one
    // and "it timed out" is useless without knowing which one did.
    expect((err as Error).message).toContain('claude-timeout-probe');
    expect((err as Error).message).toContain(baseURL);
    // The budget is the budget: three attempts and two backoffs do not get to
    // multiply it. Generous upper bound so a loaded CI box does not flake.
    expect(elapsed).toBeLessThan(4000);
  });

  it('spends the budget once, not once per retry attempt', async () => {
    // A hung endpoint would otherwise cost timeout x 3 attempts + backoffs.
    const client = createAnthropicClient('claude-timeout-probe', { baseURL });
    const startedAt = Date.now();
    await client.structured(request({ timeoutMs: 250 })).catch(() => {});
    expect(Date.now() - startedAt).toBeLessThan(2500);
  });

  it('honours a caller abort without turning it into three attempts', async () => {
    const client = createAnthropicClient('claude-timeout-probe', { baseURL });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const startedAt = Date.now();
    await client
      .structured(request({ timeoutMs: 30_000, signal: controller.signal }))
      .catch(() => {});
    expect(Date.now() - startedAt).toBeLessThan(4000);
  });
});

describe('a missing tool call', () => {
  let server: Server;
  let baseURL = '';
  let requests = 0;

  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-used-the-answer-is-canned';
    server = createServer((_req, res) => {
      requests += 1;
      // A well-formed 200 that simply did not call the tool — the shape a
      // weaker model produces when it narrates instead of emitting.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-substituted-by-a-router',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
          content: [{ type: 'text', text: 'Sure! Here is a thing.' }],
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('throws immediately and is never retried — semantic retry belongs to bank.service', async () => {
    requests = 0;
    const client = createAnthropicClient('claude-tool-probe', { baseURL });
    const err = await client
      .structured(request({ timeoutMs: 10_000 }))
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LlmToolCallError);
    expect((err as Error).message).toContain('emit_thing');
    expect(requests).toBe(1);
  });

  it('reports the model the endpoint actually served, not the one asked for', async () => {
    const client = createAnthropicClient('claude-tool-probe', { baseURL });
    const err = (await client
      .structured(request({ timeoutMs: 10_000 }))
      .catch((e: unknown) => e)) as LlmToolCallError;
    // A router in front of an endpoint is free to substitute. The reply is the
    // only place that shows it, which is why CallMeta carries it.
    expect(err.meta.servedModel).toBe('claude-substituted-by-a-router');
    expect(err.meta.stop).toBe('end_turn');
    expect(err.meta.usage.cachedInputTokens).toBe(3);
  });
});
