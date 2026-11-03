// =============================================================================
// WarmupChecklist — the warm-up's piles as a quiet checklist under the step
// =============================================================================
// The step card's one Start drives the warm-up; these rows only say what is in
// it and how far along each pile is: a status dot, the label, one count, and a
// quiet chevron (each row still opens its own page). No buttons here, so the
// screen keeps exactly one primary action.

import { Link } from 'react-router-dom';
import { Check, ChevronRight } from 'lucide-react';
import type { TodayState } from '@/shared/today';
import { envelopeLeftLabel } from '@/shared/envelope';
import { cn } from '@/lib/utils';

export type ChecklistTone = 'todo' | 'done' | 'optional' | 'recommended';

export interface ChecklistItem {
  key: string;
  label: string;
  count: string;
  tone: ChecklistTone;
  href: string;
}

const WARM = 'from=today&step=warmup';

type WarmupInput = Pick<TodayState, 'envelope' | 'recognize' | 'refresh' | 'patternRecallDue'> & {
  warmupDue?: TodayState['warmupDue'];
};

/** The warm-up's rows, in the order the Start link serves them. Pure. */
export function warmupItems(state: WarmupInput): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const cards = state.warmupDue?.cards ?? 0;
  const reviews = state.warmupDue?.reviews ?? 0;
  if (cards > 0) items.push({ key: 'cards', label: 'Drill cards', count: `${cards} due`, tone: 'todo', href: `/mock?${WARM}#cards` });
  const e = state.envelope;
  if (e && !(e.daily === 0 && e.due === 0 && e.doneToday === 0)) {
    items.push(
      e.done
        ? { key: 'envelope', label: 'Envelope', count: `${e.correctToday}/${e.doneToday} right`, tone: 'done', href: '/envelope' }
        : { key: 'envelope', label: 'Envelope', count: envelopeLeftLabel(e), tone: 'todo', href: e.href },
    );
  }
  if (state.patternRecallDue > 0)
    items.push({ key: 'recall', label: 'Pattern recall', count: `${state.patternRecallDue} due`, tone: 'todo', href: `/patterns?${WARM}&due=1` });
  if (reviews > 0) items.push({ key: 'reviews', label: 'Review problems', count: `${reviews} due`, tone: 'todo', href: `/grind?${WARM}` });
  const r = state.recognize;
  if (r && !state.refresh.on) {
    items.push({
      key: 'recognize',
      label: 'Recognize ×5',
      count: r.done ? `${r.doneToday} today` : r.recommended ? 'recommended' : 'optional',
      tone: r.done ? 'done' : r.recommended ? 'recommended' : 'optional',
      href: r.href,
    });
  }
  return items;
}

function Dot({ tone }: { tone: ChecklistTone }) {
  if (tone === 'done')
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400" aria-hidden>
        <Check className="h-3 w-3" />
      </span>
    );
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>
      <span
        className={cn(
          'h-2 w-2 rounded-full',
          tone === 'todo' && 'bg-primary',
          tone === 'recommended' && 'ring-2 ring-primary',
          tone === 'optional' && 'ring-1 ring-muted-foreground/60',
        )}
      />
    </span>
  );
}

export function WarmupChecklist({ items, className }: { items: readonly ChecklistItem[]; className?: string }) {
  if (!items.length) return null;
  return (
    <ul aria-label="In the warm-up" className={cn('-mx-1', className)}>
      {items.map((it) => (
        <li key={it.key}>
          <Link
            to={it.href}
            className="group flex min-h-11 items-center gap-3 rounded-md px-1 text-sm transition-colors hover:bg-secondary/50 sm:pointer-fine:min-h-9"
          >
            <Dot tone={it.tone} />
            <span className={cn('min-w-0 flex-1 truncate', it.tone === 'done' && 'text-muted-foreground')}>{it.label}</span>
            <span
              className={cn(
                'shrink-0 text-xs tabular-nums',
                it.tone === 'done' ? 'text-emerald-400' : it.tone === 'recommended' ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              {it.count}
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}
