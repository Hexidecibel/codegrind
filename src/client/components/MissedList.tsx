// =============================================================================
// MissedList — the coach's "what you missed" bullets, made clickable
// =============================================================================
// Before this component the section was a wall of prose: "you don't reset
// `left` when the window shrinks" with no indication of WHICH line that is, and
// no sight of what the corrected line would have been. Reading it meant doing
// the mapping by hand, which is the chore this whole feature exists to delete.
//
// ONE COMPONENT, ONE BEHAVIOUR, following the rule HelpHint.tsx:11-25 states
// outright: the alternative was a bespoke popover per site, "which is how an app
// ends up with four tooltips that behave four ways and one of them unreachable
// by keyboard". So this uses the same `ui/popover` primitive as HelpHint and
// EditorSettings, and inherits Radix's dialog role, focus return and Escape
// rather than reimplementing any of it.
//
// FIVE RULES THAT ARE NOT NEGOTIABLE, each of them a decision that would be
// quietly wrong if made the other way:
//
//  1. AN ITEM WITH NO ANCHOR RENDERS EXACTLY AS IT DID BEFORE — a `<span>`, no
//     button, no hover cursor, nothing. Not every bullet can be tied to a line
//     (an item about something MISSING from the code has no line to point at),
//     and a dead-looking affordance that does nothing when tapped is worse than
//     plain text: it teaches the reader that the feature is broken.
//
//  2. AN ANCHORED ITEM IS A REAL `<button type="button">`. A div with an
//     onClick is the difference between "reachable by Tab and Enter" and
//     "reachable by mouse only", and it is one careless refactor away at all
//     times — hence the test.
//
//  3. THE CORRECTED CODE IS CONDITIONALLY RENDERED, NEVER CSS-HIDDEN. It is
//     assistance, it is paid for with a recorded reveal, and it does not exist
//     in this component's tree until the server has been asked for it. (The
//     brief never carries it either — it carries an opaque `fixId`; see
//     api.ts's `revealCoachFix`.) Rendering it hidden would put the answer in
//     devtools and make the whole gate theatre.
//
//  4. THE POPOVER ANCHORS TO THE BULLET, NOT TO THE CODE LINE. Anchoring over
//     the editor would need scroll/resize/wrap/fold tracking to stay put, would
//     cover the code on a phone, and on a phone the anchor would live inside a
//     `display:none` tabpanel where it has no box to anchor to. The band in the
//     editor already supplies the proximity; this supplies the words.
//
//  5. THE BAND OUTLIVES THE POPOVER. `selected` (which bullet's lines are lit
//     up) and `open` (which bullet's popover is showing) are two props, not
//     one, because the natural next action after reading a bullet is to click
//     into the editor and fix the line — and that click is an outside-click,
//     which Radix answers by closing the popover. Tying the band's lifetime to
//     the popover's meant the marker died at the exact moment it became
//     useful. So a close only closes; the band comes down when the user picks a
//     different bullet, when a new run/submit makes the brief obsolete, or when
//     they say so — see `onDismiss` and the trigger's toggle below.

import { useEffect, useId, useState } from 'react';
import { BookOpen, Loader2 } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/client/components/ui/popover';
import { Button } from '@/client/components/ui/button';
import { ApiError, revealCoachFix } from '@/client/lib/api';
import { lineDiff } from '@/client/lib/line-diff';
import type { MissedFix, MissedView } from '@/client/lib/missed-fix';
import { cn } from '@/lib/utils';

