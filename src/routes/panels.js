/* ============================================================================
 * Panel endpoints: Tool toggles, MCP servers, Images, Database, Storage.
 * Every handler is ownership-scoped; the admin table browser requires role=admin.
 * ==========================================================================*/
import { Hono } from 'hono';
import { clamp, jsonError, nowSec, rateLimit, requireAdmin, requireAuth, uid } from '../lib/http.js';
import { discoverMcp } from '../lib/tools.js';
import { generateImage, cleanPrompt } from '../lib/image.js';
import {
  createServer, enabledMcpServers, listServers, rememberStatus, removeServer, serverWithSecret,
} from '../lib/mcp.js';
import {
  audit, deleteImageRow, findImage, insertImage, listFiles, listImages, orphanFiles, readSettings,
  userFileBytes, userStats, writeSetting, db_first, db_run, TABLES, listPublicTables, tableOverview, readTablePage,
} from '../lib/db.js';
import { removeObject, signedDownloadUrl } from '../lib/store.js';

const panels = new Hono();
panels.use('*', (c, next) => (c.get('user') ? next() : jsonError(c, 401, 'unauthenticated', 'Please log in to continue.')));
panels.use('/admin/*', requireAdmin);

const bucketOf = (c) => c.env.UPLOADS || c.env.R2;
const limitBytesOf = (c) => Number(c.env.STORAGE_LIMIT_BYTES || 1 * 1024 * 1024 * 1024);

/* ================================ TOOLS ================================= */
panels.get('/tools', async (c) => {
  const prefs = await readSettings(c.env.DB, c.get('user').id);
  return c.json({ tools: normaliseToolPrefs(prefs) });
});

panels.post('/tools', async (c) => {
  const body = await readJson(c);
  const changed = {};
  const prefs = await readSettings(c.env.DB, c.get('user').id);
  const current = normaliseToolPrefs(prefs);

  for (const key of Object.keys(TOOL_DEFAULTS)) {
    if (typeof body[key] !== 'boolean') continue;
    current[key] = body[key];
    changed[key] = body[key];
  }
  if (!Object.keys(changed).length) return jsonError(c, 400, 'bad_request', 'Send one of: web_search, flight_search, hotel_search, visa_checker, currency.');

  await writeSetting(c.env.DB, c.get('user').id, 'tools', current);
  await audit(c.env.DB, c.get('user').id, 'tools.toggle', Object.entries(changed).map(([k, v]) => `${k}=${v}`).join(','));
  return c.json({ tools: current });
});

const TOOL_DEFAULTS = { web_search: true, flight_search: true, hotel_search: true, visa_checker: true, currency: true };
const normaliseToolPrefs = (prefs) => ({ ...TOOL_DEFAULTS, ...(prefs.tools && typeof prefs.tools === 'object' ? prefs.tools : {}) });

/* ================================= MCP ================================= */
panels.get('/mcp', async (c) => c.json({ servers: await listServers(c, c.get('user').id) }));

panels.post('/mcp', async (c) => {
  const limited = await rateLimit(c, { limit: 10, windowSec: 300, scope: 'mcp-add', by: c.get('user').id });
  if (limited) return jsonError(c, 429, 'rate_limited', 'Too many servers added at once.');

  const body = await readJson(c);
  const url = String(body.url || '').trim();
  // Real servers must be https; a local dev/tunnel MCP endpoint on loopback is allowed.
  const allowed = /^https:\/\/[^\s]+$/.test(url) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?\/[^\s]*$/.test(url);
  if (!allowed) return jsonError(c, 400, 'bad_url', 'The MCP server URL must be https:// (http is only allowed for localhost).');

  const already = await db_first(c.env.DB, 'SELECT id FROM mcp_servers WHERE user_id = ?1 AND url = ?2', c.get('user').id, url);
  if (already) return jsonError(c, 409, 'duplicate', 'That server is already connected.');

  const created = await createServer(c, { name: body.name, url, apiKey: body.api_key || body.apiKey });
  await audit(c.env.DB, c.get('user').id, 'mcp.add', url);
  const { apiKey, api_key_enc, ...safe } = created;
  return c.json({ server: { ...safe, has_key: Boolean(apiKey) }, servers: await listServers(c, c.get('user').id) }, 201);
});

/* The panel posts { id }; a path link may also carry it. */
const mcpId = (c) => String(c.get('mcpId') || c.req.param('id') || '').slice(0, 64);

panels.post('/mcp/test', async (c) => {
  const body = await readJson(c);
  c.set('mcpId', body.id || '');
  return testConnection(c, mcpId(c));
});
panels.post('/mcp/:id/test', async (c) => testConnection(c, mcpId(c)));

