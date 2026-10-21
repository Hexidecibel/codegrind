// =============================================================================
// Mock — an interview over chat (system design today), graded at a level
// =============================================================================
//   /mock        the start card (kind, level, prompt, the cost estimate) + recent mocks
//   /mock/:id    the interview, or its grade report once graded
//
// No streaming, by decision: an interviewer reply takes ~5-10 seconds and the
// page says so while it waits. Every model call is a button press; the page's
// own reads (the list, the mock) are free GETs.
//
// THE COMPOSER IS NEVER CLEARED ON FAILURE. The server stores a candidate turn
// only together with the reply to it, so a failed send means nothing happened —
// and the text stays where it was so pressing Send again is the whole recovery.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowRight,
  BookOpenCheck,
  Flag,
  GraduationCap,
  HelpCircle,
  Loader2,
  MessagesSquare,
  Send,
  SkipForward,
  X,
} from 'lucide-react';
import {
  abandonMock,
  endMock,
  getMock,
  getMockPrompts,
  listMocks,
  sendMockTurn,
  startMock,
  ApiError,
  type MockPromptOption,
} from '@/client/lib/api';
import {
  estimateMockCost,
  type MockAction,
  type MockSummary,
  type MockTurn,
  type MockView,
} from '@/shared/mock';
import { DEFAULT_MOCK_LEVEL, MOCK_LEVELS, MOCK_LEVEL_LABEL, type MockLevel } from '@/shared/sd';
import {
  DEFAULT_MOCK_KIND,
  MOCK_KINDS,
  UPCOMING_MOCK_KINDS,
  mockKindInfo,
  mockPromptTitle,
  type MockKind,
} from '@/shared/mock-kinds';
import { Button } from '@/client/components/ui/button';
import { GradeReport } from '@/client/components/GradeReport';
import { GapCards } from '@/client/components/GapCards';
import { cn } from '@/lib/utils';

