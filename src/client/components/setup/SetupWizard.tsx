// =============================================================================
// The first-run wizard
// =============================================================================
// Three screens between `git clone` and a solvable problem: paste a key, pick a
// language, watch a bank fill. It takes over the app when — and only when —
// `GET /api/setup/state` says something is genuinely missing, which is derived
// from the key and the bank rather than from an "onboarded" flag somebody's
// restored backup could clear.
//
// Design notes, all inherited rather than invented:
//   - Same idiom as the Grind start hero: a rounded icon tile, a bold title, a
//     muted paragraph, one primary Button. Nothing here introduces a component,
//     a colour or a spacing scale the app did not already have.
//   - Dark-only, like the rest of the app (see index.css).
//   - `size={controlSize}` on the buttons, so the touch targets are 44px on a
//     phone exactly as they are everywhere else.
//
// THE PROGRESS BAR IS REAL. Its denominator is `total` from the server's `plan`
// event, counted out of the database before any generating starts, and it moves
// on `generated` / `failed` events — i.e. when a problem has actually been
// written. There is no timer and no easing. A cold generate is 15-30 seconds,
// so the bar visibly sits still, and it is telling the truth when it does; the
// per-problem line underneath is what shows the thing is alive.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  KeyRound,
  Loader2,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  Boxes,
  ExternalLink,
  ShieldCheck,
} from 'lucide-react';
import type { SetupState, SeedEvent, Topic, Difficulty } from '@/shared/types';
import { LANGUAGE_META, type Language } from '@/shared/languages';
import {
  getSetupState,
  updateSettings,
  dismissSetup,
  seedBank,
  startSession,
} from '@/client/lib/api';
import type { GrindSnapshot } from '@/client/lib/grind-snapshot';
import { useControlSize } from '@/client/hooks/useMediaQuery';
import { Button } from '@/client/components/ui/button';
import { Badge } from '@/client/components/ui/badge';
import { humanize } from '@/client/lib/format';
import { cn } from '@/lib/utils';

/** How many problems per topic+difficulty slot a first run stocks. */
const PER_SLOT = 2;

type Step = 'key' | 'language' | 'seed' | 'ready';

/** One line in the live seeding log. */
interface LogLine {
  key: string;
  tone: 'ok' | 'bad' | 'busy';
  text: string;
}

