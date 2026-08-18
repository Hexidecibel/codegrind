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
// There are now TWO layers, and the environment wins over the other one FIELD BY
// FIELD (not wholesale — a deploy that pins only the model must still let the
// wizard choose an endpoint):
//
//   1. The environment, read once at module load. Deployment configuration.
//   2. Two rows in the `settings` table, `llm.workhorse` and `llm.tutor`,
//      written by the in-app wizard. Read through an INJECTED reader — see
//      `useStoredProviderConfig` for why this module must not import db.js.
//
//   | field                  | env                                              | fallback        |
//   |------------------------|--------------------------------------------------|-----------------|
//   | workhorse provider     | CODEGRIND_PROVIDER                               | stored, else anthropic |
//   | workhorse model        | ANTHROPIC_MODEL / CODEGRIND_MODEL                | stored, else provider default |
//   | tutor provider         | CODEGRIND_CHAT_PROVIDER                          | stored, else workhorse's |
//   | tutor model            | ANTHROPIC_CHAT_MODEL / CODEGRIND_CHAT_MODEL      | stored, else workhorse's |
//   | endpoint               | CODEGRIND_ENDPOINT, then QWEN_URL                | stored          |
//   | endpoint credential    | CODEGRIND_API_KEY                                | stored (write-only) |
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
// A STORED MODEL IS ONLY USED FOR THE PROVIDER IT WAS STORED AGAINST. The wizard
// writes `{provider, model, endpoint}` together, so if the environment then pins
// a different provider the stored model is silently wrong for it — a local model
// id sent to Anthropic, or the reverse. That pair is checked rather than assumed.
//
// TUTOR DEFAULTS TO MATCHING THE WORKHORSE, in provider AND model. A local-only
// install must stay local-only: no key, no signup, no spend. A tutor that
// quietly fell back to Anthropic would be a bill the user never agreed to, which
// is the exact thing this work exists to prevent. Using Claude for the tutor
// while the workhorse runs locally is fully supported — it is just opt-in, via
// CODEGRIND_CHAT_PROVIDER or the wizard.
//
// THERE IS NO FAILOVER. If the configured endpoint is down, calls fail, loudly,
// naming the endpoint and the model. They do not silently become Anthropic calls.
//
// RESOLUTION IS LAZY AND CACHED, NOT MODULE-LOAD. It used to be module-load,
// because a request must not be able to re-route a running server. That property
// is kept — nothing re-resolves per call — but a settings WRITE has to take
// effect without a restart, so the cache is explicitly invalidated by
// `reloadRouting()` and by nothing else. Environment values are still read (and
// validated) at module load: a deploy that spells a provider wrong should fail
// at boot, not at 3am on the first generate.

import { createAnthropicClient } from './llm.anthropic.js';
import { createOpenAiClient } from './llm.openai.js';
import { findLeakedToolCallFraming, LlmToolCallError } from './llm.types.js';
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

/**
 * What a role falls back to when nothing is stored and nothing is pinned.
 *
 * Exported so the UI can NAME the default it is offering instead of repeating
 * these two ids in TypeScript. The Settings page shows "the coach runs on X,
 * which is the bigger model" and offers to pin it to the workhorse's instead;
 * the moment it is pinned, the default is no longer the resolved value, so
 * there has to be a way to ask for it that is not a second copy of these
 * strings going stale.
 *
 * Empty string for `openai-compatible`, and that is a real answer rather than a
 * gap: there is deliberately no default local model, because picking one for
 * somebody is how a router hands the job to whatever is cheapest to load.
 */
export function roleDefaultModel(role: CallRole, provider: ProviderId): string {
  if (provider !== 'anthropic') return '';
  return role === 'tutor' ? ANTHROPIC_TUTOR_DEFAULT : ANTHROPIC_WORKHORSE_DEFAULT;
}

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

/** Read at module load, as these always have been: deployment configuration. */
function readProvider(name: string): ProviderId | null {
  const raw = env(name);
  if (!raw) return null;
  if (raw === 'anthropic' || raw === 'openai-compatible') return raw;
  throw new Error(
    `${name}="${raw}" is not a provider codegrind knows. Use "anthropic" or ` +
      `"openai-compatible" (the latter covers llama.cpp, llama-swap, vLLM, Ollama, ` +
      `LM Studio and anything else speaking /v1/chat/completions).`
  );
}

