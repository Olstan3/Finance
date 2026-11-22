import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, addContact, addTxn, gbp } from './helpers.js';
import { createInvoice, getInvoice, recordPayment, setInvoiceStatus, invoiceTotals, receivablesAging, deleteInvoice, creditNoteFor, nextInvoiceNumber } from '../server/domain/invoices.js';
import { createTemplate, runDue, advance, renderPlaceholders, previewDates, getTemplate } from '../server/domain/recurring.js';
import { vatReturn } from '../server/domain/vat.js';
import { buildTaxReturn } from '../server/domain/taxReturn.js';
import { saveSettings } from '../server/db.js';
import { setTaxInput } from '../server/db.js';
import { setClock } from '../server/util/dates.js';
import { loadEntries, totalsByTaxField } from '../server/domain/ledger.js';

const line = (description, qty, price, vat = 'S') => ({ description, quantity: qty, unit_price: gbp(price), vat_code: vat });

test('invoice totals: per-line VAT, credit notes are negative', () => {
  const t = invoiceTotals([{ quantity: 3, unit_price: gbp(33.33), vat_code: 'S' }, { quantity: 1, unit_price: gbp(10), vat_code: 'Z' }]);
  assert.equal(t.net, gbp(109.99));
  assert.equal(t.vat, Math.round(gbp(99.99) * 0.2));
  assert.equal(invoiceTotals([{ quantity: 1, unit_price: gbp(100), vat_code: 'S' }], 'credit_note').gross, -gbp(120));
});

test('invoice numbering is sequential, unique and separate for credit notes', () => {
  const db = freshDb();
  const c = addContact(db);
  const a = createInvoice(db, { contact_id: c, issue_date: '2026-01-05', lines: [line('x', 1, 10)] });
  const b = createInvoice(db, { contact_id: c, issue_date: '2026-01-06', lines: [line('x', 1, 10)] });
  assert.equal(a.number, 'INV-0001');
  assert.equal(b.number, 'INV-0002');
  assert.equal(creditNoteFor(db, a.id).number, 'CN-0001');
  assert.throws(() => createInvoice(db, { number: 'INV-0001', contact_id: c, issue_date: '2026-01-05', lines: [line('x', 1, 10)] }), /already exists/);
  assert.equal(nextInvoiceNumber(db), 'INV-0003');
});

test('invoice validation rejects bad dates, empty lines and due-before-issue', () => {
  const db = freshDb();
  assert.throws(() => createInvoice(db, { issue_date: '2026-13-45', lines: [line('x', 1, 1)] }), /valid date/);
  assert.throws(() => createInvoice(db, { issue_date: '2026-01-01', lines: [] }), /at least one line/);
  assert.throws(() => createInvoice(db, { issue_date: '2026-01-10', due_date: '2026-01-01', lines: [line('x', 1, 1)] }), /before the issue date/);
});

test('invoice lifecycle: draft -> sent -> part paid -> paid; overdue; payments recorded as transactions', () => {
  const db = freshDb({ vat: { registered: true } });
  const c = addContact(db);
  let inv = createInvoice(db, { contact_id: c, issue_date: '2026-01-01', due_date: '2026-01-31', lines: [line('Consulting', 10, 100)] });
  assert.equal(inv.derived_status, 'draft');
  assert.equal(inv.totals.gross, gbp(1200));
  assert.throws(() => recordPayment(db, inv.id, { account_id: 1, date: '2026-01-10', amount: gbp(100) }), /Issue the invoice/);
  inv = setInvoiceStatus(db, inv.id, 'sent');
  setClock('2026-01-15');
  assert.equal(getInvoice(db, inv.id).derived_status, 'sent');
  setClock('2026-02-10');
  assert.equal(getInvoice(db, inv.id).derived_status, 'overdue');
  const p1 = recordPayment(db, inv.id, { account_id: 1, date: '2026-02-01', amount: gbp(500) });
  assert.equal(p1.invoice.derived_status, 'overdue'); // part paid but still past due
  assert.equal(p1.invoice.outstanding, gbp(700));
  assert.throws(() => recordPayment(db, inv.id, { account_id: 1, date: '2026-02-02', amount: gbp(800) }), /more than the outstanding/);
  const p2 = recordPayment(db, inv.id, { account_id: 1, date: '2026-02-03', amount: gbp(700) });
  assert.equal(p2.invoice.derived_status, 'paid');
  const txns = db.all('SELECT * FROM transactions WHERE invoice_id = ?', inv.id);
  assert.equal(txns.length, 2);
  assert.equal(txns[0].vat_amount, 8333); // £500 of a £1,200 invoice carries 500/1200 of the £200 VAT = £83.33
  assert.throws(() => deleteInvoice(db, inv.id), /Only drafts/);
  setClock(null);
});