async function testConnection(c, id) {
  const server = await serverWithSecret(c, id);
  if (!server) return jsonError(c, 404, 'not_found', 'That MCP server is not in your account.');

  const limited = await rateLimit(c, { limit: 20, windowSec: 60, scope: 'mcp-test', by: c.get('user').id });
  if (limited) return jsonError(c, 429, 'rate_limited', 'Testing too fast. Wait a moment.');

  const outcome = await discoverMcp({ url: server.url, apiKey: server.apiKey });
  const tools = outcome.tools || [];
  const status = outcome.ok && tools.length ? 'connected' : outcome.ok ? 'connected' : 'failed';

  await rememberStatus(c, server.id, status, outcome.error || null);
  await writeSetting(c.env.DB, c.get('user').id, 'mcp_tools', { server: server.name, tools: tools.map((tool) => tool.name) });

  const message = status === 'failed'
    ? outcome.error || 'The MCP server could not be reached.'
    : `Connected. ${tools.length} tool${tools.length === 1 ? '' : 's'} available${outcome.serverName ? ` from ${outcome.serverName}` : ''}.`;

  await audit(c.env.DB, c.get('user').id, 'mcp.test', `${server.name}: ${status}`);
  return c.json({ status, error: outcome.error || null, tools, message, server: { id: server.id, name: server.name, url: server.url, status } });
}

panels.delete('/mcp/:id', async (c) => {
  const server = await serverWithSecret(c, mcpId(c));
  if (!server) return jsonError(c, 404, 'not_found', 'That MCP server is not in your account.');
  await removeServer(c, server.id);
  await audit(c.env.DB, c.get('user').id, 'mcp.remove', server.name);
  return c.json({ ok: true, servers: await listServers(c, c.get('user').id) });
});

/* ================================ IMAGES =============================== */
panels.get('/images', async (c) => {
  const rows = await listImages(c.env.DB, c.get('user').id);
  return c.json({
    images: rows.map(toImageDto),
    items: rows.map(toImageDto),
    total: rows.length,
  });
});

/**
 * §6C. The image lands in R2 + D1 and is echoed straight back into the chat,
 * so the visitor sees it in both places.
 */
panels.post('/images/generate', async (c) => {
  const user = c.get('user');
  if (!c.env.AI && !c.env.OPENAI_API_KEY) {
    return jsonError(c, 503, 'model_unconfigured', 'No image model is bound. Enable Workers AI or set OPENAI_API_KEY.');
  }
  const limited = await rateLimit(c, { limit: Number(c.env.IMAGE_RATE_LIMIT || 8), windowSec: 300, scope: 'image', by: c.get('user').id });
  if (limited) return jsonError(c, 429, 'rate_limited', 'Image generation is limited to a few per few minutes.');

  const body = await readJson(c);
  const prompt = cleanPrompt(body.prompt || body.text);
  if (!prompt) return jsonError(c, 400, 'empty_prompt', 'Describe the image you want.');

  const generated = await generateImage({
    env: c.env, userId: user.id, prompt, size: body.size, signal: c.req.raw.signal,
  });
  await insertImage(c.env.DB, {
    id: generated.id, user_id: user.id, chat_id: body.chatId || null,
    prompt: generated.prompt, r2_key: generated.r2_key, url: generated.url,
    size: generated.size, created_at: nowSec(),
  });
  await audit(c.env.DB, user.id, 'image.generate', `${generated.provider}:${generated.model}`);

  return c.json({
    image: { ...generated, filename: `${generated.id}.png`, mime: 'image/png' },
    images: (await listImages(c.env.DB, user.id)).map(toImageDto),
    reply: `I made an image for: ${generated.prompt}`,
  }, 201);
});

panels.get('/images/:id/download', async (c) => {
  const row = await findImage(c.env.DB, c.req.param('id'), c.get('user').id);
  if (!row) return jsonError(c, 404, 'not_found', 'That image is not in your account.');
  const bucket = bucketOf(c);
  const signed = await signedDownloadUrl(c.env, row.r2_key, { expiresIn: 120, filename: `${row.id}.png` });
  if (signed) return c.redirect(signed, 302);
  const object = await bucket.get(row.r2_key);
  if (!object) return jsonError(c, 410, 'gone', 'The image object is missing.');
  return new Response(object.body, { headers: { 'content-type': 'image/png', 'content-disposition': 'inline', 'cache-control': 'private, no-store' } });
});

