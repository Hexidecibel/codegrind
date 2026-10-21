// The "Next: <step> →" bar a screen shows when it was opened from Today. It
// re-reads GET /api/today (free) whenever `refreshKey` changes — after a
// submit is recorded, a mock is graded, a card is graded — and renders nothing
// while this screen is still where the current step happens.

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, CalendarCheck } from 'lucide-react';
import type { TodayStepId } from '@/shared/today';
import { getToday } from '@/client/lib/api';
import { nextStepLink, type TodayLink } from '@/client/lib/today-flow';
import { Button } from '@/client/components/ui/button';
import { cn } from '@/lib/utils';

export function TodayNextBar({
  here,
  screenPath,
  refreshKey,
  onLocal,
  className,
}: {
  here: TodayStepId;
  /** The path of the screen showing the bar ('/grind', '/mock'). */
  screenPath: string;
  refreshKey?: unknown;
  /**
   * Handle the link on this screen instead of navigating (Grind serves the
   * next problem itself). Return true when handled.
   */
  onLocal?: (link: TodayLink) => boolean;
  className?: string;
}) {
  const navigate = useNavigate();
  const [link, setLink] = useState<TodayLink | null>(null);
  const [progress, setProgress] = useState<string>('');

  useEffect(() => {
    let live = true;
    getToday()
      .then((s) => {
        if (!live) return;
        setLink(nextStepLink(s, here, screenPath));
        setProgress(`${s.completed}/${s.total}`);
      })
      .catch(() => {
        /* the bar is a convenience; the Today tab still works */
      });
    return () => {
      live = false;
    };
  }, [here, screenPath, refreshKey]);

  if (!link) return null;
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-lg border border-primary/40 bg-primary/10 px-4 py-3',
        className,
      )}
      role="status"
    >
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <CalendarCheck className="h-4 w-4 text-primary" /> Today {progress}
      </span>
      {onLocal && link.step !== null ? (
        <Button
          className="ml-auto gap-1.5"
          onClick={() => {
            if (!onLocal(link)) navigate(link.href);
          }}
        >
          {link.label} <ArrowRight className="h-4 w-4" />
        </Button>
      ) : (
        <Button asChild className="ml-auto gap-1.5">
          <Link to={link.href}>
            {link.label} <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      )}
    </div>
  );
}
