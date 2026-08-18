// =============================================================================
// Settings — the config screen you can still reach on day 300
// =============================================================================
// The provider form used to exist in exactly one place: the first-run wizard,
// which the app renders only while `GET /api/setup/state` says something is
// missing. The moment a working provider and a stocked bank existed, `needed`
// went false and there was no route in the browser that could change a model, an
// endpoint or a key again — the answer was `curl -X PUT /api/providers` or edit
// `.env`. This page is that route.
//
// IT HOSTS THE WIZARD'S OWN CONTROL, not a copy of it. `ProviderPicker` was
// lifted out of SetupWizard.tsx precisely so there is one implementation of
// "point codegrind at a model", one set of rules about what may be saved, and
// one gate — `PUT /api/providers` runs a real forced tool call and stores
// nothing that fails it. A second form here would be a second place for those
// rules to drift.
//
// THE ENVIRONMENT ALWAYS WINS, AND THE PAGE SAYS SO RATHER THAN IMPLYING
// OTHERWISE. `GET /api/providers` reports a `source` per field; anything marked
// `env` is rendered read-only with the wizard's own "your deploy set this"
// language. Offering an editable box over an env-pinned field would invite
// somebody to save a row that is then never used, and to conclude the app
// ignored them.
//
// NO CREDENTIAL IS EVER ON THIS PAGE. The Anthropic key and the endpoint's
// bearer token are both described as {configured, source, suffix} and by nothing
// else — the same shape the API returns, because the API is careful never to
// return more. Replacing a key is a write; reading one back is not a feature.
//
// NO NEW ENDPOINT BACKS ANY OF THIS. Routing comes from GET /api/providers, the
// model list from POST /api/providers/models, the save from PUT /api/providers,
// language and key status from GET/PUT /api/settings.

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Coins,
  Cpu,
  KeyRound,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import type { ApiKeyStatus, LlmProviderCheck, LlmRoleStatus, LlmStatus } from '@/shared/types';
import { LANGUAGE_META } from '@/shared/languages';
import { getProviders, getSettings, updateProvider } from '@/client/lib/api';
import { summariseRoles, coachCostSentence, type RoleSummary } from '@/client/lib/role-summary';
import {
  ProviderPicker,
  EnvPinnedFields,
  EnvPinnedSentence,
  ENV_PINNED_TITLE,
} from '@/client/components/setup/ProviderPicker';
import { LanguagePicker } from '@/client/components/LanguagePicker';
import { Badge } from '@/client/components/ui/badge';
import { sourceLabel, roleIsEnvPinned } from '@/client/lib/provider-source';
import { cn } from '@/lib/utils';
import type { Language } from '@/shared/languages';

/** What each role actually does, in the terms the user experiences it. */
const ROLE_BLURB = {
  workhorse: 'Writes every problem, hint, lesson and grade.',
  tutor: 'Answers you in the coach chat.',
} as const;

/**
 * The heading, in the same terms.
 *
 * "Workhorse" and "tutor" are the words the code uses; nobody arrives at this
 * page knowing them, and the cost surprise this section exists to prevent is
 * about WHICH JOB costs what. The internal name stays alongside so the routing
 * on screen is still greppable against llm.client.ts and the env variables.
 */
const ROLE_TITLE = {
  workhorse: 'Problems',
  tutor: 'Coach chat',
} as const;

function Section({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{blurb}</p>
      </div>
      {children}
    </section>
  );
}

/** One `label — value (where it came from)` line. */
function Row({
  label,
  value,
  origin,
  mono = true,
}: {
  label: string;
  value: React.ReactNode;
  /** Omitted when the field has no per-field source (the API key has its own). */
  origin?: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-baseline gap-2">
        <span className={mono ? 'truncate font-mono text-xs' : 'truncate text-sm'}>{value}</span>
        {origin}
      </span>
    </div>
  );
}

/**
 * The origin tag.
 *
 * An env-supplied field gets the emphatic variant and the shield, because it is
 * the one case where what is on screen cannot be changed from this page.
 */
function Origin({ source }: { source: LlmRoleStatus['source']['model'] }) {
  const env = source === 'env';
  return (
    <Badge
      variant={env ? 'default' : 'secondary'}
      className="shrink-0 gap-1 whitespace-nowrap font-normal"
    >
      {env && <ShieldCheck className="h-3 w-3" />}
      {sourceLabel(source)}
    </Badge>
  );
}

