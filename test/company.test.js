import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, companyDb, addTxn, addContact, gbp } from './helpers.js';
import { getSettings, saveSettings, setTaxInput } from '../server/db.js';
import { companyPeriods, ctPeriods, ctCharge, companyOverview, companyPnl, corporationTax, balanceSheet, loansToParticipators, declareDividend, directorDividendSummary, s455RateFor, syncAssets, trialBalance, trialBalanceCsv, directorBalances, distributableReserves, companyDeadlines, assetDepreciation, findPeriod } from '../server/domain/company.js';
import { loadEntries, spreadPortion } from '../server/domain/ledger.js';
import { vatReturn } from '../server/domain/vat.js';
import { createInvoice, setInvoiceStatus } from '../server/domain/invoices.js';

const settingsOf = (db) => getSettings(db);

test('accounting periods: first period, 12-month years, long first period splits for Corporation Tax', () => {
  const mk = (inc, asOf = '2027-06-01') => companyPeriods({ company: { incorporationDate: inc, yearEndMonth: 3, yearEndDay: 31 } }, { asOf });
  const a = mk('2025-04-01');
  assert.deepEqual(a.slice(0, 2).map((p) => [p.start, p.end]), [['2025-04-01', '2026-03-31'], ['2026-04-01', '2027-03-31']]);
  assert.equal(a[0].label, 'Year ended 31 Mar 2026');
  assert.equal(a[0].longerThanYear, false);
  const b = mk('2025-03-10')[0]; // 12 months + 3 weeks: allowed for accounts, but two Corporation Tax periods
  assert.deepEqual([b.start, b.end, b.longerThanYear], ['2025-03-10', '2026-03-31', true]);
  assert.deepEqual(ctPeriods(b).map((p) => [p.start, p.end]), [['2025-03-10', '2026-03-09'], ['2026-03-10', '2026-03-31']]);
  assert.equal(mk('2025-06-15')[0].end, '2026-03-31', 'a first period must not exceed 18 months');
});

test('Corporation Tax: small profits, marginal relief, main rate (textbook figures)', () => {
  const tax = (profits, extra = {}) => ctCharge({ profits: gbp(profits), ...extra }).tax;
  assert.equal(tax(40000), gbp(7600));
  assert.equal(tax(50000), gbp(9500));
  assert.equal(tax(60000), gbp(12150)); // 9,500 + 26.5% of the next 10,000
  assert.equal(tax(100000), gbp(22750)); // 25,000 - 3/200 * 150,000
  assert.equal(tax(250000), gbp(62500));
  assert.equal(tax(300000), gbp(75000));
  assert.equal(ctCharge({ profits: gbp(100000) }).band, 'marginal');
});

test('Corporation Tax: associated companies halve the limits; short periods scale them', () => {
  assert.equal(ctCharge({ profits: gbp(100000), associated: 1 }).tax, gbp(24625)); // limits 25k / 125k
  const short = ctCharge({ profits: gbp(30000), days: 182 });
  assert.equal(short.tax, 750000 - Math.round(0.015 * (Math.round(25000000 * 182 / 365) - 3000000)));
  assert.equal(ctCharge({ profits: gbp(20000), days: 182 }).band, 'small');
});

test('s455 rate depends on the date the loan was made', () => {
  assert.equal(s455RateFor('2026-04-05'), 0.3375);
  assert.equal(s455RateFor('2026-04-06'), 0.3575);
  assert.equal(s455RateFor('2024-01-01'), 0.3375);
});

test('spreading: portions are day-exact and add up to the whole across periods', () => {
  const a = spreadPortion(120000, '2025-10-01', '2026-09-30', '2025-04-01', '2026-03-31');
  const b = spreadPortion(120000, '2025-10-01', '2026-09-30', '2026-04-01', '2027-03-31');
  assert.equal(a.amount, Math.round((120000 * 182) / 365));
  assert.equal(a.amount + b.amount, 120000);
  assert.equal(spreadPortion(120000, '2025-10-01', '2026-09-30', '2024-01-01', '2025-03-31').amount, 0);
});

test('an annual subscription paid up front is income across the months it covers, not when it arrives', () => {
  const { db } = companyDb();
  addTxn(db, { date: '2025-10-01', amount: 1200, category: 'co_subscriptions', desc: 'Annual plan – Acme', spread: ['2025-10-01', '2026-09-30'] });
  const s = settingsOf(db);
  const y1 = loadEntries(db, '2025-04-01', '2026-03-31', { settings: s }).entries;
  const y2 = loadEntries(db, '2026-04-01', '2027-03-31', { settings: s }).entries;
  assert.equal(y1.reduce((a, e) => a + e.net, 0), Math.round((120000 * 182) / 365));
  assert.equal(y1.reduce((a, e) => a + e.net, 0) + y2.reduce((a, e) => a + e.net, 0), 120000);
});

