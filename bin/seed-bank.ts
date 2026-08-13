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
// WHY IT IS IDEMPOTENT NOW. It was not before: every run generated the whole
// SEED list again, at full cost, whether or not the bank already held those
// problems. bin/warm-lessons has had the skip-if-exists guard since it was
// written; this is the same guard, against `servableBankSize` — which counts
// exactly the rows `findUnusedProblem` would hand out, so the two cannot
// disagree about whether a slot is stocked.

import { DIFFICULTIES, TOPICS, type Topic, type Difficulty } from '../src/shared/types.js';
import { LANGUAGES, isLanguage, type Language } from '../src/shared/languages.js';
import { ROOT_TOPICS } from '../src/server/services/curriculum.js';
import { generateAndStore } from '../src/server/services/bank.service.js';
import {
  bankSize,
  servableBankSize,
  getBankTitles,
  getActiveLanguage,
} from '../src/server/services/db.js';

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
    topics: topics.length ? topics : [...ROOT_TOPICS],
    difficulties: difficulties.length ? difficulties : ['easy'],
    perSlot,
    dryRun,
  };
}

const tally = {
  generated: 0,
  skipped: 0,
  apiCalls: 0,
  failures: [] as string[],
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { language } = args;

  const slots = args.topics.length * args.difficulties.length;
  console.log(
    `Seeding ${language}: ${args.topics.length} topic(s) × ${args.difficulties.length} ` +
      `difficulty(ies) = ${slots} slot(s), up to ${args.perSlot} problem(s) each` +
      (args.dryRun ? ' — DRY RUN, no API calls, no writes' : '')
  );
  console.log(`Bank currently holds ${bankSize(language)} ${language} problem(s).\n`);

  if (!args.dryRun && !process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set — provision it via bin/inject.');
    process.exit(1);
  }

  for (const topic of args.topics) {
    for (const difficulty of args.difficulties) {
      const have = servableBankSize(language, topic, difficulty);
      const need = Math.max(0, args.perSlot - have);
      const label = `${difficulty}/${topic}`;

      if (need === 0) {
        console.log(`  ${label}: ${have} ready, skipping`);
        tally.skipped += have;
        continue;
      }
      if (args.dryRun) {
        console.log(`  ${label}: ${have} ready — WOULD GENERATE ${need}`);
        continue;
      }

      for (let i = 0; i < need; i++) {
        process.stdout.write(`  ${label}: generating ${i + 1}/${need} ... `);
        try {
          // Show the generator what this topic already holds. Without it,
          // seeding two problems into one slot reliably produces the SAME
          // problem twice — the first python seed run emitted "Happy Number"
          // and "First Unique Character" as both of their slots' pairs, because
          // each call was made in total ignorance of the other. getAdaptiveProblem
          // has always passed these; only the direct seed path did not.
          const avoidTitles = getBankTitles(language, topic);
          // One Claude call per problem, plus two sandbox runs (sample +
          // hidden) to canonicalize its tests against the reference. For a
          // non-JavaScript language this THROWS rather than storing an
          // unverified problem, which is exactly what we want while seeding:
          // a broken sandbox must stop the spend, not fill the bank with
          // problems nobody can ever solve.
          tally.apiCalls++;
          const p = await generateAndStore(
            language,
            topic,
            difficulty,
            avoidTitles.length ? { avoidTitles } : undefined
          );
          tally.generated++;
          console.log(
            `ok — "${p.title}" (${p.sampleTests.length} sample, ${p.hiddenTests.length} hidden)`
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.log(`FAILED: ${message}`);
          tally.failures.push(`${label}: ${message}`);
        }
      }
    }
  }

  console.log('\n' + '-'.repeat(60));
  if (args.dryRun) {
    console.log('DRY RUN — nothing was generated or written.');
  } else {
    console.log(
      [
        `generated: ${tally.generated}`,
        `skipped:   ${tally.skipped} (already banked)`,
        // The number that costs money. `apiCalls` counts generateAndStore
        // ENTRIES, and one entry can retry generation up to MAX_GEN_ATTEMPTS
        // times when a reference errors on its own tests — so this is a floor,
        // not an exact bill.
        `generation attempts (min): ${tally.apiCalls}`,
        `bank now holds ${bankSize(language)} ${language} problem(s).`,
      ].join('\n')
    );
  }

  if (tally.failures.length) {
    console.log(`\n${tally.failures.length} failure(s) — re-run to retry just these:`);
    for (const f of tally.failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
