// Create and migrate the codegrind database, then report what it holds.
// Run via bin/migrate (tsx).
//
// There is no migration COMMAND in this app — importing db.ts creates the
// schema and runs `migrate()` as a side effect, inside one transaction, and has
// done since Phase 0. That is the right design (the server can never run
// against an unmigrated database) and it has one gap: on a fresh install the
// first thing that opens the database is the SERVER, so a migration failure
// arrives as "the server exited" rather than as a migration failure.
//
// This script closes that gap by being the thing that opens it first. It is a
// no-op on an already-migrated database, which is what makes bin/setup safe to
// re-run.
//
// READ THIS BEFORE ADDING A --force OR A --reset: the migration is deliberately
// all-or-nothing and deliberately non-destructive. A failure crash-loops with
// the database untouched, which is the correct failure mode. Do not add a flag
// that papers over one.

import { db } from '../src/server/services/db.js';
import { SCHEMA_VERSION } from '../src/server/services/db.migrate.js';

const quiet = process.argv.includes('--quiet');

const version = db.pragma('user_version', { simple: true }) as number;
const counts = ['problems', 'attempts', 'lessons', 'settings'].map((t) => {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number };
  return `${row.n} ${t}`;
});

if (version !== SCHEMA_VERSION) {
  // Not reachable through a normal import — db.ts migrates on load — so if it
  // ever prints, the migration silently did not finish and that is worth
  // stopping for rather than reporting as success.
  console.error(
    `database is at schema v${version} but this build expects v${SCHEMA_VERSION}. ` +
      `The migration did not complete; do not run against it.`
  );
  db.close();
  process.exit(1);
}

if (quiet) {
  console.log(`schema v${version}, ${counts.join(', ')}`);
} else {
  console.log(`codegrind :: migrate`);
  console.log(`  schema v${version} (current)`);
  for (const c of counts) console.log(`  ${c}`);
}
db.close();
