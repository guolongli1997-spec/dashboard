/* D1 access layer. Keeps statement building in one place so every read is scoped
 * to the signed-in user, and the admin view can only ever touch known tables. */
import { nowSec } from './http.js';

export const TABLES = {
  users: ['id', 'email', 'name', 'avatar_url', 'provider', 'role', 'created_at'],   // password_hash deliberately absent
  sessions: ['user_id', 'created_at', 'last_seen_at', 'expires_at'],
  chats: ['id', 'user_id', 'title', 'created_at', 'updated_at'],
  messages: ['id', 'chat_id', 'role', 'content', 'files_json', 'created_at'],
  files: ['id', 'user_id', 'chat_id', 'filename', 'file_type', 'size', 'url', 'created_at'],
  settings: ['user_id', 'key', 'value'],
  mcp_servers: ['id', 'user_id', 'name', 'url', 'status', 'last_error', 'last_check', 'created_at'],
  images: ['id', 'user_id', 'chat_id', 'prompt', 'url', 'size', 'created_at'],
  password_resets: ['user_id', 'created_at', 'expires_at', 'used_at'],
  audit_log: ['id', 'user_id', 'action', 'detail', 'created_at'],
};

export async function db_all(db, sql, ...params) {
  const result = await db.prepare(sql).bind(...params).all();
  return result.results || [];
}

export async function db_first(db, sql, ...params) {
  const result = await db.prepare(sql).bind(...params).first();
  return result === null ? null : result;
}

export function db_run(db, sql, ...params) {
  return db.prepare(sql).bind(...params).run();
}

export async function db_exec(db, statements) {
  return db.batch(statements.map((entry) => (Array.isArray(entry)
    ? db.prepare(entry[0]).bind(...entry.slice(1))
    : entry)));
}

/** Cheap existence probe so a half-migrated database fails loudly, not silently. */
export async function tableExists(db, table) {
  const row = await db_first(db, `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?1`, table);
  return Boolean(row && row.n > 0);
}

export async function audit(db, userId, action, detail) {
  try {
    await db_run(
      db,
      'INSERT INTO audit_log (id, user_id, action, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
      `aud_${crypto.randomUUID()}`, userId || null, action, detail ? String(detail).slice(0, 500) : null, Math.floor(Date.now() / 1000),
    );
  } catch (err) {
    console.warn('[db] audit write skipped:', err && err.message);
  }
}

