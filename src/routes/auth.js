/* ============================================================================
 * Authentication. Cloudflare D1 users, bcrypt hashes, HttpOnly cookie session
 * with a JWT payload. A visitor cannot read or send a message before this
 * resolves - the gate lives in chat.js and requireAuth here.
 * ==========================================================================*/
import { Hono } from 'hono';
import { uid, nowSec, jsonError, rateLimit, EMAIL_RE } from '../lib/http.js';
import { hashPassword, verifyPassword, passwordProblem } from '../lib/passwd.js';
import { createSession, destroySession, COOKIE, parseCookie } from '../lib/sessions.js';
import { randomToken, tokenHash } from '../lib/crypto.js';
import { downloadPath } from '../lib/store.js';
import { sign_jwt, verify_jwt } from '../lib/jwt.js';
import {
  findUserByEmail, insertUser, findUserById, upgradeLegacyPassword, updateProfile,
  insertReset, findReset, consumeReset, db_first, db_run, audit,
} from '../lib/db.js';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';
const RESET_TTL = 60 * 30;

const publicUser = (row) => ({
  id: row.id,
  name: row.name || null,
  email: row.email,
  avatar_url: row.avatar_url || null,
  provider: row.provider || 'password',
  is_admin: Number(row.role === 'admin' || row.is_admin ? 1 : 0),
  created_at: Number(row.created_at),
});

const auth = new Hono();

/* --------------------------------- signup -------------------------------- */
auth.post('/signup', async (c) => {
  const body = await readBody(c);
  const email = String(body.email || '').trim().toLowerCase();

  const gated = await throttle(c, {
    limit: Number(c.env.SIGNUP_RATE_LIMIT || 6), windowSec: 300, scope: 'signup', by: email,
  });
  if (gated) return gated;
  const name = String(body.name || '').trim().slice(0, 80);
  const password = String(body.password || '');

  if (!EMAIL_RE.test(email)) return jsonError(c, 400, 'invalid_email', 'Enter a valid email address.');
  const problem = passwordProblem(password);
  if (problem) return jsonError(c, 400, 'weak_password', problem);
  // Accounts on the company's own domain are created by an admin, not by the public form.
  if (email.endsWith('@flytripvisa.site')) {
    return jsonError(c, 400, 'invalid_email', 'Use your personal email address to sign up.');
  }

  const existing = await findUserByEmail(c.env.DB, email);
  if (existing) return jsonError(c, 409, 'email_taken', 'That email is already registered. Try logging in.');

  // Bootstrap: the very first account is the workspace admin (see §6D admin panel).
  const count = await db_first(c.env.DB, 'SELECT COUNT(*) AS n FROM users');
  const isFirstAccount = !count || Number(count.n) === 0;

  const { hash } = await hashPassword(password);
  const user = {
    id: uid('usr'),
    email,
    password_hash: hash,
    name: name || email.split('@')[0],
    avatar_url: null,
    provider: 'password',
    role: isFirstAccount ? 'admin' : 'user',
    created_at: nowSec(),
    hash_alg: 'bcrypt',
  };

  try {
    await insertUser(c.env.DB, user);
  } catch (err) {
    if (isUnique(err)) return jsonError(c, 409, 'email_taken', 'That email is already registered. Try logging in.');
    console.error('[auth] signup insert failed:', err && err.message);
    return jsonError(c, 500, 'server_error', 'Could not create the account.');
  }

  await createSession(c, user);
  await audit(c.env.DB, user.id, 'auth.signup', email);
  return c.json({ user: publicUser(user) }, 201);
});

