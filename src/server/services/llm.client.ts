// =============================================================================
// llm.client — which model answers which kind of call
// =============================================================================
// The call sites in llm.service.ts say WHAT they want (`structured`, `text`) and
// what KIND of call it is (`role`). This file is the only place that turns a
// role into a configured client, which is what keeps the word "provider" out of
// llm.service.ts entirely — a rule that exists because the alternative is
// visible one directory over, in soulseek-helper, where an `if` per function
// went out of step function by function.
//
// A second implementation was added by adding ONE BRANCH to `clientFor`. No call
// site changed, and none of them can tell.
//
// -----------------------------------------------------------------------------
// THE CONFIGURATION, AND WHY IT IS SHAPED LIKE THIS
// -----------------------------------------------------------------------------
// Environment only, at module load, per field:
//
//   | field                  | env                                              | fallback        |
//   |------------------------|--------------------------------------------------|-----------------|
//   | workhorse provider     | CODEGRIND_PROVIDER                               | anthropic       |
//   | workhorse model        | ANTHROPIC_MODEL / CODEGRIND_MODEL                | provider default|
//   | tutor provider         | CODEGRIND_CHAT_PROVIDER                          | workhorse's     |
//   | tutor model            | ANTHROPIC_CHAT_MODEL / CODEGRIND_CHAT_MODEL      | workhorse's     |
//   | endpoint               | CODEGRIND_ENDPOINT, then QWEN_URL                 | —               |
//   | endpoint credential    | CODEGRIND_API_KEY                                | — (fleets have none) |
//   | models never to touch  | CODEGRIND_MODEL_DENY (comma list)                | empty           |
//   | output-token ceiling   | CODEGRIND_MAX_OUTPUT_TOKENS (0 = uncapped)       | llm.types.MAX_OUTPUT_TOKENS |
//
// `ANTHROPIC_MODEL` AND `ANTHROPIC_CHAT_MODEL` KEEP WORKING EXACTLY AS TODAY.
// That is the compatibility guarantee for the existing systemd deploy, and it is
// why the vendor-named variables are still read first — for the vendor they name.
// They are deliberately NOT consulted when the provider is something else: a
// deploy that sets `ANTHROPIC_MODEL=claude-sonnet-5` and then switches provider
// would otherwise ask a local llama.cpp for a Claude model id and get a 404 it
// could not explain. Vendor-named config configures that vendor; `CODEGRIND_*`
// is the provider-neutral spelling.
//
// TUTOR DEFAULTS TO MATCHING THE WORKHORSE, in provider AND model. A local-only
// install must stay local-only: no key, no signup, no spend. A tutor that
// quietly fell back to Anthropic would be a bill the user never agreed to, which
// is the exact thing this work exists to prevent. Using Claude for the tutor
// while the workhorse runs locally is fully supported — it is just opt-in, via
// CODEGRIND_CHAT_PROVIDER.
//
// THERE IS NO FAILOVER. If the configured endpoint is down, calls fail, loudly,
// naming the endpoint and the model. They do not silently become Anthropic calls.

import { createAnthropicClient } from './llm.anthropic.js';
import { createOpenAiClient } from './llm.openai.js';
import type {
  CallRole,
  LlmClient,
  ProviderId,
  StructuredRequest,
  StructuredResult,
  TextRequest,
  TextResult,
} from './llm.types.js';

export { NO_API_KEY_MESSAGE } from './llm.anthropic.js';

/** The default model per provider, for the roles that have one. */
const ANTHROPIC_WORKHORSE_DEFAULT = 'claude-sonnet-5';
const ANTHROPIC_TUTOR_DEFAULT = 'claude-opus-5';

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

/** Read at module load, as these always have been: deployment configuration. */
function readProvider(name: string, fallback: ProviderId): ProviderId {
  const raw = env(name);
  if (!raw) return fallback;
  if (raw === 'anthropic' || raw === 'openai-compatible') return raw;
  throw new Error(
    `${name}="${raw}" is not a provider codegrind knows. Use "anthropic" or ` +
      `"openai-compatible" (the latter covers llama.cpp, llama-swap, vLLM, Ollama, ` +
      `LM Studio and anything else speaking /v1/chat/completions).`
  );
}

