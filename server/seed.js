// Demo data: a freelance designer with a rental flat, spanning last tax year and this one so every
// screen has something to show. `npm run seed` loads it from the command line; the dashboard has a
// button too. resetAll() wipes your records (keeping the passcode) so you can start for real.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, openDb, saveSettings, getSettings, setTaxInput } from './db.js';
import { createTransaction } from './domain/transactions.js';
import { createInvoice, setInvoiceStatus, recordPayment, getInvoice } from './domain/invoices.js';
import { createTemplate, runDue } from './domain/recurring.js';
import { currentTaxYear, taxYearStartYear, addDays, addMonths, today } from './util/dates.js';
import { seedCategories } from './domain/categories.js';
import { ensureDirectorRecords, declareDividend } from './domain/company.js';

const P = (x) => Math.round(x * 100);

export function isEmpty(db) {
  return db.get('SELECT (SELECT COUNT(*) FROM transactions) + (SELECT COUNT(*) FROM invoices) + (SELECT COUNT(*) FROM contacts) AS n').n === 0;
}

export function resetAll(db) {
  db.tx(() => {
    for (const t of ['transactions', 'invoice_lines', 'invoices', 'recurring_templates', 'assets', 'mileage', 'disposals', 'tax_inputs', 'vat_returns', 'import_batches', 'documents', 'rules', 'contacts', 'audit_log']) db.run(`DELETE FROM ${t}`);
    db.run('DELETE FROM categories WHERE builtin = 0');
    db.run('DELETE FROM accounts');
    db.run("DELETE FROM settings WHERE key = 'app'");
    db.run("INSERT INTO accounts (name, kind) VALUES ('Business current account', 'bank')");
    db.run("INSERT INTO accounts (name, kind) VALUES ('Cash & receipts (no bank match yet)', 'cash')");
    seedCategories(db);
  });
  fs.rmSync(path.join(DATA_DIR, 'uploads'), { recursive: true, force: true });
}

