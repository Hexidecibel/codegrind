// =============================================================================
// provider.service — configuring which model answers, from the browser
// =============================================================================
// Everything above this file used to require editing a unit file to change the
// model. This is the half that lets the first-run wizard do it instead:
//
//   * TWO ROWS, NEVER A MIGRATION. `llm.workhorse` and `llm.tutor` in the
//     existing `settings` table, each holding a JSON object. SCHEMA_VERSION
//     stays 3. The settings table was designed for exactly this (see db.ts).
//   * THE ENVIRONMENT STILL WINS, FIELD BY FIELD. That merge lives in
//     llm.client.ts, which this file feeds through `useStoredProviderConfig`.
//     Nothing here re-implements it.
//   * THE EXISTING `apiKey` ROW IS NOT TOUCHED, not renamed, not moved. An
//     install that has one and no `llm.*` rows resolves to the Anthropic default
//     exactly as it did before this file existed — zero migration, zero change.
//
// -----------------------------------------------------------------------------
// THE GUARDRAIL, AND WHY IT IS A GATE AND NOT ADVICE
// -----------------------------------------------------------------------------
// `apikey.service.validate()` already proves an Anthropic key against Anthropic
// before storing it, because a bad key accepted here fails later as an opaque
// 401 inside a 30-second operation nobody connects to something they typed two
// screens ago. An endpoint + model is the same problem with a worse failure, so
// it gets the same treatment, in two steps:
//
//   1. `GET /v1/models`, and the chosen id must be IN the list. "The server is
//      up" and "the server serves that model" are different facts and only the
//      second one matters; a router happily 404s a name it has never heard of,
//      minutes later, mid-generation.
//   2. ONE FORCED TOOL CALL, against a schema shaped like codegrind's own —
//      an array of objects with required fields, and one deliberately
//      loosely-typed field, which is the construct that wobbles on weaker
//      models. Ten of this app's eleven LLM calls are forced tool calls. A
//      model that answers them with prose cannot run codegrind at all, so this
//      is a gate: the configuration is NOT STORED when it fails.
//
// Latency is measured on that same call and reported as a WARNING, never a gate.
// A slow endpoint works; it just means the bank has to be stocked ahead of time.
// The user is told the number and its consequence, and left to decide.

import {
  MODEL_DENY,
  reloadRouting,
  routingFor,
  useStoredProviderConfig,
  type Routing,
  type StoredProviderConfig,
  type StoredRoleConfig,
} from './llm.client.js';
import { createOpenAiClient } from './llm.openai.js';
import { LlmTimeoutError, LlmToolCallError, type ToolSpec } from './llm.types.js';
import { getSetting, setSetting } from './db.js';
import type {
  CredentialStatus,
  LlmProviderCheck,
  LlmProviderId,
  LlmRoleStatus,
  LlmStatus,
} from '../../shared/types.js';

/** The two rows. Named for what they configure, not for who wrote them. */
export const WORKHORSE_SETTING = 'llm.workhorse';
export const TUTOR_SETTING = 'llm.tutor';

/**
 * The wall-clock budget for the whole validation, and it is a human's patience
 * rather than a model's.
 *
 * 90 seconds is not generous for a chat completion — it is the number that
 * survives a llama-swap COLD START, where the first request to an unloaded model
 * waits for weights to page in before a single token is produced. A tighter
 * budget would fail honest local setups on their first ever call and tell them
 * their model cannot do tool use.
 */
const PROBE_TIMEOUT_MS = 90_000;

/** Small on purpose: the probe proves a capability, it does not write a problem. */
const PROBE_MAX_TOKENS = 500;

/**
 * The output size of a real generation, for turning a measured token rate into a
 * number of seconds the user can act on.
 *
 * Measured, not guessed: legitimate generations on the local fleet ran 976–1320
 * output tokens at `easy` and 1345–5337 at `expert` (see llm.types
 * MAX_OUTPUT_TOKENS). 1200 is the middle of the common case.
 */
const TYPICAL_PROBLEM_OUTPUT_TOKENS = 1200;

