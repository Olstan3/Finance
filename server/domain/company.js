// Limited-company mode: accounting periods, profit & loss, balance sheet, Corporation Tax computation,
// director's loan accounts, dividends, deadlines and worksheets.
//
// Everything here is derived from the same ledger as the rest of the app (bank transactions, invoices,
// the asset register). The balance sheet is built from independent sources (bank balances, invoices,
// assets) and compared with the profit & loss reserves, so a gap shows up as an "unreconciled difference"
// instead of being hidden by a plug figure.
//
// IMPORTANT: this prepares figures. HMRC's free company-return service closed on 31 March 2026 and
// CT600 returns now need commercial software with iXBRL accounts and computations, so filing
// itself happens outside this app (the trial balance export is for that).

import { getSettings, saveSettings, getTaxInput, audit } from '../db.js';
import { loadEntries, categoryMap, spreadPortion } from './ledger.js';
import { ValidationError, listInvoices } from './invoices.js';
import { vatReturn } from './vat.js';
import { calculateIncomeTax } from './taxEngine.js';
import { CORPORATION_TAX, S455_RATES, S455_LATE_MONTHS, SUPPORTED_TAX_YEARS, ratesFor } from './taxRates.js';
import { addDays, addMonths, parseISO, toISO, today, taxYearOf, fmtDate, isISO } from '../util/dates.js';
import { pctOf, fmtGBP } from '../util/money.js';
import { createTransaction } from './transactions.js';

const dayCount = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1; // inclusive
const lastDayOfMonth = (y, m) => toISO(new Date(Date.UTC(y, m, 0)));
const ardOn = (year, c) => {
  const m = Math.min(12, Math.max(1, Number(c.yearEndMonth) || 3));
  const dim = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return `${year}-${String(m).padStart(2, '0')}-${String(Math.min(Number(c.yearEndDay) || dim, dim)).padStart(2, '0')}`;
};

// ------------------------------------------------------------------------------------------ periods

export function companyConfigured(settings) {
  return settings.entityType === 'company';
}

/**
 * Accounting periods from incorporation to the one containing `asOf`.
 * The first period is the first accounting reference date at least ~11 months in (but never over 18 months);
 * later ones are exactly a year each.
 */
export function companyPeriods(settings, { firstDate, asOf = today() } = {}) {
  const c = settings.company;
  const start0 = isISO(c.incorporationDate) ? c.incorporationDate : isISO(firstDate) ? firstDate : `${Number(asOf.slice(0, 4)) - 1}-${String(Number(c.yearEndMonth) || 3).padStart(2, '0')}-01`;
  const startYear = Number(start0.slice(0, 4));
  const cands = [startYear - 1, startYear, startYear + 1, startYear + 2].map((y) => ardOn(y, c)).filter((d) => d >= start0);
  const elevenMonths = addMonths(start0, 11);
  const eighteen = addDays(addMonths(start0, 18), -1);
  let firstEnd = cands.find((d) => d >= elevenMonths && d <= eighteen) || cands[0];
  if (isISO(c.firstPeriodEnd) && c.firstPeriodEnd >= start0) firstEnd = c.firstPeriodEnd;
  const periods = [];
  let start = start0, end = firstEnd;
  for (let i = 0; i < 40; i++) {
    periods.push(makePeriod(start, end, i === 0));
    if (end >= asOf) break;
    start = addDays(end, 1);
    end = ardOn(Number(end.slice(0, 4)) + 1, c);
  }
  return periods;
}

function makePeriod(start, end, first) {
  const days = dayCount(start, end);
  const full = addMonths(start, 12) === addDays(end, 1);
  return {
    key: `${start}_${end}`, start, end, days, first,
    label: full ? `Year ended ${fmtDate(end)}` : `${fmtDate(start)} to ${fmtDate(end)}`,
    longerThanYear: end > addDays(addMonths(start, 12), -1),
  };
}

export function findPeriod(settings, key, opts) {
  const periods = companyPeriods(settings, { ...opts, asOf: key ? key.split('_')[1] : (opts?.asOf || today()) });
  if (!key) return currentPeriod(settings, opts);
  const p = periods.find((x) => x.key === key);
  if (!p) throw new ValidationError(`Unknown accounting period ${key}`);
  return p;
}
export function currentPeriod(settings, opts = {}) {
  const asOf = opts.asOf || today();
  const ps = companyPeriods(settings, { ...opts, asOf });
  return ps.find((p) => p.start <= asOf && asOf <= p.end) || ps[ps.length - 1];
}

/** Corporation Tax periods can't exceed 12 months, so a longer first accounting period is split in two. */
export function ctPeriods(ap) {
  if (!ap.longerThanYear) return [{ start: ap.start, end: ap.end, days: ap.days }];
  const firstEnd = addDays(addMonths(ap.start, 12), -1);
  const secondStart = addDays(firstEnd, 1);
  return [{ start: ap.start, end: firstEnd, days: dayCount(ap.start, firstEnd) }, { start: secondStart, end: ap.end, days: dayCount(secondStart, ap.end) }];
}

export const earliestActivityDate = (db) => db.get('SELECT MIN(d) AS d FROM (SELECT MIN(date) AS d FROM transactions UNION ALL SELECT MIN(issue_date) FROM invoices)')?.d || null;

// ------------------------------------------------------------------------------------------ assets

/** Equipment purchases categorised as "capital" become assets automatically (idempotent). */
export function syncAssets(db, settings = getSettings(db)) {
  if (!companyConfigured(settings)) return 0;
  const vatOn = !!settings.vat.registered;
  const rows = db.all(
    `SELECT t.* FROM transactions t JOIN categories c ON c.id = t.category_id
     WHERE c.kind = 'capital' AND t.amount < 0 AND t.status != 'ignored' AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.txn_id = t.id)`,
  );
  for (const t of rows) {
    const cost = Math.abs(t.amount) - (vatOn ? Math.abs(t.vat_amount || 0) : 0);
    db.run('INSERT INTO assets (name, purchase_date, cost, pool, business_pct, txn_id, life_years) VALUES (?, ?, ?, ?, 100, ?, 3)', t.description.slice(0, 120), t.date, cost, 'plant', t.id);
  }
  return rows.length;
}

/** Straight-line accounting depreciation, by day, with cumulative rounding. Returns pence charged within [start, end]. */
export function assetDepreciation(asset, start, end) {
  const life = Math.max(1, Number(asset.life_years) || 3);
  const lifeEnd = addDays(addMonths(asset.purchase_date, life * 12), -1);
  const stop = asset.disposal_date && asset.disposal_date < lifeEnd ? addDays(asset.disposal_date, -1) : lifeEnd;
  const cost = Math.round(asset.cost * ((asset.business_pct ?? 100) / 100));
  const total = dayCount(asset.purchase_date, lifeEnd);
  const through = (d) => { if (d < asset.purchase_date) return 0; const hi = d < stop ? d : stop; return hi < asset.purchase_date ? 0 : Math.round((cost * dayCount(asset.purchase_date, hi)) / total); };
  return through(end) - through(addDays(start, -1));
}

