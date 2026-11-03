// =============================================================================
// BestOnIpad — the coding places, met on a phone
// =============================================================================
// Writing code on a phone keyboard is practice for the wrong thing. /grind and
// /manual open on this card instead: a tablet, one line, ONE thing the phone is
// good for right now, and a quiet way through for whoever really means it.
//
// "Open anyway" is remembered for the tab's session only (sessionStorage), so
// tomorrow the phone asks again. Storage that throws (private mode) just means
// the card shows again on the next visit.

import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { Tablet } from 'lucide-react';
import { useIsPhone } from '@/client/hooks/useMediaQuery';
import { Button } from '@/client/components/ui/button';

export type IpadAction = { label: string; to: string } | { label: string; onClick: () => void };

export function BestOnIpad({ action, onOpenAnyway }: { action: IpadAction; onOpenAnyway: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-6 py-10 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-secondary">
        <Tablet className="h-10 w-10 text-muted-foreground" strokeWidth={1.5} />
      </div>
      <p className="text-lg font-medium">Code this on iPad.</p>
      <div className="flex w-full max-w-xs flex-col items-center gap-3">
        {'to' in action ? (
          <Button asChild className="h-12 w-full text-base">
            <Link to={action.to}>{action.label}</Link>
          </Button>
        ) : (
          <Button className="h-12 w-full text-base" onClick={action.onClick}>
            {action.label}
          </Button>
        )}
        <button
          type="button"
          onClick={onOpenAnyway}
          className="min-h-11 px-3 text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          Open anyway
        </button>
      </div>
    </div>
  );
}

const flagKey = (place: string) => `codegrind.openAnyway.${place}`;

function readFlag(place: string): boolean {
  try {
    return sessionStorage.getItem(flagKey(place)) === '1';
  } catch {
    return false;
  }
}

/**
 * Should `place` show the BestOnIpad card? Only on a phone, and only until
 * "Open anyway" is pressed in this tab's session.
 */
export function useIpadGate(place: string): { gated: boolean; openAnyway: () => void } {
  const isPhone = useIsPhone();
  const [opened, setOpened] = useState(() => readFlag(place));
  const openAnyway = useCallback(() => {
    try {
      sessionStorage.setItem(flagKey(place), '1');
    } catch {
      // The card simply shows again next visit.
    }
    setOpened(true);
  }, [place]);
  return { gated: isPhone && !opened, openAnyway };
}