// ------------------------------------------------------------------ a worked company year

function workedYear() {
  const ctx = companyDb();
  const { db, c1, dla1 } = ctx;
  addTxn(db, { date: '2025-04-01', amount: 100, category: 'share_capital', desc: 'Share capital paid in' });
  addTxn(db, { date: '2025-06-01', amount: 5000, category: 'co_subscriptions', desc: 'STRIPE PAYOUT' });
  addTxn(db, { date: '2025-07-01', amount: 3000, category: 'co_advertising_income', desc: 'GOOGLE ADMOB' });
  addTxn(db, { date: '2025-08-01', amount: -1200, category: 'co_hosting', desc: 'AWS' });
  addTxn(db, { date: '2025-09-01', amount: -120, category: 'co_domains', desc: 'NAMECHEAP annual', spread: ['2025-09-01', '2026-08-31'] });
  addTxn(db, { date: '2025-05-01', amount: -1500, category: 'co_equipment', desc: 'MACBOOK PRO' });
  addTxn(db, { date: '2025-11-01', amount: -60, category: 'co_software', desc: 'GITHUB (paid by Sam personally)', account: dla1 });
  return { ...ctx, c1 };
}
const P1 = '2025-04-01_2026-03-31';

test('P&L: spreads the domain, depreciates the laptop, and the tax computation uses the Annual Investment Allowance', () => {
  const { db } = workedYear();
  const s = settingsOf(db);
  syncAssets(db, s);
  const period = findPeriod(s, P1);
  const pnl = companyPnl(db, s, period);
  const domain = Math.round((12000 * 212) / 365); // 1 Sep 2025 - 31 Mar 2026 is 212 of 365 days
  const dep = Math.round((150000 * 335) / 1096);
  assert.equal(pnl.turnover, gbp(8000));
  assert.equal(pnl.depreciation, dep);
  assert.equal(pnl.totalExpenses, 120000 + domain + 6000 + dep);
  const ct = corporationTax(db, s, period, { pnl });
  const r = ct.rows[0];
  assert.equal(r.capitalAllowances, gbp(1500));
  assert.equal(r.tradingProfitBeforeLosses, pnl.profitBeforeTax + dep - gbp(1500));
  assert.equal(ct.tax, Math.round(r.chargeable * 0.19));
  assert.equal(r.charge.band, 'small');
});

test('balance sheet balances, with prepayment, asset, director-loan and tax creditors', () => {
  const { db } = workedYear();
  const s = settingsOf(db);
  syncAssets(db, s);
  const period = findPeriod(s, P1);
  const bs = balanceSheet(db, s, period);
  assert.equal(bs.cash, gbp(5280)); // 100 + 5,000 + 3,000 - 1,200 - 120 - 1,500
  assert.equal(bs.prepayments, 12000 - Math.round((12000 * 212) / 365));
  assert.equal(bs.dlaOwedToDirectors, gbp(60));
  assert.equal(bs.fixedAssets.nbv, 150000 - Math.round((150000 * 335) / 1096));
  assert.equal(bs.shareCapital, gbp(100));
  assert.ok(bs.ctOwed > 0);
  assert.equal(bs.balanced, true, `difference ${bs.difference}`);
});

test('a transaction left uncategorised is exposed as an unreconciled difference (not plugged away)', () => {
  const { db } = workedYear();
  addTxn(db, { date: '2025-12-01', amount: -50, desc: 'MYSTERY' });
  const s = settingsOf(db);
  syncAssets(db, s);
  const period = findPeriod(s, P1);
  const bs = balanceSheet(db, s, period);
  assert.equal(bs.balanced, false);
  assert.equal(bs.difference, -gbp(50));
  assert.ok(bs.explain.some((e) => /uncategorised/.test(e.text)));
  const ov = companyOverview(db, P1);
  assert.ok(ov.warnings.some((w) => w.level === 'error' && /balance sheet is out/.test(w.text)));
  assert.ok(ov.warnings.some((w) => w.level === 'error' && /no category/.test(w.text)));
});

test('trial balance: debits equal credits, no suspense line when the books agree', () => {
  const { db } = workedYear();
  const ov = companyOverview(db, P1);
  const tb = trialBalance(db, settingsOf(db), ov.period, { pnl: ov.pnl, ct: ov.ct, bs: ov.balanceSheet });
  assert.equal(tb.debit, tb.credit);
  assert.ok(!tb.rows.some((r) => r.code === '9999'));
  const csv = trialBalanceCsv(tb, ov.period);
  assert.match(csv, /Code,Account,Debit,Credit/);
  assert.match(csv, /Corporation Tax charge/);
});

