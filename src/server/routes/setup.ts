// =============================================================================
// setup — the first-run flow's server half
// =============================================================================
// Three endpoints, one job: get a brand-new install from "cloned it" to "there
// is a real problem on screen" without anybody editing a file.
//
//   GET  /api/setup/state    what is missing, and what each language can serve
//   POST /api/setup/seed     stock a bank, streaming REAL progress as NDJSON
//   POST /api/setup/dismiss  "I know the bank is empty; let me in"
//
// The API key is written through PUT /api/settings, not here, because it is a
// setting and settings have one writer. See routes/settings.ts.
//
// WHY `needed` IS DERIVED AND NOT A FLAG. The obvious implementation is an
// `onboarded = true` row, and it is wrong in both directions: a returning user
// who restores a backup or moves the database gets no help when they genuinely
// need it, and any user whose flag is somehow cleared gets a wizard in front of
// a working app. The two things the wizard exists to fix — no usable key, and
// nothing the active language can hand out — are both cheap to just ask. So we
// ask. The one stored bit (`setup.dismissed`) can only ever SUPPRESS the
// empty-bank prompt, never raise it, and it cannot suppress the missing-key
// prompt at all, because there is nothing to skip to.
//
// WHY NDJSON AND NOT SSE. Seeding is a POST — it spends money, so it must not be
// a GET that a browser can prefetch or a proxy can retry. EventSource cannot
// issue a POST. A `fetch` whose body is read line by line does everything the
// wizard needs, with no reconnection semantics to reason about: when the socket
// dies the run is over, which is exactly true.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { SetupState, SetupLanguageState, Difficulty, Topic } from '../../shared/types.js';
import { DIFFICULTIES, TOPICS } from '../../shared/types.js';
import { LANGUAGES, LANGUAGE_META, isLanguage } from '../../shared/languages.js';
import {
  bankSize,
  servableBankTotal,
  getActiveLanguage,
  setActiveLanguage,
  getSetting,
  setSetting,
} from '../services/db.js';
import * as apikey from '../services/apikey.service.js';
import {
  runSeed,
  DEFAULT_SEED_TOPICS,
  DEFAULT_SEED_DIFFICULTIES,
} from '../services/seed.service.js';

export const setupRoutes = new Hono();

/** The settings row that suppresses the empty-bank prompt. Never raises it. */
export const SETUP_DISMISSED_SETTING = 'setup.dismissed';

/**
 * The upper bound on what one wizard run may spend.
 *
 * Seeding from the browser is the only path in the app where a single click can
 * trigger a dozen generation calls, so the ceiling is enforced on the SERVER
 * and not in the form. 4 root topics x 3 per slot = 12 problems is the most a
 * first run can cost, which is roughly a coffee.
 */
const MAX_PER_SLOT = 3;

/**
 * The repo root, resolved from this module rather than from `process.cwd()`.
 *
 * The service is started by systemd with a WorkingDirectory, by `bin/start`
 * from the repo, and by a developer from wherever they happen to be standing.
 * Only one of those three is guaranteed.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Does a sandbox harness exist for this language?
 *
 * Deliberately the same question `cg_buildable_languages` asks in
 * bin/lib/languages.sh, and deliberately asked of the same directory: a
 * hardcoded list here would be a second source of truth that goes stale the
 * moment `test-harness/java/` lands.
 */
function harnessExists(language: string): boolean {
  return existsSync(path.join(REPO_ROOT, 'test-harness', language, 'Dockerfile'));
}

function languageStates(): SetupLanguageState[] {
  return LANGUAGES.map((language) => ({
    language,
    displayName: LANGUAGE_META[language].displayName,
    banked: bankSize(language),
    servable: servableBankTotal(language),
    supported: harnessExists(language),
  }));
}

/** The whole first-run picture, derived fresh on every call. */
export function readSetupState(): SetupState {
  const key = apikey.describe();
  const language = getActiveLanguage();
  const servable = servableBankTotal(language);
  const dismissed = getSetting<unknown>(SETUP_DISMISSED_SETTING) === true;

  // Order matters: a missing key is the only blocker that cannot be skipped,
  // so it is checked first and is never suppressed by the dismissal row.
  let reason: SetupState['reason'] = null;
  if (!key.configured) reason = 'no-api-key';
  else if (servable === 0 && !dismissed) reason = 'empty-bank';

  return {
    needed: reason !== null,
    reason,
    dismissible: key.configured,
    apiKey: key,
    language,
    languages: languageStates(),
  };
}

setupRoutes.get('/setup/state', (c) => c.json(readSetupState()));

