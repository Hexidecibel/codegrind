// =============================================================================
// HistoryRow — one attempt, moved here from the retired ProgressDashboard
// =============================================================================
// The only change from the original: difficulty now renders through
// `DifficultyTag`, which draws the validated triad as a coloured mark beside a
// text label instead of tinting the label itself. Same information, but the
// text keeps a text token, and the label is no longer optional.

import { Check, X } from 'lucide-react';
import type { AttemptRecord } from '@/shared/types';
import { DIFFICULTY_COLOR } from './chart';
import { DifficultyTag } from './primitives';
import { humanize, shortDate } from '@/client/lib/format';

export function HistoryRow({ a }: { a: AttemptRecord }) {
  const Icon = a.solved ? Check : X;
  return (
    <div className="flex items-center gap-3 border-b border-border/60 py-2.5 last:border-0">
      <Icon
        className="h-3.5 w-3.5 shrink-0"
        strokeWidth={3}
        style={{
          color: a.solved ? DIFFICULTY_COLOR.easy : DIFFICULTY_COLOR.hard,
        }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          <span className="sr-only">{a.solved ? 'Solved: ' : 'Failed: '}</span>
          {a.problemTitle}
        </div>
        <div className="text-xs text-muted-foreground">
          {humanize(a.pattern)} · {a.testsPassed}/{a.testsTotal} tests
          {a.hintsUsed > 0 && ` · ${a.hintsUsed} hint${a.hintsUsed === 1 ? '' : 's'}`}
        </div>
      </div>
      <DifficultyTag difficulty={a.difficulty} />
      <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
        {shortDate(a.createdAt)}
      </span>
    </div>
  );
}
