// =============================================================================
// explain — the two rules, tested as rules
// =============================================================================
// 1. A KNOWN CAUSE GETS A NEXT ACTION. Not a paraphrase, not a friendlier tone —
//    a sentence naming the thing to do. The value of the whole file is in those
//    verbs, so each one is asserted rather than the general shape.
// 2. NOTHING IS DELETED, AND NOTHING IS INVENTED. The raw message survives as
//    `detail` for every case that was rewritten, and an unrecognised error is
//    passed through untouched with no `detail` at all (offering a "details"
//    disclosure that repeats what is already on screen is worse than none).

import { describe as suite, it, expect } from 'vitest';
import { explainError } from './explain.service.js';
import { LlmTimeoutError, LlmToolCallError } from './llm.types.js';
import type { CallMeta } from './llm.types.js';

const meta = (stop: CallMeta['stop']): CallMeta => ({
  servedModel: 'qwen3-local',
  stop,
  latencyMs: 1000,
  usage: { inputTokens: 10, outputTokens: 8000, cachedInputTokens: 0 },
});

suite('the model ran out of room', () => {
  it('translates llm.service\'s own truncation message', () => {
    const e = explainError(
      new Error(
        'Generation truncated at max_tokens (expert/graphs) after 8000 output tokens — the emitted problem was cut off mid-tool-call.',
      ),
    );
    expect(e.message).toMatch(/ran out of room/i);
    expect(e.message).toMatch(/thinking out loud|enable_thinking/i);
    expect(e.message).not.toMatch(/max_tokens/);
    expect(e.detail).toMatch(/max_tokens/);
  });

  it('recognises the same failure arriving as a typed stop reason', () => {
    const e = explainError(new LlmToolCallError('no tool call', meta('max_tokens')));
    expect(e.message).toMatch(/ran out of room/i);
  });
});

suite('the model answered in prose', () => {
  it('gives the --jinja fix, which is the commonest real cause', () => {
    const e = explainError(new LlmToolCallError('returned text, no tool_calls', meta('stop')));
    expect(e.message).toMatch(/--jinja/);
    expect(e.message).toMatch(/prose/i);
    expect(e.detail).toBe('returned text, no tool_calls');
  });
});

suite('the model took too long', () => {
  it('names the budget in seconds and says to retry', () => {
    const e = explainError(
      new LlmTimeoutError('timed out', 'qwen3-local', 'http://127.0.0.1:9600/v1', 300_000),
    );
    expect(e.message).toContain('300 seconds');
    expect(e.message).toMatch(/try again/i);
  });
});

suite('nothing was listening', () => {
  it.each([
    'fetch failed',
    'connect ECONNREFUSED 127.0.0.1:9600',
    'getaddrinfo ENOTFOUND llm.example',
  ])('recognises %s', (raw) => {
    const e = explainError(new Error(raw));
    expect(e.message).toMatch(/could not reach the model endpoint/i);
    expect(e.detail).toBe(raw);
  });
});

suite('the sandbox could not run', () => {
  it.each([
    'docker: Error response from daemon: no such image: codegrind-runner-go',
    'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
    'spawn /srv/codegrind/bin/run-submission ENOENT',
  ])('recognises %s', (raw) => {
    const e = explainError(new Error(raw));
    expect(e.message).toMatch(/bin\/build-runner-image/);
    expect(e.message).toMatch(/bin\/status/);
    expect(e.detail).toBe(raw);
  });

  it('keeps the raw docker output out of the sentence but not out of the response', () => {
    const raw =
      'Cannot generate a go problem: the sandbox failed, so the reference solution was never run ' +
      'and every expected value would be unverified. Fix the sandbox (bin/build-runner-image, bin/status) ' +
      'and retry. Cause: docker: no such image: codegrind-runner-go';
    const e = explainError(new Error(raw));
    expect(e.message.length).toBeLessThan(raw.length);
    expect(e.detail).toBe(raw);
  });
});

suite('an unrecognised failure', () => {
  it('is passed through exactly, with no invented advice', () => {
    const e = explainError(new Error('something nobody has seen before'));
    expect(e.message).toBe('something nobody has seen before');
    expect(e.detail).toBeUndefined();
  });

  it('survives a non-Error being thrown', () => {
    expect(explainError('a bare string').message).toBe('a bare string');
    expect(explainError(undefined).message).toBe('undefined');
  });
});
