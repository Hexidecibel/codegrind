// =============================================================================
// BottomTabBar — the phone's navigation, where a thumb can reach it
// =============================================================================
// On a phone the header is hidden (`phone:hidden` in Layout) and this takes
// over: five labelled tabs along the bottom edge, 56px tall, above the home
// indicator. Everything else is `hidden phone:flex`, so an iPad or a desktop
// never renders it visibly and their layout is untouched.
//
// Rendered AFTER <main> on purpose: Layout.test.tsx reads the first <nav> as the
// header's tab row.
//
// More opens a bottom sheet rather than a popover: Mock, Settings, Help, and a
// quiet "On iPad" group for the two coding places, so they are still reachable
// without pretending a phone is a good place to write code.

import { useEffect, useRef, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import {
  BarChart3,
  BookOpen,
  CircleQuestionMark,
  Code2,
  Dumbbell,
  Ellipsis,
  Home,
  ListChecks,
  MessagesSquare,
  Settings,
  Tablet,
} from 'lucide-react';
import { useVisualViewportHeight } from '@/client/hooks/useMediaQuery';
import { HELP_ROUTE } from '@/client/lib/help-content';
import { cn } from '@/lib/utils';

type Icon = ComponentType<{ className?: string }>;

export interface PhoneTab {
  to: string;
  label: string;
  icon: Icon;
  /** Other paths this tab lights up on. */
  alsoActiveOn?: string[];
}

export const PHONE_TABS: readonly PhoneTab[] = [
  { to: '/home', label: 'Home', icon: Home, alsoActiveOn: ['/today'] },
  { to: '/practice', label: 'Drills', icon: Dumbbell, alsoActiveOn: ['/recognize', '/envelope', '/concept', '/stories'] },
  { to: '/study', label: 'Learn', icon: BookOpen, alsoActiveOn: ['/patterns', '/concepts'] },
  { to: '/progress', label: 'Progress', icon: BarChart3 },
];

export interface MoreLink {
  to: string;
  label: string;
  icon: Icon;
}

export const PHONE_MORE: readonly MoreLink[] = [
  { to: '/mock', label: 'Mock', icon: MessagesSquare },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: HELP_ROUTE, label: 'Help', icon: CircleQuestionMark },
];

/** Coding places: reachable from a phone, but labelled as the iPad's. */
export const PHONE_MORE_IPAD: readonly MoreLink[] = [
  { to: '/grind', label: 'Daily grind', icon: Code2 },
  { to: '/manual', label: 'Pick a problem', icon: ListChecks },
];

const owns = (pathname: string, p: string) => pathname === p || pathname.startsWith(`${p}/`);

/** Which tab is lit for a path: one of PHONE_TABS' `to`, 'more', or null. */
export function activeTab(pathname: string): string | null {
  for (const t of PHONE_TABS) {
    if (owns(pathname, t.to) || (t.alsoActiveOn ?? []).some((p) => owns(pathname, p))) return t.to;
  }
  if ([...PHONE_MORE, ...PHONE_MORE_IPAD].some((l) => owns(pathname, l.to))) return 'more';
  return null;
}

/**
 * Is the soft keyboard up? The visual viewport has shrunk well below the
 * tallest it has been at this width. Comparing with the TALLEST seen rather than
 * `innerHeight` covers both platforms: iOS shrinks only the visual viewport, and
 * Android with `interactive-widget=resizes-content` shrinks the layout viewport
 * (and innerHeight) with it.
 */
export function keyboardUp(height: number | null, tallest: number | null): boolean {
  if (height === null || tallest === null) return false;
  return height < 0.75 * tallest;
}

function useKeyboardUp(): boolean {
  const height = useVisualViewportHeight();
  const tallest = useRef<{ width: number; height: number } | null>(null);
  if (typeof window !== 'undefined' && height !== null) {
    const width = window.innerWidth;
    // Rotation is a new baseline, not a keyboard.
    if (!tallest.current || tallest.current.width !== width || height > tallest.current.height) {
      tallest.current = { width, height };
    }
  }
  return keyboardUp(height, tallest.current?.height ?? null);
}

const TAB_CLASS =
  'flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors';

function TabLink({ tab, active }: { tab: PhoneTab; active: boolean }) {
  const Icon = tab.icon;
  return (
    <Link
      to={tab.to}
      aria-current={active ? 'page' : undefined}
      className={cn(TAB_CLASS, active ? 'text-foreground' : 'text-muted-foreground')}
    >
      <Icon className={cn('h-5 w-5', active && 'text-primary')} />
      <span>{tab.label}</span>
    </Link>
  );
}

function SheetLink({ link, muted, onPick }: { link: MoreLink; muted?: boolean; onPick: () => void }) {
  const Icon = link.icon;
  return (
    <Link
      to={link.to}
      onClick={onPick}
      className={cn(
        'flex min-h-12 items-center gap-3 rounded-lg px-3 text-[15px] transition-colors active:bg-secondary',
        muted ? 'text-muted-foreground' : 'text-foreground',
      )}
    >
      <Icon className="h-5 w-5 text-muted-foreground" />
      {link.label}
    </Link>
  );
}

function MoreSheet({ onClose }: { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 animate-in fade-in-0"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="More"
        tabIndex={-1}
        className="relative rounded-t-2xl border-t border-border bg-card px-3 pt-2 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] outline-none animate-in slide-in-from-bottom-8"
      >
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-muted-foreground/30" />
        <nav aria-label="More">
          {PHONE_MORE.map((l) => (
            <SheetLink key={l.to} link={l} onPick={onClose} />
          ))}
          <p className="mt-3 flex items-center gap-1.5 px-3 pb-1 text-xs text-muted-foreground">
            <Tablet className="h-3.5 w-3.5" /> On iPad
          </p>
          {PHONE_MORE_IPAD.map((l) => (
            <SheetLink key={l.to} link={l} muted onPick={onClose} />
          ))}
        </nav>
      </div>
    </div>,
    document.body,
  );
}

export function BottomTabBar() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const typing = useKeyboardUp();
  const lit = activeTab(pathname);

  // Leaving the page by any route closes the sheet.
  useEffect(() => setOpen(false), [pathname]);

  return (
    <>
      <nav
        aria-label="Tabs"
        className={cn(
          // Hidden everywhere but a phone, and on a phone while typing: the
          // keyboard already took the bottom of the screen.
          typing ? 'hidden' : 'hidden phone:flex',
          'shrink-0 border-t border-border bg-card pb-[env(safe-area-inset-bottom)]',
        )}
      >
        {PHONE_TABS.map((t) => (
          <TabLink key={t.to} tab={t} active={lit === t.to} />
        ))}
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className={cn(TAB_CLASS, lit === 'more' || open ? 'text-foreground' : 'text-muted-foreground')}
        >
          <Ellipsis className={cn('h-5 w-5', (lit === 'more' || open) && 'text-primary')} />
          <span>More</span>
        </button>
      </nav>
      {open && <MoreSheet onClose={() => setOpen(false)} />}
    </>
  );
}
