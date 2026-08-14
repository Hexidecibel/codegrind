// =============================================================================
// Seeding a bank — ONE implementation, two front ends
// =============================================================================
// This is `bin/seed-bank`'s loop, lifted out of the CLI so the first-run wizard
// can drive the identical work and stream it to a browser. It was NOT copied:
// a second seeding loop would be a second answer to "is this slot already
// stocked", and the two would disagree the first time either changed — which
// costs real money, in duplicate problems nobody asked for.
//
// The shape is an async GENERATOR rather than a function with a callback,
// because both consumers want the same thing for different reasons. The CLI
// prints each event as a line. The HTTP route serializes each event as NDJSON
// and flushes it. Neither has to know how the other renders, and back-pressure
// on the HTTP side falls out for free.
//
// EVERY NUMBER IN THESE EVENTS IS REAL. `total` is computed by asking the
// database how many slots are short before anything is generated, and `done`
// only advances when a generation call has actually returned. There is no
// interpolation and no timer anywhere in this file — a progress bar built on
// these events moves when work completes and stalls when work stalls, which is
// the honest thing to show for an operation whose steps take 15-30 seconds
// each.
//
// IDEMPOTENT AND RESUMABLE, inherited from the CLI: a slot already holding
// `perSlot` servable problems is skipped and never regenerated, so a run that
// dies half way through only re-pays for what is still missing.

import type { Difficulty, Topic, SeedEvent, SeedSlot } from '../../shared/types.js';
import type { Language } from '../../shared/languages.js';
import { LANGUAGE_META } from '../../shared/languages.js';
import { ROOT_TOPICS } from './curriculum.js';
import { generateAndStore } from './bank.service.js';
import { bankSize, getBankTitles, servableBankSize } from './db.js';

export type { SeedEvent, SeedSlot };

export interface SeedOptions {
  language: Language;
  topics: Topic[];
  difficulties: Difficulty[];
  /** Problems to hold ready per topic+difficulty slot. */
  perSlot: number;
  /** Report the plan and generate nothing. */
  dryRun?: boolean;
}

/** The slots a bare `bin/seed-bank` fills: the cold-start ones, and only those. */
export const DEFAULT_SEED_TOPICS: readonly Topic[] = ROOT_TOPICS;
export const DEFAULT_SEED_DIFFICULTIES: readonly Difficulty[] = ['easy'];

/**
 * Turn a generation failure into something a newcomer can act on.
 *
 * The one failure a first-run user is actually likely to hit is a missing
 * runner image — `bin/setup` builds all three, but somebody who ran the app
 * some other way will see canonicalization throw, and the raw message describes
 * a sandbox they have never heard of. Everything else is passed through
 * untouched; inventing advice for errors we have not seen is worse than none.
 */
export function explainSeedFailure(language: Language, message: string): string {
  if (/no such image|Unable to find image|image .* not found|docker/i.test(message)) {
    return `${message} — the ${LANGUAGE_META[language].displayName} sandbox image is missing. Run \`bin/build-runner-image ${language}\` and try again.`;
  }
  return message;
}

/**
 * Seed a bank, yielding real progress as it goes.
 *
 * SPENDS REAL MONEY when `dryRun` is false: one Claude generation call per
 * problem (sometimes more — `generateAndStore` retries a reference that fails
 * its own tests), plus two sandbox runs to canonicalize the tests against it.
 */
export async function* runSeed(opts: SeedOptions): AsyncGenerator<SeedEvent> {
  const { language, topics, difficulties, perSlot, dryRun = false } = opts;

  // The whole plan is computed BEFORE any generating starts. That is what makes
  // `total` a denominator rather than a guess, and it is also the cheapest
  // possible dry run.
  const slots: SeedSlot[] = [];
  for (const topic of topics) {
    for (const difficulty of difficulties) {
      const have = servableBankSize(language, topic, difficulty);
      slots.push({ topic, difficulty, have, need: Math.max(0, perSlot - have) });
    }
  }
  const total = slots.reduce((n, s) => n + s.need, 0);
  const alreadyStocked = slots.reduce((n, s) => n + Math.min(s.have, perSlot), 0);

  yield {
    type: 'plan',
    language,
    slots,
    total,
    alreadyStocked,
    bankSize: bankSize(language),
    dryRun,
  };

  let generated = 0;
  let attempts = 0;
  let done = 0;
  const failures: string[] = [];

  if (!dryRun) {
    for (const slot of slots) {
      for (let i = 0; i < slot.need; i++) {
        yield {
          type: 'generating',
          done,
          total,
          topic: slot.topic,
          difficulty: slot.difficulty,
        };
        try {
          // Show the generator what this topic already holds. Without it,
          // seeding two problems into one slot reliably produces the SAME
          // problem twice — each call is otherwise made in total ignorance of
          // the other.
          const avoidTitles = getBankTitles(language, slot.topic);
          attempts++;
          const p = await generateAndStore(
            language,
            slot.topic,
            slot.difficulty,
            avoidTitles.length ? { avoidTitles } : undefined
          );
          generated++;
          done++;
          yield {
            type: 'generated',
            done,
            total,
            topic: slot.topic,
            difficulty: slot.difficulty,
            title: p.title,
            sampleTests: p.sampleTests.length,
            hiddenTests: p.hiddenTests.length,
          };
        } catch (err) {
          const raw = err instanceof Error ? err.message : String(err);
          const message = explainSeedFailure(language, raw);
          done++;
          failures.push(`${slot.difficulty}/${slot.topic}: ${message}`);
          // A failure is NOT fatal to the run. A partial bank is a usable bank —
          // the app generates on demand for anything it does not hold — and
          // stranding the user on the first bad completion would be the worst
          // possible reading of "seeding failed".
          yield {
            type: 'failed',
            done,
            total,
            topic: slot.topic,
            difficulty: slot.difficulty,
            message,
          };
        }
      }
    }
  }

  yield {
    type: 'done',
    language,
    generated,
    skipped: alreadyStocked,
    attempts,
    failures,
    bankSize: bankSize(language),
    dryRun,
  };
}
