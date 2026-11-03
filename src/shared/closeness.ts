// =============================================================================
// closeness — how near a failed submit came, and whether the player fixed it
// =============================================================================
// A failed submit is not one thing. 0/12 tests passing is a wrong idea; 11/12
// is a right idea with an off-by-one in it. The verdict alone files both under
// "failed", which undersells a player whose misses are mostly the second kind.
//
//   closeness   = testsPassed / testsTotal, on a FAILED attempt
//   near miss   = a failed attempt with closeness >= NEAR_MISS_THRESHOLD
//   recovered   = a near miss followed, the same local day, by a clean
//                 (hint-free) solve of the same problem: the player found and
//                 fixed their own bug
//
// Pure and dependency-free so the server (aggregation, scoring) and the
// browser (copy) share one threshold. The scoring side lives in
// db.updateSkillOnAttempt, which uses `isNearMiss` from here.

/** A failed attempt passing at least this share of hidden tests is a near miss. */
export const NEAR_MISS_THRESHOLD = 0.75;

/** testsPassed / testsTotal, or null when there were no tests to pass. */
export function closeness(testsPassed: number, testsTotal: number): number | null {
  if (!Number.isFinite(testsTotal) || testsTotal <= 0) return null;
  const c = testsPassed / testsTotal;
  return Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : null;
}

export interface ClosenessAttempt {
  problemId: string;
  solved: boolean;
  testsPassed: number;
  testsTotal: number;
  hintsUsed: number;
  createdAt: string;
}

/** A FAILED attempt whose closeness reaches NEAR_MISS_THRESHOLD. */
export function isNearMiss(a: Pick<ClosenessAttempt, 'solved' | 'testsPassed' | 'testsTotal'>): boolean {
  if (a.solved) return false;
  const c = closeness(a.testsPassed, a.testsTotal);
  return c !== null && c >= NEAR_MISS_THRESHOLD;
}

export interface ClosenessWeek {
  /** Local `YYYY-MM-DD` of the week's Monday. */
  weekStart: string;
  /** Failed attempts that week (with a test count). */
  failed: number;
  /** Mean closeness over those failed attempts; null when there were none. */
  avgCloseness: number | null;
  /** Failed attempts at or above NEAR_MISS_THRESHOLD. */
  nearMisses: number;
  /**
   * Near misses fixed the same day: distinct (problem, local day) pairs where a
   * near miss was later followed by a hint-free solve of that problem.
   */
  recovered: number;
}

export interface ClosenessWindow {
  weeks: number;
  failed: number;
  avgCloseness: number | null;
  nearMisses: number;
  recovered: number;
}

export interface ClosenessStats {
  threshold: number;
  /** Oldest → newest, always `weeks` long (empty weeks included). */
  weeks: ClosenessWeek[];
  /** The last HEADLINE_WEEKS weeks (including the current one)… */
  recent: ClosenessWindow;
  /** …and the HEADLINE_WEEKS before that. */
  prior: ClosenessWindow;
}

/** How many weeks the Reflect section charts. */
export const CLOSENESS_WEEKS = 12;
/** The headline compares this many recent weeks with the same span before. */
export const HEADLINE_WEEKS = 4;

const DAY_MS = 86_400_000;

function localDayOf(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(ms)
  );
}

/** Calendar arithmetic on `YYYY-MM-DD`, done in UTC so no DST can bite. */
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

/** The Monday on or before a local day. */
export function mondayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

function windowOf(weeks: ClosenessWeek[], sums: Map<string, number>): ClosenessWindow {
  let failed = 0;
  let sum = 0;
  let nearMisses = 0;
  let recovered = 0;
  for (const w of weeks) {
    failed += w.failed;
    sum += sums.get(w.weekStart) ?? 0;
    nearMisses += w.nearMisses;
    recovered += w.recovered;
  }
  return { weeks: weeks.length, failed, avgCloseness: failed > 0 ? sum / failed : null, nearMisses, recovered };
}

/**
 * Bucket attempts into local weeks (Monday start) ending with the week holding
 * `nowMs`. Attempts outside the window are ignored; order does not matter.
 * A recovery is credited to the week of the near miss it recovered.
 */
export function aggregateCloseness(
  attempts: readonly ClosenessAttempt[],
  nowMs: number,
  tz: string,
  weekCount = CLOSENESS_WEEKS
): ClosenessStats {
  const thisMonday = mondayOf(localDayOf(nowMs, tz));
  const starts: string[] = [];
  for (let i = weekCount - 1; i >= 0; i--) starts.push(addDays(thisMonday, -7 * i));
  const index = new Map(starts.map((s, i) => [s, i]));

  const weeks: ClosenessWeek[] = starts.map((weekStart) => ({
    weekStart,
    failed: 0,
    avgCloseness: null,
    nearMisses: 0,
    recovered: 0,
  }));
  const sums = new Map<string, number>();

  // Per (problem, local day): the time of the first near miss, and whether a
  // clean solve came after it.
  const sorted = [...attempts]
    .map((a) => ({ a, t: Date.parse(a.createdAt) }))
    .filter((x) => Number.isFinite(x.t))
    .sort((x, y) => x.t - y.t);
  const pending = new Map<string, string>(); // key → week of the near miss
  const recoveredKeys = new Set<string>();

  for (const { a, t } of sorted) {
    const day = localDayOf(t, tz);
    const week = mondayOf(day);
    const i = index.get(week);
    const key = `${a.problemId}|${day}`;
    if (!a.solved) {
      const c = closeness(a.testsPassed, a.testsTotal);
      if (c === null) continue;
      if (i !== undefined) {
        weeks[i].failed += 1;
        sums.set(week, (sums.get(week) ?? 0) + c);
        if (c >= NEAR_MISS_THRESHOLD) weeks[i].nearMisses += 1;
      }
      if (c >= NEAR_MISS_THRESHOLD && !pending.has(key)) pending.set(key, week);
    } else if (a.hintsUsed === 0 && pending.has(key) && !recoveredKeys.has(key)) {
      recoveredKeys.add(key);
      const j = index.get(pending.get(key)!);
      if (j !== undefined) weeks[j].recovered += 1;
    }
  }

  for (const w of weeks) w.avgCloseness = w.failed > 0 ? (sums.get(w.weekStart) ?? 0) / w.failed : null;

  const headline = Math.min(HEADLINE_WEEKS, Math.floor(weekCount / 2));
  return {
    threshold: NEAR_MISS_THRESHOLD,
    weeks,
    recent: windowOf(weeks.slice(weeks.length - headline), sums),
    prior: windowOf(weeks.slice(weeks.length - 2 * headline, weeks.length - headline), sums),
  };
}