/* ---------------------------------- login -------------------------------- */
auth.post('/login', async (c) => {
  const body = await readBody(c);
  const email = String(body.email || '').trim().toLowerCase();

  const gated = await throttle(c, {
    limit: Number(c.env.LOGIN_RATE_LIMIT || 10), windowSec: 60, scope: 'login', by: email,
  });
  if (gated) return gated;
  const password = String(body.password || '');
  if (!EMAIL_RE.test(email) || !password) return jsonError(c, 401, 'bad_credentials', 'Incorrect email or password.');

  const row = await findUserByEmail(c.env.DB, email);
  // Same wording and status whether or not the account exists: no enumeration.
  if (!row) {
    // Burn the same CPU as a real check so response timing does not reveal the account list.
    await hashPassword(password).catch(() => {});
    return jsonError(c, 401, 'bad_credentials', 'Incorrect email or password.');
  }
  if (!row.password_hash) {
    return jsonError(c, 403, 'provider_account', 'This account uses Google sign-in. Continue with Google instead.');
  }

  const ok = await verifyPassword(password, row.password_hash, row.salt, row.hash_alg);
  if (!ok) return jsonError(c, 401, 'bad_credentials', 'Incorrect email or password.');

  if (row.hash_alg !== 'bcrypt') {
    const fresh = await hashPassword(password);
    await upgradeLegacyPassword(c.env.DB, row.id, fresh.hash, 'bcrypt');
  }

  await createSession(c, row);
  await audit(c.env.DB, row.id, 'auth.login', 'password');
  return c.json({ user: publicUser(row) });
});

/* --------------------------------- logout -------------------------------- */
auth.post('/logout', async (c) => {
  await destroySession(c);
  const user = c.get('user');
  if (user) await audit(c.env.DB, user.id, 'auth.logout', null);
  return c.json({ ok: true });
});

auth.get('/logout', async (c) => c.redirect('/', 302));   // plain link fallback

/* ----------------------------------- me ---------------------------------- */
auth.get('/me', async (c) => {
  const user = c.get('user');
  if (!user) return jsonError(c, 401, 'unauthenticated', 'Not signed in.');
  return c.json({
    user: {
      ...publicUser(user),
      role: user.role || 'user',
      mustChangePassword: String(user.hash_alg || 'bcrypt') !== 'bcrypt',
      tools_enabled: true,
      storage_limit_bytes: Number(c.env.STORAGE_LIMIT_BYTES || 1073741824),
      csrf_token: c.env.JWT_SECRET ? await csrfToken(user.id, c.env.JWT_SECRET) : null,
    },
  });
});

/* ---------------------------- forgot password ---------------------------- */
auth.post('/forgot-password', async (c) => {
  const body = await readBody(c);
  const email = String(body.email || '').trim().toLowerCase();

  const gated = await throttle(c, {
    limit: Number(c.env.FORGOT_RATE_LIMIT || 4), windowSec: 600, scope: 'forgot', by: email,
  });
  if (gated) return gated;
  const row = EMAIL_RE.test(email) ? await findUserByEmail(c.env.DB, email) : null;

  // Always the same response: the form must not reveal whether the address exists.
  if (!row || !row.password_hash) return c.json({ ok: true });

  const token = randomToken(32);
  await insertReset(c.env.DB, {
    token_hash: await tokenHash(token),
    user_id: row.id,
    created_at: nowSec(),
    expires_at: nowSec() + RESET_TTL,
  });

  const link = `${originFor(c)}/reset-password?token=${encodeURIComponent(token)}`;
  const mailer = await sendResetEmail(c, row, link).catch((err) => {
    console.error('[auth] reset mail failed:', err && err.message);
    return false;
  });
  await audit(c.env.DB, row.id, 'auth.forgot', mailer ? 'sent' : 'not_configured');
  return c.json({ ok: true });
});

