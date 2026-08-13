// Translate the shared study corpus's SNIPPETS into another language.
//
// The corpus is written once, in CORPUS_LANGUAGE, because its prose is
// language-free by construction — so only the code inside it forks. This script
// is the eager, operator-driven half of that fork; `warmAhead` does the same
// work lazily, one topic ahead of the reader, through the same service call.
//
// One BATCHED API call per topic (~9 snippets: the primer skeleton plus the
// topic's lesson bodies). Idempotent: a topic already translated costs nothing,
// and a topic that grew a lesson since costs exactly one call to catch up.
//
// Run via bin/translate-corpus (tsx). Costs tokens.
import { TOPICS, type Topic } from '../src/shared/types.js';
import { LANGUAGES, isLanguage, type Language } from '../src/shared/languages.js';
import { getCorpusSnippets, getTranslatedSourceIds, getActiveLanguage } from '../src/server/services/db.js';
import { CORPUS_LANGUAGE } from '../src/server/services/llm.language.js';
import { ensureTranslations } from '../src/server/services/study.service.js';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
interface Args {
  dryRun: boolean;
  topics: Topic[];
  language: Language;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let language: Language | null = null;
  let limit = Infinity;
  const topics: Topic[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') {
      dryRun = true;
    } else if (a === '--topic' || a === '-t') {
      const v = argv[++i];
      if (!v || !(TOPICS as readonly string[]).includes(v)) {
        console.error(`--topic must be one of: ${TOPICS.join(', ')}`);
        process.exit(2);
      }
      topics.push(v as Topic);
    } else if (a === '--language' || a === '-L') {
      const v = argv[++i];
      if (!v || !isLanguage(v)) {
        console.error(`--language must be one of: ${LANGUAGES.join(', ')}`);
        process.exit(2);
      }
      language = v;
    } else if (a === '--limit') {
      const v = parseInt(argv[++i] ?? '', 10);
      if (!Number.isFinite(v) || v < 1) {
        console.error('--limit must be a positive integer');
        process.exit(2);
      }
      limit = v;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'Usage: bin/translate-corpus [--language L] [--topic T]... [--limit N] [--dry-run]',
          '',
          '  --language, -L L   Target language. Default: the ACTIVE language setting.',
          '  --topic,    -t T   Restrict to one topic (repeatable). Default: all 18.',
          '  --limit       N    Stop after N topics actually needed work. Default: no limit.',
          '  --dry-run,  -n     Report what would be translated; make no API calls.',
          '',
          'ONE batched API call per topic that needs work. Idempotent: an already-',
          'translated topic is skipped, and a topic that grew a lesson costs one call.',
          '',
          'Translating INTO the corpus language is a no-op — the stored snippet is',
          'already the original, and reading it back is the fallback every other',
          'language degrades to.',
        ].join('\n')
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a} (try --help)`);
      process.exit(2);
    }
  }

  return {
    dryRun,
    topics: topics.length ? topics : [...TOPICS],
    language: language ?? getActiveLanguage(),
    limit,
  };
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.language === CORPUS_LANGUAGE) {
    console.log(
      `${args.language} IS the corpus language — every stored snippet is already ` +
        `the original. Nothing to translate.`
    );
    return;
  }
  if (!args.dryRun && !process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set — provision it via bin/inject.');
    process.exit(1);
  }

  console.log(
    `Translating the study corpus ${CORPUS_LANGUAGE} -> ${args.language} ` +
      `across ${args.topics.length} topic(s)` +
      (args.limit === Infinity ? '' : `, stopping after ${args.limit} that need work`) +
      (args.dryRun ? ' — DRY RUN, no API calls, no writes' : '')
  );

  const have = getTranslatedSourceIds(args.language);
  let calls = 0;
  let worked = 0;
  const failures: string[] = [];

  for (const topic of args.topics) {
    if (worked >= args.limit) {
      console.log(`\n(--limit ${args.limit} reached; ${args.topics.length - worked} topic(s) left)`);
      break;
    }

    const snippets = getCorpusSnippets(topic);
    const missing = snippets.filter((s) => !have.has(s.sourceId));

    if (!snippets.length) {
      console.log(`  ${topic.padEnd(20)} nothing written yet — skipped`);
      continue;
    }
    if (!missing.length) {
      console.log(`  ${topic.padEnd(20)} ${snippets.length} snippet(s), all translated — skipped`);
      continue;
    }

    worked++;
    if (args.dryRun) {
      console.log(
        `  ${topic.padEnd(20)} WOULD TRANSLATE ${missing.length} of ${snippets.length} snippet(s) in 1 call`
      );
      continue;
    }

    process.stdout.write(
      `  ${topic.padEnd(20)} ${missing.length} of ${snippets.length} snippet(s), 1 call ... `
    );
    try {
      // Straight through the service, so this script and the lazy warm path
      // cannot drift: same batching, same dedupe, same failure cooldown.
      await ensureTranslations(args.language, topic);
      calls++;
      const now = getTranslatedSourceIds(args.language);
      const written = missing.filter((s) => now.has(s.sourceId)).length;
      for (const s of missing) if (now.has(s.sourceId)) have.add(s.sourceId);
      if (!written) throw new Error('nothing came back');
      console.log(`ok — ${written} stored${written < missing.length ? ' (partial)' : ''}`);
    } catch (err) {
      console.log(`FAILED: ${err instanceof Error ? err.message : err}`);
      failures.push(topic);
    }
  }

  console.log('\n' + '-'.repeat(60));
  if (args.dryRun) {
    console.log(`DRY RUN — ${worked} topic(s) would be translated, one API call each.`);
  } else {
    console.log(`topics translated: ${worked - failures.length}`);
    console.log(`API calls:         ${calls}`);
  }
  if (failures.length) {
    console.log(`\n${failures.length} failure(s) — re-run to retry just these:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
