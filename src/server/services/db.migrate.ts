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
import { DEFAULT_LANGUAGE } from '../../shared/languages.js';

/**
 * The schema generation this build of the app expects.
 *
 * Bump this in the same commit that appends a versioned step to `migrate()`.
 * Stored in `PRAGMA user_version` (a 32-bit int in the database header) rather
 * than a `schema_version` table: it needs no schema of its own, so it cannot
 * itself become a thing that needs migrating, and it is already there on every
 * SQLite file ever created (0 by default).
 */
export const SCHEMA_VERSION = 2;

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

/** The stored CREATE statement for a schema object, or null if it doesn't exist. */
function objectSql(db: Database, name: string): string | null {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(name) as
    | { sql: string | null }
    | undefined;
  return row?.sql ?? null;
}

/** Does this table exist at all? (Rebuild steps must not fire on a fresh file.) */
function tableExists(db: Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}

function countRows(db: Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
}

/**
 * The tables this migration must never change the size of. Snapshotted at the
 * top of the transaction and re-counted at the bottom; a disagreement throws,
 * which rolls the whole thing back. `settings` and `code_translations` are
 * absent on purpose — those two are supposed to grow.
 *
 * This is the check that catches the failure row counts are usually blamed for
 * missing: a rebuild-and-copy that drops rows on the floor still leaves a
 * perfectly valid-looking database, and it does it silently.
 */
const INVARIANT_TABLES = [
  'problems',
  'attempts',
  'skill_state',
  'sessions',
  'review_queue',
  'pattern_primers',
  'lesson_tracks',
  'lessons',
  'lesson_reads',
  'revealed_solutions',
] as const;

/**
 * The language literal written into SQL by this migration.
 *
 * Interpolated from the shared registry so the two cannot disagree *at the
 * moment this migration is authored*. It is not a live link: a `DEFAULT` is
 * baked into a table definition when the column is added and is never
 * re-evaluated, and rows already backfilled stay backfilled. Changing
 * DEFAULT_LANGUAGE later is therefore a new migration, not a recompile.
 *
 * Safe to interpolate: `Language` is a union of compile-time literals, so
 * there is no string here that TypeScript did not put there.
 */
