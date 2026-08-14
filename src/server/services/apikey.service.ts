// =============================================================================
// The API key — where it comes from, and who is allowed to see it
// =============================================================================
// codegrind needs an Anthropic key to do anything interesting, and there are now
// two ways it can have one:
//
//   1. `ANTHROPIC_API_KEY` in the environment. This is how the author's own
//      instance runs — systemd hands it to the service, materialized from
//      Infisical by cush-tools' `bin/inject`.
//   2. A row in the `settings` table, written by the first-run wizard.
//
// **THE ENVIRONMENT ALWAYS WINS.** That ordering is not a preference, it is the
// compatibility guarantee: an existing deploy whose key arrives through the
// environment keeps behaving exactly as it did, and nothing the wizard writes
// can shadow it.
//
// WHY NOT `.env`. The obvious place to put a key the user pastes is `.env`, and
// it is the one place it must never go. `bin/inject` rewrites that file with
// O_TRUNC from `.cush-secrets` on every deploy AND on every `cd` into the
// directory (direnv), so a hand-added key there is destroyed silently and at an
// unpredictable moment — the app simply stops working with no edit to blame.
// The `settings` table is the store the plan always intended for this
// (`provider`, `model`, `apiKeyRef` as ROWS, never a migration), and nothing
// but this app writes it.
//
// HOW THE KEY REACHES THE SDK. `hydrate()` copies a stored key into
// `process.env.ANTHROPIC_API_KEY` at boot when — and only when — the
// environment does not already carry one. Every existing consumer
// (`llm.service.ts`, `bin/seed-bank`, `bin/warm-lessons`, `bin/translate-corpus`)
// therefore keeps reading exactly the variable it always read, with no plumbing
// and no second source of truth. `llm.service` re-creates its cached client when
// the value changes, so a key pasted into the wizard is live immediately without
// a restart.
//
// SECRECY RULES, all enforced here:
//   - `describe()` is the ONLY shape that crosses the HTTP boundary. It carries
//     a boolean, a source, and the last four characters. Never the key.
//   - Nothing in this file logs the key, at any level. `redact()` scrubs it out
//     of provider error messages before they are shown, because an SDK is free
//     to echo a request back at you and this module is the last place that can
//     stop it.

import Anthropic from '@anthropic-ai/sdk';
import { getSetting, setSetting } from './db.js';

/** The `settings` row the pasted key lives in. */
export const API_KEY_SETTING = 'apiKey';
/** The `settings` row naming the provider that key belongs to. */
export const PROVIDER_SETTING = 'provider';

/** The only provider codegrind speaks to today. */
export const PROVIDER = 'anthropic';

/**
 * Everything the client is allowed to know about the key.
 *
 * `source` is what makes the wizard honest: with `env` the key came from the
 * deploy and the wizard must not offer to replace it, because a stored key
 * would be written and then never used.
 */
export interface ApiKeyStatus {
  configured: boolean;
  source: 'env' | 'settings' | null;
  /** Last four characters — enough to recognise, useless to steal. */
  suffix: string | null;
}

/**
 * The exact value THIS MODULE put into `process.env.ANTHROPIC_API_KEY`, or null.
 *
 * Once a stored key has been published into the environment the two sources are
 * indistinguishable by inspection, and the app needs to tell them apart: the
 * wizard says "your deploy supplies this key" for one and "stored here" for the
 * other. A boolean `hydrated` flag is NOT enough — `hydrate()` is called again
 * on every seed request, and a second call would see a non-empty environment,
 * conclude the deploy must have set it, and quietly relabel a wizard-stored key
 * as environment-supplied. Comparing the VALUE cannot drift that way.
 */
let published: string | null = null;

function env(): string {
  return (process.env.ANTHROPIC_API_KEY ?? '').trim();
}

/** Is the live environment value one we published from the settings table? */
function envIsOurs(): boolean {
  return published !== null && env() === published;
}

