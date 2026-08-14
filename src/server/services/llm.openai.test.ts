// =============================================================================
// llm.openai.test — the wire format, the quirks, and the two failures
// =============================================================================
// Everything here runs against a REAL local HTTP server, not a mocked fetch, for
// the same reason the Anthropic tests do: the properties under test are about
// sockets (a budget that holds when nothing answers) and about bytes (the exact
// body that leaves this process). A stubbed transport can be made to agree with
// whatever the code does.
//
// The three properties that would each have cost a debugging session:
//
//   1. THE SYSTEM STRING IS SENT BYTE FOR BYTE. llama.cpp's slot cache is a
//      prefix match on the tokenized prompt; a system prompt this adapter
//      "tidied" would re-tokenize on every call and nothing would report it.
//   2. `finish_reason: "length"` BECOMES `stop: "max_tokens"`. generateProblem
//      tells "cut off mid-tool-call" apart from "ignored the tool" by reading
//      that string, and it is forbidden from knowing which vendor answered. A
//      Qwen3 thinking leak produces exactly the second shape with the first
//      cause, so getting this wrong mislabels the commonest local failure.
//   3. A MISSING TOOL CALL IS NOT RETRIED. bank.service already retries three
//      times, varying the prompt.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import { createOpenAiClient } from './llm.openai.js';
import {
  LlmTimeoutError,
  LlmToolCallError,
  type StructuredRequest,
  type TextRequest,
  type ToolSpec,
} from './llm.types.js';

const TOOL: ToolSpec = {
  name: 'emit_thing',
  description: 'Emit the thing.',
  schema: { type: 'object', properties: { thing: { type: 'string' } }, required: ['thing'] },
};

/** A system prompt with the shapes a "helpful" adapter would normalize away. */
const SYSTEM = 'You emit things.\n\n  - indented bullet\n\nTrailing space here: \nDone.';

function request(over: Partial<StructuredRequest> = {}): StructuredRequest {
  return {
    role: 'workhorse',
    system: SYSTEM,
    tool: TOOL,
    messages: [{ role: 'user', content: 'Emit a thing.' }],
    maxTokens: 100,
    thinking: 'off',
    timeoutMs: 10_000,
    ...over,
  };
}

function textRequest(over: Partial<TextRequest> = {}): TextRequest {
  return {
    role: 'tutor',
    system: SYSTEM,
    messages: [{ role: 'user', content: 'Explain.' }],
    maxTokens: 100,
    thinking: 'off',
    timeoutMs: 10_000,
    ...over,
  };
}

/** A completion carrying a well-formed forced tool call. */
function toolCallReply(args: unknown = { thing: 'a thing' }) {
  return {
    model: 'served-by-the-router',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'emit_thing', arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      prompt_tokens_details: { cached_tokens: 5 },
    },
  };
}

/** A scriptable endpoint: each test sets what it answers and reads what it got. */
interface Fake {
  baseURL: string;
  bodies: Record<string, unknown>[];
  paths: string[];
  auth: (string | undefined)[];
  reply: (n: number) => { status?: number; json?: unknown; text?: string };
}

