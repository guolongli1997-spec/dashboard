/* WebCrypto helpers. No secrets are logged anywhere in this file. */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes) {
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToString(value) {
  const bin = atob(String(value).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(value).length + 3) % 4));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return dec.decode(bytes);
}

export function utf8(str) {
  return enc.encode(str);
}

export function fromUtf8(buffer) {
  return dec.decode(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', utf8(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** 43-char url-safe token for sessions and reset links (256 bits). */
export function randomToken(length = 32) {
  return b64url(randomBytes(length));
}

/** One-way handle for a token: only the hash is ever stored in D1. */
export async function tokenHash(token) {
  return sha256Hex(token);
}

export async function hmacSha256Base64url(secret, data) {
  const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, utf8(data));
  return b64url(new Uint8Array(sig));
}

export async function hmacSha256Hex(secret, data) {
  const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, utf8(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time-ish comparison of two equal-length strings. */
export function stringEqual(a, b) {
  const left = String(a || ''), right = String(b || '');
  if (left.length !== right.length || !left.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export async function fingerprint(value) {
  return sha256Hex('fd:' + String(value));
}

/* ---------------- AES-GCM: MCP api keys at rest ---------------- */
async function aesKey(secret, saltBytes) {
  const material = await crypto.subtle.importKey('raw', utf8(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: 120000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptSecret(secret, plaintext) {
  if (!plaintext) return null;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await aesKey(secret, salt);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8(plaintext));
  return 'v1.' + b64url(salt) + '.' + b64url(iv) + '.' + b64url(new Uint8Array(cipher));
}

export async function decryptSecret(secret, packed) {
  if (!packed || !String(packed).startsWith('v1.')) return null;
  const [, saltB64, ivB64, dataB64] = String(packed).split('.');
  if (!saltB64 || !ivB64 || !dataB64) return null;
  const toBytes = (value) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
  try {
    const key = await aesKey(secret, toBytes(saltB64));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toBytes(ivB64) }, key, toBytes(dataB64));
    return fromUtf8(plain);
  } catch (err) {
    console.warn('[crypto] MCP secret could not be decrypted:', err && err.name);
    return null;
  }
}