/* ------------------------------- users ------------------------------- */
export function insertUser(db, user) {
  return db_run(
    db,
    `INSERT INTO users (id, email, password_hash, name, avatar_url, provider, role, created_at, hash_alg)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    user.id, user.email, user.password_hash, user.name, user.avatar_url, user.provider, user.role, user.created_at, user.hash_alg,
  );
}

export function findUserByEmail(db, email) {
  return db_first(db, 'SELECT * FROM users WHERE lower(email) = lower(?1)', String(email || '').trim());
}

export function findUserById(db, id) {
  return db_first(db, 'SELECT * FROM users WHERE id = ?1', id);
}

export async function upgradeLegacyPassword(db, userId, hash, alg) {
  try {
    await db_run(db, 'UPDATE users SET password_hash = ?2, hash_alg = ?3, salt = NULL WHERE id = ?1', userId, hash, alg);
  } catch (err) {
    // The old column set has no salt/hash_alg: fall back to plain hash storage.
    console.warn('[db] password upgrade skipped:', err && err.message);
  }
}

/* ------------------------------ sessions ----------------------------- */
export function insertSession(db, session) {
  return db_run(
    db,
    `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, user_agent, ip)
     VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6)`,
    session.token_hash, session.user_id, session.created_at, session.expires_at, session.user_agent, session.ip,
  );
}

export function selectSession(db, tokenHash) {
  return db_first(db, 'SELECT * FROM sessions WHERE token_hash = ?1', tokenHash);
}

export function touchSession(db, tokenHash, when) {
  return db_run(db, 'UPDATE sessions SET last_seen_at = ?2 WHERE token_hash = ?1', tokenHash, when);
}

export function deleteSession(db, tokenHash) {
  return db_run(db, 'DELETE FROM sessions WHERE token_hash = ?1', tokenHash);
}

export function purgeSessions(db, before) {
  return db_run(db, 'DELETE FROM sessions WHERE expires_at < ?1', before);
}

/* -------------------------------- chats ------------------------------ */
export function insertChat(db, chat) {
  return db_run(
    db,
    'INSERT INTO chats (id, user_id, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)',
    chat.id, chat.user_id, chat.title, chat.created_at, chat.updated_at,
  );
}

export function findChat(db, chatId, userId) {
  return db_first(db, 'SELECT * FROM chats WHERE id = ?1 AND user_id = ?2', chatId, userId);
}

export function touchChat(db, chatId, when = nowSec()) {
  return db_run(db, 'UPDATE chats SET updated_at = ?2 WHERE id = ?1', chatId, when);
}

export function renameChatIfDefault(db, chatId, title, when) {
  return db_run(
    db,
    "UPDATE chats SET title = ?2, updated_at = ?3 WHERE id = ?1 AND title = 'New chat'",
    chatId, title, when,
  );
}

export function listChats(db, userId, limit = 50) {
  return db_all(
    db,
    `SELECT c.id, c.title, c.created_at, c.updated_at,
            (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS message_count
       FROM chats c WHERE c.user_id = ?1
      ORDER BY c.updated_at DESC LIMIT ?2`,
    userId, limit,
  );
}

export function deleteChat(db, chatId, userId) {
  return db_run(db, 'DELETE FROM chats WHERE id = ?1 AND user_id = ?2', chatId, userId);
}

export function deleteAllChats(db, userId) {
  return db_run(db, 'DELETE FROM chats WHERE user_id = ?1', userId);
}

export function insertMessage(db, message) {
  return db_run(
    db,
    'INSERT INTO messages (id, chat_id, role, content, files_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    message.id, message.chat_id, message.role, message.content, JSON.stringify(message.files || []), message.created_at,
  );
}

export function listMessages(db, chatId, limit = 200) {
  return db_all(
    db,
    `SELECT id, chat_id, role, content, files_json, created_at
       FROM messages WHERE chat_id = ?1 ORDER BY created_at ASC LIMIT ?2`,
    chatId, limit,
  );
}

/* ------------------------------- files ------------------------------- */
export function insertFile(db, file) {
  return db_run(
    db,
    `INSERT INTO files (id, user_id, chat_id, r2_key, filename, file_type, size, url, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    file.id, file.user_id, file.chat_id, file.r2_key, file.filename, file.file_type, file.size, file.url, file.created_at,
  );
}

export function findFile(db, fileId, userId) {
  return db_first(db, 'SELECT * FROM files WHERE id = ?1 AND user_id = ?2', fileId, userId);
}

export function listFiles(db, userId, search) {
  const where = search
    ? 'WHERE f.user_id = ?1 AND lower(f.filename) LIKE ?2'
    : 'WHERE f.user_id = ?1';
  const params = search ? [userId, `%${String(search).toLowerCase()}%`] : [userId];
  return db_all(
    db,
    `SELECT f.id, f.filename, f.file_type, f.size, f.url, f.chat_id, f.created_at, c.title AS chat_title
       FROM files f LEFT JOIN chats c ON c.id = f.chat_id
       ${where} ORDER BY f.created_at DESC LIMIT 200`,
    ...params,
  );
}

export function attachFilesToChat(db, chatId, userId, ids) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return Promise.resolve();
  const marks = list.map((_, index) => `?${index + 3}`).join(', ');
  return db_run(
    db,
    `UPDATE files SET chat_id = ?1 WHERE user_id = ?2 AND id IN (${marks})`,
    chatId, userId, ...list,
  );
}

export function deleteFileRow(db, fileId, userId) {
  return db_run(db, 'DELETE FROM files WHERE id = ?1 AND user_id = ?2', fileId, userId);
}

