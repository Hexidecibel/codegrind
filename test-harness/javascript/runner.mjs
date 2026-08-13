// =============================================================================
// codegrind sandbox test harness — JavaScript
// =============================================================================
// Runs inside the ephemeral, network-less Docker container started by
// bin/run-submission. Reads the user's solution (raw JS) and a tests JSON blob,
// calls the target function once per test case, deep-equal-compares the return
// value to `expected`, and prints a SINGLE JSON blob to stdout.
//
//   node runner.mjs <solution.mjs> <tests.json>
//   node runner.mjs --selftest [equality-cases.json]
//
//   tests.json  { "functionName": "...", "tests": [{ name, args, expected }] }
//
//   stdout      { phase, results: [{ name, passed, expected, actual, stderr,
//                                    stdout, timeMs }], passed, total, stdout? }
//               or, when nothing could be run,
//               { phase, results: [], passed: 0, total: 0, error, stdout? }
//
// THE STDOUT CONTRACT IS THE WHOLE POINT OF THIS FILE. The container's stdout is
// a single JSON document and nothing else. A user's `console.log` used to be
// written straight into that stream, so the caller's JSON.parse failed and the
// player got an unexplained `error` verdict for code that ran perfectly. Every
// window in which user code can execute is therefore wrapped in a capture (see
// beginCapture) and the collected text is returned as DATA, on `stdout` fields,
// where the UI can show it and the parser never sees it.
//
// `phase` says where things stopped: "compile" (the source does not parse),
// "load" (it parses but blew up while defining things, or defined nothing by
// the expected name), or "run" (we got as far as calling the function). The
// caller maps "compile" to the `compile_error` verdict, which is the one shape
// a JS SyntaxError, a Python IndentationError and a javac diagnostic all share.
//
// A per-case synchronous infinite loop cannot be interrupted from here (single
// thread); the outer `timeout` in bin/run-submission kills the whole container,
// which the caller reports as a timeout verdict.

import { readFileSync, writeSync } from 'node:fs';

const PHASE_COMPILE = 'compile';
const PHASE_LOAD = 'load';
const PHASE_RUN = 'run';

// -----------------------------------------------------------------------------
// stdout capture
// -----------------------------------------------------------------------------
// console.log, console.info, console.table and friends all funnel through
// process.stdout.write, so patching that one method catches every route a
// solution has to the payload stream. Capture is opt-in per window: outside a
// beginCapture/endCapture pair the original write is used unchanged, which is
// what lets the final payload out.

/** The real write, captured before anything can shadow it. */
const REAL_WRITE = process.stdout.write.bind(process.stdout);

/** Per-window cap. A `console.log` inside a hot loop is a memory bomb otherwise. */
const STDOUT_CAP = 8 * 1024;

let capture = null;

process.stdout.write = function patchedWrite(chunk, encoding, callback) {
  if (!capture) return REAL_WRITE(chunk, encoding, callback);

  const cb = typeof encoding === 'function' ? encoding : callback;
  const enc = typeof encoding === 'string' ? encoding : 'utf8';
  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(enc);

  const room = STDOUT_CAP - capture.size;
  if (room > 0) {
    const take = text.slice(0, room);
    capture.parts.push(take);
    capture.size += take.length;
    if (take.length < text.length) capture.truncated = true;
  } else if (text.length > 0) {
    capture.truncated = true;
  }

  // Honour the callback contract: a solution that awaits a drain callback must
  // not hang just because we swallowed the write.
  if (typeof cb === 'function') cb();
  return true;
};

function beginCapture() {
  capture = { parts: [], size: 0, truncated: false };
}

/** End the current window and return what was printed, or undefined if nothing. */
function endCapture() {
  const c = capture;
  capture = null;
  if (!c) return undefined;
  let text = c.parts.join('');
  if (c.truncated) text += `\n… (output truncated at ${STDOUT_CAP} bytes)`;
  return text.length > 0 ? text : undefined;
}

