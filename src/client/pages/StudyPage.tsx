import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  LayoutList,
  Loader2,
  Moon,
  Sun,
  AlertTriangle,
  Sparkles,
} from 'lucide-react';
import { TOPICS } from '@/shared/types';
import type { Lesson, StudyPosition, Topic } from '@/shared/types';
import { getStudyFeed, jumpToTopic, markLessonRead } from '@/client/lib/api';
import { LessonCard } from '@/client/components/LessonCard';
import { StudyIndex } from '@/client/components/StudyIndex';
import { useLocalStorage } from '@/client/hooks/useLocalStorage';
import { humanize } from '@/client/lib/format';
import { cn } from '@/lib/utils';

/** How many lessons to pull per append. Small = the server has less to have
 *  pre-generated before it can answer instantly. */
const PAGE = 3;

/** Load the next page this far before the tail actually reaches the viewport.
 *  ~1.5 screens of runway on a phone, so the fetch lands long before the
 *  reader could ever see a gap. */
const PREFETCH_MARGIN = '1200px 0px 1200px 0px';

/** A lesson counts as read once its bottom edge has been past the fold for
 *  this long — long enough that flicking through the feed doesn't burn the
 *  whole curriculum. */
const READ_DWELL_MS = 900;

/** While the server is still writing the next lesson, re-ask on this cadence.
 *  The tail sentinel stays intersecting, so IntersectionObserver will not
 *  re-fire on its own — this is what un-sticks the skeleton. */
const WARM_POLL_MS = 4000;

/**
 * Study — a continuous, never-ending reading feed over the DSA curriculum.
 *
 * The design constraint that shapes everything here is that it is read in bed,
 * one-handed, half-asleep: no decisions, no pagination, no modals, and above
 * all **no layout shift**. Appends land below a fixed-height skeleton, so
 * nothing ever moves under the reader's eyes; the "read" mark is derived from
 * scroll position and fired into the void.
 */