test('the CT600 worksheet carries the verified boxes and the right figures', () => {
  const { db } = workedYear();
  const ov = companyOverview(db, P1);
  const ct600 = ov.forms.find((f) => f.id === 'CT600');
  const rows = ct600.pages[1].rows;
  const box = (n) => rows.find((r) => r.box === n);
  assert.equal(box('145').value, gbp(8000));
  assert.equal(box('155').value, ov.ct.rows[0].tradingProfitBeforeLosses);
  assert.equal(box('475').value, ov.ct.tax);
  assert.equal(box('510').value, ov.ct.tax);
  assert.match(ct600.intro, /closed on 31 March 2026/);
});

test('deadlines: tax 9 months + 1 day, return 12 months, accounts 9 months', () => {
  const s = { company: { incorporationDate: '2025-04-01' } };
  const d = companyDeadlines(s, { start: '2025-04-01', end: '2026-03-31', days: 365, longerThanYear: false }, '2026-05-01');
  assert.equal(d.find((x) => /Pay Corporation Tax/.test(x.title)).date, '2027-01-01');
  assert.equal(d.find((x) => /CT600/.test(x.title)).date, '2027-03-31');
  assert.equal(d.find((x) => /Companies House/.test(x.title)).date, '2026-12-31');
});

// ------------------------------------------------------------------ directors, loans, dividends

test("overdrawn director's loan: balance, s455 at 33.75% for an old loan, 35.75% for a new one", () => {
  const { db, c1, dla1 } = companyDb();
  addTxn(db, { date: '2025-11-01', amount: -60, category: 'co_software', desc: 'GitHub', account: dla1 });
  addTxn(db, { date: '2026-02-10', amount: -2000, category: 'dla_movement', desc: 'Transfer to Sam', contact: c1 });
  const s = settingsOf(db);
  const period = findPeriod(s, P1);
  const loans = loansToParticipators(db, s, period);
  assert.equal(loans.rows.length, 1);
  assert.equal(loans.rows[0].balance, gbp(2000) - gbp(60)); // overdrawn by 1,940
  assert.equal(loans.rows[0].rate, 0.3375);
  assert.equal(loans.rows[0].s455, Math.round(194000 * 0.3375));
  assert.equal(loans.repayBy, '2027-01-01');
  assert.equal(directorBalances(db, s, '2026-03-31').find((d) => d.director.id === 'd1').balance, 194000);
  // a later loan in the next period attracts the higher rate
  addTxn(db, { date: '2026-05-01', amount: -1000, category: 'dla_movement', desc: 'Transfer to Alex', contact: db.get("SELECT id FROM contacts WHERE name = 'Alex'").id });
  const p2 = findPeriod(s, '2026-04-01_2027-03-31');
  const l2 = loansToParticipators(db, s, p2);
  assert.equal(l2.rows.find((r) => r.director === 'Alex').rate, 0.3575);
});

test('the overdrawn-loan warning appears on the overview', () => {
  const { db, c1 } = companyDb();
  addTxn(db, { date: '2025-06-01', amount: 5000, category: 'co_subscriptions' });
  addTxn(db, { date: '2025-11-01', amount: -12000, category: 'dla_movement', contact: c1 });
  const ov = companyOverview(db, P1);
  const w = ov.warnings.find((x) => /owe the company/.test(x.text));
  assert.ok(w);
  assert.equal(w.level, 'error', 'over £10,000 is also a benefit in kind');
  assert.ok(ov.forms.find((f) => f.id === 'CT600A').applies);
});

test('dividends: split by shares, creates the bank payment, and refuses to pay out profit that does not exist', () => {
  const { db } = workedYear();
  const s = settingsOf(db);
  const r = declareDividend(db, s, { declared_date: '2026-02-01', paid_date: '2026-02-01', total: gbp(1001) });
  assert.deepEqual(r.allocations.map((a) => a.amount), [50050, 50050]);
  const txn = db.get("SELECT * FROM transactions WHERE category_id = 'dividend_paid'");
  assert.equal(txn.amount, -gbp(1001));
  assert.throws(() => declareDividend(db, s, { declared_date: '2026-02-02', total: gbp(50000) }), (e) => e.code === 'insufficient_reserves');
  const forced = declareDividend(db, s, { declared_date: '2026-02-02', total: gbp(50000), acknowledge: true });
  assert.ok(forced.id);
  // an odd penny goes to the last shareholder so the parts always add up
  const odd = declareDividend(db, s, { declared_date: '2026-02-03', total: 1, acknowledge: true });
  assert.equal(odd.allocations.reduce((a, x) => a + x.amount, 0), 1);
});

