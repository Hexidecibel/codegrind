import Database from 'better-sqlite3';
import type { LessonMeta } from './study.order.js';
import {
  FOUNDATIONAL_START,
  countCleanSolves,
  emptyCleanSolves,
  masteryScore,
  tierLevel,
  workingDifficulty,
  type AttemptCredit,
} from './curriculum.js';
import fs from 'node:fs';
import path from 'node:path';
import { TOPICS } from '../../shared/types.js';
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
  Lesson,
  LessonKind,
  TrackOutlineItem,
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

  -- Study: per-topic reading track (cheap outline call, cached forever).
  CREATE TABLE IF NOT EXISTS lesson_tracks (
    topic     TEXT PRIMARY KEY,
    outline   TEXT NOT NULL,          -- JSON TrackOutlineItem[]
    createdAt TEXT NOT NULL
  );

  -- Study: one written lesson (markdown body), cached forever, never invalidated.
  CREATE TABLE IF NOT EXISTS lessons (
    id        TEXT PRIMARY KEY,
    topic     TEXT NOT NULL,
    kind      TEXT NOT NULL,
    seq       INTEGER NOT NULL,
    title     TEXT NOT NULL,
    data      TEXT NOT NULL,          -- JSON Lesson
    createdAt TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_lessons_topic_seq ON lessons(topic, seq);

  -- Answer reveals: one row the moment the reference solution is shown for a
  -- problem. Read back at submit time to force the attempt to count as
  -- assisted, so revealing can never bank a clean tier solve. Server-side on
  -- purpose — the honesty property must not depend on the client reporting it.
  CREATE TABLE IF NOT EXISTS revealed_solutions (
    problemId  TEXT PRIMARY KEY,
    revealedAt TEXT NOT NULL
  );

  -- Study: read receipts. No position table — resume is the first unread lesson.
  CREATE TABLE IF NOT EXISTS lesson_reads (
    lessonId TEXT PRIMARY KEY,
    readAt   TEXT NOT NULL,
    fuzzy    INTEGER NOT NULL DEFAULT 0
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
// Clean solves — the tier ladder's ONLY input.
// -----------------------------------------------------------------------------
// One credit = one DISTINCT problem solved with zero hints. The counting rule
// itself lives in the pure `curriculum.countCleanSolves` — these queries hand
// it raw attempt rows and do NOT pre-filter on solved/hintsUsed, so there is
// exactly one place that decides what earns credit (and it is unit-tested
// without a database). The row count is one per submit ever made, which is
// small and stays small; correctness beats a GROUP BY here.
//
// Two keyings, deliberately:
//   by TOPIC   — joins `problems`, whose `topic`/`difficulty` are authoritative
//                for the curriculum (a handful of old attempts carry a `pattern`
//                that disagrees with their problem's topic).
//   by PATTERN — reads `attempts` alone, because PatternStat is keyed on the
//                free-text pattern tag and must include patterns that are not
//                curriculum topics at all.
// -----------------------------------------------------------------------------
interface CreditRow {
  key: string;
  problemId: string;
  difficulty: string;
  solved: number;
  hintsUsed: number;
}

function foldCredits(rows: CreditRow[]): Map<string, Record<Difficulty, number>> {
  const grouped = new Map<string, AttemptCredit[]>();
  for (const r of rows) {
    const credit: AttemptCredit = {
      problemId: r.problemId,
      difficulty: r.difficulty,
      solved: r.solved === 1,
      hintsUsed: r.hintsUsed,
    };
    const bucket = grouped.get(r.key);
    if (bucket) bucket.push(credit);
    else grouped.set(r.key, [credit]);
  }
  const out = new Map<string, Record<Difficulty, number>>();
  for (const [key, credits] of grouped) out.set(key, countCleanSolves(credits));
  return out;
}

const creditsByTopicStmt = db.prepare(`
  SELECT p.topic AS key, a.problemId AS problemId, p.difficulty AS difficulty,
         a.solved AS solved, a.hintsUsed AS hintsUsed
  FROM attempts a
  JOIN problems p ON p.id = a.problemId
`);

/** Distinct hint-free solves per (topic, difficulty). Untouched topics are absent. */
export function getCleanSolvesByTopic(): Map<Topic, Record<Difficulty, number>> {
  return foldCredits(creditsByTopicStmt.all() as CreditRow[]) as Map<
    Topic,
    Record<Difficulty, number>
  >;
}

const creditsForTopicStmt = db.prepare(`
  SELECT p.topic AS key, a.problemId AS problemId, p.difficulty AS difficulty,
         a.solved AS solved, a.hintsUsed AS hintsUsed
  FROM attempts a
  JOIN problems p ON p.id = a.problemId
  WHERE p.topic = ?
`);

/** One topic's distinct hint-free solves per difficulty (dense, never null). */
export function getCleanSolvesForTopic(topic: Topic): Record<Difficulty, number> {
  const rows = creditsForTopicStmt.all(topic) as CreditRow[];
  return foldCredits(rows).get(topic) ?? emptyCleanSolves();
}

const creditsByPatternStmt = db.prepare(`
  SELECT pattern AS key, problemId AS problemId, difficulty AS difficulty,
         solved AS solved, hintsUsed AS hintsUsed
  FROM attempts
`);

/** Distinct hint-free solves per (pattern, difficulty) — PatternStat's input. */
export function getCleanSolvesByPattern(): Map<string, Record<Difficulty, number>> {
  return foldCredits(creditsByPatternStmt.all() as CreditRow[]);
}

// -----------------------------------------------------------------------------
// Progress — derived per-pattern from attempts. `attempted`/`solved` are still
// raw attempt counts (they are honest as counts); masteryScore is the tier
// ladder's display ordinal, NOT a solve rate. See curriculum.masteryScore.
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

  const clean = getCleanSolvesByPattern();

  return rows.map((r) => ({
    pattern: r.pattern,
    attempted: r.attempted,
    solved: r.solved,
    lastSeen: r.lastSeen,
    // Rounded to 2dp for display.
    masteryScore: Math.round(masteryScore(clean.get(r.pattern)) * 100) / 100,
  }));
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

// Difficulty ladder helpers live in ./curriculum.js (DIFF_ORDER) — this file
// used to keep its own copy, which is how two ladders drift apart.

// Box → review interval (ms). Clean solves push the topic further out.
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BOX_INTERVALS_MS = [4 * HOUR, 1 * DAY, 3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY];

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
 * - solved & no hints → box up, streak++, ease up, dueAt pushed out.
 * - solved with hints → hold (box unchanged, mild ease penalty), reschedule.
 * - failed → box reset to 0, dueAt now, streak 0, ease penalty.
 *
 * `currentDifficulty` is NOT set from `box` any more. It is DERIVED from the
 * tier ladder — the difficulty above the highest completed tier — so it is a
 * pure function of distinct hint-free solves and cannot be walked up by
 * re-submitting a solution that already passes. (Box keeps its real job:
 * choosing the review interval.) The column is now a cache of that derivation,
 * kept only so readers that already have a SkillRow don't need a second query.
 *
 * MUST be called AFTER the attempt row is inserted — the derivation counts it.
 * The topic is chosen because problem.topic is in hand at submit time.
 */
export function updateSkillOnAttempt(
  topic: Topic,
  solved: boolean,
  hintsUsed: number
): void {
  const prev = getSkillForTopic(topic);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const currentDifficulty: Difficulty = workingDifficulty(
    tierLevel(getCleanSolvesForTopic(topic))
  );
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

const recentProblemDigestsStmt = db.prepare(`
  SELECT title, prompt
  FROM problems
  WHERE topic = ?
  ORDER BY createdAt DESC
  LIMIT ?
`);

/**
 * Recent problem statements for a topic. Used to steer the generator away from
 * re-serving the same algorithmic shape in a new costume — avoiding titles alone
 * only stops repeated NAMES, not repeated algorithms.
 */
export function getRecentProblemDigests(
  topic: Topic,
  limit = 4
): Array<{ title: string; prompt: string }> {
  return recentProblemDigestsStmt.all(topic, limit) as Array<{
    title: string;
    prompt: string;
  }>;
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
// Answer reveals — the honesty ledger behind "show me the answer".
// -----------------------------------------------------------------------------
// Revealing the reference solution is always allowed and always costs the clean
// solve. The record lives here rather than in the client's `hintsUsed` counter
// so that a reload, a second tab, or a hand-rolled POST cannot launder a
// revealed problem back into tier credit.
const markRevealedStmt = db.prepare(`
  INSERT INTO revealed_solutions (problemId, revealedAt) VALUES (?, ?)
  ON CONFLICT(problemId) DO NOTHING
`);

/** Record that the reference solution was shown for this problem (idempotent). */
export function markSolutionRevealed(problemId: string): void {
  markRevealedStmt.run(problemId, new Date().toISOString());
}

const isRevealedStmt = db.prepare(`SELECT 1 AS hit FROM revealed_solutions WHERE problemId = ?`);

/** True once the answer has been revealed for this problem. */
export function isSolutionRevealed(problemId: string): boolean {
  return !!isRevealedStmt.get(problemId);
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
// Study — lesson tracks, lesson bodies, read receipts.
// Tracks and lessons are write-once caches (an upsert only ever rewrites the
// same generated content); reads are the only mutable state.
// -----------------------------------------------------------------------------
const getTrackStmt = db.prepare(`SELECT outline FROM lesson_tracks WHERE topic = ?`);

/** The cached outline for a topic's reading track, or null if never generated. */
export function getTrackOutline(topic: Topic): TrackOutlineItem[] | null {
  const row = getTrackStmt.get(topic) as { outline: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.outline);
    return Array.isArray(parsed) ? (parsed as TrackOutlineItem[]) : null;
  } catch {
    return null;
  }
}

const insertTrackStmt = db.prepare(`
  INSERT INTO lesson_tracks (topic, outline, createdAt)
  VALUES (@topic, @outline, @createdAt)
  ON CONFLICT(topic) DO UPDATE SET outline = @outline, createdAt = @createdAt
`);

export function insertTrackOutline(topic: Topic, outline: TrackOutlineItem[]): void {
  insertTrackStmt.run({
    topic,
    outline: JSON.stringify(outline),
    createdAt: new Date().toISOString(),
  });
}

const allTracksStmt = db.prepare(`SELECT topic, outline FROM lesson_tracks`);

/** Every cached track outline, keyed by topic (the Study feed plans over these). */
export function getAllTrackOutlines(): Map<Topic, TrackOutlineItem[]> {
  const rows = allTracksStmt.all() as Array<{ topic: string; outline: string }>;
  const out = new Map<Topic, TrackOutlineItem[]>();
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.outline);
      if (Array.isArray(parsed)) out.set(r.topic as Topic, parsed as TrackOutlineItem[]);
    } catch {
      // Corrupt row — treat the track as ungenerated so it can be rebuilt.
    }
  }
  return out;
}

const getLessonStmt = db.prepare(`SELECT data FROM lessons WHERE id = ?`);

export function getLesson(id: string): Lesson | null {
  const row = getLessonStmt.get(id) as { data: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.data) as Lesson;
  } catch {
    return null;
  }
}

