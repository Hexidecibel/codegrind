import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';

// =============================================================================
// Cross-origin policy — same-origin only, and every relaxation is typed out
// =============================================================================
// This used to be `app.use('/*', cors())`, and Hono's default for that is
// `origin: '*'`. Read that with the rest of the app in mind: codegrind has NO
// authentication of its own. The single deployment that has any is the owner's,
// which sits behind a separate gate at the reverse proxy; anybody who clones
// this repo and runs `npm start` gets an unauthenticated API.
//
// THE 127.0.0.1 DEFAULT IS NOT THE CONTROL IT LOOKS LIKE. `HOST` defaulting to
// loopback is a good default and it stops another MACHINE connecting. It does
// not stop a BROWSER: the browser is already on the loopback interface. Any
// page the user has open in another tab — any ad frame inside it — can
// `fetch('http://127.0.0.1:9416/api/...')`, and with `origin: '*'` it could
// also READ the reply. That is:
//
//   GET  /api/settings  → the model routing and the API key's suffix
//   POST /api/problems  → generation, billed to the user's Anthropic key
//   POST /api/submit    → arbitrary code into the sandbox
//
// So the default here allows no cross-origin caller at all, and a request that
// arrives WITH a foreign `Origin` is refused outright rather than merely denied
// its response headers. Omitting `Access-Control-Allow-Origin` only stops the
// page READING the answer — the request still executes, which is enough for the
// two POSTs above. Refusing at the door is what closes that.
//
// Nothing legitimate loses out, because nothing legitimate is cross-origin:
//   * production serves the built SPA from this same server (see index.ts), so
//     the browser's origin IS this origin;
//   * `npm run dev` is same-origin too — vite.config.ts proxies /api to this
//     port instead of letting the client call it directly, so the browser only
//     ever addresses the vite origin. That proxy MUST forward Host untouched
//     for the check below to see it that way, which is why vite.config.ts
//     spells the proxy out as an object with `changeOrigin: false` instead of
//     using the string shorthand: vite normalises the shorthand to
//     `changeOrigin: true`, which rewrites Host to localhost:9416 and leaves
//     Origin as localhost:5173, and every dev POST then reads as cross-origin.
//     cors.test.ts pins that config so the shorthand cannot come back;
//   * curl, the healthcheck and anything else non-browser sends no `Origin` at
//     all, and is untouched.
//
// The escape hatch, for a client genuinely served from somewhere else, is an
// explicit allowlist in CODEGRIND_CORS_ORIGINS. It is empty unless somebody
// sets it, it takes exact origins ("http://localhost:5173"), and it never
// accepts "*" — see readAllowedOrigins.

/** The env var that is the ONLY way to permit a cross-origin caller. */
export const CORS_ORIGINS_ENV = 'CODEGRIND_CORS_ORIGINS';

/**
 * Exact origins from a comma-separated list. Empty when unset — that is the
 * whole point, and it is what the tests pin.
 *
 * A literal `*` is dropped rather than honoured. Wildcarding this is never
 * something a person means on an unauthenticated API; it is something they
 * paste while debugging and then ship, and a silently ignored star is a much
 * cheaper failure than a silently opened one.
 */
export function readAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '' && s !== '*');
}

/** The `host` of an Origin header, or null when it is not a parseable URL. */
function hostOfOrigin(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    // Includes the literal `null` origin a sandboxed iframe or a file:// page
    // sends. Unparseable is not same-origin.
    return null;
  }
}

/**
 * True when `origin` names the same host:port the request was addressed to.
 *
 * HOST, NOT FULL ORIGIN, is deliberate. Behind a TLS-terminating reverse proxy
 * the browser's origin is `https://…` while this server sees a plain HTTP
 * request, so comparing schemes would reject every request on the one
 * deployment that is actually fronted by a proxy.
 */
export function isSameOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  const originHost = hostOfOrigin(origin);
  return originHost !== null && originHost === host;
}

/**
 * The middleware: refuse foreign origins, and speak CORS only for the ones an
 * operator listed by hand.
 */
export function crossOriginPolicy(allowed: readonly string[]): MiddlewareHandler {
  const allowlist = new Set(allowed);

  // Reached only for an allowlisted origin — everything else has already been
  // turned away below, so this never has to decide anything on its own.
  const corsMiddleware = cors({
    origin: (origin) => (allowlist.has(origin) ? origin : null),
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
  });

  return async (c, next) => {
    const origin = c.req.header('origin');
    // No Origin header: not a browser, or a same-origin GET the browser did not
    // bother to label. Either way there is no other origin to refuse.
    if (origin && !allowlist.has(origin) && !isSameOrigin(origin, c.req.header('host'))) {
      return c.json(
        {
          error:
            'Cross-origin requests are refused. codegrind serves its own UI and ' +
            `has no authentication of its own; set ${CORS_ORIGINS_ENV} to an ` +
            'exact origin to allow one deliberately.',
        },
        403
      );
    }
    return corsMiddleware(c, next);
  };
}
