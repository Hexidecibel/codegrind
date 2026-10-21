// De-leak the stored problem bank. Run via bin/strip-pattern-leaks.
//
// A review of the live bank (2026-10-21) found most generated statements
// naming their own technique ("Use the two-pointer technique…", "**Approach
// hint:** use a hash map", "## How Binary Search Applies") — which hands over
// the one thing Recognize and the grind are practising. New problems are
// stripped at generation (llm.service generateProblem); this applies the same
// deterministic filter (shared/pattern-leak.ts) to the rows already stored.
//
// STRIP, NOT REGENERATE: the problems are otherwise sound, people have
// practised on them, and a regeneration is a paid call each. Only directive
// text is removed; tests, reference solutions and every SRS/attempt row are
// untouched. A statement's own worked-examples section is removed too, when
// the problem carries structured examples[] (the UI renders those right under
// the statement, so it was printed twice).
//
// Idempotent: the filters are, so a second run changes nothing.

import { db } from '../src/server/services/db.js';
import { stripExampleSections, stripPatternLeaks, stripTitleLeak, findPatternLeak } from '../src/shared/pattern-leak.js';

interface Row {
  id: string;
  title: string;
  prompt: string;
  constraints: string;
  examples: string;
}

const dryRun = process.argv.includes('--dry-run');
const verbose = process.argv.includes('--verbose');
const rows = db.prepare(`SELECT id, title, prompt, constraints, examples FROM problems`).all() as Row[];
const update = db.prepare(
  `UPDATE problems SET title = @title, prompt = @prompt, constraints = @constraints, examples = @examples WHERE id = @id`
);

function clean(r: Row) {
  const examples = JSON.parse(r.examples) as { input: string; output: string; explanation?: string }[];
  const constraints = JSON.parse(r.constraints) as string[];
  let prompt = stripPatternLeaks(r.prompt);
  if (examples.length) prompt = stripExampleSections(prompt);
  return {
    id: r.id,
    title: stripTitleLeak(r.title),
    prompt,
    constraints: JSON.stringify(constraints.map(stripPatternLeaks).filter((c) => c.trim())),
    examples: JSON.stringify(examples.map((e) => (e.explanation ? { ...e, explanation: stripPatternLeaks(e.explanation) } : e))),
  };
}

let changed = 0;
let leftover = 0;
db.transaction(() => {
  for (const r of rows) {
    const next = clean(r);
    // Idempotence is asserted, not assumed: a filter that keeps cutting on a
    // second pass would eat a statement one run at a time.
    const again = clean({ ...r, ...next });
    if (JSON.stringify(again) !== JSON.stringify(next)) throw new Error(`filter is not idempotent on ${r.id}`);
    const left = findPatternLeak(next.prompt);
    if (left) {
      leftover++;
      console.log(`  still names a technique: ${r.id} "${left}"`);
    }
    if (next.title === r.title && next.prompt === r.prompt && next.constraints === r.constraints && next.examples === r.examples) continue;
    changed++;
    console.log(`${dryRun ? 'would strip' : 'strip'} ${r.id} "${r.title}"${next.title !== r.title ? ` → "${next.title}"` : ''} (${r.prompt.length} → ${next.prompt.length} chars)`);
    if (verbose) console.log(`--- after\n${next.prompt}\n`);
    if (!dryRun) update.run(next);
  }
})();
console.log(`\n${dryRun ? 'dry run — nothing written. ' : ''}${changed} of ${rows.length} problem(s) ${dryRun ? 'would be ' : ''}stripped; ${leftover} still flagged.`);
