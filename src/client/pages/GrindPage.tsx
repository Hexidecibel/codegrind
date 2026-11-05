import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Loader2,
  Zap,
  ArrowRight,
  Flame,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Sparkles,
  BookOpen,
} from 'lucide-react';
import { TOPICS, type SubmitResult, type Topic, type Primer, type CoachNudge } from '@/shared/types';
import {
  startSession,
  nextInSession,
  getSession,
  getProgress,
  getPrimer,
  getSettings,
  getBankStatus,
  getToday,
  markLessonRead,
} from '@/client/lib/api';
import { activeGate, dismissGate, learnHref, pinFromSearch } from '@/client/lib/read-first';
import { presetToOverrides, type AssistanceSettings } from '@/client/lib/assistance';
import { isGrindLink, todayStepFrom, type TodayLink } from '@/client/lib/today-flow';
import { TodayNextBar } from '@/client/components/TodayNextBar';
import { describeWait } from '@/client/lib/wait-copy';
import { useLocalStorage } from '@/client/hooks/useLocalStorage';
import { staleForLanguage, type GrindSnapshot } from '@/client/lib/grind-snapshot';
import { useControlSize, useIsWide } from '@/client/hooks/useMediaQuery';
import { Button } from '@/client/components/ui/button';
import { Badge } from '@/client/components/ui/badge';
import { SolveSurface } from '@/client/components/SolveSurface';
import { CoachBanner } from '@/client/components/CoachBanner';
import { PatternPrimer } from '@/client/components/PatternPrimer';
import { humanize } from '@/client/lib/format';
import { BestOnIpad, useIpadGate } from '@/client/components/BestOnIpad';

/** The Today routine's editor: Minimal (highlighting + line numbers), closest to CoderPad. */
const TODAY_ASSISTANCE: AssistanceSettings = { level: 2, overrides: presetToOverrides(2) };

function uniqueTopics(topics: Topic[], next: Topic): Topic[] {
  return topics.includes(next) ? topics : [...topics, next];
}

/**
 * On a phone, /grind opens on the BestOnIpad card: the day's coding belongs on
 * the iPad, and Recognize ×5 is the phone-shaped thing to do instead.
 */
export function GrindPage() {
  const gate = useIpadGate('grind');
  if (gate.gated) {
    return (
      <BestOnIpad
        action={{ label: 'Do Recognize ×5 instead', to: '/recognize?n=5' }}
        onOpenAnyway={gate.openAnyway}
      />
    );
  }
  return <GrindScreen />;
}

