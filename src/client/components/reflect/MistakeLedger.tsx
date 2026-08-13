// =============================================================================
// MistakeLedger — what keeps going wrong, and whether it still is
// =============================================================================
// Ranked horizontal bars, one series (total count), plus a recent-vs-earlier
// delta per tag. The delta is the point: a big bar you fixed six weeks ago is
// history, and a small bar that is all *recent* is the thing to go read about.
//
// The delta carries three redundant channels — arrow direction, colour, and a
// signed number — so it survives both colourblindness and a greyscale
// screenshot.

import { useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import type { ReflectMistake } from '@/shared/types';
import { DIFFICULTY_COLOR, SERIES, useElementWidth, useHoverPoint } from './chart';
import { ChartTooltip, TooltipRow, TooltipTitle, Empty } from './primitives';
import { mistakeLabel } from '@/client/lib/format';
import { cn } from '@/lib/utils';

/** Reuse the validated triad's ends: emerald = improving, rose = worsening. */
const BETTER = DIFFICULTY_COLOR.easy;
const WORSE = DIFFICULTY_COLOR.hard;

function Delta({ recent, earlier }: { recent: number; earlier: number }) {
  const diff = recent - earlier;
  if (diff === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs tabular-nums text-muted-foreground">
        <Minus className="h-3 w-3" aria-hidden />
        <span className="sr-only">unchanged, </span>0
      </span>
    );
  }
  const worse = diff > 0;
  const Icon = worse ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className="inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums text-foreground"
      title={worse ? 'more often lately' : 'less often lately'}
    >
      <Icon
        className="h-3 w-3"
        style={{ color: worse ? WORSE : BETTER }}
        aria-hidden
      />
      <span className="sr-only">{worse ? 'up ' : 'down '}</span>
      {worse ? '+' : '−'}
      {Math.abs(diff)}
    </span>
  );
}

export function MistakeLedger({ mistakes }: { mistakes: ReflectMistake[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [boxRef, width] = useElementWidth<HTMLDivElement>();
  const { ref: hoverRef, point, handlers, clear } = useHoverPoint<HTMLDivElement>();

  if (mistakes.length === 0) {
    return <Empty>No recurring mistakes logged yet — clean solving so far.</Empty>;
  }

  const rows = [...mistakes].sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...rows.map((m) => m.count));
  const hit = hovered === null ? null : rows[hovered];

  return (
    <div
      ref={(el) => {
        boxRef.current = el;
        hoverRef.current = el;
      }}
      className="relative"
      {...handlers}
      onPointerLeave={() => {
        clear();
        setHovered(null);
      }}
    >
      <div className="space-y-1">
        {rows.map((m, i) => (
          <div
            key={m.tag}
            onPointerEnter={() => setHovered(i)}
            className={cn(
              'flex min-h-11 items-center rounded-md px-1 transition-colors',
              hovered === i && 'bg-accent/40',
            )}
          >
            <span className="w-[7.5rem] shrink-0 truncate pr-2 text-xs text-foreground sm:w-40 sm:text-sm">
              {mistakeLabel(m.tag)}
            </span>
            <span className="block min-w-0 flex-1">
              <span className="block h-2.5 w-full overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${Math.max((m.count / max) * 100, 4)}%`,
                    backgroundColor: SERIES,
                  }}
                />
              </span>
            </span>
            <span className="w-8 shrink-0 pl-2 text-right text-xs font-semibold tabular-nums text-foreground">
              {m.count}
            </span>
            <span className="w-12 shrink-0 pl-2 text-right">
              <Delta recent={m.recent} earlier={m.earlier} />
            </span>
          </div>
        ))}
      </div>

      <p className="mt-2 text-[0.7rem] text-muted-foreground">
        Bars are the all-time count. The arrow compares the recent half of your
        history with the earlier half — down is better.
      </p>

      {hit && point && (
        <ChartTooltip x={point.x} y={point.y} containerWidth={width}>
          <TooltipTitle>{mistakeLabel(hit.tag)}</TooltipTitle>
          <TooltipRow label="Total" value={hit.count} />
          <TooltipRow label="Recent half" value={hit.recent} />
          <TooltipRow label="Earlier half" value={hit.earlier} />
        </ChartTooltip>
      )}
    </div>
  );
}
