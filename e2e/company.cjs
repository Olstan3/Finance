// End-to-end browser test for LIMITED COMPANY mode: two directors, no salary, income from ad networks,
// app stores and subscriptions, costs for hosting and domains.
//
//   npm run e2e:company    (needs Playwright + a Chromium: `npm i -D playwright && npx playwright install chromium`)
//
// Screenshots land in e2e/screenshots/.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'screenshots');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerline-e2e-'));
const F = path.join(TMP, 'files');
fs.mkdirSync(OUT, { recursive: true });
let BASE = '';

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

async function bootServer() {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), LEDGER_DATA_DIR: path.join(TMP, 'data') }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/auth/status'); if (r.ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 250)); }
  fs.mkdirSync(F, { recursive: true });
  fs.writeFileSync(path.join(F, 'bank.csv'), `Date,Description,Amount
01/04/2025,SHARE CAPITAL PAID IN,100.00
08/06/2025,AWS EMEA SARL,-250.00
09/06/2025,NAMECHEAP DOMAIN RENEWAL,-12.00
14/06/2025,GOOGLE ADMOB PAYMENT,1200.00
15/06/2025,GITHUB,-4.00
20/06/2025,APPLE DISTRIBUTION INTERNATIONAL,800.00
25/06/2025,STRIPE PAYOUT,2000.00
`);
  return { start: () => {}, stop: async () => { child.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 400)); fs.rmSync(TMP, { recursive: true, force: true }); } };
}

