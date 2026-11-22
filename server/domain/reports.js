import { getSettings, getTaxInput } from '../db.js';
import { loadEntries, taxYearEntries, totalsByTaxField, categoryMap } from './ledger.js';
import { buildTaxReturn } from './taxReturn.js';
import { receivablesAging, listInvoices } from './invoices.js';
import { listTemplates, previewDates } from './recurring.js';
import { vatThresholdCheck, vatPeriods, vatDueDate } from './vat.js';
import { taxYearRange, currentTaxYear, today, quarterlyPeriods, filingDeadline, taxYearStartYear, addDays, MONTHS } from '../util/dates.js';
import { THRESHOLDS } from './taxRates.js';

/** Profit & loss grouped by category for a tax year or an arbitrary range. */
export function profitAndLoss(db, { taxYear, from, to }) {
  const settings = getSettings(db);
  const cats = categoryMap(db);
  let entries, uncategorised, needsReview;
  if (taxYear) {
    ({ entries, uncategorised, needsReview } = taxYearEntries(db, taxYear, { settings, cats }));
    ({ start: from, end: to } = taxYearRange(taxYear));
  } else ({ entries, uncategorised, needsReview } = loadEntries(db, from, to, { settings, cats }));

  const group = (kind) => {
    const m = new Map();
    for (const e of entries) {
      const k = e.kind === 'capital' ? 'capital' : e.kind;
      if (k !== kind) continue;
      const row = m.get(e.category_id) || { category_id: e.category_id, name: cats[e.category_id]?.name || e.category_id, section: e.section, amount: 0, count: 0 };
      row.amount += e.net; row.count++;
      m.set(e.category_id, row);
    }
    return [...m.values()].sort((a, b) => b.amount - a.amount);
  };
  const income = group('income');
  const expenses = group('expense');
  const capital = group('capital');
  const totalIncome = income.reduce((a, r) => a + r.amount, 0);
  const cashBasis = settings.accountingBasis !== 'accruals';
  const totalExpenses = expenses.reduce((a, r) => a + r.amount, 0) + (cashBasis ? capital.reduce((a, r) => a + r.amount, 0) : 0);
  return {
    from, to, basis: settings.accountingBasis, income, expenses, capital, totalIncome, totalExpenses, netProfit: totalIncome - totalExpenses,
    uncategorised: uncategorised.length, needsReview,
  };
}

/**
 * Month-by-month income/expense series. With `taxMonths` the buckets run 6th–5th (HMRC "tax
 * months"), so a tax year is exactly 12 buckets labelled Apr..Mar.
 */
export function monthlySeries(db, from, to, { taxMonths = false } = {}) {
  const settings = getSettings(db);
  const { entries } = loadEntries(db, from, to, { settings });
  const cashBasis = settings.accountingBasis !== 'accruals';
  const bucketOf = (date) => {
    let [y, m, d] = date.split('-').map(Number);
    if (taxMonths && d < 6) { m -= 1; if (m === 0) { m = 12; y -= 1; } }
    return [y, m];
  };
  const months = new Map();
  const [fy, fm] = bucketOf(from);
  const [ty, tm] = bucketOf(to);
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, (m = 1)) : m++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    months.set(key, { month: key, label: `${MONTHS[m - 1]} ${String(y).slice(2)}`, income: 0, expenses: 0 });
  }
  for (const e of entries) {
    const [y, m] = bucketOf(e.date);
    const row = months.get(`${y}-${String(m).padStart(2, '0')}`);
    if (!row) continue;
    if (e.kind === 'income') row.income += e.net;
    else if (e.kind === 'expense' || (e.kind === 'capital' && cashBasis)) row.expenses += e.net;
  }
  return [...months.values()];
}

export function accountBalances(db) {
  return db.all(
    `SELECT a.id, a.name, a.kind, a.opening_balance + COALESCE(SUM(t.amount), 0) AS balance, COUNT(t.id) AS transactions
     FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id WHERE a.archived = 0 GROUP BY a.id ORDER BY a.id`,
  );
}

