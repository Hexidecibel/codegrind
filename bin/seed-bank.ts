// Seed a small starter bank so day one isn't cold. Run via `npm run seed`
// (tsx). Exercises the REAL Claude generate path — costs a few tokens per
// problem, so this deliberately seeds only a handful.
import type { Topic, Difficulty } from '../src/shared/types.js';
import { generateAndStore } from '../src/server/services/bank.service.js';
import { bankSize, getActiveLanguage } from '../src/server/services/db.js';

// Smoke-test set: 3 problems across common patterns. Expand SEED to grow the bank.
const SEED: Array<{ topic: Topic; difficulty: Difficulty }> = [
  { topic: 'two-pointer', difficulty: 'easy' },
  { topic: 'sliding-window', difficulty: 'medium' },
  { topic: 'hashing', difficulty: 'easy' },
];

async function main() {
  // The bank partitions by language, so seeding does too: seeding the ACTIVE
  // language is the only choice that can't leave you looking at a bank that
  // exists but is invisible to the app. Phase 3 adds `--language <lang>`.
  const language = getActiveLanguage();
  console.log(
    `Bank currently holds ${bankSize(language)} ${language} problem(s). Seeding ${SEED.length}...`
  );
  for (const { topic, difficulty } of SEED) {
    process.stdout.write(`  generating ${language} ${difficulty}/${topic} ... `);
    try {
      const p = await generateAndStore(language, topic, difficulty);
      console.log(`ok — "${p.title}" (${p.sampleTests.length} sample, ${p.hiddenTests.length} hidden)`);
    } catch (err) {
      console.log(`FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`Done. Bank now holds ${bankSize(language)} ${language} problem(s).`);
}

main();
