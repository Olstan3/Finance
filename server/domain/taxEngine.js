// Self Assessment tax calculation engine. A pure function: figures in -> breakdown out.
// All inputs/outputs are integer PENCE. No database access here, so it is easy to test.
//
// Scope (individuals): employment, self-employment, UK property, pensions, savings interest,
// dividends, Gift Aid & pension relief at source, Marriage Allowance, Class 2/4 NIC, student
// loans, High Income Child Benefit Charge, residential finance-cost relief, CIS/PAYE credits,
// payments on account — plus Capital Gains Tax via calculateCgt().
//
// Simplifications are documented in README ("What it does not cover").

import { ratesFor } from './taxRates.js';
import { floorPounds, pctOf } from '../util/money.js';
import { taxYearStartYear } from '../util/dates.js';

const P = (pounds) => Math.round(pounds * 100);
const INF = Number.POSITIVE_INFINITY;

/** Tax a slice of income [pos, pos+amount) against a ladder of bands. Bands: {name, from, to, rate}. */
function taxSlice(amount, pos, bands, label, rows, type) {
  let tax = 0;
  if (amount <= 0) return 0;
  const end = pos + amount;
  for (const b of bands) {
    const lo = Math.max(pos, b.from);
    const hi = Math.min(end, b.to);
    if (hi > lo) {
      const portion = hi - lo;
      const t = pctOf(portion, b.rate);
      tax += t;
      rows.push({ type, band: b.name, amount: portion, rate: b.rate, tax: t, label });
    }
  }
  return tax;
}

function ukBands(R, extension) {
  const basicTop = P(R.basicRateBand) + extension;
  const higherTop = Math.max(basicTop, P(R.additionalRateThreshold));
  return [
    { name: 'Basic rate', from: 0, to: basicTop, rate: R.rates.basic },
    { name: 'Higher rate', from: basicTop, to: higherTop, rate: R.rates.higher },
    { name: 'Additional rate', from: higherTop, to: INF, rate: R.rates.additional },
  ];
}

function scottishBands(R, extension) {
  const defs = R.scotland.bands;
  const lastFinite = defs.filter((b) => b.upTo !== INF).length - 1;
  let from = 0;
  return defs.map((b, i) => {
    const to = b.upTo === INF ? INF : P(b.upTo) + (i < lastFinite ? extension : 0);
    const band = { name: `${b.name} rate`, from, to, rate: b.rate };
    from = to;
    return band;
  });
}

