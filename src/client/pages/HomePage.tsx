// =============================================================================
// HomePage — the landing page: today's next step, one lever, this week
// =============================================================================
// Rendered at /home and /today (today-flow returns to /today, with ?query and
// #debrief). Top to bottom, one calm column:
//   1. Today: date, streak, progress, ONE big Start / Continue for the current
//      step. Every step, the 30-min day, the refresh controls and the AI spend
//      sit in "Show all steps" (open by default only while the day is going).
//   2. One lever: the weakest readiness area's hint; the tiles open on tap.
//   3. This week + 4. Target next (side by side at md+), from /api/home/weekly.
//   5. Mock nudge.  6. Coming up: interview loops, reviews due.
//   7. "See full progress", then the debrief (#debrief).
// Step reviews and the debrief are written server-side (gated by Settings → AI
// reviews); this page only reads, polling briefly while one is pending.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Briefcase,
  CalendarClock,
  MessagesSquare,
  Mic,
  CalendarCheck,
  Check,
  ChevronDown,
  ChevronUp,
  Coins,
  Flame,
  Loader2,
  Lock,
  RotateCcw,
  SkipForward,
  Sparkles,
  Square,
  Play,
  Target,
  Timer,
  Trophy,
  Wrench,
  Shapes,
  RefreshCw,
  Repeat,
} from 'lucide-react';
import {
  QUICK_OFF_STEPS,
  STEP_NOTE_IDS,
  type StepNote,
  type StepNoteId,
  type TodayState,
  type TodayStep,
} from '@/shared/today';
import type { WeeklyResponse } from '@/shared/weekly';
import { ROUND_LABEL, countdownPhrase } from '@/shared/loops';
import { InterviewsPanel } from '@/client/components/InterviewsPanel';
import { LeverLine } from '@/client/components/home/LeverLine';
import { MockNudge, mockNudgeIsLine } from '@/client/components/home/MockNudge';
import { TargetCard } from '@/client/components/home/TargetCard';
import { RefreshBanner } from '@/client/components/home/RefreshBanner';
import { WarmupChecklist, warmupItems } from '@/client/components/home/WarmupChecklist';
import { WeekPanel } from '@/client/components/home/WeekPanel';
import { CARD } from '@/client/components/home/HomeCard';
import { helpHref } from '@/client/lib/help-content';
import { mockKindInfo } from '@/shared/mock-kinds';
import {
  endTodayEarly,
  getToday,
  getWeekly,
  runTodayDebrief,
  setTodayQuick,
  setTodayRefresh,
  skipTodayStep,
  ApiError,
} from '@/client/lib/api';
import { humanize } from '@/client/lib/format';
import { Button } from '@/client/components/ui/button';
import { cn } from '@/lib/utils';

function longDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

/**
 * Today: where am I, in two seconds. Title + date + streak, the countdown to
 * the next loop, the progress bar; then the children (the one big action).
 */
function Header({ state, children }: { state: TodayState; children?: ReactNode }) {
  const pct = Math.round((state.completed / state.total) * 100);
  return (
    <section aria-label="Today" className={cn(CARD, 'space-y-4')}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <CalendarCheck className="h-6 w-6 text-primary" aria-hidden /> Today
        </h1>
        <span className="text-sm text-muted-foreground">{longDate(state.date)}</span>
        <span className="ml-auto inline-flex items-center gap-1 text-sm font-semibold" title="Consecutive days with practice">
          <Flame className={cn('h-4 w-4', state.streak > 0 ? 'text-amber-400' : 'text-muted-foreground')} aria-hidden />
          <span>
            {state.streak}
            <span className="font-normal text-muted-foreground">-day streak</span>
          </span>
        </span>
      </div>

      {state.nextLoop && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <Briefcase className="h-4 w-4 text-muted-foreground" aria-hidden />
          <span className="font-semibold">
            {state.nextLoop.company} {countdownPhrase(state.nextLoop.daysLeft)}
          </span>
          <span className="text-muted-foreground">· {state.nextLoop.rounds.map((r) => ROUND_LABEL[r]).join(', ')}</span>
          {state.nextLoop.isFinalReviewDay && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">final review today</span>
          )}
        </p>
      )}

      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <span>
            {state.current === null ? (
              <span className="font-semibold text-emerald-400">Day complete</span>
            ) : (
              <>
                <span className="font-semibold">{state.completed}</span>
                <span className="text-muted-foreground"> of {state.total} steps</span>
              </>
            )}
            {state.endedEarly && <span className="text-muted-foreground"> · ended early</span>}
          </span>
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Timer className="h-3.5 w-3.5" aria-hidden />
            {state.refresh.on ? '~60 min' : state.quick ? '~30 min' : '~90 min'}
          </span>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div
            className={cn('h-full rounded-full transition-all', state.current === null ? 'bg-emerald-400' : 'bg-primary')}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {children}
    </section>
  );
}

