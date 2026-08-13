// =============================================================================
// db.migrate — every schema change this database has ever needed, in one place
// =============================================================================
// Split out of db.ts on purpose. db.ts opens SQLite at module scope, so merely
// importing it touches the live database and binds a native ABI — which is why
// nothing in the suite imports it (see the headers of study.order.ts and
// curriculum.test.ts). This module takes the connection as an ARGUMENT and owns
// no state of its own, so a test can hand it `new Database(':memory:')`, apply a
// hand-rolled old schema, and watch what migrate() actually does.
//
// Contract: `migrate()` is idempotent, transactional, and safe to re-run on
// every startup — because it IS re-run on every startup.

import type { Database } from 'better-sqlite3';

/**
 * The schema generation this build of the app expects.
 *
 * Bump this in the same commit that appends a versioned step to `migrate()`.
 * Stored in `PRAGMA user_version` (a 32-bit int in the database header) rather
 * than a `schema_version` table: it needs no schema of its own, so it cannot
 * itself become a thing that needs migrating, and it is already there on every
 * SQLite file ever created (0 by default).
 */
export const SCHEMA_VERSION = 1;

/** Optional instrumentation — startup logging, and the seam tests observe. */
export interface MigrateOptions {
  /** Called with the name of each versioned step that actually ran. */
  onStep?: (name: string) => void;
}

// -----------------------------------------------------------------------------
// Schema introspection — the "detect real state" half of the strategy below.
// -----------------------------------------------------------------------------
// All four of these read PRAGMA table_info, whose rows are
// `{ cid, name, type, notnull, dflt_value, pk }`. Table names are interpolated
// because PRAGMA arguments cannot be bound; every caller passes a literal.

interface TableInfoRow {
  name: string;
  /**
   * 0 for a non-key column, otherwise the column's 1-BASED POSITION WITHIN THE
   * PRIMARY KEY — not a boolean, and not the column's position in the table.
   */
  pk: number;
}

function tableInfo(db: Database, table: string): TableInfoRow[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[];
}

export function columnExists(db: Database, table: string, column: string): boolean {
  return tableInfo(db, table).some((c) => c.name === column);
}

/**
 * ALTER TABLE ADD COLUMN, but survivable. better-sqlite3 throws on a duplicate
 * ADD COLUMN, so the PRAGMA check is what makes startup re-runnable.
 */
export function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  decl: string
): void {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

/**
 * The table's PRIMARY KEY columns, in KEY order (empty for a rowid table).
 *
 * Key order is not column order: `PRIMARY KEY (b, a)` reports b with pk=1 and
 * a with pk=2 while their cids stay 0 and 1. Sorting by cid would silently
 * return the right columns in the wrong order — which is exactly the mistake a
 * composite-key rebuild cannot survive, so we sort by the pk ordinal.
 */
export function pkColumns(db: Database, table: string): string[] {
  return tableInfo(db, table)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}

/** True only when the table's PRIMARY KEY is EXACTLY `cols`, in that order. */
export function hasPk(db: Database, table: string, cols: string[]): boolean {
  const actual = pkColumns(db, table);
  return actual.length === cols.length && actual.every((c, i) => c === cols[i]);
}

// -----------------------------------------------------------------------------
// The migration
// -----------------------------------------------------------------------------
// Two tiers, deliberately:
//
//   ALWAYS-RUN steps  — cheap and self-detecting (the columnExists idiom). They
//                       run on every startup regardless of user_version, so a
//                       half-applied or hand-edited database heals itself even
//                       if its version number lies.
//
//   VERSIONED steps   — expensive or destructive (table rebuild + copy, backfill
//                       over every row). Gated on `user_version < SCHEMA_VERSION`
//                       so a warm database doesn't pay for them on every boot.
//                       Each one STILL detects its own real state, so the gate
//                       is a performance optimisation and never the only thing
//                       standing between the app and a correct schema.
//
// Everything runs inside one transaction: either the database comes out at
// SCHEMA_VERSION with every step applied, or it comes out untouched.

export function migrate(db: Database, opts: MigrateOptions = {}): void {
  const from = db.pragma('user_version', { simple: true }) as number;

  db.transaction(() => {
    // --- ALWAYS-RUN -----------------------------------------------------------
    // Retrieval loop / mistake ledger: nullable JSON columns on attempts.
    addColumnIfMissing(db, 'attempts', 'prediction', 'TEXT'); // JSON Prediction | null
    addColumnIfMissing(db, 'attempts', 'mistakeTags', 'TEXT'); // JSON string[] | null

    // --- VERSIONED ------------------------------------------------------------
    if (from < SCHEMA_VERSION) {
      // v1 is the schema db.ts already creates with CREATE TABLE IF NOT EXISTS,
      // so there is genuinely nothing expensive to do here yet. The gate and the
      // transaction exist NOW so that the multi-language work is a diff to this
      // block and nothing else.
      //
      // Phase 1 appends here and bumps SCHEMA_VERSION to 2:
      //
      //   if (from < 2) {
      //     if (!columnExists(db, 'problems', 'language')) { ...ADD COLUMN... }
      //     if (!hasPk(db, 'skill_state', ['topic', 'language'])) {
      //       // SQLite cannot ALTER a PRIMARY KEY: create skill_state_new with
      //       // the composite key, INSERT..SELECT the old rows in, drop, rename.
      //     }
      //   }
      //
      // Note the shape: each step asks the DATABASE whether it is needed, not
      // the version number. The `from <` check only decides whether to bother
      // asking.
      opts.onStep?.('v1-baseline');
    }

    // Only advance the marker once every step above has committed to this same
    // transaction — a rolled-back migration must not leave a version claiming it
    // succeeded.
    if (from < SCHEMA_VERSION) {
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  })();
}
