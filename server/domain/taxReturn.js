// Builds a complete Self Assessment return for one tax year:
//   ledger entries + user inputs  ->  SA103 / SA105 / SA102 / SA108 figures  ->  tax engine  ->  form worksheets.
//
// IMPORTANT: this produces *worksheets* that mirror HMRC's forms so figures can be keyed into
// HMRC's online service or approved commercial software. It does not submit anything to HMRC.
//
// Box numbers: `box` is shown only where it was cross-checked against HMRC's 2025-26 forms.
// `inferred: true` marks boxes derived from the form's numbering pattern (shown with a dagger).

import { getSettings, getTaxInput } from '../db.js';
import { ratesFor, THRESHOLDS } from './taxRates.js';
import { taxYearEntries, totalsByTaxField, categoryMap } from './ledger.js';
import { calculateIncomeTax, calculateCgt } from './taxEngine.js';
import { capitalAllowances } from './capitalAllowances.js';
import { taxYearRange, filingDeadline, keepRecordsUntil, today, taxYearStartYear, fmtDate } from '../util/dates.js';
import { floorPounds } from '../util/money.js';

const P = (pounds) => Math.round(pounds * 100);

export const DEFAULT_INPUTS = {
  employment: [],
  pensions: { pay: 0, tax: 0 },
  otherIncome: { amount: 0, tax: 0 },
  interestManual: 0,
  dividendsManual: 0,
  giftAidManual: 0,
  pensionRasManual: 0,
  studentLoan: { plan: 'none', postgrad: false, paidViaPaye: 0 },
  childBenefit: 0,
  marriageAllowance: 'none',
  cisDeducted: 0,
  otherTaxDeducted: 0,
  seLossesBF: 0,
  propLossesBF: 0,
  propFinanceBF: 0,
  cgtLossesBF: 0,
  seOwnUse: 0,
  seOtherAdjustments: 0,
  tradingAllowance: 'auto',
  propertyAllowance: 'auto',
  payments: [],
  capitalPoolsBF: null,
  notes: '',
};

export function loadInputs(db, taxYear) {
  const out = {};
  for (const [k, def] of Object.entries(DEFAULT_INPUTS)) out[k] = getTaxInput(db, taxYear, k, def);
  return out;
}

const sumFields = (totals, fields) => fields.reduce((a, f) => a + (totals[f] || 0), 0);

// ------------------------------------------------------------------ self-employment

const SE_EXPENSE_FIELDS = [
  ['se.costOfGoods', 'Cost of goods bought for resale or goods used', 17],
  ['se.cis', 'Construction industry – payments to subcontractors', 18],
  ['se.wages', 'Wages, salaries and other staff costs', 19],
  ['se.travel', 'Car, van and travel expenses', 20],
  ['se.premises', 'Rent, rates, power and insurance costs', 21],
  ['se.repairs', 'Repairs and maintenance of property and equipment', 22],
  ['se.admin', 'Phone, fax, stationery and other office costs', 23],
  ['se.advertising', 'Advertising and business entertainment costs', 24],
  ['se.interest', 'Interest on bank and other loans', 25],
  ['se.financeCharges', 'Bank, credit card and other financial charges', 26],
  ['se.badDebts', 'Irrecoverable debts written off', 27],
  ['se.professional', 'Accountancy, legal and other professional fees', 28],
  ['se.depreciation', 'Depreciation and loss/profit on sale of assets', 29],
  ['se.other', 'Other business expenses', 30],
];