panels.delete('/images/:id', async (c) => {
  const row = await findImage(c.env.DB, c.req.param('id'), c.get('user').id);
  if (!row) return jsonError(c, 404, 'not_found', 'That image is not in your account.');
  await deleteImageRow(c.env.DB, row.id, c.get('user').id);
  const bucket = bucketOf(c);
  if (bucket) await removeObject(bucket, row.r2_key);
  await audit(c.env.DB, c.get('user').id, 'image.delete', row.id);
  return c.json({ ok: true });
});

/* =============================== DATABASE ============================== */
panels.get('/tables', async (c) => c.json({ tables: await tableOverview(c.env.DB) }));

panels.get('/stats', async (c) => {
  const stats = await userStats(c.env.DB, c.get('user').id);
  return c.json({ ...stats, storage_bytes: stats.storage_bytes, limit_bytes: limitBytesOf(c) });
});

panels.get('/admin/tables', async (c) => c.json({ tables: await listPublicTables(c.env.DB) }));

panels.get('/admin/tables/:table', async (c) => {
  const name = String(c.req.param('table') || '').replace(/[^a-z_]/gi, '');
  if (!TABLES[name]) return jsonError(c, 404, 'unknown_table', 'That table is not exposed to the admin view.');
  const page = await readTablePage(c.env.DB, name, {
    limit: clamp(c.req.query('limit') || 25, 1, 100),
    offset: clamp(c.req.query('offset') || 0, 0, 100000),
  });
  if (!page) return jsonError(c, 404, 'unknown_table', 'That table is not exposed to the admin view.');
  return c.json({ table: name, columns: page.columns, rows: page.rows, total: page.total });
});

/* ============================ R2 STORAGE ============================== */
panels.get('/storage', async (c) => {
  const userId = c.get('user').id;
  const usage = await userFileBytes(c.env.DB, userId);
  const rows = await listFiles(c.env.DB, userId);
  const orphans = await orphanFiles(c.env.DB, userId);

  const items = rows.map((file) => ({
    id: file.id,
    key: file.url,                                   // never the raw r2_key
    filename: file.filename,
    size: file.size,
    file_type: file.file_type,
    url: file.url,
    chat_title: file.chat_title || null,
    created_at: file.created_at,
    orphan: !file.chat_id,
  }));

  return c.json({
    used_bytes: Number(usage?.bytes || 0),
    limit_bytes: limitBytesOf(c),
    object_count: items.length,
    orphan_count: orphans.length,
    items,
    buckets: [{ name: c.env.R2_BUCKET_NAME || 'fly-dragon-uploads', objects: items.length, bytes: Number(usage?.bytes || 0) }],
  });
});

/** Removes files and images that are linked to no chat and older than 5 minutes. */
panels.post('/storage/cleanup', async (c) => {
  const userId = c.get('user').id;
  const limited = await rateLimit(c, { limit: 5, windowSec: 120, scope: 'cleanup', by: c.get('user').id });
  if (limited) return jsonError(c, 429, 'rate_limited', 'Cleanup is running too often.');

  const bucket = bucketOf(c);
  if (!bucket) return jsonError(c, 500, 'storage_unbound', 'The uploads bucket is not bound to this worker.');

  const orphans = await orphanFiles(c.env.DB, userId);
  const fresh = Math.floor(Date.now() / 1000) - 300;
  let removed = 0;
  const failed = [];

  for (const file of orphans) {
    if (Number(file.created_at) > fresh) continue;                     // still in flight from the composer
    try {
      await removeObject(bucket, file.r2_key);
      await db_run(c.env.DB, 'DELETE FROM files WHERE id = ?1 AND user_id = ?2', file.id, userId);
      removed += 1;
    } catch (err) {
      failed.push({ id: file.id, filename: file.filename, reason: err && err.message });
    }
  }

  await audit(c.env.DB, userId, 'storage.cleanup', `${removed} removed, ${failed.length} failed`);
  return c.json({ removed, failed, bytes_freed: orphans.filter((f) => Number(f.created_at) <= fresh).reduce((sum, f) => sum + Number(f.size || 0), 0) });
});

/* ================================ HELPERS ============================== */
function toImageDto(row) {
  return {
    id: row.id,
    prompt: row.prompt,
    url: `/api/images/${row.id}/download`,
    filename: `${row.id}.png`,
    mime: 'image/png',
    size: Number(row.size || 0),
    chat_title: row.chat_title || null,
    created_at: Number(row.created_at),
  };
}

async function readJson(c) {
  try { return await c.req.json(); } catch (err) { return {}; }
}

export default panels;
