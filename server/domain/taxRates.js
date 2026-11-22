// UK tax-year rate tables. Everything here is *data*: when HMRC publishes next year's rates,
// add a new entry (or correct one) — no engine code needs to change.
//
// All money values are WHOLE POUNDS in this file (the engine converts to pence).
// `status`:
//   'confirmed'   – figures cross-checked against published HMRC / gov.scot material
//   'provisional' – announced but not independently re-verified; shown with a warning in the UI
//
// Scottish bands are given as upper limits of *taxable income* (i.e. after the Personal
// Allowance), exactly as HMRC publishes them for Self Assessment.

const UK_RATES = { basic: 0.2, higher: 0.4, additional: 0.45 };
const SL = (p1, p2, p4, p5 = 25000, pg = 21000) => ({
  plan1: { threshold: p1, rate: 0.09 },
  plan2: { threshold: p2, rate: 0.09 },
  plan4: { threshold: p4, rate: 0.09 },
  plan5: { threshold: p5, rate: 0.09 },
  postgrad: { threshold: pg, rate: 0.06 },
});

export const TAX_YEAR_DATA = {
  '2023-24': {
    status: 'confirmed',
    personalAllowance: 12570,
    paTaperThreshold: 100000,
    basicRateBand: 37700,
    additionalRateThreshold: 125140,
    rates: UK_RATES,
    scotland: {
      bands: [
        { name: 'Starter', upTo: 2162, rate: 0.19 },
        { name: 'Basic', upTo: 13118, rate: 0.2 },
        { name: 'Intermediate', upTo: 31092, rate: 0.21 },
        { name: 'Higher', upTo: 125140, rate: 0.42 },
        { name: 'Top', upTo: Infinity, rate: 0.47 },
      ],
    },
    savings: { startingRateBand: 5000, psa: { basic: 1000, higher: 500, additional: 0 }, rates: UK_RATES },
    dividends: { allowance: 1000, rates: { basic: 0.0875, higher: 0.3375, additional: 0.3935 } },
    class4: { lower: 12570, upper: 50270, mainRate: 0.09, upperRate: 0.02 },
    class2: { weekly: 3.45, smallProfitsThreshold: 6725, compulsoryAbove: 12570 },
    tradingAllowance: 1000,
    propertyAllowance: 1000,
    marriageAllowance: 1260,
    hicbc: { lower: 50000, step: 100 },
    studentLoan: SL(22015, 27295, 27660, null, 21000),
    cgt: { aea: 6000, rates: { basic: 0.1, higher: 0.2, resBasic: 0.18, resHigher: 0.28 } },
    capitalAllowances: { aia: 1000000, mainRate: 0.18, specialRate: 0.06 },
  },
  '2024-25': {
    status: 'confirmed',
    personalAllowance: 12570,
    paTaperThreshold: 100000,
    basicRateBand: 37700,
    additionalRateThreshold: 125140,
    rates: UK_RATES,
    scotland: {
      bands: [
        { name: 'Starter', upTo: 2306, rate: 0.19 },
        { name: 'Basic', upTo: 13991, rate: 0.2 },
        { name: 'Intermediate', upTo: 31092, rate: 0.21 },
        { name: 'Higher', upTo: 62430, rate: 0.42 },
        { name: 'Advanced', upTo: 125140, rate: 0.45 },
        { name: 'Top', upTo: Infinity, rate: 0.48 },
      ],
    },
    savings: { startingRateBand: 5000, psa: { basic: 1000, higher: 500, additional: 0 }, rates: UK_RATES },
    dividends: { allowance: 500, rates: { basic: 0.0875, higher: 0.3375, additional: 0.3935 } },
    class4: { lower: 12570, upper: 50270, mainRate: 0.06, upperRate: 0.02 },
    class2: { weekly: 3.45, smallProfitsThreshold: 6845, compulsoryAbove: null },
    tradingAllowance: 1000,
    propertyAllowance: 1000,
    marriageAllowance: 1260,
    hicbc: { lower: 60000, step: 200 },
    studentLoan: SL(24990, 27295, 31395),
    // 2024-25 CGT: 10/20% on most assets until 29 Oct 2024, 18/24% from 30 Oct 2024; residential property 18/24% all year.
    cgt: { aea: 3000, rates: { basic: 0.1, higher: 0.2, resBasic: 0.18, resHigher: 0.24 }, ratesFrom: { date: '2024-10-30', basic: 0.18, higher: 0.24 } },
    capitalAllowances: { aia: 1000000, mainRate: 0.18, specialRate: 0.06 },
  },
  '2025-26': {
    status: 'confirmed',
    personalAllowance: 12570,
    paTaperThreshold: 100000,
    basicRateBand: 37700,
    additionalRateThreshold: 125140,
    rates: UK_RATES,
    scotland: {
      bands: [
        { name: 'Starter', upTo: 2827, rate: 0.19 },
        { name: 'Basic', upTo: 14921, rate: 0.2 },
        { name: 'Intermediate', upTo: 31092, rate: 0.21 },
        { name: 'Higher', upTo: 62430, rate: 0.42 },
        { name: 'Advanced', upTo: 125140, rate: 0.45 },
        { name: 'Top', upTo: Infinity, rate: 0.48 },
      ],
    },
    savings: { startingRateBand: 5000, psa: { basic: 1000, higher: 500, additional: 0 }, rates: UK_RATES },
    dividends: { allowance: 500, rates: { basic: 0.0875, higher: 0.3375, additional: 0.3935 } },
    class4: { lower: 12570, upper: 50270, mainRate: 0.06, upperRate: 0.02 },
    class2: { weekly: 3.5, smallProfitsThreshold: 6845, compulsoryAbove: null },
    tradingAllowance: 1000,
    propertyAllowance: 1000,
    marriageAllowance: 1260,
    hicbc: { lower: 60000, step: 200 },
    studentLoan: SL(26065, 28470, 32745),
    cgt: { aea: 3000, rates: { basic: 0.18, higher: 0.24, resBasic: 0.18, resHigher: 0.24 } },
    capitalAllowances: { aia: 1000000, mainRate: 0.18, specialRate: 0.06 },
  },
  '2026-27': {
    status: 'provisional',
    notes: [
      'Scottish bands per the Scottish Budget 2026-27 (starter/basic/intermediate thresholds up 7.4%); check they were finally passed.',
      'Dividend ordinary/upper rates rise by 2 points to 10.75% / 35.75% from 6 April 2026.',
      'Class 2 weekly rate, small profits threshold, student-loan thresholds and the main-pool writing-down allowance rate are provisional.',
    ],
    personalAllowance: 12570,
    paTaperThreshold: 100000,
    basicRateBand: 37700,
    additionalRateThreshold: 125140,
    rates: UK_RATES,
    scotland: {
      bands: [
        { name: 'Starter', upTo: 3967, rate: 0.19 },
        { name: 'Basic', upTo: 16956, rate: 0.2 },
        { name: 'Intermediate', upTo: 31092, rate: 0.21 },
        { name: 'Higher', upTo: 62430, rate: 0.42 },
        { name: 'Advanced', upTo: 125140, rate: 0.45 },
        { name: 'Top', upTo: Infinity, rate: 0.48 },
      ],
    },
    savings: { startingRateBand: 5000, psa: { basic: 1000, higher: 500, additional: 0 }, rates: UK_RATES },
    dividends: { allowance: 500, rates: { basic: 0.1075, higher: 0.3575, additional: 0.3935 } },
    class4: { lower: 12570, upper: 50270, mainRate: 0.06, upperRate: 0.02 },
    class2: { weekly: 3.65, smallProfitsThreshold: 7105, compulsoryAbove: null },
    tradingAllowance: 1000,
    propertyAllowance: 1000,
    marriageAllowance: 1260,
    hicbc: { lower: 60000, step: 200 },
    studentLoan: SL(26900, 29385, 33795),
    cgt: { aea: 3000, rates: { basic: 0.18, higher: 0.24, resBasic: 0.18, resHigher: 0.24 } },
    capitalAllowances: { aia: 1000000, mainRate: 0.14, specialRate: 0.06 },
  },
};

