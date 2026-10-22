// Re-check every Envelope attempt on a review card with the CURRENT checker,
// and fix the ones it now grades differently. Run via bin/regrade-envelope.
//
// Why: a checker bug graded a right answer wrong ("8000 gb or 8 tb" was read as
// terabits, 2026-10-21). The attempt row and its card's schedule both carried
// that miss. This replays each affected card from a fresh schedule through its
// attempts in order, so the card ends where honest grading would have put it.
// The stored AI note on a flipped attempt is cleared: it explained a miss that
// was not one. Idempotent; no model call. Attempts with no card are skipped
// (their item is not stored, so they cannot be re-checked).

import { db } from '../src/server/services/db.js';
import { checkAnswer } from '../src/shared/envelope.js';
import { newCardSchedule, type GapCardSchedule } from '../src/shared/gap-cards.js';
import { scheduleRecognizeCard } from '../src/server/services/recognize.compute.js';
import { getCard, updateSchedule } from '../src/server/services/envelope.store.js';

const dryRun = process.argv.includes('--dry-run');

interface Row {
  id: number;
  cardKey: string;
  answer: string;
  ok: number;
  createdAt: string;
}
const rows = db
  .prepare(`SELECT id, cardKey, answer, ok, createdAt FROM envelope_attempts WHERE cardKey IS NOT NULL ORDER BY createdAt, id`)
  .all() as Row[];

const flippedCards = new Set<string>();
const fixAttempt = db.prepare(
  `UPDATE envelope_attempts SET ok = @ok, given = @given, orders = @orders, cause = @cause, aiNote = NULL WHERE id = @id`
);
const regraded = new Map<number, boolean>();

for (const r of rows) {
  const card = getCard(r.cardKey);
  if (!card) continue;
  const v = checkAnswer(card.item, r.answer);
  if (!v) continue;
  regraded.set(r.id, v.ok);
  if (v.ok !== (r.ok === 1)) {
    flippedCards.add(r.cardKey);
    console.log(`${dryRun ? 'would fix' : 'fix'}  #${r.id} ${r.cardKey}  "${r.answer}"  ${r.ok ? 'right' : 'wrong'} → ${v.ok ? 'right' : 'wrong'}`);
    if (!dryRun) fixAttempt.run({ id: r.id, ok: v.ok ? 1 : 0, given: v.given, orders: v.orders, cause: v.cause });
  }
}

for (const key of flippedCards) {
  const card = getCard(key)!;
  let s: GapCardSchedule = newCardSchedule(new Date(card.createdAt));
  for (const r of rows.filter((x) => x.cardKey === key)) {
    const ok = regraded.get(r.id) ?? r.ok === 1;
    s = scheduleRecognizeCard(s, ok ? 'got' : 'missed', new Date(r.createdAt))!;
  }
  console.log(`${dryRun ? 'would reschedule' : 'reschedule'}  ${key}  → step ${s.step}, due ${s.dueAt}${s.retiredAt ? ', retired' : ''}`);
  if (!dryRun) updateSchedule(key, s);
}

console.log(flippedCards.size ? `\n${flippedCards.size} card(s) ${dryRun ? 'would be ' : ''}corrected.` : '\nNothing to correct.');
