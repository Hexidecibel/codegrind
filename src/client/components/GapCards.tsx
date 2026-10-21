// =============================================================================
// GapCards — every gap a mock exposed, drilled on a spaced schedule
// =============================================================================
// One card at a time: read the question, type or dictate an answer, then
// "Check my answer" — one small call grades it against the card back
// (got / shaky / missed + why) and pre-selects that grade; one tap confirms or
// overrides. With "AI reviews" off, or when the call fails, it is the old flow:
// reveal and grade yourself. The schedule is src/shared/gap-cards.ts
// (now → +2d → +5d → +10d → retired); only the grade you tap moves it.

import { useCallback, useEffect, useState } from 'react';
import { Eye, Layers, Loader2, Sparkles } from 'lucide-react';
import { checkGapCard, getGapCards, gradeGapCard } from '@/client/lib/api';
import {
  GAP_CARD_GRADES,
  describeOutcome,
  type GapCard,
  type GapCardCheck,
  type GapCardGrade,
  type GapCardsResponse,
} from '@/shared/gap-cards';
import { anyConceptLabel } from '@/shared/mock-kinds';
import { Button } from '@/client/components/ui/button';
import { cn } from '@/lib/utils';

export const GAP_TYPE_META = {
  fact: { label: 'Cheap fix', hint: 'a fact — one card closes it', className: 'border-sky-500/40 text-sky-300' },
  skill: { label: 'Practice area', hint: 'a reasoning move — closes with reps', className: 'border-amber-500/40 text-amber-300' },
} as const;

const GRADE_LABEL: Record<GapCardGrade, string> = { got: 'Got it', shaky: 'Shaky', missed: 'Missed' };
const GRADE_TONE: Record<GapCardGrade, string> = { got: 'text-emerald-400', shaky: 'text-amber-300', missed: 'text-rose-300' };

/** The front of a card. Gaps recorded before cards existed have no title. */
export function cardFront(card: Pick<GapCard, 'title' | 'concept' | 'summary'>): string {
  return card.title || `${anyConceptLabel(card.concept)}: ${card.summary}`;
}

function whenLabel(iso: string): string {
  const days = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  return days <= 0 ? 'later today' : days === 1 ? 'tomorrow' : `in ${days} days`;
}

