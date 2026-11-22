// Capital allowances for the self-employment pages: Annual Investment Allowance (AIA), main
// and special-rate pool writing-down allowances, 100% first-year allowance for zero-emission
// cars, and balancing charges. Under the cash basis, ordinary equipment is deducted as an
// expense instead, so only cars are handled here.

import { ratesFor, SUPPORTED_TAX_YEARS } from './taxRates.js';
import { getSettings, getTaxInput } from '../db.js';
import { taxYearRange, previousTaxYear } from '../util/dates.js';
import { pctOf } from '../util/money.js';

export const POOLS = {
  plant: 'Equipment & machinery (AIA)',
  car_main: 'Car – CO2 up to 50g/km (main pool, 18%)',
  car_special: 'Car – CO2 over 50g/km (special rate pool, 6%)',
  car_zero: 'Zero-emission car (100% first-year allowance)',
};

const SMALL_POOL = 100000; // £1,000

function compute(db, taxYear, cashBasis, depth) {
  const R = ratesFor(taxYear).capitalAllowances;
  const { start, end } = taxYearRange(taxYear);
  const assets = db.all('SELECT * FROM assets').filter((a) => (cashBasis ? a.pool.startsWith('car') : true));

  let bf = getTaxInput(db, taxYear, 'capitalPoolsBF', null);
  if (!bf) {
    const prev = previousTaxYear(taxYear);
    if (depth < 4 && SUPPORTED_TAX_YEARS.includes(prev)) {
      const p = compute(db, prev, cashBasis, depth + 1);
      bf = { main: p.pools.main.cf, special: p.pools.special.cf };
    } else bf = { main: 0, special: 0 };
  }

  const inYear = (d) => d && d >= start && d <= end;
  const pctOfAsset = (a, v) => pctOf(v, (a.business_pct ?? 100) / 100);
  const additions = assets.filter((a) => inYear(a.purchase_date));
  const disposals = assets.filter((a) => inYear(a.disposal_date));

  const plantAdds = additions.filter((a) => a.pool === 'plant').reduce((s, a) => s + pctOfAsset(a, a.cost), 0);
  const aiaLimit = R.aia * 100;
  const aia = Math.min(plantAdds, aiaLimit);
  const plantExcess = plantAdds - aia;
  const carMainAdds = additions.filter((a) => a.pool === 'car_main').reduce((s, a) => s + pctOfAsset(a, a.cost), 0);
  const carSpecialAdds = additions.filter((a) => a.pool === 'car_special').reduce((s, a) => s + pctOfAsset(a, a.cost), 0);
  const fya = additions.filter((a) => a.pool === 'car_zero').reduce((s, a) => s + pctOfAsset(a, a.cost), 0);

  const proceeds = (poolTest) => disposals.filter((a) => poolTest(a.pool)).reduce((s, a) => s + pctOfAsset(a, a.disposal_proceeds || 0), 0);
  const mainDisposals = proceeds((p) => p === 'plant' || p === 'car_main');
  const specialDisposals = proceeds((p) => p === 'car_special');

  const pool = (bfAmount, adds, disp, rate) => {
    const base = bfAmount + adds - disp;
    if (base < 0) return { bf: bfAmount, additions: adds, disposals: disp, wda: 0, balancingCharge: -base, cf: 0 };
    const wda = base <= SMALL_POOL && base > 0 ? base : pctOf(base, rate);
    return { bf: bfAmount, additions: adds, disposals: disp, wda, balancingCharge: 0, cf: base - wda };
  };
  const main = pool(bf.main || 0, plantExcess + carMainAdds, mainDisposals, R.mainRate);
  const special = pool(bf.special || 0, carSpecialAdds, specialDisposals, R.specialRate);

  const total = aia + fya + main.wda + special.wda;
  const charges = main.balancingCharge + special.balancingCharge;
  return {
    taxYear, aia, aiaLimit, fya, plantAdditions: plantAdds,
    pools: { main, special }, total, balancingCharges: charges,
    mainRate: R.mainRate, specialRate: R.specialRate,
    additions: additions.map((a) => ({ id: a.id, name: a.name, cost: a.cost, pool: a.pool })),
    disposals: disposals.map((a) => ({ id: a.id, name: a.name, proceeds: a.disposal_proceeds || 0 })),
  };
}

export function capitalAllowances(db, taxYear, settings = getSettings(db)) {
  return compute(db, taxYear, settings.accountingBasis !== 'accruals', 0);
}