test('the books still balance after a dividend is paid', () => {
  const { db } = workedYear();
  declareDividend(db, settingsOf(db), { declared_date: '2026-02-01', total: gbp(1000) });
  const ov = companyOverview(db, P1);
  assert.equal(ov.balanceSheet.dividends, gbp(1000));
  assert.equal(ov.balanceSheet.balanced, true, `difference ${ov.balanceSheet.difference}`);
});

test("each director's dividends and personal tax estimate (no salary: personal allowance covers the first £12,570)", () => {
  const { db } = workedYear();
  const s = settingsOf(db);
  declareDividend(db, s, { declared_date: '2026-02-01', total: gbp(1000) });
  const small = directorDividendSummary(db, s, '2025-26');
  assert.equal(small[0].dividends, gbp(500));
  assert.equal(small[0].estimatedTax, 0);
  declareDividend(db, s, { declared_date: '2026-03-01', total: gbp(59000), acknowledge: true }); // 29,500 each
  const big = directorDividendSummary(db, s, '2025-26');
  assert.equal(big[0].dividends, gbp(500) + gbp(29500));
  // 30,000 dividends, nothing else: (30,000 - 12,570 PA - 500 allowance) at 8.75%
  assert.equal(big[0].estimatedTax, Math.round(gbp(16930) * 0.0875));
});

// ------------------------------------------------------------------ VAT for an overseas-facing digital business

test('VAT: overseas ad revenue goes in Box 6; reverse-charged hosting is in Boxes 1, 4, 6 and 7 and nets to nil', () => {
  const { db } = companyDb({ vat: { registered: true, scheme: 'standard' } });
  const cust = addContact(db, 'UK Customer Ltd');
  setInvoiceStatus(db, createInvoice(db, { contact_id: cust, issue_date: '2025-05-05', category_id: 'co_subscriptions', lines: [{ description: 'Licence', quantity: 1, unit_price: gbp(1000), vat_code: 'S' }] }).id, 'sent');
  addTxn(db, { date: '2025-05-20', amount: 500, category: 'co_advertising_income', desc: 'GOOGLE ADMOB', vatCode: 'OB' });
  addTxn(db, { date: '2025-05-10', amount: -100, category: 'co_hosting', desc: 'AWS EMEA', vatCode: 'RC' });
  const v = vatReturn(db, '2025-04-01', '2025-06-30');
  assert.equal(v.boxes.box1, gbp(200) + gbp(20)); // UK sale VAT + reverse-charge VAT on hosting
  assert.equal(v.boxes.box4, gbp(20));
  assert.equal(v.boxes.box5, gbp(200)); // the reverse charge nets to nil
  assert.equal(v.boxes.box6, gbp(1000) + gbp(500) + gbp(100));
  assert.equal(v.boxes.box7, gbp(100));
});

test('asset sync: equipment purchases become assets exactly once, VAT-exclusive when VAT registered', () => {
  const { db } = companyDb({ vat: { registered: true } });
  addTxn(db, { date: '2025-05-01', amount: -1200, vat: 200, vatCode: 'S', category: 'co_equipment', desc: 'LAPTOP' });
  const s = settingsOf(db);
  assert.equal(syncAssets(db, s), 1);
  assert.equal(syncAssets(db, s), 0);
  assert.equal(db.get('SELECT cost FROM assets').cost, gbp(1000));
});

test('depreciation stops at disposal and never exceeds cost', () => {
  const a = { cost: 150000, purchase_date: '2025-05-01', life_years: 3, business_pct: 100, disposal_date: null };
  const total = assetDepreciation(a, '2025-05-01', '2040-01-01');
  assert.equal(total, 150000);
  const sold = assetDepreciation({ ...a, disposal_date: '2026-05-01' }, '2025-05-01', '2040-01-01');
  assert.ok(sold < 150000 && sold > 0);
});

test('company overview requires company mode and a long first period is flagged', () => {
  const db = freshDb();
  assert.throws(() => companyOverview(db, undefined), /limited company/);
  const { db: cdb } = companyDb({ company: { incorporationDate: '2025-03-10', yearEndMonth: 3, yearEndDay: 31 } });
  addTxn(cdb, { date: '2025-06-01', amount: 1000, category: 'co_subscriptions' });
  const ov = companyOverview(cdb, '2025-03-10_2026-03-31');
  assert.equal(ov.ct.rows.length, 2);
  assert.ok(ov.warnings.some((w) => /two Corporation Tax periods/.test(w.text)));
  assert.equal(ov.ct.rows[0].profitBeforeTax + ov.ct.rows[1].profitBeforeTax, ov.pnl.profitBeforeTax);
});