auth.post('/reset-password', async (c) => {
  const gated = await throttle(c, { limit: 8, windowSec: 600, scope: 'reset' });
  if (gated) return gated;

  const body = await readBody(c);
  const token = String(body.token || '');
  const password = String(body.password || '');
  if (!token) return jsonError(c, 400, 'bad_request', 'This reset link is not valid.');
  const problem = passwordProblem(password);
  if (problem) return jsonError(c, 400, 'weak_password', problem);

  const record = await findReset(c.env.DB, await tokenHash(token));
  if (!record || record.used_at || Number(record.expires_at) < nowSec()) {
    return jsonError(c, 400, 'expired', 'This reset link has expired. Request a new one.');
  }

  const user = await findUserById(c.env.DB, record.user_id);
  if (!user) return jsonError(c, 400, 'expired', 'This reset link is no longer valid.');

  const { hash } = await hashPassword(password);
  await db_run(c.env.DB, 'UPDATE users SET password_hash = ?2, hash_alg = ?3, salt = NULL WHERE id = ?1', user.id, hash, 'bcrypt');
  await consumeReset(c.env.DB, record.token_hash, nowSec());
  // One strong credential change invalidates every other device.
  await db_run(c.env.DB, 'DELETE FROM sessions WHERE user_id = ?1', user.id);

  await createSession(c, user);
  await audit(c.env.DB, user.id, 'auth.reset', 'password changed');
  return c.json({ ok: true, user: publicUser(user) });
});

