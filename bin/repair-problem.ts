// Hand-repair one or more banked problems from JSON patches. Run via
// bin/repair-problem.
//
//   bin/repair-problem --id ID --patch data/tmp/repairs/ID.json [--dry-run]
//   bin/repair-problem --patch a.json --patch b.json            # ids from the files
//
// bin/audit-problems fixes what a machine can judge and HOLDS what it cannot:
// a reference the brute-force cross-check disputes, a statement that admits two
// answers, a starter with the wrong signature. Those are decided by a person
// reading the statement, and written with this — never with ad-hoc SQL — so
// that every write goes through the same checks:
//
//   1. referenceSolution changed, or dropTests given → the tests are
//      re-canonicalized against the (new) reference with bank.canonicalize.
//      If too few survive, NOTHING is written.
//   2. the starter's parameter count must match what the tests pass.
//   3. the examples are run through the reference (examples.service). Examples
//      the patch supplies must ALL agree with it — they were written by hand,
//      so a disagreement is a mistake in the patch and the write is refused,
//      with the reference's output printed. Examples the patch leaves alone
//      are fixed the way bin/audit-problems fixes them (output replaced,
//      explanation rewritten by the model; --dry-run makes no model calls).
//   4. recognize_checks / recognize_notes for the problem are cleared — both
//      were derived from the old statement and examples.
//
// `retire: true` sets canonicalized = 0, which every bank read filters on
// (db.ts findUnusedProblem & co.): the row and its history stay, it is never
// served again. Nothing is deleted.
//
// --dry-run runs the sandbox and prints what would be written, but writes
// nothing and calls no model. (It does load db.ts, via bank.service.)
// bin/repair-problem backs the database up first unless --dry-run.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Example, TestCase } from '../src/shared/types.js';
import { isLanguage, type Language } from '../src/shared/languages.js';
import {
  validateExamples,
  fixExamples,
  paramNames,
  renderValue,
  type ExplainFn,
} from '../src/server/services/examples.service.js';
import { parsePatch, applyPatch, testDiff, type RepairPatch } from '../src/server/services/problem-repair.js';

interface Args {
  dryRun: boolean;
  id: string | null;
  patches: string[];
}

function usage(code = 0): never {
  console.log(
    [
      'usage: bin/repair-problem [--id ID] --patch FILE [--patch FILE ...] [--dry-run]',
      '',
      '  --id ID       the problem (only with a single --patch; otherwise each patch carries "id")',
      '  --patch FILE  JSON patch: prompt, constraints, starterCode, referenceSolution,',
      '                examples, dropTests, retire (see src/server/services/problem-repair.ts)',
      '  --dry-run     check everything, write nothing, call no model',
    ].join('\n')
  );
  process.exit(code);
}

function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, id: null, patches: [] };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--dry-run') a.dryRun = true;
    else if (f === '--id') a.id = argv[++i] ?? usage(1);
    else if (f === '--patch') a.patches.push(argv[++i] ?? usage(1));
    else if (f === '-h' || f === '--help') usage();
    else {
      console.error(`unknown flag: ${f}`);
      usage(1);
    }
  }
  if (a.patches.length === 0) usage(1);
  if (a.id && a.patches.length > 1) {
    console.error('--id only goes with a single --patch');
    process.exit(1);
  }
  return a;
}

interface Row {
  id: string;
  language: string;
  title: string;
  pattern: string;
  prompt: string;
  constraints: string;
  examples: string;
  starterCode: string;
  functionName: string;
  sampleTests: string;
  hiddenTests: string;
  referenceSolution: string;
  canonicalized: number;
}

interface Plan {
  id: string;
  title: string;
  retire: boolean;
  fields: {
    prompt: string;
    constraints: string[];
    starterCode: string;
    referenceSolution: string;
    examples: Example[];
    sampleTests: TestCase[];
    hiddenTests: TestCase[];
  };
  lines: string[];
}

class Refused extends Error {}