test('credit notes: refund payments settle a negative invoice', () => {
  const db = freshDb();
  const c = addContact(db);
  const inv = setInvoiceStatus(db, createInvoice(db, { contact_id: c, issue_date: '2026-01-01', lines: [line('Work', 1, 100, 'N')] }).id, 'sent');
  const cn = setInvoiceStatus(db, creditNoteFor(db, inv.id).id, 'sent');
  assert.equal(cn.totals.gross, -gbp(100));
  const r = recordPayment(db, cn.id, { account_id: 1, date: '2026-01-20', amount: gbp(100) });
  assert.equal(r.invoice.paid, -gbp(100));
  assert.equal(r.invoice.derived_status, 'paid');
});

test('receivables aging buckets by days overdue', () => {
  const db = freshDb();
  const c = addContact(db);
  for (const [issue, due] of [['2026-03-01', '2026-03-31'], ['2026-02-01', '2026-03-03'], ['2025-11-01', '2025-12-01']]) {
    setInvoiceStatus(db, createInvoice(db, { contact_id: c, issue_date: issue, due_date: due, lines: [line('x', 1, 100, 'N')] }).id, 'sent');
  }
  const a = receivablesAging(db, '2026-04-15');
  assert.equal(a.buckets.d1_30, gbp(100)); // due 31 Mar -> 15 days
  assert.equal(a.buckets.d31_60, gbp(100)); // due 3 Mar -> 43 days
  assert.equal(a.buckets.d90plus, gbp(100)); // due 1 Dec -> 135 days
  assert.equal(a.total, gbp(300));
});

// ---------------- recurring ----------------

