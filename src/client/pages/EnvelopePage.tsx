// =============================================================================
// EnvelopePage — back-of-the-envelope math reps (Phase G)
// =============================================================================
// One question at a time, phrased the way an interviewer asks it. Type an
// answer ("500", "30M", "8 TB", "3e7"), optionally your working, and Check: the
// server reads it, says how far off it was (and which way, in powers of ten),
// names the likely slip, and shows the worked split — small numbers, exponent
// arithmetic, the 3/6/9/12 ladder back. On a miss with AI reviews on, one small
// call explains the slip from your working. Misses come back as review cards.
//
// Keys: Enter checks (in the answer box) · Enter after the reveal = next.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowRight, Calculator, Check, Loader2, Sparkles, X } from 'lucide-react';
import { DEFAULT_ENVELOPE_SIZE, type EnvelopeCheckResponse, type EnvelopeNote, type EnvelopePrompt } from '@/shared/envelope';
import { checkEnvelope, getEnvelopeSession, noteEnvelope } from '@/client/lib/api';
import { todayStepFrom } from '@/client/lib/today-flow';
import { TodayNextBar } from '@/client/components/TodayNextBar';
import { Button } from '@/client/components/ui/button';
import { cn } from '@/lib/utils';

const SIZES = [5, 10] as const;

const ANCHORS: readonly [string, string][] = [
  ['a day', '≈ 10⁵ s'],
  ['a month', '≈ 2.5 × 10⁶ s'],
  ['a year', '≈ 3 × 10⁷ s'],
  ['per day → per year', '× 400'],
  ['1 Gbps', '≈ 125 MB/s'],
  ['b / B', 'bits / bytes'],
  ['ladder', '10³ K · 10⁶ M · 10⁹ B/G · 10¹² T'],
];

const SPLIT_ROWS: readonly [keyof EnvelopeCheckResponse['split'], string][] = [
  ['parts', 'Write it small × 10ⁿ'],
  ['small', 'Small numbers'],
  ['zeros', 'Exponents'],
  ['back', 'Back up the ladder'],
  ['sanity', 'Sanity check'],
];

interface Done {
  key: string;
  ok: boolean;
  orders: number;
}

