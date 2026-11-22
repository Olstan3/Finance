export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** pence -> "£1,234.56" (negatives as "-£12.30") */
export function gbp(p, { dp = 2, sign = false } = {}) {
  if (p == null || Number.isNaN(p)) return '';
  const neg = p < 0;
  const s = (Math.abs(p) / 100).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return `${neg ? '-' : sign && p > 0 ? '+' : ''}£${s}`;
}
export const gbp0 = (p) => gbp(p, { dp: 0 });
export const pct = (x, dp = 0) => `${(x * 100).toFixed(dp)}%`;

/** compact axis tick: full under 10,000, else 10K / 1.2M */
export function compactGBP(p) {
  const v = Math.abs(p) / 100;
  const sign = p < 0 ? '-' : '';
  if (v < 10000) return `${sign}£${v.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
  if (v < 1e6) return `${sign}£${+(v / 1000).toFixed(v < 100000 ? 1 : 0)}K`;
  return `${sign}£${+(v / 1e6).toFixed(1)}M`;
}

export function fmtDate(iso, { short = false } = {}) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return short ? `${d} ${MONTHS[m - 1]}` : `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "£1,200.50", "1200", "(45.00)", "-12" -> pence, or null if unparseable */
export function parseMoney(str) {
  if (typeof str === 'number') return Math.round(str * 100);
  let s = String(str ?? '').trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/^[-−–]/.test(s)) { neg = true; s = s.slice(1); }
  s = s.replace(/[£,\s]/g, '');
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
  const v = Math.round(parseFloat(s) * 100);
  return neg ? -v : v;
}
export const toInput = (p) => (p == null ? '' : (p / 100).toFixed(2));

export const cls = (...a) => a.filter(Boolean).join(' ');

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function isoToday() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }); }
export function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

export const STATUS_LABELS = { draft: 'Draft', sent: 'Awaiting payment', part_paid: 'Part paid', paid: 'Paid', overdue: 'Overdue', void: 'Void' };
export const STATUS_TONE = { draft: '', sent: 'info', part_paid: 'warn', paid: 'good', overdue: 'bad', void: '' };
export const FREQ_LABELS = { weekly: 'week', monthly: 'month', quarterly: 'quarter', yearly: 'year' };
