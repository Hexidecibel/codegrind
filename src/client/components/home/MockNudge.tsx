// =============================================================================
// MockNudge — a gentle weekly reminder to do a mock interview
// =============================================================================
// Mocks are the practice that most moves readiness, and the easiest to put off.
// No mock in the window: one card, one line, one button. One done: a quiet
// line, no card. During the Pattern Refresh (which replaces mocks): a quiet
// line that says when mocks pick back up, no button.

import { Link } from 'react-router-dom';
import { ArrowRight, Check, MessagesSquare } from 'lucide-react';
import type { WeeklyResponse } from '@/shared/weekly';
import { Button } from '@/client/components/ui/button';
import { HomeCard } from './HomeCard';

/** The nudge is a quiet line (not a card): a mock done this week, or the refresh is on. */
export function mockNudgeIsLine(mocks: WeeklyResponse['mocks'], refresh: { day: number; total: number } | null = null): boolean {
  return !!refresh || mocks.thisWeek > 0;
}

const LINE = 'flex min-h-11 items-center gap-2 px-1 text-sm text-muted-foreground';

export function MockNudge({
  mocks,
  href = '/mock',
  refresh = null,
}: {
  mocks: WeeklyResponse['mocks'];
  href?: string;
  /** The refresh's day, while it is on. */
  refresh?: { day: number; total: number } | null;
}) {
  if (refresh) {
    return (
      <p className={LINE}>
        <MessagesSquare className="h-4 w-4 shrink-0" aria-hidden />
        Mocks pick back up after the refresh (day {refresh.day} of {refresh.total})
      </p>
    );
  }
  if (mocks.thisWeek > 0) {
    return (
      <p className={LINE}>
        <Check className="h-4 w-4 text-emerald-400" aria-hidden />
        {mocks.thisWeek === 1 ? 'Mock done this week' : `${mocks.thisWeek} mocks done this week`}
      </p>
    );
  }
  return (
    <HomeCard title="Mock interview" icon={MessagesSquare}>
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-semibold">No mock this week</p>
          <p className="text-sm text-muted-foreground">One 45-min mock beats ten problems for readiness.</p>
        </div>
        <Button asChild variant="secondary" className="gap-1.5">
          <Link to={href}>
            Start a mock <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>
    </HomeCard>
  );
}
