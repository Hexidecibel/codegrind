// =============================================================================
// The provider step, extracted so it can live in two places
// =============================================================================
// This IS the wizard's first screen — lifted out of SetupWizard.tsx verbatim so
// that Settings can host the same control instead of growing a second, subtly
// different one. There is exactly one implementation of "point codegrind at a
// model", and both surfaces render it.
//
// Everything the original screen did, it still does, and for the same reasons:
//
//   THE LOCAL PATH PICKS FROM A LIST IT FETCHED, NEVER A TEXT BOX. `GET
//   /v1/models` populates a `<select>`, so the commonest local misconfiguration
//   — a model id that is nearly right — is not expressible. Ids on this deploy's
//   deny list are filtered out server-side and never reach the list at all.
//
//   AND IT IS VALIDATED BEFORE IT IS STORED. Submitting runs a real forced tool
//   call against the chosen model; if the model answers with prose, nothing is
//   saved and the screen says so. Ten of this app's eleven LLM calls are forced
//   tool calls, so that is not a warning, it is the difference between an app and
//   a spinner.
//
// The only things the host supplies are the words on the button and what to do
// after a successful save — the wizard advances a step, Settings re-reads the
// routing it just changed. The gate itself belongs to the server (PUT
// /api/providers) and neither host can opt out of it.
//
// WHAT IS NOT HERE: the env-pinned case. Both hosts have to render "your deploy
// set this" in their own frame — a full wizard screen with a Continue button, or
// a panel in a page of panels — so what is shared is the FIELDS and the SENTENCE
// (`EnvPinnedFields`, `ENV_PINNED_TITLE`, `EnvPinnedSentence`), not the layout
// around them. A row written under an env-pinned field is a row that never takes
// effect, which is why neither host offers the form at all in that state.

import { useCallback, useEffect, useState } from 'react';
import {
  KeyRound,
  Loader2,
  ArrowRight,
  AlertTriangle,
  ExternalLink,
  ShieldCheck,
  Cpu,
  Cloud,
  ChevronRight,
  ChevronDown,
  RefreshCw,
} from 'lucide-react';
import type {
  LlmProviderCheck,
  LlmProviderId,
  LlmRoleStatus,
  LlmStatus,
} from '@/shared/types';
import { updateSettings, updateProvider, listProviderModels } from '@/client/lib/api';
import { useControlSize } from '@/client/hooks/useMediaQuery';
import { Button } from '@/client/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * What the endpoint field starts as.
 *
 * llama.cpp, llama-swap and LM Studio all speak this shape; the port is the one
 * the author's own fleet uses, and a prefilled value that is nearly right is
 * worth more than an empty box to someone who has never seen `/v1` before.
 */
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:9600/v1';

/** The heading both hosts use when the environment pinned the routing. */
export const ENV_PINNED_TITLE = 'Your deploy set this';

/** The one sentence both hosts say about an env-pinned configuration. */
export function EnvPinnedSentence() {
  return (
    <>
      This install&rsquo;s model is configured in the environment, which always wins over
      anything saved here.
    </>
  );
}

/** The read-only model/endpoint card shown instead of the form when env wins. */
export function EnvPinnedFields({ role }: { role: LlmRoleStatus }) {
  return (
    <div className="rounded-xl border bg-card p-4 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground">Model</span>
        <span className="font-mono text-xs">{role.model || '(not set)'}</span>
      </div>
      {role.endpoint && (
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-muted-foreground">Endpoint</span>
          <span className="truncate font-mono text-xs">{role.endpoint}</span>
        </div>
      )}
    </div>
  );
}

export interface ProviderPickerProps {
  /** The live routing, used for the opening branch and the prefilled fields. */
  llm: LlmStatus;
  /**
   * Run after a configuration has been VALIDATED AND STORED. `check` carries the
   * local path's measurement, and is null on the Anthropic path (which has its
   * own key check). Anything this throws is reported in the form's own error
   * line, exactly as a failed save is — so a host that reloads state here does
   * not have to invent a second place to put the failure.
   */
  onSaved: (check: LlmProviderCheck | null) => void | Promise<void>;
  /** Button text for the Claude branch. */
  anthropicSubmitLabel?: string;
  /** Button text for the local branch. */
  localSubmitLabel?: string;
  /** How the local branch's footnote names the act of submitting. */
  localSubmitVerb?: string;
  /**
   * Whether opening a branch should focus its first field.
   *
   * True in the wizard, where the form IS the screen and the caret belongs in
   * it. False on a page of panels: focusing scrolls the focused element into
   * view, so an autofocused endpoint box lands the reader halfway down Settings
   * with the routing they came to read already scrolled off the top.
   */
  autoFocusFirstField?: boolean;
}

export function ProviderPicker({
  llm,
  onSaved,
  anthropicSubmitLabel = 'Verify and continue',
  localSubmitLabel = 'Test and continue',
  localSubmitVerb = 'Continuing',
  autoFocusFirstField = true,
}: ProviderPickerProps) {
  const controlSize = useControlSize();
  const [choice, setChoice] = useState<LlmProviderId | null>(
    // Whatever is configured now, so a second visit opens on the right branch.
    llm.workhorse.provider === 'openai-compatible' ? 'openai-compatible' : null,
  );

  // -- the Claude branch --
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
      setKeyInput('');
      await onSaved(null);
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : 'Could not verify that key.');
    } finally {
      setVerifying(false);
    }
  }, [keyInput, onSaved]);

  // -- the local branch --
  const [endpoint, setEndpoint] = useState(llm.workhorse.endpoint ?? DEFAULT_ENDPOINT);
  const [models, setModels] = useState<string[] | null>(null);
  const [denied, setDenied] = useState(0);
  const [model, setModel] = useState(llm.workhorse.model ?? '');
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
      await onSaved(res.check);
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : 'That endpoint did not pass the check.');
    } finally {
      setChecking(false);
    }
  }, [endpoint, model, endpointKey, onSaved]);

  return (
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

      {/* ---- Claude: the key form ---- */}
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
            autoFocus={autoFocusFirstField}
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
                {anthropicSubmitLabel} <ArrowRight className="h-4 w-4" />
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
              machine&rsquo;s local database — never in <code className="font-mono">.env</code>,
              and never sent anywhere but Anthropic. Set{' '}
              <code className="font-mono">ANTHROPIC_API_KEY</code> in the environment instead
              and that wins over anything saved here.
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
            <label className="text-xs font-medium text-muted-foreground" htmlFor="cg-endpoint">
              Endpoint
            </label>
            <div className="flex gap-2">
              <input
                id="cg-endpoint"
                autoFocus={autoFocusFirstField}
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
                {localSubmitLabel} <ArrowRight className="h-4 w-4" />
              </>
            )}
          </Button>
          <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              {localSubmitVerb} runs one real call against that model and checks it answers by
              calling a tool, the way codegrind asks for everything it needs. A model that
              cannot do that is not saved &mdash; it would fail on every problem instead of
              here.
            </span>
          </p>
        </form>
      )}
    </div>
  );
}
