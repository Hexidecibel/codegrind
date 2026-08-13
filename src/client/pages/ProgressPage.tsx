// =============================================================================
// Reflect — grind → study → reflect → improve
// =============================================================================
// The route is still `/progress` (no broken bookmarks) but the page answers a
// different question than the old mastery grid did: **am I progressing, and
// what do I do next?**
//
// Reading order is deliberate and top-down:
//
//   1. the next unlock          — the one sentence worth acting on today
//   2. the prerequisite tree    — the hero: where you are in the curriculum
//   3. the five numbers         — the state of play, no interpretation needed
//   4. the gate, then trends    — the evidence behind 1–3
//   5. mistakes, recent work    — the detail you go looking for
//
// Layout note, load-bearing: this component is the **direct child of `<main>`**
// and owns its own `h-full overflow-y-auto`. Wrapping it in anything makes the
// scroller size to its content instead of to the shell, and the page silently
// clips rather than scrolling.

import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { DIFFICULTIES, TOPICS } from '@/shared/types';
import type { AttemptRecord, ReflectResponse } from '@/shared/types';
import { getHistory, getReflect } from '@/client/lib/api';
import { SkillTree } from '@/client/components/reflect/SkillTree';
import { UnlockCard } from '@/client/components/reflect/UnlockCard';
import { StatTiles } from '@/client/components/reflect/StatTiles';
import { TierLadder } from '@/client/components/reflect/TierLadder';
import { ActivityHeatmap } from '@/client/components/reflect/ActivityHeatmap';
import { TrendChart } from '@/client/components/reflect/TrendChart';
import { MistakeLedger } from '@/client/components/reflect/MistakeLedger';
import { HistoryRow } from '@/client/components/reflect/HistoryRow';
import {
  DataTable,
  Section,
  Empty,
} from '@/client/components/reflect/primitives';
import { dayLabel, pct } from '@/client/components/reflect/chart';
import { humanize, mistakeLabel, shortDate } from '@/client/lib/format';
import { Card } from '@/client/components/ui/card';