function makeFake(): { fake: Fake; server: Server; listen: () => Promise<void>; close: () => Promise<void> } {
  const fake: Fake = {
    baseURL: '',
    bodies: [],
    paths: [],
    auth: [],
    reply: () => ({ json: toolCallReply() }),
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      fake.paths.push(req.url ?? '');
      fake.auth.push(req.headers.authorization);
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) fake.bodies.push(JSON.parse(raw) as Record<string, unknown>);
      const answer = fake.reply(fake.paths.length);
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      res.end(answer.text ?? JSON.stringify(answer.json ?? {}));
    });
  });
  return {
    fake,
    server,
    listen: async () => {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      fake.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// =============================================================================
describe('the request body', () => {
  const h = makeFake();
  beforeAll(h.listen);
  afterAll(h.close);

  function reset() {
    h.fake.bodies = [];
    h.fake.paths = [];
    h.fake.auth = [];
    h.fake.reply = () => ({ json: toolCallReply() });
  }

  it('sends a forced function call whose parameters are the tool schema verbatim', async () => {
    reset();
    const client = createOpenAiClient('llama-3.1-8b', { endpoint: h.fake.baseURL });
    await client.structured(request());

    const body = h.fake.bodies[0];
    expect(h.fake.paths[0]).toBe('/v1/chat/completions');
    expect(body.model).toBe('llama-3.1-8b');
    expect(body.max_tokens).toBe(100);
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'emit_thing',
          description: 'Emit the thing.',
          // The tool schema IS the response schema, and nothing rewrites it.
          parameters: TOOL.schema,
        },
      },
    ]);
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'emit_thing' } });
  });

  it('sets no sampling knobs — a pinned temperature made the bank deterministic', () => {
    // Measured, not assumed: with `temperature: 0` five consecutive
    // dry-run generations came back as the SAME problem, byte-identical test
    // inputs included, and every quality metric read as perfect while it
    // happened. The interface carries no temperature for either adapter.
    const body = h.fake.bodies[0];
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('top_k');
  });

  it('sends the system string byte for byte, as the first message', async () => {
    reset();
    const client = createOpenAiClient('llama-3.1-8b', { endpoint: h.fake.baseURL });
    await client.structured(request());

    const messages = h.fake.bodies[0].messages as { role: string; content: string }[];
    expect(messages[0].role).toBe('system');
    // Not trimmed, not re-indented, not re-wrapped: the slot cache keys on it.
    expect(messages[0].content).toBe(SYSTEM);
    expect(messages.slice(1)).toEqual([{ role: 'user', content: 'Emit a thing.' }]);
  });

  it('turns thinking off two ways at once on Qwen3, because the kwarg alone leaks', async () => {
    reset();
    const client = createOpenAiClient('Qwen3-local-q8', { endpoint: h.fake.baseURL });
    await client.structured(request());

    const body = h.fake.bodies[0];
    const messages = body.messages as { role: string; content: string }[];
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    // The belt: a constant prefix, and the ONLY edit made to the system string.
    expect(messages[0].content).toBe(`/no_think ${SYSTEM}`);
  });

  it('does not inject /no_think twice — a changed prefix is a lost slot cache', async () => {
    reset();
    const client = createOpenAiClient('Qwen3-local-q8', { endpoint: h.fake.baseURL });
    await client.structured(request({ system: `/no_think ${SYSTEM}` }));
    const messages = h.fake.bodies[0].messages as { content: string }[];
    expect(messages[0].content).toBe(`/no_think ${SYSTEM}`);
  });

  it('leaves a non-Qwen3 model alone, kwarg aside', async () => {
    reset();
    const client = createOpenAiClient('llama-3.1-8b', { endpoint: h.fake.baseURL });
    await client.structured(request());
    const messages = h.fake.bodies[0].messages as { content: string }[];
    expect(messages[0].content).toBe(SYSTEM);
  });

  it('asks for thinking when the caller asked for it', async () => {
    reset();
    const client = createOpenAiClient('Qwen3-local-q8', { endpoint: h.fake.baseURL });
    await client.structured(request({ thinking: 'adaptive' }));
    const body = h.fake.bodies[0];
    expect(body.chat_template_kwargs).toBeUndefined();
    expect((body.messages as { content: string }[])[0].content).toBe(SYSTEM);
  });

  it('sends no Authorization header when no credential is configured', async () => {
    reset();
    // The fleet this was built for has no auth at all, and sending
    // "Bearer undefined" is how an endpoint that DOES check one starts
    // answering 401 for a reason nobody can find.
    const client = createOpenAiClient('llama-3.1-8b', { endpoint: h.fake.baseURL });
    await client.structured(request());
    expect(h.fake.auth[0]).toBeUndefined();
  });

  it('sends a bearer token when one is configured', async () => {
    reset();
    const client = createOpenAiClient('llama-3.1-8b', {
      endpoint: h.fake.baseURL,
      apiKey: 'sk-local-123',
    });
    await client.structured(request());
    expect(h.fake.auth[0]).toBe('Bearer sk-local-123');
  });

  it('tolerates a trailing slash on the endpoint', async () => {
    reset();
    const client = createOpenAiClient('llama-3.1-8b', { endpoint: `${h.fake.baseURL}/` });
    await client.structured(request());
    expect(h.fake.paths[0]).toBe('/v1/chat/completions');
  });
});

