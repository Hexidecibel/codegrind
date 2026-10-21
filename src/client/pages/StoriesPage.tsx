// =============================================================================
// StoriesPage — the story forge (Phase H4)
// =============================================================================
//   /stories                     pick a competency (open story-bank gaps first)
//                                and, optionally, a candidate or story to deepen
//   /stories?competency=<id>     preselected (the behavioral grade's "Stories to
//                                capture" links come here)
//   /stories?session=<id>        a forge session: one question per turn, answered
//                                by dictation; the coach pushes back and rewrites
//                                the STAR draft; "Save to story bank" appends it
//                                to resume-builder as a DRAFT — on that click only.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, BookOpen, Check, Loader2, Mic, Save, X } from 'lucide-react';
import {
  FORGE_BEATS,
  FORGE_BEAT_LABEL,
  PUSHBACK_LABEL,
  draftSavable,
  type ForgeOptions,
  type ForgeSessionView,
} from '@/shared/story-forge';
import { abandonForge, forgeTurn, getForge, getForgeOptions, saveForge, startForge } from '@/client/lib/api';
import { todayStepFrom } from '@/client/lib/today-flow';
import { TodayNextBar } from '@/client/components/TodayNextBar';
import { Button } from '@/client/components/ui/button';
import { cn } from '@/lib/utils';

