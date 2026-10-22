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
//
// Phase I (for a true beginner): Guided mode walks a question one small step at
// a time; a drill picker serves one kind only (the 13 interview kinds plus three
// quick ones); Endless keeps going, weighted to what is missed most; Anchors are
// ~10 s flashcards; Speed round is 60 s of quick conversions. From Today while
// still learning, the page opens guided on the day's one skill.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowRight, Calculator, Check, Loader2, Sparkles, Square, X } from 'lucide-react';
import {
  ALL_KINDS,
  DEFAULT_ENVELOPE_SIZE,
  KIND_LABEL,
  QUICK_KINDS,
  type EnvelopeCheckResponse,
  type EnvelopeKind,
  type EnvelopeNote,
  type EnvelopePrompt,
} from '@/shared/envelope';
import { skillById } from '@/shared/envelope-learn';
import { checkEnvelope, getEnvelopeSession, noteEnvelope } from '@/client/lib/api';
import { GuidedRunner } from '@/client/components/envelope/GuidedRunner';
import { AnchorDrill } from '@/client/components/envelope/AnchorDrill';
import { SpeedRound } from '@/client/components/envelope/SpeedRound';
import { todayStepFrom } from '@/client/lib/today-flow';
import { TodayNextBar } from '@/client/components/TodayNextBar';
import { Button } from '@/client/components/ui/button';
import { cn } from '@/lib/utils';

const SIZES = [5, 10, 'endless'] as const;
type Size = (typeof SIZES)[number];
type Tab = 'practice' | 'anchors' | 'speed';
const TABS: readonly [Tab, string][] = [
  ['practice', 'Practice'],
  ['anchors', 'Anchor cards'],
  ['speed', 'Speed round'],
];

const GUIDED_PREF = 'envelope.guided';
function guidedPref(): boolean {
  try {
    return window.localStorage.getItem(GUIDED_PREF) !== '0';
  } catch {
    return true;
  }
}

function placeholderFor(kind: EnvelopeKind | undefined): string {
  if (kind === 'direction') return 'divide or multiply';
  if (kind === 'words-to-sci') return 'e.g. 5 x 10^8';
  if (kind === 'sci-to-number') return 'e.g. 500, or 8 TB';
  return 'e.g. 500, 30M, 3e7, 8 TB, 125 MB/s';
}

const ANCHORS: readonly [string, string][] = [
  ['a day', '≈ 10⁵ s'],
  ['a month', '≈ 2.5 × 10⁶ s'],
  ['a year', '≈ 3 × 10⁷ s'],
  ['per day → per year', '× 400'],
  ['1 Gbps', '≈ 125 MB/s'],
  ['b / B', 'bits / bytes'],
  ['K / M / B (G) / T', '3 / 6 / 9 / 12 zeros'],
  ['10ⁿ', '1 followed by n zeros, in total'],
  ['back up the ladder', 'each comma knocked off = one unit up'],
];