function computeSelfEmployment(totals, unallowable, inputs, capital, R, basis) {
  const turnover = totals['se.turnover'] || 0;
  const otherIncome = totals['se.otherIncome'] || 0;
  const expenses = SE_EXPENSE_FIELDS.map(([field, label, box]) => ({ field, label, box, amount: totals[field] || 0, disallowable: unallowable[field] || 0 }));
  const totalExpenses = expenses.reduce((a, e) => a + e.amount, 0);
  const disallowable = expenses.reduce((a, e) => a + e.disallowable, 0);
  const grossIncome = turnover + otherIncome;
  const hasActivity = grossIncome !== 0 || totalExpenses !== 0 || capital.total !== 0;

  const netProfitBeforeAdj = grossIncome - totalExpenses;
  const ownUse = inputs.seOwnUse || 0;
  const otherAdj = inputs.seOtherAdjustments || 0;
  const additions = disallowable + ownUse + capital.balancingCharges + Math.max(0, otherAdj);
  const deductions = capital.total + Math.max(0, -otherAdj);
  const profitActual = netProfitBeforeAdj + additions - deductions;

  // Trading allowance: £1,000 in place of actual expenses (and capital allowances).
  const allowance = P(R.tradingAllowance);
  const profitWithAllowance = Math.max(0, grossIncome + ownUse - allowance);
  let usedAllowance = false;
  if (inputs.tradingAllowance === 'claim') usedAllowance = grossIncome > 0;
  else if (inputs.tradingAllowance === 'auto') usedAllowance = grossIncome > 0 && profitWithAllowance < profitActual;
  const profitAfterAllowance = usedAllowance ? profitWithAllowance : profitActual;

  const lossesBF = inputs.seLossesBF || 0;
  const lossUsed = profitAfterAllowance > 0 ? Math.min(lossesBF, profitAfterAllowance) : 0;
  const taxableProfit = Math.max(0, profitAfterAllowance - lossUsed);
  const lossThisYear = profitAfterAllowance < 0 ? -profitAfterAllowance : 0;

  return {
    active: hasActivity || lossesBF > 0, turnover, otherIncome, grossIncome, expenses, totalExpenses, disallowable,
    netProfitBeforeAdj, ownUse, otherAdj, additions, deductions, capitalAllowances: capital.total, balancingCharges: capital.balancingCharges,
    profitActual, usedAllowance, allowance, profitAfterAllowance, lossesBF, lossUsed, taxableProfit,
    lossThisYear, lossesCarriedForward: lossesBF - lossUsed + lossThisYear,
    useShortForm: turnover <= P(THRESHOLDS.sa103sTurnoverLimit) && !capital.total,
    basis,
  };
}

// ------------------------------------------------------------------ property

const PROP_EXPENSE_FIELDS = [
  ['prop.rentRatesInsurance', 'Rent, rates, insurance and ground rents', 24, false],
  ['prop.repairs', 'Property repairs, maintenance and renewals', 25, true],
  ['prop.financeNonRes', 'Non-residential finance costs', 26, false],
  ['prop.professional', 'Legal, management and other professional fees', 27, true],
  ['prop.services', 'Costs of services provided, including wages', 28, true],
  ['prop.other', 'Other allowable property expenses', 29, true],
];

function computeProperty(totals, inputs, R) {
  const rents = totals['prop.rents'] || 0;
  const expenses = PROP_EXPENSE_FIELDS.map(([field, label, box, inferred]) => ({ field, label, box, inferred, amount: totals[field] || 0 }));
  const totalExpenses = expenses.reduce((a, e) => a + e.amount, 0);
  const residentialFinance = totals['prop.residentialFinance'] || 0;
  const financeBF = inputs.propFinanceBF || 0;
  const profitActual = rents - totalExpenses;

  const allowance = P(R.propertyAllowance);
  const profitWithAllowance = Math.max(0, rents - allowance);
  let usedAllowance = false;
  if (inputs.propertyAllowance === 'claim') usedAllowance = rents > 0;
  else if (inputs.propertyAllowance === 'auto') usedAllowance = rents > 0 && profitWithAllowance < profitActual && residentialFinance === 0;
  const profit = usedAllowance ? profitWithAllowance : profitActual;

  const lossesBF = inputs.propLossesBF || 0;
  const lossUsed = profit > 0 ? Math.min(lossesBF, profit) : 0;
  const taxableProfit = Math.max(0, profit - lossUsed);
  const lossThisYear = profit < 0 ? -profit : 0;
  return {
    active: rents !== 0 || totalExpenses !== 0 || residentialFinance !== 0, rents, expenses, totalExpenses, profitActual, usedAllowance, allowance,
    profit, lossesBF, lossUsed, taxableProfit, lossThisYear, lossesCarriedForward: lossesBF - lossUsed + lossThisYear,
    residentialFinance: usedAllowance ? 0 : residentialFinance, financeBF: usedAllowance ? 0 : financeBF,
  };
}

// ------------------------------------------------------------------ main builder

