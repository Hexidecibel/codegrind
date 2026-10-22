// =============================================================================
// PatternsPage — /patterns: the code shape of each interview pattern
// =============================================================================
// Static reference (shared/pattern-shapes): the "Which one?" clue table, then
// one card per pattern — Spot it, Shape, a commented JS template, the Trap —
// with a sticky jump bar and an anchor per card (/patterns#sliding-window).
//
// "Write it from memory" per card: the template is hidden, you type the
// skeleton, Compare shows yours beside the template, and a got / shaky /
// missed self-grade moves a spaced-repetition card (gap-card ladder). Free.
//
// Opened from Today (`?from=today&step=relearn|recall|warmup`): Re-learn
// records the view, Recall opens the card in recall mode, and the
// "Next: <step>" bar sits at the bottom.

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Check, Eye, PencilLine, Shapes, Zap } from 'lucide-react';
import {
  PATTERN_SHAPES,
  WHICH_ONE,
  isPatternId,
  practiceHref,
  type PatternId,
  type PatternRecallCard,
  type PatternShape,
  type PatternsState,
} from '@/shared/pattern-shapes';
import { GAP_CARD_LADDER_DAYS } from '@/shared/gap-cards';
import { getPatterns, gradePatternRecall, viewPattern } from '@/client/lib/api';
import { todayStepFrom } from '@/client/lib/today-flow';
import { TodayNextBar } from '@/client/components/TodayNextBar';
import { humanize } from '@/client/lib/format';
import { Button } from '@/client/components/ui/button';
import { cn } from '@/lib/utils';

