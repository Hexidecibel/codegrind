// =============================================================================
// examples.service — the worked examples are checked against the reference too
// =============================================================================
// A problem's `examples` ({input, output, explanation}) are the first thing a
// player reads, and until this file they were the one part of a problem nothing
// ever ran. `canonicalize` (bank.service) makes every TEST agree with the
// reference by construction; the examples were model-written prose rendered
// straight onto the page. A review of the bank (2026-10-29) found ~71 of 242
// problems showing at least one example whose output contradicts the reference
// — Widest Valley says 0 where the answer is 2, Draining Two Reservoirs says 2
// where it is -1 — and an explanation arguing for the wrong number, which is
// worse than no example at all: the player trusts it over their own code.
//
// So the examples get the same treatment as the tests: parse each one's input
// into an argument list, run the reference on it in ONE sandbox call, and
// compare. A wrong output is replaced by the reference's (and its explanation
// rewritten by the caller's `explain`); an example that cannot be parsed or
// that the reference errors on is dropped when a good one remains, and
// otherwise replaced by one rendered from a canonical sample test.
//
// The parser is lenient on purpose — the stored inputs are prose, not JSON:
// `nums = [1, 2], k = 3` mostly, a bare value for one-argument functions,
// single-quoted strings, bare object keys, Python `True`/`None`. What it will
// not do is guess: an ellipsis, a `TreeNode(…)` constructor, or an argument
// whose shape differs from what the tests pass (a level-order tree array where
// the harness passes a node object) is `unparseable`, never silently run.
//
// Used by generateAndStore/dryRunGenerate (new problems) and bin/audit-problems
// (the stored bank). No model call happens in here; `explain` is injected.

import JSON5 from 'json5';
import type { Example, ProblemRecord, TestCase } from '../../shared/types.js';
import type { Language } from '../../shared/languages.js';
import { stripPatternLeaks } from '../../shared/pattern-leak.js';
import { runTests } from './sandbox.service.js';

/** The fields of a problem this module reads. A GeneratedProblem + language fits. */
export type ExampleProblem = Pick<
  ProblemRecord,
  'language' | 'title' | 'prompt' | 'functionName' | 'starterCode' | 'referenceSolution' | 'examples' | 'sampleTests'
> & {
  /** Only read for argument shapes; the more tests, the fewer false mismatches. */
  hiddenTests?: TestCase[];
};

export type ExampleStatus = 'ok' | 'wrong' | 'unparseable' | 'ref-error';

export interface ExampleCheck {
  index: number;
  status: ExampleStatus;
  /** The reference's return value (parsed), for `ok` and `wrong`. */
  actual?: unknown;
  /** Why it is `unparseable` / `ref-error`. */
  reason?: string;
}

/** The sandbox could not run the reference at all — infrastructure, not data. */
export class SandboxUnavailableError extends Error {
  constructor(detail: string) {
    super(`sandbox unavailable: ${detail}`);
    this.name = 'SandboxUnavailableError';
  }
}

// -----------------------------------------------------------------------------
// Scanning helpers — top-level splits that respect brackets and string literals
// -----------------------------------------------------------------------------
const OPEN = '([{';
const CLOSE = ')]}';

