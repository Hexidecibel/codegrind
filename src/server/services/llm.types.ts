// =============================================================================
// llm.types — the shape of a model call, with no vendor in it
// =============================================================================
// codegrind used to speak to exactly one endpoint, and every call site wrote its
// own `messages.create` body by hand. This file is the seam that replaced that:
// what a call needs to say, expressed once, so a second implementation is a new
// file rather than a branch inside eleven functions.
//
// THE INTERFACE IS STRUCTURED-OUTPUT-FIRST, and that is a measurement rather
// than a preference: ten of the eleven calls in this app are forced tool use.
// Only the tutor chat wants prose. So there are two methods — `structured` and
// `text` — instead of one string-in/string-out method that every structured
// caller would then have to parse its way out of.
//
// THE TOOL SCHEMA IS THE RESPONSE SCHEMA. `ToolSpec.schema` is the JSON Schema
// the model must fill in; forcing the tool is how the structure is obtained.
// That is the one idea worth keeping from the other local-LLM consumer on this
// box, whose own abstraction otherwise shows exactly what to avoid: a
// per-function `if (isLocal)` fork that had to be repeated, and got out of step,
// in every function that made a call.
//
// WHAT DELIBERATELY DOES NOT CROSS THIS INTERFACE:
//
//   * `cache_control`. `system` is a plain string. Wrapping it in an ephemeral
//     text block is the Anthropic adapter's business, and an implementation that
//     has no such concept simply does not do it. What actually makes caching
//     work was never a call-site concern anyway — see the note on byte stability
//     below.
//   * Streaming. There is none: eleven `messages.create`, zero `.stream`. The
//     only streaming in the app is Hono's NDJSON in routes/setup.ts.
//   * Temperature and the other sampling knobs. Nothing here sets one, and the
//     newer Anthropic models reject them outright.
//
// BYTE STABILITY IS THE CACHING CONTRACT, AND IT IS SHARED. Anthropic caches on
// a prefix of the serialized request; llama.cpp's slot cache is likewise a
// prefix match on the tokenized prompt. Both are defeated by the same mistake —
// a system prompt or a tool definition rebuilt, and subtly re-worded, per call.
// So `GENERATE_SYSTEM_BY_LANGUAGE` and `EMIT_PROBLEM_TOOL_BY_LANGUAGE` are built
// ONCE at module load by `perLanguage()`, there is no per-call scope for a
// dynamic value to leak in from, and no adapter may reformat, reorder or
// re-indent the strings it is handed. That invariant belongs to every
// implementation, including the ones whose `caps.promptCaching` is false.

/** Which implementation is behind an `LlmClient`. */
export type ProviderId = 'anthropic' | 'openai-compatible';

/**
 * What an endpoint can actually do — reported, never assumed.
 *
 * `forcedToolUse` is the one that decides whether this app works at all: ten of
 * eleven calls are a forced tool call, and an endpoint that cannot force one has
 * no usable fallback here short of prompt-and-parse.
 */
export interface ProviderCaps {
  /** The endpoint honours "you must call exactly this tool". */
  forcedToolUse: boolean;
  /** The endpoint bills cached prefix tokens at a discount when told to cache. */
  promptCaching: boolean;
  /** A credential is required to talk to it at all. */
  needsCredential: boolean;
}

/**
 * Thinking as ADVICE, not as a configuration block.
 *
 * Every endpoint spells reasoning differently — Anthropic takes a `thinking`
 * object, llama.cpp takes `chat_template_kwargs`, Qwen3 additionally needs a
 * `/no_think` prefix injected because it leaks through the kwarg. A caller that
 * had to know which is which would be back to branching per function. It says
 * what it wants; the adapter says how.
 */
export type ThinkingMode = 'off' | 'adaptive';

