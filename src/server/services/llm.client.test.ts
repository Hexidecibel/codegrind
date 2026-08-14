// =============================================================================
// llm.client.test — who answers, and what it costs to get that wrong
// =============================================================================
// This file is a table of environments and the routing each one must produce.
// It is worth testing precisely because the failures are silent and expensive:
//
//   * A deploy that sets ANTHROPIC_MODEL and gets a different model is a
//     regression nothing else in the suite can see. That variable is the
//     compatibility guarantee for the existing systemd install.
//   * A local-only install whose TUTOR quietly stayed on Anthropic is a bill
//     the user never agreed to — the exact failure this whole stage exists to
//     prevent — and it would only show up on the credit card.
//   * A missing endpoint or model must fail LOUDLY, at the call, naming what to
//     set. Falling back to Anthropic instead would be the same silent spend.
//
// The module reads its configuration ONCE at load, deliberately (a request must
// not be able to re-route a running server), so each case re-imports it under a
// fresh environment via vi.resetModules.

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { CallRole } from './llm.types.js';

const VARS = [
  'CODEGRIND_PROVIDER',
  'CODEGRIND_CHAT_PROVIDER',
  'CODEGRIND_MODEL',
  'CODEGRIND_CHAT_MODEL',
  'CODEGRIND_ENDPOINT',
  'CODEGRIND_API_KEY',
  'CODEGRIND_MODEL_DENY',
  'QWEN_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_CHAT_MODEL',
];

const SAVED = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));

afterEach(() => {
  for (const v of VARS) {
    if (SAVED[v] === undefined) delete process.env[v];
    else process.env[v] = SAVED[v];
  }
  vi.resetModules();
});

/** Load the module fresh under `env`, and report how each role is routed. */
async function routeUnder(env: Record<string, string>) {
  for (const v of VARS) delete process.env[v];
  Object.assign(process.env, env);
  vi.resetModules();
  const mod = await import('./llm.client.js');
  const of = (role: CallRole) => {
    const c = mod.clientFor(role);
    return `${c.provider}:${c.model}`;
  };
  return {
    workhorse: of('workhorse'),
    small: of('small'),
    tutor: of('tutor'),
    needsAnthropicKey: mod.needsAnthropicKey(),
    describe: mod.describeRouting(),
    clientFor: mod.clientFor,
  };
}

// =============================================================================
describe('the default: nothing configured', () => {
  it('is Anthropic, with the two models it has always used', async () => {
    const r = await routeUnder({});
    expect(r.workhorse).toBe('anthropic:claude-sonnet-5');
    expect(r.tutor).toBe('anthropic:claude-opus-5');
  });

  it('gives workhorse and small the same client — they differ in budget, not in who answers', async () => {
    const r = await routeUnder({});
    expect(r.small).toBe(r.workhorse);
    expect(r.clientFor('small')).toBe(r.clientFor('workhorse'));
  });
});

// =============================================================================
describe('the compatibility guarantee for the existing deploy', () => {
  it('honours ANTHROPIC_MODEL and ANTHROPIC_CHAT_MODEL exactly as before', async () => {
    const r = await routeUnder({
      ANTHROPIC_MODEL: 'claude-haiku-5',
      ANTHROPIC_CHAT_MODEL: 'claude-opus-5-1',
    });
    expect(r.workhorse).toBe('anthropic:claude-haiku-5');
    expect(r.tutor).toBe('anthropic:claude-opus-5-1');
  });

  it('lets the vendor-named variable win for the vendor it names', async () => {
    const r = await routeUnder({ ANTHROPIC_MODEL: 'claude-haiku-5', CODEGRIND_MODEL: 'ignored' });
    expect(r.workhorse).toBe('anthropic:claude-haiku-5');
  });

  it('IGNORES ANTHROPIC_MODEL once the provider is not Anthropic', async () => {
    // A deploy that switches provider without unsetting the old variable would
    // otherwise ask a local llama.cpp for "claude-sonnet-5" and get a 404 it
    // could not explain.
    const r = await routeUnder({
      CODEGRIND_PROVIDER: 'openai-compatible',
      CODEGRIND_ENDPOINT: 'http://127.0.0.1:9600/v1',
      CODEGRIND_MODEL: 'Qwen3-local-q8',
      ANTHROPIC_MODEL: 'claude-sonnet-5',
      ANTHROPIC_CHAT_MODEL: 'claude-opus-5',
    });
    expect(r.workhorse).toBe('openai-compatible:Qwen3-local-q8');
    expect(r.tutor).toBe('openai-compatible:Qwen3-local-q8');
  });
});

