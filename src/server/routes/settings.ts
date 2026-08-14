// =============================================================================
// settings — the server-side preference store, over HTTP
// =============================================================================
// Server-side rather than localStorage because the language decides what gets
// GENERATED, and generation happens on the server hours before any client asks
// for it (bin/seed-bank, warmAhead). A preference the server cannot read is not
// a preference, it is a display filter.
//
// THE API KEY IS A SETTING AND IT IS NOT LIKE THE OTHERS. Two rules govern it,
// and both are enforced here rather than by convention:
//
//   1. **It never comes back out.** `readSettings()` returns
//      `apikey.describe()` — a boolean, a source, and the last four characters.
//      There is no route, no query parameter and no debug flag that returns the
//      key, because the only consumer that needs the value is the SDK, running
//      in this process.
//   2. **It is validated against the provider before it is stored.** A bad key
//      that was accepted here would fail later, on the first generate, as an
//      opaque 401 inside a 30-second operation the user has no reason to
//      connect to something they typed two screens ago.
//
// Rule 2 is why `validate` may now return a Promise: proving a key is real
// means a network round trip. The commit half stays synchronous, and the
// all-or-nothing property is unchanged — every field is validated before any
// field is committed.

import { Hono } from 'hono';
import type { SettingsResponse } from '../../shared/types.js';
import { LANGUAGES, isLanguage } from '../../shared/languages.js';
import { getActiveLanguage, setActiveLanguage } from '../services/db.js';
import * as apikey from '../services/apikey.service.js';

export const settingsRoutes = new Hono();

/** The whole live settings state, assembled from its individual accessors. */
function readSettings(): SettingsResponse {
  return { language: getActiveLanguage(), apiKey: apikey.describe() };
}

/**
 * One entry per writable setting: validate an untrusted value, then commit it.
 * A table rather than a chain of ifs because this is the list the wizard grows,
 * and because "which keys are writable" should be one readable thing rather
 * than a property of control flow.
 *
 * `validate` returns an error MESSAGE (400 body) or null for "accepted" — the
 * only place a language string from outside this repo is ever narrowed. It may
 * return a Promise, because validating an API key means asking the provider.
 */
interface SettingWriter {
  validate: (value: unknown) => string | null | Promise<string | null>;
  commit: (value: unknown) => void;
}

const WRITERS: Record<string, SettingWriter> = {
  language: {
    validate: (value) =>
      isLanguage(value) ? null : `language must be one of: ${LANGUAGES.join(', ')}`,
    commit: (value) => {
      // Safe: validate() ran first and is the type guard.
      if (isLanguage(value)) setActiveLanguage(value);
    },
  },
  apiKey: {
    validate: (value) => {
      if (typeof value !== 'string') return 'apiKey must be a string';
      // The live provider check. Costs no tokens (`models.list`) and is the
      // only thing that can tell a typo from a revoked key.
      return apikey.validate(value);
    },
    commit: (value) => {
      if (typeof value === 'string') apikey.store(value);
    },
  },
};

// GET /api/settings — the current settings, with defaults filled in for any
// row that has never been written (a fresh install has none of them).
//
// `apiKey` here is a STATUS, never a value. See apikey.service.ts.
settingsRoutes.get('/settings', (c) => c.json(readSettings()));

// PUT /api/settings — partial update. Unknown keys and invalid values are 400s,
// and nothing is committed unless EVERY field validates: a half-applied
// settings write is how you end up serving a language whose bank is empty.
settingsRoutes.put('/settings', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'body must be a JSON object' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'body must be a JSON object' }, 400);
  }

  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length === 0) {
    return c.json({ error: 'no settings supplied' }, 400);
  }

  for (const [key, value] of entries) {
    const writer = WRITERS[key];
    if (!writer) {
      return c.json(
        { error: `unknown setting "${key}" — writable settings: ${Object.keys(WRITERS).join(', ')}` },
        400
      );
    }
    const problem = await writer.validate(value);
    if (problem) return c.json({ error: problem }, 400);
  }

  for (const [key, value] of entries) WRITERS[key].commit(value);

  return c.json(readSettings());
});
