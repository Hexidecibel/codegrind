// =============================================================================
// llm.openai — the OpenAI-compatible implementation of LlmClient
// =============================================================================
// One file, one wire format: `POST {endpoint}/chat/completions` with tools, the
// dialect llama.cpp, llama-swap, vLLM, Ollama, LM Studio and every hosted
// OpenAI-alike agree on. Nothing above this file learns that it exists — the
// only wiring is one branch in llm.client.ts.
//
// THE QUIRKS LIVE HERE AND NOWHERE ELSE. They are lifted, deliberately verbatim,
// from the other Qwen consumer on this box (resume-builder/src/lib/llm.ts), and
// each one is a bug somebody already paid for:
//
//   * `chat_template_kwargs: {enable_thinking: false}` AND a `/no_think` prefix
//     on the system message for any model id matching /qwen3/i. Belt and braces
//     because the kwarg alone LEAKS: Qwen3 ships as a reasoning model, and a
//     leak on a FORCED TOOL CALL is not a stylistic wobble — the reply comes
//     back as prose with no `tool_calls` at all, which is ten of this app's
//     eleven call sites returning nothing usable.
//   * Reading back `msg.content || msg.reasoning_content`. When thinking leaks
//     anyway, the answer is sometimes in the reasoning channel and `content` is
//     empty. Recovering it is free; not recovering it looks like an outage.
//   * 429 is retryable. llama-swap runs `concurrencyLimit=2` and answers 429 as
//     ordinary backpressure — an expected transient response on a shared box,
//     not an error anybody should see.
//
// NO SDK. `fetch` directly, because the parts of an OpenAI SDK this needs are
// the two lines that build the body, and the part it would fight is the one that
// matters: the deadline. This file owns its own budget, aborts its own socket,
// and puts the model AND the endpoint into the error — the SDK's own timeout
// message names neither, on the single failure where knowing which endpoint hung
// is the entire diagnosis.
//
// BYTE STABILITY IS PRESERVED EVEN THOUGH `caps.promptCaching` IS FALSE, and
// that is not an oversight. llama.cpp's slot cache is a PREFIX match on the
// tokenized prompt: an identical leading system message means the whole prefix
// is reused and the call starts generating immediately, while a system prompt
// re-worded per call re-tokenizes and re-evaluates every time. So the string
// this adapter is handed is sent through untouched — not re-indented, not
// re-ordered, not trimmed. The single exception is the constant `/no_think `
// prefix, which is deterministic, applied at the very front, and therefore
// itself a stable prefix. `promptCaching: false` reports the BILLING property
// (there is no cached-token discount to ask for), not a licence to churn bytes.

import {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS,
  LlmTimeoutError,
  LlmToolCallError,
  type CallMeta,
  type LlmClient,
  type LlmMessage,
  type ProviderCaps,
  type StructuredRequest,
  type StructuredResult,
  type TextRequest,
  type TextResult,
} from './llm.types.js';

/**
 * An OpenAI-compatible endpoint is assumed to force tools until it proves
 * otherwise, because the fleet this was built against does (a live probe:
 * `finish_reason: "tool_calls"`, correct name, valid JSON arguments).
 *
 * `promptCaching: false` means "do not ask for a cached-token discount" — see
 * the byte-stability note at the top for why the bytes are stable regardless.
 * `needsCredential: false` because the common case is a LAN endpoint with no
 * auth at all; a key is sent when one is configured and omitted when not.
 */
const CAPS: ProviderCaps = {
  forcedToolUse: true,
  promptCaching: false,
  needsCredential: false,
};

/** Qwen3 leaks its reasoning through `enable_thinking:false`. This is the belt. */
const NO_THINK_PREFIX = '/no_think ';