// -----------------------------------------------------------------------------
// The stored layer, injected rather than imported
// -----------------------------------------------------------------------------
// This module must NOT import db.js. Two reasons, both concrete:
//
//   * db.js opens a SQLite file at import time, from `DATA_DIR`. llm.client's own
//     test re-imports this module seventeen times under different environments
//     and sets no DATA_DIR, so importing db here would open — and hold open —
//     the AUTHOR'S LIVE DATABASE seventeen times during `vitest run`.
//   * "which model answers" is a question that should be answerable without a
//     database at all: `bin/dry-run-generate` and the boot log both ask it.
//
// So provider.service.ts — which does own the rows, and does import db — pushes
// a reader in. Until it does, the stored layer is simply empty, which is exactly
// right for a process that never opened the database.

/** One role's stored configuration, as written by the wizard. */
export interface StoredRoleConfig {
  provider?: ProviderId;
  model?: string;
  /** Base URL including the version segment, e.g. `http://127.0.0.1:9600/v1`. */
  endpoint?: string;
  /**
   * Bearer token for that endpoint. WRITE-ONLY as far as HTTP is concerned: it
   * lives in the row, it reaches the adapter, and no GET ever returns it.
   */
  endpointKey?: string;
}

export interface StoredProviderConfig {
  workhorse?: StoredRoleConfig | null;
  tutor?: StoredRoleConfig | null;
}

type StoredReader = () => StoredProviderConfig;

const NO_STORED_CONFIG: StoredReader = () => ({});
let readStored: StoredReader = NO_STORED_CONFIG;

/**
 * Let the settings table participate in routing.
 *
 * Called by provider.service.ts on behalf of every entry point that has a
 * database: the server, and the CLI tools that can spend money. Idempotent, and
 * it invalidates the cache so a reader registered after something already asked
 * a routing question still takes effect.
 */
export function useStoredProviderConfig(reader: StoredReader): void {
  readStored = reader;
  reloadRouting();
}

// -----------------------------------------------------------------------------
// The environment layer — read, and validated, once
// -----------------------------------------------------------------------------

const ENV_WORKHORSE_PROVIDER = readProvider('CODEGRIND_PROVIDER');
const ENV_TUTOR_PROVIDER = readProvider('CODEGRIND_CHAT_PROVIDER');
const ENV_ENDPOINT = env('CODEGRIND_ENDPOINT') || env('QWEN_URL');
const ENV_ENDPOINT_KEY = env('CODEGRIND_API_KEY');

/**
 * Model ids this process must never send work to.
 *
 * Configuration rather than cleverness: codegrind cannot know that one id in a
 * router's `/v1/models` is mapped onto a CPU on the same box as the user's media
 * server. The deployment's own systemd unit is what sets this. See
 * llm.openai.assertNotDenied, and provider.service, which also refuses to OFFER
 * a denied model in the wizard — a list you cannot pick from is a better guard
 * than an error after you did.
 */
export const MODEL_DENY: readonly string[] = env('CODEGRIND_MODEL_DENY')
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

// -----------------------------------------------------------------------------
// Resolution
// -----------------------------------------------------------------------------

/** Where a resolved field actually came from. The wizard renders `env` read-only. */
export type FieldSource = 'env' | 'settings' | 'default';

/** The resolved routing for one role. Computed once per reload. */
export interface Routing {
  provider: ProviderId;
  model: string;
  /** Only meaningful for `openai-compatible`. Empty string when unset. */
  endpoint: string;
  /** Never crosses the HTTP boundary. See StoredRoleConfig.endpointKey. */
  endpointKey: string;
  source: {
    provider: FieldSource;
    model: FieldSource;
    endpoint: FieldSource;
    /** `default` means there is no credential at all — the usual LAN case. */
    endpointKey: FieldSource;
  };
}

interface Resolved {
  workhorse: Routing;
  tutor: Routing;
}

/**
 * A stored model belongs to the provider it was stored against.
 *
 * `undefined` in the row means the row predates a provider being written, which
 * only the Anthropic default could have produced.
 */
