// Audit the stored problem bank against its own reference solutions. Run via
// bin/audit-problems.
//
//   bin/audit-problems --dry-run           # report only (the default): no DB writes, no model calls
//   bin/audit-problems --apply             # back up, then fix examples (+ explanation rewrites)
//   bin/audit-problems --crosscheck        # also check every reference against a brute force
//   bin/audit-problems --id <id> --verbose # one problem, every example
//   bin/audit-problems --limit 20
//
// WHAT IT CHECKS. Each problem's examples[] — the worked examples printed on the
// problem page — are run through referenceSolution in the sandbox and compared
// with what they claim (examples.service). Until 2026-10-29 nothing ever did
// this: tests were canonicalized against the reference, examples were stored as
// the model wrote them, and ~71 of 242 problems showed at least one wrong one.
// New problems are verified at generation (bank.service); this repairs the rows
// already stored, the same way strip-pattern-leaks repaired the statements.
//
//   ok           the reference returns what the example says
//   wrong        it returns something else → output replaced, explanation
//                rewritten (one small model call each, --apply only)
//   unparseable  the input cannot be read as an argument list (ellipsis, a
//                linked-list arrow, an argument missing) → dropped, or rebuilt
//                from a canonical sample test if nothing good is left
//   ref-error    the reference throws on it → same as unparseable
//
// It also lists statements that still carry a worked example of their own
// (those are prose, and get fixed by hand), and starters whose signature does
// not match what the tests pass.
//
// --crosscheck asks a model for an INDEPENDENT brute force (statement and
// signature only — never the reference or the tests) and runs it on every
// small stored test. A disagreement marks the problem `suspect`. Nothing is
// rewritten for a suspect: a reference that misread its own statement is a
// judgement call, made by hand. With --apply --crosscheck together, a suspect
// problem's examples are held back too (they would be "fixed" to agree with the
// reference under suspicion).
//
// --dry-run opens the database READ-ONLY and imports nothing that could write
// to it or call a model. --apply is idempotent: a second run reports all ok.
// The report lands in data/tmp/audit-problems-<ts>.{json,md}.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Example, TestCase } from '../src/shared/types.js';
import { isLanguage, type Language } from '../src/shared/languages.js';
import { runTests } from '../src/server/services/sandbox.service.js';
import {
  validateExamples,
  fixExamples,
  paramNames,
  sameValue,
  SandboxUnavailableError,
  type ExampleCheck,
  type ExampleProblem,
  type ExplainFn,
} from '../src/server/services/examples.service.js';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
interface Args {
  apply: boolean;
  crosscheck: boolean;
  id: string | null;
  limit: number | null;
  verbose: boolean;
}

function usage(code = 0): never {
  console.log(
    [
      'usage: bin/audit-problems [--dry-run | --apply] [--crosscheck] [--id ID] [--limit N] [--verbose]',
      '',
      '  --dry-run      report only (default): read-only DB, no model calls',
      '  --apply        back up the DB, then write corrected examples',
      '  --crosscheck   also run a model-written brute force against every stored test',
      '  --id ID        one problem',
      '  --limit N      the first N problems (oldest first)',
      '  --verbose      print every example, not only the ones that change',
    ].join('\n')
  );
  process.exit(code);
}

function parseArgs(argv: string[]): Args {
  const a: Args = { apply: false, crosscheck: false, id: null, limit: null, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--dry-run') a.apply = false;
    else if (f === '--apply') a.apply = true;
    else if (f === '--crosscheck') a.crosscheck = true;
    else if (f === '--verbose') a.verbose = true;
    else if (f === '--id') a.id = argv[++i] ?? usage(1);
    else if (f === '--limit') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) usage(1);
      a.limit = n;
    } else if (f === '-h' || f === '--help') usage();
    else {
      console.error(`unknown flag: ${f}`);
      usage(1);
    }
  }
  if (argv.includes('--dry-run') && a.apply) {
    console.error('--dry-run and --apply are mutually exclusive');
    process.exit(1);
  }
  return a;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------
interface Row {
  id: string;
  language: string;
  title: string;
  prompt: string;
  constraints: string;
  examples: string;
  starterCode: string;
  functionName: string;
  sampleTests: string;
  hiddenTests: string;
  referenceSolution: string;
}

interface Problem extends ExampleProblem {
  id: string;
  constraints: string[];
  hiddenTests: TestCase[];
}