/** How one role is routed right now, field by field, with each field's origin. */
function RoleCard({
  name,
  role,
  children,
}: {
  name: 'workhorse' | 'tutor';
  role: LlmRoleStatus;
  /** The coach's model control, on the one card that has one. */
  children?: React.ReactNode;
}) {
  const pinned = roleIsEnvPinned(role);
  return (
    <div className="rounded-xl border bg-card p-4 shadow">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">
          {ROLE_TITLE[name]}{' '}
          <span className="text-xs font-normal capitalize text-muted-foreground">({name})</span>
        </h3>
        <span className="text-xs text-muted-foreground">{ROLE_BLURB[name]}</span>
      </div>
      <div className="mt-2 divide-y divide-border/60">
        <Row
          label="Provider"
          value={role.provider === 'anthropic' ? 'Anthropic (Claude)' : 'Your own model'}
          mono={false}
          origin={<Origin source={role.source.provider} />}
        />
        <Row
          label="Model"
          value={role.model || '(not set)'}
          origin={<Origin source={role.source.model} />}
        />
        {role.provider === 'openai-compatible' && (
          <Row
            label="Endpoint"
            value={role.endpoint || '(not set)'}
            origin={<Origin source={role.source.endpoint} />}
          />
        )}
        {role.credential.configured && (
          <Row
            label="Endpoint key"
            value={`····${role.credential.suffix ?? ''}`}
            origin={<Origin source={role.source.endpointKey} />}
          />
        )}
      </div>
      {pinned && (
        <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <EnvPinnedSentence /> Change it where the service is configured, not here.
          </span>
        </p>
      )}
      {children}
    </div>
  );
}

/**
 * The coach's model: what it is, what it costs, and the one control that changes it.
 *
 * This lives inside the tutor's card because the fact it is correcting is a fact
 * ABOUT THAT ROLE. Before this, `storeProviderConfig` wrote the same row for both
 * roles, but llm.client's Anthropic defaults are `claude-sonnet-5` for the
 * workhorse and `claude-opus-5` for the tutor — so every coach follow-up ran on
 * the dearer model, chosen by nobody, mentioned nowhere. Opus stays the default
 * (it is genuinely better at the conversation); it is just no longer a secret.
 *
 * NOTHING HERE IS A HARDCODED MODEL ID. Both options come off `GET /api/providers`:
 * the writer's resolved model, and the role's own `defaultModel`.
 *
 * It renders nothing on the local path, where both roles are the same self-hosted
 * model and the extra cost is zero — a warning that does not apply is how you
 * teach somebody to ignore the next one.
 */
