// The "Next: <step> →" bar a screen shows when it was opened from Today. It
// re-reads GET /api/today (free) whenever `refreshKey` changes — after a
// submit is recorded, a mock is graded, a card is graded — and renders nothing
// while this screen is still where the current step happens.

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, CalendarCheck, Sparkles } from 'lucide-react';
import type { TodayStepId } from '@/shared/today';
import { getToday } from '@/client/lib/api';
import { nextStepLink, type TodayLink } from '@/client/lib/today-flow';
import { Button } from '@/client/components/ui/button';
import { cn } from '@/lib/utils';

/** "Next: Problem 2" → "Problem 2". */
function stepLabel(link: TodayLink): string {
  return link.label.replace(/^(Next|Continue): /, '');
}

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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const load = () =>
      getToday()
        .then((s) => {
          if (!live) return;
          setLink(nextStepLink(s, here, screenPath));
          setProgress(`${s.completed}/${s.total}`);
          // A step review is being written (server-side, once): re-read a few
          // times so its "carry" shows up. Bounded — never a loop.
          if (s.aiPending.length && polls++ < 8) timer = setTimeout(load, 4000);
        })
        .catch(() => {
          /* the bar is a convenience; the Today tab still works */
        });
    void load();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
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
      {link.carry && link.step && (
        <span className="order-last basis-full text-sm sm:order-none sm:basis-auto sm:flex-1" title={`From the ${link.carry.from} review`}>
          <Sparkles className="mr-1 inline h-3.5 w-3.5 text-primary" />
          <span className="font-medium">Carry into {stepLabel(link)}:</span> {link.carry.text}
        </span>
      )}
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
