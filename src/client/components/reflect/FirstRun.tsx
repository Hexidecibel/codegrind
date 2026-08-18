// =============================================================================
// FirstRun — what Reflect says before there is anything to reflect on
// =============================================================================
// The page below this card is left exactly as it is, deliberately. An empty
// skill tree is not a broken dashboard: it is the map of the whole curriculum,
// with three topics open and the rest showing what it costs to reach them. The
// tier ladder says the same thing in numbers. Hiding all that until the first
// solve would delete the one screen that explains where the grind is going.
//
// What was missing was a sentence in front of it. Six zero tiles and two blank
// charts with no framing read as software that failed to load, and this is the
// tab that is supposed to sell the premise — the memory a chatbot cannot offer.
//
// Tone is borrowed from StudyPage's exhaustion state ("That's everything for
// tonight."): a bordered box, a quiet icon, one bold line, one paragraph. No
// alarm colour, no call to action styled as a button — the actionable sentence
// is the UnlockCard directly underneath, which already says exactly which
// topic to grind and what it opens.
//
// The one rule it must not break is in reflect-empty.ts: lessonsRead and streak
// are GLOBAL, so this card never claims "nothing here yet" to somebody who has
// been reading Study or grinding another language.

import { Sparkles } from 'lucide-react';
import type { ReflectEmptiness } from '@/client/lib/reflect-empty';
import { earnedSentence } from '@/client/lib/reflect-empty';

/** One "this is what will appear" line. */
function Will({ what, when }: { what: string; when: string }) {
  return (
    <li className="flex flex-wrap gap-x-1.5 leading-relaxed">
      <span className="font-medium text-foreground">{what}</span>
      <span className="min-w-0 flex-1 text-muted-foreground">{when}</span>
    </li>
  );
}

export function FirstRun({ emptiness }: { emptiness: ReflectEmptiness }) {
  const earned = earnedSentence(emptiness);
  return (
    <div className="rounded-xl border border-border bg-muted/20 p-5 sm:p-6">
      <Sparkles className="h-5 w-5 text-violet-400" />
      <p className="mt-2 text-base font-semibold">
        This is where the grind adds up. Nothing has been submitted yet.
      </p>
      <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted-foreground">
        Every attempt you make is kept — which is the thing a chat window cannot do. Solve
        one problem in <strong className="font-medium text-foreground">Grind</strong> and
        this page starts answering &ldquo;am I actually getting better?&rdquo; instead of
        showing you the map.
      </p>
      {earned && (
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">
          {earned}
        </p>
      )}
      <ul className="mt-4 space-y-1.5 text-sm">
        <Will
          what="The skill tree is already drawn."
          when={`Every topic is on it. ${emptiness.openTopics} ${
            emptiness.openTopics === 1 ? 'is' : 'are'
          } open now; the rest unlock when a prerequisite clears its easy tier — 3 distinct problems solved with no hints.`}
        />
        <Will
          what="The six numbers fill in as you go."
          when="Solved, tiers cleared and hint-free rate move on your first submission; review due appears once something is old enough to be worth seeing again."
        />
        <Will
          what="Trends and mistakes need a few problems."
          when="First-submit accuracy and submits-to-pass are one point per problem, and the mistake ledger is built from the tags the coach attaches to your code."
        />
      </ul>
    </div>
  );
}
