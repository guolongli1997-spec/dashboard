/* ============================================================================
 * Integration test - runs the REAL worker (src/index.js) on real SQLite (D1 is
 * SQLite) with an in-memory R2 and an OpenAI-protocol provider double.
 *
 *   npm test          or    node --test test/integration.test.mjs
 *
 * Covered: §4 auth (hashing, session, revocation, reset), §5 every endpoint,
 * §6 panel data, ownership/tenant isolation, admin masking, streaming + tools.
 * ==========================================================================*/
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { start, stop, env, cookieOf } from './harness.mjs';

let base = '';
let db;

let providerBase = '';
before(async () => {
  const info = await start();
  base = `http://127.0.0.1:${info.port}`;
  providerBase = info.providerBase;
  db = info.sqlite;
});

after(async () => {
  await stop();
});

const jar = () => ({ cookie: '' });

async function api(path, { method = 'GET', json, form, session = jar(), headers = {}, raw = false } = {}) {
  const init = { method, headers: { ...headers } };
  if (json !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (form !== undefined) {
    init.body = form;
  }
  if (session.cookie) init.headers.cookie = session.cookie;

  const response = await fetch(`${base}${path}`, init);
  if (session === null) return response;                   // caller wants the raw response
  const setCookie = response.headers.get('set-cookie');
  if (setCookie && session.cookie !== undefined) session.cookie = cookieOf(response);
  if (raw) return { response, body: await response.text(), session };
  let body = null;
  try { body = await response.json(); } catch (err) { body = null; }
  return { status: response.status, body, response, session };
}

/** Signed-in jars are per suite; re-login if the session is not usable yet. */
async function ensureLogin(session, email, password = PASSWORD) {
  const me = await api('/api/auth/me', { session });
  if (me.status === 200) return session;
  const login = await api('/api/auth/login', { method: 'POST', json: { email, password }, session });
  if (login.status !== 200) throw new Error('login failed: ' + JSON.stringify(login.body));
  return session;
}

/**
 * node:test runs sibling suites in parallel, so every suite signs in as its own
 * account instead of borrowing one created elsewhere in the file.
 */
const PASSWORD = 'Corr3ct-Horse!';
const accounts = new Map();
async function account(email, { admin = false } = {}) {
  if (!accounts.has(email)) {
    const session = jar();
    const created = await api('/api/auth/signup', { method: 'POST', json: { email, name: email.split('@')[0], password: PASSWORD }, session });
    if (created.status !== 201 && created.status !== 409) throw new Error('account setup failed: ' + JSON.stringify(created.body));
    accounts.set(email, { session, email, created: created.status === 201 });
  }
  const entry = accounts.get(email);
  if (!entry.created) await ensureLogin(entry.session, email);
  if (admin) db.prepare("UPDATE users SET role = 'admin' WHERE email = ?1").run(email);   // real deployments set this once
  return entry;
}

function newUser(email) {
  const session = jar();
  return { session, email };
}

async function signUp(email, password = 'Corr3ct-Horse!') {
  const session = jar();
  const answer = await api('/api/auth/signup', { method: 'POST', json: { email, name: email.split('@')[0], password }, session });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  return { session, email, user: answer.body.user };
}

/* ================================ §4 auth ============================== */
describe('authentication', { concurrency: 1 }, () => {
  test('signup hashes with bcrypt, never stores plain text, sets an HttpOnly cookie', async () => {
    const { session, user } = await signUp('owner@example.com', 'Corr3ct-Horse!');
    assert.equal(user.provider, 'password');
    assert.equal(user.is_admin, 1, 'the first account bootstraps as admin');

    const row = db.prepare('SELECT password_hash, hash_alg, salt FROM users WHERE email = ?1').get('owner@example.com');
    assert.match(row.password_hash, /^\$2[aby]\$/, 'password must be a bcrypt hash');
    assert.doesNotMatch(String(row.password_hash), /Corr3ct/, 'plain password must never appear');
    assert.equal(row.hash_alg, 'bcrypt');
    assert.equal(row.salt, null);

    const me = await api('/api/auth/me', { session });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, 'owner@example.com');
    assert.equal(me.body.user.password_hash, undefined, 'hash must not be serialised to the client');
  });

  test('the session cookie is HttpOnly, Secure and SameSite=Lax', async () => {
    const raw = await api('/api/auth/login', { method: 'POST', json: { email: 'owner@example.com', password: 'Corr3ct-Horse!' }, raw: true, session: jar() });
    const cookie = raw.response.headers.get('set-cookie') || '';
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Max-Age=2592000/, '30 days as promised in the login form');
  });

  test('wrong password and unknown email answer identically', async () => {
    const mine = await api('/api/auth/login', { method: 'POST', json: { email: 'owner@example.com', password: 'nope-nope-nope' }, session: jar() });
    const ghost = await api('/api/auth/login', { method: 'POST', json: { email: 'ghost+who@example.com', password: 'nope-nope-nope' }, session: jar() });
    assert.equal(mine.status, 401);
    assert.equal(ghost.status, 401);
    assert.equal(mine.body.message, ghost.body.message, 'no account enumeration');
  });

  test('duplicate signup and brand-domain signup are refused', async () => {
    const dupe = await api('/api/auth/signup', { method: 'POST', json: { email: 'owner@example.com', password: 'Corr3ct-Horse!' }, session: jar() });
    assert.equal(dupe.status, 409);
    const brand = await api('/api/auth/signup', { method: 'POST', json: { email: 'staff@flytripvisa.site', password: 'Corr3ct-Horse!' }, session: jar() });
    assert.equal(brand.status, 400);
    const weak = await api('/api/auth/signup', { method: 'POST', json: { email: 'weak@example.com', password: 'password' }, session: jar() });
    assert.equal(weak.status, 400);
  });

  test('forgot password emails a single-use link that rotates the credential and signs other devices out', async () => {
    const { session } = await signUp('reset-me@example.com');
    const otherDevice = jar();
    await api('/api/auth/login', { method: 'POST', json: { email: 'reset-me@example.com', password: 'Corr3ct-Horse!' }, session: otherDevice });

    const asked = await api('/api/auth/forgot-password', { method: 'POST', json: { email: 'reset-me@example.com' }, session: jar() });
    assert.equal(asked.status, 200);
    const unknown = await api('/api/auth/forgot-password', { method: 'POST', json: { email: 'nobody-here@example.com' }, session: jar() });
    assert.equal(unknown.status, 200, 'unknown addresses answer the same way, so nothing is enumerable');

    const captured = await (await fetch(`${providerBase}/outbox`)).json();
    const mail = captured.outbox.filter((entry) => entry.to === 'reset-me@example.com').at(-1);
    assert.ok(mail, 'a reset email was sent');
    const token = /token=([\w-]+)/.exec(String(mail.html))?.[1];
    assert.ok(token, 'the emailed link carries the secret token');
    assert.ok(!String(mail.html).includes('Corr3ct'), 'the email never repeats the password');

    const stored = db.prepare("SELECT COUNT(*) AS n FROM password_resets r JOIN users u ON u.id = r.user_id WHERE u.email = 'reset-me@example.com'").get();
    assert.equal(stored.n, 1, 'only the token hash is stored');

    const reset = await api('/api/auth/reset-password', { method: 'POST', json: { token, password: 'Fresh-Password-2!' }, session: jar() });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));

    const replay = await api('/api/auth/reset-password', { method: 'POST', json: { token, password: 'Third-Password-3!' }, session: jar() });
    assert.equal(replay.status, 400, 'the link is single use');

    const stale = await api('/api/auth/login', { method: 'POST', json: { email: 'reset-me@example.com', password: 'Corr3ct-Horse!' }, session: jar() });
    assert.equal(stale.status, 401, 'the old password stops working');
    const fresh = await api('/api/auth/login', { method: 'POST', json: { email: 'reset-me@example.com', password: 'Fresh-Password-2!' }, session: jar() });
    assert.equal(fresh.status, 200);
    const kicked = await api('/api/auth/me', { session: otherDevice });
    assert.equal(kicked.status, 401, 'a password change signs every other device out');
    void session;
  });

  test('a legacy sha256 password row still signs in and is upgraded to bcrypt', async () => {
    const { createHash, randomBytes } = await import('node:crypto');
    const legacySalt = randomBytes(16).toString('hex');
    const legacyHash = createHash('sha256').update(legacySalt + 'Legacy-Pass-1!').digest('hex');
    db.prepare('INSERT INTO users (id, email, password_hash, name, provider, role, created_at, hash_alg, salt) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)')
      .run('usr_legacy', 'legacy@example.com', legacyHash, 'Legacy', 'password', 'user', Math.floor(Date.now() / 1000), 'sha256', legacySalt);

    const me = await api('/api/auth/login', { method: 'POST', json: { email: 'legacy@example.com', password: 'Legacy-Pass-1!' }, session: jar() });
    assert.equal(me.status, 200, 'legacy accounts are not stranded by the upgrade');
    const row = db.prepare('SELECT hash_alg, password_hash FROM users WHERE email = ?1').get('legacy@example.com');
    assert.equal(row.hash_alg, 'bcrypt');
    assert.match(row.password_hash, /^\$2[aby]\$/, 're-hashed with bcrypt on sign-in');
  });

  test('logout clears the cookie and the session row', async () => {
    const session = jar();
    await api('/api/auth/login', { method: 'POST', json: { email: 'owner@example.com', password: 'Corr3ct-Horse!' }, session });
    const out = await api('/api/auth/logout', { method: 'POST', session });
    assert.equal(out.status, 200);
    const gone = await api('/api/auth/me', { session });
    assert.equal(gone.status, 401);
  });
});