export function orphanFiles(db, userId) {
  return db_all(db, 'SELECT id, filename, r2_key, size, created_at FROM files WHERE user_id = ?1 AND chat_id IS NULL', userId);
}

export function userFileBytes(db, userId) {
  return db_first(db, 'SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS n FROM files WHERE user_id = ?1', userId);
}

/* ------------------------------ settings ----------------------------- */
export async function readSettings(db, userId) {
  const rows = await db_all(db, 'SELECT key, value FROM settings WHERE user_id = ?1', userId);
  const out = {};
  for (const row of rows) {
    try {
      out[row.key] = row.value === null ? null : JSON.parse(row.value);
    } catch (err) {
      out[row.key] = row.value;
    }
  }
  return out;
}

export function writeSetting(db, userId, key, value) {
  const encoded = JSON.stringify(value === undefined ? null : value);
  return db_run(
    db,
    `INSERT INTO settings (user_id, key, value) VALUES (?1, ?2, ?3)
     ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
    userId, key, encoded,
  );
}

export function deleteAccount(db, userId) {
  return db_exec(db, [
    ['DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE user_id = ?1)', userId],
    ['DELETE FROM chats WHERE user_id = ?1', userId],
    ['DELETE FROM files WHERE user_id = ?1', userId],
    ['DELETE FROM images WHERE user_id = ?1', userId],
    ['DELETE FROM mcp_servers WHERE user_id = ?1', userId],
    ['DELETE FROM settings WHERE user_id = ?1', userId],
    ['DELETE FROM sessions WHERE user_id = ?1', userId],
    ['DELETE FROM users WHERE id = ?1', userId],
  ]);
}

/* --------------------------- password resets --------------------------- */
export function insertReset(db, reset) {
  return db_run(
    db,
    'INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)',
    reset.token_hash, reset.user_id, reset.created_at, reset.expires_at,
  );
}

export function findReset(db, tokenHash) {
  return db_first(db, 'SELECT * FROM password_resets WHERE token_hash = ?1', tokenHash);
}

export function consumeReset(db, tokenHash, when) {
  return db_run(db, 'UPDATE password_resets SET used_at = ?2 WHERE token_hash = ?1', tokenHash, when);
}

/* ------------------------------- profile ------------------------------- */
export function updateProfile(db, userId, fields) {
  const sets = [];
  const params = [];
  let index = 2;
  for (const [key, value] of Object.entries(fields)) {
    if (!['name', 'avatar_url'].includes(key)) continue;
    sets.push(`${key} = ?${index++}`);
    params.push(value);
  }
  if (!sets.length) return Promise.resolve();
  params.unshift(userId);
  return db_run(db, `UPDATE users SET ${sets.join(', ')} WHERE id = ?1`, ...params);
}

export async function listPublicTables(db) {
  const rows = await db_all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  return rows.map((row) => row.name).filter((name) => TABLES[name]);
}

/** Row counts for the tables this app owns, for the admin landing list. */
export async function tableOverview(db) {
  const names = await listPublicTables(db);
  const out = [];
  for (const name of names) {
    const count = await db_first(db, `SELECT COUNT(*) AS n FROM "${name}"`);
    out.push({ name, rows: Number(count ? count.n : 0) });
  }
  return out;
}

/**
 * Paginated admin read. Column names come from the fixed TABLES map only, and the
 * table name is validated against sqlite_master, so nothing user-supplied is ever
 * interpolated into SQL. Values are masked by column policy.
 */
export async function readTablePage(db, table, { limit = 25, offset = 0 } = {}) {
  const known = await db_first(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1", table);
  if (!known || !TABLES[table]) return null;

  const allowed = TABLES[table];
  const probe = await db_first(db, `SELECT * FROM "${table}" LIMIT 1`);
  const presentColumns = probe ? Object.keys(probe).filter((col) => allowed.includes(col)) : [];
  const columns = (presentColumns.length ? presentColumns : allowed).filter((col) => allowed.includes(col));
  const selectList = columns.length ? columns.map((col) => `"${col}"`).join(', ') : 'rowid';

  const total = await db_first(db, `SELECT COUNT(*) AS n FROM "${table}"`);
  const rows = await db_all(
    db,
    `SELECT ${selectList} FROM "${table}" ORDER BY rowid LIMIT ?1 OFFSET ?2`,
    Math.min(100, Math.max(1, Number(limit) || 25)),
    Math.max(0, Number(offset) || 0),
  );
  return { columns, rows, total: total ? total.n : 0 };
}

/* -------------------------------- stats -------------------------------- */
export async function userStats(db, userId) {
  const chats = await db_first(db, 'SELECT COUNT(*) AS n FROM chats WHERE user_id = ?1', userId);
  const messages = await db_first(
    db,
    'SELECT COUNT(*) AS n FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.user_id = ?1',
    userId,
  );
  const files = await userFileBytes(db, userId);
  const images = await db_first(db, 'SELECT COUNT(*) AS n FROM images WHERE user_id = ?1', userId);
  return {
    chats: chats ? chats.n : 0,
    messages: messages ? messages.n : 0,
    files: files ? files.n : 0,
    images: images ? images.n : 0,
    storage_bytes: files ? files.bytes : 0,
  };
}

export async function userChats(db, userId, search) {
  if (search) {
    return db_all(
      db,
      `SELECT id, title, created_at, updated_at FROM chats
        WHERE user_id = ?1 AND lower(title) LIKE ?2 ORDER BY updated_at DESC LIMIT 100`,
      userId, `%${String(search).toLowerCase()}%`,
    );
  }
  return listChats(db, userId, 100);
}

/* ------------------------------ mcp servers ---------------------------- */
export function insertMcp(db, server) {
  return db_run(
    db,
    `INSERT INTO mcp_servers (id, user_id, name, url, api_key_enc, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    server.id, server.user_id, server.name, server.url, server.api_key_enc, server.status, server.created_at,
  );
}

export async function listMcp(db, userId) {
  const rows = await db_all(
    db,
    `SELECT id, name, url, status, last_error, last_check, created_at,
            CASE WHEN api_key_enc IS NULL THEN 0 ELSE 1 END AS has_key
       FROM mcp_servers WHERE user_id = ?1 ORDER BY created_at DESC`,
    userId,
  );
  return rows.map((row) => ({ ...row, has_key: row.has_key === 1 }));
}

export function findMcp(db, id, userId) {
  return db_first(db, 'SELECT * FROM mcp_servers WHERE id = ?1 AND user_id = ?2', id, userId);
}

export function updateMcpStatus(db, id, userId, status, error, when) {
  return db_run(
    db,
    'UPDATE mcp_servers SET status = ?3, last_error = ?4, last_check = ?5 WHERE id = ?1 AND user_id = ?2',
    id, userId, status, error ? String(error).slice(0, 400) : null, when,
  );
}

export function deleteMcp(db, id, userId) {
  return db_run(db, 'DELETE FROM mcp_servers WHERE id = ?1 AND user_id = ?2', id, userId);
}

/* --------------------------------- images ------------------------------ */
export function insertImage(db, image) {
  return db_run(
    db,
    'INSERT INTO images (id, user_id, chat_id, prompt, r2_key, url, size, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
    image.id, image.user_id, image.chat_id, image.prompt, image.r2_key, image.url, image.size, image.created_at,
  );
}

export function listImages(db, userId) {
  return db_all(
    db,
    `SELECT i.id, i.user_id, i.chat_id, i.prompt, i.url, i.size, i.created_at, c.title AS chat_title
       FROM images i LEFT JOIN chats c ON c.id = i.chat_id
      WHERE i.user_id = ?1 ORDER BY i.created_at DESC LIMIT 200`,
    userId,
  );
}

export function findImage(db, id, userId) {
  return db_first(db, 'SELECT * FROM images WHERE id = ?1 AND user_id = ?2', id, userId);
}

export function deleteImageRow(db, id, userId) {
  return db_run(db, 'DELETE FROM images WHERE id = ?1 AND user_id = ?2', id, userId);
}
