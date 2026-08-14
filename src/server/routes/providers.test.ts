// =============================================================================
// providers route — the gate, and the two things it must never do
// =============================================================================
// This is the only screen in the app that can make codegrind unusable, and the
// only one that can make it usable without a credit card. So the cases here are
// not "does the handler return 200". They are:
//
//   1. A MODEL THAT CANNOT MAKE A FORCED TOOL CALL IS NOT STORED. Ten of the
//      eleven LLM calls in this app are forced tool calls. Accepting an endpoint
//      that answers in prose would trade a two-second check for an install that
//      fails on every single problem, hours later, with an error nobody can
//      connect to a URL they typed once.
//   2. A CREDENTIAL NEVER COMES BACK OUT. Not the endpoint's bearer token, not
//      in the success body, not in the error body, not in the status.
//
// Everything is exercised through the real route, the real service and the real
// db layer against a throwaway DATA_DIR. Only the endpoint itself is faked —
// which is the point: the fake is how "answered with prose" becomes a test case
// rather than a thing that happens to somebody in six months.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-providers-test-'));
if (!TEST_DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run: test DATA_DIR ${TEST_DATA_DIR} is not under ${tmpdir()}`);
}
process.env.DATA_DIR = TEST_DATA_DIR;
// The routing these tests assert is the STORED one. A stray CODEGRIND_* in the
// shell that ran vitest would win over every row written here — which is the
// correct behaviour, and would make every assertion below a lie.
for (const v of [
  'CODEGRIND_PROVIDER',
  'CODEGRIND_CHAT_PROVIDER',
  'CODEGRIND_MODEL',
  'CODEGRIND_CHAT_MODEL',
  'CODEGRIND_ENDPOINT',
  'CODEGRIND_API_KEY',
  'CODEGRIND_MAX_OUTPUT_TOKENS',
  'QWEN_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_CHAT_MODEL',
]) {
  delete process.env[v];
}
delete process.env.ANTHROPIC_API_KEY;
// The one model id on this box that must never be sent load: its router maps it
// to a CPU beside the media server. It has to be UNSELECTABLE, not merely
// rejected — see the Plex-starvation incident behind CODEGRIND_MODEL_DENY.
process.env.CODEGRIND_MODEL_DENY = 'Qwen3-local';

const { providerRoutes } = await import('./providers.js');
const provider = await import('../services/provider.service.js');
const db = await import('../services/db.js');
const apikey = await import('../services/apikey.service.js');

const app = new Hono();
app.route('/api', providerRoutes);

const ENDPOINT = 'http://127.0.0.1:9600/v1';
const MODEL = 'Qwen3-local-q8';

/** What the fake endpoint serves, and how it answers a forced tool call. */
interface FakeEndpoint {
  models?: string[] | null;
  /** 'tool' = a proper tool call, 'prose' = the failure this gate exists for. */
  reply?: 'tool' | 'prose' | 'truncated';
  /** Override the tool-call arguments, to exercise the shape check. */
  args?: unknown;
  /** What the endpoint claims it served — a router may substitute. */
  servedModel?: string;
  /** Bearer tokens seen, so the tests can prove one was forwarded. */
  auth: (string | null)[];
}

let fake: FakeEndpoint;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const headers = new Headers(init?.headers as HeadersInit | undefined);
  fake.auth.push(headers.get('authorization'));

  if (url.endsWith('/models')) {
    if (fake.models === null) return new Response('nope', { status: 500 });
    return jsonResponse({ data: (fake.models ?? [MODEL, 'Qwen3-local']).map((id) => ({ id })) });
  }
  if (url.endsWith('/chat/completions')) {
    if (fake.reply === 'prose') {
      return jsonResponse({
        model: fake.servedModel ?? MODEL,
        choices: [{ message: { content: 'Sure! Here is a problem about adding two numbers.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      });
    }
    if (fake.reply === 'truncated') {
      return jsonResponse({
        model: fake.servedModel ?? MODEL,
        choices: [{ message: { content: '<think>hmm' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 100, completion_tokens: 500 },
      });
    }
    const args =
      fake.args ?? {
        title: 'Add Two Integers',
        difficulty: 'easy',
        tests: [
          { args: [1, 2], expected: 3 },
          { args: [-1, 1], expected: 0 },
        ],
      };
    return jsonResponse({
      model: fake.servedModel ?? MODEL,
      choices: [
        {
          message: {
            tool_calls: [
              { type: 'function', function: { name: 'emit_problem', arguments: JSON.stringify(args) } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 200, completion_tokens: 120 },
    });
  }
  throw new Error(`unexpected fetch to ${url}`);
});

vi.stubGlobal('fetch', fakeFetch);

async function put(body: unknown): Promise<Response> {
  return app.request('/api/providers', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function models(body: unknown): Promise<Response> {
  return app.request('/api/providers/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  db.db.exec(`DELETE FROM settings`);
  delete process.env.ANTHROPIC_API_KEY;
  apikey.forget();
  db.db.exec(`DELETE FROM settings`);
  provider.hydrateProviderConfig();
  fake = { auth: [] };
  fakeFetch.mockClear();
});

afterAll(() => {
  db.db.close();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// =============================================================================
describe('GET /api/providers', () => {
  it('reports the Anthropic default on an install with no rows at all', async () => {
    // The zero-migration guarantee: an existing install has an `apiKey` row and
    // no `llm.*` rows, and must resolve exactly as it did before this existed.
    const res = await app.request('/api/providers');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workhorse.provider).toBe('anthropic');
    expect(body.workhorse.model).toBe('claude-sonnet-5');
    expect(body.tutor.model).toBe('claude-opus-5');
    expect(body.needsAnthropicKey).toBe(true);
    expect(body.envLocked).toBe(false);
  });

  it('reports the deny list, so the picker can leave those ids out', async () => {
    const body = await (await app.request('/api/providers')).json();
    expect(body.deny).toEqual(['Qwen3-local']);
  });
});

// =============================================================================
describe('POST /api/providers/models', () => {
  it('lists what the endpoint serves', async () => {
    fake.models = ['a-model', 'b-model'];
    const res = await models({ endpoint: ENDPOINT });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ models: ['a-model', 'b-model'], denied: 0 });
  });

  it('REMOVES a denied id rather than offering it', async () => {
    // Not "rejects it on submit". A list you cannot pick from is the guard; an
    // error afterwards is a chance to have already created the load.
    fake.models = [MODEL, 'Qwen3-local'];
    const body = await (await models({ endpoint: ENDPOINT })).json();
    expect(body.models).toEqual([MODEL]);
    expect(body.denied).toBe(1);
  });

  it('says what to check when nothing answers', async () => {
    fake.models = null;
    const res = await models({ endpoint: ENDPOINT });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Nothing answered/);
  });

  it('forwards a bearer token without ever echoing it', async () => {
    fake.models = ['a-model'];
    const res = await models({ endpoint: ENDPOINT, endpointKey: 'secret-token-1234' });
    expect(fake.auth).toContain('Bearer secret-token-1234');
    expect(JSON.stringify(await res.json())).not.toContain('secret-token');
  });

  it('rejects a URL it could not call', async () => {
    const res = await models({ endpoint: 'not a url' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/is not a URL/);
  });
});

// =============================================================================
describe('PUT /api/providers — the forced-tool-use gate', () => {
  it('stores a configuration that passes, for BOTH roles', async () => {
    const res = await put({ provider: 'openai-compatible', endpoint: ENDPOINT, model: MODEL });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.llm.workhorse).toMatchObject({ provider: 'openai-compatible', model: MODEL });
    // The local-stays-local rule. A tutor left on Claude here is a bill the user
    // never agreed to — the exact thing this whole feature exists to prevent.
    expect(body.llm.tutor).toMatchObject({ provider: 'openai-compatible', model: MODEL });
    expect(body.llm.needsAnthropicKey).toBe(false);
    expect(db.getSetting(provider.WORKHORSE_SETTING)).toMatchObject({ model: MODEL });
    expect(db.getSetting(provider.TUTOR_SETTING)).toMatchObject({ model: MODEL });
  });

  it('REFUSES TO STORE a model that answers with prose, and says what to do', async () => {
    fake.reply = 'prose';
    const res = await put({ provider: 'openai-compatible', endpoint: ENDPOINT, model: MODEL });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toMatch(/prose instead of calling the tool/);
    // The line that saves a working local setup from being blamed on the model.
    expect(error).toMatch(/--jinja/);
    // Nothing stored. This is the whole assertion.
    expect(db.getSetting(provider.WORKHORSE_SETTING)).toBeNull();
    expect(db.getSetting(provider.TUTOR_SETTING)).toBeNull();
  });

  it('tells a truncated thinking-leak apart from a model that ignored the tool', async () => {
    fake.reply = 'truncated';
    const res = await put({ provider: 'openai-compatible', endpoint: ENDPOINT, model: MODEL });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/ran out of output tokens/);
  });

  it('refuses a model the endpoint does not actually serve', async () => {
    fake.models = ['something-else'];
    const res = await put({ provider: 'openai-compatible', endpoint: ENDPOINT, model: MODEL });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/does not serve a model called/);
    expect(db.getSetting(provider.WORKHORSE_SETTING)).toBeNull();
  });

  it('refuses a denied model even when the request was hand-crafted', async () => {
    const res = await put({
      provider: 'openai-compatible',
      endpoint: ENDPOINT,
      model: 'Qwen3-local',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/CODEGRIND_MODEL_DENY/);
    // And no call was made to it: the refusal has to precede the load.
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('refuses a tool call that dropped a required field', async () => {
    // The wobble observed live, in its fatal form: `expected` missing from a
    // test means a problem with nothing to grade against.
    fake.args = { title: 'Add', difficulty: 'easy', tests: [{ args: [1, 2] }] };
    const res = await put({ provider: 'openai-compatible', endpoint: ENDPOINT, model: MODEL });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/expected/);
    expect(db.getSetting(provider.WORKHORSE_SETTING)).toBeNull();
  });

  it('reports latency as a measurement, never as a verdict', async () => {
    const body = await (
      await put({ provider: 'openai-compatible', endpoint: ENDPOINT, model: MODEL })
    ).json();
    expect(body.check.estimatedProblemSeconds).toBeGreaterThan(0);
    expect(typeof body.check.latencyMs).toBe('number');
    // No grade, no tier, no ladder — a number and its consequence, or nothing.
    expect(body.check).not.toHaveProperty('grade');
  });

  it('says when a router substituted a different model', async () => {
    fake.servedModel = 'some-other-model';
    const body = await (
      await put({ provider: 'openai-compatible', endpoint: ENDPOINT, model: MODEL })
    ).json();
    expect(body.check.warning).toMatch(/substituting/);
  });
});

// =============================================================================
describe('what must never leave the server', () => {
  it('strips user:pass@ from an endpoint before storing OR returning it', async () => {
    const res = await put({
      provider: 'openai-compatible',
      endpoint: 'http://alice:hunter2@127.0.0.1:9600/v1',
      model: MODEL,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.llm.workhorse.endpoint).toBe(ENDPOINT);
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(JSON.stringify(db.getSetting(provider.WORKHORSE_SETTING))).not.toContain('hunter2');
  });

  it('describes an endpoint credential the way the API key is described', async () => {
    const body = await (
      await put({
        provider: 'openai-compatible',
        endpoint: ENDPOINT,
        model: MODEL,
        endpointKey: 'sk-local-abcd1234',
      })
    ).json();
    expect(body.llm.workhorse.credential).toEqual({
      configured: true,
      source: 'settings',
      suffix: '1234',
    });
    expect(JSON.stringify(body)).not.toContain('sk-local-abcd');
  });

  it('never returns a credential from the GET either', async () => {
    await put({
      provider: 'openai-compatible',
      endpoint: ENDPOINT,
      model: MODEL,
      endpointKey: 'sk-local-abcd1234',
    });
    const body = await (await app.request('/api/providers')).json();
    expect(JSON.stringify(body)).not.toContain('sk-local-abcd');
    expect(body.workhorse.credential.configured).toBe(true);
  });
});

// =============================================================================
describe('switching back to Claude', () => {
  it('will not record the choice while there is no key to make it work', async () => {
    const res = await put({ provider: 'anthropic' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Anthropic API key/);
  });

  it('overwrites a stored local configuration once a key exists', async () => {
    await put({ provider: 'openai-compatible', endpoint: ENDPOINT, model: MODEL });
    apikey.store('sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaWXYZ');
    const res = await put({ provider: 'anthropic' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.llm.workhorse.provider).toBe('anthropic');
    // The stored local model must not survive as the model for Anthropic.
    expect(body.llm.workhorse.model).toBe('claude-sonnet-5');
    expect(body.check).toBeNull();
  });
});

// =============================================================================
describe('the environment still wins', () => {
  it('ignores a stored model once the deploy pins one, and says so', async () => {
    await put({ provider: 'openai-compatible', endpoint: ENDPOINT, model: MODEL });
    // A fresh module graph is the only honest way to test a value that is read
    // once at load — which is exactly what a deploy's environment is.
    vi.resetModules();
    process.env.CODEGRIND_PROVIDER = 'openai-compatible';
    process.env.CODEGRIND_ENDPOINT = 'http://elsewhere:1234/v1';
    process.env.CODEGRIND_MODEL = 'pinned-by-the-deploy';
    try {
      const svc = await import('../services/provider.service.js');
      svc.hydrateProviderConfig();
      const status = svc.describeProviders();
      expect(status.workhorse.model).toBe('pinned-by-the-deploy');
      expect(status.workhorse.endpoint).toBe('http://elsewhere:1234/v1');
      expect(status.workhorse.source.model).toBe('env');
      // The wizard renders read-only on this, because a row written under a
      // pinned field is a row that never takes effect.
      expect(status.envLocked).toBe(true);
    } finally {
      delete process.env.CODEGRIND_PROVIDER;
      delete process.env.CODEGRIND_ENDPOINT;
      delete process.env.CODEGRIND_MODEL;
      vi.resetModules();
    }
  });
});
