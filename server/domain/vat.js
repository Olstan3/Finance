// VAT: nine-box VAT100 return (standard & cash accounting schemes), period generation and a
// registration-threshold monitor. The flat-rate scheme is intentionally not supported.

import { getSettings } from '../db.js';
import { categoryMap } from './ledger.js';
import { lineTotals } from './invoices.js';
import { THRESHOLDS } from './taxRates.js';
import { addDays, addMonths, parseISO, today } from '../util/dates.js';
import { floorPounds, pctOf } from '../util/money.js';

const PROFIT_KINDS = new Set(['income', 'expense', 'capital']);

/**
 * VAT returns and payments are due one calendar month and seven days after the period ends.
 * For a period ending on the last day of a month, "one month later" is the last day of the
 * next month (30 Jun -> 31 Jul -> due 7 Aug).
 */
export function vatDueDate(periodEnd) {
  const firstOfNext = addDays(periodEnd, 1);
  const isMonthEnd = firstOfNext.endsWith('-01');
  const oneMonth = isMonthEnd ? addDays(addMonths(firstOfNext, 1), -1) : addMonths(periodEnd, 1);
  return addDays(oneMonth, 7);
}

/** Sales and purchases that belong in a VAT return for [from, to]. */
export function vatEntries(db, from, to, settings = getSettings(db)) {
  const scheme = settings.vat.scheme === 'cash' ? 'cash' : 'standard';
  const cats = categoryMap(db);
  const sales = [];
  const purchases = [];

  const txns = db.all("SELECT * FROM transactions WHERE date >= ? AND date <= ? AND status != 'ignored' ORDER BY date, id", from, to);
  for (const t of txns) {
    const cat = cats[t.category_id];
    if (!cat || !PROFIT_KINDS.has(cat.kind)) continue;
    if (t.vat_code === 'O') continue; // outside the scope of VAT
    if (t.invoice_id && scheme === 'standard') continue; // already counted via the invoice
    const vat = Math.abs(t.vat_amount || 0);
    const net = Math.abs(t.amount) - vat;
    const neg = (cat.kind === 'income' ? t.amount < 0 : t.amount > 0); // refund / credit
    const pct = cat.kind === 'income' ? 1 : (t.business_pct ?? 100) / 100;
    const row = { id: t.id, date: t.date, description: t.description, vatCode: t.vat_code, net: pctOf(net, pct) * (neg ? -1 : 1), vat: pctOf(vat, pct) * (neg ? -1 : 1), source: 'txn' };
    // Reverse charge: UK VAT is accounted for on the value of an overseas service, in Box 1 and (as input tax) Box 4.
    if (t.vat_code === 'RC' && cat.kind !== 'income') row.reverseCharge = pctOf(Math.abs(t.amount) * (neg ? -1 : 1) * (pct), 0.2);
    (cat.kind === 'income' ? sales : purchases).push(row);
  }

  if (scheme === 'standard') {
    const invs = db.all("SELECT * FROM invoices WHERE issue_date >= ? AND issue_date <= ? AND status NOT IN ('draft','void')", from, to);
    for (const inv of invs) {
      const sign = inv.kind === 'credit_note' ? -1 : 1;
      for (const l of db.all('SELECT * FROM invoice_lines WHERE invoice_id = ?', inv.id)) {
        if (l.vat_code === 'O') continue;
        const t = lineTotals(l);
        sales.push({ id: inv.id, date: inv.issue_date, description: `${inv.number} – ${l.description}`, vatCode: l.vat_code, net: sign * t.net, vat: sign * t.vat, source: 'invoice' });
      }
    }
  }
  return { sales, purchases, scheme };
}

