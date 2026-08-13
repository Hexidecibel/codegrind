import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Problem, Difficulty } from '@/shared/types';
import { Badge } from '@/client/components/ui/badge';
import { humanize } from '@/client/lib/format';
import { cn } from '@/lib/utils';

// Same four hues as reflect/chart.DIFFICULTY_COLOR (emerald / amber / rose /
// fuchsia), on the Tailwind scale this badge already used. The badge always
// prints the difficulty word — the emerald↔amber CVD warning on this set is
// only legal with that text label, so never drop it for a bare swatch.
const DIFFICULTY_STYLES: Record<Difficulty, string> = {
  easy: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  medium: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  hard: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
  expert: 'bg-fuchsia-500/15 text-fuchsia-400 border-fuchsia-500/30',
};

export function ProblemPanel({
  problem,
  footer,
}: {
  problem: Problem;
  /**
   * Rendered at the end of the scrolling column. The phone layout parks the
   * session/stats context down here so the problem statement comes first.
   */
  footer?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="space-y-4 p-6">
        <div className="space-y-3">
          <h1 className="text-xl font-bold leading-tight">{problem.title}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={cn('capitalize', DIFFICULTY_STYLES[problem.difficulty])}
            >
              {problem.difficulty}
            </Badge>
            <Badge variant="secondary">{humanize(problem.topic)}</Badge>
            <Badge
              variant="outline"
              className="border-primary/40 bg-primary/10 text-primary"
            >
              {humanize(problem.pattern)}
            </Badge>
          </div>
        </div>

        <article className="prose-cg">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{problem.prompt}</ReactMarkdown>
        </article>

        {problem.examples.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Examples
            </h2>
            {problem.examples.map((ex, i) => (
              <div
                key={i}
                className="rounded-lg border border-border bg-muted/20 p-3 text-sm"
              >
                <div className="mb-1 text-xs font-semibold text-muted-foreground">
                  Example {i + 1}
                </div>
                <dl className="space-y-1 font-mono text-[13px]">
                  <div className="flex gap-2">
                    <dt className="shrink-0 text-muted-foreground">Input:</dt>
                    <dd className="whitespace-pre-wrap break-all">{ex.input}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="shrink-0 text-muted-foreground">Output:</dt>
                    <dd className="whitespace-pre-wrap break-all">{ex.output}</dd>
                  </div>
                  {ex.explanation && (
                    <div className="flex gap-2 pt-1 font-sans text-[13px] text-muted-foreground">
                      <dt className="shrink-0">Explanation:</dt>
                      <dd>{ex.explanation}</dd>
                    </div>
                  )}
                </dl>
              </div>
            ))}
          </section>
        )}

        {problem.constraints.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Constraints
            </h2>
            <ul className="space-y-1 text-sm">
              {problem.constraints.map((c, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-muted-foreground">•</span>
                  <code className="font-mono text-[13px]">{c}</code>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {footer}
    </div>
  );
}
