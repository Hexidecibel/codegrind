// One honest generation attempt, scored by stage. Run via bin/dry-run-generate.
//
//   bin/dry-run-generate                                  # active language, arrays/easy
//   bin/dry-run-generate --language go --topic trees --difficulty medium
//   bin/dry-run-generate --keep                           # store it in the bank
//   bin/dry-run-generate --repeat 5                       # a single-shot RATE
//
// WHY THIS EXISTS AND bin/seed-bank DOES NOT ANSWER IT. seed-bank retries three
// times per slot, which is right when a bank has to end up stocked and wrong
// when the question is "how good is this model". The number that predicts what
// using an endpoint actually feels like is the SINGLE-SHOT rate, and a retry
// loop is designed to hide it. This makes exactly one attempt.
//
// --repeat MEASURES A SEQUENCE, NOT N FIRST QUESTIONS. The app never asks a
// model to write a problem in a vacuum: it names the titles already in the slot
// and quotes the statements it has recently served. This used to skip both, and
// the result was a measurement that libelled the model — eight local-model runs
// of easy/arrays came back as "find the maximum" under six different titles,
// while the same model asked the way the app asks produced eight different
// problems. So the same steer is built here (bank.noveltyOpts, shared with the
// real path), and because a dry run stores nothing, this loop carries its own
// history forward across attempts.
//
// It also reports WHICH STAGE failed, because "it didn't work" conflates three
// unrelated things: the model produced no usable tool call (`generation`), it
// produced one whose own reference errors on its own inputs (`too-few-tests`),
// or the SANDBOX could not run at all (`sandbox`). Only the first two are
// evidence about the model. A missing runner image is never scored against it.
//
// COSTS: one generation call per attempt, plus two sandbox runs when it gets far
// enough to canonicalize. Nothing is written to the database unless --keep.

import { TOPICS, DIFFICULTIES, type Topic, type Difficulty } from '../src/shared/types.js';
import { LANGUAGES, isLanguage, type Language } from '../src/shared/languages.js';
import {
  dryRunGenerate,
  type DryRunResult,
  type RecentDigest,
} from '../src/server/services/bank.service.js';
import { getActiveLanguage } from '../src/server/services/db.js';
import { hydrate, isConfigured } from '../src/server/services/apikey.service.js';
import { hydrateProviderConfig } from '../src/server/services/provider.service.js';
import { describeRouting, needsAnthropicKey } from '../src/server/services/llm.client.js';

interface Args {
  language: Language;
  topic: Topic;
  difficulty: Difficulty;
  keep: boolean;
  repeat: number;
}