const SPLIT_ROWS: readonly [keyof EnvelopeCheckResponse['split'], string][] = [
  ['parts', 'Write it small × 10ⁿ'],
  ['small', 'Small numbers'],
  ['zeros', 'Exponents'],
  ['back', 'Back to a normal number'],
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
  const qs = new URLSearchParams(location.search);
  const qn = Number(qs.get('n'));
  const skill = skillById(qs.get('skill'));
  const [tab, setTab] = useState<Tab>('practice');
  const [size, setSize] = useState<Size | number>(qn > 0 ? Math.min(qn, 20) : DEFAULT_ENVELOPE_SIZE);
  const [kind, setKind] = useState<string>(qs.get('kind') ?? '');
  const [guided, setGuided] = useState<boolean>(qs.get('guided') === '1' || guidedPref());
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

  const endless = size === 'endless';
  const fetchItems = useCallback(
    (n: number) =>
      getEnvelopeSession(n, {
        kind: kind || undefined,
        skill: !kind && todayStep ? skill?.id : undefined,
        mode: size === 'endless' && !kind ? 'endless' : undefined,
      }),
    [kind, skill, size, todayStep],
  );

  const start = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await fetchItems(size === 'endless' ? 5 : size);
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
  }, [fetchItems, size]);

  // Opened from Today: go straight in.
  useEffect(() => {
    if (todayStep && !items) void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleGuided = (on: boolean) => {
    setGuided(on);
    try {
      window.localStorage.setItem(GUIDED_PREF, on ? '1' : '0');
    } catch {
      /* per-viewer convenience only */
    }
  };

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

  const onResult = useCallback(
    (r: EnvelopeCheckResponse) => {
      if (!item) return;
      setResult(r);
      setNote(null);
      setNoteError(null);
      setDone((d) => [...d, { key: item.key, ok: r.ok, orders: r.orders }]);
      if (r.noteAvailable) void askNote(r.attemptId);
    },
    [item, askNote],
  );

  const submit = useCallback(async () => {
    if (!item || !answer.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      onResult(await checkEnvelope(item.key, answer, working));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [item, answer, working, loading, onResult]);

  const next = async () => {
    // Endless: top up before running out.
    if (endless && items && idx + 2 >= items.length) {
      try {
        const more = await fetchItems(5);
        setItems((xs) => [...(xs ?? []), ...more.items.filter((m) => !m.card || !(xs ?? []).some((x) => x.key === m.key))]);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    setIdx((i) => i + 1);
    setResult(null);
    setNote(null);
    setAnswer('');
    setWorking('');
  };

  const stop = () => {
    setItems((xs) => (xs ? xs.slice(0, idx + (result ? 1 : 0)) : xs));
    setIdx(idx + (result ? 1 : 0));
    setResult(null);
  };

  const guidedHere = guided && !!item?.guided && !result;

  const right = done.filter((d) => d.ok).length;
  const quickKinds = QUICK_KINDS as readonly string[];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-4 p-4 pb-16 sm:p-6">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Calculator className="h-6 w-6 text-primary" /> Envelope
          </h1>
          {tab === 'practice' && items && !finished && (
            <span className="text-sm text-muted-foreground">
              Question {idx + 1}
              {endless ? '' : ` of ${items.length}`}
              {item?.card ? ' · review card' : ''}
            </span>
          )}
        </header>

        {todayStep && <TodayNextBar here={todayStep} screenPath="/envelope" refreshKey={done.length} />}

        {skill && todayStep && (
          <p className="rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
            <span className="font-medium">Today&apos;s skill:</span> {skill.label}. One idea at a time; it is fine to be slow.
          </p>
        )}

        {!todayStep && (
          <div className="flex flex-wrap gap-1.5" role="tablist">
            {TABS.map(([t, label]) => (
              <Button key={t} size="sm" variant={tab === t ? 'default' : 'outline'} onClick={() => setTab(t)} role="tab" aria-selected={tab === t}>
                {label}
              </Button>
            ))}
          </div>
        )}

        <details className="rounded-lg border border-border bg-card px-3 py-2 text-sm" open={!items && tab === 'practice'}>
          <summary className="cursor-pointer text-muted-foreground">
            The method: small × 10ⁿ, add exponents to multiply, subtract to divide, then back with commas
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

        {tab === 'anchors' && (
          <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <AnchorDrill />
          </section>
        )}

        {tab === 'speed' && (
          <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
            <SpeedRound />
          </section>
        )}

        {tab === 'practice' && !items && (
          <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Interview-style estimation questions, plus quick one-idea drills. Estimates count within 30%; quick drills
              must be exact. Free; misses come back on a spaced schedule.
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={guided} onChange={(e) => toggleGuided(e.target.checked)} className="h-4 w-4 accent-primary" />
              Guided: one small step at a time, checked as you go
            </label>
            <div className="space-y-1">
              <label htmlFor="env-kind" className="block text-sm text-muted-foreground">
                Drill
              </label>
              <select
                id="env-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="">Mixed (due reviews first)</option>
                <optgroup label="Quick, one idea">
                  {ALL_KINDS.filter((k) => quickKinds.includes(k)).map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Interview questions">
                  {ALL_KINDS.filter((k) => !quickKinds.includes(k)).map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </optgroup>
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {SIZES.map((n) => (
                <Button key={n} variant={size === n ? 'default' : 'outline'} onClick={() => setSize(n)} disabled={loading}>
                  {n === 'endless' ? 'Endless' : `×${n}`}
                </Button>
              ))}
              <Button onClick={() => void start()} disabled={loading} className="ml-auto gap-1.5">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                Start
              </Button>
            </div>
            {size === 'endless' && (
              <p className="text-xs text-muted-foreground">
                Endless keeps going until you stop{kind ? '' : ', and leans toward what you miss most'}.
              </p>
            )}
          </section>
        )}

        {tab === 'practice' && item && (
          <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
            <p className="text-lg leading-relaxed">{item.question}</p>

            {guidedHere ? (
              <GuidedRunner key={`${item.key}:${idx}`} itemKey={item.key} onDone={onResult} />
            ) : (
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
                  placeholder={placeholderFor(item.kind)}
                  autoComplete="off"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-base outline-none focus:border-primary"
                />
                {!quickKinds.includes(item.kind) && (
                  <textarea
                    value={working}
                    disabled={!!result}
                    onChange={(e) => setWorking(e.target.value)}
                    rows={2}
                    placeholder="Working (optional): 5 × 10⁷ ÷ 10⁵ = 5 × 10² …"
                    className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary"
                  />
                )}
                {!result && (
                  <Button onClick={() => void submit()} disabled={loading || !answer.trim()} className="gap-1.5">
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Check
                  </Button>
                )}
              </div>
            )}

            {result && (
              <div className="space-y-3">
                <div
                  className={cn(
                    'rounded-lg border px-3 py-2',
                    result.ok ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-rose-500/40 bg-rose-500/10',
                  )}
                >
                  <p className={cn('flex items-center gap-2 font-medium', result.ok ? 'text-emerald-300' : 'text-rose-300')}>
                    {result.ok ? <Check className="h-4 w-4 shrink-0" /> : <X className="h-4 w-4 shrink-0" />} {result.verdict}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Read as {result.read}. Answer: {result.answerText}.
                  </p>
                  {result.causeText && <p className="mt-1 text-sm">{result.causeText}</p>}
                  {result.failedStep && <p className="mt-1 text-sm text-muted-foreground">The step that slipped first: {result.failedStep}</p>}
                  <p className="mt-1 text-xs text-muted-foreground">Review: {result.schedule}</p>
                </div>

                <details className="rounded-lg border border-border px-3 py-2 text-sm" open={!result.ok}>
                  <summary className="cursor-pointer text-muted-foreground">The worked steps</summary>
                  <dl className="mt-2 space-y-1.5">
                    {SPLIT_ROWS.filter(([k]) => result.split[k]).map(([k, label]) => (
                      <div key={k} className="grid grid-cols-1 gap-x-3 sm:grid-cols-[10rem_1fr]">
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="font-mono text-[13px] leading-relaxed">{result.split[k]}</dd>
                      </div>
                    ))}
                  </dl>
                </details>

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
                        <Loader2 className="h-4 w-4 animate-spin" /> Reading your steps…
                      </p>
                    ) : noteError ? (
                      <p className="text-muted-foreground">AI note unavailable: {noteError}</p>
                    ) : null}
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <Button ref={nextRef} onClick={() => void next()} className="gap-1.5">
                    {endless || idx + 1 < (items?.length ?? 0) ? 'Next question' : 'Finish'} <ArrowRight className="h-4 w-4" />
                  </Button>
                  {endless && (
                    <Button variant="outline" onClick={stop} className="gap-1.5">
                      <Square className="h-3.5 w-3.5" /> Stop here
                    </Button>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {tab === 'practice' && finished && (
          <section className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5">
            <p className="text-lg font-semibold">
              {right} of {done.length} right{right === done.length && done.length > 0 ? '. Lovely.' : ''}
            </p>
            <p className="text-sm text-muted-foreground">
              Every miss is practice that sticks: misses come back tomorrow. Accuracy, and which steps slip most, are on{' '}
              <Link to="/progress" className="underline underline-offset-4">Reflect</Link>.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void start()} variant="outline">
                {endless ? 'Keep going' : `Another ×${size}`}
              </Button>
              <Button onClick={() => setItems(null)} variant="ghost">
                Change drill
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
