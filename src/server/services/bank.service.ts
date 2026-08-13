import { nanoid } from 'nanoid';
import type { ProblemRecord, Topic, Difficulty, TestCase } from '../../shared/types.js';
import type { Language } from '../../shared/languages.js';
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
  getRecentProblemDigests,
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
  language: Language,
  functionName: string,
  referenceSolution: string,
  tests: TestCase[]
): Promise<TestCase[]> {
  if (tests.length === 0) return [];
  const res = await runTests({ language, functionName, userCode: referenceSolution, tests });
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
async function canonicalize(
  language: Language,
  gen: GeneratedProblem
): Promise<GeneratedProblem | null> {
  const sampleTests = await canonicalizeTests(
    language, gen.functionName, gen.referenceSolution, gen.sampleTests
  );
  const hiddenTests = await canonicalizeTests(
    language, gen.functionName, gen.referenceSolution, gen.hiddenTests
  );
  if (sampleTests.length < MIN_SAMPLE_TESTS || hiddenTests.length < MIN_HIDDEN_TESTS) {
    return null;
  }
  return { ...gen, sampleTests, hiddenTests };
}

/**
 * Generate a fresh problem via Claude, canonicalize its tests against the
 * reference solution (so the problem is internally consistent), and store it.
 * Regenerates if the reference is too broken to yield enough usable tests.
 *
 * WHEN CANONICALIZATION CANNOT BE DONE, THE TWO LANGUAGES PART WAYS. This used
 * to swallow a sandbox failure with a `console.warn` and store the problem with
 * the model's hand-authored `expected` values, which is survivable in
 * JavaScript — the incumbent, whose whole existing bank was built that way and
 * is demonstrably solvable — and fatal anywhere else. A missing JDK image would
 * mint a Java problem whose `expected` no real run can ever reproduce: an
 * unsolvable problem, served silently, with the failure looking exactly like the
 * player being wrong.
 *
 * So: JavaScript keeps the lenient path and the problem is stamped
 * `canonicalized: false`, which keeps it out of every future bank read. Every
 * other language throws, loudly, at generation time.
 */
export async function generateAndStore(
  language: Language,
  topic: Topic,
  difficulty: Difficulty,
  opts?: GenerateProblemOpts
): Promise<ProblemRecord> {
  let gen: GeneratedProblem | null = null;
  let lastRaw: GeneratedProblem | null = null;
  // Only true when every stored `expected` came out of a real sandbox run of
  // the reference. Never inferred later — by then the evidence is gone.
  let canonicalized = false;

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_GEN_ATTEMPTS; attempt++) {
    // Generation itself must be inside the retry. It throws on a truncated or
    // malformed tool call ("missing sample or hidden tests"), and that used to
    // escape this loop entirely — one unlucky completion 500'd the request and
    // left the player staring at "Failed to load next problem" with no recovery.
    let raw: GeneratedProblem;
    try {
      raw = await generateProblem(language, topic, difficulty, opts);
    } catch (err) {
      lastError = err;
      console.warn(
        `[bank] ${difficulty}/${topic} attempt ${attempt}/${MAX_GEN_ATTEMPTS} failed to generate: ${
          err instanceof Error ? err.message : err
        }`
      );
      continue;
    }
    lastRaw = raw;
    try {
      const canon = await canonicalize(language, raw);
      if (canon) {
        gen = canon;
        canonicalized = true;
        break;
      }
      console.warn(
        `[bank] ${difficulty}/${topic} attempt ${attempt}: too few tests survived canonicalization (reference errors on most inputs) — regenerating.`
      );
    } catch (err) {
      // The sandbox itself could not run (Docker down, image missing, the
      // script gone). This is infrastructure, not a bad generation, so retrying
      // would only burn generation calls against the same broken sandbox.
      const detail = err instanceof Error ? err.message : String(err);
      if (language !== 'javascript') {
        throw new Error(
          `Cannot generate a ${language} problem: the sandbox failed, so the reference ` +
            `solution was never run and every expected value would be unverified. ` +
            `Fix the sandbox (bin/build-runner-image, bin/status) and retry. Cause: ${detail}`
        );
      }
      console.warn(`[bank] canonicalization skipped (sandbox error): ${detail}`);
      gen = raw;
      canonicalized = false;
      break;
    }
  }

  if (!gen && lastRaw) {
    if (language !== 'javascript') {
      throw new Error(
        `Could not generate a solvable ${language} ${difficulty} ${topic} problem after ` +
          `${MAX_GEN_ATTEMPTS} attempts: the reference solution errored on too many of its own ` +
          `test inputs every time, so no expected value could be verified.`
      );
    }
    console.warn(`[bank] storing ${difficulty}/${topic} un-canonicalized after ${MAX_GEN_ATTEMPTS} attempts.`);
    gen = lastRaw;
    canonicalized = false;
  }

  if (!gen) {
    // Every attempt threw, so there is no raw problem to fall back on. Surface
    // the real cause rather than a null-deref on `gen.title`.
    throw new Error(
      `Could not generate a ${difficulty} ${topic} problem after ${MAX_GEN_ATTEMPTS} attempts: ${
        lastError instanceof Error ? lastError.message : lastError
      }`
    );
  }

  const record: ProblemRecord = {
    id: nanoid(),
    // The language that produced these `expected` values, stamped at the moment
    // they were produced — and the language the sandbox was actually invoked
    // with above, not an assumption about which one it must have been.
    language,
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
    canonicalized,
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
  language: Language,
  topic: Topic,
  difficulty: Difficulty
): Promise<ProblemRecord> {
  const existing = findUnusedProblem(language, topic, difficulty);
  const record = existing ?? (await generateAndStore(language, topic, difficulty));
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
  // No separate language argument on purpose — it rides on the intent, which is
  // what the scheduler computed the whole pick from.
  const { language, topic, difficulty, kind } = intent;

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
    record = findUnusedProblem(language, topic, difficulty);
  }

  if (!record) {
    const opts: GenerateProblemOpts = {};
    const noveltyHint = NOVELTY_HINT[kind];
    if (noveltyHint) opts.noveltyHint = noveltyHint;

    const avoidTitles = intent.avoidTitles ?? getBankTitles(language, topic);
    if (avoidTitles.length) opts.avoidTitles = avoidTitles;

    // Avoiding titles only stops repeated NAMES. Left alone the generator will
    // happily re-serve the same algorithm in a fresh costume — six distinct
    // "find a target in a sorted array" problems with six different stories.
    // Show it what it has already produced and demand a different structural
    // variant of the technique.
    const recent = getRecentProblemDigests(language, topic, 4);
    if (recent.length) {
      const digest = recent
        .map((r) => `- "${r.title}": ${r.prompt.replace(/\s+/g, ' ').slice(0, 160)}`)
        .join('\n');
      opts.noveltyHint = [
        opts.noveltyHint,
        `Already served for "${topic}":\n${digest}\n\n` +
          `Pick a genuinely DIFFERENT structural variant of the ${topic} technique — a different ` +
          `invariant, boundary condition, or search/traversal target. Re-stating the same algorithm ` +
          `in a new domain or story is a failure; the solution shape itself must differ.`,
      ]
        .filter(Boolean)
        .join('\n\n');
    }

    if (kind === 'variation') {
      const seed = getRecentSolvedProblem(language, topic);
      if (seed) {
        opts.variationOf = { title: seed.title, pattern: seed.pattern, prompt: seed.prompt };
      }
    }

    record = await generateAndStore(language, topic, difficulty, opts);
  }

  markProblemUsed(record.id);
  return { ...record, used: true };
}

export { getProblem };