export function seedDemo(db, type = 'individual') {
  if (type === 'company') return seedCompanyDemo(db);
  if (!isEmpty(db)) throw Object.assign(new Error('Demo data can only be loaded into an empty set of accounts.'), { status: 400 });
  const ty = currentTaxYear();
  const y0 = taxYearStartYear(ty) - 1; // last tax year starts here
  const asOf = today();
  saveSettings(db, {
    profile: { name: 'Sam Taylor', tradingName: 'ST Design', utr: '1234567890', nino: 'QQ123456C', email: 'sam@stdesign.example', address: '14 Mill Lane\nLeeds', postcode: 'LS1 4AB', businessDescription: 'Freelance graphic design', businessPostcode: 'LS1 4AB', region: 'england', aliases: 'ST Design, Sam Taylor' },
    invoice: { bankDetails: 'ST Design\nSort code 20-45-67\nAccount 12345678', paymentTermsDays: 30, notes: 'Thank you – payment within 30 days please.' },
    businessStartDate: `${y0 - 2}-06-01`,
  });
  const bank = 1;
  const savings = db.run("INSERT INTO accounts (name, kind, opening_balance) VALUES ('Savings', 'bank', ?)", P(8000)).id;
  db.run('UPDATE accounts SET opening_balance = ? WHERE id = 1', P(2500));
  const contact = (name, kind, email, terms) => db.run('INSERT INTO contacts (name, kind, email, payment_terms_days) VALUES (?, ?, ?, ?)', name, kind, email || null, terms ?? null).id;
  const bright = contact('Bright Co Ltd', 'customer', 'accounts@brightco.example', 14);
  const harbour = contact('Harbour Studio', 'customer', 'hello@harbour.example');
  const kelly = contact('Kelly & Sons Bakery', 'customer', 'orders@kellys.example');
  contact('Adobe', 'supplier'); contact('Leeds Lets', 'supplier');

  const txn = (date, amount, description, category, extra = {}) => { if (date > asOf) return; createTransaction(db, { account_id: bank, date, amount: P(amount), description, category_id: category, status: 'confirmed', source: 'import', ...extra }); };
  const line = (description, price, qty = 1) => ({ description, quantity: qty, unit_price: P(price), vat_code: 'N' });
  const issue = (cid, date, lines, { paid = null, ref } = {}) => {
    if (date > asOf) return null;
    const inv = setInvoiceStatus(db, createInvoice(db, { contact_id: cid, issue_date: date, due_date: addDays(date, 14), lines, reference: ref }).id, 'sent');
    if (paid && addDays(date, paid) <= asOf) recordPayment(db, inv.id, { account_id: bank, date: addDays(date, paid), amount: inv.totals.gross });
    return getInvoice(db, inv.id);
  };

  // --- two years of monthly activity
  for (let m = 0; m < 20; m++) {
    const d = addMonths(`${y0}-04-06`, m);
    const date = (day) => `${d.slice(0, 8)}${String(day).padStart(2, '0')}`;
    issue(bright, date(8), [line(`Retainer – design support`, 1800)], { paid: 6 });
    if (m % 3 === 1) issue(harbour, date(14), [line('Brand identity project – milestone', 2400 + (m % 5) * 150)], { paid: m % 4 === 0 ? 30 : 12 });
    if (m % 4 === 2) issue(kelly, date(20), [line('Packaging design', 950), line('Artwork revisions', 85, 3)], { paid: 20 });
    txn(date(3), -54.99, 'ADOBE SYSTEMS CREATIVE CLOUD', 'se_admin');
    txn(date(5), -35, 'O2 MOBILE', 'se_admin', { business_pct: 70 });
    txn(date(9), -150, 'THE HUB COWORKING', 'se_premises');
    txn(date(11), -(40 + (m * 7) % 35), 'SHELL SERVICE STATION', 'se_travel');
    if (m % 2 === 0) txn(date(16), -(28 + (m * 3) % 20), 'TRAINLINE LEEDS-LONDON', 'se_travel');
    txn(date(18), -12.5, 'XERO SUBSCRIPTION', 'se_admin');
    txn(date(20), -9.5, 'MONTHLY ACCOUNT FEE', 'se_bank');
    txn(date(21), -(210 + (m * 13) % 90), 'TESCO STORES', 'drawings');
    // rental flat
    txn(date(1), 850, 'FASTER PAYMENT MRS PATEL RENT', 'prop_rent');
    txn(date(1), -420, 'HALIFAX MORTGAGE INTEREST', 'prop_finance_res');
    txn(date(2), -85, 'LEEDS LETS MANAGEMENT FEE', 'prop_professional');
    if (m % 5 === 3) txn(date(12), -(120 + m * 6), 'ABC PLUMBING REPAIR', 'prop_repairs');
  }
  txn(`${y0}-05-20`, -1299, 'APPLE STORE MACBOOK PRO', 'se_capital');
  txn(`${y0}-06-15`, -280, 'LANDLORD INSURANCE AVIVA', 'prop_rates_ins');
  txn(`${y0 + 1}-06-15`, -296, 'LANDLORD INSURANCE AVIVA', 'prop_rates_ins');
  txn(`${y0}-10-30`, -420, 'WILSON & CO ACCOUNTANTS', 'se_professional');
  txn(`${y0}-12-02`, -200, 'JUST GIVING DONATION', 'gift_aid');
  txn(`${y0 + 1}-01-02`, 45.2, 'SAVINGS INTEREST GROSS', 'int_bank', { account_id: savings });
  txn(`${y0 + 1}-01-30`, -2150, 'HMRC SELF ASSESSMENT PAYMENT', 'hmrc_payment');
  txn(`${y0 + 1}-07-31`, -2150, 'HMRC SELF ASSESSMENT PAYMENT', 'hmrc_payment');
  // a few that need a human
  txn(addDays(asOf, -9), -64.2, 'AMAZON MKTPLACE PMTS', 'se_admin', { status: 'review', confidence: 0.45 });
  txn(addDays(asOf, -6), -19.99, 'MYSTERY PAYEE 4471', null, { status: 'review' });
  txn(addDays(asOf, -4), -240, 'CARD PAYMENT WILKO TRADING', null, { status: 'review' });

  // overdue + current invoices
  issue(harbour, addDays(asOf, -52), [line('Website illustration set', 1650)]);
  issue(kelly, addDays(asOf, -18), [line('Menu redesign', 720)]);
  issue(bright, addDays(asOf, -3), [line('Retainer – design support', 1800)]);
  setInvoiceStatus(db, createInvoice(db, { contact_id: harbour, issue_date: asOf, lines: [line('Annual report layout', 3200)], notes: 'Draft – awaiting final page count' }).id, 'draft');

  createTemplate(db, { name: 'Bright Co monthly retainer', contact_id: bright, frequency: 'monthly', start_date: addMonths(`${asOf.slice(0, 7)}-08`, asOf.slice(8) < '08' ? 0 : 1), due_days: 14, mode: 'issue', lines: [{ description: 'Retainer for {month} {year}', quantity: 1, unit_price: P(1800), vat_code: 'N' }] });
  runDue(db);

  // mileage, home office, shares disposal, tax inputs
  for (const [date, from, to, miles, purpose] of [[`${y0}-09-12`, 'Leeds', 'Manchester', 86, 'Client workshop'], [`${y0}-11-04`, 'Leeds', 'York', 48, 'Print supplier'], [`${y0 + 1}-02-19`, 'Leeds', 'Sheffield', 72, 'Client meeting']]) {
    db.run('INSERT INTO mileage (date, from_place, to_place, miles, vehicle, purpose) VALUES (?, ?, ?, ?, ?, ?)', date, from, to, miles, 'car', purpose);
  }
  const ly = `${y0}-${String((y0 + 1) % 100).padStart(2, '0')}`;
  setTaxInput(db, ly, 'homeOfficeHours', Object.fromEntries(Array.from({ length: 12 }, (_, i) => [addMonths(`${y0}-04-01`, i).slice(0, 7), 60 + (i % 3) * 30])));
  setTaxInput(db, ly, 'payments', [{ date: `${y0 + 1}-01-30`, amount: P(2150), note: 'Payment on account' }, { date: `${y0 + 1}-07-31`, amount: P(2150), note: 'Payment on account' }]);
  db.run("INSERT INTO disposals (description, asset_type, acquired_date, disposal_date, proceeds, cost, costs, residential) VALUES ('200 shares in Acme plc', 'shares', ?, ?, ?, ?, ?, 0)", `${y0 - 3}-03-10`, `${y0 + 1}-02-14`, P(9800), P(5200), P(40));
  db.run("INSERT INTO rules (pattern, match_type, direction, category_id) VALUES ('mrs patel', 'contains', 'in', 'prop_rent')");
  return { transactions: db.get('SELECT COUNT(*) AS n FROM transactions').n, invoices: db.get('SELECT COUNT(*) AS n FROM invoices').n };
}