/** Split on `sep` at bracket depth 0, outside string literals. */
function splitTopLevel(text: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    else if (c === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** The text between the `(` at `open` and its matching `)`, or null. */
function balancedParens(text: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// -----------------------------------------------------------------------------
// paramNames — the function's parameter names, in order, from the starter code
// -----------------------------------------------------------------------------
export function paramNames(language: Language, starterCode: string, functionName: string): string[] {
  const fn = escapeRe(functionName);
  const heads: RegExp[] =
    language === 'python'
      ? [new RegExp(`def\\s+${fn}\\s*\\(`)]
      : language === 'go'
        ? [new RegExp(`func\\s+${fn}\\s*\\(`)]
        : [
            new RegExp(`function\\s*\\*?\\s*${fn}\\s*\\(`),
            new RegExp(`\\b${fn}\\s*=\\s*(?:async\\s*)?(?:function\\s*)?\\(`),
            new RegExp(`\\b${fn}\\s*\\(`),
          ];
  let inner: string | null = null;
  for (const re of heads) {
    const m = re.exec(starterCode);
    if (!m) continue;
    inner = balancedParens(starterCode, m.index + m[0].length - 1);
    if (inner !== null) break;
  }
  if (inner === null || !inner.trim()) return [];

  const names: string[] = [];
  splitTopLevel(inner).forEach((raw, i) => {
    let p = raw.trim();
    if (!p) return;
    if (language === 'python') {
      if (p === '*' || p === '/' || p === 'self' || p === 'cls') return;
      p = p.replace(/^\*{1,2}/, '').split(/[:=]/)[0].trim();
    } else if (language === 'go') {
      // `a []int`, or `a` alone when grouped (`a, b int`): the first word.
      p = p.split(/\s+/)[0];
    } else {
      p = p.replace(/^\.\.\./, '').split(/[:=]/)[0].trim();
    }
    names.push(/^[A-Za-z_$][\w$]*$/.test(p) ? p : `arg${i + 1}`);
  });
  return names;
}

// -----------------------------------------------------------------------------
// Literals — lenient JSON5, plus the Python / Go spellings of true/false/null
// -----------------------------------------------------------------------------
const WORD_MAP: Record<string, string> = { True: 'true', False: 'false', None: 'null', nil: 'null' };

/** Rewrite True/False/None/nil outside string literals. */
function normalizeWords(text: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      out += c;
      if (c === '\\' && i + 1 < text.length) out += text[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    const m = /^[A-Za-z_]\w*/.exec(text.slice(i));
    if (m && (i === 0 || !/[\w$]/.test(text[i - 1]))) {
      out += WORD_MAP[m[0]] ?? m[0];
      i += m[0].length - 1;
      continue;
    }
    out += c;
  }
  return out;
}

export type LiteralResult = { ok: true; value: unknown } | { ok: false; reason: string };

/** One value literal, leniently. Never throws. */
export function parseLiteral(text: string): LiteralResult {
  const t = text.trim();
  if (!t) return { ok: false, reason: 'empty' };
  if (/\.\.\.|…/.test(t)) return { ok: false, reason: 'contains an ellipsis' };
  if (/\b(?:ListNode|TreeNode|Node)\s*\(|\bnew\s+[A-Z]/.test(t)) {
    return { ok: false, reason: 'constructor call, not a literal' };
  }
  try {
    return { ok: true, value: JSON5.parse(normalizeWords(t)) };
  } catch {
    return { ok: false, reason: `not a literal: ${t.length > 60 ? t.slice(0, 57) + '...' : t}` };
  }
}

// -----------------------------------------------------------------------------
// parseExampleInput — "nums = [1, 2], k = 3" → [[1, 2], 3]
// -----------------------------------------------------------------------------
export type ParsedInput = { ok: true; args: unknown[] } | { ok: false; reason: string };

const NAMED_ARG = /^\s*([A-Za-z_$][\w$]*)\s*=(?!=)([\s\S]*)$/;

export function parseExampleInputDetailed(input: string, params: string[]): ParsedInput {
  const text = input.trim().replace(/;\s*$/, '');
  if (!text) return { ok: false, reason: 'empty input' };

  // Rejoin comma pieces into arguments: a piece that opens with `name =` starts
  // a new one; anything else was a comma inside an unbracketed value.
  const pieces = splitTopLevel(text);
  if (NAMED_ARG.test(pieces[0])) {
    const named: Array<{ name: string; value: string }> = [];
    for (const piece of pieces) {
      const m = NAMED_ARG.exec(piece);
      if (m) named.push({ name: m[1], value: m[2] });
      else named[named.length - 1].value += ',' + piece;
    }
    const values: unknown[] = [];
    for (const n of named) {
      const lit = parseLiteral(n.value);
      if (!lit.ok) return { ok: false, reason: `${n.name}: ${lit.reason}` };
      values.push(lit.value);
    }
    const names = named.map((n) => n.name);
    if (params.length && names.every((n) => params.includes(n)) && params.every((p) => names.includes(p))) {
      return { ok: true, args: params.map((p) => values[names.indexOf(p)]) };
    }
    // Names that do not match the signature (camelCase vs snake_case, a typo)
    // but the right number of them: positional, as written. A starter with no
    // readable signature at all gets the same; the caller checks the count
    // against what the tests pass.
    if (named.length === params.length || params.length === 0) return { ok: true, args: values };
    return {
      ok: false,
      reason: `named ${names.join(', ')} but the function takes (${params.join(', ')})`,
    };
  }

  // A bare value.
  if (params.length === 1) {
    const lit = parseLiteral(text);
    return lit.ok ? { ok: true, args: [lit.value] } : { ok: false, reason: lit.reason };
  }
  if (params.length > 1) {
    const lit = parseLiteral(`[${text}]`);
    if (lit.ok && Array.isArray(lit.value) && lit.value.length === params.length) {
      return { ok: true, args: lit.value };
    }
    return { ok: false, reason: `bare value for a ${params.length}-argument function` };
  }
  return { ok: false, reason: 'could not read the function signature' };
}

export function parseExampleInput(input: string, params: string[]): unknown[] | null {
  const r = parseExampleInputDetailed(input, params);
  return r.ok ? r.args : null;
}

// -----------------------------------------------------------------------------
// Comparison
// -----------------------------------------------------------------------------
type Kind = 'array' | 'object' | 'number' | 'string' | 'boolean' | 'null' | 'other';
function kindOf(v: unknown): Kind {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  return t === 'number' || t === 'string' || t === 'boolean' || t === 'object' ? (t as Kind) : 'other';
}

/** What the tests pass at each argument position: its kinds, and its array elements' kinds. */
interface ArgShape {
  kinds: Set<Kind>;
  elements: Set<Kind>;
}

function argShapes(tests: TestCase[]): ArgShape[] {
  const shapes: ArgShape[] = [];
  for (const t of tests) {
    t.args.forEach((a, i) => {
      const s = (shapes[i] ??= { kinds: new Set(), elements: new Set() });
      s.kinds.add(kindOf(a));
      if (Array.isArray(a)) for (const e of a) if (e !== null) s.elements.add(kindOf(e));
    });
  }
  return shapes;
}

const article = (k: string) => `${/^[ao]/.test(k) ? 'an' : 'a'} ${k}`;

/**
 * Does an example's argument have a shape the tests pass? Judged against EVERY
 * test, so a mixed array (numbers and "VOID") is not a mismatch for having
 * started with a number. A null on either side proves nothing (an empty tree,
 * an optional). One level of array element is checked too — a level-order
 * `[1, 2, null]` tree where the tests pass node objects is the case it exists for.
 */
function shapeMismatch(arg: unknown, shape: ArgShape | undefined): string | null {
  if (!shape) return null;
  const a = kindOf(arg);
  if (a === 'null' || shape.kinds.has('null') && shape.kinds.size === 1) return null;
  if (!shape.kinds.has(a)) return `${a} where the tests pass ${[...shape.kinds].filter((k) => k !== 'null').map(article).join(' or ')}`;
  if (a === 'array' && shape.elements.size) {
    const odd = (arg as unknown[]).find((e) => e !== null && !shape.elements.has(kindOf(e)));
    if (odd !== undefined) {
      return `array of ${kindOf(odd)} where the tests pass an array of ${[...shape.elements].join(' / ')}`;
    }
  }
  return null;
}

function decimals(n: number): number {
  const s = String(n);
  if (/e/i.test(s)) return 0;
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * The example's value (`shown`) against the reference's (`actual`). Order
 * matters, as it does in every runner's deepEqual. Numbers forgive float noise,
 * and a shown fraction forgives display rounding (0.33 for 0.3333…).
 */
function valuesMatch(shown: unknown, actual: unknown, rounding = true): boolean {
  if (typeof shown === 'number' && typeof actual === 'number') {
    if (shown === actual) return true;
    if (!Number.isFinite(shown) || !Number.isFinite(actual)) return Number.isNaN(shown) && Number.isNaN(actual);
    if (Math.abs(shown - actual) <= 1e-9 * Math.max(1, Math.abs(shown), Math.abs(actual))) return true;
    if (!rounding) return false;
    const d = decimals(shown);
    return d > 0 && !Number.isInteger(actual) && Number(actual.toFixed(d)) === shown;
  }
  if (shown === actual) return true;
  if (shown === null || actual === null || typeof shown !== 'object' || typeof actual !== 'object') return false;
  if (Array.isArray(shown) !== Array.isArray(actual)) return false;
  if (Array.isArray(shown)) {
    const a = actual as unknown[];
    return shown.length === a.length && shown.every((x, i) => valuesMatch(x, a[i], rounding));
  }
  const sk = Object.keys(shown as object);
  const ak = Object.keys(actual as object);
  return (
    sk.length === ak.length &&
    sk.every((k) => Object.prototype.hasOwnProperty.call(actual, k) &&
      valuesMatch((shown as Record<string, unknown>)[k], (actual as Record<string, unknown>)[k], rounding))
  );
}

/** Two returned values, as a runner's deepEqual sees them (float noise forgiven, nothing else). */
export function sameValue(a: unknown, b: unknown): boolean {
  return valuesMatch(a, b, false);
}

const squash = (s: string) => s.replace(/\s+/g, '').replace(/'/g, '"');

/** Does the example's `output` text say what the reference returned? */
export function outputMatches(output: string, actual: unknown, language: Language): boolean {
  const lit = parseLiteral(output);
  if (lit.ok && valuesMatch(lit.value, actual)) return true;
  if (typeof actual === 'string') {
    const t = output.trim();
    const unquoted = /^(["'`]).*\1$/s.test(t) ? t.slice(1, -1) : t;
    if (unquoted === actual) return true;
  }
  const o = squash(output);
  return o === squash(JSON.stringify(actual) ?? '') || o === squash(renderValue(actual, language));
}

// -----------------------------------------------------------------------------
// Rendering — a value as the problem's language would write it
// -----------------------------------------------------------------------------
export function renderValue(v: unknown, language: Language): string {
  const py = language === 'python';
  if (v === null || v === undefined) return py ? 'None' : language === 'go' ? 'nil' : 'null';
  if (typeof v === 'boolean') return py ? (v ? 'True' : 'False') : String(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => renderValue(x, language)).join(', ')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // The runners' NaN / Infinity sentinels (test-harness/conformance).
    if (Object.keys(o).length === 1 && typeof o.$cg === 'string') {
      const s = { nan: 'NaN', inf: 'Infinity', '-inf': '-Infinity', '-zero': '-0' }[o.$cg as string];
      if (s) return py ? `float('${s.toLowerCase()}')` : s;
    }
    return `{${Object.entries(o).map(([k, x]) => `${JSON.stringify(k)}: ${renderValue(x, language)}`).join(', ')}}`;
  }
  return String(v);
}

/** A test case's args as an example input line: `nums = [1, 2], k = 3`. */
export function renderInput(args: unknown[], params: string[], language: Language): string {
  return args
    .map((a, i) => `${params[i] ?? `arg${i + 1}`} = ${renderValue(a, language)}`)
    .join(', ');
}

// -----------------------------------------------------------------------------
// validateExamples — one sandbox run for every parseable example
// -----------------------------------------------------------------------------
function firstLine(s: string): string {
  const l = s.trim().split('\n').find((x) => x.trim()) ?? '';
  return l.length > 160 ? l.slice(0, 157) + '...' : l;
}

/**
 * Check every example against the reference. One `runTests` call carries all
 * parseable examples plus a CONTROL — the first canonical sample test, which
 * the reference is known to pass. If the control errors too, the run is
 * retried once with the control alone: still failing means the sandbox is
 * down (SandboxUnavailableError), passing means an example input broke the
 * whole batch (a timeout), and each example is then run on its own.
 */
export async function validateExamples(problem: ExampleProblem): Promise<ExampleCheck[]> {
  const { language, functionName, referenceSolution } = problem;
  const params = paramNames(language, problem.starterCode, functionName);
  const ref = problem.sampleTests[0]?.args;
  const shapes = argShapes([...problem.sampleTests, ...(problem.hiddenTests ?? [])]);

  const checks: ExampleCheck[] = [];
  const toRun: Array<{ index: number; args: unknown[] }> = [];
  problem.examples.forEach((ex, index) => {
    const parsed = parseExampleInputDetailed(ex.input, params);
    if (!parsed.ok) {
      checks.push({ index, status: 'unparseable', reason: parsed.reason });
      return;
    }
    if (ref && ref.length !== parsed.args.length) {
      checks.push({
        index,
        status: 'unparseable',
        reason: `${parsed.args.length} argument(s) where the tests pass ${ref.length}`,
      });
      return;
    }
    const mi = parsed.args.findIndex((a, i) => shapeMismatch(a, shapes[i]));
    if (mi >= 0) {
      const why = shapeMismatch(parsed.args[mi], shapes[mi]);
      checks.push({ index, status: 'unparseable', reason: `${params[mi] ?? `arg${mi + 1}`}: ${why}` });
      return;
    }
    checks.push({ index, status: 'ok' }); // provisional, settled below
    toRun.push({ index, args: parsed.args });
  });
  if (toRun.length === 0) return checks;

  const control: TestCase | undefined = problem.sampleTests[0]
    ? { name: 'control', args: problem.sampleTests[0].args, expected: problem.sampleTests[0].expected }
    : undefined;
  const asTests = (items: typeof toRun): TestCase[] =>
    items.map((t) => ({ name: `example_${t.index + 1}`, args: t.args, expected: null }));
  const run = (tests: TestCase[]) => runTests({ language, functionName, userCode: referenceSolution, tests });
  const controlFailed = (r: { stderr?: string; actual?: string } | undefined) =>
    !r || !!r.stderr || typeof r.actual !== 'string';

  let results: Array<{ stderr?: string; actual?: string } | undefined>;
  const batch = await run(control ? [control, ...asTests(toRun)] : asTests(toRun));
  if (control && controlFailed(batch.results[0])) {
    const alone = await run([control]);
    if (controlFailed(alone.results[0])) {
      throw new SandboxUnavailableError(firstLine(alone.results[0]?.stderr ?? `verdict ${alone.verdict}`));
    }
    results = [];
    for (const t of toRun) results.push((await run(asTests([t]))).results[0]);
  } else {
    results = control ? batch.results.slice(1) : batch.results;
  }

  toRun.forEach((t, i) => {
    const check = checks.find((c) => c.index === t.index)!;
    const r = results[i];
    if (!r || r.stderr || typeof r.actual !== 'string') {
      check.status = 'ref-error';
      check.reason = r?.stderr ? firstLine(r.stderr) : 'no return value';
      return;
    }
    let actual: unknown;
    try {
      actual = JSON.parse(r.actual);
    } catch {
      check.status = 'ref-error';
      check.reason = 'unserializable return value';
      return;
    }
    check.actual = actual;
    check.status = outputMatches(problem.examples[t.index].output, actual, language) ? 'ok' : 'wrong';
  });
  return checks;
}

// -----------------------------------------------------------------------------
// fixExamples
// -----------------------------------------------------------------------------
/** Writes a short explanation of why `input` gives `output`. Injected — it is a model call. */
export type ExplainFn = (
  problem: ExampleProblem,
  example: { input: string; output: string }
) => Promise<string>;

export interface ExampleFix {
  examples: Example[];
  changed: boolean;
  /** One human line per change, for logs and the audit report. */
  actions: string[];
}

/**
 * Apply `validateExamples`' verdicts. `wrong` → the reference's output, and a
 * rewritten explanation when `explain` is given (none otherwise — a stale
 * explanation arguing for the old number is the thing being removed).
 * `unparseable` / `ref-error` → dropped while at least one good example
 * remains, otherwise each replaced by a distinct canonical sample test.
 */
export async function fixExamples(
  problem: ExampleProblem,
  checks: ExampleCheck[],
  opts: { explain?: ExplainFn | null } = {}
): Promise<ExampleFix> {
  const { language } = problem;
  const params = paramNames(language, problem.starterCode, problem.functionName);
  const actions: string[] = [];
  const explain = async (input: string, output: string): Promise<string | undefined> => {
    if (!opts.explain) return undefined;
    try {
      const text = stripPatternLeaks((await opts.explain(problem, { input, output })).trim());
      return text || undefined;
    } catch (err) {
      actions.push(`  (explanation rewrite failed: ${err instanceof Error ? err.message : err})`);
      return undefined;
    }
  };

  const byIndex = new Map(checks.map((c) => [c.index, c]));
  const kept: Array<Example | null> = [];
  for (let i = 0; i < problem.examples.length; i++) {
    const ex = problem.examples[i];
    const c = byIndex.get(i);
    if (!c || c.status === 'ok') {
      kept.push(ex);
    } else if (c.status === 'wrong') {
      const output = renderValue(c.actual, language);
      actions.push(`example ${i + 1}: output ${ex.output} → ${output}`);
      kept.push({ input: ex.input, output, explanation: await explain(ex.input, output) });
    } else {
      kept.push(null);
    }
  }

  const good = kept.filter((e): e is Example => e !== null);
  const bad = checks.filter((c) => c.status === 'unparseable' || c.status === 'ref-error');
  let examples: Example[];
  if (bad.length === 0) {
    examples = good;
  } else if (good.length > 0) {
    for (const c of bad) actions.push(`example ${c.index + 1}: dropped (${c.status}: ${c.reason ?? ''})`);
    examples = good;
  } else {
    // Nothing trustworthy left: rebuild from the canonical sample tests, one
    // per bad example, in order, without repeats.
    examples = [];
    bad.forEach((c, n) => {
      const t = problem.sampleTests[n];
      if (!t) {
        actions.push(`example ${c.index + 1}: dropped (${c.status}: ${c.reason ?? ''}; no sample test left to replace it)`);
        return;
      }
      examples.push({ input: renderInput(t.args, params, language), output: renderValue(t.expected, language) });
      actions.push(`example ${c.index + 1}: replaced from sample test "${t.name}" (${c.status}: ${c.reason ?? ''})`);
    });
    for (const e of examples) e.explanation = await explain(e.input, e.output);
  }

  const changed = JSON.stringify(examples) !== JSON.stringify(problem.examples);
  return { examples, changed, actions };
}
