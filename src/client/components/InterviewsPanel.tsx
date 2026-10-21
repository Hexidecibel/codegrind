// =============================================================================
// InterviewsPanel — target interview loops on Today (Phase H2)
// =============================================================================
// Company, date, round types, and an optional link to a resume-builder job
// posting. The nearest loop drives Today's countdown, the spacing cap, the
// final review and the mock rotation (server-side, shared/loops.ts). Collapsed
// to one line by default; free (no model call).

import { useCallback, useEffect, useState } from 'react';
import { Briefcase, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  ROUND_LABEL,
  ROUND_TYPES,
  countdownPhrase,
  daysBetween,
  type InterviewLoop,
  type JobPosting,
  type RoundType,
} from '@/shared/loops';
import { createLoop, deleteLoop, getLoops, getPostings, updateLoop, type LoopBody } from '@/client/lib/api';
import { Button } from '@/client/components/ui/button';
import { cn } from '@/lib/utils';

const EMPTY: LoopBody = { company: '', date: '', rounds: ['coding', 'system-design', 'behavioral'], postingId: null, postingTitle: null };

function LoopForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: LoopBody;
  onSave: (b: LoopBody) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState<LoopBody>(initial);
  const [postings, setPostings] = useState<JobPosting[] | null>(null);
  const [postingsDown, setPostingsDown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPostings()
      .then((r) => {
        setPostings(r.postings);
        setPostingsDown(!r.available);
      })
      .catch(() => setPostingsDown(true));
  }, []);

  const toggleRound = (r: RoundType) =>
    setBody((b) => ({ ...b, rounds: b.rounds.includes(r) ? b.rounds.filter((x) => x !== r) : [...b.rounds, r] }));

  const pickPosting = (id: string) => {
    const p = postings?.find((x) => x.id === id) ?? null;
    setBody((b) => ({
      ...b,
      postingId: p?.id ?? null,
      postingTitle: p ? p.title : null,
      company: b.company || p?.company || '',
    }));
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(body);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  const input = 'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm';
  return (
    <div className="space-y-3 rounded-lg border border-border bg-secondary/20 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-muted-foreground">
          Company
          <input className={input} value={body.company} maxLength={80} onChange={(e) => setBody({ ...body, company: e.target.value })} />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Interview date
          <input type="date" className={input} value={body.date} onChange={(e) => setBody({ ...body, date: e.target.value })} />
        </label>
      </div>
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">Rounds</div>
        <div className="flex flex-wrap gap-1.5">
          {ROUND_TYPES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => toggleRound(r)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs',
                body.rounds.includes(r) ? 'border-primary/60 bg-primary/15 text-foreground' : 'border-border text-muted-foreground',
              )}
            >
              {ROUND_LABEL[r]}
            </button>
          ))}
        </div>
        {body.rounds.includes('project-deep-dive') && (
          <p className="text-[11px] text-muted-foreground">Project deep-dive mocks are not built yet; the rotation ignores that round for now.</p>
        )}
      </div>
      <label className="block space-y-1 text-xs text-muted-foreground">
        Job posting (resume-builder, optional)
        {postingsDown ? (
          <div className="text-[11px]">
            resume-builder is not reachable{body.postingTitle ? ` — linked: ${body.postingTitle}` : ''}.
          </div>
        ) : postings === null ? (
          <div className="inline-flex items-center gap-1 text-[11px]">
            <Loader2 className="h-3 w-3 animate-spin" /> loading postings…
          </div>
        ) : (
          <select className={input} value={body.postingId ?? ''} onChange={(e) => pickPosting(e.target.value)}>
            <option value="">— none —</option>
            {postings.map((p) => (
              <option key={p.id} value={p.id}>
                {p.company} · {p.title}
              </option>
            ))}
          </select>
        )}
      </label>
      {error && <p className="text-xs text-destructive-foreground">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={saving || !body.company.trim() || !body.date || !body.rounds.length}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function InterviewsPanel({ today, onChange }: { today: string; onChange: () => void }) {
  const [loops, setLoops] = useState<InterviewLoop[] | null>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    getLoops()
      .then((r) => setLoops(r.loops))
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const done = (r: { loops: InterviewLoop[] }) => {
    setLoops(r.loops);
    setEditing(null);
    onChange();
  };

  const upcoming = (loops ?? []).filter((l) => l.date >= today);
  const past = (loops ?? []).filter((l) => l.date < today);

  return (
    <section className="rounded-xl border border-border bg-card p-3 sm:p-4">
      <button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((o) => !o)}>
        <Briefcase className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">Interviews</span>
        <span className="text-xs text-muted-foreground">
          {loops === null
            ? ''
            : upcoming.length
              ? `${upcoming.length} upcoming · next ${upcoming[0].company} ${countdownPhrase(daysBetween(today, upcoming[0].date))}`
              : 'none planned — add one to aim spacing and mocks at it'}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">{open ? 'hide' : 'manage'}</span>
      </button>
      {open && (
        <div className="mt-3 space-y-2">
          {error && <p className="text-xs text-destructive-foreground">{error}</p>}
          {[...upcoming, ...past].map((l) =>
            editing === l.id ? (
              <LoopForm
                key={l.id}
                initial={{ company: l.company, date: l.date, rounds: l.rounds, postingId: l.postingId, postingTitle: l.postingTitle }}
                onSave={async (b) => done(await updateLoop(l.id, b))}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <div key={l.id} className={cn('flex items-start gap-2 rounded-lg border border-border px-3 py-2', l.date < today && 'opacity-60')}>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {l.company} <span className="text-xs font-normal text-muted-foreground">· {l.date} · {l.date < today ? 'past' : countdownPhrase(daysBetween(today, l.date))}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {l.rounds.map((r) => ROUND_LABEL[r]).join(', ')}
                    {l.postingTitle ? ` · ${l.postingTitle}` : ''}
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setEditing(l.id)} aria-label="Edit">
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Delete"
                  onClick={async () => {
                    if (!window.confirm(`Delete the ${l.company} interview?`)) return;
                    try {
                      done(await deleteLoop(l.id));
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ),
          )}
          {editing === 'new' ? (
            <LoopForm initial={EMPTY} onSave={async (b) => done(await createLoop(b))} onCancel={() => setEditing(null)} />
          ) : (
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setEditing('new')}>
              <Plus className="h-3.5 w-3.5" /> Add an interview
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