function Shell({
  icon,
  title,
  blurb,
  children,
  step,
}: {
  icon: React.ReactNode;
  title: string;
  blurb: React.ReactNode;
  children: React.ReactNode;
  step: Step;
}) {
  const order: Step[] = ['key', 'language', 'seed'];
  const index = order.indexOf(step);
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-lg space-y-6 py-6">
        <div className="space-y-4 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/15 text-primary">
            {icon}
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">{blurb}</p>
          </div>
        </div>
        {children}
        {index >= 0 && (
          <div className="flex items-center justify-center gap-1.5 pt-2" aria-hidden>
            {order.map((s, i) => (
              <span
                key={s}
                className={cn(
                  'h-1.5 rounded-full transition-all',
                  i === index ? 'w-6 bg-primary' : 'w-1.5 bg-border',
                )}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function SetupWizard({ state: initial, onDone }: { state: SetupState; onDone: () => void }) {
  const controlSize = useControlSize();
  const [state, setState] = useState<SetupState>(initial);
  const [step, setStep] = useState<Step>(initial.apiKey.configured ? 'language' : 'key');

  // ---- step 1: the key -----------------------------------------------------
  const [keyInput, setKeyInput] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  const saveKey = useCallback(async () => {
    setKeyError(null);
    setVerifying(true);
    try {
      // The server proves the key against Anthropic before storing it, so a
      // rejection here is "that key does not work" rather than "wrong shape".
      await updateSettings({ apiKey: keyInput });
      const next = await getSetupState();
      setState(next);
      setKeyInput('');
      setStep('language');
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : 'Could not verify that key.');
    } finally {
      setVerifying(false);
    }
  }, [keyInput]);

  // ---- step 2: the language ------------------------------------------------
  const [language, setLanguage] = useState<Language>(initial.language);
  const [switching, setSwitching] = useState(false);
  const [langError, setLangError] = useState<string | null>(null);

  const chooseLanguage = useCallback(async (next: Language) => {
    setLangError(null);
    setSwitching(true);
    try {
      await updateSettings({ language: next });
      setLanguage(next);
      setState(await getSetupState());
      setStep('seed');
    } catch (err) {
      setLangError(err instanceof Error ? err.message : 'Could not save that language.');
    } finally {
      setSwitching(false);
    }
  }, []);

  // ---- step 3: seeding -----------------------------------------------------
  const [seeding, setSeeding] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState<{ topic: Topic; difficulty: Difficulty } | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [banked, setBanked] = useState(0);
  const [finished, setFinished] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const startSeeding = useCallback(async () => {
    setSeedError(null);
    setSeeding(true);
    setLog([]);
    setDone(0);
    setTotal(0);
    setFinished(false);
    const controller = new AbortController();
    abort.current = controller;
    let n = 0;
    try {
      await seedBank(
        { language, perSlot: PER_SLOT },
        (ev: SeedEvent) => {
          switch (ev.type) {
            case 'plan':
              setTotal(ev.total);
              setBanked(ev.bankSize);
              if (ev.alreadyStocked > 0) {
                setLog((l) => [
                  ...l,
                  {
                    key: `stocked-${n++}`,
                    tone: 'ok',
                    text: `${ev.alreadyStocked} already banked — skipping those`,
                  },
                ]);
              }
              break;
            case 'generating':
              setDone(ev.done);
              setCurrent({ topic: ev.topic, difficulty: ev.difficulty });
              break;
            case 'generated':
              setDone(ev.done);
              setCurrent(null);
              // The bank counter has to move with the work. `bankSize` only
              // rides on `plan` and `done`, so without this it reads "0 in the
              // bank" for the whole run and then jumps — which looks exactly
              // like nothing being saved.
              setBanked((n) => n + 1);
              setLog((l) => [
                ...l,
                {
                  key: `ok-${n++}`,
                  tone: 'ok',
                  text: `${humanize(ev.topic)} — “${ev.title}” (${ev.sampleTests + ev.hiddenTests} tests)`,
                },
              ]);
              break;
            case 'failed':
              setDone(ev.done);
              setCurrent(null);
              setLog((l) => [
                ...l,
                { key: `bad-${n++}`, tone: 'bad', text: ev.message },
              ]);
              break;
            case 'done':
              setBanked(ev.bankSize);
              setFinished(true);
              break;
          }
        },
        controller.signal,
      );
      setStep('ready');
    } catch (err) {
      if (!controller.signal.aborted) {
        setSeedError(err instanceof Error ? err.message : 'Seeding failed.');
      }
    } finally {
      setSeeding(false);
      setCurrent(null);
    }
  }, [language]);

  // ---- finishing -----------------------------------------------------------
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  /**
   * Hand the user a real problem, not a menu.
   *
   * This starts a genuine session and writes the SAME `codegrind.grind`
   * snapshot GrindPage persists for itself, so the app comes up already inside
   * a sitting with a solvable problem on screen. Reusing that key rather than
   * inventing a handoff means the resume path — which validates the session
   * server-side and drops a snapshot whose language no longer matches — is the
   * one already tested.
   */
  const launch = useCallback(async () => {
    setLaunchError(null);
    setLaunching(true);
    try {
      const res = await startSession();
      const snapshot: GrindSnapshot = {
        sessionId: res.sessionId,
        plan: res.plan,
        problem: res.problem,
        why: res.why,
        upNext: res.upNext,
        solved: 0,
        streak: 0,
        topics: [res.why.topic],
      };
      window.localStorage.setItem('codegrind.grind', JSON.stringify(snapshot));
      onDone();
    } catch (err) {
      setLaunchError(
        err instanceof Error ? err.message : 'Could not start a session — try the Grind tab.',
      );
      setLaunching(false);
    }
  }, [onDone]);

  const skipSeeding = useCallback(async () => {
    try {
      await dismissSetup();
    } catch {
      /* the wizard is leaving either way; a failed dismissal just means it
         reappears next load, which is annoying but not wrong */
    }
    setStep('ready');
  }, []);

  // ===========================================================================
  // Step 1 — the key
  // ===========================================================================
  if (step === 'key') {
    return (
      <Shell
        step="key"
        icon={<KeyRound className="h-7 w-7" />}
        title="Add your Anthropic key"
        blurb={
          <>
            codegrind writes every problem, hint and coaching note with Claude, so it needs
            a key of your own. Create one at{' '}
            <a
              className="inline-flex items-center gap-0.5 text-primary underline-offset-4 hover:underline"
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noreferrer"
            >
              console.anthropic.com
              <ExternalLink className="h-3 w-3" />
            </a>
            .
          </>
        }
      >
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!verifying && keyInput.trim()) void saveKey();
          }}
        >
          <input
            // type=password: this is a credential and browsers, screenshots and
            // shoulders all treat it as one.
            type="password"
            autoFocus
            spellCheck={false}
            autoComplete="off"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="sk-ant-…"
            aria-label="Anthropic API key"
            className="h-11 w-full rounded-md border border-input bg-background px-3 font-mono text-sm outline-none ring-ring transition focus-visible:ring-1"
          />
          {keyError && (
            <p className="flex items-start gap-1.5 text-sm text-destructive-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{keyError}</span>
            </p>
          )}
          <Button
            type="submit"
            className="w-full gap-1.5"
            size={controlSize}
            disabled={verifying || !keyInput.trim()}
          >
            {verifying ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Checking with Anthropic…
              </>
            ) : (
              <>
                Verify and continue <ArrowRight className="h-4 w-4" />
              </>
            )}
          </Button>
          <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Checked against Anthropic before it is saved, then stored in this machine&rsquo;s
              local database — never in <code className="font-mono">.env</code>, and never sent
              anywhere but Anthropic. Set <code className="font-mono">ANTHROPIC_API_KEY</code> in
              the environment instead and that wins over anything saved here.
            </span>
          </p>
        </form>
      </Shell>
    );
  }

  // ===========================================================================
  // Step 2 — the language
  // ===========================================================================
  if (step === 'language') {
    const options = state.languages.filter((l) => l.supported);
    return (
      <Shell
        step="language"
        icon={<Sparkles className="h-7 w-7" />}
        title="Pick your language"
        blurb={
          <>
            Every problem is written, run and graded in one language — the bank, the skill
            tree and the tier ladder are all separate per language. You can switch any time;
            nothing is lost.
          </>
        }
      >
        <div className="space-y-2">
          {options.map((l) => (
            <button
              key={l.language}
              type="button"
              disabled={switching}
              onClick={() => void chooseLanguage(l.language)}
              className={cn(
                'flex w-full items-center gap-3 rounded-xl border bg-card p-4 text-left shadow transition-colors',
                'hover:border-primary/60 hover:bg-accent disabled:opacity-50',
                l.language === language && 'border-primary/60',
              )}
            >
              <span className="flex-1">
                <span className="block font-semibold">{l.displayName}</span>
                <span className="block text-xs text-muted-foreground">
                  {l.servable > 0
                    ? `${l.servable} problem${l.servable === 1 ? '' : 's'} ready to go`
                    : 'Bank is empty — the next step stocks it'}
                </span>
              </span>
              {switching && l.language === language ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : (
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
          ))}
        </div>
        {state.languages.some((l) => !l.supported) && (
          <p className="text-center text-xs text-muted-foreground">
            {state.languages
              .filter((l) => !l.supported)
              .map((l) => l.displayName)
              .join(', ')}{' '}
            {state.languages.filter((l) => !l.supported).length === 1 ? 'is' : 'are'} not
            wired up in this build yet.
          </p>
        )}
        {langError && (
          <p className="text-center text-sm text-destructive-foreground">{langError}</p>
        )}
      </Shell>
    );
  }

  // ===========================================================================
  // Step 3 — seeding
  // ===========================================================================
  if (step === 'seed') {
    const meta = LANGUAGE_META[language];
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    return (
      <Shell
        step="seed"
        icon={<Boxes className="h-7 w-7" />}
        title={`Stock your ${meta.displayName} bank`}
        blurb={
          seeding || finished ? (
            <>
              Claude is writing problems, then running each reference solution in a sandbox to
              derive its expected answers. That verification is why a problem takes 15&ndash;30
              seconds &mdash; and why the one you get is guaranteed solvable.
            </>
          ) : (
            <>
              A fresh {meta.displayName} bank is empty, so your first problems would each take
              15&ndash;30 seconds to write. Stocking {PER_SLOT} per starting topic now
              (8&nbsp;problems, a few minutes, a few cents) makes them instant instead.
            </>
          )
        }
      >
        {!seeding && !finished && (
          <div className="space-y-3">
            <Button className="w-full gap-1.5" size={controlSize} onClick={() => void startSeeding()}>
              <Sparkles className="h-4 w-4" /> Stock the bank
            </Button>
            <Button
              variant="ghost"
              className="w-full"
              size={controlSize}
              onClick={() => void skipSeeding()}
            >
              Skip &mdash; generate as I go
            </Button>
            {seedError && (
              <p className="flex items-start gap-1.5 text-sm text-destructive-foreground">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{seedError}</span>
              </p>
            )}
          </div>
        )}

        {(seeding || finished) && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {done} of {total} written
                </span>
                <span>{banked} in the bank</span>
              </div>
            </div>

            {current && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Writing an {current.difficulty} {humanize(current.topic).toLowerCase()} problem…
              </p>
            )}

            {log.length > 0 && (
              <ul className="max-h-52 space-y-1.5 overflow-y-auto rounded-lg border border-border bg-card/60 p-3 text-xs">
                {log.map((line) => (
                  <li key={line.key} className="flex items-start gap-1.5">
                    {line.tone === 'bad' ? (
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                    ) : (
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                    )}
                    <span
                      className={
                        line.tone === 'bad' ? 'text-muted-foreground' : 'text-foreground/90'
                      }
                    >
                      {line.text}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {seeding && (
              <Button
                variant="ghost"
                className="w-full"
                size={controlSize}
                onClick={() => {
                  // Stop WATCHING. The problem in flight is already paid for and
                  // will still be banked; a partial bank is a usable bank.
                  abort.current?.abort();
                  setSeeding(false);
                  void skipSeeding();
                }}
              >
                Stop and start grinding with what I have
              </Button>
            )}
          </div>
        )}
      </Shell>
    );
  }

  // ===========================================================================
  // Step 4 — the payoff
  // ===========================================================================
  return (
    <Shell
      step="ready"
      icon={<CheckCircle2 className="h-7 w-7" />}
      title="You&rsquo;re set"
      blurb={
        <>
          The coach reads your mastery, plans a sitting and drills what you need next. No topic
          picking, no difficulty guessing &mdash; just sit down and grind.
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Badge variant="secondary">{LANGUAGE_META[language].displayName}</Badge>
          {banked > 0 && <Badge variant="secondary">{banked} problems banked</Badge>}
          <Badge variant="secondary">key verified ····{state.apiKey.suffix}</Badge>
        </div>
        <Button
          className="w-full gap-1.5"
          size={controlSize}
          onClick={() => void launch()}
          disabled={launching}
        >
          {launching ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Planning your first session…
            </>
          ) : (
            <>
              Start your first problem <ArrowRight className="h-4 w-4" />
            </>
          )}
        </Button>
        {launchError && (
          <div className="space-y-2">
            <p className="flex items-start gap-1.5 text-sm text-destructive-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{launchError}</span>
            </p>
            <Button variant="outline" className="w-full" size={controlSize} onClick={onDone}>
              Go to the app anyway
            </Button>
          </div>
        )}
      </div>
    </Shell>
  );
}