async function plan(
  row: Row,
  patch: RepairPatch,
  explain: ExplainFn | null,
  canonicalize: typeof import('../src/server/services/bank.service.js').canonicalize
): Promise<Plan> {
  if (!isLanguage(row.language)) throw new Refused(`unknown language ${row.language}`);
  const language: Language = row.language;
  const before = {
    prompt: row.prompt,
    constraints: JSON.parse(row.constraints) as string[],
    starterCode: row.starterCode,
    referenceSolution: row.referenceSolution,
    examples: JSON.parse(row.examples) as Example[],
    sampleTests: JSON.parse(row.sampleTests) as TestCase[],
    hiddenTests: JSON.parse(row.hiddenTests) as TestCase[],
  };
  const { problem, refChanged, testsChanged } = applyPatch(before, patch);
  const lines: string[] = [];
  for (const k of ['prompt', 'constraints', 'starterCode', 'referenceSolution'] as const) {
    if (JSON.stringify(problem[k]) !== JSON.stringify(before[k])) lines.push(`${k}: changed`);
  }

  if (patch.retire) {
    lines.push('retire: canonicalized 1 → 0 (never served again)');
    return { id: row.id, title: row.title, retire: true, fields: problem, lines };
  }

  // 1. Tests.
  if (refChanged || testsChanged) {
    const canon = await canonicalize(language, {
      title: row.title,
      prompt: problem.prompt,
      pattern: row.pattern,
      examples: problem.examples,
      constraints: problem.constraints,
      functionName: row.functionName,
      starterCode: problem.starterCode,
      sampleTests: problem.sampleTests,
      hiddenTests: problem.hiddenTests,
      referenceSolution: problem.referenceSolution,
    });
    if (!canon) throw new Refused('canonicalize failed: too few tests survive the reference (it errors on them)');
    const diff = testDiff([...before.sampleTests, ...before.hiddenTests], [...canon.sampleTests, ...canon.hiddenTests]);
    lines.push(
      `tests re-canonicalized: ${canon.sampleTests.length} sample + ${canon.hiddenTests.length} hidden` +
        (diff.length ? `, ${diff.length} changed:` : ', no expected value changed')
    );
    lines.push(...diff);
    problem.sampleTests = canon.sampleTests;
    problem.hiddenTests = canon.hiddenTests;
  }

  // 2. Signature.
  const params = paramNames(language, problem.starterCode, row.functionName);
  const argc = problem.sampleTests[0]?.args.length;
  if (argc !== undefined && params.length !== argc) {
    throw new Refused(`starterCode declares (${params.join(', ')}) but the tests pass ${argc} argument(s)`);
  }

  // 3. Examples.
  const exProblem = {
    language,
    title: row.title,
    prompt: problem.prompt,
    functionName: row.functionName,
    starterCode: problem.starterCode,
    referenceSolution: problem.referenceSolution,
    examples: problem.examples,
    sampleTests: problem.sampleTests,
    hiddenTests: problem.hiddenTests,
  };
  const checks = await validateExamples(exProblem);
  if (patch.examples) {
    const bad = checks.filter((c) => c.status !== 'ok');
    if (bad.length) {
      throw new Refused(
        'patch examples disagree with the reference:\n' +
          bad
            .map((c) => {
              const e = problem.examples[c.index];
              return (
                `  ex${c.index + 1} ${c.status}: ${e.input} → shows ${e.output}` +
                (c.status === 'wrong' ? `, reference returns ${renderValue(c.actual, language)}` : '') +
                (c.reason ? ` (${c.reason})` : '')
              );
            })
            .join('\n')
      );
    }
    lines.push(`examples: ${problem.examples.length} supplied, all agree with the reference`);
  } else {
    const fix = await fixExamples(exProblem, checks, { explain });
    if (fix.changed) {
      lines.push('examples fixed:', ...fix.actions.map((a) => `  - ${a}`));
      problem.examples = fix.examples;
    } else {
      lines.push(`examples: ${problem.examples.length} unchanged, all agree with the reference`);
    }
  }

  return { id: row.id, title: row.title, retire: false, fields: problem, lines };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = process.env.DATA_DIR || './data';
  const dbPath = path.join(dataDir, 'codegrind.db');

  const patches = args.patches.map((file) => {
    const patch = parsePatch(JSON.parse(fs.readFileSync(file, 'utf8')));
    const id = patch.id ?? args.id;
    if (!id) throw new Error(`${file}: no id (pass --id or put "id" in the patch)`);
    if (patch.id && args.id && patch.id !== args.id) throw new Error(`${file}: patch id ${patch.id} ≠ --id ${args.id}`);
    return { file, id, patch };
  });

  const ro = new Database(dbPath, { readonly: true, fileMustExist: true });
  const rows = new Map<string, Row>();
  for (const { id } of patches) {
    const r = ro
      .prepare(
        `SELECT id, language, title, pattern, prompt, constraints, examples, starterCode, functionName,
                sampleTests, hiddenTests, referenceSolution, canonicalized FROM problems WHERE id = ?`
      )
      .get(id) as Row | undefined;
    if (!r) throw new Error(`no problem with id ${id}`);
    rows.set(id, r);
  }
  ro.close();

  const { canonicalize } = await import('../src/server/services/bank.service.js');
  let explain: ExplainFn | null = null;
  if (!args.dryRun && patches.some((p) => !p.patch.retire && !p.patch.examples)) {
    const { hydrate, isConfigured } = await import('../src/server/services/apikey.service.js');
    const { hydrateProviderConfig } = await import('../src/server/services/provider.service.js');
    const { needsAnthropicKey } = await import('../src/server/services/llm.client.js');
    hydrateProviderConfig();
    hydrate();
    if (needsAnthropicKey() && !isConfigured()) {
      console.error('No Anthropic API key is configured (needed to rewrite explanations of fixed examples).');
      process.exit(1);
    }
    explain = (await import('../src/server/services/llm.examples.js')).rewriteExampleExplanation;
  }

  const plans: Plan[] = [];
  let refused = 0;
  for (const { file, id, patch } of patches) {
    const row = rows.get(id)!;
    try {
      const p = await plan(row, patch, explain, canonicalize);
      plans.push(p);
      console.log(`\n${id} "${row.title}" (${file})${patch.note ? `\n  note: ${patch.note}` : ''}`);
      for (const l of p.lines) console.log(`  ${l}`);
    } catch (err) {
      refused++;
      console.error(`\n${id} "${row.title}" (${file}): REFUSED — ${err instanceof Error ? err.message : err}`);
    }
  }

  if (refused) {
    console.error(`\n${refused} of ${patches.length} patch(es) refused — nothing written. Fix and rerun.`);
    process.exit(1);
  }
  if (args.dryRun) {
    console.log(`\ndry run — ${plans.length} patch(es) check out, nothing written.`);
    return;
  }

  const { db } = await import('../src/server/services/db.js');
  db.transaction(() => {
    for (const p of plans) {
      const f = p.fields;
      db.prepare(
        `UPDATE problems SET prompt = ?, constraints = ?, starterCode = ?, referenceSolution = ?, examples = ?,
                             sampleTests = ?, hiddenTests = ?${p.retire ? ', canonicalized = 0' : ''}
          WHERE id = ?`
      ).run(
        f.prompt,
        JSON.stringify(f.constraints),
        f.starterCode,
        f.referenceSolution,
        JSON.stringify(f.examples),
        JSON.stringify(f.sampleTests),
        JSON.stringify(f.hiddenTests),
        p.id
      );
      db.prepare('DELETE FROM recognize_checks WHERE problemId = ?').run(p.id);
      db.prepare('DELETE FROM recognize_notes WHERE problemId = ?').run(p.id);
    }
  })();
  console.log(`\n${plans.length} problem(s) written.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
