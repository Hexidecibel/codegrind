// =============================================================================
// settings route — the HTTP boundary where an untrusted language is narrowed
// =============================================================================
// Exercised through Hono's `app.request()` against the real route and the real
// db layer (pointed at a throwaway DATA_DIR — see db.language.test.ts for why
// that seam exists and why the assignment must precede the import).
//
// This is the only place in the app where a language arrives as an arbitrary
// string, so it is the only place that can reject one. Everywhere else the
// compiler has already done it.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The apiKey writer proves a key against Anthropic before storing it, so the
// SDK is replaced wholesale — the point of these cases is the ROUTE's
// behaviour (validated-before-stored, never echoed), not the provider's.
const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    models = { list: mocks.list };
    constructor(_opts: unknown) {}
  }
  return { default: FakeAnthropic };
});

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-settings-test-'));
if (!TEST_DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run: test DATA_DIR ${TEST_DATA_DIR} is not under ${tmpdir()}`);
}
process.env.DATA_DIR = TEST_DATA_DIR;

// No key in the environment for these tests: `apiKey.source` is 'env' or
// 'settings' depending on it, and a stray ANTHROPIC_API_KEY in the shell that
// ran vitest would silently change what GET /api/settings reports.
delete process.env.ANTHROPIC_API_KEY;

const { settingsRoutes } = await import('./settings.js');
const db = await import('../services/db.js');
const apikey = await import('../services/apikey.service.js');

const app = new Hono();
app.route('/api', settingsRoutes);

async function put(body: unknown): Promise<Response> {
  return app.request('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** The apiKey block a fresh install reports: nothing configured. */
const NO_KEY = { configured: false, source: null, suffix: null };

beforeEach(() => {
  db.db.exec(`DELETE FROM settings`);
  delete process.env.ANTHROPIC_API_KEY;
  apikey.forget();
  delete process.env.ANTHROPIC_API_KEY;
  db.db.exec(`DELETE FROM settings`);
  mocks.list.mockReset();
});

afterAll(() => {
  db.db.close();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('GET /api/settings', () => {
  it('reports the default language on a fresh install', async () => {
    const res = await app.request('/api/settings');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ language: 'javascript', apiKey: NO_KEY });
  });

  it('reports whatever was last written', async () => {
    db.setActiveLanguage('python');
    const res = await app.request('/api/settings');
    expect(await res.json()).toEqual({ language: 'python', apiKey: NO_KEY });
  });
});

describe('PUT /api/settings', () => {
  it('sets the language and echoes the new state', async () => {
    const res = await put({ language: 'python' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ language: 'python', apiKey: NO_KEY });
    // And it is really persisted, not just reflected back.
    expect(db.getActiveLanguage()).toBe('python');
  });

  it('round-trips back to javascript', async () => {
    await put({ language: 'go' });
    const res = await put({ language: 'javascript' });
    expect(await res.json()).toEqual({ language: 'javascript', apiKey: NO_KEY });
    expect(db.getActiveLanguage()).toBe('javascript');
  });

  it('rejects a language this build does not support', async () => {
    const res = await put({ language: 'kotlin' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('language must be one of');
    expect(db.getActiveLanguage()).toBe('javascript');
  });

  it('rejects a language this build has no sandbox harness for', async () => {
    // The regression this route was missing. Java is a real member of LANGUAGES
    // — `isLanguage('java')` is true and always will be — but there is no
    // `test-harness/java/`, so storing it hands the user an app where every
    // problem load spends MAX_GEN_ATTEMPTS generation calls and then fails with
    // a message blaming the model for erroring on its own tests.
    const res = await put({ language: 'java' });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain('Java');
    expect(error).toContain('no sandbox harness');
    // Not "must be one of" — Java IS one of them. The message has to say the
    // real reason or the user goes looking for a typo.
    expect(error).not.toContain('must be one of');
    expect(db.getActiveLanguage()).toBe('javascript');
  });

  it('accepts every language that does have a harness on disk', async () => {
    // The gate must be the filesystem, not a hardcoded denylist: when
    // test-harness/java/Dockerfile lands this route starts accepting it with no
    // edit here, and until then nothing else is collateral damage.
    for (const language of ['javascript', 'python', 'go']) {
      const res = await put({ language });
      expect(res.status, language).toBe(200);
      expect(db.getActiveLanguage()).toBe(language);
    }
  });

  it('rejects casing variants rather than papering over them', async () => {
    // A stored 'Python' is a bug to surface, not to normalise — every writer of
    // this column is code in this repo.
    expect((await put({ language: 'Python' })).status).toBe(400);
  });

  it('rejects non-string values', async () => {
    for (const value of [null, 42, true, ['python'], { name: 'python' }]) {
      expect((await put({ language: value })).status).toBe(400);
    }
    expect(db.getActiveLanguage()).toBe('javascript');
  });

  it('rejects an unknown setting key', async () => {
    const res = await put({ favouriteColour: 'blue' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('unknown setting');
  });

  it('commits nothing when one field of several is invalid', async () => {
    db.setActiveLanguage('python');
    const res = await put({ language: 'go', favouriteColour: 'blue' });
    expect(res.status).toBe(400);
    // The valid half must not have landed — a half-applied settings write is how
    // you end up serving a language whose bank is empty.
    expect(db.getActiveLanguage()).toBe('python');
  });

  it('rejects an empty or non-object body', async () => {
    expect((await put({})).status).toBe(400);
    expect((await put('[]')).status).toBe(400);
    expect((await put('not json at all')).status).toBe(400);
  });
});

// =============================================================================
describe('the API key, which is a setting and is not like the others', () => {
  const KEY = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaWXYZ';

  it('stores a key the provider accepts, and reports only its status', async () => {
    mocks.list.mockResolvedValue({ data: [] });
    const res = await put({ apiKey: KEY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      language: 'javascript',
      apiKey: { configured: true, source: 'settings', suffix: 'WXYZ' },
    });
  });

  it('NEVER returns the key — not on write, not on read', async () => {
    mocks.list.mockResolvedValue({ data: [] });
    const written = await (await put({ apiKey: KEY })).text();
    expect(written).not.toContain(KEY);
    const read = await (await app.request('/api/settings')).text();
    expect(read).not.toContain(KEY);
    // And the last four are the most that is ever shown.
    expect(read).toContain('WXYZ');
    expect(read).not.toContain('aaaa');
  });

  it('rejects a bad key with a clear message rather than storing it', async () => {
    mocks.list.mockRejectedValue(Object.assign(new Error('invalid x-api-key'), { status: 401 }));
    const res = await put({ apiKey: KEY });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/rejected that key/);
    // Nothing landed.
    expect(db.getSetting(apikey.API_KEY_SETTING)).toBeNull();
    expect(apikey.describe().configured).toBe(false);
  });

  it('rejects junk without even asking the provider', async () => {
    const res = await put({ apiKey: 'hunter2' });
    expect(res.status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(apikey.describe().configured).toBe(false);
  });

  it('rejects a non-string key', async () => {
    for (const value of [null, 42, true, ['sk-ant-x'], {}]) {
      expect((await put({ apiKey: value })).status).toBe(400);
    }
  });

  it('commits neither field when the key is the invalid half', async () => {
    mocks.list.mockRejectedValue(Object.assign(new Error('nope'), { status: 401 }));
    const res = await put({ language: 'python', apiKey: KEY });
    expect(res.status).toBe(400);
    expect(db.getActiveLanguage()).toBe('javascript');
    expect(apikey.describe().configured).toBe(false);
  });

  it('says the environment is the source when the environment has a key', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-supplied-by-the-deploy-ENVV';
    const res = await app.request('/api/settings');
    expect((await res.json()).apiKey).toEqual({
      configured: true,
      source: 'env',
      suffix: 'ENVV',
    });
  });
});
