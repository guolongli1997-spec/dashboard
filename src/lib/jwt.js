/* HS256 JWT, WebCrypto only. Enough to carry {sub, jti} in a cookie; the real
 * source of truth stays in D1 so a session can be revoked instantly. */
import { b64url, utf8, hmacSha256Base64url, b64urlToString, stringEqual } from './crypto.js';

const HEADER = b64url(utf8(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));

export async function sign_jwt(payload, secret, ttlSec = 60 * 60 * 24 * 30) {
  const issued = Math.floor(Date.now() / 1000);
  const body = { iat: issued, exp: issued + ttlSec, ...payload };
  const encoded = HEADER + '.' + b64url(utf8(JSON.stringify(body)));
  const signature = await hmacSha256Base64url(secret, encoded);
  return `${encoded}.${signature}`;
}

export async function verify_jwt(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = await hmacSha256Base64url(secret, `${header}.${payload}`);
  if (!stringEqual(signature, expected)) return null;
  let claims;
  try {
    claims = JSON.parse(b64urlToString(payload));
  } catch (err) {
    return null;
  }
  if (!claims || !claims.exp || claims.exp * 1000 < Date.now()) return null;
  return claims;
}
