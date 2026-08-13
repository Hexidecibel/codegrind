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
} from 'lucide-react';
import type { SubmitResponse, Topic, Primer } from '@/shared/types';
import {
  startSession,
  nextInSession,
  getSession,
  getProgress,
  getPrimer,
  getSettings,
} from '@/client/lib/api';
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
    }
  }, [snapshot, advancing, setSnapshot]);

  const onSubmitted = useCallback(
    (res: SubmitResponse) => {
      const accepted = res.result.verdict === 'accepted';
      setSnapshot((prev) =>
        prev
          ? {
              ...prev,
              solved: prev.solved + (accepted ? 1 : 0),
              streak: accepted ? prev.streak + 1 : 0,
            }
          : prev,
      );
      void refreshReviewDue();
    },
    [setSnapshot, refreshReviewDue],
  );

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

    const footer = (
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
              <Loader2 className="h-4 w-4 animate-spin" /> Loading next…
            </>
          ) : (
            <>
              Next problem <ArrowRight className="h-4 w-4" />
            </>
          )}
        </Button>
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
