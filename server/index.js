import { openDb } from './db.js';
import { createApp } from './app.js';
import { startScheduler } from './scheduler.js';
import { authConfigured } from './auth.js';
import { shutdownOcr } from './importers/ocr.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const allowedHosts = String(process.env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);

const db = openDb();
const app = createApp({ db, allowedHosts });
const server = app.listen(PORT, HOST, () => {
  console.log(`\n  Ledgerline is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}\n`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(HOST) && !authConfigured(db)) {
    console.warn('  ⚠  You are listening on a network address and no passcode is set.\n     Anyone who can reach this port can read your accounts. Set a passcode in Settings → Security.\n');
  }
});
const stopScheduler = startScheduler(db);

let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  stopScheduler();
  await shutdownOcr();
  server.close(() => { try { db.close(); } catch { /* ignore */ } process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
