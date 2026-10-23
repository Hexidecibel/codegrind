// Pre-generate everything the app otherwise generates lazily on first view and
// caches forever, so every page loads instantly. Run via bin/warm-content (tsx).
//
// It drives the app's OWN generate-on-demand paths — study.service's
// ensurePrimer/ensureOutline/ensureLesson/ensureTranslations, concept.service's
// lesson(), bank.service's generateAndStore (pattern-leak filter + reference
// canonicalization included) — so every call lands in the ai_usage ledger, and
// the in-flight dedupe and failure cooldowns are the app's, not a copy.
//
// IDEMPOTENT: anything already cached is skipped. BUDGET-CAPPED: spend is read
// from the ai_usage ledger (delta since start) and no job starts if the spent
// amount plus the estimates of everything in flight plus this job would cross
// --budget. Per-attempt content (coaching, grading, hints) is never touched.
//
//   bin/warm-content --dry-run                 # plan + estimated cost, no calls
//   bin/warm-content --budget 20               # run it
//   bin/warm-content --only problems --per-slot 3
import { TOPICS, type Topic, type Difficulty } from '../src/shared/types.js';
import { LANGUAGES, type Language } from '../src/shared/languages.js';
import { AI_SD_CONCEPTS } from '../src/shared/sd.js';
import { REFRESH_TOPICS } from '../src/shared/pattern-shapes.js';
import {
  db,
  getActiveLanguage,
  getBankTitles,
  getCachedLessonMeta,
  getCorpusSnippets,
  getLesson,
  getPrimer,
  getSkillState,
  getTrackOutline,
  getTranslatedSourceIds,
  servableBankSize,
} from '../src/server/services/db.js';
import {
  buildStudyState,
  ensureLesson,
  ensureOutline,
  ensurePrimer,
  ensureTranslations,
  planTrackSlots,
  studyQueue,
} from '../src/server/services/study.service.js';
import { lesson as conceptLesson } from '../src/server/services/concept.service.js';
import * as conceptStore from '../src/server/services/concept.store.js';
import { generateAndStore } from '../src/server/services/bank.service.js';
import { CORPUS_LANGUAGE } from '../src/server/services/llm.language.js';
import { hydrate, isConfigured } from '../src/server/services/apikey.service.js';
import { hydrateProviderConfig } from '../src/server/services/provider.service.js';
import { describeRouting, needsAnthropicKey } from '../src/server/services/llm.client.js';

// Rough per-call estimates (USD), from the ledger's emit_problem average and the
// maxTokens of each path. Used for the dry-run total and the budget guard only.
const EST = {
  primer: 0.03,
  outline: 0.02,
  lesson: 0.04,
  translation: 0.1,
  concept: 0.06,
  problem: { easy: 0.025, medium: 0.035, hard: 0.045, expert: 0.05 } as Record<Difficulty, number>,
};

const SECTIONS = ['lessons', 'translations', 'concepts', 'personal', 'problems'] as const;
type Section = (typeof SECTIONS)[number];

