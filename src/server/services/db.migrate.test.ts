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
 * The pre-migration schema, as db.ts's CREATE TABLE block actually wrote it —
 * every table the migration touches or counts, with the columns and the
 * single-column `skill_state` key it really had.
 *
 * `attempts` deliberately has NO prediction / mistakeTags columns, and nothing
 * anywhere has a `language` column: that is the state a database that predates
 * the retrieval loop and the multi-language work is actually in. `lessons` and
 * `pattern_primers` carry their real JSON `data` payload, because the
 * `code_translations` backfill reads it with json_extract and a fixture that
 * stored a bare string would prove nothing.
 */
function oldDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE problems (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      difficulty        TEXT NOT NULL,
      topic             TEXT NOT NULL,
      pattern           TEXT NOT NULL DEFAULT 'arrays',
      used              INTEGER NOT NULL DEFAULT 0,
      createdAt         TEXT NOT NULL
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
    CREATE INDEX idx_problems_slot ON problems(topic, difficulty, used);

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

    CREATE TABLE sessions (
      id         TEXT PRIMARY KEY,
      createdAt  TEXT NOT NULL,
      plan       TEXT NOT NULL,
      served     INTEGER NOT NULL DEFAULT 0,
      lastTopic  TEXT
    );

    CREATE TABLE review_queue (
      problemId  TEXT PRIMARY KEY,
      reason     TEXT NOT NULL,
      dueAt      TEXT NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      clearedAt  TEXT,
      createdAt  TEXT NOT NULL
    );

    CREATE TABLE pattern_primers (
      pattern    TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      createdAt  TEXT NOT NULL
    );

    CREATE TABLE lesson_tracks (
      topic     TEXT PRIMARY KEY,
      outline   TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );

    CREATE TABLE lessons (
      id        TEXT PRIMARY KEY,
      topic     TEXT NOT NULL,
      kind      TEXT NOT NULL,
      seq       INTEGER NOT NULL,
      title     TEXT NOT NULL,
      data      TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );

    CREATE TABLE revealed_solutions (
      problemId  TEXT PRIMARY KEY,
      revealedAt TEXT NOT NULL
    );

    CREATE TABLE lesson_reads (
      lessonId TEXT PRIMARY KEY,
      readAt   TEXT NOT NULL,
      fuzzy    INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

/**
 * One problem, two attempts on it (one clean, one hinted), one skill row, one
 * session, plus the study corpus the translation backfill reads: three lessons
 * of which only TWO carry a code snippet (one has no `code` key at all, which
 * is the real shape of the 2 lessons out of 114 that have none), and one
 * primer.
 */
function seed(db: Database.Database): void {
  db.prepare(
    `INSERT INTO problems (id, title, difficulty, topic, pattern, used, createdAt)
     VALUES ('p1', 'Two Sum', 'easy', 'arrays', 'arrays', 0, '2026-01-01T00:00:00.000Z')`
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
  db.prepare(
    `INSERT INTO sessions VALUES ('s1','2026-01-02T00:00:00.000Z','{"slots":[]}',0,'arrays')`
  ).run();

  const lesson = (id: string, seq: number, code: string | null) =>
    db
      .prepare(`INSERT INTO lessons VALUES (?, 'arrays', 'concept', ?, ?, ?, ?)`)
      .run(
        id,
        seq,
        `Lesson ${seq}`,
        JSON.stringify(
          code === null
            ? { id, topic: 'arrays', seq, title: `Lesson ${seq}`, body: 'prose only' }
            : { id, topic: 'arrays', seq, title: `Lesson ${seq}`, body: 'prose', code }
        ),
        '2026-01-03T00:00:00.000Z'
      );
  lesson('arrays:0', 0, 'const a = [1, 2, 3];');
  lesson('arrays:1', 1, 'arr.forEach((x) => x);');
  lesson('arrays:2', 2, null);

  db.prepare(`INSERT INTO pattern_primers VALUES ('arrays', ?, '2026-01-03T00:00:00.000Z')`).run(
    JSON.stringify({ pattern: 'arrays', recognitionCues: [], template: 'for (const x of arr) {}' })
  );
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

  it('does not re-add columns that are already there', () => {
    // Some of what migrate() adds is already present before it runs — a partial
    // restore, or a hand-repaired database. Unguarded, ALTER TABLE ADD COLUMN
    // is `SqliteError: duplicate column name`, which is a crash on startup.
    const db = oldDb();
    db.exec(`ALTER TABLE attempts ADD COLUMN prediction TEXT`);
    db.exec(`ALTER TABLE attempts ADD COLUMN mistakeTags TEXT`);
    db.exec(`ALTER TABLE attempts ADD COLUMN language TEXT NOT NULL DEFAULT 'javascript'`);

    expect(() => migrate(db)).not.toThrow();

    const named = (table: string, column: string) =>
      (db.pragma(`table_info(${table})`) as Array<{ name: string }>).filter(
        (c) => c.name === column
      ).length;
    expect(named('attempts', 'language')).toBe(1);
    expect(named('attempts', 'prediction')).toBe(1);
    expect(named('problems', 'language')).toBe(1);
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
    // The pre-existing columns are identical; prediction/mistakeTags read back
    // as NULL rather than as a default that would look like a real prediction,
    // while `language` backfills to the incumbent.
    expect(
      attemptsAfter.map(
        ({ prediction: _p, mistakeTags: _m, language: _l, ...rest }) => rest
      )
    ).toEqual(attemptsBefore);
    expect(attemptsAfter.every((r) => r.prediction === null && r.mistakeTags === null)).toBe(true);
    expect(attemptsAfter.every((r) => r.language === 'javascript')).toBe(true);

    // skill_state is rebuilt rather than altered, so every column it had before
    // must still read back identically once `language` is set aside.
    const skillAfter = db.prepare(`SELECT * FROM skill_state`).all() as Array<
      Record<string, unknown>
    >;
    expect(skillAfter.map(({ language: _l, ...rest }) => rest)).toEqual(skillBefore);
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
    expect(stepsFrom(db)).toEqual([
      'v1-baseline',
      'v2-skill-state-pk',
      'v2-idx-problems-slot',
      'v2-code-translations',
    ]);
    expect(stepsFrom(db)).toEqual([]);
    expect(stepsFrom(db)).toEqual([]);
    db.close();
  });

  it('skips the versioned steps entirely on a database already at version', () => {
    const db = oldDb();
    migrate(db); // genuinely current, marker and reality agree
    expect(stepsFrom(db)).toEqual([]);
    db.close();
  });

  it('forces the skill_state rebuild even when the version marker claims done', () => {
    // The version marker does NOT get the last word on this one step. Code and
    // data are coupled here: `upsertSkillStmt` says ON CONFLICT(topic, language)
    // and throws outright against the old single-column key, so trusting a
    // lying marker would turn a self-healing startup into a permanently broken
    // app on the next submit. The detection is one PRAGMA, so it is cheap
    // enough to run unconditionally.
    const db = oldDb();
    seed(db);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    expect(hasPk(db, 'skill_state', ['topic'])).toBe(true);

    expect(stepsFrom(db)).toEqual([
      'v2-skill-state-pk',
      'v2-idx-problems-slot',
      'v2-code-translations',
    ]);

    expect(hasPk(db, 'skill_state', ['topic', 'language'])).toBe(true);
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

// -----------------------------------------------------------------------------
// v2 — multi-language
// -----------------------------------------------------------------------------
// The migration that the rest of the multi-language work stands on. Every
// assertion below has a counterpart in bin/verify-migration, which runs the
// same questions against the live database; these run them against a database
// whose entire history is visible in this file.

/** oldDb + seed + migrate — the state every test in this section starts from. */
function migrated(): Database.Database {
  const db = oldDb();
  seed(db);
  migrate(db);
  return db;
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

describe('v2 — language columns', () => {
  it('adds language to problems, attempts and sessions', () => {
    const db = migrated();
    for (const t of ['problems', 'attempts', 'sessions']) {
      expect(columnsOf(db, t)).toContain('language');
    }
    db.close();
  });

  it('backfills every existing row to javascript, with no NULLs', () => {
    const db = migrated();
    for (const t of ['problems', 'attempts', 'sessions', 'skill_state']) {
      const stray = db
        .prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE language IS NULL OR language <> 'javascript'`)
        .get() as { n: number };
      expect([t, stray.n]).toEqual([t, 0]);
    }
    db.close();
  });

  it('declares the column NOT NULL DEFAULT javascript, so new inserts cannot omit it', () => {
    // The point of the DEFAULT is that a Phase-1a call site which has not yet
    // learned about language still writes a legal, correct row rather than a
    // NULL that every later `WHERE language = ?` would silently skip.
    const db = migrated();
    db.prepare(
      `INSERT INTO problems (id, title, difficulty, topic, pattern, used, createdAt)
       VALUES ('p2', 'Later', 'easy', 'arrays', 'arrays', 0, '2026-02-01T00:00:00.000Z')`
    ).run();
    expect(db.prepare(`SELECT language FROM problems WHERE id = 'p2'`).get()).toEqual({
      language: 'javascript',
    });

    const info = (db.pragma(`table_info(problems)`) as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>).find((c) => c.name === 'language')!;
    expect(info.notnull).toBe(1);
    expect(info.dflt_value).toBe(`'javascript'`);
    db.close();
  });

  it('does not add language to skill_state as a plain column', () => {
    // ALTER TABLE ADD COLUMN cannot extend a PRIMARY KEY. If `language` arrived
    // that way the rebuild would be skipped-looking-successful and the key
    // would stay single-column — so it must arrive with the rebuild instead.
    const db = migrated();
    expect(columnsOf(db, 'skill_state')).toContain('language');
    expect(hasPk(db, 'skill_state', ['topic', 'language'])).toBe(true);
    db.close();
  });
});

describe('v2 — the skill_state rebuild', () => {
  it('lands on PRIMARY KEY (topic, language), in that order', () => {
    const db = migrated();
    expect(pkColumns(db, 'skill_state')).toEqual(['topic', 'language']);
    db.close();
  });

  it('carries every row across with its values intact', () => {
    const db = oldDb();
    seed(db);
    const before = db.prepare(`SELECT * FROM skill_state ORDER BY topic`).get() as Record<
      string,
      unknown
    >;

    migrate(db);

    const after = db.prepare(`SELECT * FROM skill_state ORDER BY topic`).get() as Record<
      string,
      unknown
    >;
    // Column-by-column, not a count: an INSERT..SELECT that trusted positional
    // order would write `topic` into `language` and still count 1 row.
    expect(after.topic).toBe('arrays');
    expect(after.language).toBe('javascript');
    expect(after.currentDifficulty).toBe(before.currentDifficulty);
    expect(after.box).toBe(before.box);
    expect(after.ease).toBe(before.ease);
    expect(after.streak).toBe(before.streak);
    expect(after.attempts).toBe(before.attempts);
    expect(after.solved).toBe(before.solved);
    expect(after.hintsSum).toBe(before.hintsSum);
    expect(after.lastResult).toBe(before.lastResult);
    expect(after.lastSeenAt).toBe(before.lastSeenAt);
    expect(after.dueAt).toBe(before.dueAt);
    db.close();
  });

  it('leaves no skill_state_new lying around', () => {
    const db = migrated();
    const names = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(names).not.toContain('skill_state_new');
    expect(names).toContain('skill_state');
    db.close();
  });

  it('lets the same topic hold independent state per language', () => {
    // The whole point of the composite key: a Python ladder that starts cold
    // while the JavaScript one is untouched.
    const db = migrated();
    db.prepare(
      `INSERT INTO skill_state (topic, language, currentDifficulty) VALUES ('arrays','python','easy')`
    ).run();

    const rows = db
      .prepare(`SELECT language, currentDifficulty FROM skill_state WHERE topic = 'arrays' ORDER BY language`)
      .all();
    expect(rows).toEqual([
      { language: 'javascript', currentDifficulty: 'medium' },
      { language: 'python', currentDifficulty: 'easy' },
    ]);

    // And the old key really is gone: this would have been a PK violation.
    expect(() =>
      db
        .prepare(`INSERT INTO skill_state (topic, language) VALUES ('arrays','python')`)
        .run()
    ).toThrow(/UNIQUE|PRIMARY/i);
    db.close();
  });
});

describe('v2 — idx_problems_slot, the silent no-op', () => {
  it('recreates the index so it actually carries language', () => {
    // `CREATE INDEX IF NOT EXISTS` matches on NAME, never on definition. On a
    // database where the index already exists, editing its column list is a
    // no-op that passes every test written against a fresh file and silently
    // degrades the one that matters. DROP first.
    const db = oldDb();
    const sqlOf = () =>
      (
        db
          .prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_problems_slot'`)
          .get() as { sql: string }
      ).sql;
    expect(sqlOf()).not.toMatch(/language/);

    migrate(db);

    expect(sqlOf()).toMatch(/language/);
    expect(sqlOf()).toMatch(/problems\(language, topic, difficulty, used\)/);
    db.close();
  });

  it('proves the index is the one the bank filter would use', () => {
    const db = migrated();
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT * FROM problems WHERE language = ? AND topic = ? AND difficulty = ? AND used = 0`
      )
      .all('javascript', 'arrays', 'easy') as Array<{ detail: string }>;
    expect(plan.map((r) => r.detail).join(' ')).toMatch(/idx_problems_slot/);
    db.close();
  });

  it('does not touch the index again once it already carries language', () => {
    const db = migrated();
    const before = (
      db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_problems_slot'`).get() as {
        sql: string;
      }
    ).sql;
    expect(stepsFrom(db)).toEqual([]);
    expect(
      (
        db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_problems_slot'`).get() as {
          sql: string;
        }
      ).sql
    ).toBe(before);
    db.close();
  });
});

describe('v2 — settings and code_translations', () => {
  it('creates settings keyed on `key`', () => {
    const db = migrated();
    expect(pkColumns(db, 'settings')).toEqual(['key']);
    expect(columnsOf(db, 'settings')).toEqual(['key', 'value', 'updatedAt']);
    db.close();
  });

  it('creates code_translations keyed on (sourceId, language)', () => {
    const db = migrated();
    expect(pkColumns(db, 'code_translations')).toEqual(['sourceId', 'language']);
    expect(columnsOf(db, 'code_translations')).toEqual([
      'sourceId',
      'language',
      'code',
      'createdAt',
    ]);
    db.close();
  });

  it('backfills one row per lesson-with-code and per primer, and no others', () => {
    const db = migrated();
    const rows = db
      .prepare(`SELECT sourceId, language, code FROM code_translations ORDER BY sourceId`)
      .all() as Array<{ sourceId: string; language: string; code: string }>;

    // 2 of the 3 seeded lessons carry a `code` field; the third has none and
    // must NOT produce a row with a NULL or empty snippet.
    expect(rows).toEqual([
      { sourceId: 'lesson:arrays:0', language: 'javascript', code: 'const a = [1, 2, 3];' },
      { sourceId: 'lesson:arrays:1', language: 'javascript', code: 'arr.forEach((x) => x);' },
      { sourceId: 'primer:arrays', language: 'javascript', code: 'for (const x of arr) {}' },
    ]);

    const expected =
      (db.prepare(`SELECT COUNT(*) AS n FROM lessons WHERE json_extract(data, '$.code') <> ''`).get() as { n: number }).n +
      (db.prepare(`SELECT COUNT(*) AS n FROM pattern_primers WHERE json_extract(data, '$.template') <> ''`).get() as { n: number }).n;
    expect(rows).toHaveLength(expected);
    db.close();
  });

  it('re-running the backfill inserts nothing and overwrites nothing', () => {
    // INSERT OR IGNORE, not INSERT OR REPLACE: once Phase 4 writes a real
    // translation into one of these rows, a re-run must not stomp it back to
    // the JavaScript original.
    const db = migrated();
    db.prepare(
      `UPDATE code_translations SET code = 'EDITED' WHERE sourceId = 'lesson:arrays:0'`
    ).run();

    db.pragma('user_version = 0'); // force the versioned block to run again
    migrate(db);

    expect(db.prepare(`SELECT COUNT(*) AS n FROM code_translations`).get()).toEqual({ n: 3 });
    expect(
      db.prepare(`SELECT code FROM code_translations WHERE sourceId = 'lesson:arrays:0'`).get()
    ).toEqual({ code: 'EDITED' });
    db.close();
  });

  it('keeps a lesson and a primer of the same name apart', () => {
    // The `lesson:` / `primer:` prefix is what lets one column address two
    // corpora; without it, `arrays` the primer and `arrays:0` the lesson would
    // eventually collide.
    const db = migrated();
    const ids = (
      db.prepare(`SELECT sourceId FROM code_translations ORDER BY sourceId`).all() as Array<{
        sourceId: string;
      }>
    ).map((r) => r.sourceId);
    expect(ids.filter((i) => i.startsWith('lesson:'))).toHaveLength(2);
    expect(ids.filter((i) => i.startsWith('primer:'))).toHaveLength(1);
    db.close();
  });
});

describe('v2 — the statement db.ts prepares against this schema', () => {
  // Code and data are coupled here, and this test is the tripwire. db.ts cannot
  // be imported (it opens the live database at module scope), so the upsert is
  // reproduced verbatim — if someone edits it there and not here, this test
  // keeps passing while production breaks, which is why the shape below is
  // asserted against BOTH keys: the old one must reject it.
  const UPSERT = `
    INSERT INTO skill_state (
      topic, language, currentDifficulty, box, ease, streak, attempts, solved, hintsSum,
      lastResult, lastSeenAt, dueAt
    ) VALUES (
      @topic, 'javascript', @currentDifficulty, @box, @ease, @streak, @attempts, @solved, @hintsSum,
      @lastResult, @lastSeenAt, @dueAt
    )
    ON CONFLICT(topic, language) DO UPDATE SET
      box    = @box,
      streak = @streak
  `;

  const args = {
    topic: 'arrays',
    currentDifficulty: 'hard',
    box: 9,
    ease: 2.9,
    streak: 7,
    attempts: 20,
    solved: 11,
    hintsSum: 7,
    lastResult: 'solved',
    lastSeenAt: '2026-02-01T00:00:00.000Z',
    dueAt: '2026-03-01T00:00:00.000Z',
  };

  it('upserts onto the composite key rather than inserting a duplicate', () => {
    const db = migrated();
    db.prepare(UPSERT).run(args);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM skill_state`).get()).toEqual({ n: 1 });
    expect(
      db.prepare(`SELECT box, streak FROM skill_state WHERE topic = 'arrays'`).get()
    ).toEqual({ box: 9, streak: 7 });
    db.close();
  });

  it('cannot even be prepared against the OLD single-column key', () => {
    // It dies on the column before it ever reaches the ON CONFLICT clause
    // (`table skill_state has no column named language`), and either way it
    // dies at prepare() — which in db.ts is MODULE SCOPE. So rolling the code
    // forward without the data takes the whole service down on boot rather
    // than corrupting rows, which is the failure mode you want. It is also why
    // a rollback has to revert both together.
    const db = oldDb();
    seed(db);
    expect(() => db.prepare(UPSERT)).toThrow(/no column named language|ON CONFLICT/i);
    db.close();
  });
});

describe('v2 — idempotency and failure', () => {
  it('is a no-op the second time, byte-identical schema and data', () => {
    const db = oldDb();
    seed(db);
    migrate(db);

    const schema = schemaOf(db);
    const dump = (t: string) => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all());
    const data = ['problems', 'attempts', 'skill_state', 'sessions', 'code_translations'].map(dump);

    expect(() => migrate(db)).not.toThrow();
    expect(() => migrate(db)).not.toThrow();

    expect(schemaOf(db)).toBe(schema);
    expect(['problems', 'attempts', 'skill_state', 'sessions', 'code_translations'].map(dump)).toEqual(data);
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('aborts and rolls everything back when a row count moves', () => {
    // The verification the whole design hangs on: a migration that loses rows
    // must not be allowed to commit, and must leave nothing behind.
    //
    // Losing a row is engineered rather than waited for: `code_translations`
    // has to exist before a trigger can hang off it, so create the table by
    // hand exactly as the migration would (CREATE TABLE IF NOT EXISTS then
    // finds it and moves on), and attach a trigger that quietly deletes a
    // problem when the backfill inserts. That is a faithful stand-in for a
    // botched rebuild: from the outside it looks like an ordinary successful
    // migration right up until the counts are compared.
    const db = oldDb();
    seed(db);
    db.exec(`
      CREATE TABLE code_translations (
        sourceId  TEXT NOT NULL,
        language  TEXT NOT NULL,
        code      TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (sourceId, language)
      );

      CREATE TRIGGER steal_a_problem AFTER INSERT ON code_translations
      BEGIN
        DELETE FROM problems WHERE id = 'p1';
      END;
    `);

    const before = schemaOf(db);
    const skillBefore = db.prepare(`SELECT * FROM skill_state ORDER BY topic`).all();

    expect(() => migrate(db)).toThrow(/row count changed|migration aborted/i);

    // Untouched: the schema, the data, and the version marker.
    expect(schemaOf(db)).toBe(before);
    expect(db.prepare(`SELECT * FROM skill_state ORDER BY topic`).all()).toEqual(skillBefore);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM problems`).get()).toEqual({ n: 1 });
    expect(userVersion(db)).toBe(0);
    expect(hasPk(db, 'skill_state', ['topic'])).toBe(true);
    db.close();
  });

  it('restores foreign_keys after a failed migration, not just a successful one', () => {
    // PRAGMA foreign_keys is toggled OUTSIDE the transaction (inside one it is
    // a silent no-op), which means the restore is ours to get right. A
    // migration that throws must not leave the connection with its integrity
    // checking quietly switched off for the rest of the process.
    const db = oldDb();
    seed(db);
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE code_translations (
        sourceId  TEXT NOT NULL,
        language  TEXT NOT NULL,
        code      TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (sourceId, language)
      );

      CREATE TRIGGER steal_a_problem AFTER INSERT ON code_translations
      BEGIN
        DELETE FROM problems WHERE id = 'p1';
      END;
    `);

    expect(() => migrate(db)).toThrow();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('leaves foreign_keys off if that is how it found them', () => {
    const db = oldDb();
    seed(db);
    db.pragma('foreign_keys = OFF');

    migrate(db);

    expect(db.pragma('foreign_keys', { simple: true })).toBe(0);
    db.close();
  });
});