const problems = [];
let diagnose = async () => {};
let failShot = async () => {};
const step = async (name, fn) => {
  try { await fn(); console.log('  ok  ', name); }
  catch (e) { console.log('  FAIL', name, '\n      ', String(e.message).split('\n')[0]); problems.push(name); await failShot(name); await diagnose(); }
};
(async () => {
  const { stop } = await bootServer();
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 1000 } })).newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 40[0-9]/.test(m.text())) { console.log('   [console.error]', m.text().slice(0, 200)); problems.push('console: ' + m.text().slice(0, 80)); } });
  page.on('pageerror', (e) => { console.log('   [pageerror]', e.message.slice(0, 200)); problems.push('pageerror: ' + e.message.slice(0, 80)); });
  page.on('dialog', (d) => d.accept());
  const fresh = async (hash) => { await page.goto('about:blank'); await page.goto(BASE + hash); await page.waitForSelector('.shell'); };
  const shot = (n) => page.screenshot({ path: `${OUT}/company_${n}.png` });
  const toast = (re) => page.locator('.toast', { hasText: re }).first().waitFor({ timeout: 6000 });
  const card = (name) => page.locator('.card', { has: page.getByRole('heading', { name }) });
  const api = async (m, u, data) => { const r = await page.request.fetch(BASE + u, { method: m, data }); return { status: r.status(), body: r.headers()['content-type']?.includes('json') ? await r.json() : await r.text() }; };
  const selectPeriod = async () => { await page.locator('select[aria-label="Accounting period"]').selectOption({ label: 'Year ended 31 Mar 2026' }); await page.waitForTimeout(700); };

  failShot = (name) => page.screenshot({ path: `${OUT}/FAIL_${name.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}.png` }).catch(() => {});
  // on any failure, print what the books look like so the cause is obvious
  diagnose = async () => {
    try {
      const ov = await api('GET', '/api/company/overview?period=2025-04-01_2026-03-31');
      const b = ov.body.balanceSheet;
      console.log('      [books] balanced:', b.balanced, 'difference £' + (b.difference / 100), JSON.stringify(b.explain), '| cash £' + b.cash / 100, '| accounts', JSON.stringify(b.accounts.map((a) => [a.name, a.balance / 100])));
      const tx = await api('GET', '/api/transactions?taxYear=&limit=100');
      console.log('      [txns]', tx.body.rows.map((t) => `${t.date} ${t.amount / 100} ${t.category_id} acct${t.account_id}`).join(' | '));
    } catch (err) { console.log('      [diagnose failed]', err.message); }
  };
  await page.goto(BASE + '/#/dashboard'); await page.waitForSelector('.shell');

  await step('first run: choose "Limited company"', async () => {
    await page.getByRole('button', { name: 'Limited company' }).click();
    await toast(/limited company/i);
    await page.getByText('Company tax').first().waitFor();
  });

  await step('settings: company details validate, directors are added with their own loan accounts', async () => {
    await fresh('/#/settings');
    await page.getByLabel('Company name').fill('Pixel Pond Ltd');
    await page.getByLabel('Company number').fill('123');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('A company number is 8 characters').waitFor();
    await page.getByLabel('Company number').fill('12345678');
    await page.getByLabel('Date incorporated').fill('2025-04-01');
    for (let i = 0; i < 2; i++) await page.getByRole('button', { name: 'Add', exact: true }).click();
    const names = page.locator('input[aria-label="Director name"]'), shares = page.locator('input[aria-label="Shares"]'); // exact: the share-capital field's hint also contains the word "shares"
    await names.nth(0).fill('Sam Taylor'); await shares.nth(0).fill('50');
    await names.nth(1).fill('Alex Taylor'); await shares.nth(1).fill('50');
    await page.getByRole('button', { name: 'Save', exact: true }).click(); await toast(/Settings saved/);
    const accounts = await api('GET', '/api/accounts');
    assert.ok(accounts.body.some((a) => a.kind === 'dla' && /Sam/.test(a.name)), "a director's loan account exists for Sam");
    assert.ok(accounts.body.some((a) => a.kind === 'dla' && /Alex/.test(a.name)));
    await shot('01_settings');
  });

  await step('company categories only: no "Owner drawings", but app/ads/subscription categories', async () => {
    await fresh('/#/transactions');
    await page.getByRole('button', { name: 'Add transaction' }).click();
    const opts = await page.getByRole('dialog').locator('label', { hasText: 'Category' }).locator('select option').allInnerTexts();
    assert.ok(opts.some((t) => /Advertising revenue/.test(t)), 'ad revenue category');
    assert.ok(opts.some((t) => /Domain names/.test(t)), 'domain category');
    assert.ok(opts.some((t) => /Director's loan/.test(t)), "director's loan category");
    assert.ok(!opts.some((t) => /Owner drawings/.test(t)), 'no owner drawings for a company');
    assert.ok(!opts.some((t) => /Sales & fees \(turnover\)/.test(t)), 'no sole-trader categories');
    await page.keyboard.press('Escape');
  });

  await step('import a bank statement: ads, app store, Stripe, hosting, domain all categorised for a company', async () => {
    await fresh('/#/import');
    await page.setInputFiles('input[type=file]', `${F}/bank.csv`);
    await page.getByRole('heading', { name: 'bank.csv' }).waitFor();
    const rows = card('bank.csv').locator('table tbody tr');
    assert.equal(await rows.count(), 7);
    const got = await rows.evaluateAll((trs) => trs.map((tr) => ({ d: [...tr.querySelectorAll('input[type=text]')].map((i) => i.value).join(' '), c: tr.querySelector('select')?.value })));
    const cat = (re) => got.find((r) => re.test(r.d))?.c;
    assert.equal(cat(/ADMOB/), 'co_advertising_income'); assert.equal(cat(/APPLE/), 'co_inapp'); assert.equal(cat(/STRIPE/), 'co_subscriptions');
    assert.equal(cat(/AWS/), 'co_hosting'); assert.equal(cat(/NAMECHEAP/), 'co_domains'); assert.equal(cat(/GITHUB/), 'co_software'); assert.equal(cat(/SHARE CAPITAL/), 'share_capital');
    await shot('02_import');
    await page.getByRole('button', { name: /Record 7 items/ }).click(); await page.getByText(/recorded 7 transactions/).waitFor();
  });

  await step('an annual plan paid up front is spread; a laptop becomes an asset', async () => {
    await fresh('/#/transactions?taxYear=all');
    await page.getByRole('button', { name: 'Add transaction' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('button', { name: 'Money in' }).click();
    await dlg.getByLabel('Date').fill('2025-10-01');
    await dlg.getByLabel('Amount').fill('1200');
    await dlg.getByLabel('Description').fill('ANNUAL PLAN Acme Studios');
    await dlg.locator('label', { hasText: 'Category' }).locator('select').selectOption('co_subscriptions');
    await dlg.getByText('covers a period').click();
    await dlg.getByText(/spread across the months it covers/).waitFor();
    await dlg.getByRole('button', { name: 'Save' }).click(); await toast(/Transaction added/);
    await page.getByRole('button', { name: 'Add transaction' }).click();
    const d2 = page.getByRole('dialog');
    await d2.getByLabel('Date').fill('2025-05-03'); await d2.getByLabel('Amount').fill('1500'); await d2.getByLabel('Description').fill('APPLE STORE MACBOOK PRO');
    await d2.locator('label', { hasText: 'Category' }).locator('select').selectOption('co_equipment');
    await d2.getByRole('button', { name: 'Save' }).click(); await toast(/Transaction added/);
  });

  await step('company tax: overview, balanced accounts with deferred income and equipment', async () => {
    await fresh('/#/tax?tab=overview');
    await selectPeriod();
    await page.getByText('Corporation Tax for this period').waitFor();
    assert.match(await page.locator('main').innerText(), /HMRC's free service for company tax returns closed on 31 March 2026/);
    await shot('03_overview');
    await page.getByRole('tab', { name: 'Accounts' }).click();
    await page.getByText(/The balance sheet balances/).first().waitFor();
    const txt = await page.locator('main').innerText();
    assert.match(txt, /Deferred income/); assert.match(txt, /Tangible assets/); assert.match(txt, /Called-up share capital/); assert.match(txt, /Micro-entity statements/);
    await shot('04_accounts');
  });

  await step('computation: AIA on the laptop, 19% small profits rate, verified CT600 boxes', async () => {
    await page.getByRole('tab', { name: 'Tax computation & CT600' }).click();
    await page.getByText('Corporation Tax computation').first().waitFor();
    const txt = await page.locator('main').innerText();
    assert.match(txt, /Annual Investment Allowance £1,500\.00/); assert.match(txt, /19% \(small profits rate\)/);
    assert.match(txt, /Box 145/); assert.match(txt, /Box 155/); assert.match(txt, /Box 475/);
    await shot('05_computation');
  });

  await step('dividend: over-paying is blocked until acknowledged; a sensible one is recorded and the books still balance', async () => {
    await page.getByRole('tab', { name: 'Directors & dividends' }).click();
    await page.getByRole('button', { name: 'Declare a dividend' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Total dividend').fill('50000');
    await dlg.getByText(/more than the profit available/).waitFor();
    assert.equal(await dlg.getByRole('button', { name: 'Record dividend & payment' }).isDisabled(), true);
    await dlg.getByLabel('Total dividend').fill('1000');
    await dlg.getByLabel('Declared on').fill('2026-02-01'); await dlg.getByLabel('Paid on').fill('2026-02-01');
    await dlg.getByText(/Sam Taylor/).first().waitFor();
    await page.waitForTimeout(500);
    assert.equal(await dlg.getByRole('button', { name: 'Record dividend & payment' }).isDisabled(), false);
    await dlg.getByRole('button', { name: 'Record dividend & payment' }).click(); await toast(/Dividend recorded/);
    await page.getByText('Minutes & vouchers').waitFor();
    await shot('06_directors');
    await page.getByRole('tab', { name: 'Accounts' }).click(); await page.getByText(/The balance sheet balances/).first().waitFor();
  });

  await step('downloads: draft accounts PDF, trial balance CSV (debits = credits), dividend minutes & vouchers', async () => {
    const key = '2025-04-01_2026-03-31';
    const pdf = await page.request.get(`${BASE}/api/company/pdf?pack=all&period=${key}`);
    assert.equal(pdf.status(), 200); assert.equal((await pdf.body()).subarray(0, 4).toString(), '%PDF');
    const csv = await (await page.request.get(`${BASE}/api/company/trial-balance.csv?period=${key}`)).text();
    assert.match(csv, /Code,Account,Debit,Credit/); assert.doesNotMatch(csv, /SUSPENSE/);
    const lines = csv.trim().split(/\r?\n/); const tot = lines[lines.length - 1].split(',');
    assert.equal(tot[tot.length - 2], tot[tot.length - 1], 'debit total equals credit total');
    const divs = await api('GET', '/api/company/dividends');
    const dv = await page.request.get(`${BASE}/api/company/dividends/${divs.body[0].id}/pack.pdf`);
    assert.equal(dv.status(), 200); assert.equal((await dv.body()).subarray(0, 4).toString(), '%PDF');
  });

  await step("director's loan: money taken out as a loan shows the s455 warning", async () => {
    const sam = (await api('GET', '/api/contacts')).body.find((c) => c.name === 'Sam Taylor');
    const r = await api('POST', '/api/transactions', { date: '2025-12-01', description: 'TRANSFER TO SAM PERSONAL', amount: -300000, category_id: 'dla_movement', contact_id: sam.id, account_id: 1 });
    assert.equal(r.status, 201);
    await fresh('/#/tax?tab=overview'); await selectPeriod();
    await page.getByText(/Directors owe the company £3,000\.00/).waitFor();
    await page.getByText(/s455/).first().waitFor();
    await page.getByRole('tab', { name: 'Tax computation & CT600' }).click();
    await page.getByText(/CT600A/).first().waitFor();
    await shot('07_s455');
  });

  await step('the chosen accounting period survives a reload', async () => {
    await page.reload(); await page.waitForSelector('.shell');
    assert.equal(await page.locator('select[aria-label="Accounting period"]').inputValue(), '2025-04-01_2026-03-31');
  });

  await step('dashboard in company mode: Corporation Tax, dividends available, balance sheet status', async () => {
    await fresh('/#/dashboard'); await selectPeriod();
    await page.getByText('Estimated Corporation Tax').waitFor(); await page.getByText('Available to pay as dividends').waitFor();
    await page.getByText("Directors owe the company").first().waitFor();
    await shot('08_dashboard');
  });

  await browser.close();
  await stop();
  console.log(problems.length ? `\n${problems.length} PROBLEM(S): ${problems.join(' | ')}` : '\nALL COMPANY E2E STEPS PASSED');
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error('E2E CRASHED', e); process.exit(2); });