const LANG = DEFAULT_LANGUAGE;

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

  // ---------------------------------------------------------------------------
  // PRAGMA foreign_keys, OUTSIDE the transaction — and this is not a style call.
  // ---------------------------------------------------------------------------
  // `PRAGMA foreign_keys` is a documented NO-OP inside a transaction: SQLite
  // silently ignores it and returns success, so a migration that "disables"
  // constraints on the first line of its own transaction has disabled nothing
  // and will discover that only when a rebuild's DROP TABLE fires a cascade.
  //
  // The rebuild below is create-copy-drop-rename, so it must run with foreign
  // keys off. Read the real state first (db.ts turns them ON at startup; a test
  // connection leaves them at SQLite's default OFF) and restore exactly that,
  // in a finally — a migration that throws must not leave the connection with
  // its integrity checking quietly switched off for the rest of the process.
  const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
  if (fkWasOn) db.pragma('foreign_keys = OFF');

  try {
    db.transaction(() => {
      // --- Row-count snapshot -------------------------------------------------
      // Taken inside the transaction so the comparison at the bottom is against
      // the same consistent read. See INVARIANT_TABLES.
      const before = new Map<string, number>();
      for (const t of INVARIANT_TABLES) {
        if (tableExists(db, t)) before.set(t, countRows(db, t));
      }

      // --- ALWAYS-RUN ---------------------------------------------------------
      // Cheap and self-detecting: a PRAGMA read, then an O(1) metadata change.
      // Deliberately NOT gated on user_version, so a database whose version
      // marker lies (a restore from an old dump, a hand-edited pragma) still
      // heals itself on the next boot.

      // Retrieval loop / mistake ledger: nullable JSON columns on attempts.
      addColumnIfMissing(db, 'attempts', 'prediction', 'TEXT'); // JSON Prediction | null
      addColumnIfMissing(db, 'attempts', 'mistakeTags', 'TEXT'); // JSON string[] | null

      // Multi-language: the additive half. NOT NULL with a DEFAULT means every
      // existing row backfills without a rewrite — SQLite stores the default in
      // the table header and synthesises it on read.
      //
      // `attempts.language` is denormalised against `problems.language` on
      // purpose: six accessors read `attempts` with no join at all, and folding
      // "Python indentation" and "JS hoisting" into one syntax-error tally is
      // worse than having no tally. `sessions.language` so a sitting keeps
      // scheduling in the language it started in.
      const langDecl = `TEXT NOT NULL DEFAULT '${LANG}'`;
      addColumnIfMissing(db, 'problems', 'language', langDecl);
      addColumnIfMissing(db, 'attempts', 'language', langDecl);
      addColumnIfMissing(db, 'sessions', 'language', langDecl);
      // NOTE: skill_state.language is deliberately absent here. It is part of
      // that table's PRIMARY KEY, and ALTER TABLE ADD COLUMN cannot extend a
      // key — it arrives with the rebuild below.

      // Server-side key/value store. The language selector needs it now; the
      // provider/model wizard later adds ROWS, never another migration.
      db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
          key       TEXT PRIMARY KEY,
          value     TEXT NOT NULL,   -- JSON, so a value can grow a shape later
          updatedAt TEXT NOT NULL
        );
      `);

      // The only genuinely language-bound bytes in the study corpus. Lesson and
      // primer PROSE stays shared (verified: zero of 114 lesson bodies contain a
      // fence), so only the snippet forks — which is what collapses five table
      // rebuilds into one and keeps all 19 read receipts valid.
      //
      // `sourceId` reuses the `<kind>:<id>` prefix convention lessons.id already
      // uses for `mistake:` / `walkthrough:`, so one column addresses both
      // corpora without a discriminator column nobody would keep in sync.
      db.exec(`
        CREATE TABLE IF NOT EXISTS code_translations (
          sourceId  TEXT NOT NULL,   -- 'lesson:<lessons.id>' | 'primer:<pattern>'
          language  TEXT NOT NULL,
          code      TEXT NOT NULL,
          createdAt TEXT NOT NULL,
          PRIMARY KEY (sourceId, language)
        );
      `);

      // --- VERSIONED ----------------------------------------------------------
      // Expensive or destructive. Gated on the version marker so a warm database
      // doesn't pay on every boot — but each step still asks the DATABASE
      // whether it is needed, and the two below can FORCE the gate open.
      //
      // Forcing matters most for the skill_state key. `upsertSkillStmt` says
      // ON CONFLICT(topic, language); against the old single-column key that is
      // a hard runtime error on the next submit. A version marker that lies
      // about that step would turn a self-healing startup into a permanently
      // broken app, so the marker does not get to be the last word on it.
      const needsSkillPk = tableExists(db, 'skill_state') && !hasPk(db, 'skill_state', ['topic', 'language']);
      const slotSql = objectSql(db, 'idx_problems_slot');
      const needsSlotIndex =
        tableExists(db, 'problems') && (slotSql === null || !/\blanguage\b/.test(slotSql));

      if (from < 1) {
        // v1 was the schema db.ts already creates with CREATE TABLE IF NOT
        // EXISTS — nothing expensive, the marker just had to start somewhere.
        opts.onStep?.('v1-baseline');
      }

      if (from < 2 || needsSkillPk || needsSlotIndex) {
        if (needsSkillPk) {
          // SQLite cannot ALTER a PRIMARY KEY, so: build the new shape, copy,
          // drop, rename. Both column lists are written out in full — an
          // INSERT..SELECT that relies on positional order is exactly how
          // `topic` ends up in `language` while every row count stays perfect.
          //
          // The fork is a FULL RESET, no unlock transfer: the tier ladder means
          // "distinct problems solved at this difficulty with zero hints", and
          // you have not done that in Python. Existing rows land on the default
          // language and the other languages start cold, which the cold-start
          // path in scheduler.service already handles.
          db.exec(`
            CREATE TABLE skill_state_new (
              topic             TEXT NOT NULL,
              language          TEXT NOT NULL DEFAULT '${LANG}',
              currentDifficulty TEXT NOT NULL DEFAULT 'easy',
              box               INTEGER NOT NULL DEFAULT 0,
              ease              REAL NOT NULL DEFAULT 2.5,
              streak            INTEGER NOT NULL DEFAULT 0,
              attempts          INTEGER NOT NULL DEFAULT 0,
              solved            INTEGER NOT NULL DEFAULT 0,
              hintsSum          INTEGER NOT NULL DEFAULT 0,
              lastResult        TEXT,
              lastSeenAt        TEXT,
              dueAt             TEXT,
              PRIMARY KEY (topic, language)
            );

            INSERT INTO skill_state_new (
              topic, language, currentDifficulty, box, ease, streak,
              attempts, solved, hintsSum, lastResult, lastSeenAt, dueAt
            )
            SELECT
              topic, '${LANG}', currentDifficulty, box, ease, streak,
              attempts, solved, hintsSum, lastResult, lastSeenAt, dueAt
            FROM skill_state;

            DROP TABLE skill_state;
            ALTER TABLE skill_state_new RENAME TO skill_state;
          `);
          opts.onStep?.('v2-skill-state-pk');
        }

        if (needsSlotIndex) {
          // THE SILENT NO-OP. `CREATE INDEX IF NOT EXISTS idx_problems_slot`
          // in db.ts matches on NAME, not on definition — so editing that line
          // to add `language` does exactly nothing to a database where the
          // index already exists, and the bank filter degrades to a scan that
          // still returns correct rows. It passes on a fresh database and
          // silently rots on the real one. DROP first, always.
          db.exec(`
            DROP INDEX IF EXISTS idx_problems_slot;
            CREATE INDEX idx_problems_slot ON problems(language, topic, difficulty, used);
          `);
          opts.onStep?.('v2-idx-problems-slot');
        }

        // Seed the translation table with what already exists: today's stored
        // snippets ARE the JavaScript translation. INSERT OR IGNORE against the
        // composite key makes this a no-op on re-run rather than a conflict, so
        // it is safe for the forced-repair path above to drag it along.
        if (tableExists(db, 'lessons')) {
          db.exec(`
            INSERT OR IGNORE INTO code_translations (sourceId, language, code, createdAt)
            SELECT 'lesson:' || id, '${LANG}', json_extract(data, '$.code'), createdAt
            FROM lessons
            WHERE json_extract(data, '$.code') IS NOT NULL
              AND json_extract(data, '$.code') <> ''
          `);
        }
        if (tableExists(db, 'pattern_primers')) {
          db.exec(`
            INSERT OR IGNORE INTO code_translations (sourceId, language, code, createdAt)
            SELECT 'primer:' || pattern, '${LANG}', json_extract(data, '$.template'), createdAt
            FROM pattern_primers
            WHERE json_extract(data, '$.template') IS NOT NULL
              AND json_extract(data, '$.template') <> ''
          `);
        }
        opts.onStep?.('v2-code-translations');
      }

      // --- Verification, INSIDE the transaction -------------------------------
      // Throwing here rolls everything back, including the version bump. The
      // correct failure mode for a migration is a loud crash-loop against an
      // untouched database, not a half-migrated one that starts.
      for (const [table, want] of before) {
        const got = countRows(db, table);
        if (got !== want) {
          throw new Error(
            `migration aborted: ${table} row count changed ${want} -> ${got}. ` +
              `No table outside settings/code_translations may gain or lose rows; ` +
              `the database has been rolled back.`
          );
        }
      }

      // The rebuild is the one step that rewrites rows rather than metadata, so
      // it gets a second, content-level check: every carried-over row must have
      // landed on the default language. A copy that wrote the columns in the
      // wrong order fails here even though the count matched.
      if (tableExists(db, 'skill_state') && columnExists(db, 'skill_state', 'language')) {
        const stray = (
          db
            .prepare(`SELECT COUNT(*) AS n FROM skill_state WHERE language <> ?`)
            .get(LANG) as { n: number }
        ).n;
        if (stray !== 0) {
          throw new Error(
            `migration aborted: ${stray} skill_state row(s) did not land on '${LANG}'.`
          );
        }
      }

      // Only advance the marker once every step above has committed to this same
      // transaction — a rolled-back migration must not leave a version claiming it
      // succeeded.
      if (from < SCHEMA_VERSION) {
        db.pragma(`user_version = ${SCHEMA_VERSION}`);
      }
    })();
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }
}
