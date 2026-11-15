/* Server-Sent Events helper. One place that knows the wire format, so the route
 * stays about the conversation. Frames the client understands:
 *
 *   {"type":"meta","chatId":..,"provider":..,"model":..}
 *   {"type":"delta","text":".."}
 *   {"type":"tool_status","tools":[{name,status,message}]}
 *   {"type":"stopped","chatId":..}
 *   {"type":"done","chatId":..,"reply":..}
 *   {"type":"error","error":"..","code":".."}
 * Legacy keys (response / [DONE]) are also emitted for older front ends.
 */
export function sseHeaders() {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  };
}

/** Streams one chat turn. `handler` receives an async send(event) callback. */
export function streamSSE(handler) {
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const encoder = new TextEncoder();
      const send = async (event) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch (err) {
          closed = true;                       // client went away; stop writing
        }
      };

      const keepAlive = setInterval(() => {
        if (!closed) {
          try { controller.enqueue(encoder.encode(': keep-alive\n\n')); } catch (err) { /* ignore */ }
        }
      }, 15000);

      try {
        await send({ type: 'start' });
        await handler(send);
      } catch (err) {
        console.error('[sse] handler failed:', err && err.stack ? err.stack : err);
        await send({ type: 'error', error: 'The assistant stopped unexpectedly.', code: 'stream_failed' });
      } finally {
        clearInterval(keepAlive);
        closed = true;
        try { controller.close(); } catch (err) { /* already closed */ }
      }
    },
  });

  return new Response(stream, { status: 200, headers: sseHeaders() });
}