/**
 * What KIND of call this is. It selects the model and the timeout budget, and it
 * is the reason neither of those is a magic number at a call site.
 *
 *   workhorse — the big structured calls (>= 8000 output tokens): problem
 *               generation, the per-submit coaching brief, corpus translation.
 *   small     — the cheap forced-tool calls: hints, session plans, primers,
 *               outlines, lesson bodies.
 *   tutor     — the conversational teaching call, one per question actually
 *               asked. The only `text` call in the app.
 */
export type CallRole = 'workhorse' | 'small' | 'tutor';

/** A JSON Schema object. Passed through verbatim; nothing here rewrites it. */
export interface ToolSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

/**
 * A tool definition, which is to say a response schema with a name on it.
 *
 * `schema` is the Anthropic `input_schema` body unchanged — the rename is the
 * whole difference, because the JSON Schema itself is already the interchange
 * format every endpoint in play speaks.
 */
export interface ToolSpec {
  name: string;
  description: string;
  schema: ToolSchema;
}

/** One conversational turn. `system` is not a role here — it is its own field. */
export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Fields every call carries, structured or not. */
interface BaseRequest {
  role: CallRole;
  /**
   * The system prompt, as a plain string. Precomputed by the caller and passed
   * through byte-for-byte — see the byte-stability note at the top of this file.
   */
  system: string;
  messages: LlmMessage[];
  /**
   * The output budget for THIS call, in tokens.
   *
   * Never defaulted, and never *raised* by an adapter. Each of the call sites
   * carries a comment explaining its number, usually recording a truncation that
   * actually happened; a helpful abstraction that "tidied" them would be
   * re-earning those bugs one at a time.
   *
   * It may be LOWERED, by exactly one documented mechanism: MAX_OUTPUT_TOKENS
   * below, which is per-implementation and exists because a budget is a promise
   * about the worst case and the worst case is not the same on every endpoint.
   * See that constant for the measurement behind it.
   */
  maxTokens: number;
  /** Advisory. Defaults to 'off' — the ten structured calls all want it off. */
  thinking?: ThinkingMode;
  /**
   * The wall-clock budget for the whole call INCLUDING retries. Defaults from
   * DEFAULT_TIMEOUT_MS by role. This is not decoration: routes/submit.ts wraps
   * `coach()` in a graceful fallback that, without a bound, can never be
   * reached — the request simply hangs and the candidate's passing tests never
   * render.
   */
  timeoutMs?: number;
  /** Caller-side cancellation, composed with the timeout rather than replacing it. */
  signal?: AbortSignal;
}

export interface StructuredRequest extends BaseRequest {
  /** The tool the model MUST call, exactly once. Its schema is the response schema. */
  tool: ToolSpec;
}

export type TextRequest = BaseRequest;

/**
 * What actually happened, as opposed to what was asked for.
 *
 * `servedModel` is the ground truth and the reason this type exists: a router in
 * front of an endpoint is free to substitute a different model than the one
 * named in the request, and the reply is the only place that shows it.
 */
export interface CallMeta {
  servedModel: string;
  /** The endpoint's stop reason, verbatim. `max_tokens` means truncation. */
  stop: string | null;
  latencyMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    /** Prefix tokens served from cache. 0 everywhere caching is off or missed. */
    cachedInputTokens: number;
  };
}

export interface StructuredResult {
  /** The tool call's arguments — i.e. the response, in the schema's shape. */
  input: Record<string, unknown>;
  meta: CallMeta;
}

export interface TextResult {
  text: string;
  meta: CallMeta;
}

export interface LlmClient {
  readonly provider: ProviderId;
  readonly model: string;
  readonly caps: ProviderCaps;
  structured(req: StructuredRequest): Promise<StructuredResult>;
  text(req: TextRequest): Promise<TextResult>;
  /**
   * What the endpoint says it serves. `null` means it could not be asked (no
   * such route, unreachable, no credential) — which is different from `[]`,
   * meaning it answered and offers nothing. A caller must not conflate them.
   */
  listModels(timeoutMs?: number): Promise<string[] | null>;
}