export function EnvelopePage() {
  const location = useLocation();
  const todayStep = todayStepFrom(location.search);
  const qn = Number(new URLSearchParams(location.search).get('n'));
  const [size, setSize] = useState<number>(qn > 0 ? Math.min(qn, 20) : DEFAULT_ENVELOPE_SIZE);
  const [items, setItems] = useState<EnvelopePrompt[] | null>(null);
  const [aiReviews, setAiReviews] = useState(true);
  const [idx, setIdx] = useState(0);
  const [answer, setAnswer] = useState('');
  const [working, setWorking] = useState('');
  const [result, setResult] = useState<EnvelopeCheckResponse | null>(null);
  const [note, setNote] = useState<EnvelopeNote | null>(null);
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [done, setDone] = useState<Done[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answerRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  const start = useCallback(async (n: number) => {
    setLoading(true);
    setError(null);
    try {
      const s = await getEnvelopeSession(n);
      setItems(s.items);
      setAiReviews(s.aiReviews);
      setIdx(0);
      setDone([]);
      setResult(null);
      setAnswer('');
      setWorking('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Opened from Today: go straight in.
  useEffect(() => {
    if (todayStep && !items) void start(size);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const item = items?.[idx] ?? null;
  const finished = !!items && idx >= items.length;

  useEffect(() => {
    if (item && !result) answerRef.current?.focus();
    if (result) nextRef.current?.focus();
  }, [item, result]);

  const askNote = useCallback(async (attemptId: number) => {
    setNoteBusy(true);
    setNoteError(null);
    try {
      setNote(await noteEnvelope(attemptId));
    } catch (e) {
      setNoteError(e instanceof Error ? e.message : String(e));
    } finally {
      setNoteBusy(false);
    }
  }, []);

  const submit = useCallback(async () => {
    if (!item || !answer.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const r = await checkEnvelope(item.key, answer, working);
      setResult(r);
      setNote(null);
      setNoteError(null);
      setDone((d) => [...d, { key: item.key, ok: r.ok, orders: r.orders }]);
      if (r.noteAvailable) void askNote(r.attemptId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [item, answer, working, loading, askNote]);

  const next = () => {
    setIdx((i) => i + 1);
    setResult(null);
    setNote(null);
    setAnswer('');
    setWorking('');
  };

  const right = done.filter((d) => d.ok).length;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-4 p-4 pb-16 sm:p-6">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Calculator className="h-6 w-6 text-primary" /> Envelope
          </h1>
          {items && !finished && (
            <span className="text-sm text-muted-foreground">
              Question {idx + 1} of {items.length}
              {item?.card ? ' · review card' : ''}
            </span>
          )}
        </header>

        {todayStep && <TodayNextBar here={todayStep} screenPath="/envelope" refreshKey={done.length} />}

        <details className="rounded-lg border border-border bg-card px-3 py-2 text-sm" open={!items}>
          <summary className="cursor-pointer text-muted-foreground">
            The method: small × 10ⁿ, add exponents to multiply, subtract to divide, back up the 3/6/9/12 ladder
          </summary>
          <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
            {ANCHORS.map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <dt className="w-36 shrink-0 text-muted-foreground">{k}</dt>
                <dd className="tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        </details>

        {error && <p className="text-sm text-destructive-foreground">{error}</p>}

        {!items && (
          <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Interview-style estimation questions: rates, storage, bandwidth, ID sizes. Answer roughly — within 30%
              counts. Free; misses come back on a spaced schedule, and each one shows the worked split.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {SIZES.map((n) => (
                <Button key={n} variant={size === n ? 'default' : 'outline'} onClick={() => setSize(n)} disabled={loading}>
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

        {item && (
          <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
            <p className="text-lg leading-relaxed">{item.question}</p>
            <div className="space-y-2">
              <label className="block text-sm text-muted-foreground" htmlFor="env-answer">
                Your answer{item.unitHint ? ` (a bare number is read as ${item.unitHint})` : ''}
              </label>
              <input
                id="env-answer"
                ref={answerRef}
                value={answer}
                disabled={!!result}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void submit();
                  }
                }}
                placeholder='e.g. 500, 30M, 3e7, 8 TB, 125 MB/s'
                autoComplete="off"
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-base outline-none focus:border-primary"
              />
              <textarea
                value={working}
                disabled={!!result}
                onChange={(e) => setWorking(e.target.value)}
                rows={2}
                placeholder="Working (optional): 5 × 10⁷ ÷ 10⁵ = 5 × 10² …"
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary"
              />
              {!result && (
                <Button onClick={() => void submit()} disabled={loading || !answer.trim()} className="gap-1.5">
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Check
                </Button>
              )}
            </div>

            {result && (
              <div className="space-y-3">
                <div
                  className={cn(
                    'rounded-lg border px-3 py-2',
                    result.ok ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-rose-500/40 bg-rose-500/10',
                  )}
                >
                  <p className={cn('flex items-center gap-2 font-medium', result.ok ? 'text-emerald-300' : 'text-rose-300')}>
                    {result.ok ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />} {result.verdict}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Read as {result.read}. Answer: {result.answerText}.
                  </p>
                  {result.causeText && <p className="mt-1 text-sm">{result.causeText}</p>}
                  <p className="mt-1 text-xs text-muted-foreground">Review: {result.schedule}</p>
                </div>

                <dl className="space-y-1.5 rounded-lg border border-border px-3 py-2 text-sm">
                  {SPLIT_ROWS.map(([k, label]) => (
                    <div key={k} className="grid grid-cols-1 gap-x-3 sm:grid-cols-[10rem_1fr]">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="font-mono text-[13px] leading-relaxed">{result.split[k]}</dd>
                    </div>
                  ))}
                </dl>

                {!result.ok && (aiReviews || note) && (
                  <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
                    {note ? (
                      <>
                        <p>
                          <Sparkles className="mr-1 inline h-3.5 w-3.5 text-primary" />
                          {note.slip}
                        </p>
                        {note.fix && <p className="mt-1 text-muted-foreground">Next time: {note.fix}</p>}
                      </>
                    ) : noteBusy ? (
                      <p className="inline-flex items-center gap-2 text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> Reading your working…
                      </p>
                    ) : noteError ? (
                      <p className="text-muted-foreground">AI note unavailable: {noteError}</p>
                    ) : null}
                  </div>
                )}

                <Button ref={nextRef} onClick={next} className="gap-1.5">
                  {idx + 1 < (items?.length ?? 0) ? 'Next question' : 'Finish'} <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </section>
        )}

        {finished && (
          <section className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5">
            <p className="text-lg font-semibold">
              {right} of {done.length} right
            </p>
            <p className="text-sm text-muted-foreground">
              Misses are on the review ladder and come back tomorrow. Accuracy and how many zeros you are off by over
              time are on <Link to="/progress" className="underline underline-offset-4">Reflect</Link>.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => start(size)} variant="outline">
                Another ×{size}
              </Button>
              {todayStep && (
                <Button asChild>
                  <Link to="/today">Back to Today</Link>
                </Button>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
