// codegrind sandbox test harness.
//
// Runs inside the ephemeral, network-less Docker container. Reads the user's
// solution (raw JS) and a tests JSON blob, calls the target function once per
// test case, deep-equal-compares the return value to `expected`, and prints a
// SINGLE JSON blob to stdout:
//   { results: [{ name, passed, expected, actual, stderr, timeMs }], passed, total }
//
// Usage: node runner.mjs <solution.mjs> <tests.json>
//   tests.json = { "functionName": "...", "tests": [{ name, args, expected }] }
//
// A per-case synchronous infinite loop cannot be interrupted from here (single
// thread); the outer `timeout` in bin/run-submission kills the whole container,
// which the caller reports as a timeout verdict.

import { readFileSync } from 'node:fs';

function fail(message) {
  process.stdout.write(JSON.stringify({ results: [], passed: 0, total: 0, error: message }));
  process.exit(0);
}

function deepEqual(a, b) {
  if (a === b) return true;
  // NaN
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const [, , solutionPath, testsPath] = process.argv;
if (!solutionPath || !testsPath) {
  fail('runner: missing solution or tests path argument');
}

let userCode;
let spec;
try {
  userCode = readFileSync(solutionPath, 'utf8');
} catch (e) {
  fail(`runner: could not read solution: ${e.message}`);
}
try {
  spec = JSON.parse(readFileSync(testsPath, 'utf8'));
} catch (e) {
  fail(`runner: could not parse tests json: ${e.message}`);
}

const functionName = spec.functionName;
const tests = Array.isArray(spec.tests) ? spec.tests : [];
if (!functionName) fail('runner: tests json missing functionName');

// Evaluate the user's code in an isolated function scope and pull out the named
// function. Handles `function foo(){}`, `const foo = () => {}`, `var foo = ...`.
let fn;
try {
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    `${userCode}\n;return (typeof ${functionName} !== "undefined") ? ${functionName} : undefined;`
  );
  fn = factory();
} catch (e) {
  fail(`runner: your code failed to load: ${e.message}`);
}

if (typeof fn !== 'function') {
  fail(`runner: expected a function named "${functionName}" but it was not defined`);
}

const results = [];
let passedCount = 0;

for (const test of tests) {
  const name = test && typeof test.name === 'string' ? test.name : 'test';
  const args = test && Array.isArray(test.args) ? test.args : [];
  const expected = test ? test.expected : undefined;

  const start = process.hrtime.bigint();
  let actual;
  let stderr;
  let passed = false;
  try {
    // Deep-clone args so a mutating solution can't corrupt the next test.
    const callArgs = JSON.parse(JSON.stringify(args));
    actual = fn(...callArgs);
    passed = deepEqual(actual, expected);
  } catch (e) {
    stderr = e && e.message ? `${e.name}: ${e.message}` : String(e);
  }
  const timeMs = Number(process.hrtime.bigint() - start) / 1e6;

  results.push({
    name,
    passed,
    expected: safeStringify(expected),
    actual: stderr ? undefined : safeStringify(actual),
    stderr,
    timeMs: Math.round(timeMs * 1000) / 1000,
  });
  if (passed) passedCount++;
}

process.stdout.write(
  JSON.stringify({ results, passed: passedCount, total: results.length })
);
