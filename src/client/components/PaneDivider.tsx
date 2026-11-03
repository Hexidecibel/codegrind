// =============================================================================
// PaneDivider — a finger-sized handle between the problem and the editor
// =============================================================================
// Tablets only (SolveSurface decides). `axis="y"` sits between a stacked
// problem and editor and drags up/down; `axis="x"` sits between side-by-side
// panes and drags left/right. The visible bar is slim; the hit area is 44px,
// spilling over both neighbours, so it can be grabbed without precision.
//
// Pointer events with capture cover touch, pen and mouse in one path, and
// `touch-action: none` stops the drag from scrolling the page instead. It is a
// focusable role="separator" too, so the arrow keys move it.

import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import { splitFromKey, splitFromPointer, type SplitBounds } from '@/client/hooks/useSplitPane';

export function PaneDivider({
  axis,
  value,
  bounds,
  onChange,
  containerRef,
  controls,
  label = 'Resize the problem and code panes',
}: {
  axis: 'x' | 'y';
  /** The problem pane's share, in percent. */
  value: number;
  bounds: SplitBounds;
  /** `persist` is true when the drag or key press is finished. */
  onChange: (value: number, persist?: boolean) => void;
  /** The element the percentage is measured against. */
  containerRef: RefObject<HTMLElement | null>;
  controls?: string;
  label?: string;
}) {
  const dragging = useRef(false);
  const last = useRef(value);

  const fromEvent = (e: ReactPointerEvent) => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return NaN;
    return axis === 'y'
      ? splitFromPointer(e.clientY, box.top, box.height)
      : splitFromPointer(e.clientX, box.left, box.width);
  };

  return (
    <div
      role="separator"
      aria-orientation={axis === 'y' ? 'horizontal' : 'vertical'}
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={Math.round(value)}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      tabIndex={0}
      className={cn(
        'group relative z-20 flex shrink-0 touch-none select-none items-center justify-center bg-border/60 outline-none focus-visible:bg-primary/40',
        axis === 'y' ? 'h-3 w-full cursor-row-resize' : 'h-full w-3 cursor-col-resize',
      )}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        dragging.current = true;
        last.current = value;
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (!dragging.current) return;
        const v = fromEvent(e);
        if (Number.isFinite(v)) {
          last.current = v;
          onChange(v);
        }
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
        onChange(last.current, true);
      }}
      onPointerCancel={() => {
        if (!dragging.current) return;
        dragging.current = false;
        onChange(last.current, true);
      }}
      onKeyDown={(e) => {
        const v = splitFromKey(e.key, value, bounds);
        if (v === null) return;
        e.preventDefault();
        last.current = v;
        onChange(v, true);
      }}
    >
      {/* The 44px hit area: transparent, centred on the bar, over both panes. */}
      <span
        aria-hidden
        className={cn('absolute', axis === 'y' ? 'inset-x-0 -inset-y-4' : 'inset-y-0 -inset-x-4')}
      />
      {/* The grip. */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none rounded-full bg-muted-foreground/50 transition-colors group-hover:bg-foreground/70 group-active:bg-primary',
          axis === 'y' ? 'h-1 w-10' : 'h-10 w-1',
        )}
      />
    </div>
  );
}