interface Args {
  dryRun: boolean;
  budget: number;
  concurrency: number;
  perSlot: number;
  language: Language;
  translateTo: Language[];
  difficulties: Difficulty[];
  only: Section[];
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    dryRun: false,
    budget: 20,
    concurrency: 3,
    perSlot: 3,
    language: getActiveLanguage(),
    translateTo: ['python', 'go'],
    difficulties: ['medium', 'easy', 'hard'],
    only: [...SECTIONS],
  };
  const only: Section[] = [];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i] ?? '';
    if (k === '--dry-run' || k === '-n') a.dryRun = true;
    else if (k === '--budget') a.budget = Number(v());
    else if (k === '--concurrency') a.concurrency = Math.max(1, Math.min(3, parseInt(v(), 10) || 1));
    else if (k === '--per-slot') a.perSlot = Math.max(0, parseInt(v(), 10) || 0);
    else if (k === '--translate-to') {
      a.translateTo = v().split(',').filter(Boolean) as Language[];
      if (a.translateTo.some((l) => !(LANGUAGES as readonly string[]).includes(l))) {
        console.error(`--translate-to takes a comma list of: ${LANGUAGES.join(', ')}`);
        process.exit(2);
      }
    } else if (k === '--difficulties') a.difficulties = v().split(',').filter(Boolean) as Difficulty[];
    else if (k === '--only') {
      const s = v() as Section;
      if (!(SECTIONS as readonly string[]).includes(s)) {
        console.error(`--only must be one of: ${SECTIONS.join(', ')}`);
        process.exit(2);
      }
      only.push(s);
    } else if (k === '--help' || k === '-h') {
      console.log(
        [
          'Usage: bin/warm-content [--dry-run] [--budget USD] [--concurrency N<=3] [--per-slot N]',
          '                        [--translate-to python,go] [--difficulties medium,easy,hard]',
          '                        [--only lessons|translations|concepts|personal|problems]...',
          '',
          '  lessons       primers, track outlines and every track lesson (corpus)',
          '  translations  per-language snippet overlays (code_translations), one call per topic',
          '  concepts      the AI-systems track lessons (/concepts)',
          '  personal      mistake + walkthrough lessons currently queued in Study',
          '  problems      top every topic x difficulty up to --per-slot unused problems',
          '',
          'Idempotent; budget measured from the ai_usage ledger. Default budget $20.',
        ].join('\n')
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${k} (try --help)`);
      process.exit(2);
    }
  }
  if (only.length) a.only = only;
  if (!Number.isFinite(a.budget) || a.budget <= 0) {
    console.error('--budget must be a positive number');
    process.exit(2);
  }
  return a;
}

// -----------------------------------------------------------------------------
// Ledger + budget
// -----------------------------------------------------------------------------
const ledgerStmt = db.prepare(`SELECT COALESCE(SUM(costUsd), 0) AS usd, COUNT(*) AS n FROM ai_usage WHERE id > ?`);
const maxIdStmt = db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM ai_usage`);
const startId = (maxIdStmt.get() as { id: number }).id;
/** Spend since this run started. Includes anything the live service spent meanwhile (conservative). */
function spent(): { usd: number; n: number } {
  return ledgerStmt.get(startId) as { usd: number; n: number };
}

// A dead account must stop the run, not burn through every remaining job. The
// study paths swallow their errors into console.error, so listen there too.
let creditDead = false;
const CREDIT_RE = /credit balance|insufficient.*credit|no credit|billing/i;
const origError = console.error.bind(console);
console.error = (...xs: unknown[]) => {
  if (xs.some((x) => CREDIT_RE.test(x instanceof Error ? x.message : String(x)))) creditDead = true;
  origError(...xs);
};

interface Job {
  section: Section;
  label: string;
  est: number;
  /** Jobs sharing a lock never run concurrently (same-topic problems share avoidTitles). */
  lock?: string;
  run: () => Promise<boolean>;
}

async function runJobs(jobs: Job[], args: Args): Promise<{ ok: number; failed: string[]; skipped: string[] }> {
  let inflightEst = 0;
  const locks = new Set<string>();
  const queue = [...jobs];
  const failed: string[] = [];
  const skipped: string[] = [];
  let ok = 0;
  let done = 0;
  const total = jobs.length;

  async function worker(): Promise<void> {
    for (;;) {
      if (creditDead) return;
      const idx = queue.findIndex((j) => !j.lock || !locks.has(j.lock));
      if (idx < 0) {
        if (!queue.length) return;
        await new Promise((r) => setTimeout(r, 500)); // every remaining job is locked by a running one
        continue;
      }
      const job = queue.splice(idx, 1)[0];
      const s = spent().usd;
      if (s + inflightEst + job.est > args.budget) {
        skipped.push(`${job.label} (budget: $${s.toFixed(2)} spent)`);
        done++;
        continue;
      }
      inflightEst += job.est;
      if (job.lock) locks.add(job.lock);
      const t0 = Date.now();
      let good = false;
      let why = '';
      try {
        good = await job.run();
        if (!good) why = 'not cached afterwards (see log above; cooldown applies)';
      } catch (err) {
        why = err instanceof Error ? err.message : String(err);
        if (CREDIT_RE.test(why)) creditDead = true;
      } finally {
        inflightEst -= job.est;
        if (job.lock) locks.delete(job.lock);
      }
      done++;
      const sp = spent();
      const tag = `[${done}/${total}] $${sp.usd.toFixed(3)} (${sp.n} calls)`;
      if (good) {
        ok++;
        console.log(`${tag} ok      ${job.label} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      } else {
        failed.push(`${job.label}: ${why.slice(0, 200)}`);
        console.log(`${tag} FAILED  ${job.label}: ${why.slice(0, 200)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: args.concurrency }, () => worker()));
  for (const j of queue) skipped.push(`${j.label} (stopped)`);
  return { ok, failed, skipped };
}

// -----------------------------------------------------------------------------
// Planning — every check reads the same predicate the app does.
// -----------------------------------------------------------------------------
function planLessons(): Job[] {
  const jobs: Job[] = [];
  const cachedIds = new Set(getCachedLessonMeta().map((m) => m.id));
  for (const topic of TOPICS) {
    if (!getPrimer(CORPUS_LANGUAGE, topic))
      jobs.push({ section: 'lessons', label: `primer ${topic}`, est: EST.primer, lock: `t:${topic}`, run: async () => (await ensurePrimer(topic), !!getPrimer(CORPUS_LANGUAGE, topic)) });
    if (!getTrackOutline(topic))
      jobs.push({ section: 'lessons', label: `outline ${topic}`, est: EST.outline, lock: `t:${topic}`, run: async () => (await ensureOutline(topic), !!getTrackOutline(topic)) });
    const outline = getTrackOutline(topic);
    if (!outline) continue; // bodies get planned on the next run, once the outline exists
    for (const slot of planTrackSlots(topic, outline, cachedIds)) {
      if (slot.cached || getLesson(CORPUS_LANGUAGE, slot.id)) continue;
      jobs.push({
        section: 'lessons',
        label: `lesson ${slot.id}`,
        est: slot.seq === 0 ? 0 : EST.lesson,
        run: async () => (await ensureLesson(slot), !!getLesson(CORPUS_LANGUAGE, slot.id)),
      });
    }
  }
  return jobs;
}

function missingTranslations(language: Language, topic: Topic): number {
  const have = getTranslatedSourceIds(language);
  return getCorpusSnippets(topic).filter((s) => !have.has(s.sourceId)).length;
}

function planTranslations(args: Args): Job[] {
  const jobs: Job[] = [];
  for (const language of args.translateTo) {
    if (language === CORPUS_LANGUAGE) continue;
    for (const topic of TOPICS) {
      const n = missingTranslations(language, topic);
      if (!n) continue;
      jobs.push({
        section: 'translations',
        label: `translate ${topic} -> ${language} (${n} snippets)`,
        est: EST.translation,
        run: async () => (await ensureTranslations(language, topic), missingTranslations(language, topic) === 0),
      });
    }
  }
  return jobs;
}

function planConcepts(): Job[] {
  return AI_SD_CONCEPTS.filter((c) => !conceptStore.getLesson(c)).map((c) => ({
    section: 'concepts' as const,
    label: `concept lesson ${c}`,
    est: EST.concept,
    run: async () => (await conceptLesson(c), !!conceptStore.getLesson(c)),
  }));
}

function planPersonal(args: Args): Job[] {
  const queue = studyQueue(buildStudyState(args.language));
  return queue
    .filter((s) => (s.source === 'mistake' || s.source === 'walkthrough') && !s.cached && !getLesson(CORPUS_LANGUAGE, s.id))
    .map((slot) => ({
      section: 'personal' as const,
      label: `${slot.source} lesson ${slot.id}`,
      est: EST.lesson,
      run: async () => (await ensureLesson(slot), !!getLesson(CORPUS_LANGUAGE, slot.id)),
    }));
}

/** Refresh topics first, then never-attempted topics, then the rest by fewest attempts. */
function topicPriority(language: Language): Topic[] {
  const attempts = new Map(getSkillState(language).map((s) => [s.topic, s.attempts]));
  const rest = TOPICS.filter((t) => !REFRESH_TOPICS.includes(t));
  rest.sort((a, b) => (attempts.get(a) ?? -1) - (attempts.get(b) ?? -1));
  return [...REFRESH_TOPICS, ...rest];
}

function planProblems(args: Args): Job[] {
  const jobs: Job[] = [];
  const { language } = args;
  const order = topicPriority(language);
  // Round by round (1st, 2nd, 3rd unused problem per slot) so a budget stop
  // leaves every slot partly stocked rather than some full and some empty.
  for (const difficulty of args.difficulties) {
    for (let round = 1; round <= args.perSlot; round++) {
      for (const topic of order) {
        if (servableBankSize(language, topic, difficulty) >= round) continue;
        jobs.push({
          section: 'problems',
          label: `problem ${language} ${difficulty}/${topic} #${round}`,
          est: EST.problem[difficulty] ?? 0.04,
          lock: `p:${topic}`,
          run: async () => {
            // Re-checked at run time: the live service may have stocked it meanwhile.
            if (servableBankSize(language, topic, difficulty) >= round) return true;
            const avoidTitles = getBankTitles(language, topic);
            await generateAndStore(language, topic, difficulty, avoidTitles.length ? { avoidTitles } : undefined);
            return true;
          },
        });
      }
    }
  }
  return jobs;
}

// -----------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  hydrateProviderConfig(); // also installs the ai_usage recorder
  hydrate();

  console.log(`warm-content — language ${args.language}, budget $${args.budget.toFixed(2)}, concurrency ${args.concurrency}` + (args.dryRun ? ' — DRY RUN' : ''));
  console.log(`Routing: ${describeRouting()}`);
  if (!args.dryRun && needsAnthropicKey() && !isConfigured()) {
    console.error('No Anthropic API key is configured.');
    process.exit(1);
  }

  const planners: Record<Section, () => Job[]> = {
    lessons: planLessons,
    translations: () => planTranslations(args),
    concepts: planConcepts,
    personal: () => planPersonal(args),
    problems: () => planProblems(args),
  };

  // Sections run in order; lessons first so translations see every snippet.
  let grandEst = 0;
  const report: string[] = [];
  for (const section of SECTIONS) {
    if (!args.only.includes(section)) continue;
    if (creditDead) break;
    const jobs = planners[section]();
    const est = jobs.reduce((n, j) => n + j.est, 0);
    grandEst += est;
    console.log(`\n== ${section}: ${jobs.length} to generate, est ~$${est.toFixed(2)}`);
    if (args.dryRun) {
      for (const j of jobs) console.log(`   WOULD GENERATE ${j.label} (~$${j.est.toFixed(3)})`);
      continue;
    }
    if (!jobs.length) continue;
    const r = await runJobs(jobs, args);
    report.push(`${section}: ${r.ok} ok, ${r.failed.length} failed, ${r.skipped.length} skipped`);
    for (const f of r.failed) report.push(`  failed  ${f}`);
    for (const s of r.skipped) report.push(`  skipped ${s}`);
  }

  console.log('\n' + '-'.repeat(60));
  if (args.dryRun) {
    console.log(`DRY RUN — estimated total ~$${grandEst.toFixed(2)} (budget $${args.budget.toFixed(2)}). Nothing generated.`);
    return;
  }
  for (const line of report) console.log(line);
  const sp = spent();
  console.log(`\nLedger spend this run: $${sp.usd.toFixed(4)} over ${sp.n} call(s).`);
  if (creditDead) {
    console.log('STOPPED: the API reported a credit/billing problem.');
    process.exit(1);
  }
  console.log('Done.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
