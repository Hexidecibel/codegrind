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
  /**
   * Required by `exactSchema` below, and meaningless without it. Left optional
   * here because nine of the app's eleven tools do not ask for exact validation
   * and adding the key to them would move their cached prefix for nothing.
   */
  additionalProperties?: boolean;
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
  /**
   * "This schema must be validated EXACTLY — the answer is worthless if it is
   * merely schema-shaped."
   *
   * INTENT, NOT A VENDOR FIELD, which is what keeps it on the right side of the
   * seam. Anthropic implements exactly this guarantee as `strict: true` on the
   * tool definition (GA, no beta header), and llm.anthropic.ts is the only file
   * that knows the spelling. An endpoint that cannot offer the guarantee simply
   * does not: llm.openai.ts sends nothing, because the OpenAI-only `strict`
   * spelling is one of the several newer spellings the local servers this app
   * targets do not all accept, and the whole reason findSchemaTypeViolation
   * below exists is that that path has to be defended in code instead.
   *
   * Setting it obliges the schema to carry `additionalProperties: false` and to
   * name EVERY property in `required` — a field that must stay optional in
   * effect is typed nullable (`type: ['string', 'null']`) and the consumer
   * treats an explicit null exactly as it treats an absent field.
   */
  exactSchema?: boolean;
  /**
   * The trailing string field where a model's post-call drift lands, if this
   * tool has one. Only meaningful together with `exactSchema`.
   *
   * MEASURED, AND THE MEASUREMENT IS THE WHOLE JUSTIFICATION. With strict tool
   * use on, the coaching call stopped collapsing — every field arrived, every
   * type was right, `missed` came back as four real anchored objects. What did
   * NOT stop was the model's urge to write tool-call markup once it had said
   * everything it had to say; the grammar simply has nowhere left to put it but
   * the last string still open. Two live calls, and both of them ended with
   *
   *     calibration: "</antml>\n\n<invoke name=\"emit_coaching\">\n"
   *     calibration: "</antml :parameter>\n"
   *
   * and a complete, correct brief in front of it.
   *
   * findLeakedToolCallFraming rejects a leak because it means THE FIELDS THAT
   * SHOULD HAVE FOLLOWED ARE MISSING — read its header, that is the entire
   * argument. Nothing follows the last field, and under `exactSchema` nothing
   * can be missing anyway, so in this one slot the premise is simply false. A
   * guard that fired here threw a good brief away and sent the player to a
   * degraded retry that answered `pattern: "bogus"` — which is how this was
   * found.
   *
   * The named field is NOT thereby trusted. It is excused from meaning "the
   * call collapsed"; the consumer still has to treat its contents as suspect,
   * which for `emit_coaching` is `looksLikeToolCallFraming` in llm.service.
   */
  leakSink?: string;
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
  /**
   * "This is a growing conversation; cache the history, not just the system."
   *
   * INTENT, NOT A VENDOR FIELD — the same rule as `exactSchema`. Absent (every
   * call that existed before the mock interviewer) means exactly what it always
   * meant: only the system prompt is cached, and the serialized body is byte-
   * identical to llm.golden.test.ts's fixture. Set, the Anthropic adapter also
   * marks the LAST message as a cache breakpoint, so turn N+1 reads turns 1..N
   * back at the cache-read rate instead of paying full input for them again.
   *
   *   'short'  5-minute entries — a conversation whose replies arrive quickly.
   *   'long'   1-hour entries on BOTH markers — a candidate can think for longer
   *            than five minutes, and a miss re-bills the whole transcript as a
   *            cache write. The system marker has to move to 1h too: Anthropic
   *            requires longer-TTL entries to appear before shorter ones, and a
   *            5-minute system marker in front of a 1-hour message marker is a 400.
   *
   * An endpoint with no such concept ignores it (llm.openai.ts does: llama.cpp's
   * slot cache is an automatic prefix match and needs no marker).
   */
  cacheConversation?: 'short' | 'long';
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
    /**
     * Prefix tokens WRITTEN to cache on this call, billed above the base input
     * rate. Optional because only an endpoint with explicit cache writes has the
     * number; absent reads as 0. The mock interviewer's cost accounting is the
     * one consumer that needs it — a conversation cache is mostly writes on the
     * turn that adds a message and mostly reads on every turn after.
     */
    cacheWriteInputTokens?: number;
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

