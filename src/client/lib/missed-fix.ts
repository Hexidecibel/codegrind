// =============================================================================
// missed-fix — turning coaching bullets into something clickable, safely
// =============================================================================
// Two jobs, both pure, both here rather than inside MissedList because this repo
// has no jsdom: a component's rendering cannot be asserted beyond its closed
// markup, but "which lines should light up" can be, and that is the part that
// silently does the wrong thing.
//
//   toMissedViews  — normalize whatever the server sent into something the list
//                    can render without a single defensive `?.` at the call site
//   resolveMissedRange — re-anchor a submitted-source range onto the buffer the
//                    user is actually looking at now, or refuse
//
// THE GOVERNING RULE, same as the server-side resolver's: when in doubt, refuse.
// A bullet that fails to highlight anything is a mild disappointment. A bullet
// that highlights the WRONG lines teaches the reader something false about
// their own code, and they have no way to know it happened.

import type { LineAnchor, MissedItem } from '@/shared/types';
import { splitLines } from '@/shared/code-lines';

/**
 * One bullet, normalized: every field either usable or absent.
 *
 * `interactive` is derived rather than left to the renderer to work out, because
 * it is the single decision that governs the whole affordance — with an anchor
 * the bullet is a button, without one it is the `<span>` that shipped before
 * this feature existed. Computing it in two places is how those two drift.
 */
export interface MissedView {
  /** The bullet's prose, trimmed. Never blank — blank items are dropped. */
  note: string;
  /** Lines of the SUBMITTED source, when the server resolved a quote. */
  anchor?: LineAnchor;
  /** Handle for POST /api/coaching/fix, when a fix was generated. */
  fixId?: string;
  /** True iff this bullet has somewhere to point, i.e. renders as a button. */
  interactive: boolean;
}

/**
 * One fetched fix: the user's own lines and the coach's replacement for them.
 *
 * Lives here rather than inside `MissedList` because the CACHE of these no
 * longer lives inside `MissedList` either — `SolveSurface` holds it, so that
 * crossing the `lg` breakpoint (which returns structurally different JSX and
 * therefore remounts the whole list) does not throw away a fix the user has
 * already paid a recorded reveal for. Both ends of that prop need the name.
 *
 * A value of this shape only ever comes back from a successful
 * `POST /api/coaching/fix`. Nothing constructs one from the brief, because the
 * brief does not carry the corrected code in the first place.
 */
export interface MissedFix {
  before: string;
  after: string;
}

/** A `LineAnchor` we are willing to act on: whole, positive, non-inverted. */
function usableAnchor(anchor: LineAnchor | undefined): anchor is LineAnchor {
  if (!anchor) return false;
  const { startLine, endLine } = anchor;
  return (
    Number.isInteger(startLine) &&
    Number.isInteger(endLine) &&
    startLine >= 1 &&
    endLine >= startLine
  );
}

/**
 * Normalize the brief's `missed` array for rendering.
 *
 * The server already drops blank notes and unresolvable anchors — so why again
 * here? Because the brief is model output that has crossed a wire, this is the
 * last checkpoint before it becomes DOM, and the failure modes are asymmetric:
 * a redundant check costs a few microseconds, while an `undefined` note renders
 * as an empty bullet and a `{startLine: 0}` anchor paints a band nowhere.
 *
 * A `fixId` without a usable anchor is dropped along with the anchor. There is
 * no UI for "corrected code for lines I can't show you" — the popover's whole
 * frame is "here are your lines, here is the fix" — and offering the fetch
 * anyway would charge assistance for half a feature.
 */
export function toMissedViews(items: MissedItem[] | undefined): MissedView[] {
  if (!Array.isArray(items)) return [];
  const views: MissedView[] = [];
  for (const item of items) {
    const note = typeof item?.note === 'string' ? item.note.trim() : '';
    if (!note) continue;
    const anchor = usableAnchor(item.anchor) ? item.anchor : undefined;
    views.push({
      note,
      anchor,
      fixId: anchor && typeof item.fixId === 'string' && item.fixId ? item.fixId : undefined,
      interactive: !!anchor,
    });
  }
  return views;
}

/** Every start index (0-based) at which `needle` appears as consecutive lines. */
function findAll(haystack: string[], needle: string[]): number[] {
  const out: number[] = [];
  if (needle.length === 0 || needle.length > haystack.length) return out;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * Where do the submitted source's lines `anchor` live in the buffer on screen?
 *
 * The anchor was resolved against the source as SUBMITTED. `SolveSurface`'s
 * `code` is a live buffer the user can keep typing into while the coach is
 * still thinking, so by the time a bullet is clicked the two can disagree. The
 * options were:
 *
 *   - swap the editor to the snapshot. Destroys the user's work and their undo
 *     stack to win an argument about line numbers. No.
 *   - ask the model again. A round trip at the exact moment the user wanted an
 *     answer, plus a second chance to be wrong.
 *   - this: find the snapshot's own lines in the live buffer, once, at click
 *     time. After the first paint the editor's own decoration tracking follows
 *     subsequent edits, so this only ever runs against the buffer as it stood
 *     when the bullet was clicked.
 *
 * @returns the range to paint, or `null` when it cannot be located — which the
 *   caller shows as a quiet "you've edited since you submitted" note rather
 *   than painting a guess.
 *
 * The three outcomes, in the order they are checked:
 *
 *  1. The buffers are identical (overwhelmingly the common case — the coaching
 *     brief lands seconds after the verdict, on a submit that just blurred the
 *     editor). Return the anchor verbatim; no searching, no chance of error.
 *  2. Otherwise search the live buffer for the snapshot's lines. EXACTLY one
 *     match → paint it. This is what covers "I added an import above while the
 *     coach was thinking", the realistic edit.
 *  3. Zero matches (the user rewrote those very lines) or two or more (they
 *     duplicated them) → `null`. Two matches is the interesting refusal: one of
 *     them is right and we have no way to tell which, and a 50% chance of
 *     teaching a falsehood is not a good trade against a one-line note.
 *
 * Comparison is EXACT, whitespace and all. Both strings came out of the same
 * editor buffer minutes apart, so there is no formatting normalisation to be
 * forgiving about; being strict here converts "I reindented everything" from a
 * possible mis-paint into an honest "you've edited since you submitted".
 */
export function resolveMissedRange(
  submitted: string,
  live: string,
  anchor: LineAnchor,
): LineAnchor | null {
  if (!usableAnchor(anchor)) return null;

  const submittedLines = splitLines(submitted);
  // Bounds are checked rather than clamped. `sliceLines` clamps — right for
  // rendering a "before" block, wrong here: an anchor at line 999 of a 10-line
  // file would clamp to line 10, find line 10 in the live buffer, and paint a
  // confident band over a line the coach never mentioned.
  if (anchor.endLine > submittedLines.length) return null;
  const needle = submittedLines.slice(anchor.startLine - 1, anchor.endLine);
  if (needle.length === 0) return null;

  if (submitted === live) return anchor;

  const matches = findAll(splitLines(live), needle);
  if (matches.length !== 1) return null;
  const startLine = matches[0] + 1;
  return { startLine, endLine: startLine + needle.length - 1 };
}
