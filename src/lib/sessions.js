/* ============================================================================
 * Session: one HttpOnly cookie holding `<opaque>.<jwt>`.
 *
 *   opaque  - 32 random bytes, only its SHA-256 is stored in D1, so the row can be
 *             deleted to revoke access instantly and a DB leak cannot be replayed.
 *   jwt     - HS256 claims {sub, jti, exp}. Cheap identity for tool calls and for
 *             cross-checking the opaque token (a mismatch is treated as no session).
 *
 * Cookie flags: HttpOnly + Secure + SameSite=Lax, 30-day sliding expiry, which is
 * what "Remember me for 30 days" in the login form promises.
 * ==========================================================================*/
import { randomToken, tokenHash, stringEqual } from './crypto.js';
import { sign_jwt, verify_jwt } from './jwt.js';
import { nowSec } from './http.js';
import { insertSession, selectSession, touchSession, deleteSession, purgeSessions, findUserById } from './db.js';

export const COOKIE = 'fd_session';
export const SESSION_TTL = 30 * 24 * 60 * 60;

function serialize(attrs) {
  const bits = [`Path=${attrs.path || '/'}`];
  if (attrs.maxAge === 0) bits.push('Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  else bits.push(`Max-Age=${attrs.maxAge}`);
  if (attrs.httpOnly) bits.push('HttpOnly');
  if (attrs.secure) bits.push('Secure');
  if (attrs.sameSite) bits.push(`SameSite=${attrs.sameSite}`);
  return bits.join('; ');
}

function setCookie(c, value, maxAge) {
  c.header('set-cookie', `${COOKIE}=${value}; ${serialize({
    path: '/', maxAge, httpOnly: true, secure: true, sameSite: 'Lax',
  })}`);
}

export function parseCookie(header) {
  const jar = {};
  for (const part of String(header || '').split(/;\s*/)) {
    if (!part) continue;
    const at = part.indexOf('=');
    if (at < 0) continue;
    jar[part.slice(0, at)] = decodeURIComponent(part.slice(at + 1));
  }
  return jar;
}

/** Keep a promise off the response path without losing it when the isolate pauses. */
function background(c, promise) {
  const ctx = c.executionCtx || c.env?.__execution;
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(promise.catch(() => {}));
  else promise.catch(() => {});
}

export async function createSession(c, user) {
  const opaque = randomToken(32);
  const hash = await tokenHash(opaque);
  const jti = randomToken(8);
  const now = nowSec();

  await insertSession(c.env.DB, {
    token_hash: hash,
    user_id: user.id,
    created_at: now,
    expires_at: now + SESSION_TTL,
    user_agent: (c.req.header('user-agent') || '').slice(0, 200) || null,
    ip: c.req.header('cf-connecting-ip') || null,
  });

  const jwt = await sign_jwt({ sub: user.id, jti, name: user.name || null }, c.env.JWT_SECRET, SESSION_TTL);
  setCookie(c, `${opaque}.${jwt}`, SESSION_TTL);
  background(c, purgeSessions(c.env.DB, now - SESSION_TTL * 2));

  return { opaque, hash, jwt, expiresAt: now + SESSION_TTL };
}

export async function destroySession(c) {
  const raw = parseCookie(c.req.header('cookie'))[COOKIE];
  setCookie(c, '', 0);
  if (!raw) return;
  const opaque = String(raw).split('.')[0];   // matches the first-dot split above
  await deleteSession(c.env.DB, await tokenHash(opaque));
}

/** Resolves the signed-in user, or null. The D1 row is the source of truth. */
export async function verifySession(c) {
  const raw = parseCookie(c.req.header('cookie'))[COOKIE];
  if (!raw) return null;

  // The opaque half is base64url (never contains a dot), the JWT always has two,
  // so the FIRST dot is the boundary.
  const first = String(raw).indexOf('.');
  if (first < 0) return null;
  const opaque = raw.slice(0, first);
  const jwt = raw.slice(first + 1);
  if (!opaque || !jwt || jwt.indexOf('.') === -1) return null;

  const hash = await tokenHash(opaque);
  const row = await selectSession(c.env.DB, hash);
  if (!row) return null;
  if (Number(row.expires_at) <= nowSec()) {
    await deleteSession(c.env.DB, hash);
    return null;
  }

  const claims = await verify_jwt(jwt, c.env.JWT_SECRET);
  if (!claims || !stringEqual(String(claims.sub), String(row.user_id))) return null;

  const user = await findUserById(c.env.DB, row.user_id);
  if (!user) {
    await deleteSession(c.env.DB, hash);
    return null;
  }

  if (nowSec() - Number(row.last_seen_at) > 600) background(c, touchSession(c.env.DB, hash, nowSec()));
  return { user, session: row, claims, tokenHash: hash };
}

export { tokenHash };
