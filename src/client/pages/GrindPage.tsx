import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Loader2,
  Zap,
  ArrowRight,
  Flame,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import type { SubmitResult, Topic, Primer } from '@/shared/types';
import {
  startSession,
  nextInSession,
  getSession,
  getProgress,
  getPrimer,
  getSettings,
  getBankStatus,
} from '@/client/lib/api';
import { describeWait } from '@/client/lib/wait-copy';
import { useLocalStorage } from '@/client/hooks/useLocalStorage';
import { staleForLanguage, type GrindSnapshot } from '@/client/lib/grind-snapshot';
import { useControlSize, useIsDesktop } from '@/client/hooks/useMediaQuery';
import { Button } from '@/client/components/ui/button';
import { Badge } from '@/client/components/ui/badge';
import { SolveSurface } from '@/client/components/SolveSurface';
import { CoachBanner } from '@/client/components/CoachBanner';
import { PatternPrimer } from '@/client/components/PatternPrimer';
import { humanize } from '@/client/lib/format';

function uniqueTopics(topics: Topic[], next: Topic): Topic[] {
  return topics.includes(next) ? topics : [...topics, next];
}

export function GrindPage() {
  const [snapshot, setSnapshot] = useLocalStorage<GrindSnapshot | null>(
    'codegrind.grind',
    null,
  );

  const [starting, setStarting] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [resuming, setResuming] = useState(!!snapshot);
  const [error, setError] = useState<string | null>(null);
  const [reviewDue, setReviewDue] = useState(0);
  const [primer, setPrimer] = useState<Primer | null>(null);
  const [primerLoading, setPrimerLoading] = useState(false);
  /**
   * How long one generation takes on this install, measured — see
   * pace.service.ts. Null means nothing has ever been measured, and the wait
   * copy says so in shape rather than inventing a number.
   */
  const [generationSeconds, setGenerationSeconds] = useState<number | null>(null);
  /** Milliseconds the in-flight "Next problem" request has been running. */
  const [waitMs, setWaitMs] = useState(0);
  const validated = useRef(false);
  const isDesktop = useIsDesktop();
  const controlSize = useControlSize();

  // "N due for review" pill — motivational; the scheduler already serves them first.
  const refreshReviewDue = useCallback(async () => {
    try {
      const p = await getProgress();
      setReviewDue(p.reviewDue);
    } catch {
      /* non-critical — leave the last known count */
    }
  }, []);

  useEffect(() => {
    void refreshReviewDue();
  }, [refreshReviewDue]);

  // Free (three indexed counts, no LLM), and re-read after every advance because
  // a generation that just happened updates the estimate.
  const refreshPace = useCallback(async () => {
    try {
      const status = await getBankStatus();
      setGenerationSeconds(status.generationSeconds);
    } catch {
      /* non-critical — the wait copy falls back to its shape-only wording */
    }
  }, []);

  useEffect(() => {
    void refreshPace();
  }, [refreshPace]);

  /**
   * Tick while a "Next problem" request is in flight.
   *
   * This clock is what distinguishes the two things the button used to render
   * identically: a banked problem comes back in tens of milliseconds, and a
   * generated one never comes back in under ten seconds. See wait-copy.ts for
   * why elapsed time is the honest signal here rather than a server-side peek.
   */
  useEffect(() => {
    if (!advancing) {
      setWaitMs(0);
      return;
    }
    const startedAt = Date.now();
    const id = setInterval(() => setWaitMs(Date.now() - startedAt), 250);
    return () => clearInterval(id);
  }, [advancing]);

  // Fetch a pattern primer whenever the scheduler fires a fresh new-pattern intent.
  const whyKind = snapshot?.why.kind;
  const whyTopic = snapshot?.why.topic;
  useEffect(() => {
    if (whyKind !== 'new-pattern' || !whyTopic) {
      setPrimer(null);
      setPrimerLoading(false);
      return;
    }
    let alive = true;
    setPrimer(null);
    setPrimerLoading(true);
    (async () => {
      try {
        const p = await getPrimer(whyTopic);
        if (alive) setPrimer(p);
      } catch {
        if (alive) setPrimer(null);
      } finally {
        if (alive) setPrimerLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [whyKind, whyTopic]);

  // On mount, validate the persisted session two ways before resuming it.
  //
  // 1. It still exists server-side (the original check).
  // 2. Its problem is in the language the app is CURRENTLY set to.
  //
  // The second one is not cosmetic. The snapshot holds a whole `Problem`, and
  // the language picker lives on another page — so switching to Python and
  // coming back here would otherwise put a JavaScript problem on screen inside
  // a session that schedules, runs and grades everything after it as Python.
  // The problem's own language is the only honest answer to "what is this",
  // because it is baked into the reference solution every `expected` came from;
  // that is why `Problem.language` crosses the API boundary at all.
  //
  // Dropping the snapshot is the right repair rather than reloading a fresh
  // problem into it: the plan, the solved/streak counters and the topic list
  // all describe the old language's sitting too.
  useEffect(() => {
    if (validated.current) return;
    validated.current = true;
    if (!snapshot) return;
    let cancelled = false;
    (async () => {
      try {
        // A settings fetch that FAILS must not be read as a mismatch — an
        // unreachable server is not a reason to throw away a live session, so
        // the check is skipped rather than failed.
        const settings = await getSettings().catch(() => null);
        if (staleForLanguage(snapshot, settings?.language ?? null)) {
          if (!cancelled) setSnapshot(null);
          return;
        }
        await getSession(snapshot.sessionId);
        // Session lives and matches — keep the persisted problem/plan as-is.
      } catch {
        // 404 (or gone) — drop it and fall back to the start hero.
        if (!cancelled) setSnapshot(null);
      } finally {
        if (!cancelled) setResuming(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setStarting(true);
    try {
      const res = await startSession();
      setSnapshot({
        sessionId: res.sessionId,
        plan: res.plan,
        problem: res.problem,
        why: res.why,
        upNext: res.upNext,
        solved: 0,
        streak: 0,
        topics: [res.why.topic],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start session');
    } finally {
      setStarting(false);
    }
  }, [setSnapshot]);

  const next = useCallback(async () => {
    if (!snapshot || advancing) return; // disabled-while-loading guards the 3s seed bucket
    setError(null);
    setAdvancing(true);
    try {
      const gp = await nextInSession(snapshot.sessionId);
      setSnapshot((prev) =>
        prev
          ? {
              ...prev,
              problem: gp.problem,
              why: gp.why,
              upNext: gp.upNext,
              topics: uniqueTopics(prev.topics, gp.why.topic),
            }
          : prev,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load next problem');
    } finally {
      setAdvancing(false);
      void refreshPace();
    }
  }, [snapshot, advancing, setSnapshot, refreshPace]);

  // Fires with the VERDICT, which now arrives minutes before the coaching does.
  // Only the counters this page owns belong here.
  const onSubmitted = useCallback(
    (result: SubmitResult) => {
      const accepted = result.verdict === 'accepted';
      setSnapshot((prev) =>
        prev
          ? {
              ...prev,
              solved: prev.solved + (accepted ? 1 : 0),
              streak: accepted ? prev.streak + 1 : 0,
            }
          : prev,
      );
    },
    [setSnapshot],
  );

  // The review count is SERVER-derived and the review-queue move happens after
  // the coaching call, so refreshing it on the verdict would read the count from
  // before this submit. It waits for the stream to end instead.
  const onSubmitRecorded = useCallback(() => {
    void refreshReviewDue();
  }, [refreshReviewDue]);

  // ---- Resuming a persisted session (brief liveness check) ------------------
  if (snapshot && resuming) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Resuming your session…
        </span>
      </div>
    );
  }

  // ---- Active session -------------------------------------------------------
  if (snapshot) {
    const sessionStrip = (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1 font-semibold">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
          {snapshot.solved} solved
        </span>
        <span className="inline-flex items-center gap-1 font-semibold">
          <Flame
            className={
              snapshot.streak > 0
                ? 'h-3.5 w-3.5 text-amber-400'
                : 'h-3.5 w-3.5 text-muted-foreground'
            }
          />
          {snapshot.streak} streak
        </span>
        {reviewDue > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 font-semibold text-rose-300/90">
            <RotateCcw className="h-3 w-3" />
            {reviewDue} due for review
          </span>
        )}
        <span className="hidden items-center gap-1 sm:inline-flex">
          {snapshot.topics.slice(0, 6).map((t) => (
            <Badge key={t} variant="secondary" className="text-[10px]">
              {humanize(t)}
            </Badge>
          ))}
          {snapshot.topics.length > 6 && (
            <span className="text-muted-foreground">
              +{snapshot.topics.length - 6}
            </span>
          )}
        </span>
      </div>
    );

    // The scheduler ALWAYS generates fresh for variation / level-up /
    // new-pattern intents, so roughly half of these clicks are a model writing a
    // whole problem — 15-30s on Claude, 95s+ on a local model, up to 3x that
    // when canonicalization retries. "Loading next…" covered both that and a
    // 50ms database read.
    const wait = describeWait({
      intent: 'bank-first',
      elapsedMs: waitMs,
      estimateSeconds: generationSeconds,
      subject: 'next problem',
    });

    const footer = (
      <div className="space-y-1.5">
        {advancing && wait.note && (
          <p
            aria-live="polite"
            className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground"
          >
            <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            {wait.note}
          </p>
        )}
        <div className="flex items-center gap-3">
          {error && (
            <span className="flex items-center gap-1.5 text-xs text-destructive-foreground">
              <AlertTriangle className="h-3.5 w-3.5" />
              {error}
            </span>
          )}
          <Button
            onClick={next}
            disabled={advancing}
            className="ml-auto gap-1.5"
            size={controlSize}
          >
            {advancing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> {wait.label}
              </>
            ) : (
              <>
                Next problem <ArrowRight className="h-4 w-4" />
              </>
            )}
          </Button>
        </div>
      </div>
    );

    return (
      <SolveSurface
        key={snapshot.problem.id}
        problem={snapshot.problem}
        reviewMode={snapshot.why.kind === 'review'}
        banner={
          <>
            <CoachBanner
              plan={snapshot.plan}
              why={snapshot.why}
              upNext={snapshot.upNext}
            />
            {snapshot.why.kind === 'new-pattern' &&
              (primerLoading || primer) && (
                <div className="shrink-0 border-b border-border bg-background/40 px-4 py-3">
                  {primerLoading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Preparing a primer for this pattern…
                    </div>
                  ) : primer ? (
                    // Collapsed on a phone: expanded it pushes the problem statement
                    // most of a screen down.
                    <PatternPrimer primer={primer} defaultOpen={isDesktop} />
                  ) : null}
                </div>
              )}
          </>
        }
        toolbarExtras={sessionStrip}
        toolbarExtrasKind="context"
        footer={footer}
        onSubmitted={onSubmitted}
        onSubmitRecorded={onSubmitRecorded}
      />
    );
  }

  // ---- Start hero -----------------------------------------------------------
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md space-y-6 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
          <Zap className="h-7 w-7" />
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">Adaptive grind</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            No topic picking. The coach reads your mastery, plans a session, and
            drills what you need next — reinforcing weak patterns, spinning up
            variations, and leveling you up as you go. Just sit down and grind.
          </p>
        </div>

        {error && (
          <p className="text-sm text-destructive-foreground">{error}</p>
        )}

        <div className="space-y-3">
          <Button
            size="lg"
            onClick={start}
            disabled={starting}
            className="gap-2"
          >
            {starting ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" /> Planning your
                session…
              </>
            ) : (
              <>
                <Zap className="h-5 w-5" /> Start grinding
              </>
            )}
          </Button>
          <div>
            <Link
              to="/manual"
              className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              or pick manually
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
