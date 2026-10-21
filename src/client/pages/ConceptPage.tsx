// =============================================================================
// ConceptPage — the daily concept rep and the AI-systems track (Phase H3)
// =============================================================================
//   /concept               today's rep: (teach-first primer when the concept is
//                          new) → the interviewer's question → explain it by
//                          dictation (~2 min) → ONE graded call → hit / missed,
//                          the model answer, a follow-up. Misses become drill cards.
//   /concepts              the track: every concept's learning state and the
//                          AI-prompt gate ("5 AI concepts known unlocks AI mocks").
//   /concepts/:concept     one AI-systems lesson (generated once, then free).

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ArrowRight, BookOpen, Check, Lightbulb, Loader2, Mic, X } from 'lucide-react';
import type { ConceptLesson, ConceptRepView, ConceptToday, ConceptTrack, ConceptLearningState } from '@/shared/concepts';
import { getConceptLesson, getConceptToday, getConceptTrack, gradeConcept, learnConcept } from '@/client/lib/api';
import { todayStepFrom } from '@/client/lib/today-flow';
import { TodayNextBar } from '@/client/components/TodayNextBar';
import { Button } from '@/client/components/ui/button';
import { cn } from '@/lib/utils';

const STATE_LABEL: Record<ConceptLearningState, string> = { new: 'new', learning: 'learning', known: 'known' };
const STATE_CLASS: Record<ConceptLearningState, string> = {
  new: 'bg-secondary text-muted-foreground',
  learning: 'bg-amber-500/15 text-amber-300',
  known: 'bg-emerald-500/15 text-emerald-400',
};

function StateChip({ state }: { state: ConceptLearningState }) {
  return <span className={cn('rounded-full px-2 py-0.5 text-[11px]', STATE_CLASS[state])}>{STATE_LABEL[state]}</span>;
}

const GRADE_CLASS = {
  got: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  shaky: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  missed: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
} as const;

