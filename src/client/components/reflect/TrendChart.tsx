// =============================================================================
// TrendChart — one metric, one line, one y-axis
// =============================================================================
// This component is deliberately single-series and deliberately single-axis.
// The two trend metrics on this page — first-submit accuracy and submits to
// pass — are rendered as **two of these side by side**, never as one chart
// with two y-scales. A dual-axis chart lets you draw any correlation you like
// by sliding one scale, which is the opposite of what a "am I improving?"
// page should do.
//
// One series means no legend box: the title names the line. The only direct
// label is on the latest point, because that is the number the reader came
// for; everything else is available on hover or in the "show data" table.

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { SERIES, linePath, linearScale, niceTicks, useElementWidth, useHoverPoint } from './chart';
import { ChartTooltip, TooltipRow, TooltipTitle, Empty } from './primitives';

export interface TrendDatum {
  /** Primary tooltip line — usually the problem title. */
  label: string;
  /** Secondary tooltip line — topic, date, whatever else identifies it. */
  meta?: string;
  value: number;
}

const H = 168;
const M = { top: 14, right: 44, bottom: 20, left: 34 };

export function TrendChart({
  title,
  description,
  data,
  format,
  /** Fix the y-axis top (e.g. 1 for a ratio) instead of deriving it. */
  domainMax,
  /** Rendered under the chart — say which direction is "better". */
  footnote,
}: {
  title: string;
  description?: ReactNode;
  data: TrendDatum[];
  format: (v: number) => string;
  domainMax?: number;
  footnote?: string;
}) {
  const [boxRef, width] = useElementWidth<HTMLDivElement>(560);
  const { ref: hoverRef, point, handlers } = useHoverPoint<HTMLDivElement>();

  const plotW = Math.max(80, width - M.left - M.right);
  const plotH = H - M.top - M.bottom;

  const { x, y, ticks, pts } = useMemo(() => {
    const max = domainMax ?? Math.max(1, ...data.map((d) => d.value));
    const t = niceTicks(max, 4);
    const top = domainMax ?? t[t.length - 1];
    const xs = linearScale([0, Math.max(1, data.length - 1)], [0, plotW]);
    const ys = linearScale([0, top], [plotH, 0]);
    return {
      x: xs,
      y: ys,
      ticks: domainMax !== undefined ? niceTicks(domainMax, 4) : t,
      pts: data.map((d, i) => [xs(i), ys(d.value)] as [number, number]),
    };
  }, [data, domainMax, plotW, plotH]);

  // Nearest index to the pointer. The hit layer spans the whole plot, so the
  // target is the full column height, not the 3px dot.
  const idx =
    point && data.length > 0
      ? Math.max(
          0,
          Math.min(data.length - 1, Math.round(x.invert(point.x - M.left))),
        )
      : null;
  const hit = idx === null ? null : data[idx];

  return (
    <div>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {description && (
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}

      {data.length === 0 ? (
        <div className="mt-2">
          <Empty>Not enough attempts yet to draw a trend.</Empty>
        </div>
      ) : (
        <div
          ref={(el) => {
            boxRef.current = el;
            hoverRef.current = el;
          }}
          className="relative mt-2 w-full"
          {...handlers}
        >
          <svg
            width={width}
            height={H}
            viewBox={`0 0 ${width} ${H}`}
            role="img"
            aria-label={title}
            // max-w-full only matters for the single frame before the
            // ResizeObserver reports: without it the fallback width can
            // briefly overflow a 390px column.
            className="block max-w-full"
          >
            <g transform={`translate(${M.left},${M.top})`}>
              {/* Grid + axis, recessive: they orient, they don't compete. */}
              {ticks.map((t) => (
                <g key={t}>
                  <line
                    x1={0}
                    x2={plotW}
                    y1={y(t)}
                    y2={y(t)}
                    className="stroke-border"
                    strokeOpacity={0.55}
                    strokeWidth={1}
                  />
                  <text
                    x={-7}
                    y={y(t)}
                    dy="0.32em"
                    textAnchor="end"
                    fontSize={9.5}
                    className="fill-muted-foreground"
                  >
                    {format(t)}
                  </text>
                </g>
              ))}

              {/* Thin mark. */}
              <path
                d={linePath(pts)}
                fill="none"
                stroke={SERIES}
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {/* Points only when they are countable; past that the line is
                  the mark and dots turn into noise. */}
              {data.length <= 40 &&
                pts.map(([px, py], i) => (
                  <circle key={i} cx={px} cy={py} r={2.1} fill={SERIES} />
                ))}

              {/* The one direct label: the latest value. */}
              {pts.length > 0 && (
                <text
                  x={pts[pts.length - 1][0] + 7}
                  y={pts[pts.length - 1][1]}
                  dy="0.32em"
                  fontSize={10.5}
                  fontWeight={700}
                  className="fill-foreground"
                >
                  {format(data[data.length - 1].value)}
                </text>
              )}

              {/* Crosshair. */}
              {idx !== null && (
                <g pointerEvents="none">
                  <line
                    x1={x(idx)}
                    x2={x(idx)}
                    y1={0}
                    y2={plotH}
                    className="stroke-foreground"
                    strokeOpacity={0.35}
                    strokeWidth={1}
                    strokeDasharray="3 3"
                  />
                  <circle
                    cx={x(idx)}
                    cy={y(data[idx].value)}
                    r={4}
                    fill={SERIES}
                    className="stroke-background"
                    strokeWidth={1.5}
                  />
                </g>
              )}

              {/* x-axis: first and last only. Selective labels, not a wall. */}
              <text
                x={0}
                y={plotH + 14}
                fontSize={9.5}
                className="fill-muted-foreground"
              >
                oldest
              </text>
              <text
                x={plotW}
                y={plotH + 14}
                textAnchor="end"
                fontSize={9.5}
                className="fill-muted-foreground"
              >
                latest
              </text>
            </g>
          </svg>

          {hit && point && (
            <ChartTooltip
              x={x(idx ?? 0) + M.left}
              y={y(hit.value) + M.top}
              containerWidth={width}
            >
              <TooltipTitle>{hit.label}</TooltipTitle>
              <TooltipRow label={title} value={format(hit.value)} />
              {hit.meta && (
                <div className="mt-0.5 text-[0.7rem] text-muted-foreground">
                  {hit.meta}
                </div>
              )}
            </ChartTooltip>
          )}
        </div>
      )}

      {footnote && (
        <p className="mt-1.5 text-[0.7rem] text-muted-foreground">{footnote}</p>
      )}
    </div>
  );
}
