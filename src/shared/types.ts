// =============================================================================
// codegrind — shared API contract (single source of truth for client + server)
// =============================================================================
// The client depends on this file. Server-only fields (hidden tests, reference
// solution) live in ProblemRecord and are NEVER present on the player-safe
// `Problem` type that crosses the API boundary.

// -----------------------------------------------------------------------------
// Topics & difficulty
// -----------------------------------------------------------------------------
export const TOPICS = [
  'arrays',
  'hashing',
  'two-pointer',
  'sliding-window',
  'binary-search',
  'stack',
  'linked-list',
  'trees',
  'graphs',
  'bfs-dfs',
  'backtracking',
  'dynamic-programming',
  'greedy',
  'intervals',
  'heap',
  'trie',
  'bit-manipulation',
  'math',
] as const;
export type Topic = (typeof TOPICS)[number];

/**
 * The difficulty ladder, in ascending order. **The tuple order IS the ladder** —
 * `curriculum.DIFF_ORDER` is this tuple, and every escalation/step-down walks it.
 *
 * `expert` is the top rung: multi-technique composition, a non-obvious
 * reduction, constraints that force the optimal complexity. Difficulty is stored
 * as TEXT in every table, so adding a rung is purely additive — no migration —
 * and the `isDifficulty` guards read this tuple, so they accept it for free.
 */
