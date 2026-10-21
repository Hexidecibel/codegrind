// Seed the five Envelope cards from the 2026-10-21 diagnostic, due now.
// Run via bin/seed-envelope. Idempotent: a card whose key exists is left alone
// (its schedule included). No model call.

import { seedItems } from '../src/shared/envelope.js';
import { seedEnvelopeCards } from '../src/server/services/envelope.service.js';
import { getCard } from '../src/server/services/envelope.store.js';

const dryRun = process.argv.includes('--dry-run');
for (const item of seedItems()) {
  const have = getCard(item.key);
  console.log(`${have ? 'have ' : dryRun ? 'would add' : 'add  '}  ${item.key}  ${item.question}  [${item.answerText}]`);
}
if (!dryRun) {
  const added = seedEnvelopeCards();
  console.log(`\n${added} card(s) added.`);
} else {
  console.log('\ndry run — nothing written.');
}
