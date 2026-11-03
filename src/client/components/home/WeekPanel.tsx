// =============================================================================
// WeekPanel — "This week" in a glance
// =============================================================================
// Seven day dots, the volume (daily vs free is a heuristic, so "(approx.)"),
// the top three topics with a solved bar, near misses, and up to four topics
// not touched. One short line each; numbers come from GET /api/home/weekly.

import { Link } from 'react-router-dom';
import { CalendarDays } from 'lucide-react';
import type { WeeklyResponse } from '@/shared/weekly';
import type { Topic } from '@/shared/types';
import { practiceHref } from '@/shared/pattern-shapes';
import { humanize } from '@/client/lib/format';
import { cn } from '@/lib/utils';
import { HomeCard } from './HomeCard';

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "2026-10-21" → "Wed" (the date is a local day already; read it as UTC). */
export function weekdayOf(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : WEEKDAY[d.getUTCDay()];
}

const MAX_UNTOUCHED = 4;

export function WeekPanel({ week }: { week: WeeklyResponse }) {
  const top = week.topics.slice(0, 3);
  const untouched = week.untouched.slice(0, MAX_UNTOUCHED);
  const { volume, nearMisses } = week;
  return (
    <HomeCard
      title="This week"
      icon={CalendarDays}
      className="h-full"
      aside={
        <>
          <span className="font-semibold text-foreground">{week.activeDays}</span> of {week.days} days
        </>
      }
    >
      <ol className="flex justify-between gap-1" aria-label="Days practised">
        {week.daily.map((d) => (
          <li key={d.date} className="flex flex-col items-center gap-1 text-[11px] text-muted-foreground">
            <span
              className={cn('h-3.5 w-3.5 rounded-full', d.practiced ? 'bg-emerald-400' : 'border border-border bg-muted')}
              aria-label={`${d.date}: ${d.practiced ? 'practised' : 'no practice'}`}
            />
            {weekdayOf(d.date)}
          </li>
        ))}
      </ol>

      <p className="text-sm">
        {volume.subs === 0 ? (
          'No problems submitted yet this week.'
        ) : (
          <>
            {volume.subs} {volume.subs === 1 ? 'submit' : 'submits'} on {volume.problems}{' '}
            {volume.problems === 1 ? 'problem' : 'problems'}
            <span className="text-muted-foreground">
              {' '}
              · {volume.grindSubs} daily, {volume.freeSubs} free (approx.)
            </span>
          </>
        )}
      </p>

      {top.length > 0 && (
        <ul className="space-y-2" aria-label="Top topics">
          {top.map((t) => (
            <li key={t.topic} className="space-y-1">
              <div className="flex justify-between gap-2 text-sm">
                <span className="truncate">{humanize(t.topic)}</span>
                <span className="shrink-0 text-muted-foreground">
                  {t.solvedPct}% solved · {t.attempts}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                <div className="h-full rounded-full bg-primary" style={{ width: `${t.solvedPct}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {nearMisses.count > 0 && (
        <p className="text-sm">
          {nearMisses.count} {nearMisses.count === 1 ? 'near-miss' : 'near-misses'}
          <span className="text-muted-foreground"> · {nearMisses.fixedUnaided} fixed on your own</span>
        </p>
      )}

      {untouched.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">Not touched this week</p>
          <div className="flex flex-wrap gap-1.5">
            {untouched.map((t) => (
              <Link
                key={t}
                to={practiceHref(t as Topic, 'easy')}
                className="inline-flex min-h-11 items-center rounded-full border border-border px-3 text-xs transition-colors hover:bg-muted sm:pointer-fine:min-h-7"
              >
                {humanize(t)}
              </Link>
            ))}
          </div>
        </div>
      )}
    </HomeCard>
  );
}
