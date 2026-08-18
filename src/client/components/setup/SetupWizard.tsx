// =============================================================================
// The first-run wizard
// =============================================================================
// Three screens between `git clone` and a solvable problem: choose who writes
// the problems, pick a language, watch a bank fill. It takes over the app when
// — and only when — `GET /api/setup/state` says something is genuinely missing,
// which is derived from the key and the bank rather than from an "onboarded"
// flag somebody's restored backup could clear.
//
// THE FIRST STEP IS A PROVIDER STEP, NOT A KEY STEP, and that is the whole
// point of it: this app runs perfectly well on a local model, and an install
// that needs no key must not open by demanding one. Still THREE dots — the step
// was replaced, not added, because a wizard that grew a screen to gain an option
// makes everybody pay for a choice most people will not make.
//
// THAT STEP'S CONTROL NOW LIVES IN ProviderPicker.tsx, because Settings hosts
// the same one — model, endpoint and key are things you change on day 300, not
// only on day 0, and a second copy of the form is a second set of rules about
// what may be saved. It picks from a fetched list rather than a text box, and it
// is validated by a real forced tool call before anything is stored; see that
// file. Latency IS only a warning: it comes back as "problems will take about N
// seconds to write", measured, not guessed, and this file is what says so.
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
  Loader2,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  Boxes,
  ShieldCheck,
  Cpu,
  Coins,
  Info,
} from 'lucide-react';
import type {
  SetupState,
  SeedEvent,
  Topic,
  Difficulty,
  LlmProviderCheck,
} from '@/shared/types';
import { LANGUAGE_META, type Language } from '@/shared/languages';
import { getSetupState, updateSettings, dismissSetup, seedBank, startSession } from '@/client/lib/api';
import type { GrindSnapshot } from '@/client/lib/grind-snapshot';
import { useControlSize } from '@/client/hooks/useMediaQuery';
import { Button } from '@/client/components/ui/button';
import { Badge } from '@/client/components/ui/badge';
import {
  ProviderPicker,
  EnvPinnedFields,
  EnvPinnedSentence,
  ENV_PINNED_TITLE,
} from '@/client/components/setup/ProviderPicker';
import { humanize } from '@/client/lib/format';
import { summariseRoles, coachCostSentence } from '@/client/lib/role-summary';
import { cn } from '@/lib/utils';

/** How many problems per topic+difficulty slot a first run stocks. */
const PER_SLOT = 2;

type Step = 'provider' | 'language' | 'seed' | 'ready';

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
  const order: Step[] = ['provider', 'language', 'seed'];
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

/**
 * The two roles on the Ready screen, named by what they do.
 *
 * Small, and deliberately not a Badge row: a badge is a fact you glance at, and
 * "your follow-up questions run on a more expensive model than your problems" is
 * a fact somebody has to actually read. On the local path — and any time both
 * roles resolve to the same model — the cost line is absent, because there is no
 * extra cost to warn about and a warning that does not apply is how you train
 * someone to skip the next one.
 */
function RolesReady({ llm }: { llm: SetupState['llm'] }) {
  const summary = summariseRoles(llm);
  const cost = coachCostSentence(summary);
  return (
    <div className="space-y-2 rounded-xl border border-border bg-card/60 p-3">
      <RoleLine job="Problems, hints and lessons" model={summary.writerModel} />
      <RoleLine job="Coach chat" model={summary.coachModel} />
      {cost && (
        <p className="flex items-start gap-1.5 border-t border-border/60 pt-2 text-xs leading-relaxed text-muted-foreground">
          <Coins className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{cost}</span>
        </p>
      )}
      {!cost && summary.sameModel && (
        <p className="border-t border-border/60 pt-2 text-xs leading-relaxed text-muted-foreground">
          One model for both jobs. Change either in Settings.
        </p>
      )}
    </div>
  );
}

function RoleLine({ job, model }: { job: string; model: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs">
      <span className="text-muted-foreground">{job}</span>
      <span className="min-w-0 truncate font-mono">{model || '(not set)'}</span>
    </div>
  );
}

