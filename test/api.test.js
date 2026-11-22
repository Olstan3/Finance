import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerline-test-'));
process.env.LEDGER_DATA_DIR = tmp;
process.env.SMTP_URL = 'json';
const { openDb } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');

let server, base, db;
before(async () => {
  db = openDb(':memory:');
  const app = createApp({ db });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const call = async (method, url, body, headers = {}) => {
  const res = await fetch(base + url, { method, headers: { ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body && !Buffer.isBuffer(body) ? JSON.stringify(body) : body });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : ct.includes('pdf') || ct.includes('octet') ? Buffer.from(await res.arrayBuffer()) : await res.text();
  return { status: res.status, data, headers: res.headers };
};

test('meta endpoint boots with categories, accounts and tax years', async () => {
  const { status, data } = await call('GET', '/api/meta');
  assert.equal(status, 200);
  assert.ok(data.categories.length > 30);
  assert.ok(data.taxYears.some((y) => y.label === '2025-26' && y.status === 'confirmed'));
  assert.equal(data.accounts.length, 2);
});

test('security headers, host allowlist and cross-site write protection', async () => {
  const r = await call('GET', '/api/meta');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  // wrong Host header (DNS rebinding) is refused. fetch() will not let us set Host, so use raw http.
  const rawStatus = (host) => new Promise((resolve, reject) => {
    const u = new URL(base);
    http.get({ host: u.hostname, port: u.port, path: '/api/meta', headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(await rawStatus('evil.example.com'), 421);
  assert.equal(await rawStatus('localhost:3000'), 200);
  // cross-origin POST is refused
  const x = await call('POST', '/api/contacts', { name: 'X' }, { Origin: 'https://evil.example.com' });
  assert.equal(x.status, 403);
});

test('validation errors are friendly 400s with the field name', async () => {
  const r = await call('POST', '/api/invoices', { issue_date: 'nonsense', lines: [] });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /date/i);
  assert.equal(r.data.field, 'issue_date');
  const bad = await call('PUT', '/api/settings', { profile: { utr: '123' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.field, 'utr');
});

test('invoice flow over HTTP: create -> issue -> pdf -> pay -> email', async () => {
  const c = (await call('POST', '/api/contacts', { name: 'Acme Ltd', email: 'ap@acme.test', kind: 'customer' })).data;
  const inv = (await call('POST', '/api/invoices', { contact_id: c.id, issue_date: '2026-02-01', lines: [{ description: 'Consulting', quantity: 2, unit_price: 25000, vat_code: 'N' }] })).data;
  assert.equal(inv.totals.gross, 50000);
  assert.equal((await call('POST', `/api/invoices/${inv.id}/payments`, { amount: 100 })).status, 400, 'cannot take payment on a draft');
  const sent = await call('POST', `/api/invoices/${inv.id}/send`, { email: true });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.emailed.to, 'ap@acme.test');
  assert.equal(sent.data.invoice.status, 'sent');
  const pdf = await call('GET', `/api/invoices/${inv.id}/pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.data.subarray(0, 4).toString(), '%PDF');
  const paid = await call('POST', `/api/invoices/${inv.id}/payments`, { amount: 50000, date: '2026-02-10' });
  assert.equal(paid.data.invoice.derived_status, 'paid');
  assert.equal((await call('DELETE', `/api/invoices/${inv.id}`)).status, 400, 'sent invoices cannot be deleted');
});

test('recurring invoice over HTTP: create, preview, run-due', async () => {
  const c = (await call('POST', '/api/contacts', { name: 'Retainer Co' })).data;
  const t = (await call('POST', '/api/recurring', {
    name: 'Monthly support', contact_id: c.id, frequency: 'monthly', start_date: '2025-01-15', mode: 'issue', due_days: 14,
    lines: [{ description: 'Support {month} {year}', quantity: 1, unit_price: 30000, vat_code: 'N' }], max_runs: 3,
  })).data;
  assert.equal(t.next_date, '2025-01-15');
  const run = await call('POST', '/api/recurring/run-due');
  assert.equal(run.data.created.length, 3);
  const list = await call('GET', '/api/invoices?status=unpaid');
  assert.ok(list.data.filter((i) => i.recurring_id === t.id).length === 3);
});

test('upload a CSV statement, review the preview, edit one row, commit, then see it in the tax return', async () => {
  const csv = Buffer.from('Date,Description,Amount\n03/07/2025,SHELL FUEL,-45.00\n04/07/2025,STRIPE PAYOUT,2000.00\n05/07/2025,MYSTERY,-10.00\n');
  const up = await call('POST', '/api/import/upload?filename=july.csv', csv, { 'Content-Type': 'application/octet-stream' });
  assert.equal(up.status, 201);
  assert.equal(up.data.items.length, 3);
  assert.equal(up.data.summary.needsReview, 1);
  const mystery = up.data.items.find((i) => i.description === 'MYSTERY');
  const commit = await call('POST', `/api/import/batches/${up.data.id}/commit`, { edits: { [mystery.idx]: { category_id: 'se_admin' } } });
  assert.equal(commit.data.created, 3);
  const before = await call('GET', '/api/tax/2025-26');
  assert.equal(before.status, 200);
  // £2,000 payout + the £500 invoice payment recorded in the invoice test (Feb 2026 is in 2025-26)
  assert.equal(before.data.se.turnover, 250000);
  assert.equal(before.data.se.totalExpenses, 5500);
  assert.equal(before.data.counts.uncategorised, 0);
  const sa103 = before.data.forms.find((f) => f.id === 'SA103F');
  assert.ok(sa103.pages.some((p) => p.rows.some((r) => r.box === '15' && r.value === 250000)));
  // evidence file is downloadable
  const batch = await call('GET', `/api/import/batches/${up.data.id}`);
  assert.equal(batch.data.status, 'committed');
});

test('tax PDF worksheets and exports render', async () => {
  const pdf = await call('GET', '/api/tax/2025-26/pdf?form=all');
  assert.equal(pdf.status, 200);
  assert.equal(pdf.data.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdf.data.length > 3000);
  const json = await call('GET', '/api/tax/2025-26/export.json');
  assert.equal(json.data.taxYear, '2025-26');
  const csv = await call('GET', '/api/transactions/export.csv?taxYear=2025-26');
  assert.match(csv.data, /Date,Account,Description/);
  assert.equal((await call('GET', '/api/tax/1999-00')).status, 400);
});

test('tax inputs are validated and flow into the calculation', async () => {
  const r = await call('PUT', '/api/tax/2025-26/inputs', { employment: [{ employer: 'Day Job Ltd', pay: 3000000, tax: 350000 }], studentLoan: { plan: 'plan2', postgrad: false } });
  assert.equal(r.status, 200);
  const t = await call('GET', '/api/tax/2025-26');
  assert.equal(t.data.calc.income.employment, 3000000);
  assert.ok(t.data.calc.studentLoan.due > 0);
  assert.equal((await call('PUT', '/api/tax/2025-26/inputs', { studentLoan: { plan: 'plan99' } })).status, 400);
  assert.equal((await call('PUT', '/api/tax/2025-26/inputs', { bogusKey: 1 })).status, 400);
});

test('dashboard, P&L, VAT and quarterly reports respond', async () => {
  const d = await call('GET', '/api/reports/dashboard?taxYear=2025-26');
  assert.equal(d.status, 200);
  assert.equal(d.data.totals.income, 250000);
  assert.ok(d.data.monthly.length === 12);
  const pnl = await call('GET', '/api/reports/pnl?taxYear=2025-26');
  assert.ok(pnl.data.income.length >= 1);
  const q = await call('GET', '/api/reports/quarterly?taxYear=2025-26');
  assert.equal(q.data.length, 4);
  assert.equal(q.data[0].due, '2025-08-07');
  const v = await call('GET', '/api/reports/vat?from=2025-07-01&to=2025-09-30');
  assert.equal(v.status, 200);
  assert.equal((await call('GET', '/api/reports/vat?from=bad&to=2025-09-30')).status, 400);
});

test('passcode: set, lock the API, log in, log out', async () => {
  const set = await call('PUT', '/api/auth/passcode', { passcode: 'correct horse' });
  assert.equal(set.data.locked, true);
  const cookie = set.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('GET', '/api/meta')).status, 401, 'no cookie -> locked');
  assert.equal((await call('GET', '/api/meta', null, { Cookie: cookie })).status, 200);
  assert.equal((await call('POST', '/api/auth/login', { passcode: 'wrong' })).status, 401);
  const login = await call('POST', '/api/auth/login', { passcode: 'correct horse' });
  assert.equal(login.status, 200);
  assert.equal((await call('GET', '/api/auth/status')).data.locked, true);
  // remove it again
  const off = await call('PUT', '/api/auth/passcode', { current: 'correct horse', passcode: '' }, { Cookie: cookie });
  assert.equal(off.data.locked, false);
  assert.equal((await call('GET', '/api/meta')).status, 200);
});

test('unknown API routes are JSON 404s, and path traversal in static files is refused', async () => {
  assert.equal((await call('GET', '/api/nope')).status, 404);
  const t = await fetch(base + '/..%2f..%2fpackage.json');
  assert.notEqual(t.status, 200);
});
