// =============================================================================
// LeverLine — the one readiness area to push, plus a compact readiness row
// =============================================================================
// The lowest verdict's hint as one sentence and a Start link. The four tiles
// shrink to a row of dots; one tap opens the full tiles (ReadinessTile), so the
// detail is never hover-only.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronDown, ChevronUp, Gauge } from 'lucide-react';
import { READINESS_VERDICT_LABEL, type ReadinessArea, type ReadinessVerdict } from '@/shared/today';
import { ReadinessTile } from '@/client/components/ReadinessTile';
import { Button } from '@/client/components/ui/button';
import { cn } from '@/lib/utils';
import { HomeCard } from './HomeCard';

/** Lower = push here first. */
const RANK: Readonly<Record<ReadinessVerdict, number>> = { 'not-yet': 0, 'not-enough': 1, close: 2, ready: 3 };

const DOT: Readonly<Record<ReadinessVerdict, string>> = {
  ready: 'bg-emerald-400',
  close: 'bg-amber-300',
  'not-yet': 'bg-rose-400',
  'not-enough': 'bg-muted-foreground/40',
};

const AREA_HREF: Readonly<Record<ReadinessArea['id'], string>> = {
  algos: '/grind',
  'system-design': '/mock?kind=system-design',
  behavioral: '/mock?kind=behavioral',
  coding: '/mock?kind=coding',
};

/** The area to push: lowest verdict, skipping rounds not in the next loop; ties keep order. */
export function leverArea(areas: readonly ReadinessArea[]): ReadinessArea | null {
  const pool = areas.filter((a) => a.inLoop !== false && a.verdict !== 'ready');
  if (!pool.length) return null;
  return [...pool].sort((a, b) => RANK[a.verdict] - RANK[b.verdict])[0];
}

export function leverHref(area: ReadinessArea): string {
  return AREA_HREF[area.id] ?? '/grind';
}

export function LeverLine({ areas, defaultOpen = false }: { areas: readonly ReadinessArea[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const lever = leverArea(areas);
  if (!areas.length) return null;
  return (
    <HomeCard title="Readiness" icon={Gauge}>
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          {lever ? (
            <>
              <p className="font-semibold">{lever.label}</p>
              <p className="text-sm text-muted-foreground">{lever.hint}</p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Every area reads ready. Keep it warm.</p>
          )}
        </div>
        {lever && (
          <Button asChild variant="secondary" className="gap-1.5">
            <Link to={leverHref(lever)}>
              Work on it <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        )}
      </div>
      <div className="space-y-3 border-t border-border pt-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="readiness-tiles"
          onClick={() => setOpen((v) => !v)}
          className="flex min-h-11 w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-md text-left text-xs text-muted-foreground transition-colors hover:text-foreground sm:pointer-fine:min-h-8"
        >
          {areas.map((a) => (
            <span key={a.id} className={cn('inline-flex items-center gap-1.5', a.inLoop === false && 'opacity-60')}>
              <span className={cn('h-2.5 w-2.5 rounded-full', DOT[a.verdict])} aria-hidden />
              {a.label} <span className="sr-only">{READINESS_VERDICT_LABEL[a.verdict]}</span>
            </span>
          ))}
          <span className="ml-auto inline-flex items-center gap-0.5">
            {open ? 'Hide' : 'Details'}
            {open ? <ChevronUp className="h-3.5 w-3.5" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
          </span>
        </button>
        {open && (
          <div id="readiness-tiles" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {areas.map((a) => (
              <ReadinessTile key={a.id} area={a} />
            ))}
          </div>
        )}
      </div>
    </HomeCard>
  );
}