function storedMatches(stored: StoredRoleConfig, provider: ProviderId): boolean {
  return (stored.provider ?? 'anthropic') === provider;
}

function resolveRole(
  role: 'workhorse' | 'tutor',
  stored: StoredRoleConfig,
  envProvider: ProviderId | null,
  fallbackProvider: ProviderId,
  inherit: Routing | null
): Routing {
  const provider = envProvider ?? stored.provider ?? fallbackProvider;
  const providerSource: FieldSource = envProvider
    ? 'env'
    : stored.provider
      ? 'settings'
      : 'default';

  // The vendor-named variable first, for the vendor it names. Not consulted for
  // any other provider — see the header.
  const vendorNamed =
    provider === 'anthropic' ? env(role === 'tutor' ? 'ANTHROPIC_CHAT_MODEL' : 'ANTHROPIC_MODEL') : '';
  const neutral = env(role === 'tutor' ? 'CODEGRIND_CHAT_MODEL' : 'CODEGRIND_MODEL');

  let model = '';
  let modelSource: FieldSource = 'default';
  if (vendorNamed || neutral) {
    model = vendorNamed || neutral;
    modelSource = 'env';
  } else if (stored.model && storedMatches(stored, provider)) {
    model = stored.model;
    modelSource = 'settings';
  } else if (provider === 'anthropic') {
    // The historical defaults, and they are NOT the inherit rule below: on the
    // Anthropic path the tutor has always been a bigger model than the
    // workhorse, because it is one call per question actually asked. Reaching
    // this for the tutor while the workhorse is local means someone opted into
    // Claude for the tutor deliberately.
    model = role === 'tutor' ? ANTHROPIC_TUTOR_DEFAULT : ANTHROPIC_WORKHORSE_DEFAULT;
    modelSource = 'default';
  } else if (inherit && inherit.provider === provider) {
    // The local-stays-local rule: the tutor matches the workhorse, model and
    // all, unless something said otherwise. When the providers differ there is
    // nothing to inherit (a Claude model id is not a local model id) and `build`
    // says which variable to set.
    model = inherit.model;
    modelSource = inherit.source.model;
  }

  let endpoint = '';
  let endpointSource: FieldSource = 'default';
  if (ENV_ENDPOINT) {
    endpoint = ENV_ENDPOINT;
    endpointSource = 'env';
  } else if (stored.endpoint) {
    endpoint = stored.endpoint;
    endpointSource = 'settings';
  } else if (inherit?.endpoint) {
    endpoint = inherit.endpoint;
    endpointSource = inherit.source.endpoint;
  }

  let endpointKey = '';
  let endpointKeySource: FieldSource = 'default';
  if (ENV_ENDPOINT_KEY) {
    endpointKey = ENV_ENDPOINT_KEY;
    endpointKeySource = 'env';
  } else if (stored.endpointKey) {
    endpointKey = stored.endpointKey;
    endpointKeySource = 'settings';
  } else if (inherit?.endpointKey) {
    endpointKey = inherit.endpointKey;
    endpointKeySource = inherit.source.endpointKey;
  }

  return {
    provider,
    model,
    endpoint,
    endpointKey,
    source: {
      provider: providerSource,
      model: modelSource,
      endpoint: endpointSource,
      endpointKey: endpointKeySource,
    },
  };
}

function resolve(): Resolved {
  const stored = readStored();
  const workhorse = resolveRole(
    'workhorse',
    stored.workhorse ?? {},
    ENV_WORKHORSE_PROVIDER,
    'anthropic',
    null
  );
  const tutor = resolveRole(
    'tutor',
    stored.tutor ?? {},
    ENV_TUTOR_PROVIDER,
    workhorse.provider,
    workhorse
  );
  return { workhorse, tutor };
}

let resolved: Resolved | null = null;
const clients = new Map<CallRole, LlmClient>();

/**
 * Forget the resolved routing and every client built from it.
 *
 * The ONLY way the routing changes in a running process. Called after a settings
 * write; never on a read path, because a request must not be able to re-route a
 * running server, and because a cached client is also a cached HTTP agent.
 */
export function reloadRouting(): void {
  resolved = null;
  clients.clear();
}

