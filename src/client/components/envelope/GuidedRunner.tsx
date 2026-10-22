// =============================================================================
// GuidedRunner — one envelope question, one small step at a time (Phase I)
// =============================================================================
// Each step is checked as you go (free, deterministic) and the feedback names
// the exact slip. After a step, the right answer is shown so you carry the
// right number forward. Steps you have got right 3 times in a row come filled
// in; a miss brings them back. The last step is the answer itself, graded the
// same way as plain mode.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Lightbulb, Loader2, X } from 'lucide-react';
import type { EnvelopeCheckResponse } from '@/shared/envelope';
import type { GuidedStepPrompt, StepCheckResponse } from '@/shared/envelope-learn';
import { checkEnvelope, checkEnvelopeStep, getEnvelopeGuided } from '@/client/lib/api';
import { Button } from '@/client/components/ui/button';
import { cn } from '@/lib/utils';

interface Done {
  answer: string;
  r: StepCheckResponse | null;
}

export function GuidedRunner({ itemKey, onDone }: { itemKey: string; onDone: (r: EnvelopeCheckResponse) => void }) {
  const [steps, setSteps] = useState<GuidedStepPrompt[] | null>(null);
  const [at, setAt] = useState(0);
  const [done, setDone] = useState<Record<number, Done>>({});
  const [text, setText] = useState('');
  const [showHint, setShowHint] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    setSteps(null);
    setAt(0);
    setDone({});
    getEnvelopeGuided(itemKey)
      .then((g) => {
        if (!live) return;
        setSteps(g.steps);
        // Skip past auto-filled steps at the start.
        let i = 0;
        while (i < g.steps.length - 1 && g.steps[i].auto) i++;
        setAt(i);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [itemKey]);

  const step = steps?.[at] ?? null;
  const checked = done[at]?.r ?? null;
  const isFinal = step?.type === 'unit';

  useEffect(() => {
    if (step && !checked) inputRef.current?.focus();
    else if (checked) nextRef.current?.focus();
  }, [step, checked]);

  const advance = useCallback(() => {
    if (!steps) return;
    let i = at + 1;
    while (i < steps.length - 1 && steps[i].auto) i++;
    setAt(i);
    setText('');
    setShowHint(false);
  }, [at, steps]);

  const submit = useCallback(async () => {
    if (!step || !text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (isFinal) {
        onDone(await checkEnvelope(itemKey, text, '', 'guided'));
      } else {
        const r = await checkEnvelopeStep(itemKey, step.index, text);
        setDone((d) => ({ ...d, [at]: { answer: text, r } }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [step, text, busy, isFinal, itemKey, at, onDone]);

  if (error && !steps) return <p className="text-sm text-destructive-foreground">{error}</p>;
  if (!steps || !step) {
    return (
      <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Getting the steps…
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <ol className="space-y-1.5">
        {steps.slice(0, at).map((s, i) => {
          const d = done[i];
          return (
            <li key={s.index} className="flex items-baseline gap-2 text-sm">
              <span className="w-5 shrink-0 text-right tabular-nums text-muted-foreground">{i + 1}.</span>
              <span className="text-muted-foreground">{s.label}:</span>
              {s.auto ? (
                <span className="font-mono text-[13px]">
                  {s.answer} <span className="text-xs text-emerald-400">(filled in: you have this one)</span>
                </span>
              ) : (
                <span className="font-mono text-[13px]">
                  {d?.r?.answer}{' '}
                  {d?.r?.ok ? <Check className="inline h-3.5 w-3.5 text-emerald-400" /> : <X className="inline h-3.5 w-3.5 text-rose-400" />}
                </span>
              )}
            </li>
          );
        })}
      </ol>

      <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Step {at + 1} of {steps.length} · {step.label}
        </p>
        <p className="text-base">{step.prompt}</p>
        <input
          ref={inputRef}
          value={checked ? (done[at]?.answer ?? text) : text}
          disabled={!!checked || busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={placeholderFor(step.type)}
          autoComplete="off"
          className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-base outline-none focus:border-primary"
        />
        {!checked && (
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void submit()} disabled={busy || !text.trim()} className="gap-1.5">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} {isFinal ? 'Check answer' : 'Check step'}
            </Button>
            {!showHint && (
              <Button variant="ghost" size="sm" onClick={() => setShowHint(true)} className="gap-1 text-muted-foreground">
                <Lightbulb className="h-3.5 w-3.5" /> Hint
              </Button>
            )}
          </div>
        )}
        {showHint && !checked && <p className="text-sm text-muted-foreground">{step.hint}</p>}
        {error && <p className="text-sm text-destructive-foreground">{error}</p>}
        {checked && (
          <div
            className={cn(
              'rounded-md border px-3 py-2 text-sm',
              checked.ok ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-rose-500/40 bg-rose-500/10',
            )}
          >
            <p className={cn('font-medium', checked.ok ? 'text-emerald-300' : 'text-rose-300')}>
              {checked.ok ? 'Nice.' : 'Not quite, and that is fine: this is how it sticks.'}
            </p>
            <p className="mt-0.5">{checked.feedback}</p>
            {checked.fadesNow && (
              <p className="mt-1 text-xs text-emerald-400">3 in a row: this step will fill itself in from now on.</p>
            )}
            <Button ref={nextRef} size="sm" onClick={advance} className="mt-2 gap-1">
              Next step <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function placeholderFor(type: GuidedStepPrompt['type']): string {
  switch (type) {
    case 'direction':
      return 'divide or multiply';
    case 'split':
      return 'e.g. 5 x 10^8';
    case 'small':
      return 'e.g. 0.8';
    case 'exponent':
      return 'the little number, e.g. 3';
    case 'back':
      return 'e.g. 500 or 8 TB';
    case 'unit':
      return 'e.g. 500 per second, 8 TB, 4 Gbps';
  }
}
