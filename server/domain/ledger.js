// The ledger turns raw records (bank transactions, invoices, mileage, home-office claims)
// into normalised "entries" that every report and tax form is built from. One place decides:
//   * cash vs accruals basis (so an invoice and its payment are never counted twice)
//   * VAT-exclusive figures when VAT-registered
//   * business-use percentages
//   * which categories count towards profit
//
// Sign convention for entries: `net`/`vat`/`gross` are positive for normal income and normal
// expenses; refunds and credit notes are negative.

import { SIMPLIFIED, VAT_RATES } from './taxRates.js';
import { getSettings, getTaxInput } from '../db.js';
import { invoiceTotals, lineTotals } from './invoices.js';
import { taxYearOf, taxYearRange, parseISO } from '../util/dates.js';
import { pctOf } from '../util/money.js';

const PROFIT_KINDS = new Set(['income', 'expense', 'capital']);

export function categoryMap(db) {
  return Object.fromEntries(db.all('SELECT * FROM categories').map((c) => [c.id, c]));
}

/**
 * Entries between two ISO dates (inclusive).
 * Returns { entries, uncategorised, needsReview, unlinked }.
 */
export function loadEntries(db, from, to, { settings = getSettings(db), cats = categoryMap(db) } = {}) {
  const basis = settings.accountingBasis === 'accruals' ? 'accruals' : 'cash';
  const vatOn = !!settings.vat.registered;
  const entries = [];
  const uncategorised = [];
  let needsReview = 0;

  // ---- bank / cash transactions ----
  const txns = db.all('SELECT * FROM transactions WHERE date >= ? AND date <= ? ORDER BY date, id', from, to);
  for (const t of txns) {
    if (t.status === 'ignored') continue;
    if (basis === 'accruals' && t.invoice_id) continue; // settlement of an invoice recognised on issue
    const cat = t.category_id ? cats[t.category_id] : null;
    if (!cat) { uncategorised.push(t); continue; }
    if (t.status === 'review') needsReview++;
    if (!PROFIT_KINDS.has(cat.kind)) continue;
    const vatMag = vatOn ? Math.abs(t.vat_amount || 0) : 0;
    const vatSigned = t.amount < 0 ? -vatMag : vatMag;
    const value = t.amount - vatSigned; // signed, same direction as the cash movement
    const pct = (t.business_pct ?? 100) / 100;
    if (cat.kind === 'income') {
      entries.push(entry({ t, cat, src: 'txn', kind: 'income', net: value, vat: vatSigned, gross: t.amount, pct: 1 }));
    } else {
      // Expenses: money out is negative, so flip to a positive cost.
      const kind = cat.kind === 'capital' ? 'capital' : 'expense';
      entries.push(entry({ t, cat, src: 'txn', kind, net: pctOf(-value, pct), vat: pctOf(-vatSigned, pct), gross: pctOf(-t.amount, pct), pct }));
    }
  }

  // ---- invoices (accruals basis: recognised on issue date) ----
  if (basis === 'accruals') {
    const invs = db.all("SELECT * FROM invoices WHERE issue_date >= ? AND issue_date <= ? AND status NOT IN ('draft','void')", from, to);
    for (const inv of invs) {
      const cat = cats[inv.category_id] || cats.se_turnover;
      const lines = db.all('SELECT * FROM invoice_lines WHERE invoice_id = ?', inv.id);
      const sign = inv.kind === 'credit_note' ? -1 : 1;
      let net = 0, vat = 0;
      for (const l of lines) { const lt = lineTotals(l); net += lt.net; vat += lt.vat; }
      entries.push({
        key: `inv-${inv.id}`, source: 'invoice', id: inv.id, date: inv.issue_date, description: `${inv.number}`, category_id: cat.id,
        taxField: cat.tax_field, section: cat.section, kind: 'income', allowable: 1,
        net: sign * net, vat: vatOn ? sign * vat : 0, gross: sign * (vatOn ? net + vat : net), businessPct: 100, review: false, vatCode: lines[0]?.vat_code || 'N',
      });
    }
  }

  return { entries, uncategorised, needsReview };
}

