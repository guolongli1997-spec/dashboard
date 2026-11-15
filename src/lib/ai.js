/* ============================================================================
 * Model layer. Workers AI by default; OpenAI when OPENAI_API_KEY is set.
 *
 * Everything on screen uses the existing design - this file only produces text
 * and tool calls. Both providers are normalised into one async iterator of
 * { type:'delta', text } / { type:'tool', ... } / { type:'done' } so the route
 * does not care which one answered.
 * ==========================================================================*/
import { toolCatalog } from './tools.js';

/* Kept tiny on purpose: the product answer must not depend on a long prompt. */
export function buildSystemPrompt(context = {}) {
  const user = context.user || {};
  const lines = [
    'You are Fly Dragon AI, the assistant of flytripvisa.site - a travel and visa consultancy.',
    'Answer about visas, entry rules, flights, hotels, eSIM, business setup and travel costs.',
    '',
    'Rules:',
    '- Never invent a price, a visa rule, a flight or a hotel. If a fact needs live data, call a tool first.',
    '- If a tool needs configuration or fails, say what you could not verify and name the safest next step (embassy, airline, hotel).',
    '- Use the visitor\'s own words: Bangla question means Bangla answer.',
    '- Keep it readable on a phone: short sentences, small lists, no walls of text.',
    '- Money: show the currency the visitor asked in, and convert only with the currency tool.',
    '- You are not an embassy or an airline. For anything time-critical, remind the visitor to confirm with the official source.',
  ];
  if (user.name) lines.push(`The signed-in visitor is ${user.name} <${user.email || ''}>.`);
  if (context.prefs?.language === 'bn') lines.push('Reply in Bangla (বাংলা) unless the visitor writes in another language.');
  if (context.city) lines.push(`The visitor appears to be in ${context.city}.`);
  return lines.join('\n');
}

/* ------------------------------- provider ------------------------------- */
function useOpenAI(env) {
  return Boolean(env.OPENAI_API_KEY);
}

export function currentModel(env) {
  return useOpenAI(env)
    ? { provider: 'openai', model: env.OPENAI_MODEL || 'gpt-4o-mini' }
    : { provider: 'cloudflare-ai', model: env.AI_MODEL || '@cf/meta/llama-3.1-8b-instruct' };
}

/**
 * Runs one turn and yields normalised deltas. Tools are offered to both
 * providers; when the model asks for a tool the caller executes it and calls
 * again with the tool result so the final answer is grounded.
 */
export async function* streamTurn({ env, messages, tools, signal, onToolCall }) {
  if (useOpenAI(env)) {
    yield* streamOpenAI({ env, messages, tools, signal });
    return;
  }
  yield* streamWorkersAI({ env, messages, tools, signal, onToolCall });
}

