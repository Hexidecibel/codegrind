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
//   * (partial credit) the FIRST clean solve on the SAME local day as the last
//     miss climbs one rung and reschedules at that rung's spacing — but it can
//     NEVER clear the item (at the top rung it only reschedules there). Only
//     one such climb per local day (`lastCreditAt`); further same-day solves
//     change nothing. Why: the original rule ("same day changes nothing") was
//     right that a solve minutes after a miss is not spaced recall, but the
//     real pattern is fail → fail → solve within minutes, every time, so items
//     sat on rung 0 forever and came back every single day. One rung of credit
//     lets a recovered item breathe; clearing still takes a later-day solve.
//   * a lapse (miss on a live item, on a later day) drops ONE rung, not to the
//     bottom; several misses on one day count as one lapse — but a miss AFTER
//     that day's partial credit takes the credit back (drops the rung it gave)
//   * a cleared item that is missed again re-enters at rung 0
//   * (Phase H2) with an interview loop ahead, no due date lands past the loop's
//     final-review day: `deadlineMs` caps it (shared/loops.capDueAtMs)
// No database and no clock it is not handed, like today.compute.

import { localDay } from './today.compute.js';
import { capDueAtMs } from '../../shared/loops.js';

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
  /** ISO of the last same-day partial-credit climb (absent/null = never). */
  lastCreditAt?: string | null;
}

export interface LadderMove {
  rung: number;
  dueAt: string;
  /** Set when this move clears (graduates) the item. */
  clearedAt: string | null;
  lastMissAt: string | null;
  lastCreditAt: string | null;
}

const clampRung = (r: number) => Math.max(0, Math.min(TOP_RUNG, Math.floor(Number.isFinite(r) ? r : 0)));
/** Due `RUNG_DAYS[rung]` days from now, capped at the loop deadline (null = no loop). */
const dueIn = (rung: number, nowMs: number, deadlineMs: number | null = null) =>
  new Date(capDueAtMs(nowMs + RUNG_DAYS[clampRung(rung)] * DAY_MS, nowMs, deadlineMs)).toISOString();

function sameLocalDay(iso: string | null, nowMs: number, tz: string): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && localDay(t, tz) === localDay(nowMs, tz);
}

/** A miss (failed, or solved only with help). `row` null = not queued yet. */
export function ladderOnMiss(row: LadderRow | null, nowMs: number, tz: string, deadlineMs: number | null = null): LadderMove {
  const now = new Date(nowMs).toISOString();
  if (!row || row.clearedAt !== null) {
    return { rung: 0, dueAt: dueIn(0, nowMs, deadlineMs), clearedAt: null, lastMissAt: now, lastCreditAt: null };
  }
  const lastCreditAt = row.lastCreditAt ?? null;
  let rung: number;
  if (sameLocalDay(row.lastMissAt, nowMs, tz)) {
    // A second miss the same day is the same lapse — it must not walk the item
    // down the ladder one submit at a time. But if today's partial credit was
    // given after the last miss, this miss takes it back.
    const creditSinceMiss =
      sameLocalDay(lastCreditAt, nowMs, tz) && Date.parse(lastCreditAt!) >= Date.parse(row.lastMissAt!);
    rung = creditSinceMiss ? clampRung(row.rung - 1) : clampRung(row.rung);
  } else {
    rung = clampRung(row.rung - 1);
  }
  // lastCreditAt is kept: a revoked credit still used up today's one climb.
  return { rung, dueAt: dueIn(rung, nowMs, deadlineMs), clearedAt: null, lastMissAt: now, lastCreditAt };
}

/** A clean, unaided solve of a queued item. Null = nothing to change. */
export function ladderOnCleanSolve(
  row: LadderRow | null,
  nowMs: number,
  tz: string,
  deadlineMs: number | null = null
): LadderMove | null {
  if (!row || row.clearedAt !== null) return null;
  const now = new Date(nowMs).toISOString();
  const lastCreditAt = row.lastCreditAt ?? null;
  // Same day as the miss: recall of the last few minutes, not spaced recall —
  // worth one rung of partial credit (once per local day), never a clear. The
  // item was just pushed out by the miss, so there is no "is it due" check here.
  if (sameLocalDay(row.lastMissAt, nowMs, tz)) {
    if (sameLocalDay(lastCreditAt, nowMs, tz)) return null;
    const rung = Math.min(TOP_RUNG, clampRung(row.rung) + 1);
    return { rung, dueAt: dueIn(rung, nowMs, deadlineMs), clearedAt: null, lastMissAt: row.lastMissAt, lastCreditAt: now };
  }
  // A solve before the item was due (served some other way) does not climb either.
  if (Date.parse(row.dueAt) > nowMs) return null;
  if (clampRung(row.rung) >= TOP_RUNG) {
    return { rung: TOP_RUNG, dueAt: row.dueAt, clearedAt: now, lastMissAt: row.lastMissAt, lastCreditAt };
  }
  const rung = clampRung(row.rung) + 1;
  return { rung, dueAt: dueIn(rung, nowMs, deadlineMs), clearedAt: null, lastMissAt: row.lastMissAt, lastCreditAt };
}

/** A skip of a due item: push it out by its rung, change nothing else. */
export function ladderSnoozeDue(row: LadderRow, nowMs: number, deadlineMs: number | null = null): string {
  return dueIn(row.rung, nowMs, deadlineMs);
}

/**
 * The soft Submit cap: after this many submits of one problem in a local day,
 * the UI asks the candidate to use Run (sample tests) instead. Overridable.
 */
export const SUBMIT_SOFT_CAP = 3;
