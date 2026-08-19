// =============================================================================
// coachfix.service — where a coaching brief's corrected code waits to be paid for
// =============================================================================
// The coach generates a corrected version of the lines each "what you missed"
// bullet is about, in the same call that writes the brief. Those corrections do
// NOT ride along to the browser: reading one is assistance, and assistance is
// recorded server-side (see db.ts's reveal ledger for the argument). So the
// brief carries an opaque `fixId` and the text sits here until someone asks for
// it through POST /api/coaching/fix, which writes the ledger row first.
//
// WHY A MAP AND NOT A TABLE. The coaching brief is itself never persisted — it
// is streamed as NDJSON out of POST /api/submit and discarded (submit.ts
// documents the stream; nothing writes the brief anywhere). Persisting its
// fixes would give a fragment of the brief a longer life than the brief it
// hangs off: a `fixId` that survives a restart when the panel showing it did
// not is a row nobody can ever ask for. Losing them on restart yields an honest
// 404 and a UI that says so, which is the accurate answer.
//
// This is single-user, single-process software (one systemd unit, one SQLite
// file); there is no second replica that might hold the other half of the map.
// If that ever stops being true, this file is the thing to move — not the
// route, not the brief.

import { nanoid } from 'nanoid';

/**
 * The two halves of the before/after the popup draws. Both are plain text.
 *
 * This is the shape llm.service produces — it knows the lines and the
 * correction and nothing else about where they came from.
 */
export interface CoachFix {
  /** The candidate's own lines, sliced out of the source they submitted. */
  before: string;
  /** The coach's corrected version. UNVERIFIED — nothing ran it. */
  after: string;
}

/**
 * What is actually stored, and what a lookup hands back.
 *
 * `problemId` rides along because the ledger is keyed on the PROBLEM, not on
 * the fix: revealing a correction has to charge the same row a reveal of the
 * whole solution charges. Carrying it here rather than making the route hold a
 * second id→problem map means the route cannot forget to write the ledger for
 * some fixes and not others — the id it looked the fix up with is the id that
 * tells it what to charge.
 */
export interface StashedFix extends CoachFix {
  problemId: string;
}

interface StashEntry extends StashedFix {
  storedAt: number;
}

/**
 * 200 entries and six hours, and both numbers are chosen to be ignorable.
 *
 * A submit produces at most 8 fixes (coerceMissed caps `missed` at 8), so 200
 * covers roughly the last 25 submits — far more than one sitting, and this
 * process is restarted by every deploy anyway. Six hours is longer than any
 * grind session and shorter than "forever", which is the only property that
 * matters: a fix whose panel was closed hours ago is dead weight.
 *
 * Nothing here holds a timer. A `setInterval` in a module that exists to hold a
 * few kilobytes of strings would keep the event loop alive and would have to be
 * torn down in tests; expiry is checked on read and on write instead, which is
 * every moment anybody could observe the difference.
 */
const MAX_ENTRIES = 200;
const TTL_MS = 6 * 60 * 60 * 1000;

// Insertion order is eviction order — a plain Map iterates in insertion order,
// which is exactly the oldest-first sequence an LRU-less bounded cache needs.
const stash = new Map<string, StashEntry>();

function prune(now: number): void {
  for (const [id, entry] of stash) {
    if (now - entry.storedAt > TTL_MS) stash.delete(id);
  }
  // Oldest first, until we are back under the cap. `keys().next()` is the head
  // of the insertion order.
  while (stash.size > MAX_ENTRIES) {
    const oldest = stash.keys().next();
    if (oldest.done) break;
    stash.delete(oldest.value);
  }
}

/** Stash one fix and hand back the handle that goes into the brief. */
export function stashFix(problemId: string, fix: CoachFix): string {
  const id = nanoid();
  stash.set(id, { ...fix, problemId, storedAt: Date.now() });
  prune(Date.now());
  return id;
}

/**
 * Look one up, or null if it never existed / has expired / was evicted.
 *
 * NON-DESTRUCTIVE on purpose. The reveal is already recorded by the time this
 * is read, so a second look costs the reader nothing new, and deleting on read
 * would turn an accidental double-click into a 404 on something they just paid
 * for.
 */
export function getFix(id: string): StashedFix | null {
  const entry = stash.get(id);
  if (!entry) return null;
  if (Date.now() - entry.storedAt > TTL_MS) {
    stash.delete(id);
    return null;
  }
  return { problemId: entry.problemId, before: entry.before, after: entry.after };
}

/** Test seam. Nothing in the app calls this — the process restart is the reset. */
export function clearFixes(): void {
  stash.clear();
}

/** Test seam: how many fixes are currently held (for the eviction assertions). */
export function fixCount(): number {
  return stash.size;
}
