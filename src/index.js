/* ============================================================================
 * FlyDragon AI worker - entry point (Hono on Cloudflare Workers)
 * D1 = data, R2 = files, Workers AI or OpenAI = answers. No mock replies.
 * ==========================================================================*/
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { logger } from 'hono/logger';

import { errorResponses } from './lib/http.js';
import { verifySession } from './lib/sessions.js';
import { currentModel } from './lib/ai.js';
import { imageModel } from './lib/image.js';
import { toolCatalog } from './lib/tools.js';

import auth from './routes/auth.js';
import files from './routes/files.js';
import chat from './routes/chat.js';
import panels from './routes/panels.js';
import settings from './routes/settings.js';

const app = new Hono();

app.use('*', logger());
app.use('*', secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'"],            // existing inline handlers in index.html
    styleSrc: ["'self'", "'unsafe-inline'"],             // existing inline <style>
    imgSrc: ["'self'", 'data:', 'blob:', 'https://*.r2.cloudflarestorage.com', 'https://flytripvisa.site'],
    connectSrc: ["'self'", 'https://api.openai.com'],
    frameAncestors: ["'none'"],
    objectSrc: ["'none'"],
  },
  strictTransportSecurity: ['max-age=31536000', 'includeSubDomains'],
  referrerPolicy: ['no-referrer'],
}));

app.use('/api/*', cors({
  origin: allowedOrigins(),
  credentials: true,
  allowHeaders: ['content-type', 'accept', 'x-confirm'],
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  maxAge: 600,
}));

/**
 * Session resolution happens once per API request. It never throws: an unreadable
 * cookie simply means "anonymous" and each route decides whether that is allowed.
 */
app.use('/api/*', async (c, next) => {
  try {
    const resolved = await verifySession(c);
    if (resolved) {
      c.set('user', resolved.user);
      c.set('session', resolved.session);
    }
  } catch (err) {
    console.warn('[worker] session lookup failed:', err && err.message);
  }
  await next();
});

app.get('/api/health', (c) => c.json({
  ok: true,
  service: 'fly-dragon-ai',
  chat: currentModel(c.env),
  image: imageModel(c.env),
  tools: toolCatalog(),
  storage: { bucket: c.env.R2_BUCKET_NAME || 'fly-dragon-uploads', limit_bytes: Number(c.env.STORAGE_LIMIT_BYTES || 1073741824) },
  time: new Date().toISOString(),
}));

app.route('/api/auth', auth);        // signup, login, logout, me, avatar, forgot/reset, google
app.route('/api', files);            // upload, files, download, text, delete
app.route('/api', chat);             // chat (SSE + json), chats, history, delete
app.route('/api', panels);           // tools, mcp, images, database, storage
app.route('/api', settings);         // settings, prefs, delete account

/* Pages are static from ./public; these routes keep deep links alive after refresh. */
const PAGES = ['index', 'login', 'signup', 'admin', 'dashboard'];
for (const page of PAGES) {
  app.get(page === 'index' ? '/' : `/${page}`, (c) => servePage(c, 'index.html'));
}
app.get('/chat', (c) => servePage(c, 'index.html'));

app.notFound((c) => {
  if ((c.req.header('accept') || '').includes('text/html')) return servePage(c, 'index.html');
  return c.json({ error: 'not_found', message: 'No such endpoint.' }, 404);
});

app.onError(errorResponses);

function servePage(c, name) {
  const assets = c.env.ASSETS;
  if (!assets) return c.text('Static assets are not bound. Add [assets] to wrangler.toml.', 500);
  return assets.fetch(new Request(new URL(`/${name}`, c.req.url), c.req.raw));
}

/**
 * CORS only lets your own origins through. PUBLIC_ORIGIN is the deployment URL;
 * ADDITIONAL_ORIGINS is a comma-separated list for staging/localhost.
 */
function allowedOrigins() {
  return (origin, c) => {
    if (!origin) return null;
    const list = [String(c.env.PUBLIC_ORIGIN || '').replace(/\/$/, ''), ...(c.env.ADDITIONAL_ORIGINS || '').split(',')]
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (!list.length) return origin.includes('localhost') || origin.includes('127.0.0.1') ? origin : null;
    return list.includes(origin) ? origin : null;
  };
}

export default app;
