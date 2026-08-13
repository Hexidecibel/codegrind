// =============================================================================
// db.migrate.test — the schema-change harness
// =============================================================================
// This is the ONE test file in the suite that loads a native module, and that is
// the whole point of splitting db.migrate.ts out of db.ts. The other files stay
// pure because db.ts opens the LIVE database at module scope (see the headers of
// curriculum.test.ts and study.order.ts); a migration, by definition, cannot be
// tested without a database. So this file takes the other half of the deal: it
// imports better-sqlite3 directly, builds its own `:memory:` connection, and
// never reads DATA_DIR, never touches a file, and never imports ./db.js.
//
// Consequence: this file needs the Node the app is pinned to (v22.22.0 —
// better-sqlite3 is compiled against its ABI). See bin/warm-lessons.
//
// Every test starts from the schema as it stood BEFORE the migration, applied by
// hand below, so the assertions are about what migrate() does to a real old
// database rather than about what the current db.ts happens to create.

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import {
  SCHEMA_VERSION,
  addColumnIfMissing,
  columnExists,
  hasPk,
  migrate,
  pkColumns,
} from './db.migrate.js';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

/**
 * A representative subset of the pre-migration schema: the two tables the
 * migration reaches for (`attempts`, which gains columns; `skill_state`, whose
 * key Phase 1 rebuilds) plus `problems` so the joins have something to join to.
 *
 * `attempts` deliberately has NO prediction / mistakeTags columns — that is the
 * state a database that predates the retrieval loop is actually in.
 */
function oldDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE problems (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      difficulty TEXT NOT NULL,
      topic      TEXT NOT NULL,
      createdAt  TEXT NOT NULL
    );

    CREATE TABLE attempts (
      id          TEXT PRIMARY KEY,
      problemId   TEXT NOT NULL,
      pattern     TEXT NOT NULL,
      difficulty  TEXT NOT NULL,
      solved      INTEGER NOT NULL,
      hintsUsed   INTEGER NOT NULL DEFAULT 0,
      testsPassed INTEGER NOT NULL,
      testsTotal  INTEGER NOT NULL,
      code        TEXT NOT NULL,
      createdAt   TEXT NOT NULL
    );

    CREATE INDEX idx_attempts_pattern ON attempts(pattern);

    CREATE TABLE skill_state (
      topic             TEXT PRIMARY KEY,
      currentDifficulty TEXT NOT NULL DEFAULT 'easy',
      box               INTEGER NOT NULL DEFAULT 0,
      ease              REAL NOT NULL DEFAULT 2.5,
      streak            INTEGER NOT NULL DEFAULT 0,
      attempts          INTEGER NOT NULL DEFAULT 0,
      solved            INTEGER NOT NULL DEFAULT 0,
      hintsSum          INTEGER NOT NULL DEFAULT 0,
      lastResult        TEXT,
      lastSeenAt        TEXT,
      dueAt             TEXT
    );
  `);
  return db;
}

/** One problem, two attempts on it (one clean, one hinted), one skill row. */
function seed(db: Database.Database): void {
  db.prepare(
    `INSERT INTO problems VALUES ('p1', 'Two Sum', 'easy', 'arrays', '2026-01-01T00:00:00.000Z')`
  ).run();
  db.prepare(
    `INSERT INTO attempts VALUES
       ('a1','p1','arrays','easy',1,0,5,5,'const f=()=>1','2026-01-01T01:00:00.000Z')`
  ).run();
  db.prepare(
    `INSERT INTO attempts VALUES
       ('a2','p1','arrays','easy',1,2,5,5,'const f=()=>2','2026-01-02T01:00:00.000Z')`
  ).run();
  db.prepare(
    `INSERT INTO skill_state VALUES ('arrays','medium',3,2.6,4,19,10,7,'solved',
       '2026-01-02T01:00:00.000Z','2026-01-09T01:00:00.000Z')`
  ).run();
}

/** Everything about the schema a migration could plausibly change. */
function schemaOf(db: Database.Database): string {
  const objects = db
    .prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`)
    .all() as Array<{ type: string; name: string; sql: string | null }>;
  const columns = objects
    .filter((o) => o.type === 'table')
    .map((t) => `${t.name}=${JSON.stringify(db.pragma(`table_info(${t.name})`))}`);
  return [JSON.stringify(objects), ...columns].join('\n');
}

function userVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/** Run migrate() and report which VERSIONED steps actually fired. */
function stepsFrom(db: Database.Database): string[] {
  const seen: string[] = [];
  migrate(db, { onStep: (name) => seen.push(name) });
  return seen;
}