export function StudyPage() {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [position, setPosition] = useState<StudyPosition | null>(null);
  const [warming, setWarming] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [booting, setBooting] = useState(true);
  const [appending, setAppending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [indexOpen, setIndexOpen] = useState(false);
  const [dim, setDim] = useLocalStorage<boolean>('codegrind.study.dim', false);
  const [searchParams, setSearchParams] = useSearchParams();

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const tailRef = useRef<HTMLDivElement | null>(null);

  // --- append bookkeeping (refs, not state: read inside observers) ---------
  const fetchingRef = useRef(false);
  const exhaustedRef = useRef(false);
  const lastIdRef = useRef<string | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  /** Is the tail sentinel currently inside the prefetch margin? */
  const tailVisibleRef = useRef(false);
  /** Did the last fetch actually yield new lessons? Distinguishes "keep
   *  filling the runway" from "the server has nothing more right now". */
  const lastFreshRef = useRef(0);

  const loadMore = useCallback(async () => {
    if (fetchingRef.current || exhaustedRef.current) return;
    fetchingRef.current = true;
    setAppending(true);
    setError(null);
    try {
      const after = lastIdRef.current;
      const res = await getStudyFeed(
        after ? { after, limit: PAGE } : { limit: PAGE },
      );

      // De-dupe defensively: a warm-poll and a sentinel fire can race, and the
      // server re-anchors on `after`, so overlap is cheap to guard against.
      const fresh = res.lessons.filter((l: Lesson) => !seenRef.current.has(l.id));
      for (const l of fresh) seenRef.current.add(l.id);
      lastFreshRef.current = fresh.length;
      if (fresh.length > 0) {
        lastIdRef.current = fresh[fresh.length - 1].id;
        setLessons((prev) => [...prev, ...fresh]);
      }

      setPosition(res.position ?? null);
      setWarming(Boolean(res.warming));
      exhaustedRef.current = Boolean(res.exhausted);
      setExhausted(Boolean(res.exhausted));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the feed');
    } finally {
      fetchingRef.current = false;
      setAppending(false);
      setBooting(false);
    }
  }, []);

  // --- tail sentinel: append ahead of the reader ---------------------------
  useEffect(() => {
    const el = tailRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        tailVisibleRef.current = last.isIntersecting;
        if (last.isIntersecting) void loadMore();
      },
      { root: scrollRef.current, rootMargin: PREFETCH_MARGIN, threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  // --- top-up loop ---------------------------------------------------------
  // An IntersectionObserver only fires on *transitions*. With a 1200px
  // prefetch margin the tail sentinel routinely stays intersecting across an
  // append (three short lessons don't push it out), so it would never fire
  // again and the feed would silently stall. This effect re-runs on every
  // append and tops the runway up until the sentinel is genuinely off-margin.
  //
  // Two cadences: fast while the server is still handing us cached lessons,
  // slow (WARM_POLL_MS) while it's generating or has momentarily run dry —
  // that slow path is also what un-sticks the "writing the next lesson…"
  // skeleton, since nothing else will re-ask.
  useEffect(() => {
    if (exhausted || error || appending) return;
    const needMore =
      warming || lessons.length === 0 || tailVisibleRef.current;
    if (!needMore) return;
    const stillFilling =
      !warming && lastFreshRef.current > 0 && tailVisibleRef.current;
    const t = window.setTimeout(
      () => void loadMore(),
      stillFilling ? 250 : WARM_POLL_MS,
    );
    return () => window.clearTimeout(t);
  }, [warming, exhausted, appending, error, lessons.length, loadMore]);

  // --- per-lesson read tracking -------------------------------------------
  // One observer for the whole feed. Each lesson gets a sentinel div under its
  // card; dwell past the fold for READ_DWELL_MS => mark read, once, forever,
  // fire-and-forget. Nothing on screen waits on the round-trip.
  const readObsRef = useRef<IntersectionObserver | null>(null);
  const elIdRef = useRef<Map<Element, string>>(new Map());
  const markedRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Map<string, number>>(new Map());
  const refCacheRef = useRef<
    Map<string, (el: HTMLDivElement | null) => (() => void) | void>
  >(new Map());

  useEffect(() => {
    const timers = timersRef.current;
    const elIds = elIdRef.current;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = elIds.get(entry.target);
          if (!id) continue;
          if (entry.isIntersecting) {
            if (markedRef.current.has(id) || timers.has(id)) continue;
            const handle = window.setTimeout(() => {
              timers.delete(id);
              if (markedRef.current.has(id)) return;
              markedRef.current.add(id);
              io.unobserve(entry.target);
              // Fire-and-forget: a failed mark just means the lesson
              // resurfaces later, which is a survivable outcome.
              void markLessonRead(id).catch(() => {
                markedRef.current.delete(id);
              });
            }, READ_DWELL_MS);
            timers.set(id, handle);
          } else {
            const handle = timers.get(id);
            if (handle !== undefined) {
              window.clearTimeout(handle);
              timers.delete(id);
            }
          }
        }
      },
      {
        root: scrollRef.current,
        // Bottom edge pulled up 25%: the sentinel has to be genuinely behind
        // the reader, not merely peeking into view, before it counts.
        rootMargin: '0px 0px -25% 0px',
        threshold: 0,
      },
    );
    readObsRef.current = io;
    // Anything already mounted (StrictMode remount, or a jump that re-rendered
    // before this effect re-ran) gets picked up here.
    for (const el of elIds.keys()) io.observe(el);
    return () => {
      io.disconnect();
      readObsRef.current = null;
      for (const handle of timers.values()) window.clearTimeout(handle);
      timers.clear();
    };
  }, []);

  // Stable per-id ref callback — a fresh closure each render would detach and
  // re-observe every sentinel on every append.
  const readRef = useCallback((id: string) => {
    const cache = refCacheRef.current;
    let fn = cache.get(id);
    if (!fn) {
      // React 19 ref-cleanup form: unobserve on unmount (a topic jump swaps
      // the whole list) so the observer doesn't retain detached nodes.
      fn = (el: HTMLDivElement | null) => {
        if (!el) return;
        elIdRef.current.set(el, id);
        if (!markedRef.current.has(id)) readObsRef.current?.observe(el);
        return () => {
          readObsRef.current?.unobserve(el);
          elIdRef.current.delete(el);
        };
      };
      cache.set(id, fn);
    }
    return fn;
  }, []);

  // --- jump ----------------------------------------------------------------
  const jump = useCallback(async (topic: Topic) => {
    setIndexOpen(false);
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    setBooting(true);
    setError(null);
    try {
      const res = await jumpToTopic(topic);
      seenRef.current = new Set(res.lessons.map((l: Lesson) => l.id));
      lastIdRef.current = res.lessons.length
        ? res.lessons[res.lessons.length - 1].id
        : null;
      lastFreshRef.current = res.lessons.length;
      tailVisibleRef.current = false;
      setLessons(res.lessons);
      setPosition(res.position ?? null);
      setWarming(Boolean(res.warming));
      exhaustedRef.current = Boolean(res.exhausted);
      setExhausted(Boolean(res.exhausted));
      scrollRef.current?.scrollTo({ top: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to jump');
    } finally {
      fetchingRef.current = false;
      setBooting(false);
    }
  }, []);

  // --- boot ----------------------------------------------------------------
  // Normally: no `after`, so the server resumes at the first unread lesson.
  //
  // With `?topic=…`: Reflect sent us here. A tap on a node in the skill tree
  // (or a row in the mastery gate) means "I want to read about *this*", so the
  // feed opens there instead of wherever the reader last was. The param is
  // then dropped with `replace`, because it has done its job: a refresh, or a
  // Back into this entry an hour later, should resume normally rather than
  // yanking the reader back to a topic they already moved past.
  //
  // Declared after `jump` on purpose — it closes over it.
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    const requested = searchParams.get('topic');
    const topic =
      requested && (TOPICS as readonly string[]).includes(requested)
        ? (requested as Topic)
        : null;
    if (topic) {
      setSearchParams({}, { replace: true });
      void jump(topic);
    } else {
      void loadMore();
    }
  }, [searchParams, setSearchParams, jump, loadMore]);

  // The skeleton also stands in for "no lessons yet, but more are coming" —
  // an empty feed with no placeholder reads as a broken page.
  const showSkeleton =
    !exhausted &&
    !error &&
    (warming || appending || booting || lessons.length === 0);

  return (
    <div
      ref={scrollRef}
      className={cn(
        'h-full overflow-y-auto',
        // Dim/warm mode re-declares the palette tokens for this subtree only
        // (see .study-dim in index.css) — the rest of the app is untouched.
        dim && 'study-dim bg-background',
      )}
    >
      {/* Sticky so position + escape hatches survive an infinite scroll. */}
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex max-w-3xl items-center gap-1 px-2 py-2 sm:px-4">
          <Link
            to="/"
            aria-label="Back to grind"
            title="Back to grind"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>

          <div className="min-w-0 flex-1 px-1">
            {position ? (
              <p className="truncate text-sm font-semibold">
                {humanize(position.topic)}
                <span className="ml-2 text-xs font-normal tabular-nums text-muted-foreground">
                  {position.seq + 1}/{position.total}
                </span>
              </p>
            ) : (
              <p className="truncate text-sm font-semibold text-muted-foreground">
                Study
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={() => setIndexOpen(true)}
            aria-label="Jump to a topic"
            title="Jump to a topic"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <LayoutList className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setDim(!dim)}
            aria-pressed={dim}
            aria-label={dim ? 'Normal brightness' : 'Dim, warmer reading'}
            title={dim ? 'Normal brightness' : 'Dim, warmer reading'}
            className={cn(
              'inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground',
              dim ? 'text-amber-300/80' : 'text-muted-foreground',
            )}
          >
            {dim ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-3xl space-y-6 px-3 pb-32 pt-4 sm:px-6">
        {lessons.map((lesson) => (
          <div key={lesson.id}>
            <LessonCard lesson={lesson} />
            {/* Read sentinel: sits just under the card, observed once. */}
            <div ref={readRef(lesson.id)} className="h-px w-full" aria-hidden />
          </div>
        ))}

        {/* Fixed-height skeleton. This is the whole zero-layout-shift trick:
            the space the next lesson will occupy is already reserved, so when
            it arrives nothing below the reader's eyes moves. */}
        {showSkeleton && (
          <div
            className="h-64 rounded-xl border border-border bg-card/40 px-4 py-5 sm:px-6 sm:py-6"
            aria-live="polite"
          >
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-400" />
              {booting || lessons.length === 0
                ? 'Finding your place…'
                : 'Writing the next lesson…'}
            </div>
            <div className="mt-4 space-y-3" aria-hidden>
              <div className="h-5 w-2/3 rounded bg-muted/60" />
              <div className="h-3 w-full rounded bg-muted/40" />
              <div className="h-3 w-11/12 rounded bg-muted/40" />
              <div className="h-3 w-full rounded bg-muted/40" />
              <div className="h-3 w-4/5 rounded bg-muted/40" />
              <div className="h-3 w-10/12 rounded bg-muted/40" />
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive-foreground">
            <p>
              <AlertTriangle className="mb-0.5 mr-1.5 inline h-4 w-4" />
              {error}
            </p>
            <button
              type="button"
              onClick={() => {
                setError(null);
                void loadMore();
              }}
              className="mt-3 inline-flex min-h-11 items-center rounded-md border border-border px-3 text-sm transition-colors hover:bg-accent"
            >
              Try again
            </button>
          </div>
        )}

        {/* Exhaustion is a calm end, not a failure. */}
        {exhausted && !error && (
          <div className="rounded-xl border border-border bg-muted/20 p-6 text-center">
            <Sparkles className="study-accent mx-auto h-5 w-5 text-violet-400" />
            <p className="mt-2 text-sm font-semibold">
              That&apos;s everything for tonight.
            </p>
            <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">
              You&apos;ve read through what&apos;s written. Grind a few problems
              and new lessons will be drawn from how they go — or jump back to a
              topic that still feels fuzzy.
            </p>
            <button
              type="button"
              onClick={() => setIndexOpen(true)}
              className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-md border border-border px-4 text-sm transition-colors hover:bg-accent"
            >
              <LayoutList className="h-4 w-4" />
              Browse topics
            </button>
          </div>
        )}

        {/* Tail sentinel — kept mounted so the observer never has to be rebuilt. */}
        <div ref={tailRef} className="h-px w-full" aria-hidden />
      </div>

      <StudyIndex
        open={indexOpen}
        onClose={() => setIndexOpen(false)}
        onJump={(t) => void jump(t)}
        currentTopic={position?.topic ?? null}
      />
    </div>
  );
}
