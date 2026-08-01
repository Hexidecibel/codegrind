import { useEffect, useState } from 'react';
import { Loader2, BookOpen, Check, AlertTriangle } from 'lucide-react';
import { TOPICS } from '@/shared/types';
import type { Primer, Topic } from '@/shared/types';
import { getPrimer, getPrimers } from '@/client/lib/api';
import { PatternPrimer } from '@/client/components/PatternPrimer';
import { humanize } from '@/client/lib/format';
import { cn } from '@/lib/utils';

/**
 * Cheat-sheet library: browse a durable primer for any of the 18 patterns.
 * Primers generate on demand (Claude, ~15s) and cache server-side; already-cached
 * topics are flagged so repeat visits are instant.
 */
export function LibraryPage() {
  const [cached, setCached] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Topic | null>(null);
  const [primer, setPrimer] = useState<Primer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await getPrimers();
        if (alive) setCached(new Set(list));
      } catch {
        /* non-critical — the badges are just a hint */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const select = async (topic: Topic) => {
    if (loading) return;
    setSelected(topic);
    setPrimer(null);
    setError(null);
    setLoading(true);
    try {
      const p = await getPrimer(topic);
      setPrimer(p);
      setCached((prev) => new Set(prev).add(topic));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load primer');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto h-full max-w-5xl space-y-6 overflow-y-auto p-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <BookOpen className="h-6 w-6 text-violet-400" />
          Pattern library
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A durable cheat-sheet for every pattern — recognition cues, a reusable
          template, pitfalls, and a canonical example. Pick one to open its primer.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {TOPICS.map((t) => {
          const isActive = selected === t;
          const isCached = cached.has(t);
          return (
            <button
              key={t}
              type="button"
              onClick={() => select(t)}
              disabled={loading}
              className={cn(
                'flex items-center gap-2 rounded-lg border px-3 py-2.5 text-left text-sm font-medium transition-colors disabled:opacity-60',
                isActive
                  ? 'border-violet-500/50 bg-violet-500/15 text-violet-200'
                  : 'border-border bg-card hover:border-violet-500/30 hover:bg-violet-500/[0.06]',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{humanize(t)}</span>
              {isActive && loading ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-violet-400" />
              ) : isCached ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
              ) : null}
            </button>
          );
        })}
      </div>

      {loading && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
          Generating the {selected ? humanize(selected) : ''} primer… (first time
          can take ~15s)
        </div>
      )}

      {error && !loading && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive-foreground">
          <AlertTriangle className="mb-1 inline h-4 w-4" /> {error}
        </div>
      )}

      {primer && !loading && (
        <PatternPrimer key={primer.pattern} primer={primer} defaultOpen />
      )}

      {!selected && !loading && (
        <p className="text-sm text-muted-foreground">
          Select a pattern above to open its primer.
        </p>
      )}
    </div>
  );
}