export function calculateIncomeTax(input) {
  const R = ratesFor(input.taxYear);
  const region = input.region === 'scotland' ? 'scotland' : 'uk';
  const n = (v) => Math.round(Number(v) || 0);

  const employmentPay = n(input.employmentPay);
  const seProfit = Math.max(0, n(input.selfEmploymentProfit));
  const propertyProfit = Math.max(0, n(input.propertyProfit));
  const pensionIncome = n(input.pensionIncome);
  const otherIncome = n(input.otherIncome);
  const savingsInterest = n(input.savingsInterest);
  const dividends = n(input.dividends);

  const nonSavings = employmentPay + seProfit + propertyProfit + pensionIncome + otherIncome;
  const totalIncome = nonSavings + savingsInterest + dividends;

  // Gift Aid and relief-at-source pension payments are made net of basic-rate tax; the gross
  // amount extends the basic-rate band and reduces adjusted net income.
  const grossGiftAid = pctOf(n(input.giftAidNet), 1 / 0.8);
  const grossPension = pctOf(n(input.pensionRasNet), 1 / 0.8);
  const bandExtension = grossGiftAid + grossPension;
  const adjustedNetIncome = Math.max(0, totalIncome - grossGiftAid - grossPension);

  // Personal Allowance, tapered £1 for every £2 of adjusted net income over £100k.
  let personalAllowance = P(R.personalAllowance);
  const taperStart = P(R.paTaperThreshold);
  if (adjustedNetIncome > taperStart) {
    const reductionPounds = Math.floor((floorPounds(adjustedNetIncome) - taperStart) / 100 / 2);
    personalAllowance = Math.max(0, personalAllowance - reductionPounds * 100);
  }
  const standardPA = personalAllowance;
  if (input.marriageAllowance === 'give') personalAllowance = Math.max(0, personalAllowance - P(R.marriageAllowance));

  // Allocate the Personal Allowance: non-savings first, then savings, then dividends.
  let paLeft = personalAllowance;
  const nsTaxable = floorPounds(Math.max(0, nonSavings - paLeft));
  paLeft = Math.max(0, paLeft - nonSavings);
  const savTaxable = floorPounds(Math.max(0, savingsInterest - paLeft));
  paLeft = Math.max(0, paLeft - savingsInterest);
  const divTaxable = floorPounds(Math.max(0, dividends - paLeft));
  const totalTaxable = nsTaxable + savTaxable + divTaxable;

  const ukB = ukBands(R, bandExtension);
  const basicTop = ukB[0].to;
  const higherTop = ukB[1].to;
  const nsBands = region === 'scotland' ? scottishBands(R, bandExtension) : ukB;

  const rows = [];

  // 1. Non-savings income
  const nonSavingsTax = taxSlice(nsTaxable, 0, nsBands, 'Earnings, profits & pensions', rows, 'Non-savings');

  // 2. Savings income: starting rate band (0%) -> Personal Savings Allowance (0%) -> normal rates
  let savingsTax = 0;
  let startingRateUsed = 0;
  let psaUsed = 0;
  if (savTaxable > 0) {
    const startingAvail = Math.max(0, P(R.savings.startingRateBand) - nsTaxable);
    startingRateUsed = Math.min(savTaxable, startingAvail);
    if (startingRateUsed) rows.push({ type: 'Savings', band: 'Starting rate for savings', amount: startingRateUsed, rate: 0, tax: 0, label: 'Savings interest' });
    const bracket = totalTaxable <= basicTop ? 'basic' : totalTaxable <= higherTop ? 'higher' : 'additional';
    const psa = P(R.savings.psa[bracket]);
    psaUsed = Math.min(savTaxable - startingRateUsed, psa);
    if (psaUsed) rows.push({ type: 'Savings', band: 'Personal Savings Allowance', amount: psaUsed, rate: 0, tax: 0, label: 'Savings interest' });
    const rest = savTaxable - startingRateUsed - psaUsed;
    savingsTax = taxSlice(rest, nsTaxable + startingRateUsed + psaUsed, ukB.map((b) => ({ ...b, rate: R.savings.rates[bandKey(b.name)] })), 'Savings interest', rows, 'Savings');
  }

  // 3. Dividends: dividend allowance (0%) then dividend rates
  let dividendTax = 0;
  let dividendAllowanceUsed = 0;
  if (divTaxable > 0) {
    dividendAllowanceUsed = Math.min(divTaxable, P(R.dividends.allowance));
    if (dividendAllowanceUsed) rows.push({ type: 'Dividends', band: 'Dividend allowance', amount: dividendAllowanceUsed, rate: 0, tax: 0, label: 'Dividends' });
    const rest = divTaxable - dividendAllowanceUsed;
    dividendTax = taxSlice(rest, nsTaxable + savTaxable + dividendAllowanceUsed, ukB.map((b) => ({ ...b, rate: R.dividends.rates[bandKey(b.name)] })), 'Dividends', rows, 'Dividends');
  }

  let incomeTaxBeforeReductions = nonSavingsTax + savingsTax + dividendTax;

  // Tax reductions
  const reductions = [];
  if (input.marriageAllowance === 'receive' && totalTaxable <= basicTop) {
    const amt = Math.min(pctOf(P(R.marriageAllowance), R.rates.basic), incomeTaxBeforeReductions);
    if (amt > 0) reductions.push({ label: 'Marriage Allowance transferred from spouse/civil partner', amount: amt });
  }
  const financeCosts = Math.max(0, n(input.residentialFinanceCosts));
  if (financeCosts > 0 && propertyProfit > 0) {
    const limit = Math.min(financeCosts, propertyProfit, Math.max(0, adjustedNetIncome - standardPA));
    const amt = pctOf(limit, R.rates.basic);
    if (amt > 0) reductions.push({ label: 'Residential property finance costs (20% relief)', amount: Math.min(amt, incomeTaxBeforeReductions - reductions.reduce((a, r) => a + r.amount, 0)) });
  }
  const totalReductions = reductions.reduce((a, r) => a + r.amount, 0);
  const incomeTax = Math.max(0, incomeTaxBeforeReductions - totalReductions);

  // National Insurance
  const seProfitForNic = Math.max(0, n(input.class4Profit ?? input.selfEmploymentProfit));
  const nicProfit = floorPounds(seProfitForNic);
  const c4 = R.class4;
  const c4Main = pctOf(Math.max(0, Math.min(nicProfit, P(c4.upper)) - P(c4.lower)), c4.mainRate);
  const c4Upper = pctOf(Math.max(0, nicProfit - P(c4.upper)), c4.upperRate);
  const class4 = c4Main + c4Upper;

  const weeklyClass2 = P(R.class2.weekly);
  const class2Annual = weeklyClass2 * 52;
  const class2Compulsory = !!input.hasSelfEmployment && R.class2.compulsoryAbove != null && nicProfit >= P(R.class2.compulsoryAbove);
  const class2 = class2Compulsory ? class2Annual : 0;
  const class2VoluntaryOption =
    !!input.hasSelfEmployment && !class2Compulsory && R.class2.compulsoryAbove == null && nicProfit < P(R.class2.smallProfitsThreshold)
      ? class2Annual : 0;

  // Student loans (collected through Self Assessment on total income above the threshold)
  const studentLoanLines = [];
  const sl = input.studentLoan || {};
  const incomeFloor = floorPounds(totalIncome);
  const addSl = (key, label) => {
    const def = R.studentLoan[key];
    if (!def || def.threshold == null) return;
    const amt = pctOf(Math.max(0, incomeFloor - P(def.threshold)), def.rate);
    studentLoanLines.push({ key, label, threshold: P(def.threshold), amount: amt });
  };
  if (sl.plan && sl.plan !== 'none') addSl(sl.plan, `Student Loan ${sl.plan.replace('plan', 'Plan ')}`);
  if (sl.postgrad) addSl('postgrad', 'Postgraduate Loan');
  const studentLoanGross = studentLoanLines.reduce((a, l) => a + l.amount, 0);
  const studentLoanDue = Math.max(0, studentLoanGross - n(sl.paidViaPaye));

  // High Income Child Benefit Charge
  let hicbc = 0;
  let hicbcPct = 0;
  const childBenefit = n(input.childBenefit);
  if (childBenefit > 0 && adjustedNetIncome > P(R.hicbc.lower)) {
    hicbcPct = Math.min(100, Math.floor((floorPounds(adjustedNetIncome) - P(R.hicbc.lower)) / P(R.hicbc.step)));
    hicbc = pctOf(childBenefit, hicbcPct / 100);
  }

  const cgt = n(input.capitalGainsTax);

  const dues = incomeTax + class4 + class2 + hicbc;
  const totalLiability = dues + studentLoanDue + cgt;

  const ds = input.taxDeductedAtSource || {};
  const credits = [
    { key: 'paye', label: 'Tax deducted from employment/pensions (PAYE)', amount: n(ds.paye) },
    { key: 'cis', label: 'CIS deductions suffered', amount: n(ds.cis) },
    { key: 'savings', label: 'Tax deducted from savings/other income', amount: n(ds.other) },
  ].filter((c) => c.amount);
  const deductedAtSource = credits.reduce((a, c) => a + c.amount, 0);
  const paymentsMade = (input.paymentsMade || []).reduce((a, p) => a + n(p.amount), 0);

  const balance = totalLiability - deductedAtSource - paymentsMade; // + = owed to HMRC, - = refund

  // Payments on account for the NEXT tax year (50% each, 31 Jan and 31 Jul).
  const sy = taxYearStartYear(input.taxYear);
  const saLiability = dues; // income tax + NIC + HICBC (excl. CGT and student loans)
  const unpaidAtSource = Math.max(0, saLiability - deductedAtSource);
  const poaRequired = unpaidAtSource >= 100000 && deductedAtSource < 0.8 * saLiability;
  const poaEach = poaRequired ? Math.round(unpaidAtSource / 2) : 0;
  const nextYear = `${sy + 1}-${String((sy + 2) % 100).padStart(2, '0')}`;
  const paymentsOnAccount = poaRequired
    ? [
        { label: `1st payment on account for ${nextYear}`, due: `${sy + 2}-01-31`, amount: poaEach },
        { label: `2nd payment on account for ${nextYear}`, due: `${sy + 2}-07-31`, amount: poaEach },
      ]
    : [];

  return {
    taxYear: input.taxYear,
    region,
    rateStatus: R.status,
    income: {
      employment: employmentPay, selfEmployment: seProfit, property: propertyProfit,
      pensions: pensionIncome, other: otherIncome, nonSavings,
      savings: savingsInterest, dividends, total: totalIncome,
    },
    adjustedNetIncome,
    giftAidGross: grossGiftAid,
    pensionGross: grossPension,
    bandExtension,
    personalAllowance, standardPersonalAllowance: standardPA,
    taxable: { nonSavings: nsTaxable, savings: savTaxable, dividends: divTaxable, total: totalTaxable },
    allowancesUsed: { startingRateSavings: startingRateUsed, personalSavingsAllowance: psaUsed, dividendAllowance: dividendAllowanceUsed },
    bands: rows,
    tax: { nonSavings: nonSavingsTax, savings: savingsTax, dividends: dividendTax, beforeReductions: incomeTaxBeforeReductions, reductions, incomeTax },
    nic: {
      class4, class4Main: c4Main, class4Upper: c4Upper, class4Profit: nicProfit,
      class2, class2Compulsory, class2VoluntaryOption, class2Annual,
    },
    studentLoan: { lines: studentLoanLines, gross: studentLoanGross, paidViaPaye: n(sl.paidViaPaye), due: studentLoanDue },
    hicbc: { amount: hicbc, percentage: hicbcPct, childBenefit },
    cgt,
    totalLiability,
    credits, deductedAtSource, paymentsMade,
    balance,
    paymentsOnAccount,
    balancingPaymentDue: `${sy + 2}-01-31`,
    firstPoaDueWithBalance: poaRequired ? poaEach : 0,
    totalDueByJanuary: Math.max(0, balance) + poaEach,
    effectiveRate: totalIncome > 0 ? (incomeTax + class4 + class2) / totalIncome : 0,
  };
}