// =============================================================================
describe('a local-only install', () => {
  const LOCAL = {
    CODEGRIND_PROVIDER: 'openai-compatible',
    CODEGRIND_ENDPOINT: 'http://127.0.0.1:9600/v1',
    CODEGRIND_MODEL: 'Qwen3-local-q8',
  };

  it('routes every role to the local endpoint, tutor included', async () => {
    const r = await routeUnder(LOCAL);
    expect(r.workhorse).toBe('openai-compatible:Qwen3-local-q8');
    expect(r.small).toBe('openai-compatible:Qwen3-local-q8');
    // THE POINT OF THE WHOLE STAGE. A tutor that stayed on Claude here is a
    // signup and a bill for someone who asked for neither.
    expect(r.tutor).toBe('openai-compatible:Qwen3-local-q8');
  });

  it('needs no Anthropic key at all', async () => {
    const r = await routeUnder(LOCAL);
    expect(r.needsAnthropicKey).toBe(false);
  });

  it('accepts QWEN_URL as the endpoint when CODEGRIND_ENDPOINT is unset', async () => {
    const r = await routeUnder({
      CODEGRIND_PROVIDER: 'openai-compatible',
      QWEN_URL: 'http://127.0.0.1:9600/v1',
      CODEGRIND_MODEL: 'local-model',
    });
    expect(r.workhorse).toBe('openai-compatible:local-model');
    expect(r.describe).toContain('http://127.0.0.1:9600/v1');
  });

  it('prefers CODEGRIND_ENDPOINT over QWEN_URL', async () => {
    const r = await routeUnder({
      CODEGRIND_PROVIDER: 'openai-compatible',
      CODEGRIND_ENDPOINT: 'http://127.0.0.1:9600/v1',
      QWEN_URL: 'http://elsewhere:1234/v1',
      CODEGRIND_MODEL: 'local-model',
    });
    expect(r.describe).toContain('127.0.0.1:9600');
    expect(r.describe).not.toContain('elsewhere');
  });
});

// =============================================================================
describe('mixed providers', () => {
  it('keeps a local workhorse while the tutor is opted in to Claude', async () => {
    const r = await routeUnder({
      CODEGRIND_PROVIDER: 'openai-compatible',
      CODEGRIND_ENDPOINT: 'http://127.0.0.1:9600/v1',
      CODEGRIND_MODEL: 'Qwen3-local-q8',
      CODEGRIND_CHAT_PROVIDER: 'anthropic',
    });
    expect(r.workhorse).toBe('openai-compatible:Qwen3-local-q8');
    expect(r.tutor).toBe('anthropic:claude-opus-5');
    expect(r.needsAnthropicKey).toBe(true);
  });

  it('keeps an Anthropic workhorse while the tutor runs locally', async () => {
    const r = await routeUnder({
      CODEGRIND_CHAT_PROVIDER: 'openai-compatible',
      CODEGRIND_ENDPOINT: 'http://127.0.0.1:9600/v1',
      CODEGRIND_CHAT_MODEL: 'Qwen3-local-q8',
    });
    expect(r.workhorse).toBe('anthropic:claude-sonnet-5');
    expect(r.tutor).toBe('openai-compatible:Qwen3-local-q8');
  });
});

// =============================================================================
describe('configuration that cannot work fails loudly', () => {
  it('says which variable to set when the endpoint is missing', async () => {
    for (const v of VARS) delete process.env[v];
    process.env.CODEGRIND_PROVIDER = 'openai-compatible';
    process.env.CODEGRIND_MODEL = 'local-model';
    vi.resetModules();
    const mod = await import('./llm.client.js');
    // Loudly, and NOT by quietly becoming an Anthropic call.
    expect(() => mod.clientFor('workhorse')).toThrow(/CODEGRIND_ENDPOINT/);
  });

  it('says which variable to set when the model is missing', async () => {
    for (const v of VARS) delete process.env[v];
    process.env.CODEGRIND_PROVIDER = 'openai-compatible';
    process.env.CODEGRIND_ENDPOINT = 'http://127.0.0.1:9600/v1';
    vi.resetModules();
    const mod = await import('./llm.client.js');
    expect(() => mod.clientFor('workhorse')).toThrow(/CODEGRIND_MODEL/);
  });

  it('rejects a provider name it does not implement, at load', async () => {
    for (const v of VARS) delete process.env[v];
    process.env.CODEGRIND_PROVIDER = 'ollama';
    vi.resetModules();
    await expect(import('./llm.client.js')).rejects.toThrow(/openai-compatible/);
  });

  it('refuses a denied model rather than sending it work', async () => {
    for (const v of VARS) delete process.env[v];
    process.env.CODEGRIND_PROVIDER = 'openai-compatible';
    process.env.CODEGRIND_ENDPOINT = 'http://127.0.0.1:9600/v1';
    process.env.CODEGRIND_MODEL = 'Qwen3-local';
    process.env.CODEGRIND_MODEL_DENY = 'Qwen3-local, something-else';
    vi.resetModules();
    const mod = await import('./llm.client.js');
    expect(() => mod.clientFor('workhorse')).toThrow(/CODEGRIND_MODEL_DENY/);
  });
});
