import { type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Home, Code2, BarChart3, Dumbbell, BookOpen, MessagesSquare } from 'lucide-react';
import { useAppHeight } from '@/client/hooks/useAppHeight';
import { cn } from '@/lib/utils';
import { MoreMenu } from '@/client/components/MoreMenu';
import { LEARN_SUBNAV, PRACTICE_SUBNAV, SubNav, groupPaths } from '@/client/components/SubNav';

function Tab({
  to,
  icon,
  label,
  end,
  /**
   * Where the text label starts showing. See the header-budget note on Layout:
   * the five tabs and More label from `md`.
   */
  labelClass = 'hidden md:inline',
  alsoActiveOn = [],
}: {
  /** Other paths this tab owns (Learn also lights up on /patterns). */
  alsoActiveOn?: string[];
  to: string;
  icon: ReactNode;
  label: string;
  end?: boolean;
  labelClass?: string;
}) {
  const { pathname } = useLocation();
  const owned = alsoActiveOn.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  return (
    <NavLink
      to={to}
      end={end}
      aria-label={label}
      title={label}
      className={({ isActive }) =>
        cn(
          // Icon-only, the text line-box no longer sets the height, so without
          // min-h/min-w these collapse to a 40×28 target. The compact size is
          // for a mouse, and for the short landscape budget — never for a finger
          // on a tablet, however wide it is.
          'inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors sm:pointer-fine:min-h-0 sm:pointer-fine:min-w-0 short:min-h-0 short:min-w-0',
          isActive || owned
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
 * THE HEADER IS A FIXED-WIDTH BUDGET. Write down what pays for what — the
 * failure mode is silent: the row simply overflows on a phone nobody tested on.
 *
 * Five tabs (Home, Practice, Mock, Learn, Progress) and a More button
 * (Settings, Help). Each place a tab stands for keeps its own route; SubNav
 * shows a group's siblings under the header (Practice: grind / pick a problem /
 * drills; Learn: lessons / pattern shapes / concepts). The row holds a 28px
 * logo mark, the `codegrind` wordmark (~85px), a tagline (~145px), the five tabs
 * and More. Icon-only, each is a 44px touch target; labelled, ~76-100px. With
 * 32px of page padding:
 *
 *   < sm   6 icons, no gap (264) + padding (32), header gap 0              = 296 of 390
 *   sm     6 icons + gaps (284) + mark (28) + gap (16) + padding (32)      = 360 of 640
 *   md     6 labels (~540) + mark (28) + gap (16) + padding (32)           = ~616 of 768
 *   lg     the above plus the wordmark (93)                                = ~709 of 1024
 *   xl     the above plus the tagline (153)                                = ~862 of 1280
 *
 * Seven tabs plus `?` used to spend the whole row; folding into five plus More
 * gave back ~90px on a phone. A NEW destination goes in a group's SubNav or in
 * More, not in the tab row.
 */
export function Layout({ children }: { children: ReactNode }) {
  useAppHeight();
  return (
    // Not h-screen: 100vh is the URL-bar-retracted height on mobile, so the
    // bottom of the app ends up clipped by `overflow-hidden`. Anything with a
    // soft keyboard goes one better and tracks the visual viewport
    // (`--app-height`), which is the only thing that shrinks for it on iOS; a
    // mouse-driven desktop leaves that unset and falls through to dvh.
    <div className="flex h-[var(--app-height,100dvh)] flex-col overflow-hidden bg-background text-foreground">
      {/* `short:` = landscape with the keyboard up (see index.css): every
          vertical pixel is contested there, so the header tightens to ~40px. */}
      <header className="flex items-center gap-0 sm:gap-4 border-b border-border bg-card px-4 py-2.5 short:py-1">
        <div className="flex items-center gap-2">
          <div className="hidden h-7 w-7 items-center justify-center sm:flex rounded-md bg-primary text-primary-foreground short:h-6 short:w-6">
            <Code2 className="h-4 w-4" />
          </div>
          {/* Not `hidden`: the wordmark stays in the accessibility tree and in
              the document at every width, it just stops taking layout space on a
              phone. `sr-only` is absolutely positioned, so it is not a flex item
              and contributes no gap either. */}
          <span className="sr-only text-base font-bold tracking-tight lg:not-sr-only lg:inline">
            codegrind
          </span>
          {/* `lg` only: below it the five labels and the wordmark have already
              spent the row. */}
          <span className="hidden text-xs text-muted-foreground xl:inline short:hidden">
            AI-coached interview prep
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <nav className="flex items-center gap-0 sm:gap-1">
            {/* First: today's next step and this week, the landing page. */}
            <Tab to="/home" icon={<Home className="h-4 w-4" />} label="Home" alsoActiveOn={['/today']} />
            <Tab
              to="/practice"
              icon={<Dumbbell className="h-4 w-4" />}
              label="Practice"
              alsoActiveOn={groupPaths(PRACTICE_SUBNAV)}
            />
            {/* Mock interviews: a chat with an interviewer, graded at a level. */}
            <Tab to="/mock" icon={<MessagesSquare className="h-4 w-4" />} label="Mock" />
            <Tab to="/study" icon={<BookOpen className="h-4 w-4" />} label="Learn" alsoActiveOn={groupPaths(LEARN_SUBNAV)} />
            {/* Route stays /progress so old bookmarks keep working. */}
            <Tab to="/progress" icon={<BarChart3 className="h-4 w-4" />} label="Progress" />
          </nav>
          {/* Settings and Help: not places you practice, so one tap further. */}
          <MoreMenu />
        </div>
      </header>
      <SubNav />
      <main className="min-h-0 flex-1">{children}</main>
    </div>
  );
}