// -----------------------------------------------------------------------------
// Retry policy — TRANSPORT ONLY, exactly as in the Anthropic adapter.
// -----------------------------------------------------------------------------
// Three attempts, `2000ms * attempt`, and the same rule that matters most: a
// missing or malformed tool call is NEVER retried here. bank.service already
// retries generation three times, varying the prompt; stacking a transport retry
// under it turns one bad completion into nine calls at ~29s each.
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 2000;
/** 429 = llama-swap backpressure; 502/503/504 = the proxy in front of the model. */
const RETRY_STATUSES = new Set([429, 502, 503, 504, 529]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An HTTP failure that is worth another go, carrying the status that said so. */
class TransientHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'TransientHttpError';
  }
}

/** A non-transient HTTP failure. Terminal: the same request fails the same way. */
class HttpStatusError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

function isRetryable(err: unknown): boolean {
  // Our own deadline is a budget, not a hint — retrying it would double it.
  if (err instanceof LlmTimeoutError) return false;
  // Semantic failures are terminal here by design. See LlmToolCallError.
  if (err instanceof LlmToolCallError) return false;
  if (err instanceof TransientHttpError) return true;
  // A 400/401/404/500 is the endpoint's considered answer. Retrying a bad
  // request just sends the same bad request twice more.
  if (err instanceof HttpStatusError) return false;
  // No status at all means the request never got an answer: DNS, a refused
  // connection, a dropped socket. Transport, so worth one more go.
  return err instanceof Error;
}

/**
 * The endpoint's own word for why it stopped, normalized on exactly one point.
 *
 * OpenAI-compatible servers say `length` where Anthropic says `max_tokens`, and
 * `max_tokens` is the string the rest of this app tests against — llm.service's
 * `generateProblem` distinguishes "the model was cut off mid-tool-call" from
 * "the model ignored the tool" by reading `meta.stop`, and it must not learn
 * which vendor answered (llm.structural.test.ts enforces that). So the one
 * synonym is translated here, where vendor differences belong, and every other
 * value is passed through verbatim.
 *
 * This matters more on a local model than it did on Claude: a Qwen3 thinking
 * leak burns the budget on reasoning and comes back with NO tool call and
 * `finish_reason: "length"`. Reported honestly that is a truncation, and the
 * user is told to raise the budget. Reported as `stop` it reads as "the model
 * ignored the tool", which is a different bug with different advice.
 */
function normalizeStop(finishReason: unknown): string | null {
  if (typeof finishReason !== 'string' || !finishReason) return null;
  return finishReason === 'length' ? 'max_tokens' : finishReason;
}

/** The wire shapes this adapter reads. Only the fields actually used. */
interface ChatToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}
interface ChatMessage {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: ChatToolCall[] | null;
}
interface ChatChoice {
  message?: ChatMessage;
  finish_reason?: string | null;
}
interface ChatCompletion {
  model?: string;
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export interface OpenAiSeam {
  /** Test seam. Never set in production. */
  fetch?: typeof globalThis.fetch;
}

export interface OpenAiClientOptions extends OpenAiSeam {
  /** Base URL including the version segment, e.g. `http://127.0.0.1:9600/v1`. */
  endpoint: string;
  /** Optional bearer token. The fleet this was built for has no auth. */
  apiKey?: string;
  /**
   * Model ids this process must never send load to, from `CODEGRIND_MODEL_DENY`.
   * See `assertNotDenied` for why this is configuration and not cleverness.
   */
  deny?: readonly string[];
  /**
   * Hard ceiling on the output tokens any single call may ask for, from
   * `CODEGRIND_MAX_OUTPUT_TOKENS`. Defaults to MAX_OUTPUT_TOKENS for this
   * implementation; `null` disables the ceiling entirely. See that constant for
   * the measurement, and `effectiveMaxTokens` for what it does.
   */
  maxOutputTokens?: number | null;
}

/**
 * Refuse a denied model, loudly, before a single byte goes out.
 *
 * THIS GUARD EXISTS BECAUSE OF A REAL INCIDENT. The owner's router maps one of
 * the advertised model ids onto a CPU-hosted llama.cpp on the very box this app
 * runs on, and a CPU model there once starved the Plex transcoder badly enough
 * to be visible as buffering in the living room. codegrind cannot know a
 * router's topology — the id looks like any other in `/v1/models` — so the
 * deny list is deployment configuration, checked here at the last point before
 * load is created.
 */
function assertNotDenied(model: string, deny: readonly string[], endpoint: string): void {
  if (!deny.some((d) => d === model)) return;
  throw new Error(
    `Refusing to send work to model "${model}" at ${endpoint}: it is listed in ` +
      `CODEGRIND_MODEL_DENY. That list exists to keep load off a model whose ` +
      `router maps it somewhere it must not run. Pick a different model ` +
      `(CODEGRIND_MODEL / CODEGRIND_CHAT_MODEL), or edit the deny list if it is wrong.`
  );
}

/**
 * Reject at `ms` no matter what the transport does.
 *
 * Same shape as the Anthropic adapter's: the loser of the race must not surface
 * later as an unhandled rejection, and the timer must be cleared either way.
 */
function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const guarded = work.finally(() => clearTimeout(timer));
  guarded.catch(() => {});
  return Promise.race([
    guarded,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(onTimeout()), ms);
    }),
  ]);
}

