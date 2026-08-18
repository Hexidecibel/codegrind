import { useState } from 'react';
import {
  Compass,
  ChevronDown,
  ChevronUp,
  ArrowRight,
  Flame,
  RotateCcw,
  Shuffle,
  TrendingUp,
  Sparkles,
  Snowflake,
} from 'lucide-react';
import type {
  SessionPlan,
  SchedulerWhy,
  SchedulerIntentKind,
} from '@/shared/types';
import { Badge } from '@/client/components/ui/badge';
import { HelpHint } from '@/client/components/HelpHint';
import { humanize } from '@/client/lib/format';
import { cn } from '@/lib/utils';

/**
 * Exported so the Help tab can enumerate the six reasons with the SAME label and
 * glyph the banner draws. A second list over there would be a second thing to
 * keep in step, and the one it would drift from is the one people actually see.
 */
export const KIND_META: Record<
  SchedulerIntentKind,
  { label: string; className: string; icon: typeof Flame }
> = {
  'warm-up': {
    label: 'Warm-up',
    className: 'border-sky-500/30 bg-sky-500/10 text-sky-400',
    icon: Flame,
  },
  reinforce: {
    label: 'Reinforce',
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
    icon: RotateCcw,
  },
  variation: {
    label: 'Variation',
    className: 'border-violet-500/30 bg-violet-500/10 text-violet-400',
    icon: Shuffle,
  },
  'level-up': {
    label: 'Level up',
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
    icon: TrendingUp,
  },
  'new-pattern': {
    label: 'New pattern',
    className: 'border-primary/40 bg-primary/10 text-primary',
    icon: Sparkles,
  },
  review: {
    label: 'Cold review',
    className:
      'border-rose-500/40 bg-gradient-to-r from-rose-500/15 to-amber-500/10 text-rose-300',
    icon: Snowflake,
  },
};

export function CoachBanner({
  plan,
  why,
  upNext,
}: {
  plan: SessionPlan;
  why: SchedulerWhy;
  upNext?: string;
}) {
  const [introOpen, setIntroOpen] = useState(false);
  const kind = KIND_META[why.kind];
  const KindIcon = kind.icon;

  return (
    <div className="shrink-0 border-b border-border bg-gradient-to-b from-primary/[0.07] to-transparent px-4 py-3">
      {/* Session theme + coach intro (collapsible) */}
      <button
        type="button"
        onClick={() => setIntroOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
          <Compass className="h-3.5 w-3.5" />
        </div>
        <span className="text-sm font-bold">{plan.theme}</span>
        <span className="text-xs text-muted-foreground">
          {introOpen ? 'Hide session plan' : 'Session plan'}
        </span>
        {introOpen ? (
          <ChevronUp className="ml-auto h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {introOpen && (
        <div className="mt-2 space-y-2 pl-8">
          <p className="text-sm leading-relaxed text-foreground/90">
            {plan.coachIntro}
          </p>
          {plan.focus.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Focus:</span>
              {plan.focus.map((t) => (
                <Badge key={t} variant="secondary" className="text-[11px]">
                  {humanize(t)}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Why this one */}
      <div className="mt-3 flex flex-wrap items-center gap-2 pl-8">
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold',
            kind.className,
          )}
        >
          <KindIcon className="h-3 w-3" />
          {kind.label}
        </span>
        <Badge variant="outline" className="text-[11px]">
          {humanize(why.topic)}
        </Badge>
        <span className="text-sm text-foreground/90">{why.text}</span>
        {/* The rationale says why THIS problem; the hint says who decided and
            on what evidence — which is the question the chip actually raises,
            and the one whose answer ("arithmetic over your own history, no
            model") is the reason to believe the rationale at all. */}
        <HelpHint id="why-this-problem" />
      </div>

      {/* Up next peek */}
      {upNext && (
        <div className="mt-1.5 flex items-center gap-1.5 pl-8 text-xs text-muted-foreground">
          <ArrowRight className="h-3.5 w-3.5" />
          <span>
            Up next: <span className="text-foreground/80">{upNext}</span>
          </span>
        </div>
      )}
    </div>
  );
}
