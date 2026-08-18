import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, Sparkles } from 'lucide-react';
import type { Problem, Topic, Difficulty } from '@/shared/types';
import { ApiError, nextProblem, generateProblem, getBankStatus } from '@/client/lib/api';
import { useLocalStorage } from '@/client/hooks/useLocalStorage';
import { useControlSize } from '@/client/hooks/useMediaQuery';
import { describeWait } from '@/client/lib/wait-copy';
import { Button } from '@/client/components/ui/button';
import { TopicPicker } from '@/client/components/TopicPicker';
import { LanguagePicker } from '@/client/components/LanguagePicker';
import { SolveSurface } from '@/client/components/SolveSurface';

/**
 * Where /manual opens when the bank cannot suggest anything.
 *
 * `arrays`/`easy` rather than the old `two-pointer`/`easy`: arrays is
 * FOUNDATIONAL_START and one of the four ROOT_TOPICS, which are exactly the
 * slots seeding fills — so on an empty bank it is also the first slot that will
 * ever have something in it. It is only ever reached when GET /api/bank says
 * there is nothing servable at all (or is unreachable); the normal path asks.
 */
const FALLBACK_SLOT: { topic: Topic; difficulty: Difficulty } = {
  topic: 'arrays',
  difficulty: 'easy',
};

/**
 * Manual mode (/manual): the classic topic-picker flow. All solve logic lives in
 * SolveSurface — this page only owns problem selection (topic/difficulty + New/
 * Generate), passed in as the surface's toolbar extras.
 *
 * WHY THE OPENING SLOT IS A QUERY. This page used to default to
 * `two-pointer`/`easy` and auto-load on mount. Seeding stocks `easy` x the four
 * ROOT_TOPICS (arrays, hashing, math, bit-manipulation) and nothing else, and
 * `two-pointer` is not one of them — so that slot was empty BY CONSTRUCTION on
 * every fresh install, and a brand-new user's very first click on "Manual" paid
 * a full cold generation (15-95 seconds) under the words "Loading problem…".
 * Asking the bank what it can actually serve fixes it in a way that stays right
 * when the seed plan changes; hardcoding a different topic would not.
 *
 * A STORED PREFERENCE ALWAYS WINS. The suggestion is only consulted when the
 * player has never picked, so nobody's chosen topic is second-guessed.
 */