export function fixedAssetsAt(db, end) {
  const assets = db.all('SELECT * FROM assets WHERE purchase_date <= ?', end);
  let cost = 0, depreciation = 0;
  const rows = assets.map((a) => {
    const c = Math.round(a.cost * ((a.business_pct ?? 100) / 100));
    const disposed = a.disposal_date && a.disposal_date <= end;
    const dep = disposed ? c : Math.min(c, assetDepreciation(a, a.purchase_date, end));
    if (!disposed) { cost += c; depreciation += dep; }
    return { id: a.id, name: a.name, purchase_date: a.purchase_date, cost: c, depreciation: dep, nbv: disposed ? 0 : c - dep, disposed: !!disposed, life_years: a.life_years };
  });
  return { rows, cost, depreciation, nbv: cost - depreciation };
}

// ------------------------------------------------------------------------------------------ capital allowances (company)

function caRates(end) {
  // Main-pool writing-down rate falls to 14% for periods from April 2026 (provisional); AIA is £1m throughout.
  return ratesFor(end >= '2026-04-01' ? '2026-27' : '2025-26').capitalAllowances;
}

/** Capital allowances for each corporation-tax period in order, with the pools carried forward. */
export function companyCapitalAllowances(db, periods) {
  let main = 0, special = 0;
  const out = [];
  for (const cp of periods) {
    const R = caRates(cp.end);
    const scale = Math.min(1, cp.days / 365);
    const assets = db.all('SELECT * FROM assets');
    const pct = (a, v) => pctOf(v, (a.business_pct ?? 100) / 100);
    const inP = (d) => d && d >= cp.start && d <= cp.end;
    const adds = assets.filter((a) => inP(a.purchase_date));
    const disp = assets.filter((a) => inP(a.disposal_date));
    const plant = adds.filter((a) => a.pool === 'plant').reduce((s, a) => s + pct(a, a.cost), 0);
    const aiaLimit = Math.round(R.aia * 100 * scale);
    const aia = Math.min(plant, aiaLimit);
    const carMain = adds.filter((a) => a.pool === 'car_main').reduce((s, a) => s + pct(a, a.cost), 0);
    const carSpecial = adds.filter((a) => a.pool === 'car_special').reduce((s, a) => s + pct(a, a.cost), 0);
    const fya = adds.filter((a) => a.pool === 'car_zero').reduce((s, a) => s + pct(a, a.cost), 0);
    const mainDisp = disp.filter((a) => a.pool === 'plant' || a.pool === 'car_main').reduce((s, a) => s + pct(a, a.disposal_proceeds || 0), 0);
    const specDisp = disp.filter((a) => a.pool === 'car_special').reduce((s, a) => s + pct(a, a.disposal_proceeds || 0), 0);
    const pool = (bf, add, d, rate) => {
      const base = bf + add - d;
      if (base < 0) return { wda: 0, charge: -base, cf: 0 };
      const wda = base > 0 && base <= 100000 ? base : pctOf(Math.round(base * scale), rate);
      return { wda, charge: 0, cf: base - wda };
    };
    const m = pool(main, plant - aia + carMain, mainDisp, R.mainRate);
    const sp = pool(special, carSpecial, specDisp, R.specialRate);
    main = m.cf; special = sp.cf;
    out.push({ period: cp, aia, aiaLimit, fya, plantAdditions: plant, mainWda: m.wda, specialWda: sp.wda, total: aia + fya + m.wda + sp.wda, balancingCharges: m.charge + sp.charge, mainCf: m.cf, specialCf: sp.cf });
  }
  return out;
}

// ------------------------------------------------------------------------------------------ profit & loss

export function companyPnl(db, settings, period) {
  const cats = categoryMap(db);
  const { entries, uncategorised, needsReview } = loadEntries(db, period.start, period.end, { settings, cats });
  const income = new Map(), expenses = new Map();
  let disallowable = 0, interest = 0, turnover = 0;
  for (const e of entries) {
    if (e.kind === 'income') {
      if (e.taxField === 'co.interest') interest += e.net; else turnover += e.net;
      const r = income.get(e.category_id) || { category_id: e.category_id, name: cats[e.category_id]?.name || e.category_id, amount: 0 };
      r.amount += e.net; income.set(e.category_id, r);
    } else if (e.kind === 'expense') {
      const r = expenses.get(e.category_id) || { category_id: e.category_id, name: cats[e.category_id]?.name || e.category_id, amount: 0, allowable: e.allowable };
      r.amount += e.net; expenses.set(e.category_id, r);
      if (e.allowable === 0) disallowable += e.net;
    }
  }
  const assets = db.all('SELECT * FROM assets');
  const depreciation = assets.reduce((a, x) => a + assetDepreciation(x, period.start, period.end), 0);
  const expenseLines = [...expenses.values()].sort((a, b) => b.amount - a.amount);
  const totalExpenses = expenseLines.reduce((a, r) => a + r.amount, 0) + depreciation;
  const operatingProfit = turnover - totalExpenses;
  return {
    period, turnover, income: [...income.values()].filter((r) => r.category_id !== 'co_interest').sort((a, b) => b.amount - a.amount),
    expenses: expenseLines, depreciation, totalExpenses, operatingProfit, interest, profitBeforeTax: operatingProfit + interest,
    disallowable, uncategorised: uncategorised.length, needsReview,
  };
}

// ------------------------------------------------------------------------------------------ corporation tax

/** Corporation Tax on `profits` for a period of `days`, with marginal relief and associated companies. */
export function ctCharge({ profits, days = 365, associated = 0 }) {
  const C = CORPORATION_TAX;
  const share = 1 + Math.max(0, Math.floor(associated));
  const scale = Math.min(1, days / 365);
  const lower = Math.round((C.lowerLimit * 100 * scale) / share);
  const upper = Math.round((C.upperLimit * 100 * scale) / share);
  const p = Math.max(0, profits);
  if (p <= lower) return { tax: pctOf(p, C.smallProfitsRate), marginalRelief: 0, band: 'small', lower, upper, rate: C.smallProfitsRate };
  if (p >= upper) return { tax: pctOf(p, C.mainRate), marginalRelief: 0, band: 'main', lower, upper, rate: C.mainRate };
  const relief = Math.round(C.marginalFraction * (upper - p));          // N = A, so N/A cancels
  return { tax: pctOf(p, C.mainRate) - relief, marginalRelief: relief, band: 'marginal', lower, upper, rate: C.mainRate };
}