// POST /api/setup/dismiss — "the bank is empty and I do not care".
//
// A legitimate choice: with a key configured the app works fine with an empty
// bank, it is just slow on the first problem of each slot. The row this writes
// can never make `needed` true, only stop the empty-bank case from making it
// true, and pasting a key later re-arms nothing.
setupRoutes.post('/setup/dismiss', (c) => {
  setSetting(SETUP_DISMISSED_SETTING, true);
  return c.json(readSetupState());
});

interface SeedBody {
  language?: unknown;
  perSlot?: unknown;
  topics?: unknown;
  difficulties?: unknown;
}

// POST /api/setup/seed — stock a bank, streaming progress.
//
// THIS SPENDS REAL MONEY. One Claude generation call per problem (sometimes
// more — a reference that fails its own tests is regenerated), plus two sandbox
// runs each to canonicalize the tests.
//
// Response is `application/x-ndjson`: one JSON `SeedEvent` per line, flushed as
// it happens. A failure mid-run is a `failed` event and the run CONTINUES — a
// partial bank is a usable bank, and the alternative is stranding somebody four
// minutes into a five-minute operation.
setupRoutes.post('/setup/seed', async (c) => {
  let body: SeedBody = {};
  try {
    body = (await c.req.json()) as SeedBody;
  } catch {
    // An empty body is fine: seed the active language with the defaults.
  }

  // Publish a wizard-stored key into the environment before anything can need
  // it. Cheap, idempotent, and it means a key pasted 10 seconds ago works
  // without a restart.
  apikey.hydrate();
  if (!apikey.isConfigured()) {
    return c.json({ error: 'No API key is configured — add one before seeding.' }, 400);
  }

  const language = body.language === undefined ? getActiveLanguage() : body.language;
  if (!isLanguage(language)) {
    return c.json({ error: `language must be one of: ${LANGUAGES.join(', ')}` }, 400);
  }
  // Seeding a language with no harness would spend a generation call per
  // problem and then fail every canonicalization — the most expensive possible
  // way to learn that Java is not finished.
  if (!harnessExists(language)) {
    return c.json(
      {
        error: `${LANGUAGE_META[language].displayName} has no sandbox harness in this build yet — pick another language.`,
      },
      400
    );
  }

  const perSlotRaw = body.perSlot === undefined ? 2 : Number(body.perSlot);
  if (!Number.isInteger(perSlotRaw) || perSlotRaw < 1 || perSlotRaw > MAX_PER_SLOT) {
    return c.json({ error: `perSlot must be an integer between 1 and ${MAX_PER_SLOT}` }, 400);
  }

  const topics = pickList<Topic>(body.topics, TOPICS, DEFAULT_SEED_TOPICS);
  if (!topics) return c.json({ error: `topics must be a subset of: ${TOPICS.join(', ')}` }, 400);

  const difficulties = pickList<Difficulty>(
    body.difficulties,
    DIFFICULTIES,
    DEFAULT_SEED_DIFFICULTIES
  );
  if (!difficulties) {
    return c.json({ error: `difficulties must be a subset of: ${DIFFICULTIES.join(', ')}` }, 400);
  }

  // Seeding a language you are not going to practice is a bill for nothing, so
  // the wizard's choice is committed here rather than in a second round trip
  // the user could close the tab between.
  if (getActiveLanguage() !== language) setActiveLanguage(language);

  c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
  c.header('Cache-Control', 'no-store');
  // Chunks must reach the browser as they happen or the progress is a lie told
  // slowly. Nothing in this stack buffers by default, but a proxy in front of
  // it might; this is the standard ask not to.
  c.header('X-Accel-Buffering', 'no');

  return stream(c, async (s) => {
    try {
      for await (const ev of runSeed({ language, topics, difficulties, perSlot: perSlotRaw })) {
        await s.write(JSON.stringify(ev) + '\n');
      }
    } catch (err) {
      // Anything that escapes runSeed is a bug or a dead database, not a failed
      // generation (those are `failed` events). Say so on the wire — a stream
      // that simply stops looks identical to a network drop from the client.
      const message = err instanceof Error ? err.message : String(err);
      await s.write(JSON.stringify({ type: 'failed', done: 0, total: 0, message }) + '\n');
    }
  });
});

/**
 * Narrow an optional list of enum members, or fall back to a default.
 *
 * Returns `null` for "the caller sent something invalid", which is different
 * from "the caller sent nothing" — conflating the two is how a typo'd topic
 * silently seeds all four.
 */
function pickList<T extends string>(
  value: unknown,
  allowed: readonly string[],
  fallback: readonly T[]
): T[] | null {
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: T[] = [];
  for (const v of value) {
    if (typeof v !== 'string' || !allowed.includes(v)) return null;
    if (!out.includes(v as T)) out.push(v as T);
  }
  return out;
}