function CoachModelControl({
  summary,
  onChange,
  busy,
  error,
}: {
  summary: RoleSummary;
  onChange: (model: string | null) => void;
  busy: boolean;
  error: string | null;
}) {
  const cost = coachCostSentence(summary, 'settings');
  if (!cost && !summary.canChooseCoachModel) return null;

  const matched = summary.sameModel;
  const options: { key: 'default' | 'match'; model: string; label: string; note: string }[] = [
    {
      key: 'default',
      model: summary.coachDefaultModel,
      label: 'Best answers',
      note: 'codegrind’s default. The bigger model, and the more expensive one.',
    },
    {
      key: 'match',
      model: summary.writerModel,
      label: 'Same as problems',
      note: 'One model for everything, so the coach costs what the rest of the app does.',
    },
  ];

  return (
    <div className="mt-3 space-y-2 border-t border-border/60 pt-3">
      {cost && (
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <Coins className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{cost}</span>
        </p>
      )}
      {summary.canChooseCoachModel && (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            {options.map((o) => {
              const selected = (o.key === 'match') === matched;
              return (
                <button
                  key={o.key}
                  type="button"
                  disabled={busy || selected || !o.model}
                  onClick={() => onChange(o.key === 'match' ? summary.writerModel : null)}
                  className={cn(
                    'rounded-lg border bg-background p-3 text-left text-xs transition-colors',
                    'hover:border-primary/60 hover:bg-accent disabled:hover:bg-background',
                    selected && 'border-primary/60 bg-accent disabled:opacity-100',
                    !selected && 'disabled:opacity-50',
                  )}
                >
                  <span className="flex items-center gap-1.5 font-semibold">
                    {o.label}
                    {selected && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[0.7rem] text-muted-foreground">
                    {o.model || '—'}
                  </span>
                  <span className="mt-1 block leading-relaxed text-muted-foreground">{o.note}</span>
                </button>
              );
            })}
          </div>
          {busy && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
            </p>
          )}
          {error && (
            <p className="flex items-start gap-1.5 text-xs text-destructive-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** The Anthropic key, described. Never the key. */
function ApiKeyCard({ status, relevant }: { status: ApiKeyStatus; relevant: boolean }) {
  return (
    <div className="rounded-xl border bg-card p-4 shadow">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">Anthropic API key</h3>
        <span className="text-xs text-muted-foreground">
          {relevant
            ? 'Every Claude call needs it.'
            : 'Nothing routes to Anthropic right now — this install spends nothing.'}
        </span>
      </div>
      <div className="mt-2 divide-y divide-border/60">
        <Row
          label="Status"
          value={status.configured ? `configured ····${status.suffix ?? ''}` : 'not configured'}
          origin={
            status.source && (
              <Badge
                variant={status.source === 'env' ? 'default' : 'secondary'}
                className="shrink-0 gap-1 whitespace-nowrap font-normal"
              >
                {status.source === 'env' && <ShieldCheck className="h-3 w-3" />}
                {sourceLabel(status.source)}
              </Badge>
            )
          }
        />
      </div>
      <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
        <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          {status.source === 'env' ? (
            <>
              Supplied by <code className="font-mono">ANTHROPIC_API_KEY</code> in this
              service&rsquo;s environment, which always wins over anything saved here. A key
              pasted below is kept as a fallback but is not the one being used.
            </>
          ) : (
            <>
              To replace it, choose <strong>Claude</strong> below and paste a new one — it is
              checked against Anthropic before it is stored, and never shown again.
            </>
          )}
        </span>
      </p>
    </div>
  );
}

export function SettingsPage() {
  const [llm, setLlm] = useState<LlmStatus | null>(null);
  const [apiKey, setApiKey] = useState<ApiKeyStatus | null>(null);
  const [language, setLanguage] = useState<Language | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The measurement from the last successful save, and the banner that says the
  // save took. Both are cleared on the next attempt by the picker's own state.
  const [check, setCheck] = useState<LlmProviderCheck | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // The coach-model control's own in-flight state. Separate from the picker's:
  // this write neither validates an endpoint nor spends anything, so it must not
  // borrow the picker's "testing a real tool call" language or its spinner.
  const [coachBusy, setCoachBusy] = useState(false);
  const [coachError, setCoachError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [providers, settings] = await Promise.all([getProviders(), getSettings()]);
    setLlm(providers);
    setApiKey(settings.apiKey);
    setLanguage(settings.language);
  }, []);

  useEffect(() => {
    let live = true;
    load()
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : 'Could not read your settings.');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [load]);

  /**
   * After a save that the SERVER accepted.
   *
   * Re-reading rather than trusting the write is the point: the response says
   * what was stored, but `GET /api/providers` says what the app will actually
   * use — including the tutor, which follows the workhorse unless it was pinned
   * separately, and which nobody edited here.
   */
  const onSaved = useCallback(
    async (next: LlmProviderCheck | null) => {
      setCheck(next);
      await load();
      setSavedAt(Date.now());
    },
    [load],
  );

  /**
   * Pin the coach's model, or clear the pin.
   *
   * `null` clears it — `PUT /api/providers` distinguishes an ABSENT chatModel
   * ("leave it alone") from a null one ("back to the default"), which is what
   * lets re-saving an API key stop wiping this choice. Re-reads afterwards for
   * the same reason every other save here does: the response says what was
   * stored, `GET /api/providers` says what the app will actually use.
   */
  const chooseCoachModel = useCallback(
    async (model: string | null) => {
      setCoachError(null);
      setCoachBusy(true);
      try {
        await updateProvider({ provider: 'anthropic', chatModel: model });
        await load();
      } catch (err) {
        setCoachError(
          err instanceof Error ? err.message : 'Could not change the coach’s model.',
        );
      } finally {
        setCoachBusy(false);
      }
    },
    [load],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Loading your settings…
      </div>
    );
  }

  if (error || !llm || !apiKey) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <div className="mx-auto mt-6 max-w-md rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive-foreground">
          <AlertTriangle className="mb-1 inline h-4 w-4" />{' '}
          {error ?? 'No settings returned.'}
        </div>
      </div>
    );
  }

  return (
    // Direct child of `<main>` and owner of its own scroller, exactly as Reflect
    // is — wrapping this in anything sizes the scroller to the content and the
    // page clips instead of scrolling.
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-8 p-4 pb-24 sm:p-6">
        <header>
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Who writes your problems, and what they are written in. Everything on this page
            takes effect on the next thing the app generates.
          </p>
        </header>

        <Section
          title="How you're routed"
          blurb={
            <>
              Two jobs, routed separately: one model writes your problems, another answers
              you in the coach chat. This is what each actually goes to right now, and where
              every value came from — anything your deploy set in the environment wins over
              anything saved here.
            </>
          }
        >
          <div className="space-y-3">
            <RoleCard name="workhorse" role={llm.workhorse} />
            <RoleCard name="tutor" role={llm.tutor}>
              <CoachModelControl
                summary={summariseRoles(llm)}
                onChange={(model) => void chooseCoachModel(model)}
                busy={coachBusy}
                error={coachError}
              />
            </RoleCard>
            <ApiKeyCard status={apiKey} relevant={llm.needsAnthropicKey} />
          </div>
        </Section>

        <Section
          title="Which model answers"
          blurb={
            llm.envLocked ? (
              <EnvPinnedSentence />
            ) : (
              <>
                Point codegrind at Anthropic&rsquo;s Claude or at a model you run yourself. The
                whole app works either way, and a local one costs nothing.
              </>
            )
          }
        >
          {llm.envLocked ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <ShieldCheck className="h-4 w-4 text-primary" />
                {ENV_PINNED_TITLE}
              </div>
              <EnvPinnedFields role={llm.workhorse} />
              <p className="text-xs leading-relaxed text-muted-foreground">
                There is nothing to change here — a value saved from this page under an
                env-pinned field would be stored and then never used. Edit the service&rsquo;s
                environment instead.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {savedAt !== null && (
                <p
                  key={savedAt}
                  role="status"
                  className="flex items-start gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-foreground"
                >
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                  <span>
                    Saved — {llm.workhorse.provider === 'openai-compatible' ? (
                      <>
                        every call now goes to{' '}
                        <code className="font-mono text-xs">{llm.workhorse.model}</code>
                      </>
                    ) : (
                      <>every call now goes to Claude</>
                    )}
                    {check && (
                      <>
                        {' '}
                        &middot; measured at {check.latencyMs}ms, so a problem should take about{' '}
                        {check.estimatedProblemSeconds} seconds to write
                      </>
                    )}
                    .
                  </span>
                </p>
              )}
              {check?.warning && (
                <p className="flex items-start gap-1.5 rounded-lg border border-border bg-card/60 p-3 text-xs leading-relaxed text-muted-foreground">
                  <Cpu className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{check.warning}</span>
                </p>
              )}
              <ProviderPicker
                llm={llm}
                onSaved={onSaved}
                anthropicSubmitLabel="Verify and save"
                localSubmitLabel="Test and save"
                localSubmitVerb="Saving"
                // Settings opens on the routing you came to read, not with the
                // caret in an endpoint box halfway down the page.
                autoFocusFirstField={false}
              />
            </div>
          )}
        </Section>

        <Section
          title="Language"
          blurb={
            <>
              The language every new problem is written, run and graded in. The bank, the skill
              tree and the tier ladder are separate per language, so switching loses nothing —
              it just changes which of them you are working on.
            </>
          }
        >
          <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4 shadow">
            <LanguagePicker onChange={(next) => setLanguage(next)} />
            <span className="text-xs text-muted-foreground">
              {language
                ? `New problems will be ${LANGUAGE_META[language].displayName}.`
                : 'Choose the language new problems are written in.'}
            </span>
          </div>
        </Section>
      </div>
    </div>
  );
}