export interface MissedListProps {
  /**
   * Already normalized (see `toMissedViews`), because the HOST indexes into the
   * same array to decide which lines to paint. Normalizing in two places would
   * let a dropped blank note shift the indices apart, and the symptom — every
   * bullet highlighting the lines of the bullet below it — would look like an
   * anchoring bug rather than an off-by-one.
   */
  items: MissedView[];
  /**
   * Index of the bullet whose BAND is up in the editor, or `null`.
   *
   * Deliberately not the same thing as `open`. This is what the persistent
   * left-border marker tracks, because that marker is the on-screen answer to
   * "why is that line pink" — and the pink line is still there long after the
   * popover has gone, which is the whole point of rule 5.
   */
  selected: number | null;
  /** Index of the bullet whose popover is showing, or `null`. */
  open: number | null;
  /**
   * The user opened bullet `index`: show its popover AND move the band to it
   * (there is only ever one band, so this replaces any previous one).
   */
  onOpen: (index: number) => void;
  /**
   * The popover was closed by something that is not a dismissal — a click into
   * the editor, Escape, focus leaving. THE BAND SURVIVES THIS. Controlled by
   * the host rather than held here because closing is not only a user action:
   * collapsing the results strip, or rotating a phone into a short landscape
   * viewport, unmounts the trigger this popover is anchored to.
   */
  onClose: () => void;
  /**
   * The user is finished with these lines: band down, popover down. Reached
   * two ways, on purpose — the "Clear highlight" control in the popover (which
   * is the discoverable one, and the only one a keyboard user will find), and
   * clicking the open bullet again, which is the gesture people try first
   * because it is the symmetric undo of the click that raised it.
   */
  onDismiss: () => void;
  /**
   * Fixes already fetched — and therefore already PAID FOR with a recorded
   * reveal — keyed by `fixId`.
   *
   * Held by the host, not here, and that is a bug fix rather than a taste
   * call: `SolveSurface` returns structurally different JSX above and below
   * `lg`, so resizing a window across that breakpoint remounts this component
   * and wipes its state. A user who revealed a fix at 700px and then widened
   * the window was shown "Show me the fix" again and had to re-do the two-tap
   * confirm for something they had already bought. (`markSolutionRevealed` is
   * idempotent so they were never charged twice — but nothing on screen told
   * them that, which is its own kind of wrong.)
   *
   * The security property is untouched by the move: this map starts empty and
   * is only ever written from a 200 on `POST /api/coaching/fix`. No fix text
   * reaches the browser before it is paid for, and none of it is rendered
   * while the popover is closed.
   */
  fixes: Record<string, MissedFix>;
  /** A fix came back from the server, i.e. the reveal has been written. */
  onFixRevealed: (fixId: string, fix: MissedFix) => void;
  /**
   * The open item's lines could not be found in the buffer as it stands now —
   * the user kept typing after they submitted. Said plainly in the popover
   * instead of painting a guess.
   */
  drifted?: boolean;
  /**
   * The reference solution is already on screen (earned or revealed). Skips the
   * two-tap confirm: the fix is a handful of lines OUT OF something the reader
   * can already scroll to, and asking them to confirm a price they have already
   * paid is a ritual, not a safeguard.
   */
  answerVisible?: boolean;
}

/** `Lines 4–6`, or `Line 4` when the anchor is a single line. */
function rangeLabel(startLine: number, endLine: number): string {
  return endLine > startLine ? `Lines ${startLine}–${endLine}` : `Line ${startLine}`;
}

/**
 * The before/after, as a diff.
 *
 * The glyph is REAL TEXT, not decoration: a `-`/`+` in the content is what makes
 * this legible to a colour-blind reader and to a screen reader both (WCAG 1.4.1
 * — colour is never the only carrier of meaning). Hence no `aria-hidden` on it,
 * and hence the rose/emerald pair being a reinforcement of the glyph rather
 * than the signal itself. That pair is ResultsPanel's expected-vs-actual
 * palette, reused so "wrong" and "right" look the same everywhere in the app.
 */
function FixDiff({ before, after }: { before: string; after: string }) {
  const rows = lineDiff(before, after);
  return (
    <pre className="max-h-64 overflow-auto rounded-md border border-border bg-black/40 p-2 font-mono text-[11px] leading-relaxed">
      {rows.map((row, i) => (
        <div
          key={i}
          className={cn(
            'whitespace-pre',
            row.kind === 'del' && 'bg-rose-500/10 text-rose-300/90',
            row.kind === 'ins' && 'bg-emerald-500/10 text-emerald-300/90',
            row.kind === 'same' && 'text-muted-foreground',
          )}
        >
          {row.kind === 'del' ? '- ' : row.kind === 'ins' ? '+ ' : '  '}
          {row.text}
        </div>
      ))}
    </pre>
  );
}