function toProblem(r: Row): Problem {
  if (!isLanguage(r.language)) throw new Error(`${r.id}: unknown language ${r.language}`);
  return {
    id: r.id,
    language: r.language,
    title: r.title,
    prompt: r.prompt,
    constraints: JSON.parse(r.constraints) as string[],
    examples: JSON.parse(r.examples) as Example[],
    starterCode: r.starterCode,
    functionName: r.functionName,
    sampleTests: JSON.parse(r.sampleTests) as TestCase[],
    hiddenTests: JSON.parse(r.hiddenTests) as TestCase[],
    referenceSolution: r.referenceSolution,
  };
}

// ---------------------------------------------------------------------------
// Statements that still carry their own worked example
// ---------------------------------------------------------------------------
// stripExampleSections (shared/pattern-leak) removes the headed and bold-lead-in
// shapes at generation; these are the shapes it does not, found by reading the
// bank. Reported only — rewording prose is a by-hand job.
const LEFTOVER_PATTERNS: RegExp[] = [
  /^\s*(?:[-*]\s*)?(?:\*\*|__)?(?:input|output)(?:\*\*|__)?\s*:/i,
  /^#{1,6}\s+.*\bexamples?\b/i,
  /\bexample\s*\d*\s*(?:\*\*)?\s*:/i,
  /\b(?:for example|for instance|e\.g\.)\b.*(?:→|->|=>|\breturns?\b|\bgives\b|\bshould be\b|\bthe answer is\b)/i,
];

