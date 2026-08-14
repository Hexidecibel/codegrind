import { type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { Code2, BarChart3, Zap, BookOpen, Settings } from 'lucide-react';
import { useAppHeight } from '@/client/hooks/useAppHeight';
import { cn } from '@/lib/utils';

function Tab({
  to,
  icon,
  label,
  end,
  /**
   * Where the text label starts showing. Five labelled tabs no longer fit a
   * `sm` header, and the gear is the one icon that needs no word — so Settings
   * waits for `md` while the four content tabs keep their existing threshold.
   */
  labelClass = 'hidden sm:inline',
}: {
  to: string;
  icon: ReactNode;
  label: string;
  end?: boolean;
  labelClass?: string;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      aria-label={label}
      title={label}
      className={({ isActive }) =>
        cn(
          // Below `sm` the label is hidden, so the text line-box no longer sets
          // the height — without min-h/min-w these collapse to a 40×28 target.
          'inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors sm:min-h-0 sm:min-w-0',
          isActive
            ? 'bg-secondary text-foreground'
            : 'text-muted-foreground hover:text-foreground',
        )
      }
    >
      {icon}
      {/* Icons only on phones — labelled tabs overflow a 390px header. */}
      <span className={labelClass}>{label}</span>
    </NavLink>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  useAppHeight();
  return (
    // Not h-screen: 100vh is the URL-bar-retracted height on mobile, so the
    // bottom of the app ends up clipped by `overflow-hidden`. Below `lg` we go
    // one better and track the visual viewport (`--app-height`), which is the
    // only thing that shrinks for the soft keyboard on iOS.
    <div className="flex h-[var(--app-height,100dvh)] flex-col overflow-hidden bg-background text-foreground lg:h-dvh">
      {/* `short:` = landscape phone with the keyboard up (see index.css): every
          vertical pixel is contested there, so the header tightens to ~40px. */}
      <header className="flex items-center gap-4 border-b border-border bg-card px-4 py-2.5 short:py-1">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground short:h-6 short:w-6">
            <Code2 className="h-4 w-4" />
          </div>
          <span className="text-base font-bold tracking-tight">codegrind</span>
          <span className="hidden text-xs text-muted-foreground sm:inline short:hidden">
            AI-coached interview prep
          </span>
        </div>
        <nav className="ml-auto flex items-center gap-1">
          <Tab to="/" icon={<Zap className="h-4 w-4" />} label="Grind" end />
          <Tab to="/manual" icon={<Code2 className="h-4 w-4" />} label="Manual" />
          {/* Route stays /progress so old bookmarks keep working; the label is
              what the page actually does now. */}
          <Tab to="/progress" icon={<BarChart3 className="h-4 w-4" />} label="Reflect" />
          <Tab to="/study" icon={<BookOpen className="h-4 w-4" />} label="Study" />
          {/* Last, and the only tab that is not a place you practice: it is
              where you change who writes the problems, which before this had no
              route at all once the first-run wizard stopped rendering. */}
          <Tab
            to="/settings"
            icon={<Settings className="h-4 w-4" />}
            label="Settings"
            labelClass="hidden md:inline"
          />
        </nav>
      </header>
      <main className="min-h-0 flex-1">{children}</main>
    </div>
  );
}