export const SUPPORTED_TAX_YEARS = Object.keys(TAX_YEAR_DATA);

export function ratesFor(taxYear) {
  const r = TAX_YEAR_DATA[taxYear];
  if (!r) throw new Error(`No tax rates for ${taxYear}. Supported: ${SUPPORTED_TAX_YEARS.join(', ')}`);
  return r;
}

// Simplified-expenses rates (apply to all supported years).
export const SIMPLIFIED = {
  mileage: {
    car: { first10000: 0.45, after: 0.25 },
    motorcycle: { first10000: 0.24, after: 0.24 },
    bicycle: { first10000: 0.2, after: 0.2 },
  },
  // Use of home flat rate, per month, by hours worked from home that month.
  homeOffice: [
    { minHours: 101, perMonth: 26 },
    { minHours: 51, perMonth: 18 },
    { minHours: 25, perMonth: 10 },
  ],
};

// ---- Corporation Tax (unchanged for the financial years 2023-2026) ----
export const CORPORATION_TAX = {
  status: 'confirmed',
  smallProfitsRate: 0.19,
  mainRate: 0.25,
  lowerLimit: 50000,      // divided by (1 + associated companies) and scaled for short periods
  upperLimit: 250000,
  marginalFraction: 3 / 200,
  payDays: { months: 9, plusDays: 1 },   // CT is due 9 months and 1 day after the period ends
  returnMonths: 12,                      // CT600 due 12 months after the period ends
  accountsMonths: 9,                     // Companies House accounts for a private company
};

