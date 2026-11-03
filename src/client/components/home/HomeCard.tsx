// =============================================================================
// HomeCard — the one card every Home section uses
// =============================================================================
// Same padding, radius, border and heading on every card, so the page reads as
// one system: a small section title (icon + label, optional right-hand aside),
// then the content. Three type levels only: this title, a value, a muted caption.

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export const CARD = 'rounded-xl border border-border bg-card p-4 sm:p-5';

export function HomeCard({
  title,
  icon: Icon,
  aside,
  children,
  className,
  label,
}: {
  title: ReactNode;
  icon: LucideIcon;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  /** aria-label for the section; defaults to a string title. */
  label?: string;
}) {
  return (
    <section aria-label={label ?? (typeof title === 'string' ? title : undefined)} className={cn(CARD, 'flex flex-col gap-4', className)}>
      <div className="flex items-center gap-2">
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-muted-foreground">
          <Icon className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate">{title}</span>
        </h2>
        {aside && <div className="ml-auto shrink-0 text-sm text-muted-foreground">{aside}</div>}
      </div>
      {children}
    </section>
  );
}
