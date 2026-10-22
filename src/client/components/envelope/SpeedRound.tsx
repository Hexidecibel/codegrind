// =============================================================================
// SpeedRound — 60 seconds of quick conversions (Phase I)
// =============================================================================
// Each answer is checked right here (the same pure checker the server uses),
// so feedback is instant; at the buzzer the answers go to the server, which
// re-grades them and keeps the best score and the history. No penalty for a
// miss: guess and move on.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Timer, Trophy } from 'lucide-react';
import { checkAnswer, formHint } from '@/shared/envelope';
import type { SpeedRoundResult, SpeedRoundStart } from '@/shared/envelope-learn';
import { finishEnvelopeSpeed, getEnvelopeSpeed } from '@/client/lib/api';
import { Button } from '@/client/components/ui/button';
import { cn } from '@/lib/utils';

interface Given {
  key: string;
  answer: string;
  atMs: number;
  ok: boolean;
}

export function SpeedRound() {
  const [round, setRound] = useState<SpeedRoundStart | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [idx, setIdx] = useState(0);
  const [text, setText] = useState('');
  const [given, setGiven] = useState<Given[]>([]);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [result, setResult] = useState<SpeedRoundResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sent = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRound(await getEnvelopeSpeed());
      setStartedAt(null);
      setIdx(0);
      setGiven([]);
      setResult(null);
      setFlash(null);
      sent.current = false;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const running = startedAt !== null && !result;
  const left = round && startedAt !== null ? Math.max(0, round.ms - (now - startedAt)) : round?.ms ?? 60_000;

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [running]);

  useEffect(() => {
    if (running) inputRef.current?.focus();
  }, [running, idx]);

  // The buzzer.
  useEffect(() => {
    if (!running || left > 0 || sent.current) return;
    sent.current = true;
    finishEnvelopeSpeed(given.map(({ key, answer, atMs }) => ({ key, answer, atMs })))
      .then(setResult)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [running, left, given]);

  const item = round?.items[idx] ?? null;

  const submit = () => {
    if (!item || !running || !text.trim()) return;
    const h = formHint(item, text);
    if (h) {
      setHint(h);
      return;
    }
    const v = checkAnswer(item, text);
    if (!v) {
      setHint('Type a number (or divide / multiply).');
      return;
    }
    setHint(null);
    setGiven((g) => [...g, { key: item.key, answer: text, atMs: Date.now() - startedAt!, ok: v.ok }]);
    setFlash({ ok: v.ok, text: v.ok ? 'Right' : `It was ${item.answerText.replace(/^≈ /, '')}` });
    setText('');
    setIdx((i) => i + 1);
  };

  if (error) return <p className="text-sm text-destructive-foreground">{error}</p>;
  if (!round) return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;

  if (result) {
    return (
      <div className="space-y-3">
        <p className="flex items-center gap-2 text-2xl font-semibold">
          {result.newBest && <Trophy className="h-6 w-6 text-amber-400" />} {result.score} right
        </p>
        <p className="text-sm text-muted-foreground">
          {result.attempted} answered · best streak {result.bestStreak} · best ever {result.best}
          {result.newBest ? ' (new best!)' : ''}
        </p>
        <Button onClick={() => void load()}>Again</Button>
      </div>
    );
  }

  if (!running) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          60 seconds of quick ones: divide or multiply, small × 10ⁿ, back to a normal number, a few conversions. One point
          per right answer, no penalty for a miss.
          {round.best !== null && ` Your best: ${round.best}.`}
        </p>
        {round.history.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Recent: {round.history.slice(0, 10).map((h) => h.score).join(' · ')}
          </p>
        )}
        <Button
          onClick={() => {
            setStartedAt(Date.now());
            setNow(Date.now());
          }}
          className="gap-1.5"
        >
          <Timer className="h-4 w-4" /> Go
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm">
        <span className="tabular-nums text-muted-foreground">{Math.ceil(left / 1000)} s</span>
        <span className="tabular-nums">{given.filter((g) => g.ok).length} right</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden>
        <div className="h-full bg-primary" style={{ width: `${(left / round.ms) * 100}%` }} />
      </div>
      {item && <p className="text-lg">{item.question}</p>}
      <input
        ref={inputRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="answer, then Enter"
        autoComplete="off"
        className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-base outline-none focus:border-primary"
      />
      {hint && <p className="text-sm text-amber-300">{hint}</p>}
      {flash && <p className={cn('text-sm', flash.ok ? 'text-emerald-400' : 'text-rose-300')}>{flash.text}</p>}
    </div>
  );
}
