// =============================================================================
// reflect/primitives — the small shared pieces every Reflect section uses
// =============================================================================
// Three things live here because they are *rules*, not decoration, and having
// them in one module is what keeps the page reading as one system:
//
//   Section        — heading + the "show data" toggle. Every numeric section
//                    can be read as a plain <table>, not just as a picture.
//   ChartTooltip   — the hover layer. Every chart on this page has one.
//   DifficultyTag  — the difficulty triad always ships with its text label
//                    (the palette passed with a CVD warning, which is only
//                    legal alongside a secondary encoding).

import { useId, useState, type ReactNode } from 'react';
import { Table2 } from 'lucide-react';
import type { Difficulty } from '@/shared/types';
import { DIFFICULTY_COLOR } from './chart';
import { cn } from '@/lib/utils';

// -----------------------------------------------------------------------------

export function Section({
  title,
  description,
  aside,
  table,
  className,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** Rendered top-right of the heading row, before the show-data toggle. */
  aside?: ReactNode;
  /** When given, a "Show data" toggle reveals this below the chart. */
  table?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <section className={cn('space-y-3', className)}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-lg font-bold">{title}</h2>
        {description && (
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">{description}</p>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {aside}
          {table && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls={panelId}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:min-h-8"
            >
              <Table2 className="h-3.5 w-3.5" />
              {open ? 'Hide data' : 'Show data'}
            </button>
          )}
        </div>
      </div>
      {children}
      {table && open && (
        <div id={panelId} className="overflow-x-auto rounded-lg border border-border">
          {table}
        </div>
      )}
    </section>
  );
}

/**
 * A plain, unstyled-by-default data table for the "show data" panels. Nothing
 * clever: this is the escape hatch for anyone who would rather read the
 * numbers than the picture, and for screen readers.
 */
export function DataTable({
  head,
  children,
}: {
  head: readonly string[];
  children: ReactNode;
}) {
  return (
    <table className="w-full border-collapse text-left text-xs">
      <thead>
        <tr className="border-b border-border bg-muted/30">
          {head.map((h, i) => (
            <th
              key={h}
              scope="col"
              className={cn(
                'whitespace-nowrap px-3 py-2 font-semibold text-muted-foreground',
                i > 0 && 'text-right',
              )}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="[&_td]:whitespace-nowrap [&_td]:px-3 [&_td]:py-1.5 [&_td:not(:first-child)]:text-right [&_td:not(:first-child)]:tabular-nums [&_tr]:border-b [&_tr]:border-border/50 [&_tr:last-child]:border-0">
        {children}
      </tbody>
    </table>
  );
}

// -----------------------------------------------------------------------------

/**
 * Tooltip anchored at container-local pixel coordinates. The caller owns a
 * `relative` box; this floats above the anchor and clamps itself inside.
 */
export function ChartTooltip({
  x,
  y,
  containerWidth,
  children,
}: {
  x: number;
  y: number;
  containerWidth: number;
  children: ReactNode;
}) {
  // Clamp the *anchor*, not the box, so the arrowless tip still points near
  // the mark it describes when you hover the far edge of a narrow phone.
  const left = Math.min(Math.max(x, 78), Math.max(containerWidth - 78, 78));
  // Near the top of the plot there is no room above the mark, so flip below
  // rather than letting the tip escape the card and cover the heading.
  const below = y < 84;
  return (
    <div
      role="tooltip"
      className={cn(
        'pointer-events-none absolute z-20 w-max max-w-[15rem] -translate-x-1/2 rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-lg',
        below ? 'translate-y-0' : '-translate-y-full',
      )}
      style={{ left, top: below ? y + 16 : y - 10 }}
    >
      {children}
    </div>
  );
}

/** Title line inside a tooltip. */
export function TooltipTitle({ children }: { children: ReactNode }) {
  return <div className="mb-0.5 font-semibold text-foreground">{children}</div>;
}

/** `label · value` row inside a tooltip. Value is tabular so rows line up. */
export function TooltipRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  );
}

// -----------------------------------------------------------------------------

/**
 * Difficulty always renders as **coloured mark + text label**. The triad
 * validated with a 7.9 ΔE protan warning, which is only acceptable with a
 * second channel — so the label is not optional and there is deliberately no
 * "dot only" variant of this component.
 */
export function DifficultyTag({
  difficulty,
  className,
}: {
  difficulty: Difficulty;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs font-medium capitalize text-foreground',
        className,
      )}
    >
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: DIFFICULTY_COLOR[difficulty] }}
      />
      {difficulty}
    </span>
  );
}

/** An empty-state line that keeps a section's box from collapsing. */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
