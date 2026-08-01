import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ProblemRecord,
  Problem,
  Difficulty,
  Topic,
  AttemptRecord,
  PatternStat,
  SessionPlan,
  Prediction,
  Primer,
  MistakeStat,
} from '../../shared/types.js';

// -----------------------------------------------------------------------------
// Connection — SQLite on NVMe (DATA_DIR, gitignored). WAL for concurrency.
// -----------------------------------------------------------------------------
const DATA_DIR = process.env.DATA_DIR || './data';
fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'codegrind.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// -----------------------------------------------------------------------------
// Schema (idempotent, created on startup)
// -----------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS problems (
    id                TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    prompt            TEXT NOT NULL,
    examples          TEXT NOT NULL,   -- JSON Example[]
    constraints       TEXT NOT NULL,   -- JSON string[]
    difficulty        TEXT NOT NULL,
    topic             TEXT NOT NULL,
    pattern           TEXT NOT NULL,
    starterCode       TEXT NOT NULL,
    functionName      TEXT NOT NULL,
    sampleTests       TEXT NOT NULL,   -- JSON TestCase[]
    hiddenTests       TEXT NOT NULL,   -- JSON TestCase[] (server-only)
    referenceSolution TEXT NOT NULL,   -- server-only
    used              INTEGER NOT NULL DEFAULT 0,
    createdAt         TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attempts (
    id           TEXT PRIMARY KEY,
    problemId    TEXT NOT NULL,
    pattern      TEXT NOT NULL,
    difficulty   TEXT NOT NULL,
    solved       INTEGER NOT NULL,
    hintsUsed    INTEGER NOT NULL DEFAULT 0,
    testsPassed  INTEGER NOT NULL,
    testsTotal   INTEGER NOT NULL,
    code         TEXT NOT NULL,
    createdAt    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_attempts_pattern ON attempts(pattern);
  CREATE INDEX IF NOT EXISTS idx_attempts_problem ON attempts(problemId);
  CREATE INDEX IF NOT EXISTS idx_problems_slot ON problems(topic, difficulty, used);

  -- Adaptive Grind Mode: per-topic spaced-repetition / progression state.
  CREATE TABLE IF NOT EXISTS skill_state (
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

  -- Adaptive Grind Mode: one row per grind sitting.
  CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    createdAt  TEXT NOT NULL,
    plan       TEXT NOT NULL,   -- JSON SessionPlan
    served     INTEGER NOT NULL DEFAULT 0,
    lastTopic  TEXT
  );

  -- Retrieval loop: spaced re-solve queue of failed / hint-assisted problems.
  CREATE TABLE IF NOT EXISTS review_queue (
    problemId  TEXT PRIMARY KEY,
    reason     TEXT NOT NULL,          -- 'failed' | 'hinted'
    dueAt      TEXT NOT NULL,          -- ISO; earliest due<=now, cleared IS NULL = serve
    attempts   INTEGER NOT NULL DEFAULT 0,
    clearedAt  TEXT,                   -- set on a clean unaided solve
    createdAt  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_review_due ON review_queue(clearedAt, dueAt);

  -- Pattern primers: durable per-pattern cheat-sheet cards (generated + cached).
  CREATE TABLE IF NOT EXISTS pattern_primers (
    pattern    TEXT PRIMARY KEY,       -- the topic id
    data       TEXT NOT NULL,          -- JSON Primer
    createdAt  TEXT NOT NULL
  );
`);

// -----------------------------------------------------------------------------
// Idempotent column migrations — better-sqlite3 throws on a duplicate ADD COLUMN,
// so guard each with a PRAGMA table_info check (safe to re-run on every startup).
// -----------------------------------------------------------------------------
function columnExists(table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}
function addColumnIfMissing(table: string, column: string, decl: string): void {
  if (!columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}
// Retrieval loop / mistake ledger: nullable JSON columns on attempts.
addColumnIfMissing('attempts', 'prediction', 'TEXT');   // JSON Prediction | null
addColumnIfMissing('attempts', 'mistakeTags', 'TEXT');  // JSON string[] | null

// -----------------------------------------------------------------------------
// Row <-> record mapping
// -----------------------------------------------------------------------------
interface ProblemRow {
  id: string;
  title: string;
  prompt: string;
  examples: string;
  constraints: string;
  difficulty: string;
  topic: string;
  pattern: string;
  starterCode: string;
  functionName: string;
  sampleTests: string;
  hiddenTests: string;
  referenceSolution: string;
  used: number;
  createdAt: string;
}

function rowToProblem(row: ProblemRow): ProblemRecord {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    examples: JSON.parse(row.examples),
    constraints: JSON.parse(row.constraints),
    difficulty: row.difficulty as Difficulty,
    topic: row.topic as Topic,
    pattern: row.pattern,
    starterCode: row.starterCode,
    functionName: row.functionName,
    sampleTests: JSON.parse(row.sampleTests),
    hiddenTests: JSON.parse(row.hiddenTests),
    referenceSolution: row.referenceSolution,
    used: row.used === 1,
    createdAt: row.createdAt,
  };
}

// -----------------------------------------------------------------------------
// Problem bank
// -----------------------------------------------------------------------------
const insertProblemStmt = db.prepare(`
  INSERT INTO problems (
    id, title, prompt, examples, constraints, difficulty, topic, pattern,
    starterCode, functionName, sampleTests, hiddenTests, referenceSolution,
    used, createdAt
  ) VALUES (
    @id, @title, @prompt, @examples, @constraints, @difficulty, @topic, @pattern,
    @starterCode, @functionName, @sampleTests, @hiddenTests, @referenceSolution,
    @used, @createdAt
  )
`);

export function insertProblem(p: ProblemRecord): void {
  insertProblemStmt.run({
    id: p.id,
    title: p.title,
    prompt: p.prompt,
    examples: JSON.stringify(p.examples),
    constraints: JSON.stringify(p.constraints),
    difficulty: p.difficulty,
    topic: p.topic,
    pattern: p.pattern,
    starterCode: p.starterCode,
    functionName: p.functionName,
    sampleTests: JSON.stringify(p.sampleTests),
    hiddenTests: JSON.stringify(p.hiddenTests),
    referenceSolution: p.referenceSolution,
    used: p.used ? 1 : 0,
    createdAt: p.createdAt,
  });
}

const getProblemStmt = db.prepare(`SELECT * FROM problems WHERE id = ?`);

export function getProblem(id: string): ProblemRecord | null {
  const row = getProblemStmt.get(id) as ProblemRow | undefined;
  return row ? rowToProblem(row) : null;
}

const findUnusedStmt = db.prepare(`
  SELECT * FROM problems
  WHERE topic = ? AND difficulty = ? AND used = 0
  ORDER BY createdAt ASC
  LIMIT 1
`);

/** Pick an unused problem for a topic+difficulty slot, or null if the bank is empty. */
export function findUnusedProblem(
  topic: Topic,
  difficulty: Difficulty
): ProblemRecord | null {
  const row = findUnusedStmt.get(topic, difficulty) as ProblemRow | undefined;
  return row ? rowToProblem(row) : null;
}

const markUsedStmt = db.prepare(`UPDATE problems SET used = 1 WHERE id = ?`);
export function markProblemUsed(id: string): void {
  markUsedStmt.run(id);
}

const countBankStmt = db.prepare(`SELECT COUNT(*) AS n FROM problems`);
export function bankSize(): number {
  return (countBankStmt.get() as { n: number }).n;
}

// -----------------------------------------------------------------------------
// Attempts
// -----------------------------------------------------------------------------
const insertAttemptStmt = db.prepare(`
  INSERT INTO attempts (
    id, problemId, pattern, difficulty, solved, hintsUsed,
    testsPassed, testsTotal, code, createdAt, prediction, mistakeTags
  ) VALUES (
    @id, @problemId, @pattern, @difficulty, @solved, @hintsUsed,
    @testsPassed, @testsTotal, @code, @createdAt, @prediction, @mistakeTags
  )
`);

export interface AttemptInput {
  id: string;
  problemId: string;
  pattern: string;
  difficulty: Difficulty;
  solved: boolean;
  hintsUsed: number;
  testsPassed: number;
  testsTotal: number;
  code: string;
  createdAt: string;
  /** Optional pre-solve prediction stored as JSON (retrieval loop). */
  prediction?: Prediction | null;
  /** Optional coach-emitted mistake tags stored as JSON (mistake ledger). */
  mistakeTags?: string[] | null;
}

export function insertAttempt(a: AttemptInput): void {
  insertAttemptStmt.run({
    id: a.id,
    problemId: a.problemId,
    pattern: a.pattern,
    difficulty: a.difficulty,
    solved: a.solved ? 1 : 0,
    hintsUsed: a.hintsUsed,
    testsPassed: a.testsPassed,
    testsTotal: a.testsTotal,
    code: a.code,
    createdAt: a.createdAt,
    prediction: a.prediction ? JSON.stringify(a.prediction) : null,
    mistakeTags: a.mistakeTags && a.mistakeTags.length ? JSON.stringify(a.mistakeTags) : null,
  });
}

const historyStmt = db.prepare(`
  SELECT
    a.id, a.problemId, a.pattern, a.difficulty, a.solved,
    a.hintsUsed, a.testsPassed, a.testsTotal, a.createdAt,
    COALESCE(p.title, '(deleted problem)') AS problemTitle
  FROM attempts a
  LEFT JOIN problems p ON p.id = a.problemId
  ORDER BY a.createdAt DESC
  LIMIT ?
`);

export function getHistory(limit = 50): AttemptRecord[] {
  const rows = historyStmt.all(limit) as Array<{
    id: string;
    problemId: string;
    problemTitle: string;
    pattern: string;
    difficulty: string;
    solved: number;
    hintsUsed: number;
    testsPassed: number;
    testsTotal: number;
    createdAt: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    problemId: r.problemId,
    problemTitle: r.problemTitle,
    pattern: r.pattern,
    difficulty: r.difficulty as Difficulty,
    solved: r.solved === 1,
    hintsUsed: r.hintsUsed,
    testsPassed: r.testsPassed,
    testsTotal: r.testsTotal,
    createdAt: r.createdAt,
  }));
}

// -----------------------------------------------------------------------------
// Progress — derived per-pattern from attempts.
// masteryScore blends solve-rate with a mild recency bonus (both in 0..1).
// -----------------------------------------------------------------------------
const progressStmt = db.prepare(`
  SELECT
    pattern,
    COUNT(*)                              AS attempted,
    SUM(CASE WHEN solved = 1 THEN 1 ELSE 0 END) AS solved,
    MAX(createdAt)                        AS lastSeen
  FROM attempts
  GROUP BY pattern
  ORDER BY pattern ASC
`);

export function getProgress(): PatternStat[] {
  const rows = progressStmt.all() as Array<{
    pattern: string;
    attempted: number;
    solved: number;
    lastSeen: string | null;
  }>;

  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  return rows.map((r) => {
    const solveRate = r.attempted > 0 ? r.solved / r.attempted : 0;
    // Recency: full weight within a week, decaying toward 0 over ~30 days.
    let recency = 0;
    if (r.lastSeen) {
      const ageDays = (now - new Date(r.lastSeen).getTime()) / DAY;
      recency = Math.max(0, 1 - ageDays / 30);
    }
    // Mastery: mostly solve-rate, lightly boosted by recent practice.
    const masteryScore = Math.round((solveRate * 0.8 + recency * 0.2) * 100) / 100;
    return {
      pattern: r.pattern,
      attempted: r.attempted,
      solved: r.solved,
      lastSeen: r.lastSeen,
      masteryScore,
    };
  });
}

// -----------------------------------------------------------------------------
// Skill state — per-topic spaced-repetition + progression (keyed on TOPIC, not
// the free `pattern` string). Feeds the deterministic scheduler.
// -----------------------------------------------------------------------------
export interface SkillRow {
  topic: Topic;
  currentDifficulty: Difficulty;
  box: number;
  ease: number;
  streak: number;
  attempts: number;
  solved: number;
  hintsSum: number;
  lastResult: 'solved' | 'solved-hinted' | 'failed' | null;
  lastSeenAt: string | null;
  dueAt: string | null;
}

interface SkillStateDbRow {
  topic: string;
  currentDifficulty: string;
  box: number;
  ease: number;
  streak: number;
  attempts: number;
  solved: number;
  hintsSum: number;
  lastResult: string | null;
  lastSeenAt: string | null;
  dueAt: string | null;
}

function rowToSkill(r: SkillStateDbRow): SkillRow {
  return {
    topic: r.topic as Topic,
    currentDifficulty: r.currentDifficulty as Difficulty,
    box: r.box,
    ease: r.ease,
    streak: r.streak,
    attempts: r.attempts,
    solved: r.solved,
    hintsSum: r.hintsSum,
    lastResult: (r.lastResult as SkillRow['lastResult']) ?? null,
    lastSeenAt: r.lastSeenAt,
    dueAt: r.dueAt,
  };
}

const getAllSkillStmt = db.prepare(`SELECT * FROM skill_state`);
const getSkillStmt = db.prepare(`SELECT * FROM skill_state WHERE topic = ?`);

/** All per-topic skill rows (topics never practiced simply have no row). */
export function getSkillState(): SkillRow[] {
  const rows = getAllSkillStmt.all() as SkillStateDbRow[];
  return rows.map(rowToSkill);
}

export function getSkillForTopic(topic: Topic): SkillRow | null {
  const row = getSkillStmt.get(topic) as SkillStateDbRow | undefined;
  return row ? rowToSkill(row) : null;
}

// Difficulty ladder helpers.
const DIFF_ORDER: Difficulty[] = ['easy', 'medium', 'hard'];
function nextDifficulty(d: Difficulty): Difficulty {
  const i = DIFF_ORDER.indexOf(d);
  return DIFF_ORDER[Math.min(i + 1, DIFF_ORDER.length - 1)];
}

// Box → review interval (ms). Clean solves push the topic further out.
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BOX_INTERVALS_MS = [4 * HOUR, 1 * DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];
// Clean-solve box count at a difficulty before we bump currentDifficulty up.
const LEVELUP_BOX = 3;

function clampEase(e: number): number {
  return Math.max(1.3, Math.min(3.0, e));
}

const upsertSkillStmt = db.prepare(`
  INSERT INTO skill_state (
    topic, currentDifficulty, box, ease, streak, attempts, solved, hintsSum,
    lastResult, lastSeenAt, dueAt
  ) VALUES (
    @topic, @currentDifficulty, @box, @ease, @streak, @attempts, @solved, @hintsSum,
    @lastResult, @lastSeenAt, @dueAt
  )
  ON CONFLICT(topic) DO UPDATE SET
    currentDifficulty = @currentDifficulty,
    box               = @box,
    ease              = @ease,
    streak            = @streak,
    attempts          = @attempts,
    solved            = @solved,
    hintsSum          = @hintsSum,
    lastResult        = @lastResult,
    lastSeenAt        = @lastSeenAt,
    dueAt             = @dueAt
`);

/**
 * Apply one attempt's outcome to a topic's spaced-repetition state.
 * - solved & no hints → box up, streak++, ease up, dueAt pushed out; a full box
 *   run at a difficulty bumps currentDifficulty up (and resets box).
 * - solved with hints → hold (box unchanged, mild ease penalty), reschedule.
 * - failed → box reset to 0, dueAt now, streak 0, ease penalty.
 * The topic is chosen because problem.topic is in hand at submit time.
 */
export function updateSkillOnAttempt(
  topic: Topic,
  difficulty: Difficulty,
  solved: boolean,
  hintsUsed: number
): void {
  const prev = getSkillForTopic(topic);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  let currentDifficulty: Difficulty = prev?.currentDifficulty ?? difficulty;
  let box = prev?.box ?? 0;
  let ease = prev?.ease ?? 2.5;
  let streak = prev?.streak ?? 0;
  const attempts = (prev?.attempts ?? 0) + 1;
  const solvedCount = (prev?.solved ?? 0) + (solved ? 1 : 0);
  const hintsSum = (prev?.hintsSum ?? 0) + hintsUsed;
  let lastResult: SkillRow['lastResult'];
  let dueMs: number;

  if (solved && hintsUsed === 0) {
    lastResult = 'solved';
    box = box + 1;
    streak = streak + 1;
    ease = clampEase(ease + 0.1);
    // Level up once a full box run is cleared at this difficulty.
    if (box >= LEVELUP_BOX && currentDifficulty !== 'hard') {
      currentDifficulty = nextDifficulty(currentDifficulty);
      box = 0;
    }
    const idx = Math.min(box, BOX_INTERVALS_MS.length - 1);
    dueMs = nowMs + BOX_INTERVALS_MS[idx];
  } else if (solved) {
    // Solved but needed hints — hold the box, reschedule soon-ish.
    lastResult = 'solved-hinted';
    ease = clampEase(ease - 0.05);
    const idx = Math.min(box, BOX_INTERVALS_MS.length - 1);
    dueMs = nowMs + BOX_INTERVALS_MS[idx];
  } else {
    // Failed — reset and resurface immediately.
    lastResult = 'failed';
    box = 0;
    streak = 0;
    ease = clampEase(ease - 0.2);
    dueMs = nowMs;
  }

  upsertSkillStmt.run({
    topic,
    currentDifficulty,
    box,
    ease,
    streak,
    attempts,
    solved: solvedCount,
    hintsSum,
    lastResult,
    lastSeenAt: nowIso,
    dueAt: new Date(dueMs).toISOString(),
  });
}

// -----------------------------------------------------------------------------
// Bank / attempt helpers used by the adaptive generator.
// -----------------------------------------------------------------------------
const bankTitlesStmt = db.prepare(`SELECT title FROM problems WHERE topic = ?`);

/** All banked problem titles for a topic — used as `avoidTitles` for variations. */
export function getBankTitles(topic: Topic): string[] {
  const rows = bankTitlesStmt.all(topic) as Array<{ title: string }>;
  return rows.map((r) => r.title);
}

const recentSolvedStmt = db.prepare(`
  SELECT p.*
  FROM attempts a
  JOIN problems p ON p.id = a.problemId
  WHERE p.topic = ? AND a.solved = 1
  ORDER BY a.createdAt DESC
  LIMIT 1
`);

/** The most recently solved problem for a topic (seed for a variation). */
export function getRecentSolvedProblem(topic: Topic): ProblemRecord | null {
  const row = recentSolvedStmt.get(topic) as ProblemRow | undefined;
  return row ? rowToProblem(row) : null;
}

// -----------------------------------------------------------------------------
// Sessions — one row per grind sitting (persisted so a refresh resumes).
// -----------------------------------------------------------------------------
export interface SessionRow {
  id: string;
  createdAt: string;
  plan: SessionPlan;
  served: number;
  lastTopic: Topic | null;
}

interface SessionDbRow {
  id: string;
  createdAt: string;
  plan: string;
  served: number;
  lastTopic: string | null;
}

const insertSessionStmt = db.prepare(`
  INSERT INTO sessions (id, createdAt, plan, served, lastTopic)
  VALUES (?, ?, ?, 0, NULL)
`);

export function createSession(id: string, plan: SessionPlan): void {
  insertSessionStmt.run(id, new Date().toISOString(), JSON.stringify(plan));
}

const getSessionStmt = db.prepare(`SELECT * FROM sessions WHERE id = ?`);

export function getSession(id: string): SessionRow | null {
  const row = getSessionStmt.get(id) as SessionDbRow | undefined;
  if (!row) return null;
  let plan: SessionPlan;
  try {
    plan = JSON.parse(row.plan) as SessionPlan;
  } catch {
    plan = { theme: 'Adaptive practice', coachIntro: '', focus: [] };
  }
  return {
    id: row.id,
    createdAt: row.createdAt,
    plan,
    served: row.served,
    lastTopic: (row.lastTopic as Topic | null) ?? null,
  };
}

const bumpSessionStmt = db.prepare(`
  UPDATE sessions SET served = served + 1, lastTopic = ? WHERE id = ?
`);

/** Record that a problem was served in this session (increments count, tracks last topic). */
export function bumpSession(id: string, lastTopic: Topic): void {
  bumpSessionStmt.run(lastTopic, id);
}

// -----------------------------------------------------------------------------
// Review queue — spaced re-solve of failed / hint-assisted problems (retrieval
// loop). An item is "due" when clearedAt IS NULL and dueAt <= now. A clean,
// unaided solve clears it; another miss pushes dueAt out on a spaced ladder.
// -----------------------------------------------------------------------------
export type ReviewReason = 'failed' | 'hinted';

// attempts 0 → due now; 1 → +2d; 2 → +5d; 3+ → +10d.
const REVIEW_LADDER_DAYS = [0, 2, 5, 10];
function reviewDueMsFor(attempts: number, nowMs: number): number {
  const idx = Math.min(attempts, REVIEW_LADDER_DAYS.length - 1);
  return nowMs + REVIEW_LADDER_DAYS[idx] * DAY;
}

const getReviewStmt = db.prepare(`SELECT * FROM review_queue WHERE problemId = ?`);
interface ReviewDbRow {
  problemId: string;
  reason: string;
  dueAt: string;
  attempts: number;
  clearedAt: string | null;
  createdAt: string;
}

const insertReviewStmt = db.prepare(`
  INSERT INTO review_queue (problemId, reason, dueAt, attempts, clearedAt, createdAt)
  VALUES (@problemId, @reason, @dueAt, 0, NULL, @createdAt)
`);
const reopenReviewStmt = db.prepare(`
  UPDATE review_queue SET reason = @reason, clearedAt = NULL, dueAt = @dueAt WHERE problemId = @problemId
`);

/**
 * Queue a problem for spaced review after a miss/hint. If a live (un-cleared)
 * row already exists we keep it (earliest due wins — don't push it out here;
 * that's bumpReviewOnFail's job). If it was previously cleared, reopen it due now.
 */
export function enqueueReview(problemId: string, reason: ReviewReason): void {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const existing = getReviewStmt.get(problemId) as ReviewDbRow | undefined;
  if (!existing) {
    insertReviewStmt.run({ problemId, reason, dueAt: nowIso, createdAt: nowIso });
    return;
  }
  if (existing.clearedAt !== null) {
    // Previously cleared then regressed — reopen, due now, attempts preserved.
    reopenReviewStmt.run({ problemId, reason, dueAt: nowIso });
  }
  // else: already live & queued — keep the earliest dueAt (no-op).
}

const bumpReviewStmt = db.prepare(`
  UPDATE review_queue SET attempts = @attempts, dueAt = @dueAt, clearedAt = NULL WHERE problemId = @problemId
`);

/** A missed review re-attempt: increment attempts and push dueAt out on the ladder. */
export function bumpReviewOnFail(problemId: string): void {
  const existing = getReviewStmt.get(problemId) as ReviewDbRow | undefined;
  if (!existing) {
    enqueueReview(problemId, 'failed');
    return;
  }
  const nowMs = Date.now();
  const attempts = existing.attempts + 1;
  const dueAt = new Date(reviewDueMsFor(attempts, nowMs)).toISOString();
  bumpReviewStmt.run({ problemId, attempts, dueAt });
}

const clearReviewStmt = db.prepare(`
  UPDATE review_queue SET clearedAt = @clearedAt WHERE problemId = @problemId AND clearedAt IS NULL
`);

/** Clear a review item (called on a clean unaided solve). No-op if not queued. */
export function clearReview(problemId: string): void {
  clearReviewStmt.run({ problemId, clearedAt: new Date().toISOString() });
}

const dueReviewStmt = db.prepare(`
  SELECT problemId, reason, attempts FROM review_queue
  WHERE clearedAt IS NULL AND dueAt <= ?
  ORDER BY dueAt ASC
  LIMIT 1
`);

export interface DueReview {
  problemId: string;
  reason: ReviewReason;
  attempts: number;
}

/** The earliest due, un-cleared review item, or null. */
export function getDueReview(): DueReview | null {
  const row = dueReviewStmt.get(new Date().toISOString()) as
    | { problemId: string; reason: string; attempts: number }
    | undefined;
  if (!row) return null;
  return {
    problemId: row.problemId,
    reason: row.reason === 'hinted' ? 'hinted' : 'failed',
    attempts: row.attempts,
  };
}

const reviewDueCountStmt = db.prepare(`
  SELECT COUNT(*) AS n FROM review_queue WHERE clearedAt IS NULL AND dueAt <= ?
`);

/** How many review items are currently due. */
export function getReviewDueCount(): number {
  return (reviewDueCountStmt.get(new Date().toISOString()) as { n: number }).n;
}

/** Whether a problem currently has a live (un-cleared) review row. */
export function isReviewQueued(problemId: string): boolean {
  const row = getReviewStmt.get(problemId) as ReviewDbRow | undefined;
  return !!row && row.clearedAt === null;
}

// -----------------------------------------------------------------------------
// Pattern primers — cached per-pattern cheat-sheet cards.
// -----------------------------------------------------------------------------
const getPrimerStmt = db.prepare(`SELECT data FROM pattern_primers WHERE pattern = ?`);

export function getPrimer(pattern: string): Primer | null {
  const row = getPrimerStmt.get(pattern) as { data: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.data) as Primer;
  } catch {
    return null;
  }
}

const insertPrimerStmt = db.prepare(`
  INSERT INTO pattern_primers (pattern, data, createdAt)
  VALUES (@pattern, @data, @createdAt)
  ON CONFLICT(pattern) DO UPDATE SET data = @data, createdAt = @createdAt
`);

export function insertPrimer(primer: Primer): void {
  insertPrimerStmt.run({
    pattern: primer.pattern,
    data: JSON.stringify(primer),
    createdAt: new Date().toISOString(),
  });
}

const primerPatternsStmt = db.prepare(`SELECT pattern FROM pattern_primers ORDER BY pattern ASC`);

/** Topics/patterns that already have a cached primer (for the library page). */
export function getPrimerPatterns(): string[] {
  const rows = primerPatternsStmt.all() as Array<{ pattern: string }>;
  return rows.map((r) => r.pattern);
}

// -----------------------------------------------------------------------------
// Mistake ledger — aggregate coach-emitted mistakeTags across attempts.
// -----------------------------------------------------------------------------
const mistakeLedgerStmt = db.prepare(`
  SELECT mistakeTags, createdAt FROM attempts WHERE mistakeTags IS NOT NULL
`);

/** Recurring failure modes: {tag,count,lastSeen} aggregated across attempts, count desc. */
export function getMistakeLedger(): MistakeStat[] {
  const rows = mistakeLedgerStmt.all() as Array<{ mistakeTags: string; createdAt: string }>;
  const agg = new Map<string, { count: number; lastSeen: string }>();
  for (const row of rows) {
    let tags: unknown;
    try {
      tags = JSON.parse(row.mistakeTags);
    } catch {
      continue;
    }
    if (!Array.isArray(tags)) continue;
    for (const t of tags) {
      if (typeof t !== 'string') continue;
      const cur = agg.get(t);
      if (!cur) {
        agg.set(t, { count: 1, lastSeen: row.createdAt });
      } else {
        cur.count += 1;
        if (row.createdAt > cur.lastSeen) cur.lastSeen = row.createdAt;
      }
    }
  }
  return [...agg.entries()]
    .map(([tag, v]) => ({ tag, count: v.count, lastSeen: v.lastSeen }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export { db };
export type { Problem };
