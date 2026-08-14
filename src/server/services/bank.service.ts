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

/**
 * Rebuild a generated problem with reference-canonicalized tests, or null if too
 * few survive.
 *
 * EXPORTED BECAUSE IT IS THE ONLY OBJECTIVE JUDGE OF A MODEL IN THIS CODEBASE.
 * Everything else about a generated problem is a matter of taste; this either
 * comes back with a problem or it does not, and it does so by actually running
 * the model's own reference solution against the model's own test inputs. A
 * capability probe that asks "is this endpoint good enough for codegrind?" has
 * no better question available to it, and asking this one costs a function call
 * rather than a reimplementation that would drift.
 */
export async function canonicalize(
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

  const record = toRecord(language, topic, difficulty, gen, canonicalized);
  insertProblem(record);
  return record;
}

/** A generated problem, stamped into a storable record. */
function toRecord(
  language: Language,
  topic: Topic,
  difficulty: Difficulty,
  gen: GeneratedProblem,
  canonicalized: boolean
): ProblemRecord {
  return {
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
}

// ---------------------------------------------------------------------------
// dryRunGenerate — one attempt, honestly scored
// ---------------------------------------------------------------------------
/** Which stage failed. The distinction is the entire point of this function. */
export type DryRunFailure =
  /** The model never produced a usable tool call (or the call threw). */
  | 'generation'
  /** It produced one, but its own reference errored on most of its own inputs. */
  | 'too-few-tests'
  /** The SANDBOX could not run. Nothing was learned about the model. */
  | 'sandbox';

export type DryRunResult =
  | {
      ok: true;
      language: Language;
      topic: Topic;
      difficulty: Difficulty;
      problem: GeneratedProblem;
      /** Test counts AFTER canonicalization — i.e. tests that actually ran. */
      sampleTests: number;
      hiddenTests: number;
      /** The id it was stored under, or null when this was a true dry run. */
      storedId: string | null;
      ms: number;
    }
  | {
      ok: false;
      language: Language;
      topic: Topic;
      difficulty: Difficulty;
      failure: DryRunFailure;
      error: string;
      /** Present once generation itself succeeded. */
      title?: string;
      ms: number;
    };

/**
 * Generate one problem, canonicalize it, and report what happened — WITHOUT
 * storing it unless asked to.
 *
 * This is deliberately NOT `generateAndStore` with a flag. Two differences, both
 * load-bearing:
 *
 *   1. ONE ATTEMPT, never three. `generateAndStore` retries because a player is
 *      waiting and a problem has to appear; the single-shot rate is what
 *      predicts what using this model will actually feel like, and a 3-attempt
 *      loop hides exactly that. (Go's measured rate on the incumbent: 8 accepted
 *      in 10 calls.)
 *   2. IT NAMES THE STAGE THAT FAILED. `generateAndStore` collapses a broken
 *      Docker into the same "could not generate" as a bad completion, which is
 *      correct for a player and useless for judging a model. A missing runner
 *      image must never be scored against the model — so `sandbox` is its own
 *      outcome, and a caller that treats it as a model failure is wrong.
 *
 * It reuses `canonicalize`, `MIN_SAMPLE_TESTS`/`MIN_HIDDEN_TESTS` and `runTests`
 * unchanged: a probe that measured a DIFFERENT bar than the app enforces would
 * be measuring nothing.
 *
 * Cost: exactly one generation call, plus two sandbox runs when it succeeds.
 */
export async function dryRunGenerate(
  language: Language,
  topic: Topic,
  difficulty: Difficulty,
  opts: { keep?: boolean } = {}
): Promise<DryRunResult> {
  const startedAt = Date.now();
  const where = { language, topic, difficulty };
  const elapsed = () => Date.now() - startedAt;
  const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

  let raw: GeneratedProblem;
  try {
    raw = await generateProblem(language, topic, difficulty);
  } catch (err) {
    return { ok: false, ...where, failure: 'generation', error: reason(err), ms: elapsed() };
  }

  let canon: GeneratedProblem | null;
  try {
    canon = await canonicalize(language, raw);
  } catch (err) {
    // The sandbox itself could not run (Docker down, image missing, script
    // gone). Infrastructure, not the model — and never scored against it.
    return {
      ok: false,
      ...where,
      failure: 'sandbox',
      error: reason(err),
      title: raw.title,
      ms: elapsed(),
    };
  }

  if (!canon) {
    return {
      ok: false,
      ...where,
      failure: 'too-few-tests',
      error:
        `The reference solution errored on too many of its own test inputs: fewer than ` +
        `${MIN_SAMPLE_TESTS} sample / ${MIN_HIDDEN_TESTS} hidden tests survived canonicalization.`,
      title: raw.title,
      ms: elapsed(),
    };
  }

  let storedId: string | null = null;
  if (opts.keep) {
    // Only ever reached on success, so this is always a canonicalized record.
    const record = toRecord(language, topic, difficulty, canon, true);
    insertProblem(record);
    storedId = record.id;
  }

  return {
    ok: true,
    ...where,
    problem: canon,
    sampleTests: canon.sampleTests.length,
    hiddenTests: canon.hiddenTests.length,
    storedId,
    ms: elapsed(),
  };
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
