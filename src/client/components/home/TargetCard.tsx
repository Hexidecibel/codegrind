// =============================================================================
// TargetCard — "Target next": one reason, one button
// =============================================================================
// The server picks it (weekly.compute.pickTarget); this only renders.

import { Link } from 'react-router-dom';
import { ArrowRight, Crosshair } from 'lucide-react';
import type { WeeklyTarget } from '@/shared/weekly';
import { Button } from '@/client/components/ui/button';

const BUTTON: Readonly<Record<WeeklyTarget['kind'], string>> = {
  refresh: 'Open the shape',
  review: 'Clear reviews',
  struggling: 'Practice it',
  unseen: 'Start',
  untouched: 'Try one',
  grind: 'Grind',
};

export function TargetCard({ target }: { target: WeeklyTarget }) {
  return (
    <section aria-label="Target next" className="flex h-full flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Crosshair className="h-4 w-4 text-primary" aria-hidden /> Target next
      </h2>
      <p className="flex-1 text-sm">{target.reason}</p>
      <Button asChild variant="secondary" className="gap-1.5 self-start">
        <Link to={target.href}>
          {BUTTON[target.kind]} <ArrowRight className="h-4 w-4" />
        </Link>
      </Button>
    </section>
  );
}
