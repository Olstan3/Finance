// All money in the app is stored as integer pence. These helpers convert at the edges.

export const toPence = (pounds) => Math.round((Number(pounds) + Number.EPSILON) * 100);
export const toPounds = (pence) => pence / 100;

export function fmtGBP(pence, { sign = false, dp = 2 } = {}) {
  if (pence === null || pence === undefined || Number.isNaN(pence)) return '';
  const neg = pence < 0;
  const abs = Math.abs(pence) / 100;
  const s = abs.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return `${neg ? '-' : sign && pence > 0 ? '+' : ''}£${s}`;
}

/** Round a pence amount multiplied by a rate to the nearest penny (half away from zero). */
export function pctOf(pence, rate) {
  const v = pence * rate;
  return v < 0 ? -Math.round(-v) : Math.round(v);
}

/** Floor to whole pounds, expressed in pence (HMRC rounds taxable income down to the pound). */
export const floorPounds = (pence) => Math.floor(pence / 100) * 100;

export const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + (f(x) || 0), 0);

/**
 * Extract VAT from a VAT-inclusive gross amount at a given rate (e.g. 0.2).
 * Returns pence of VAT (positive magnitude when gross is positive).
 */
export function vatFromGross(gross, rate) {
  if (!rate) return 0;
  const g = Math.abs(gross);
  const vat = Math.round((g * rate) / (1 + rate));
  return gross < 0 ? -vat : vat;
}

/** Split an amount across weights, guaranteeing the parts sum to the total. */
export function allocate(total, weights) {
  const w = weights.reduce((a, b) => a + b, 0);
  if (!w) return weights.map(() => 0);
  let remaining = total;
  const parts = weights.map((x) => {
    const p = Math.round((total * x) / w);
    return p;
  });
  const diff = total - parts.reduce((a, b) => a + b, 0);
  if (parts.length) parts[parts.length - 1] += diff;
  remaining = 0;
  return parts;
}