/** Everything the dashboard needs in one call. */
export function dashboard(db, taxYear = currentTaxYear()) {
  const settings = getSettings(db);
  const asOf = today();
  const { start, end } = taxYearRange(taxYear);
  const pnl = profitAndLoss(db, { taxYear });
  const ret = buildTaxReturn(db, taxYear, { settings });
  const aging = receivablesAging(db, asOf);
  const overdue = listInvoices(db, { status: 'overdue' }, asOf);
  const drafts = listInvoices(db, { status: 'draft' }, asOf).length;

  const deadlines = [];
  const add = (date, title, detail, kind) => { if (date >= addDays(asOf, -30)) deadlines.push({ date, title, detail, kind, daysAway: Math.round((Date.parse(date) - Date.parse(asOf)) / 86400000) }); };
  const sy = taxYearStartYear(taxYear);
  add(filingDeadline(taxYear), `Self Assessment ${taxYear}: file and pay`, 'Online filing and balancing payment deadline', 'tax');
  add(`${sy + 1}-07-31`, 'Second payment on account', 'For the previous tax year', 'tax');
  add(`${sy}-10-31`, `Paper return deadline for ${taxYear.replace(/(\d{4})-(\d{2})/, (m, a) => `${a - 1}-${String(a).slice(2)}`)}`, '', 'tax');
  if (settings.vat.registered) {
    for (const p of vatPeriods(settings.vat.stagger || 1, asOf, 2)) add(p.due, `VAT return for period ending ${p.end}`, `Period ${p.start} to ${p.end}`, 'vat');
  }
  for (const q of quarterlyPeriods(taxYear, settings.mtd.quarterlyScheme)) add(q.due, `MTD quarterly update ${q.n}`, `${q.start} to ${q.end}`, 'mtd');
  deadlines.sort((a, b) => (a.date < b.date ? -1 : 1));

  const upcomingRecurring = listTemplates(db).filter((t) => t.active).flatMap((t) => previewDates(t, 1).map((d) => ({ id: t.id, name: t.name, contact: t.contact_name, date: d }))).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(0, 5);

  return {
    taxYear, asOf, period: { start, end },
    totals: { income: pnl.totalIncome, expenses: pnl.totalExpenses, profit: pnl.netProfit },
    estimate: { totalLiability: ret.calc.totalLiability, incomeTax: ret.calc.tax.incomeTax, class4: ret.calc.nic.class4, balance: ret.calc.balance, rateStatus: ret.status },
    accounts: accountBalances(db),
    receivables: { total: aging.total, buckets: aging.buckets, overdueCount: overdue.length, overdueTotal: overdue.reduce((a, i) => a + i.outstanding, 0), drafts },
    attention: { uncategorised: pnl.uncategorised, needsReview: pnl.needsReview, warnings: ret.warnings.filter((w) => w.level !== 'info').length },
    vatThreshold: settings.vat.registered ? null : vatThresholdCheck(db, asOf),
    deadlines: deadlines.slice(0, 6),
    upcomingRecurring,
    monthly: monthlySeries(db, start, end, { taxMonths: true }),
  };
}

// ---------------------------------------------------------------- MTD quarterly updates