// -----------------------------------------------------------------------------
// Equality — the shared spec, hand-written here
// -----------------------------------------------------------------------------
// Every runtime writes its own copy of this, because sharing the CODE would mean
// embedding a JS engine in the Python image. What IS shared is the FIXTURE:
// conformance/equality-cases.json, checked by `--selftest` as a post-build gate.
// Change the rules here and the build fails until the fixture agrees.
//
// The rules: arrays are order-SENSITIVE, objects are key-order-INSENSITIVE,
// NaN equals NaN (which `===` denies), and no type coercion ever — 1 is not "1".

function deepEqual(a, b) {
  if (a === b) return true;
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

// -----------------------------------------------------------------------------
// Canonical serialization — STRICT JSON, keys sorted
// -----------------------------------------------------------------------------
// Two separate bugs are being fixed here.
//
// 1. The old safeStringify fell back to `String(value)` when JSON.stringify
//    threw. `String(v)` of a circular object is "[object Object]" — not JSON —
//    and that text was handed to bank.service.ts, which JSON.parses `actual` to
//    adopt it as the canonical `expected`. The parse threw, the test was
//    silently dropped, and a problem quietly lost its coverage. There is now no
//    non-JSON escape hatch at all: a value either serializes to strict JSON or
//    it is reported as unserializable, and the caller is told which.
//
// 2. Keys were emitted in insertion order, so {a:1,b:2} and {b:2,a:1} — equal by
//    deepEqual — rendered as different strings in the diff the player reads and
//    in the `expected` the bank stores. Sorting makes identical values render
//    identically, in every runtime, which is what lets the same fixture check
//    all of them.
//
// Arrays are NEVER sorted: their order is part of the value.
//
// THE OBJECT TEXT IS BUILT BY HAND, and it has to be. Sorting the keys into a
// fresh object and handing that to JSON.stringify does not work in JavaScript:
// integer-like own keys ("1", "9", "10") are ALWAYS enumerated in ascending
// numeric order regardless of insertion order, so `{"1":…,"10":…,"9":…}` comes
// back out as `{"1":…,"9":…,"10":…}` — while Python's insertion-ordered dict
// would emit the sorted order faithfully. Two runtimes, two canonical forms for
// the same value. The conformance fixture caught exactly this on the first
// build. Emitting the text ourselves takes key order out of the runtime's hands.
//
// Scalars still go through JSON.stringify: string escaping is a spec unto
// itself and there is no reason to re-derive it.

function serialize(value, seen) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'bigint') throw new TypeError('BigInt has no JSON representation');
  if (t === 'boolean') return value ? 'true' : 'false';
  // NaN and ±Infinity are not JSON. `null` is what JSON.stringify emits for
  // them, and matching it keeps this strictly a superset-free JSON writer.
  if (t === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (t === 'string') return JSON.stringify(value);
  // undefined | function | symbol: absent from JSON entirely. Signalled by
  // returning undefined so the caller can decide (dropped in an object, `null`
  // in an array — JSON.stringify's own rules).
  if (t !== 'object') return undefined;

  if (seen.has(value)) throw new TypeError('circular structure');
  // Date and anything else with toJSON gets the same treatment JSON.stringify
  // would give it, just one step earlier so the result is sorted too.
  if (typeof value.toJSON === 'function') return serialize(value.toJSON(), seen);

  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    const parts = [];
    for (const item of value) {
      const s = serialize(item, seen);
      parts.push(s === undefined ? 'null' : s);
    }
    out = `[${parts.join(',')}]`;
  } else {
    const parts = [];
    // Default sort is by UTF-16 code unit — the one ordering every runtime can
    // agree on without a locale. The fixture pins it.
    for (const k of Object.keys(value).sort()) {
      const s = serialize(value[k], seen);
      if (s === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${s}`);
    }
    out = `{${parts.join(',')}}`;
  }
  seen.delete(value);
  return out;
}

/**
 * @returns {{ ok: true, json: string } | { ok: false, note?: string }}
 *   `ok:false` with NO note is the ordinary "this value is simply absent from
 *   JSON" case — `undefined`, a function, a symbol. That is how a solution which
 *   forgets to return is reported, and it stays a wrong answer rather than being
 *   dressed up as an error. A note means something genuinely went wrong.
 */
function canonicalJson(value) {
  let text;
  try {
    text = serialize(value, new WeakSet());
  } catch (e) {
    return { ok: false, note: `value could not be serialized: ${e.message}` };
  }
  if (typeof text !== 'string') return { ok: false };
  return { ok: true, json: text };
}

// -----------------------------------------------------------------------------
// Output
// -----------------------------------------------------------------------------
// writeSync(1, …) rather than process.stdout.write: stdout is a pipe here, so
// Node's stream write is asynchronous and a process.exit() immediately after it
// can truncate the payload. A truncated JSON document is exactly the failure
// this file exists to prevent.

function emit(payload) {
  writeSync(1, JSON.stringify(payload));
}

/** Report that nothing could be run, and say at which phase it stopped. */
function fail(phase, message, stdout) {
  emit({ phase, results: [], passed: 0, total: 0, error: message, stdout });
  process.exit(0);
}

// =============================================================================
// --selftest — the conformance gate
// =============================================================================
// Run at BUILD time by bin/build-runner-image, against the fixture baked into
// the image. It never touches user code; it only asks whether this runtime's
// deepEqual and serializer still agree with the shared spec.

const SENTINELS = {
  nan: NaN,
  inf: Infinity,
  '-inf': -Infinity,
  '-zero': -0,
};

/** Turn `{"$cg":"nan"}` back into a real NaN, recursively. See the fixture's `encoding`. */
function decodeFixture(value) {
  if (Array.isArray(value)) return value.map(decodeFixture);
  if (value === null || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === '$cg') {
    if (!(value.$cg in SENTINELS)) throw new Error(`unknown sentinel: ${value.$cg}`);
    return SENTINELS[value.$cg];
  }
  const out = {};
  for (const k of keys) out[k] = decodeFixture(value[k]);
  return out;
}

function selftest(casesPath) {
  const path = casesPath || '/app/conformance/equality-cases.json';
  let spec;
  try {
    spec = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    writeSync(1, `selftest: could not read ${path}: ${e.message}\n`);
    process.exit(1);
  }

  const failures = [];
  let checks = 0;

  for (const c of spec.equality || []) {
    const a = decodeFixture(c.a);
    const b = decodeFixture(c.b);
    const want = c.equal === true;

    const got = deepEqual(a, b);
    checks++;
    if (got !== want) failures.push(`equality/${c.name}: expected ${want}, got ${got}`);

    // Symmetry and reflexivity are not in the fixture because they hold for
    // EVERY case; asserting them here triples the coverage for free, and they
    // are the two properties a hand-written comparator loses first.
    const swapped = deepEqual(b, a);
    checks++;
    if (swapped !== want) {
      failures.push(`equality/${c.name}: not symmetric — a~b ${got}, b~a ${swapped}`);
    }
    checks += 2;
    if (!deepEqual(a, a)) failures.push(`equality/${c.name}: a is not equal to itself`);
    if (!deepEqual(b, b)) failures.push(`equality/${c.name}: b is not equal to itself`);
  }

  for (const c of spec.serialization || []) {
    const res = canonicalJson(decodeFixture(c.value));
    checks++;
    if (!res.ok) {
      failures.push(`serialization/${c.name}: not serializable${res.note ? ` (${res.note})` : ''}`);
      continue;
    }
    if (res.json !== c.json) {
      failures.push(`serialization/${c.name}: expected ${c.json}, got ${res.json}`);
      continue;
    }
    // Round-trip: the emitted text must be strict JSON that parses back to an
    // equal value. This is the property bank.service.ts depends on when it
    // adopts `actual` as the stored `expected`.
    checks++;
    let reparsed;
    try {
      reparsed = JSON.parse(res.json);
    } catch (e) {
      failures.push(`serialization/${c.name}: emitted text is not valid JSON — ${e.message}`);
      continue;
    }
    if (!deepEqual(reparsed, decodeFixture(c.value))) {
      failures.push(`serialization/${c.name}: does not survive a JSON round-trip`);
    }
  }

  const header = `selftest: javascript runner vs ${path} (fixture v${spec.version})\n`;
  if (failures.length === 0) {
    writeSync(1, `${header}  PASS — ${checks} checks over ` +
      `${(spec.equality || []).length} equality and ${(spec.serialization || []).length} serialization cases\n`);
    process.exit(0);
  }
  writeSync(1, `${header}  FAIL — ${failures.length} of ${checks} checks disagree with the shared spec:\n`);
  for (const f of failures) writeSync(1, `    ${f}\n`);
  process.exit(1);
}

// =============================================================================
// Main
// =============================================================================

const argv = process.argv.slice(2);

if (argv[0] === '--selftest') {
  selftest(argv[1]);
}

const [solutionPath, testsPath] = argv;
if (!solutionPath || !testsPath) {
  fail(PHASE_LOAD, 'runner: missing solution or tests path argument');
}

let userCode;
let spec;
try {
  userCode = readFileSync(solutionPath, 'utf8');
} catch (e) {
  fail(PHASE_LOAD, `runner: could not read solution: ${e.message}`);
}
try {
  spec = JSON.parse(readFileSync(testsPath, 'utf8'));
} catch (e) {
  fail(PHASE_LOAD, `runner: could not parse tests json: ${e.message}`);
}

const functionName = spec.functionName;
const tests = Array.isArray(spec.tests) ? spec.tests : [];
if (!functionName) fail(PHASE_LOAD, 'runner: tests json missing functionName');

// --- compile -----------------------------------------------------------------
// `new Function` PARSES the source at construction and only executes it when
// called, which splits the two failure modes cleanly: a SyntaxError here means
// the source does not parse (phase "compile" — the analogue of a javac
// diagnostic), while anything thrown by the call below happened while the code
// was defining itself (phase "load").
let factory;
try {
  // eslint-disable-next-line no-new-func
  factory = new Function(
    `${userCode}\n;return (typeof ${functionName} !== "undefined") ? ${functionName} : undefined;`
  );
} catch (e) {
  fail(PHASE_COMPILE, `${e.name}: ${e.message}`);
}

// --- load --------------------------------------------------------------------
// Top-level user code runs HERE, so this is the first window that needs a
// capture: a solution whose module scope logs a banner would otherwise print it
// straight into the payload.
let fn;
beginCapture();
try {
  fn = factory();
} catch (e) {
  const printed = endCapture();
  fail(PHASE_LOAD, `runner: your code failed to load: ${e.message}`, printed);
}
const loadStdout = endCapture();

if (typeof fn !== 'function') {
  fail(
    PHASE_LOAD,
    `runner: expected a function named "${functionName}" but it was not defined`,
    loadStdout
  );
}

// --- run ---------------------------------------------------------------------
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

  beginCapture();
  try {
    // Deep-clone args so a mutating solution can't corrupt the next test.
    const callArgs = JSON.parse(JSON.stringify(args));
    actual = fn(...callArgs);
    // An async solution used to be compared as a pending Promise object and
    // failed every test with a diff nobody could read. Awaiting a thenable is
    // a no-op for the synchronous case.
    if (actual !== null && typeof actual === 'object' && typeof actual.then === 'function') {
      actual = await actual;
    }
    passed = deepEqual(actual, expected);
  } catch (e) {
    stderr = e && e.message ? `${e.name}: ${e.message}` : String(e);
  }
  const printed = endCapture();
  const timeMs = Number(process.hrtime.bigint() - start) / 1e6;

  const expectedJson = canonicalJson(expected);
  const actualJson = stderr ? { ok: false } : canonicalJson(actual);
  if (!stderr && actualJson.ok === false && actualJson.note) {
    // Only a genuine serialization failure (circular, BigInt, a throwing
    // toJSON) becomes an error. A plain `undefined` return carries no note and
    // stays an ordinary wrong answer.
    stderr = `runner: ${actualJson.note}`;
    passed = false;
  }

  results.push({
    name,
    passed,
    expected: expectedJson.ok ? expectedJson.json : undefined,
    actual: actualJson.ok ? actualJson.json : undefined,
    stderr,
    stdout: printed,
    timeMs: Math.round(timeMs * 1000) / 1000,
  });
  if (passed) passedCount++;
}

emit({
  phase: PHASE_RUN,
  results,
  passed: passedCount,
  total: results.length,
  stdout: loadStdout,
});
