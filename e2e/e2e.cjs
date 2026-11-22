// End-to-end browser test: starts Ledgerline on a free port with a throwaway database, then drives
// the real UI like a user would (import files, edit rows, create invoices, read the tax worksheets).
//
//   npm run e2e            (needs Playwright + a Chromium: `npm i -D playwright && npx playwright install chromium`)
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
  const { makeFixtures } = await import('./fixtures.mjs');
  await makeFixtures(F);
  // photograph a receipt: render the HTML to a PNG so the OCR path has a real image to read
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 700, height: 560 }, deviceScaleFactor: 2 });
  await p.goto('file://' + path.join(F, 'receipt.html')); await p.screenshot({ path: path.join(F, 'receipt.png') }); await b.close();
  return { start: () => {}, stop: async () => { child.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 400)); fs.rmSync(TMP, { recursive: true, force: true }); } };
}

const problems = [];
const step = async (name, fn) => { try { await fn(); console.log('  ok  ', name); } catch (e) { console.log('  FAIL', name, '\n      ', String(e.message).split('\n')[0]); problems.push(name); } };
(async () => {
  const { start, stop } = await bootServer();
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 40[0-9]/.test(m.text())) { console.log('   [console.error]', m.text().slice(0, 200)); problems.push('console: ' + m.text().slice(0, 80)); } });
  page.on('pageerror', (e) => { console.log('   [pageerror]', e.message.slice(0, 200)); problems.push('pageerror: ' + e.message.slice(0, 80)); });
  page.on('dialog', (d) => d.accept());
  const fresh = async (hash) => { await page.goto('about:blank'); await page.goto(BASE + hash); await page.waitForSelector('.shell'); };
  const card = (name) => page.locator('.card', { has: page.getByRole('heading', { name }) });
  const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
  const toast = (re) => page.locator('.toast', { hasText: re }).first().waitFor({ timeout: 6000 });

  await page.goto(BASE + '/#/dashboard');
  await page.waitForSelector('.shell');

  await step('empty dashboard offers a guided start', async () => { await page.getByText("Welcome – let's get your accounts going").waitFor(); await shot('01_welcome'); });

  await step('save profile in settings (with validation)', async () => {
    await fresh('/#/settings');
    await page.getByLabel('Your full name').fill('Sam Taylor');
    await page.getByLabel('Trading name').fill('ST Design');
    await page.getByLabel('Unique Taxpayer Reference (UTR)').fill('123');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('A UTR is 10 digits').waitFor();
    await page.getByLabel('Unique Taxpayer Reference (UTR)').fill('1234567890');
    await page.getByLabel('Other names you appear under on documents').fill('ST Design, Sam Taylor');
    await page.getByRole('button', { name: 'Save', exact: true }).click(); await toast(/Settings saved/);
  });

  await step('import a Monzo-style CSV: preview, edit a category, record', async () => {
    await fresh('/#/import');
    await page.setInputFiles('input[type=file]', `${F}/monzo.csv`);
    await page.getByRole('heading', { name: 'monzo.csv' }).waitFor();
    await page.getByText('Detected a spreadsheet table').waitFor();
    assert.equal(await card('monzo.csv').locator('table tbody tr').count(), 4);
    await shot('02_csv_preview');
    // the unknown cafe row has no category: choose one
    const rows = card('monzo.csv').locator('table tbody tr');
    const idx = await rows.evaluateAll((trs) => trs.findIndex((tr) => [...tr.querySelectorAll('input[type=text]')].some((i) => i.value.includes('UNKNOWN PLACE'))));
    assert.ok(idx >= 0, 'found the unknown-cafe row');
    await rows.nth(idx).locator('select').selectOption('drawings');
    await page.getByRole('button', { name: /Record 4 items/ }).click();
    await page.getByText(/recorded 4 transactions/).waitFor();
  });

  await step('import a PDF bank statement with columns', async () => {
    await fresh('/#/import');
    await page.setInputFiles('input[type=file]', `${F}/april-statement.pdf`);
    await page.getByRole('heading', { name: 'april-statement.pdf' }).waitFor();
    await page.getByText('Detected a bank / card statement').waitFor();
    const vals = await card('april-statement.pdf').locator('table tbody input[type=text]').evaluateAll((els) => els.map((e) => e.value).join(' | '));
    assert.match(vals, /SCREWFIX/); assert.match(vals, /BRIGHT CO/);
    const amounts = await card('april-statement.pdf').locator('table tbody tr td.num').allInnerTexts();
    assert.ok(amounts.some((t) => t.includes('-£120.00')), 'screwfix is money out');
    assert.ok(amounts.some((t) => t.includes('£1,500.00') && !t.includes('-')), 'bright co is money in');
    await shot('03_pdf_preview');
    await page.getByRole('button', { name: /Record \d+ items/ }).click();
    await page.getByText(/recorded 5 transactions/).waitFor();
  });

  await step('re-importing the same file skips every duplicate', async () => {
    await fresh('/#/import');
    await page.setInputFiles('input[type=file]', `${F}/april-statement.pdf`);
    await page.getByText(/exact file before/).waitFor();
    await page.getByText(/5 duplicates skipped/).waitFor();
    await page.getByRole('button', { name: 'Discard' }).click();
  });

  await step('supplier invoice PDF: expense with VAT details, vendor found', async () => {
    await fresh('/#/import');
    await page.setInputFiles('input[type=file]', `${F}/supplier-invoice.pdf`);
    await page.getByRole('heading', { name: 'supplier-invoice.pdf' }).waitFor();
    await page.getByText('Detected a single invoice or receipt').waitFor();
    const t = await card('supplier-invoice.pdf').locator('table tbody').innerText() + await card('supplier-invoice.pdf').locator('table tbody input[type=text]').evaluateAll((els) => els.map((e) => e.value).join(' '));
    assert.match(t, /Northern Paper Supplies/); assert.match(t, /-£240\.00/);
    await page.getByText('Unpaid bill').first().waitFor();
    await shot('04_invoice_preview');
    await page.getByRole('button', { name: /Record 1 item/ }).click(); await page.getByText(/recorded 1 transaction/).waitFor();
  });

  await step('photographed receipt is read with OCR', async () => {
    await fresh('/#/import');
    await page.setInputFiles('input[type=file]', `${F}/receipt.png`);
    await page.getByRole('heading', { name: 'receipt.png' }).waitFor({ timeout: 20000 });
    const t = await card('receipt.png').locator('table tbody').innerText() + await card('receipt.png').locator('table tbody input[type=text]').evaluateAll((els) => els.map((e) => e.value).join(' '));
    assert.match(t, /SCREWFIX/i); assert.match(t, /-£118\.79/);
    await page.getByText(/read from the image by OCR/).waitFor();
    await page.getByRole('button', { name: /Record 1 item/ }).click(); await page.getByText(/recorded 1 transaction/).waitFor();
  });

  await step('pasted free-form notes', async () => {
    await fresh('/#/import');
    await page.getByText('Paste text instead').click();
    await page.locator('textarea').fill('Paid £45.50 to Screwfix on 3 March 2025 for tools\nReceived £600 from Mrs Patel on 5/3/2025 - rent');
    await page.getByRole('button', { name: 'Read this text' }).click();
    await page.getByRole('heading', { name: 'Pasted text' }).waitFor();
    const amounts = await card('Pasted text').locator('table tbody tr td.num').allInnerTexts();
    assert.ok(amounts.some((t) => t.includes('-£45.50'))); assert.ok(amounts.some((t) => t.includes('£600.00')));
    await page.getByRole('button', { name: /Record 2 items/ }).click(); await page.getByText(/recorded 2 transactions/).waitFor();
  });

  await step('transactions list shows everything, review filter works, categorising clears the flag', async () => {
    await fresh('/#/transactions?taxYear=all');
    await page.locator('table tbody tr').first().waitFor();
    const n = await page.locator('table tbody tr').count(); assert.ok(n >= 12, `rows ${n}`);
    await fresh('/#/transactions?taxYear=all&status=review');
    await page.locator('table tbody tr').first().waitFor();
    const before = await page.locator('table tbody tr').count(); assert.ok(before >= 1);
    await page.locator('button', { hasText: 'Looks right' }).first().click();
    await page.waitForTimeout(600);
    assert.equal(await page.locator('table tbody tr').count(), before - 1);
    await shot('05_review');
  });

  await step('create a customer + invoice, issue it, record a payment', async () => {
    await fresh('/#/invoices/new');
    await page.getByRole('button', { name: 'New customer' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Name', { exact: true }).fill('Bright Co Ltd'); await dlg.getByLabel('Email', { exact: true }).fill('accounts@brightco.example');
    await dlg.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForTimeout(700);
    await page.getByPlaceholder('What you did or sold').fill('Website design');
    await page.getByLabel('Quantity').fill('3'); await page.getByLabel('Unit price').fill('250');
    await page.getByText('£750.00').first().waitFor();
    await page.getByRole('button', { name: 'Save & issue' }).click();
    await page.getByRole('heading', { name: /Invoice INV-0001/ }).waitFor();
    await shot('06_invoice_detail');
    await page.getByRole('button', { name: 'Record payment' }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click(); await toast(/Payment recorded/);
    await page.getByText('Paid', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Preview PDF' }).click();
    await page.locator('iframe.pdf-frame').waitFor();
  });

  await step('recurring invoice: create and run now', async () => {
    await fresh('/#/recurring');
    await page.getByRole('button', { name: 'New recurring invoice' }).first().click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Name').first().fill('Monthly retainer');
    await dlg.locator('select').first().selectOption({ label: 'Bright Co Ltd' });
    await page.getByPlaceholder('What you did or sold').fill('Retainer for {month} {year}');
    await page.getByLabel('Unit price').fill('500');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click(); await toast(/Saved/);
    await page.getByText('Monthly retainer').waitFor();
    await page.getByRole('button', { name: 'Create next now' }).click(); await toast(/Created INV-0002/);
    await shot('07_recurring');
    await fresh('/#/invoices');
    await page.getByText('INV-0002').waitFor();
  });

  await step('tax return for 2025-26 reflects the imports; drill-down shows the transactions', async () => {
    // With ~£460 of expenses the £1,000 trading allowance is worth more, so 'auto' must claim it...
    await fresh('/#/tax?tab=forms');
    await page.locator('select[aria-label="Tax year"]').selectOption('2025-26');
    await page.getByText('SA103F – Self-employment (full pages)').waitFor();
    await page.getByText('Trading income allowance claimed').waitFor();
    // ...and when the user opts out, the expense boxes appear.
    const r = await page.request.put(BASE + '/api/tax/2025-26/inputs', { data: { tradingAllowance: 'no' } });
    assert.equal(r.status(), 200);
    await page.reload(); await page.getByText('SA103F – Self-employment (full pages)').waitFor();
    const txt = await page.locator('main').innerText();
    assert.match(txt, /Your turnover/); assert.match(txt, /Box 15/); assert.match(txt, /Box 17/); assert.match(txt, /Box 31/);
    await page.locator('.ws-row', { hasText: 'Your turnover' }).getByRole('button', { name: 'see transactions' }).click();
    await page.getByRole('dialog').getByText('BRIGHT CO').first().waitFor();
    await shot('08_drill');
    await page.keyboard.press('Escape');
    await fresh('/#/tax?tab=overview');
    await page.getByText('Your estimated bill').waitFor();
    await shot('09_tax_overview');
  });

  await step('unsaved-input flow: employment + student loan changes the calculation', async () => {
    await fresh('/#/tax?tab=income');
    await page.getByRole('button', { name: 'Add employer' }).click();
    await page.getByLabel('Employer', { exact: true }).fill('Day Job Ltd');
    await page.getByLabel('Pay (P60)').fill('30000'); await page.getByLabel('UK tax taken off').fill('3486');
    await page.getByLabel('Student loan plan').selectOption('plan2');
    await page.getByRole('button', { name: 'Save changes' }).click(); await toast(/Saved/);
    await fresh('/#/tax?tab=forms');
    await page.getByText('SA102 – Employment').waitFor();
    await page.getByText('Day Job Ltd').first().waitFor();
  });

  await step('reports: P&L, VAT (not registered), quarterly', async () => {
    await fresh('/#/reports'); await page.getByText('Total income').waitFor();
    await fresh('/#/reports?tab=vat'); await page.getByText("You're not VAT registered").waitFor();
    await fresh('/#/reports?tab=quarterly'); await page.getByText(/Update 1:/).waitFor();
  });

  await step('dashboard with data: chart tooltip + table view', async () => {
    await fresh('/#/dashboard');
    await page.locator('select[aria-label="Tax year"]').selectOption('2025-26');
    await page.locator('.chart svg').waitFor();
    await page.locator('.chart .hit').nth(3).hover();
    await page.locator('.tip').waitFor();
    assert.match(await page.locator('.tip').innerText(), /Money in/);
    await shot('10_dashboard_tooltip');
    await page.getByRole('button', { name: 'View as table' }).click();
    await page.locator('.chart-table, table caption').first().waitFor({ state: 'attached' });
    await shot('11_dashboard_table');
  });

  await step('dark mode renders', async () => {
    await page.emulateMedia({ colorScheme: 'dark' }); await page.reload(); await page.waitForSelector('.shell'); await page.waitForTimeout(600);
    await page.getByRole('button', { name: 'View chart' }).click().catch(() => {});
    await shot('12_dark');
  });

  await step('mobile layout: menu opens, no horizontal overflow', async () => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 390, height: 800 });
    await fresh('/#/transactions?taxYear=all'); await page.waitForSelector('.topbar');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, 'page scrolls horizontally by ' + overflow);
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('link', { name: 'Tax return' }).waitFor(); await shot('13_mobile_menu');
  });

  await browser.close();
  await stop();
  console.log(problems.length ? `\n${problems.length} PROBLEM(S): ${problems.join(' | ')}` : '\nALL E2E STEPS PASSED');
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error('E2E CRASHED', e); process.exit(2); });