const insertLessonStmt = db.prepare(`
  INSERT INTO lessons (id, topic, kind, seq, title, data, createdAt)
  VALUES (@id, @topic, @kind, @seq, @title, @data, @createdAt)
  ON CONFLICT(id) DO UPDATE SET
    topic = @topic, kind = @kind, seq = @seq, title = @title, data = @data
`);

export function insertLesson(lesson: Lesson): void {
  insertLessonStmt.run({
    id: lesson.id,
    topic: lesson.topic,
    kind: lesson.kind,
    seq: lesson.seq,
    title: lesson.title,
    data: JSON.stringify(lesson),
    createdAt: new Date().toISOString(),
  });
}

const lessonsByTopicStmt = db.prepare(`
  SELECT data FROM lessons WHERE topic = ? ORDER BY seq ASC
`);

export function getLessonsByTopic(topic: Topic): Lesson[] {
  const rows = lessonsByTopicStmt.all(topic) as Array<{ data: string }>;
  const out: Lesson[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.data) as Lesson);
    } catch {
      // Skip an unparseable row rather than breaking the whole feed.
    }
  }
  return out;
}

const lessonMetaStmt = db.prepare(`
  SELECT id, topic, kind, seq, title FROM lessons ORDER BY topic ASC, seq ASC
`);

