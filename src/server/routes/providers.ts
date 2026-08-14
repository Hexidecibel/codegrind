// =============================================================================
// providers — configuring which model answers, over HTTP
// =============================================================================
// Three endpoints, one job: let somebody point this app at their own model from
// the browser, and stop them pointing it at one that cannot run it.
//
//   GET  /api/providers          how each role is routed, and what the deploy pinned
//   POST /api/providers/models   what an endpoint says it serves (for the picker)
//   PUT  /api/providers          validate a configuration, then store it
//
// WHY THIS IS NOT PART OF /api/settings. The settings route is a table of
// single-value writers with an all-or-nothing commit; a provider configuration
// is three fields that only mean anything together, and validating it costs a
// live model call. Bolting that onto the settings table's contract would make
// `PUT /api/settings {language}` able to spend 90 seconds proving an endpoint.
// The API key stays where it is, on /api/settings, unchanged and untouched.
//
// WHY `/models` IS A POST. It carries an optional endpoint credential (the
// vLLM-behind-auth case). A GET would put that credential in a query string,
// which is the one place a secret is guaranteed to be logged — by the browser's
// history, by any proxy, and by the server's own access log.
//
// NOTHING HERE EVER RETURNS A CREDENTIAL. Not the Anthropic key, not the
// endpoint's bearer token. `describeProviders()` is the only shape that crosses
// this boundary and it carries {configured, source, suffix}, exactly as
// apikey.service does — see provider.service.ts.

import { Hono } from 'hono';
import type { LlmConfigRequest, LlmModelsRequest } from '../../shared/types.js';
import {
  describeProviders,
  listEndpointModels,
  parseEndpoint,
  storeProviderConfig,
  validateOpenAiProvider,
} from '../services/provider.service.js';
import * as apikey from '../services/apikey.service.js';

export const providerRoutes = new Hono();

// GET /api/providers — the live routing, described. Never a credential.
providerRoutes.get('/providers', (c) => c.json(describeProviders()));

// POST /api/providers/models — ask an endpoint what it serves.
//
// Read-only and free: it is a GET on the endpoint's side and consumes no tokens.
// Denied model ids are removed from the answer rather than flagged, because the
// picker must not be able to offer one at all.
providerRoutes.post('/providers/models', async (c) => {
  let body: LlmModelsRequest;
  try {
    body = (await c.req.json()) as LlmModelsRequest;
  } catch {
    return c.json({ error: 'body must be a JSON object' }, 400);
  }
  if (typeof body?.endpoint !== 'string') {
    return c.json({ error: 'endpoint must be a string' }, 400);
  }
  const key = typeof body.endpointKey === 'string' ? body.endpointKey : undefined;
  const result = await listEndpointModels(body.endpoint, key);
  if ('error' in result) return c.json({ error: result.error }, 400);
  return c.json(result);
});

// PUT /api/providers — the gate.
//
// A configuration that fails validation is NOT STORED. That is the whole point:
// ten of this app's eleven LLM calls are forced tool calls, so an endpoint that
// cannot make one is not "degraded", it is unusable, and storing it would trade
// a 90-second check now for a broken install discovered mid-session.
providerRoutes.put('/providers', async (c) => {
  let body: LlmConfigRequest;
  try {
    body = (await c.req.json()) as LlmConfigRequest;
  } catch {
    return c.json({ error: 'body must be a JSON object' }, 400);
  }

  if (body?.provider === 'anthropic') {
    // The Anthropic path has its own check, and it already ran: the key was
    // proved against the provider by PUT /api/settings before this call. All
    // that is left is to record the choice, which matters because it is what
    // switches an install BACK from a local endpoint.
    if (!apikey.isConfigured()) {
      return c.json(
        {
          error:
            'Add an Anthropic API key before choosing Claude — every call would fail without one.',
        },
        400
      );
    }
    return c.json({ llm: storeProviderConfig({ provider: 'anthropic' }), check: null });
  }

  if (body?.provider !== 'openai-compatible') {
    return c.json(
      { error: 'provider must be "anthropic" or "openai-compatible"' },
      400
    );
  }

  if (typeof body.endpoint !== 'string' || typeof body.model !== 'string') {
    return c.json({ error: 'endpoint and model are both required for a local provider' }, 400);
  }
  const parsed = parseEndpoint(body.endpoint);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);

  const endpointKey =
    typeof body.endpointKey === 'string' && body.endpointKey.trim()
      ? body.endpointKey.trim()
      : undefined;

  const verdict = await validateOpenAiProvider({
    endpoint: parsed.url,
    model: body.model,
    endpointKey,
  });
  if (!verdict.ok) return c.json({ error: verdict.error }, 400);

  const llm = storeProviderConfig({
    provider: 'openai-compatible',
    model: body.model.trim(),
    // Stored WITHOUT any `user:pass@` it arrived with — parseEndpoint stripped
    // it, and this is the value that reaches the database.
    endpoint: parsed.url,
    endpointKey,
  });
  return c.json({ llm, check: verdict.check });
});