function ErrorBar({ error, onClose }: { error: ApiError | Error; onClose?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
      <div className="flex-1">
        {error.message}
        {error instanceof ApiError && error.detail && (
          <details className="mt-1 text-xs text-red-300/80">
            <summary className="cursor-pointer">details</summary>
            <pre className="whitespace-pre-wrap">{error.detail}</pre>
          </details>
        )}
      </div>
      {onClose && (
        <button onClick={onClose} aria-label="Dismiss" className="text-red-300 hover:text-red-100">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function titleOf(view: MockView): string {
  return mockPromptTitle(view.kind, view.promptId) || mockKindInfo(view.kind).label;
}

function Markdown({ children }: { children: string }) {
  return (
    <div className="prose-study text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

// -----------------------------------------------------------------------------
// The start card
// -----------------------------------------------------------------------------

function StartCard() {
  const navigate = useNavigate();
  const [kind, setKind] = useState<MockKind>(DEFAULT_MOCK_KIND);
  const [level, setLevel] = useState<MockLevel>(DEFAULT_MOCK_LEVEL);
  const [promptId, setPromptId] = useState('');
  const [prompts, setPrompts] = useState<MockPromptOption[]>([]);
  const [mocks, setMocks] = useState<MockSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const info = mockKindInfo(kind);

  useEffect(() => {
    listMocks().then((r) => setMocks(r.mocks)).catch(() => setMocks([]));
  }, []);

  // Prompt ids are per kind: switching kind clears the choice and reloads the list.
  useEffect(() => {
    setPromptId('');
    setPrompts([]);
    getMockPrompts(kind).then((r) => setPrompts(r.prompts)).catch(setError);
  }, [kind]);

  const typical = estimateMockCost(info.typicalTurns).usd;
  const worst = estimateMockCost(info.turnCap).usd;
  const active = mocks?.find((m) => m.status === 'active' || m.status === 'grade_failed');

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const view = await startMock({ kind, level, ...(promptId ? { promptId } : {}) });
      navigate(`/mock/${view.id}`);
    } catch (err) {
      setError(err as Error);
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <MessagesSquare className="h-6 w-6" /> Mock interview
        </h1>
        <p className="text-sm text-muted-foreground">{info.start.blurb}</p>
      </div>

      {active && (
        <Link
          to={`/mock/${active.id}`}
          className="flex items-center justify-between rounded-lg border border-primary/40 bg-primary/10 px-4 py-3 text-sm hover:bg-primary/15"
        >
          <span>
            Resume <span className="font-medium">{active.promptTitle}</span> ({active.candidateTurns} turns in)
          </span>
          <ArrowRight className="h-4 w-4" />
        </Link>
      )}

      <div className="space-y-4 rounded-lg border border-border bg-card p-4">
        <div className="space-y-1.5">
          <div className="text-sm font-medium">Interview</div>
          <div className="inline-flex flex-wrap rounded-md border border-border p-0.5" role="radiogroup" aria-label="Kind">
            {MOCK_KINDS.map((k) => (
              <button
                key={k}
                role="radio"
                aria-checked={kind === k}
                onClick={() => setKind(k)}
                className={cn(
                  'min-h-9 rounded px-3 text-sm',
                  kind === k ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {mockKindInfo(k).label}
              </button>
            ))}
            {UPCOMING_MOCK_KINDS.map((k) => (
              <button
                key={k.id}
                role="radio"
                aria-checked={false}
                disabled
                title="Coming soon"
                className="min-h-9 cursor-not-allowed rounded px-3 text-sm text-muted-foreground/50"
              >
                {k.label} <span className="text-xs">(soon)</span>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-sm font-medium">Graded at</div>
          <div className="inline-flex rounded-md border border-border p-0.5" role="radiogroup" aria-label="Level">
            {MOCK_LEVELS.map((l) => (
              <button
                key={l}
                role="radio"
                aria-checked={level === l}
                onClick={() => setLevel(l)}
                className={cn(
                  'min-h-9 rounded px-3 text-sm',
                  level === l ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {MOCK_LEVEL_LABEL[l]}
              </button>
            ))}
          </div>
        </div>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Prompt</span>
          <select
            value={promptId}
            onChange={(e) => setPromptId(e.target.value)}
            className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">Pick one for me</option>
            {prompts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
                {p.familiar ? info.start.familiarTag : ''}
              </option>
            ))}
          </select>
          <span className="block text-xs text-muted-foreground">
            {promptId
              ? prompts.find((p) => p.id === promptId)?.brief
              : info.start.pickHint}
          </span>
        </label>

        <div className="text-xs text-muted-foreground">
          About ${typical.toFixed(2)} for a typical mock, at most ~${worst.toFixed(2)} at the {info.turnCap}-turn cap
          (estimate; each mock shows what it actually cost). {info.minutes} minutes. Each reply takes 5–10
          seconds.
        </div>

        {error && <ErrorBar error={error} onClose={() => setError(null)} />}

        <Button onClick={start} disabled={busy} className="w-full sm:w-auto">
          {busy ? <Loader2 className="animate-spin" /> : <ArrowRight />}
          {busy ? 'The interviewer is getting ready…' : 'Start the interview'}
        </Button>
      </div>

      <GapCards />

      {mocks && mocks.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Recent mocks</h2>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {mocks.map((m) => (
              <li key={m.id}>
                <Link to={`/mock/${m.id}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-secondary/50">
                  <span className="flex-1 truncate">{m.promptTitle}</span>
                  <span className="text-xs text-muted-foreground">{MOCK_LEVEL_LABEL[m.level]}</span>
                  <span className="w-24 text-right text-xs text-muted-foreground">
                    {m.verdict ? `${m.verdict} level` : m.status.replace('_', ' ')}
                  </span>
                  <span className="w-12 text-right text-xs text-muted-foreground">
                    {m.costUsd != null ? `$${m.costUsd.toFixed(2)}` : ''}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// The interview
// -----------------------------------------------------------------------------

function StageChips({ view }: { view: MockView }) {
  const { stages, stageMeta } = mockKindInfo(view.kind);
  return (
    <ol className="flex flex-wrap gap-1" aria-label="Stages">
      {stages.map((s) => {
        const covered = view.state.covered.includes(s);
        const skipped = view.state.skipped.includes(s);
        const current = view.state.stage === s;
        return (
          <li
            key={s}
            title={stageMeta[s]?.goal}
            className={cn(
              'rounded-full border px-2 py-0.5 text-xs',
              covered && 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
              skipped && 'border-amber-500/40 text-amber-300 line-through',
              !covered && !skipped && 'border-border text-muted-foreground',
              current && 'ring-1 ring-primary',
            )}
          >
            {stageMeta[s]?.label ?? s}
          </li>
        );
      })}
    </ol>
  );
}

function useMinutes(startedAt: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 60_000));
}

function Bubble({ turn, kind, children }: { turn: MockTurn; kind: MockKind; children?: ReactNode }) {
  const { conceptLabel } = mockKindInfo(kind);
  if (turn.role === 'candidate') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary/15 px-3.5 py-2 text-sm">
          {turn.content || (
            <span className="italic text-muted-foreground">
              {turn.action === 'teach_me'
                ? 'Teach me'
                : turn.action === 'stuck'
                  ? "I'm stuck"
                  : turn.action === 'move_on'
                    ? 'Move on'
                    : 'Keep going'}
            </span>
          )}
        </div>
      </div>
    );
  }
  if (turn.kind === 'teach') {
    return (
      <div className="rounded-lg border border-sky-500/40 bg-sky-500/5 p-3.5">
        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-sky-300">
          <GraduationCap className="h-3.5 w-3.5" /> Lesson{turn.teach ? `: ${conceptLabel(turn.teach.concept)}` : ''}
        </div>
        <Markdown>{turn.content}</Markdown>
      </div>
    );
  }
  return (
    <div className="max-w-[90%] rounded-2xl rounded-bl-sm border border-border bg-card px-3.5 py-2">
      {turn.kind === 'nudge' && <div className="mb-0.5 text-xs text-muted-foreground">nudge</div>}
      <Markdown>{turn.content}</Markdown>
      {children}
    </div>
  );
}

function Interview({ view, onView }: { view: MockView; onView: (v: MockView) => void }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState<MockAction | 'end' | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const minutes = useMinutes(view.state.startedAt);
  const last = view.turns[view.turns.length - 1];
  const lastSeq = last?.seq ?? 0;
  const atCap = view.state.candidateTurns >= view.limits.turnCap;
  const canTalk = view.status === 'active' && !atCap && last?.role === 'interviewer';
  const offer = canTalk && last?.kind === 'offer' && last.teach ? last.teach : null;

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [view.turns.length, sending]);

  const resync = useCallback(() => {
    getMock(view.id).then(onView).catch(() => {});
  }, [view.id, onView]);

  const send = async (action: MockAction) => {
    if (sending) return;
    if (action === 'answer' && !text.trim()) return;
    setSending(action);
    setError(null);
    try {
      const next = await sendMockTurn(view.id, {
        expectedSeq: lastSeq,
        content: action === 'answer' ? text : text.trim() ? text : '',
        action,
        ...(action === 'teach_me' && offer ? { concept: offer.concept } : {}),
      });
      setText('');
      onView(next);
    } catch (err) {
      setError(err as Error);
      // A 409 means another tab moved it on; the free re-read shows where.
      resync();
    } finally {
      setSending(null);
    }
  };

  const end = async () => {
    if (!window.confirm('End the interview and grade it? This is one model call, usually 30–90 seconds.')) return;
    setSending('end');
    setError(null);
    try {
      await endMock(view.id, (event) => {
        if (event.type === 'error') setError(new ApiError(event.error, event.detail));
      });
    } catch (err) {
      setError(err as Error);
    } finally {
      setSending(null);
      resync();
    }
  };

  const abandon = async () => {
    if (!window.confirm('Abandon this mock? It will not be graded.')) return;
    try {
      onView(await abandonMock(view.id));
    } catch (err) {
      setError(err as Error);
    }
  };

  const grading = sending === 'end' || view.status === 'grading';

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-border px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <Link to="/mock" className="text-muted-foreground hover:text-foreground">
            Mocks
          </Link>
          <span className="truncate font-medium" title={view.prompt}>
            {titleOf(view)}
          </span>
          <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
            <span>{MOCK_LEVEL_LABEL[view.level]}</span>
            <span className={cn(minutes >= view.limits.minutes && 'text-amber-300')}>
              {minutes} / {view.limits.minutes} min
            </span>
            <span>
              {view.state.candidateTurns} / {view.limits.turnCap} turns
            </span>
            {view.usage.costUsd != null && <span>${view.usage.costUsd.toFixed(2)}</span>}
          </span>
        </div>
        <StageChips view={view} />
      </div>

      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {view.turns.map((t) => (
          <Bubble key={t.seq} turn={t} kind={view.kind}>
            {offer && t.seq === lastSeq && (
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => send('teach_me')} disabled={!!sending}>
                  <GraduationCap /> Teach me {mockKindInfo(view.kind).conceptLabel(offer.concept)}
                </Button>
                <Button size="sm" variant="outline" onClick={() => send('keep_going')} disabled={!!sending}>
                  Keep going
                </Button>
              </div>
            )}
          </Bubble>
        ))}
        {sending && sending !== 'end' && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> The interviewer is replying (usually 5–10 seconds)…
          </div>
        )}
        {grading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Grading the whole interview (30–90 seconds)…
          </div>
        )}
        {view.status === 'abandoned' && <p className="text-sm text-muted-foreground">This mock was abandoned.</p>}
        {view.status === 'grade_failed' && !grading && (
          <p className="text-sm text-amber-300">Grading failed last time. The transcript is safe — press End &amp; grade to try again.</p>
        )}
      </div>

      {(view.status === 'active' || view.status === 'grade_failed') && (
        <div className="space-y-2 border-t border-border bg-card px-4 py-3">
          {error && <ErrorBar error={error} onClose={() => setError(null)} />}
          {atCap && view.status === 'active' && (
            <p className="text-sm text-amber-300">That was the last turn. Press End &amp; grade.</p>
          )}
          {view.status === 'active' && (
            <div className="flex gap-2">
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    send('answer');
                  }
                }}
                disabled={!canTalk || !!sending}
                rows={3}
                placeholder={canTalk ? 'Answer, ask a question, or say "wait, explain …"  (Ctrl+Enter sends)' : ''}
                className="min-h-[4.5rem] flex-1 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              <Button
                onClick={() => send('answer')}
                disabled={!canTalk || !!sending || !text.trim()}
                size="touchIcon"
                aria-label="Send"
                className="self-end"
              >
                <Send />
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {view.status === 'active' && (
              <>
                <Button size="sm" variant="secondary" onClick={() => send('teach_me')} disabled={!canTalk || !!sending}>
                  <BookOpenCheck /> Teach me
                </Button>
                <Button size="sm" variant="secondary" onClick={() => send('stuck')} disabled={!canTalk || !!sending}>
                  <HelpCircle /> I&rsquo;m stuck
                </Button>
                <Button size="sm" variant="secondary" onClick={() => send('move_on')} disabled={!canTalk || !!sending}>
                  <SkipForward /> Move on
                </Button>
              </>
            )}
            <Button
              size="sm"
              onClick={end}
              disabled={!!sending || view.state.candidateTurns === 0}
              className="ml-auto"
            >
              <Flag /> End &amp; grade
            </Button>
            {view.status === 'active' && (
              <Button size="sm" variant="ghost" onClick={abandon} disabled={!!sending}>
                Abandon
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Graded({ view }: { view: MockView }) {
  const [showTranscript, setShowTranscript] = useState(false);
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <div className="space-y-1">
        <Link to="/mock" className="text-sm text-muted-foreground hover:text-foreground">
          ← Mocks
        </Link>
        <h1 className="text-xl font-bold tracking-tight">{titleOf(view)}</h1>
        <p className="text-sm text-muted-foreground">{view.prompt}</p>
      </div>
      {view.grade && <GradeReport grade={view.grade} usage={view.usage} gaps={view.gaps} kind={view.kind} />}
      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTranscript((s) => !s)}>
          {showTranscript ? 'Hide' : 'Show'} the transcript ({view.turns.length} messages)
        </Button>
        {showTranscript && (
          <div className="mt-3 space-y-3">
            {view.turns.map((t) => (
              <Bubble key={t.seq} turn={t} kind={view.kind} />
            ))}
          </div>
        )}
      </div>
      <Button asChild>
        <Link to="/mock">Start another</Link>
      </Button>
    </div>
  );
}

export function MockPage() {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<MockView | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!id) return;
    setView(null);
    setError(null);
    getMock(id).then(setView).catch(setError);
  }, [id]);

  const content = useMemo(() => {
    if (!id) return <StartCard />;
    if (error) {
      return (
        <div className="mx-auto max-w-2xl space-y-3 p-6">
          <ErrorBar error={error} />
          <Link to="/mock" className="text-sm text-primary hover:underline">
            Back to mocks
          </Link>
        </div>
      );
    }
    if (!view) {
      return (
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the mock…
        </div>
      );
    }
    if (view.status === 'graded') return <Graded view={view} />;
    return <Interview view={view} onView={setView} />;
  }, [id, view, error]);

  return <div className="h-full overflow-y-auto">{content}</div>;
}