export function WorkspacePage() {
  // Null means "never chosen", which is the distinction the old default of
  // 'two-pointer' threw away — an unset preference and a deliberate choice of
  // two-pointer were indistinguishable.
  const [storedTopic, setStoredTopic] = useLocalStorage<Topic | null>(
    'codegrind.topic',
    null,
  );
  const [storedDifficulty, setStoredDifficulty] = useLocalStorage<Difficulty | null>(
    'codegrind.difficulty',
    null,
  );

  const [slot, setSlot] = useState<{ topic: Topic; difficulty: Difficulty } | null>(
    () =>
      storedTopic && storedDifficulty
        ? { topic: storedTopic, difficulty: storedDifficulty }
        : null,
  );

  const [problem, setProblem] = useState<Problem | null>(null);
  const [loadingProblem, setLoadingProblem] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(
    null,
  );
  /** Measured seconds per generation on this install, or null. See pace.service.ts. */
  const [generationSeconds, setGenerationSeconds] = useState<number | null>(null);
  const [waitMs, setWaitMs] = useState(0);

  const busy = loadingProblem || generating;
  const controlSize = useControlSize();

  // Resolve the opening slot (and the pace estimate) exactly once, before the
  // first fetch — the whole point is to avoid the cold generation, so guessing
  // first and correcting afterwards would defeat it.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const status = await getBankStatus();
        if (!alive) return;
        setGenerationSeconds(status.generationSeconds);
        setSlot((prev) =>
          prev ?? {
            topic: storedTopic ?? status.suggested?.topic ?? FALLBACK_SLOT.topic,
            difficulty:
              storedDifficulty ??
              status.suggested?.difficulty ??
              FALLBACK_SLOT.difficulty,
          },
        );
      } catch {
        // An unreachable status endpoint must not leave the page with no slot at
        // all — fall back and let the normal error path report the real failure.
        if (alive) setSlot((prev) => prev ?? FALLBACK_SLOT);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadNext = useCallback(
    async (fresh: boolean, target?: { topic: Topic; difficulty: Difficulty }) => {
      const where = target ?? slot;
      if (!where) return;
      setError(null);
      if (fresh) setGenerating(true);
      else setLoadingProblem(true);
      try {
        const p = fresh
          ? await generateProblem(where.topic, where.difficulty)
          : await nextProblem(where.topic, where.difficulty);
        setProblem(p);
      } catch (err) {
        if (err instanceof ApiError) {
          setError({ message: err.message, detail: err.detail });
        } else {
          setError({
            message: err instanceof Error ? err.message : 'Failed to load problem',
          });
        }
      } finally {
        setLoadingProblem(false);
        setGenerating(false);
        // A generation that just happened moves the estimate — see pace.service.
        getBankStatus()
          .then((s) => setGenerationSeconds(s.generationSeconds))
          .catch(() => {});
      }
    },
    [slot],
  );

  // Auto-load the first problem once — but only after the slot is known, which
  // is the fix: firing on mount is what made the default topic load-bearing.
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (!slot || autoLoaded.current) return;
    autoLoaded.current = true;
    void loadNext(false);
  }, [slot, loadNext]);

  // Same elapsed-time clock as grind's "Next problem" — see wait-copy.ts.
  useEffect(() => {
    if (!busy) {
      setWaitMs(0);
      return;
    }
    const startedAt = Date.now();
    const id = setInterval(() => setWaitMs(Date.now() - startedAt), 250);
    return () => clearInterval(id);
  }, [busy]);

  const pickTopic = useCallback(
    (topic: Topic) => {
      setStoredTopic(topic);
      setSlot((prev) => ({
        topic,
        difficulty: prev?.difficulty ?? FALLBACK_SLOT.difficulty,
      }));
    },
    [setStoredTopic],
  );
  const pickDifficulty = useCallback(
    (difficulty: Difficulty) => {
      setStoredDifficulty(difficulty);
      setSlot((prev) => ({
        topic: prev?.topic ?? FALLBACK_SLOT.topic,
        difficulty,
      }));
    },
    [setStoredDifficulty],
  );

  // "Generate" is a model call by definition, so it says so from the first
  // frame; "New" tries the bank first, so only the clock can tell.
  const wait = describeWait({
    intent: generating ? 'generate' : 'bank-first',
    elapsedMs: waitMs,
    estimateSeconds: generationSeconds,
    subject: 'problem',
  });

  const toolbarExtras = (
    <>
      {/*
        Next to topic/difficulty because it is the same KIND of control: all
        three steer what the next problem will be. Switching it reloads from the
        newly active language's bank, because the problem on screen belongs to
        the old one and nothing about it changes retroactively.
      */}
      <LanguagePicker disabled={busy} onChange={() => void loadNext(false)} />
      <TopicPicker
        topic={slot?.topic ?? FALLBACK_SLOT.topic}
        difficulty={slot?.difficulty ?? FALLBACK_SLOT.difficulty}
        onTopic={pickTopic}
        onDifficulty={pickDifficulty}
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
        title="Force a fresh model-written problem (slow — the bank is not consulted)"
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
        {busy || !slot ? (
          <div className="max-w-md space-y-2" aria-live="polite">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {slot ? wait.label : 'Loading…'}
            </span>
            {wait.note && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {wait.note}
              </p>
            )}
          </div>
        ) : error ? (
          <div className="max-w-md space-y-3">
            <p className="text-destructive-foreground">{error.message}</p>
            {error.detail && (
              <details className="text-left">
                <summary className="cursor-pointer text-xs opacity-70 hover:opacity-100">
                  Technical detail
                </summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 p-2 text-[11px] leading-relaxed">
                  {error.detail}
                </pre>
              </details>
            )}
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
