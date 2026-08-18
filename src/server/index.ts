import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import './services/db.js'; // create tables on startup (idempotent)
import { problemsRoutes } from './routes/problems.js';
import { bankRoutes } from './routes/bank.js';
import { submitRoutes } from './routes/submit.js';
import { hintsRoutes } from './routes/hints.js';
import { progressRoutes } from './routes/progress.js';
import { sessionRoutes } from './routes/session.js';
import { primersRoutes } from './routes/primers.js';
import { studyRoutes } from './routes/study.js';
import { reflectRoutes } from './routes/reflect.js';
import { settingsRoutes } from './routes/settings.js';
import { setupRoutes } from './routes/setup.js';
import { providerRoutes } from './routes/providers.js';
import { hydrate as hydrateApiKey } from './services/apikey.service.js';
import { hydrateProviderConfig } from './services/provider.service.js';
import { describeRouting, needsAnthropicKey } from './services/llm.client.js';

// Let the wizard-written `llm.workhorse` / `llm.tutor` rows count towards
// routing. Must precede the first routing question below. The ENVIRONMENT still
// wins field by field, so a deploy that sets CODEGRIND_* or ANTHROPIC_MODEL is
// unaffected by anything anyone stored.
hydrateProviderConfig();

// Publish a wizard-stored API key into the environment before any route can
// need one. Does NOTHING when ANTHROPIC_API_KEY is already set — the deploy's
// key always wins — so an existing systemd + Infisical install is untouched.
// See services/apikey.service.ts for why the key is not, and must not be, in
// .env: bin/inject truncates that file on every deploy and every `cd`.
const bootKey = hydrateApiKey();

const app = new Hono();

app.use('/*', cors());
app.route('/api', problemsRoutes);
app.route('/api', bankRoutes);
app.route('/api', submitRoutes);
app.route('/api', hintsRoutes);
app.route('/api', progressRoutes);
app.route('/api', sessionRoutes);
app.route('/api', primersRoutes);
app.route('/api', studyRoutes);
app.route('/api', reflectRoutes);
app.route('/api', settingsRoutes);
app.route('/api', setupRoutes);
app.route('/api', providerRoutes);

app.get('/api/health', (c) => c.json({ status: 'ok' }));

// Serve the built SPA for everything that isn't an /api route. `precompressed`
// picks up the .br/.gz siblings bin/build writes — Monaco is bundled locally now
// (no CDN), and its editor chunk + TypeScript worker are multi-MB uncompressed.
app.use('/*', serveStatic({ root: './dist', precompressed: true }));

// SPA fallback: any non-API GET that didn't match a real file returns index.html.
app.get('*', (c, next) => {
  if (c.req.path.startsWith('/api')) return next();
  return serveStatic({ root: './dist', path: 'index.html' })(c, next);
});

const port = parseInt(process.env.PORT || '9416');
const host = process.env.HOST || '127.0.0.1';
console.log(`codegrind server running on ${host}:${port}`);
// Which models answer which calls, and where. Never a credential.
console.log(`  models: ${describeRouting()}`);
// The key's SOURCE, never its value — this line goes to the journal. It is only
// a problem when something actually routes to Anthropic: a fully local install
// has no key by design, and reporting that as a fault would be a lie.
console.log(
  !needsAnthropicKey()
    ? '  Anthropic API key: not needed (no call routes to Anthropic)'
    : bootKey.configured
      ? `  Anthropic API key: configured (from ${bootKey.source})`
      : '  Anthropic API key: NOT configured — the setup screen will ask for one'
);
serve({ fetch: app.fetch, port, hostname: host });
