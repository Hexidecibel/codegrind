// =============================================================================
// RecognizePage — read the problem, call the pattern, sketch the approach
// =============================================================================
// For rusty days: no editor, no tests. Per card: statement only → pick the
// pattern (4 choices, auto-checked) + 1-3 sentences of approach/complexity →
// Reveal (pattern, the tell, skeleton, pitfalls, cached insight/complexity;
// full code behind a toggle) → grade got / shaky / missed. With "AI reviews"
// on, the AI check runs on reveal (one small call, cached per answer) and its
// verdict pre-selects the grade; otherwise it is a button.
//
// Keys: 1-4 pick · Ctrl/⌘+Enter reveal · after reveal: Enter confirms the AI's
// grade, g / s / m grade, c show code. Not a solve: nothing here moves tier credit.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Code2,
  Eye,
  Lightbulb,
  Loader2,
  ScanSearch,
  Sparkles,
  Timer,
  X,
} from 'lucide-react';
import type { GapCardGrade } from '@/shared/gap-cards';
import type { Topic } from '@/shared/types';
import {
  DEFAULT_RECOGNIZE_SIZE,
  RECOGNIZE_SIZES,
  RECOGNIZE_SOFT_SECONDS,
  type RecognizeCard,
  type RecognizeCheck,
  type RecognizeCode,
  type RecognizeReveal,
} from '@/shared/recognize';
import {
  checkRecognize,
  getRecognizeSession,
  gradeRecognize,
  revealRecognize,
  showRecognizeCode,
} from '@/client/lib/api';
import { humanize } from '@/client/lib/format';
import { unshownExamples } from '@/client/lib/examples';
import { todayStepFrom } from '@/client/lib/today-flow';
import { patternForTopic, patternHref } from '@/shared/pattern-shapes';
import { TodayNextBar } from '@/client/components/TodayNextBar';
import { Button } from '@/client/components/ui/button';
import { cn } from '@/lib/utils';

interface Done {
  problemId: string;
  title: string;
  topic: Topic;
  patternCorrect: boolean;
  grade: GapCardGrade;
  outcome: string;
}

