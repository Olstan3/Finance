import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authConfigured, checkPasscode, clearSession, hasSession, issueSession, loginThrottle, resetThrottle, setPasscode } from './auth.js';
import core from './routes/core.js';
import ledger from './routes/ledger.js';
import invoices from './routes/invoices.js';
import reports from './routes/reports.js';
import tax from './routes/tax.js';
import company from './routes/company.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const PUBLIC = path.join(ROOT, 'public');

function cspHashes(publicDir) {
  // Allow exactly the inline <script> blocks in index.html (the import map) – nothing else inline.
  try {
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    return [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
  } catch { return []; }
}

export function createApp({ db, publicDir = PUBLIC, allowedHosts = [] } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]', ...allowedHosts.map((h) => h.toLowerCase())]);
  const csp = [
    "default-src 'self'", `script-src 'self' ${cspHashes(publicDir).join(' ')}`.trim(), "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
    "connect-src 'self'", "frame-src 'self' blob:", "object-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'self'",
  ].join('; ');

  // DNS-rebinding protection: only answer requests addressed to a host we expect.
  app.use((req, res, next) => {
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    if (!hosts.has(host)) return res.status(421).type('text/plain').send(`Unexpected host "${host}". Set ALLOWED_HOSTS to use another hostname.`);
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use('/api', express.json({ limit: '2mb' }));

  // Cross-site request protection for anything that changes data.
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin) {
      let oh; try { oh = new URL(origin).host; } catch { oh = ''; }
      if (oh.toLowerCase() !== String(req.headers.host).toLowerCase()) return res.status(403).json({ error: 'Cross-site request blocked.' });
    }
    next();
  });

  // ---- auth
  const api = express.Router();
  const ip = (req) => req.socket.remoteAddress || 'unknown';
  api.get('/auth/status', (req, res) => res.json({ locked: authConfigured(db), authenticated: !authConfigured(db) || hasSession(db, req) }));
  api.post('/auth/login', (req, res) => {
    const wait = loginThrottle(ip(req));
    if (wait) return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).` });
    if (!authConfigured(db)) return res.json({ ok: true });
    if (!checkPasscode(db, req.body?.passcode ?? '')) return res.status(401).json({ error: 'That passcode is not right.' });
    resetThrottle(ip(req));
    issueSession(db, res, req.secure);
    res.json({ ok: true });
  });
  api.post('/auth/logout', (req, res) => { clearSession(res); res.json({ ok: true }); });

  // Everything below requires a session once a passcode has been set.
  api.use((req, res, next) => {
    if (authConfigured(db) && !hasSession(db, req)) return res.status(401).json({ error: 'Locked', locked: true });
    next();
  });
  api.put('/auth/passcode', (req, res) => {
    const { current, passcode } = req.body || {};
    if (authConfigured(db) && !checkPasscode(db, current ?? '')) return res.status(401).json({ error: 'Your current passcode is not right.' });
    setPasscode(db, passcode === '' || passcode == null ? null : passcode);
    if (authConfigured(db)) issueSession(db, res, req.secure); else clearSession(res);
    res.json({ locked: authConfigured(db) });
  });

  const ctx = { db };
  core(api, ctx); ledger(api, ctx); invoices(api, ctx); reports(api, ctx); tax(api, ctx); company(api, ctx);
  api.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use('/api', api);

  // ---- front end (served as plain files; Preact/htm come straight from node_modules, no build step)
  const nm = path.join(ROOT, 'node_modules');
  app.use('/vendor/preact', express.static(path.join(nm, 'preact', 'dist'), { index: false }));
  app.use('/vendor/preact-hooks', express.static(path.join(nm, 'preact', 'hooks', 'dist'), { index: false }));
  app.use('/vendor/htm', express.static(path.join(nm, 'htm', 'dist'), { index: false }));
  app.use(express.static(publicDir, { index: 'index.html' }));
  app.get(/^\/(?!api\/).*/, (req, res, next) => (path.extname(req.path) ? next() : res.sendFile(path.join(publicDir, 'index.html'))));

  // ---- errors
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request was not valid JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large (limit 25 MB).' });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message, field: err.field });
    if (/UNIQUE constraint/.test(err.message || '')) return res.status(409).json({ error: 'That already exists.' });
    if (/FOREIGN KEY/.test(err.message || '')) return res.status(409).json({ error: 'That is still in use by other records.' });
    const id = crypto.randomBytes(4).toString('hex');
    console.error(`[${id}] ${req.method} ${req.originalUrl}`, err);
    res.status(500).json({ error: `Something went wrong (ref ${id}). Your data has not been changed by this request.` });
  });
  return app;
}
