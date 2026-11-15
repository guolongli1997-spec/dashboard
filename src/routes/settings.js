/* ============================================================================
 * Settings + account. Panels read these; nothing here deletes data quietly.
 *   GET    /api/settings             all preferences for the signed-in user
 *   POST   /api/settings             patch {font_size, language, voice_lang, auto_send_voice}
 *   GET    /api/prefs               merged prefs (server wins, localStorage fills gaps)
 *   POST   /api/prefs               one key upsert
 *   DELETE /api/account             permanent self-deletion, typed confirmation required
 * ==========================================================================*/
import { Hono } from 'hono';
import { jsonError, requireAuth } from '../lib/http.js';
import { readSettings, writeSetting, deleteAccount, audit } from '../lib/db.js';
import { removeObject } from '../lib/store.js';
import { destroySession } from '../lib/sessions.js';

const settings = new Hono();
settings.use('*', requireAuth);

const KEYS = ['font_size', 'language', 'voice_lang', 'auto_send_voice', 'tools', 'mcp_tools', 'theme_lock'];
const DEFAULTS = { font_size: 'medium', language: 'en', voice_lang: 'en-US', auto_send_voice: 0 };

/* -------------------------------- settings ------------------------------- */
settings.get('/settings', async (c) => {
  const stored = await readSettings(c.env.DB, c.get('user').id);
  return c.json({ settings: { ...DEFAULTS, ...pick(stored, KEYS) }, defaults: DEFAULTS });
});

settings.post('/settings', async (c) => {
  const body = await readJson(c);
  const changed = {};

  for (const [key, value] of Object.entries(body)) {
    if (!KEYS.includes(key)) continue;
    const valid = validateSetting(key, value);
    if (!valid.ok) return jsonError(c, 400, 'bad_value', valid.message);
    await writeSetting(c.env.DB, c.get('user').id, key, valid.value);
    changed[key] = valid.value;
  }

  if (!Object.keys(changed).length) return jsonError(c, 400, 'bad_request', `Allowed keys: ${KEYS.join(', ')}.`);
  await audit(c.env.DB, c.get('user').id, 'settings.update', Object.keys(changed).join(','));
  return c.json({ ok: true, changed, settings: { ...DEFAULTS, ...changed } });
});

/* -------------------------- merged prefs for boot ------------------------ */
settings.get('/prefs', async (c) => {
  const stored = await readSettings(c.env.DB, c.get('user').id);
  return c.json({ prefs: { ...DEFAULTS, ...pick(stored, KEYS) } });
});

settings.post('/prefs', async (c) => {
  const body = await readJson(c);
  const key = String(body.key || '');
  if (!KEYS.includes(key)) return jsonError(c, 400, 'bad_key', 'That preference is unknown.');
  const valid = validateSetting(key, body.value);
  if (!valid.ok) return jsonError(c, 400, 'bad_value', valid.message);
  await writeSetting(c.env.DB, c.get('user').id, key, valid.value);
  return c.json({ ok: true, key, value: valid.value });
});

/* ---------------------------- delete account ----------------------------- */
settings.delete('/account', async (c) => {
  const user = c.get('user');
  const body = await readJson(c);
  if (String(body.confirm || '').toUpperCase() !== 'DELETE') {
    return jsonError(c, 400, 'confirmation_required', 'Type DELETE to confirm. This removes your chats, messages, files and images.');
  }

  const bucket = c.env.UPLOADS || c.env.R2;
  const rows = await Promise.all([
    c.env.DB.prepare('SELECT id, r2_key FROM files WHERE user_id = ?1').bind(user.id).all(),
    c.env.DB.prepare('SELECT id, r2_key FROM images WHERE user_id = ?1').bind(user.id).all(),
    c.env.DB.prepare('SELECT id, avatar_url FROM users WHERE id = ?1').bind(user.id).first(),
  ]);

  const keys = [...(rows[0]?.results || []), ...(rows[1]?.results || [])].map((row) => row.r2_key).filter(Boolean);
  if (bucket) {
    for (const key of keys) {
      try { await removeObject(bucket, key); } catch (err) { console.warn('[settings] R2 delete skipped:', key, err && err.message); }
    }
  }

  await deleteAccount(c.env.DB, user.id);
  await destroySession(c);
  console.info(`[settings] account deleted`, { user_id: user.id, objects_purged: keys.length });
  return c.json({ ok: true, objects_purged: keys.length });
});

/* -------------------------------- helpers -------------------------------- */
function pick(source, keys) {
  const out = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function validateSetting(key, value) {
  switch (key) {
    case 'font_size':
      return ['small', 'medium', 'large'].includes(value) ? { ok: true, value } : { ok: false, message: 'font_size must be small, medium or large.' };
    case 'language':
      return ['en', 'bn'].includes(value) ? { ok: true, value } : { ok: false, message: 'language must be en or bn.' };
    case 'voice_lang':
      return /^[a-z]{2}(-[A-Za-z]{2,4})?$/i.test(String(value || '')) ? { ok: true, value: String(value).slice(0, 12) } : { ok: false, message: 'voice_lang looks wrong (e.g. en-US, bn-BD).' };
    case 'auto_send_voice':
      return { ok: true, value: value ? 1 : 0 };
    case 'tools':
    case 'mcp_tools':
    case 'theme_lock':
      return { ok: true, value };
    default:
      return { ok: false, message: 'Unknown preference.' };
  }
}

async function readJson(c) {
  try { return await c.req.json(); } catch (err) { return {}; }
}

export default settings;
