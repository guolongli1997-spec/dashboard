/* ============================================================================
 * R2 storage + file rules.
 *
 *  Keys are always "<userId>/<fileId>/<safe name>" so no client can address
 *  another user's object, even with a signed URL leaked from a shared chat.
 *  Downloads go through /api/files/:id/download, which mints a short-lived
 *  signed URL server-side after checking ownership. The DB `url` column stores
 *  that same path (never the R2 key), so the client never sees bucket layout.
 * ==========================================================================*/
import { uid, MAX_FILE_BYTES, FILE_EXT, pickFilename } from './http.js';

export const MIME_BY_EXT = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

export const EXT_BY_MIME = {
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** §5: same list as the HTML accept attribute and a hard 10MB cap. */
export function validateUpload(file) {
  if (!file || typeof file.size !== 'number') return { ok: false, reason: 'No file received.' };
  if (!file.size) return { ok: false, reason: 'That file is empty.' };
  if (file.size > MAX_FILE_BYTES) return { ok: false, reason: `Files must be ${MAX_FILE_BYTES / 1024 / 1024}MB or smaller.` };
  const ext = pickFilename(file.name || 'file.bin') ? String(file.name).split('.').pop().toLowerCase() : null;
  if (!ext || !FILE_EXT.includes(ext)) return { ok: false, reason: `Unsupported file type. Allowed: ${FILE_EXT.join(', ')}.` };
  return { ok: true, ext, filename: pickFilename(file.name), mime: MIME_BY_EXT[ext] || file.type || 'application/octet-stream' };
}

export function r2Key(userId, fileId, filename) {
  return `${userId}/${fileId}/${filename}`;
}

export function downloadPath(fileId) {
  return `/api/files/${encodeURIComponent(fileId)}/download`;
}

/** Upload with a bounded wait; returns the R2 etag when the bucket reports one. */
export async function putObject(bucket, key, data, options = {}) {
  await bucket.put(key, data, {
    httpMetadata: { contentType: options.contentType || 'application/octet-stream', cacheControl: options.cacheControl || 'private, no-store' },
    ...(options.customMetadata ? { customMetadata: options.customMetadata } : {}),
  });
  return { key };
}

export async function removeObject(bucket, key) {
  await bucket.delete(key);
}

/**
 * Short-lived signed URL for a private object. Falls back to streaming through
 * the worker when the binding cannot sign (older Wrangler versions).
 */
export async function signedDownloadUrl(env, key, { expiresIn = 180, filename } = {}) {
  const bucket = env.UPLOADS || env.R2 || env['flytripvisa-cloud'];
  if (!bucket) return null;
  if (typeof bucket.createSignedUrl === 'function') {
    try {
      return await bucket.createSignedUrl(key, { expiresInSeconds: expiresIn, ...(filename ? { contentDisposition: `attachment; filename="${filename.replace(/["\r\n]/g, '')}"` } : {}) });
    } catch (err) {
      console.warn('[store] createSignedUrl unavailable:', err && err.message);
    }
  }
  if (typeof bucket.createSignedUrls === 'function') {
    try {
      const urls = await bucket.createSignedUrls([{ key, expiresInSeconds: expiresIn }]);
      return urls?.[0] ?? null;
    } catch (err) {
      console.warn('[store] createSignedUrls unavailable:', err && err.message);
    }
  }
  return null;
}

export async function getObject(bucket, key) {
  return bucket.get(key);
}

/* --------------------------- text for the model --------------------------- */
const TEXT_EXT = ['txt', 'csv', 'md', 'json', 'xml', 'html', 'log'];

/**
 * Best-effort, dependency-free text extraction so an attached file can be reasoned
 * about. Text-ish files decode directly; PDFs get a light pass (extract text
 * between BT/TJ operators - adequate for most passport/visa scans, and we say so
 * in the prompt when the result is thin). Binaries (doc/docx/xlsx) are only
 * described by name, never fabricated.
 */
export async function extractText(bucket, file) {
  const ext = String(file.filename).split('.').pop().toLowerCase();

  if (ext === 'pdf') {
    const bytes = await readBytes(bucket, file);
    if (!bytes) return null;
    const text = pdfLikeText(bytes);
    return text.length > 24 ? text.slice(0, 6000) : null;
  }

  if (TEXT_EXT.includes(ext)) {
    const bytes = await readBytes(bucket, file);
    if (!bytes) return null;
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 200000));
  }

  return null;
}

async function readBytes(bucket, file) {
  try {
    const object = await bucket.get(file.r2_key);
    if (!object) return null;
    return new Uint8Array(await object.arrayBuffer());
  } catch (err) {
    console.warn('[store] read failed:', err && err.message);
    return null;
  }
}

/** Naive but honest PDF text sniffing: literal strings inside content streams. */
function pdfLikeText(bytes) {
  const latin = new TextDecoder('latin1').decode(bytes.subarray(0, 4_000_000));
  const chunks = [];
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  let match;
  while ((match = streamRe.exec(latin)) && chunks.length < 400) {
    const body = match[1];
    const textOps = body.match(/\((?:\\.|[^\\()])*\)/g) || [];
    for (const token of textOps) {
      const value = token.slice(1, -1).replace(/\\([()\\])/g, '$1');
      if (value.trim() && !/^[a-zA-Z]$/.test(value.trim())) chunks.push(value);
      if (chunks.length > 400) break;
    }
  }
  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}

export function newFileRecord(userId, file, validation, chatId) {
  const id = uid('file');
  return {
    id,
    user_id: userId,
    chat_id: chatId && String(chatId).length ? String(chatId) : null,
    r2_key: r2Key(userId, id, validation.filename),
    filename: validation.filename,
    file_type: validation.mime,
    size: file.size,
    url: downloadPath(id),
    created_at: Math.floor(Date.now() / 1000),
  };
}