function RepResult({ rep }: { rep: ConceptRepView }) {
  return (
    <div className="space-y-3">
      <div className={cn('rounded-lg border px-3 py-2', GRADE_CLASS[rep.grade])}>
        <p className="flex items-center gap-2 font-medium">
          {rep.grade === 'got' ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
          {rep.grade === 'got' ? 'Got it' : rep.grade === 'shaky' ? 'Shaky' : 'Missed'} · {rep.label}
        </p>
        {rep.why && <p className="mt-1 text-sm text-foreground/90">{rep.why}</p>}
        {rep.cardId !== null && (
          <p className="mt-1 text-xs text-muted-foreground">On your drill cards — it comes back tomorrow in the warm-up.</p>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border px-3 py-2 text-sm">
          <p className="mb-1 text-xs font-medium text-emerald-400">You covered</p>
          {rep.hit.length ? (
            <ul className="list-disc space-y-0.5 pl-4">{rep.hit.map((h) => <li key={h}>{h}</li>)}</ul>
          ) : (
            <p className="text-muted-foreground">Nothing from the rubric yet.</p>
          )}
        </div>
        <div className="rounded-lg border border-border px-3 py-2 text-sm">
          <p className="mb-1 text-xs font-medium text-rose-300">Missing</p>
          {rep.missed.length ? (
            <ul className="list-disc space-y-0.5 pl-4">{rep.missed.map((h) => <li key={h}>{h}</li>)}</ul>
          ) : (
            <p className="text-muted-foreground">Nothing important.</p>
          )}
        </div>
      </div>
      {rep.modelAnswer && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <p className="mb-1 text-xs font-medium text-primary">What a Staff answer sounds like</p>
          <p className="leading-relaxed">{rep.modelAnswer}</p>
        </div>
      )}
      {rep.followUp && (
        <p className="text-sm">
          <span className="text-muted-foreground">The interviewer would ask next: </span>
          {rep.followUp}
        </p>
      )}
      {rep.costUsd !== null && rep.costUsd > 0 && (
        <p className="text-[11px] text-muted-foreground">Graded for ${rep.costUsd.toFixed(3)}.</p>
      )}
    </div>
  );
}

export function ConceptPage() {
  const location = useLocation();
  const todayStep = todayStepFrom(location.search);
  const [day, setDay] = useState<ConceptToday | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [primerRead, setPrimerRead] = useState(false);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConceptRepView | null>(null);
  const [started, setStarted] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const answerRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async (next = false) => {
    setError(null);
    try {
      const d = await getConceptToday(next);
      setDay(d);
      setResult(null);
      setAnswer('');
      setPrimerRead(false);
      setStarted(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A soft 2-minute clock once the question is showing.
  useEffect(() => {
    if (started === null || result) return;
    const t = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, [started, result]);

  const showQuestion = !!day && (!day.primer || primerRead);
  useEffect(() => {
    if (showQuestion && started === null && day && !day.today.some((r) => r.concept === day.concept)) {
      setStarted(Date.now());
      answerRef.current?.focus();
    }
  }, [showQuestion, started, day]);

  const ackPrimer = async () => {
    if (!day) return;
    setPrimerRead(true);
    try {
      await learnConcept(day.concept, 'primer');
    } catch {
      /* grading marks it learned too */
    }
  };

  const submit = async () => {
    if (!day || !answer.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await gradeConcept({ concept: day.concept, promptIdx: day.promptIdx, answer, primed: !!day.primer });
      setResult(r);
      setDay(await getConceptToday());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  void tick;
  const elapsed = started ? Math.floor((Date.now() - started) / 1000) : 0;
  const doneThis = day ? day.today.find((r) => r.concept === day.concept) ?? null : null;
  const shown = result ?? doneThis;
  const canAnother = !!day && !!shown && day.doneToday < day.maxPerDay;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-4 p-4 pb-16 sm:p-6">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Lightbulb className="h-6 w-6 text-primary" /> Concept rep
          </h1>
          <Link to="/concepts" className="text-sm text-muted-foreground underline underline-offset-4">
            AI-systems track
          </Link>
          <Link to="/stories" className="text-sm text-muted-foreground underline underline-offset-4">
            Story forge
          </Link>
        </header>

        {todayStep && <TodayNextBar here={todayStep} screenPath="/concept" refreshKey={day?.doneToday ?? 0} />}
        {error && <p className="text-sm text-destructive-foreground">{error}</p>}
        {!day && !error && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}

        {day && (
          <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold">{day.label}</span>
              <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
                {day.category === 'ai' ? 'AI systems' : 'system design'}
              </span>
              <StateChip state={day.state} />
              <span className="text-xs text-muted-foreground">· {day.why}</span>
              {day.lessonHref && (
                <Link to={day.lessonHref} className="ml-auto inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline">
                  <BookOpen className="h-3.5 w-3.5" /> Full lesson
                </Link>
              )}
            </div>

            {day.primer && !primerRead && !shown && (
              <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-primary">First time — a 2-minute read, then explain it back</p>
                <p className="leading-relaxed">{day.primer.primer}</p>
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Key points</p>
                  <ul className="list-disc space-y-1 pl-4">{day.primer.keyPoints.map((k) => <li key={k}>{k}</li>)}</ul>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Worked example</p>
                  <p className="leading-relaxed">{day.primer.example}</p>
                </div>
                <p className="text-muted-foreground">
                  <span className="font-medium text-foreground">The common mistake: </span>
                  {day.primer.mistake}
                </p>
                <Button onClick={() => void ackPrimer()} className="gap-1.5">
                  Got it — ask me <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
            )}

            {showQuestion && (
              <>
                <p className="text-lg leading-relaxed">“{day.question}”</p>
                {!shown && (
                  <div className="space-y-2">
                    <label htmlFor="concept-answer" className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      <Mic className="h-4 w-4" /> Explain it as you would to the interviewer — dictate it, about 2 minutes.
                      {started && (
                        <span className={cn('ml-auto tabular-nums', elapsed > 150 && 'text-amber-300')}>
                          {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
                        </span>
                      )}
                    </label>
                    <textarea
                      id="concept-answer"
                      ref={answerRef}
                      value={answer}
                      onChange={(e) => setAnswer(e.target.value)}
                      rows={9}
                      placeholder="Start talking…"
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm leading-relaxed outline-none focus:border-primary"
                    />
                    <div className="flex flex-wrap items-center gap-3">
                      <Button onClick={() => void submit()} disabled={busy || !answer.trim()} className="gap-1.5">
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                        {busy ? 'Grading…' : 'Grade my answer'}
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        One graded call{day.estimateUsd !== null ? ` (~$${day.estimateUsd.toFixed(2)})` : ''} against a rubric
                        for this concept. Say “I don’t know” to see the answer for free.
                      </span>
                    </div>
                  </div>
                )}
              </>
            )}

            {shown && (
              <>
                {!result && <p className="text-xs text-muted-foreground">Today's rep is done:</p>}
                {shown.answer && !result && (
                  <details className="text-sm text-muted-foreground">
                    <summary className="cursor-pointer">Your answer</summary>
                    <p className="mt-1 whitespace-pre-wrap">{shown.answer}</p>
                  </details>
                )}
                <RepResult rep={shown} />
                <div className="flex flex-wrap gap-2">
                  {canAnother && (
                    <Button variant="outline" onClick={() => void load(true)}>
                      Another concept ({day.doneToday}/{day.maxPerDay} today)
                    </Button>
                  )}
                  {todayStep && (
                    <Button asChild>
                      <Link to="/today">Back to Today</Link>
                    </Button>
                  )}
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

export function ConceptTrackPage() {
  const [track, setTrack] = useState<ConceptTrack | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getConceptTrack().then(setTrack).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  const ai = track?.items.filter((i) => i.category === 'ai') ?? [];
  const classic = track?.items.filter((i) => i.category === 'classic') ?? [];
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-4 p-4 pb-16 sm:p-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <BookOpen className="h-6 w-6 text-primary" /> AI-systems track
        </h1>
        {error && <p className="text-sm text-destructive-foreground">{error}</p>}
        {track && (
          <>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Learn each concept, then prove it on a cold concept rep at least two days later. A concept is{' '}
              <span className="text-emerald-400">known</span> once that cold rep is graded “got”. AI system-design prompts join
              the random mock pick at {track.unlockAt} known —{' '}
              <span className={track.aiUnlocked ? 'text-emerald-400' : 'text-foreground'}>
                {track.knownAi} of {track.unlockAt}
                {track.aiUnlocked ? ', unlocked' : ''}
              </span>
              .{track.aiFocus ? ' An AI-focused interview is coming up: concept reps lean AI.' : ''}
            </p>
            <ol className="space-y-2">
              {ai.map((i, n) => (
                <li key={i.concept} className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
                  <span className="w-5 text-right text-xs tabular-nums text-muted-foreground">{n + 1}</span>
                  <Link to={`/concepts/${i.concept}`} className="min-w-0 flex-1 font-medium hover:underline">
                    {i.label}
                  </Link>
                  {i.lastGrade && <span className="text-xs text-muted-foreground">last: {i.lastGrade}</span>}
                  <StateChip state={i.state} />
                </li>
              ))}
            </ol>
            <h2 className="pt-2 text-sm font-semibold text-muted-foreground">Classic system design (concept reps)</h2>
            <ul className="flex flex-wrap gap-1.5">
              {classic.map((i) => (
                <li key={i.concept} className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs">
                  {i.label} <StateChip state={i.state} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

export function ConceptLessonPage() {
  const { concept = '' } = useParams();
  const [lesson, setLesson] = useState<ConceptLesson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [learned, setLearned] = useState<ConceptLearningState | null>(null);

  useEffect(() => {
    getConceptTrack()
      .then((t) => setLearned(t.items.find((i) => i.concept === concept)?.state ?? null))
      .catch(() => undefined);
    getConceptLesson(concept)
      .then(setLesson)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [concept]);

  const markRead = async () => {
    try {
      const t = await learnConcept(concept, 'lesson');
      setLearned(t.items.find((i) => i.concept === concept)?.state ?? 'learning');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <article className="mx-auto max-w-2xl space-y-5 p-4 pb-16 sm:p-6">
        <Link to="/concepts" className="text-sm text-muted-foreground underline underline-offset-4">
          ← AI-systems track
        </Link>
        {error && <p className="text-sm text-destructive-foreground">{error}</p>}
        {!lesson && !error && (
          <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading the lesson (the first open writes it once, ~20 s)…
          </p>
        )}
        {lesson && (
          <>
            <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold tracking-tight">
              {lesson.label} {learned && <StateChip state={learned} />}
            </h1>
            <section className="prose prose-invert max-w-none text-sm">
              <ReactMarkdown>{lesson.card}</ReactMarkdown>
            </section>
            <section className="space-y-1">
              <h2 className="text-sm font-semibold">In the interview</h2>
              <p className="text-sm leading-relaxed">{lesson.inInterview}</p>
            </section>
            <section className="space-y-1">
              <h2 className="text-sm font-semibold">How it fails</h2>
              <ul className="list-disc space-y-0.5 pl-4 text-sm">{lesson.failureModes.map((f) => <li key={f}>{f}</li>)}</ul>
            </section>
            <section className="space-y-1">
              <h2 className="text-sm font-semibold">Worked example</h2>
              <p className="text-sm leading-relaxed">{lesson.workedExample}</p>
            </section>
            {lesson.drawOn.length > 0 && (
              <section className="space-y-1 rounded-lg border border-border px-3 py-2">
                <h2 className="text-sm font-semibold">From your own work</h2>
                <ul className="list-disc space-y-0.5 pl-4 text-sm">{lesson.drawOn.map((d) => <li key={d}>{d}</li>)}</ul>
              </section>
            )}
            <section className="space-y-1 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
              <h2 className="text-sm font-semibold text-primary">What a Staff answer sounds like</h2>
              <p className="text-sm leading-relaxed">{lesson.staffAnswer}</p>
            </section>
            {learned === 'new' && (
              <Button onClick={() => void markRead()} className="gap-1.5">
                <Check className="h-4 w-4" /> I've read it — test me in two days
              </Button>
            )}
            {learned && learned !== 'new' && (
              <p className="text-xs text-muted-foreground">
                Learned. Its cold concept rep comes up once two days have passed; a “got” there makes it known.
              </p>
            )}
          </>
        )}
      </article>
    </div>
  );
}