/**
 * The resolved routing for one role. Computed once; a request may not change it.
 */
interface Routing {
  provider: ProviderId;
  model: string;
}

const WORKHORSE_PROVIDER: ProviderId = readProvider('CODEGRIND_PROVIDER', 'anthropic');
const TUTOR_PROVIDER: ProviderId = readProvider('CODEGRIND_CHAT_PROVIDER', WORKHORSE_PROVIDER);

/**
 * The workhorse: generation, forced-tool-use extraction, lesson writing, corpus
 * translation, and the per-submit coaching brief — everything that runs on a
 * schedule the user doesn't control. `small` shares it: those calls differ in
 * their token budget and their timeout, not in who answers.
 */
const WORKHORSE: Routing = {
  provider: WORKHORSE_PROVIDER,
  model:
    (WORKHORSE_PROVIDER === 'anthropic' ? env('ANTHROPIC_MODEL') : '') ||
    env('CODEGRIND_MODEL') ||
    (WORKHORSE_PROVIDER === 'anthropic' ? ANTHROPIC_WORKHORSE_DEFAULT : ''),
};

/**
 * The teaching model, used by `askFollowup` alone: one call per question
 * actually asked, the lowest-frequency and highest-value call in the app.
 * `coach` is the other teaching call but fires on every submit, so it stays on
 * the workhorse and buys its quality with thinking instead.
 *
 * Its default is the WORKHORSE's model — including the workhorse's provider —
 * so that pointing this app at a local endpoint moves the whole app, tutor
 * included. On the Anthropic path the historical default (a bigger model for
 * the tutor) is preserved exactly.
 */
function tutorModel(): string {
  if (TUTOR_PROVIDER === 'anthropic') {
    // The vendor-named variable first, for the vendor it names: today's deploy
    // sets ANTHROPIC_CHAT_MODEL and must keep behaving identically.
    const named = env('ANTHROPIC_CHAT_MODEL') || env('CODEGRIND_CHAT_MODEL');
    // No explicit model: the historical default, which is a bigger model for
    // the one call per question actually asked. Reaching this with a LOCAL
    // workhorse means someone opted into Claude for the tutor deliberately.
    return named || ANTHROPIC_TUTOR_DEFAULT;
  }
  const named = env('CODEGRIND_CHAT_MODEL');
  if (named) return named;
  // Match the workhorse — the local-stays-local rule. When the providers differ
  // there is nothing to inherit (a Claude model id is not a local model id), so
  // the model has to be named and `build` says so.
  return TUTOR_PROVIDER === WORKHORSE_PROVIDER ? WORKHORSE.model : '';
}

const TUTOR: Routing = { provider: TUTOR_PROVIDER, model: tutorModel() };

/** Where an OpenAI-compatible endpoint lives. `QWEN_URL` is the fleet's name for it. */
const ENDPOINT = env('CODEGRIND_ENDPOINT') || env('QWEN_URL');
const ENDPOINT_KEY = env('CODEGRIND_API_KEY');

/**
 * Model ids this process must never send work to.
 *
 * Configuration rather than cleverness: codegrind cannot know that one id in a
 * router's `/v1/models` is mapped onto a CPU on the same box as the user's media
 * server. The deployment's own systemd unit sets this. See llm.openai.assertNotDenied.
 */
const MODEL_DENY = env('CODEGRIND_MODEL_DENY')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * The output-token ceiling for an OpenAI-compatible endpoint, overriding the
 * measured default in llm.types.MAX_OUTPUT_TOKENS.
 *
 * It is here rather than in the adapter for the same reason CODEGRIND_MODEL_DENY
 * is: it is a fact about somebody's deployment, not about the wire format. The
 * default is calibrated against one 35B local model; a friend running something
 * that genuinely writes bigger problems raises it, and `0` turns the ceiling off
 * altogether and sends every call site's number verbatim.
 */
