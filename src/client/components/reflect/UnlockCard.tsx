// =============================================================================
// UnlockCard — the single most motivating element on the page
// =============================================================================
// The whole feature exists because the app knew, and never said, that a couple
// of clean arrays solves would complete its easy tier and open three more
// topics. That sentence is this card. It gets real weight: the biggest type on
// the page, above the fold, above the tree.
//
// "Clean solve" is load-bearing in the copy and in the maths: a DISTINCT
// problem, zero hints. Re-submitting something that already passes moves this
// number not at all, so the card can never promise an unlock you can fake.
//
// It also carries the "how far in" meter — N of 18 topics reached — as 18
// discrete segments rather than a smooth bar, because the denominator is small
// and countable and that reads as progress through a *curriculum*, not a
// percentage.

import type { ReactNode } from 'react';
import { Lock, Sparkles, Target } from 'lucide-react';
import type { ReflectNextUnlock, Topic } from '@/shared/types';
import { UNLOCK_GATE, RAMP, pct, rampFor } from './chart';
import { humanize } from '@/client/lib/format';
import { Card } from '@/client/components/ui/card';
import { cn } from '@/lib/utils';

export function UnlockCard({
  nextUnlock,
  topicsReached,
  totalTopics,
}: {
  nextUnlock: ReflectNextUnlock | null;
  topicsReached: number;
  totalTopics: number;
}) {
  const reached = Math.max(0, Math.min(topicsReached, totalTopics));
  const done = totalTopics > 0 && reached >= totalTopics;

  return (
    <Card className="overflow-hidden border-violet-500/25 p-5 sm:p-6">
      {/* --- N / 18 meter ------------------------------------------------- */}
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold text-muted-foreground">
          Curriculum reached
        </span>
        <span className="ml-auto text-sm tabular-nums text-muted-foreground">
          <span className="text-base font-bold text-foreground">{reached}</span> /{' '}
          {totalTopics} topics
        </span>
      </div>
      <div
        className="mt-2 flex gap-[3px]"
        role="img"
        aria-label={`${reached} of ${totalTopics} topics reached`}
      >
        {Array.from({ length: totalTopics }, (_, i) => (
          <span
            key={i}
            className={cn('h-2 flex-1 rounded-[2px]', i >= reached && 'bg-muted')}
            style={
              i < reached
                ? { backgroundColor: rampFor(totalTopics <= 1 ? 1 : i / (totalTopics - 1)) }
                : undefined
            }
          />
        ))}
      </div>

      {/* --- the callout --------------------------------------------------- */}
      <div className="mt-5 border-t border-border pt-5">
        {nextUnlock ? (
          <NextUnlock unlock={nextUnlock} />
        ) : done ? (
          <Headline
            icon={<Sparkles className="h-5 w-5" />}
            title="The whole tree is open."
            body="Nothing is gated any more — from here it's depth, not breadth. The tier ladder below shows how far up each topic has climbed, and the top tier keeps counting."
          />
        ) : (
          <Headline
            icon={<Lock className="h-5 w-5" />}
            title="No unlock is within reach yet."
            body="Every locked topic needs more than a handful of clean solves right now. Grind an available topic and this will fill in."
          />
        )}
      </div>
    </Card>
  );
}

function NextUnlock({ unlock }: { unlock: ReflectNextUnlock }) {
  const { topic, cleanSolvesNeeded, currentMastery, unlocks } = unlock;
  const n = Math.max(1, cleanSolvesNeeded);
  const gateColour = RAMP[3];

  return (
    <div>
      <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Target className="h-3.5 w-3.5" style={{ color: gateColour }} />
        Next unlock
      </p>

      {/* The sentence. Deliberately the largest thing on the page. */}
      <p className="mt-2 text-xl font-bold leading-snug sm:text-2xl">
        {n} new clean {humanize(topic)} solve{n === 1 ? '' : 's'}
        <span className="mx-2 font-normal text-muted-foreground">→</span>
        <UnlockList topics={unlocks} />
      </p>

      {/* How close that topic is to the gate, drawn as the gate. */}
      <div className="mt-4">
        <div className="flex items-baseline justify-between text-xs text-muted-foreground">
          <span>{humanize(topic)} progress</span>
          <span className="tabular-nums">
            <span className="font-semibold text-foreground">{pct(currentMastery)}</span>
            {' of the '}
            {pct(UNLOCK_GATE)} that opens it
          </span>
        </div>
        <div className="relative mt-1.5 h-3 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.min(100, Math.max(currentMastery, 0) * 100)}%`,
              backgroundColor: rampFor(currentMastery),
            }}
          />
          {/* The gate itself — the reason any of this is happening. */}
          <div
            className="absolute inset-y-0 w-0.5 bg-foreground/70"
            style={{ left: `${UNLOCK_GATE * 100}%` }}
            aria-hidden
          />
        </div>
        <p className="mt-1 text-[0.7rem] text-muted-foreground">
          The marker is the easy tier — 3 distinct problems solved with no
          hints. Each quarter of the bar is one completed tier.
        </p>
      </div>
    </div>
  );
}

/**
 * The topics that open up. Each name wears the text token and is preceded by a
 * ramp-coloured dot — the mark carries the identity, the text stays readable.
 */
function UnlockList({ topics }: { topics: Topic[] }) {
  if (topics.length === 0) return <span className="text-muted-foreground">progress</span>;
  return (
    <>
      {topics.map((t, i) => (
        <span key={t} className="whitespace-nowrap">
          {i > 0 && <span className="mx-1.5 font-normal text-muted-foreground">·</span>}
          <span
            aria-hidden
            className="mr-1.5 inline-block h-2 w-2 rounded-full align-middle"
            style={{ backgroundColor: RAMP[4] }}
          />
          <span className="text-foreground">{humanize(t)}</span>
        </span>
      ))}
    </>
  );
}

function Headline({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <div>
        <p className="text-lg font-bold leading-snug">{title}</p>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