function GrindScreen() {
  const [snapshot, setSnapshot] = useLocalStorage<GrindSnapshot | null>(
    'codegrind.grind',
    null,
  );

  const [starting, setStarting] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [resuming, setResuming] = useState(!!snapshot);
  const [error, setError] = useState<string | null>(null);
  const [reviewDue, setReviewDue] = useState(0);
  // The problem a verdict has come back for in this page's lifetime — what
  // tells "Next" apart from "Skip" on a review. Not persisted: after a reload
  // the label may say Skip for a review already submitted, and the server
  // ignores that skip because the row is no longer due.
  const [submittedProblemId, setSubmittedProblemId] = useState<string | null>(null);
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
  const isWide = useIsWide();
  const controlSize = useControlSize();
  const location = useLocation();
  const navigate = useNavigate();
  // Opened from Today (`?from=today&step=…`): Minimal editor, prediction
  // required on the problem steps, and a "Next: <step> →" bar on completion.
  const todayStep = todayStepFrom(location.search);
  const [todayKey, setTodayKey] = useState(0);
  const todayEntry = useRef(false);
  // Learn's "Practice this →" lands here as ?topic=&tag=: a pinned first problem.
  const pinEntry = useRef(false);
  // Bumped when a read-first gate is dismissed (the dismissal itself lives in
  // sessionStorage, see read-first.ts) so the card goes away at once.
  const [, setGateTick] = useState(0);
  const gate = activeGate(snapshot?.readFirst);

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
  // A read-first gate on any OTHER kind of pick reads the primer cache-only:
  // showing a gate must never cost a generation.
  const whyKind = snapshot?.why.kind;
  const whyTopic = snapshot?.why.topic;
  const gateTopic = gate?.topic;
  useEffect(() => {
    const generating = whyKind === 'new-pattern' && !!whyTopic;
    const topic = generating ? whyTopic : gateTopic;
    if (!topic) {
      setPrimer(null);
      setPrimerLoading(false);
      return;
    }
    let alive = true;
    setPrimer(null);
    setPrimerLoading(true);
    (async () => {
      try {
        const p = await getPrimer(topic, { cachedOnly: !generating });
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
  }, [whyKind, whyTopic, gateTopic]);

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

  const start = useCallback(async (pin?: { topic: Topic; tag?: string }) => {
    setError(null);
    setStarting(true);
    try {
      const res = await startSession(pin);
      setSnapshot({
        sessionId: res.sessionId,
        plan: res.plan,
        problem: res.problem,
        why: res.why,
        upNext: res.upNext,
        readFirst: res.readFirst,
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
      // Only a problem served AS a review is named. A problem missed for the
      // first time a moment ago is also "due" (queued due-now), and that one is
      // supposed to come straight back cold — naming it here would snooze it.
      const gp = await nextInSession(
        snapshot.sessionId,
        snapshot.why.kind === 'review' ? snapshot.problem.id : undefined,
      );
      setSnapshot((prev) =>
        prev
          ? {
              ...prev,
              problem: gp.problem,
              why: gp.why,
              upNext: gp.upNext,
              readFirst: gp.readFirst,
              topics: uniqueTopics(prev.topics, gp.why.topic),
            }
          : prev,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load next problem');
    } finally {
      setAdvancing(false);
      void refreshPace();
      // A skipped review left the due set, so the pill's count just changed.
      void refreshReviewDue();
    }
  }, [snapshot, advancing, setSnapshot, refreshPace, refreshReviewDue]);

  // Fires with the VERDICT, which now arrives minutes before the coaching does.
  // Only the counters this page owns belong here.
  const onSubmitted = useCallback(
    (result: SubmitResult) => {
      const accepted = result.verdict === 'accepted';
      // The surface is keyed on the problem, so a verdict is always for the one
      // on screen.
      setSubmittedProblemId(snapshot?.problem.id ?? null);
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
    [setSnapshot, snapshot?.problem.id],
  );

  // The review count is SERVER-derived and the review-queue move happens after
  // the coaching call, so refreshing it on the verdict would read the count from
  // before this submit. It waits for the stream to end instead.
  const onSubmitRecorded = useCallback(() => {
    void refreshReviewDue();
    setTodayKey((k) => k + 1);
  }, [refreshReviewDue]);

  // Entering from Learn ("Practice this →", ?topic=&tag=), once: start a
  // sitting pinned to that topic — unless the problem on screen already is one.
  // The params are then dropped with `replace`, like Learn's own ?topic=, so a
  // refresh resumes rather than re-pinning.
  useEffect(() => {
    if (pinEntry.current || resuming || starting || todayStep) return;
    pinEntry.current = true;
    const pin = pinFromSearch(location.search, TOPICS);
    if (!pin) return;
    navigate('/grind', { replace: true });
    if (snapshot?.why.topic === pin.topic) return;
    void start(pin);
  }, [resuming, starting, todayStep, location.search, navigate, snapshot, start]);

  const closeGate = useCallback((g: CoachNudge, read: boolean) => {
    dismissGate(g.topic);
    setGateTick((t) => t + 1);
    // Best-effort: the read is a lean for the coach, not something to block on.
    if (read) void markLessonRead(g.lessonId).catch(() => {});
  }, []);

  // Entering from Today, once: no sitting yet → start one (the user clicked
  // Start); a sitting whose problem was already submitted today → serve the
  // next one, so "Problem 2" never opens on Problem 1's finished screen.
  useEffect(() => {
    if (!todayStep || todayEntry.current || resuming || starting || advancing) return;
    todayEntry.current = true;
    if (!snapshot) {
      void start();
      return;
    }
    if (todayStep === 'problem1' || todayStep === 'problem2') {
      getToday()
        .then((t) => {
          if (t.attemptedProblemIds.includes(snapshot.problem.id)) void next();
        })
        .catch(() => {
          /* stay on the problem shown */
        });
    }
  }, [todayStep, resuming, starting, advancing, snapshot, start, next]);

  // The bar's link stays on this screen when the next step is another grind
  // problem: serve it here instead of re-mounting the page.
  const onTodayLink = useCallback(
    (link: TodayLink) => {
      if (!isGrindLink(link)) return false;
      navigate(link.href, { replace: true });
      void next();
      return true;
    },
    [navigate, next],
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

    // Leaving a review without submitting it snoozes it (see `next`). Any
    // submit, pass or fail, already moved it out of the due set, so after one
    // this is an ordinary advance and the label goes back to saying so.
    const skipsReview =
      snapshot.why.kind === 'review' && submittedProblemId !== snapshot.problem.id;

    const footer = (
      <div className="space-y-1.5">
        {todayStep && (
          <TodayNextBar
            here={todayStep}
            screenPath="/grind"
            refreshKey={`${todayKey}:${snapshot.problem.id}`}
            onLocal={onTodayLink}
          />
        )}
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
                {skipsReview ? 'Skip for now' : 'Next problem'}{' '}
                <ArrowRight className="h-4 w-4" />
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
        sessionAssistance={todayStep ? TODAY_ASSISTANCE : undefined}
        requirePrediction={todayStep === 'problem1' || todayStep === 'problem2'}
        banner={
          <>
            <CoachBanner
              plan={snapshot.plan}
              why={snapshot.why}
              upNext={snapshot.upNext}
            />
            {gate ? (
              <ReadFirstCard
                gate={gate}
                primer={primer}
                primerLoading={primerLoading}
                onRead={() => closeGate(gate, true)}
                onSkip={() => closeGate(gate, false)}
              />
            ) : snapshot.why.kind === 'new-pattern' &&
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
                    <PatternPrimer primer={primer} defaultOpen={isWide} />
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
            onClick={() => void start()}
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
              className="tap-link text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              or pick manually
            </Link>
            <span className="mx-2 text-xs text-muted-foreground">·</span>
            <Link
              to="/recognize"
              className="tap-link text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              rusty? recognize patterns (no code)
            </Link>
            <span className="mx-2 text-xs text-muted-foreground">·</span>
            <Link
              to="/envelope"
              className="tap-link text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              envelope math reps
            </Link>
            <span className="mx-2 text-xs text-muted-foreground">·</span>
            <Link
              to="/patterns"
              className="tap-link text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              pattern shapes
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The soft read-first gate: the topic's primer, open, above a problem from a
 * topic you have never attempted. Never blocks the editor — "Skip" is one tap.
 * With no cached primer it is a link to the topic's lessons in Learn instead
 * (the gate never triggers a generation).
 */
function ReadFirstCard({
  gate,
  primer,
  primerLoading,
  onRead,
  onSkip,
}: {
  gate: CoachNudge;
  primer: Primer | null;
  primerLoading: boolean;
  onRead: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="shrink-0 space-y-3 border-b border-border bg-background/40 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-violet-300">
          <BookOpen className="h-4 w-4" />
          Read first: {humanize(gate.topic)}
        </span>
        <span className="text-xs text-muted-foreground">
          New to you — a quick read makes this one land.
        </span>
      </div>
      {primerLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading the primer…
        </div>
      ) : primer ? (
        <PatternPrimer primer={primer} defaultOpen />
      ) : (
        <Link
          to={learnHref(gate)}
          className="tap-link text-sm text-violet-300 underline-offset-4 hover:text-foreground hover:underline"
        >
          Open {gate.title} in Learn →
        </Link>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onRead} className="gap-1.5">
          <CheckCircle2 className="h-4 w-4" /> I&apos;ve read it
        </Button>
        <Button size="sm" variant="ghost" onClick={onSkip}>
          Skip
        </Button>
      </div>
    </div>
  );
}