const GRADE_META: Record<GapCardGrade, { label: string; key: string; cls: string }> = {
  got: { label: 'Got it', key: 'g', cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20' },
  shaky: { label: 'Shaky', key: 's', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20' },
  missed: { label: 'Missed', key: 'm', cls: 'border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20' },
};

const inField = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);

function useElapsed(startedAt: number, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

function SoftTimer({ startedAt, running }: { startedAt: number; running: boolean }) {
  const s = useElapsed(startedAt, running);
  const over = s > RECOGNIZE_SOFT_SECONDS;
  return (
    <span
      className={cn('inline-flex items-center gap-1 text-xs tabular-nums', over ? 'text-amber-300' : 'text-muted-foreground')}
      title="A soft 2-minute target — nothing happens when it runs out"
    >
      <Timer className="h-3.5 w-3.5" />
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')} / 2:00
    </span>
  );
}

function Statement({ card }: { card: RecognizeCard }) {
  const examples = unshownExamples(card.prompt, card.examples);
  return (
    <div className="space-y-3">
      <article className="prose-cg">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{card.prompt}</ReactMarkdown>
      </article>
      {examples.slice(0, 2).map((ex, i) => (
        <div key={i} className="rounded-lg border border-border bg-muted/20 p-3 font-mono text-[13px]">
          <div className="break-all"><span className="text-muted-foreground">Input: </span>{ex.input}</div>
          <div className="break-all"><span className="text-muted-foreground">Output: </span>{ex.output}</div>
        </div>
      ))}
      {card.constraints.length > 0 && (
        <ul className="space-y-0.5 text-sm text-muted-foreground">
          {card.constraints.map((c, i) => (
            <li key={i}>
              • <code className="font-mono text-[13px]">{c}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RevealPanel({
  reveal,
  code,
  codeBusy,
  codeOpen,
  onCode,
  check,
}: {
  reveal: RecognizeReveal;
  code: RecognizeCode | null;
  codeBusy: boolean;
  codeOpen: boolean;
  onCode: () => void;
  check: RecognizeCheck | null;
}) {
  const note = check?.note.keyInsight ? check.note : reveal.note;
  return (
    <section className="space-y-4 rounded-xl border border-primary/30 bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        {reveal.patternCorrect ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-sm font-semibold text-emerald-300">
            <Check className="h-4 w-4" /> {humanize(reveal.topic)}
          </span>
        ) : (
          <>
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2.5 py-1 text-sm text-rose-300 line-through">
              <X className="h-4 w-4" /> {reveal.picked ? humanize(reveal.picked) : 'no pick'}
            </span>
            <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-sm font-semibold text-emerald-300">
              {humanize(reveal.topic)}
            </span>
          </>
        )}
        <span className="text-sm text-muted-foreground">· {reveal.title}</span>
        {/* Only after the reveal: before it, this would name the answer. */}
        {patternForTopic(reveal.topic) && (
          <Link
            to={patternHref(patternForTopic(reveal.topic)!.id)}
            className="ml-auto text-xs text-primary underline-offset-4 hover:underline"
          >
            {patternForTopic(reveal.topic)!.title} shape →
          </Link>
        )}
      </div>

      {note && (
        <div className="space-y-1">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold"><Lightbulb className="h-4 w-4 text-amber-300" /> Key insight</h3>
          <p className="text-sm">{note.keyInsight}</p>
          {(note.time || note.space) && (
            <p className="text-sm text-muted-foreground">
              Optimal: <span className="font-mono">{note.time || '?'}</span> time,{' '}
              <span className="font-mono">{note.space || '?'}</span> space
            </p>
          )}
        </div>
      )}

      {reveal.primer && (
        <>
          <div className="space-y-1">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold"><Eye className="h-4 w-4 text-primary" /> The tells for {humanize(reveal.topic)}</h3>
            <ul className="list-disc space-y-0.5 pl-5 text-sm">
              {reveal.primer.cues.map((c, i) => <li key={i}>{c}</li>)}
            </ul>
            {!note && (
              <p className="pt-1 text-xs text-muted-foreground">
                Canonical: <span className="font-medium text-foreground/90">{reveal.primer.example.title}</span> — {reveal.primer.example.insight}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Skeleton</h3>
            <pre className="overflow-x-auto rounded-lg border border-border bg-muted/30 p-3 text-[12.5px] leading-relaxed"><code>{reveal.primer.skeleton}</code></pre>
          </div>
          {reveal.primer.pitfalls.length > 0 && (
            <div className="space-y-1">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold"><AlertTriangle className="h-4 w-4 text-amber-300" /> Pitfalls</h3>
              <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
                {reveal.primer.pitfalls.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            </div>
          )}
        </>
      )}

      <div className="space-y-2">
        <Button variant="outline" size="sm" onClick={onCode} disabled={codeBusy} className="gap-1.5">
          {codeBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Code2 className="h-4 w-4" />}
          {codeOpen ? 'Hide code' : 'Show code'} <kbd className="ml-1 text-[10px] text-muted-foreground">c</kbd>
        </Button>
        {codeOpen && code && (
          <pre className="max-h-[50vh] overflow-auto rounded-lg border border-border bg-muted/30 p-3 text-[12.5px] leading-relaxed">
            <code>{code.referenceSolution}</code>
          </pre>
        )}
      </div>
    </section>
  );
}

function CheckPanel({ check }: { check: RecognizeCheck }) {
  const tone =
    check.verdict === 'correct' ? 'text-emerald-300' : check.verdict === 'partly' ? 'text-amber-300' : 'text-rose-300';
  return (
    <section className="space-y-2 rounded-xl border border-border bg-card p-4 text-sm">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" />
        <span className={cn('font-semibold capitalize', tone)}>{check.verdict}</span>
        {check.costUsd != null && <span className="ml-auto text-xs text-muted-foreground">${check.costUsd.toFixed(4)}</span>}
      </div>
      {check.missing.length > 0 && (
        <div>
          <span className="text-muted-foreground">Missing: </span>
          {check.missing.join(' · ')}
        </div>
      )}
      {check.edgeCaseThatBites && (
        <div>
          <span className="text-muted-foreground">Edge case that bites: </span>
          {check.edgeCaseThatBites}
        </div>
      )}
      {check.oneLineFix && (
        <div>
          <span className="text-muted-foreground">Fix: </span>
          {check.oneLineFix}
        </div>
      )}
    </section>
  );
}

function Summary({ done, onAgain }: { done: Done[]; onAgain: () => void }) {
  const right = done.filter((d) => d.patternCorrect).length;
  const got = done.filter((d) => d.grade === 'got').length;
  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
      <h2 className="text-lg font-bold">Session done</h2>
      <p className="text-sm">
        Pattern right on <span className="font-semibold">{right}/{done.length}</span> · approach solid on{' '}
        <span className="font-semibold">{got}/{done.length}</span>
      </p>
      <ul className="space-y-1.5 text-sm">
        {done.map((d) => (
          <li key={d.problemId} className="flex flex-wrap items-center gap-2">
            <span className={cn('h-2 w-2 rounded-full', d.grade === 'got' ? 'bg-emerald-400' : d.grade === 'shaky' ? 'bg-amber-400' : 'bg-rose-400')} />
            <span>{d.title}</span>
            <span className="text-muted-foreground">· {humanize(d.topic)}</span>
            <span className="ml-auto text-xs text-muted-foreground">{d.outcome}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onAgain} className="gap-1.5">
          Another round <ArrowRight className="h-4 w-4" />
        </Button>
        <Button variant="ghost" asChild>
          <Link to="/grind">Go grind</Link>
        </Button>
      </div>
    </section>
  );
}

export function RecognizePage() {
  const location = useLocation();
  const todayStep = todayStepFrom(location.search);
  const presetN = useMemo(() => {
    const n = Number(new URLSearchParams(location.search).get('n'));
    return (RECOGNIZE_SIZES as readonly number[]).includes(n) ? n : null;
  }, [location.search]);

  const [size, setSize] = useState<number>(presetN ?? DEFAULT_RECOGNIZE_SIZE);
  const [cards, setCards] = useState<RecognizeCard[] | null>(null);
  const [dueLeft, setDueLeft] = useState(0);
  const [idx, setIdx] = useState(0);
  const [done, setDone] = useState<Done[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // per-card
  const [picked, setPicked] = useState<Topic | null>(null);
  const [approach, setApproach] = useState('');
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [reveal, setReveal] = useState<RecognizeReveal | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [code, setCode] = useState<RecognizeCode | null>(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const [codeBusy, setCodeBusy] = useState(false);
  const [check, setCheck] = useState<RecognizeCheck | null>(null);
  const [checkBusy, setCheckBusy] = useState(false);
  const [grading, setGrading] = useState(false);
  const approachRef = useRef<HTMLTextAreaElement>(null);

  const card = cards?.[idx] ?? null;

  const resetCard = useCallback(() => {
    setPicked(null);
    setApproach('');
    setStartedAt(Date.now());
    setReveal(null);
    setCode(null);
    setCodeOpen(false);
    setCheck(null);
    setError(null);
  }, []);

  const start = useCallback(
    async (n: number) => {
      setLoading(true);
      setError(null);
      try {
        const s = await getRecognizeSession(n);
        setCards(s.cards);
        setDueLeft(s.dueLeft);
        setIdx(0);
        setDone([]);
        resetCard();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [resetCard],
  );

  // Opened from Today with ?n= → straight in.
  useEffect(() => {
    if (presetN) void start(presetN);
  }, [presetN, start]);

  const doReveal = useCallback(async () => {
    if (!card || reveal || revealing) return;
    setRevealing(true);
    setError(null);
    let r: RecognizeReveal | null = null;
    try {
      r = await revealRecognize(card.problemId, picked);
      setReveal(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRevealing(false);
    }
    // "AI reviews" on: check the approach automatically (cached per answer, so
    // an identical answer is free). Its verdict pre-selects the grade.
    if (r?.autoCheck && approach.trim()) {
      setCheckBusy(true);
      try {
        setCheck(await checkRecognize(card.problemId, picked, approach));
      } catch (e) {
        setError(`AI check unavailable (${(e as Error).message}) — grade it yourself.`);
      } finally {
        setCheckBusy(false);
      }
    }
  }, [approach, card, picked, reveal, revealing]);

  const toggleCode = useCallback(async () => {
    if (!card || !reveal) return;
    if (codeOpen) return setCodeOpen(false);
    if (code) return setCodeOpen(true);
    if (
      !card.codeFree &&
      !window.confirm(
        "You haven't ground this problem yet. Seeing the reference code marks it as revealed: if you grind it later, that solve counts as assisted. Show it?",
      )
    ) {
      return;
    }
    setCodeBusy(true);
    try {
      setCode(await showRecognizeCode(card.problemId));
      setCodeOpen(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCodeBusy(false);
    }
  }, [card, code, codeOpen, reveal]);

  const runCheck = useCallback(async () => {
    if (!card || !reveal || checkBusy) return;
    setCheckBusy(true);
    setError(null);
    try {
      setCheck(await checkRecognize(card.problemId, picked, approach));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCheckBusy(false);
    }
  }, [approach, card, checkBusy, picked, reveal]);

  const doGrade = useCallback(
    async (selfGrade: GapCardGrade) => {
      if (!card || !reveal || grading) return;
      setGrading(true);
      setError(null);
      try {
        const r = await gradeRecognize({
          problemId: card.problemId,
          picked,
          approach,
          selfGrade,
          codeShown: !!code,
          aiVerdict: check?.verdict ?? null,
          durationMs: Date.now() - startedAt,
        });
        setDone((d) => [
          ...d,
          { problemId: card.problemId, title: reveal.title, topic: reveal.topic, patternCorrect: reveal.patternCorrect, grade: r.grade, outcome: r.outcome },
        ]);
        setIdx((i) => i + 1);
        resetCard();
        window.scrollTo({ top: 0 });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setGrading(false);
      }
    },
    [approach, card, check, code, grading, picked, resetCard, reveal, startedAt],
  );

  // Keyboard flow.
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void doReveal();
        return;
      }
      if (inField(e.target) || e.altKey || e.ctrlKey || e.metaKey) return;
      if (!reveal) {
        const n = Number(e.key);
        if (n >= 1 && n <= card.choices.length) {
          setPicked(card.choices[n - 1]);
          approachRef.current?.focus();
          e.preventDefault();
        }
        return;
      }
      const k = e.key.toLowerCase();
      if (e.key === 'Enter' && check) {
        e.preventDefault();
        void doGrade(check.suggested);
        return;
      }
      if (k === 'g') void doGrade('got');
      else if (k === 's') void doGrade('shaky');
      else if (k === 'm') void doGrade('missed');
      else if (k === 'c') void toggleCode();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [card, check, doGrade, doReveal, reveal, toggleCode]);

  const total = cards?.length ?? 0;
  const finished = cards !== null && idx >= total;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-4 p-4 pb-16 sm:p-6">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <ScanSearch className="h-6 w-6 text-primary" /> Recognize
          </h1>
          {cards && !finished && (
            <span className="text-sm text-muted-foreground">
              Card {idx + 1} of {total}
              {card?.due ? ' · due again' : ''}
            </span>
          )}
          {card && !reveal && <span className="ml-auto"><SoftTimer startedAt={startedAt} running /></span>}
        </header>

        {todayStep && <TodayNextBar here={todayStep} screenPath="/recognize" refreshKey={done.length} />}

        {error && <p className="text-sm text-destructive-foreground">{error}</p>}

        {!cards && (
          <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Read a problem, call the pattern, sketch the approach in a sentence or three — then see the reference
              approach and grade yourself. No code to write. Free; misses come back on a spaced schedule. Doesn't
              count as a solve.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {RECOGNIZE_SIZES.map((n) => (
                <Button
                  key={n}
                  variant={size === n ? 'default' : 'outline'}
                  onClick={() => setSize(n)}
                  disabled={loading}
                >
                  ×{n}
                </Button>
              ))}
              <Button onClick={() => start(size)} disabled={loading} className="ml-auto gap-1.5">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                Start
              </Button>
            </div>
          </section>
        )}

        {cards && total === 0 && (
          <p className="text-sm text-muted-foreground">
            The problem bank is empty — grind or seed a few problems first.
          </p>
        )}

        {finished && total > 0 && (
          <>
            <Summary done={done} onAgain={() => start(size)} />
            {dueLeft > 0 && <p className="text-xs text-muted-foreground">{dueLeft} more recognize card{dueLeft === 1 ? '' : 's'} due.</p>}
          </>
        )}

        {card && (
          <>
            <section className="rounded-xl border border-border bg-card p-4">
              <div className="mb-2 text-xs capitalize text-muted-foreground">{card.difficulty}</div>
              <Statement card={card} />
            </section>

            <section className="space-y-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Pattern">
                {card.choices.map((t, i) => {
                  const isPicked = picked === t;
                  const isAnswer = reveal && t === reveal.topic;
                  return (
                    <button
                      key={t}
                      type="button"
                      role="radio"
                      aria-checked={isPicked}
                      disabled={!!reveal}
                      onClick={() => setPicked(t)}
                      className={cn(
                        'flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
                        isPicked ? 'border-primary bg-primary/10' : 'border-border hover:bg-secondary',
                        reveal && isAnswer && 'border-emerald-500/60 bg-emerald-500/10',
                        reveal && isPicked && !isAnswer && 'border-rose-500/60 bg-rose-500/10',
                      )}
                    >
                      <kbd className="rounded border border-border px-1.5 text-[11px] text-muted-foreground">{i + 1}</kbd>
                      {humanize(t)}
                    </button>
                  );
                })}
              </div>
              <textarea
                ref={approachRef}
                value={approach}
                onChange={(e) => setApproach(e.target.value)}
                readOnly={!!reveal}
                rows={3}
                placeholder="Approach in 1–3 sentences, plus time/space (e.g. 'Sort, then two pointers from both ends… O(n log n) / O(1)')"
                className="w-full resize-y rounded-lg border border-border bg-background p-3 text-sm outline-none focus:border-primary"
              />
              {!reveal && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">1–4 pick · Ctrl/⌘+Enter reveal</span>
                  <Button onClick={doReveal} disabled={revealing} className="ml-auto gap-1.5">
                    {revealing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                    Reveal
                  </Button>
                </div>
              )}
            </section>

            {reveal && (
              <>
                <RevealPanel
                  reveal={reveal}
                  code={code}
                  codeBusy={codeBusy}
                  codeOpen={codeOpen}
                  onCode={toggleCode}
                  check={check}
                />
                {check && <CheckPanel check={check} />}
                <section className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">How was your approach?</span>
                    {checkBusy && !check && (
                      <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> AI checking your approach…
                      </span>
                    )}
                    {check && (
                      <span className="ml-auto text-xs text-muted-foreground">
                        AI suggests <b>{GRADE_META[check.suggested].label}</b> — Enter confirms, or pick another
                        {check.cached ? ' · cached, free' : ''}
                      </span>
                    )}
                    {!check && !checkBusy && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={runCheck}
                        disabled={checkBusy || !approach.trim()}
                        className="ml-auto gap-1.5"
                        title={approach.trim() ? 'One small model call' : 'Write an approach first'}
                      >
                        {checkBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                        AI check my approach
                        {reveal.checkEstimateUsd != null ? ` (~$${reveal.checkEstimateUsd.toFixed(4)})` : ' (local model)'}
                      </Button>
                    )}
                  </div>
                  {!reveal.patternCorrect && (
                    <p className="text-xs text-muted-foreground">Wrong pattern — this card goes on the ladder as a miss whatever you pick.</p>
                  )}
                  <div className="grid grid-cols-3 gap-2">
                    {(['got', 'shaky', 'missed'] as const).map((g) => (
                      <button
                        key={g}
                        type="button"
                        disabled={grading}
                        onClick={() => doGrade(g)}
                        className={cn(
                          'min-h-11 rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
                          GRADE_META[g].cls,
                          check?.suggested === g && 'ring-2 ring-primary',
                        )}
                      >
                        {check?.suggested === g ? 'Confirm: ' : ''}
                        {GRADE_META[g].label} <kbd className="ml-1 text-[10px] opacity-70">{GRADE_META[g].key}</kbd>
                      </button>
                    ))}
                  </div>
                </section>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