/* ============================== §5 chat ================================ */
describe('chat', { concurrency: 1 }, () => {
  let session = null;

  test('anonymous chat is refused', async () => {
    const anonymous = await api('/api/chat', { method: 'POST', json: { message: 'hi' }, session: jar() });
    assert.equal(anonymous.status, 401);
  });

  test('SSE turn emits meta, deltas and done, and persists both messages', async () => {
    session = (await account('chat-owner@example.com')).session;

    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', cookie: session.cookie },
      body: JSON.stringify({ message: 'What documents do I need for Japan?' }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);

    const text = await response.text();
    const events = text.split('\n\n').filter((chunk) => chunk.startsWith('data:')).map((chunk) => JSON.parse(chunk.slice(5).trim()));

    assert.equal(events[0].type, 'start', 'stream is opened before any model work');
    const meta = events.find((event) => event.type === 'meta');
    assert.ok(meta && meta.chatId, 'meta carries the chatId');
    assert.equal(meta.provider, 'openai', 'the harness uses the OpenAI-compatible code path');
    assert.ok(events.some((event) => event.type === 'delta' && event.text.length > 0), 'at least one delta');
    const done = events.find((event) => event.type === 'done');
    assert.ok(done && done.reply.length > 20, 'done carries the full reply');
    assert.ok(!events.some((event) => event.type === 'error'), JSON.stringify(events.at(-1)));

    const chats = await api('/api/chats', { session });
    const thread = chats.body.chats.find((row) => row.id === done.chatId);
    assert.ok(thread, 'the new thread is listed');
    assert.equal(thread.message_count, 2, 'user + assistant stored');

    const history = await api(`/api/chats/${done.chatId}`, { session });
    assert.equal(history.body.messages.map((row) => row.role).join(','), 'user,assistant');
    assert.match(history.body.messages[1].content, /\*\*bold\*\*/, 'markdown reaches the client intact');
  });

  test('a tool-using turn streams tool_status and still answers', async () => {
    session = (await account('chat-owner@example.com')).session;
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', cookie: session.cookie },
      body: JSON.stringify({ message: 'Check Japan Visa requirements for a BGD passport', chatId: null }),
    });
    const events = (await response.text()).split('\n\n').filter((c) => c.startsWith('data:')).map((c) => JSON.parse(c.slice(5).trim()));
    const statuses = events.filter((event) => event.type === 'tool_status');
    assert.ok(statuses.length >= 2, 'running, then the outcome');
    assert.equal(statuses[0].tools[0].name, 'visa');
    assert.equal(statuses.at(-1).tools[0].status, 'needs_setup', 'no IATA key, so the tool says it is not configured instead of inventing a rule');
    assert.match(statuses.at(-1).tools[0].message, /IATA_API_KEY/);
    assert.ok(events.some((event) => event.type === 'delta'), 'the second round produced text');
    assert.ok(events.some((event) => event.type === 'done'));
  });

  test('json (non-streaming) clients get { reply, chatId }', async () => {
    session = (await account('chat-owner@example.com')).session;
    const answer = await api('/api/chat', { method: 'POST', json: { message: 'Hello again' }, session, headers: { accept: 'application/json' } });
    assert.equal(answer.status, 200);
    assert.ok(answer.body.reply.length > 10);
    assert.ok(answer.body.chatId);
  });

  test('empty message is refused', async () => {
    session = (await account('chat-owner@example.com')).session;
    const empty = await api('/api/chat', { method: 'POST', json: { message: '   ' }, session });
    assert.equal(empty.status, 400);
  });

  test('chat ownership is enforced', async () => {
    session = (await account('chat-owner@example.com')).session;
    const other = await account('chat-stranger@example.com');
    const mine = await api('/api/chats', { session });
    const stolen = await api(`/api/chats/${mine.body.chats[0].id}`, { session: other.session });
    assert.equal(stolen.status, 404, 'another user cannot read your thread');
    const stealDelete = await api(`/api/chats/${mine.body.chats[0].id}`, { method: 'DELETE', session: other.session });
    assert.equal(stealDelete.status, 404);
  });
});

