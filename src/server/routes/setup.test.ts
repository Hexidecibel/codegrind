// =============================================================================
// setup route — first-run detection, and the guards around spending money
// =============================================================================
// The interesting logic here is not the happy path, it is `needed`. It must be
// DERIVED, it must be true when the app cannot work, and it must be false the
// moment it can — because a wizard that appears in front of a working install
// is worse than no wizard at all.
//
// The seeding endpoint is the only place in the app where one click can trigger
// a dozen LLM calls, so its argument validation is tested as if it were a
// payment form. Nothing here ever reaches `runSeed`: every case asserted is one
// that must be rejected BEFORE any generating starts.

import { describe as suite, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Language } from '../../shared/languages.js';

// Seeding must never actually run in a unit test. Mocking the bank is what
// makes "the route rejected this before spending anything" a provable claim
// rather than a hopeful one.
const mocks = vi.hoisted(() => ({
  generateAndStore: vi.fn(),
  // Defaults to an Anthropic install, so every pre-existing case below reads
  // exactly as it did before local providers existed.
  needsAnthropicKey: vi.fn(() => true),
}));
vi.mock('../services/bank.service.js', () => ({ generateAndStore: mocks.generateAndStore }));
// Only the one question is faked; the rest of the module is real, because
// seed.service imports it too and a bare stub would break that graph.
vi.mock('../services/llm.client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/llm.client.js')>()),
  needsAnthropicKey: mocks.needsAnthropicKey,
}));

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-setup-test-'));
if (!TEST_DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run: test DATA_DIR ${TEST_DATA_DIR} is not under ${tmpdir()}`);
}
process.env.DATA_DIR = TEST_DATA_DIR;
delete process.env.ANTHROPIC_API_KEY;

const { setupRoutes, SETUP_DISMISSED_SETTING } = await import('./setup.js');
const db = await import('../services/db.js');
const apikey = await import('../services/apikey.service.js');

const app = new Hono();
app.route('/api', setupRoutes);

const KEY = 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaWXYZ';

async function state() {
  const res = await app.request('/api/setup/state');
  expect(res.status).toBe(200);
  return res.json();
}

/** Put one problem in the bank, through the real insert. */
function bankOne(
  overrides: Partial<{ language: Language; used: boolean; canonicalized: boolean; id: string }> = {}
): void {
  db.insertProblem({
    id: overrides.id ?? `p-${Math.random().toString(36).slice(2)}`,
    language: overrides.language ?? 'javascript',
    title: 'Two Sum',
    prompt: 'Add two numbers.',
    examples: [],
    constraints: [],
    difficulty: 'easy',
    topic: 'arrays',
    pattern: 'hashing',
    starterCode: 'function f() {}',
    functionName: 'f',
    sampleTests: [],
    hiddenTests: [],
    referenceSolution: 'function f() {}',
    canonicalized: overrides.canonicalized ?? true,
    used: overrides.used ?? false,
    createdAt: new Date().toISOString(),
  });
}

beforeEach(() => {
  db.db.exec(`DELETE FROM settings; DELETE FROM problems;`);
  delete process.env.ANTHROPIC_API_KEY;
  apikey.forget();
  delete process.env.ANTHROPIC_API_KEY;
  db.db.exec(`DELETE FROM settings`);
  mocks.generateAndStore.mockReset();
  mocks.needsAnthropicKey.mockReturnValue(true);
});

afterAll(() => {
  db.db.close();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// =============================================================================
suite('GET /api/setup/state', () => {
  it('needs setup, and says why, when there is no key', async () => {
    const s = await state();
    expect(s.needed).toBe(true);
    expect(s.reason).toBe('no-api-key');
    // Nothing to skip TO: every interesting path needs the provider.
    expect(s.dismissible).toBe(false);
  });

  // A fully local install has no Anthropic key, wants none, and every API path
  // works without one. Gating the SPA on a key here would lock a working app
  // behind a signup it never needs — the precise outcome the provider work
  // exists to prevent, and invisible from the server side because every route
  // answers 200 while the browser refuses to leave the wizard.
  it('does not demand a key when the configured routing needs no key', async () => {
    mocks.needsAnthropicKey.mockReturnValue(false);
    bankOne();
    const s = await state();
    expect(s.needed).toBe(false);
    expect(s.reason).toBe(null);
    // Skippable even with nothing banked: there is no blocker to resolve.
    expect(s.dismissible).toBe(true);
  });

  it('sends a keyless local install to the bank, never to the key screen', async () => {
    mocks.needsAnthropicKey.mockReturnValue(false);
    const s = await state();
    expect(s.needed).toBe(true);
    expect(s.reason).toBe('empty-bank');
    expect(s.dismissible).toBe(true);
  });

  it('needs setup when the key is fine but the bank is empty', async () => {
    apikey.store(KEY);
    const s = await state();
    expect(s.needed).toBe(true);
    expect(s.reason).toBe('empty-bank');
    expect(s.dismissible).toBe(true);
  });

  it('gets out of the way once a key and a servable problem exist', async () => {
    apikey.store(KEY);
    bankOne();
    const s = await state();
    expect(s.needed).toBe(false);
    expect(s.reason).toBeNull();
  });

  it('counts SERVABLE problems, not rows', async () => {
    apikey.store(KEY);
    // Used, and un-canonicalized: two rows the bank can never hand out.
    bankOne({ id: 'used', used: true });
    bankOne({ id: 'raw', canonicalized: false });
    const s = await state();
    expect(s.needed).toBe(true);
    expect(s.reason).toBe('empty-bank');
    const js = s.languages.find((l: { language: string }) => l.language === 'javascript');
    expect(js.banked).toBe(2);
    expect(js.servable).toBe(0);
  });

  it('is scoped to the ACTIVE language — another language’s bank does not count', async () => {
    apikey.store(KEY);
    bankOne({ language: 'python' });
    expect((await state()).reason).toBe('empty-bank'); // active is javascript
    db.setActiveLanguage('python');
    expect((await state()).needed).toBe(false);
  });

  it('never returns the key', async () => {
    apikey.store(KEY);
    const res = await app.request('/api/setup/state');
    const body = await res.text();
    expect(body).not.toContain(KEY);
    expect(JSON.parse(body).apiKey).toEqual({
      configured: true,
      source: 'settings',
      suffix: 'WXYZ',
    });
  });

  it('reports which languages have a harness in this build', async () => {
    const s = await state();
    const supported = s.languages.filter((l: { supported: boolean }) => l.supported);
    const names = supported.map((l: { language: string }) => l.language);
    // Read off the filesystem, so this asserts the shape rather than a list —
    // except that the incumbent must always be there.
    expect(names).toContain('javascript');
    // Java is deliberately unfinished; it must not be offered.
    expect(names).not.toContain('java');
  });
});

// =============================================================================
suite('POST /api/setup/dismiss', () => {
  it('suppresses the empty-bank prompt', async () => {
    apikey.store(KEY);
    expect((await state()).needed).toBe(true);
    const res = await app.request('/api/setup/dismiss', { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).needed).toBe(false);
    expect(db.getSetting(SETUP_DISMISSED_SETTING)).toBe(true);
  });

  it('CANNOT suppress a missing key', async () => {
    await app.request('/api/setup/dismiss', { method: 'POST' });
    const s = await state();
    expect(s.needed).toBe(true);
    expect(s.reason).toBe('no-api-key');
  });
});

// =============================================================================
suite('POST /api/setup/seed — the guards that run before any money is spent', () => {
  async function seed(body: unknown): Promise<Response> {
    return app.request('/api/setup/seed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('refuses to seed without a key', async () => {
    const res = await seed({ language: 'javascript' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/No API key/);
    expect(mocks.generateAndStore).not.toHaveBeenCalled();
  });

  // The same trap as the state gate, one layer down and more expensive: here the
  // user has already chosen a provider and asked for a bank, so refusing lands
  // them in a wizard that offered to do a thing it then won't do.
  it('seeds a keyless local install instead of demanding a key it does not need', async () => {
    mocks.needsAnthropicKey.mockReturnValue(false);
    const res = await seed({ language: 'javascript', perSlot: 1, topics: ['arrays'] });
    expect(res.status).toBe(200);
  });

  it('rejects an unknown language', async () => {
    apikey.store(KEY);
    const res = await seed({ language: 'kotlin' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/language must be one of/);
  });

  it('rejects a language with no harness rather than paying to discover it', async () => {
    apikey.store(KEY);
    const res = await seed({ language: 'java' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no sandbox harness/);
    expect(mocks.generateAndStore).not.toHaveBeenCalled();
  });

  it('caps how much one click may spend', async () => {
    apikey.store(KEY);
    for (const perSlot of [0, -1, 4, 100, 2.5, 'lots']) {
      const res = await seed({ language: 'javascript', perSlot });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/perSlot must be an integer/);
    }
    expect(mocks.generateAndStore).not.toHaveBeenCalled();
  });

  it('rejects a topic list it does not recognise', async () => {
    apikey.store(KEY);
    expect((await seed({ topics: ['arrays', 'wizardry'] })).status).toBe(400);
    expect((await seed({ topics: [] })).status).toBe(400);
    expect((await seed({ difficulties: ['trivial'] })).status).toBe(400);
    expect(mocks.generateAndStore).not.toHaveBeenCalled();
  });
});