/** Above this, waiting for a problem mid-session is a real experience problem. */
const SLOW_PROBLEM_SECONDS = 20;

// -----------------------------------------------------------------------------
// The rows
// -----------------------------------------------------------------------------

function isProviderId(value: unknown): value is LlmProviderId {
  return value === 'anthropic' || value === 'openai-compatible';
}

/**
 * Read one row, defensively.
 *
 * A settings row is JSON written by a previous version of this app and is
 * therefore untrusted input. Anything unrecognisable reads as absent, which
 * degrades to "the Anthropic default" rather than to a server that will not boot
 * — the same forgiving-read rule db.getSetting already applies.
 */
function readRole(key: string): StoredRoleConfig | null {
  const raw = getSetting<unknown>(key);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const cfg: StoredRoleConfig = {};
  if (isProviderId(o.provider)) cfg.provider = o.provider;
  if (typeof o.model === 'string' && o.model.trim()) cfg.model = o.model.trim();
  if (typeof o.endpoint === 'string' && o.endpoint.trim()) cfg.endpoint = o.endpoint.trim();
  if (typeof o.endpointKey === 'string' && o.endpointKey.trim())
    cfg.endpointKey = o.endpointKey.trim();
  return Object.keys(cfg).length > 0 ? cfg : null;
}

/** The stored layer, as llm.client wants it. */
export function readStoredProviderConfig(): StoredProviderConfig {
  return { workhorse: readRole(WORKHORSE_SETTING), tutor: readRole(TUTOR_SETTING) };
}

/**
 * Make the stored rows count towards routing.
 *
 * Explicit rather than a module-load side effect, and called next to
 * `apikey.hydrate()` by every entry point that has a database and can spend
 * money — the server, `bin/seed-bank`, `bin/dry-run-generate`. A process that
 * never calls it routes from the environment alone, which is exactly right for
 * a unit test that never opened a database.
 */
export function hydrateProviderConfig(): void {
  useStoredProviderConfig(readStoredProviderConfig);
}

// -----------------------------------------------------------------------------
// Endpoints, and the userinfo that must not survive contact with this file
// -----------------------------------------------------------------------------

/**
 * Normalize an endpoint, or say why it is not one.
 *
 * `user:pass@` is stripped rather than rejected, and that is deliberate: a
 * credential pasted into a URL field is a credential the user believes is
 * configured, and rejecting the URL teaches them nothing while echoing it back
 * in an error message would put it in a log. It comes off before the value is
 * stored and before it is ever returned.
 */
export function parseEndpoint(raw: string): { url: string } | { error: string } {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return {
      error:
        'Enter the address of your OpenAI-compatible server, including the version ' +
        'segment — for example http://127.0.0.1:9600/v1',
    };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      error:
        `"${trimmed}" is not a URL codegrind can call. It needs the scheme and the ` +
        `version segment — for example http://127.0.0.1:9600/v1`,
    };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      error: `codegrind can only call http:// or https:// endpoints, not ${url.protocol}//`,
    };
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  url.search = '';
  return { url: url.toString().replace(/\/+$/, '') };
}

// -----------------------------------------------------------------------------
// Describing the live configuration, without describing a credential
// -----------------------------------------------------------------------------

function describeCredential(routing: Routing): CredentialStatus {
  if (!routing.endpointKey) return { configured: false, source: null, suffix: null };
  return {
    configured: true,
    source: routing.source.endpointKey === 'env' ? 'env' : 'settings',
    suffix: routing.endpointKey.slice(-4),
  };
}

function describeRole(routing: Routing): LlmRoleStatus {
  return {
    provider: routing.provider,
    model: routing.model,
    endpoint: routing.endpoint || null,
    source: { ...routing.source },
    credential: describeCredential(routing),
  };
}

/** The whole provider picture, safe to serialize. Never carries a credential. */
export function describeProviders(): LlmStatus {
  const workhorse = routingFor('workhorse');
  const tutor = routingFor('tutor');
  const pinned = (r: Routing) =>
    r.source.provider === 'env' || r.source.model === 'env' || r.source.endpoint === 'env';
  return {
    workhorse: describeRole(workhorse),
    tutor: describeRole(tutor),
    envLocked: pinned(workhorse) || pinned(tutor),
    deny: [...MODEL_DENY],
    needsAnthropicKey: workhorse.provider === 'anthropic' || tutor.provider === 'anthropic',
  };
}