function bandKey(name) {
  return name.startsWith('Basic') ? 'basic' : name.startsWith('Higher') ? 'higher' : 'additional';
}

// ---------------------------------------------------------------------------------------
// Capital Gains Tax
// ---------------------------------------------------------------------------------------

/**
 * disposals: [{ date, gain (pence, may be negative), residential: bool }]
 * ctx: { taxYear, taxableIncome (pence, after allowances), basicBandTop (pence), lossesBroughtForward (pence) }
 */
export function calculateCgt(disposals, ctx) {
  const R = ratesFor(ctx.taxYear);
  const C = R.cgt;
  const lossesBF = Math.max(0, Math.round(ctx.lossesBroughtForward || 0));

  const bucketFor = (d) => {
    let basic = d.residential ? C.rates.resBasic : C.rates.basic;
    let higher = d.residential ? C.rates.resHigher : C.rates.higher;
    if (!d.residential && C.ratesFrom && d.date >= C.ratesFrom.date) { basic = C.ratesFrom.basic; higher = C.ratesFrom.higher; }
    return { basic, higher };
  };

  const buckets = new Map();
  let gainsTotal = 0;
  let lossesTotal = 0;
  for (const d of disposals) {
    if (d.gain >= 0) {
      gainsTotal += d.gain;
      const { basic, higher } = bucketFor(d);
      const key = `${basic}/${higher}`;
      if (!buckets.has(key)) buckets.set(key, { basic, higher, amount: 0 });
      buckets.get(key).amount += d.gain;
    } else lossesTotal += -d.gain;
  }

  // Current-year losses are set against current-year gains (highest-rate gains first).
  const ordered = [...buckets.values()].sort((a, b) => b.higher - a.higher || b.basic - a.basic);
  let lossLeft = lossesTotal;
  for (const b of ordered) { const use = Math.min(b.amount, lossLeft); b.amount -= use; lossLeft -= use; }
  const netGain = ordered.reduce((a, b) => a + b.amount, 0);
  const currentYearLossCarriedForward = lossLeft;

  // Annual exempt amount, then brought-forward losses only as far as needed to reach the AEA.
  const aea = P(C.aea);
  const bfUsed = Math.min(lossesBF, Math.max(0, netGain - aea));
  let reduce = Math.min(netGain, aea) + bfUsed;
  const aeaUsed = Math.min(netGain, aea);
  for (const b of ordered) { const use = Math.min(b.amount, reduce); b.amount -= use; reduce -= use; }
  const taxableGain = ordered.reduce((a, b) => a + b.amount, 0);

  // Basic-rate band remaining after taxable income.
  let basicLeft = Math.max(0, (ctx.basicBandTop ?? P(R.basicRateBand)) - Math.max(0, ctx.taxableIncome || 0));
  const lines = [];
  let tax = 0;
  for (const b of ordered) {
    if (b.amount <= 0) continue;
    const lower = Math.min(b.amount, basicLeft);
    basicLeft -= lower;
    const upper = b.amount - lower;
    const t1 = pctOf(lower, b.basic);
    const t2 = pctOf(upper, b.higher);
    tax += t1 + t2;
    if (lower) lines.push({ amount: lower, rate: b.basic, tax: t1 });
    if (upper) lines.push({ amount: upper, rate: b.higher, tax: t2 });
  }

  return {
    gainsTotal, lossesTotal, netGain, aeaUsed, aea,
    lossesBroughtForwardUsed: bfUsed,
    lossesCarriedForward: currentYearLossCarriedForward + (lossesBF - bfUsed),
    taxableGain, tax, lines,
  };
}