export function buildTaxReturn(db, taxYear, opts = {}) {
  const settings = opts.settings || getSettings(db);
  const R = ratesFor(taxYear);
  const basis = settings.accountingBasis === 'accruals' ? 'accruals' : 'cash';
  const inputs = { ...loadInputs(db, taxYear), ...(opts.inputsOverride || {}) };
  const cats = categoryMap(db);

  const ledger = taxYearEntries(db, taxYear, { settings, cats });
  const { totals, unallowable } = totalsByTaxField(ledger.entries, { basis });
  const capital = capitalAllowances(db, taxYear, settings);

  const se = computeSelfEmployment(totals, unallowable, inputs, capital, R, basis);
  const prop = computeProperty(totals, inputs, R);

  const employment = (inputs.employment || []).map((e) => ({ ...e, net: (e.pay || 0) + (e.benefits || 0) - (e.expenses || 0) }));
  const employmentPay = employment.reduce((a, e) => a + e.net, 0);
  const employmentTax = employment.reduce((a, e) => a + (e.tax || 0), 0);

  const interest = (totals['int.bank'] || 0) + (inputs.interestManual || 0);
  const dividends = (totals['div.uk'] || 0) + (inputs.dividendsManual || 0);
  const giftAid = Math.abs(totals['relief.giftAid'] || 0) + (inputs.giftAidManual || 0);
  const pensionRas = Math.abs(totals['relief.pensionRas'] || 0) + (inputs.pensionRasManual || 0);

  const taxDeductedAtSource = {
    paye: employmentTax + (inputs.pensions?.tax || 0),
    cis: inputs.cisDeducted || 0,
    other: (inputs.otherTaxDeducted || 0) + (inputs.otherIncome?.tax || 0),
  };

  const engineBase = {
    taxYear,
    region: settings.profile.region === 'scotland' ? 'scotland' : 'england',
    hasSelfEmployment: se.active,
    employmentPay,
    selfEmploymentProfit: se.taxableProfit,
    class4Profit: se.taxableProfit,
    propertyProfit: prop.taxableProfit,
    residentialFinanceCosts: prop.residentialFinance + prop.financeBF,
    pensionIncome: inputs.pensions?.pay || 0,
    otherIncome: inputs.otherIncome?.amount || 0,
    savingsInterest: interest,
    dividends,
    giftAidNet: giftAid,
    pensionRasNet: pensionRas,
    marriageAllowance: inputs.marriageAllowance,
    studentLoan: { plan: inputs.studentLoan?.plan === 'none' ? null : inputs.studentLoan?.plan, postgrad: !!inputs.studentLoan?.postgrad, paidViaPaye: inputs.studentLoan?.paidViaPaye || 0 },
    childBenefit: inputs.childBenefit || 0,
    taxDeductedAtSource,
    paymentsMade: inputs.payments || [],
  };

  // Capital gains: needs taxable income to know how much basic-rate band is left.
  const disposals = db.all('SELECT * FROM disposals WHERE disposal_date >= ? AND disposal_date <= ? ORDER BY disposal_date', taxYearRange(taxYear).start, taxYearRange(taxYear).end);
  const disposalRows = disposals.map((d) => ({ ...d, gain: d.proceeds - d.cost - d.costs }));
  let calc = calculateIncomeTax({ ...engineBase, capitalGainsTax: 0 });
  let cgt = null;
  if (disposalRows.length || inputs.cgtLossesBF) {
    cgt = calculateCgt(disposalRows.map((d) => ({ date: d.disposal_date, gain: d.gain, residential: !!d.residential })), {
      taxYear, taxableIncome: calc.taxable.total, basicBandTop: P(R.basicRateBand) + calc.bandExtension, lossesBroughtForward: inputs.cgtLossesBF || 0,
    });
    calc = calculateIncomeTax({ ...engineBase, capitalGainsTax: cgt.tax });
  }

  const warnings = buildWarnings({ db, taxYear, R, settings, ledger, se, prop, calc, inputs, disposalRows, cats });
  const forms = buildForms({ taxYear, settings, R, se, prop, employment, inputs, interest, dividends, giftAid, pensionRas, calc, cgt, disposalRows, capital, basis, taxDeductedAtSource });

  return {
    taxYear,
    status: R.status,
    notes: R.notes || [],
    period: taxYearRange(taxYear),
    deadlines: { online: filingDeadline(taxYear), paper: `${taxYearStartYear(taxYear) + 1}-10-31`, keepRecordsUntil: keepRecordsUntil(taxYear) },
    inputs, se, prop, employment, interest, dividends, giftAid, pensionRas, capital, cgt, disposals: disposalRows,
    calc, forms, warnings,
    counts: { entries: ledger.entries.length, uncategorised: ledger.uncategorised.length, needsReview: ledger.needsReview },
  };
}

