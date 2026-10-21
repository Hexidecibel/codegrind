// =============================================================================
// TodayPage — the guided daily routine, the app's landing page
// =============================================================================
// One highlighted current step with a big Start / Continue button; done steps
// show how they went, each with a short AI step review and what to carry into
// the next step; a progress bar, the streak, AI spend and per-area readiness on
// top; the debrief at the bottom. The reviews and the debrief are written
// server-side (once each, gated by Settings → AI reviews); this page only
// reads, polling briefly while one is pending.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  CalendarCheck,
  Check,
  Coins,
  Flame,
  Loader2,
  Lock,
  RotateCcw,
  ScanSearch,
  Calculator,
  SkipForward,
  Sparkles,
  Target,
  Timer,
  Trophy,
  Wrench,
} from 'lucide-react';
import { QUICK_OFF_STEPS, READINESS_VERDICT_LABEL, type ReadinessVerdict, type StepNote, type TodayState, type TodayStep } from '@/shared/today';
import { ROUND_LABEL, countdownPhrase } from '@/shared/loops';
import { InterviewsPanel } from '@/client/components/InterviewsPanel';
import { mockKindInfo } from '@/shared/mock-kinds';
import { endTodayEarly, getToday, runTodayDebrief, setTodayQuick, skipTodayStep, ApiError } from '@/client/lib/api';
import { humanize } from '@/client/lib/format';
import { Button } from '@/client/components/ui/button';
import { cn } from '@/lib/utils';

const VERDICT_TONE: Readonly<Record<ReadinessVerdict, string>> = {
  ready: 'text-emerald-400',
  close: 'text-amber-300',
  'not-yet': 'text-rose-300',
  'not-enough': 'text-muted-foreground',
};

function longDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function Header({ state }: { state: TodayState }) {
  const pct = Math.round((state.completed / state.total) * 100);
  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <CalendarCheck className="h-6 w-6 text-primary" /> Today
        </h1>
        <span className="text-sm text-muted-foreground">{longDate(state.date)}</span>
        <span
          className="inline-flex items-center gap-1 text-xs text-muted-foreground"
          title={`Every model call the app made: ${state.spend.todayCalls} today, ${state.spend.monthCalls} this month${state.aiReviews ? '' : ' · AI reviews are off (Settings)'}`}
        >
          <Coins className="h-3.5 w-3.5" /> AI ${state.spend.todayUsd.toFixed(2)} today · ${state.spend.monthUsd.toFixed(2)} this month
          {!state.aiReviews && <span className="ml-1 rounded bg-secondary px-1.5 py-0.5 text-[10px]">reviews off</span>}
        </span>
        <span
          className="ml-auto inline-flex items-center gap-1 text-sm font-semibold"
          title="Consecutive days with practice"
        >
          <Flame className={cn('h-4 w-4', state.streak > 0 ? 'text-amber-400' : 'text-muted-foreground')} />
          {state.streak}-day streak
        </span>
      </div>

      {state.nextLoop && (
        <div className="flex flex-wrap items-baseline gap-x-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
          <span className="font-semibold">
            {state.nextLoop.company} {countdownPhrase(state.nextLoop.daysLeft)}
          </span>
          <span className="text-xs text-muted-foreground">
            {state.nextLoop.date} · {state.nextLoop.rounds.map((r) => ROUND_LABEL[r]).join(', ')}
            {state.nextLoop.isFinalReviewDay
              ? ' · final review today: every open card and review problem is due'
              : state.nextLoop.finalReviewDay
                ? ` · final review ${state.nextLoop.finalReviewDay}`
                : ''}
          </span>
        </div>
      )}

      <div className="space-y-1.5">
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>
            {state.current === null ? 'Day complete' : `${state.completed} of ${state.total} steps`}
            {state.endedEarly ? ' · ended early' : ''}
          </span>
          <span>{state.quick ? '~30 min' : '~90 min'}</span>
        </div>
        <div
          className="h-2.5 overflow-hidden rounded-full bg-secondary"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {state.readiness.map((a) => (
          <div
            key={a.id}
            className={cn('rounded-lg border border-border px-3 py-2', a.inLoop === false && 'opacity-60')}
            title={[
              ...a.signals.map((s) => `${s.label}: ${s.value}${s.n ? ` (n=${s.n})` : ''}`),
              a.inLoop === false ? 'Not a round in your next interview.' : '',
            ]
              .filter(Boolean)
              .join('\n')}
          >
            <div className="text-xs text-muted-foreground">{a.label}</div>
            <div className={cn('text-sm font-semibold', VERDICT_TONE[a.verdict])}>{READINESS_VERDICT_LABEL[a.verdict]}</div>
            <div className="truncate text-[11px] text-muted-foreground">{a.evidence}</div>
            <div className="mt-1 line-clamp-3 text-[11px] text-foreground/80">{a.hint}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** The AI step review under a finished step: what happened + what to carry. */
function StepNoteLine({ note, pending }: { note: StepNote | undefined; pending: boolean }) {
  if (!note && !pending) return null;
  if (!note) {
    return (
      <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> AI reviewing this step…
      </p>
    );
  }
  return (
    <div className="mt-1.5 space-y-0.5 rounded-md border border-border/60 bg-secondary/30 px-2.5 py-1.5 text-xs">
      <p className="whitespace-pre-line text-foreground/85">
        <Sparkles className="mr-1 inline h-3 w-3 text-primary" />
        {note.note}
      </p>
      {note.carry && (
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground/90">Carry:</span> {note.carry}
        </p>
      )}
    </div>
  );
}

function StepIcon({ step, index }: { step: TodayStep; index: number }) {
  const base = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold';
  if (step.status === 'done') return <div className={cn(base, 'bg-emerald-500/15 text-emerald-400')}><Check className="h-4 w-4" /></div>;
  if (step.status === 'skipped') return <div className={cn(base, 'bg-secondary text-muted-foreground')}><SkipForward className="h-4 w-4" /></div>;
  if (step.status === 'locked') return <div className={cn(base, 'bg-secondary text-muted-foreground')}><Lock className="h-4 w-4" /></div>;
  const active = step.status === 'current' || step.status === 'in-progress';
  return (
    <div className={cn(base, active ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground')}>
      {index + 1}
    </div>
  );
}

function StepRow({
  step,
  index,
  busy,
  onSkip,
  onUnskip,
  extra,
  note,
  notePending = false,
  offToday = false,
}: {
  /** Turned off by the 30-min day: no Undo (turn the mode off instead). */
  offToday?: boolean;
  step: TodayStep;
  index: number;
  busy: boolean;
  onSkip: () => void;
  onUnskip: () => void;
  note?: StepNote;
  notePending?: boolean;
  /** A sub-row under the step (the warm-up's optional Recognize add-on). */
  extra?: ReactNode;
}) {
  const active = step.status === 'current' || step.status === 'in-progress';
  const isDebrief = step.id === 'debrief';
  return (
    <li
      className={cn(
        'rounded-xl border p-4 transition-colors',
        active ? 'border-primary/60 bg-primary/5 shadow-sm' : 'border-border bg-card',
        (step.status === 'skipped' || step.status === 'locked') && 'opacity-70',
      )}
    >
      <div className="flex items-start gap-3">
        <StepIcon step={step} index={index} />
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('font-semibold', active && 'text-base')}>{step.label}</span>
            {step.status === 'in-progress' && (
              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">in progress</span>
            )}
            {step.status === 'skipped' && <span className="text-xs text-muted-foreground">{offToday ? 'off today' : 'skipped'}</span>}
          </div>
          {step.result ? (
            <p
              className={cn(
                'text-sm',
                step.ok === true && 'text-emerald-400',
                step.ok === false && 'text-rose-300',
                step.ok === null && 'text-foreground/90',
              )}
            >
              {step.result}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {step.status === 'locked' ? 'Unlocks after the mock (or end the day early).' : step.detail}
            </p>
          )}
          <StepNoteLine note={note} pending={notePending} />
        </div>
        {step.status === 'skipped' && !offToday && (
          <Button variant="ghost" size="sm" onClick={onUnskip} disabled={busy} className="text-muted-foreground">
            Undo
          </Button>
        )}
        {step.status === 'done' && !isDebrief && step.href !== '/today' && (
          <Button variant="ghost" size="sm" asChild className="text-muted-foreground">
            <Link to={step.href}>Open</Link>
          </Button>
        )}
      </div>

      {active && !isDebrief && (
        <div className="mt-4 flex flex-wrap items-center gap-2 pl-11">
          <Button asChild size="lg" className="gap-2">
            <Link to={step.href}>
              {step.status === 'in-progress' ? 'Continue' : 'Start'} <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button variant="ghost" onClick={onSkip} disabled={busy} className="gap-1.5 text-muted-foreground">
            <SkipForward className="h-4 w-4" /> Skip step
          </Button>
        </div>
      )}
      {extra}
    </li>
  );
}

/**
 * "Recognize ×5": optional, never a step (it does not block the day or count
 * toward the progress bar). Highlighted when the server says you're rusty.
 */
function RecognizeRow({ r, note, pending }: { r: TodayState['recognize']; note?: StepNote; pending: boolean }) {
  return (
    <div
      className={cn(
        'mt-3 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 pl-3 sm:ml-11',
        r.recommended && !r.done ? 'border-primary/50 bg-primary/5' : 'border-border',
      )}
    >
      <ScanSearch className={cn('h-4 w-4 shrink-0', r.recommended && !r.done ? 'text-primary' : 'text-muted-foreground')} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">
          Recognize ×5{' '}
          {r.done ? (
            <span className="text-xs text-emerald-400">done · {r.doneToday} today</span>
          ) : r.recommended ? (
            <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] text-primary">recommended</span>
          ) : (
            <span className="text-xs text-muted-foreground">optional</span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {r.reason}
          {!r.done && r.doneToday > 0 ? ` · ${r.doneToday} done today` : ''}
        </div>
        <StepNoteLine note={note} pending={pending} />
      </div>
      <Button asChild size="sm" variant={r.recommended && !r.done ? 'default' : 'outline'} className="gap-1">
        <Link to={r.href}>
          {r.done ? 'Again' : 'Start'} <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </Button>
    </div>
  );
}

/**
 * "Envelope ×5": back-of-the-envelope math reps. Part of the warm-up (the
 * warm-up is done only when `remaining` is 0); due envelope cards lead it.
 */
function EnvelopeRow({ e }: { e: TodayState['envelope'] }) {
  if (!e || (e.daily === 0 && e.due === 0 && e.doneToday === 0)) return null;
  return (
    <div
      className={cn(
        'mt-3 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 pl-3 sm:ml-11',
        !e.done ? 'border-primary/50 bg-primary/5' : 'border-border',
      )}
    >
      <Calculator className={cn('h-4 w-4 shrink-0', !e.done ? 'text-primary' : 'text-muted-foreground')} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">
          Envelope ×{e.daily}{' '}
          {e.done ? (
            <span className="text-xs text-emerald-400">
              done · {e.correctToday}/{e.doneToday} right
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">{e.remaining} to go</span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          Back-of-the-envelope math, interview style: small × 10ⁿ, add or subtract exponents, back up the ladder.
          {e.due > 0 ? ` ${e.due} review card${e.due === 1 ? '' : 's'} due.` : ''}
        </div>
      </div>
      <Button asChild size="sm" variant={!e.done ? 'default' : 'outline'} className="gap-1">
        <Link to={e.done ? '/envelope' : e.href}>
          {e.done ? 'More' : 'Start'} <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </Button>
    </div>
  );
}

function DebriefPanel({
  state,
  busy,
  onRun,
}: {
  state: TodayState;
  busy: boolean;
  onRun: (regenerate: boolean) => void;
}) {
  const step = state.steps.find((s) => s.id === 'debrief')!;
  const d = state.debrief;
  if (step.status === 'locked') return null;
  return (
    <section id="debrief" className="scroll-mt-4 space-y-4 rounded-xl border border-primary/30 bg-card p-4 sm:p-5">
      <h2 className="flex items-center gap-2 text-lg font-bold">
        <Sparkles className="h-5 w-5 text-primary" /> Debrief
      </h2>
      {!d ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            One short AI read of today — what went well, what to fix (each with a concrete drill), and what
            tomorrow should lean on.{' '}
            {state.aiReviews
              ? 'Written automatically once every step is done or skipped (or you end the day early).'
              : 'AI reviews are off, so it runs only when you click.'}
          </p>
          {state.aiPending.includes('debrief') ? (
            <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Writing your debrief…
            </p>
          ) : (
            <Button size="lg" onClick={() => onRun(false)} disabled={busy} className="gap-2">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {busy ? 'Reading your day…' : `Debrief me now (~$${state.debriefEstimateUsd.toFixed(state.debriefEstimateUsd < 0.01 ? 4 : 2)})`}
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {state.nextLoop && (
            <p className="text-xs text-muted-foreground">
              {state.nextLoop.company} {countdownPhrase(state.nextLoop.daysLeft)} ({state.nextLoop.date})
            </p>
          )}
          <p className="text-base font-semibold">{d.verdict}</p>
          {d.wins.length > 0 && (
            <div className="space-y-1.5">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-emerald-400">
                <Trophy className="h-4 w-4" /> Wins
              </h3>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {d.wins.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          {d.fixes.length > 0 && (
            <div className="space-y-1.5">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-amber-300">
                <Wrench className="h-4 w-4" /> Fixes
              </h3>
              <ul className="space-y-2 text-sm">
                {d.fixes.map((f, i) => (
                  <li key={i} className="rounded-lg border border-border px-3 py-2">
                    <div>{f.issue}</div>
                    <div className="mt-0.5 text-muted-foreground">
                      <span className="font-medium text-foreground/90">Do:</span> {f.action}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="space-y-1.5">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <Target className="h-4 w-4 text-primary" /> Tomorrow
            </h3>
            <div className="flex flex-wrap gap-1.5 text-xs">
              {d.tomorrowFocus.patterns.map((p) => (
                <span key={p} className="rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1">
                  {humanize(p)}
                </span>
              ))}
              {d.tomorrowFocus.mockKind && (
                <span className="rounded-full border border-border px-2.5 py-1">
                  Mock: {mockKindInfo(d.tomorrowFocus.mockKind).label}
                </span>
              )}
              {!d.tomorrowFocus.patterns.length && !d.tomorrowFocus.mockKind && (
                <span className="text-muted-foreground">The usual adaptive plan.</span>
              )}
            </div>
            {d.tomorrowFocus.patterns.length > 0 && (
              <p className="text-xs text-muted-foreground">Tomorrow's problems lean toward these (lightly).</p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3 text-xs text-muted-foreground">
            {state.debriefUsage && (
              <span>
                {state.debriefUsage.costUsd != null ? `$${state.debriefUsage.costUsd.toFixed(3)}` : 'local model'} ·{' '}
                {state.debriefUsage.inputTokens + state.debriefUsage.outputTokens} tokens
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              className="ml-auto gap-1.5"
              onClick={() => {
                if (window.confirm(`Regenerate the debrief? One more model call (~$${state.debriefEstimateUsd.toFixed(state.debriefEstimateUsd < 0.01 ? 4 : 2)}).`)) {
                  onRun(true);
                }
              }}
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
              Regenerate
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

export function TodayPage() {
  const [state, setState] = useState<TodayState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [debriefBusy, setDebriefBusy] = useState(false);

  useEffect(() => {
    getToday()
      .then(setState)
      .catch((e: Error) => setError(e.message));
  }, []);

  // Step reviews / the auto debrief are written server-side in the background.
  // While any is pending, re-read every few seconds — bounded, never a loop.
  const [polls, setPolls] = useState(0);
  const pendingKey = state?.aiPending.join(',') ?? '';
  useEffect(() => {
    if (!pendingKey || polls >= 20) return;
    const t = setTimeout(() => {
      getToday()
        .then((s) => {
          setState(s);
          setPolls((n) => n + 1);
        })
        .catch(() => setPolls(20));
    }, 4000);
    return () => clearTimeout(t);
  }, [pendingKey, polls]);

  // A #debrief link from another screen scrolls once the panel exists.
  useEffect(() => {
    if (state && window.location.hash === '#debrief') {
      document.getElementById('debrief')?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [state]);

  const act = useCallback(async (fn: () => Promise<TodayState>) => {
    setBusy(true);
    setError(null);
    try {
      setState(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const runDebrief = useCallback(async (regenerate: boolean) => {
    setDebriefBusy(true);
    setError(null);
    try {
      setState(await runTodayDebrief(regenerate));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setDebriefBusy(false);
    }
  }, []);

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        {error ? (
          <span className="text-destructive-foreground">{error}</span>
        ) : (
          <span className="inline-flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading your day…
          </span>
        )}
      </div>
    );
  }

  const canEndEarly = !state.endedEarly && state.current !== null && state.current !== 'debrief';

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-4 p-4 sm:p-6">
        <Header state={state} />

        <InterviewsPanel today={state.date} onChange={() => void getToday().then(setState).catch(() => undefined)} />

        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
          <Timer className="h-4 w-4 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">30-min day {state.quick && <span className="text-xs text-emerald-400">on</span>}</div>
            <div className="text-xs text-muted-foreground">
              Warm-up cards + Envelope ×3, one problem, the debrief. Streak and spacing are kept; review problems stay due.
            </div>
          </div>
          <Button size="sm" variant={state.quick ? 'outline' : 'secondary'} disabled={busy} onClick={() => act(() => setTodayQuick(!state.quick))}>
            {state.quick ? 'Back to the full day' : 'Short on time'}
          </Button>
        </div>

        {error && <p className="text-sm text-destructive-foreground">{error}</p>}

        <ol className="space-y-2.5">
          {state.steps.map((s, i) => (
            <StepRow
              key={s.id}
              step={s}
              index={i}
              busy={busy}
              onSkip={() => act(() => skipTodayStep(s.id, true))}
              onUnskip={() => act(() => skipTodayStep(s.id, false))}
              offToday={state.quick && QUICK_OFF_STEPS.includes(s.id) && s.status === 'skipped'}
              note={s.id === 'debrief' ? undefined : state.stepNotes[s.id]}
              notePending={s.id !== 'debrief' && state.aiPending.includes(s.id)}
              extra={
                s.id === 'warmup' ? (
                  <>
                    <EnvelopeRow e={state.envelope} />
                    {state.recognize && (
                      <RecognizeRow
                        r={state.recognize}
                        note={state.stepNotes.recognize}
                        pending={state.aiPending.includes('recognize')}
                      />
                    )}
                  </>
                ) : undefined
              }
            />
          ))}
        </ol>

        <DebriefPanel state={state} busy={debriefBusy} onRun={runDebrief} />

        <div className="flex flex-wrap items-center gap-3 pb-6 text-sm">
          {canEndEarly && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                if (window.confirm('End the day early? Unfinished steps are skipped and the debrief unlocks.')) {
                  void act(() => endTodayEarly(true));
                }
              }}
            >
              End day early
            </Button>
          )}
          {state.endedEarly && state.current !== null && (
            <Button variant="ghost" disabled={busy} onClick={() => act(() => endTodayEarly(false))}>
              Resume the day
            </Button>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            Today's mock: {mockKindInfo(state.mockKind).label}
          </span>
        </div>
      </div>
    </div>
  );
}
