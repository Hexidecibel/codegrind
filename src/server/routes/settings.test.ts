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

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'codegrind-settings-test-'));
if (!TEST_DATA_DIR.startsWith(tmpdir())) {
  throw new Error(`refusing to run: test DATA_DIR ${TEST_DATA_DIR} is not under ${tmpdir()}`);
}
process.env.DATA_DIR = TEST_DATA_DIR;

const { settingsRoutes } = await import('./settings.js');
const db = await import('../services/db.js');

const app = new Hono();
app.route('/api', settingsRoutes);

async function put(body: unknown): Promise<Response> {
  return app.request('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  db.db.exec(`DELETE FROM settings`);
});

afterAll(() => {
  db.db.close();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('GET /api/settings', () => {
  it('reports the default language on a fresh install', async () => {
    const res = await app.request('/api/settings');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ language: 'javascript' });
  });

  it('reports whatever was last written', async () => {
    db.setActiveLanguage('python');
    const res = await app.request('/api/settings');
    expect(await res.json()).toEqual({ language: 'python' });
  });
});

describe('PUT /api/settings', () => {
  it('sets the language and echoes the new state', async () => {
    const res = await put({ language: 'python' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ language: 'python' });
    // And it is really persisted, not just reflected back.
    expect(db.getActiveLanguage()).toBe('python');
  });

  it('round-trips back to javascript', async () => {
    await put({ language: 'java' });
    const res = await put({ language: 'javascript' });
    expect(await res.json()).toEqual({ language: 'javascript' });
    expect(db.getActiveLanguage()).toBe('javascript');
  });

  it('rejects a language this build does not support', async () => {
    const res = await put({ language: 'kotlin' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('language must be one of');
    expect(db.getActiveLanguage()).toBe('javascript');
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
    const res = await put({ language: 'java', favouriteColour: 'blue' });
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