/* --------------------------------- OpenAI -------------------------------- */
async function* streamOpenAI({ env, messages, tools, signal }) {
  const { model } = currentModel(env);
  const body = {
    model,
    messages,
    stream: true,
    temperature: 0.4,
    max_tokens: 900,
  };
  if (tools && tools.length) body.tools = tools.map(toOpenAITool);

  const res = await fetch(`${env.OPENAI_BASE || 'https://api.openai.com/v1'}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw httpError(res.status, await readErrorMessage(res));

  const pendingTools = new Map();
  for await (const event of readSSE(res)) {
    const delta = event?.choices?.[0]?.delta;
    if (!delta) continue;
    if (delta.content) yield { type: 'delta', text: String(delta.content) };
    for (const call of delta.tool_calls || []) {
      const slot = pendingTools.get(call.index) || { id: '', name: '', arguments: '' };
      if (call.id) slot.id = call.id;
      if (call.function?.name) slot.name += call.function.name;
      if (call.function?.arguments) slot.arguments += call.function.arguments;
      pendingTools.set(call.index, slot);
    }
    if (event?.choices?.[0]?.finish_reason === 'tool_calls' && pendingTools.size) {
      for (const slot of pendingTools.values()) {
        if (!slot.name) continue;
        yield { type: 'tool', id: slot.id, name: slot.name, arguments: parseArgs(slot.arguments) };
      }
      pendingTools.clear();
    }
  }
  yield { type: 'done' };
}

function toOpenAITool(tool) {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

/* ------------------------------ Workers AI ------------------------------
 * Workers AI chat returns OpenAI-shaped JSON. Native tool use is not always
 * available on every model, so tool selection is done with a strict JSON
 * protocol: the model must answer either {"tool":..., "args":...} or plain text
 * inside a fenced "answer" block. Both are parsed here without ever showing
 * protocol noise to the visitor.
 * -----------------------------------------------------------------------*/
async function* streamWorkersAI({ env, messages, tools, signal }) {
  const answer = await runWorkersAI({ env, messages, tools, signal });
  if (!answer) throw httpError(502, 'The model returned nothing.');

  const asked = parseToolRequest(answer.content, tools);
  if (asked) {
    yield { type: 'tool', id: `call_${Date.now()}`, name: asked.name, arguments: asked.args };
    return;
  }
  const text = stripProtocol(answer.content);
  const chunks = chunkForTyping(text);
  for (const part of chunks) yield { type: 'delta', text: part };
  yield { type: 'done' };
}

async function runWorkersAI({ env, messages, tools, signal }) {
  const model = currentModel(env).model;
  const options = {
    messages: messages.map((m) => ({ role: m.role, content: String(m.content ?? '').slice(0, 12000) })),
    stream: false,
    temperature: 0.4,
    max_tokens: 900,
  };
  if (tools && tools.length && env.AI_MODEL?.includes('tool')) options.tools = tools.map(toOpenAITool);

  try {
    const result = await env.AI.run(model, options, { signal });
    return { content: normalise(result), usage: result?.usage || null };
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    console.warn('[ai] workers ai run failed:', err && err.message);
    throw httpError(502, `Workers AI could not answer (${err && err.message ? err.message : 'model error'}).`);
  }
}

function normalise(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (typeof result.response === 'string') return result.response;
  if (Array.isArray(result.response)) return result.response.map((part) => part?.text || part?.content || '').join('');
  if (result.choices?.[0]?.message?.content) return String(result.choices[0].message.content);
  if (typeof result.output === 'string') return result.output;
  if (Array.isArray(result.output)) return result.output.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
  return JSON.stringify(result).slice(0, 1200);
}

/** Two paths to a tool decision, so neither model dialect breaks the flow. */
function parseToolRequest(content, tools) {
  const text = String(content || '').trim();
  const names = (tools || []).map((tool) => tool.name);
  if (!text || !names.length) return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const payload = (fenced ? fenced[1] : text).trim();
  if (!payload.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(payload);
    const name = String(parsed.tool || parsed.name || '');
    if (!names.includes(name)) return null;
    return { name, args: parsed.args || parsed.arguments || parsed.parameters || {} };
  } catch (err) {
    return null;
  }
}

function stripProtocol(content) {
  return String(content || '')
    .replace(/^\s*(ANSWER|RESPONSE)\s*:\s*/i, '')
    .replace(/^\s*<\|[^|>]*\|>\s*/g, '')
    .trim();
}

function parseArgs(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : { query: String(value) };
  } catch (err) {
    return {};
  }
}

function chunkForTyping(text) {
  const parts = [];
  for (let i = 0; i < text.length; i += 24) parts.push(text.slice(i, i + 24));
  return parts;
}

/* ------------------------------- shared --------------------------------- */
async function* readSSE(res) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let at;
    while ((at = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          yield JSON.parse(data);
        } catch (err) { /* ignore keep-alive frames */ }
      }
    }
  }
}

async function readErrorMessage(res) {
  try {
    const text = await res.text();
    const parsed = JSON.parse(text);
    return String(parsed?.error?.message || parsed?.error || parsed?.message || text).slice(0, 300);
  } catch (err) {
    return `HTTP ${res.status}`;
  }
}

function httpError(status, message) {
  const err = new Error(message || `model error ${status}`);
  err.httpStatus = status >= 400 && status < 600 ? (status === 429 ? 429 : 502) : 502;
  err.code = err.httpStatus === 429 ? 'model_rate_limited' : 'model_error';
  return err;
}

export { toolCatalog, httpError };
