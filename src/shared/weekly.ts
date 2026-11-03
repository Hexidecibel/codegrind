// =============================================================================
// weekly — "This week" on Home (GET /api/home/weekly), as the client sees it
// =============================================================================
// The same numbers bin/progress-report prints, for one window ending now. All
// derived from rows; no model call. Grind vs free is a HEURISTIC (attempts carry
// no session id — see server/services/weekly.compute.classifyGrind), so the
// page labels that split "(approx.)".

/** One local day of the window, oldest first. */
export interface WeeklyDay {
  /** Local `YYYY-MM-DD`. */
  date: string;
  /** Problem submissions that day (every language). */
  subs: number;
  /** Of those, inside a grind sitting (heuristic). */
  grind: number;
  solved: number;
  /** Any practice at all that day: a submit, a Recognize card, an Envelope rep, a mock. */
  practiced: boolean;
}

export interface WeeklyTrendHalf {
  n: number;
  solved: number;
}

export interface WeeklyTopic {
  topic: string;
  attempts: number;
  /** Attempts outside a grind sitting (heuristic). */
  free: number;
  solved: number;
  /** Rounded percent of attempts solved. */
  solvedPct: number;
  /** Failed attempts that passed >= NEAR_MISS_THRESHOLD of the tests. */
  nearMisses: number;
  /** Solved attempts that used a hint… */
  hinted: number;
  /** …and solved attempts that did not. */
  unaided: number;
  /** Solve rate in the first half of the window vs the second. */
  trend: { before: WeeklyTrendHalf; after: WeeklyTrendHalf };
}

export interface WeeklyRecognize {
  topic: string;
  n: number;
  patternCorrect: number;
  got: number;
  /** Rounded percent with the right pattern picked. */
  patternCorrectPct: number;
}

export interface WeeklyReview {
  topic: string;
  /** Open and due now. */
  due: number;
  /** Due more than a day ago. */
  overdue: number;
}

export type WeeklyTargetKind = 'refresh' | 'review' | 'struggling' | 'unseen' | 'untouched' | 'grind';

/** The one "Target next" card: one line of why, one place to go. */
export interface WeeklyTarget {
  kind: WeeklyTargetKind;
  topic: string | null;
  reason: string;
  href: string;
}

export interface WeeklyResponse {
  days: number;
  /** Local `YYYY-MM-DD`, first and last day of the window. */
  from: string;
  to: string;
  /** Local days with any practice (every language). */
  activeDays: number;
  daily: WeeklyDay[];
  volume: {
    subs: number;
    problems: number;
    grindSubs: number;
    freeSubs: number;
  };
  /** Active language, topics practised in the window, most attempts first. */
  topics: WeeklyTopic[];
  /** Unlocked topics (active language) with no attempt in the window, curriculum order. */
  untouched: string[];
  /** Near misses in the window, and how many were fixed the same day without a hint. */
  nearMisses: { count: number; fixed: number; fixedUnaided: number };
  recognize: WeeklyRecognize[];
  envelope: { n: number; ok: number; okPct: number; days: number };
  reviewDue: WeeklyReview[];
  /** Mock interviews finished in the window, and the latest one ever. */
  mocks: { thisWeek: number; lastAt: string | null };
  target: WeeklyTarget;
}

export const WEEKLY_DEFAULT_DAYS = 7;
export const WEEKLY_MAX_DAYS = 60;

/** `?days=` → 1..60, default 7. */
export function clampWeeklyDays(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return WEEKLY_DEFAULT_DAYS;
  return Math.min(WEEKLY_MAX_DAYS, Math.max(1, Math.floor(n)));
}
