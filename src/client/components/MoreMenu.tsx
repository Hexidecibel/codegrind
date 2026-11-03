// =============================================================================
// MoreMenu — Settings and Help, behind one "More" button
// =============================================================================
// Neither is a place you practice, so neither needs a tab. A tap opens the
// popover (no hover); choosing a link closes it.

import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { CircleQuestionMark, Ellipsis, Settings } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/client/components/ui/popover';
import { HELP_ROUTE } from '@/client/lib/help-content';
import { cn } from '@/lib/utils';

export const MORE_ITEMS = [
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: HELP_ROUTE, label: 'Help', icon: CircleQuestionMark },
] as const;

export function MoreMenu({ labelClass = 'hidden md:inline' }: { labelClass?: string }) {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const active = MORE_ITEMS.some((i) => pathname === i.to);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="More"
        title="More"
        className={cn(
          'inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors sm:pointer-fine:min-h-0 sm:pointer-fine:min-w-0 short:min-h-0 short:min-w-0',
          active || open ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Ellipsis className="h-4 w-4" />
        <span className={labelClass}>More</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-48 p-1">
        <ul>
          {MORE_ITEMS.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  cn(
                    'flex min-h-11 items-center gap-2 rounded px-3 text-sm transition-colors hover:bg-secondary sm:pointer-fine:min-h-9',
                    isActive && 'bg-secondary font-medium',
                  )
                }
              >
                <Icon className="h-4 w-4 text-muted-foreground" /> {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
