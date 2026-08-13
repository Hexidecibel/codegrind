import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Lightbulb,
  Code2,
  AlertTriangle,
  ListOrdered,
  Shuffle,
  AlertCircle,
  Sparkles,
  HelpCircle,
  Check,
} from 'lucide-react';
import type { Lesson, LessonKind } from '@/shared/types';
import { markLessonRead } from '@/client/lib/api';
import { humanize } from '@/client/lib/format';
import { cn } from '@/lib/utils';

/**
 * Per-kind visual treatment. Same language as PatternPrimer: a tinted chip,
 * a hairline border and a top-down wash, violet for "here is how it works"
 * and rose for "here is how it bites you". `chip` is what the dim-mode
 * desaturation hooks onto via .study-accent.
 */
const KIND_STYLES: Record<
  LessonKind,
  { icon: typeof Lightbulb; label: string; chip: string; rule: string }
> = {
  concept: {
    icon: Lightbulb,
    label: 'Concept',
    chip: 'bg-violet-500/15 text-violet-300',
    rule: 'border-violet-500/25 from-violet-500/[0.06]',
  },
  template: {
    icon: Code2,
    label: 'Template',
    chip: 'bg-indigo-500/15 text-indigo-300',
    rule: 'border-indigo-500/25 from-indigo-500/[0.06]',
  },
  pitfall: {
    icon: AlertTriangle,
    label: 'Pitfall',
    chip: 'bg-rose-500/15 text-rose-300',
    rule: 'border-rose-500/25 from-rose-500/[0.06]',
  },
  walkthrough: {
    icon: ListOrdered,
    label: 'Walkthrough',
    chip: 'bg-emerald-500/15 text-emerald-300',
    rule: 'border-emerald-500/25 from-emerald-500/[0.06]',
  },
  variation: {
    icon: Shuffle,
    label: 'Variation',
    chip: 'bg-amber-500/15 text-amber-300',
    rule: 'border-amber-500/25 from-amber-500/[0.06]',
  },
  mistake: {
    icon: AlertCircle,
    label: 'Your mistake',
    chip: 'bg-rose-500/20 text-rose-300',
    rule: 'border-rose-500/30 from-rose-500/[0.08]',
  },
};

/**
 * One lesson in the Study feed — a screenful of markdown, an optional code
 * snippet, and the one sentence worth remembering.
 *
 * Read-tracking is NOT this component's job: StudyPage observes a sentinel
 * underneath the card and marks it read from scroll position. The only
 * control here is the quiet "still fuzzy" button, which re-queues the lesson
 * server-side and is deliberately easy to ignore.
 */
export function LessonCard({ lesson }: { lesson: Lesson }) {
  const [fuzzy, setFuzzy] = useState(false);
  const style = KIND_STYLES[lesson.kind] ?? KIND_STYLES.concept;
  const Icon = style.icon;

  const markFuzzy = () => {
    if (fuzzy) return;
    setFuzzy(true);
    // Fire-and-forget: nothing on screen depends on the round-trip, and a
    // failed re-queue is not worth interrupting a reading session over.
    void markLessonRead(lesson.id, true).catch(() => setFuzzy(false));
  };

  return (
    <article
      className={cn(
        'rounded-xl border bg-gradient-to-b to-transparent px-4 py-5 sm:px-6 sm:py-6',
        style.rule,
      )}
    >
      {/* Kind + topic strip */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={cn(
            'study-accent inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-semibold',
            style.chip,
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {style.label}
        </span>
        <span className="text-muted-foreground">{humanize(lesson.topic)}</span>
        {lesson.seq < 1000 && (
          <span className="text-muted-foreground/70">· {lesson.seq + 1}</span>
        )}
      </div>

      <h2 className="mt-3 text-xl font-bold leading-snug sm:text-2xl">
        {lesson.title}
      </h2>

      <div className="prose-study mt-3">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{lesson.body}</ReactMarkdown>
      </div>

      {lesson.code && (
        <pre className="mt-4 max-w-[68ch] overflow-x-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed text-foreground/90">
          <code>{lesson.code}</code>
        </pre>
      )}

      {/* Takeaway — the one sentence to carry out of the lesson. */}
      {lesson.takeaway && (
        <div className="mt-5 flex max-w-[68ch] gap-3 rounded-lg border border-border bg-muted/20 p-3.5">
          <Sparkles className="study-accent mt-0.5 h-4 w-4 shrink-0 text-violet-400" />
          <p className="text-[0.95rem] leading-relaxed text-foreground/90">
            {lesson.takeaway}
          </p>
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={markFuzzy}
          disabled={fuzzy}
          // Deliberately low-contrast: an escape hatch, not a call to action.
          className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground/70 transition-colors hover:text-foreground disabled:opacity-70"
        >
          {fuzzy ? (
            <>
              <Check className="h-3.5 w-3.5" />
              We&apos;ll come back to it
            </>
          ) : (
            <>
              <HelpCircle className="h-3.5 w-3.5" />
              Still fuzzy
            </>
          )}
        </button>
      </div>
    </article>
  );
}
