import { nanoid } from 'nanoid';
import type { ProblemRecord, Topic, Difficulty, TestCase } from '../../shared/types.js';
import { generateProblem, type GeneratedProblem, type GenerateProblemOpts } from './llm.service.js';
import type { SchedulerIntent } from './scheduler.service.js';
import { runTests } from './sandbox.service.js';
import {
  insertProblem,
  findUnusedProblem,
  markProblemUsed,
  getProblem,
  getBankTitles,
  getRecentSolvedProblem,
} from './db.js';

// How many times to regenerate if too few tests survive canonicalization (the
// reference solution errors on most inputs — a genuinely broken problem).
const MAX_GEN_ATTEMPTS = 3;
const MIN_SAMPLE_TESTS = 1;
const MIN_HIDDEN_TESTS = 4;

/**
 * Canonicalize a test set against the reference solution: run the reference in
 * the sandbox and adopt ITS output as the ground-truth `expected` for each case,
 * dropping any test the reference errors on. This makes the stored problem 100%
 * self-consistent by construction — the reference always passes its own tests —
 * and resolves the common LLM failure mode where the model hand-authors an
 * `expected` value that disagrees with its own (correct) reference, or picks one
 * of several valid answers for an ambiguous case.
 */
async function canonicalizeTests(
  functionName: string,
  referenceSolution: string,
  tests: TestCase[]
): Promise<TestCase[]> {
  if (tests.length === 0) return [];
  const res = await runTests(functionName, referenceSolution, tests);
  const out: TestCase[] = [];
  res.results.forEach((r, i) => {
    const src = tests[i];
    if (!src) return;
    if (r.stderr) return; // reference errored on this input → drop the test
    if (typeof r.actual !== 'string') return; // undefined / unserializable → drop
    let expected: unknown;
    try {
      expected = JSON.parse(r.actual);
    } catch {
      return;
    }
    out.push({ name: src.name, args: src.args, expected });
  });
  return out;
}

/** Rebuild a generated problem with reference-canonicalized tests, or null if too few survive. */
async function canonicalize(gen: GeneratedProblem): Promise<GeneratedProblem | null> {
  const sampleTests = await canonicalizeTests(gen.functionName, gen.referenceSolution, gen.sampleTests);
  const hiddenTests = await canonicalizeTests(gen.functionName, gen.referenceSolution, gen.hiddenTests);
  if (sampleTests.length < MIN_SAMPLE_TESTS || hiddenTests.length < MIN_HIDDEN_TESTS) {
    return null;
  }
  return { ...gen, sampleTests, hiddenTests };
}

/**
 * Generate a fresh problem via Claude, canonicalize its tests against the
 * reference solution (so the problem is internally consistent), and store it.
 * Regenerates if the reference is too broken to yield enough usable tests; as a
 * last resort stores the raw generation so the bank is never empty.
 */
export async function generateAndStore(
  topic: Topic,
  difficulty: Difficulty,
  opts?: GenerateProblemOpts
): Promise<ProblemRecord> {
  let gen: GeneratedProblem | null = null;
  let lastRaw: GeneratedProblem | null = null;

  for (let attempt = 1; attempt <= MAX_GEN_ATTEMPTS; attempt++) {
    const raw = await generateProblem(topic, difficulty, opts);
    lastRaw = raw;
    try {
      const canon = await canonicalize(raw);
      if (canon) {
        gen = canon;
        break;
      }
      console.warn(
        `[bank] ${difficulty}/${topic} attempt ${attempt}: too few tests survived canonicalization (reference errors on most inputs) — regenerating.`
      );
    } catch (err) {
      // Sandbox unavailable (e.g. Docker/image missing) — store the raw problem.
      console.warn(
        `[bank] canonicalization skipped (sandbox error): ${err instanceof Error ? err.message : err}`
      );
      gen = raw;
      break;
    }
  }

  if (!gen) {
    console.warn(`[bank] storing ${difficulty}/${topic} un-canonicalized after ${MAX_GEN_ATTEMPTS} attempts.`);
    gen = lastRaw!;
  }

  const record: ProblemRecord = {
    id: nanoid(),
    title: gen.title,
    prompt: gen.prompt,
    examples: gen.examples,
    constraints: gen.constraints,
    difficulty,
    topic,
    pattern: gen.pattern,
    starterCode: gen.starterCode,
    functionName: gen.functionName,
    sampleTests: gen.sampleTests,
    hiddenTests: gen.hiddenTests,
    referenceSolution: gen.referenceSolution,
    used: false,
    createdAt: new Date().toISOString(),
  };
  insertProblem(record);
  return record;
}

/**
 * Serve the next problem for a topic+difficulty slot: reuse an unused banked
 * problem if one exists, otherwise generate a fresh one. The returned problem
 * is marked used so it isn't served again.
 */
export async function getNextProblem(
  topic: Topic,
  difficulty: Difficulty
): Promise<ProblemRecord> {
  const existing = findUnusedProblem(topic, difficulty);
  const record = existing ?? (await generateAndStore(topic, difficulty));
  markProblemUsed(record.id);
  return { ...record, used: true };
}

// A short per-kind steer for the generator on freshly-generated adaptive problems.
const NOVELTY_HINT: Partial<Record<SchedulerIntent['kind'], string>> = {
  variation: 'This is a spaced-repetition VARIATION — keep the technique, change everything else.',
  'new-pattern':
    'Introduce this pattern gently: a clean, canonical easy example that teaches the core idea without extra twists.',
  'level-up': 'Step the challenge up a notch from a basic instance — add a realistic wrinkle that the technique still handles.',
};

/**
 * Serve a problem for a scheduler intent. `variation`/`new-pattern`/`level-up`
 * generate FRESH (with novelty/avoid/variation opts) so they're genuinely new;
 * `warm-up`/`reinforce` reuse an unused banked problem for the slot if present
 * (fast + free), else generate. The returned problem is marked used.
 */
export async function getAdaptiveProblem(intent: SchedulerIntent): Promise<ProblemRecord> {
  const { topic, difficulty, kind } = intent;

  // Retrieval loop: a review re-serves the SAME problem cold. Do NOT generate,
  // do NOT mark used again — the player solves the exact problem they leaned on.
  if (kind === 'review' && intent.reviewProblemId) {
    const existing = getProblem(intent.reviewProblemId);
    if (existing) return existing;
    // Fall through to normal serving if the problem disappeared.
  }

  const mustGenerate = kind === 'variation' || kind === 'new-pattern' || kind === 'level-up';

  let record: ProblemRecord | null = null;

  if (!mustGenerate) {
    // warm-up / reinforce — reuse the bank when possible.
    record = findUnusedProblem(topic, difficulty);
  }

  if (!record) {
    const opts: GenerateProblemOpts = {};
    const noveltyHint = NOVELTY_HINT[kind];
    if (noveltyHint) opts.noveltyHint = noveltyHint;

    const avoidTitles = intent.avoidTitles ?? getBankTitles(topic);
    if (avoidTitles.length) opts.avoidTitles = avoidTitles;

    if (kind === 'variation') {
      const seed = getRecentSolvedProblem(topic);
      if (seed) {
        opts.variationOf = { title: seed.title, pattern: seed.pattern, prompt: seed.prompt };
      }
    }

    record = await generateAndStore(topic, difficulty, opts);
  }

  markProblemUsed(record.id);
  return { ...record, used: true };
}

export { getProblem };