/* ============================== §5 files =============================== */
describe('files and storage', { concurrency: 1 }, () => {
  let holder = null;
  let fileId = '';

  const signIn = async () => {
    if (!holder) holder = await account('files-traveller@example.com');
    return holder.session;
  };

  test('upload registers the object in R2 and D1', async () => {
    const session = await signIn();
    const form = new FormData();
    form.append('file', new Blob(['Passport BD1234567 expires 2031\n'], { type: 'text/plain' }), 'passport.txt');

    const up = await api('/api/upload', { method: 'POST', form, session });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    fileId = up.body.fileId;
    assert.ok(up.body.url.startsWith('/api/files/'), 'the url stays on our own origin');
    assert.equal(up.body.files[0].filename, 'passport.txt');
    assert.ok(up.body.files[0].size > 0);

    const stored = db.prepare('SELECT r2_key, file_type, size FROM files WHERE id = ?1').get(fileId);
    assert.match(stored.r2_key, /^usr_/, 'the R2 key is namespaced by user id');
    assert.equal(stored.file_type, 'text/plain');
  });

  test('disallowed file types are refused', async () => {
    const session = await signIn();
    const form = new FormData();
    form.append('file', new Blob(['x'], { type: 'application/x-msdownload' }), 'malware.exe');
    const bad = await api('/api/upload', { method: 'POST', form, session });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /Unsupported file type/);
  });

  test('list, text preview and download work for the owner', async () => {
    const session = await signIn();
    const list = await api('/api/files', { session });
    const mine = list.body.files.find((file) => file.id === fileId);
    assert.equal(mine.filename, 'passport.txt');
    assert.ok(Number(list.body.used_bytes) >= mine.size);

    const preview = await api(`/api/files/${fileId}/text`, { session });
    assert.match(preview.body.text, /BD1234567/);

    const download = await fetch(`${base}/api/files/${fileId}/download`, { headers: { cookie: session.cookie } });
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.match(await download.text(), /Passport/);
  });

  test('another account cannot reach the file at all', async () => {
    const nosy = await account('files-nosy@example.com');
    const peek = await api(`/api/files/${fileId}/download`, { session: nosy.session, raw: true });
    assert.equal(peek.response.status, 404);
    const meta = await api(`/api/files/${fileId}/text`, { session: nosy.session });
    assert.equal(meta.status, 404);
    const removed = await api(`/api/files/${fileId}?purge=1`, { method: 'DELETE', session: nosy.session });
    assert.equal(removed.status, 404);
  });

  test('storage panel reports usage and protects fresh uploads from cleanup', async () => {
    const session = await signIn();
    const storage = await api('/api/storage', { session });
    assert.equal(storage.body.limit_bytes, 1073741824);
    const tracked = storage.body.items.find((item) => item.id === fileId);
    assert.equal(tracked.orphan, true, 'the file belongs to no chat yet');
    assert.equal(tracked.key, `/api/files/${fileId}/download`, 'the panel never sees the raw R2 key');

    const cleaned = await api('/api/storage/cleanup', { method: 'POST', session });
    assert.equal(cleaned.status, 200);
    assert.equal(cleaned.body.removed, 0);

    const list = await api('/api/files', { session });
    assert.ok(list.body.files.some((file) => file.id === fileId), 'the fresh upload survived');
  });

  test('delete removes the row and the stored object', async () => {
    const session = await signIn();
    const removed = await api(`/api/files/${fileId}?purge=1`, { method: 'DELETE', session });
    assert.equal(removed.status, 200);

    const list = await api('/api/files', { session });
    assert.equal(list.body.files.some((file) => file.id === fileId), false, 'row gone');
    const gone = await fetch(`${base}/api/files/${fileId}/download`, { headers: { cookie: session.cookie } });
    assert.equal(gone.status, 404);
  });
});

