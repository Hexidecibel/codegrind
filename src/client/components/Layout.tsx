import { type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import {
  Code2,
  BarChart3,
  Zap,
  BookOpen,
  Settings,
  CircleQuestionMark,
} from 'lucide-react';
import { useAppHeight } from '@/client/hooks/useAppHeight';
import { cn } from '@/lib/utils';

function Tab({
  to,
  icon,
  label,
  end,
  /**
   * Where the text label starts showing. See the header-budget note on Layout:
   * the four content tabs label from `sm`, while the two utility tabs (the gear
   * and the question mark — the two glyphs that need no word) wait for `md`.
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
 * THE HEADER IS A FIXED-WIDTH BUDGET, and the sixth tab spends most of what was
 * left. It is worth writing down what pays for what, because the failure mode is
 * silent — the row simply overflows on a phone nobody tested on.
 *
 * The row holds: a 28px logo mark, the `codegrind` wordmark (~85px), a tagline
 * (~145px), and the nav. Each icon-only tab is a 44px touch target; each
 * labelled tab is roughly 76-96px. With 32px of page padding that is:
 *
 *   < sm   6 icons (284) + mark (28) + gaps (16) + padding (32)  = 360 of 390
 *   sm     4 labels + 2 icons (458) + mark & wordmark (121) + …  = 627 of 640
 *   md     6 labels (542) + mark & wordmark (121) + …            = 711 of 768
 *   lg     the above plus the tagline (153)                      = 864 of 1024
 *
 * Two things had to give to make that work, and both give up decoration rather
 * than a destination: the wordmark goes screen-reader-only below `sm`, and the
 * tagline waits for `lg` instead of `sm`. Adding a SEVENTH tab has no room left
 * to take from — that one needs an overflow menu, not another squeeze.
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
          <span className="sr-only text-base font-bold tracking-tight sm:not-sr-only sm:inline">
            codegrind
          </span>
          {/* Pushed from `sm` to `lg`: at `md` the six labels and the wordmark
              have already spent the row. */}
          <span className="hidden text-xs text-muted-foreground lg:inline short:hidden">
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
          {/* The manual. Last, unlabelled until `md`, and a question mark rather
              than a word — it is the one destination whose glyph is universal,
              which is what buys the sixth slot on a phone. */}
          <Tab
            to="/help"
            icon={<CircleQuestionMark className="h-4 w-4" />}
            label="Help"
            labelClass="hidden md:inline"
          />
        </nav>
      </header>
      <main className="min-h-0 flex-1">{children}</main>
    </div>
  );
}
