// Backfill drill cards for mocks graded before gap typing existed. Run via
// bin/backfill-mock-gaps. Hand-written answers; no model call.
//
// The URL-shortener mock of 2026-10-16 (Met4QEQ33X7g4uDmTN8lR, Staff) recorded
// only two gaps, both teach-mode skills, with no card text. The interviewer
// also handed over four facts it never recorded (301 vs 302 inside a nudge,
// the per-path freshness answer it skipped entirely, the seconds-per-month
// constant, base62 vs random IDs). This adds those as cards and gives the two
// existing skill gaps a front and a back.
//
// Idempotent: a card whose title (by gapKey) is already on the mock is skipped,
// and an existing gap's text is only filled while its answer is still empty.
// The fronts here are the INTERVIEWER-PHRASED wording bin/reword-gap-fronts
// moved the live cards to (2026-10-21), so a re-run matches them by gapKey and
// never re-inserts the old note-style text.

import { db } from '../src/server/services/db.js';
import { getGaps, getMock, insertGap, type NewGap } from '../src/server/services/mock.store.js';
import { gapKey } from '../src/shared/gap-cards.js';

const MOCK_ID = 'Met4QEQ33X7g4uDmTN8lR';

const NEW_CARDS: NewGap[] = [
  {
    seq: 37,
    concept: 'api-design',
    type: 'fact',
    title: "For a URL shortener's redirects, would you use a 301 or a 302 — and what does that choice do to your click analytics?",
    summary: 'Leaned 302 without knowing why, then flipped to 301 when asked about analytics; the interviewer supplied the answer.',
    answer:
      '302 (temporary). A 301 tells the browser the redirect is permanent, so it caches it and repeat clicks from that browser never reach your servers — those clicks are invisible and your analytics undercount. A 302 makes every click pass through you, so each one can be counted; the counting itself can be async and lag by minutes, which is the staleness you already accepted for analytics. Trade-off in one line: 301 saves you load, 302 keeps you seeing every click.',
    source: 'backfill',
  },
  {
    seq: 16,
    concept: 'freshness',
    type: 'fact',
    title: 'Say your URL shortener serves redirects from a cache that can be a little stale, but a brand-new link has to work immediately. How do you think about freshness for each kind of data?',
    summary: 'Asked how freshness squares with serving from cache ("that\'s where I get confused on freshness"); the question went unanswered.',
    answer:
      'Freshness is per data path, not one setting for the system. A newly created link must resolve immediately for its creator — read-your-writes on create (write through to the cache, or fall back to the DB on a miss), because a fresh link that 404s looks broken. Staleness is acceptable on the other paths: an edit or delete of an existing link can take a short while to propagate, and click counts can lag by minutes. Saying "fresh on create, eventually consistent on update, stale-OK on analytics" is the Staff answer.',
    source: 'backfill',
  },
  {
    seq: 29,
    concept: 'scale-estimation',
    type: 'fact',
    title: 'Roughly how many seconds are there in a month? And how would you use that to turn a monthly number into a per-second rate?',
    summary: 'Did not know the seconds-per-month constant, so could not convert monthly volume to rps.',
    answer:
      'About 2.5 million (30 × 24 × 3600 ≈ 2.6M; round to 2.5M for easy division). So per-second ≈ per-month ÷ 2.5M: 100M writes/month ≈ 40/s, 10B reads/month ≈ 4,000/s. Then multiply by 5–10× for peak. Knowing the constant is what lets you do capacity out loud in seconds instead of stalling.',
    source: 'backfill',
  },
  {
    seq: 41,
    concept: 'data-modeling',
    type: 'fact',
    title: "How would you generate the short codes — base62 of a counter, or random codes with a collision check? What's the trade-off?",
    summary: 'Proposed both but was "not sure on the tradeoff"; needed the counter-contention problem explained.',
    answer:
      'Base62 of a unique counter never collides and gives short codes (7 chars ≈ 3.5 trillion IDs), but a single global counter is a contention point and single point of failure — fix it by handing each app server a pre-allocated range of IDs (or a ticket service). Codes are also sequential and therefore guessable, which matters if links should not be enumerable. Random codes are unguessable and need no coordination, but every insert must check for a collision (cheap with a unique index and retry, rarer with longer codes). Pick one and say why: e.g. range-allocated base62 for simplicity at 40 writes/s, or random if guessability matters.',
    source: 'backfill',
  },
];

/** The two Phase-1 skill gaps, keyed by turn, given a card front and back. */
const FILL_EXISTING: Record<number, { title: string; answer: string }> = {
  19: {
    title: "Say you're designing a URL shortener. Which failure would hurt most, and what would you give up to protect against it? Give me your ranking in one sentence.",
    answer:
      'Worst is down: a dead redirect is instantly visible and breaks the link everywhere it was shared. "The worst failure here is unavailability, so I\'ll design for that first; I\'m willing to accept stale click counts and a short propagation delay on edits to get it." Correctness of a new mapping is not on the table — it is immutable and read-your-writes on create. The skill is ranking and naming the sacrifice in one sentence, instead of calling all six failures equally critical.',
  },
  29: {
    title: 'Say a URL shortener gets 100 million new links and 10 billion redirects a month. Talk me through the rough numbers — requests per second, peak, storage — and what they mean for the design.',
    answer:
      'Divide by ~2.5M s/month: ~40 writes/s and ~4,000 reads/s on average; ×5–10 for peak ≈ 400 writes/s and 20–40K reads/s. Storage: 100M × ~500 B ≈ 50 GB/month, low terabytes over a few years. The consequence is the point: a ~100:1 read skew means caching and fast key lookup dominate the design, not write throughput.',
  },
};

const dryRun = process.argv.includes('--dry-run');

const mock = getMock(MOCK_ID);
if (!mock) {
  console.error(`No mock ${MOCK_ID} in this database — nothing to backfill.`);
  process.exit(1);
}

const existing = getGaps(MOCK_ID);
const seen = new Set(existing.map((g) => gapKey(g.title)).filter(Boolean));
const fill = db.prepare(`UPDATE mock_gaps SET title = ?, answer = ? WHERE id = ? AND answer = ''`);

let added = 0;
let filled = 0;
db.transaction(() => {
  for (const g of existing) {
    const f = g.seq != null ? FILL_EXISTING[g.seq] : undefined;
    if (!f || g.answer) continue;
    console.log(`${dryRun ? 'would fill' : 'fill'}  #${g.seq} [${g.type}] ${f.title}`);
    if (!dryRun) fill.run(f.title, f.answer, g.id);
    filled++;
  }
  const now = new Date();
  for (const card of NEW_CARDS) {
    if (seen.has(gapKey(card.title))) {
      console.log(`skip  #${card.seq} (already there) ${card.title}`);
      continue;
    }
    console.log(`${dryRun ? 'would add' : 'add'}   #${card.seq} [${card.type}] ${card.title}`);
    if (!dryRun) insertGap(MOCK_ID, card, now);
    added++;
  }
})();

console.log(`\n${dryRun ? 'dry run — nothing written. ' : ''}${added} card(s) added, ${filled} existing gap(s) filled.`);
