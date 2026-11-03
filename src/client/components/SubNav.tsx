// =============================================================================
// SubNav — the Practice / Learn link strip under the header
// =============================================================================
// Five tabs now stand for more places than five. Each group's places keep their
// own routes (bookmarks, today-flow deep links); this strip shows the siblings
// of wherever you are, so nothing is more than one tap away. Hidden in the
// `short:` landscape-keyboard budget, where every vertical pixel is the editor's.

import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';

export interface SubNavItem {
  to: string;
  label: string;
  /** Other paths that light this item up (Drills owns each drill's own page). */
  alsoActiveOn?: string[];
  /** Match `to` exactly, not as a prefix (/study vs /study/…). */
  end?: boolean;
}

export const PRACTICE_SUBNAV: readonly SubNavItem[] = [
  { to: '/grind', label: 'Daily grind' },
  { to: '/manual', label: 'Pick a problem' },
  { to: '/practice', label: 'Drills', alsoActiveOn: ['/recognize', '/envelope', '/concept', '/stories'] },
];

export const LEARN_SUBNAV: readonly SubNavItem[] = [
  { to: '/study', label: 'Lessons' },
  { to: '/patterns', label: 'Pattern shapes' },
  { to: '/concepts', label: 'Concepts' },
];

const owns = (pathname: string, p: string) => pathname === p || pathname.startsWith(`${p}/`);

export function itemActive(item: SubNavItem, pathname: string): boolean {
  return (item.end ? pathname === item.to : owns(pathname, item.to)) || (item.alsoActiveOn ?? []).some((p) => owns(pathname, p));
}

/** Every path a group owns, for the top tab's `alsoActiveOn`. */
export function groupPaths(items: readonly SubNavItem[]): string[] {
  return items.flatMap((i) => [i.to, ...(i.alsoActiveOn ?? [])]);
}

/** Which strip a path shows, if any. */
export function subNavFor(pathname: string): readonly SubNavItem[] | null {
  if (PRACTICE_SUBNAV.some((i) => itemActive(i, pathname))) return PRACTICE_SUBNAV;
  if (LEARN_SUBNAV.some((i) => itemActive(i, pathname))) return LEARN_SUBNAV;
  return null;
}

export function SubNav() {
  const { pathname } = useLocation();
  const items = subNavFor(pathname);
  if (!items) return null;
  return (
    // Practice's strip is all coding places plus Drills; on a phone the tab bar's
    // Drills tab IS that page, so the strip would only offer the iPad's places.
    <nav
      aria-label="Section"
      className={cn(
        'flex gap-1 overflow-x-auto border-b border-border bg-card/60 px-4 short:hidden',
        items === PRACTICE_SUBNAV && 'phone:hidden',
      )}
    >
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          aria-current={itemActive(item, pathname) ? 'page' : undefined}
          className={cn(
              'inline-flex min-h-11 shrink-0 items-center border-b-2 px-3 text-sm transition-colors sm:pointer-fine:min-h-9',
            itemActive(item, pathname)
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
