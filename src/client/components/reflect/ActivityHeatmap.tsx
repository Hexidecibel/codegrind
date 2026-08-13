// =============================================================================
// ActivityHeatmap — 84 days of showing up
// =============================================================================
// Twelve weeks, one cell a day, weekday down / week across. The one rule that
// matters: **a zero-attempt day is not a ramp step.** It renders on the muted
// surface, so "I did nothing" can never be mistaken for "I did a little" —
// which is exactly the mistake a 5-step ramp starting at "very faint" invites.
//
// Cells are 16px marks with a 19px invisible hit target over them, because
// this gets read on a phone and a 16px tap target is a lie.

import { useState } from 'react';
import type { ReflectActivityDay } from '@/shared/types';
import { ACTIVITY_BUCKETS, RAMP, activityRamp, dayLabel } from './chart';
import { ChartTooltip, TooltipRow, TooltipTitle, Empty } from './primitives';

const CELL = 16;
const GAP = 3;
const PITCH = CELL + GAP;
const GUTTER = 26; // weekday labels
const HEADER = 14; // month labels

const WEEKDAYS = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'];

/** Monday-first weekday index for a `YYYY-MM-DD` string, parsed as local. */
function mondayIndex(isoDate: string): number {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  return (new Date(y, (m || 1) - 1, d || 1).getDay() + 6) % 7;
}

function monthLabel(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString(undefined, {
    month: 'short',
  });
}

export function ActivityHeatmap({ activity }: { activity: ReflectActivityDay[] }) {
  const [hovered, setHovered] = useState<number | null>(null);

  if (activity.length === 0) return <Empty>No activity recorded yet.</Empty>;

  // The series is contiguous and oldest-first, so the weekday of day 0 fixes
  // the whole grid; no per-cell date maths.
  const offset = mondayIndex(activity[0].date);
  const weeks = Math.ceil((activity.length + offset) / 7);
  const width = GUTTER + weeks * PITCH;
  const height = HEADER + 7 * PITCH;

  const day = hovered === null ? null : activity[hovered];
  const hx = hovered === null ? 0 : GUTTER + Math.floor((hovered + offset) / 7) * PITCH;
  const hy = hovered === null ? 0 : HEADER + ((hovered + offset) % 7) * PITCH;

  // One label per month, at the first column that month appears in.
  const monthTicks: Array<{ col: number; label: string }> = [];
  activity.forEach((d, i) => {
    const label = monthLabel(d.date);
    const col = Math.floor((i + offset) / 7);
    const last = monthTicks[monthTicks.length - 1];
    if (!last || last.label !== label) {
      if (!last || col > last.col + 1) monthTicks.push({ col, label });
    }
  });

  return (
    <div>
      <div className="reflect-hscroll overflow-x-auto pb-1">
        {/* Clear on leave so a tooltip can never get stranded on a phone. */}
        <div
          className="relative"
          style={{ width, height }}
          onPointerLeave={() => setHovered(null)}
          onPointerCancel={() => setHovered(null)}
        >
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`Attempts per day over the last ${activity.length} days`}
            className="block"
          >
            {monthTicks.map((t) => (
              <text
                key={`${t.label}-${t.col}`}
                x={GUTTER + t.col * PITCH}
                y={HEADER - 4}
                fontSize={10}
                className="fill-muted-foreground"
              >
                {t.label}
              </text>
            ))}

            {WEEKDAYS.map((w, i) =>
              w ? (
                <text
                  key={w}
                  x={0}
                  y={HEADER + i * PITCH + CELL - 4}
                  fontSize={9.5}
                  className="fill-muted-foreground"
                >
                  {w}
                </text>
              ) : null,
            )}

            {activity.map((d, i) => {
              const col = Math.floor((i + offset) / 7);
              const row = (i + offset) % 7;
              const x = GUTTER + col * PITCH;
              const y = HEADER + row * PITCH;
              const colour = activityRamp(d.attempts);
              const on = hovered === i;
              return (
                <g key={d.date}>
                  {colour === null ? (
                    <rect
                      x={x}
                      y={y}
                      width={CELL}
                      height={CELL}
                      rx={3}
                      className="fill-muted"
                      fillOpacity={0.55}
                    />
                  ) : (
                    <rect
                      x={x}
                      y={y}
                      width={CELL}
                      height={CELL}
                      rx={3}
                      fill={colour}
                    />
                  )}
                  {on && (
                    <rect
                      x={x - 1}
                      y={y - 1}
                      width={CELL + 2}
                      height={CELL + 2}
                      rx={4}
                      fill="none"
                      className="stroke-foreground"
                      strokeOpacity={0.8}
                      strokeWidth={1.25}
                    />
                  )}
                  {/* Hit target, larger than the mark. */}
                  <rect
                    x={x - GAP / 2}
                    y={y - GAP / 2}
                    width={PITCH}
                    height={PITCH}
                    fill="transparent"
                    onPointerEnter={() => setHovered(i)}
                    onPointerDown={() => setHovered(i)}
                  />
                </g>
              );
            })}

          </svg>

          {day && (
            <ChartTooltip x={hx + CELL / 2} y={hy} containerWidth={width}>
              <TooltipTitle>{dayLabel(day.date)}</TooltipTitle>
              <TooltipRow label="Attempts" value={day.attempts} />
              <TooltipRow label="Solved" value={day.solved} />
            </ChartTooltip>
          )}
        </div>
      </div>

      <div className="mt-2 flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
        <span>None</span>
        <span className="h-2.5 w-2.5 rounded-[2px] bg-muted" />
        <span className="ml-1.5">Less</span>
        {RAMP.map((c, i) => (
          <span
            key={c}
            className="h-2.5 w-2.5 rounded-[2px]"
            style={{ backgroundColor: c }}
            title={
              i === 0 ? '1 attempt' : `${ACTIVITY_BUCKETS[i] ?? i + 1}+ attempts`
            }
          />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}