// Section 455 charge on loans to participators (e.g. overdrawn director's loan accounts):
// the rate is set by the date the loan was made. 35.75% from 6 April 2026, 33.75% before.
export const S455_RATES = [
  { from: '2026-04-06', rate: 0.3575 },
  { from: '0000-01-01', rate: 0.3375 },
];
export const S455_LATE_MONTHS = 9; // repay within 9 months + 1 day of period end to avoid the charge

export const VAT_RATES = {
  S: { code: 'S', label: 'Standard 20%', rate: 0.2 },
  R: { code: 'R', label: 'Reduced 5%', rate: 0.05 },
  Z: { code: 'Z', label: 'Zero-rated 0%', rate: 0 },
  E: { code: 'E', label: 'Exempt', rate: 0 },
  O: { code: 'O', label: 'Outside scope', rate: 0 },
  N: { code: 'N', label: 'No VAT', rate: 0 },
  // Overseas B2B: a service supplied to a customer abroad (e.g. an ad network). Outside UK VAT, but the value
  // is still reported in Box 6.
  OB: { code: 'OB', label: 'Sale to overseas business (outside UK VAT, in Box 6)', rate: 0 },
  // Reverse charge: services bought from an overseas supplier (hosting, domains, SaaS). You account for UK VAT
  // yourself – Boxes 1 and 4 (net nil) – and the value goes in Boxes 6 and 7.
  RC: { code: 'RC', label: 'Reverse charge – overseas supplier (Boxes 1, 4, 6, 7)', rate: 0 },
};

export const THRESHOLDS = {
  vatRegistration: 90000,
  vatDeregistration: 88000,
  // MTD for Income Tax: mandatory by qualifying income (gross self-employment + property turnover)
  mtdItsa: [
    { from: '2026-04-06', above: 50000 },
    { from: '2027-04-06', above: 30000 },
    { from: '2028-04-06', above: 20000 },
  ],
  sa103sTurnoverLimit: 90000,
};
