// Pre-generate the Study reading tracks so the first bedtime session isn't a
// series of 15s waits. Run via bin/warm-lessons (tsx). Exercises the REAL Claude
// path, so it costs tokens — but it is IDEMPOTENT and RESUMABLE: anything already
// cached is skipped and never regenerated.
//
//   bin/warm-lessons                 # all 18 tracks, first 3 lessons each
//   bin/warm-lessons --dry-run       # report the plan, spend nothing
//   bin/warm-lessons --topic trees   # one track only
//   bin/warm-lessons --lessons 5     # deeper warm
import { TOPICS, type Topic } from '../src/shared/types.js';
import {
  getPrimer,
  insertPrimer,
  getTrackOutline,
  insertTrackOutline,
  getLesson,
  insertLesson,
} from '../src/server/services/db.js';
import {
  generatePrimer,
  generateTrackOutline,
  generateLessonBody,
} from '../src/server/services/llm.service.js';
import { primerToLesson } from '../src/server/services/study.service.js';
// This script WRITES the shared corpus, so every read below asks for the
// corpus language rather than the active one — an overlay read here would
// derive lesson 0 from a translated skeleton and store it as the original.
import { CORPUS_LANGUAGE } from '../src/server/services/llm.language.js';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
interface Args {
  dryRun: boolean;
  topics: Topic[];
  lessons: number;
}

function parseArgs(argv: string[]): Args {
  let dryRun = false;
  let lessons = 3;
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
    } else if (a === '--lessons' || a === '-l') {
      const v = parseInt(argv[++i] ?? '', 10);
      if (!Number.isFinite(v) || v < 0) {
        console.error('--lessons must be a non-negative integer');
        process.exit(2);
      }
      lessons = v;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'Usage: bin/warm-lessons [--dry-run] [--topic <t>]... [--lessons N]',
          '',
          '  --dry-run, -n      Report what would be generated; make no API calls.',
          '  --topic,   -t <t>  Restrict to one topic (repeatable). Default: all 18.',
          '  --lessons, -l N    Track lessons (seq 1..N) to write per topic. Default 3.',
          '',
          'Idempotent and resumable: cached primers, outlines and lessons are skipped.',
        ].join('\n')
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a} (try --help)`);
      process.exit(2);
    }
  }

  return { dryRun, topics: topics.length ? topics : [...TOPICS], lessons };
}

// ---------------------------------------------------------------------------
// Tally
// ---------------------------------------------------------------------------
const tally = {
  primersGenerated: 0,
  primersSkipped: 0,
  lesson0Derived: 0,
  lesson0Skipped: 0,
  outlinesGenerated: 0,
  outlinesSkipped: 0,
  bodiesGenerated: 0,
  bodiesSkipped: 0,
  apiCalls: 0,
  failures: [] as string[],
};

function plan(label: string, needed: boolean, dryRun: boolean): boolean {
  if (!needed) {
    console.log(`    ${label}: cached, skipping`);
    return false;
  }
  if (dryRun) {
    console.log(`    ${label}: WOULD GENERATE`);
    return false;
  }
  process.stdout.write(`    ${label}: generating ... `);
  return true;
}

// ---------------------------------------------------------------------------
// Per-topic warm — every step guarded so a re-run costs nothing for what exists.
// ---------------------------------------------------------------------------
async function warmTopic(topic: Topic, args: Args): Promise<void> {
  console.log(`\n[${topic}]`);

  // 1. Primer — lesson 0 is DERIVED from it, so it is the cheapest way to get
  //    a topic's first screenful. Reuses whatever the Library already cached.
  let primer = getPrimer(CORPUS_LANGUAGE, topic);
  const needPrimer = !primer;
  if (plan('primer', needPrimer, args.dryRun)) {
    try {
      primer = await generatePrimer(topic);
      insertPrimer(primer);
      tally.apiCalls++;
      tally.primersGenerated++;
      console.log('ok');
    } catch (err) {
      console.log(`FAILED: ${err instanceof Error ? err.message : err}`);
      tally.failures.push(`${topic} primer`);
      return; // everything downstream needs the primer for grounding
    }
  } else if (!needPrimer) {
    tally.primersSkipped++;
  }

  // 2. Lesson 0 — pure mapping of the primer. Free, no API call.
  const lesson0Id = `${topic}:0`;
  if (getLesson(CORPUS_LANGUAGE, lesson0Id)) {
    console.log('    lesson 0: cached, skipping');
    tally.lesson0Skipped++;
  } else if (args.dryRun) {
    console.log('    lesson 0: WOULD DERIVE from primer (free)');
  } else if (primer) {
    insertLesson(primerToLesson({ ...primer, pattern: topic }));
    tally.lesson0Derived++;
    console.log('    lesson 0: derived from primer (free)');
  }

  // 3. Outline — one cheap call that plans the whole track.
  let outline = getTrackOutline(topic);
  if (plan('outline', !outline, args.dryRun)) {
    try {
      outline = await generateTrackOutline(topic);
      if (!outline.length) throw new Error('empty outline');
      insertTrackOutline(topic, outline);
      tally.apiCalls++;
      tally.outlinesGenerated++;
      console.log(`ok — ${outline.length} lessons planned`);
    } catch (err) {
      console.log(`FAILED: ${err instanceof Error ? err.message : err}`);
      tally.failures.push(`${topic} outline`);
      return;
    }
  } else if (outline) {
    tally.outlinesSkipped++;
  }

  if (!outline) {
    // Dry run with no cached outline: we can't name the bodies we'd write.
    if (args.dryRun && args.lessons > 0) {
      console.log(`    lessons 1-${args.lessons}: WOULD GENERATE (pending outline)`);
    }
    return;
  }

  // 4. Bodies — seq 1..N. seq 0 is already handled above.
  for (const item of outline.slice(0, args.lessons)) {
    const id = `${topic}:${item.seq}`;
    const label = `lesson ${item.seq} "${item.title}"`;
    if (!plan(label, !getLesson(CORPUS_LANGUAGE, id), args.dryRun)) {
      if (getLesson(CORPUS_LANGUAGE, id)) tally.bodiesSkipped++;
      continue;
    }
    try {
      if (!primer) throw new Error('no primer to ground the lesson');
      const lesson = await generateLessonBody(topic, item, primer);
      insertLesson({ ...lesson, id });
      tally.apiCalls++;
      tally.bodiesGenerated++;
      console.log(`ok (${lesson.body.length} chars)`);
    } catch (err) {
      console.log(`FAILED: ${err instanceof Error ? err.message : err}`);
      tally.failures.push(`${topic} ${id}`);
    }
  }
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(
    `Warming ${args.topics.length} track(s), ${args.lessons} lesson(s) each` +
      (args.dryRun ? ' — DRY RUN, no API calls, no writes' : '')
  );
  if (!args.dryRun && !process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set — provision it via bin/inject.');
    process.exit(1);
  }

  for (const topic of args.topics) {
    await warmTopic(topic, args);
  }

  console.log('\n' + '-'.repeat(60));
  if (args.dryRun) {
    console.log('DRY RUN — nothing was generated or written.');
  } else {
    console.log(
      [
        `primers:   ${tally.primersGenerated} generated, ${tally.primersSkipped} cached`,
        `lesson 0:  ${tally.lesson0Derived} derived (free), ${tally.lesson0Skipped} cached`,
        `outlines:  ${tally.outlinesGenerated} generated, ${tally.outlinesSkipped} cached`,
        `bodies:    ${tally.bodiesGenerated} generated, ${tally.bodiesSkipped} cached`,
        `API calls: ${tally.apiCalls}`,
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
