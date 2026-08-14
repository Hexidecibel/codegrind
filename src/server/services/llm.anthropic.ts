// =============================================================================
// llm.anthropic — the Anthropic implementation of LlmClient
// =============================================================================
// Everything vendor-specific about talking to Anthropic lives here and nowhere
// else: the SDK, the key, the `cache_control` wrapper, the `thinking` block, the
// retry policy, and the shape of the request body.
//
// THE BODY KEY ORDER IN `buildBody` IS LOAD-BEARING. Anthropic's prompt cache
// keys on a prefix of the serialized request, and `tools` sits in FRONT of
// `system`, so the order `model, max_tokens, thinking, system, tools,
// tool_choice, messages` is the order every call site used before this file
// existed. llm.golden.test.ts asserts, against a fixture captured from that
// pre-abstraction code, that the serialized body — key order included — has not
// moved. Reordering these keys costs money and reports nothing.

import Anthropic from '@anthropic-ai/sdk';
import {
  DEFAULT_TIMEOUT_MS,
  LlmTimeoutError,
  LlmToolCallError,
  type CallMeta,
  type LlmClient,
  type ProviderCaps,
  type StructuredRequest,
  type StructuredResult,
  type TextRequest,
  type TextResult,
  type ThinkingMode,
} from './llm.types.js';

/**
 * The message a MISSING key produces, everywhere.
 *
 * It used to say "provision it via bin/inject", which is correct on exactly one
 * machine in the world and meaningless on the one this app is being handed to.
 * The first-run wizard is now the answer for everybody else, and the
 * environment variable stays named for the people who already use it.
 */
export const NO_API_KEY_MESSAGE =
  'No Anthropic API key is configured. Open codegrind in a browser and paste one into the setup screen, or set ANTHROPIC_API_KEY in the environment.';

/** Where the SDK will actually send this, for error messages that can be acted on. */
const DEFAULT_BASE_URL = 'https://api.anthropic.com';

const CAPS: ProviderCaps = {
  forcedToolUse: true,
  promptCaching: true,
  needsCredential: true,
};

/** Thinking, translated. `off` is the default because ten of eleven calls want it. */
const THINKING: Record<ThinkingMode, Anthropic.ThinkingConfigParam> = {
  off: { type: 'disabled' },
  adaptive: { type: 'adaptive' },
};

// -----------------------------------------------------------------------------
// Retry policy — TRANSPORT ONLY.
// -----------------------------------------------------------------------------
// Three attempts, `2000ms * attempt` between them, on the failures that are
// genuinely transient: a socket that never came up, and the statuses that mean
// "not now" rather than "not ever".
//
// A refusal is never retried — the same prompt refuses the same way. Neither is
// a missing or malformed tool call: that is semantic, and semantic retry belongs
// to bank.service, which knows how to vary the prompt. See LlmToolCallError.
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 2000;
/** 429/529 = back off; 502/503/504 = a gateway hiccup in front of the model. */
const RETRY_STATUSES = new Set([429, 502, 503, 504, 529]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRetryable(err: unknown): boolean {
  // Our own deadline is a budget, not a hint — retrying it would double it.
  if (err instanceof LlmTimeoutError) return false;
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return RETRY_STATUSES.has(status);
  // No HTTP status at all means the request never got an answer: DNS, a refused
  // connection, a dropped socket. Transport, so worth one more go.
  return err instanceof Error;
}

/**
 * Test seams. Never set in production — they exist so the timeout can be proven
 * against a transport that hangs, without black-holing a real address.
 */
export interface AnthropicSeam {
  fetch?: typeof globalThis.fetch;
  baseURL?: string;
}

// The client is cached on the KEY it was built with, not merely on existence.
// The first-run wizard can write a key into a RUNNING server (apikey.service
// publishes it into the environment), so a client cached forever on first
// construction would make the first paste appear to work while every subsequent
// call kept using the client that has no key.
let cachedClient: Anthropic | null = null;
let cachedKey: string | null = null;

function sdkFor(seam?: AnthropicSeam): Anthropic {
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? '').trim();
  if (!apiKey) throw new Error(NO_API_KEY_MESSAGE);
  // maxRetries: 0 because THIS file owns the retry policy. Left at the SDK
  // default of 2, a transient 529 would be retried twice by the SDK inside each
  // of our three attempts — six requests and a budget nobody can predict.
  if (seam) return new Anthropic({ apiKey, maxRetries: 0, ...seam });
  if (!cachedClient || cachedKey !== apiKey) {
    cachedClient = new Anthropic({ apiKey, maxRetries: 0 });
    cachedKey = apiKey;
  }
  return cachedClient;
}

/**
 * Reject at `ms` no matter what the transport does.
 *
 * The SDK's own `timeout` aborts a request it is waiting on, which is the right
 * thing and is also passed below — but it can only fire if the fetch it was
 * given honours an abort signal. This race is the guarantee that the budget
 * holds regardless, which is the whole point of having one.
 */
function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const guarded = work.finally(() => clearTimeout(timer));
  // The loser of the race must not surface later as an unhandled rejection.
  guarded.catch(() => {});
  return Promise.race([
    guarded,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(onTimeout()), ms);
    }),
  ]);
}

