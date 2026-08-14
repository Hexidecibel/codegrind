// Seed a starter problem bank so day one isn't a chain of cold 15-30s generates.
// Run via bin/seed-bank (tsx). Exercises the REAL Claude generate path, so it
// costs tokens — but it is IDEMPOTENT and RESUMABLE: a slot that is already
// stocked is skipped and never regenerated.
//
//   bin/seed-bank                                  # active language, root topics, easy
//   bin/seed-bank --language python                # seed a specific language
//   bin/seed-bank --language python --topic arrays # one topic (repeatable)
//   bin/seed-bank --difficulty medium              # one difficulty (repeatable)
//   bin/seed-bank --per-slot 3                     # depth per topic+difficulty slot
//   bin/seed-bank --dry-run                        # report the plan, spend nothing
//
// WHY ROOT TOPICS AT EASY. A new language's bank starts completely empty — that
// is the honest cost of the hard language filter, and the plan is explicit that
// it gets mitigated by seeding rather than by falling back to another language's
// problems. The scheduler's cold-start path serves root topics at easy first, so
// those are the only slots that can be hit before the player has done anything,
// and they are the only ones worth pre-paying for.
//
// WHERE THE LOOP LIVES NOW. The seeding itself is `runSeed` in
// src/server/services/seed.service.ts, and this file is a printer for the events
// it yields. The first-run wizard drives the SAME generator over HTTP, so the
// browser and the CLI cannot disagree about whether a slot is stocked — which
// they would, expensively, the first time either copy was changed.

import { DIFFICULTIES, TOPICS, type Topic, type Difficulty } from '../src/shared/types.js';
import { LANGUAGES, isLanguage, type Language } from '../src/shared/languages.js';
import {
  runSeed,
  DEFAULT_SEED_TOPICS,
  DEFAULT_SEED_DIFFICULTIES,
} from '../src/server/services/seed.service.js';
import { getActiveLanguage } from '../src/server/services/db.js';
import { hydrate, isConfigured } from '../src/server/services/apikey.service.js';

interface Args {
  language: Language;
  topics: Topic[];
  difficulties: Difficulty[];
  perSlot: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  // Seeding the ACTIVE language is the only default that cannot leave you
  // looking at a bank that exists but is invisible to the app.
  let language: Language | null = null;
  let perSlot = 2;
  let dryRun = false;
  const topics: Topic[] = [];
  const difficulties: Difficulty[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--language' || a === '-L') {
      const v = argv[++i];
      if (!isLanguage(v)) {
        console.error(`--language must be one of: ${LANGUAGES.join(', ')}`);
        process.exit(2);
      }
      language = v;
    } else if (a === '--topic' || a === '-t') {
      const v = argv[++i];
      if (!v || !(TOPICS as readonly string[]).includes(v)) {
        console.error(`--topic must be one of: ${TOPICS.join(', ')}`);
        process.exit(2);
      }
      topics.push(v as Topic);
    } else if (a === '--difficulty' || a === '-d') {
      const v = argv[++i];
      if (!v || !(DIFFICULTIES as readonly string[]).includes(v)) {
        console.error(`--difficulty must be one of: ${DIFFICULTIES.join(', ')}`);
        process.exit(2);
      }
      difficulties.push(v as Difficulty);
    } else if (a === '--per-slot' || a === '-n') {
      const v = parseInt(argv[++i] ?? '', 10);
      if (!Number.isFinite(v) || v < 0) {
        console.error('--per-slot must be a non-negative integer');
        process.exit(2);
      }
      perSlot = v;
    } else if (a === '--dry-run' || a === '-N') {
      dryRun = true;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'Usage: bin/seed-bank [--language L] [--topic T]... [--difficulty D]... [--per-slot N] [--dry-run]',
          '',
          '  --language,   -L L  Language to seed. Default: the active setting.',
          '  --topic,      -t T  Restrict to one topic (repeatable). Default: the 4 root topics.',
          '  --difficulty, -d D  Restrict to one difficulty (repeatable). Default: easy.',
          '  --per-slot,   -n N  Problems to hold ready per topic+difficulty. Default 2.',
          '  --dry-run,    -N    Report the plan; make no API calls and no writes.',
          '',
          'Idempotent: a slot already holding --per-slot unused problems is skipped.',
          'THIS SPENDS REAL MONEY — one Claude generation call per problem, plus a',
          'sandbox run of the reference solution to canonicalize its tests.',
        ].join('\n')
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a} (try --help)`);
      process.exit(2);
    }
  }

  return {
    language: language ?? getActiveLanguage(),
    topics: topics.length ? topics : [...DEFAULT_SEED_TOPICS],
    difficulties: difficulties.length ? difficulties : [...DEFAULT_SEED_DIFFICULTIES],
    perSlot,
    dryRun,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { language } = args;

  const slots = args.topics.length * args.difficulties.length;
  console.log(
    `Seeding ${language}: ${args.topics.length} topic(s) × ${args.difficulties.length} ` +
      `difficulty(ies) = ${slots} slot(s), up to ${args.perSlot} problem(s) each` +
      (args.dryRun ? ' — DRY RUN, no API calls, no writes' : '')
  );

  // A key stored by the first-run wizard lives in the settings table, not in
  // .env — `bin/inject` truncates .env on every deploy, so a pasted key there
  // would be destroyed. hydrate() publishes it into the environment for the
  // SDK, and does nothing at all when the environment already has one.
  hydrate();
  if (!args.dryRun && !isConfigured()) {
    console.error(
      'No Anthropic API key is configured. Set ANTHROPIC_API_KEY, or start the app\n' +
        '(bin/setup) and paste one into the setup screen.'
    );
    process.exit(1);
  }

  let failed = false;

  for await (const ev of runSeed(args)) {
    switch (ev.type) {
      case 'plan':
        console.log(`Bank currently holds ${ev.bankSize} ${ev.language} problem(s).\n`);
        for (const s of ev.slots) {
          const label = `${s.difficulty}/${s.topic}`;
          if (s.need === 0) console.log(`  ${label}: ${s.have} ready, skipping`);
          else if (ev.dryRun) console.log(`  ${label}: ${s.have} ready — WOULD GENERATE ${s.need}`);
        }
        break;
      case 'generating':
        process.stdout.write(
          `  ${ev.difficulty}/${ev.topic}: generating ${ev.done + 1}/${ev.total} ... `
        );
        break;
      case 'generated':
        console.log(`ok — "${ev.title}" (${ev.sampleTests} sample, ${ev.hiddenTests} hidden)`);
        break;
      case 'failed':
        console.log(`FAILED: ${ev.message}`);
        break;
      case 'done': {
        console.log('\n' + '-'.repeat(60));
        if (ev.dryRun) {
          console.log('DRY RUN — nothing was generated or written.');
        } else {
          console.log(
            [
              `generated: ${ev.generated}`,
              `skipped:   ${ev.skipped} (already banked)`,
              // The number that costs money. `attempts` counts generateAndStore
              // ENTRIES, and one entry can retry generation up to
              // MAX_GEN_ATTEMPTS times when a reference errors on its own tests
              // — so this is a floor, not an exact bill.
              `generation attempts (min): ${ev.attempts}`,
              `bank now holds ${ev.bankSize} ${ev.language} problem(s).`,
            ].join('\n')
          );
        }
        if (ev.failures.length) {
          console.log(`\n${ev.failures.length} failure(s) — re-run to retry just these:`);
          for (const f of ev.failures) console.log(`  - ${f}`);
          failed = true;
        }
        break;
      }
    }
  }

  if (failed) process.exit(1);
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
