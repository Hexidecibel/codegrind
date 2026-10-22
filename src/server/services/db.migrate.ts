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
export const SCHEMA_VERSION = 4;

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

/**
 * The v4 mock_gaps shape, as a template so the always-run CREATE (fresh
 * databases) and the v4 rebuild (old ones) cannot drift apart. Every gap is
 * a drill card: `title` is the front, `answer` the back, and step..retiredAt
 * the schedule (src/shared/gap-cards.ts).
 */
const MOCK_GAPS_V4 = (name: string) => `
        CREATE TABLE IF NOT EXISTS ${name} (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          mockId         TEXT NOT NULL REFERENCES mocks(id) ON DELETE CASCADE,
          seq            INTEGER,                        -- the turn it surfaced on; NULL = grader, no turn
          concept        TEXT NOT NULL,
          type           TEXT NOT NULL DEFAULT 'skill',  -- fact | skill
          title          TEXT NOT NULL DEFAULT '',       -- card front: a self-contained question
          summary        TEXT NOT NULL,                  -- what the candidate did not know
          answer         TEXT NOT NULL DEFAULT '',       -- card back: 2-4 sentences incl. why it matters
          source         TEXT NOT NULL DEFAULT 'turn',   -- turn | grade | backfill
          step           INTEGER NOT NULL DEFAULT 0,     -- rung on GAP_CARD_LADDER_DAYS
          dueAt          TEXT NOT NULL,
          reps           INTEGER NOT NULL DEFAULT 0,
          lapses         INTEGER NOT NULL DEFAULT 0,
          lastGrade      TEXT,                           -- got | shaky | missed
          lastReviewedAt TEXT,
          retiredAt      TEXT,
          createdAt      TEXT NOT NULL
        );`;

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

      // v3. Did every `expected` value on this problem come out of a real
      // sandbox run of its reference solution?
      //
      // DEFAULT 0, NOT 1, and the difference matters. The default is what an
      // INSERT that forgets this column gets, and the safe thing to assume about
      // a problem nobody vouched for is that nobody vouched for it. Existing
      // rows are backfilled to 1 by the versioned step below — explicitly,
      // because they are all JavaScript, all already served, and all
      // demonstrably solvable, which is a claim about THIS database rather than
      // a property of the column.
      const addedCanonicalized = tableExists(db, 'problems')
        && !columnExists(db, 'problems', 'canonicalized');
      addColumnIfMissing(db, 'problems', 'canonicalized', 'INTEGER NOT NULL DEFAULT 0');

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

      // Mock interviews. Four new tables, no change to any existing one, so they
      // are always-run CREATE IF NOT EXISTS rather than a version bump: there is
      // nothing to backfill and nothing to rebuild. JSON columns hold shapes from
      // src/shared/mock.ts, which Phase 2's knowledge fold will read back —
      // `mock_turns.meta.observations` and `mock_grades.grade.conceptObservations`
      // are the raw events behind "known / shaky / next" and retire-after-3.
      //
      // `mock_turns.rendered` is the EXACT text sent to the model for that turn
      // (a candidate turn's control notes included). It is replayed verbatim on
      // every later request; recomputing it would move the cached prefix. See
      // mock.state.ts.
      db.exec(`
        CREATE TABLE IF NOT EXISTS mocks (
          id          TEXT PRIMARY KEY,
          kind        TEXT NOT NULL,             -- 'system-design' (Phase 4 adds 'behavioral')
          level       TEXT NOT NULL,             -- senior | staff | principal
          promptId    TEXT,
          prompt      TEXT NOT NULL,             -- the brief, frozen at start
          status      TEXT NOT NULL,             -- active | grading | graded | grade_failed | abandoned
          context     TEXT NOT NULL,             -- the first user message, frozen
          digest      TEXT,                      -- short post-grade summary (Phase 2 reads it)
          state       TEXT NOT NULL,             -- JSON MockState
          usage       TEXT NOT NULL,             -- JSON MockUsage
          turnCount   INTEGER NOT NULL DEFAULT 0,
          createdAt   TEXT NOT NULL,
          updatedAt   TEXT NOT NULL,
          endedAt     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_mocks_created ON mocks (createdAt);

        CREATE TABLE IF NOT EXISTS mock_turns (
          mockId    TEXT NOT NULL REFERENCES mocks(id) ON DELETE CASCADE,
          seq       INTEGER NOT NULL,
          role      TEXT NOT NULL,               -- interviewer | candidate
          kind      TEXT NOT NULL,               -- answer | control | question | nudge | offer | teach | wrap_up
          content   TEXT NOT NULL,               -- what was said / typed
          rendered  TEXT NOT NULL,               -- what the model was sent, byte for byte
          stage     TEXT NOT NULL,
          meta      TEXT,                        -- JSON: mode, teach, action, observations, call usage
          createdAt TEXT NOT NULL,
          PRIMARY KEY (mockId, seq)
        );

        ${MOCK_GAPS_V4('mock_gaps')}

        CREATE TABLE IF NOT EXISTS mock_grades (
          mockId    TEXT PRIMARY KEY REFERENCES mocks(id) ON DELETE CASCADE,
          level     TEXT NOT NULL,
          verdict   TEXT NOT NULL,
          grade     TEXT NOT NULL,               -- JSON MockGrade
          usage     TEXT NOT NULL,               -- JSON: the grade call(s) alone
          createdAt TEXT NOT NULL
        );
      `);

      // The "Today" routine. One row per LOCAL day, holding only what cannot be
      // derived from real rows: skips, "end day early", the day's chosen mock
      // kind, and the debrief. Step state itself is recomputed from attempts,
      // mocks, cards and the review queue on every GET (today.service.ts), so
      // nothing here can drift from what actually happened. A new table, no
      // backfill → always-run, no version bump.
      db.exec(`
        CREATE TABLE IF NOT EXISTS daily_sessions (
          date          TEXT PRIMARY KEY,          -- local YYYY-MM-DD (CODEGRIND_TZ)
          mockKind      TEXT,                      -- the day's mock kind, frozen on first read
          skips         TEXT NOT NULL DEFAULT '[]',-- JSON TodayStepId[]
          endedEarlyAt  TEXT,
          debrief       TEXT,                      -- JSON Debrief
          debriefUsage  TEXT,                      -- JSON DebriefUsage
          debriefAt     TEXT,
          createdAt     TEXT NOT NULL,
          updatedAt     TEXT NOT NULL
        );
      `);

      // The Recognize drill (pattern matching, no code). Three new tables, no
      // backfill → always-run. Deliberately NOT attempts/skill_state/review_queue:
      // a recognize card is not a solve and must never move tier credit.
      //   recognize_attempts  one row per graded card (accuracy, Today, Reflect)
      //   recognize_cards     the SRS schedule for misses/shaky, one per problem,
      //                       on the gap-card ladder (shared/gap-cards.ts)
      //   recognize_notes     the problem-specific key insight + optimal
      //                       complexity, cached from the first AI check
      db.exec(`
        CREATE TABLE IF NOT EXISTS recognize_attempts (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          problemId      TEXT NOT NULL,
          topic          TEXT NOT NULL,
          picked         TEXT,
          patternCorrect INTEGER NOT NULL,
          approach       TEXT NOT NULL DEFAULT '',
          selfGrade      TEXT NOT NULL,              -- got | shaky | missed, as clicked
          grade          TEXT NOT NULL,              -- effective: a wrong pick is missed
          codeShown      INTEGER NOT NULL DEFAULT 0,
          aiVerdict      TEXT,                       -- correct | partly | wrong | NULL
          durationMs     INTEGER,
          createdAt      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_recognize_attempts_created ON recognize_attempts (createdAt);

        CREATE TABLE IF NOT EXISTS recognize_cards (
          problemId      TEXT PRIMARY KEY,
          topic          TEXT NOT NULL,
          step           INTEGER NOT NULL DEFAULT 0,
          dueAt          TEXT NOT NULL,
          reps           INTEGER NOT NULL DEFAULT 0,
          lapses         INTEGER NOT NULL DEFAULT 0,
          lastGrade      TEXT,
          lastReviewedAt TEXT,
          retiredAt      TEXT,
          createdAt      TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS recognize_notes (
          problemId  TEXT PRIMARY KEY,
          keyInsight TEXT NOT NULL,
          time       TEXT NOT NULL,
          space      TEXT NOT NULL,
          createdAt  TEXT NOT NULL
        );
      `);

      // Phase F (AI review on every step). Always-run, self-detecting:
      //   daily_sessions.stepNotes   JSON StepNotes — one AI note per finished step
      //   daily_sessions.aiFailures  JSON {target: {n, at}} — the retry budget, so a
      //                              dead model can never turn GET /api/today into
      //                              a retry loop
      //   recognize_checks           the Recognize AI check, cached per
      //                              (problem, pick, answer) so an identical answer
      //                              is never paid for twice
      //   ai_usage                   the spend ledger: one row per model call,
      //                              written by llm.client's usage recorder. Created
      //                              WITH a one-time backfill from the two places
      //                              usage was stored before it (mocks.usage, the
      //                              debrief) so "this month" is not zero on day one.
      if (tableExists(db, 'daily_sessions')) {
        addColumnIfMissing(db, 'daily_sessions', 'stepNotes', 'TEXT');
        addColumnIfMissing(db, 'daily_sessions', 'aiFailures', 'TEXT');
        addColumnIfMissing(db, 'daily_sessions', 'debriefRegens', 'INTEGER NOT NULL DEFAULT 0');
      }
      // Phase H: the review queue's spaced ladder (review-ladder.ts). Additive,
      // no backfill: an old row reads as rung 0 with its miss on an earlier day.
      if (tableExists(db, 'review_queue')) {
        addColumnIfMissing(db, 'review_queue', 'rung', 'INTEGER NOT NULL DEFAULT 0');
        addColumnIfMissing(db, 'review_queue', 'lastMissAt', 'TEXT');
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS recognize_checks (
          key        TEXT PRIMARY KEY,           -- sha256(problemId|pick|normalized answer)
          problemId  TEXT NOT NULL,
          result     TEXT NOT NULL,              -- JSON RecognizeCheck (cost as paid)
          createdAt  TEXT NOT NULL
        );
      `);
      const hadLedger = tableExists(db, 'ai_usage');
      db.exec(`
        CREATE TABLE IF NOT EXISTS ai_usage (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          at           TEXT NOT NULL,
          source       TEXT NOT NULL,            -- the forced tool's name, 'text', or 'backfill:*'
          role         TEXT NOT NULL,
          model        TEXT NOT NULL,
          inputTokens  INTEGER NOT NULL DEFAULT 0,
          outputTokens INTEGER NOT NULL DEFAULT 0,
          cacheRead    INTEGER NOT NULL DEFAULT 0,
          cacheWrite   INTEGER NOT NULL DEFAULT 0,
          costUsd      REAL                      -- NULL = unpriced (a local model)
        );
        CREATE INDEX IF NOT EXISTS idx_ai_usage_at ON ai_usage (at);
      `);
      if (!hadLedger) {
        if (tableExists(db, 'mocks') && columnExists(db, 'mocks', 'usage')) {
          db.exec(`
            INSERT INTO ai_usage (at, source, role, model, inputTokens, outputTokens, cacheRead, cacheWrite, costUsd)
            SELECT createdAt, 'backfill:mock', 'workhorse',
                   COALESCE(json_extract(usage, '$.models[0]'), 'unknown'),
                   COALESCE(json_extract(usage, '$.inputTokens'), 0),
                   COALESCE(json_extract(usage, '$.outputTokens'), 0),
                   COALESCE(json_extract(usage, '$.cacheReadTokens'), 0),
                   COALESCE(json_extract(usage, '$.cacheWriteTokens'), 0),
                   json_extract(usage, '$.costUsd')
            FROM mocks WHERE json_valid(usage) AND COALESCE(json_extract(usage, '$.calls'), 0) > 0;
          `);
        }
        if (tableExists(db, 'daily_sessions')) {
          db.exec(`
            INSERT INTO ai_usage (at, source, role, model, inputTokens, outputTokens, costUsd)
            SELECT COALESCE(debriefAt, updatedAt), 'backfill:debrief', 'small',
                   COALESCE(json_extract(debriefUsage, '$.model'), 'unknown'),
                   COALESCE(json_extract(debriefUsage, '$.inputTokens'), 0),
                   COALESCE(json_extract(debriefUsage, '$.outputTokens'), 0),
                   json_extract(debriefUsage, '$.costUsd')
            FROM daily_sessions WHERE debriefUsage IS NOT NULL AND json_valid(debriefUsage);
          `);
        }
      }

      // Phase G (Envelope math drill). Two new tables, no backfill → always-run.
      //   envelope_cards     the SRS schedule for misses (gap-card ladder, with
      //                      a one-day floor like recognize_cards), seeded cards
      //                      and cards made from estimation gaps in mocks. The
      //                      item itself is stored as JSON (shared/envelope.ts).
      //   envelope_attempts  one row per checked answer: accuracy, the orders-of-
      //                      magnitude error and the likely cause, for Reflect
      //                      and Today; plus the AI note once it is written.
      db.exec(`
        CREATE TABLE IF NOT EXISTS envelope_cards (
          key            TEXT PRIMARY KEY,           -- seed:* | g:<kind>:<seed> | mock:<gapId>
          item           TEXT NOT NULL,              -- JSON EnvelopeItem
          source         TEXT NOT NULL,              -- seed | miss | mock
          mockId         TEXT,
          step           INTEGER NOT NULL DEFAULT 0,
          dueAt          TEXT NOT NULL,
          reps           INTEGER NOT NULL DEFAULT 0,
          lapses         INTEGER NOT NULL DEFAULT 0,
          lastGrade      TEXT,
          lastReviewedAt TEXT,
          retiredAt      TEXT,
          createdAt      TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS envelope_attempts (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          itemKey   TEXT NOT NULL,
          cardKey   TEXT,                            -- set when a due card was answered
          kind      TEXT NOT NULL,
          question  TEXT NOT NULL,
          answer    TEXT NOT NULL,                   -- as typed
          working   TEXT NOT NULL DEFAULT '',
          expected  REAL NOT NULL,
          given     REAL NOT NULL,
          ok        INTEGER NOT NULL,
          orders    REAL NOT NULL,                   -- log10(given / expected)
          cause     TEXT,
          aiNote    TEXT,                            -- JSON EnvelopeNote
          createdAt TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_envelope_attempts_created ON envelope_attempts (createdAt);
      `);

      // Phase H2 (interview loops, 30-min day, readiness). Additive, always-run:
      //   interview_loops                one row per target interview day
      //   card_reviews                   one row per drill-card self-grade, with
      //                                  the interval it was recalled over — the
      //                                  readiness model's "retention at 5+ days"
      //   daily_sessions.quick           the day's "30-min day" toggle
      //   daily_sessions.finalReviewAt   the final review pulled items due (once)
      //   daily_sessions.recognizeStocked bank problems generated today so
      //                                  Recognize can reach an empty topic (bounded)
      db.exec(`
        CREATE TABLE IF NOT EXISTS interview_loops (
          id           TEXT PRIMARY KEY,
          company      TEXT NOT NULL,
          date         TEXT NOT NULL,              -- YYYY-MM-DD, local
          rounds       TEXT NOT NULL,              -- JSON RoundType[]
          postingId    TEXT,
          postingTitle TEXT,
          createdAt    TEXT NOT NULL,
          updatedAt    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_interview_loops_date ON interview_loops (date);

        CREATE TABLE IF NOT EXISTS card_reviews (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          cardId       INTEGER NOT NULL,
          grade        TEXT NOT NULL,
          intervalDays REAL NOT NULL,              -- since its last review (or creation)
          at           TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_card_reviews_at ON card_reviews (at);
      `);
      if (tableExists(db, 'daily_sessions')) {
        addColumnIfMissing(db, 'daily_sessions', 'quick', 'INTEGER NOT NULL DEFAULT 0');
        addColumnIfMissing(db, 'daily_sessions', 'finalReviewAt', 'TEXT');
        addColumnIfMissing(db, 'daily_sessions', 'recognizeStocked', 'INTEGER NOT NULL DEFAULT 0');
      }

      // Phase H3 (concept reps + the AI-systems track). Additive, always-run:
      //   concept_reps          one row per GRADED rep (the grade, the rubric
      //                         hits/misses, the model answer) — learning state,
      //                         the daily pick, readiness and the debrief read it
      //   concept_learning      when a concept was learned (primer acknowledged
      //                         or its track lesson read): new -> learning
      //   concept_lessons       one generated AI-systems lesson per concept, cached
      //   daily_sessions.conceptPick   the day's frozen pick (JSON)
      //   interview_loops.aiFocus      the loop is at an AI-focused company
      db.exec(`
        CREATE TABLE IF NOT EXISTS concept_reps (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          day        TEXT NOT NULL,                -- local YYYY-MM-DD
          concept    TEXT NOT NULL,
          promptIdx  INTEGER NOT NULL DEFAULT 0,
          question   TEXT NOT NULL,
          answer     TEXT NOT NULL,
          primed     INTEGER NOT NULL DEFAULT 0,   -- opened with the teach-first primer
          grade      TEXT NOT NULL,                -- got | shaky | missed
          result     TEXT NOT NULL,                -- JSON: hit, missed, why, modelAnswer, followUp
          cardId     INTEGER,                      -- the drill card minted from a miss
          model      TEXT NOT NULL DEFAULT '',
          costUsd    REAL,
          createdAt  TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_concept_reps_created ON concept_reps (createdAt);

        CREATE TABLE IF NOT EXISTS concept_learning (
          concept    TEXT PRIMARY KEY,
          learnedAt  TEXT NOT NULL,
          via        TEXT NOT NULL                 -- primer | lesson
        );

        CREATE TABLE IF NOT EXISTS concept_lessons (
          concept    TEXT PRIMARY KEY,
          lesson     TEXT NOT NULL,                -- JSON ConceptLesson
          createdAt  TEXT NOT NULL
        );
      `);
      if (tableExists(db, 'daily_sessions')) addColumnIfMissing(db, 'daily_sessions', 'conceptPick', 'TEXT');
      if (tableExists(db, 'interview_loops')) addColumnIfMissing(db, 'interview_loops', 'aiFocus', 'INTEGER NOT NULL DEFAULT 0');

      // Phase H4 (story forge). Additive, always-run: one row per forge session —
      // the seed, the coach/candidate turns, the latest STAR draft, and what was
      // saved to resume-builder (the story id) and minted (the retell card).
      db.exec(`
        CREATE TABLE IF NOT EXISTS story_forge_sessions (
          id            TEXT PRIMARY KEY,
          day           TEXT NOT NULL,              -- local YYYY-MM-DD
          seed          TEXT NOT NULL,              -- JSON ForgeSeed
          status        TEXT NOT NULL,              -- active | drafted | saved | abandoned
          turns         TEXT NOT NULL,              -- JSON ForgeTurn[]
          covered       TEXT NOT NULL DEFAULT '[]', -- JSON ForgeBeat[]
          draft         TEXT,                       -- JSON StoryDraft
          savedStoryId  TEXT,
          cardId        INTEGER,
          costUsd       REAL NOT NULL DEFAULT 0,
          calls         INTEGER NOT NULL DEFAULT 0,
          createdAt     TEXT NOT NULL,
          updatedAt     TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_forge_day ON story_forge_sessions (day);
      `);

      // Phase I (Envelope learning upgrades). Additive, always-run:
      //   envelope_steps          one row per checked guided step: the type, what
      //                           was typed, right or not and the named slip. Rows
      //                           with counted = 0 only reset a faded step's streak
      //                           (a final miss brought it back) and stay out of
      //                           the error rates.
      //   envelope_anchor_cards   the SRS schedule per anchor flashcard (id from
      //                           shared/envelope-learn.ts ANCHOR_CARDS)
      //   envelope_speed_rounds   one row per 60 s speed round
      //   envelope_attempts.mode       plain | guided
      //   envelope_attempts.failedStep the guided step that broke (for the AI note)
      db.exec(`
        CREATE TABLE IF NOT EXISTS envelope_steps (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          itemKey   TEXT NOT NULL,
          stepType  TEXT NOT NULL,
          stepIndex INTEGER NOT NULL,
          prompt    TEXT NOT NULL,
          answer    TEXT NOT NULL,
          ok        INTEGER NOT NULL,
          slip      TEXT,
          feedback  TEXT NOT NULL DEFAULT '',
          counted   INTEGER NOT NULL DEFAULT 1,
          createdAt TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_envelope_steps_type ON envelope_steps (stepType, createdAt);
        CREATE INDEX IF NOT EXISTS idx_envelope_steps_item ON envelope_steps (itemKey, createdAt);

        CREATE TABLE IF NOT EXISTS envelope_anchor_cards (
          id             TEXT PRIMARY KEY,
          step           INTEGER NOT NULL DEFAULT 0,
          dueAt          TEXT NOT NULL,
          reps           INTEGER NOT NULL DEFAULT 0,
          lapses         INTEGER NOT NULL DEFAULT 0,
          lastGrade      TEXT,
          lastReviewedAt TEXT,
          retiredAt      TEXT,
          createdAt      TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS envelope_speed_rounds (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          score      INTEGER NOT NULL,
          correct    INTEGER NOT NULL,
          attempted  INTEGER NOT NULL,
          bestStreak INTEGER NOT NULL,
          createdAt  TEXT NOT NULL
        );
      `);
      // Pattern shapes (/patterns) + Today's Pattern Refresh:
      //   pattern_recall_cards    the SRS schedule per pattern for "write it
      //                           from memory" (id = shared/pattern-shapes
      //                           PatternId), on the gap-card ladder
      //   pattern_recall_reviews  one row per self-grade (what Today reads)
      //   pattern_views           a pattern card opened from Today (Re-learn)
      //   refresh_days            which refresh day each local date is, and
      //                           the cold-review problem it chose
      db.exec(`
        CREATE TABLE IF NOT EXISTS pattern_recall_cards (
          id             TEXT PRIMARY KEY,
          step           INTEGER NOT NULL DEFAULT 0,
          dueAt          TEXT NOT NULL,
          reps           INTEGER NOT NULL DEFAULT 0,
          lapses         INTEGER NOT NULL DEFAULT 0,
          lastGrade      TEXT,
          lastReviewedAt TEXT,
          retiredAt      TEXT,
          createdAt      TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pattern_recall_reviews (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          pattern   TEXT NOT NULL,
          grade     TEXT NOT NULL,
          answer    TEXT NOT NULL DEFAULT '',
          createdAt TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pattern_recall_reviews ON pattern_recall_reviews (pattern, createdAt);
        CREATE TABLE IF NOT EXISTS pattern_views (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          pattern   TEXT NOT NULL,
          createdAt TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pattern_views ON pattern_views (pattern, createdAt);
        CREATE TABLE IF NOT EXISTS refresh_days (
          date          TEXT PRIMARY KEY,
          day           INTEGER NOT NULL,
          coldProblemId TEXT,
          createdAt     TEXT NOT NULL
        );
      `);
      if (tableExists(db, 'envelope_attempts')) {
        addColumnIfMissing(db, 'envelope_attempts', 'mode', "TEXT NOT NULL DEFAULT 'plain'");
        addColumnIfMissing(db, 'envelope_attempts', 'failedStep', 'TEXT');
      }

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

      if (from < 3 || addedCanonicalized) {
        // The backfill fires if and only if THIS run created the column — which
        // is exactly the condition "there are rows here that predate it". That
        // is a stronger gate than the version marker: re-running against a warm
        // database cannot flip a legitimately un-canonicalized problem back to
        // 1, and a database whose marker lies still gets backfilled the moment
        // the column is actually missing.
        //
        // Every row that exists at this point is a JavaScript problem that has
        // already been served and solved, so 1 is the truth about all of them.
        if (addedCanonicalized) {
          db.exec(`UPDATE problems SET canonicalized = 1`);
          opts.onStep?.('v3-problems-canonicalized');
        }
      }

      // v4. mock_gaps grows into drill cards: a fact/skill type, a card front
      // and back, and the spaced-repetition schedule. The old key was
      // (mockId, seq) — one gap per teach turn — but a turn can now supply
      // several gaps and the grader adds ones with no turn at all, so the key
      // changes and that means a rebuild. Self-detecting (no `type` column =
      // old shape), so a lying version marker still gets it.
      //
      // Existing rows default to `skill` with an empty answer: Phase 1 only
      // recorded teach-mode gaps, and those were all reasoning moves. Each one
      // becomes a card due at the moment it was recorded.
      const needsGapRebuild = tableExists(db, 'mock_gaps') && !columnExists(db, 'mock_gaps', 'type');
      if (from < 4 || needsGapRebuild) {
        if (needsGapRebuild) {
          const n = countRows(db, 'mock_gaps');
          db.exec(`
            ${MOCK_GAPS_V4('mock_gaps_new')}
            INSERT INTO mock_gaps_new (mockId, seq, concept, type, title, summary, answer, source, dueAt, createdAt)
            SELECT mockId, seq, concept, 'skill', '', summary, '', 'turn', createdAt, createdAt
            FROM mock_gaps ORDER BY createdAt, seq;
            DROP TABLE mock_gaps;
            ALTER TABLE mock_gaps_new RENAME TO mock_gaps;
          `);
          const got = countRows(db, 'mock_gaps');
          if (got !== n) {
            throw new Error(`migration aborted: mock_gaps row count changed ${n} -> ${got} in the v4 rebuild.`);
          }
          opts.onStep?.('v4-mock-gap-cards');
        }
        db.exec(`CREATE INDEX IF NOT EXISTS idx_mock_gaps_due ON mock_gaps (retiredAt, dueAt);`);
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
      //
      // GATED ON `needsSkillPk`, and that gate is load-bearing rather than an
      // optimisation. The invariant being asserted is "the COPY put every
      // pre-existing row on the default language" — which is a statement about
      // rows this transaction just moved, not about the table. Run
      // unconditionally, it re-reads as "no skill_state row may ever be in
      // another language", which was true only for as long as the app was
      // JavaScript-only: the first Python submit writes ('arrays','python'),
      // and from then on EVERY subsequent startup aborts its own migration and
      // crash-loops the service against a database that is in fact perfect.
      // (Latent from Phase 1a; reachable from the first Python solve in
      // Phase 3; found in Phase 4 by importing db.ts from a CLI script.)
      if (needsSkillPk && tableExists(db, 'skill_state') && columnExists(db, 'skill_state', 'language')) {
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

      // Same idea for the canonicalized flag, which is a boolean stored in a
      // column SQLite will happily accept a string into.
      if (tableExists(db, 'problems') && columnExists(db, 'problems', 'canonicalized')) {
        const bad = (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM problems
                WHERE canonicalized IS NULL OR canonicalized NOT IN (0, 1)`
            )
            .get() as { n: number }
        ).n;
        if (bad !== 0) {
          throw new Error(
            `migration aborted: ${bad} problems row(s) have a canonicalized value that is neither 0 nor 1.`
          );
        }
        // If this run added the column, the backfill above claimed every row.
        // A row still at 0 means the UPDATE did not reach it, and serving would
        // then silently refuse problems the player has already solved.
        if (addedCanonicalized) {
          const missed = (
            db.prepare(`SELECT COUNT(*) AS n FROM problems WHERE canonicalized <> 1`).get() as {
              n: number;
            }
          ).n;
          if (missed !== 0) {
            throw new Error(
              `migration aborted: ${missed} pre-existing problems row(s) were not backfilled to canonicalized = 1.`
            );
          }
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