export function MissedList({
  items,
  selected,
  open,
  onOpen,
  onClose,
  onDismiss,
  fixes,
  onFixRevealed,
  drifted = false,
  answerVisible = false,
}: MissedListProps) {
  const titleId = useId();
  // `confirming`, `loading` and `fixError` stay local: all three are about the
  // popover that is on screen right now, and if that popover is gone (or the
  // component remounted) there is nothing for them to describe. The `fixes`
  // cache is the one piece that has to outlive the mount, and it is a prop.
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);

  // A confirm is a promise about ONE bullet. Moving to another (or closing)
  // must not leave a primed "Sure?" pointing at code the user is no longer
  // looking at — that is how a mis-tap costs a clean solve. Keyed on `open`
  // rather than `selected`: the confirm lives in the popover, so it is the
  // popover's lifetime that bounds it, not the band's.
  useEffect(() => {
    setConfirming(false);
    setFixError(null);
  }, [open]);

  const openItem = open !== null ? items[open] : undefined;
  const fix = openItem?.fixId ? (fixes[openItem.fixId] ?? null) : null;

  async function askForFix(fixId: string) {
    if (loading) return;
    // Two taps, mirroring the Answer button (SolveSurface's `reveal`): the
    // first states the price, the second pays it. Skipped entirely when the
    // whole reference solution is already visible.
    if (!answerVisible && !confirming) {
      setConfirming(true);
      return;
    }
    setLoading(true);
    setFixError(null);
    try {
      const res = await revealCoachFix(fixId);
      // Handed up rather than stored here — the host's copy survives the
      // remount that crossing `lg` causes. Only reachable on a 200, which is
      // the point at which the server has already written the reveal.
      onFixRevealed(fixId, { before: res.before, after: res.after });
      setConfirming(false);
    } catch (err) {
      // A 404 ("that fix is no longer available") is a normal outcome, not a
      // bug — the fixes live in server memory for as long as the brief is
      // plausibly on screen. The server's sentence says so; show it as-is.
      setFixError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not fetch that fix.',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => {
        const isOpen = open === i;
        // Tracks the BAND, not the popover. The user clicks a bullet, reads it,
        // then clicks into the editor to fix the line — which closes the
        // popover and leaves the band up. If the marker followed `isOpen` it
        // would vanish right then, and the pink lines in the editor would have
        // nothing on screen pointing back at the sentence that explains them.
        const isBanded = selected === i;
        return (
          <li
            key={i}
            className={cn(
              'flex gap-2',
              // The persistent marker in the band's own colour, kept up for as
              // long as the highlight is. Negative margin so turning it on does
              // not shove the text sideways.
              isBanded && '-ml-2 border-l-2 border-rose-400/80 pl-[calc(0.5rem-2px)]',
            )}
          >
            {/* Decorative: the list already conveys "these are separate items". */}
            <span
              aria-hidden
              className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-400/80"
            />
            {item.anchor ? (
              <Popover
                open={isOpen}
                // A close is JUST a close. Radix cannot tell us why it fired —
                // Escape, a click into the editor and a click on the trigger
                // all arrive here as `false` — so the band is not this
                // callback's business; see the trigger's `onClick` for the one
                // close that does take it down.
                onOpenChange={(o) => (o ? onOpen(i) : onClose())}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    // Radix's Slot runs the CHILD's handler before its own, so
                    // `isOpen` here is still the state the user was looking at
                    // when they clicked. Clicking the open bullet again is the
                    // symmetric undo of the click that raised the band, so it
                    // takes both down; Radix's toggle then closes the popover
                    // a second time, harmlessly.
                    onClick={() => {
                      if (isOpen) onDismiss();
                    }}
                    className={cn(
                      // `cursor-pointer` explicitly: the browser default for a
                      // <button> is `default`, and Tailwind's preflight does
                      // not override it. Without this the only thing that says
                      // "this does something" is the dotted underline changing
                      // shade on hover — which a reader who is not already
                      // hovering never sees. Anchored items only: an
                      // unanchored bullet is a <span> and must stay inert.
                      'min-w-0 flex-1 cursor-pointer rounded text-left underline decoration-rose-400/40 decoration-dotted underline-offset-4',
                      'transition-colors hover:decoration-rose-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                      isBanded && 'decoration-rose-400',
                    )}
                  >
                    {item.note}
                    {/* The visible text is the coach's prose; a screen reader
                        would otherwise get no clue that it is actionable or what
                        the action costs. */}
                    <span className="sr-only">
                      {' '}
                      — {rangeLabel(item.anchor.startLine, item.anchor.endLine)}; opens the
                      lines in the editor
                      {item.fixId ? ' and offers the corrected version' : ''}
                    </span>
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  collisionPadding={12}
                  aria-labelledby={titleId}
                  className="w-[min(26rem,calc(100vw-1.5rem))] space-y-2.5 p-3.5 text-left"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p id={titleId} className="text-sm font-semibold text-foreground">
                      {rangeLabel(item.anchor.startLine, item.anchor.endLine)} of your
                      submission
                    </p>
                    {/* THE DISCOVERABLE WAY OUT. The band deliberately outlives
                        this popover, so there has to be something that says in
                        words how to take it down — the click-the-bullet-again
                        toggle is guessable but invisible, and unreachable as a
                        concept for anyone reading rather than experimenting.
                        Hidden when `drifted`, because then there is no band on
                        screen and offering to clear it would be a lie. */}
                    {!drifted && (
                      <button
                        type="button"
                        onClick={onDismiss}
                        className="shrink-0 cursor-pointer rounded text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      >
                        Clear highlight
                      </button>
                    )}
                  </div>
                  <p
                    className={cn(
                      'text-xs leading-relaxed',
                      drifted ? 'text-amber-400/90' : 'text-muted-foreground',
                    )}
                  >
                    {drifted
                      ? "You've edited since you submitted and these lines have moved or gone, so nothing is highlighted. The before/after below is still your submitted code."
                      : 'Highlighted in the editor, and it stays there while you work.'}
                  </p>

                  {!item.fixId ? (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      The coach didn't write a corrected version for this one.
                    </p>
                  ) : fix ? (
                    <div className="space-y-1.5">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Yours <span aria-hidden>→</span> the fix
                      </p>
                      <FixDiff before={fix.before} after={fix.after} />
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        Unverified model output — read it, don't paste it. Nothing here
                        has been run against the tests.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <Button
                        type="button"
                        size="sm"
                        variant={confirming ? 'destructive' : 'outline'}
                        disabled={loading}
                        onClick={() => askForFix(item.fixId!)}
                        // The house rule for a phone-reachable control is 44px
                        // (WCAG 2.5.5 AAA, see button.tsx's `touch` size), and
                        // this one is inside a popover the user reached with a
                        // thumb. Done with a breakpoint rather than by threading
                        // `controlSize` in as a second prop — the popover's own
                        // width is already a media query, and one more prop for
                        // a value CSS can read is a prop that will get passed
                        // wrong somewhere.
                        className="h-11 w-full gap-1.5 text-sm lg:h-8 lg:text-xs"
                        title={
                          answerVisible
                            ? 'The reference solution is already on screen, so this costs nothing more.'
                            : "Shows the corrected lines. Counts as assistance, like the Answer button."
                        }
                      >
                        {loading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <BookOpen className="h-4 w-4" />
                        )}
                        {loading
                          ? 'Fetching…'
                          : answerVisible
                            ? 'Show the corrected lines'
                            : confirming
                              ? 'Sure? Counts as assisted'
                              : 'Show me the fix'}
                      </Button>
                      {!answerVisible && (
                        <p className="text-[11px] leading-relaxed text-muted-foreground">
                          {confirming
                            ? 'Tap again — this is recorded as a reveal, so your next submit of this problem counts as assisted.'
                            : 'Corrected code counts as assistance, the same as the Answer button.'}
                        </p>
                      )}
                      {fixError && (
                        <p className="text-[11px] leading-relaxed text-rose-300/90">
                          {fixError}
                        </p>
                      )}
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            ) : (
              // No anchor, no affordance. Byte for byte what shipped before.
              <span>{item.note}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