/**
 * Lightweight row for planning — avoids parsing every lesson body per request.
 * Defined in the pure planner module (study.order) and re-exported here so the
 * query helpers below can name their return type.
 */
export type { LessonMeta } from './study.order.js';

/** Every cached lesson's metadata — the `cached` flag the Study planner works from. */
export function getCachedLessonMeta(): LessonMeta[] {
  const rows = lessonMetaStmt.all() as Array<{
    id: string;
    topic: string;
    kind: string;
    seq: number;
    title: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    topic: r.topic as Topic,
    kind: r.kind as LessonKind,
    seq: r.seq,
    title: r.title,
  }));
}

const markReadStmt = db.prepare(`
  INSERT INTO lesson_reads (lessonId, readAt, fuzzy)
  VALUES (@lessonId, @readAt, @fuzzy)
  ON CONFLICT(lessonId) DO UPDATE SET readAt = @readAt, fuzzy = @fuzzy
`);

/** Upsert a read receipt. `fuzzy` means "didn't stick" — it resurfaces later. */
export function markLessonRead(lessonId: string, fuzzy = false): void {
  markReadStmt.run({
    lessonId,
    readAt: new Date().toISOString(),
    fuzzy: fuzzy ? 1 : 0,
  });
}

const readIdsStmt = db.prepare(`SELECT lessonId FROM lesson_reads`);

