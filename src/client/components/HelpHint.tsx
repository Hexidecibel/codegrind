// =============================================================================
// HelpHint — one affordance, used everywhere something needs explaining
// =============================================================================
// The app is full of numbers and labels that are perfectly clear once you know
// the mechanism and completely opaque before that: `mastery 42%`, `Cold review`,
// `Compile Error`, `Assist: Standard`. The fix is not more words on screen — the
// person who already knows what those mean should see exactly what they see
// today — so this is a single, quiet glyph that stays out of the way and opens
// two or three sentences plus a link into the matching Help section.
//
// ONE COMPONENT, DELIBERATELY. The alternative was a bespoke popover per site,
// which is how an app ends up with four tooltips that behave four ways and one
// of them unreachable by keyboard. Everything about a hint except *which* hint
// is fixed here.
//
// Why Radix Popover rather than a hover div:
//
//   - it opens on click/Enter/Space and closes on Escape, so it works with a
//     keyboard and on a touchscreen. A hover-only affordance is unreachable on
//     both. Hover is used ONLY to make the glyph more visible, never to reveal
//     the content.
//   - the content is `role="dialog"`, focus moves into it and returns to the
//     trigger on close, and the trigger carries `aria-expanded`/`aria-controls`.
//     None of that is worth reimplementing, and `ui/popover.tsx` is already the
//     app's popover (EditorSettings uses the same primitive).
//
// The copy lives in help-content.ts, not here — see that file for why a hint is
// a pointer into the long explanation rather than a second short one.

import { useId } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CircleQuestionMark } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/client/components/ui/popover';
import {
  HELP_HINTS,
  helpHref,
  hintDestination,
  type HelpHintId,
} from '@/client/lib/help-content';
import { cn } from '@/lib/utils';

export interface HelpHintProps {
  /** Which hint to show. The copy and its Help destination come from the id. */
  id: HelpHintId;
  /**
   * Popover edge alignment, passed through to Radix. Default `start`, because
   * most hints sit at the left of a label; pass `end` for one in a right-hand
   * gutter so the panel does not hang off the viewport.
   */
  align?: 'start' | 'center' | 'end';
  /** Extra classes for the trigger — spacing only. Never colour or size. */
  className?: string;
}

export function HelpHint({ id, align = 'start', className }: HelpHintProps) {
  const hint = HELP_HINTS[id];
  const destination = hintDestination(id);
  const titleId = useId();

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          // The name a screen reader announces. "Help: Mastery" rather than
          // "question mark button", and it repeats the popover's own heading so
          // the two cannot describe different things.
          aria-label={`Help: ${hint.title}`}
          className={cn(
            // Quiet by default and brighter on hover/focus: someone who already
            // knows what the label means should be able to look straight past
            // it, and someone hunting for an explanation should find it.
            'inline-flex shrink-0 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            // Negative margin + padding: a 14px glyph with a ~30px hit area,
            // which clears WCAG 2.5.8 without pushing anything around it. The
            // same trick the error-bar dismiss button uses in SolveSurface.
            '-m-2 p-2',
            className,
          )}
        >
          <CircleQuestionMark aria-hidden className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        // Radix renders this as role="dialog"; point its label at the heading
        // below so the dialog announces as the thing it explains.
        aria-labelledby={titleId}
        className="w-72 space-y-2 p-3.5 text-left"
      >
        <p id={titleId} className="text-sm font-semibold text-foreground">
          {hint.title}
        </p>
        {hint.body.map((paragraph) => (
          <p key={paragraph} className="text-xs leading-relaxed text-muted-foreground">
            {paragraph}
          </p>
        ))}
        {/* Names its destination instead of saying "learn more", so the reader
            knows whether the click is worth losing their place for. */}
        <Link
          to={helpHref(hint.section)}
          className="inline-flex items-center gap-1 pt-0.5 text-xs font-medium text-primary underline-offset-4 hover:underline"
        >
          {destination.title}
          <ArrowRight aria-hidden className="h-3 w-3" />
        </Link>
      </PopoverContent>
    </Popover>
  );
}