/** Pixel Pond Ltd: two directors, no salary, apps funded by ads, app-store sales and subscriptions. */
export function seedCompanyDemo(db) {
  if (!isEmpty(db)) throw Object.assign(new Error('Demo data can only be loaded into an empty set of accounts.'), { status: 400 });
  const asOf = today();
  const inc = '2025-04-01';
  saveSettings(db, {
    entityType: 'company',
    company: { name: 'Pixel Pond Ltd', number: '12345678', utr: '1234567890', incorporationDate: inc, yearEndMonth: 3, yearEndDay: 31, registeredOffice: '14 Mill Lane, Leeds', postcode: 'LS1 4AB', shareCapital: 100, associatedCompanies: 0, natureOfBusiness: 'Mobile app development and publishing',
      directors: [{ id: 'dir_sam', name: 'Sam Taylor', shares: 50 }, { id: 'dir_alex', name: 'Alex Taylor', shares: 50 }] },
    invoice: { prefix: 'PP-', bankDetails: 'Pixel Pond Ltd\nSort code 20-45-67\nAccount 12345678', paymentTermsDays: 30 },
  });
  ensureDirectorRecords(db);
  const bank = 1;
  const sam = db.get("SELECT id FROM contacts WHERE name = 'Sam Taylor'").id;
  const samDla = db.get("SELECT id FROM accounts WHERE director_id = 'dir_sam'").id;
  const harbour = db.run("INSERT INTO contacts (name, kind, email, payment_terms_days) VALUES ('Harbour Media Ltd', 'customer', 'accounts@harbourmedia.example', 14)").id;
  const txn = (date, amount, description, category, extra = {}) => {
    if (date > asOf) return;
    const { spread, ...rest } = extra;
    createTransaction(db, { account_id: bank, date, amount: P(amount), description, category_id: category, status: 'confirmed', source: 'import', ...(spread ? { spread_from: spread[0], spread_to: spread[1] } : {}), ...rest });
  };

  txn(inc, 100, 'SHARE CAPITAL PAID IN', 'share_capital');
  txn('2025-05-03', -1799, 'APPLE STORE MACBOOK PRO', 'co_equipment');
  txn('2025-05-10', -79, 'APPLE DEVELOPER PROGRAM ANNUAL', 'co_software', { spread: ['2025-05-10', '2026-05-09'] });
  for (let m = 0; m < 20; m++) {
    const d = addMonths(`${inc.slice(0, 7)}-01`, m);
    const day = (n) => `${d.slice(0, 8)}${String(n).padStart(2, '0')}`;
    if (m >= 1) {
      txn(day(14), 620 + ((m * 137) % 780), 'GOOGLE ADMOB PAYMENT', 'co_advertising_income');
      txn(day(20), 410 + ((m * 91) % 360), 'APPLE DISTRIBUTION INTERNATIONAL', 'co_inapp');
      txn(day(25), 880 + ((m * 173) % 1100), 'STRIPE PAYOUT', 'co_subscriptions');
      txn(day(8), -(190 + ((m * 53) % 140)), 'AWS EMEA SARL', 'co_hosting');
      txn(day(9), -150, 'FACEBK ADS', 'co_marketing');
      txn(day(12), -24, 'CLOUDFLARE', 'co_hosting');
      txn(day(15), -4, 'GITHUB', 'co_software');
      txn(day(26), -(28 + ((m * 11) % 20)), 'STRIPE FEES', 'co_platform_fees');
    }
  }
  txn('2025-09-01', 1200, 'ANNUAL PLAN – Acme Studios (12 months)', 'co_subscriptions', { spread: ['2025-09-01', '2026-08-31'] });
  txn('2025-09-02', -9.98, 'NAMECHEAP pixelpond.app – 1 year', 'co_domains', { spread: ['2025-09-02', '2026-09-01'] });
  txn('2025-10-30', -300, 'WILSON & CO ACCOUNTANTS', 'co_professional');
  txn('2026-04-14', -34, 'COMPANIES HOUSE CONFIRMATION STATEMENT', 'co_admin');
  // a director pays for a domain personally: it is a company expense funded by a director's loan
  createTransaction(db, { account_id: samDla, date: '2025-11-05', description: 'GODADDY pixelpond.co.uk (paid by Sam personally)', amount: -P(14.99), category_id: 'co_domains', status: 'confirmed', source: 'manual', spread_from: '2025-11-05', spread_to: '2026-11-04' });

  // customer invoices (a custom licence) – one settled, one overdue
  const line = (d, p) => ({ description: d, quantity: 1, unit_price: P(p), vat_code: 'N' });
  const inv = (date, lines, paid) => { if (date > asOf) return; const i = setInvoiceStatus(db, createInvoice(db, { contact_id: harbour, issue_date: date, due_date: addDays(date, 14), lines, category_id: 'co_other_income' }).id, 'sent'); if (paid && addDays(date, paid) <= asOf) recordPayment(db, i.id, { account_id: bank, date: addDays(date, paid), amount: i.totals.gross }); };
  inv('2025-12-01', [line('Enterprise licence – Q4 2025', 2400)], 10);
  inv('2026-03-01', [line('Enterprise licence – Q1 2026', 2400)], 12);
  inv(addDays(asOf, -40), [line('Enterprise licence – current quarter', 2600)]);

  // a dividend, and a few things that need a human
  if (asOf >= '2026-02-01') declareDividend(db, getSettings(db), { declared_date: '2026-02-01', paid_date: '2026-02-01', total: P(6000), notes: 'Interim dividend' });
  txn(addDays(asOf, -9), -64.2, 'AMAZON MKTPLACE PMTS', 'co_other', { status: 'review', confidence: 0.45 });
  txn(addDays(asOf, -6), -42.5, 'TESCO STORES 4471', 'dla_movement', { contact_id: sam, status: 'review', confidence: 0.65 });
  txn(addDays(asOf, -3), -19.99, 'MYSTERY PAYEE 9921', null, { status: 'review' });
  createTemplate(db, { name: 'Harbour Media – licence', contact_id: harbour, frequency: 'quarterly', start_date: addMonths(`${asOf.slice(0, 7)}-01`, 1), due_days: 14, mode: 'draft', category_id: 'co_other_income', lines: [{ description: 'Enterprise licence – {quarter} {year}', quantity: 1, unit_price: P(2600), vat_code: 'N' }] });
  return { transactions: db.get('SELECT COUNT(*) AS n FROM transactions').n, invoices: db.get('SELECT COUNT(*) AS n FROM invoices').n };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = openDb();
  try { console.log('Loaded demo data:', seedDemo(db, process.argv[2] === 'company' ? 'company' : 'individual')); } catch (e) { console.error(e.message); process.exit(1); }
}
