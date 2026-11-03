// =============================================================================
// MockNudge — a gentle weekly reminder to do a mock interview
// =============================================================================
// Mocks are the practice that most moves readiness, and the easiest to put off.
// No mock in the window: one small friendly card and one button. One done: a
// quiet line, no card. Copy stays one sentence.

import { Link } from 'react-router-dom';
import { ArrowRight, Check, MessagesSquare } from 'lucide-react';
import type { WeeklyResponse } from '@/shared/weekly';
import { Button } from '@/client/components/ui/button';

export function MockNudge({ mocks, href = '/mock' }: { mocks: WeeklyResponse['mocks']; href?: string }) {
  if (mocks.thisWeek > 0) {
    return (
      <p className="flex items-center gap-1.5 px-1 text-sm text-emerald-400">
        <Check className="h-4 w-4" aria-hidden />
        {mocks.thisWeek === 1 ? 'Mock done this week' : `${mocks.thisWeek} mocks done this week`}
      </p>
    );
  }
  return (
    <section
      aria-label="Mock interview"
      className="flex flex-wrap items-center gap-3 rounded-xl border border-sky-500/40 bg-sky-500/5 p-4"
    >
      <MessagesSquare className="h-5 w-5 shrink-0 text-sky-400" aria-hidden />
      <p className="min-w-0 flex-1 text-sm">
        <span className="font-semibold">No mock this week.</span>{' '}
        <span className="text-muted-foreground">One 45-min mock beats ten problems for readiness.</span>
      </p>
      <Button asChild className="gap-1.5">
        <Link to={href}>
          Start a mock <ArrowRight className="h-4 w-4" />
        </Link>
      </Button>
    </section>
  );
}
