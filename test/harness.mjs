/* ============================================================================
 * Local test harness: real routes on real SQLite + an in-memory R2 double.
 *
 * Cloudflare D1 IS SQLite, and the worker only ever talks to it through
 * prepare().bind().all|first|run + batch(), so this harness executes the actual
 * SQL from src/db/schema.sql and the actual handlers in src/routes/*.
 * No network, no Cloudflare account, no test doubles inside the app.
 *
 *   node test/harness.mjs            -> starts provider double + API on :8790
 *   const { call } = await import('./harness.mjs')   -> in-process fetch too
 * ==========================================================================*/
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import app from '../src/index.js';
import { startProvider } from './provider-double.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Ports are chosen by the OS so concurrent test runs can never hijack each other's
// provider or half-dead leftovers from an earlier session.
const FIXED_PORT = Number(process.env.HARNESS_PORT || 0);

const sqlLog = [];

/* ---------------------------------- D1 ---------------------------------- */
/**
 * Params arrive in D1 style (?1, ?2 or ?). node:sqlite binds anonymous `?`
 * positionally, so every `?N` in the statement is rewritten to `?` in order.
 * Mixed usage is not produced by this app, and the guard below says so loudly.
 */
class D1 {
  constructor(database) {
    this.db = database;
  }

  prepare(query) {
    const numbered = [...query.matchAll(/\?(\d+)/g)].map((match) => Number(match[1]));
    const bare = (query.match(/\?(?!\d)/g) || []).length;
    if (numbered.length && bare) throw new Error('D1 shim: a statement must not mix ? and ?N placeholders');
    if (numbered.length) {
      const distinct = [...new Set(numbered)].sort((a, b) => a - b);
      if (distinct.some((value, index) => value !== index + 1)) {
        throw new Error(`D1 shim: ?N placeholders must cover 1..${distinct.length} without gaps (${distinct.join(',')})`);
      }
    }
    const occurrences = numbered.length ? numbered : null;
    const flat = occurrences ? query.replace(/\?\d+/g, '?') : query;
    return new D1Statement(this.db, flat, query, occurrences);
  }

  async batch(statements) {
    const out = [];
    for (const statement of statements) out.push(await statement.all());
    return { results: out, success: true };
  }
}

class D1Statement {
  constructor(database, flat, original, occurrences) {
    this.database = database;
    this.flat = flat;
    this.original = original;
    this.occurrences = occurrences;         // ?N → bind() index, so repeats work
    this.params = [];
  }

  bind(...values) {
    this.params = values;
    return this;
  }

  /** node:sqlite binds positionally, so ?N is expanded per occurrence. */
  args() {
    const bound = this.occurrences
      ? this.occurrences.map((n) => normalise([this.params[n - 1]])[0])
      : normalise(this.params);
    return bound;
  }

  async all() {
    sqlLog.push(this.original);
    const rows = this.database.prepare(this.flat).all(...this.args());
    return { results: rows.map(fromSqlite), success: true, meta: { changed: 0 } };
  }

  async first() {
    sqlLog.push(this.original);
    const row = this.database.prepare(this.flat).get(...this.args());
    return row === undefined ? null : fromSqlite(row);
  }

  async run() {
    sqlLog.push(this.original);
    const info = this.database.prepare(this.flat).run(...this.args());
    return { success: true, meta: { changes: Number(info.changes ?? 0), last_read_row_id: Number(info.lastInsertRowid ?? 0) } };
  }
}

function normalise(values) {
  return values.map((value) => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) return new Uint8Array(value);
    return value;
  });
}

/** node:sqlite returns BigInt for COUNT(*); the app must always see plain numbers. */
function fromSqlite(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) out[key] = typeof value === 'bigint' ? Number(value) : value;
  return out;
}

/* ---------------------------------- R2 ---------------------------------- */
class R2 {
  constructor(name) {
    this.name = name;
    this.store = new Map();
  }

  async put(key, value, options = {}) {
    const bytes = await toBytes(value);
    this.store.set(String(key), { bytes, options, uploadedAt: new Date() });
    return { key: String(key), size: bytes.byteLength };
  }

  async get(key) {
    const entry = this.store.get(String(key));
    if (!entry) return null;
    const { bytes, options } = entry;
    return {
      key: String(key),
      size: bytes.byteLength,
      httpMetadata: options.httpMetadata || {},
      customMetadata: options.customMetadata || {},
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      text: async () => new TextDecoder().decode(bytes),
      body: new Response(bytes).body,
    };
  }

  async head(key) {
    const entry = this.store.get(String(key));
    return entry ? { key: String(key), size: entry.bytes.byteLength } : null;
  }

  async delete(key) {
    this.store.delete(String(key));
  }

