/* ============================================================================
 * Chat routes - real model calls, D1 persistence, SSE streaming, tool loop.
 *   POST   /api/chat            { message, chatId, files[] } -> stream | json
 *   GET    /api/chats                                        -> user's chats
 *   GET    /api/chats/:id                                   -> one chat + messages
 *   DELETE /api/chats/:id                                   -> remove one chat
 *   DELETE /api/chats                                        -> clear all (Settings)
 *   POST   /api/chat/stop                                   -> stop a generation
 * ==========================================================================*/
import { Hono } from 'hono';

import { clamp, jsonError, nowSec, rateLimit, requireAuth, titleFrom, uid } from '../lib/http.js';
import { buildSystemPrompt, currentModel, streamTurn } from '../lib/ai.js';
import { buildToolset } from '../lib/tools.js';
import { streamSSE } from '../lib/sse.js';
import { enabledMcpServers } from '../lib/mcp.js';
import {
  attachFilesToChat, audit, deleteAllChats, deleteChat, findChat, insertChat, insertMessage,
  listChats, listMessages, readSettings, touchChat,
} from '../lib/db.js';
import { extractText } from '../lib/store.js';

const chat = new Hono();
chat.use('*', requireAuth);

const HISTORY_TURNS = 12;              // pairs handed to the model
const TOOL_ROUNDS = 3;                 // model -> tools -> model cycles per answer
const ANSWER_TIMEOUT_MS = 90000;

/* ------------------------------- POST /chat ----------------------------- */
chat.post('/chat', async (c) => {
  const user = c.get('user');
  const limited = await rateLimit(c, { limit: Number(c.env.CHAT_RATE_LIMIT || 20), windowSec: 60, scope: 'chat', by: user.id });
  if (limited) return jsonError(c, 429, 'rate_limited', 'You are sending very fast. Please wait a moment.');
  if (!c.env.AI && !c.env.OPENAI_API_KEY) {
    return jsonError(c, 503, 'model_unconfigured', 'No model is connected. Bind the AI block in wrangler.toml or set OPENAI_API_KEY.');
  }

  const body = await readJson(c);
  const message = String(body.message ?? '').trim().slice(0, 12000);
  const files = await ownedFiles(c, body.files);
  if (!message && !files.length) return jsonError(c, 400, 'empty_message', 'Type something, or attach a file first.');

  const chatRow = await resolveChat(c, user.id, body.chatId, message, files);

  const prefs = await readSettings(c.env.DB, user.id);
  const mcpServers = await enabledMcpServers(c, user.id);
  const toolset = buildToolset(c.env, prefs, mcpServers);

  // Store the question before answering so a dropped connection cannot lose it.
  await insertMessage(c.env.DB, {
    id: uid('msg'), chat_id: chatRow.id, role: 'user',
    content: message || describeFiles(files), files, created_at: nowSec(),
  });
  await attachFilesToChat(c.env.DB, chatRow.id, user.id, files.map((file) => file.id));

  const history = await listMessages(c.env.DB, chatRow.id, HISTORY_TURNS * 2 + 1);
  const context = await fileContext(c, files);
  const messages = toModelMessages({
    system: buildSystemPrompt({ user, prefs, locale: c.req.header('accept-language') }),
    history,
    files,
    context,
  });

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), ANSWER_TIMEOUT_MS);
  const wantsSse = usesEventStream(c);
  const signal = mergeSignals(controller.signal, c.req.raw.signal);

  const run = async (send) => {
    let answer = '';
    let toolsCalled = 0;
    const meta = { chatId: chatRow.id, ...currentModel(c.env) };
    await send({ type: 'meta', ...meta });

    let turn = messages;
    for (let round = 0; round < TOOL_ROUNDS; round += 1) {
      if (signal.aborted) break;

      const pending = [];
      const result = await consumeTurn({
        env: c.env, messages: turn, toolset, signal, send, pending, c,
      });
      if (result.error) {
        await send({ type: 'error', error: result.error, code: result.code || 'model_error' });
        return;
      }
      answer += result.text;
      if (!result.toolCalls.length) break;

      toolsCalled += result.toolCalls.length;
      const followUp = await runToolRounds({ c, toolset, calls: result.toolCalls, send, assistantText: result.text, userMessage: turn });
      turn = followUp;
    }

    if (signal.aborted) {
      await send({ type: 'stopped', chatId: chatRow.id });
      return;
    }

    const finalText = (answer || '').trim()
      || 'I could not produce an answer this time. Please try again.';

    await insertMessage(c.env.DB, {
      id: uid('msg'), chat_id: chatRow.id, role: 'assistant',
      content: finalText, files: [], created_at: nowSec(),
    });
    await touchChat(c.env.DB, chatRow.id, nowSec());

    await audit(c.env.DB, user.id, 'chat.answer', `${finalText.length} chars, ${toolsCalled} tool(s)`);
    await send({ type: 'done', chatId: chatRow.id, reply: finalText, toolsUsed: toolsCalled });
  };

  if (wantsSse) {
    return streamSSE(async (send) => {
      try { await run(send); } finally { clearTimeout(deadline); }
    });
  }

  const collected = [];
  try {
    await run(async (event) => { collected.push(event); });
  } finally {
    clearTimeout(deadline);
  }
  const failure = collected.find((event) => event.type === 'error');
  if (failure) return jsonError(c, 502, failure.code || 'model_error', failure.error);
  const done = collected.find((event) => event.type === 'done') || {};
  return c.json({ reply: done.reply || 'I could not produce an answer this time.', chatId: chatRow.id });
});

