// =============================================================================
// GradeReport — what a graded mock says, stage by stage
// =============================================================================
// Pure presentation over a MockGrade. The drill list is shown as text here;
// turning each drill into a startable exercise is Phase 2 (`POST /api/drill`).
// The mock's GAPS are split the way the grade weighs them: facts are cheap
// fixes, skills are practice areas. Every gap is already a drill card on the
// Mock tab (GapCards), so this section says so rather than offering a button.

import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ExternalLink,
  GraduationCap,
  Layers,
  ListChecks,
  MessageSquareQuote,
  XCircle,
} from 'lucide-react';
import type {
  MockCodingGrade,
  MockGrade,
  MockKind,
  MockQuestionGrade,
  MockUsage,
  MockVerdict,
  StoryBankStatus,
} from '@/shared/mock';
import { Link } from 'react-router-dom';
import { STORY_CAPTURE_URL } from '@/shared/behavioral-questions';
import type { MockGap } from '@/shared/gap-cards';
import { GAP_TYPE_META, cardFront } from '@/client/components/GapCards';
import { MOCK_LEVEL_LABEL } from '@/shared/sd';
import { mockKindInfo, stageLabel } from '@/shared/mock-kinds';
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

function GapList({ gaps, type }: { gaps: MockGap[]; type: MockGap['type'] }) {
  const list = gaps.filter((g) => g.type === type);
  if (!list.length) return null;
  const meta = GAP_TYPE_META[type];
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {type === 'fact' ? 'Cheap fixes — facts' : 'Practice areas — reasoning'}
        <span className="ml-1 font-normal normal-case tracking-normal">({meta.hint})</span>
      </div>
      <ul className="space-y-2 text-sm">
        {list.map((g) => (
          <li key={g.id} className="rounded-md border border-border px-3 py-2">
            <div className="font-medium">
              {cardFront(g)}
              {g.seq != null && <span className="ml-1 text-xs font-normal text-muted-foreground">#{g.seq}</span>}
            </div>
            {g.answer && <p className="mt-1 text-muted-foreground">{g.answer}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

const STAR_KEYS = ['situation', 'task', 'action', 'result'] as const;
const OWNERSHIP_LABEL: Record<MockQuestionGrade['ownership'], string> = { i: '"I"', we: '"we"', mixed: '"I" + "we"' };

function Pill({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'rounded border px-1.5 text-xs',
        ok ? 'border-emerald-500/40 text-emerald-300' : 'border-amber-500/40 text-amber-300',
      )}
    >
      {children}
    </span>
  );
}

/** Behavioral: one card per question — STAR, scope, I-vs-we, numbers, length, story fit, fidelity. */
function QuestionList({ questions, conceptLabel }: { questions: MockQuestionGrade[]; conceptLabel: (c: string) => string }) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        <MessageSquareQuote className="h-4 w-4" /> Question by question
      </h3>
      <ol className="space-y-2">
        {questions.map((q) => (
          <li key={q.stage} className="space-y-1.5 rounded-lg border border-border bg-card p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{q.stage.toUpperCase()} · {conceptLabel(q.concept)}</span>
              <ScoreDots score={q.scope} />
              <span className="text-xs text-muted-foreground">scope</span>
            </div>
            {q.question && <p className="italic text-muted-foreground">“{q.question}”</p>}
            <div className="flex flex-wrap gap-1.5">
              {STAR_KEYS.map((k) => (
                <Pill key={k} ok={q.star[k]}>
                  {k}
                </Pill>
              ))}
              <Pill ok={q.ownership === 'i'}>{OWNERSHIP_LABEL[q.ownership]}</Pill>
              <Pill ok={q.quantified}>{q.quantified ? 'quantified' : 'no number'}</Pill>
              <Pill ok={q.length === 'ok'}>
                {q.words ? `${q.words} words` : 'length'} · {q.length}
              </Pill>
              <Pill ok={q.storyFit === 'strong' || q.storyFit === 'ok'}>
                {q.storyId ? `story: ${q.storyId}` : 'no bank story'} · fit {q.storyFit}
              </Pill>
            </div>
            {q.fidelity && (
              <p className="text-amber-200/90">
                <span className="font-medium">Against your bank: </span>
                {q.fidelity}
              </p>
            )}
            {q.fix && (
              <p>
                <span className="font-medium">Fix: </span>
                {q.fix}
              </p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Coding: the hidden-test result the grade used, the pattern call, complexity, and the review-queue note. */
function CodingSummary({ coding }: { coding: MockCodingGrade }) {
  const t = coding.tests;
  const pass = t && !t.error && t.total > 0 && t.passed === t.total;
  return (
    <section className="space-y-1.5 rounded-lg border border-border bg-card p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-semibold">Hidden tests</span>
        {t ? (
          t.error ? (
            <span className="text-amber-300">could not run ({t.error})</span>
          ) : (
            <span className={pass ? 'text-emerald-300' : 'text-red-300'}>
              {t.passed}/{t.total} passed
            </span>
          )
        ) : (
          <span className="text-muted-foreground">never ran — no code was written</span>
        )}
        {t && !t.error && (
          <span className="text-xs text-muted-foreground">
            {t.source === 'submit' ? 'from your last Submit' : 'your final code, run at End'}
          </span>
        )}
      </div>
      {t && t.failing.length > 0 && (
        <div className="text-xs text-muted-foreground">Failing: {t.failing.join(', ')}</div>
      )}
      <div>
        <span className="font-semibold">Pattern</span>{' '}
        <span className={coding.patternMissed ? 'text-amber-300' : 'text-emerald-300'}>
          {coding.patternMissed ? 'missed' : 'found it yourself'}
        </span>
        {coding.patternNote && <span className="text-muted-foreground"> — {coding.patternNote}</span>}
      </div>
      <div>
        <span className="font-semibold">Complexity</span>{' '}
        <span className="text-muted-foreground">
          yours: {coding.complexityStated || 'not stated'}
          {coding.complexityOptimal ? ` · optimal: ${coding.complexityOptimal}` : ''}
        </span>
      </div>
      {coding.reviewQueued && (
        <p className="text-xs text-sky-300">
          This problem is now on your review queue — Grind will bring it back cold.
        </p>
      )}
    </section>
  );
}

export function GradeReport({
  grade,
  usage,
  gaps = [],
  kind = 'system-design',
  storyBank,
}: {
  grade: MockGrade;
  usage?: MockUsage;
  gaps?: MockGap[];
  kind?: MockKind;
  /** Behavioral: whether the story bank loaded when the mock started. */
  storyBank?: StoryBankStatus;
}) {
  const { conceptLabel } = mockKindInfo(kind);
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
        {storyBank && !storyBank.loaded && (
          <p className="flex items-center gap-1.5 text-xs text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" /> Your story bank was unavailable when this mock started
            {storyBank.error ? ` (${storyBank.error})` : ''} — stories were judged on the transcript alone, with no
            fidelity check.
          </p>
        )}
      </div>

      {grade.coding && <CodingSummary coding={grade.coding} />}

      {grade.questions && grade.questions.length > 0 && (
        <QuestionList questions={grade.questions} conceptLabel={conceptLabel} />
      )}

      {grade.storyGaps && grade.storyGaps.length > 0 && (
        <section className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <BookOpen className="h-4 w-4" /> Stories to capture
          </h3>
          <ul className="space-y-1 text-sm">
            {grade.storyGaps.map((g) => (
              <li key={g.concept}>
                <span className="font-medium">{conceptLabel(g.concept)}</span>
                {g.note && <span className="text-muted-foreground"> — {g.note}</span>}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {grade.storyGaps.map((g) => (
              <Link
                key={g.concept}
                to={`/stories?competency=${encodeURIComponent(g.concept)}`}
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                Forge a {conceptLabel(g.concept).toLowerCase()} story
              </Link>
            ))}
          </div>
          <a
            href={STORY_CAPTURE_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
          >
            Or capture them in resume-builder (Interview → Capture) <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </section>
      )}

      {grade.dimensions && grade.dimensions.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Deep-dive rubric</h3>
          <ul className="space-y-1 text-sm">
            {grade.dimensions.map((d) => (
              <li key={d.concept} className="flex gap-2">
                <span className="w-8 shrink-0 tabular-nums font-medium">{d.score}/4</span>
                <span>
                  <span className="font-medium">{conceptLabel(d.concept)}</span>
                  {d.note && <span className="text-muted-foreground"> — {d.note}</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {grade.fidelity && grade.fidelity.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Fidelity — claims checked against your story bank and resume</h3>
          <ul className="space-y-1 text-sm">
            {grade.fidelity.map((f, i) => (
              <li key={i}>
                <span
                  className={cn(
                    'mr-2 rounded-full px-2 py-0.5 text-[11px]',
                    f.status === 'contradicted' ? 'bg-rose-500/15 text-rose-300' : 'bg-amber-500/15 text-amber-300'
                  )}
                >
                  {f.status}
                </span>
                <span className="font-medium">{f.claim}</span>
                {f.note && <span className="text-muted-foreground"> — {f.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Stage by stage</h3>
        <ol className="space-y-2">
          {grade.stages.map((s) => (
            <li key={s.stage} className="rounded-lg border border-border bg-card p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{stageLabel(kind, s.stage)}</span>
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

      {gaps.length > 0 && (
        <section className="space-y-3">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Layers className="h-4 w-4" /> Gaps — each is now a drill card on the Mock tab
          </h3>
          <GapList gaps={gaps} type="skill" />
          <GapList gaps={gaps} type="fact" />
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