/** The AI step review under a finished step: what happened + what to carry. */
function StepNoteLine({ note, pending }: { note: StepNote | undefined; pending: boolean }) {
  if (!note && !pending) return null;
  if (!note) {
    return (
      <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> AI reviewing this step…
      </p>
    );
  }
  return (
    <div className="space-y-1 rounded-md bg-secondary/40 px-3 py-2 text-sm">
      <p className="whitespace-pre-line text-foreground/85">{note.note}</p>
      {note.carry && (
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground/90">Carry:</span> {note.carry}
        </p>
      )}
    </div>
  );
}

function StepIcon({ step, index }: { step: TodayStep; index: number }) {
  const base = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold';
  if (step.status === 'done')
    return (
      <div className={cn(base, 'bg-emerald-500/15 text-emerald-400')}>
        <Check className="h-4 w-4" />
      </div>
    );
  if (step.status === 'skipped')
    return (
      <div className={cn(base, 'bg-secondary text-muted-foreground')}>
        <SkipForward className="h-3.5 w-3.5" />
      </div>
    );
  if (step.status === 'locked')
    return (
      <div className={cn(base, 'bg-secondary text-muted-foreground')}>
        <Lock className="h-3.5 w-3.5" />
      </div>
    );
  const active = step.status === 'current' || step.status === 'in-progress';
  return <div className={cn(base, active ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground')}>{index + 1}</div>;
}

/**
 * One compact line per step: icon, label, its result (or what it is), and the
 * row's one action. The AI step review opens on tap (Sparkles), never inline,
 * so the list stays scannable. Start / Skip live on the big card above.
 */
function StepRow({
  step,
  index,
  busy,
  onUnskip,
  extra,
  note,
  notePending = false,
  offToday = false,
  lockedText = 'Unlocks after the mock (or end the day early).',
}: {
  lockedText?: string;
  /** Turned off by the 30-min day: no Undo (turn the mode off instead). */
  offToday?: boolean;
  step: TodayStep;
  index: number;
  busy: boolean;
  onUnskip: () => void;
  note?: StepNote;
  notePending?: boolean;
  /** A sub-row under the step (the warm-up's Envelope / Recognize add-ons). */
  extra?: ReactNode;
}) {
  const [showNote, setShowNote] = useState(false);
  const active = step.status === 'current' || step.status === 'in-progress';
  const isDebrief = step.id === 'debrief';
  const line = step.result ?? (step.status === 'locked' ? lockedText : extra ? null : step.detail);
  return (
    <li className={cn('space-y-2 px-3 py-2.5', active && 'bg-primary/5')}>
      <div className="flex min-h-11 items-center gap-3">
        <StepIcon step={step} index={index} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            <span className="truncate">{step.label}</span>
            {active && <span className="shrink-0 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] text-primary">now</span>}
            {step.status === 'skipped' && <span className="shrink-0 text-xs font-normal text-muted-foreground">{offToday ? 'off today' : 'skipped'}</span>}
          </p>
          {line && (
            <p
              className={cn(
                'truncate text-xs',
                step.result && step.ok === true && 'text-emerald-400',
                step.result && step.ok === false && 'text-rose-300',
                !(step.result && step.ok !== null) && 'text-muted-foreground',
              )}
              title={line}
            >
              {line}
            </p>
          )}
        </div>
        {(note || notePending) && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={showNote ? 'Hide the AI review' : 'Show the AI review'}
            aria-expanded={showNote}
            onClick={() => setShowNote((v) => !v)}
            className={cn('shrink-0 pointer-coarse:h-11 pointer-coarse:w-11', showNote ? 'text-primary' : 'text-muted-foreground')}
          >
            {note ? <Sparkles className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />}
          </Button>
        )}
        {step.status === 'skipped' && !offToday && (
          <Button variant="ghost" size="sm" onClick={onUnskip} disabled={busy} className="shrink-0 text-muted-foreground">
            Undo
          </Button>
        )}
        {step.status === 'done' && !isDebrief && step.href !== '/today' && (
          <Button variant="ghost" size="sm" asChild className="shrink-0 text-muted-foreground">
            <Link to={step.href}>Open</Link>
          </Button>
        )}
      </div>
      {showNote && (
        <div className="pl-10">
          <StepNoteLine note={note} pending={notePending} />
        </div>
      )}
      {extra}
    </li>
  );
}

const isNoteId = (id: string): id is StepNoteId => (STEP_NOTE_IDS as readonly string[]).includes(id);

/**
 * The warm-up's piles (drill cards, Envelope, recall, reviews, Recognize) as a
 * quiet checklist, wherever the warm-up shows; the optional Recognize add-on's
 * AI note sits under it.
 */
function WarmupExtras({ state, className }: { state: TodayState; className?: string }) {
  const items = warmupItems(state);
  const recNote = !state.refresh.on && state.recognize ? state.stepNotes.recognize : undefined;
  const recPending = !state.refresh.on && !!state.recognize && state.aiPending.includes('recognize');
  if (!items.length && !recNote && !recPending) return null;
  return (
    <div className={cn('space-y-2', className)}>
      <WarmupChecklist items={items} />
      <StepNoteLine note={recNote} pending={recPending} />
    </div>
  );
}

/** A settings-style row: icon, label + one caption, one control. */
function OptionRow({ icon: Icon, label, caption, children }: { icon: typeof Timer; label: ReactNode; caption: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{caption}</p>
      </div>
      {children}
    </div>
  );
}

/**
 * "Pattern refresh", off: the 9-day plan (one pattern a day, then a mixed day)
 * and its Turn on. While it is on, its controls live in the Today card's
 * RefreshBanner ⋯ menu instead.
 */
function RefreshOption({ state, busy, onToggle }: { state: TodayState; busy: boolean; onToggle: (on: boolean) => void }) {
  const r = state.refresh;
  const recentlyFinished = r.finishedAt && Date.now() - Date.parse(r.finishedAt) < 4 * 86_400_000;
  const caption = recentlyFinished
    ? `Finished: all ${r.total} days done.`
    : r.completedThrough > 0 && r.completedThrough < r.total
      ? `9 days, one pattern a day. Resumes at day ${r.completedThrough + 1}.`
      : '9 days, one pattern a day.';
  return (
    <OptionRow icon={RefreshCw} label="Pattern refresh" caption={caption}>
      <Link to={helpHref('loop')} className="tap-link text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
        How it works
      </Link>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => onToggle(true)}>
        {r.completedThrough >= r.total ? 'Run it again' : 'Turn on'}
      </Button>
    </OptionRow>
  );
}

