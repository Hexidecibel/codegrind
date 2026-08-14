// =============================================================================
// apikey.service — the two rules that must never quietly stop being true
// =============================================================================
//   1. The ENVIRONMENT wins. An existing deploy hands its key in through
//      ANTHROPIC_API_KEY, and nothing the first-run wizard stores may shadow
//      it. If this regresses, the user's live instance starts running on a key
//      they pasted into a browser months ago and cannot see.
//   2. Nothing that crosses the HTTP boundary carries the key. `describe()` is
//      the only shape that leaves this module, so it is the only thing that has
//      to be checked — which is exactly why the module is shaped this way.
//
// The Anthropic SDK is replaced wholesale: `validate()` must be exercised for
// each failure it maps, and none of those mappings should require a network or
// a real key.

import { describe as suite, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    models = { list: mocks.list };
    constructor(public opts: { apiKey: string }) {}
  }
  return { default: FakeAnthropic };
});

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-apikey-test-'));
if (!TEST_DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run: test DATA_DIR ${TEST_DATA_DIR} is not under ${tmpdir()}`);
}
process.env.DATA_DIR = TEST_DATA_DIR;
delete process.env.ANTHROPIC_API_KEY;

const apikey = await import('./apikey.service.js');
const db = await import('./db.js');

const GOOD = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaWXYZ';

beforeEach(() => {
  db.db.exec(`DELETE FROM settings`);
  delete process.env.ANTHROPIC_API_KEY;
  // Reset the module's hydrated flag through its own API rather than reaching
  // into it: forget() is the supported way back to "nothing configured".
  apikey.forget();
  delete process.env.ANTHROPIC_API_KEY;
  db.db.exec(`DELETE FROM settings`);
  mocks.list.mockReset();
});

afterAll(() => {
  db.db.close();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// =============================================================================
suite('where the key comes from', () => {
  it('reports nothing on a fresh install', () => {
    expect(apikey.describe()).toEqual({ configured: false, source: null, suffix: null });
    expect(apikey.isConfigured()).toBe(false);
  });

  it('reads the environment, and calls it the environment', () => {
    process.env.ANTHROPIC_API_KEY = GOOD;
    expect(apikey.describe()).toEqual({ configured: true, source: 'env', suffix: 'WXYZ' });
  });

  it('reads a stored key when the environment has none', () => {
    apikey.store(GOOD);
    expect(apikey.describe()).toEqual({ configured: true, source: 'settings', suffix: 'WXYZ' });
  });

  it('publishes a stored key into the environment so the SDK can see it', () => {
    apikey.store(GOOD);
    expect(process.env.ANTHROPIC_API_KEY).toBe(GOOD);
  });

  it('trims what it stores — a pasted key usually arrives with a newline', () => {
    apikey.store(`  ${GOOD}\n`);
    expect(process.env.ANTHROPIC_API_KEY).toBe(GOOD);
    expect(db.getSetting<string>(apikey.API_KEY_SETTING)).toBe(GOOD);
  });
});

// =============================================================================
suite('THE ENVIRONMENT WINS', () => {
  it('hydrate does not overwrite an environment key', () => {
    apikey.store(GOOD);
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-from-the-deployment-ENVV';
    apikey.hydrate();
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-from-the-deployment-ENVV');
    expect(apikey.describe()).toEqual({ configured: true, source: 'env', suffix: 'ENVV' });
  });

  it('storing a key while the environment has one persists it but does NOT take over', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-from-the-deployment-ENVV';
    apikey.store(GOOD);
    // Stored for later...
    expect(db.getSetting<string>(apikey.API_KEY_SETTING)).toBe(GOOD);
    // ...but the live key is still the deploy's, and it says so.
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-from-the-deployment-ENVV');
    expect(apikey.describe().source).toBe('env');
  });

  it('hydrate loads a stored key only when the environment is empty', () => {
    apikey.store(GOOD);
    delete process.env.ANTHROPIC_API_KEY;
    expect(apikey.hydrate()).toEqual({ configured: true, source: 'settings', suffix: 'WXYZ' });
    expect(process.env.ANTHROPIC_API_KEY).toBe(GOOD);
  });

  it('a SECOND hydrate does not relabel a stored key as environment-supplied', () => {
    // The regression this exists for: hydrate() runs again on every seed
    // request. A boolean "have I hydrated" flag would see a non-empty
    // environment on the second call, conclude the deploy must have set it, and
    // report source: 'env' for a key the user pasted into the wizard — after
    // which the setup screen refuses to let them change it.
    apikey.store(GOOD);
    expect(apikey.describe().source).toBe('settings');
    apikey.hydrate();
    apikey.hydrate();
    expect(apikey.describe().source).toBe('settings');
  });

  it('a deploy key that appears AFTER a stored one takes over', () => {
    apikey.store(GOOD);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-appeared-later-from-systemd-ENVV';
    apikey.hydrate();
    expect(apikey.describe()).toEqual({ configured: true, source: 'env', suffix: 'ENVV' });
  });

  it('treats an empty-string environment variable as absent', () => {
    process.env.ANTHROPIC_API_KEY = '   ';
    apikey.store(GOOD);
    expect(apikey.describe().source).toBe('settings');
  });

  it('forget clears the stored key but never an environment one', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-from-the-deployment-ENVV';
    apikey.store(GOOD);
    apikey.forget();
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-from-the-deployment-ENVV');
    expect(apikey.describe().source).toBe('env');
  });
});

// =============================================================================
suite('secrecy', () => {
  it('describe() has no field that could carry the key', () => {
    apikey.store(GOOD);
    const status = apikey.describe();
    expect(Object.keys(status).sort()).toEqual(['configured', 'source', 'suffix']);
    expect(JSON.stringify(status)).not.toContain(GOOD);
    // Four characters, and never more.
    expect(status.suffix).toHaveLength(4);
    expect(GOOD.endsWith(status.suffix!)).toBe(true);
  });

  it('redact scrubs the key out of anything about to be shown', () => {
    expect(apikey.redact(`bad key: ${GOOD} rejected`, GOOD)).toBe('bad key: sk-ant-*** rejected');
    // A blank key must not turn every message into asterisks.
    expect(apikey.redact('untouched', '')).toBe('untouched');
  });
});

// =============================================================================
suite('validate', () => {
  it('accepts a key the provider accepts', async () => {
    mocks.list.mockResolvedValue({ data: [] });
    expect(await apikey.validate(GOOD)).toBeNull();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty box without a network call', async () => {
    expect(await apikey.validate('   ')).toMatch(/Paste your Anthropic API key/);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('rejects something that is plainly not a key, without a network call', async () => {
    for (const junk of ['hunter2', 'https://console.anthropic.com', 'sk-proj-abc123']) {
      expect(await apikey.validate(junk)).toMatch(/does not look like an Anthropic API key/);
    }
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('turns a 401 into advice, not a stack trace', async () => {
    mocks.list.mockRejectedValue(Object.assign(new Error('invalid x-api-key'), { status: 401 }));
    const msg = await apikey.validate(GOOD);
    expect(msg).toMatch(/rejected that key/);
    expect(msg).toMatch(/console\.anthropic\.com/);
  });

  it('distinguishes "no internet" from "wrong key"', async () => {
    mocks.list.mockRejectedValue(new Error('fetch failed'));
    expect(await apikey.validate(GOOD)).toMatch(/could not reach the Anthropic API/i);
  });

  it('calls out an empty balance, which is not a bad key', async () => {
    mocks.list.mockRejectedValue(
      Object.assign(new Error('your credit balance is too low'), { status: 400 })
    );
    expect(await apikey.validate(GOOD)).toMatch(/no credit/);
  });

  it('never echoes the key back in an error message', async () => {
    mocks.list.mockRejectedValue(
      Object.assign(new Error(`request with key ${GOOD} failed`), { status: 500 })
    );
    const msg = await apikey.validate(GOOD);
    expect(msg).not.toContain(GOOD);
    expect(msg).toContain('sk-ant-***');
  });
});
