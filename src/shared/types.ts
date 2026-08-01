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

export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

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

/** One aggregated row of the mistake ledger (GET /api/mistakes). */
export interface MistakeStat {
  tag: string;
  count: number;
  /** ISO timestamp of the most recent attempt carrying this tag. */
  lastSeen: string | null;
}

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
  /** 0..1 mastery estimate blending solve rate + recency. */
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
}

export interface AskResponse {
  answer: string;
}
