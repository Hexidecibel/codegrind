// Reword drill-card FRONTS that were written as terse notes so they read the
// way an interviewer would ask them. Run via bin/reword-gap-fronts.
//
// Changes ONLY mock_gaps.title. The answer (card back), the summary and every
// SRS field (step, dueAt, reps, lapses, lastGrade, …) are left alone, so a
// card keeps its place on the review ladder.
//
// Idempotent: each rewrite matches the OLD title exactly, so a second run finds
// nothing to change. bin/backfill-mock-gaps.ts carries the NEW wording, and it
// dedupes by gapKey(title), so a re-run of the backfill sees the reworded card
// as already present and does not put the old text back.

import { db } from '../src/server/services/db.js';

export const FRONT_REWRITES: readonly { from: string; to: string }[] = [
  {
    from: 'URL shortener: rank the failures — which is worst, and what do you give up to protect it? Say the ranking sentence.',
    to: "Say you're designing a URL shortener. Which failure would hurt most, and what would you give up to protect against it? Give me your ranking in one sentence.",
  },
  {
    from: 'Capacity out loud: turn 100M new links/month and 10B redirects/month into rps, peak, storage, and the design consequence.',
    to: 'Say a URL shortener gets 100 million new links and 10 billion redirects a month. Talk me through the rough numbers — requests per second, peak, storage — and what they mean for the design.',
  },
  {
    from: 'URL shortener redirect: 301 or 302 — and what does the choice do to click analytics?',
    to: "For a URL shortener's redirects, would you use a 301 or a 302 — and what does that choice do to your click analytics?",
  },
  {
    from: '"Serve redirects from a stale cache — but the data must be in the cache immediately?" How do freshness and staleness apply per data path?',
    to: 'Say your URL shortener serves redirects from a cache that can be a little stale, but a brand-new link has to work immediately. How do you think about freshness for each kind of data?',
  },
  {
    from: 'Roughly how many seconds are in a month — and what is the per-month to per-second shortcut?',
    to: 'Roughly how many seconds are there in a month? And how would you use that to turn a monthly number into a per-second rate?',
  },
  {
    from: 'Short-code generation: base62 of a counter vs random codes with a collision check — what is the trade-off?',
    to: "How would you generate the short codes — base62 of a counter, or random codes with a collision check? What's the trade-off?",
  },
];

const dryRun = process.argv.includes('--dry-run');
const find = db.prepare(`SELECT id FROM mock_gaps WHERE title = ?`);
const update = db.prepare(`UPDATE mock_gaps SET title = ? WHERE id = ? AND title = ?`);

let changed = 0;
db.transaction(() => {
  for (const r of FRONT_REWRITES) {
    const rows = find.all(r.from) as { id: number }[];
    for (const { id } of rows) {
      console.log(`${dryRun ? 'would reword' : 'reword'} #${id}\n  before: ${r.from}\n  after:  ${r.to}`);
      if (!dryRun) update.run(r.to, id, r.from);
      changed++;
    }
  }
})();
console.log(`\n${dryRun ? 'dry run — nothing written. ' : ''}${changed} front(s) reworded.`);