// -----------------------------------------------------------------------------
// Inline markup (`**bold**`, `` `code` ``) and a tiny JS highlighter
// -----------------------------------------------------------------------------
export function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**') ? (
          <strong key={i} className="font-semibold text-foreground">
            {p.slice(2, -2)}
          </strong>
        ) : p.startsWith('`') && p.endsWith('`') && p.length > 1 ? (
          <code key={i} className="rounded bg-secondary px-1 py-0.5 font-mono text-[0.85em]">
            {p.slice(1, -1)}
          </code>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

const KEYWORDS = new Set([
  'const', 'let', 'var', 'for', 'of', 'in', 'while', 'if', 'else', 'return', 'function',
  'new', 'true', 'false', 'null', 'undefined', 'continue', 'break',
]);
const TOKEN = /(\/\/[^\n]*)|('(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;

/** JS → coloured spans. Comments, strings, numbers, keywords, calls. */
export function highlightJs(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const [tok, comment, str, num, ident] = m;
    let cls = '';
    if (comment) cls = 'text-muted-foreground italic';
    else if (str) cls = 'text-emerald-300';
    else if (num) cls = 'text-amber-300';
    else if (ident && KEYWORDS.has(ident)) cls = 'text-violet-300';
    else if (ident && /^\s*\(/.test(code.slice(m.index + tok.length))) cls = 'text-sky-300';
    out.push(cls ? <span key={i++} className={cls}>{tok}</span> : tok);
    last = m.index + tok.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="min-w-0">
      {label && <div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>}
      <pre className="overflow-x-auto rounded-lg border border-border bg-black/30 p-3 font-mono text-[12.5px] leading-relaxed text-foreground/90">
        <code>{highlightJs(code)}</code>
      </pre>
    </div>
  );
}

// -----------------------------------------------------------------------------
// One card
// -----------------------------------------------------------------------------
function dueWords(card: PatternRecallCard | undefined): string | null {
  if (!card) return null;
  if (card.retired) return 'recall retired';
  if (card.due) return 'recall due';
  const days = Math.max(1, Math.ceil((Date.parse(card.dueAt) - Date.now()) / 86_400_000));
  return `next recall in ${days} day${days === 1 ? '' : 's'}`;
}

function PatternCard({
  p,
  card,
  recallOpen,
  onRecallOpen,
  onGraded,
}: {
  p: PatternShape;
  card: PatternRecallCard | undefined;
  recallOpen: boolean;
  onRecallOpen: (open: boolean) => void;
  onGraded: (s: PatternsState) => void;
}) {
  const [answer, setAnswer] = useState('');
  const [compared, setCompared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [graded, setGraded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = dueWords(card);

  const grade = async (g: 'got' | 'shaky' | 'missed') => {
    setBusy(true);
    setError(null);
    try {
      const s = await gradePatternRecall(p.id, g, answer);
      const next = s.cards.find((c) => c.id === p.id);
      const days: number = next ? GAP_CARD_LADDER_DAYS[Math.min(next.step, GAP_CARD_LADDER_DAYS.length - 1)] : 0;
      setGraded(
        g === 'missed'
          ? 'Saved as missed — it stays due; try again after a re-read.'
          : next?.retired
            ? 'Saved — retired: you know this one.'
            : `Saved — next recall in ${days} day${days === 1 ? '' : 's'}.`,
      );
      onGraded(s);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setAnswer('');
    setCompared(false);
    setGraded(null);
    setError(null);
  };

  return (
    <section id={p.id} className="scroll-mt-28 space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-lg font-bold">{p.title}</h2>
        <span className="font-mono text-xs text-muted-foreground">{p.bigO}</span>
        {status && (
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px]',
              card?.due ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground',
            )}
          >
            {status}
          </span>
        )}
        <span className="ml-auto flex flex-wrap gap-1">
          {p.topics.map((t) => (
            <span key={t} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
              {humanize(t)}
            </span>
          ))}
        </span>
      </div>

      <p className="text-sm leading-relaxed text-foreground/90">
        <span className="font-semibold text-sky-300">Spot it:</span> <Inline text={p.spot} />
      </p>
      <p className="rounded-lg border-l-2 border-violet-400/70 bg-violet-500/[0.07] px-3 py-2 text-sm leading-relaxed">
        <span className="font-semibold text-violet-300">Shape:</span> <Inline text={p.shape} />
      </p>

      {!recallOpen ? (
        <>
          <CodeBlock code={p.code} />
          {p.note && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              <span className="font-semibold text-foreground/80">Note:</span> <Inline text={p.note} />
            </p>
          )}
          <p className="flex gap-1.5 text-sm leading-relaxed">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <span>
              <span className="font-semibold text-amber-300">Trap:</span> <Inline text={p.trap} />
            </span>
          </p>
        </>
      ) : (
        <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-3">
          <div className="text-sm font-medium">
            <PencilLine className="mr-1 inline h-4 w-4 text-primary" /> Write it from memory
          </div>
          {!compared ? (
            <>
              <p className="text-xs text-muted-foreground">
                The template is hidden. Type the skeleton — the loop, the check, the update. Names and syntax don&apos;t matter; the shape does.
              </p>
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                rows={12}
                placeholder={`// ${p.title}: the shape from memory\n`}
                className="w-full resize-y rounded-md border border-border bg-black/30 p-3 font-mono text-[13px] leading-relaxed outline-none focus:border-primary/60"
              />
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setCompared(true)} className="gap-1.5">
                  <Eye className="h-4 w-4" /> Compare
                </Button>
                <Button variant="ghost" className="text-muted-foreground" onClick={() => onRecallOpen(false)}>
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="min-w-0">
                  <div className="mb-1 text-xs font-medium text-muted-foreground">Yours</div>
                  <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-border bg-black/20 p-3 font-mono text-[12.5px] leading-relaxed">
                    {answer.trim() || '(nothing written)'}
                  </pre>
                </div>
                <CodeBlock code={p.code} label="Template" />
              </div>
              <p className="flex gap-1.5 text-sm leading-relaxed">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                <span>
                  <span className="font-semibold text-amber-300">Trap:</span> <Inline text={p.trap} />
                </span>
              </p>
              {graded ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="inline-flex items-center gap-1 text-emerald-300">
                    <Check className="h-4 w-4" /> {graded}
                  </span>
                  <Button size="sm" variant="ghost" onClick={reset}>
                    Again
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onRecallOpen(false)}>
                    Show the card
                  </Button>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <div className="text-xs text-muted-foreground">How close was yours? Be strict: the shape, not the names.</div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy} onClick={() => void grade('got')} className="bg-emerald-600 text-white hover:bg-emerald-500">
                      Got it
                    </Button>
                    <Button size="sm" disabled={busy} variant="secondary" onClick={() => void grade('shaky')}>
                      Shaky
                    </Button>
                    <Button size="sm" disabled={busy} variant="outline" className="border-rose-500/50 text-rose-300" onClick={() => void grade('missed')}>
                      Missed
                    </Button>
                  </div>
                  {error && <p className="text-xs text-destructive-foreground">{error}</p>}
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        {p.topics[0] && (
          <Button asChild size="sm" variant="outline" className="gap-1.5">
            <Link to={practiceHref(p.topics[0])}>
              <Zap className="h-3.5 w-3.5" /> Practice this (Easy)
            </Link>
          </Button>
        )}
        {!recallOpen && (
          <Button
            size="sm"
            variant="ghost"
            className="gap-1.5"
            onClick={() => {
              reset();
              onRecallOpen(true);
            }}
          >
            <PencilLine className="h-3.5 w-3.5" /> Write it from memory
          </Button>
        )}
      </div>
    </section>
  );
}

// -----------------------------------------------------------------------------
// The page
// -----------------------------------------------------------------------------
export function PatternsPage() {
  const location = useLocation();
  const todayStep = todayStepFrom(location.search);
  const query = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const hashId = location.hash.slice(1);
  const [state, setState] = useState<PatternsState | null>(null);
  const [recall, setRecall] = useState<Set<PatternId>>(() => new Set());
  const [todayKey, setTodayKey] = useState(0);

  useEffect(() => {
    getPatterns()
      .then(setState)
      .catch(() => setState({ cards: [], due: [] }));
  }, []);

  // `?recall=<id>` opens that card in recall mode (Today's "Write it from memory").
  useEffect(() => {
    const r = query.get('recall');
    if (isPatternId(r)) setRecall((prev) => new Set(prev).add(r));
  }, [query]);

  // Today's Re-learn: opening the card is the step.
  useEffect(() => {
    if (todayStep !== 'relearn' || !isPatternId(hashId)) return;
    viewPattern(hashId)
      .then((s) => {
        setState(s);
        setTodayKey((k) => k + 1);
      })
      .catch(() => undefined);
  }, [todayStep, hashId]);

  // Scroll to the anchor (also after a same-page link changes the hash).
  useEffect(() => {
    if (!hashId) return;
    const t = setTimeout(() => document.getElementById(hashId)?.scrollIntoView({ block: 'start' }), 30);
    return () => clearTimeout(t);
  }, [hashId, location.search]);

  const cards = useMemo(() => new Map((state?.cards ?? []).map((c) => [c.id, c])), [state]);
  const setOpen = useCallback((id: PatternId, open: boolean) => {
    setRecall((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const jump = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    window.history.replaceState(null, '', `${location.pathname}${location.search}#${id}`);
  };

  const due = state?.due ?? [];

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Sticky jump bar: one chip per card. */}
        <nav
          aria-label="Patterns"
          className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
        >
          <div className="mx-auto flex max-w-3xl gap-1.5 overflow-x-auto px-3 py-2 sm:flex-wrap sm:px-6">
            <button
              type="button"
              onClick={() => jump('which')}
              className="shrink-0 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
            >
              Which one?
            </button>
            {PATTERN_SHAPES.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => jump(p.id)}
                className={cn(
                  'shrink-0 rounded-full border px-2.5 py-1 text-xs transition-colors hover:text-foreground',
                  hashId === p.id ? 'border-primary/60 text-foreground' : 'border-border text-muted-foreground',
                  cards.get(p.id)?.due && 'border-primary/50',
                )}
              >
                {p.title}
              </button>
            ))}
          </div>
        </nav>

        <div className="mx-auto max-w-3xl space-y-4 px-3 pb-16 pt-4 sm:px-6">
          <header className="space-y-1">
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
              <Shapes className="h-6 w-6 text-primary" /> Pattern shapes
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              The code shape of each interview pattern, in JavaScript. Read the clue, say the shape out loud, then glance at the code. Each one has the trap people fall into.
              Or hide the code and write it from memory.
            </p>
          </header>

          {due.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/50 bg-primary/5 px-3 py-2 text-sm">
              <PencilLine className="h-4 w-4 text-primary" />
              <span className="font-medium">Due to recall:</span>
              {due.map((id) => (
                <Button
                  key={id}
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1"
                  onClick={() => {
                    setOpen(id, true);
                    jump(id);
                  }}
                >
                  {PATTERN_SHAPES.find((p) => p.id === id)?.title ?? id} <ArrowRight className="h-3 w-3" />
                </Button>
              ))}
            </div>
          )}

          <section id="which" className="scroll-mt-28 space-y-2 rounded-xl border border-border bg-card p-4 sm:p-5">
            <h2 className="text-lg font-bold">Which one? Read the clue</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">The problem says…</th>
                    <th className="py-1.5 font-medium">Reach for</th>
                  </tr>
                </thead>
                <tbody>
                  {WHICH_ONE.map((r) => (
                    <tr key={r.pattern} className="border-b border-border/50 last:border-0">
                      <td className="py-1.5 pr-3 text-foreground/90">
                        <Inline text={r.clue} />
                      </td>
                      <td className="whitespace-nowrap py-1.5">
                        <button type="button" onClick={() => jump(r.pattern)} className="text-primary underline-offset-4 hover:underline">
                          {r.label}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {PATTERN_SHAPES.map((p) => (
            <PatternCard
              key={p.id}
              p={p}
              card={cards.get(p.id)}
              recallOpen={recall.has(p.id)}
              onRecallOpen={(open) => setOpen(p.id, open)}
              onGraded={(s) => {
                setState(s);
                setTodayKey((k) => k + 1);
              }}
            />
          ))}
        </div>
      </div>
      {todayStep && (
        <TodayNextBar here={todayStep} screenPath="/patterns" refreshKey={todayKey} className="m-2 shrink-0 sm:mx-auto sm:w-full sm:max-w-3xl" />
      )}
    </div>
  );
}