/* --------------------------------- google -------------------------------- */
auth.get('/google', async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID) {
    return jsonError(c, 503, 'google_not_configured', 'Google sign-in is not set up yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
  }
  const state = randomToken(16);
  const next = safeNext(c.req.query('next'));
  const jwt = await sign_jwt({ purpose: 'oauth_state', state, next }, c.env.JWT_SECRET, 600);

  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${originFor(c)}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account consent',
    include_granted_scopes: 'true',
    state: jwt,
  });

  c.header('set-cookie', `${COOKIE}_oauth=${jwt}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  return c.redirect(`${GOOGLE_AUTH}?${params}`, 302);
});

auth.get('/google/callback', async (c) => {
  const errorParam = c.req.query('error');
  const code = c.req.query('code');
  const stateToken = c.req.query('state') || parseCookie(c.req.header('cookie'))[`${COOKIE}_oauth`];

  // Chat lives at /, so every entry message lands there as ?error= / ?auth=.
  if (errorParam) return failToLogin(c, describeProviderError(errorParam));
  if (!code || !stateToken || !c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return failToLogin(c, 'Google sign-in is not configured yet.');
  }

  const claims = await verify_jwt(stateToken, c.env.JWT_SECRET);
  if (!claims || claims.purpose !== 'oauth_state') return failToLogin(c, 'That sign-in attempt expired. Please try again.');

  let profile;
  try {
    const tokens = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: c.env.GOOGLE_CLIENT_ID,
        client_secret: c.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${originFor(c)}/api/auth/google/callback`,
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!tokens.ok) throw new Error(`token exchange ${tokens.status}`);
    const token = await tokens.json();
    const me = await fetch(GOOGLE_USERINFO, { headers: { authorization: `Bearer ${token.access_token}` } });
    if (!me.ok) throw new Error(`userinfo ${me.status}`);
    profile = await me.json();
  } catch (err) {
    console.error('[auth] google callback failed:', err && err.message);
    return failToLogin(c, 'Google sign-in failed. Please try again.');
  }

  const email = String(profile.email || '').trim().toLowerCase();
  if (!email || profile.email_verified === false) {
    return failToLogin(c, 'Google did not return a verified email address.');
  }

  const name = String(profile.name || profile.given_name || email.split('@')[0]).slice(0, 80);
  const avatar = String(profile.picture || '').slice(0, 500) || null;

  let user = await findUserByEmail(c.env.DB, email);
  if (!user) {
    user = {
      id: uid('usr'), email, password_hash: null, name, avatar_url: avatar,
      provider: 'google', role: 'user', created_at: nowSec(), hash_alg: null,
    };
    try {
      await insertUser(c.env.DB, user);
    } catch (err) {
      if (!isUnique(err)) throw err;                        // race: the row already exists, use it below
      user = await findUserByEmail(c.env.DB, email);
    }
  } else {
    const fields = {};
    if (!user.name && name) fields.name = name;
    if (!user.avatar_url && avatar) fields.avatar_url = avatar;
    if (Object.keys(fields).length) {
      await updateProfile(c.env.DB, user.id, fields);
      user = { ...user, ...fields };
    }
  }

  await createSession(c, user);
  await audit(c.env.DB, user.id, 'auth.google', email);
  c.header('set-cookie', `${COOKIE}_oauth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  const target = new URL(safeNext(claims.next), originFor(c));
  target.searchParams.set('auth', 'google');
  return c.redirect(`${target.pathname}${target.search}`, 302);
});

/* -------------------------- avatar upload (R2) -------------------------- */
auth.post('/avatar', async (c) => {
  const user = c.get('user');
  if (!user) return jsonError(c, 401, 'unauthenticated', 'Please log in first.');

  const form = await c.req.formData().catch(() => null);
  const file = form && form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function') return jsonError(c, 400, 'no_file', 'Choose an image file.');
  if (file.size > 2 * 1024 * 1024) return jsonError(c, 413, 'too_large', 'Avatars must be 2MB or smaller.');
  if (!/^image\/(png|jpeg|webp|gif)$/.test(String(file.type || ''))) return jsonError(c, 415, 'bad_type', 'Use a PNG, JPG, WEBP or GIF image.');

  const id = uid('avt');
  const key = `${user.id}/avatar/${id}.${String(file.type).split('/')[1] === 'jpeg' ? 'jpg' : String(file.type).split('/')[1]}`;
  await (c.env.UPLOADS || c.env.R2).put(key, file, {
    httpMetadata: { contentType: file.type, cacheControl: 'public, max-age=31536000, immutable' },
  });
  const url = downloadPath(id);   // served by /api/files/:id/download
  await updateProfile(c.env.DB, user.id, { avatar_url: url });
  await db_run(c.env.DB, 'INSERT INTO files (id, user_id, chat_id, r2_key, filename, file_type, size, url, created_at) VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8)',
    id, user.id, key, `avatar-${id}`, file.type, file.size, url, nowSec());

  return c.json({ ok: true, url, id });
});

/* ------------------------------ profile patch ---------------------------- */
auth.post('/profile', async (c) => {
  const user = c.get('user');
  if (!user) return jsonError(c, 401, 'unauthenticated', 'Please log in first.');
  const body = await readBody(c);
  const fields = {};
  if (typeof body.name === 'string') fields.name = body.name.trim().slice(0, 80) || null;
  if (Object.keys(fields).length) await updateProfile(c.env.DB, user.id, fields);
  const fresh = await findUserById(c.env.DB, user.id);
  return c.json({ user: publicUser(fresh) });
});

/* -------------------------------- helpers -------------------------------- */
async function readBody(c) {
  const type = c.req.header('content-type') || '';
  if (type.includes('application/json')) {
    try { return await c.req.json(); } catch (err) { return {}; }
  }
  if (type.includes('form')) {
    const form = await c.req.formData().catch(() => null);
    if (!form) return {};
    const out = {};
    for (const [key, value] of form.entries()) if (typeof value === 'string') out[key] = value;
    return out;
  }
  return {};
}

async function throttle(c, options) {
  const limited = await rateLimit(c, options);
  if (!limited) return null;
  const res = jsonError(c, 429, 'rate_limited', 'Too many attempts. Please wait a minute and try again.');
  res.headers.set('retry-after', String(limited.retryAfter || 30));
  return res;
}

function isUnique(err) {
  return /UNIQUE constraint failed|already exists|constraint/i.test(String(err?.message || ''));
}

export function originFor(c) {
  const configured = String(c.env.PUBLIC_ORIGIN || '').replace(/\/$/, '');
  if (configured && !/^https?:\/\//.test(configured)) return `https://${configured}`;
  if (configured) return configured;
  return new URL(c.req.url).origin;
}