export function ProgressPage() {
  const [data, setData] = useState<ReflectResponse | null>(null);
  const [attempts, setAttempts] = useState<AttemptRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        // History is a separate endpoint and only feeds the tail section, so a
        // slow/failed history fetch must not take the whole page down with it.
        const [reflect, history] = await Promise.all([
          getReflect(),
          getHistory().catch(() => null),
        ]);
        if (!alive) return;
        setData(reflect);
        setAttempts(history?.attempts ?? []);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : 'Failed to load Reflect');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading your progress…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <div className="mx-auto mt-6 max-w-md rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive-foreground">
          <AlertTriangle className="mb-1 inline h-4 w-4" />{' '}
          {error ?? 'No data returned.'}
        </div>
      </div>
    );
  }

  const { tree, nextUnlock, tiles, activity, trend, mistakes } = data;

  const accuracy = trend.map((t) => ({
    label: t.title,
    meta: `${humanize(t.topic)} · ${shortDate(t.at)}`,
    value: t.firstSubmitRatio,
  }));
  const submits = trend
    .filter((t) => t.submitsToPass !== null)
    .map((t) => ({
      label: t.title,
      meta: `${humanize(t.topic)} · ${shortDate(t.at)}`,
      value: t.submitsToPass as number,
    }));
  const unsolved = trend.length - submits.length;

  const totalAttempts = activity.reduce((n, d) => n + d.attempts, 0);
  const activeDays = activity.filter((d) => d.attempts > 0).length;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-8 p-4 pb-24 sm:p-6">
        <header>
          <h1 className="text-2xl font-bold">Reflect</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Where you are in the curriculum, what opens next, and whether the
            grind is actually working.
          </p>
        </header>

        {/* 1 — the one sentence worth acting on today. */}
        <UnlockCard
          nextUnlock={nextUnlock}
          topicsReached={tiles.topicsReached}
          totalTopics={tree.length || TOPICS.length}
        />

        {/* 2 — the hero. */}
        <Section
          title="Skill tree"
          description="Each topic opens once a prerequisite completes its easy tier — 3 distinct problems solved with no hints."
          table={
            <DataTable
              head={[
                'Topic',
                'State',
                'Tier',
                'Toward next',
                'Clean solves',
                'Solved',
                'Attempts',
                'Serving',
                'Lessons',
                'Depth',
              ]}
            >
              {tree.map((n) => (
                <tr key={n.topic}>
                  <td>{humanize(n.topic)}</td>
                  <td className="capitalize">{n.state}</td>
                  <td>{n.tierLabel}</td>
                  <td>
                    {n.nextTier
                      ? `${n.towardNext}/${n.tierRequirement} ${n.nextTier}`
                      : '—'}
                  </td>
                  <td>
                    {DIFFICULTIES.map((d) => `${d[0]}${n.cleanSolves[d]}`).join(' ')}
                  </td>
                  <td>{n.solved}</td>
                  <td>{n.attempts}</td>
                  <td className="capitalize">{n.difficulty}</td>
                  <td>
                    {n.lessonsRead}/{n.lessonsTotal}
                  </td>
                  <td>{n.depth}</td>
                </tr>
              ))}
            </DataTable>
          }
        >
          <Card className="p-3 sm:p-4">
            <SkillTree tree={tree} />
          </Card>
        </Section>

        {/* 3 — the state of play. */}
        <StatTiles tiles={tiles} />

        {/* 4 — the evidence. */}
        <Section
          title="Tier ladder"
          description="Each quarter of a bar is one completed tier. The marker is the easy tier, which is what opens a topic's dependents."
          table={
            <DataTable head={['Topic', 'Tier', 'To next tier', 'Progress', 'Solved', 'Attempts']}>
              {[...tree]
                .sort((a, b) => b.mastery - a.mastery)
                .map((n) => (
                  <tr key={n.topic}>
                    <td>{humanize(n.topic)}</td>
                    <td>{n.tierLabel}</td>
                    <td>
                      {n.nextTier
                        ? `${n.tierRequirement - n.towardNext} clean ${n.nextTier}`
                        : 'top tier'}
                    </td>
                    <td>{pct(n.mastery)}</td>
                    <td>{n.solved}</td>
                    <td>{n.attempts}</td>
                  </tr>
                ))}
            </DataTable>
          }
        >
          <Card className="p-3 sm:p-4">
            <TierLadder tree={tree} />
          </Card>
        </Section>

        <Section
          title="Activity"
          description={`${totalAttempts} attempt${totalAttempts === 1 ? '' : 's'} across ${activeDays} day${activeDays === 1 ? '' : 's'} in the last ${activity.length}.`}
          table={
            <DataTable head={['Date', 'Attempts', 'Solved']}>
              {[...activity]
                .reverse()
                .filter((d) => d.attempts > 0)
                .map((d) => (
                  <tr key={d.date}>
                    <td>{dayLabel(d.date)}</td>
                    <td>{d.attempts}</td>
                    <td>{d.solved}</td>
                  </tr>
                ))}
            </DataTable>
          }
        >
          <Card className="p-3 sm:p-4">
            <ActivityHeatmap activity={activity} />
          </Card>
        </Section>

        {/* Two metrics, two charts. Never two y-axes on one. */}
        <Section
          title="Trend"
          description="One point per problem, oldest to newest."
          table={
            <DataTable
              head={[
                'Problem',
                'Topic',
                'First submit',
                'Submits to pass',
                'Minutes',
                'When',
              ]}
            >
              {trend.map((t) => (
                <tr key={t.problemId}>
                  <td className="max-w-[16rem] truncate">{t.title}</td>
                  <td>{humanize(t.topic)}</td>
                  <td>{pct(t.firstSubmitRatio)}</td>
                  <td>{t.submitsToPass ?? '—'}</td>
                  <td>{t.minutesToSolve === null ? '—' : Math.round(t.minutesToSolve)}</td>
                  <td>{shortDate(t.at)}</td>
                </tr>
              ))}
            </DataTable>
          }
        >
          <Card className="grid gap-6 p-3 sm:p-4 lg:grid-cols-2">
            <TrendChart
              title="First-submit accuracy"
              description="Share of hidden tests passing on the very first submit."
              data={accuracy}
              format={pct}
              domainMax={1}
              footnote="Higher is better."
            />
            <TrendChart
              title="Submits to pass"
              description="How many submissions it took to clear the problem."
              data={submits}
              format={(v) => String(Math.round(v))}
              footnote={
                unsolved > 0
                  ? `Lower is better. ${unsolved} unsolved problem${unsolved === 1 ? '' : 's'} excluded.`
                  : 'Lower is better.'
              }
            />
          </Card>
        </Section>

        <Section
          title="Recurring mistakes"
          description="The tags the coach keeps attaching to your submissions."
          table={
            <DataTable head={['Mistake', 'Total', 'Recent', 'Earlier', 'Change']}>
              {[...mistakes]
                .sort((a, b) => b.count - a.count)
                .map((m) => (
                  <tr key={m.tag}>
                    <td>{mistakeLabel(m.tag)}</td>
                    <td>{m.count}</td>
                    <td>{m.recent}</td>
                    <td>{m.earlier}</td>
                    <td>
                      {m.recent - m.earlier > 0 ? '+' : ''}
                      {m.recent - m.earlier}
                    </td>
                  </tr>
                ))}
            </DataTable>
          }
        >
          <Card className="p-3 sm:p-4">
            <MistakeLedger mistakes={mistakes} />
          </Card>
        </Section>

        <Section title="Recent attempts">
          {attempts.length === 0 ? (
            <Empty>No attempts recorded yet.</Empty>
          ) : (
            <Card className="px-4">
              {attempts.map((a) => (
                <HistoryRow key={a.id} a={a} />
              ))}
            </Card>
          )}
        </Section>
      </div>
    </div>
  );
}