test('month-end schedules do not drift: 31 Jan -> 28 Feb -> 31 Mar', () => {
  let d = '2026-01-31';
  const seen = [];
  for (let i = 0; i < 4; i++) { d = advance(d, 'monthly', 1, 31); seen.push(d); }
  assert.deepEqual(seen, ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  assert.equal(advance('2024-02-29', 'yearly', 1, 29), '2025-02-28');
  assert.equal(advance('2026-01-01', 'quarterly', 1), '2026-04-01');
  assert.equal(advance('2026-01-01', 'weekly', 2), '2026-01-15');
});

test('placeholders render month/year/quarter', () => {
  assert.equal(renderPlaceholders('Retainer {month} {year} ({quarter}, billing {prevMonth})', '2026-11-05'), 'Retainer November 2026 (Q4, billing October)');
});

test('recurring invoices: catch up missed periods exactly once, stop at end/max runs', () => {
  const db = freshDb();
  const c = addContact(db, 'Retainer Client');
  const t = createTemplate(db, {
    name: 'Monthly retainer', contact_id: c, frequency: 'monthly', start_date: '2026-01-31', due_days: 14, mode: 'issue',
    lines: [{ description: 'Retainer for {month} {year}', quantity: 1, unit_price: gbp(500), vat_code: 'N' }], max_runs: 4,
  });
  assert.deepEqual(previewDates(t, 6), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  const first = runDue(db, { asOf: '2026-03-15' });
  assert.equal(first.length, 2);
  assert.equal(first[0].invoice.issue_date, '2026-01-31');
  assert.equal(first[0].invoice.lines[0].description, 'Retainer for January 2026');
  assert.equal(first[1].invoice.issue_date, '2026-02-28');
  assert.equal(first[0].invoice.status, 'sent');
  assert.equal(first[0].invoice.due_date, '2026-02-14');
  assert.equal(runDue(db, { asOf: '2026-03-15' }).length, 0, 'idempotent');
  const second = runDue(db, { asOf: '2026-12-31' });
  assert.equal(second.length, 2, 'only 2 runs remain of max 4');
  const after = getTemplate(db, t.id);
  assert.equal(after.runs, 4);
  assert.equal(after.active, false);
  assert.equal(db.all('SELECT * FROM invoices WHERE recurring_id = ?', t.id).length, 4);
});

test('recurring template in draft mode creates drafts; force runs a template early', () => {
  const db = freshDb();
  const c = addContact(db);
  const t = createTemplate(db, { name: 'Hosting', contact_id: c, frequency: 'yearly', start_date: '2027-06-01', mode: 'draft', lines: [{ description: 'Hosting', quantity: 1, unit_price: gbp(120), vat_code: 'S' }] });
  assert.equal(runDue(db, { asOf: '2026-11-22' }).length, 0);
  const forced = runDue(db, { asOf: '2026-11-22', templateId: t.id, force: true });
  assert.equal(forced.length, 1);
  assert.equal(forced[0].invoice.derived_status, 'draft');
  assert.equal(forced[0].invoice.issue_date, '2026-11-22');
  assert.equal(getTemplate(db, t.id).next_date, '2028-06-01');
});

// ---------------- ledger: cash vs accruals ----------------

function seedBusiness(db) {
  const c = addContact(db, 'Big Client');
  // £1,000 invoice issued 1 Mar 2026 (2025-26), paid 10 Apr 2026 (2026-27)
  const inv = setInvoiceStatus(db, createInvoice(db, { contact_id: c, issue_date: '2026-03-01', lines: [line('Project', 1, 1000, 'N')] }).id, 'sent');
  recordPayment(db, inv.id, { account_id: 1, date: '2026-04-10', amount: gbp(1000) });
  addTxn(db, { date: '2025-09-01', amount: 2000, category: 'se_turnover', desc: 'Direct sale' });
  addTxn(db, { date: '2025-10-01', amount: -300, category: 'se_admin' });
  return inv;
}

test('cash basis counts the invoice when PAID; accruals counts it when ISSUED; never twice', () => {
  const db = freshDb({ accountingBasis: 'cash' });
  seedBusiness(db);
  const cash25 = totalsByTaxField(loadEntries(db, '2025-04-06', '2026-04-05').entries, { basis: 'cash' }).totals;
  const cash26 = totalsByTaxField(loadEntries(db, '2026-04-06', '2027-04-05').entries, { basis: 'cash' }).totals;
  assert.equal(cash25['se.turnover'], gbp(2000));
  assert.equal(cash26['se.turnover'], gbp(1000));
  saveSettings(db, { accountingBasis: 'accruals' });
  const acc25 = totalsByTaxField(loadEntries(db, '2025-04-06', '2026-04-05').entries, { basis: 'accruals' }).totals;
  const acc26 = totalsByTaxField(loadEntries(db, '2026-04-06', '2027-04-05').entries, { basis: 'accruals' }).totals;
  assert.equal(acc25['se.turnover'], gbp(3000));
  assert.equal(acc26['se.turnover'] || 0, 0, 'payment of an invoice recognised last year is not income again');
  assert.equal(gbp(3000) + 0, (acc25['se.turnover'] || 0) + (acc26['se.turnover'] || 0));
});

test('business-use percentage and refunds are applied to expenses', () => {
  const db = freshDb();
  addTxn(db, { date: '2025-06-01', amount: -100, category: 'se_admin', pct: 60 });
  addTxn(db, { date: '2025-06-02', amount: 20, category: 'se_admin' }); // refund
  const t = totalsByTaxField(loadEntries(db, '2025-04-06', '2026-04-05').entries).totals;
  assert.equal(t['se.admin'], gbp(60) - gbp(20));
});

test('uncategorised and ignored transactions are excluded and reported', () => {
  const db = freshDb();
  addTxn(db, { date: '2025-06-01', amount: 500 });
  addTxn(db, { date: '2025-06-01', amount: 700, category: 'se_turnover', status: 'ignored' });
  const l = loadEntries(db, '2025-04-06', '2026-04-05');
  assert.equal(l.entries.length, 0);
  assert.equal(l.uncategorised.length, 1);
});

// ---------------- VAT ----------------

test('VAT return: standard scheme uses invoice dates; credit notes reduce box 1; boxes 6/7 floored to pounds', () => {
  const db = freshDb({ vat: { registered: true, scheme: 'standard' } });
  const c = addContact(db);
  const i1 = setInvoiceStatus(db, createInvoice(db, { contact_id: c, issue_date: '2026-04-10', lines: [line('A', 1, 1000, 'S')] }).id, 'sent');
  setInvoiceStatus(db, createInvoice(db, { contact_id: c, issue_date: '2026-05-10', lines: [line('B', 1, 500.5, 'Z')] }).id, 'sent');
  setInvoiceStatus(db, creditNoteFor(db, i1.id).id, 'sent'); // issued today (clock)… override date below
  db.run("UPDATE invoices SET issue_date = '2026-06-01' WHERE kind = 'credit_note'");
  addTxn(db, { date: '2026-05-01', amount: -120, category: 'se_admin', vat: 20, vatCode: 'S' });
  addTxn(db, { date: '2026-05-02', amount: -50, category: 'se_wages', vatCode: 'O' }); // outside scope -> excluded
  const r = vatReturn(db, '2026-04-01', '2026-06-30');
  assert.equal(r.boxes.box1, gbp(200) - gbp(200)); // invoice VAT 200 less credit note 200
  assert.equal(r.boxes.box4, gbp(20));
  assert.equal(r.boxes.box5, -gbp(20));
  assert.equal(r.position, 'reclaimable');
  assert.equal(r.boxes.box6, 500 * 100 + 0 + 0, 'sales ex VAT: 1000 + 500.50 - 1000 = 500.50 -> floored to £500');
  assert.equal(r.boxes.box7, 100 * 100);
  assert.equal(r.dueDate, '2026-08-07');
});

test('VAT cash accounting: payments, not invoices, drive box 1', () => {
  const db = freshDb({ vat: { registered: true, scheme: 'cash' } });
  const c = addContact(db);
  const inv = setInvoiceStatus(db, createInvoice(db, { contact_id: c, issue_date: '2026-03-20', lines: [line('A', 1, 1000, 'S')] }).id, 'sent');
  assert.equal(vatReturn(db, '2026-01-01', '2026-03-31').boxes.box1, 0);
  recordPayment(db, inv.id, { account_id: 1, date: '2026-04-15', amount: gbp(600) });
  const q2 = vatReturn(db, '2026-04-01', '2026-06-30');
  assert.equal(q2.boxes.box1, gbp(100)); // 600/1200 * £200
  assert.equal(q2.boxes.box6, gbp(500));
});

// ---------------- full tax return ----------------

test('end-to-end 2025-26 return: sole trader with expenses, mileage, home office and payments', () => {
  const db = freshDb({ profile: { name: 'Sam Trader', utr: '1234567890', nino: 'QQ123456C' } });
  addTxn(db, { date: '2025-07-01', amount: 60000, category: 'se_turnover' });
  addTxn(db, { date: '2025-08-01', amount: -5000, category: 'se_cogs' });
  addTxn(db, { date: '2025-09-01', amount: -1200, category: 'se_admin' });
  addTxn(db, { date: '2025-09-05', amount: -500, category: 'se_entertainment' });
  addTxn(db, { date: '2026-01-02', amount: -4000, category: 'drawings' }); // ignored
  db.run("INSERT INTO mileage (date, from_place, to_place, miles, vehicle) VALUES ('2025-10-01', 'Home', 'Client', 1000, 'car')");
  setTaxInput(db, '2025-26', 'homeOfficeHours', { '2025-10': 60, '2025-11': 120 }); // £18 + £26
  setTaxInput(db, '2025-26', 'payments', [{ date: '2026-01-30', amount: gbp(2000), note: 'POA 1' }]);
  const r = buildTaxReturn(db, '2025-26');
  const se = r.se;
  assert.equal(se.turnover, gbp(60000));
  // expenses: 5000 + 1200 + 500 + mileage 450 + home 44
  assert.equal(se.totalExpenses, gbp(5000 + 1200 + 500 + 450 + 44));
  assert.equal(se.disallowable, gbp(500));
  // profit = 60000 - 7194 + 500 disallowable added back
  assert.equal(se.taxableProfit, gbp(60000 - 7194 + 500));
  assert.equal(r.calc.income.selfEmployment, se.taxableProfit);
  assert.equal(r.calc.paymentsMade, gbp(2000));
  assert.equal(r.calc.balance, r.calc.totalLiability - gbp(2000));
  const sa103 = r.forms.find((f) => f.id === 'SA103F');
  const turnoverRow = sa103.pages[1].rows[0];
  assert.equal(turnoverRow.box, '15');
  assert.equal(turnoverRow.value, gbp(60000));
  assert.ok(r.forms.find((f) => f.id === 'SA100'));
  assert.equal(r.warnings.filter((w) => w.level === 'error').length, 0);
});

test('trading allowance is used automatically when it beats actual expenses', () => {
  const db = freshDb();
  addTxn(db, { date: '2025-07-01', amount: 1500, category: 'se_turnover' });
  addTxn(db, { date: '2025-08-01', amount: -200, category: 'se_admin' });
  const r = buildTaxReturn(db, '2025-26');
  assert.equal(r.se.usedAllowance, true);
  assert.equal(r.se.taxableProfit, gbp(500));
  const noAllowance = buildTaxReturn(db, '2025-26', { inputsOverride: { tradingAllowance: 'no' } });
  assert.equal(noAllowance.se.taxableProfit, gbp(1300));
});

test('brought-forward losses reduce profit and the unused balance carries forward', () => {
  const db = freshDb();
  addTxn(db, { date: '2025-07-01', amount: 10000, category: 'se_turnover' });
  setTaxInput(db, '2025-26', 'seLossesBF', gbp(4000));
  setTaxInput(db, '2025-26', 'tradingAllowance', 'no');
  const r = buildTaxReturn(db, '2025-26');
  assert.equal(r.se.lossUsed, gbp(4000));
  assert.equal(r.se.taxableProfit, gbp(6000));
  setTaxInput(db, '2025-26', 'seLossesBF', gbp(15000));
  const r2 = buildTaxReturn(db, '2025-26');
  assert.equal(r2.se.taxableProfit, 0);
  assert.equal(r2.se.lossesCarriedForward, gbp(5000));
});

test('uncategorised transactions raise an error-level warning', () => {
  const db = freshDb();
  addTxn(db, { date: '2025-07-01', amount: 999 });
  const r = buildTaxReturn(db, '2025-26');
  assert.ok(r.warnings.some((w) => w.level === 'error' && /no category/.test(w.text)));
});

test('property return: residential finance costs excluded from expenses, claimed as 20% credit', () => {
  const db = freshDb();
  addTxn(db, { date: '2025-07-01', amount: 12000, category: 'prop_rent' });
  addTxn(db, { date: '2025-07-02', amount: -1500, category: 'prop_repairs' });
  addTxn(db, { date: '2025-07-03', amount: -4000, category: 'prop_finance_res' });
  addTxn(db, { date: '2025-07-04', amount: 30000, category: 'se_turnover' });
  const r = buildTaxReturn(db, '2025-26');
  assert.equal(r.prop.totalExpenses, gbp(1500));
  assert.equal(r.prop.residentialFinance, gbp(4000));
  assert.equal(r.prop.taxableProfit, gbp(10500));
  assert.equal(r.calc.tax.reductions[0].amount, gbp(800));
  assert.equal(r.forms.find((f) => f.id === 'SA105').pages[2].rows.find((x) => x.box === '44').value, gbp(4000));
});
