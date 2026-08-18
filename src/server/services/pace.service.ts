// =============================================================================
// pace — how long generating one problem actually takes on THIS install
// =============================================================================
// The number exists so the UI can stop saying "Loading next…" for ninety seconds
// and say what is really happening instead. Two rules govern it:
//
//   1. IT IS MEASURED, NEVER GUESSED. "15-30 seconds" is true of Claude and a
//      lie about a local 35B model, where a single expert problem was timed at
//      95 seconds of output alone — and up to three times that when a reference
//      fails its own tests and generateAndStore retries. A hardcoded range would
//      be wrong for exactly the person who most needs the warning.
//   2. IT IS NEVER FABRICATED WHEN UNKNOWN. `read()` returns null on a fresh
//      install with nothing to go on, and every caller must render the honest
//      "this can take a while" rather than invent a number.
//
// Two sources feed it, in priority order:
//
//   - `measured` — real generateAndStore durations from this install. A first
//     run gets eight of these for free, because the setup wizard's seed step
//     generates eight problems through the same function.
//   - `probe` — `estimatedProblemSeconds` from the provider check the wizard
//     ran before seeding (provider.service.validateOpenAiProvider). It is the
//     same measurement SetupWizard already renders as "about N seconds"; storing
//     it here is what lets the rest of the app reuse it instead of re-deriving
//     a second, differently-wrong estimate.
//
// Stored in the settings kv rather than a table: it is one number, it is a hint,
// and losing it costs nothing but a vaguer sentence.

import { getSetting, setSetting } from './db.js';

const MEASURED_KEY = 'pace.generationMs';
const PROBE_KEY = 'pace.probeSeconds';

/**
 * How much weight one new sample carries.
 *
 * An EWMA rather than a mean of everything, because the number that matters is
 * "what will the NEXT one cost", and the endpoint changes: somebody who moves
 * from a local model to Claude must not be quoted a 95-second wait for the rest
 * of the install's life. At 0.35 a switch is mostly absorbed within three
 * generations and fully within about eight.
 */
const ALPHA = 0.35;

/** Samples outside this range are noise, not pace, and are dropped. */
const MIN_SAMPLE_MS = 500;
const MAX_SAMPLE_MS = 15 * 60_000;

/**
 * Fold one real generation duration into the running estimate.
 *
 * Called from bank.service.generateAndStore, i.e. from every path that pays for
 * a problem: the seed run, /api/problems/generate, /manual's New on an empty
 * slot, and every generating scheduler intent. Deliberately best-effort — a
 * failed write here must never fail the generation that just succeeded.
 */
export function recordGeneration(ms: number): void {
  if (!Number.isFinite(ms) || ms < MIN_SAMPLE_MS || ms > MAX_SAMPLE_MS) return;
  try {
    const prev = getSetting<unknown>(MEASURED_KEY);
    const previous = typeof prev === 'number' && Number.isFinite(prev) ? prev : null;
    const next = previous === null ? ms : previous * (1 - ALPHA) + ms * ALPHA;
    setSetting(MEASURED_KEY, Math.round(next));
  } catch (err) {
    console.warn('[pace] could not record a generation sample:', err instanceof Error ? err.message : err);
  }
}

/**
 * Remember what the provider check measured, so it survives the wizard.
 *
 * `LlmProviderCheck.estimatedProblemSeconds` is only ever returned in the
 * response to PUT /api/providers — it lives in one React component's state and
 * is gone on the next reload. This is the whole of "persist it": one number,
 * written where anything can read it.
 */
export function recordProbeEstimate(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  try {
    setSetting(PROBE_KEY, Math.round(seconds));
  } catch (err) {
    console.warn('[pace] could not record the probe estimate:', err instanceof Error ? err.message : err);
  }
}

export interface GenerationPace {
  seconds: number;
  source: 'measured' | 'probe';
}

/**
 * The best available answer to "how long will one problem take", or null.
 *
 * Null is a real answer and callers must render it as one. A fresh install that
 * dismissed the wizard has generated nothing and probed nothing, and there is
 * genuinely no honest number to show.
 */
export function readGenerationPace(): GenerationPace | null {
  const measured = getSetting<unknown>(MEASURED_KEY);
  if (typeof measured === 'number' && Number.isFinite(measured) && measured > 0) {
    return { seconds: Math.max(1, Math.round(measured / 1000)), source: 'measured' };
  }
  const probe = getSetting<unknown>(PROBE_KEY);
  if (typeof probe === 'number' && Number.isFinite(probe) && probe > 0) {
    return { seconds: Math.max(1, Math.round(probe)), source: 'probe' };
  }
  return null;
}
