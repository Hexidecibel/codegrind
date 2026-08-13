import { useEffect, useState } from 'react';
import { Loader2, X, AlertTriangle } from 'lucide-react';
import { TOPICS } from '@/shared/types';
import type { StudyIndexEntry, Topic } from '@/shared/types';
import { getStudyIndex } from '@/client/lib/api';
import { humanize } from '@/client/lib/format';
import { cn } from '@/lib/utils';

/**
 * The jump-to index — the old Library grid, repurposed. Same 18-topic
 * responsive button grid, but each cell reports how far through the track you
 * are and how solid the topic is, instead of a cache checkmark.
 *
 * Presented as a bottom sheet on phones / a centred panel on desktop. There's
 * no shadcn sheet primitive in this project (only badge/button/card/popover/
 * select/switch) and adding a dependency is out of scope, so this is a plain
 * fixed overlay: backdrop click and Escape both close it.
 */
export function StudyIndex({
  open,
  onClose,
  onJump,
  currentTopic,
}: {
  open: boolean;
  onClose: () => void;
  onJump: (topic: Topic) => void;
  currentTopic?: Topic | null;
}) {
  const [stats, setStats] = useState<Map<Topic, StudyIndexEntry>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refetch each time it opens: counts move as you read.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await getStudyIndex();
        if (!alive) return;
        setStats(
          new Map(res.topics.map((t: StudyIndexEntry) => [t.topic, t])),
        );
      } catch (err) {
        if (alive) {
          setError(err instanceof Error ? err.message : 'Failed to load index');
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="Close index"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Jump to a topic"
        className="relative flex max-h-[85%] w-full flex-col rounded-t-2xl border border-border bg-card shadow-xl sm:max-h-[80%] sm:max-w-3xl sm:rounded-2xl"
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-base font-bold">Jump to a topic</h2>
            <p className="truncate text-xs text-muted-foreground">
              Read count and mastery per pattern. The feed picks up where that
              topic left off.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error && (
            <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive-foreground">
              <AlertTriangle className="mb-0.5 mr-1 inline h-4 w-4" />
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {TOPICS.map((t) => {
              const s = stats.get(t);
              const isActive = currentTopic === t;
              const done = s && s.total > 0 && s.read >= s.total;
              const pct = s && s.total > 0 ? (s.read / s.total) * 100 : 0;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => onJump(t)}
                  className={cn(
                    'flex min-h-16 flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-left transition-colors',
                    isActive
                      ? 'border-violet-500/50 bg-violet-500/15 text-violet-200'
                      : 'border-border bg-card hover:border-violet-500/30 hover:bg-violet-500/[0.06]',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {humanize(t)}
                    </span>
                    {loading && !s ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-violet-400" />
                    ) : (
                      <span
                        className={cn(
                          'shrink-0 text-xs tabular-nums',
                          done ? 'text-emerald-400' : 'text-muted-foreground',
                        )}
                      >
                        {s ? `${s.read}/${s.total}` : '—'}
                      </span>
                    )}
                  </span>
                  {/* Read progress; mastery rides underneath as a tint. */}
                  <span className="block h-1 w-full overflow-hidden rounded-full bg-muted">
                    <span
                      className={cn(
                        'study-accent block h-full rounded-full',
                        done ? 'bg-emerald-400/70' : 'bg-violet-400/70',
                      )}
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </span>
                  <span className="text-[0.7rem] text-muted-foreground">
                    {s ? `${Math.round(s.mastery * 100)}% mastery` : 'not started'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