export function CardFace({
  card,
  revealed,
  onReveal,
  onGrade,
  busy,
  aiReviews = false,
}: {
  card: GapCard;
  revealed: boolean;
  onReveal: () => void;
  onGrade: (g: GapCardGrade) => void;
  busy: boolean;
  /** Offer "Check my answer": one small call grades the answer vs the card back. */
  aiReviews?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [check, setCheck] = useState<GapCardCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  useEffect(() => {
    setDraft('');
    setCheck(null);
    setCheckError(null);
  }, [card.id]);
  const meta = GAP_TYPE_META[card.type];

  const runCheck = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      setCheck(await checkGapCard(card.id, draft));
    } catch (e) {
      // The fallback: the card back is still there, and so is self-grading.
      setCheckError(`AI grade unavailable (${(e as Error).message}) — grade it yourself.`);
    } finally {
      setChecking(false);
      onReveal();
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={cn('rounded border px-1.5 py-0.5 font-medium', meta.className)} title={meta.hint}>
          {meta.label}
        </span>
        <span className="text-muted-foreground">{anyConceptLabel(card.concept)}</span>
        {card.mockTitle && <span className="ml-auto text-muted-foreground">from {card.mockTitle}</span>}
      </div>
      <p className="font-medium leading-snug">{cardFront(card)}</p>
      {!revealed ? (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (aiReviews && (e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                void runCheck();
              }
            }}
            rows={aiReviews ? 5 : 3}
            placeholder={
              aiReviews
                ? 'Type or dictate your answer, then Check — the AI grades it against the card back. Blank or "I don\'t know" counts as missed.'
                : 'Answer it out loud or type it here (not saved) — then reveal.'
            }
            className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <div className="flex flex-wrap items-center gap-2">
            {aiReviews && (
              <Button onClick={() => void runCheck()} size="sm" disabled={checking || busy} className="gap-1.5">
                {checking ? <Loader2 className="animate-spin" /> : <Sparkles />}
                {checking ? 'Grading…' : 'Check my answer'}
              </Button>
            )}
            <Button onClick={onReveal} variant="outline" size="sm" disabled={checking}>
              <Eye /> {aiReviews ? 'Just reveal' : 'Reveal'}
            </Button>
            {aiReviews && <span className="text-xs text-muted-foreground">Ctrl/⌘+Enter checks</span>}
          </div>
        </>
      ) : (
        <>
          {draft.trim() && (
            <p className="whitespace-pre-wrap rounded-md border border-border/60 px-3 py-2 text-sm text-muted-foreground">
              {draft}
            </p>
          )}
          {check && (
            <div className="space-y-1 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                <span className={cn('font-semibold', GRADE_TONE[check.grade])}>{check.ai ? 'AI' : 'Auto'}: {GRADE_LABEL[check.grade]}</span>
                {check.costUsd != null && check.ai && (
                  <span className="ml-auto text-xs text-muted-foreground">${check.costUsd.toFixed(4)}</span>
                )}
              </div>
              {check.why && <p>{check.why}</p>}
              {check.missing.length > 0 && (
                <p className="text-xs text-muted-foreground">Missing: {check.missing.join(' · ')}</p>
              )}
            </div>
          )}
          {checkError && <p className="text-xs text-amber-300">{checkError}</p>}
          <div className="space-y-1.5 rounded-md bg-secondary/40 px-3 py-2 text-sm">
            {card.answer ? (
              <p className="leading-relaxed">{card.answer}</p>
            ) : (
              <p className="text-muted-foreground">No stored explanation — this gap predates drill cards.</p>
            )}
            {card.title && card.summary && card.summary !== card.title && (
              <p className="text-xs text-muted-foreground">In the mock: {card.summary}</p>
            )}
          </div>
          {check && (
            <p className="text-xs text-muted-foreground">
              Tap the AI&rsquo;s grade to confirm it, or any other to override.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {GAP_CARD_GRADES.map((g) => {
              const suggested = check?.grade === g;
              return (
                <Button
                  key={g}
                  size="sm"
                  variant={(check ? suggested : g === 'got') ? 'default' : 'outline'}
                  disabled={busy}
                  onClick={() => onGrade(g)}
                  title={describeOutcome(card, g)}
                  className={cn(suggested && 'ring-2 ring-primary')}
                >
                  {suggested ? `Confirm: ${GRADE_LABEL[g]}` : GRADE_LABEL[g]}
                  <span className="text-xs opacity-70">· {describeOutcome(card, g)}</span>
                </Button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export function GapCards({ onGraded }: { onGraded?: () => void } = {}) {
  const [data, setData] = useState<GapCardsResponse | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    getGapCards()
      .then((d) => {
        setData(d);
        setRevealed(false);
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  if (!data) return null;
  const total = data.due.length + data.upcoming + data.retired;
  if (total === 0) return null;
  const card = data.due[0];

  const grade = async (g: GapCardGrade) => {
    setBusy(true);
    setError(null);
    try {
      await gradeGapCard(card.id, g);
      load();
      onGraded?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="cards" className="scroll-mt-4 space-y-2" aria-label="Drill cards">
      <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
        <Layers className="h-4 w-4" /> Drill cards from your mocks
        <span className="font-normal text-muted-foreground">
          {data.due.length} due · {data.upcoming} scheduled · {data.retired} retired
        </span>
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      </h2>
      {card ? (
        <CardFace
          card={card}
          revealed={revealed}
          onReveal={() => setRevealed(true)}
          onGrade={grade}
          busy={busy}
          aiReviews={data.aiReviews}
        />
      ) : (
        <p className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
          Nothing due.{data.nextDueAt ? ` The next card comes up ${whenLabel(data.nextDueAt)}.` : ''}
        </p>
      )}
      {error && <p className="text-sm text-red-300">{error}</p>}
    </section>
  );
}