  async list({ prefix = '', limit = 1000 } = {}) {
    const objects = [];
    for (const [key, entry] of this.store) {
      if (!key.startsWith(prefix)) continue;
      if (objects.length >= limit) break;
      objects.push({ key, size: entry.bytes.byteLength });
    }
    return { objects, truncated: [], delimitedPrefixes: [] };
  }
}

async function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value && typeof value.arrayBuffer === 'function') {
    const blob = await value.arrayBuffer();
    return new Uint8Array(blob);
  }
  return new Uint8Array(0);
}

/* --------------------------------- env ---------------------------------- */
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(await readFile(path.join(ROOT, 'src/db/schema.sql'), 'utf8'));

const bucket = new R2('fly-dragon-uploads');

export const env = {
  DB: new D1(sqlite),
  UPLOADS: bucket,
  R2: bucket,
  AI: null,                       // provider double speaks the OpenAI protocol
  JWT_SECRET: 'harness-jwt-secret-32-bytes-long!!!',
  MCP_ENCRYPTION_KEY: 'harness-mcp-encryption-32-bytes!!',
  OPENAI_API_KEY: 'sk-harness-not-real',
  OPENAI_BASE: 'http://127.0.0.1:0/v1',            // rewritten by start()
  // Mail is captured by the same local double so the reset link can be followed for real.
  RESEND_API_KEY: 're-harness-not-real',
  RESEND_ENDPOINT: 'http://127.0.0.1:0/emails',    // rewritten by start()
  PUBLIC_ORIGIN: 'http://127.0.0.1:0',            // rewritten by start()
  ADDITIONAL_ORIGINS: '',                          // rewritten by start()
  STORAGE_LIMIT_BYTES: String(1024 * 1024 * 1024),
  CHAT_RATE_LIMIT: '500',
  IMAGE_RATE_LIMIT: '500',
  LOGIN_RATE_LIMIT: '400',
  SIGNUP_RATE_LIMIT: '400',
  FORGOT_RATE_LIMIT: '400',
  UPLOAD_RATE_LIMIT: '400',
  TOOL_TIMEOUT_MS: '12000',
  HISTORY_LIMIT: '200',
  R2_BUCKET_NAME: 'fly-dragon-uploads',
};

/** Serve over real HTTP so the browser suite can drive it exactly like Workers would. */
export const httpServer = http.createServer(async (req, res) => {
  const local = `http://127.0.0.1:${httpServer.address()?.port || 0}`;
  const target = new URL(req.url || '/', local);

  if (req.method === 'GET' && (target.pathname === '/' || target.pathname === '/index.html')) {
    const html = await readFile(path.join(ROOT, 'test/fixture/index.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    return res.end(html.replace('http://127.0.0.1:0', local));
  }
  if (req.method === 'GET' && target.pathname === '/chat.js') {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
    return res.end(await readFile(path.join(ROOT, 'public/chat.js'), 'utf8'));
  }

  const chunks = [];
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    for await (const chunk of req) chunks.push(chunk);
  }

  const request = new Request(`${local}${target.pathname}${target.search}`, {
    method: req.method,
    headers: new Headers(Object.entries(req.headers)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)])),
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });

  try {
    const response = await app.fetch(request, env, { waitUntil() {}, passThroughOnException() {} });
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error('[harness] request crashed:', err && err.stack ? err.stack : err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'harness_crash', message: String(err && err.message) }));
  }
});

let providerServer = null;

export async function start() {
  providerServer = await startProvider(0);
  const provider = providerServer;
  const providerPort = provider.address().port;
  const providerBase = `http://127.0.0.1:${providerPort}`;
  env.OPENAI_BASE = `${providerBase}/v1`;
  env.RESEND_ENDPOINT = `${providerBase}/emails`;
  env.MCP_DOUBLE_URL = `${providerBase}/mcp`;

  await new Promise((resolve) => httpServer.listen(FIXED_PORT, '127.0.0.1', resolve));
  const port = httpServer.address().port;
  env.PUBLIC_ORIGIN = `http://127.0.0.1:${port}`;
  env.ADDITIONAL_ORIGINS = `http://127.0.0.1:${port},http://localhost:${port}`;

  return { port, providerPort, providerBase, provider, env, sqlite, bucket, sqlLog, httpServer };
}

export function cookieOf(response) {
  const raw = response.headers.get('set-cookie') || '';
  return raw.split(/,(?=[^;]+?=)/).map((part) => part.split(';')[0]).join('; ');
}

export async function stop() {
  await new Promise((resolve) => httpServer.close(resolve));
  if (providerServer) await new Promise((resolve) => providerServer.close(resolve));
  sqlite.close();
}

export function providerUrl(info, route = '') {
  return `${info.providerBase}${route}`;
}
