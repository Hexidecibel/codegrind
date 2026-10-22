// =============================================================================
// AnchorDrill — the anchor numbers as ~10-second flashcards (Phase I)
// =============================================================================
// Type the answer before the bar runs out. Right and in time moves the card
// along its spaced schedule; wrong or slow brings it back sooner. Free.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Loader2, X } from 'lucide-react';
import type { AnchorCheckResponse, AnchorPrompt } from '@/shared/envelope-learn';
import { checkEnvelopeAnchor, getEnvelopeAnchors } from '@/client/lib/api';
import { Button } from '@/client/components/ui/button';
import { cn } from '@/lib/utils';

export function AnchorDrill() {
  const [cards, setCards] = useState<AnchorPrompt[] | null>(null);
  const [seconds, setSeconds] = useState(10);
  const [idx, setIdx] = useState(0);
  const [text, setText] = useState('');
  const [result, setResult] = useState<AnchorCheckResponse | null>(null);
  const [results, setResults] = useState<{ front: string; r: AnchorCheckResponse }[]>([]);
  const [startedAt, setStartedAt] = useState(0);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await getEnvelopeAnchors();
      setCards(s.cards);
      setSeconds(s.seconds);
      setIdx(0);
      setResults([]);
      setResult(null);
      setText('');
      setStartedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const card = cards?.[idx] ?? null;

  useEffect(() => {
    if (!card || result) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [card, result]);

  useEffect(() => {
    if (card && !result) inputRef.current?.focus();
    if (result) nextRef.current?.focus();
  }, [card, result]);

  const submit = useCallback(async () => {
    if (!card || busy || result) return;
    setBusy(true);
    try {
      const r = await checkEnvelopeAnchor(card.id, text, Date.now() - startedAt);
      setResult(r);
      setResults((x) => [...x, { front: card.front, r }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [card, busy, result, text, startedAt]);

  const next = () => {
    setIdx((i) => i + 1);
    setResult(null);
    setText('');
    setStartedAt(Date.now());
    setNow(Date.now());
  };

  if (error) return <p className="text-sm text-destructive-foreground">{error}</p>;
  if (!cards) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  if (cards.length === 0) {
    return <p className="text-sm text-muted-foreground">No anchor cards due. They come back on their schedule.</p>;
  }

  if (!card) {
    const got = results.filter((x) => x.r.grade === 'got').length;
    return (
      <div className="space-y-3">
        <p className="text-lg font-semibold">
          {got} of {results.length} in time
        </p>
        <ul className="space-y-1 text-sm">
          {results
            .filter((x) => x.r.grade !== 'got')
            .map((x) => (
              <li key={x.front}>
                <span className="text-muted-foreground">{x.front}</span> {x.r.back}
              </li>
            ))}
        </ul>
        <Button variant="outline" onClick={() => void load()}>
          Check for more
        </Button>
      </div>
    );
  }

  const left = Math.max(0, seconds * 1000 - (now - startedAt));
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Card {idx + 1} of {cards.length}
        {card.isNew ? ' · new' : ''}
      </p>
      <p className="text-xl">{card.front}</p>
      {!result && (
        <div className="h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden>
          <div
            className={cn('h-full transition-[width] duration-100', left > 3000 ? 'bg-primary' : 'bg-amber-400')}
            style={{ width: `${(left / (seconds * 1000)) * 100}%` }}
          />
        </div>
      )}
      <input
        ref={inputRef}
        value={text}
        disabled={!!result || busy}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder="type it, then Enter"
        autoComplete="off"
        className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-base outline-none focus:border-primary"
      />
      {result && (
        <div
          className={cn(
            'rounded-md border px-3 py-2 text-sm',
            result.grade === 'got' ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-rose-500/40 bg-rose-500/10',
          )}
        >
          <p className="flex items-center gap-1.5 font-medium">
            {result.ok ? <Check className="h-4 w-4 text-emerald-400" /> : <X className="h-4 w-4 text-rose-400" />}
            {result.back}
          </p>
          <p className="text-xs text-muted-foreground">Next: {result.schedule}</p>
          <Button ref={nextRef} size="sm" onClick={next} className="mt-2 gap-1">
            Next <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}
