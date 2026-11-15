-- ============================================================================
-- FlyDragon AI - Cloudflare D1 schema (source of truth: this file)
--
--   local:  npx wrangler d1 execute fly-dragon-db --local  --file ./src/db/schema.sql
--   prod:   npx wrangler d1 execute fly-dragon-db --remote --file ./src/db/schema.sql
--
-- The five tables from the brief (users, chats, messages, files, settings) are
-- implemented with exactly the columns asked for. The four extra tables -
-- sessions, password_resets, mcp_servers, images, audit_log - exist only because
-- other parts of the brief require them: HttpOnly session storage (§4), the
-- optional forgot-password link (§4), "Add Custom MCP Server URL + API Key" (§6B),
-- the image gallery (§6C) and the admin view (§6D) needing something to read.
--
-- Legacy: the previous worker stored password_hash plus a separate `salt` column.
-- New rows use bcrypt and leave salt NULL; login detects the format per row and
-- upgrades the hash on the next successful sign-in, so old accounts keep working.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- §5 users. `role` is the only addition: §6D requires an admin view.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT,                          -- bcrypt; NULL for provider-only accounts
  name          TEXT,
  avatar_url    TEXT,
  provider      TEXT NOT NULL DEFAULT 'password',  -- password | google
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    INTEGER NOT NULL,
  -- legacy compatibility
  salt          TEXT,
  hash_alg      TEXT DEFAULT 'bcrypt',
  provider_id   TEXT
);
CREATE INDEX IF NOT EXISTS users_email_idx ON users (email);

-- §4 session store. The cookie holds an opaque token; D1 stores its SHA-256 hash,
-- so a leaked row cannot be replayed and revoking is a single DELETE.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_exp_idx  ON sessions (expires_at);

-- §4 optional forgot-password link (single use, expiring).
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

-- §5 chats (exactly the requested columns).
CREATE TABLE IF NOT EXISTS chats (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT 'New chat',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chats_user_idx ON chats (user_id, updated_at DESC);

-- §5 messages (exactly the requested columns; the owner is reached via chats).
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  chat_id    TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT NOT NULL,
  files_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_chat_idx ON messages (chat_id, created_at);

-- §5 files: R2 object registry. `url` is the path that mints a signed URL
-- (/api/files/:id/download); the bare R2 key is never exposed.
CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  chat_id    TEXT REFERENCES chats (id) ON DELETE SET NULL,
  r2_key     TEXT NOT NULL UNIQUE,
  filename   TEXT NOT NULL,
  file_type  TEXT NOT NULL,
  size       INTEGER NOT NULL DEFAULT 0,
  url        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS files_user_idx ON files (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS files_chat_idx ON files (chat_id);

-- §5 settings: per-user key/value (tool toggles, appearance, language, voice).
CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT,
  PRIMARY KEY (user_id, key)
);

-- §6B custom MCP servers. api_key is stored AES-GCM encrypted with MCP_ENCRYPTION_KEY
-- and is never sent back to the client.
CREATE TABLE IF NOT EXISTS mcp_servers (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  api_key_enc TEXT,
  status      TEXT NOT NULL DEFAULT 'unknown',   -- connected | failed | unknown
  last_error  TEXT,
  last_check  INTEGER,
  created_at  INTEGER NOT NULL
);

-- §6C gallery of AI-generated images (uploaded images stay in `files`).
CREATE TABLE IF NOT EXISTS images (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  chat_id    TEXT REFERENCES chats (id) ON DELETE SET NULL,
  prompt     TEXT NOT NULL,
  r2_key     TEXT NOT NULL UNIQUE,
  url        TEXT NOT NULL,
  size       INTEGER,
  created_at INTEGER NOT NULL
);

-- §6D admin view + general abuse tracing.
CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  action     TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log (created_at DESC);

-- Seed one admin when the app has no users yet. Change the password immediately
-- (or delete the row) - the hash below is for 'ChangeMe-First!' at bcrypt cost 10.
-- INSERT INTO users (id, email, password_hash, name, provider, role, created_at, hash_alg)
-- VALUES ('usr_admin', 'admin@flytripvisa.site',
--         '$2b$10$replace-with-your-own-bcrypt-hash', 'Admin', 'password', 'admin',
--         strftime('%s','now'), 'bcrypt');