/** Trailing slashes make `${endpoint}/chat/completions` a 404 on some servers. */
function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

export function createOpenAiClient(model: string, opts: OpenAiClientOptions): LlmClient {
  const endpoint = normalizeEndpoint(opts.endpoint);
  const deny = opts.deny ?? [];
  const doFetch = opts.fetch ?? globalThis.fetch;
  // Fail fast, at construction: a denied model is a configuration error, and
  // discovering it one call later means the load it forbids has been created.
  assertNotDenied(model, deny, endpoint);

  const isQwen3 = /qwen3/i.test(model);
  const ceiling =
    opts.maxOutputTokens === undefined
      ? MAX_OUTPUT_TOKENS['openai-compatible']
      : opts.maxOutputTokens;

  /**
   * The budget actually sent: the call site's number, lowered to the ceiling.
   *
   * NEVER RAISED — a call site that asks for 800 tokens gets 800. The ceiling is
   * a stop on the one failure this implementation has that Anthropic's does not:
   * a completion that degenerates into repetition and then runs to whatever
   * budget it was given. See MAX_OUTPUT_TOKENS.
   */
  function effectiveMaxTokens(requested: number): number {
    return ceiling === null ? requested : Math.min(requested, ceiling);
  }

  /** Told to the user only when a call actually hit the ceiling, never otherwise. */
  function ceilingNote(requested: number): string {
    if (ceiling === null || requested <= ceiling) return '';
    return (
      ` The call asked for ${requested} but this endpoint is capped at ${ceiling} ` +
      `output tokens; raise CODEGRIND_MAX_OUTPUT_TOKENS if this model genuinely ` +
      `needs the room.`
    );
  }

  /**
   * The messages array, with `system` in front as its own turn.
   *
   * The system string is passed through BYTE FOR BYTE — see the note at the top
   * of this file. The only edit is the constant `/no_think ` prefix on Qwen3,
   * which is itself stable and idempotent: applying it twice would change the
   * prefix and cost the slot cache, so it is applied only when absent.
   */
  function buildMessages(system: string, messages: LlmMessage[], thinkingOff: boolean): unknown[] {
    const content =
      thinkingOff && isQwen3 && !system.includes('/no_think')
        ? `${NO_THINK_PREFIX}${system}`
        : system;
    return [
      { role: 'system', content },
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ];
  }

  /**
   * The request body.
   *
   * `max_tokens` rather than `max_completion_tokens`: the newer name is an
   * OpenAI-only spelling that llama.cpp, llama-swap and vLLM's older routes do
   * not all accept, and every one of them still honours `max_tokens`.
   *
   * NO `temperature`, AND THAT IS A MEASUREMENT, NOT AN OMISSION. The obvious
   * thing — and what the other Qwen consumer on this box does — is to pin it to
   * 0, because these calls return a JSON object that has to satisfy a schema
   * and sampling variety sounds like nothing but risk. It was tried here first,
   * and five consecutive `bin/dry-run-generate` runs produced the SAME problem,
   * with the same title and byte-identical test inputs. This app's workhorse
   * call exists to author problems a user has not seen; a deterministic bank is
   * a bank with one problem in it, and every quality metric would have reported
   * a perfect score while it happened. So the sampling knobs are left to the
   * server, which is also exactly what the Anthropic adapter does — the
   * interface deliberately carries no temperature for either of them.
   */
  function buildBody(req: StructuredRequest | TextRequest): Record<string, unknown> {
    const tool = 'tool' in req ? req.tool : undefined;
    const thinkingOff = (req.thinking ?? 'off') === 'off';
    return {
      model,
      max_tokens: effectiveMaxTokens(req.maxTokens),
      messages: buildMessages(req.system, req.messages, thinkingOff),
      ...(tool
        ? {
            tools: [
              {
                type: 'function' as const,
                function: {
                  name: tool.name,
                  description: tool.description,
                  // The tool schema IS the response schema, passed through
                  // unchanged — the same JSON Schema body Anthropic is handed.
                  parameters: tool.schema,
                },
              },
            ],
            tool_choice: { type: 'function' as const, function: { name: tool.name } },
          }
        : {}),
      // Ignored by servers that do not implement it, which is why it is
      // unconditional on the `off` path rather than guarded by a model sniff.
      ...(thinkingOff ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    };
  }

  function headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
    };
  }

  /** One call, with transport retries, inside a single wall-clock budget. */
  async function send(req: StructuredRequest | TextRequest): Promise<ChatCompletion> {
    const budget = req.timeoutMs ?? DEFAULT_TIMEOUT_MS['openai-compatible'][req.role];
    const deadline = Date.now() + budget;
    const url = `${endpoint}/chat/completions`;
    const payload = JSON.stringify(buildBody(req));

    const expired = () =>
      new LlmTimeoutError(
        `Local model call timed out after ${budget}ms (model ${model}, endpoint ${endpoint}). ` +
          `No answer arrived inside the budget for this ${req.role} call. ` +
          `Nothing was sent to any other provider.`,
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
        return await withDeadline(
          (async (): Promise<ChatCompletion> => {
            const res = await doFetch(url, {
              method: 'POST',
              headers: headers(),
              body: payload,
              signal: controller.signal,
            });
            if (RETRY_STATUSES.has(res.status)) {
              // Read and discard the body so the socket can be reused; a 429
              // from llama-swap carries nothing worth surfacing.
              await res.text().catch(() => '');
              throw new TransientHttpError(
                `${model} at ${endpoint} answered HTTP ${res.status} (transient).`,
                res.status
              );
            }
            if (!res.ok) {
              const detail = (await res.text().catch(() => '')).slice(0, 500);
              throw new HttpStatusError(
                `${model} at ${endpoint} answered HTTP ${res.status}. ${detail}`,
                res.status
              );
            }
            return (await res.json()) as ChatCompletion;
          })(),
          remaining,
          () => {
            // Abort closes the socket rather than leaving a request in flight
            // against an endpoint that has already lost its budget.
            controller.abort();
            return expired();
          }
        );
      } catch (err) {
        lastErr = err;
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

  function metaOf(res: ChatCompletion, startedAt: number): CallMeta {
    const usage = res.usage;
    return {
      // What the endpoint says it served. On a router this is the ground truth
      // and routinely differs from what was asked for.
      servedModel: res.model || model,
      stop: normalizeStop(res.choices?.[0]?.finish_reason),
      latencyMs: Date.now() - startedAt,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        // Present on servers that report a reused prefix (llama.cpp does);
        // absent, and therefore 0, on most.
        cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
    };
  }

  return {
    provider: 'openai-compatible',
    model,
    caps: CAPS,

    async structured(req: StructuredRequest): Promise<StructuredResult> {
      const startedAt = Date.now();
      const res = await send(req);
      const meta = metaOf(res, startedAt);

      const message = res.choices?.[0]?.message;
      const call = message?.tool_calls?.find((c) => c.function?.name === req.tool.name);
      if (!call) {
        // The commonest local failure, and the reason `meta` is on this error:
        // a thinking leak produces prose (or reasoning_content) and no tool
        // call, and `stop` is what tells "cut off at max_tokens" apart from
        // "answered, but ignored the tool". A leaked preview helps nobody
        // debug a prompt they cannot see, so a short one is included.
        const leak = (message?.content || message?.reasoning_content || '').trim().slice(0, 200);
        throw new LlmToolCallError(
          `${model} at ${endpoint} did not call ${req.tool.name} as expected ` +
            `(finish_reason: ${meta.stop ?? 'none'})` +
            (leak ? `. It replied with prose instead: "${leak}"` : '.') +
            (meta.stop === 'max_tokens' ? ceilingNote(req.maxTokens) : ''),
          meta
        );
      }

      const raw = call.function?.arguments ?? '';
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('arguments were not a JSON object');
        }
        return { input: parsed as Record<string, unknown>, meta };
      } catch (err) {
        // Malformed arguments are semantic, exactly like a missing tool call:
        // terminal here, retried (with a varied prompt) by bank.service.
        throw new LlmToolCallError(
          `${model} at ${endpoint} called ${req.tool.name} with arguments that are not ` +
            `valid JSON (finish_reason: ${meta.stop ?? 'none'}): ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `First 200 characters: ${raw.slice(0, 200)}` +
            (meta.stop === 'max_tokens' ? ceilingNote(req.maxTokens) : ''),
          meta
        );
      }
    },

    async text(req: TextRequest): Promise<TextResult> {
      const startedAt = Date.now();
      const res = await send(req);
      const meta = metaOf(res, startedAt);

      const message = res.choices?.[0]?.message;
      // The thinking-leak recovery: when reasoning escapes into its own channel
      // the visible content can be empty while the actual answer sits in
      // `reasoning_content`. Taking it is free; not taking it looks like an
      // outage to the user.
      const text = (message?.content || message?.reasoning_content || '').trim();
      if (!text) {
        // Not retried: an empty completion from the same prompt is empty again.
        // Named as truncation when that is what it was, because the fix differs.
        throw new Error(
          meta.stop === 'max_tokens'
            ? `${model} at ${endpoint} hit max_tokens before producing any text ` +
              `(budget was ${effectiveMaxTokens(req.maxTokens)} tokens).` +
              ceilingNote(req.maxTokens)
            : `${model} at ${endpoint} returned no content and no reasoning_content ` +
              `(finish_reason: ${meta.stop ?? 'none'}).`
        );
      }
      return { text, meta };
    },

    async listModels(timeoutMs = 10_000): Promise<string[] | null> {
      try {
        const controller = new AbortController();
        const res = await withDeadline(
          doFetch(`${endpoint}/models`, { headers: headers(), signal: controller.signal }),
          timeoutMs,
          () => {
            controller.abort();
            return new LlmTimeoutError(
              `Listing models timed out after ${timeoutMs}ms (endpoint ${endpoint}).`,
              model,
              endpoint,
              timeoutMs
            );
          }
        );
        if (!res.ok) return null;
        const body = (await res.json()) as { data?: { id?: unknown }[] };
        if (!Array.isArray(body?.data)) return null;
        return body.data.map((m) => String(m?.id ?? '')).filter(Boolean);
      } catch {
        // null, not []: "could not ask" is not "answered, and offers nothing".
        return null;
      }
    },
  };
}
