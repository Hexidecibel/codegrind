// =============================================================================
// RecognizeAccuracy — how often you call the pattern right, per pattern
// =============================================================================
// Fetches its own (free) stats so a failure here never takes Reflect down, and
// renders nothing until there is at least one recognize card. Worst pattern
// first: the top of the list is the thing to drill.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { RecognizeStats } from '@/shared/recognize';
import { getRecognizeStats } from '@/client/lib/api';
import { humanize } from '@/client/lib/format';
import { Card } from '@/client/components/ui/card';
import { Section } from './primitives';

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function RecognizeAccuracy() {
  const [stats, setStats] = useState<RecognizeStats | null>(null);
  useEffect(() => {
    let live = true;
    getRecognizeStats()
      .then((s) => live && setStats(s))
      .catch(() => {
        /* optional section */
      });
    return () => {
      live = false;
    };
  }, []);

  if (!stats || stats.total === 0) return null;
  return (
    <Section
      title="Pattern recognition"
      description={
        <>
          From <Link to="/recognize" className="underline underline-offset-4">Recognize</Link>: did you call the
          pattern from the statement alone?
          {stats.recentAccuracy !== null && ` Last ${stats.recentN}: ${pct(stats.recentAccuracy)} right.`}
          {stats.due > 0 && ` ${stats.due} due.`}
        </>
      }
    >
      <Card className="space-y-2 p-3 sm:p-4">
        {stats.byTopic.map((t) => (
          <div key={t.topic} className="flex items-center gap-3 text-sm">
            <span className="w-36 shrink-0 truncate">{humanize(t.topic)}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary" aria-hidden>
              <div
                className={t.patternAccuracy >= 0.6 ? 'h-full bg-emerald-400/80' : 'h-full bg-rose-400/80'}
                style={{ width: pct(t.patternAccuracy) }}
              />
            </div>
            <span className="w-24 shrink-0 text-right tabular-nums text-muted-foreground">
              {pct(t.patternAccuracy)} · {t.n}
            </span>
          </div>
        ))}
      </Card>
    </Section>
  );
}
