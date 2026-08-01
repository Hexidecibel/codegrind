import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Sparkles } from 'lucide-react';
import type { Problem, Topic, Difficulty } from '@/shared/types';
import { nextProblem, generateProblem } from '@/client/lib/api';
import { useLocalStorage } from '@/client/hooks/useLocalStorage';
import { useControlSize } from '@/client/hooks/useMediaQuery';
import { Button } from '@/client/components/ui/button';
import { TopicPicker } from '@/client/components/TopicPicker';
import { SolveSurface } from '@/client/components/SolveSurface';

/**
 * Manual mode (/manual): the classic topic-picker flow. All solve logic lives in
 * SolveSurface — this page only owns problem selection (topic/difficulty + New/
 * Generate), passed in as the surface's toolbar extras.
 */
export function WorkspacePage() {
  const [topic, setTopic] = useLocalStorage<Topic>('codegrind.topic', 'two-pointer');
  const [difficulty, setDifficulty] = useLocalStorage<Difficulty>(
    'codegrind.difficulty',
    'easy',
  );

  const [problem, setProblem] = useState<Problem | null>(null);
  const [loadingProblem, setLoadingProblem] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadNext = useCallback(
    async (fresh: boolean) => {
      setError(null);
      if (fresh) setGenerating(true);
      else setLoadingProblem(true);
      try {
        const p = fresh
          ? await generateProblem(topic, difficulty)
          : await nextProblem(topic, difficulty);
        setProblem(p);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load problem');
      } finally {
        setLoadingProblem(false);
        setGenerating(false);
      }
    },
    [topic, difficulty],
  );

  // Auto-load a first problem on mount.
  useEffect(() => {
    if (!problem) void loadNext(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = loadingProblem || generating;
  const controlSize = useControlSize();

  const toolbarExtras = (
    <>
      <TopicPicker
        topic={topic}
        difficulty={difficulty}
        onTopic={setTopic}
        onDifficulty={setDifficulty}
        disabled={busy}
      />
      <Button
        variant="outline"
        size={controlSize}
        onClick={() => loadNext(false)}
        disabled={busy}
        className="gap-1.5"
      >
        {loadingProblem ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="h-4 w-4" />
        )}
        New
      </Button>
      <Button
        variant="ghost"
        size={controlSize}
        onClick={() => loadNext(true)}
        disabled={busy}
        className="gap-1.5"
        title="Force Claude to generate a fresh problem"
      >
        {generating ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Sparkles className="h-4 w-4" />
        )}
        Generate
      </Button>
    </>
  );

  if (!problem) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {busy ? (
          <span className="inline-flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading problem…
          </span>
        ) : error ? (
          <div className="space-y-3">
            <p className="text-destructive-foreground">{error}</p>
            <Button size="sm" onClick={() => loadNext(false)}>
              Retry
            </Button>
          </div>
        ) : (
          'No problem loaded.'
        )}
      </div>
    );
  }

  return <SolveSurface problem={problem} toolbarExtras={toolbarExtras} />;
}
