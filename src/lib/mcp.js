/* Custom MCP servers (§6B) - storage, crypto and tool discovery. */
import { encryptSecret, decryptSecret, randomToken, stringEqual } from './crypto.js';
import { uid } from './http.js';
import { deleteMcp, findMcp, insertMcp, listMcp, updateMcpStatus, db_all } from './db.js';
import { discoverMcp } from './tools.js';

/** Per-request memo so a chat turn handshakes with each MCP server at most once. */
const cache = {
  getWaitUntil(c, key, loader) {
    if (!c.__mcpCache) c.__mcpCache = new Map();
    if (!c.__mcpCache.has(key)) c.__mcpCache.set(key, loader());
    return c.__mcpCache.get(key);
  },
};

const KEY_ENV = 'MCP_ENCRYPTION_KEY';

export function encryptionKey(env) {
  return env[KEY_ENV] || env.JWT_SECRET || null;
}

export async function sealApiKey(env, plainKey) {
  const secret = encryptionKey(env);
  if (!plainKey) return null;
  if (!secret) throw missingSecret();
  return encryptSecret(secret, String(plainKey).slice(0, 4000));
}

export async function openApiKey(env, sealed) {
  if (!sealed) return null;
  const secret = encryptionKey(env);
  if (!secret) return null;
  return decryptSecret(secret, sealed);
}

function missingSecret() {
  const err = new Error(`${KEY_ENV} (or JWT_SECRET) must be set to store an MCP API key.`);
  err.httpStatus = 500;
  err.code = 'config_missing';
  return err;
}

export async function createServer(c, { name, url, apiKey }) {
  const record = {
    id: uid('mcp'),
    user_id: c.get('user').id,
    name: String(name || 'MCP server').slice(0, 60),
    url: String(url).slice(0, 500),
    api_key_enc: await sealApiKey(c.env, apiKey),
    status: 'unknown',
    created_at: Math.floor(Date.now() / 1000),
  };
  await insertMcp(c.env.DB, record);
  return { ...record, apiKey: apiKey || null };
}

export async function listServers(c, userId) {
  const rows = await listMcp(c.env.DB, userId);
  return rows.map((row) => ({ ...row, apiKey: undefined }));
}

export async function serverWithSecret(c, id) {
  const row = await findMcp(c.env.DB, id, c.get('user').id);
  if (!row) return null;
  return { ...row, apiKey: await openApiKey(c.env, row.api_key_enc) };
}

export async function removeServer(c, id) {
  return deleteMcp(c.env.DB, id, c.get('user').id);
}

export async function rememberStatus(c, id, status, error) {
  return updateMcpStatus(c.env.DB, id, c.get('user').id, status, error, Math.floor(Date.now() / 1000));
}

/**
 * Servers the visitor connected and last tested successfully, with their discovered
 * tools attached so buildToolset() can expose them to the model. Discovery is cached
 * per request; a server that stopped answering yields no tools instead of breaking
 * the chat turn.
 */
export async function enabledMcpServers(c, userId) {
  const rows = await db_all(
    c.env.DB,
    "SELECT id, name, url, api_key_enc FROM mcp_servers WHERE user_id = ?1 AND status = 'connected' ORDER BY created_at DESC LIMIT 6",
    userId,
  );
  return Promise.all(rows.map(async (row) => {
    const server = {
      id: row.id,
      name: row.name,
      url: row.url,
      apiKey: await openApiKey(c.env, row.api_key_enc),
      tools: [],
    };
    try {
      const answer = await cache.getWaitUntil(c, `mcp:${row.id}`, () => discoverMcp(server));
      server.tools = answer?.ok ? (answer.tools || []) : [];
      server.sessionId = answer?.session || null;
    } catch (err) {
      console.warn(`[mcp] ${row.name} tool discovery failed:`, err && err.message);
    }
    return server;
  }));
}

export { randomToken, stringEqual };
