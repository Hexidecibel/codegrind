// =============================================================================
// review-ladder — the PURE spacing rule behind review_queue
// =============================================================================
// A review item is a problem the candidate failed (or needed help on). It is
// re-served COLD on a spaced ladder and only leaves the queue after it has been
// solved cleanly at every rung — the point of spacing is that a solve minutes
// after the miss proves recall of the last ten minutes, not of the pattern.
//
// The rules (Phase H, from a real log where 11 of 14 items were "cleared"
// within minutes of the miss that queued them):
//   * a miss puts the item on rung 0 (due in RUNG_DAYS[0] days)
//   * a clean solve on a LATER local day than the last miss climbs one rung;
//     a clean solve at the top rung clears the item
//   * a clean solve on the SAME local day as the last miss changes nothing —
//     the item stays due on its rung
//   * a lapse (miss on a live item, on a later day) drops ONE rung, not to the
//     bottom; several misses on one day count as one lapse
//   * a cleared item that is missed again re-enters at rung 0
// No database and no clock it is not handed, like today.compute.

import { localDay } from './today.compute.js';

/** Days until due, per rung: a success climbs 1 → 3 → 7 → 14. */
export const RUNG_DAYS = [1, 3, 7, 14] as const;
export const TOP_RUNG = RUNG_DAYS.length - 1;
const DAY_MS = 86_400_000;

export interface LadderRow {
  rung: number;
  /** ISO of the last miss (null on rows that predate the column: treated as long ago). */
  lastMissAt: string | null;
  clearedAt: string | null;
  dueAt: string;
}

export interface LadderMove {
  rung: number;
  dueAt: string;
  /** Set when this move clears (graduates) the item. */
  clearedAt: string | null;
  lastMissAt: string | null;
}

const clampRung = (r: number) => Math.max(0, Math.min(TOP_RUNG, Math.floor(Number.isFinite(r) ? r : 0)));
const dueIn = (rung: number, nowMs: number) => new Date(nowMs + RUNG_DAYS[clampRung(rung)] * DAY_MS).toISOString();

function sameLocalDay(iso: string | null, nowMs: number, tz: string): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && localDay(t, tz) === localDay(nowMs, tz);
}

/** A miss (failed, or solved only with help). `row` null = not queued yet. */
export function ladderOnMiss(row: LadderRow | null, nowMs: number, tz: string): LadderMove {
  const now = new Date(nowMs).toISOString();
  if (!row || row.clearedAt !== null) return { rung: 0, dueAt: dueIn(0, nowMs), clearedAt: null, lastMissAt: now };
  // A second miss the same day is the same lapse — it must not walk the item
  // down the ladder one submit at a time.
  const rung = sameLocalDay(row.lastMissAt, nowMs, tz) ? clampRung(row.rung) : clampRung(row.rung - 1);
  return { rung, dueAt: dueIn(rung, nowMs), clearedAt: null, lastMissAt: now };
}

/** A clean, unaided solve of a queued item. Null = nothing to change. */
export function ladderOnCleanSolve(row: LadderRow | null, nowMs: number, tz: string): LadderMove | null {
  if (!row || row.clearedAt !== null) return null;
  // Same day as the miss: recall of the last few minutes, not spaced recall.
  if (sameLocalDay(row.lastMissAt, nowMs, tz)) return null;
  // A solve before the item was due (served some other way) does not climb either.
  if (Date.parse(row.dueAt) > nowMs) return null;
  const now = new Date(nowMs).toISOString();
  if (clampRung(row.rung) >= TOP_RUNG) {
    return { rung: TOP_RUNG, dueAt: row.dueAt, clearedAt: now, lastMissAt: row.lastMissAt };
  }
  const rung = clampRung(row.rung) + 1;
  return { rung, dueAt: dueIn(rung, nowMs), clearedAt: null, lastMissAt: row.lastMissAt };
}

/** A skip of a due item: push it out by its rung, change nothing else. */
export function ladderSnoozeDue(row: LadderRow, nowMs: number): string {
  return dueIn(row.rung, nowMs);
}

/**
 * The soft Submit cap: after this many submits of one problem in a local day,
 * the UI asks the candidate to use Run (sample tests) instead. Overridable.
 */
export const SUBMIT_SOFT_CAP = 3;
