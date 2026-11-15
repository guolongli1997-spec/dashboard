/* ============================================================================
 * Model provider double. Speaks the OpenAI HTTP protocol the app really uses
 * (SSE deltas, tool_calls, image generations) so src/lib/ai.js runs unchanged.
 * It replaces the *provider*, not any part of the app.
 *
 *   startProvider(8899)  ->  POST http://127.0.0.1:8899/v1/chat/completions
 * ==========================================================================*/
import http from 'node:http';

export const ANSWER = [
  'Answer: a Japan tourist e-visa needs a passport, photo and itinerary.',
  '**bold** renders',
  '',
  '- first bullet',
  '- second bullet',
].join('\n');

const PNG_PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const frame = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long the double stays silent before the first token - real models are not instant,
 *  and the chat UI has to show its "Thinking..." state during that window. */
const THINK_MS = Number(process.env.FAKE_THINK_MS ?? 0);

/** Captured emails, readable through GET /outbox on the double. */
export const outbox = [];

const lastUser = (messages) => String([...(messages || [])].reverse().find((m) => m?.role === 'user')?.content || '');

const toolNames = (tools) => (tools || []).map((t) => t?.function?.name).filter(Boolean);

function wantedTool(names, question) {
  if (/destination notes/i.test(question)) {
    return names.find((n) => /mcp_/.test(n)) || null;
  }
  if (/flight/i.test(question) && names.includes('flights')) return 'flights';
  if (/hotel/i.test(question) && names.includes('hotels')) return 'hotels';
  if (/visa/i.test(question) && names.includes('visa')) return 'visa';
  if (/currenc|convert|price/i.test(question) && names.includes('currency')) return 'currency';
  return null;
}

function toolArgs(question) {
  if (/hotel/i.test(question)) return '{"city":"Tokyo"}';
  if (/visa/i.test(question)) return '{"passport":"BGD","destination":"JPN"}';
  if (/currenc|convert|price/i.test(question)) return '{"amount":100,"from":"USD","to":"JPY"}';
  return '{"from":"DAC","to":"KUL"}';
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (err) { resolve({}); }
    });
  });
}

export function createProvider() {
  return http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = String(req.url || '').replace(/\/$/, '');

    if (url === '/v1/chat/completions') {
      const question = lastUser(body.messages);
      const names = toolNames(body.tools);
      const alreadyUsedTool = (body.messages || []).some((m) => m.role === 'tool');
      const tool = alreadyUsedTool ? null : wantedTool(names, question);

      if (tool) {
        const call = { id: 'call_double_1', type: 'function', function: { name: tool, arguments: toolArgs(question) } };
        if (!body.stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            model: body.model,
            choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [call] } }],
          }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        await sleep(THINK_MS);
        res.write(frame({ choices: [{ index: 0, delta: { role: 'assistant', content: '', tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: tool, arguments: '' } }] } }] }));
        res.write(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: call.function.arguments } }] } }] }));
        res.write(frame({ choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }] }));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: body.model,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: ANSWER } }],
        }));
        return;
      }

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      await sleep(THINK_MS);
      for (const part of ANSWER.match(/.{1,18}/gs) || []) {
        res.write(frame({ choices: [{ index: 0, delta: { content: part } }] }));
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      res.write(frame({ choices: [{ index: 0, finish_reason: 'stop', delta: {} }] }));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (url === '/v1/images/generations') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: body.model || 'double', data: [{ b64_json: PNG_PIXEL.toString('base64') }] }));
      return;
    }

    // JSON-RPC 2.0 double for user-added MCP servers (§6B): initialize / tools/list / tools/call.
    if (url === '/mcp' && req.method === 'POST') {
      const method = body.method;
      let result = {};
      if (method === 'initialize') {
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'double-mcp', version: '1.0.0' } };
      } else if (method === 'tools/list') {
        result = { tools: [{ name: 'destination_notes', description: 'Notes about a destination', inputSchema: { type: 'object', properties: { country: { type: 'string' } } } }] };
      } else if (method === 'tools/call') {
        result = { content: [{ type: 'text', text: 'MCP double says: bring a copy of your passport.' }] };
      } else if (method === 'notifications/initialized') {
        result = {};
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32601, message: 'unknown method' } }));
      }
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'double-session-1' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, result }));
    }

    // Resend-shaped capture endpoint: lets a test read the reset link the app emailed.
    if (url === '/emails' && req.method === 'POST') {
      outbox.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'email_' + outbox.length, to: body.to }));
    }
    if (url === '/outbox') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ outbox }));
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'provider double has no route ' + url } }));
  });
}

/** Base URL of the MCP double, for tests that register it as a user server. */
export const mcpUrl = (port = 8899) => `http://127.0.0.1:${port}/mcp`;

export function startProvider(port = 8899) {
  const server = createProvider();
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