// =============================================================================
describe('reading the answer', () => {
  const h = makeFake();
  beforeAll(h.listen);
  afterAll(h.close);

  it('returns the tool arguments as the response, with the served model', async () => {
    h.fake.reply = () => ({ json: toolCallReply({ thing: 'a thing', n: 3 }) });
    const client = createOpenAiClient('asked-for', { endpoint: h.fake.baseURL });
    const res = await client.structured(request());

    expect(res.input).toEqual({ thing: 'a thing', n: 3 });
    // A router substitutes freely; the reply is the only place that shows it.
    expect(res.meta.servedModel).toBe('served-by-the-router');
    expect(res.meta.stop).toBe('tool_calls');
    expect(res.meta.usage).toEqual({ inputTokens: 11, outputTokens: 7, cachedInputTokens: 5 });
  });

  it('reads prose from content', async () => {
    h.fake.reply = () => ({
      json: {
        model: 'm',
        choices: [{ finish_reason: 'stop', message: { content: '  The answer.  ' } }],
      },
    });
    const client = createOpenAiClient('m', { endpoint: h.fake.baseURL });
    expect((await client.text(textRequest())).text).toBe('The answer.');
  });

  it('recovers prose from reasoning_content when thinking leaked into it', async () => {
    h.fake.reply = () => ({
      json: {
        model: 'm',
        choices: [
          { finish_reason: 'stop', message: { content: '', reasoning_content: 'The answer.' } },
        ],
      },
    });
    const client = createOpenAiClient('Qwen3-thinky', { endpoint: h.fake.baseURL });
    expect((await client.text(textRequest())).text).toBe('The answer.');
  });

  it('fails clearly when there is neither content nor reasoning_content', async () => {
    h.fake.reply = () => ({
      json: { model: 'm', choices: [{ finish_reason: 'stop', message: { content: '' } }] },
    });
    const client = createOpenAiClient('m', { endpoint: h.fake.baseURL });
    await expect(client.text(textRequest())).rejects.toThrow(/no content and no reasoning_content/);
  });

  it('lists the models the endpoint advertises', async () => {
    h.fake.reply = () => ({ json: { data: [{ id: 'a' }, { id: 'b' }] } });
    const client = createOpenAiClient('a', { endpoint: h.fake.baseURL });
    expect(await client.listModels()).toEqual(['a', 'b']);
  });

  it('answers null — not [] — when the endpoint cannot be asked', async () => {
    h.fake.reply = () => ({ status: 404, text: 'no such route' });
    const client = createOpenAiClient('a', { endpoint: h.fake.baseURL });
    // "could not ask" is not "answered, and offers nothing".
    expect(await client.listModels(2000)).toBeNull();
  });
});

// =============================================================================
describe('a missing or unusable tool call', () => {
  const h = makeFake();
  beforeAll(h.listen);
  afterAll(h.close);

  it('reports a thinking leak that ran out of budget AS TRUNCATION', async () => {
    // The exact shape of the failure this adapter exists to survive: Qwen3
    // reasons instead of calling the tool, burns the budget, and comes back
    // with prose and finish_reason "length". llm.service turns stop ===
    // "max_tokens" into "Generation truncated at max_tokens", which is the
    // right advice; "the model ignored the tool" would not be.
    h.fake.paths = [];
    h.fake.reply = () => ({
      json: {
        model: 'Qwen3-thinky',
        choices: [
          {
            finish_reason: 'length',
            message: { content: '', reasoning_content: 'Let me think about this problem...' },
          },
        ],
      },
    });
    const client = createOpenAiClient('Qwen3-thinky', { endpoint: h.fake.baseURL });
    const err = (await client.structured(request()).catch((e: unknown) => e)) as LlmToolCallError;

    expect(err).toBeInstanceOf(LlmToolCallError);
    expect(err.meta.stop).toBe('max_tokens');
    // One request. Semantic retry belongs to bank.service, which varies the prompt.
    expect(h.fake.paths).toHaveLength(1);
  });

  it('keeps a real stop reason verbatim when it was not truncation', async () => {
    h.fake.reply = () => ({
      json: {
        model: 'm',
        choices: [{ finish_reason: 'stop', message: { content: 'Sure! Here is a thing.' } }],
      },
    });
    const client = createOpenAiClient('m', { endpoint: h.fake.baseURL });
    const err = (await client.structured(request()).catch((e: unknown) => e)) as LlmToolCallError;
    expect(err.meta.stop).toBe('stop');
    expect(err.message).toContain('emit_thing');
    // The prose it sent instead, so the failure can be diagnosed from a log.
    expect(err.message).toContain('Sure! Here is a thing.');
  });

  it('treats arguments that are not valid JSON as a semantic failure, not a retry', async () => {
    h.fake.paths = [];
    h.fake.reply = () => ({
      json: {
        model: 'm',
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              tool_calls: [{ function: { name: 'emit_thing', arguments: '{"thing": "a th' } }],
            },
          },
        ],
      },
    });
    const client = createOpenAiClient('m', { endpoint: h.fake.baseURL });
    const err = (await client.structured(request()).catch((e: unknown) => e)) as LlmToolCallError;
    expect(err).toBeInstanceOf(LlmToolCallError);
    expect(h.fake.paths).toHaveLength(1);
  });
});

