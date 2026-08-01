import { useEffect, useState } from 'react';
import {
  Loader2,
  AlertTriangle,
  Flame,
  Snowflake,
  Circle,
  RotateCcw,
} from 'lucide-react';
import type {
  ProgressStats,
  PatternStat,
  HistoryResponse,
  AttemptRecord,
  Difficulty,
  MistakeStat,
} from '@/shared/types';
import { getProgress, getHistory, getMistakes } from '@/client/lib/api';
import { Card } from '@/client/components/ui/card';
import { Badge } from '@/client/components/ui/badge';
import { humanize, shortDate, mistakeLabel } from '@/client/lib/format';
import { cn } from '@/lib/utils';

const DIFFICULTY_STYLES: Record<Difficulty, string> = {
  easy: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  medium: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  hard: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
};

function masteryColor(score: number): string {
  if (score >= 0.75) return 'bg-emerald-500';
  if (score >= 0.4) return 'bg-amber-500';
  return 'bg-rose-500';
}

function PatternCard({ p }: { p: PatternStat }) {
  const pct = Math.round(p.masteryScore * 100);
  const weak = p.masteryScore < 0.4 && p.attempted > 0;
  const untouched = p.attempted === 0;
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-semibold">{humanize(p.pattern)}</span>
            {weak && <Flame className="h-3.5 w-3.5 text-rose-400" />}
            {untouched && <Snowflake className="h-3.5 w-3.5 text-sky-400" />}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {p.solved}/{p.attempted} solved
            {p.lastSeen ? ` · seen ${shortDate(p.lastSeen)}` : ' · never attempted'}
          </div>
        </div>
        <span className="shrink-0 text-sm font-bold tabular-nums">{pct}%</span>
      </div>
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full transition-all', masteryColor(p.masteryScore))}
          style={{ width: `${Math.max(pct, untouched ? 0 : 4)}%` }}
        />
      </div>
    </Card>
  );
}

function HistoryRow({ a }: { a: AttemptRecord }) {
  return (
    <div className="flex items-center gap-3 border-b border-border/60 py-2.5 last:border-0">
      {a.solved ? (
        <div className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
      ) : (
        <Circle className="h-2 w-2 shrink-0 text-rose-500" fill="currentColor" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{a.problemTitle}</div>
        <div className="text-xs text-muted-foreground">
          {humanize(a.pattern)} · {a.testsPassed}/{a.testsTotal} tests
          {a.hintsUsed > 0 && ` · ${a.hintsUsed} hint${a.hintsUsed === 1 ? '' : 's'}`}
        </div>
      </div>
      <Badge
        variant="outline"
        className={cn('shrink-0 capitalize', DIFFICULTY_STYLES[a.difficulty])}
      >
        {a.difficulty}
      </Badge>
      <span className="shrink-0 text-xs text-muted-foreground">
        {shortDate(a.createdAt)}
      </span>
    </div>
  );
}

export function ProgressDashboard() {
  const [progress, setProgress] = useState<ProgressStats | null>(null);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [mistakes, setMistakes] = useState<MistakeStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [p, h, m] = await Promise.all([
          getProgress(),
          getHistory(),
          getMistakes(),
        ]);
        if (!alive) return;
        setProgress(p);
        setHistory(h);
        setMistakes(m);
      } catch (err) {
        if (!alive) return;
        setError(err instanceof Error ? err.message : 'Failed to load progress');
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
        Loading progress…
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto mt-10 max-w-md rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive-foreground">
        <AlertTriangle className="mb-1 inline h-4 w-4" /> {error}
      </div>
    );
  }

  const patterns = progress?.patterns ?? [];
  const attempts = history?.attempts ?? [];
  const reviewDue = progress?.reviewDue ?? 0;
  const sorted = [...patterns].sort((a, b) => a.masteryScore - b.masteryScore);
  const maxMistake = mistakes.reduce((m, x) => Math.max(m, x.count), 0);

  return (
    <div className="mx-auto max-w-5xl space-y-8 overflow-y-auto p-6">
      <div>
        <h1 className="text-2xl font-bold">Pattern mastery</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Weak patterns (<Flame className="inline h-3.5 w-3.5 text-rose-400" />) and
          untouched ones (<Snowflake className="inline h-3.5 w-3.5 text-sky-400" />) are
          what to grind next.
        </p>
        {reviewDue > 0 && (
          <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-rose-500/30 bg-rose-500/10 px-3 py-1 text-sm font-semibold text-rose-300/90">
            <RotateCcw className="h-3.5 w-3.5" />
            {reviewDue} problem{reviewDue === 1 ? '' : 's'} due for review
          </p>
        )}
      </div>

      {sorted.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">
          No attempts yet — solve a problem to start building your mastery map.
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((p) => (
            <PatternCard key={p.pattern} p={p} />
          ))}
        </div>
      )}

      <div>
        <h2 className="mb-2 text-lg font-bold">Recurring mistakes</h2>
        {mistakes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No recurring mistakes logged yet — clean solving so far.
          </p>
        ) : (
          <Card className="space-y-3 p-4">
            {mistakes.map((m) => (
              <div key={m.tag} className="flex items-center gap-3">
                <span className="w-40 shrink-0 truncate text-sm font-medium">
                  {mistakeLabel(m.tag)}
                </span>
                <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-rose-500/80"
                    style={{
                      width: `${maxMistake ? Math.max((m.count / maxMistake) * 100, 6) : 0}%`,
                    }}
                  />
                </div>
                <span className="w-6 shrink-0 text-right text-sm font-bold tabular-nums">
                  {m.count}
                </span>
                <span className="hidden w-24 shrink-0 text-right text-xs text-muted-foreground sm:inline">
                  {m.lastSeen ? shortDate(m.lastSeen) : '—'}
                </span>
              </div>
            ))}
          </Card>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-lg font-bold">Recent attempts</h2>
        {attempts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No attempts recorded yet.</p>
        ) : (
          <Card className="px-4">
            {attempts.map((a) => (
              <HistoryRow key={a.id} a={a} />
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}
