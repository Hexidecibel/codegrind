// =============================================================================
// TierLadder — every topic against the unlock gate
// =============================================================================
// This was MasteryGate, drawing every topic against a 0.60 line. That line was
// a coin-flip solve rate wearing a percentage, so both the number and the word
// "mastered" are gone. What is drawn now is the tier ladder:
//
//   each quarter of a bar == one completed tier (easy, medium, hard, expert)
//   the marker at 25%     == the easy tier, which is what opens dependents
//
// A tier is 3 DISTINCT problems solved with zero hints, so a bar can only move
// by doing something new — re-solving what you already solved moves nothing.
//
// Direct value labels on every row (18 rows, one label each — that is
// "selective", not "a number on every point"; there is one point per row).

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ReflectTreeNode } from '@/shared/types';
import { UNLOCK_GATE, rampFor, useElementWidth, useHoverPoint } from './chart';
import { ChartTooltip, TooltipRow, TooltipTitle, Empty } from './primitives';
import { humanize } from '@/client/lib/format';
import { cn } from '@/lib/utils';

/** Width of the topic-name gutter; the gate marker is offset by this. */
const LABEL_W = 'w-[7.5rem] sm:w-40';
/** The value column has to hold `expert ×12`, not just `62%`. */
const VALUE_W = 'w-[4.5rem]';

export function TierLadder({ tree }: { tree: ReflectTreeNode[] }) {
  const navigate = useNavigate();
  const [hovered, setHovered] = useState<number | null>(null);
  const [boxRef, width] = useElementWidth<HTMLDivElement>();
  const { ref: hoverRef, point, handlers, clear } = useHoverPoint<HTMLDivElement>();

  if (tree.length === 0) return <Empty>No topics yet.</Empty>;

  // Descending: the topics furthest up the ladder at the top, the ones one or
  // two clean solves from opening something in the middle where the eye lands.
  const rows = [...tree].sort((a, b) => b.mastery - a.mastery);
  const node = hovered === null ? null : rows[hovered];

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
      {/* Gate caption, aligned to the marker below it. */}
      <div className="flex items-end pb-1">
        <div className={cn('shrink-0', LABEL_W)} />
        <div className="relative min-w-0 flex-1">
          <span
            className="absolute -translate-x-1/2 whitespace-nowrap text-[0.7rem] font-medium text-muted-foreground"
            style={{ left: `${UNLOCK_GATE * 100}%` }}
          >
            easy tier · unlocks
          </span>
          <span className="block h-4" />
        </div>
        <div className={cn('shrink-0', VALUE_W)} />
      </div>

      <div className="space-y-1">
        {rows.map((n, i) => {
          const locked = n.state === 'locked';
          const over = n.tier !== 'none';
          return (
            <button
              key={n.topic}
              type="button"
              onMouseEnter={() => setHovered(i)}
              onFocus={() => setHovered(i)}
              onBlur={() => setHovered(null)}
              onClick={() => navigate(`/study?topic=${encodeURIComponent(n.topic)}`)}
              // 32px rows would be tidier, but this is read on a phone.
              className="flex min-h-11 w-full items-center rounded-md px-1 text-left transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none"
            >
              <span
                className={cn(
                  'shrink-0 truncate pr-2 text-xs sm:text-sm',
                  locked ? 'text-muted-foreground' : 'text-foreground',
                  LABEL_W,
                )}
              >
                {humanize(n.topic)}
              </span>

              <span className="relative block min-w-0 flex-1">
                <span className="block h-2.5 w-full overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${Math.max(0, Math.min(1, n.mastery)) * 100}%`,
                      backgroundColor: rampFor(n.mastery),
                      opacity: locked ? 0.45 : 1,
                    }}
                  />
                </span>
                {/* The unlock marker. Per-row, but every row shares the same
                    track geometry, so it reads as one continuous line. */}
                <span
                  aria-hidden
                  className="absolute inset-y-[-3px] w-px bg-foreground/45"
                  style={{ left: `${UNLOCK_GATE * 100}%` }}
                />
              </span>

              <span
                className={cn(
                  'shrink-0 truncate pl-2 text-right text-xs tabular-nums',
                  VALUE_W,
                  over ? 'font-semibold text-foreground' : 'text-muted-foreground',
                )}
              >
                {n.tierLabel}
              </span>
            </button>
          );
        })}
      </div>

      {node && point && (
        <ChartTooltip x={point.x} y={point.y} containerWidth={width}>
          <TooltipTitle>{humanize(node.topic)}</TooltipTitle>
          <TooltipRow label="Tier" value={node.tierLabel} />
          <TooltipRow
            label={node.nextTier ? `Toward ${node.nextTier}` : 'Top tier solves'}
            value={
              node.nextTier
                ? `${node.towardNext}/${node.tierRequirement} clean`
                : String(node.cleanSolves.expert)
            }
          />
          <TooltipRow label="Solved" value={`${node.solved}/${node.attempts}`} />
          <TooltipRow label="State" value={node.state} />
        </ChartTooltip>
      )}
    </div>
  );
}
