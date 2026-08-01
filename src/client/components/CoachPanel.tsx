import {
  Lightbulb,
  Target,
  Eye,
  Gauge,
  TrendingUp,
  Sparkles,
  Scale,
} from 'lucide-react';
import type { CoachingBrief } from '@/shared/types';
import { humanize, mistakeLabel } from '@/client/lib/format';

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        {title}
      </h3>
      <div className="text-sm leading-relaxed text-foreground/90">{children}</div>
    </section>
  );
}

export function CoachPanel({ brief }: { brief: CoachingBrief }) {
  return (
    <div className="space-y-5 rounded-xl border border-primary/20 bg-gradient-to-b from-primary/[0.06] to-transparent p-5">
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/15 text-primary">
          <Sparkles className="h-4 w-4" />
        </div>
        <h2 className="text-base font-bold">Coach</h2>
      </div>

      {/* Calibration — predicted vs actual, surfaced prominently when present */}
      {brief.calibration && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-400/90">
            <Scale className="h-3.5 w-3.5" />
            Calibration
          </h3>
          <p className="mt-1.5 text-sm leading-relaxed text-foreground/90">
            {brief.calibration}
          </p>
        </div>
      )}

      {brief.approach && (
        <Section icon={<Lightbulb className="h-3.5 w-3.5" />} title="Your approach">
          <p>{brief.approach}</p>
        </Section>
      )}

      {brief.missed.length > 0 && (
        <Section icon={<Target className="h-3.5 w-3.5" />} title="What you missed">
          <ul className="space-y-1.5">
            {brief.missed.map((m, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-400/80" />
                <span>{m}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Pattern callout — the centerpiece */}
      {(brief.pattern || brief.patternRecognition) && (
        <div className="rounded-lg border border-primary/30 bg-primary/10 p-4">
          <div className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-primary" />
            <span className="text-xs font-semibold uppercase tracking-wide text-primary/80">
              Pattern
            </span>
          </div>
          {brief.pattern && (
            <p className="mt-1 text-lg font-bold text-primary">
              {humanize(brief.pattern)}
            </p>
          )}
          {brief.patternRecognition && (
            <div className="mt-2 space-y-1">
              <p className="text-xs font-semibold text-muted-foreground">
                How to recognize it next time
              </p>
              <p className="text-sm leading-relaxed text-foreground/90">
                {brief.patternRecognition}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Complexity comparison */}
      {(brief.complexity.yours || brief.complexity.optimal) && (
        <Section icon={<Gauge className="h-3.5 w-3.5" />} title="Complexity">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-border bg-muted/20 p-3">
              <div className="text-xs text-muted-foreground">Yours</div>
              <div className="mt-0.5 font-mono text-sm">{brief.complexity.yours}</div>
            </div>
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
              <div className="text-xs text-emerald-400/80">Optimal</div>
              <div className="mt-0.5 font-mono text-sm text-emerald-300/90">
                {brief.complexity.optimal}
              </div>
            </div>
          </div>
        </Section>
      )}

      {brief.improvement && (
        <div className="rounded-lg border border-border bg-muted/20 p-4">
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <TrendingUp className="h-3.5 w-3.5" />
            To get better
          </h3>
          <p className="mt-1.5 text-sm leading-relaxed text-foreground/90">
            {brief.improvement}
          </p>
        </div>
      )}

      {/* Recurring-failure tags for this attempt */}
      {brief.mistakeTags && brief.mistakeTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Flagged:</span>
          {brief.mistakeTags.map((t) => (
            <span
              key={t}
              className="inline-flex items-center rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-300/90"
            >
              {mistakeLabel(t)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