export const CT_INPUT_KEYS = ['ctLossesBF', 'ctOtherAdjustments', 'charitableDonations', 'associatedCompanies'];
export function periodInputs(db, settings, period) {
  const g = (k, d) => getTaxInput(db, period.key, k, d);
  return {
    ctLossesBF: g('ctLossesBF', 0) || 0, ctOtherAdjustments: g('ctOtherAdjustments', 0) || 0, charitableDonations: g('charitableDonations', 0) || 0,
    associatedCompanies: g('associatedCompanies', null) ?? settings.company.associatedCompanies ?? 0,
  };
}

const apportion = (value, parts) => { // split by days with cumulative rounding so parts add up exactly
  const total = parts.reduce((a, p) => a + p.days, 0);
  let acc = 0, given = 0;
  return parts.map((p) => { acc += p.days; const cum = Math.round((value * acc) / total); const part = cum - given; given = cum; return part; });
};

export function corporationTax(db, settings, period, { pnl, allPeriods } = {}) {
  const P = pnl || companyPnl(db, settings, period);
  const inputs = periodInputs(db, settings, period);
  const parts = ctPeriods(period);
  const periods = allPeriods || companyPeriods(settings, { asOf: period.end, firstDate: earliestActivityDate(db) });
  // capital allowances need the pools from earlier periods, so run every CT period up to this one
  const allCt = periods.flatMap((p) => ctPeriods(p));
  const caAll = companyCapitalAllowances(db, allCt);
  const caFor = (cp) => caAll.find((x) => x.period.start === cp.start && x.period.end === cp.end) || { total: 0, balancingCharges: 0, aia: 0, mainWda: 0, specialWda: 0, fya: 0 };

  const pbt = apportion(P.profitBeforeTax, parts), dep = apportion(P.depreciation, parts), dis = apportion(P.disallowable, parts);
  const intr = apportion(P.interest, parts), adj = apportion(inputs.ctOtherAdjustments, parts);
  let lossesLeft = inputs.ctLossesBF;
  const rows = parts.map((cp, i) => {
    const ca = caFor(cp);
    const tradingBeforeLosses = pbt[i] - intr[i] + dep[i] + dis[i] + adj[i] - ca.total + ca.balancingCharges;
    const totalProfitsBeforeLosses = Math.max(0, tradingBeforeLosses) + intr[i];
    const lossUsed = Math.min(lossesLeft, Math.max(0, totalProfitsBeforeLosses));
    lossesLeft -= lossUsed;
    const tradingLossThisPeriod = tradingBeforeLosses < 0 ? -tradingBeforeLosses : 0;
    const donations = Math.min(inputs.charitableDonations, Math.max(0, totalProfitsBeforeLosses - lossUsed));
    const chargeable = Math.max(0, totalProfitsBeforeLosses - lossUsed - donations);
    const charge = ctCharge({ profits: chargeable, days: cp.days, associated: inputs.associatedCompanies });
    return {
      period: cp, profitBeforeTax: pbt[i], interest: intr[i], depreciationAddBack: dep[i], disallowableAddBack: dis[i], otherAdjustments: adj[i],
      capitalAllowances: ca.total, balancingCharges: ca.balancingCharges, allowanceDetail: ca,
      tradingProfitBeforeLosses: Math.max(0, tradingBeforeLosses), tradingLoss: tradingLossThisPeriod, lossesUsed: lossUsed,
      netTradingProfit: Math.max(0, Math.max(0, tradingBeforeLosses) - lossUsed), totalProfits: totalProfitsBeforeLosses, donations, chargeable, charge,
      dueDate: addDays(addMonths(cp.end, CORPORATION_TAX.payDays.months), CORPORATION_TAX.payDays.plusDays),
      returnDue: addMonths(cp.end, CORPORATION_TAX.returnMonths),
    };
  });
  const tax = rows.reduce((a, r) => a + r.charge.tax, 0);
  const carriedForwardLosses = lossesLeft + rows.reduce((a, r) => a + r.tradingLoss, 0);
  return { period, rows, tax, inputs, lossesCarriedForward: carriedForwardLosses, associated: inputs.associatedCompanies };
}

// ------------------------------------------------------------------------------------------ directors, loans, dividends

export function directorsOf(settings) { return settings.company.directors || []; }

/** Every director gets a contact record and a director's-loan account, so loans and dividends can be tracked. Idempotent. */
export function ensureDirectorRecords(db) {
  const settings = getSettings(db);
  if (settings.entityType !== 'company') return settings;
  const dirs = directorsOf(settings).map((d) => {
    let contactId = d.contact_id && db.get('SELECT id FROM contacts WHERE id = ?', d.contact_id)?.id;
    if (!contactId) contactId = db.get("SELECT id FROM contacts WHERE name = ? AND kind = 'director'", d.name)?.id || db.run("INSERT INTO contacts (name, kind) VALUES (?, 'director')", d.name).id;
    if (!db.get("SELECT 1 AS x FROM accounts WHERE kind = 'dla' AND director_id = ?", d.id)) db.run("INSERT INTO accounts (name, kind, director_id) VALUES (?, 'dla', ?)", `Director's loan – ${d.name}`, d.id);
    return { ...d, contact_id: contactId };
  });
  return saveSettings(db, { company: { directors: dirs } });
}

/** Positive = the director owes the company (an overdrawn loan account); negative = the company owes the director. */
export function directorBalances(db, settings, end = today()) {
  const out = directorsOf(settings).map((d) => ({ director: d, accountBalance: 0, movements: 0, balance: 0, timeline: [] }));
  const byId = new Map(out.map((o) => [o.director.id, o]));
  const unassigned = { director: { id: 'unassigned', name: 'Not assigned to a director' }, accountBalance: 0, movements: 0, balance: 0, timeline: [] };
  const get = (id) => byId.get(id) || null;
  for (const a of db.all("SELECT * FROM accounts WHERE kind = 'dla'")) {
    const o = get(a.director_id) || unassigned;
    o.accountBalance += a.opening_balance;
    for (const t of db.all('SELECT date, amount FROM transactions WHERE account_id = ? AND date <= ?', a.id, end)) { o.accountBalance += t.amount; o.timeline.push({ date: t.date, delta: t.amount }); }
  }
  const contactToDirector = new Map(directorsOf(settings).filter((d) => d.contact_id).map((d) => [d.contact_id, d.id]));
  for (const t of db.all("SELECT date, amount, contact_id FROM transactions WHERE category_id = 'dla_movement' AND status != 'ignored' AND date <= ? AND account_id IN (SELECT id FROM accounts WHERE kind != 'dla')", end)) {
    const o = get(contactToDirector.get(t.contact_id)) || unassigned;
    o.movements -= t.amount; o.timeline.push({ date: t.date, delta: -t.amount }); // money out of the company bank to a director = they owe more
  }
  const all = unassigned.accountBalance || unassigned.movements ? [...out, unassigned] : out;
  for (const o of all) {
    o.balance = o.accountBalance + o.movements;
    // when did the current overdrawn spell start? (sets the s455 rate: 35.75% for loans made on/after 6 April 2026)
    let run = 0, debitSince = null;
    for (const e of o.timeline.sort((a, b) => (a.date < b.date ? -1 : 1))) { const before = run; run += e.delta; if (run > 0 && before <= 0) debitSince = e.date; if (run <= 0) debitSince = null; }
    o.debitSince = o.balance > 0 ? debitSince : null;
    delete o.timeline;
  }
  return all;
}

