import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import type { TestCase, TestResult, RunResult, Verdict } from '../../shared/types.js';

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
    timeMs?: number;
  }>;
  passed?: number;
  total?: number;
  error?: string;
}

/** Turn the harness JSON (or a failure) into a typed RunResult. */
function toRunResult(
  parsed: HarnessOutput | null,
  totalTests: number,
  fallbackVerdict: Verdict,
  fallbackError?: string
): RunResult {
  if (!parsed || !Array.isArray(parsed.results) || parsed.results.length === 0) {
    // Sandbox produced nothing usable (timeout, crash, harness-level error).
    const message =
      parsed?.error || fallbackError || 'Execution failed or was killed by the sandbox.';
    const results: TestResult[] = Array.from({ length: Math.max(totalTests, 1) }, (_, i) => ({
      name: `test_${i + 1}`,
      passed: false,
      stderr: message,
      timeMs: 0,
    }));
    return { results, passed: 0, total: results.length, verdict: fallbackVerdict };
  }

  const results: TestResult[] = parsed.results.map((r, i) => ({
    name: typeof r.name === 'string' ? r.name : `test_${i + 1}`,
    passed: r.passed === true,
    expected: typeof r.expected === 'string' ? r.expected : undefined,
    actual: typeof r.actual === 'string' ? r.actual : undefined,
    stderr: typeof r.stderr === 'string' ? r.stderr : undefined,
    timeMs: typeof r.timeMs === 'number' ? r.timeMs : 0,
  }));

  const passed = results.filter((r) => r.passed).length;
  const anyError = results.some((r) => r.stderr);
  let verdict: Verdict;
  if (passed === results.length) verdict = 'accepted';
  else if (anyError) verdict = 'runtime_error';
  else verdict = 'wrong_answer';

  return { results, passed, total: results.length, verdict };
}

/**
 * Run `userCode` against `tests` in the Docker sandbox. Never throws — any
 * failure (timeout, crashed container, unparseable output) is reported as a
 * failed run with an appropriate verdict.
 */
export async function runTests(
  functionName: string,
  userCode: string,
  tests: TestCase[]
): Promise<RunResult> {
  await fs.mkdir(SCRATCH_DIR, { recursive: true });
  const id = nanoid();
  const solutionPath = path.join(SCRATCH_DIR, `${id}.solution.mjs`);
  const testsPath = path.join(SCRATCH_DIR, `${id}.tests.json`);

  try {
    await fs.writeFile(solutionPath, userCode, 'utf8');
    await fs.writeFile(testsPath, JSON.stringify({ functionName, tests }), 'utf8');

    let stdout = '';
    let timedOut = false;
    let runError: string | undefined;
    try {
      const res = await execFileAsync(RUN_SCRIPT, [solutionPath, testsPath], {
        timeout: 20_000, // outer safety net above the script's own 12s timeout
        maxBuffer: 8 * 1024 * 1024,
      });
      stdout = res.stdout;
    } catch (err: unknown) {
      // Non-zero exit (incl. 124 timeout) lands here. The container may still
      // have printed partial/valid JSON to stdout before being killed.
      const e = err as { stdout?: string; killed?: boolean; code?: number; message?: string };
      stdout = e.stdout || '';
      if (e.killed || e.code === 124) timedOut = true;
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

    // If we got no parseable output, decide timeout vs generic error.
    if (!parsed || !Array.isArray(parsed.results) || parsed.results.length === 0) {
      const verdict: Verdict = timedOut ? 'timeout' : parsed?.error ? 'error' : 'error';
      const errMsg = timedOut
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
