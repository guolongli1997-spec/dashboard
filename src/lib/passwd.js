/* ============================================================================
 * Password hashing. bcryptjs is used because the brief asks for bcrypt and
 * because the previous app's rows may still be in the legacy
 * sha256(salt + password) format, which has to keep working after this upgrade.
 *
 * Workers has no bcrypt in WebCrypto, so hashing runs off the main request path
 * in the sense that cost is capped at 10 rounds (~50-90ms on a Worker) to stay
 * inside CPU limits. Passwords are never logged and never stored in plain text.
 * ==========================================================================*/
import bcrypt from 'bcryptjs';
import { sha256Hex, randomToken, stringEqual } from './crypto.js';

export const BCRYPT_COST = 10;

export async function hashPassword(password) {
  return { hash: await bcrypt.hash(String(password), BCRYPT_COST), alg: 'bcrypt', salt: null };
}

/** New-style check, with legacy sha256 rows still accepted (auth route upgrades them). */
export async function verifyPassword(password, storedHash, legacySalt, alg) {
  const value = String(password || '');
  if (!storedHash) return false;

  if (alg === 'bcrypt' || /^\$2[aby]\$/.test(String(storedHash))) {
    try {
      return await bcrypt.compare(value, storedHash);
    } catch (err) {
      console.warn('[passwd] bcrypt compare failed:', err && err.message);
      return false;
    }
  }

  // Legacy row: sha256(salt + password) in hex, salt stored per row.
  if (legacySalt) {
    const digest = await sha256Hex(String(legacySalt) + value);
    return stringEqual(digest, String(storedHash).toLowerCase());
  }

  return false;
}

export function generateSalt() {
  return randomToken(16);
}

/**
 * Password policy, enforced server side too.
 * Eight characters and no structure checks is what the deployed login form asks for;
 * the brief wants bcrypt + sane limits, so this stays aligned with the client.
 */
export function passwordProblem(password) {
  const value = String(password || '');
  if (value.length < 8) return 'Password must be at least 8 characters.';
  if (value.length > 200) return 'Password is too long.';
  if (/^(password|12345678|qwertyui|admin123)/i.test(value)) return 'That password is too common.';
  return null;
}