// -----------------------------------------------------------------------------
// Asking an endpoint what it serves
// -----------------------------------------------------------------------------

/** A denied id is not offered. A list you cannot pick from beats an error later. */
function withoutDenied(models: string[]): { models: string[]; denied: number } {
  const kept = models.filter((m) => !MODEL_DENY.includes(m));
  return { models: kept, denied: models.length - kept.length };
}

/**
 * `GET {endpoint}/models`, for the wizard's picker.
 *
 * Picking from the served list rather than typing an id is itself a guardrail:
 * the commonest local misconfiguration is a model name that is nearly right, and
 * a `<select>` cannot be nearly right.
 */
export async function listEndpointModels(
  endpoint: string,
  endpointKey?: string
): Promise<{ models: string[]; denied: number } | { error: string }> {
  const parsed = parseEndpoint(endpoint);
  if ('error' in parsed) return parsed;
  // The model id is irrelevant to `/models` and the deny check must not fire on
  // a placeholder, so this client is built for one read-only call.
  const client = createOpenAiClient('__list__', {
    endpoint: parsed.url,
    apiKey: endpointKey?.trim() || undefined,
  });
  const models = await client.listModels(15_000);
  if (models === null) {
    return {
      error:
        `Nothing answered at ${parsed.url}/models. Check the server is running, that ` +
        `the address includes the version segment (…/v1), and that this machine can ` +
        `reach it. If the endpoint needs a key, open “this endpoint needs a key” and ` +
        `add one.`,
    };
  }
  if (models.length === 0) {
    return {
      error:
        `${parsed.url} answered, but says it serves no models at all. Load a model on ` +
        `that server and try again.`,
    };
  }
  return withoutDenied(models);
}

// -----------------------------------------------------------------------------
// The forced-tool-use gate
// -----------------------------------------------------------------------------

/**
 * A miniature of codegrind's own generation schema.
 *
 * Deliberately NOT a trivial one-string tool. Two constructs decide whether a
 * model can actually run this app, and both are here:
 *
 *   * `tests` — an ARRAY OF OBJECTS with `required` fields. Weaker models emit
 *     an array of strings, or omit `expected` on the second element.
 *   * `expected` — LOOSELY TYPED ON PURPOSE (no `type`), because the real
 *     schema's `expected` is too: a problem's answer may be a number, a string,
 *     an array. That is the field observed wobbling live, where a model
 *     "helpfully" wrapped the value as `{type, value}`. The same wobble on
 *     `args` is silently fatal — bank.service keeps `args` verbatim and only
 *     replaces `expected` — so it is worth finding out here, in two seconds,
 *     rather than in a bank full of nonsense.
 */
const PROBE_TOOL: ToolSpec = {
  name: 'emit_problem',
  description:
    'Emit one tiny coding problem and its sample tests. You MUST call this tool exactly once and reply with nothing else.',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'A short title for the problem.' },
      difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
      tests: {
        type: 'array',
        description: 'Exactly two sample tests.',
        items: {
          type: 'object',
          properties: {
            args: {
              type: 'array',
              description: 'Positional arguments, as bare JSON values.',
            },
            expected: {
              description:
                'The value the function returns for those arguments, as a bare JSON value of whatever type that is. Not wrapped in an object.',
            },
          },
          required: ['args', 'expected'],
        },
      },
    },
    required: ['title', 'difficulty', 'tests'],
  },
};

const PROBE_SYSTEM =
  'You write small programming practice problems. You always answer by calling the tool you are given, never in prose.';

const PROBE_USER =
  'Write the simplest possible problem: a function that adds two integers. Give it a title, a difficulty, and exactly two sample tests.';