// -----------------------------------------------------------------------------
describe('migrate — safe to re-run on every startup', () => {
  it('brings a pre-migration database up to the current schema', () => {
    const db = oldDb();
    expect(columnExists(db, 'attempts', 'prediction')).toBe(false);

    migrate(db);

    expect(columnExists(db, 'attempts', 'prediction')).toBe(true);
    expect(columnExists(db, 'attempts', 'mistakeTags')).toBe(true);
    db.close();
  });

  it('produces a byte-identical schema the second time, and does not throw', () => {
    const db = oldDb();
    migrate(db);
    const after = schemaOf(db);

    expect(() => migrate(db)).not.toThrow();
    expect(schemaOf(db)).toBe(after);
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('leaves nothing to do when the schema is already current', () => {
    // A database created by today's db.ts: the columns are already there before
    // migrate() ever runs, so migrate() must not try to add them again.
    const db = oldDb();
    db.exec(`ALTER TABLE attempts ADD COLUMN prediction TEXT`);
    db.exec(`ALTER TABLE attempts ADD COLUMN mistakeTags TEXT`);
    const before = schemaOf(db);

    expect(() => migrate(db)).not.toThrow();
    expect(schemaOf(db)).toBe(before);
    db.close();
  });

  it('heals a database whose version number lies about a missing column', () => {
    // The self-detecting half must NOT be gated on user_version. A restore from
    // an old dump, or a hand-edited pragma, leaves the marker ahead of reality —
    // startup has to notice and repair rather than trust the number.
    const db = oldDb();
    db.pragma(`user_version = ${SCHEMA_VERSION}`);

    migrate(db);

    expect(columnExists(db, 'attempts', 'prediction')).toBe(true);
    expect(columnExists(db, 'attempts', 'mistakeTags')).toBe(true);
    db.close();
  });

  it('carries seeded rows through untouched', () => {
    const db = oldDb();
    seed(db);
    const attemptsBefore = db.prepare(`SELECT * FROM attempts ORDER BY id`).all();
    const skillBefore = db.prepare(`SELECT * FROM skill_state`).all();

    migrate(db);

    const attemptsAfter = db.prepare(`SELECT * FROM attempts ORDER BY id`).all() as Array<
      Record<string, unknown>
    >;
    expect(attemptsAfter).toHaveLength(2);
    // The pre-existing columns are identical; the new ones read back as NULL
    // rather than as a default that would look like a real prediction.
    expect(attemptsAfter.map(({ prediction: _p, mistakeTags: _m, ...rest }) => rest)).toEqual(
      attemptsBefore
    );
    expect(attemptsAfter.every((r) => r.prediction === null && r.mistakeTags === null)).toBe(true);
    expect(db.prepare(`SELECT * FROM skill_state`).all()).toEqual(skillBefore);
    db.close();
  });
});

// -----------------------------------------------------------------------------
describe('user_version — the gate on the expensive steps', () => {
  it('starts at 0 on an untouched database and lands on SCHEMA_VERSION', () => {
    const db = oldDb();
    expect(userVersion(db)).toBe(0);

    migrate(db);

    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('runs the versioned steps once and skips them on every boot after', () => {
    const db = oldDb();
    expect(stepsFrom(db)).toEqual(['v1-baseline']);
    expect(stepsFrom(db)).toEqual([]);
    expect(stepsFrom(db)).toEqual([]);
    db.close();
  });

  it('skips the versioned steps entirely on a database already at version', () => {
    const db = oldDb();
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    expect(stepsFrom(db)).toEqual([]);
    db.close();
  });

  it('does not create a schema_version table — the marker is the pragma', () => {
    const db = oldDb();
    migrate(db);
    const names = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(names).not.toContain('schema_version');
    db.close();
  });
});

// -----------------------------------------------------------------------------
describe('columnExists / addColumnIfMissing', () => {
  it('reports the columns a table actually has, and nothing else', () => {
    const db = oldDb();
    expect(columnExists(db, 'attempts', 'hintsUsed')).toBe(true);
    expect(columnExists(db, 'attempts', 'prediction')).toBe(false);
    // Case-sensitive on purpose: SQLite would accept `hintsused` in SQL, but a
    // loose match here would make addColumnIfMissing skip a real add.
    expect(columnExists(db, 'attempts', 'language')).toBe(false);
    db.close();
  });

  it('adds a missing column, leaving existing rows NULL there', () => {
    const db = oldDb();
    seed(db);

    addColumnIfMissing(db, 'attempts', 'language', `TEXT NOT NULL DEFAULT 'javascript'`);

    expect(columnExists(db, 'attempts', 'language')).toBe(true);
    const langs = db.prepare(`SELECT language FROM attempts`).all() as Array<{ language: string }>;
    expect(langs.map((r) => r.language)).toEqual(['javascript', 'javascript']);
    db.close();
  });

  it('is a no-op on a column that already exists, rather than throwing', () => {
    // Unguarded, this is `SqliteError: duplicate column name: code` — the exact
    // crash that would take the service down on its second start.
    const db = oldDb();
    seed(db);
    const before = schemaOf(db);

    expect(() => addColumnIfMissing(db, 'attempts', 'code', 'TEXT')).not.toThrow();

    expect(schemaOf(db)).toBe(before);
    expect(db.prepare(`SELECT code FROM attempts WHERE id = 'a1'`).get()).toEqual({
      code: 'const f=()=>1',
    });
    db.close();
  });
});

// -----------------------------------------------------------------------------
describe('pkColumns — KEY order, not column order', () => {
  it('returns the single key column of a keyed table', () => {
    const db = oldDb();
    expect(pkColumns(db, 'skill_state')).toEqual(['topic']);
    expect(pkColumns(db, 'attempts')).toEqual(['id']);
    db.close();
  });

  it('returns [] for a rowid table with no declared key', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE rowid_only (a TEXT, b TEXT)`);
    expect(pkColumns(db, 'rowid_only')).toEqual([]);
    db.close();
  });

  it('returns a composite key in KEY order, not declaration order', () => {
    // The load-bearing case. `PRIMARY KEY (b, a)` gives b pk=1 / cid=1 and
    // a pk=2 / cid=0 — so anything that sorts by cid (or trusts PRAGMA's row
    // order, which IS cid order) silently answers ['a','b']. A skill_state
    // rebuild that copies columns in that order writes topic into language.
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE composite (a TEXT NOT NULL, b TEXT NOT NULL, c TEXT, PRIMARY KEY (b, a))`);
    expect(pkColumns(db, 'composite')).toEqual(['b', 'a']);
    db.close();
  });

  it('reads a three-column key in key order too', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE triple (a TEXT, b TEXT, c TEXT, PRIMARY KEY (c, a, b))`);
    expect(pkColumns(db, 'triple')).toEqual(['c', 'a', 'b']);
    db.close();
  });
});

// -----------------------------------------------------------------------------
describe('hasPk — exact match only', () => {
  /** A table keyed on (topic, language) — the shape Phase 1 migrates toward. */
  function keyed(): Database.Database {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE skill_state (
        topic    TEXT NOT NULL,
        language TEXT NOT NULL,
        box      INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (topic, language)
      )
    `);
    return db;
  }

  it('matches the exact key, in order', () => {
    const db = keyed();
    expect(hasPk(db, 'skill_state', ['topic', 'language'])).toBe(true);
    db.close();
  });

  it('rejects the right columns in the wrong order', () => {
    // Not pedantry: (topic, language) and (language, topic) index differently,
    // and a rebuild guarded by a set-equality check would skip a real change.
    const db = keyed();
    expect(hasPk(db, 'skill_state', ['language', 'topic'])).toBe(false);
    db.close();
  });

  it('rejects a subset and a superset', () => {
    const db = keyed();
    expect(hasPk(db, 'skill_state', ['topic'])).toBe(false);
    expect(hasPk(db, 'skill_state', ['topic', 'language', 'box'])).toBe(false);
    db.close();
  });

  it('is false for the pre-migration single-column key, true after', () => {
    // This is the exact call Phase 1 gates its rebuild on: it must say "no" to
    // today's table, or the migration silently never happens.
    const old = oldDb();
    expect(hasPk(old, 'skill_state', ['topic', 'language'])).toBe(false);
    expect(hasPk(old, 'skill_state', ['topic'])).toBe(true);
    old.close();

    const next = keyed();
    expect(hasPk(next, 'skill_state', ['topic', 'language'])).toBe(true);
    next.close();
  });

  it('treats a rowid table as having no key at all', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE rowid_only (a TEXT, b TEXT)`);
    expect(hasPk(db, 'rowid_only', [])).toBe(true);
    expect(hasPk(db, 'rowid_only', ['a'])).toBe(false);
    db.close();
  });
});