function metaOf(res: Anthropic.Message, model: string, startedAt: number): CallMeta {
  const usage = res.usage as Partial<Anthropic.Usage> | undefined;
  return {
    // What the endpoint says it served, which is not always what was asked for.
    servedModel: res.model || model,
    stop: res.stop_reason ?? null,
    latencyMs: Date.now() - startedAt,
    usage: {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cachedInputTokens: usage?.cache_read_input_tokens ?? 0,
    },
  };
}

export function createAnthropicClient(model: string, seam?: AnthropicSeam): LlmClient {
  const endpoint = seam?.baseURL ?? process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL;

  /** The request body, in the one key order the prompt cache understands. */
  function buildBody(
    req: StructuredRequest | TextRequest
  ): Anthropic.MessageCreateParamsNonStreaming {
    const tool = 'tool' in req ? req.tool : undefined;
    return {
      model,
      max_tokens: req.maxTokens,
      thinking: THINKING[req.thinking ?? 'off'],
      // The caller hands over a plain string; the ephemeral wrapper is this
      // adapter's business and is applied unconditionally.
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      ...(tool
        ? {
            tools: [
              {
                name: tool.name,
                description: tool.description,
                input_schema: tool.schema as unknown as Anthropic.Tool.InputSchema,
              },
            ],
            tool_choice: { type: 'tool' as const, name: tool.name },
          }
        : {}),
      messages: req.messages,
    };
  }

  /** One call, with retries, inside a single wall-clock budget. */
  async function send(
    req: StructuredRequest | TextRequest,
    body: Anthropic.MessageCreateParamsNonStreaming
  ): Promise<Anthropic.Message> {
    const budget = req.timeoutMs ?? DEFAULT_TIMEOUT_MS.anthropic[req.role];
    const deadline = Date.now() + budget;
    // Resolved BEFORE the loop: a missing key is a configuration error, and
    // retrying it three times with backoff only delays saying so.
    const sdk = sdkFor(seam);

    const expired = () =>
      new LlmTimeoutError(
        `Anthropic call timed out after ${budget}ms (model ${model}, endpoint ${endpoint}). ` +
          `No answer arrived inside the budget for this ${req.role} call.`,
        model,
        endpoint,
        budget
      );

    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw lastErr instanceof Error && attempt > 1 ? lastErr : expired();

      const controller = new AbortController();
      const abort = () => controller.abort();
      req.signal?.addEventListener('abort', abort, { once: true });
      try {
        // No `timeout` option: the deadline above IS the budget, and letting the
        // SDK raise its own timeout first would surface "Request timed out" —
        // an error that names neither the model nor the endpoint, on the one
        // failure where knowing which endpoint hung is the entire diagnosis.
        // The abort still closes the socket.
        return await withDeadline(
          sdk.messages.create(body, { signal: controller.signal }) as Promise<Anthropic.Message>,
          remaining,
          () => {
            controller.abort();
            return expired();
          }
        );
      } catch (err) {
        lastErr = err;
        // A caller who cancelled does not want two more attempts.
        if (req.signal?.aborted) throw err;
        if (!isRetryable(err) || attempt === MAX_ATTEMPTS) throw err;
        const backoff = RETRY_BACKOFF_MS * attempt;
        // Sleeping past the deadline would report a timeout that was really a
        // transport error, and would hide the status that caused it.
        if (Date.now() + backoff >= deadline) throw err;
        await sleep(backoff);
      } finally {
        req.signal?.removeEventListener('abort', abort);
      }
    }
    throw lastErr instanceof Error ? lastErr : expired();
  }

  /** A safety decline is a successful 200, so it has to be checked before content. */
  function assertNotRefused(res: Anthropic.Message): void {
    if (res.stop_reason === 'refusal') {
      throw new Error(`${model} declined this request (stop_reason: refusal).`);
    }
  }

  return {
    provider: 'anthropic',
    model,
    caps: CAPS,

    async structured(req: StructuredRequest): Promise<StructuredResult> {
      const startedAt = Date.now();
      const res = await send(req, buildBody(req));
      const meta = metaOf(res, model, startedAt);
      assertNotRefused(res);

      const call = res.content?.find(
        (block): block is Anthropic.ToolUseBlock =>
          block.type === 'tool_use' && block.name === req.tool.name
      );
      if (!call) {
        // Semantic, therefore terminal here. The caller decides whether to retry.
        throw new LlmToolCallError(
          `${model} did not call ${req.tool.name} as expected (stop_reason: ${
            meta.stop ?? 'none'
          }).`,
          meta
        );
      }
      return { input: (call.input ?? {}) as Record<string, unknown>, meta };
    },

    async text(req: TextRequest): Promise<TextResult> {
      const startedAt = Date.now();
      const res = await send(req, buildBody(req));
      const meta = metaOf(res, model, startedAt);
      assertNotRefused(res);

      // Thinking blocks come back ahead of the answer and (displayed as
      // "omitted") carry no text, so content[0] is not necessarily the reply.
      const text = (res.content ?? [])
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return { text, meta };
    },

    async listModels(timeoutMs = 10_000): Promise<string[] | null> {
      try {
        const page = await withDeadline(
          sdkFor(seam).models.list({ limit: 100 }),
          timeoutMs,
          () =>
            new LlmTimeoutError(
              `Listing models timed out after ${timeoutMs}ms (endpoint ${endpoint}).`,
              model,
              endpoint,
              timeoutMs
            )
        );
        return page.data.map((m) => m.id);
      } catch {
        // null, not []: "could not ask" is not "answered, and offers nothing".
        return null;
      }
    },
  };
}
