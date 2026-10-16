// =============================================================================
// GapCards — every gap a mock exposed, drilled on a spaced schedule
// =============================================================================
// One card at a time: read the question, think (or type — nothing typed is
// saved or sent anywhere), reveal the stored explanation, grade yourself.
// Grading is a plain POST with no model behind it, so drilling is free; the
// schedule is src/shared/gap-cards.ts (now → +2d → +5d → +10d → retired).

import { useCallback, useEffect, useState } from 'react';
import { Eye, Layers, Loader2 } from 'lucide-react';
import { getGapCards, gradeGapCard } from '@/client/lib/api';
import {
  GAP_CARD_GRADES,
  describeOutcome,
  type GapCard,
  type GapCardGrade,
  type GapCardsResponse,
} from '@/shared/gap-cards';
import { conceptLabel } from '@/shared/sd';
import { Button } from '@/client/components/ui/button';
import { cn } from '@/lib/utils';

export const GAP_TYPE_META = {
  fact: { label: 'Cheap fix', hint: 'a fact — one card closes it', className: 'border-sky-500/40 text-sky-300' },
  skill: { label: 'Practice area', hint: 'a reasoning move — closes with reps', className: 'border-amber-500/40 text-amber-300' },
} as const;

const GRADE_LABEL: Record<GapCardGrade, string> = { got: 'Got it', shaky: 'Shaky', missed: 'Missed' };

/** The front of a card. Gaps recorded before cards existed have no title. */
export function cardFront(card: Pick<GapCard, 'title' | 'concept' | 'summary'>): string {
  return card.title || `${conceptLabel(card.concept)}: ${card.summary}`;
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
}: {
  card: GapCard;
  revealed: boolean;
  onReveal: () => void;
  onGrade: (g: GapCardGrade) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState('');
  useEffect(() => setDraft(''), [card.id]);
  const meta = GAP_TYPE_META[card.type];
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={cn('rounded border px-1.5 py-0.5 font-medium', meta.className)} title={meta.hint}>
          {meta.label}
        </span>
        <span className="text-muted-foreground">{conceptLabel(card.concept)}</span>
        {card.mockTitle && <span className="ml-auto text-muted-foreground">from {card.mockTitle}</span>}
      </div>
      <p className="font-medium leading-snug">{cardFront(card)}</p>
      {!revealed ? (
        <>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            placeholder="Answer it out loud or type it here (not saved) — then reveal."
            className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <Button onClick={onReveal} variant="outline" size="sm">
            <Eye /> Reveal
          </Button>
        </>
      ) : (
        <>
          {draft.trim() && (
            <p className="whitespace-pre-wrap rounded-md border border-border/60 px-3 py-2 text-sm text-muted-foreground">
              {draft}
            </p>
          )}
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
          <div className="flex flex-wrap gap-2">
            {GAP_CARD_GRADES.map((g) => (
              <Button
                key={g}
                size="sm"
                variant={g === 'got' ? 'default' : 'outline'}
                disabled={busy}
                onClick={() => onGrade(g)}
                title={describeOutcome(card, g)}
              >
                {GRADE_LABEL[g]}
                <span className="text-xs opacity-70">· {describeOutcome(card, g)}</span>
              </Button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function GapCards() {
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
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2" aria-label="Drill cards">
      <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
        <Layers className="h-4 w-4" /> Drill cards from your mocks
        <span className="font-normal text-muted-foreground">
          {data.due.length} due · {data.upcoming} scheduled · {data.retired} retired
        </span>
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      </h2>
      {card ? (
        <CardFace card={card} revealed={revealed} onReveal={() => setRevealed(true)} onGrade={grade} busy={busy} />
      ) : (
        <p className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
          Nothing due.{data.nextDueAt ? ` The next card comes up ${whenLabel(data.nextDueAt)}.` : ''}
        </p>
      )}
      {error && <p className="text-sm text-red-300">{error}</p>}
    </section>
  );
}