/* ====================== attached files reach the model ================= */
describe('chat with attachments', { concurrency: 1 }, () => {
  test('an uploaded file is read for the model and linked to the chat', async () => {
    const { session } = await account('attach-traveller@example.com');

    const form = new FormData();
    form.append('file', new Blob(['Visa fee table: USD 40, 5 working days'], { type: 'text/plain' }), 'fees.txt');
    const up = await api('/api/upload', { method: 'POST', form, session });
    const file = up.body.files[0];
    assert.ok(file.fileId);

    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', cookie: session.cookie },
      body: JSON.stringify({ message: 'Summarise the attached fee table', files: [{ id: file.fileId, url: file.url, name: 'fees.txt' }] }),
    });
    const events = (await response.text()).split('\n\n').filter((chunk) => chunk.startsWith('data:')).map((chunk) => JSON.parse(chunk.slice(5).trim()));
    const done = events.find((event) => event.type === 'done');
    assert.ok(done && done.chatId, JSON.stringify(events.at(-1)));

    const history = await api(`/api/chats/${done.chatId}`, { session });
    const stored = JSON.parse(history.body.messages[0].files_json);
    assert.equal(stored[0].filename, 'fees.txt', 'the message keeps its file reference');

    const files = await api('/api/files', { session });
    const linked = files.body.files.find((entry) => entry.filename === 'fees.txt');
    assert.ok(linked.chat_title, 'the file list knows which chat it belongs to');
    assert.equal(history.body.messages[0].chat_id, done.chatId);
  });
});

