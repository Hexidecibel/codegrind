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
// THE LOCAL PATH PICKS FROM A LIST IT FETCHED, NEVER A TEXT BOX. `GET
// /v1/models` populates a `<select>`, so the commonest local misconfiguration —
// a model id that is nearly right — is not expressible. Ids on this deploy's
// deny list are filtered out server-side and never reach the list at all.
//
// AND IT IS VALIDATED BEFORE IT IS STORED. Continue runs a real forced tool call
// against the chosen model; if the model answers with prose, nothing is saved
// and the screen says so. Ten of this app's eleven LLM calls are forced tool
// calls, so that is not a warning, it is the difference between an app and a
// spinner. Latency IS only a warning: it comes back as "problems will take about
// N seconds to write", measured, not guessed.
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
  Cpu,
  Cloud,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Info,
} from 'lucide-react';
import type {
  SetupState,
  SeedEvent,
  Topic,
  Difficulty,
  LlmProviderCheck,
  LlmProviderId,
} from '@/shared/types';
import { LANGUAGE_META, type Language } from '@/shared/languages';
import {
  getSetupState,
  updateSettings,
  updateProvider,
  listProviderModels,
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

/**
 * What the endpoint field starts as.
 *
 * llama.cpp, llama-swap and LM Studio all speak this shape; the port is the one
 * the author's own fleet uses, and a prefilled value that is nearly right is
 * worth more than an empty box to someone who has never seen `/v1` before.
 */
const DEFAULT_ENDPOINT = 'http://127.0.0.1:9600/v1';

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
  const [choice, setChoice] = useState<LlmProviderId | null>(
    // Whatever is configured now, so a second visit opens on the right branch.
    initial.llm.workhorse.provider === 'openai-compatible' ? 'openai-compatible' : null,
  );

  // -- the Claude branch: unchanged from the key step it replaces --
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
      // Record the CHOICE as well as the key. This is what switches an install
      // back from a local endpoint — without it, a stored `llm.workhorse` row
      // would keep routing to a local model that the user just replaced.
      await updateProvider({ provider: 'anthropic' });
      const next = await getSetupState();
      setState(next);
      setKeyInput('');
      setCheck(null);
      setStep('language');
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : 'Could not verify that key.');
    } finally {
      setVerifying(false);
    }
  }, [keyInput]);

  // -- the local branch --
  const [endpoint, setEndpoint] = useState(initial.llm.workhorse.endpoint ?? DEFAULT_ENDPOINT);
  const [models, setModels] = useState<string[] | null>(null);
  const [denied, setDenied] = useState(0);
  const [model, setModel] = useState(initial.llm.workhorse.model ?? '');
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [endpointKey, setEndpointKey] = useState('');
  const [showKeyField, setShowKeyField] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  /** Ask the endpoint what it serves. Free, read-only, and no tokens. */
  const loadModels = useCallback(async () => {
    setModelsError(null);
    setCheckError(null);
    setLoadingModels(true);
    try {
      const res = await listProviderModels(endpoint, endpointKey || undefined);
      setModels(res.models);
      setDenied(res.denied);
      // Keep a selection that is still on offer; otherwise make the user pick.
      setModel((current) => (res.models.includes(current) ? current : ''));
    } catch (err) {
      setModels(null);
      setModelsError(err instanceof Error ? err.message : 'Could not reach that endpoint.');
    } finally {
      setLoadingModels(false);
    }
  }, [endpoint, endpointKey]);

  // Populate the list as soon as the local branch is opened. The default
  // endpoint is right often enough that making people press a button first
  // would be a step for nothing.
  useEffect(() => {
    if (choice === 'openai-compatible' && models === null && !loadingModels && !modelsError) {
      void loadModels();
    }
  }, [choice, models, loadingModels, modelsError, loadModels]);

  /**
   * The gate. A 400 here means NOTHING was stored — the endpoint could not be
   * reached, does not serve that model, or could not be made to call a tool.
   */
  const saveLocalProvider = useCallback(async () => {
    setCheckError(null);
    setChecking(true);
    try {
      const res = await updateProvider({
        provider: 'openai-compatible',
        endpoint,
        model,
        endpointKey: endpointKey || undefined,
      });
      setCheck(res.check);
      setState(await getSetupState());
      setStep('language');
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : 'That endpoint did not pass the check.');
    } finally {
      setChecking(false);
    }
  }, [endpoint, model, endpointKey]);

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
      const w = state.llm.workhorse;
      return (
        <Shell
          step="provider"
          icon={<ShieldCheck className="h-7 w-7" />}
          title="Your deploy set this"
          blurb={
            <>
              This install&rsquo;s model is configured in the environment, which always wins
              over anything saved here. Nothing to choose &mdash; carry on.
            </>
          }
        >
          <div className="space-y-3">
            <div className="rounded-xl border bg-card p-4 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Model</span>
                <span className="font-mono text-xs">{w.model || '(not set)'}</span>
              </div>
              {w.endpoint && (
                <div className="mt-2 flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Endpoint</span>
                  <span className="truncate font-mono text-xs">{w.endpoint}</span>
                </div>
              )}
            </div>
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
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setChoice('anthropic')}
              className={cn(
                'flex items-start gap-3 rounded-xl border bg-card p-4 text-left shadow transition-colors',
                'hover:border-primary/60 hover:bg-accent',
                choice === 'anthropic' && 'border-primary/60 bg-accent',
              )}
            >
              <Cloud className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <span>
                <span className="block font-semibold">Claude</span>
                <span className="block text-xs text-muted-foreground">
                  Best quality. Needs an API key, and costs a few cents an hour.
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setChoice('openai-compatible')}
              className={cn(
                'flex items-start gap-3 rounded-xl border bg-card p-4 text-left shadow transition-colors',
                'hover:border-primary/60 hover:bg-accent',
                choice === 'openai-compatible' && 'border-primary/60 bg-accent',
              )}
            >
              <Cpu className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <span>
                <span className="block font-semibold">Your own model</span>
                <span className="block text-xs text-muted-foreground">
                  llama.cpp, Ollama, LM Studio, vLLM. No key, no spend, slower.
                </span>
              </span>
            </button>
          </div>

          {/* ---- Claude: the key form, unchanged ---- */}
          {choice === 'anthropic' && (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!verifying && keyInput.trim()) void saveKey();
              }}
            >
              <input
                // type=password: this is a credential and browsers, screenshots
                // and shoulders all treat it as one.
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
                <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Create one at{' '}
                  <a
                    className="inline-flex items-center gap-0.5 text-primary underline-offset-4 hover:underline"
                    href="https://console.anthropic.com/settings/keys"
                    target="_blank"
                    rel="noreferrer"
                  >
                    console.anthropic.com
                    <ExternalLink className="h-3 w-3" />
                  </a>
                  . Checked against Anthropic before it is saved, then stored in this
                  machine&rsquo;s local database — never in{' '}
                  <code className="font-mono">.env</code>, and never sent anywhere but
                  Anthropic. Set <code className="font-mono">ANTHROPIC_API_KEY</code> in the
                  environment instead and that wins over anything saved here.
                </span>
              </p>
            </form>
          )}

          {/* ---- Local: endpoint, then a model picked from what it serves ---- */}
          {choice === 'openai-compatible' && (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!checking && model) void saveLocalProvider();
              }}
            >
              <div className="space-y-1.5">
                <label
                  className="text-xs font-medium text-muted-foreground"
                  htmlFor="cg-endpoint"
                >
                  Endpoint
                </label>
                <div className="flex gap-2">
                  <input
                    id="cg-endpoint"
                    autoFocus
                    spellCheck={false}
                    autoComplete="off"
                    value={endpoint}
                    onChange={(e) => {
                      setEndpoint(e.target.value);
                      // The list belongs to the OLD address the moment this
                      // changes; keeping it on screen would let somebody submit
                      // a model one server serves against another that does not.
                      setModels(null);
                      setModelsError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void loadModels();
                      }
                    }}
                    placeholder={DEFAULT_ENDPOINT}
                    aria-label="OpenAI-compatible endpoint"
                    className="h-11 w-full rounded-md border border-input bg-background px-3 font-mono text-sm outline-none ring-ring transition focus-visible:ring-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size={controlSize}
                    className="shrink-0 gap-1.5"
                    onClick={() => void loadModels()}
                    disabled={loadingModels || !endpoint.trim()}
                  >
                    {loadingModels ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}
                    <span className="sr-only sm:not-sr-only">Models</span>
                  </Button>
                </div>
              </div>

              {modelsError && (
                <p className="flex items-start gap-1.5 text-sm text-destructive-foreground">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{modelsError}</span>
                </p>
              )}

              {models !== null && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="cg-model">
                    Model
                  </label>
                  <select
                    id="cg-model"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    aria-label="Model"
                    className="h-11 w-full rounded-md border border-input bg-background px-3 font-mono text-sm outline-none ring-ring transition focus-visible:ring-1"
                  >
                    <option value="">
                      {models.length === 0 ? 'nothing on offer' : 'choose a model…'}
                    </option>
                    {models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    {models.length} model{models.length === 1 ? '' : 's'} served
                    {denied > 0 && (
                      <>
                        {' '}
                        &middot; {denied} hidden by this deploy&rsquo;s deny list
                      </>
                    )}
                  </p>
                </div>
              )}

              {/* The fleet this was built for has no auth at all, so a key field
                  on screen by default would be a question most people cannot
                  answer. Collapsed, and it stays collapsed until someone with a
                  vLLM behind a gateway goes looking for it. */}
              <button
                type="button"
                onClick={() => setShowKeyField((v) => !v)}
                className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {showKeyField ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                This endpoint needs a key
              </button>
              {showKeyField && (
                <input
                  type="password"
                  spellCheck={false}
                  autoComplete="off"
                  value={endpointKey}
                  onChange={(e) => setEndpointKey(e.target.value)}
                  placeholder="bearer token"
                  aria-label="Endpoint bearer token"
                  className="h-11 w-full rounded-md border border-input bg-background px-3 font-mono text-sm outline-none ring-ring transition focus-visible:ring-1"
                />
              )}

              {checkError && (
                <p className="flex items-start gap-1.5 text-sm text-destructive-foreground">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{checkError}</span>
                </p>
              )}

              <Button
                type="submit"
                className="w-full gap-1.5"
                size={controlSize}
                disabled={checking || !model}
              >
                {checking ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Testing a real tool call…
                  </>
                ) : (
                  <>
                    Test and continue <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </Button>
              <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Continuing runs one real call against that model and checks it answers by
                  calling a tool, the way codegrind asks for everything it needs. A model
                  that cannot do that is not saved &mdash; it would fail on every problem
                  instead of here.
                </span>
              </p>
            </form>
          )}
        </div>
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
