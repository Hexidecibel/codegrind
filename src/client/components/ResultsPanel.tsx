import { CheckCircle2, XCircle, Clock, AlertTriangle, Ban } from 'lucide-react';
import type { RunResult, TestResult, Verdict } from '@/shared/types';
import { cn } from '@/lib/utils';

/**
 * Per-verdict presentation. `className` styles the chip inside the results
 * body; `textClass` is the bare text/icon colour for places that need the
 * verdict tone without the chip treatment (the phone summary strip).
 */
export const VERDICT_META: Record<
  Verdict,
  { label: string; className: string; textClass: string; icon: typeof CheckCircle2 }
> = {
  accepted: {
    label: 'Accepted',
    className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    textClass: 'text-emerald-400',
    icon: CheckCircle2,
  },
  wrong_answer: {
    label: 'Wrong Answer',
    className: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
    textClass: 'text-rose-400',
    icon: XCircle,
  },
  runtime_error: {
    label: 'Runtime Error',
    className: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
    textClass: 'text-orange-400',
    icon: AlertTriangle,
  },
  timeout: {
    label: 'Time Limit Exceeded',
    className: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    textClass: 'text-amber-400',
    icon: Clock,
  },
  error: {
    label: 'Execution Error',
    className: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
    textClass: 'text-rose-400',
    icon: Ban,
  },
};

function TestRow({ t }: { t: TestResult }) {
  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        t.passed
          ? 'border-emerald-500/20 bg-emerald-500/5'
          : 'border-rose-500/20 bg-rose-500/5',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {t.passed ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
          ) : (
            <XCircle className="h-4 w-4 shrink-0 text-rose-400" />
          )}
          <span className="truncate text-sm font-medium">{t.name}</span>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {Math.round(t.timeMs)}ms
        </span>
      </div>

      {!t.passed && (
        <div className="mt-2 space-y-1.5 pl-6 font-mono text-xs">
          {t.expected !== undefined && (
            <div className="flex gap-2">
              <span className="shrink-0 text-muted-foreground">expected</span>
              <span className="whitespace-pre-wrap break-all text-emerald-300/90">
                {t.expected}
              </span>
            </div>
          )}
          {t.actual !== undefined && (
            <div className="flex gap-2">
              <span className="shrink-0 text-muted-foreground">actual&nbsp;&nbsp;</span>
              <span className="whitespace-pre-wrap break-all text-rose-300/90">
                {t.actual}
              </span>
            </div>
          )}
          {t.stderr && (
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-black/40 p-2 text-rose-300/90">
              {t.stderr}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function ResultsPanel({
  result,
  mode,
}: {
  result: RunResult;
  mode: 'run' | 'submit';
}) {
  const meta = VERDICT_META[result.verdict];
  const Icon = meta.icon;

  return (
    <div className="space-y-3">
      <div
        className={cn(
          'flex items-center justify-between rounded-lg border px-4 py-2.5',
          meta.className,
        )}
      >
        <div className="flex items-center gap-2">
          <Icon className="h-5 w-5" />
          <span className="font-semibold">{meta.label}</span>
        </div>
        <span className="text-sm font-medium">
          {result.passed}/{result.total} {mode === 'run' ? 'sample' : 'hidden'} tests
        </span>
      </div>

      <div className="space-y-2">
        {result.results.map((t, i) => (
          <TestRow key={i} t={t} />
        ))}
      </div>
    </div>
  );
}
