// =============================================================================
// GradeReport — what a graded mock says, stage by stage
// =============================================================================
// Pure presentation over a MockGrade. The drill list is shown as text here;
// turning each drill into a startable exercise is Phase 2 (`POST /api/drill`).

import { AlertTriangle, CheckCircle2, GraduationCap, ListChecks, XCircle } from 'lucide-react';
import type { MockGrade, MockUsage, MockVerdict } from '@/shared/mock';
import { MOCK_LEVEL_LABEL, SD_STAGE_META, conceptLabel } from '@/shared/sd';
import { cn } from '@/lib/utils';

const VERDICT_META: Record<MockVerdict, { label: string; className: string }> = {
  below: { label: 'Below level', className: 'border-red-500/40 bg-red-500/10 text-red-300' },
  at: { label: 'At level', className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' },
  above: { label: 'Above level', className: 'border-sky-500/40 bg-sky-500/10 text-sky-300' },
};

function ScoreDots({ score }: { score: number }) {
  return (
    <span className="inline-flex gap-0.5" aria-label={`score ${score} of 4`} title={`${score} / 4`}>
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={cn('h-2 w-2 rounded-full', i <= score ? 'bg-primary' : 'bg-muted-foreground/30')}
        />
      ))}
    </span>
  );
}

export function GradeReport({ grade, usage }: { grade: MockGrade; usage?: MockUsage }) {
  const verdict = VERDICT_META[grade.verdict];
  const signals = { nailed: [] as string[], weak: [] as string[], missing: [] as string[] };
  for (const o of grade.conceptObservations) signals[o.signal].push(conceptLabel(o.concept));

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('rounded-md border px-2.5 py-1 text-sm font-semibold', verdict.className)}>
            {verdict.label}
          </span>
          <span className="text-sm text-muted-foreground">graded at {MOCK_LEVEL_LABEL[grade.level]}</span>
          {usage?.costUsd != null && (
            <span className="ml-auto text-xs text-muted-foreground">this mock cost ${usage.costUsd.toFixed(2)}</span>
          )}
        </div>
        {grade.summary && <p className="text-sm leading-relaxed">{grade.summary}</p>}
        {grade.degraded && (
          <p className="flex items-center gap-1.5 text-xs text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" /> Graded with the simpler fallback schema — concept
            observations are missing from this report.
          </p>
        )}
      </div>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Stage by stage</h3>
        <ol className="space-y-2">
          {grade.stages.map((s) => (
            <li key={s.stage} className="rounded-lg border border-border bg-card p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{SD_STAGE_META[s.stage].label}</span>
                <ScoreDots score={s.score} />
                {s.score === 0 ? (
                  <span className="text-xs text-muted-foreground">not reached</span>
                ) : s.atLevel ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-label="at level" />
                ) : (
                  <XCircle className="h-4 w-4 text-red-400" aria-label="not at level" />
                )}
                {grade.skipped.includes(s.stage) && (
                  <span className="rounded border border-amber-500/40 px-1.5 text-xs text-amber-300">skipped</span>
                )}
              </div>
              {s.score > 0 && <p className="mt-1.5 text-sm text-muted-foreground">{s.evidence}</p>}
              {(s.staffWouldAdd || s.principalWouldAdd) && (
                <dl className="mt-2 space-y-1 text-sm">
                  {s.staffWouldAdd && (
                    <div>
                      <dt className="inline font-medium">A Staff answer adds: </dt>
                      <dd className="inline">{s.staffWouldAdd}</dd>
                    </div>
                  )}
                  {s.principalWouldAdd && (
                    <div>
                      <dt className="inline font-medium">A Principal answer adds: </dt>
                      <dd className="inline">{s.principalWouldAdd}</dd>
                    </div>
                  )}
                </dl>
              )}
            </li>
          ))}
        </ol>
      </section>

      {grade.drills.length > 0 && (
        <section className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <ListChecks className="h-4 w-4" /> Drills, most valuable first
          </h3>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            {grade.drills.map((d, i) => (
              <li key={i}>
                <span className="font-medium">{conceptLabel(d.concept)}:</span> {d.prompt}
                {d.why && <span className="block text-xs text-muted-foreground">{d.why}</span>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {grade.gapsTaught.length > 0 && (
        <section className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <GraduationCap className="h-4 w-4" /> Taught during the mock (not scored)
          </h3>
          <ul className="space-y-1 text-sm">
            {grade.gapsTaught.map((g, i) => (
              <li key={i}>
                <span className="font-medium">{conceptLabel(g.concept)}</span>
                {g.summary && <span className="text-muted-foreground"> — {g.summary}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {grade.conceptObservations.length > 0 && (
        <section className="grid gap-2 text-sm sm:grid-cols-3">
          {(['nailed', 'weak', 'missing'] as const).map((k) => (
            <div key={k} className="rounded-lg border border-border p-3">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{k}</div>
              {signals[k].length ? signals[k].join(', ') : <span className="text-muted-foreground">—</span>}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