/* --------------------------------- chats -------------------------------- */
chat.get('/chats', async (c) => {
  const rows = await listChats(c.env.DB, c.get('user').id, clamp(c.req.query('limit') || 50, 1, 100));
  return c.json({ chats: rows.map(toChatDto), total: rows.length });
});

chat.get('/chats/:id', async (c) => {
  const row = await findChat(c.env.DB, c.req.param('id'), c.get('user').id);
  if (!row) return jsonError(c, 404, 'chat_not_found', 'That conversation is not in your account.');
  const messages = await listMessages(c.env.DB, row.id, Number(c.env.HISTORY_LIMIT || 200));
  return c.json({ chat: toChatDto(row), messages: messages.map(toMessageDto) });
});

chat.delete('/chats/:id', async (c) => {
  const row = await findChat(c.env.DB, c.req.param('id'), c.get('user').id);
  if (!row) return jsonError(c, 404, 'chat_not_found', 'That conversation is not in your account.');
  await deleteChat(c.env.DB, row.id, c.get('user').id);
  await audit(c.env.DB, c.get('user').id, 'chat.delete', row.id);
  return c.json({ ok: true });
});

// Settings -> "Clear all chats". The destructive step is confirmed in the UI;
// the account-level delete is the one that additionally requires a typed word.
chat.delete('/chats', async (c) => {
  const user = c.get('user');
  await deleteAllChats(c.env.DB, user.id);
  await audit(c.env.DB, user.id, 'chat.delete_all', 'settings');
  return c.json({ ok: true });
});

/* ================================ helpers ================================ */
async function consumeTurn({ env, messages, toolset, signal, send, pending, c }) {
  let text = '';
  try {
    for await (const event of streamTurn({ env, messages, tools: toolset, signal })) {
      if (event.type === 'delta') {
        text += event.text;
        await send({ type: 'delta', text: event.text, response: event.text });    // response = older client compat
      } else if (event.type === 'tool') {
        pending.push(event);
      }
    }
    return { text, toolCalls: pending };
  } catch (err) {
    if (signal.aborted) return { text, toolCalls: [], aborted: true };
    console.error('[chat] model turn failed:', err && err.stack ? err.stack : err);
    return { text, toolCalls: [], error: friendly(err), code: err?.code || 'model_error' };
  }
}

/** Execute the model's tool calls, report status, append the OpenAI-shaped reply. */
async function runToolRounds({ c, toolset, calls, send, assistantText, userMessage }) {
  const results = [];
  for (const call of calls) {
    const tool = toolset.find((entry) => entry.name === call.name);
    if (!tool) {
      results.push({ id: call.id, name: call.name, ok: false, status: 'unknown_tool', output: 'That tool is not available.' });
      continue;
    }
    await send({ type: 'tool_status', tools: [{ name: call.name, status: 'running' }] });
    const outcome = await safeTool(c, tool, call);
    results.push({ id: call.id, name: call.name, ...outcome });
    await send({
      type: 'tool_status',
      tools: [{ name: call.name, status: outcome.ok ? 'ok' : (outcome.status || 'failed'), message: outcome.message || null }],
    });
  }

  return userMessage.concat(
    [{ role: 'assistant', content: assistantText || null, tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) } })) }],
    results.map((result) => ({ role: 'tool', tool_call_id: result.id, name: result.name, content: compact(result) })),
  );
}

async function safeTool(c, tool, call) {
  try {
    const output = await Promise.race([
      Promise.resolve(tool.run(call.arguments || {})),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), Number(c.env.TOOL_TIMEOUT_MS || 12000))),
    ]);
    return normaliseToolOutput(output);
  } catch (err) {
    console.warn('[chat] tool failed:', tool.name, err && err.message);
    return { ok: false, status: 'failed', message: err?.message || 'The lookup failed.' };
  }
}

