// =============================================================================
// CloseCalls — how near the failed runs came, and how often you fixed them
// =============================================================================
// The verdict files 11/12 and 0/12 under the same word. This section separates
// them: the mean share of hidden tests passing on FAILED submits, how many of
// those were near misses (shared/closeness.NEAR_MISS_THRESHOLD), and how many
// near misses you then fixed yourself the same day. Per week, plus one headline
// comparing the last four weeks with the four before.
//
// Fetches its own (free) numbers so a failure here never takes Reflect down,
// and renders nothing until there is at least one failed run in the window.

import { useEffect, useState } from 'react';
import { Crosshair, Gauge, Wrench } from 'lucide-react';
import type { ClosenessStats, ClosenessWindow } from '@/shared/closeness';
import { getCloseness } from '@/client/lib/api';
import { Card } from '@/client/components/ui/card';
import { HelpHint } from '@/client/components/HelpHint';
import { DataTable, Section } from './primitives';
import { RAMP, dayLabel, pct } from './chart';
import { TrendChart } from './TrendChart';
import { Tile } from './StatTiles';

/** "9/12" for the threshold — a concrete picture of what 75% means. */
export function thresholdAsTests(threshold: number, of = 12): string {
  return `${Math.round(threshold * of)}/${of}`;
}

/** One sentence comparing the two headline windows, never scolding. */
export function closenessHeadline(recent: ClosenessWindow, prior: ClosenessWindow): string {
  const span = `${recent.weeks} week${recent.weeks === 1 ? '' : 's'}`;
  if (recent.avgCloseness === null) {
    return `No failed runs in the last ${span}.`;
  }
  const now = pct(recent.avgCloseness);
  let compare = '';
  if (prior.avgCloseness !== null) {
    const delta = Math.round((recent.avgCloseness - prior.avgCloseness) * 100);
    compare =
      delta > 0
        ? `, up from ${pct(prior.avgCloseness)} the ${span} before`
        : delta < 0
          ? `, against ${pct(prior.avgCloseness)} the ${span} before`
          : `, level with the ${span} before`;
  }
  const fixed =
    recent.nearMisses > 0
      ? ` ${recent.nearMisses} close call${recent.nearMisses === 1 ? '' : 's'}, ${recent.recovered} fixed the same day.`
      : '';
  return `Last ${span}: your failed runs passed ${now} of tests on average${compare}.${fixed}`;
}

export function CloseCalls() {
  const [stats, setStats] = useState<ClosenessStats | null>(null);
  useEffect(() => {
    let live = true;
    getCloseness()
      .then((s) => live && setStats(s))
      .catch(() => {
        /* optional section */
      });
    return () => {
      live = false;
    };
  }, []);

  if (!stats || stats.weeks.every((w) => w.failed === 0)) return null;
  const { recent, prior, threshold } = stats;

  const series = stats.weeks
    .filter((w) => w.avgCloseness !== null)
    .map((w) => ({
      label: `Week of ${dayLabel(w.weekStart)}`,
      meta: `${w.failed} failed run${w.failed === 1 ? '' : 's'} · ${w.nearMisses} close call${w.nearMisses === 1 ? '' : 's'}`,
      value: w.avgCloseness as number,
    }));

  // Tile notes: this window, then the one before it for comparison.
  const before = (n: number | null, f: (v: number) => string) =>
    `last ${recent.weeks} wks · ${n === null ? 'none' : f(n)} the ${prior.weeks} before`;

  return (
    <Section
      title="Close calls"
      description={
        <>
          {thresholdAsTests(threshold)} tests passing on a failed run means the idea was right — a
          small bug got in the way. {closenessHeadline(recent, prior)}
        </>
      }
      aside={<HelpHint id="close-calls" align="end" />}
      table={
        <DataTable head={['Week of', 'Failed runs', 'Avg passing', 'Close calls', 'Fixed same day']}>
          {[...stats.weeks].reverse().map((w) => (
            <tr key={w.weekStart}>
              <td>{dayLabel(w.weekStart)}</td>
              <td>{w.failed}</td>
              <td>{w.avgCloseness === null ? '—' : pct(w.avgCloseness)}</td>
              <td>{w.nearMisses}</td>
              <td>{w.recovered}</td>
            </tr>
          ))}
        </DataTable>
      }
    >
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        <Tile
          icon={Gauge}
          colour={RAMP[2]}
          value={recent.avgCloseness === null ? '—' : pct(recent.avgCloseness)}
          label="Passing on misses"
          note={before(prior.avgCloseness, pct)}
        />
        <Tile
          icon={Crosshair}
          colour={RAMP[3]}
          value={String(recent.nearMisses)}
          label="Close calls"
          note={before(prior.failed > 0 ? prior.nearMisses : null, String)}
        />
        <Tile
          icon={Wrench}
          colour={RAMP[4]}
          value={String(recent.recovered)}
          label="Fixed same day"
          note={
            recent.nearMisses > 0
              ? `your own fix, of ${recent.nearMisses} close call${recent.nearMisses === 1 ? '' : 's'}`
              : 'no close calls to fix yet'
          }
        />
      </div>
      {series.length > 0 && (
        <Card className="p-3 sm:p-4">
          <TrendChart
            title="Tests passing on failed runs"
            description="Weekly average share of hidden tests passing when a submit did not clear."
            data={series}
            format={pct}
            domainMax={1}
            footnote="Higher means your misses are getting smaller."
          />
        </Card>
      )}
    </Section>
  );
}