export const s455RateFor = (loanDate) => (S455_RATES.find((r) => (loanDate || '9999') >= r.from) || S455_RATES[S455_RATES.length - 1]).rate;

/** Overdrawn director's loans at a period end and the s455 charge if they are not repaid in time. */
export function loansToParticipators(db, settings, period) {
  const repayBy = addDays(addMonths(period.end, S455_LATE_MONTHS), 1);
  const rows = directorBalances(db, settings, period.end).filter((b) => b.balance > 0).map((b) => {
    const rate = s455RateFor(b.debitSince || period.end);
    return { director: b.director.name, balance: b.balance, since: b.debitSince, rate, s455: pctOf(b.balance, rate), repayBy };
  });
  return { rows, total: rows.reduce((a, r) => a + r.balance, 0), s455: rows.reduce((a, r) => a + r.s455, 0), repayBy, over10k: rows.some((r) => r.balance > 1_000_000) };
}

export function listDividends(db) {
  return db.all('SELECT * FROM dividends ORDER BY paid_date DESC, id DESC').map((d) => ({ ...d, allocations: JSON.parse(d.allocations || '[]') }));
}
const dividendsDeclared = (db, from, to) => db.all('SELECT total FROM dividends WHERE declared_date >= ? AND declared_date <= ?', from, to).reduce((a, d) => a + d.total, 0);

function periodResult(db, settings, period, allPeriods) {
  const pnl = companyPnl(db, settings, period);
  const ct = corporationTax(db, settings, period, { pnl, allPeriods });
  return { pnl, ct, profitAfterTax: pnl.profitBeforeTax - ct.tax };
}

/** Retained profit brought forward to the start of `period`. */
export function retainedBefore(db, settings, periods, period) {
  let re = 0;
  for (const p of periods) {
    if (p.start >= period.start) break;
    re += periodResult(db, settings, p, periods).profitAfterTax - dividendsDeclared(db, p.start, p.end);
  }
  return re;
}

/** Profit available for dividends on `date`: earlier retained profit + profit this period so far (after estimated tax) − dividends already declared this period. */
export function distributableReserves(db, settings, date) {
  const periods = companyPeriods(settings, { asOf: date, firstDate: earliestActivityDate(db) });
  const period = periods.find((p) => p.start <= date && date <= p.end) || periods[periods.length - 1];
  const before = retainedBefore(db, settings, periods, period);
  const toDate = { ...period, end: date, days: dayCount(period.start, date), key: `${period.start}_${date}` };
  const pnl = companyPnl(db, settings, toDate);
  const est = ctCharge({ profits: Math.max(0, pnl.profitBeforeTax), days: period.days, associated: settings.company.associatedCompanies || 0 }).tax;
  const declaredThisPeriod = dividendsDeclared(db, period.start, period.end);
  return { period, retainedBefore: before, profitToDate: pnl.profitBeforeTax, estimatedTax: est, declaredThisPeriod, available: before + pnl.profitBeforeTax - est - declaredThisPeriod };
}

