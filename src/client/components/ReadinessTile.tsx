// =============================================================================
// ReadinessTile — one area of Today's readiness strip
// =============================================================================
// The per-signal numbers behind a verdict ("first-try pass 42% (n=12)") used to
// live only in a `title` tooltip, which a finger can never open. The tile is now
// a disclosure button: tap (or click, or Enter/Space) to show the signals inline,
// tap again to fold them away. The tooltip stays for a mouse, where hovering is
// still the quickest way to peek.

import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import {
  READINESS_VERDICT_LABEL,
  type ReadinessArea,
  type ReadinessVerdict,
} from '@/shared/today';
import { cn } from '@/lib/utils';

const VERDICT_TONE: Readonly<Record<ReadinessVerdict, string>> = {
  ready: 'text-emerald-400',
  close: 'text-amber-300',
  'not-yet': 'text-rose-300',
  'not-enough': 'text-muted-foreground',
};

/** The detail lines behind a verdict, in display order. Shared by tooltip and panel. */
export function readinessDetailLines(area: ReadinessArea): string[] {
  return [
    ...area.signals.map((s) => `${s.label}: ${s.value}${s.n ? ` (n=${s.n})` : ''}`),
    area.inLoop === false ? 'Not a round in your next interview.' : '',
  ].filter(Boolean);
}

export function ReadinessTile({ area, defaultOpen = false }: { area: ReadinessArea; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const lines = readinessDetailLines(area);
  const panelId = `readiness-${area.id}-detail`;
  const expandable = lines.length > 0;

  const head = (
    <>
      <span className="flex items-start justify-between gap-1">
        <span className="text-xs text-muted-foreground">{area.label}</span>
        {expandable &&
          (open ? (
            <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          ))}
      </span>
      <span className={cn('block text-sm font-semibold', VERDICT_TONE[area.verdict])}>
        {READINESS_VERDICT_LABEL[area.verdict]}
      </span>
      <span className="block truncate text-[11px] text-muted-foreground">{area.evidence}</span>
      <span className="mt-1 block text-[11px] text-foreground/80 pointer-coarse:text-xs pointer-fine:line-clamp-3">
        {area.hint}
      </span>
    </>
  );

  return (
    <div className={cn('rounded-lg border border-border', area.inLoop === false && 'opacity-60')}>
      {expandable ? (
        <button
          type="button"
          className="block w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-expanded={open}
          aria-controls={panelId}
          title={open ? undefined : lines.join('\n')}
          onClick={() => setOpen((v) => !v)}
        >
          {head}
        </button>
      ) : (
        <div className="px-3 py-2">{head}</div>
      )}
      {expandable && open && (
        <ul
          id={panelId}
          className="mx-3 mb-2 space-y-0.5 border-t border-border/60 pt-1.5 text-[11px] text-muted-foreground pointer-coarse:text-xs"
        >
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
