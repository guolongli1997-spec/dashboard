/* Shared HTTP helpers: ids, errors, auth gate, light rate limiting. */
import { fingerprint } from './crypto.js';

export const nowSec = () => Math.floor(Date.now() / 1000);

export function uid(prefix) {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return prefix + '_' + toBase36(b);
}
function toBase36(bytes) {
  let out = '';
  for (const byte of bytes) out += byte.toString(36).padStart(2, '0');
  return out.slice(0, 14);
}

export function jsonError(c, status, code, message) {
  return c.json({ error: code, message: message || code }, status);
}

export const errorResponses = (err, c) => {
  if (err && err.httpStatus) return c.json({ error: err.code || 'error', message: err.message }, err.httpStatus);
  console.error('[unhandled]', err && err.stack ? err.stack : err);
  return c.json({ error: 'server_error', message: 'Something went wrong on our side.' }, 500);
};

/** 401 for every API call that needs a session. */
export async function requireAuth(c, next) {
  const user = c.get('user');
  if (!user) return jsonError(c, 401, 'unauthenticated', 'Please log in to continue.');
  await next();
}

export async function requireAdmin(c, next) {
  const user = c.get('user');
  if (!user) return jsonError(c, 401, 'unauthenticated', 'Please log in to continue.');
  if (user.role !== 'admin') return jsonError(c, 403, 'forbidden', 'Admin access only.');
  await next();
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const FILE_EXT = ['pdf', 'doc', 'docx', 'txt', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'csv', 'xlsx'];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;      // §5: max 10MB per file

export function pickFilename(name) {
  const raw = String(name || 'file').replace(/[\\/\0]/g, '_').replace(/\s+/g, ' ').trim();
  const clipped = raw.length > 140 ? raw.slice(0, 120) + raw.slice(-20) : raw;
  const dot = clipped.lastIndexOf('.');
  const ext = dot > 0 ? clipped.slice(dot + 1).toLowerCase() : '';
  if (!FILE_EXT.includes(ext)) return null;
  return clipped;
}

/**
 * Per-isolate limiter. Returns null when the caller may continue, or
 * `{ retryAfter }` when they must wait. Isolates are per-worker, so this is a soft
 * guard - the hard limits live in the Cloudflare plan and in the UI.
 */
const buckets = new Map();
export async function rateLimit(c, { limit = 30, windowSec = 60, scope = 'misc', by = null } = {}) {
  const ip = c.req.raw.headers.get('cf-connecting-ip') || c.req.raw.headers.get('x-forwarded-for') || 'local';
  // `by` lets an endpoint key on the account it is acting on. Without it a whole
  // office behind one NAT would share a single budget.
  const identity = by ? String(by).toLowerCase().slice(0, 120) : await fingerprint(ip);
  const key = `${scope}:${identity}`;
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || now - entry.start > windowSec * 1000) {
    buckets.set(key, { start: now, count: 1 });
    if (buckets.size > 5000) buckets.clear();          // never grow unbounded
    return null;
  }
  entry.count += 1;
  if (entry.count <= limit) return null;
  return { retryAfter: Math.max(1, Math.ceil((windowSec * 1000 - (now - entry.start)) / 1000)) };
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, Number(n) || 0));
}

export function titleFrom(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return (clean.slice(0, 56) || 'New chat');
}