function config(): Resolved {
  if (!resolved) resolved = resolve();
  return resolved;
}

function build(routing: Routing, role: CallRole): LlmClient {
  if (routing.provider === 'anthropic') {
    return createAnthropicClient(routing.model);
  }
  if (!routing.endpoint) {
    throw new Error(
      `CODEGRIND_PROVIDER is "openai-compatible" but no endpoint is configured. ` +
        `Set CODEGRIND_ENDPOINT (or QWEN_URL) to the base URL of an OpenAI-compatible ` +
        `server, including the version segment — e.g. http://127.0.0.1:9600/v1 — ` +
        `or configure one in the app's setup screen.`
    );
  }
  if (!routing.model) {
    const which = role === 'tutor' ? 'CODEGRIND_CHAT_MODEL' : 'CODEGRIND_MODEL';
    throw new Error(
      `No model is configured for ${role} calls. Set ${which} to a model id the ` +
        `endpoint at ${routing.endpoint} actually serves — there is no safe default, because ` +
        `picking one for you is how a router hands the job to whatever is cheapest to ` +
        `load, which on some fleets is a CPU.`
    );
  }
  return createOpenAiClient(routing.model, {
    endpoint: routing.endpoint,
    apiKey: routing.endpointKey || undefined,
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
  return role === 'tutor' ? config().tutor : config().workhorse;
}

/**
 * Does this configuration need an Anthropic API key to work at all?
 *
 * The one question the CLI entry points, the boot log and the first-run wizard
 * have to ask before refusing to run: a fully local install has no key, wants no
 * key, and must not be told to go and get one.
 */
export function needsAnthropicKey(): boolean {
  const { workhorse, tutor } = config();
  return workhorse.provider === 'anthropic' || tutor.provider === 'anthropic';
}

/** A one-line description of the routing, for logs. Never includes a credential. */
export function describeRouting(): string {
  const { workhorse: w, tutor: t } = config();
  const workhorse = `${w.provider}:${w.model}`;
  const tutor = `${t.provider}:${t.model}`;
  const endpoint = w.provider !== 'anthropic' ? w.endpoint : t.endpoint;
  const where =
    w.provider === 'anthropic' && t.provider === 'anthropic'
      ? ''
      : ` via ${endpoint || '(no endpoint configured)'}`;
  return workhorse === tutor ? `${workhorse}${where}` : `workhorse ${workhorse}, tutor ${tutor}${where}`;
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

/**
 * A forced-tool-use call: the tool's schema IS the response schema.
 *
 * THE GUARD BELONGS HERE, not in either adapter. A tool call that collapsed into
 * one of its own string fields is a property of the ANSWER, not of the wire
 * format that carried it — the Anthropic and OpenAI-compatible paths would need
 * the identical check, and a check written twice is a check that goes out of
 * step. This is the one place every one of the app's forced-tool calls passes
 * through, so `emit_problem` gets the same protection `emit_coaching` does
 * without a single call site knowing about it.
 *
 * See findLeakedToolCallFraming for what is detected, why it is a guard rather
 * than a fix, and why it rejects instead of repairing.
 */
export async function structured(req: StructuredRequest): Promise<StructuredResult> {
  const result = await clientFor(req.role).structured(req);
  const leak = findLeakedToolCallFraming(result.input, req.tool);
  if (leak) {
    // LlmToolCallError, not a plain Error: this is semantically identical to
    // "the arguments were not valid JSON" — the model answered, the answer is
    // unusable, and the layer that knows how to vary the prompt is the one that
    // should decide about a retry. Never retried at the transport layer.
    throw new LlmToolCallError(
      `${result.meta.servedModel} called ${req.tool.name}, but the field "${leak.field}" ` +
        `contains the raw markup of the tool call itself (${leak.marker}) — the model ` +
        `serialized the fields that should have followed it INTO it, so those fields are ` +
        `missing. The brief was rejected rather than rendered: it would have shown that ` +
        `markup to the user with every later field blank.`,
      result.meta
    );
  }
  return result;
}

/** A prose call. Exactly one call site in the app uses it: the tutor chat. */
export function text(req: TextRequest): Promise<TextResult> {
  return clientFor(req.role).text(req);
}
