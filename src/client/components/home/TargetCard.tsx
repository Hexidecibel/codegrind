// =============================================================================
// TargetCard — "Target next": one topic, one reason, one button
// =============================================================================
// The server picks it (weekly.compute.pickTarget); this only renders.

import { Link } from 'react-router-dom';
import { ArrowRight, Crosshair } from 'lucide-react';
import type { WeeklyTarget } from '@/shared/weekly';
import { humanize } from '@/client/lib/format';
import { Button } from '@/client/components/ui/button';
import { HomeCard } from './HomeCard';

const BUTTON: Readonly<Record<WeeklyTarget['kind'], string>> = {
  refresh: 'Open the shape',
  review: 'Clear reviews',
  struggling: 'Practice it',
  unseen: 'Try it',
  untouched: 'Try one',
  grind: 'Grind',
};

export function TargetCard({ target }: { target: WeeklyTarget }) {
  return (
    <HomeCard title="Target next" icon={Crosshair} className="h-full">
      <div className="space-y-1">
        {target.topic && <p className="font-semibold">{humanize(target.topic)}</p>}
        <p className="text-sm text-muted-foreground">{target.reason}</p>
      </div>
      <Button asChild variant="secondary" className="gap-1.5 self-start">
        <Link to={target.href}>
          {BUTTON[target.kind]} <ArrowRight className="h-4 w-4" />
        </Link>
      </Button>
    </HomeCard>
  );
}