export function vatReturn(db, from, to, settings = getSettings(db)) {
  const { sales, purchases, scheme } = vatEntries(db, from, to, settings);
  const sum = (arr, k) => arr.reduce((a, r) => a + r[k], 0);
  const reverseCharged = purchases.filter((r) => r.reverseCharge != null);
  const rcVat = reverseCharged.reduce((a, r) => a + r.reverseCharge, 0);
  const rcNet = reverseCharged.reduce((a, r) => a + r.net, 0);
  const box1 = sum(sales, 'vat') + rcVat;
  const box2 = 0; // acquisitions from EU member states (Northern Ireland only)
  const box3 = box1 + box2;
  const box4 = sum(purchases, 'vat') + rcVat;
  const box5 = box3 - box4;
  const boxes = {
    box1, box2, box3, box4, box5,
    box6: floorPounds(sum(sales, 'net') + rcNet), // reverse-charge purchases are also reported as outputs in Box 6
    box7: floorPounds(sum(purchases, 'net')),
    box8: 0, box9: 0,
  };
  return {
    from, to, scheme, boxes,
    position: box5 >= 0 ? 'payable' : 'reclaimable',
    amountDue: Math.abs(box5),
    dueDate: vatDueDate(to),
    sales, purchases,
    estimatedVatCount: sales.concat(purchases).filter((r) => r.vatCode === 'N').length,
  };
}

/** Quarterly VAT periods for a stagger group (1: Mar/Jun/Sep/Dec, 2: Jan/Apr/Jul/Oct, 3: Feb/May/Aug/Nov). */
export function vatPeriods(stagger = 1, asOf = today(), back = 6) {
  const firstEnd = { 1: 3, 2: 1, 3: 2 }[Number(stagger)] || 3;
  const d = parseISO(asOf);
  const periods = [];
  for (let y = d.getUTCFullYear() - 3; y <= d.getUTCFullYear() + 1; y++) {
    for (let k = 0; k < 4; k++) {
      const endMonth = firstEnd + 3 * k; // 1..12
      const endMonthStart = `${y}-${String(endMonth).padStart(2, '0')}-01`;
      const end = addDays(addMonths(endMonthStart, 1), -1);
      const start = addMonths(endMonthStart, -2);
      periods.push({ start, end, due: vatDueDate(end) });
    }
  }
  periods.sort((a, b) => (a.end < b.end ? -1 : 1));
  const idx = periods.findIndex((p) => p.end >= asOf);
  const here = idx < 0 ? periods.length : idx;
  return periods.slice(Math.max(0, here - back), here + 2).reverse();
}

/** Rolling 12-month taxable turnover vs the VAT registration threshold. */
export function vatThresholdCheck(db, asOf = today()) {
  const from = addDays(addMonths(asOf, -12), 1);
  const cats = categoryMap(db);
  let turnover = 0;
  let platformPayouts = 0; // ad-network / app-store income: whether it counts towards the threshold depends on who pays you
  for (const t of db.all("SELECT * FROM transactions WHERE date >= ? AND date <= ? AND status != 'ignored' AND amount > 0", from, asOf)) {
    const c = cats[t.category_id];
    if (c && c.kind === 'income' && ['self_employment', 'company'].includes(c.section)) {
      const net = t.amount - Math.abs(t.vat_amount || 0);
      turnover += net;
      if (c.id === 'co_advertising_income' || c.id === 'co_inapp') platformPayouts += net;
    }
  }
  // Accruals users also have issued invoices (unpaid) that count; include unpaid issued ones not yet linked.
  const unpaid = db.all(
    `SELECT i.id FROM invoices i WHERE i.issue_date >= ? AND i.issue_date <= ? AND i.status = 'sent' AND i.kind = 'invoice'
     AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.invoice_id = i.id)`, from, asOf);
  for (const u of unpaid) for (const l of db.all('SELECT * FROM invoice_lines WHERE invoice_id = ?', u.id)) turnover += lineTotals(l).net;
  const limit = THRESHOLDS.vatRegistration * 100;
  return { from, to: asOf, turnover, platformPayouts, limit, pct: limit ? turnover / limit : 0, over: turnover > limit, near: turnover >= limit * 0.8 };
}