export function getReadLessonIds(): string[] {
  return (readIdsStmt.all() as Array<{ lessonId: string }>).map((r) => r.lessonId);
}

const readsStmt = db.prepare(`SELECT lessonId, readAt, fuzzy FROM lesson_reads`);

export interface LessonRead {
  lessonId: string;
  readAt: string;
  fuzzy: boolean;
}

/** Full read receipts — feeds the fuzzy / stale re-read phase. */
export function getLessonReads(): LessonRead[] {
  const rows = readsStmt.all() as Array<{ lessonId: string; readAt: string; fuzzy: number }>;
  return rows.map((r) => ({ lessonId: r.lessonId, readAt: r.readAt, fuzzy: r.fuzzy === 1 }));
}

const readCountsStmt = db.prepare(`
  SELECT l.topic AS topic, COUNT(*) AS n
  FROM lesson_reads r
  JOIN lessons l ON l.id = r.lessonId
  GROUP BY l.topic
`);

/** Per-topic read counts for the jump index. Topics with no reads are absent. */
export function getLessonReadCounts(): Map<Topic, number> {
  const rows = readCountsStmt.all() as Array<{ topic: string; n: number }>;
  const out = new Map<Topic, number>();
  for (const r of rows) out.set(r.topic as Topic, r.n);
  return out;
}