function normaliseToolOutput(output) {
  if (!output || typeof output !== 'object') return { ok: false, status: 'failed', output: { note: 'empty result' } };
  if (output.ok === false) {
    return { ok: false, status: output.status || 'failed', message: output.message || output.error || 'No data returned.', output };
  }
  return { ok: true, status: 'ok', output };
}

const compact = (result) => JSON.stringify(result.ok ? (result.output ?? {}) : { status: result.status, message: result.message }).slice(0, 3500);

function friendly(err) {
  if (err?.code === 'model_rate_limited') return 'The model is rate limited right now. Please try again in a minute.';
  if (err?.httpStatus === 401 || err?.httpStatus === 403) return 'The model rejected our credentials. Check OPENAI_API_KEY or the AI binding.';
  if (String(err?.message || '').includes('timed out')) return 'The model took too long to answer. Please try again.';
  return err?.message || 'The model could not answer.';
}

/** Only files the requester owns may ride along with a message. */
async function ownedFiles(c, value) {
  if (!Array.isArray(value)) return [];
  const ids = [...new Set(value.map((file) => String(file?.id || '')).filter(Boolean))].slice(0, 8);
  const userId = c.get('user').id;
  const rows = await Promise.all(
    ids.map((id) => c.env.DB.prepare(
      'SELECT id, filename, file_type AS mime, size, url, r2_key, chat_id FROM files WHERE id = ?1 AND user_id = ?2',
    ).bind(id, userId).first()),
  );
  return rows.filter(Boolean);
}

/**
 * Gives the model what it can actually read: extracted text for documents, a
 * description for everything else. Never a fabricated summary of a file we could
 * not open.
 */
async function fileContext(c, files) {
  if (!files.length) return [];
  const bucket = c.env.UPLOADS || c.env.R2;
  return Promise.all(files.map(async (file) => {
    if (!bucket) return { file, text: null, note: 'Storage is not bound, so this file could not be read.' };
    try {
      const text = await extractText(bucket, file);
      if (text) return { file, text: text.slice(0, 12000), note: null };
    } catch (err) {
      console.warn('[chat] file extraction failed:', err && err.message);
    }
    return {
      file,
      text: null,
      note: file.mime && file.mime.startsWith('image/')
        ? 'An image was attached. Describe it and ask the visitor to confirm what they need.'
        : 'The text of this file could not be read. Ask the visitor to paste the important parts.',
    };
  }));
}

function describeFiles(files) {
  if (!files.length) return '';
  return files.length === 1 ? `(attached ${files[0].filename})` : `(attached ${files.length} files)`;
}

function toModelMessages({ system, history, files, context = [] }) {
  const turns = history.slice(-HISTORY_TURNS * 2).map((row) => ({ role: row.role, content: String(row.content || '') }));
  const last = turns[turns.length - 1];
  if (last && last.role === 'user' && files.length) {
    const blocks = context.map((entry) => {
      const head = `[file: ${entry.file.filename} | ${entry.file.mime || 'unknown'} | ${entry.file.url}]`;
      return entry.text ? `${head}\n---\n${entry.text}\n---` : `${head}\n${entry.note}`;
    });
    last.content += `\n\nAttached files:\n${blocks.join('\n\n')}`;
  }
  return [{ role: 'system', content: system }, ...turns];
}

async function resolveChat(c, userId, chatId, message, files) {
  const requested = String(chatId || '').trim();
  if (requested) {
    const existing = await findChat(c.env.DB, requested, userId);
    if (existing) return existing;
  }
  const row = {
    id: uid('chat'),
    user_id: userId,
    title: titleFrom(message || describeFiles(files)),
    created_at: nowSec(),
    updated_at: nowSec(),
  };
  await insertChat(c.env.DB, row);
  await audit(c.env.DB, userId, 'chat.create', row.title);
  return row;
}

/* Stopping is cooperative and needs no extra endpoint: the client aborts its own
 * fetch, the merged signal below turns that into `signal.aborted`, and the partial
 * answer is reported as `stopped` without being saved to history. */

function mergeSignals(a, b) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (a.aborted || b.aborted) controller.abort();
  else {
    a.addEventListener('abort', abort, { once: true });
    b.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

function usesEventStream(c) {
  if (c.req.query('stream') === '0') return false;
  const accept = c.req.header('accept') || '';
  if (accept.includes('application/json') && !accept.includes('text/event-stream')) return false;
  return true;
}

async function readJson(c) {
  try { return await c.req.json(); } catch (err) { return {}; }
}


function toChatDto(row) {
  return {
    id: row.id,
    title: row.title,
    message_count: row.message_count ?? undefined,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function toMessageDto(row) {
  return {
    id: row.id,
    chat_id: row.chat_id,
    role: row.role,
    content: row.content,
    files_json: row.files_json || '[]',
    created_at: Number(row.created_at),
  };
}

export default chat;