const HMRC_SE_EXPENSE_NAMES = {
  'se.costOfGoods': 'costOfGoods', 'se.cis': 'paymentsToSubcontractors', 'se.wages': 'wagesAndStaffCosts', 'se.travel': 'carVanTravelExpenses',
  'se.premises': 'premisesRunningCosts', 'se.repairs': 'maintenanceCosts', 'se.admin': 'adminCosts', 'se.advertising': 'advertisingCosts',
  'se.interest': 'interestOnBankOtherLoans', 'se.financeCharges': 'financeCharges', 'se.badDebts': 'irrecoverableDebts',
  'se.professional': 'professionalFees', 'se.depreciation': 'depreciation', 'se.other': 'otherExpenses',
};
const SE_LABELS = {
  costOfGoods: 'Cost of goods', paymentsToSubcontractors: 'Subcontractor payments (CIS)', wagesAndStaffCosts: 'Wages and staff costs', carVanTravelExpenses: 'Car, van and travel',
  premisesRunningCosts: 'Rent, rates, power and insurance', maintenanceCosts: 'Repairs and maintenance', adminCosts: 'Phone, stationery and office costs', advertisingCosts: 'Advertising',
  businessEntertainmentCosts: 'Business entertainment', interestOnBankOtherLoans: 'Interest on loans', financeCharges: 'Bank and finance charges', irrecoverableDebts: 'Irrecoverable debts',
  professionalFees: 'Accountancy, legal and professional fees', depreciation: 'Depreciation', otherExpenses: 'Other expenses',
};

function sectionTotals(entries, basis) {
  const income = { turnover: 0, other: 0 };
  const exp = {};
  const prop = { rentIncome: 0, premisesRunningCosts: 0, repairsAndMaintenance: 0, financialCosts: 0, professionalFees: 0, costOfServices: 0, other: 0 };
  const propMap = { 'prop.rents': 'rentIncome', 'prop.rentRatesInsurance': 'premisesRunningCosts', 'prop.repairs': 'repairsAndMaintenance', 'prop.financeNonRes': 'financialCosts', 'prop.professional': 'professionalFees', 'prop.services': 'costOfServices', 'prop.other': 'other' };
  for (const e of entries) {
    if (e.section === 'self_employment') {
      if (e.taxField === 'se.turnover') income.turnover += e.net;
      else if (e.taxField === 'se.otherIncome') income.other += e.net;
      else if (e.kind === 'expense' || (e.kind === 'capital' && basis === 'cash')) {
        const key = e.category_id === 'se_entertainment' ? 'businessEntertainmentCosts' : HMRC_SE_EXPENSE_NAMES[e.kind === 'capital' ? 'se.other' : e.taxField];
        if (key) exp[key] = (exp[key] || 0) + e.net;
      }
    } else if (e.section === 'property' && propMap[e.taxField]) prop[propMap[e.taxField]] += e.net;
  }
  return { selfEmployment: { income, expenses: exp, totalExpenses: Object.values(exp).reduce((a, b) => a + b, 0) }, property: prop };
}

export function quarterlyUpdates(db, taxYear, scheme) {
  const settings = getSettings(db);
  const sch = scheme || settings.mtd.quarterlyScheme || 'standard';
  const basis = settings.accountingBasis === 'accruals' ? 'accruals' : 'cash';
  const { start } = taxYearRange(taxYear);
  const submitted = getTaxInput(db, taxYear, 'quarterlySubmitted', {}) || {};
  const asOf = today();
  const all = taxYearEntries(db, taxYear, { settings }).entries;
  return quarterlyPeriods(taxYear, sch).map((q) => {
    const inPeriod = all.filter((e) => e.date >= q.start && e.date <= q.end);
    const cumulative = all.filter((e) => e.date >= start && e.date <= q.end);
    const per = sectionTotals(inPeriod, basis);
    const cum = sectionTotals(cumulative, basis);
    const status = submitted[q.n] ? 'submitted' : q.end >= asOf ? (q.start > asOf ? 'future' : 'open') : q.due < asOf ? 'overdue' : 'due';
    const profit = (s) => s.selfEmployment.income.turnover + s.selfEmployment.income.other - s.selfEmployment.totalExpenses;
    return { ...q, status, submittedOn: submitted[q.n] || null, period: per, cumulative: cum, periodProfit: profit(per), cumulativeProfit: profit(cum), labels: SE_LABELS };
  });
}

export { totalsByTaxField, vatDueDate, THRESHOLDS };