// -----------------------------------------------------------------------------
// Study — personalized-phase source material (grounded in the user's own data).
// -----------------------------------------------------------------------------
const mistakeContextStmt = db.prepare(`
  SELECT a.mistakeTags AS mistakeTags, a.pattern AS pattern, a.problemId AS problemId,
         COALESCE(p.title, '') AS title, COALESCE(p.topic, a.pattern) AS topic
  FROM attempts a
  LEFT JOIN problems p ON p.id = a.problemId
  WHERE a.mistakeTags IS NOT NULL
  ORDER BY a.createdAt DESC
`);

export interface MistakeContext {
  tag: string;
  count: number;
  /** The topic the tag showed up in most recently. */
  topic: Topic;
  /** The most recent problem where it bit, for grounding the lesson. */
  problemId: string;
  problemTitle: string;
}

/**
 * Recurring mistake tags with the most recent attempt that carried them, so a
 * mistake lesson can be grounded in a specific problem the user actually missed.
 */
export function getMistakeContexts(): MistakeContext[] {
  const rows = mistakeContextStmt.all() as Array<{
    mistakeTags: string;
    pattern: string;
    problemId: string;
    title: string;
    topic: string;
  }>;
  const agg = new Map<string, MistakeContext>();
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
        // Rows arrive newest-first, so the first sighting is the most recent one.
        agg.set(t, {
          tag: t,
          count: 1,
          topic: row.topic as Topic,
          problemId: row.problemId,
          problemTitle: row.title,
        });
      } else {
        cur.count += 1;
      }
    }
  }
  return [...agg.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

const walkthroughStmt = db.prepare(`
  SELECT a.problemId AS problemId, p.title AS title, p.topic AS topic,
         MAX(a.hintsUsed) AS hintsUsed, MAX(a.solved) AS solved, MAX(a.createdAt) AS lastAt
  FROM attempts a
  JOIN problems p ON p.id = a.problemId
  WHERE a.hintsUsed > 0 OR a.solved = 0
  GROUP BY a.problemId
  ORDER BY lastAt DESC
  LIMIT ?
`);

export interface WalkthroughCandidate {
  problemId: string;
  title: string;
  topic: Topic;
  hintsUsed: number;
  solved: boolean;
}

/** Problems the user leaned on hints for (or missed) — walkthrough material. */
export function getWalkthroughCandidates(limit = 20): WalkthroughCandidate[] {
  const rows = walkthroughStmt.all(limit) as Array<{
    problemId: string;
    title: string;
    topic: string;
    hintsUsed: number;
    solved: number;
  }>;
  return rows.map((r) => ({
    problemId: r.problemId,
    title: r.title,
    topic: r.topic as Topic,
    hintsUsed: r.hintsUsed,
    solved: r.solved === 1,
  }));
}

// -----------------------------------------------------------------------------
// Reflect — the progress dashboard's reads. Three shapes the existing accessors
// don't cover: per-problem attempt series (trend), per-day counts (heatmap) and
// raw tagged attempts (recent-vs-earlier mistake split). All of the arithmetic
// on top of these lives in the pure ./reflect.compute.js.
// -----------------------------------------------------------------------------
function asTopic(v: string | null): Topic {
  return (TOPICS as readonly string[]).includes(v ?? '') ? (v as Topic) : FOUNDATIONAL_START;
}

const attemptsByProblemStmt = db.prepare(`
  SELECT
    a.problemId   AS problemId,
    a.solved      AS solved,
    a.testsPassed AS testsPassed,
    a.testsTotal  AS testsTotal,
    a.createdAt   AS createdAt,
    COALESCE(p.title, '(deleted problem)') AS title,
    COALESCE(p.topic, a.pattern)           AS topic
  FROM attempts a
  LEFT JOIN problems p ON p.id = a.problemId
  ORDER BY a.createdAt ASC
`);

export interface ProblemAttemptSeries {
  problemId: string;
  title: string;
  topic: Topic;
  /** Chronological, oldest first. */
  attempts: Array<{
    solved: boolean;
    testsPassed: number;
    testsTotal: number;
    createdAt: string;
  }>;
}

/**
 * Every attempt grouped by problem, each group chronological, groups ordered by
 * their first attempt. Feeds the trend metrics (first-submit accuracy, submits
 * to pass, minutes to solve) — all of which need the WHOLE series per problem,
 * which the flat getHistory() list can't express.
 */
export function getAttemptsByProblem(): ProblemAttemptSeries[] {
  const rows = attemptsByProblemStmt.all() as Array<{
    problemId: string;
    solved: number;
    testsPassed: number;
    testsTotal: number;
    createdAt: string;
    title: string;
    topic: string | null;
  }>;

  // Insertion order is first-attempt order because the query is sorted by time.
  const out = new Map<string, ProblemAttemptSeries>();
  for (const r of rows) {
    let entry = out.get(r.problemId);
    if (!entry) {
      entry = { problemId: r.problemId, title: r.title, topic: asTopic(r.topic), attempts: [] };
      out.set(r.problemId, entry);
    }
    entry.attempts.push({
      solved: r.solved === 1,
      testsPassed: r.testsPassed,
      testsTotal: r.testsTotal,
      createdAt: r.createdAt,
    });
  }
  return [...out.values()];
}

const dailyActivityStmt = db.prepare(`
  SELECT
    date(createdAt)                             AS date,
    COUNT(*)                                    AS attempts,
    SUM(CASE WHEN solved = 1 THEN 1 ELSE 0 END) AS solved
  FROM attempts
  WHERE createdAt >= ?
  GROUP BY date(createdAt)
  ORDER BY date(createdAt) ASC
`);

export interface DailyActivityRow {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  attempts: number;
  solved: number;
}

/**
 * Attempt + solve counts per UTC day over the last `days` days. Days with no
 * activity are simply absent — reflect.compute.buildActivity fills the grid.
 */
export function getDailyActivity(days = 84): DailyActivityRow[] {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return dailyActivityStmt.all(since) as DailyActivityRow[];
}

const taggedAttemptsStmt = db.prepare(`
  SELECT mistakeTags, createdAt FROM attempts
  WHERE mistakeTags IS NOT NULL
  ORDER BY createdAt ASC
`);

export interface TaggedAttemptRow {
  mistakeTags: string[];
  createdAt: string;
}

/**
 * Raw tagged attempts, chronological — the un-aggregated form a plain
 * count-per-tag rollup throws away. The reflect dashboard needs the timeline to
 * split each tag into recent vs earlier halves ("is this shrinking?").
 */
export function getTaggedAttempts(): TaggedAttemptRow[] {
  const rows = taggedAttemptsStmt.all() as Array<{ mistakeTags: string; createdAt: string }>;
  const out: TaggedAttemptRow[] = [];
  for (const r of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.mistakeTags);
    } catch {
      continue; // corrupt row — skip rather than break the dashboard
    }
    if (!Array.isArray(parsed)) continue;
    const tags = parsed.filter((t): t is string => typeof t === 'string' && t.length > 0);
    if (tags.length) out.push({ mistakeTags: tags, createdAt: r.createdAt });
  }
  return out;
}

const distinctSolvedStmt = db.prepare(`
  SELECT COUNT(DISTINCT problemId) AS n FROM attempts WHERE solved = 1
`);

/** Distinct problems solved at least once (the "solved" tile). */
export function getSolvedProblemCount(): number {
  return (distinctSolvedStmt.get() as { n: number }).n;
}

const hintFreeStmt = db.prepare(`
  SELECT
    COUNT(*)                                       AS total,
    SUM(CASE WHEN hintsUsed = 0 THEN 1 ELSE 0 END) AS hintFree
  FROM attempts
`);

/** Fraction of all attempts made with zero hints, 0..1 (0 when there are none). */
export function getHintFreeRate(): number {
  const row = hintFreeStmt.get() as { total: number; hintFree: number | null };
  if (!row.total) return 0;
  return (row.hintFree ?? 0) / row.total;
}

export { db };
export type { Problem };
