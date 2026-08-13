// =============================================================================
// reflect/chart.ts — the single source of colour + geometry for Reflect
// =============================================================================
// Every colour below was **computed, not chosen**: validated with the dataviz
// skill's `validate_palette.js` against codegrind's real chart surface
// `--card: oklch(0.2 0.014 265)` = #13161d, in dark mode (this app is
// dark-only). Do not hand-pick hexes in components — import from here so there
// is exactly one place to change colour.
//
//   node scripts/validate_palette.js \
//     "#6d28d9,#8257e6,#9b7cf8,#b9a4fb,#d6cbfd" \
//     --mode dark --surface "#13161d" --ordinal        -> all pass
//   node scripts/validate_palette.js "#059669,#d97706,#e11d48,#c026d3" \
//     --mode dark --surface "#13161d"                  -> pass, CVD WARN 7.9ΔE protan
//
// Two rules fall out of those results and are load-bearing:
//
//  1. The difficulty set's CVD warning is only legal *with secondary
//     encoding*, so every difficulty mark keeps its text label. There is no
//     bare-swatch difficulty affordance anywhere in Reflect.
//  2. Topic state is ordinal (locked → available → practiced → tiered), so
//     it rides the one-hue ramp, never a categorical palette — and every mark
//     also carries an icon + label so state is never colour-alone.
//
// `expert` is fuchsia #c026d3 deliberately, not violet: #9333ea also passes,
// but it collides with the progress ramp's hue, which is reserved for progress
// magnitude. The pink variant #db2777 was tested and REJECTED — 6.5 ΔE against
// rose fails the normal-vision floor.
//
// Text always wears the text tokens (`foreground` / `muted-foreground`); a
// coloured mark *beside* a label is what carries series identity.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Difficulty } from '@/shared/types';

// -----------------------------------------------------------------------------
// Palette
// -----------------------------------------------------------------------------

/** The surface the palette was validated against (= the `--card` token). */
export const CHART_SURFACE = '#13161d';

/**
 * Progress ramp — ordinal, one hue. Dark → light == low → high.
 * Monotone lightness, ΔL ≥ 0.06 between neighbours, light end 2.55:1 on the
 * chart surface. Used by the skill tree fills and the activity heatmap.
 */
export const RAMP = ['#6d28d9', '#8257e6', '#9b7cf8', '#b9a4fb', '#d6cbfd'] as const;

/**
 * The single-series mark colour for line charts and ranked bars. It is the
 * mid-step of the same ramp, so the whole page reads as one system, and a lone
 * series never needs a legend box — the chart title names it.
 */
export const SERIES = RAMP[2];

/** Difficulty set. NEVER render one of these without its text label. */
export const DIFFICULTY_COLOR: Record<Difficulty, string> = {
  easy: '#059669',
  medium: '#d97706',
  hard: '#e11d48',
  expert: '#c026d3',
};

/**
 * The unlock gate on the display scale. Progress is a tier ladder of four
 * rungs, so one completed tier is a quarter of the bar — and completing the
 * easy tier (3 distinct hint-free easy solves) is exactly what opens a topic's
 * dependents. Keep in step with `curriculum.UNLOCK_TIER`.
 */
export const UNLOCK_GATE = 0.25;

/**
 * Bucket a 0..1 value onto the ramp. 0 lands on the darkest step, 1 on the
 * lightest, matching "dark → light == low → high".
 */
export function rampFor(t: number): string {
  if (!Number.isFinite(t)) return RAMP[0];
  const clamped = Math.min(1, Math.max(0, t));
  const i = Math.min(RAMP.length - 1, Math.floor(clamped * RAMP.length));
  return RAMP[i];
}

/**
 * Heatmap steps. A day with zero attempts is **not** a ramp step — it renders
 * on the muted surface, so "nothing happened" never reads as "a little
 * happened". The boundaries are absolute rather than quantile so the legend
 * means the same thing every week.
 */
export const ACTIVITY_BUCKETS = [1, 2, 3, 5, 8] as const; // one lower bound per ramp step

/** `null` == empty day: render it on the muted surface, not on the ramp. */
export function activityRamp(attempts: number): string | null {
  if (attempts <= 0) return null;
  let i = 0;
  for (let b = 1; b < ACTIVITY_BUCKETS.length && b < RAMP.length; b++) {
    if (attempts >= ACTIVITY_BUCKETS[b]) i = b;
  }
  return RAMP[i];
}

// -----------------------------------------------------------------------------
// Scales & path helpers
// -----------------------------------------------------------------------------

export interface LinearScale {
  (value: number): number;
  domain: readonly [number, number];
  range: readonly [number, number];
  /** Pixels → domain. Used to turn a pointer position into a data value. */
  invert(px: number): number;
}

/** A minimal d3-style linear scale. Degenerate domains map to the range start. */
export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  const scale = ((value: number) =>
    span === 0 ? r0 : r0 + ((value - d0) / span) * (r1 - r0)) as LinearScale;
  scale.domain = domain;
  scale.range = range;
  scale.invert = (px: number) =>
    r1 - r0 === 0 ? d0 : d0 + ((px - r0) / (r1 - r0)) * span;
  return scale;
}

/** Round `max` up to a friendly axis top (1/2/5 × 10ⁿ steps). */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step =
    (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = 0; v <= max + step / 2; v += step) out.push(Number(v.toFixed(6)));
  if (out.length < 2) out.push(step);
  return out;
}

/** Polyline `d` for a series of already-scaled points. */
export function linePath(points: readonly (readonly [number, number])[]): string {
  if (points.length === 0) return '';
  return points
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
    .join(' ');
}

/** Cubic edge between two node anchors, flowing left → right. */
export function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

// -----------------------------------------------------------------------------
// Formatting
// -----------------------------------------------------------------------------

export const pct = (t: number): string => `${Math.round((t ?? 0) * 100)}%`;

export const oneDecimal = (n: number): string =>
  Number.isInteger(n) ? String(n) : n.toFixed(1);

/** `2026-08-11` → `Aug 11`, without dragging the string through a Date in UTC. */
export function dayLabel(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return isoDate;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

// -----------------------------------------------------------------------------
// Hooks — the hover layer every chart on this page shares
// -----------------------------------------------------------------------------

/**
 * Track a container's pixel width so charts can be drawn at 1:1 device pixels
 * instead of being scaled by a viewBox. That matters here: a scaled viewBox
 * makes pointer-position → data-value maths lie, and every chart on this page
 * has a crosshair.
 */
export function useElementWidth<T extends HTMLElement>(fallback = 640) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export interface HoverPoint {
  x: number;
  y: number;
}

/**
 * Pointer position in container-local pixels, plus the handlers to wire onto
 * the hit layer. Works for mouse, pen and touch (pointer events), and clears
 * on leave/cancel so a tooltip can never get stranded on a phone.
 */
export function useHoverPoint<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [point, setPoint] = useState<HoverPoint | null>(null);

  const onPointerMove = useCallback((e: ReactPointerEvent<Element>) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setPoint({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, []);

  const clear = useCallback(() => setPoint(null), []);

  const handlers = useMemo(
    () => ({
      onPointerMove,
      onPointerDown: onPointerMove,
      onPointerLeave: clear,
      onPointerCancel: clear,
    }),
    [onPointerMove, clear],
  );

  return { ref, point, handlers, clear } as const;
}