/** The measured rate, turned into a sentence about the user's evening. */
function estimateProblemSeconds(latencyMs: number, outputTokens: number): number {
  const seconds = latencyMs / 1000;
  if (outputTokens > 0 && seconds > 0) {
    const tokensPerSecond = outputTokens / seconds;
    return Math.max(1, Math.round(TYPICAL_PROBLEM_OUTPUT_TOKENS / tokensPerSecond));
  }
  // No usage reported (some servers omit it). The probe is roughly a third of a
  // real generation, so scale rather than pretend the number is unknowable.
  return Math.max(1, Math.round(seconds * 3));
}

export interface ProviderCheckOk {
  ok: true;
  check: LlmProviderCheck;
}
export interface ProviderCheckFailed {
  ok: false;
  error: string;
}
export type ProviderCheckResult = ProviderCheckOk | ProviderCheckFailed;

/**
 * Prove an endpoint + model can run codegrind, or say why it cannot.
 *
 * Never throws. Every failure comes back as a message written to be read by
 * somebody who has just pasted a URL — what failed, and what to do about it —
 * in the same voice as the existing key errors.
 */
export async function validateOpenAiProvider(input: {
  endpoint: string;
  model: string;
  endpointKey?: string;
}): Promise<ProviderCheckResult> {
  const parsed = parseEndpoint(input.endpoint);
  if ('error' in parsed) return { ok: false, error: parsed.error };
  const endpoint = parsed.url;
  const model = (input.model ?? '').trim();
  const endpointKey = input.endpointKey?.trim() || undefined;

  if (!model) {
    return {
      ok: false,
      error: 'Pick a model from the list before continuing — there is no safe default.',
    };
  }
  if (MODEL_DENY.includes(model)) {
    // Belt and braces: the picker already filters these out, and a hand-crafted
    // request must not be able to get past the incident this list exists for.
    return {
      ok: false,
      error:
        `This deploy refuses to send work to "${model}" (CODEGRIND_MODEL_DENY). ` +
        `That list keeps load off a model whose router maps it somewhere it must ` +
        `not run. Pick a different model.`,
    };
  }

  // ---- step 1: is it there, and does it really serve this model? ------------
  const listed = await listEndpointModels(endpoint, endpointKey);
  if ('error' in listed) return { ok: false, error: listed.error };
  if (!listed.models.includes(model)) {
    const offered = listed.models.slice(0, 8).join(', ');
    return {
      ok: false,
      error:
        `${endpoint} does not serve a model called "${model}". It offers: ${offered}` +
        `${listed.models.length > 8 ? ', …' : ''}. Pick one of those.`,
    };
  }

  // ---- step 2: can it be MADE to call a tool? -------------------------------
  const client = createOpenAiClient(model, { endpoint, apiKey: endpointKey, deny: MODEL_DENY });
  let result;
  try {
    result = await client.structured({
      role: 'small',
      system: PROBE_SYSTEM,
      messages: [{ role: 'user', content: PROBE_USER }],
      tool: PROBE_TOOL,
      maxTokens: PROBE_MAX_TOKENS,
      thinking: 'off',
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  } catch (err) {
    return { ok: false, error: explainProbeFailure(err, model, endpoint) };
  }

  // ---- step 3: is the answer actually the shape it was asked for? -----------
  const shape = checkProbeShape(result.input);
  if (shape) {
    return {
      ok: false,
      error:
        `${model} called the tool, but ${shape} codegrind's real generation schema is ` +
        `stricter than this one, so problems would come back unusable. Choose a ` +
        `different model.`,
    };
  }

  const { latencyMs, usage, servedModel } = result.meta;
  const seconds = estimateProblemSeconds(latencyMs, usage.outputTokens);
  // Two things worth saying and neither is a gate: how long problems will take,
  // and whether a router quietly answered as something else.
  const notes: string[] = [];
  if (seconds >= SLOW_PROBLEM_SECONDS) {
    notes.push(
      `Problems will take about ${seconds} seconds each to write on this endpoint. ` +
        `Stock the bank in the next step so you are not waiting mid-session.`
    );
  }
  if (servedModel && servedModel !== model) {
    notes.push(
      `The endpoint served "${servedModel}" rather than "${model}" — a router in front ` +
        `of it is substituting.`
    );
  }
  const warning = notes.length > 0 ? notes.join(' ') : null;

  return {
    ok: true,
    check: { servedModel: servedModel || model, latencyMs, estimatedProblemSeconds: seconds, warning },
  };
}

/**
 * Why the forced tool call did not happen, in words that name a fix.
 *
 * The `--jinja` advice is the single highest-value line in this file: llama.cpp
 * serves tool calls only when started with it, and without it a perfectly
 * capable model returns prose forever. That is the commonest way a good local
 * setup looks like a bad model.
 */
function explainProbeFailure(err: unknown, model: string, endpoint: string): string {
  if (err instanceof LlmToolCallError) {
    if (err.meta.stop === 'max_tokens') {
      return (
        `${model} ran out of output tokens before it produced a tool call. That usually ` +
        `means it is "thinking" out loud instead of answering — a reasoning model with ` +
        `thinking left on cannot make the forced tool calls codegrind needs. Try a ` +
        `non-reasoning model, or one whose template honours enable_thinking:false.`
      );
    }
    return (
      `${model} returned prose instead of calling the tool codegrind asked for. Ten of ` +
      `the eleven calls this app makes are forced tool calls, so it cannot run on a ` +
      `model that ignores them — check llama.cpp is running with \`--jinja\` (tool ` +
      `calling is off without it), or choose a different model. ` +
      `Details: ${err.message}`
    );
  }
  if (err instanceof LlmTimeoutError) {
    return (
      `${model} did not answer within ${Math.round(err.timeoutMs / 1000)} seconds. If the ` +
      `server was loading the model, try again — the second attempt is usually much ` +
      `faster. If it keeps timing out, this model is too slow to run codegrind ` +
      `interactively.`
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return `${endpoint} could not complete a test call to ${model}. ${message}`;
}

/**
 * The half of the schema a weak model gets wrong. Returns a clause, or null.
 *
 * Only the structural properties are checked, never the content: this probe is
 * about capability, and refusing a model because it wrote a boring title would
 * be a grade, which is exactly what this stage deliberately does not build.
 */
function checkProbeShape(input: Record<string, unknown>): string | null {
  if (typeof input.title !== 'string' || !input.title.trim()) {
    return 'left out the required "title" field.';
  }
  if (typeof input.difficulty !== 'string') {
    return 'left out the required "difficulty" field.';
  }
  if (!Array.isArray(input.tests) || input.tests.length === 0) {
    return 'sent no "tests" array — it is required, and every generated problem is one.';
  }
  for (const test of input.tests as unknown[]) {
    if (!test || typeof test !== 'object' || Array.isArray(test)) {
      return 'filled "tests" with something other than objects, so its required fields cannot be there.';
    }
    const t = test as Record<string, unknown>;
    if (!Array.isArray(t.args)) {
      return 'left "args" off a test, or sent something that is not an array — that field decides what the reference solution is run with.';
    }
    if (!('expected' in t)) {
      return 'left "expected" off a test, which is the field a problem is graded against.';
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Writing it down
// -----------------------------------------------------------------------------

/**
 * Store a validated configuration for BOTH roles, and make it live.
 *
 * Both roles together, because the tutor defaults to matching the workhorse and
 * writing only one of them would leave a local install with a Claude tutor —
 * a bill for someone who configured a local model precisely so there would not
 * be one. Opting the tutor onto Claude stays available through
 * CODEGRIND_CHAT_PROVIDER, where it is deliberate.
 *
 * `reloadRouting()` is what makes the change take effect without a restart, and
 * it is the only place the running server's routing may change.
 */
export function storeProviderConfig(cfg: StoredRoleConfig): LlmStatus {
  const row: StoredRoleConfig = { provider: cfg.provider };
  if (cfg.model) row.model = cfg.model;
  if (cfg.endpoint) row.endpoint = cfg.endpoint;
  if (cfg.endpointKey) row.endpointKey = cfg.endpointKey;
  setSetting(WORKHORSE_SETTING, row);
  setSetting(TUTOR_SETTING, row);
  hydrateProviderConfig();
  reloadRouting();
  return describeProviders();
}