export function SetupWizard({ state: initial, onDone }: { state: SetupState; onDone: () => void }) {
  const controlSize = useControlSize();
  const [state, setState] = useState<SetupState>(initial);
  // Skip the provider step when the install is already able to work: a key is
  // configured, or nothing routes to Anthropic in the first place (a local
  // endpoint set by the deploy, or one configured here on an earlier visit).
  const alreadyUsable = initial.apiKey.configured || !initial.llm.needsAnthropicKey;
  const [step, setStep] = useState<Step>(alreadyUsable ? 'language' : 'provider');

  // ---- step 1: who writes the problems -------------------------------------
  // The measurement from the validation call, kept because the SEED step's copy
  // is derived from it: "a few cents" is a lie on a local endpoint, and
  // "15-30 seconds" is a guess when a real number was just measured.
  const [check, setCheck] = useState<LlmProviderCheck | null>(null);

  /**
   * What happens once a provider has been validated AND stored.
   *
   * Re-reading the setup state rather than trusting the write is deliberate:
   * `needsAnthropicKey`, the per-language bank counts and the key's status are
   * all derived server-side, and the two screens after this one are built out of
   * them. Anything thrown here surfaces in the picker's own error line.
   */
  const onProviderSaved = useCallback(async (next: LlmProviderCheck | null) => {
    setCheck(next);
    setState(await getSetupState());
    setStep('language');
  }, []);

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
  // Step 1 — who writes the problems
  // ===========================================================================
  if (step === 'provider') {
    // The deploy pinned it. Writing a row under an env-pinned field would store
    // something that never takes effect, so the screen reports rather than asks
    // — the same treatment an env-supplied API key has always had.
    if (state.llm.envLocked) {
      return (
        <Shell
          step="provider"
          icon={<ShieldCheck className="h-7 w-7" />}
          title={ENV_PINNED_TITLE}
          blurb={
            <>
              <EnvPinnedSentence /> Nothing to choose &mdash; carry on.
            </>
          }
        >
          <div className="space-y-3">
            <EnvPinnedFields role={state.llm.workhorse} />
            <Button
              className="w-full gap-1.5"
              size={controlSize}
              onClick={() => setStep('language')}
            >
              Continue <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </Shell>
      );
    }

    return (
      <Shell
        step="provider"
        icon={<Cpu className="h-7 w-7" />}
        title="Choose who writes your problems"
        blurb={
          <>
            Every problem, hint and coaching note is written by a model. Use Anthropic&rsquo;s
            Claude, or point codegrind at a model you already run yourself &mdash; the whole
            app works either way, and a local one costs nothing.
          </>
        }
      >
        <ProviderPicker llm={state.llm} onSaved={onProviderSaved} />
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

    // The cost and the wait are FACTS ABOUT THIS INSTALL, not decoration. A
    // local binding spends nothing, so "a few cents" would be a small lie told
    // to the exact person this work exists for; and when the provider check just
    // timed a real call, "15-30 seconds" is a guess standing in front of a
    // measurement.
    const isLocal = state.llm.workhorse.provider === 'openai-compatible';
    const writer = isLocal ? state.llm.workhorse.model || 'Your model' : 'Claude';
    const seconds = check?.estimatedProblemSeconds ?? null;
    const perProblem = seconds ? `about ${seconds} seconds` : '15–30 seconds';
    const runTime = seconds
      ? `about ${Math.max(1, Math.round((seconds * 8) / 60))} minute${
          Math.max(1, Math.round((seconds * 8) / 60)) === 1 ? '' : 's'
        }`
      : 'a few minutes';
    const price = isLocal ? 'free — it all runs on this machine' : 'a few cents';

    return (
      <Shell
        step="seed"
        icon={<Boxes className="h-7 w-7" />}
        title={`Stock your ${meta.displayName} bank`}
        blurb={
          seeding || finished ? (
            <>
              {writer} is writing problems, then running each reference solution in a sandbox
              to derive its expected answers. That verification is why a problem takes{' '}
              {perProblem} &mdash; and why the one you get is guaranteed solvable.
            </>
          ) : (
            <>
              A fresh {meta.displayName} bank is empty, so your first problems would each take{' '}
              {perProblem} to write. Stocking {PER_SLOT} per starting topic now
              (8&nbsp;problems, {runTime}, {price}) makes them instant instead.
            </>
          )
        }
      >
        {!seeding && !finished && check?.warning && (
          <p className="flex items-start gap-1.5 rounded-lg border border-border bg-card/60 p-3 text-xs leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{check.warning}</span>
          </p>
        )}

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
          {/* What is actually configured, rather than an assumption that it is a
              key: on a local install there is no key, and saying "key verified"
              there would be the app describing a setup nobody chose. */}
          {state.llm.workhorse.provider === 'openai-compatible' ? (
            <Badge variant="secondary">{state.llm.workhorse.model} verified</Badge>
          ) : (
            state.apiKey.configured && (
              <Badge variant="secondary">key verified ····{state.apiKey.suffix}</Badge>
            )
          )}
        </div>

        {/* WHICH MODEL DOES WHICH JOB, before the first call is made rather than
            after the first invoice. The wizard writes one configuration and it
            lands in both role rows, but llm.client's Anthropic defaults are not
            the same for both — the coach gets the bigger model. Labelled by the
            JOB, because "workhorse" and "tutor" are words from the source. Both
            ids come from GET /api/setup/state's resolved routing; nothing here
            knows a model name. */}
        <RolesReady llm={state.llm} />
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
