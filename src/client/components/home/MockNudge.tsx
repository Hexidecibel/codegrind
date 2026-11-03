// =============================================================================
// MockNudge — a gentle weekly reminder to do a mock interview
// =============================================================================
// Mocks are the practice that most moves readiness, and the easiest to put off.
// No mock in the window: one card, one line, one button. One done: a quiet
// line, no card.

import { Link } from 'react-router-dom';
import { ArrowRight, Check, MessagesSquare } from 'lucide-react';
import type { WeeklyResponse } from '@/shared/weekly';
import { Button } from '@/client/components/ui/button';
import { HomeCard } from './HomeCard';

export function MockNudge({ mocks, href = '/mock' }: { mocks: WeeklyResponse['mocks']; href?: string }) {
  if (mocks.thisWeek > 0) {
    return (
      <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
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
