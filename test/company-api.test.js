import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerline-co-'));
process.env.LEDGER_DATA_DIR = tmp;
const { openDb } = await import('../server/db.js');
const { createApp } = await import('../server/app.js');
const { seedCompanyDemo } = await import('../server/seed.js');

let server, base, db;
before(async () => {
  db = openDb(':memory:');
  const app = createApp({ db });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const call = async (method, url, body) => {
  const res = await fetch(base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : ct.includes('pdf') ? Buffer.from(await res.arrayBuffer()) : await res.text() };
};

test('company endpoints refuse to work until the business is a limited company', async () => {
  assert.equal((await call('GET', '/api/company/overview')).status, 400);
  const meta = await call('GET', '/api/meta');
  assert.ok(meta.data.categories.some((c) => c.id === 'se_turnover'));
  assert.ok(!meta.data.categories.some((c) => c.id === 'co_hosting'), 'company categories are hidden for individuals');
});

test('company settings are validated, and each director gets a contact and a loan account', async () => {
  assert.equal((await call('PUT', '/api/settings', { entityType: 'sole' })).status, 400);
  const bad = await call('PUT', '/api/settings', { entityType: 'company', company: { number: 'abc' } });
  assert.equal(bad.status, 400); assert.equal(bad.data.field, 'number');
  const ok = await call('PUT', '/api/settings', { entityType: 'company', company: { name: 'Pixel Pond Ltd', number: '12345678', incorporationDate: '2025-04-01', directors: [{ name: 'Sam', shares: 50 }, { name: 'Alex', shares: 50 }] } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.company.directors.length, 2);
  assert.ok(ok.data.company.directors.every((d) => d.id && d.contact_id));
  const accounts = await call('GET', '/api/accounts');
  assert.equal(accounts.data.filter((a) => a.kind === 'dla').length, 2);
  const meta = await call('GET', '/api/meta');
  assert.ok(meta.data.categories.some((c) => c.id === 'co_hosting'));
  assert.ok(!meta.data.categories.some((c) => c.id === 'se_turnover'), 'sole-trader categories are hidden for a company');
  assert.ok(!meta.data.categories.some((c) => c.id === 'drawings'));
  assert.equal(meta.data.company.current, `${meta.data.company.periods.at(-1).key}`);
});

test('overview, period inputs, PDFs, trial balance and dividends over HTTP', async () => {
  // fresh company with the demo data (replaces the empty one)
  const r = await call('POST', '/api/admin/reset', { confirm: 'DELETE' });
  assert.equal(r.status, 200);
  seedCompanyDemo(db);
  const key = '2025-04-01_2026-03-31';
  const ov = await call('GET', `/api/company/overview?period=${key}`);
  assert.equal(ov.status, 200);
  assert.equal(ov.data.balanceSheet.balanced, true);
  assert.equal(ov.data.ct.rows[0].charge.band, 'small');
  assert.ok(ov.data.forms.find((f) => f.id === 'CT600').pages[1].rows.some((x) => x.box === '145'));
  assert.equal((await call('GET', '/api/company/overview?period=nonsense')).status, 400);

  const inputs = await call('PUT', `/api/company/inputs?period=${key}`, { ctLossesBF: 100000 });
  assert.equal(inputs.status, 200);
  assert.equal(inputs.data.ctLossesBF, 100000);
  const withLoss = await call('GET', `/api/company/overview?period=${key}`);
  assert.equal(withLoss.data.ct.tax, ov.data.ct.tax - Math.round(100000 * 0.19), 'a £1,000 loss b/f saves 19% of it');
  assert.equal((await call('PUT', `/api/company/inputs?period=${key}`, { bogus: 1 })).status, 400);
  await call('PUT', `/api/company/inputs?period=${key}`, { ctLossesBF: 0, associatedCompanies: 1 });
  const assoc = await call('GET', `/api/company/overview?period=${key}`);
  assert.ok(assoc.data.ct.tax > ov.data.ct.tax, 'an associated company halves the bands, so profit moves into marginal relief and tax rises');
  assert.equal(assoc.data.ct.rows[0].charge.band, 'marginal');
  await call('PUT', `/api/company/inputs?period=${key}`, { associatedCompanies: 0 });

  const pdf = await call('GET', `/api/company/pdf?pack=all&period=${key}`);
  assert.equal(pdf.status, 200); assert.equal(pdf.data.subarray(0, 4).toString(), '%PDF');
  const csv = await call('GET', `/api/company/trial-balance.csv?period=${key}`);
  assert.match(csv.data, /Code,Account,Debit,Credit/);
  assert.doesNotMatch(csv.data, /SUSPENSE/);

  const tooBig = await call('POST', '/api/company/dividends', { declared_date: '2026-03-01', total: 9999999 });
  assert.equal(tooBig.status, 409); assert.equal(tooBig.data.code, 'insufficient_reserves');
  const list = await call('GET', '/api/company/dividends');
  assert.equal(list.data.length, 1, 'the demo dividend only – the rejected one was not recorded');
  const summary = await call('GET', '/api/company/director-summary?taxYear=2025-26');
  assert.equal(summary.data.length, 2);
  assert.equal(summary.data[0].dividends, 300000);
  assert.equal(summary.data[0].estimatedTax, 0, 'covered by the personal and dividend allowances');
  const voucher = await call('GET', `/api/company/dividends/${list.data[0].id}/pack.pdf`);
  assert.equal(voucher.data.subarray(0, 4).toString(), '%PDF');
  assert.equal((await call('DELETE', `/api/company/dividends/${list.data[0].id}`)).status, 200);
  assert.equal((await call('GET', '/api/company/dividends')).data.length, 0);
});

test('a company invoice defaults to subscription income and carries the company identity on its PDF', async () => {
  const c = (await call('POST', '/api/contacts', { name: 'Acme Studios', email: 'a@acme.test' })).data;
  const inv = (await call('POST', '/api/invoices', { contact_id: c.id, issue_date: '2026-06-01', lines: [{ description: 'Annual licence', quantity: 1, unit_price: 120000, vat_code: 'N' }] })).data;
  assert.equal(inv.category_id, 'co_subscriptions');
  const pdf = await call('GET', `/api/invoices/${inv.id}/pdf`);
  assert.equal(pdf.status, 200);
});

test('the dashboard switches to company figures with directors, dividends and the balance check', async () => {
  const d = await call('GET', '/api/reports/dashboard');
  assert.equal(d.data.entity, 'company');
  assert.ok(d.data.company);
  assert.ok(d.data.monthly.length >= 1 && d.data.monthly.length <= 18);
  assert.ok(d.data.deadlines.some((x) => /Corporation Tax|Companies House|CT600/.test(x.title)));
});

test('a transaction can carry a service period, and invalid periods are rejected', async () => {
  const ok = await call('POST', '/api/transactions', { date: '2026-05-01', description: 'ANNUAL HOSTING', amount: -24000, category_id: 'co_hosting', account_id: 1, spread_from: '2026-05-01', spread_to: '2027-04-30' });
  assert.equal(ok.status, 201); assert.equal(ok.data.spread_to, '2027-04-30');
  const bad = await call('POST', '/api/transactions', { date: '2026-05-01', description: 'X', amount: -100, category_id: 'co_hosting', account_id: 1, spread_from: '2026-05-01', spread_to: '2026-01-01' });
  assert.equal(bad.status, 400); assert.equal(bad.data.field, 'spread_to');
  const half = await call('POST', '/api/transactions', { date: '2026-05-01', description: 'X', amount: -100, category_id: 'co_hosting', account_id: 1, spread_from: '2026-05-01' });
  assert.equal(half.status, 400);
});