/**
 * The default wall-clock budget per call, by role and implementation.
 *
 * Local endpoints get double, and the reason is measured rather than cautious: a
 * forced-tool-use probe against the local fleet took 28.9s for 387 completion
 * tokens, and a llama-swap model swap can stall a first request for far longer
 * than that. An 8000-token structured call at that rate is minutes, not seconds.
 */
export const DEFAULT_TIMEOUT_MS: Record<ProviderId, Record<CallRole, number>> = {
  anthropic: { workhorse: 180_000, small: 60_000, tutor: 180_000 },
  'openai-compatible': { workhorse: 300_000, small: 120_000, tutor: 300_000 },
};

/**
 * The most output tokens one call may ask for, per implementation. `null` means
 * uncapped — the call site's number is sent exactly as written.
 *
 * WHY THIS IS NOT SYMMETRIC, AND WHY IT IS NOT A TIDY-UP. A token budget bounds
 * the worst case, and the worst case differs by endpoint. On the Anthropic path
 * the generation call asks for 16000 because a big adversarial expert suite is
 * real output that genuinely needs the room, and running out of it loses a
 * problem worth having. That number stays, uncapped, exactly as it is written at
 * the call site.
 *
 * On the local path 16000 buys nothing and costs five minutes. Measured against a
 * local 35B-class model at ~55 output tokens/sec:
 *
 *   - a legitimate `easy` problem is 976–1320 output tokens (17–23s)
 *   - a legitimate `expert` problem is 1345–5337 output tokens (24–95s)
 *   - a FAILED generation is exactly max_tokens, every time
 *
 * That third line is the whole argument. The failure is not a large problem that
 * ran out of room; it is degenerate repetition. Dumping the raw tool-call
 * arguments of three of them found `"expected": 0, "expected": 0, …` repeated
 * 347×, `1, 2, 1, 2, …` 1106×, and `1, 1, 1, …` 2206×. Once the model enters
 * that loop it emits tokens until something stops it, the output is unusable
 * whenever it stops, and every token in between is pure latency. So the budget
 * on this path is a stop, and its only job is to arrive sooner: 16000 tokens of
 * loop took 293s, 8000 takes 144s, and the problem thrown away is the same one.
 *
 * 8000 rather than something tighter because it must stay clear of real output:
 * the largest legitimate generation observed was 5337 tokens, and a cap that
 * truncates a good expert problem would be trading a rare five-minute wait for a
 * routine lost problem. Override with `CODEGRIND_MAX_OUTPUT_TOKENS` — a stronger
 * local model that genuinely writes bigger suites should raise it, and the
 * truncation error says so.
 */
export const MAX_OUTPUT_TOKENS: Record<ProviderId, number | null> = {
  anthropic: null,
  'openai-compatible': 8000,
};

/**
 * The forced tool call was missing or unusable.
 *
 * IT IS NEVER RETRIED AT THE TRANSPORT LAYER, and that is the sharpest rule in
 * this design. `bank.service.generateAndStore` already retries generation three
 * times, varying the prompt as it goes, because it is the only layer that knows
 * how. A transport that also retried three times would turn one bad completion
 * into nine calls — at ~29s each on a local model, a four-minute failure — and
 * would spend those calls re-sending the exact prompt that just failed.
 *
 * It carries `meta` so a caller can tell "the model refused to answer" from "the
 * answer was cut off at max_tokens", which are the same exception but very
 * different bugs.
 */
export class LlmToolCallError extends Error {
  constructor(
    message: string,
    readonly meta: CallMeta
  ) {
    super(message);
    this.name = 'LlmToolCallError';
  }
}

/** The call did not finish inside its budget. Names the model and the endpoint. */
export class LlmTimeoutError extends Error {
  constructor(
    message: string,
    readonly model: string,
    readonly endpoint: string,
    readonly timeoutMs: number
  ) {
    super(message);
    this.name = 'LlmTimeoutError';
  }
}