// -----------------------------------------------------------------------------
// A tool call that collapsed into one of its own string fields
// -----------------------------------------------------------------------------
// THIS IS A GUARD, AND IT IS LABELLED AS ONE. It does not fix a defect in this
// codebase — there is no defect here to fix. Every path was checked: nothing in
// this app parses tool calls out of text (no `<invoke>`/`<parameter>` reader
// exists anywhere in src/), there is no streaming and therefore no partial-JSON
// accumulation (see the note at the top of this file), the Anthropic adapter
// takes `tool_use.input` already parsed by the SDK, and the OpenAI-compatible
// adapter does exactly one `JSON.parse` of `function.arguments` and THROWS on
// failure rather than falling back to raw text. No code path here can build the
// broken shape.
//
// What was observed in production is the model emitting it. On the coaching
// call — the app's headline feature — `patternRecognition` came back as:
//
//     …nested loops.</patternRecognition> <parameter name="complexity">{"yours": "O(n)…
//
// i.e. the model wrote a well-formed tool call for the first few fields and then
// serialized the REMAINING fields as tool-call markup INSIDE the last string it
// was writing. The transport is happy — it is a valid tool_use block with a
// valid string in that slot — so the brief rendered that markup verbatim into
// CoachPanel, and `complexity`, having never been emitted as a real field, was
// coerced to the honest-but-useless "unknown"/"unknown". Seen on 4 of 6 submits
// across two different models, which is what rules out one model misbehaving.
//
// So the app-side defect is the ABSENCE OF VALIDATION: `structured()` accepted
// anything that had the right JSON *type* and never asked whether the content
// was a tool call that had fallen apart. This closes that.
//
// IT DETECTS AND REJECTS A SHAPE — it does not strip tags out of prose. That
// distinction is deliberate: this app teaches programming, and a perfectly
// legitimate lesson about parsing XML would contain tags. What is matched is
// TOOL-CALL FRAMING naming THIS tool's own schema — `<parameter name="X">` where
// X is a sibling property of the field it was found in, or a `</X>` close tag
// for one, or an `<invoke>`/`<function_calls>` wrapper. A brief that genuinely
// discusses XML does not name this tool's field list in tool-call syntax.
//
// Rejecting rather than repairing is the same call the adapters already make for
// malformed JSON: the leaked text COULD be re-parsed to recover the missing
// fields, but that means writing a parser for a broken format nobody specifies,
// and getting it subtly wrong stores a plausible-looking wrong answer instead of
// an obvious failure. `LlmToolCallError` is the established channel — bank
// generation retries it with a varied prompt, and routes/submit.ts falls back to
// the "coaching is temporarily unavailable" brief, which is a far better thing
// to show a player than markup and two "unknown"s.

/** `<parameter name="x">`, `</parameter>`, `<invoke …>`, `<function_calls>` — closing forms too. */
const FRAMING_TAG = /<\/?\s*(?:antml:)?(function_calls|invoke|parameter)\b([^>]*)>/gi;
/** `name="x"` inside such a tag. */
const TAG_NAME = /name\s*=\s*"([^"]*)"/i;
/**
 * Any tool-call element at all, named or not. Used only as corroboration for
 * the unmatched-close-tag rule below — never on its own, because on its own it
 * is exactly the "regex-strip tags out of prose" mistake this avoids.
 *
 * IT HAS TO KNOW THE SCHEMA'S FIELD NAMES, and that is a measurement. The
 * `<parameter name="x">` dialect is only one of the two the model actually
 * emits; the other names the FIELD directly, and a real payload went
 *
 *     …reach for binary search.</patternRecognition>\n<complexity>\n<yours>O(…
 *
 * with not one `<parameter>` in it. Corroborating only on `parameter`/`invoke`/
 * `function_calls` therefore let that whole dialect through: the close tag was
 * found, nothing "tool-call-shaped" followed it as far as this regex was
 * concerned, and the leak was reported as clean content.
 *
 * The safety argument is unchanged, because it never rested on this regex
 * alone: the rule still needs an UNMATCHED close tag naming a field of THIS
 * tool, and what follows must ALSO name a field of this tool (or be a wrapper).
 * A lesson holding a bare `</code>` is still fine; a lesson holding `</code>`
 * followed by `<takeaway>` is the torn edge of a serialized call.
 */
const escapeForRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function followingFraming(fields: Set<string>): RegExp {
  const names = ['function_calls', 'invoke', 'parameter', ...fields].map(escapeForRegex);
  return new RegExp(`<\\/?\\s*(?:antml:)?(?:${names.join('|')})\\b`, 'i');
}

