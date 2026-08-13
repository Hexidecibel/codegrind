import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import './services/db.js'; // create tables on startup (idempotent)
import { problemsRoutes } from './routes/problems.js';
import { submitRoutes } from './routes/submit.js';
import { hintsRoutes } from './routes/hints.js';
import { progressRoutes } from './routes/progress.js';
import { sessionRoutes } from './routes/session.js';
import { primersRoutes } from './routes/primers.js';
import { studyRoutes } from './routes/study.js';
import { reflectRoutes } from './routes/reflect.js';
import { settingsRoutes } from './routes/settings.js';

const app = new Hono();

app.use('/*', cors());
app.route('/api', problemsRoutes);
app.route('/api', submitRoutes);
app.route('/api', hintsRoutes);
app.route('/api', progressRoutes);
app.route('/api', sessionRoutes);
app.route('/api', primersRoutes);
app.route('/api', studyRoutes);
app.route('/api', reflectRoutes);
app.route('/api', settingsRoutes);

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
serve({ fetch: app.fetch, port, hostname: host });
