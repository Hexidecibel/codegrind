// =============================================================================
// settings — the server-side preference store, over HTTP
// =============================================================================
// Server-side rather than localStorage because the language decides what gets
// GENERATED, and generation happens on the server hours before any client asks
// for it (bin/seed-bank, warmAhead). A preference the server cannot read is not
// a preference, it is a display filter.
//
// Shaped for what lands next. The AI-provider wizard adds `provider`, `model`
// and `apiKeyRef` as ROWS in the same table: one more entry in WRITERS below,
// one more optional field on SettingsResponse, no migration and no new route.

import { Hono } from 'hono';
import type { SettingsResponse } from '../../shared/types.js';
import { LANGUAGES, isLanguage } from '../../shared/languages.js';
import { getActiveLanguage, setActiveLanguage } from '../services/db.js';

export const settingsRoutes = new Hono();

/** The whole live settings state, assembled from its individual accessors. */
function readSettings(): SettingsResponse {
  return { language: getActiveLanguage() };
}

/**
 * One entry per writable setting: validate an untrusted value, then commit it.
 * A table rather than a chain of ifs because this is the list the wizard grows,
 * and because "which keys are writable" should be one readable thing rather
 * than a property of control flow.
 *
 * `validate` returns an error MESSAGE (400 body) or null for "accepted" — the
 * only place a language string from outside this repo is ever narrowed.
 */
interface SettingWriter {
  validate: (value: unknown) => string | null;
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
};

// GET /api/settings — the current settings, with defaults filled in for any
// row that has never been written (a fresh install has none of them).
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
    const problem = writer.validate(value);
    if (problem) return c.json({ error: problem }, 400);
  }

  for (const [key, value] of entries) WRITERS[key].commit(value);

  return c.json(readSettings());
});
