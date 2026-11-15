/* ============================================================================
 * Image generation. Workers AI (Flux) when only the AI binding exists, OpenAI
 * Images when OPENAI_API_KEY is set. Output is stored in R2 and registered in
 * D1 `images`, then surfaced in §6C and inside the chat bubble.
 * ==========================================================================*/
import { uid } from './http.js';
import { r2Key } from './store.js';

const FLUX_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const SIZES = ['1024x1024', '1344x896', '896x1344', '1024x1536'];

export function imageModel(env) {
  return env.OPENAI_API_KEY
    ? { provider: 'openai', model: env.OPENAI_IMAGE_MODEL || 'gpt-image-1' }
    : { provider: 'cloudflare-ai', model: env.AI_IMAGE_MODEL || FLUX_MODEL };
}

/** Prompt guard: no free-form length blow-ups, and never empty. */
export function cleanPrompt(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 900);
  return text;
}

export async function generateImage({ env, userId, prompt, size = '1024x1024', signal }) {
  const ask = cleanPrompt(prompt);
  if (!ask) throw imageError(400, 'Write a prompt first.');
  if (!userId) throw imageError(500, 'generateImage needs the owning userId to namespace the R2 key.');
  const chosen = SIZES.includes(size) ? size : '1024x1024';

  const result = env.OPENAI_API_KEY
    ? await fromOpenAI(env, ask, chosen, signal)
    : await fromWorkersAI(env, ask, chosen, signal);

  const bytes = result.bytes;
  if (!bytes || !bytes.byteLength) throw imageError(502, 'The image model returned nothing.');

  const id = uid('img');
  const key = r2Key(userId, id, 'generated.png');
  const bucket = env.UPLOADS || env.R2;
  if (!bucket) throw imageError(500, 'The fly-dragon-uploads bucket is not bound to this worker.');

  await bucket.put(key, bytes, {
    httpMetadata: { contentType: 'image/png', cacheControl: 'private, no-store' },
    customMetadata: { source: result.provider, model: result.model, prompt: ask.slice(0, 800) },
  });

  return {
    id,
    r2_key: key,
    prompt: ask,
    size: bytes.byteLength,
    url: `/api/images/${id}/download`,
    provider: result.provider,
    model: result.model,
    width: chosen.split('x')[0],
    height: chosen.split('x')[1],
  };
}

async function fromOpenAI(env, ask, size, signal) {
  const { model } = imageModel(env);
  const res = await fetch(`${env.OPENAI_BASE || 'https://api.openai.com/v1'}/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model, prompt: ask, size, n: 1, response_format: 'b64_json' }),
    signal,
  });
  if (!res.ok) throw imageError(res.status, await readError(res));
  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw imageError(502, 'Image model did not return an image.');
  return {
    bytes: Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)),
    provider: 'openai',
    model: String(data.model || 'openai-images'),
  };
}

async function fromWorkersAI(env, ask, size, signal) {
  const model = env.AI_IMAGE_MODEL || FLUX_MODEL;
  const [width, height] = size.split('x').map(Number);
  let raw;
  try {
    raw = await env.AI.run(model, { prompt: ask, width: squareWidth(model, width), height: squareWidth(model, height) }, { signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw imageError(502, `Image model failed: ${err?.message || 'unknown error'}`);
  }
  const b64 = raw?.image || raw?.b64_json || (Array.isArray(raw?.images) ? raw.images[0] : null) || (typeof raw === 'string' ? raw : null);
  if (!b64) throw imageError(502, 'Image model did not return an image.');
  return {
    bytes: Uint8Array.from(atob(String(b64).replace(/^data:image\/\w+;base64,/, '')), (ch) => ch.charCodeAt(0)),
    provider: 'cloudflare-ai',
    model: String(raw?.model || model),
  };
}

/** Flux only accepts square multiples of 32 on some deployments; clamp without lying. */
const squareWidth = (model, value) => {
  if (model.includes('flux')) return 1024;
  return Math.max(64, Math.min(2048, Number(value) || 1024));
};

async function readError(res) {
  try {
    const text = await res.text();
    const parsed = JSON.parse(text);
    return String(parsed?.error?.message || parsed?.error || text).slice(0, 260);
  } catch (err) {
    return `HTTP ${res.status}`;
  }
}

function imageError(status, message) {
  const err = new Error(message);
  err.httpStatus = status >= 400 && status < 500 ? status : 502;
  err.code = err.httpStatus === 400 ? 'bad_request' : 'image_error';
  return err;
}
