/* Boots the local harness (real routes + real SQLite + R2 double + provider double)
 * and stays resident so the browser suite can drive it like a deployed worker.
 *
 *   node test/harness-server.mjs     -> http://127.0.0.1:8790
 */
import { start, stop } from './harness.mjs';

const info = await start();
// The browser suite parses this line to learn the OS-chosen ports.
console.log(`HARNESS_READY ${info.port} ${info.providerPort}`);

const shutdown = async () => {
  try { await stop(); } catch (err) { console.warn('shutdown warning:', err && err.message); }
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