/**
 * Every property name anywhere in a tool's schema, nested ones included.
 *
 * NESTED NAMES ARE THE POINT. When `missed` grew from `string[]` to an array of
 * objects, the names the model can write in markup grew with it — a captured
 * payload put `<parameter name="note">` (a SUBFIELD of a `missed` item) inside
 * the `missed` string, and a detector holding only the eight top-level names
 * had nothing to match it against and passed the payload through.
 */
export function schemaFieldNames(schema: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    const props = n.properties;
    if (props && typeof props === 'object') {
      for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
        out.add(k);
        walk(v);
      }
    }
    if (n.items) walk(n.items);
  };
  walk(schema);
  return out;
}

/** Where a leak was found, and what gave it away. Both go into the error message. */
export interface ToolCallLeak {
  /** Dotted path to the offending string, e.g. `patternRecognition` or `missed[1]`. */
  field: string;
  /** The literal marker matched, clipped — enough to recognize without dumping the brief. */
  marker: string;
}

/**
 * Find tool-call framing that leaked into a STRING of an otherwise-valid result.
 *
 * Walks the whole result, not just the top level, because `missed` is an array
 * of strings and a collapse can land in any of them.
 */
export function findLeakedToolCallFraming(
  input: Record<string, unknown>,
  tool: ToolSpec
): ToolCallLeak | null {
  // The tool's own field names, TOP LEVEL AND NESTED. A tag naming one of these
  // is the signature: the model was writing THIS schema, in markup, inside a
  // value of THIS schema.
  const fields = schemaFieldNames(tool.schema);
  const following = followingFraming(fields);

  const leakIn = (s: string): string | null => {
    for (const m of s.matchAll(FRAMING_TAG)) {
      const kind = m[1].toLowerCase();
      // `<function_calls>` and `<invoke>` are the wrapper elements of a tool
      // call and have no other reading in a coaching brief or a problem
      // statement — no sibling check needed, and demanding one would miss the
      // wrapper-only variant.
      if (kind === 'function_calls' || kind === 'invoke') return m[0].slice(0, 120);
      const named = TAG_NAME.exec(m[2] ?? '');
      // `<parameter name="complexity">` where `complexity` is a sibling. The
      // sibling check is what keeps a lesson that merely mentions a
      // `<parameter>` element from tripping this.
      if (named && fields.has(named[1])) return m[0].slice(0, 120);
    }
    // The other half of the observed payload: the model closed the field it was
    // writing with a tag named after the FIELD rather than after `parameter`
    // (`…nested loops.</patternRecognition>`). Three conditions, all required,
    // because this half is the one that can be confused with real content:
    //
    //   * the name is a field of THIS tool;
    //   * nothing opened it — a matched `<x>…</x>` pair is ordinary markup,
    //     while an unmatched close is the torn edge of a serialized call;
    //   * more tool-call framing FOLLOWS it. This is what makes the rule safe.
    //     Several schema fields are also real HTML elements (`title` in
    //     emit_problem, `code` in emit_lesson), so a lesson about HTML could
    //     legitimately end up holding a bare `</code>`. It cannot legitimately
    //     hold one with the next tool parameter written out after it, which is
    //     precisely what a collapse looks like: the remaining fields have to go
    //     somewhere, and they go here.
    for (const field of fields) {
      const close = `</${field}>`;
      const at = s.indexOf(close);
      if (at < 0 || s.includes(`<${field}>`)) continue;
      if (following.test(s.slice(at + close.length))) return close;
    }
    return null;
  };

  // See ToolSpec.leakSink. Excused only when the schema is validated exactly,
  // because that is what makes "nothing can be missing" a fact rather than a hope.
  const sink = tool.exactSchema ? tool.leakSink : undefined;

  const walk = (value: unknown, path: string): ToolCallLeak | null => {
    if (typeof value === 'string') {
      if (path === sink) return null;
      const marker = leakIn(value);
      return marker ? { field: path, marker } : null;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const hit = walk(value[i], `${path}[${i}]`);
        if (hit) return hit;
      }
      return null;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const hit = walk(v, path ? `${path}.${k}` : k);
        if (hit) return hit;
      }
    }
    return null;
  };

  return walk(input, '');
}

