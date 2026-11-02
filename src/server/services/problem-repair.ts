// =============================================================================
// problem-repair — the pure half of bin/repair-problem
// =============================================================================
// bin/audit-problems repairs what a machine can judge (an example that
// disagrees with a trusted reference). What it holds back — a reference that
// misread its own statement, a statement that admits two answers, a starter
// with the wrong signature — is fixed by hand, as a PATCH: a small JSON file
// kept under data/tmp/repairs/ so every hand edit to the bank is traceable.
//
//   {
//     "id": "laM2fvVOFRDi7MSqSIRXg",          // optional when --id is given
//     "note": "why",                          // free text, never written
//     "prompt": "...",                        // replaces the statement
//     "constraints": ["..."],
//     "starterCode": "...",
//     "referenceSolution": "...",             // → tests re-canonicalized
//     "examples": [{ "input", "output", "explanation" }],
//     "dropTests": ["test name"],             // malformed stored tests
//     "retire": true                          // canonicalized = 0: never served again
//   }
//
// This file parses a patch and applies it to a problem; the script does the
// sandbox work (canonicalize, validateExamples) and the write.

import type { Example, TestCase } from '../../shared/types.js';

export interface RepairPatch {
  id?: string;
  note?: string;
  prompt?: string;
  constraints?: string[];
  starterCode?: string;
  referenceSolution?: string;
  examples?: Example[];
  dropTests?: string[];
  retire?: boolean;
}

/** The editable part of a stored problem. */
export interface RepairableProblem {
  prompt: string;
  constraints: string[];
  starterCode: string;
  referenceSolution: string;
  examples: Example[];
  sampleTests: TestCase[];
  hiddenTests: TestCase[];
}

const KEYS = new Set([
  'id', 'note', 'prompt', 'constraints', 'starterCode', 'referenceSolution', 'examples', 'dropTests', 'retire',
]);

const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

/** Validate a parsed patch. Throws with every problem found, not just the first. */
export function parsePatch(raw: unknown): RepairPatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('patch must be a JSON object');
  const p = raw as Record<string, unknown>;
  const errs: string[] = [];
  for (const k of Object.keys(p)) if (!KEYS.has(k)) errs.push(`unknown field "${k}"`);
  for (const k of ['id', 'note', 'prompt', 'starterCode', 'referenceSolution'] as const) {
    if (k in p && !(isStr(p[k]) && (k === 'note' || (p[k] as string).trim()))) errs.push(`${k} must be a non-empty string`);
  }
  if ('constraints' in p && !isStrArr(p.constraints)) errs.push('constraints must be an array of strings');
  if ('dropTests' in p && !(isStrArr(p.dropTests) && p.dropTests.length)) errs.push('dropTests must be a non-empty array of test names');
  if ('retire' in p && typeof p.retire !== 'boolean') errs.push('retire must be a boolean');
  if ('examples' in p) {
    const ex = p.examples;
    if (!Array.isArray(ex) || ex.length === 0) errs.push('examples must be a non-empty array');
    else
      ex.forEach((e, i) => {
        const o = e as Record<string, unknown>;
        if (!o || typeof o !== 'object' || !isStr(o.input) || !isStr(o.output) || !o.input.trim() || !o.output.trim()) {
          errs.push(`examples[${i}] needs non-empty string input and output`);
        } else if ('explanation' in o && !isStr(o.explanation)) {
          errs.push(`examples[${i}].explanation must be a string`);
        }
      });
  }
  const edits = Object.keys(p).filter((k) => k !== 'id' && k !== 'note');
  if (edits.length === 0) errs.push('patch changes nothing');
  if (errs.length) throw new Error(`invalid patch: ${errs.join('; ')}`);
  return p as RepairPatch;
}

/**
 * Apply a patch's fields to a problem. Tests named in dropTests are removed
 * (every name must exist — a typo must not silently drop nothing). The
 * returned flags say what the caller has to re-derive.
 */
export function applyPatch(
  problem: RepairableProblem,
  patch: RepairPatch
): { problem: RepairableProblem; refChanged: boolean; testsChanged: boolean } {
  const next: RepairableProblem = {
    prompt: patch.prompt ?? problem.prompt,
    constraints: patch.constraints ?? problem.constraints,
    starterCode: patch.starterCode ?? problem.starterCode,
    referenceSolution: patch.referenceSolution ?? problem.referenceSolution,
    examples: patch.examples ?? problem.examples,
    sampleTests: problem.sampleTests,
    hiddenTests: problem.hiddenTests,
  };
  let testsChanged = false;
  if (patch.dropTests?.length) {
    const names = new Set(patch.dropTests);
    const all = [...problem.sampleTests, ...problem.hiddenTests].map((t) => t.name);
    const missing = patch.dropTests.filter((n) => !all.includes(n));
    if (missing.length) throw new Error(`dropTests: no test named ${missing.map((n) => JSON.stringify(n)).join(', ')}`);
    next.sampleTests = problem.sampleTests.filter((t) => !names.has(t.name));
    next.hiddenTests = problem.hiddenTests.filter((t) => !names.has(t.name));
    testsChanged = true;
  }
  const refChanged = patch.referenceSolution !== undefined && patch.referenceSolution !== problem.referenceSolution;
  return { problem: next, refChanged, testsChanged };
}

/** Human lines for each stored test whose expected value changed (or vanished). */
export function testDiff(before: TestCase[], after: TestCase[]): string[] {
  const out: string[] = [];
  const show = (v: unknown) => {
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 117) + '...' : s;
  };
  for (const t of before) {
    const a = after.find((x) => x.name === t.name);
    if (!a) out.push(`  - "${t.name}": dropped`);
    else if (JSON.stringify(a.expected) !== JSON.stringify(t.expected)) {
      out.push(`  - "${t.name}": ${show(t.expected)} → ${show(a.expected)}`);
    }
  }
  return out;
}