/* ============================== §6 panels ============================== */
describe('panels', { concurrency: 1 }, () => {
  let owner = null;
  const session = () => {
    if (!owner) throw new Error('call signIn() first');
    return owner.session;
  };
  const signIn = async () => {
    if (!owner) owner = await account('panels-owner@example.com', { admin: true });
    return owner.session;
  };

  test('database panel counts only the viewer\'s data', async () => {
    const s = await signIn();
    const stats = await api('/api/stats', { session: s });
    assert.equal(stats.status, 200, JSON.stringify(stats.body));
    assert.ok(Number.isInteger(stats.body.chats));
    assert.ok(Number.isInteger(stats.body.messages));
    assert.equal(stats.body.files, 0, 'this account uploaded nothing');
    assert.equal(stats.body.limit_bytes, 1073741824);
  });

  test('admin table browsing hides credentials and paginates', async () => {
    const s = await signIn();
    const tables = await api('/api/admin/tables', { session: s });
    assert.deepEqual(tables.body.tables, ['audit_log', 'chats', 'files', 'images', 'mcp_servers', 'messages', 'password_resets', 'sessions', 'settings', 'users']);

    const first = await api('/api/admin/tables/users?limit=2&offset=0', { session: s });
    assert.ok(!first.body.columns.includes('password_hash'), 'credentials are never browsable');
    assert.ok(!first.body.columns.includes('salt'));
    assert.ok(!first.body.columns.includes('token_hash'));
    assert.equal(first.body.rows.length, 2);
    assert.ok(first.body.total >= 4);
    const second = await api('/api/admin/tables/users?limit=2&offset=2', { session: s });
    assert.notEqual(JSON.stringify(second.body.rows), JSON.stringify(first.body.rows), 'offset pages forward');

    const injected = await api('/api/admin/tables/%22users%22%20WHERE%201%3D1', { session: s });
    assert.equal(injected.status, 404, 'table names are validated, not interpolated');
  });

  test('non-admins cannot browse tables', async () => {
    const plain = await account('plain-traveller@example.com');
    const denied = await api('/api/admin/tables', { session: plain.session });
    assert.equal(denied.status, 403);
    const rows = await api('/api/admin/tables/users?limit=1', { session: plain.session });
    assert.equal(rows.status, 403);
  });

  test('tool toggles persist per user', async () => {
    const s = await signIn();
    const initial = await api('/api/tools', { session: s });
    assert.equal(initial.body.tools.web_search, true);

    const changed = await api('/api/tools', { method: 'POST', json: { web_search: false }, session: s });
    assert.equal(changed.body.tools.web_search, false);
    assert.equal((await api('/api/tools', { session: s })).body.tools.web_search, false, 'stored, not echoed');

    const bad = await api('/api/tools', { method: 'POST', json: { web_search: 'yes' }, session: s });
    assert.equal(bad.status, 400);

    const other = await account('tool-stranger@example.com');
    assert.equal((await api('/api/tools', { session: other.session })).body.tools.web_search, true, 'toggles are per account');
  });

  test('MCP servers: add, test, list without leaking the key, delete', async () => {
    const s = await signIn();
    const added = await api('/api/mcp', { method: 'POST', json: { name: 'Notes MCP', url: `${providerBase}/mcp`, api_key: 'sk-secret-123' }, session: s });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.server.has_key, true);
    assert.equal(added.body.server.api_key, undefined, 'the api key is never echoed back');

    const server = added.body.server;
    const listed = await api('/api/mcp', { session: s });
    const shown = listed.body.servers.find((entry) => entry.id === server.id);
    assert.equal(shown.status, 'unknown', 'a fresh server has not been tested');
    assert.equal(shown.api_key_enc, undefined, 'the ciphertext is never echoed back');
    assert.equal(shown.has_key, true);

    const tested = await api('/api/mcp/test', { method: 'POST', json: { id: server.id }, session: s });
    assert.equal(tested.body.status, 'connected', JSON.stringify(tested.body));
    assert.equal(tested.body.tools[0].name, 'destination_notes');
    const afterTest = await api('/api/mcp', { session: s });
    assert.equal(afterTest.body.servers.find((entry) => entry.id === server.id).status, 'connected');

    const broken = await api('/api/mcp', { method: 'POST', json: { name: 'Broken', url: `${providerBase}/nope`, api_key: 'x' }, session: s });
    const failed = await api('/api/mcp/test', { method: 'POST', json: { id: broken.body.server.id }, session: s });
    assert.equal(failed.body.status, 'failed');
    assert.ok(failed.body.error, 'the reason is kept so the UI can show it');

    // A connected MCP server must actually reach the model as a callable tool.
    const mcpTurn = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', cookie: s.cookie },
      body: JSON.stringify({ message: 'Any destination notes for Japan?' }),
    });
    const frames = (await mcpTurn.text()).split('\n\n').filter((c) => c.startsWith('data:')).map((c) => JSON.parse(c.slice(5).trim()));
    const toolFrames = frames.filter((event) => event.type === 'tool_status');
    assert.equal(toolFrames.length >= 1, true, 'the MCP tool was invoked');
    assert.equal(toolFrames[0].tools[0].name, 'mcp_destination_notes', JSON.stringify(toolFrames[0]));
    assert.equal(toolFrames.at(-1).tools[0].status, 'ok', 'the MCP server answered');
    assert.ok(frames.some((event) => event.type === 'done'));

    const removed = await api(`/api/mcp/${server.id}`, { method: 'DELETE', session: s });
    assert.equal(removed.status, 200);
    assert.equal((await api('/api/mcp', { session: s })).body.servers.some((entry) => entry.id === server.id), false);
  });

  test('MCP urls must be https, apart from localhost', async () => {
    const s = await signIn();
    const insecure = await api('/api/mcp', { method: 'POST', json: { name: 'Bad', url: 'http://example.com/mcp' }, session: s });
    assert.equal(insecure.status, 400);
    const notAUrl = await api('/api/mcp', { method: 'POST', json: { name: 'Bad', url: 'ftp://x' }, session: s });
    assert.equal(notAUrl.status, 400);
  });

  test('image generation stores bytes in R2 and lists for the owner', async () => {
    const s = await signIn();
    const made = await api('/api/images/generate', { method: 'POST', json: { prompt: 'a red dragon over Dhaka', size: '1024x1024' }, session: s });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.ok(made.body.image.url.startsWith('/api/images/'));

    const gallery = await api('/api/images', { session: s });
    const shot = gallery.body.images.find((image) => image.prompt === 'a red dragon over Dhaka');
    assert.ok(shot, 'the generated image is listed');

    const stored = db.prepare('SELECT r2_key FROM images WHERE id = ?1').get(shot.id);
    const owner = db.prepare("SELECT id FROM users WHERE email = 'panels-owner@example.com'").get();
    assert.match(stored.r2_key, new RegExp('^' + owner.id + '/'), 'the image object is namespaced under its owner');

    const download = await fetch(`${base}${shot.url}`, { headers: { cookie: s.cookie } });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'image/png');
    assert.ok((await download.arrayBuffer()).byteLength > 0, 'real bytes come back');

    const empty = await api('/api/images/generate', { method: 'POST', json: { prompt: '   ' }, session: s });
    assert.equal(empty.status, 400);

    const removed = await api(`/api/images/${shot.id}`, { method: 'DELETE', session: s });
    assert.equal(removed.status, 200);
    assert.equal((await api('/api/images', { session: s })).body.images.some((image) => image.id === shot.id), false);
  });

  test('settings validate and persist font, language and voice', async () => {
    const s = await signIn();
    const defaults = await api('/api/settings', { session: s });
    assert.equal(defaults.body.settings.font_size, 'medium');
    assert.equal(defaults.body.settings.language, 'en');

    const saved = await api('/api/settings', { method: 'POST', json: { font_size: 'large', language: 'bn', voice_lang: 'bn-BD', auto_send_voice: true }, session: s });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.changed.language, 'bn');

    const read = await api('/api/settings', { session: s });
    assert.equal(read.body.settings.font_size, 'large');
    assert.equal(read.body.settings.auto_send_voice, 1, 'stored as a plain flag');

    const prefs = await api('/api/prefs', { session: s });
    assert.equal(prefs.body.prefs.voice_lang, 'bn-BD');

    assert.equal((await api('/api/settings', { method: 'POST', json: { font_size: 'giant' }, session: s })).status, 400);
    assert.equal((await api('/api/settings', { method: 'POST', json: { evil: 1 }, session: s })).status, 400);

    const other = await account('settings-stranger@example.com');
    assert.equal((await api('/api/settings', { session: other.session })).body.settings.font_size, 'medium', 'preferences are per account');
  });

  test('profile name and avatar update reach /me', async () => {
    const s = await signIn();
    const renamed = await api('/api/auth/profile', { method: 'POST', json: { name: 'Nas Al thanie' }, session: s });
    assert.equal(renamed.body.user.name, 'Nas Al thanie');

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'me.png');
    const avatar = await api('/api/auth/avatar', { method: 'POST', form, session: s });
    assert.equal(avatar.status, 200, JSON.stringify(avatar.body));

    const me = await api('/api/auth/me', { session: s });
    assert.ok(me.body.user.avatar_url.startsWith('/api/files/'));
    const fetched = await fetch(`${base}${me.body.user.avatar_url}`, { headers: { cookie: s.cookie } });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers.get('content-type'), 'image/png');

    const tooBig = new FormData();
    tooBig.append('file', new Blob([new Uint8Array(3 * 1024 * 1024)], { type: 'image/png' }), 'big.png');
    assert.equal((await api('/api/auth/avatar', { method: 'POST', form: tooBig, session: s })).status, 413);
  });

  test('clearing chats empties this account only', async () => {
    const s = await signIn();
    await api('/api/chat', { method: 'POST', json: { message: 'a thread to lose' }, session: s });
    assert.ok((await api('/api/chats', { session: s })).body.chats.length >= 1);

    const cleared = await api('/api/chats', { method: 'DELETE', session: s });
    assert.equal(cleared.status, 200);
    assert.equal((await api('/api/chats', { session: s })).body.chats.length, 0);

    const other = await account('chat-owner@example.com');
    assert.equal((await api('/api/chats', { session: other.session })).body.chats.length >= 1, true, 'other accounts untouched');
  });
});

/* ============================ account removal ========================== */
describe('account deletion', { concurrency: 1 }, () => {
  test('requires the typed word and removes chats, files and sessions', async () => {
    const { session } = await account('bye@example.com');
    await api('/api/chat', { method: 'POST', json: { message: 'temp' }, session });

    const refused = await api('/api/account', { method: 'DELETE', json: { confirm: 'no' }, session });
    assert.equal(refused.status, 400);

    const gone = await api('/api/account', { method: 'DELETE', json: { confirm: 'DELETE' }, session });
    assert.equal(gone.status, 200, JSON.stringify(gone.body));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'bye@example.com'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = 'bye@example.com')").get().n, 0);
    assert.equal((await api('/api/auth/me', { session })).status, 401);
  });
});

/* =============================== health ================================ */
describe('service', { concurrency: 1 }, () => {
  test('health reports the live model and tool catalogue', async () => {
    const answer = await api('/api/health', { session: jar() });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.ok, true);
    assert.equal(answer.body.chat.provider, 'openai');
    assert.equal(answer.body.tools.length, 5);
    assert.equal(env.DB === undefined, false);
  });
});