// -----------------------------------------------------------------------------
// A field that arrived as the WRONG JSON TYPE
// -----------------------------------------------------------------------------
// THE SECOND HALF OF THE SAME BUG, and the half the leak detector above cannot
// see. When the model breaks out of JSON partway through a tool call, the field
// it breaks out AT does not arrive as damaged content — it arrives as a
// different TYPE. Five live calls against one real submission produced, at the
// exact field where the schema stopped being a flat list of strings:
//
//   missed:     declared `array`,  arrived as "\n<item><note>…</note>…"
//   missed:     declared `array`,  arrived as "\n<parameter name=\"note\">…"
//   complexity: declared `object`, arrived as "\n<parameter name=\"yours\">O(n…"
//
// Nothing objected. `coerceMissed` starts `if (!Array.isArray(raw)) return []`
// and `coach` starts `(input.complexity ?? {})`, so a string in either slot is
// silently read as "the model had nothing to say" — an EMPTY "what you missed"
// beside a confident "unknown / unknown", which is precisely the panel a real
// user reported. Every one of those defences is correct in isolation; together
// they turn a structural failure into a plausible-looking answer.
//
// THE RULE IS DELIBERATELY THE NARROWEST ONE THAT CATCHES ALL OF IT: a property
// the schema declares `array` or `object`, arriving as a `string`. There is no
// legitimate reading of that. It is NOT a JSON Schema validator and must not
// grow into one — no `required` check (a model omitting an optional field is
// ordinary), no enum check (`coerceMistakeTags` already filters), and above all
// no check on ARRAY ELEMENTS: `missed` declares objects and a small local model
// answers with plain strings, which `coerceMissed` supports on purpose and
// which is a degraded brief, not a broken one.
//
// On the Anthropic path `exactSchema` makes this unreachable — the API validates
// the call before it is returned. It is written for the OpenAI-compatible path,
// which has no such guarantee, and as the belt for the day a `strict` promise
// does not hold.

/** A field whose JSON type contradicts the schema. Both parts go in the error. */
export interface SchemaTypeViolation {
  /** Dotted path to the offending value, e.g. `complexity` or `missed[0].fix`. */
  field: string;
  /** What the schema declared: `array` or `object`. */
  declared: string;
  /** The first 120 characters of the string that arrived instead. */
  got: string;
}

/**
 * Find a property the schema declares as a container that arrived as a string.
 *
 * Walks the schema and the value together, so `properties` nested inside
 * `properties` and inside `items` are all reached.
 */
export function findSchemaTypeViolation(
  input: Record<string, unknown>,
  tool: ToolSpec
): SchemaTypeViolation | null {
  const walk = (schema: unknown, value: unknown, path: string): SchemaTypeViolation | null => {
    if (!schema || typeof schema !== 'object') return null;
    const node = schema as Record<string, unknown>;

    const props = node.properties;
    if (props && typeof props === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
      const v = value as Record<string, unknown>;
      for (const [key, sub] of Object.entries(props as Record<string, unknown>)) {
        if (!(key in v)) continue;
        const here = path ? `${path}.${key}` : key;
        const declared = (sub as Record<string, unknown> | null)?.type;
        if ((declared === 'array' || declared === 'object') && typeof v[key] === 'string') {
          return { field: here, declared, got: (v[key] as string).slice(0, 120) };
        }
        const hit = walk(sub, v[key], here);
        if (hit) return hit;
      }
      return null;
    }

    // Into arrays only to REACH nested properties. The elements themselves are
    // never judged here — see the note above on `missed` and local models.
    if (node.items && Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const hit = walk(node.items, value[i], `${path}[${i}]`);
        if (hit) return hit;
      }
    }
    return null;
  };

  return walk(tool.schema, input, '');
}

/**
 * Does this short string look like tool-call markup rather than a sentence?
 *
 * For a `leakSink` field ONLY — it is deliberately blunter than
 * findLeakedToolCallFraming, because it is applied to one short field with a
 * known job (a one-sentence predicted-vs-actual note) rather than to a lesson
 * that may legitimately teach XML. It also has to catch the SPACED form the
 * model actually emitted, `</antml :parameter>`, which is not a well-formed tag
 * and which the strict detector correctly declines to match.
 */
const SINK_FRAMING =
  /<\/?\s*(?:antml\s*[:.]?\s*)?(?:function_calls|invoke|parameter)\b|<\/\s*antml\b/i;

export function looksLikeToolCallFraming(s: string): boolean {
  return SINK_FRAMING.test(s);
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
