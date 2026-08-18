// =============================================================================
// cors — the only thing standing between an unauthenticated API and any tab
// =============================================================================
// The regression these cases exist for is a one-word one: `app.use('/*',
// cors())`, whose Hono default is `origin: '*'`. Paired with an app that has no
// authentication of its own, that let any page the user had open read
// /api/settings, spend their Anthropic key via /api/problems, and push code
// into the sandbox via /api/submit — from a server bound to 127.0.0.1, because
// the browser doing it was already on 127.0.0.1.
//
// So each case below is a claim about a REQUEST, exercised through a real Hono
// app via `app.request()` rather than by inspecting the options object: what
// matters is what the middleware does to a request that arrives, not how it was
// configured to do it.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { crossOriginPolicy, readAllowedOrigins, isSameOrigin, CORS_ORIGINS_ENV } from './cors.js';

/** A stand-in for the real API surface: one GET to read, one POST to spend. */
function appWith(allowed: string[]): Hono {
  const app = new Hono();
  app.use('/*', crossOriginPolicy(allowed));
  app.get('/api/settings', (c) => c.json({ keySuffix: '…abcd' }));
  app.post('/api/problems', (c) => c.json({ generated: true }));
  return app;
}

/** `app.request()` sends no Host header of its own; the URL's host is what counts. */
const SELF = 'http://127.0.0.1:9416';

describe('the default: no cross-origin caller at all', () => {
  const app = appWith([]);

  it('refuses a GET carrying a foreign Origin with 403, not just a missing header', async () => {
    // The distinction is the whole point. Withholding
    // Access-Control-Allow-Origin only stops the page READING the reply — the
    // handler still ran. For POST /api/problems that is already the damage.
    const res = await app.request(`${SELF}/api/settings`, {
      headers: { origin: 'https://evil.example', host: '127.0.0.1:9416' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses a cross-origin POST — the one that spends the API key', async () => {
    const res = await app.request(`${SELF}/api/problems`, {
      method: 'POST',
      headers: { origin: 'http://localhost:5173', host: '127.0.0.1:9416' },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(CORS_ORIGINS_ENV);
  });

  it('refuses the preflight too, so the browser never gets as far as the real call', async () => {
    const res = await app.request(`${SELF}/api/problems`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://evil.example',
        host: '127.0.0.1:9416',
        'access-control-request-method': 'POST',
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses the literal `null` origin a sandboxed iframe or file:// page sends', async () => {
    const res = await app.request(`${SELF}/api/settings`, {
      headers: { origin: 'null', host: '127.0.0.1:9416' },
    });
    expect(res.status).toBe(403);
  });

  it('is not fooled by an origin whose host merely CONTAINS ours', async () => {
    const res = await app.request(`${SELF}/api/settings`, {
      headers: { origin: 'http://127.0.0.1:9416.evil.example', host: '127.0.0.1:9416' },
    });
    expect(res.status).toBe(403);
  });

  it('serves a same-origin request', async () => {
    // Production: the SPA is served by this same server, so the browser's
    // origin IS this origin. No ACAO header is needed or expected — a browser
    // only consults CORS for CROSS-origin reads.
    const res = await app.request(`${SELF}/api/settings`, {
      headers: { origin: SELF, host: '127.0.0.1:9416' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ keySuffix: '…abcd' });
  });

  it('serves a same-origin request whose scheme differs, because a TLS proxy terminated it', async () => {
    // The owner's deploy is fronted by a reverse proxy: the browser's origin is
    // https://…, this server sees plain HTTP. Comparing schemes would 403 the
    // only deployment that actually has a proxy in front of it.
    const res = await app.request('http://grind.example/api/settings', {
      headers: { origin: 'https://grind.example', host: 'grind.example' },
    });
    expect(res.status).toBe(200);
  });

  it('serves a request with no Origin at all — curl, healthchecks, non-browsers', async () => {
    const res = await app.request(`${SELF}/api/settings`, { headers: { host: '127.0.0.1:9416' } });
    expect(res.status).toBe(200);
  });
});

describe('the dev affordance is off unless someone typed it out', () => {
  it('reads an empty allowlist when the env var is unset or blank', () => {
    expect(readAllowedOrigins(undefined)).toEqual([]);
    expect(readAllowedOrigins('')).toEqual([]);
    expect(readAllowedOrigins('  ,  ,')).toEqual([]);
  });

  it('drops a literal `*` rather than honouring it', () => {
    // A star on an unauthenticated API is never something a person means; it is
    // something they paste while debugging and then ship. A silently ignored
    // star is a far cheaper failure than a silently opened one.
    expect(readAllowedOrigins('*')).toEqual([]);
    expect(readAllowedOrigins('http://localhost:5173, *')).toEqual(['http://localhost:5173']);
  });

  it('takes exact origins, trimmed', () => {
    expect(readAllowedOrigins(' http://localhost:5173 , http://localhost:4173 ')).toEqual([
      'http://localhost:5173',
      'http://localhost:4173',
    ]);
  });

  it('serves an allowlisted origin, with the header that lets it read the reply', async () => {
    const app = appWith(['http://localhost:5173']);
    const res = await app.request(`${SELF}/api/settings`, {
      headers: { origin: 'http://localhost:5173', host: '127.0.0.1:9416' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('answers an allowlisted preflight', async () => {
    const app = appWith(['http://localhost:5173']);
    const res = await app.request(`${SELF}/api/problems`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        host: '127.0.0.1:9416',
        'access-control-request-method': 'POST',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('still refuses everything the allowlist did not name', async () => {
    const app = appWith(['http://localhost:5173']);
    const res = await app.request(`${SELF}/api/settings`, {
      headers: { origin: 'http://localhost:5174', host: '127.0.0.1:9416' },
    });
    expect(res.status).toBe(403);
  });
});

describe('isSameOrigin compares host, and only host', () => {
  it.each([
    ['http://127.0.0.1:9416', '127.0.0.1:9416', true],
    ['https://grind.example', 'grind.example', true],
    ['http://127.0.0.1:9416', '127.0.0.1:5173', false],
    ['http://localhost:9416', '127.0.0.1:9416', false],
    ['not a url', '127.0.0.1:9416', false],
    ['null', '127.0.0.1:9416', false],
  ])('%s vs Host %s → %s', (origin, host, expected) => {
    expect(isSameOrigin(origin, host)).toBe(expected);
  });

  it('is false when there is no Host header to compare against', () => {
    expect(isSameOrigin('http://127.0.0.1:9416', undefined)).toBe(false);
  });
});

describe('the dev server stays same-origin, which is a fact about vite.config.ts', () => {
  const CONFIG = readFileSync(
    fileURLToPath(new URL('../../vite.config.ts', import.meta.url)),
    'utf8'
  );

  it('spells the /api proxy out with changeOrigin: false', () => {
    // Not style. `proxy: { '/api': 'http://localhost:9416' }` — the shorthand
    // any reader would reach for — is normalised by vite to
    // `changeOrigin: true`, which rewrites the Host header to the proxy TARGET
    // while the browser's Origin stays the dev server. isSameOrigin compares
    // exactly those two, so the shorthand turns every dev POST into a 403 and
    // the symptom (the app works, submitting does not) points nowhere near
    // here. Verified against vite's own proxyMiddleware, not assumed.
    expect(CONFIG).toMatch(/'\/api':\s*\{[^}]*changeOrigin:\s*false/);
  });

  it('does not use the string shorthand for it', () => {
    expect(CONFIG).not.toMatch(/'\/api':\s*'http/);
  });
});
