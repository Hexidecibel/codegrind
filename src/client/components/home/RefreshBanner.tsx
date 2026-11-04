// =============================================================================
// RefreshBanner — the Pattern Refresh, in one place, inside the Today card
// =============================================================================
// One compact row: today's pattern (a link to its shape), a 9-dot day strip,
// a "done" chip once today's core steps settle, and a ⋯ menu that holds
// everything else the refresh controls: how it works, the extras (concept rep,
// story forge) and Turn off.

import { Link } from 'react-router-dom';
import { ChevronRight, CircleHelp, Lightbulb, Mic, MoreHorizontal, Power, RefreshCw } from 'lucide-react';
import type { TodayState } from '@/shared/today';
import { patternHref } from '@/shared/pattern-shapes';
import { helpHref } from '@/client/lib/help-content';
import { Button } from '@/client/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/client/components/ui/popover';
import { cn } from '@/lib/utils';
import { useStoryBankEnabled } from '@/client/lib/integrations';

/** One dot per refresh day: settled days green, today primary, the rest grey. */
export function RefreshDays({ r }: { r: Pick<TodayState['refresh'], 'day' | 'total' | 'completedThrough'> }) {
  return (
    <span className="flex items-center gap-1" aria-hidden>
      {Array.from({ length: r.total }, (_, i) => (
        <span
          key={i}
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            i < r.completedThrough ? 'bg-emerald-400' : i === r.day - 1 ? 'bg-primary' : 'bg-muted-foreground/30',
          )}
        />
      ))}
    </span>
  );
}

const menuItem =
  'flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 text-sm transition-colors hover:bg-secondary sm:pointer-fine:min-h-9';

export function RefreshBanner({ r, busy, onTurnOff }: { r: TodayState['refresh']; busy: boolean; onTurnOff: () => void }) {
  const storyBank = useStoryBankEnabled();
  return (
    <div className="flex items-center gap-3 rounded-lg bg-secondary/60 py-1.5 pl-3 pr-1.5">
      <RefreshCw className="h-4 w-4 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <Link
          to={r.pattern ? patternHref(r.pattern) : '/patterns'}
          className="group inline-flex max-w-full items-center gap-1 text-sm font-semibold underline-offset-4 hover:underline"
          title={r.pattern ? 'Open the shape' : 'All shapes'}
        >
          <span className="truncate">{r.label}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden />
        </Link>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span>
            Refresh day {r.day} of {r.total}
          </span>
          <RefreshDays r={r} />
          {r.dayComplete && <span className="text-emerald-400">done · next pattern tomorrow</span>}
        </p>
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Refresh options" className="shrink-0 text-muted-foreground pointer-coarse:h-11 pointer-coarse:w-11">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-60 p-1.5">
          <Link to={helpHref('loop')} className={menuItem}>
            <CircleHelp className="h-4 w-4 text-muted-foreground" aria-hidden /> How it works
          </Link>
          <p className="px-2 pb-0.5 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Extras</p>
          <Link to="/concept" className={menuItem}>
            <Lightbulb className="h-4 w-4 text-muted-foreground" aria-hidden /> Concept rep
          </Link>
          {storyBank && (
            <Link to="/stories" className={menuItem}>
              <Mic className="h-4 w-4 text-muted-foreground" aria-hidden /> Story forge
            </Link>
          )}
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            disabled={busy}
            className={cn(menuItem, 'text-muted-foreground disabled:opacity-50')}
            onClick={() => {
              if (window.confirm('Turn the pattern refresh off? Today goes back to the normal day; turning it back on resumes where you left off.')) onTurnOff();
            }}
          >
            <Power className="h-4 w-4" aria-hidden /> Turn off the refresh
          </button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
