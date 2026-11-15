/* ============================================================================
 * Files: R2 upload/register/list/download/delete. Private bucket, signed or
 * proxied download, ownership always re-checked against D1.
 * ==========================================================================*/
import { Hono } from 'hono';
import { jsonError, nowSec, rateLimit, requireAuth, uid } from '../lib/http.js';
import { validateUpload, extractText, signedDownloadUrl, downloadPath, removeObject } from '../lib/store.js';
import { insertFile, findFile, listFiles, deleteFileRow, userFileBytes, audit } from '../lib/db.js';

const files = new Hono();
files.use('*', requireAuth);

const bucketOf = (c) => c.env.UPLOADS || c.env.R2 || c.env['fly-dragon-uploads'];

/* -------------------------------- upload -------------------------------- */
files.post('/upload', async (c) => {
  const limited = await rateLimit(c, { limit: Number(c.env.UPLOAD_RATE_LIMIT || 30), windowSec: 60, scope: 'upload', by: c.get('user').id });
  if (limited) return jsonError(c, 429, 'rate_limited', 'Too many uploads at once. Give it a minute.');

  const bucket = bucketOf(c);
  if (!bucket) return jsonError(c, 500, 'storage_unbound', 'The fly-dragon-uploads bucket is not bound to this worker.');

  const form = await c.req.formData().catch(() => null);
  if (!form) return jsonError(c, 400, 'bad_form', 'Send the file as multipart/form-data.');

  const entries = form.getAll('file').filter((value) => value && typeof value.arrayBuffer === 'function');
  const chatId = String(form.get('chatId') || '').trim() || null;
  if (!entries.length) return jsonError(c, 400, 'no_file', 'No file was attached.');

  const stored = [];
  const rejected = [];

  for (const file of entries.slice(0, 10)) {
    const checked = validateUpload(file);
    if (!checked.ok) { rejected.push({ name: String(file.name || 'file'), reason: checked.reason }); continue; }

    const used = await userFileBytes(c.env.DB, c.get('user').id);
    const limitBytes = Number(c.env.STORAGE_LIMIT_BYTES || 1073741824);
    if (Number(used?.bytes || 0) + file.size > limitBytes) {
      rejected.push({ name: checked.filename, reason: 'Your storage is full. Delete a file and try again.' });
      continue;
    }

    const id = uid('file');
    const key = `${c.get('user').id}/${id}/${checked.filename}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: checked.mime, cacheControl: 'private, no-store' },
      customMetadata: { userId: c.get('user').id, chatId: chatId || 'none', originalName: checked.filename },
    });

    const record = {
      id,
      user_id: c.get('user').id,
      chat_id: chatId,
      r2_key: key,
      filename: checked.filename,
      file_type: checked.mime,
      size: file.size,
      url: downloadPath(id),
      created_at: nowSec(),
    };
    await insertFile(c.env.DB, record);
    stored.push({
      fileId: record.id,
      id: record.id,
      url: record.url,
      filename: record.filename,
      name: record.filename,
      size: record.size,
      fileType: record.file_type,
      mime: record.file_type,
      chatId: record.chat_id,
      created_at: record.created_at,
    });
  }

  if (!stored.length) {
    return jsonError(c, rejected[0]?.reason?.includes('full') ? 507 : 400, 'upload_rejected', rejected[0]?.reason || 'None of those files could be accepted.');
  }
  await audit(c.env.DB, c.get('user').id, 'file.upload', `${stored.length} file(s)`);
  return c.json({ files: stored, fileId: stored[0].fileId, url: stored[0].url, rejected }, 201);
});

/* --------------------------------- list --------------------------------- */
files.get('/files', async (c) => {
  const search = c.req.query('q') || c.req.query('search') || '';
  const rows = await listFiles(c.env.DB, c.get('user').id, search || undefined);
  const usage = await userFileBytes(c.env.DB, c.get('user').id);
  return c.json({
    files: rows,                                     // id, filename, file_type, size, url, chat_title, created_at
    items: rows,
    total: rows.length,
    used_bytes: Number(usage?.bytes || 0),
    limit_bytes: Number(c.env.STORAGE_LIMIT_BYTES || 1073741824),
  });
});

/* ------------------------------- download ------------------------------- */
async function loadOwnedFile(c) {
  const row = await findFile(c.env.DB, c.req.param('id'), c.get('user').id);
  if (!row) return null;
  return row;
}

files.get('/files/:id/download', async (c) => {
  const row = await loadOwnedFile(c);
  if (!row) return jsonError(c, 404, 'not_found', 'That file is not in your account.');

  const bucket = bucketOf(c);
  const inline = c.req.query('inline') === '1';

  // Prefer a real signed URL from R2; fall back to streaming through the worker
  // so the link works even where signing is unavailable.
  if (!inline) {
    const signed = await signedDownloadUrl(c.env, row.r2_key, { expiresIn: 120, filename: row.filename });
    if (signed) return c.redirect(signed, 302);
  }

  const object = await bucket.get(row.r2_key);
  if (!object) return jsonError(c, 410, 'gone', 'The stored object is missing. Re-upload the file.');

  const safeName = String(row.filename).replace(/["\r\n]/g, '_');
  const headers = new Headers({
    'content-type': row.file_type || 'application/octet-stream',
    'content-length': String(object.size ?? ''),
    'cache-control': 'private, no-store',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    'x-content-type-options': 'nosniff',
  });
  return new Response(object.body, { status: 200, headers });
});

/* Preview text for txt/csv/md (images and pdfs are rendered by the download route). */
files.get('/files/:id/text', async (c) => {
  const row = await loadOwnedFile(c);
  if (!row) return jsonError(c, 404, 'not_found', 'That file is not in your account.');
  const bucket = bucketOf(c);
  const text = await extractText(bucket, row);
  if (text === null) return jsonError(c, 415, 'not_text', 'This file type cannot be shown as text.');
  return c.json({ filename: row.filename, text: text.slice(0, 60000), truncated: text.length > 60000 });
});

/* --------------------------------- delete ------------------------------- */
files.delete('/files/:id', async (c) => {
  const row = await loadOwnedFile(c);
  if (!row) return jsonError(c, 404, 'not_found', 'That file is not in your account.');

  const purge = c.req.query('purge') === '1';
  await deleteFileRow(c.env.DB, row.id, c.get('user').id);
  if (purge) await removeObject(bucketOf(c), row.r2_key);
  await audit(c.env.DB, c.get('user').id, 'file.delete', row.filename);
  return c.json({ ok: true, purged: purge });
});

export default files;