const usd = (n: number) => `$${n.toFixed(n < 0.01 ? 4 : 2)}`;

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
    <section id="debrief" aria-label="Debrief" className={cn(CARD, 'scroll-mt-4 space-y-4')}>
      <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
        <Sparkles className="h-4 w-4 text-primary" aria-hidden /> Debrief
      </h2>
      {!d ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Wins, fixes and tomorrow’s focus, in one short AI read.{' '}
            {state.aiReviews ? 'It writes itself when the day ends.' : 'AI reviews are off: run it by hand.'}
          </p>
          {state.aiPending.includes('debrief') ? (
            <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Writing your debrief…
            </p>
          ) : (
            <Button onClick={() => onRun(false)} disabled={busy} variant="secondary" className="gap-2">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {busy ? 'Reading your day…' : `Debrief me now (~${usd(state.debriefEstimateUsd)})`}
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-base font-semibold">{d.verdict}</p>
          {d.wins.length > 0 && (
            <div className="space-y-2">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-emerald-400">
                <Trophy className="h-4 w-4" aria-hidden /> Wins
              </h3>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {d.wins.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          {d.fixes.length > 0 && (
            <div className="space-y-2">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-amber-300">
                <Wrench className="h-4 w-4" aria-hidden /> Fixes
              </h3>
              <ul className="divide-y divide-border rounded-lg border border-border text-sm">
                {d.fixes.map((f, i) => (
                  <li key={i} className="space-y-1 px-3 py-2">
                    <p>{f.issue}</p>
                    <p className="text-muted-foreground">
                      <span className="font-medium text-foreground/90">Do:</span> {f.action}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <Target className="h-4 w-4 text-primary" aria-hidden /> Tomorrow
            </h3>
            <div className="flex flex-wrap gap-1.5 text-xs" title={d.tomorrowFocus.patterns.length ? "Tomorrow's problems lean toward these (lightly)." : undefined}>
              {d.tomorrowFocus.patterns.map((p) => (
                <span key={p} className="rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1">
                  {humanize(p)}
                </span>
              ))}
              {d.tomorrowFocus.mockKind && (
                <span className="rounded-full border border-border px-2.5 py-1">Mock: {mockKindInfo(d.tomorrowFocus.mockKind).label}</span>
              )}
              {!d.tomorrowFocus.patterns.length && !d.tomorrowFocus.mockKind && (
                <span className="text-muted-foreground">The usual adaptive plan.</span>
              )}
            </div>
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
                if (window.confirm(`Regenerate the debrief? One more model call (~${usd(state.debriefEstimateUsd)}).`)) {
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

/** "Show all steps" starts open only while the day is under way (started, not complete). */
export function stepsOpenByDefault(state: Pick<TodayState, 'completed' | 'current' | 'steps'>): boolean {
  if (state.current === null) return false;
  return state.completed > 0 || state.steps.some((s) => s.status === 'in-progress');
}

function scrollToDebrief() {
  document.getElementById('debrief')?.scrollIntoView({ behavior: 'smooth' });
}

/** The ONE thing to do now: the current step, big. */
export function CurrentStepCard({
  state,
  busy,
  onSkip,
}: {
  state: TodayState;
  busy: boolean;
  onSkip: (id: TodayStep['id']) => void;
}) {
  const step = state.current ? state.steps.find((s) => s.id === state.current) : undefined;
  if (!step) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-emerald-500/10 px-4 py-3">
        <Check className="h-5 w-5 text-emerald-400" aria-hidden />
        <p className="flex-1 text-sm font-semibold">Day complete. Nice work.</p>
        {state.steps.some((s) => s.id === 'debrief' && s.status !== 'locked') && (
          <Button variant="secondary" onClick={scrollToDebrief}>
            Read the debrief
          </Button>
        )}
      </div>
    );
  }
  const isDebrief = step.id === 'debrief';
  const index = state.steps.findIndex((s) => s.id === step.id);
  // The warm-up's checklist says what is in it; the detail line would repeat it.
  const checklist = step.id === 'warmup' && warmupItems(state).length > 0;
  return (
    <div className="space-y-4 rounded-lg border border-primary/50 bg-primary/5 p-4">
      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-primary">
          Next up · step {index + 1} of {state.steps.length}
        </p>
        <p className="text-lg font-semibold">{step.label}</p>
        {!checklist && <p className="text-sm text-muted-foreground">{step.detail}</p>}
      </div>
      {step.id === 'warmup' && <WarmupExtras state={state} />}
      <div className="flex flex-wrap items-center gap-2">
        {isDebrief ? (
          <Button size="lg" className="h-12 gap-2 px-6 text-base" onClick={scrollToDebrief}>
            Go to the debrief <ArrowRight className="h-5 w-5" />
          </Button>
        ) : (
          <>
            <Button asChild size="lg" className="h-12 gap-2 px-6 text-base">
              <Link to={step.href}>
                {step.status === 'in-progress' ? 'Continue' : 'Start'} <ArrowRight className="h-5 w-5" />
              </Link>
            </Button>
            <Button variant="ghost" onClick={() => onSkip(step.id)} disabled={busy} className="ml-auto gap-1.5 text-muted-foreground">
              <SkipForward className="h-4 w-4" /> Skip step
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function SpendLine({ state }: { state: TodayState }) {
  return (
    <p className="inline-flex flex-wrap items-center gap-1 text-xs text-muted-foreground" title={`${state.spend.todayCalls} AI calls today`}>
      <Coins className="h-3.5 w-3.5" aria-hidden /> AI ${state.spend.todayUsd.toFixed(2)} today · ${state.spend.monthUsd.toFixed(2)} this month
      {!state.aiReviews && <span className="ml-1 rounded bg-secondary px-1.5 py-0.5 text-[10px]">reviews off</span>}
    </p>
  );
}

const quietLink = 'tap-link inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline';

/** Everything else about today, behind one disclosure. */
function DayDetails({
  state,
  busy,
  act,
}: {
  state: TodayState;
  busy: boolean;
  act: (fn: () => Promise<TodayState>) => Promise<void>;
}) {
  const [open, setOpen] = useState(() => stepsOpenByDefault(state));
  const canEndEarly = !state.endedEarly && state.current !== null && state.current !== 'debrief';
  return (
    <div className="space-y-4 border-t border-border pt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="today-steps"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-center gap-2 rounded-md px-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        {open ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
        {open ? 'Hide steps' : 'Show all steps'}
        {/* The day at a glance: one dot per step. */}
        <span className="ml-auto flex items-center gap-1" aria-hidden>
          {state.steps.map((s) => (
            <span
              key={s.id}
              className={cn(
                'h-2 w-2 rounded-full',
                s.status === 'done' && 'bg-emerald-400',
                (s.status === 'current' || s.status === 'in-progress') && 'bg-primary',
                (s.status === 'skipped' || s.status === 'locked' || s.status === 'todo') && 'bg-secondary',
              )}
            />
          ))}
        </span>
        <span className="sr-only">
          {state.completed} of {state.total} done
        </span>
      </button>
      {open && (
        <div id="today-steps" className="space-y-4">
          <ol className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {state.steps.map((s, i) => (
              <StepRow
                key={s.id}
                step={s}
                index={i}
                busy={busy}
                onUnskip={() => act(() => skipTodayStep(s.id, false))}
                offToday={!!s.off || (state.quick && QUICK_OFF_STEPS.includes(s.id) && s.status === 'skipped')}
                lockedText={state.refresh.on ? 'Unlocks after today’s pattern steps.' : undefined}
                note={isNoteId(s.id) ? state.stepNotes[s.id] : undefined}
                notePending={isNoteId(s.id) && state.aiPending.includes(s.id)}
                extra={
                  s.id === 'warmup' && s.id !== state.current && (warmupItems(state).length > 0 || state.stepNotes.recognize) ? (
                    <WarmupExtras state={state} className="pl-10" />
                  ) : undefined
                }
              />
            ))}
          </ol>

          {!state.refresh.on && (
            <div className="divide-y divide-border rounded-lg border border-border">
              <RefreshOption state={state} busy={busy} onToggle={(on) => void act(() => setTodayRefresh(on))} />
              <OptionRow
                icon={Timer}
                label={<>30-min day {state.quick && <span className="text-xs font-normal text-emerald-400">on</span>}</>}
                caption="Warm-up, one problem, the debrief. Streak kept."
              >
                <Button size="sm" variant={state.quick ? 'outline' : 'secondary'} disabled={busy} onClick={() => act(() => setTodayQuick(!state.quick))}>
                  {state.quick ? 'Back to the full day' : 'Short on time'}
                </Button>
              </OptionRow>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <Link to="/patterns" className={quietLink}>
              <Shapes className="h-3.5 w-3.5" aria-hidden /> Pattern shapes
            </Link>
            {!state.refresh.on && (
              <Link to="/stories" className={quietLink} title="Draft a behavioral story by voice">
                <Mic className="h-3.5 w-3.5" aria-hidden /> Story forge
              </Link>
            )}
            {!state.refresh.on && (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <MessagesSquare className="h-3.5 w-3.5" aria-hidden /> Today’s mock: {mockKindInfo(state.mockKind).label}
              </span>
            )}
            {canEndEarly && (
              <button
                type="button"
                disabled={busy}
                className={quietLink}
                onClick={() => {
                  if (window.confirm('End the day early? Unfinished steps are skipped and the debrief unlocks.')) {
                    void act(() => endTodayEarly(true));
                  }
                }}
              >
                <Square className="h-3.5 w-3.5" aria-hidden /> End day early
              </button>
            )}
            {state.endedEarly && state.current !== null && (
              <button type="button" disabled={busy} className={quietLink} onClick={() => act(() => endTodayEarly(false))}>
                <Play className="h-3.5 w-3.5" aria-hidden /> Resume the day
              </button>
            )}
            <span className="ml-auto">
              <SpendLine state={state} />
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/** "Coming up": interview loops and the review problems due. */
function ComingUp({
  state,
  week,
  mockLine,
  onLoopsChange,
}: {
  state: TodayState;
  week: WeeklyResponse | null;
  /** The mock nudge when it is a quiet line (it joins the other one-liners here). */
  mockLine?: ReactNode;
  onLoopsChange: () => void;
}) {
  const due = week ? week.reviewDue.reduce((n, r) => n + r.due, 0) : 0;
  return (
    <section aria-label="Coming up" className="space-y-2">
      <h2 className="flex items-center gap-2 px-1 text-sm font-semibold text-muted-foreground">
        <CalendarClock className="h-4 w-4" aria-hidden /> Coming up
      </h2>
      <InterviewsPanel today={state.date} onChange={onLoopsChange} />
      {week && (
        <p className="flex min-h-11 items-center gap-2 px-1 text-sm">
          <Repeat className="h-4 w-4 text-muted-foreground" aria-hidden />
          {due === 0 ? (
            <span className="text-muted-foreground">No reviews due. All caught up.</span>
          ) : (
            <>
              <span>
                <span className="font-semibold">{due}</span> review {due === 1 ? 'problem' : 'problems'} due
              </span>
              <Link to="/grind" className="tap-link ml-auto text-primary underline-offset-4 hover:underline">
                Grind them →
              </Link>
            </>
          )}
        </p>
      )}
      {mockLine}
    </section>
  );
}

export function HomePage() {
  const [state, setState] = useState<TodayState | null>(null);
  const [week, setWeek] = useState<WeeklyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [debriefBusy, setDebriefBusy] = useState(false);

  useEffect(() => {
    getToday()
      .then(setState)
      .catch((e: Error) => setError(e.message));
    // "This week" is extra: if it fails, Home still shows today.
    getWeekly()
      .then(setWeek)
      .catch(() => setWeek(null));
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

  // Mocks: a card when one is owed; otherwise (one done, or the refresh is on,
  // which replaces mocks) a quiet line with the other one-liners in Coming up.
  const mockRefresh = state.refresh.on ? state.refresh : null;
  const mockLine = week && mockNudgeIsLine(week.mocks, mockRefresh) ? <MockNudge mocks={week.mocks} refresh={mockRefresh} /> : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-4 p-4 sm:p-6">
        <Header state={state}>
          {state.refresh.on && (
            <RefreshBanner r={state.refresh} busy={busy} onTurnOff={() => void act(() => setTodayRefresh(false))} />
          )}
          <CurrentStepCard state={state} busy={busy} onSkip={(id) => void act(() => skipTodayStep(id, true))} />
          {error && <p className="text-sm text-destructive-foreground">{error}</p>}
          <DayDetails state={state} busy={busy} act={act} />
        </Header>

        <LeverLine areas={state.readiness} />

        {week && (
          <div className="grid gap-4 md:grid-cols-2">
            <WeekPanel week={week} />
            <TargetCard target={week.target} />
          </div>
        )}

        {week && !mockLine && <MockNudge mocks={week.mocks} />}

        <ComingUp state={state} week={week} mockLine={mockLine} onLoopsChange={() => void getToday().then(setState).catch(() => undefined)} />

        <div className="flex justify-end">
          <Link to="/progress" className="tap-link text-sm text-primary underline-offset-4 hover:underline">
            See full progress →
          </Link>
        </div>

        <DebriefPanel state={state} busy={debriefBusy} onRun={runDebrief} />
        <div className="pb-6" />
      </div>
    </div>
  );
}

/** Kept for old imports: /today renders the same page. */
export const TodayPage = HomePage;