function entry({ t, cat, src, kind, net, vat, gross, pct }) {
  return {
    key: `txn-${t.id}`, source: src, id: t.id, date: t.date, description: t.description, category_id: cat.id,
    taxField: cat.tax_field, section: cat.section, kind, allowable: cat.allowable ?? 1,
    net, vat, gross, businessPct: Math.round(pct * 100), review: t.status === 'review', vatCode: t.vat_code,
  };
}

/** Simplified-expenses mileage for a tax year, returned as pence per trip (date order). */
export function mileageClaims(db, taxYear) {
  const { start, end } = taxYearRange(taxYear);
  const trips = db.all('SELECT * FROM mileage WHERE date >= ? AND date <= ? ORDER BY date, id', start, end);
  const cumulative = { car: 0, motorcycle: 0, bicycle: 0 };
  return trips.map((m) => {
    const rate = SIMPLIFIED.mileage[m.vehicle] || SIMPLIFIED.mileage.car;
    const before = cumulative[m.vehicle] || 0;
    const first = Math.max(0, Math.min(m.miles, 10000 - before));
    const rest = m.miles - first;
    cumulative[m.vehicle] = before + m.miles;
    return { ...m, amount: Math.round((first * rate.first10000 + rest * rate.after) * 100) };
  });
}

/** Use-of-home flat rate: input is { '2025-04': 60, ... } hours worked at home per month. */
export function homeOfficeClaim(db, taxYear) {
  const hours = getTaxInput(db, taxYear, 'homeOfficeHours', {}) || {};
  let total = 0;
  const months = [];
  for (const [month, h] of Object.entries(hours)) {
    const band = SIMPLIFIED.homeOffice.find((b) => Number(h) >= b.minHours);
    const amount = band ? band.perMonth * 100 : 0;
    total += amount;
    months.push({ month, hours: Number(h), amount });
  }
  return { total, months };
}

/**
 * Full set of entries for a tax year including mileage and home-office claims.
 * Mileage and home-office are added as pseudo-entries so reports treat them like any expense.
 */
export function taxYearEntries(db, taxYear, opts = {}) {
  const { start, end } = taxYearRange(taxYear);
  const base = loadEntries(db, start, end, opts);
  const cats = opts.cats || categoryMap(db);
  const extra = [];
  const mileage = mileageClaims(db, taxYear);
  for (const m of mileage) {
    extra.push({
      key: `mile-${m.id}`, source: 'mileage', id: m.id, date: m.date, description: `${m.miles} mi ${m.vehicle}: ${m.from_place || ''} → ${m.to_place || ''}`.trim(),
      category_id: 'se_travel', taxField: cats.se_travel?.tax_field || 'se.travel', section: 'self_employment', kind: 'expense', allowable: 1,
      net: m.amount, vat: 0, gross: m.amount, businessPct: 100, review: false, vatCode: 'O',
    });
  }
  const home = homeOfficeClaim(db, taxYear);
  if (home.total) {
    extra.push({
      key: 'home-office', source: 'homeoffice', id: 0, date: end, description: 'Use of home (HMRC flat rate)', category_id: 'se_other',
      taxField: 'se.other', section: 'self_employment', kind: 'expense', allowable: 1, net: home.total, vat: 0, gross: home.total, businessPct: 100, review: false, vatCode: 'O',
    });
  }
  return { ...base, entries: [...base.entries, ...extra], mileage, home };
}

/** Sum entries by taxField. Capital purchases are folded into expenses under the cash basis. */
export function totalsByTaxField(entries, { basis = 'cash' } = {}) {
  const out = {};
  const unallowable = {};
  for (const e of entries) {
    let field = e.taxField;
    if (e.kind === 'capital') {
      if (basis !== 'cash') continue; // accruals: handled via capital allowances / asset register
      field = 'se.other';
    }
    out[field] = (out[field] || 0) + e.net;
    if (e.kind !== 'income' && e.allowable === 0) unallowable[field] = (unallowable[field] || 0) + e.net;
  }
  return { totals: out, unallowable };
}

export { taxYearOf, parseISO, VAT_RATES, invoiceTotals };