function safeNext(value) {
  const raw = String(value || '/');
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[\r\n]/.test(raw)) return '/';
  if (raw.startsWith('/api') || raw.startsWith('/login') || raw.startsWith('/reset')) return '/';
  return raw.slice(0, 120);
}

function failToLogin(c, message) {
  const url = new URL('/', originFor(c));
  url.searchParams.set('error', String(message).slice(0, 160));
  return c.redirect(`${url.pathname}${url.search}`, 302);
}

function describeProviderError(code) {
  if (code === 'access_denied') return 'Google sign-in was cancelled.';
  if (code === 'invalid_grant' || code === 'expired') return 'That sign-in link is invalid or has already been used. Please try again.';
  if (code === 'missing-link') return 'That sign-in link is incomplete. Please try signing in again.';
  return `Google reported an error${code ? ` (${code})` : ''}. Please try again.`;
}

async function csrfToken(userId, secret) {
  return sign_jwt({ sub: userId, purpose: 'csrf' }, secret, 3600 * 12);
}

/**
 * Reset email. Works with Resend (RESEND_API_KEY) or any SMTP-ish HTTP endpoint
 * (MAIL_API_URL + MAIL_API_KEY). When nothing is configured the request still
 * returns ok (to avoid user enumeration) and the audit row says so.
 */
async function sendResetEmail(c, user, link) {
  const from = c.env.MAIL_FROM || 'Fly Dragon AI <no-reply@flytripvisa.site>';
  const payload = {
    subject: 'Reset your Fly Dragon AI password',
    intro: 'Use the link below to choose a new password. It expires in 30 minutes.',
    cta: 'Reset password',
  };

  if (c.env.RESEND_API_KEY) {
    const res = await fetch(c.env.RESEND_ENDPOINT || 'https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${c.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from,
        to: user.email,
        subject: payload.subject,
        html: emailHtml(user, link, payload),
      }),
    });
    if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text().catch(() => '')}`);
    return true;
  }

  if (c.env.MAIL_API_URL) {
    const res = await fetch(c.env.MAIL_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(c.env.MAIL_API_KEY ? { authorization: `Bearer ${c.env.MAIL_API_KEY}` } : {}),
        'x-mailer-api-key': c.env.MAILER_API_KEY || '',
        'x-custom-from': from,
        'x-custom-to': user.email,
        'x-custom-subject': payload.subject,
        'x-custom-tag': 'password-reset',
      },
      body: JSON.stringify({ to: user.email, subject: payload.subject, html: emailHtml(user, link, payload) }),
    });
    if (!res.ok) throw new Error(`mail endpoint ${res.status}`);
    return true;
  }

  console.warn('[auth] no mail provider configured - reset link not emailed');
  return false;
}

function emailHtml(user, link, copy) {
  const name = String(user.name || 'there').replace(/[<>&]/g, '');
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#000;color:#f0f0f0;padding:28px">
  <div style="max-width:520px;margin:0 auto;background:#101010;border:1px solid #262626;border-radius:16px;padding:24px">
    <div style="font-size:15px;font-weight:800">👽 Fly <span style="color:#e11d2c">🐉</span> AI</div>
    <p style="font-size:14px;line-height:1.6;margin:16px 0 8px">Hi ${name},</p>
    <p style="font-size:14px;line-height:1.6;margin:0 0 18px">${copy.intro}</p>
    <a href="${link}" style="display:inline-block;background:#e11d2c;color:#fff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:700">${copy.cta}</a>
    <p style="font-size:12px;color:#8a9ab8;margin:22px 0 0;word-break:break-all">${link}</p>
    <p style="font-size:12px;color:#5f6b7f;margin-top:18px">If you did not ask for this, you can ignore this email.</p>
  </div></div>`;
}

export { auth as authRoutes, publicUser, originFor as origin };
export default auth;