function leftoverExampleLines(prompt: string): string[] {
  let inFence = false;
  const out: string[] = [];
  for (const line of prompt.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (LEFTOVER_PATTERNS.some((re) => re.test(line))) {
      const t = line.trim();
      out.push(t.length > 160 ? t.slice(0, 157) + '...' : t);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cross-check — an independent brute force against the stored tests
// ---------------------------------------------------------------------------
/** A test small enough that a brute force should finish it. */
const SMALL_ARGS_CHARS = 300;

interface Disagreement {
  test: string;
  args: unknown[];
  expected: unknown;
  brute: unknown;
}

interface CrossCheck {
  status: 'agrees' | 'suspect' | 'inconclusive';
  ran: number;
  skipped: number;
  disagreements: Disagreement[];
  note?: string;
}

async function crossCheck(
  p: Problem,
  write: (p: Problem) => Promise<{ solution: string; notes: string }>
): Promise<CrossCheck> {
  const tests = [...p.sampleTests, ...p.hiddenTests].filter(
    (t) => JSON.stringify(t.args).length <= SMALL_ARGS_CHARS
  );
  const skippedLarge = p.sampleTests.length + p.hiddenTests.length - tests.length;
  if (tests.length === 0) {
    return { status: 'inconclusive', ran: 0, skipped: skippedLarge, disagreements: [], note: 'no small tests' };
  }
  let brute: { solution: string; notes: string };
  try {
    brute = await write(p);
  } catch (err) {
    return {
      status: 'inconclusive', ran: 0, skipped: skippedLarge, disagreements: [],
      note: `brute force not written: ${err instanceof Error ? err.message : err}`,
    };
  }
  if (!brute.solution.trim()) {
    return { status: 'inconclusive', ran: 0, skipped: skippedLarge, disagreements: [], note: 'empty brute force' };
  }

  const run = (ts: TestCase[]) =>
    runTests({ language: p.language, functionName: p.functionName, userCode: brute.solution, tests: ts });
  let res = await run(tests);
  if (res.verdict === 'compile_error') {
    return {
      status: 'inconclusive', ran: 0, skipped: skippedLarge, disagreements: [],
      note: `brute force does not compile: ${res.results[0]?.stderr?.split('\n')[0] ?? ''}`,
    };
  }
  // A whole-run timeout loses every result: run the cases one by one, and
  // skip the ones that are still too slow.
  let results = res.results;
  if (res.verdict === 'timeout') {
    results = [];
    for (const t of tests) {
      res = await run([t]);
      results.push(res.verdict === 'timeout' ? { name: t.name, passed: false, stderr: 'timeout', timeMs: 0 } : res.results[0]);
    }
  }

  const disagreements: Disagreement[] = [];
  let ran = 0;
  let skipped = skippedLarge;
  tests.forEach((t, i) => {
    const r = results[i];
    if (!r || r.stderr || typeof r.actual !== 'string') {
      skipped++;
      return;
    }
    let actual: unknown;
    try {
      actual = JSON.parse(r.actual);
    } catch {
      skipped++;
      return;
    }
    ran++;
    if (!sameValue(t.expected, actual)) {
      disagreements.push({ test: t.name, args: t.args, expected: t.expected, brute: actual });
    }
  });
  if (ran === 0) {
    return { status: 'inconclusive', ran, skipped, disagreements, note: 'brute force errored on every test' };
  }
  return {
    status: disagreements.length ? 'suspect' : 'agrees',
    ran,
    skipped,
    disagreements,
    note: brute.notes || undefined,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
interface ProblemReport {
  id: string;
  title: string;
  language: Language;
  outcome: 'ok' | 'fixed' | 'would-fix' | 'error';
  counts: Record<ExampleCheck['status'], number>;
  examples: Array<{
    index: number;
    status: ExampleCheck['status'];
    input: string;
    shown: string;
    reference?: string;
    reason?: string;
  }>;
  actions: string[];
  proposed?: Example[];
  promptLeftovers: string[];
  signatureNote?: string;
  error?: string;
  crosscheck?: CrossCheck;
}

const show = (v: unknown) => (v === undefined ? 'undefined' : JSON.stringify(v));

function markdown(meta: Record<string, unknown>, reports: ProblemReport[]): string {
  const L: string[] = [];
  const t = meta.totals as Record<string, number>;
  L.push(`# Problem audit — ${meta.mode}`, '');
  L.push(`Generated ${meta.at}. ${reports.length} problem(s) checked.`, '');
  L.push('| | problems | examples |', '|---|---|---|');
  for (const k of ['ok', 'wrong', 'unparseable', 'ref-error'] as const) {
    L.push(`| ${k} | ${t[`problems_${k}`]} | ${t[`examples_${k}`]} |`);
  }
  L.push(`| ${meta.mode === 'apply' ? 'changed' : 'would change'} | ${t.problems_changed} | |`, '');

  const changed = reports.filter((r) => r.outcome === 'fixed' || r.outcome === 'would-fix');
  L.push(`## Examples ${meta.mode === 'apply' ? 'fixed' : 'that would be fixed'} (${changed.length})`, '');
  for (const r of changed) {
    L.push(`### ${r.title} — \`${r.id}\` (${r.language})`, '');
    for (const e of r.examples.filter((e) => e.status !== 'ok')) {
      L.push(
        `- ex${e.index + 1} **${e.status}**: \`${e.input}\` shows \`${e.shown}\`` +
          (e.reference !== undefined ? `, reference returns \`${e.reference}\`` : '') +
          (e.reason ? ` — ${e.reason}` : '')
      );
    }
    for (const a of r.actions) L.push(`  - ${a}`);
    L.push('');
  }

  const errs = reports.filter((r) => r.outcome === 'error');
  if (errs.length) {
    L.push(`## Could not be checked (${errs.length})`, '');
    for (const r of errs) L.push(`- \`${r.id}\` ${r.title}: ${r.error}`);
    L.push('');
  }

  const sig = reports.filter((r) => r.signatureNote);
  if (sig.length) {
    L.push(`## Starter signature does not match the tests (${sig.length})`, '');
    for (const r of sig) L.push(`- \`${r.id}\` ${r.title}: ${r.signatureNote}`);
    L.push('');
  }

  const left = reports.filter((r) => r.promptLeftovers.length);
  L.push(`## Statements that still carry a worked example (${left.length}) — fix by hand`, '');
  for (const r of left) {
    L.push(`- \`${r.id}\` ${r.title}`);
    for (const l of r.promptLeftovers) L.push(`  - \`${l.replace(/`/g, "'")}\``);
  }
  L.push('');

  const xc = reports.filter((r) => r.crosscheck);
  if (xc.length) {
    const sus = xc.filter((r) => r.crosscheck!.status === 'suspect');
    const inc = xc.filter((r) => r.crosscheck!.status === 'inconclusive');
    L.push(`## Cross-check: ${sus.length} suspect, ${inc.length} inconclusive, ${xc.length - sus.length - inc.length} agree`, '');
    for (const r of sus) {
      const c = r.crosscheck!;
      L.push(`### SUSPECT ${r.title} — \`${r.id}\` (${c.disagreements.length}/${c.ran} disagree)`, '');
      if (c.note) L.push(`Brute force's reading: ${c.note}`, '');
      for (const d of c.disagreements.slice(0, 5)) {
        L.push(`- ${d.test}: args \`${show(d.args)}\` — reference \`${show(d.expected)}\`, brute force \`${show(d.brute)}\``);
      }
      L.push('');
    }
    for (const r of inc) L.push(`- inconclusive \`${r.id}\` ${r.title}: ${r.crosscheck!.note ?? ''}`);
    L.push('');
  }
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function preflight(): Promise<void> {
  const res = await runTests({
    language: 'javascript',
    functionName: 'plusOne',
    userCode: 'function plusOne(n) { return n + 1; }',
    tests: [{ name: 'preflight', args: [1], expected: 2 }],
  });
  if (res.results[0]?.actual !== '2') {
    console.error(
      `Sandbox preflight failed (${res.verdict}): ${res.results[0]?.stderr ?? 'no output'}\n` +
        'Nothing was checked. Fix the sandbox first (bin/status, bin/build-runner-image).'
    );
    process.exit(2);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.apply ? 'apply' : 'dry-run';
  const dataDir = process.env.DATA_DIR || './data';
  const dbPath = path.join(dataDir, 'codegrind.db');

  // Read-only unless writing: a dry run must not be able to write, not merely
  // promise not to. db.ts (which migrates on open) is only loaded by --apply.
  const ro = new Database(dbPath, { readonly: true, fileMustExist: true });
  let sql = `SELECT id, language, title, prompt, constraints, examples, starterCode, functionName,
                    sampleTests, hiddenTests, referenceSolution FROM problems`;
  const params: unknown[] = [];
  if (args.id) {
    sql += ' WHERE id = ?';
    params.push(args.id);
  }
  sql += ' ORDER BY createdAt, id';
  if (args.limit) sql += ` LIMIT ${args.limit}`;
  const rows = ro.prepare(sql).all(...params) as Row[];
  ro.close();
  if (rows.length === 0) {
    console.error(args.id ? `no problem with id ${args.id}` : 'no problems in the bank');
    process.exit(1);
  }

  await preflight();

  // Model calls only when something will spend them.
  let explain: ExplainFn | null = null;
  let brute: ((p: Problem) => Promise<{ solution: string; notes: string }>) | null = null;
  let write: { db: import('better-sqlite3').Database } | null = null;
  if (args.apply || args.crosscheck) {
    const { hydrate, isConfigured } = await import('../src/server/services/apikey.service.js');
    const { hydrateProviderConfig } = await import('../src/server/services/provider.service.js');
    const { needsAnthropicKey } = await import('../src/server/services/llm.client.js');
    hydrateProviderConfig();
    hydrate();
    if (needsAnthropicKey() && !isConfigured()) {
      console.error('No Anthropic API key is configured. Set ANTHROPIC_API_KEY, or paste one into the setup screen.');
      process.exit(1);
    }
    const llm = await import('../src/server/services/llm.examples.js');
    if (args.apply) explain = llm.rewriteExampleExplanation;
    if (args.crosscheck) brute = llm.writeBruteForce;
  }
  if (args.apply) write = { db: (await import('../src/server/services/db.js')).db };

  const reports: ProblemReport[] = [];
  const zero = () => ({ ok: 0, wrong: 0, unparseable: 0, 'ref-error': 0 });
  let n = 0;
  for (const row of rows) {
    n++;
    const p = toProblem(row);
    const rep: ProblemReport = {
      id: p.id, title: p.title, language: p.language, outcome: 'ok', counts: zero(),
      examples: [], actions: [], promptLeftovers: leftoverExampleLines(p.prompt),
    };
    const sigParams = paramNames(p.language, p.starterCode, p.functionName);
    const argc = p.sampleTests[0]?.args.length;
    if (argc !== undefined && sigParams.length !== argc) {
      rep.signatureNote = `starterCode declares (${sigParams.join(', ')}) but the tests pass ${argc} argument(s)`;
    }

    try {
      const checks = await validateExamples(p);
      for (const c of checks) {
        rep.counts[c.status]++;
        const ex = p.examples[c.index];
        rep.examples.push({
          index: c.index,
          status: c.status,
          input: ex.input,
          shown: ex.output,
          reference: c.status === 'ok' || c.status === 'wrong' ? show(c.actual) : undefined,
          reason: c.reason,
        });
      }
      // Cross-check BEFORE fixing: a "wrong" example is judged against the
      // reference, so if the reference itself is suspect, rewriting the
      // examples to agree with it would bake its mistake in. A suspect problem
      // is reported and held — never written — until it is fixed by hand.
      if (brute) rep.crosscheck = await crossCheck(p, brute);
      const held = rep.crosscheck?.status === 'suspect';
      const fix = await fixExamples(p, checks, { explain: held ? null : explain });
      rep.actions = fix.actions;
      if (fix.changed) {
        rep.outcome = args.apply && !held ? 'fixed' : 'would-fix';
        rep.proposed = fix.examples;
        if (held) rep.actions.push('HELD: the cross-check marks this reference suspect; examples not written');
        if (write && !held) {
          const db = write.db;
          db.transaction(() => {
            db.prepare('UPDATE problems SET examples = ? WHERE id = ?').run(JSON.stringify(fix.examples), p.id);
            // Both were computed from the statement AND the examples; the
            // wrong examples are gone, so is anything derived from them.
            db.prepare('DELETE FROM recognize_checks WHERE problemId = ?').run(p.id);
            db.prepare('DELETE FROM recognize_notes WHERE problemId = ?').run(p.id);
          })();
        }
      }
    } catch (err) {
      if (err instanceof SandboxUnavailableError) {
        console.error(`\n[${n}/${rows.length}] ${p.id}: ${err.message} — aborting; nothing after this was checked.`);
        process.exit(2);
      }
      rep.outcome = 'error';
      rep.error = err instanceof Error ? err.message : String(err);
    }

    const bad = rep.examples.filter((e) => e.status !== 'ok');
    const tag = rep.outcome === 'ok' ? 'ok  ' : rep.outcome === 'error' ? 'ERR ' : 'FIX ';
    const xc = rep.crosscheck ? ` [crosscheck: ${rep.crosscheck.status}]` : '';
    if (rep.outcome !== 'ok' || args.verbose || xc) {
      console.log(`[${n}/${rows.length}] ${tag} ${p.id} "${p.title}"${xc}${rep.error ? ` — ${rep.error}` : ''}`);
      for (const e of args.verbose ? rep.examples : bad) {
        console.log(
          `        ex${e.index + 1} ${e.status}: ${e.input} → shows ${e.shown}` +
            (e.reference !== undefined ? `, reference ${e.reference}` : '') +
            (e.reason ? ` (${e.reason})` : '')
        );
      }
    }
    reports.push(rep);
  }

  // Totals
  const totals: Record<string, number> = {};
  for (const k of ['ok', 'wrong', 'unparseable', 'ref-error'] as const) {
    totals[`examples_${k}`] = reports.reduce((s, r) => s + r.counts[k], 0);
    // A problem counts under the worst thing among its examples.
    totals[`problems_${k}`] = 0;
  }
  for (const r of reports) {
    const worst = r.counts.wrong ? 'wrong' : r.counts['ref-error'] ? 'ref-error' : r.counts.unparseable ? 'unparseable' : 'ok';
    totals[`problems_${worst}`]++;
  }
  totals.problems_changed = reports.filter((r) => r.outcome === 'fixed' || r.outcome === 'would-fix').length;
  totals.problems_error = reports.filter((r) => r.outcome === 'error').length;
  totals.prompt_leftovers = reports.filter((r) => r.promptLeftovers.length).length;
  if (args.crosscheck) {
    totals.crosscheck_suspect = reports.filter((r) => r.crosscheck?.status === 'suspect').length;
    totals.crosscheck_inconclusive = reports.filter((r) => r.crosscheck?.status === 'inconclusive').length;
  }

  const at = new Date().toISOString();
  const meta = { mode, crosscheck: args.crosscheck, at, totals };
  const outDir = path.resolve(dataDir, 'tmp');
  fs.mkdirSync(outDir, { recursive: true });
  const stem = path.join(outDir, `audit-problems-${at.replace(/[:.]/g, '-')}`);
  fs.writeFileSync(`${stem}.json`, JSON.stringify({ ...meta, problems: reports }, null, 2));
  fs.writeFileSync(`${stem}.md`, markdown(meta, reports));

  console.log(
    `\n${mode === 'dry-run' ? 'dry run — nothing written. ' : ''}` +
      `${rows.length} problem(s): ${totals.problems_ok} ok, ${totals.problems_wrong} with a wrong example, ` +
      `${totals.problems_unparseable} with an unparseable one, ${totals['problems_ref-error']} with a ref-error; ` +
      `${totals.problems_changed} ${mode === 'apply' ? 'changed' : 'would change'}` +
      (totals.problems_error ? `, ${totals.problems_error} could not be checked` : '') +
      `.\nexamples: ${totals.examples_ok} ok, ${totals.examples_wrong} wrong, ` +
      `${totals.examples_unparseable} unparseable, ${totals['examples_ref-error']} ref-error. ` +
      `${totals.prompt_leftovers} statement(s) still carry a worked example.` +
      (args.crosscheck ? `\ncrosscheck: ${totals.crosscheck_suspect} suspect, ${totals.crosscheck_inconclusive} inconclusive.` : '') +
      `\nreport: ${stem}.md (+ .json)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