function Setup({ onStarted }: { onStarted: (s: ForgeSessionView) => void }) {
  const location = useLocation();
  const preset = new URLSearchParams(location.search).get('competency');
  const [opts, setOpts] = useState<ForgeOptions | null>(null);
  const [competency, setCompetency] = useState('');
  const [seed, setSeed] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getForgeOptions()
      .then((o) => {
        setOpts(o);
        setCompetency(o.competencies.some((c) => c.id === preset) ? preset! : o.defaultCompetency);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [preset]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const [kind, ...ref] = seed.split(':');
      const s = await startForge({
        competency,
        ...(seed ? { candidate: { kind: kind as 'candidate' | 'story', ref: ref.join(':') } } : {}),
      });
      onStarted(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  if (!opts) return error ? <p className="text-sm text-destructive-foreground">{error}</p> : <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />;
  return (
    <div className="space-y-4">
      <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">The story is for</span>
          <select
            value={competency}
            onChange={(e) => setCompetency(e.target.value)}
            className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {opts.competencies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
                {c.gap === 'open' ? ' — open gap' : c.gap === 'partial' ? ' — partly covered' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Start from (optional)</span>
          <select value={seed} onChange={(e) => setSeed(e.target.value)} className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
            <option value="">A new story from scratch</option>
            {opts.candidates.length > 0 && (
              <optgroup label="Candidates not captured yet">
                {opts.candidates.map((c) => (
                  <option key={c.title} value={`candidate:${c.title}`}>
                    {c.title}
                  </option>
                ))}
              </optgroup>
            )}
            {opts.stories.length > 0 && (
              <optgroup label="Deepen an existing story (saved as a NEW draft)">
                {opts.stories.map((s) => (
                  <option key={s.id} value={`story:${s.id}`}>
                    {s.title} ({s.status})
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        {!opts.bank.loaded && (
          <p className="text-xs text-amber-300">Story bank unavailable ({opts.bank.error}). You can still forge; saving needs resume-builder.</p>
        )}
        <p className="text-xs text-muted-foreground">
          One question at a time: situation → your role → what YOU did → obstacles → result with a number → what you&apos;d
          change. The coach pushes back on “we”, scope and numbers and never fills in a detail — anything unsure stays an open
          question. About ${opts.estimateUsd?.toFixed(2) ?? '0.03'} per answer, at most 12 answers.
        </p>
        {error && <p className="text-sm text-destructive-foreground">{error}</p>}
        <Button onClick={() => void start()} disabled={busy || !competency} className="gap-1.5">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />} Start forging
        </Button>
      </section>
      {opts.recent.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Recent</h2>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {opts.recent.map((r) => (
              <li key={r.id}>
                <Link to={`/stories?session=${r.id}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-secondary/50">
                  <span className="flex-1 truncate">{r.draft?.title || 'Untitled story'}</span>
                  <span className="text-xs text-muted-foreground">{r.status}</span>
                  <span className="text-xs text-muted-foreground">{r.answers}/{r.maxTurns}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function DraftPanel({ s }: { s: ForgeSessionView }) {
  const d = s.draft;
  if (!d) return <p className="text-sm text-muted-foreground">The STAR draft appears after your first answer.</p>;
  const field = (label: string, v: string) =>
    v ? (
      <div>
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="leading-relaxed">{v}</p>
      </div>
    ) : null;
  const list = (label: string, items: string[], tone = '') =>
    items.length ? (
      <div>
        <p className={cn('text-xs font-medium text-muted-foreground', tone)}>{label}</p>
        <ul className="list-disc space-y-0.5 pl-4">{items.map((i) => <li key={i}>{i}</li>)}</ul>
      </div>
    ) : null;
  return (
    <div className="space-y-3 text-sm">
      <p className="font-semibold">{d.title || 'Untitled story'}</p>
      {d.question && <p className="italic text-muted-foreground">“{d.question}”</p>}
      {field('Situation', d.situation)}
      {field('Task / your role', d.task)}
      {field('Action — what you did', d.action)}
      {field('Result', d.result)}
      {field('Obstacle / pushback', d.complication)}
      {list('Numbers (only what you said)', d.numbers)}
      {list('Retell beats', d.beats)}
      {list('Caveats — how it must be told', d.caveats)}
      {list('Open questions — NOT facts until you confirm them', d.unconfirmed, 'text-amber-300')}
    </div>
  );
}

function Session({ id, onClose }: { id: string; onClose: () => void }) {
  const [s, setS] = useState<ForgeSessionView | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState<'turn' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    getForge(id).then(setS).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => endRef.current?.scrollIntoView({ block: 'nearest' }), [s?.turns.length]);

  if (!s) return error ? <p className="text-sm text-destructive-foreground">{error}</p> : <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />;
  const open = s.status === 'active' || s.status === 'drafted';
  const canAnswer = open && s.answers < s.maxTurns;

  const send = async () => {
    if (!answer.trim() || busy) return;
    setBusy('turn');
    setError(null);
    try {
      setS(await forgeTurn(s.id, answer, s.answers));
      setAnswer('');
    } catch (e) {
      // The answer stays in the box: nothing was stored.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      const r = await saveForge(s.id);
      setS(r);
      setSaveNote(r.backup.ok ? `Backed up first (${r.backup.note}).` : `Backup skipped: ${r.backup.note}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap gap-1" aria-label="Beats">
        {FORGE_BEATS.map((b) => (
          <li
            key={b}
            className={cn(
              'rounded-full border px-2 py-0.5 text-xs',
              s.covered.includes(b) ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-border text-muted-foreground'
            )}
          >
            {FORGE_BEAT_LABEL[b]}
          </li>
        ))}
        <li className="ml-auto text-xs text-muted-foreground">
          {s.answers}/{s.maxTurns} answers · ${s.costUsd.toFixed(3)}
        </li>
      </ol>

      <div className="grid gap-4 lg:grid-cols-[1fr_minmax(0,22rem)]">
        <section className="space-y-3">
          {s.turns.map((t, i) => (
            <div
              key={i}
              className={cn(
                'rounded-lg px-3 py-2 text-sm leading-relaxed',
                t.role === 'coach' ? 'border border-border bg-card' : 'ml-6 bg-secondary/60'
              )}
            >
              {t.pushback && t.pushback.length > 0 && (
                <div className="mb-1 flex flex-wrap gap-1">
                  {t.pushback.map((p, j) => (
                    <span key={j} title={p.note} className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-300">
                      {PUSHBACK_LABEL[p.kind]}
                    </span>
                  ))}
                </div>
              )}
              <p className="whitespace-pre-wrap">{t.content}</p>
            </div>
          ))}
          <div ref={endRef} />
          {canAnswer && (
            <div className="space-y-2">
              <label htmlFor="forge-answer" className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Mic className="h-4 w-4" /> Answer out loud — dictate it.
              </label>
              <textarea
                id="forge-answer"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
                }}
                rows={6}
                placeholder="Start talking…"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm leading-relaxed outline-none focus:border-primary"
              />
              <Button onClick={() => void send()} disabled={!!busy || !answer.trim()} className="gap-1.5">
                {busy === 'turn' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                {busy === 'turn' ? 'The coach is reading…' : 'Send'}
              </Button>
            </div>
          )}
          {error && <p className="text-sm text-destructive-foreground">{error}</p>}
        </section>

        <aside className="space-y-3 rounded-xl border border-border bg-card p-4">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <BookOpen className="h-4 w-4" /> STAR draft
          </h2>
          <DraftPanel s={s} />
          {s.status === 'saved' ? (
            <div className="space-y-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
              <p className="flex items-center gap-1.5 font-medium">
                <Check className="h-4 w-4" /> Saved to the story bank as a draft: {s.savedStoryId}
              </p>
              {saveNote && <p className="text-xs text-foreground/80">{saveNote}</p>}
              {s.cardId !== null && (
                <p className="text-xs text-foreground/80">A 2-minute retell card joins your drill cards tomorrow.</p>
              )}
              <p className="text-xs text-foreground/80">Review it and confirm it in resume-builder before you rely on it.</p>
            </div>
          ) : (
            open && (
              <div className="space-y-2">
                <Button onClick={() => void save()} disabled={!!busy || !draftSavable(s.draft)} variant="outline" className="w-full gap-1.5">
                  {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save to story bank (as a draft)
                </Button>
                <p className="text-xs text-muted-foreground">
                  Appends a NEW story with status “draft” to resume-builder after a backup. Nothing existing is changed; open
                  questions stay open questions.
                </p>
              </div>
            )
          )}
          {open && (
            <button
              onClick={() => {
                if (window.confirm('Abandon this draft? Nothing is saved to the story bank.')) {
                  void abandonForge(s.id).then(onClose, () => {});
                }
              }}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" /> Abandon
            </button>
          )}
        </aside>
      </div>
    </div>
  );
}

export function StoriesPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const todayStep = todayStepFrom(location.search);
  const sessionId = new URLSearchParams(location.search).get('session');
  const keep = todayStep ? `from=today&step=${todayStep}&` : '';

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-4 p-4 pb-16 sm:p-6">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <BookOpen className="h-6 w-6 text-primary" /> Story forge
          </h1>
          {sessionId && (
            <Link to={`/stories${todayStep ? `?from=today&step=${todayStep}` : ''}`} className="text-sm text-muted-foreground underline underline-offset-4">
              New story
            </Link>
          )}
        </header>
        {todayStep && <TodayNextBar here={todayStep} screenPath="/stories" refreshKey={sessionId} />}
        {sessionId ? (
          <Session key={sessionId} id={sessionId} onClose={() => navigate(`/stories${todayStep ? `?from=today&step=${todayStep}` : ''}`)} />
        ) : (
          <Setup onStarted={(s) => navigate(`/stories?${keep}session=${s.id}`)} />
        )}
      </div>
    </div>
  );
}
