import { useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  Eye,
  Code2,
  AlertTriangle,
  Star,
} from 'lucide-react';
import type { Primer } from '@/shared/types';
import { humanize } from '@/client/lib/format';

/**
 * A durable per-pattern cheat-sheet card: recognition cues, a reusable code
 * template, common pitfalls, and one canonical worked example. Collapsible;
 * `defaultOpen` controls the initial state (open the first time it's surfaced).
 */
export function PatternPrimer({
  primer,
  defaultOpen = true,
}: {
  primer: Primer;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-xl border border-violet-500/25 bg-gradient-to-b from-violet-500/[0.07] to-transparent">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-violet-500/15 text-violet-400">
          <BookOpen className="h-3.5 w-3.5" />
        </div>
        <span className="text-sm font-bold">Primer</span>
        <span className="text-sm font-semibold text-violet-300/90">
          {humanize(primer.pattern)}
        </span>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          recognition cues · template · pitfalls
        </span>
        {open ? (
          <ChevronUp className="ml-auto h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="space-y-4 border-t border-violet-500/20 p-4">
          {/* Recognition cues */}
          {primer.recognitionCues.length > 0 && (
            <section className="space-y-1.5">
              <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Eye className="h-3.5 w-3.5" />
                Recognition cues
              </h3>
              <ul className="space-y-1.5 text-sm leading-relaxed text-foreground/90">
                {primer.recognitionCues.map((c, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400/80" />
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Template */}
          {primer.template && (
            <section className="space-y-1.5">
              <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Code2 className="h-3.5 w-3.5" />
                Template
              </h3>
              <pre className="overflow-x-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed text-foreground/90">
                <code>{primer.template}</code>
              </pre>
            </section>
          )}

          {/* Pitfalls */}
          {primer.pitfalls.length > 0 && (
            <section className="space-y-1.5">
              <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <AlertTriangle className="h-3.5 w-3.5" />
                Common pitfalls
              </h3>
              <ul className="space-y-1.5 text-sm leading-relaxed text-foreground/90">
                {primer.pitfalls.map((p, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-400/80" />
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Canonical example */}
          {(primer.example.title || primer.example.insight) && (
            <div className="rounded-lg border border-border bg-muted/20 p-4">
              <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Star className="h-3.5 w-3.5" />
                Canonical example
              </h3>
              {primer.example.title && (
                <p className="mt-1.5 text-sm font-semibold text-foreground">
                  {primer.example.title}
                </p>
              )}
              {primer.example.insight && (
                <p className="mt-1 text-sm leading-relaxed text-foreground/90">
                  {primer.example.insight}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