function usage(): never {
  console.log(
    [
      'usage: bin/dry-run-generate [options]',
      '',
      '  --language L     one of: ' + LANGUAGES.join(', ') + '  (default: the active language)',
      '  --topic T        one of: ' + TOPICS.join(', ') + '  (default: arrays)',
      '  --difficulty D   one of: ' + DIFFICULTIES.join(', ') + '  (default: easy)',
      '  --keep           store the problem in the bank when it succeeds',
      '  --repeat N       run N attempts as a SEQUENCE (each told what the last ones',
      '                   produced, as the app does) and report the single-shot rate',
      '',
      'Spends one generation call per attempt.',
    ].join('\n')
  );
  process.exit(0);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    language: getActiveLanguage(),
    topic: 'arrays',
    difficulty: 'easy',
    keep: false,
    repeat: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--help':
      case '-h':
        usage();
        break;
      case '--language':
        if (!value || !isLanguage(value)) fail(`--language must be one of: ${LANGUAGES.join(', ')}`);
        args.language = value as Language;
        i++;
        break;
      case '--topic':
        if (!value || !(TOPICS as readonly string[]).includes(value)) {
          fail(`--topic must be one of: ${TOPICS.join(', ')}`);
        }
        args.topic = value as Topic;
        i++;
        break;
      case '--difficulty':
        if (!value || !(DIFFICULTIES as readonly string[]).includes(value)) {
          fail(`--difficulty must be one of: ${DIFFICULTIES.join(', ')}`);
        }
        args.difficulty = value as Difficulty;
        i++;
        break;
      case '--keep':
        args.keep = true;
        break;
      case '--repeat': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 20) fail('--repeat must be an integer 1-20');
        args.repeat = n;
        i++;
        break;
      }
      default:
        fail(`unknown flag: ${flag}`);
    }
  }
  return args;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function report(result: DryRunResult, index: number, total: number): void {
  const label = total > 1 ? `attempt ${index}/${total}` : 'attempt';
  const secs = (result.ms / 1000).toFixed(1);
  if (result.ok) {
    console.log(`  ok   ${label} — "${result.problem.title}" in ${secs}s`);
    console.log(
      `       ${result.sampleTests} sample / ${result.hiddenTests} hidden tests survived canonicalization`
    );
    console.log(`       stored: ${result.storedId ?? 'no (dry run)'}`);
    // The silent-corruption vector: `args` is kept VERBATIM from the model and
    // only `expected` is replaced by the sandbox's output, so an over-structured
    // arg (a {type,value} wrapper instead of a bare value) produces a
    // self-consistent, solvable, canonicalized NONSENSE problem that nothing in
    // the app can detect. Show them.
    const sample = result.problem.sampleTests[0];
    if (sample) console.log(`       args[0]: ${JSON.stringify(sample.args)}`);
  } else {
    console.log(`  FAIL ${label} — ${result.failure} in ${secs}s`);
    if (result.title) console.log(`       generated: "${result.title}"`);
    console.log(`       ${result.error}`);
    if (result.failure === 'sandbox') {
      console.log('       ^ this is INFRASTRUCTURE, not the model. Try bin/build-runner-image.');
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // The provider rows the wizard writes, and the key. Both are settings-table
  // reads that the environment still overrides field by field.
  hydrateProviderConfig();
  hydrate();
  // The key is only demanded when a role actually routes to Anthropic. A fully
  // local install has no key and wants none — telling it to go and get one
  // would be the first thing the friend this stage exists for ever saw.
  if (needsAnthropicKey() && !isConfigured()) {
    console.error(
      'No Anthropic API key is configured. Set ANTHROPIC_API_KEY, or start the app\n' +
        'and paste one into the setup screen.'
    );
    process.exit(1);
  }

  console.log('codegrind :: dry-run-generate');
  console.log(`  ${describeRouting()}`);
  console.log(`  ${args.language} · ${args.difficulty}/${args.topic}`);
  console.log(`  ${args.repeat} attempt(s), keep=${args.keep}\n`);

  const results: DryRunResult[] = [];
  // What this run has already produced, newest first.
  //
  // WITHOUT THIS, --repeat MEASURES THE WRONG THING. A dry run stores nothing,
  // so the "what have I already served for this topic" digest that the real
  // path reads back out of the database is empty on every attempt — and N
  // attempts are N independent first questions rather than the sequence a
  // player would actually be served. Measured on a local model, that difference
  // was eight variations of "find the maximum" versus eight different problems.
  // Keeping the accumulation HERE, in the caller that owns --repeat, is what
  // lets dryRunGenerate stay one honest attempt.
  const seen: RecentDigest[] = [];
  for (let i = 1; i <= args.repeat; i++) {
    const result = await dryRunGenerate(args.language, args.topic, args.difficulty, {
      keep: args.keep,
      recent: seen,
    });
    results.push(result);
    if (result.ok) {
      seen.unshift({ title: result.problem.title, prompt: result.problem.prompt });
    }
    report(result, i, args.repeat);
  }

  const accepted = results.filter((r) => r.ok).length;
  const sandbox = results.filter((r) => !r.ok && r.failure === 'sandbox').length;
  console.log('');
  if (sandbox === results.length) {
    // Every attempt died before the model was ever judged.
    console.log('INCOMPLETE — the sandbox never ran. Nothing was learned about the model.');
    process.exit(2);
  }
  const judged = results.length - sandbox;
  console.log(`single-shot: ${accepted}/${judged} accepted` + (sandbox ? ` (${sandbox} skipped: sandbox)` : ''));
  if (accepted > 0) {
    console.log(`calls per accepted problem: ${(judged / accepted).toFixed(2)}`);
  }
  process.exit(accepted > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
