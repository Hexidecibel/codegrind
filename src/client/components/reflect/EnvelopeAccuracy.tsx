// =============================================================================
// EnvelopeAccuracy — envelope-math accuracy and how many zeros off, over time
// =============================================================================
// Fetches its own (free) stats so a failure here never takes Reflect down, and
// renders nothing until there is at least one answer. Two numbers per day: the
// share answered within 30%, and the mean |orders of magnitude| off (0 = spot
// on, 1 = a factor of ten). The second one is the one the drill is for.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ENVELOPE_CAUSE_TEXT, type EnvelopeStats } from '@/shared/envelope';
import { getEnvelopeStats } from '@/client/lib/api';
import { Card } from '@/client/components/ui/card';
import { Section } from './primitives';

const pct = (x: number) => `${Math.round(x * 100)}%`;

const CAUSE_LABEL: Record<keyof typeof ENVELOPE_CAUSE_TEXT, string> = {
  'month-for-day': 'month constant for a day',
  'bits-bytes': 'bits / bytes',
  'unit-ladder': 'unit ladder slip',
  zeros: 'zeros, not exponents',
  arithmetic: 'small-number math',
};

export function EnvelopeAccuracy() {
  const [stats, setStats] = useState<EnvelopeStats | null>(null);
  useEffect(() => {
    let live = true;
    getEnvelopeStats()
      .then((s) => live && setStats(s))
      .catch(() => {
        /* optional section */
      });
    return () => {
      live = false;
    };
  }, []);

  if (!stats || stats.total === 0) return null;
  const maxOrders = Math.max(1, ...stats.byDay.map((d) => d.meanAbsOrders));
  return (
    <Section
      title="Envelope math"
      description={
        <>
          From <Link to="/envelope" className="underline underline-offset-4">Envelope</Link>: answers within 30%, and
          how many powers of ten off on average (0 is spot on).
          {stats.recentAccuracy !== null && ` Last ${stats.recentN}: ${pct(stats.recentAccuracy)} right`}
          {stats.recentMeanAbsOrders !== null && `, ${stats.recentMeanAbsOrders.toFixed(2)} orders off on average.`}
          {stats.due > 0 && ` ${stats.due} due.`}
        </>
      }
    >
      <Card className="space-y-2 p-3 sm:p-4">
        <div className="grid grid-cols-[5.5rem_1fr_1fr] gap-3 text-xs text-muted-foreground">
          <span>Day</span>
          <span>Right</span>
          <span>Orders off (mean |log₁₀|)</span>
        </div>
        {stats.byDay.slice(-14).map((d) => (
          <div key={d.date} className="grid grid-cols-[5.5rem_1fr_1fr] items-center gap-3 text-sm">
            <span className="tabular-nums text-muted-foreground">{d.date.slice(5)}</span>
            <div className="flex items-center gap-2">
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary" aria-hidden>
                <div
                  className={d.accuracy >= 0.8 ? 'h-full bg-emerald-400/80' : 'h-full bg-rose-400/80'}
                  style={{ width: pct(d.accuracy) }}
                />
              </div>
              <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
                {pct(d.accuracy)} · {d.n}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary" aria-hidden>
                <div
                  className={d.meanAbsOrders <= 0.15 ? 'h-full bg-emerald-400/80' : 'h-full bg-amber-400/80'}
                  style={{ width: `${Math.min(100, (d.meanAbsOrders / maxOrders) * 100)}%` }}
                />
              </div>
              <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">{d.meanAbsOrders.toFixed(2)}</span>
            </div>
          </div>
        ))}
        {stats.causes.length > 0 && (
          <p className="pt-1 text-xs text-muted-foreground">
            Misses by likely cause: {stats.causes.map((c) => `${CAUSE_LABEL[c.cause]} ×${c.n}`).join(' · ')}
          </p>
        )}
      </Card>
    </Section>
  );
}