// =============================================================================
describe('what may be retried', () => {
  const h = makeFake();
  beforeAll(h.listen);
  afterAll(h.close);

  it('retries a 429 — llama-swap answers that as ordinary backpressure', async () => {
    h.fake.paths = [];
    h.fake.reply = (n) =>
      n === 1 ? { status: 429, text: 'busy' } : { json: toolCallReply() };
    const client = createOpenAiClient('m', { endpoint: h.fake.baseURL });
    const res = await client.structured(request({ timeoutMs: 20_000 }));
    expect(res.input).toEqual({ thing: 'a thing' });
    expect(h.fake.paths).toHaveLength(2);
  }, 20_000);

  it('does not retry a 400 — the same bad request fails the same way', async () => {
    h.fake.paths = [];
    h.fake.reply = () => ({ status: 400, text: '{"error":"unknown model"}' });
    const client = createOpenAiClient('m', { endpoint: h.fake.baseURL });
    const err = (await client.structured(request()).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('HTTP 400');
    expect(err.message).toContain('unknown model');
    expect(h.fake.paths).toHaveLength(1);
  });
});

// =============================================================================
describe('the wall-clock budget', () => {
  let server: Server;
  let sockets: Socket[] = [];
  let baseURL = '';

  beforeAll(async () => {
    // Accepts, then never responds — the shape of a llama.cpp model swap or a
    // wedged gateway, which is precisely what an unbounded call hangs on.
    server = createServer(() => {});
    server.on('connection', (s) => sockets.push(s));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    sockets = [];
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fails inside its budget, naming the model and the endpoint', async () => {
    const client = createOpenAiClient('Qwen3-timeout-probe', { endpoint: baseURL });
    const startedAt = Date.now();
    const err = await client
      .structured(request({ timeoutMs: 400 }))
      .then(() => null)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LlmTimeoutError);
    expect((err as Error).message).toContain('Qwen3-timeout-probe');
    expect((err as Error).message).toContain(baseURL);
    // And says so: no other provider was asked, because there is no failover.
    expect((err as Error).message).toContain('Nothing was sent to any other provider');
    expect(Date.now() - startedAt).toBeLessThan(4000);
  });

  it('spends the budget once, not once per retry attempt', async () => {
    const client = createOpenAiClient('Qwen3-timeout-probe', { endpoint: baseURL });
    const startedAt = Date.now();
    await client.structured(request({ timeoutMs: 250 })).catch(() => {});
    expect(Date.now() - startedAt).toBeLessThan(2500);
  });

  it('honours a caller abort without turning it into three attempts', async () => {
    const client = createOpenAiClient('Qwen3-timeout-probe', { endpoint: baseURL });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const startedAt = Date.now();
    await client
      .structured(request({ timeoutMs: 30_000, signal: controller.signal }))
      .catch(() => {});
    expect(Date.now() - startedAt).toBeLessThan(4000);
  });
});

// =============================================================================
describe('the deny list', () => {
  it('refuses to build a client for a denied model, before any load is created', () => {
    // The guard against a documented incident: one advertised id on the owner's
    // router maps to a CPU on the same box as the media server, and a CPU model
    // there once starved the Plex transcoder into visible buffering.
    expect(() =>
      createOpenAiClient('Qwen3-local', {
        endpoint: 'http://127.0.0.1:9600/v1',
        deny: ['Qwen3-local'],
      })
    ).toThrow(/CODEGRIND_MODEL_DENY/);
  });

  it('names the model it refused, so the message can be acted on', () => {
    expect(() =>
      createOpenAiClient('Qwen3-local', {
        endpoint: 'http://127.0.0.1:9600/v1',
        deny: ['Qwen3-local'],
      })
    ).toThrow(/Qwen3-local/);
  });

  it('denies exactly the listed id, not everything that looks like it', () => {
    // The suffixed id is a DIFFERENT route on the same router — a remote box —
    // and denying it by prefix would take the working model down with the
    // dangerous one.
    expect(() =>
      createOpenAiClient('Qwen3-local-q8', {
        endpoint: 'http://127.0.0.1:9600/v1',
        deny: ['Qwen3-local'],
      })
    ).not.toThrow();
  });
});
