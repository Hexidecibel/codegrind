// =============================================================================
// StatTiles — the five numbers, and nothing else
// =============================================================================
// Hero numbers. No sparklines, no tooltips, no plot: a tile that needs a hover
// to be understood is a chart wearing the wrong clothes, and the charts below
// already do that job. Each tile is a value, a label, and a quiet icon.

import {
  BookOpen,
  ChevronsUp,
  CircleCheckBig,
  Flame,
  RotateCcw,
  Target,
  type LucideIcon,
} from 'lucide-react';
import type { ReflectTiles } from '@/shared/types';
import { RAMP, pct } from './chart';
import { Card } from '@/client/components/ui/card';
import { cn } from '@/lib/utils';

function Tile({
  icon: Icon,
  value,
  label,
  note,
  colour,
  emphasise,
}: {
  icon: LucideIcon;
  value: string;
  label: string;
  note?: string;
  colour: string;
  emphasise?: boolean;
}) {
  return (
    <Card
      className={cn(
        'flex flex-col gap-1 p-3.5',
        emphasise && 'border-violet-500/35 bg-violet-500/[0.06]',
      )}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: colour }} />
        <span className="truncate">{label}</span>
      </span>
      <span className="text-2xl font-bold leading-none tabular-nums text-foreground">
        {value}
      </span>
      <span className="text-[0.7rem] leading-tight text-muted-foreground">
        {note ?? ' '}
      </span>
    </Card>
  );
}

export function StatTiles({ tiles }: { tiles: ReflectTiles }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
      <Tile
        icon={CircleCheckBig}
        colour={RAMP[4]}
        value={String(tiles.solved)}
        label="Solved"
        note="problems cleared"
      />
      {/* The one number with no ceiling: every tier ever completed, across
          every topic. When the tree is fully open this is what still moves. */}
      <Tile
        icon={ChevronsUp}
        colour={RAMP[4]}
        value={String(tiles.tiersCleared)}
        label="Tiers cleared"
        note="across all topics"
      />
      <Tile
        icon={Flame}
        colour={RAMP[3]}
        value={String(tiles.streak)}
        label="Streak"
        note={`day${tiles.streak === 1 ? '' : 's'} in a row`}
      />
      <Tile
        icon={Target}
        colour={RAMP[2]}
        value={pct(tiles.hintFreeRate)}
        label="Hint-free"
        note="solves without a nudge"
      />
      <Tile
        icon={BookOpen}
        colour={RAMP[1]}
        value={String(tiles.lessonsRead)}
        label="Lessons read"
        note="in Study"
      />
      <Tile
        icon={RotateCcw}
        colour={RAMP[0]}
        value={String(tiles.reviewDue)}
        label="Review due"
        note={tiles.reviewDue > 0 ? 'waiting on you' : 'nothing overdue'}
        emphasise={tiles.reviewDue > 0}
      />
    </div>
  );
}