function readMaxOutputTokens(): number | null | undefined {
  const raw = env('CODEGRIND_MAX_OUTPUT_TOKENS');
  if (!raw) return undefined; // not set — the adapter keeps its measured default
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `CODEGRIND_MAX_OUTPUT_TOKENS="${raw}" is not a whole number of tokens. Use a ` +
        `positive integer, or 0 to send every call site's own budget uncapped.`
    );
  }
  return n === 0 ? null : n;
}

const MAX_OUTPUT_TOKENS_OVERRIDE = readMaxOutputTokens();

const clients = new Map<CallRole, LlmClient>();

function build(routing: Routing, role: CallRole): LlmClient {
  if (routing.provider === 'anthropic') {
    return createAnthropicClient(routing.model);
  }
  if (!ENDPOINT) {
    throw new Error(
      `CODEGRIND_PROVIDER is "openai-compatible" but no endpoint is configured. ` +
        `Set CODEGRIND_ENDPOINT (or QWEN_URL) to the base URL of an OpenAI-compatible ` +
        `server, including the version segment — e.g. http://127.0.0.1:9600/v1`
    );
  }
  if (!routing.model) {
    const which = role === 'tutor' ? 'CODEGRIND_CHAT_MODEL' : 'CODEGRIND_MODEL';
    throw new Error(
      `No model is configured for ${role} calls. Set ${which} to a model id the ` +
        `endpoint at ${ENDPOINT} actually serves — there is no safe default, because ` +
        `picking one for you is how a router hands the job to whatever is cheapest to ` +
        `load, which on some fleets is a CPU.`
    );
  }
  return createOpenAiClient(routing.model, {
    endpoint: ENDPOINT,
    apiKey: ENDPOINT_KEY || undefined,
    deny: MODEL_DENY,
    // `undefined` when unset, which is what keeps the adapter's own default —
    // `null` is a real value here and means "no ceiling".
    ...(MAX_OUTPUT_TOKENS_OVERRIDE === undefined
      ? {}
      : { maxOutputTokens: MAX_OUTPUT_TOKENS_OVERRIDE }),
  });
}

/** How a role is routed, without building (or needing) a client. */
export function routingFor(role: CallRole): Readonly<Routing> {
  return role === 'tutor' ? TUTOR : WORKHORSE;
}

/**
 * Does this configuration need an Anthropic API key to work at all?
 *
 * The one question the CLI entry points and the boot log have to ask before
 * refusing to run: a fully local install has no key, wants no key, and must not
 * be told to go and get one.
 */
export function needsAnthropicKey(): boolean {
  return WORKHORSE.provider === 'anthropic' || TUTOR.provider === 'anthropic';
}

/** A one-line description of the routing, for logs. Never includes a credential. */
export function describeRouting(): string {
  const workhorse = `${WORKHORSE.provider}:${WORKHORSE.model}`;
  const tutor = `${TUTOR.provider}:${TUTOR.model}`;
  const where = WORKHORSE.provider === 'anthropic' && TUTOR.provider === 'anthropic'
    ? ''
    : ` via ${ENDPOINT || '(no endpoint configured)'}`;
  return workhorse === tutor
    ? `${workhorse}${where}`
    : `workhorse ${workhorse}, tutor ${tutor}${where}`;
}

/**
 * The client for a role.
 *
 * `workhorse` and `small` are the same client on purpose — they differ in their
 * token budget and their timeout, not in who answers. `tutor` is separate
 * because it is the one call that may be worth a different model.
 */
export function clientFor(role: CallRole): LlmClient {
  const key: CallRole = role === 'tutor' ? 'tutor' : 'workhorse';
  let client = clients.get(key);
  if (!client) {
    client = build(routingFor(key), key);
    clients.set(key, client);
  }
  return client;
}

/** A forced-tool-use call: the tool's schema IS the response schema. */
export function structured(req: StructuredRequest): Promise<StructuredResult> {
  return clientFor(req.role).structured(req);
}

/** A prose call. Exactly one call site in the app uses it: the tutor chat. */
export function text(req: TextRequest): Promise<TextResult> {
  return clientFor(req.role).text(req);
}
