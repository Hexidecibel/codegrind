import { type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import {
  Code2,
  BarChart3,
  Zap,
  BookOpen,
  Settings,
  CircleQuestionMark,
  MessagesSquare,
} from 'lucide-react';
import { useAppHeight } from '@/client/hooks/useAppHeight';
import { cn } from '@/lib/utils';
import { HELP_ROUTE } from '@/client/lib/help-content';

function Tab({
  to,
  icon,
  label,
  end,
  /**
   * Where the text label starts showing. See the header-budget note on Layout:
   * the five content tabs label from `sm`; the gear waits for `lg`.
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

/**
 * THE HEADER IS A FIXED-WIDTH BUDGET, and Mock spent the last of it. It is worth
 * writing down what pays for what, because the failure mode is silent — the row
 * simply overflows on a phone nobody tested on.
 *
 * The row holds: a 28px logo mark, the `codegrind` wordmark (~85px), a tagline
 * (~145px), six nav tabs, and the Help `?`. Each icon-only tab is a 44px touch
 * target, each labelled tab roughly 76-96px, the `?` 36px. With 32px of page
 * padding:
 *
 *   < sm   6 icons, no gap (264) + ? (36) + mark (28) + gap (16) + padding (32) = 376 of 390
 *   sm     5 labels + gear (499) + ? (40) + mark (28) + …                        = 615 of 640
 *   md     the above plus the wordmark (93)                                       = 708 of 768
 *   lg     the above plus the gear's label (50) and the tagline (153)             = 911 of 1024
 *
 * What gave, all of it decoration rather than a destination: Help left the tab
 * row for a small `?` beside the gear (the /help route is unchanged); the tabs
 * lose their 4px gaps on a phone; the wordmark goes screen-reader-only until
 * `md`; the gear is unlabelled until `lg`. An EIGHTH destination has no room
 * left to take from — that one needs an overflow menu, not another squeeze.
 */
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
          {/* Not `hidden`: the wordmark stays in the accessibility tree and in
              the document at every width, it just stops taking layout space on a
              phone. `sr-only` is absolutely positioned, so it is not a flex item
              and contributes no gap either. */}
          <span className="sr-only text-base font-bold tracking-tight md:not-sr-only md:inline">
            codegrind
          </span>
          {/* `lg` only: below it the five labels and the wordmark have already
              spent the row. */}
          <span className="hidden text-xs text-muted-foreground lg:inline short:hidden">
            AI-coached interview prep
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <nav className="flex items-center gap-0 sm:gap-1">
            <Tab to="/" icon={<Zap className="h-4 w-4" />} label="Grind" end />
            <Tab to="/manual" icon={<Code2 className="h-4 w-4" />} label="Manual" />
            {/* Mock interviews: a chat with an interviewer, graded at a level. */}
            <Tab to="/mock" icon={<MessagesSquare className="h-4 w-4" />} label="Mock" />
            {/* Route stays /progress so old bookmarks keep working; the label is
                what the page actually does now. */}
            <Tab to="/progress" icon={<BarChart3 className="h-4 w-4" />} label="Reflect" />
            <Tab to="/study" icon={<BookOpen className="h-4 w-4" />} label="Study" />
            {/* Last, and the only tab that is not a place you practice: it is
                where you change who writes the problems. */}
            <Tab
              to="/settings"
              icon={<Settings className="h-4 w-4" />}
              label="Settings"
              labelClass="hidden lg:inline"
            />
          </nav>
          {/* The manual, as a small `?` beside the gear rather than a tab — it
              is the one destination whose glyph is universal, and taking it out
              of the tab row is what paid for Mock. Same /help route as before. */}
          <NavLink
            to={HELP_ROUTE}
            aria-label="Help"
            title="Help"
            className={({ isActive }) =>
              cn(
                'inline-flex min-h-11 w-9 items-center justify-center rounded-full transition-colors sm:min-h-0 sm:h-8 sm:w-8',
                isActive ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
              )
            }
          >
            <CircleQuestionMark className="h-4 w-4" />
          </NavLink>
        </div>
      </header>
      <main className="min-h-0 flex-1">{children}</main>
    </div>
  );
}
