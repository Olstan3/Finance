// Optional passcode protection. If no passcode is set the app is open (it listens on localhost
// only by default). Once set, every /api call needs a signed session cookie.

import crypto from 'node:crypto';

const COOKIE = 'ledgerline_session';
const SESSION_MS = 1000 * 60 * 60 * 12;

function getSecret(db) {
  let r = db.get("SELECT value FROM settings WHERE key = 'secret'");
  if (!r) {
    const v = crypto.randomBytes(32).toString('hex');
    db.run("INSERT INTO settings (key, value) VALUES ('secret', ?)", JSON.stringify(v));
    return v;
  }
  return JSON.parse(r.value);
}

const hash = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');

export function authConfigured(db) { return !!db.get("SELECT 1 AS x FROM settings WHERE key = 'auth'"); }

export function setPasscode(db, passcode) {
  if (passcode === null) { db.run("DELETE FROM settings WHERE key = 'auth'"); return; }
  if (String(passcode).length < 6) { const e = new Error('Use at least 6 characters.'); e.status = 400; throw e; }
  const salt = crypto.randomBytes(16).toString('hex');
  db.run("INSERT INTO settings (key, value) VALUES ('auth', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ salt, hash: hash(passcode, salt) }));
}

export function checkPasscode(db, passcode) {
  const r = db.get("SELECT value FROM settings WHERE key = 'auth'");
  if (!r) return true;
  const { salt, hash: h } = JSON.parse(r.value);
  const a = Buffer.from(hash(passcode, salt), 'hex'), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sign(db, expiry) { return crypto.createHmac('sha256', getSecret(db)).update(String(expiry)).digest('hex'); }

export function issueSession(db, res, secure) {
  const expiry = Date.now() + SESSION_MS;
  res.setHeader('Set-Cookie', `${COOKIE}=${expiry}.${sign(db, expiry)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`);
}
export function clearSession(res) { res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`); }

export function hasSession(db, req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|; )${COOKIE}=(\\d+)\\.([a-f0-9]+)`));
  if (!m) return false;
  const expiry = Number(m[1]);
  if (expiry < Date.now()) return false;
  const good = sign(db, expiry);
  const a = Buffer.from(m[2]), b = Buffer.from(good);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const attempts = new Map();
export function loginThrottle(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { n: 0, reset: now + 10 * 60 * 1000 };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + 10 * 60 * 1000; }
  rec.n++;
  attempts.set(ip, rec);
  return rec.n > 10 ? Math.ceil((rec.reset - now) / 1000) : 0;
}
export const resetThrottle = (ip) => attempts.delete(ip);