function stored(): string | null {
  const value = getSetting<unknown>(API_KEY_SETTING);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Make a stored key usable, if and only if the environment has none.
 *
 * Called once at server boot and by every CLI entry point that can spend
 * money. Returns the resulting status so a caller can report it.
 */
export function hydrate(): ApiKeyStatus {
  if (env()) {
    // Something is already there. If it is not ours, it is the deploy's and it
    // wins outright — never overwritten, never relabelled.
    if (!envIsOurs()) published = null;
    return describe();
  }
  const key = stored();
  if (key) {
    process.env.ANTHROPIC_API_KEY = key;
    published = key;
  }
  return describe();
}

/** The safe-to-serialize view of the key. Never includes the key. */
export function describe(): ApiKeyStatus {
  const active = env();
  if (active) {
    return {
      configured: true,
      source: envIsOurs() ? 'settings' : 'env',
      suffix: active.slice(-4),
    };
  }
  // Stored but not yet hydrated — still configured, just not loaded.
  const key = stored();
  if (key) return { configured: true, source: 'settings', suffix: key.slice(-4) };
  return { configured: false, source: null, suffix: null };
}

/** True when some key is available, from either source. */
export function isConfigured(): boolean {
  return describe().configured;
}

/**
 * Persist a key and make it live.
 *
 * When the environment already supplies one the key is still STORED — the user
 * asked for it and it becomes the fallback if the deploy stops providing one —
 * but `process.env` is left alone, because the environment winning has to mean
 * the environment winning even here.
 */
export function store(key: string): ApiKeyStatus {
  const trimmed = key.trim();
  setSetting(API_KEY_SETTING, trimmed);
  setSetting(PROVIDER_SETTING, PROVIDER);
  if (!env()) {
    process.env.ANTHROPIC_API_KEY = trimmed;
    published = trimmed;
  }
  return describe();
}

/** Forget a stored key. The environment's, if any, is untouched by design. */
export function forget(): ApiKeyStatus {
  setSetting(API_KEY_SETTING, '');
  if (envIsOurs()) {
    delete process.env.ANTHROPIC_API_KEY;
  }
  published = null;
  return describe();
}

/**
 * Remove the key from a string that is about to be shown or logged.
 *
 * Belt and braces: the Anthropic SDK does not echo credentials in its error
 * messages today, and this module is the wrong place to bet on that staying
 * true forever.
 */
export function redact(message: string, key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return message;
  return message.split(trimmed).join('sk-ant-***');
}

/**
 * Cheap syntactic screen, run before spending a network round trip.
 *
 * Deliberately loose — Anthropic has changed key prefixes before and a
 * too-clever regex here would reject a valid key with a message the user
 * cannot argue with. It exists to catch the two things that actually happen:
 * an empty box, and a pasted URL or password.
 */
export function looksLikeAnthropicKey(key: string): boolean {
  return /^sk-ant-\S{16,}$/.test(key.trim());
}

/**
 * Prove a key works, by asking the provider.
 *
 * `models.list` is the right probe: it is authenticated, it consumes no tokens,
 * and it distinguishes "wrong key" (401) from "no internet" (a transport
 * error) — which are the two failures a newcomer hits and they need completely
 * different advice.
 *
 * Returns `null` when the key is good, or a message to show the user. It never
 * throws and never logs.
 */
export async function validate(key: string): Promise<string | null> {
  const trimmed = key.trim();
  if (!trimmed) return 'Paste your Anthropic API key to continue.';
  if (!looksLikeAnthropicKey(trimmed)) {
    return 'That does not look like an Anthropic API key — they start with "sk-ant-". Copy one from console.anthropic.com → API keys.';
  }

  try {
    // maxRetries 0: a wrong key is wrong on the first try, and a newcomer
    // staring at a spinner for three exponential backoffs learns nothing.
    const client = new Anthropic({ apiKey: trimmed, maxRetries: 0, timeout: 20_000 });
    await client.models.list({ limit: 1 });
    return null;
  } catch (err) {
    const status =
      err && typeof err === 'object' && 'status' in err
        ? (err as { status?: number }).status
        : undefined;
    const raw = err instanceof Error ? err.message : String(err);
    const safe = redact(raw, trimmed);

    if (status === 401 || status === 403) {
      return 'Anthropic rejected that key. Check you copied the whole thing, and that the key has not been revoked (console.anthropic.com → API keys).';
    }
    if (status === 429) {
      return 'That key is real but rate-limited right now. Wait a moment and try again.';
    }
    if (status === 400 && /credit|balance/i.test(safe)) {
      return 'That key is valid but the account has no credit. Add credit at console.anthropic.com → Billing.';
    }
    if (status === undefined) {
      return `Could not reach the Anthropic API — check this machine's internet connection. (${safe})`;
    }
    return `Anthropic could not verify that key (HTTP ${status}). ${safe}`;
  }
}