// ------------------------------------------------------------------ warnings

function buildWarnings({ taxYear, R, settings, ledger, se, prop, calc, inputs, disposalRows }) {
  const w = [];
  const add = (level, text, action) => w.push({ level, text, action });
  if (R.status === 'provisional') add('warn', `${taxYear} rates are provisional – the figures may change once HMRC publishes final rates.`);
  if (ledger.uncategorised.length) add('error', `${ledger.uncategorised.length} transaction(s) in this tax year have no category and are NOT included in the figures below.`, { view: 'transactions', filter: { taxYear, uncategorised: 1 } });
  if (ledger.needsReview) add('warn', `${ledger.needsReview} transaction(s) were categorised automatically and still need a quick review.`, { view: 'transactions', filter: { taxYear, status: 'review' } });
  const p = settings.profile;
  if (!p.name) add('warn', 'Add your name in Settings so it appears on the return worksheets.', { view: 'settings' });
  if (!p.utr) add('warn', 'Your 10-digit Unique Taxpayer Reference (UTR) is not set (Settings).', { view: 'settings' });
  if (!p.nino) add('warn', 'Your National Insurance number is not set (Settings).', { view: 'settings' });
  if (se.active && se.usedAllowance) add('info', `The £${R.tradingAllowance.toLocaleString('en-GB')} trading allowance gives a lower profit than your actual expenses, so it has been used (you cannot also claim the expenses).`);
  if (prop.active && prop.usedAllowance) add('info', `The £${R.propertyAllowance.toLocaleString('en-GB')} property allowance has been used instead of expenses (residential finance-cost relief is not available with it).`);
  if (se.lossThisYear > 0) add('info', 'You have a trading loss this year. It is carried forward against future profits of the same trade. (Sideways relief against other income is not calculated – speak to an adviser if you want to claim it.)');
  if (se.active && settings.accountingBasis === 'cash' && ledger.entries.some((e) => e.kind === 'capital' && e.net > 0)) add('info', 'Cash basis: equipment purchases are deducted as expenses in "Other business expenses". Cars are handled through capital allowances instead.');
  if (se.active && se.turnover > P(THRESHOLDS.vatRegistration)) add('warn', `Turnover is over the £${THRESHOLDS.vatRegistration.toLocaleString('en-GB')} VAT registration threshold – check whether you should be VAT registered.`);
  const mtd = THRESHOLDS.mtdItsa.find((t) => taxYearStartYear(taxYear) + 1 >= Number(t.from.slice(0, 4)));
  if (mtd && (se.grossIncome + prop.rents) > P(mtd.above)) add('info', `Making Tax Digital for Income Tax applies from ${fmtDate(mtd.from)} to people with qualifying income over £${mtd.above.toLocaleString('en-GB')}. Use the Quarterly updates tab to prepare your figures.`);
  if (calc.nic.class2VoluntaryOption) add('info', `Your profits are below the Small Profits Threshold. You can pay voluntary Class 2 NI (about £${(calc.nic.class2VoluntaryOption / 100).toFixed(2)}) to keep your State Pension record – this is not included in the total.`);
  if (calc.studentLoan.gross && !inputs.studentLoan?.paidViaPaye && inputs.employment?.length) add('info', 'If student-loan repayments were already deducted by your employer, enter them under Student loan so they are not charged twice.');
  if (disposalRows.length) add('info', 'Capital gains: Business Asset Disposal Relief, share pooling/matching and reliefs are not calculated – enter the final gain per disposal.');
  return w;
}

// ------------------------------------------------------------------ forms

const money = (label, value, extra = {}) => ({ type: 'money', label, value, ...extra });
const text = (label, value, extra = {}) => ({ type: 'text', label, value, ...extra });
const yesno = (label, value, extra = {}) => ({ type: 'yesno', label, value, ...extra });