export function declareDividend(db, settings, input) {
  const directors = directorsOf(settings);
  const { declared_date, paid_date = input.declared_date, notes, acknowledge } = input;
  if (!isISO(declared_date) || !isISO(paid_date)) throw new ValidationError('Use valid dates', 'declared_date');
  if (paid_date < declared_date) throw new ValidationError('The payment date cannot be before the declaration date', 'paid_date');
  const total = Math.round(Number(input.total));
  if (!(total > 0)) throw new ValidationError('Enter the total dividend', 'total');
  if (!directors.length) throw new ValidationError('Add the company directors/shareholders in Settings first', 'directors');
  const shares = directors.map((d) => Math.max(0, Number(d.shares) || 0));
  const shareTotal = shares.reduce((a, b) => a + b, 0);
  if (!shareTotal) throw new ValidationError('Each shareholder needs a number of shares in Settings, so the dividend can be split fairly', 'directors');
  // Dividends are per share – everyone in the same class gets the same amount per share, in proportion to their holding.
  let given = 0;
  const allocations = directors.map((d, i) => {
    const amount = i === directors.length - 1 ? total - given : Math.round((total * shares[i]) / shareTotal);
    given += amount;
    return { director_id: d.id, name: d.name, shares: shares[i], amount };
  }).filter((a) => a.shares > 0);
  const reserves = distributableReserves(db, settings, declared_date);
  if (total > reserves.available && !acknowledge) {
    throw Object.assign(new ValidationError(`This dividend (${fmtGBP(total)}) is more than the profit available for dividends (${fmtGBP(Math.max(0, reserves.available))}). A dividend paid out of reserves that don't exist can be unlawful and may have to be repaid.`, 'total'), { code: 'insufficient_reserves', reserves });
  }
  const account = input.account_id || db.get("SELECT id FROM accounts WHERE kind = 'bank' AND archived = 0 ORDER BY id LIMIT 1")?.id;
  return db.tx(() => {
    const txn = createTransaction(db, {
      account_id: account, date: paid_date, description: `Dividend – ${allocations.map((a) => a.name).join(', ')}`, amount: -total,
      category_id: 'dividend_paid', status: 'confirmed', source: 'manual',
    });
    const r = db.run('INSERT INTO dividends (declared_date, paid_date, total, allocations, account_id, txn_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      declared_date, paid_date, total, JSON.stringify(allocations), account, txn.id, notes || null);
    audit(db, 'dividend', r.id, 'declare', { total });
    return { id: r.id, declared_date, paid_date, total, allocations, reserves };
  });
}

export function deleteDividend(db, id) {
  const d = db.get('SELECT * FROM dividends WHERE id = ?', id);
  if (!d) { const e = new Error('Dividend not found'); e.status = 404; throw e; }
  db.tx(() => { if (d.txn_id) db.run('DELETE FROM transactions WHERE id = ?', d.txn_id); db.run('DELETE FROM dividends WHERE id = ?', id); });
}

/** What each director should put on their personal tax return for a tax year, with a rough personal tax estimate. */
export function directorDividendSummary(db, settings, taxYear, otherIncome = {}) {
  if (!SUPPORTED_TAX_YEARS.includes(taxYear)) throw new ValidationError(`Tax year ${taxYear} is not supported`);
  const divs = listDividends(db).filter((d) => taxYearOf(d.paid_date) === taxYear);
  return directorsOf(settings).map((dir) => {
    const total = divs.reduce((a, d) => a + (d.allocations.find((x) => x.director_id === dir.id)?.amount || 0), 0);
    const other = Math.round(Number(otherIncome[dir.id]) || 0);
    const calc = calculateIncomeTax({ taxYear, region: 'england', otherIncome: other, dividends: total });
    const without = calculateIncomeTax({ taxYear, region: 'england', otherIncome: other, dividends: 0 });
    return { director: dir, dividends: total, otherIncome: other, estimatedTax: calc.tax.incomeTax - without.tax.incomeTax, allowanceUsed: calc.allowancesUsed.dividendAllowance, rateStatus: calc.rateStatus, payments: divs.filter((d) => d.allocations.some((x) => x.director_id === dir.id)).map((d) => ({ id: d.id, paid_date: d.paid_date, amount: d.allocations.find((x) => x.director_id === dir.id).amount })) };
  });
}

// ------------------------------------------------------------------------------------------ balance sheet

function tradeDebtors(db, end) {
  let total = 0;
  for (const inv of listInvoices(db, {}, end)) {
    if (inv.status === 'draft' || inv.status === 'void' || inv.issue_date > end) continue;
    const paidByEnd = inv.payments.filter((p) => p.date <= end).reduce((a, p) => a + p.amount, 0);
    total += inv.totals.gross - paidByEnd;
  }
  return total;
}

/** Unexpired part of spread transactions at `end`: prepayments (expenses) and deferred income (sales). */
function spreadBalances(db, settings, end) {
  const cats = categoryMap(db);
  const vatOn = !!settings.vat.registered;
  let prepayments = 0, deferredIncome = 0;
  for (const t of db.all('SELECT * FROM transactions WHERE spread_from IS NOT NULL AND spread_to IS NOT NULL AND date <= ? AND status != ?', end, 'ignored')) {
    const cat = cats[t.category_id]; if (!cat) continue;
    const vat = vatOn ? Math.abs(t.vat_amount || 0) : 0;
    const value = Math.abs(t.amount) - vat;
    const recognised = spreadPortion(value, t.spread_from, t.spread_to, t.spread_from, end < t.spread_to ? end : t.spread_to).amount;
    const recognisedToDate = end < t.spread_from ? 0 : recognised;
    const unexpired = value - recognisedToDate;
    if (cat.kind === 'income' && t.amount > 0) deferredIncome += unexpired;
    else if ((cat.kind === 'expense' || cat.kind === 'capital') && t.amount < 0) prepayments += cat.kind === 'capital' ? 0 : unexpired;
  }
  return { prepayments, deferredIncome };
}

function vatPosition(db, settings, end) {
  if (!settings.vat.registered) return 0;
  const owed = vatReturn(db, '1990-01-01', end, settings).boxes.box5;
  const paid = db.all("SELECT amount FROM transactions WHERE category_id = 'vat_payment' AND date <= ?", end).reduce((a, t) => a + t.amount, 0); // payments are negative
  return owed + paid; // positive = still owed to HMRC
}

export function balanceSheet(db, settings, period, { periods, result } = {}) {
  const ps = periods || companyPeriods(settings, { asOf: period.end, firstDate: earliestActivityDate(db) });
  const end = period.end;
  const cur = result || periodResult(db, settings, period, ps);

  const accounts = db.all('SELECT * FROM accounts WHERE kind != ? ORDER BY id', 'dla').map((a) => ({
    id: a.id, name: a.name, balance: a.opening_balance + db.get('SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE account_id = ? AND date <= ?', a.id, end).s,
  }));
  const cash = accounts.reduce((a, x) => a + x.balance, 0);
  const fixed = fixedAssetsAt(db, end);
  const debtors = tradeDebtors(db, end);
  const { prepayments, deferredIncome } = spreadBalances(db, settings, end);
  const dla = directorBalances(db, settings, end);
  const dlaOwedToCompany = dla.filter((d) => d.balance > 0).reduce((a, d) => a + d.balance, 0);
  const dlaOwedToDirectors = -dla.filter((d) => d.balance < 0).reduce((a, d) => a + d.balance, 0);
  const vat = vatPosition(db, settings, end);
  const ctDueTotal = ps.filter((p) => p.end <= end).reduce((a, p) => a + periodResult(db, settings, p, ps).ct.tax, 0);
  const ctPaid = db.all("SELECT amount FROM transactions WHERE category_id = 'ct_payment' AND date <= ?", end).reduce((a, t) => a + t.amount, 0);
  const ctOwed = ctDueTotal + ctPaid; // payments are negative
  const unpaidDividends = db.all('SELECT total FROM dividends WHERE declared_date <= ? AND paid_date > ?', end, end).reduce((a, d) => a + d.total, 0);

  const debtorsTotal = debtors + prepayments + dlaOwedToCompany + (vat < 0 ? -vat : 0);
  const creditors = deferredIncome + (vat > 0 ? vat : 0) + Math.max(0, ctOwed) + dlaOwedToDirectors + unpaidDividends;
  const currentAssets = debtorsTotal + cash + (ctOwed < 0 ? -ctOwed : 0);
  const netAssets = fixed.nbv + currentAssets - creditors;

  const shareCapital = Math.round((Number(settings.company.shareCapital) || 0) * 100); // entered in pounds
  const before = retainedBefore(db, settings, ps, period);
  const dividends = dividendsDeclared(db, period.start, end);
  const retained = before + cur.profitAfterTax - dividends;
  const equity = shareCapital + retained;
  const difference = netAssets - equity;

  // Help the user find a gap: things that move cash without touching profit.
  const explain = [];
  const uncat = db.get('SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS s FROM transactions WHERE category_id IS NULL AND date <= ?', end);
  if (uncat.n) explain.push({ text: `${uncat.n} uncategorised transaction(s) move cash but not profit`, amount: uncat.s });
  const ignored = db.get("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS s FROM transactions WHERE status = 'ignored' AND date <= ?", end);
  if (ignored.n) explain.push({ text: `${ignored.n} ignored transaction(s)`, amount: ignored.s });
  const scRecorded = db.get("SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE category_id = 'share_capital' AND date <= ?", end).s;
  if (shareCapital && scRecorded !== shareCapital) explain.push({ text: `Share capital is ${fmtGBP(shareCapital)} but only ${fmtGBP(scRecorded)} has been recorded as paid in (category “Share capital paid in”)`, amount: scRecorded - shareCapital });
  const openings = accounts.filter((a) => a.balance !== 0).length && db.get("SELECT COALESCE(SUM(opening_balance), 0) AS s FROM accounts WHERE kind != 'dla'").s;
  if (openings) explain.push({ text: 'Bank accounts have an opening balance that is not share capital or profit', amount: openings });
  return {
    period, end, accounts, cash, fixedAssets: fixed, tradeDebtors: debtors, prepayments, dlaOwedToCompany, vatRecoverable: vat < 0 ? -vat : 0,
    debtorsTotal, currentAssets, deferredIncome, vatOwed: vat > 0 ? vat : 0, ctOwed: Math.max(0, ctOwed), dlaOwedToDirectors, unpaidDividends, creditors,
    netAssets, shareCapital, retainedBefore: before, profitAfterTax: cur.profitAfterTax, dividends, retained, equity, difference,
    balanced: Math.abs(difference) <= 1, explain,
  };
}

// ------------------------------------------------------------------------------------------ deadlines & overview

export function companyDeadlines(settings, period, asOf = today()) {
  const out = [];
  const add = (date, title, detail, kind) => out.push({ date, title, detail, kind, daysAway: Math.round((Date.parse(date) - Date.parse(asOf)) / 86400000) });
  for (const cp of ctPeriods(period)) {
    add(addDays(addMonths(cp.end, CORPORATION_TAX.payDays.months), CORPORATION_TAX.payDays.plusDays), `Pay Corporation Tax for the period ending ${fmtDate(cp.end)}`, 'Due 9 months and 1 day after the period ends', 'tax');
    add(addMonths(cp.end, CORPORATION_TAX.returnMonths), `File the Company Tax Return (CT600) for the period ending ${fmtDate(cp.end)}`, 'Due 12 months after the period ends', 'tax');
  }
  add(addMonths(period.end, 9), `Accounts due at Companies House for the period ending ${fmtDate(period.end)}`, '9 months after the year end (private company)', 'companies-house');
  if (isISO(settings.company.incorporationDate)) {
    const inc = settings.company.incorporationDate;
    let next = `${asOf.slice(0, 4)}${inc.slice(4)}`;
    if (next < asOf) next = `${Number(asOf.slice(0, 4)) + 1}${inc.slice(4)}`;
    add(addDays(next, 14), 'Confirmation statement (approx.)', `Review date ${fmtDate(next)} – due within 14 days. Check your actual review date on Companies House.`, 'companies-house');
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function companyWarnings(db, settings, period, { pnl, bs, ct, loans }) {
  const w = [];
  const add = (level, text, action) => w.push({ level, text, action });
  const c = settings.company;
  if (!c.name) add('warn', 'Add the company name in Settings.', { view: 'settings' });
  if (!c.number) add('warn', 'Add the Companies House registration number in Settings.', { view: 'settings' });
  if (!c.utr) add('warn', 'Add the company\'s 10-digit Corporation Tax UTR in Settings (HMRC sends it after you register for Corporation Tax).', { view: 'settings' });
  if (!isISO(c.incorporationDate)) add('warn', 'Add the incorporation date so your first accounting period is right.', { view: 'settings' });
  if (!directorsOf(settings).length) add('warn', "Add the directors in Settings – you need them for dividends and for tracking directors' loan accounts.", { view: 'settings' });
  if (pnl.uncategorised) add('error', `${pnl.uncategorised} transaction(s) in this period have no category and are NOT in the figures.`, { view: 'transactions', filter: { uncategorised: 1, taxYear: 'all' } });
  if (pnl.needsReview) add('warn', `${pnl.needsReview} transaction(s) were categorised automatically and still need a quick review.`, { view: 'transactions', filter: { status: 'review', taxYear: 'all' } });
  if (!bs.balanced) add('error', `The balance sheet is out by ${fmtGBP(Math.abs(bs.difference))}. Something that moves cash isn't in the profit & loss (see "Why it doesn't balance" on the Accounts tab).`, { tab: 'accounts' });
  if (period.longerThanYear) add('info', 'This first accounting period is longer than 12 months, so it has two Corporation Tax periods (two CT600 returns). The profit is split by days.');
  if (loans.total > 0) add(loans.over10k ? 'error' : 'warn', `Directors owe the company ${fmtGBP(loans.total)} at the year end. Unless repaid by ${fmtDate(loans.repayBy)} the company pays an extra Corporation Tax charge (s455) of about ${fmtGBP(loans.s455)}${loans.over10k ? ', and loans over £10,000 are also a taxable benefit for the director' : ''}. Pay it back, or declare a dividend, before then.`, { tab: 'directors' });
  if (ct.rows.some((r) => r.tradingLoss > 0)) add('info', 'The company made a trading loss. It is carried forward to set against future profits – enter it as "Trading losses brought forward" next year.');
  if (bs.fixedAssets.rows.length) add('info', `${bs.fixedAssets.rows.length} equipment item(s) are on your asset register and depreciated over ${[...new Set(bs.fixedAssets.rows.map((r) => r.life_years))].join('/')} years in the accounts. For tax they get the Annual Investment Allowance (100% up to £1m).`, { tab: 'assets' });
  if (!settings.vat.registered && pnl.turnover > 80000 * 100) add('warn', 'Turnover is approaching the £90,000 VAT registration threshold. Income from overseas ad networks counts towards it.');
  add('info', 'R&D tax relief may be available if you develop new software or apps. It is not calculated here – ask an accountant.');
  return w;
}

// ------------------------------------------------------------------------------------------ worksheets

const money = (label, value, extra = {}) => ({ type: 'money', label, value, ...extra });
const text = (label, value, extra = {}) => ({ type: 'text', label, value, ...extra });

export function companyForms({ settings, period, pnl, ct, bs, loans }) {
  const c = settings.company;
  const periodLabel = `${fmtDate(period.start)} to ${fmtDate(period.end)}`;
  const forms = [];

  forms.push({
    id: 'ACCOUNTS', title: 'Draft accounts – profit and loss account', applies: true,
    intro: `Company ${c.name || ''}${c.number ? ' (' + c.number + ')' : ''}. Period ${periodLabel}. Draft for the directors and your accountant; the accounts you file must be in iXBRL format via approved software.`,
    pages: [{ title: 'Profit and loss account', rows: [
      ...pnl.income.map((r) => money(r.name, r.amount)), money('Turnover', pnl.turnover, { emphasis: true }),
      ...pnl.expenses.map((r) => money(`${r.name}${r.allowable === 0 ? ' (not tax-deductible)' : ''}`, -r.amount)),
      ...(pnl.depreciation ? [money('Depreciation of equipment', -pnl.depreciation)] : []),
      money('Operating profit / (loss)', pnl.operatingProfit, { emphasis: true }), ...(pnl.interest ? [money('Interest receivable', pnl.interest)] : []),
      money('Profit / (loss) before tax', pnl.profitBeforeTax, { emphasis: true }), money('Tax on profit (Corporation Tax)', -ct.tax),
      money('Profit / (loss) for the financial year', pnl.profitBeforeTax - ct.tax, { emphasis: true }),
    ] }],
  });

  forms.push({
    id: 'BALANCE', title: `Draft accounts – balance sheet at ${fmtDate(period.end)}`, applies: true,
    intro: bs.balanced ? 'The balance sheet balances.' : `⚠ The balance sheet is out by ${fmtGBP(Math.abs(bs.difference))} – resolve this before relying on it.`,
    pages: [
      { title: 'Fixed assets', rows: [money('Tangible assets (equipment, after depreciation)', bs.fixedAssets.nbv)] },
      { title: 'Current assets', rows: [
        money('Trade debtors (unpaid invoices)', bs.tradeDebtors), ...(bs.prepayments ? [money('Prepayments', bs.prepayments)] : []),
        ...(bs.dlaOwedToCompany ? [money("Directors' loan accounts (owed to the company)", bs.dlaOwedToCompany)] : []), ...(bs.vatRecoverable ? [money('VAT recoverable', bs.vatRecoverable)] : []),
        money('Cash at bank', bs.cash), money('Total current assets', bs.currentAssets, { emphasis: true }),
      ] },
      { title: 'Creditors: amounts falling due within one year', rows: [
        ...(bs.deferredIncome ? [money('Deferred income (subscriptions received in advance)', bs.deferredIncome)] : []), ...(bs.vatOwed ? [money('VAT', bs.vatOwed)] : []),
        ...(bs.ctOwed ? [money('Corporation Tax', bs.ctOwed)] : []), ...(bs.dlaOwedToDirectors ? [money("Directors' loan accounts (owed to directors)", bs.dlaOwedToDirectors)] : []),
        ...(bs.unpaidDividends ? [money('Dividends declared but unpaid', bs.unpaidDividends)] : []), money('Total creditors', bs.creditors, { emphasis: true }),
      ] },
      { title: 'Net assets and capital', rows: [
        money('Net assets', bs.netAssets, { emphasis: true }), money('Called-up share capital', bs.shareCapital), money('Profit and loss reserve', bs.retained), money('Shareholders\' funds', bs.equity, { emphasis: true }),
        ...(!bs.balanced ? [money('Unreconciled difference', bs.difference)] : []),
      ] },
      { title: 'Micro-entity statements (draft wording – check with your accountant)', rows: [
        text('Audit exemption', `For the year ended ${fmtDate(period.end)} the company was entitled to exemption from audit under section 477 of the Companies Act 2006 relating to small companies.`),
        text('Members', 'The members have not required the company to obtain an audit of its accounts for the year in question in accordance with section 476.'),
        text('Directors\' responsibilities', 'The directors acknowledge their responsibilities for complying with the requirements of the Act with respect to accounting records and the preparation of accounts.'),
        text('Basis', 'These accounts have been prepared in accordance with the micro-entity provisions and delivered in accordance with the provisions applicable to companies subject to the small companies regime.'),
      ] },
    ],
  });

  const comp = ct.rows.map((r, i) => ({
    title: ct.rows.length > 1 ? `Corporation Tax period ${i + 1}: ${fmtDate(r.period.start)} to ${fmtDate(r.period.end)}` : 'Tax computation',
    rows: [
      money('Profit / (loss) per the accounts, before tax', r.profitBeforeTax),
      ...(r.interest ? [money('Less: interest receivable (taxed separately)', -r.interest)] : []),
      money('Add: depreciation (not deductible – capital allowances instead)', r.depreciationAddBack),
      ...(r.disallowableAddBack ? [money('Add: expenses not deductible for tax (entertainment etc.)', r.disallowableAddBack)] : []),
      ...(r.otherAdjustments ? [money('Other adjustments', r.otherAdjustments)] : []),
      money('Less: capital allowances', -r.capitalAllowances, { note: r.allowanceDetail.aia ? `Annual Investment Allowance £${(r.allowanceDetail.aia / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 })}` : '' }),
      ...(r.balancingCharges ? [money('Add: balancing charges', r.balancingCharges)] : []),
      money('Trading profit', r.tradingProfitBeforeLosses, { emphasis: true }),
      ...(r.lossesUsed ? [money('Less: trading losses brought forward', -r.lossesUsed)] : []),
      ...(r.interest ? [money('Add: non-trading loan relationship income (interest)', r.interest)] : []),
      ...(r.donations ? [money('Less: qualifying charitable donations', -r.donations)] : []),
      money('Profits chargeable to Corporation Tax', r.chargeable, { emphasis: true }),
      text('Rate applied', r.charge.band === 'small' ? '19% (small profits rate)' : r.charge.band === 'main' ? '25% (main rate)' : `25% less marginal relief (effective ${(r.chargeable ? (r.charge.tax / r.chargeable) * 100 : 0).toFixed(2)}%)`),
      ...(r.charge.marginalRelief ? [money('Marginal relief', -r.charge.marginalRelief)] : []),
      money('Corporation Tax payable', r.charge.tax, { emphasis: true }),
      text('Payment due', fmtDate(r.dueDate)), text('CT600 due', fmtDate(r.returnDue)),
    ],
  }));
  forms.push({ id: 'COMPUTATION', title: 'Corporation Tax computation', applies: true, intro: `Period ${periodLabel}. Associated companies: ${ct.associated}. Limits £50,000 / £250,000 are divided by (1 + associated companies) and reduced for periods under 12 months.`, pages: comp });

  forms.push({
    id: 'CT600', title: 'CT600 – Company Tax Return: figures to enter', applies: true,
    intro: 'Box numbers are shown where they were cross-checked against HMRC\'s CT600 (2025) guidance; † = inferred. Unnumbered rows are the same figures by name. HMRC\'s free online filing service closed on 31 March 2026: this return must be filed with HMRC-recognised commercial software (with iXBRL accounts and computations) or by an accountant.',
    pages: [
      { title: 'About the company', rows: [text('Company name', c.name), text('Company registration number', c.number), text('Unique Taxpayer Reference (UTR)', c.utr), text('Registered office', [c.registeredOffice, c.postcode].filter(Boolean).join(', '))] },
      ...ct.rows.map((r, i) => ({
        title: ct.rows.length > 1 ? `Return ${i + 1}: ${fmtDate(r.period.start)} to ${fmtDate(r.period.end)}` : `Accounting period ${periodLabel}`,
        rows: [
          money('Total turnover from trade', i === 0 ? Math.round(pnl.turnover * (r.period.days / period.days)) : pnl.turnover - ct.rows.slice(0, i).reduce((a, x) => a + Math.round(pnl.turnover * (x.period.days / period.days)), 0), { box: '145' }),
          money('Trading profits', r.tradingProfitBeforeLosses, { box: '155' }),
          money('Trading losses brought forward claimed against profits', r.lossesUsed, { box: '160', inferred: true }),
          money('Net trading profits', r.netTradingProfit, { box: '165' }),
          money('Non-trading loan relationship profits (interest)', r.interest),
          money('Qualifying charitable donations', r.donations),
          money('Profits chargeable to Corporation Tax', r.chargeable, { emphasis: true }),
          money('Corporation Tax before reliefs', pctOf(r.chargeable, r.charge.rate)),
          money('Marginal relief', r.charge.marginalRelief),
          money('Net Corporation Tax liability', r.charge.tax, { box: '475' }),
          ...(loans.s455 ? [money('Tax on loans to participators (see CT600A) – estimate', loans.s455)] : []),
          money('Total tax chargeable', r.charge.tax + (i === ct.rows.length - 1 ? loans.s455 : 0), { box: '510', emphasis: true }),
          text('Corporation Tax due on', fmtDate(r.dueDate)),
        ],
      })),
    ],
  });

  forms.push({
    id: 'CT600A', title: "CT600A – Loans to participators (director's loan account overdrawn)", applies: loans.total > 0,
    intro: `Overdrawn at ${fmtDate(period.end)}. If still outstanding on ${fmtDate(loans.repayBy)} the company owes the extra charge below. 35.75% applies to loans made on or after 6 April 2026 (33.75% before); HMRC's own online service may not yet show the new rate – check before filing.`,
    pages: [{ title: 'Loans outstanding at the end of the period', rows: loans.rows.map((r) => ({ type: 'text', label: `${r.director}${r.since ? ' (overdrawn since ' + fmtDate(r.since) + ')' : ''}`, value: `${fmtGBP(r.balance)} → charge ${fmtGBP(r.s455)} at ${(r.rate * 100).toFixed(2)}%` })) }],
  });
  return forms;
}

// ------------------------------------------------------------------------------------------ trial balance (for accountants / filing software)

export function trialBalance(db, settings, period, { pnl, ct, bs }) {
  const rows = [];
  const dr = (code, name, amount) => { if (amount) rows.push({ code, name, debit: amount > 0 ? amount : 0, credit: amount < 0 ? -amount : 0 }); };
  for (const r of pnl.income) dr('4000', r.name, -r.amount);
  if (pnl.interest) dr('4900', 'Bank interest received', -pnl.interest);
  pnl.expenses.forEach((r, i) => dr(String(7000 + i), r.name, r.amount));
  dr('7900', 'Depreciation', pnl.depreciation);
  dr('8000', 'Corporation Tax charge', ct.tax);
  dr('0010', 'Equipment – cost', bs.fixedAssets.cost); dr('0011', 'Equipment – accumulated depreciation', -bs.fixedAssets.depreciation);
  dr('1100', 'Trade debtors', bs.tradeDebtors); dr('1150', 'Prepayments', bs.prepayments);
  dr('1160', "Directors' loan accounts – owed to company", bs.dlaOwedToCompany); dr('1170', 'VAT recoverable', bs.vatRecoverable);
  for (const a of bs.accounts) dr('1200', a.name, a.balance);
  dr('2100', 'Deferred income', -bs.deferredIncome); dr('2200', 'VAT', -bs.vatOwed); dr('2300', 'Corporation Tax', -bs.ctOwed);
  dr('2400', "Directors' loan accounts – owed to directors", -bs.dlaOwedToDirectors); dr('2500', 'Dividends payable', -bs.unpaidDividends);
  dr('3000', 'Share capital', -bs.shareCapital); dr('3100', 'Retained earnings brought forward', -bs.retainedBefore);
  dr('3200', 'Dividends declared in the period', bs.dividends);
  const debit = rows.reduce((a, r) => a + r.debit, 0), credit = rows.reduce((a, r) => a + r.credit, 0);
  if (debit !== credit) rows.push({ code: '9999', name: 'SUSPENSE – unreconciled difference (investigate before filing)', debit: credit > debit ? credit - debit : 0, credit: debit > credit ? debit - credit : 0 });
  return { rows, debit: rows.reduce((a, r) => a + r.debit, 0), credit: rows.reduce((a, r) => a + r.credit, 0) };
}

export function trialBalanceCsv(tb, period) {
  const f = (p) => (p ? (p / 100).toFixed(2) : '');
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  return `﻿Code,Account,Debit,Credit\r\n${tb.rows.map((r) => [r.code, q(r.name), f(r.debit), f(r.credit)].join(',')).join('\r\n')}\r\n,${q(`Trial balance for the period ${period.start} to ${period.end}`)},${f(tb.debit)},${f(tb.credit)}\r\n`;
}

// ------------------------------------------------------------------------------------------ everything for one period

export function companyOverview(db, key) {
  const settings = getSettings(db);
  if (!companyConfigured(settings)) throw new ValidationError('Switch to a limited company in Settings first.');
  syncAssets(db, settings);
  const first = earliestActivityDate(db);
  const period = findPeriod(settings, key, { firstDate: first });
  const periods = companyPeriods(settings, { asOf: period.end, firstDate: first });
  const result = periodResult(db, settings, period, periods);
  const bs = balanceSheet(db, settings, period, { periods, result });
  const loans = loansToParticipators(db, settings, period);
  const dividends = listDividends(db);
  const warnings = companyWarnings(db, settings, period, { pnl: result.pnl, bs, ct: result.ct, loans });
  const forms = companyForms({ settings, period, pnl: result.pnl, ct: result.ct, bs, loans });
  return {
    period, periods: companyPeriods(settings, { asOf: today(), firstDate: first }), pnl: result.pnl, ct: result.ct, balanceSheet: bs, loans, warnings, forms,
    deadlines: companyDeadlines(settings, period), directors: directorBalances(db, settings, period.end), dividends,
    inputs: result.ct.inputs, reserves: distributableReserves(db, settings, period.end < today() ? period.end : today()),
    directorsList: directorsOf(settings),
  };
}
