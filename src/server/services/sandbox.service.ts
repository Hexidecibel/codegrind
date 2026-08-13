import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import type { TestCase, TestResult, RunResult, RunPhase, Verdict } from '../../shared/types.js';
import { LANGUAGE_META, type Language } from '../../shared/languages.js';

const execFileAsync = promisify(execFile);

// Repo root is three levels up from src/server/services/.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const RUN_SCRIPT = path.join(REPO_ROOT, 'bin', 'run-submission');
const DATA_DIR = process.env.DATA_DIR || './data';
const SCRATCH_DIR = path.resolve(DATA_DIR, 'tmp');

interface HarnessOutput {
  results?: Array<{
    name?: string;
    passed?: boolean;
    expected?: string;
    actual?: string;
    stderr?: string;
    stdout?: string;
    timeMs?: number;
  }>;
  passed?: number;
  total?: number;
  error?: string;
  /** Where the runner stopped. Absent from a pre-Phase-2 harness. */
  phase?: string;
  /** Anything printed while the solution was LOADING, before any test ran. */
  stdout?: string;
}

const PHASES: readonly string[] = ['compile', 'load', 'run'];

/** Narrow the runner's self-reported phase; undefined for anything unrecognised. */
function toPhase(value: unknown): RunPhase | undefined {
  return typeof value === 'string' && PHASES.includes(value) ? (value as RunPhase) : undefined;
}

/**
 * Turn the harness JSON (or a failure) into a typed RunResult.
 *
 * Pure translation, and it stays that way: this is the seam every language's
 * runner meets the rest of the app at, so the only thing it is allowed to know
 * is the shape of the JSON contract. Nothing language-specific belongs here —
 * that is precisely what `phase` is for.
 */
function toRunResult(
  parsed: HarnessOutput | null,
  totalTests: number,
  fallbackVerdict: Verdict,
  fallbackError?: string
): RunResult {
  const phase = toPhase(parsed?.phase);

  if (!parsed || !Array.isArray(parsed.results) || parsed.results.length === 0) {
    // Sandbox produced nothing usable (timeout, crash, harness-level error).
    const message =
      parsed?.error || fallbackError || 'Execution failed or was killed by the sandbox.';
    const results: TestResult[] = Array.from({ length: Math.max(totalTests, 1) }, (_, i) => ({
      name: `test_${i + 1}`,
      passed: false,
      stderr: message,
      // Whatever the solution printed before it died is attached to the first
      // synthesised row rather than dropped — it is often the only clue.
      stdout: i === 0 && typeof parsed?.stdout === 'string' ? parsed.stdout : undefined,
      timeMs: 0,
    }));
    return { results, passed: 0, total: results.length, verdict: fallbackVerdict, phase };
  }

  const results: TestResult[] = parsed.results.map((r, i) => ({
    name: typeof r.name === 'string' ? r.name : `test_${i + 1}`,
    passed: r.passed === true,
    expected: typeof r.expected === 'string' ? r.expected : undefined,
    actual: typeof r.actual === 'string' ? r.actual : undefined,
    stderr: typeof r.stderr === 'string' ? r.stderr : undefined,
    stdout: typeof r.stdout === 'string' ? r.stdout : undefined,
    timeMs: typeof r.timeMs === 'number' ? r.timeMs : 0,
  }));

  const passed = results.filter((r) => r.passed).length;
  const anyError = results.some((r) => r.stderr);
  let verdict: Verdict;
  if (passed === results.length) verdict = 'accepted';
  else if (anyError) verdict = 'runtime_error';
  else verdict = 'wrong_answer';

  return { results, passed, total: results.length, verdict, phase };
}

/**
 * Everything the sandbox needs for one run.
 *
 * An options object rather than positional arguments because the list is about
 * to grow asymmetrically: Java wants a compile budget that means nothing to the
 * other two, and a fourth positional parameter that only one language reads is
 * how call sites start passing `undefined` into the middle of a signature.
 */
export interface RunTestsOptions {
  /**
   * Read off the PROBLEM, never off a request body or the active setting. It is
   * what makes running one language's source through another's harness
   * impossible rather than merely unlikely.
   */
  language: Language;
  functionName: string;
  userCode: string;
  tests: TestCase[];
}

/**
 * Run `userCode` against `tests` in the Docker sandbox. Never throws — any
 * failure (timeout, crashed container, unparseable output) is reported as a
 * failed run with an appropriate verdict.
 */
export async function runTests(opts: RunTestsOptions): Promise<RunResult> {
  const { language, functionName, userCode, tests } = opts;

  await fs.mkdir(SCRATCH_DIR, { recursive: true });
  const id = nanoid();
  // The extension is cosmetic here — bin/run-submission renames the file to
  // whatever the language requires inside the container (Solution.java, and so
  // on). It exists so a leaked scratch file is identifiable.
  const solutionPath = path.join(SCRATCH_DIR, `${id}.solution${LANGUAGE_META[language].fileExtension}`);
  const testsPath = path.join(SCRATCH_DIR, `${id}.tests.json`);

  try {
    await fs.writeFile(solutionPath, userCode, 'utf8');
    await fs.writeFile(testsPath, JSON.stringify({ functionName, tests }), 'utf8');

    let stdout = '';
    let timedOut = false;
    let runError: string | undefined;
    try {
      const res = await execFileAsync(RUN_SCRIPT, [language, solutionPath, testsPath], {
        // Outer safety net above the script's own per-language `timeout`, which
        // tops out at CG_TIMEOUT[java] = 30s. Must stay strictly above it or
        // this fires first and the structured partial results are lost.
        timeout: 45_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      stdout = res.stdout;
    } catch (err: unknown) {
      // Non-zero exit (incl. 124 timeout) lands here. The container may still
      // have printed partial/valid JSON to stdout before being killed.
      const e = err as { stdout?: string; killed?: boolean; code?: number; message?: string };
      stdout = e.stdout || '';
      // 124 = `timeout` fired and SIGTERM was enough. 137 = 128+SIGKILL, i.e.
      // `timeout -k` had to escalate — which is the normal path for a tight
      // synchronous loop, since it never yields to a signal handler.
      if (e.killed || e.code === 124 || e.code === 137) timedOut = true;
      runError = e.message;
    }

    let parsed: HarnessOutput | null = null;
    const trimmed = stdout.trim();
    if (trimmed) {
      try {
        parsed = JSON.parse(trimmed) as HarnessOutput;
      } catch {
        parsed = null;
      }
    }

    // If we got no parseable output, decide timeout vs compile error vs generic
    // error. The runner reports `phase: "compile"` when the source never
    // parsed — the one case where "0 of 8 tests passed" is actively misleading,
    // because no test was ever called and the code has no behaviour to discuss.
    if (!parsed || !Array.isArray(parsed.results) || parsed.results.length === 0) {
      const compileFailed = toPhase(parsed?.phase) === 'compile';
      const verdict: Verdict = compileFailed ? 'compile_error' : timedOut ? 'timeout' : 'error';
      const errMsg = compileFailed
        ? parsed?.error
        : timedOut
          ? 'Timed out — your solution ran too long (possible infinite loop).'
          : parsed?.error || runError;
      return toRunResult(parsed, tests.length, verdict, errMsg);
    }

    return toRunResult(parsed, tests.length, 'error');
  } finally {
    await fs.rm(solutionPath, { force: true }).catch(() => {});
    await fs.rm(testsPath, { force: true }).catch(() => {});
  }
}