export const DIFFICULTIES = ['easy', 'medium', 'hard', 'expert'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/**
 * A topic's position on the mastery ladder: the highest difficulty tier it has
 * **completed**, where completing a tier means TIER_REQUIREMENT *distinct*
 * problems solved at that difficulty with zero hints. `none` = hasn't completed
 * the easy tier yet.
 *
 * Tiers are cumulative: you cannot be `medium` without having completed `easy`.
 */
export const TIER_LEVELS = ['none', ...DIFFICULTIES] as const;
export type TierLevel = (typeof TIER_LEVELS)[number];

// -----------------------------------------------------------------------------
// Problem pieces
// -----------------------------------------------------------------------------
/** A worked example shown in the prompt (illustrative, human-readable). */
export interface Example {
  input: string;
  output: string;
  explanation?: string;
}

/**
 * A single machine-runnable test case. `args` is spread into the user's
 * exported function; `expected` is deep-equal compared to its return value.
 * Sample (visible) tests use this shape too — hidden tests are identical but
 * only ever exist server-side on ProblemRecord.
 */
export interface TestCase {
  name: string;
  args: unknown[];
  expected: unknown;
}

// -----------------------------------------------------------------------------
// Problem — player-safe view (what the API returns)
// -----------------------------------------------------------------------------
export interface Problem {
  id: string;
  title: string;
  /** Full problem statement in Markdown. */
  prompt: string;
  examples: Example[];
  constraints: string[];
  difficulty: Difficulty;
  topic: Topic;
  /** Algorithmic pattern the problem exercises (e.g. "two-pointer"). */
  pattern: string;
  /** JS starter code — an empty function with the expected signature. */
  starterCode: string;
  /** The exported function name the harness calls (parsed from the signature). */
  functionName: string;
  /** Visible sample tests only — hidden tests are never exposed. */
  sampleTests: TestCase[];
}

// -----------------------------------------------------------------------------
// Problem — full server-side record (bank storage; never sent to client)
// -----------------------------------------------------------------------------
export interface ProblemRecord extends Problem {
  hiddenTests: TestCase[];
  referenceSolution: string;
  used: boolean;
  createdAt: string;
}

/** Strip server-only fields to produce the player-safe view. */
export function toPlayerProblem(p: ProblemRecord): Problem {
  const { hiddenTests: _h, referenceSolution: _r, used: _u, createdAt: _c, ...safe } = p;
  void _h; void _r; void _u; void _c;
  return safe;
}

// -----------------------------------------------------------------------------
// Execution results
// -----------------------------------------------------------------------------
export interface TestResult {
  name: string;
  passed: boolean;
  /** JSON-stringified expected value (present unless hidden on failure). */
  expected?: string;
  /** JSON-stringified actual return value. */
  actual?: string;
  /** Captured error / stderr for this case, if any. */
  stderr?: string;
  /** Wall-clock time for this case in milliseconds. */
  timeMs: number;
}

export type Verdict =
  | 'accepted' // all tests passed
  | 'wrong_answer' // ran, but one or more tests produced the wrong result
  | 'runtime_error' // threw an exception
  | 'timeout' // killed by the sandbox timeout (e.g. infinite loop)
  | 'error'; // harness/sandbox failure (couldn't run at all)

export interface RunResult {
  results: TestResult[];
  passed: number;
  total: number;
  verdict: Verdict;
}

/** Submit uses the same execution shape as Run (hidden tests instead of sample). */
export type SubmitResult = RunResult;

// -----------------------------------------------------------------------------
// Coaching
// -----------------------------------------------------------------------------
export interface Complexity {
  /** The user's time & space complexity, e.g. "O(n^2) time, O(1) space". */
  yours: string;
  /** The optimal time & space complexity. */
  optimal: string;
}

export interface CoachingBrief {
  /** The user's approach, paraphrased back to them. */
  approach: string;
  /** What they missed, tied to specific failing test cases. */
  missed: string[];
  /** The underlying pattern this problem tests. */
  pattern: string;
  /** How to recognize this pattern next time (interview-prep focus). */
  patternRecognition: string;
  complexity: Complexity;
  /** A short, direct "to get better" nudge. */
  improvement: string;
  /**
   * When the user submitted a pre-solve prediction, a short note comparing
   * predicted vs actual complexity/approach (calibration signal). Optional so
   * older clients / prediction-less submits are unaffected.
   */
  calibration?: string;
  /**
   * Structured recurring-failure tags chosen from MISTAKE_TAGS (empty when the
   * solution was clean). Aggregated into the mistake ledger.
   */
  mistakeTags?: string[];
}

// -----------------------------------------------------------------------------
// Retrieval loop — predict-before-solve + calibration
// -----------------------------------------------------------------------------
/** The user's pre-solve prediction, gated before the editor. Stored on the attempt. */
export interface Prediction {
  /** Intended approach in one line. */
  approach: string;
  /** Predicted time complexity, e.g. "O(n)". */
  predTime: string;
  /** Predicted space complexity, e.g. "O(1)". */
  predSpace: string;
  /** Self-rated confidence, 1 (guessing) to 5 (certain). */
  confidence: number;
}

// -----------------------------------------------------------------------------
// Mistake ledger — fixed tag vocabulary
// -----------------------------------------------------------------------------
/** The only tags the coach may emit for mistakeTags (closed vocabulary). */
export const MISTAKE_TAGS = [
  'off-by-one',
  'empty-input',
  'single-element',
  'duplicates',
  'negative-or-overflow',
  'wrong-data-structure',
  'brute-force-only',
  'complexity-misjudged',
  'runtime-error',
  'syntax-error',
  'edge-case-missed',
] as const;
export type MistakeTag = (typeof MISTAKE_TAGS)[number];

// -----------------------------------------------------------------------------
// Pattern primers — durable per-pattern cheat-sheet cards
// -----------------------------------------------------------------------------
export interface Primer {
  /** The algorithmic pattern this primer covers (the topic id). */
  pattern: string;
  /** Signals/cues in a prompt that point at this pattern. */
  recognitionCues: string[];
  /** A reusable JS code skeleton for applying the pattern. */
  template: string;
  /** Common ways people get it wrong. */
  pitfalls: string[];
  /** One canonical worked example (title + the key insight). */
  example: { title: string; insight: string };
}

// -----------------------------------------------------------------------------
// Study — guided, never-ending reading feed built on the curriculum spine
// -----------------------------------------------------------------------------
/** The kinds of reading unit a track (or the personalized phase) can emit. */
export const LESSON_KINDS = [
  'concept',
  'template',
  'pitfall',
  'walkthrough',
  'variation',
  'mistake',
] as const;
export type LessonKind = (typeof LESSON_KINDS)[number];

/** One screenful of reading — the atomic unit of the Study feed. */
export interface Lesson {
  /** `${topic}:${seq}` for track lessons; `mistake:${tag}:${n}` etc. for personalized. */
  id: string;
  topic: Topic;
  kind: LessonKind;
  /** Position in the topic track; personalized lessons use seq >= 1000. */
  seq: number;
  title: string;
  /** Markdown — renders through the existing `.prose-cg` / `.prose-study` styles. */
  body: string;
  /** Optional JS snippet, rendered in its own <pre>. */
  code?: string;
  /** One sentence: the thing to remember. */
  takeaway: string;
}

/** A planned-but-not-necessarily-written lesson slot in a topic's track. */
export interface TrackOutlineItem {
  seq: number;
  kind: LessonKind;
  title: string;
  brief: string;
}

/** Where the reader currently is: topic + seq within that topic's track. */
export interface StudyPosition {
  topic: Topic;
  seq: number;
  /** Total lessons in the current topic's track (seq 0 + outline items). */
  total: number;
}

/** GET /api/study/feed and GET /api/study/jump/:topic. */
export interface StudyFeedResponse {
  /** Only ever already-cached lessons — the feed never blocks on generation. */
  lessons: Lesson[];
  position: StudyPosition;
  /** True when the next lesson is being generated right now. */
  warming: boolean;
  /** True only if nothing more can ever be served. */
  exhausted: boolean;
}

/** POST /api/study/read body. */
export interface StudyReadRequest {
  lessonId: string;
  /** Mark it as "didn't stick" so it resurfaces in the re-read phase. */
  fuzzy?: boolean;
}

/** POST /api/study/read response. */
export interface StudyReadResponse {
  ok: true;
}

/** One row of the jump-to index grid. */
export interface StudyIndexEntry {
  topic: Topic;
  total: number;
  read: number;
  /** 0..1 mastery estimate for the topic (same scale as PatternStat). */
  mastery: number;
}

/** GET /api/study/index. */
export interface StudyIndexResponse {
  topics: StudyIndexEntry[];
}

// -----------------------------------------------------------------------------
// Hints
// -----------------------------------------------------------------------------
export type HintLevel = 1 | 2 | 3;
export interface Hint {
  level: HintLevel;
  text: string;
}

// -----------------------------------------------------------------------------
// Progress / history
// -----------------------------------------------------------------------------
export interface PatternStat {
  pattern: string;
  attempted: number;
  solved: number;
  /** ISO timestamp of the most recent attempt against this pattern, or null. */
  lastSeen: string | null;
  /**
   * DISPLAY-ONLY 0..1 ordinal derived from the tier ladder, not a solve rate:
   * `(levelIndex + towardNext / TIER_REQUIREMENT) / 4`. Each completed tier is
   * a quarter of the bar, so 0.25 == the easy tier is complete. See
   * `curriculum.masteryScore`.
   */
  masteryScore: number;
}

export interface ProgressStats {
  patterns: PatternStat[];
  /** Count of review-queue items currently due (retrieval loop). */
  reviewDue: number;
}

/** A recorded attempt (as returned by /api/history). */
export interface AttemptRecord {
  id: string;
  problemId: string;
  problemTitle: string;
  pattern: string;
  difficulty: Difficulty;
  solved: boolean;
  hintsUsed: number;
  testsPassed: number;
  testsTotal: number;
  createdAt: string;
}

// -----------------------------------------------------------------------------
// Reflect — the progress dashboard (GET /api/reflect)
// -----------------------------------------------------------------------------
// One endpoint, everything precomputed server-side where the curriculum logic
// already lives. The client renders; it never re-derives mastery or unlock math.

/**
 * A topic's position in the skill tree. Ordinal, not categorical:
 * locked → available → practiced → tiered.
 *
 * `tiered` = has completed at least one difficulty tier, which is exactly the
 * condition that opens its dependents. (There is no "mastered" state: a topic
 * is never finished, it is only at some tier.)
 */
export type ReflectTreeState = 'locked' | 'available' | 'practiced' | 'tiered';

/** One node of the prerequisite DAG, with everything the tree + tooltip need. */
export interface ReflectTreeNode {
  topic: Topic;
  state: ReflectTreeState;
  /** Display-only 0..1 ordinal derived from the tier ladder (see PatternStat). */
  mastery: number;
  /** Highest tier COMPLETED (3 distinct hint-free solves at that difficulty). */
  tier: TierLevel;
  /** Short human label for `tier` — `unranked`, `easy`, … , `expert ×7`. */
  tierLabel: string;
  /** The tier being worked on now, or null once `expert` is complete. */
  nextTier: Difficulty | null;
  /** Distinct hint-free solves banked at `nextTier` (0 when it is null). */
  towardNext: number;
  /** Distinct hint-free solves that complete a tier (TIER_REQUIREMENT). */
  tierRequirement: number;
  /** Distinct hint-free solves per difficulty — the raw tier evidence. */
  cleanSolves: Record<Difficulty, number>;
  solved: number;
  attempts: number;
  /** The difficulty the adaptive scheduler currently serves for this topic. */
  difficulty: Difficulty;
  /** Spaced-repetition box, and the current clean-solve streak. */
  box: number;
  streak: number;
  lessonsRead: number;
  lessonsTotal: number;
  prereqs: Topic[];
  /** Longest path from a root topic — the tree's layer index. */
  depth: number;
}

/** The headline: the cheapest single move that opens new territory. */
export interface ReflectNextUnlock {
  /** The topic to practice. */
  topic: Topic;
  /**
   * Distinct NEW problems `topic` must be solved on — at UNLOCK_TIER, hint-free
   * — to complete that tier and open its dependents. Re-solving a problem that
   * already counted does nothing.
   */
  cleanSolvesNeeded: number;
  /** `topic`'s display score right now, 0..1. */
  currentMastery: number;
  /** Topics that stop being locked once `topic` completes the unlock tier. */
  unlocks: Topic[];
}

/** The stat-tile row above the tree. */
export interface ReflectTiles {
  /** Distinct problems solved at least once. */
  solved: number;
  /** Topics that are not locked — i.e. reachable right now. */
  topicsReached: number;
  /** Consecutive days (ending today or yesterday) with at least one attempt. */
  streak: number;
  /** Fraction of attempts made with zero hints, 0..1. */
  hintFreeRate: number;
  /**
   * Total difficulty tiers completed across every topic. Uncapped by design —
   * this is the number that keeps going up once the tree is fully open.
   */
  tiersCleared: number;
  lessonsRead: number;
  reviewDue: number;
}

/** One cell of the activity heatmap. */
export interface ReflectActivityDay {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  attempts: number;
  solved: number;
}

/** One problem's summary, for the trend charts. */
export interface ReflectTrendPoint {
  problemId: string;
  title: string;
  topic: Topic;
  /** testsPassed / testsTotal on the FIRST submit, 0..1. */
  firstSubmitRatio: number;
  /** 1-indexed submit that first passed, or null if never solved. */
  submitsToPass: number | null;
  /** Minutes from first submit to the solving submit, or null if never solved. */
  minutesToSolve: number | null;
  /** ISO timestamp of the first submit — the point's x position. */
  at: string;
}

/** One mistake-ledger row, split into recent vs earlier halves of history. */
export interface ReflectMistake {
  tag: string;
  count: number;
  /** Occurrences in the more recent half of tagged attempts. */
  recent: number;
  /** Occurrences in the earlier half. */
  earlier: number;
}

/** GET /api/reflect — the whole dashboard in one payload. */
export interface ReflectResponse {
  /** One node per topic, in curriculum order (prerequisites before dependents). */
  tree: ReflectTreeNode[];
  nextUnlock: ReflectNextUnlock | null;
  tiles: ReflectTiles;
  /** Exactly 84 days, oldest first, gaps filled with zeros. */
  activity: ReflectActivityDay[];
  /** One point per attempted problem, chronological by first submit. */
  trend: ReflectTrendPoint[];
  /** Ranked by total count, descending. */
  mistakes: ReflectMistake[];
}

// -----------------------------------------------------------------------------
// API request / response payloads
// -----------------------------------------------------------------------------
export interface GenerateProblemRequest {
  topic: Topic;
  difficulty: Difficulty;
}

export interface RunRequest {
  problemId: string;
  code: string;
}

export interface SubmitRequest {
  problemId: string;
  code: string;
  /** Optional pre-solve prediction (retrieval loop / calibration). */
  prediction?: Prediction;
}

export interface SubmitResponse {
  result: SubmitResult;
  coaching: CoachingBrief;
  /**
   * The reference solution, returned ONLY once the submission was accepted —
   * you earned it by solving it. Absent on every unsolved submit, which is
   * what keeps `toPlayerProblem` stripping it meaningful.
   */
  referenceSolution?: string;
}

/** POST /api/reveal — "show me the answer", at the cost of the clean-solve credit. */
export interface RevealRequest {
  problemId: string;
}

export interface RevealResponse {
  referenceSolution: string;
  /**
   * Always true: a reveal is recorded server-side and forces the attempt to be
   * counted as assisted, exactly like a hint. It can never earn tier credit.
   */
  assisted: true;
}

export interface HintRequest {
  problemId: string;
  code: string;
  level: HintLevel;
}

export interface HistoryResponse {
  attempts: AttemptRecord[];
}

// -----------------------------------------------------------------------------
// Adaptive Grind Mode — scheduler, sessions, coach planning
// -----------------------------------------------------------------------------
/** The kind of intent the deterministic scheduler picks for the next problem. */
export type SchedulerIntentKind =
  | 'warm-up'
  | 'reinforce'
  | 'variation'
  | 'level-up'
  | 'new-pattern'
  | 'review';

/** The player-facing "why this problem" note attached to each served problem. */
export interface SchedulerWhy {
  kind: SchedulerIntentKind;
  text: string;
  topic: Topic;
  difficulty: Difficulty;
}

/** Claude's once-per-session plan (theme + coach intro + biased focus topics). */
export interface SessionPlan {
  theme: string;
  coachIntro: string;
  focus: Topic[];
}

/** A problem served inside a grind session (POST /api/session/:id/next). */
export interface GrindProblem {
  sessionId: string;
  problem: Problem;
  why: SchedulerWhy;
  /** Best-effort short label for the likely next problem (UI peek). */
  upNext?: string;
}

/** Response for POST /api/session/start. */
export interface SessionStartResponse {
  sessionId: string;
  plan: SessionPlan;
  problem: Problem;
  why: SchedulerWhy;
  upNext?: string;
}

// -----------------------------------------------------------------------------
// Ask the coach — conversational follow-up Q&A
// -----------------------------------------------------------------------------
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AskRequest {
  problemId: string;
  code: string;
  question: string;
  history?: ChatTurn[];
  /**
   * Per-test outcomes of the most recent submission, when the client has them.
   * Without these the tutor cannot see WHICH test failed or why, so "why did
   * mine fail?" is answered by guessing from the code alone.
   */
  results?: TestResult[];
}

export interface AskResponse {
  answer: string;
}