function buildForms({ taxYear, settings, R, se, prop, employment, inputs, interest, dividends, giftAid, pensionRas, calc, cgt, disposalRows, capital, basis, taxDeductedAtSource }) {
  const p = settings.profile;
  const { start, end } = taxYearRange(taxYear);
  const period = `${fmtDate(start)} to ${fmtDate(end)}`;
  const forms = [];

  // ---------- SA100 main return ----------
  forms.push({
    id: 'SA100', title: 'SA100 – Tax return (main form)', applies: true,
    intro: `Tax year ${taxYear}: ${period}. Enter these figures in HMRC's online Self Assessment service (or the paper SA100). Supplementary pages needed are listed below.`,
    pages: [
      { title: 'Personal details', rows: [
        text('Full name', p.name), text('Unique Taxpayer Reference (UTR)', p.utr), text('National Insurance number', p.nino),
        text('Address', [p.address, p.postcode].filter(Boolean).join(', ')), text('Email', p.email),
        text('Tax region', p.region === 'scotland' ? 'Scottish taxpayer' : 'England, Wales or Northern Ireland'),
      ] },
      { title: 'Which supplementary pages do you need?', rows: [
        yesno('Employment (SA102)', employment.length > 0), yesno('Self-employment (SA103)', se.active),
        yesno('UK property (SA105)', prop.active), yesno('Capital gains summary (SA108)', disposalRows.length > 0),
        text('Not covered by this app', 'Partnership (SA104), foreign (SA106), trusts (SA107), residence/remittance (SA109)'),
      ] },
      { title: 'Savings and investment income', rows: [
        money('Interest from UK banks and building societies (gross)', interest, { field: 'int.bank' }),
        money('Dividends from UK companies', dividends, { field: 'div.uk' }),
      ] },
      { title: 'Pensions, benefits and other income', rows: [
        money('Pensions (including State Pension) – taxable amount', inputs.pensions?.pay || 0),
        money('Tax taken off pensions', inputs.pensions?.tax || 0),
        money('Other taxable income', inputs.otherIncome?.amount || 0),
      ] },
      { title: 'Reliefs and allowances', rows: [
        money('Gift Aid payments (amount paid, net)', giftAid, { field: 'relief.giftAid' }),
        money('Pension contributions paid net of basic-rate relief (relief at source)', pensionRas, { field: 'relief.pensionRas' }),
        text('Marriage Allowance', { none: 'Not claimed', give: 'Transferring to spouse/civil partner', receive: 'Receiving from spouse/civil partner' }[inputs.marriageAllowance] || 'Not claimed'),
      ] },
      { title: 'Student loans and Child Benefit', rows: [
        text('Student loan plan', inputs.studentLoan?.plan === 'none' ? 'None' : String(inputs.studentLoan.plan).replace('plan', 'Plan ')),
        yesno('Postgraduate loan', !!inputs.studentLoan?.postgrad),
        money('Child Benefit received in the tax year', inputs.childBenefit || 0),
        money('High Income Child Benefit Charge', calc.hicbc.amount),
      ] },
      { title: 'Tax already paid', rows: [
        money('Tax deducted from employment and pensions (PAYE)', taxDeductedAtSource.paye),
        money('Tax deducted by contractors under CIS', taxDeductedAtSource.cis),
        money('Other tax deducted', taxDeductedAtSource.other),
        money('Payments on account and other payments to HMRC already made', calc.paymentsMade),
      ] },
    ],
  });

  // ---------- SA102 Employment ----------
  forms.push({
    id: 'SA102', title: 'SA102 – Employment', applies: employment.length > 0,
    intro: 'One set of figures per employer, from your P60 / P45 / P11D.',
    pages: employment.length ? employment.map((e, i) => ({
      title: `Employment ${i + 1}: ${e.employer || 'employer'}`,
      rows: [
        text('Employer name', e.employer), text('Employer PAYE reference', e.payeRef),
        money('Pay from this employment (P60)', e.pay || 0), money('UK tax taken off pay', e.tax || 0),
        money('Benefits and expenses payments received (P11D)', e.benefits || 0), money('Allowable expenses you paid yourself', e.expenses || 0),
      ],
    })) : [{ title: 'No employment entered', rows: [] }],
  });

  // ---------- SA103 Self-employment ----------
  const expRows = se.expenses.map((e) => money(e.label, e.amount, { box: String(e.box), field: e.field }));
  const disRows = se.expenses.filter((e) => e.disallowable).map((e) => money(`Disallowable: ${e.label}`, e.disallowable, { box: String(e.box + 15), inferred: true }));
  forms.push({
    id: 'SA103F', title: `SA103${se.useShortForm ? 'S/F' : 'F'} – Self-employment`, applies: se.active,
    intro: `Accounting period ${period}. ${basis === 'cash' ? 'Cash basis' : 'Traditional (accruals) accounting'}. ${se.useShortForm ? 'Turnover is under £90,000, so you may use the short form (SA103S): its income and expense figures are the same as below.' : 'Use the full form (SA103F).'}`,
    pages: [
      { title: 'Business details', rows: [
        text('Business name', p.tradingName || p.name), text('Description of business', p.businessDescription),
        text('Postcode of business address', p.businessPostcode || p.postcode),
        text('Date business started (if in this period)', settings.businessStartDate && settings.businessStartDate >= start ? fmtDate(settings.businessStartDate) : ''),
        yesno('Cash basis used', basis === 'cash'),
      ] },
      { title: 'Income', rows: [
        money('Your turnover – takings, fees, sales or money earned', se.turnover, { box: '15', field: 'se.turnover' }),
        money('Any other business income', se.otherIncome, { box: '16', field: 'se.otherIncome' }),
        ...(se.usedAllowance ? [money('Trading income allowance claimed (instead of expenses)', se.allowance, { box: '16.1' })] : []),
      ] },
      { title: se.usedAllowance ? 'Allowable expenses (not used – trading allowance claimed)' : 'Total expenses (including any not allowable)', rows: se.usedAllowance ? [] : [
        ...expRows,
        money('Total expenses', se.totalExpenses, { box: '31', emphasis: true }),
      ] },
      { title: 'Expenses that are not allowable (added back)', rows: se.usedAllowance ? [] : [
        ...disRows,
        money('Total disallowable expenses', se.disallowable, { box: '46', emphasis: true }),
      ] },
      { title: 'Profit and adjustments', rows: se.usedAllowance ? [
        money('Taxable profit after trading allowance', se.profitAfterAllowance, { emphasis: true }),
      ] : [
        money('Net profit before adjustments (income less total expenses)', se.netProfitBeforeAdj),
        money('Goods and services for your own use', se.ownUse, { box: '60', inferred: true }),
        money('Balancing charges', se.balancingCharges),
        money('Other additions / (deductions)', se.otherAdj),
        money('Capital allowances', se.capitalAllowances, { note: basis === 'cash' ? 'Cars only – other equipment is an expense under the cash basis.' : 'AIA + writing-down allowances + first-year allowances' }),
        money('Net business profit / (loss) for tax purposes', se.profitAfterAllowance, { emphasis: true }),
      ] },
      { title: 'Losses and taxable profit', rows: [
        money('Loss brought forward set against this year\'s profit', se.lossUsed),
        money('Taxable profit for the year', se.taxableProfit, { emphasis: true }),
        money('Loss carried forward', se.lossesCarriedForward),
        money('Class 4 NIC profits', calc.nic.class4Profit),
      ] },
    ],
  });

  // ---------- SA105 UK property ----------
  forms.push({
    id: 'SA105', title: 'SA105 – UK property', applies: prop.active,
    intro: `Letting of UK property ${period}. Residential mortgage interest is NOT an expense: it gives a 20% tax reduction instead.`,
    pages: [
      { title: 'Income', rows: [
        money('Total rents and other income from property', prop.rents, { box: '20', field: 'prop.rents' }),
        ...(prop.usedAllowance ? [money('Property income allowance claimed (instead of expenses)', prop.allowance, { box: '20.1' })] : []),
      ] },
      { title: 'Allowable expenses', rows: prop.usedAllowance ? [] : [
        ...prop.expenses.map((e) => money(e.label, e.amount, { box: String(e.box), inferred: e.inferred, field: e.field })),
        money('Total allowable expenses', prop.totalExpenses, { emphasis: true }),
      ] },
      { title: 'Profit and finance costs', rows: [
        money('Net profit / (loss) from letting', prop.profit, { emphasis: true }),
        money('Loss brought forward used', prop.lossUsed),
        money('Taxable property profit', prop.taxableProfit, { emphasis: true }),
        money('Residential property finance costs', prop.residentialFinance, { box: '44', field: 'prop.residentialFinance' }),
        money('Unused residential finance costs brought forward', prop.financeBF, { box: '45' }),
        money('Property loss carried forward', prop.lossesCarriedForward),
      ] },
    ],
  });

  // ---------- SA108 Capital gains ----------
  forms.push({
    id: 'SA108', title: 'SA108 – Capital gains summary', applies: disposalRows.length > 0,
    intro: 'Summary of disposals in the tax year. Gain = proceeds − cost − allowable costs.',
    pages: [
      { title: 'Disposals', rows: disposalRows.length ? disposalRows.map((d) => ({
        type: 'text', label: `${d.description} (${d.asset_type}${d.residential ? ', residential' : ''}) – disposed ${fmtDate(d.disposal_date)}`,
        value: `Proceeds £${(d.proceeds / 100).toFixed(2)}, cost £${(d.cost / 100).toFixed(2)}, costs £${(d.costs / 100).toFixed(2)}, gain £${(d.gain / 100).toFixed(2)}`,
      })) : [] },
      { title: 'Gains and tax', rows: cgt ? [
        money('Total gains in the year', cgt.gainsTotal), money('Total losses in the year', cgt.lossesTotal),
        money('Annual exempt amount used', cgt.aeaUsed), money('Losses brought forward used', cgt.lossesBroughtForwardUsed),
        money('Taxable gains', cgt.taxableGain, { emphasis: true }), money('Capital Gains Tax', cgt.tax, { emphasis: true }),
        money('Losses to carry forward', cgt.lossesCarriedForward),
      ] : [] },
    ],
  });

  // ---------- SA110 tax calculation ----------
  const t = calc;
  forms.push({
    id: 'SA110', title: 'Tax calculation summary (SA110 equivalent)', applies: true,
    intro: `Estimated bill for ${taxYear}. HMRC's own calculation is the official figure – compare it with HMRC's after you file.`,
    pages: [
      { title: 'Income', rows: [
        money('Employment', t.income.employment), money('Self-employment profit', t.income.selfEmployment), money('UK property profit', t.income.property),
        money('Pensions and other income', t.income.pensions + t.income.other), money('Savings interest', t.income.savings), money('Dividends', t.income.dividends),
        money('Total income', t.income.total, { emphasis: true }),
      ] },
      { title: 'Allowances and taxable income', rows: [
        money('Adjusted net income', t.adjustedNetIncome), money('Personal Allowance', t.personalAllowance),
        money('Taxable: earnings, profits & pensions', t.taxable.nonSavings), money('Taxable: savings', t.taxable.savings), money('Taxable: dividends', t.taxable.dividends),
      ] },
      { title: 'Tax', rows: [
        ...t.bands.map((b) => ({ type: 'money', label: `${b.type} – ${b.band} (${(b.rate * 100).toFixed(2).replace(/\.?0+$/, '')}% on £${(b.amount / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 })})`, value: b.tax })),
        ...t.tax.reductions.map((r) => money(`Less: ${r.label}`, -r.amount)),
        money('Income Tax', t.tax.incomeTax, { emphasis: true }),
        money('Class 4 National Insurance', t.nic.class4), ...(t.nic.class2 ? [money('Class 2 National Insurance', t.nic.class2)] : []),
        ...(t.studentLoan.due ? [money('Student loan repayment', t.studentLoan.due)] : []),
        ...(t.hicbc.amount ? [money('High Income Child Benefit Charge', t.hicbc.amount)] : []),
        ...(t.cgt ? [money('Capital Gains Tax', t.cgt)] : []),
        money('Total tax and NIC due', t.totalLiability, { emphasis: true }),
      ] },
      { title: 'Payments and balance', rows: [
        ...t.credits.map((c) => money(`Less: ${c.label}`, -c.amount)),
        ...(t.paymentsMade ? [money('Less: payments already made to HMRC', -t.paymentsMade)] : []),
        money(t.balance >= 0 ? 'Balancing payment due' : 'Refund due to you', Math.abs(t.balance), { emphasis: true }),
        text('Balancing payment deadline', fmtDate(t.balancingPaymentDue)),
        ...t.paymentsOnAccount.map((pa) => money(`${pa.label} – due ${fmtDate(pa.due)}`, pa.amount)),
        money('Cash needed on 31 January (balance + 1st payment on account)', t.totalDueByJanuary, { emphasis: true }),
      ] },
    ],
  });

  return forms;
}

export { floorPounds };
