// Dates are ISO strings (YYYY-MM-DD) everywhere. All arithmetic is done in UTC so the
// server's time zone never shifts a date.

let clockOverride = null;
/** Test hook: freeze "today" to an ISO date. Pass null to restore. */
export function setClock(iso) { clockOverride = iso; }

export function today() {
  if (clockOverride) return clockOverride;
  const d = new Date();
  // "Today" in the UK, regardless of server timezone.
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

export const isISO = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && toISO(parseISO(s)) === s;

export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
export function toISO(d) {
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
export function addDays(iso, n) {
  const d = parseISO(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
}
const daysInMonth = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

/**
 * Add whole months, clamping to the end of shorter months. `anchorDay` lets a monthly series
 * that started on the 31st keep returning to the 31st (30 Apr -> 31 May) instead of drifting.
 */
export function addMonths(iso, n, anchorDay) {
  const d = parseISO(iso);
  const day = anchorDay || d.getUTCDate();
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
  const y = Math.floor(total / 12);
  const m0 = ((total % 12) + 12) % 12;
  return toISO(new Date(Date.UTC(y, m0, Math.min(day, daysInMonth(y, m0)))));
}
export function daysBetween(a, b) {
  return Math.round((parseISO(b) - parseISO(a)) / 86400000);
}
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---- UK tax year helpers ("2025-26" = 6 April 2025 .. 5 April 2026) ----

export function taxYearOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const startYear = m > 4 || (m === 4 && d >= 6) ? y : y - 1;
  return taxYearLabel(startYear);
}
export const taxYearLabel = (startYear) => `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
export const taxYearStartYear = (label) => Number(label.slice(0, 4));
export function taxYearRange(label) {
  const y = taxYearStartYear(label);
  return { start: `${y}-04-06`, end: `${y + 1}-04-05` };
}
export const isTaxYearLabel = (s) => /^\d{4}-\d{2}$/.test(s) && (Number(s.slice(0, 4)) + 1) % 100 === Number(s.slice(5));
export const currentTaxYear = () => taxYearOf(today());
export const previousTaxYear = (label) => taxYearLabel(taxYearStartYear(label) - 1);

/** Self Assessment online filing + payment deadline for a tax year: 31 January after it ends. */
export const filingDeadline = (label) => `${taxYearStartYear(label) + 2}-01-31`;
export const paperDeadline = (label) => `${taxYearStartYear(label) + 1}-10-31`;
/** Records must be kept 5 years after the 31 January submission deadline. */
export const keepRecordsUntil = (label) => `${taxYearStartYear(label) + 7}-01-31`;

/**
 * MTD-for-Income-Tax quarterly update periods. "standard" = 6 Apr-5 Jul etc.; "calendar" =
 * 1 Apr-30 Jun etc. (an HMRC-permitted election). Deadlines are the 7th of the month after.
 */
export function quarterlyPeriods(label, scheme = 'standard') {
  const y = taxYearStartYear(label);
  if (scheme === 'calendar') {
    return [
      { n: 1, start: `${y}-04-01`, end: `${y}-06-30`, due: `${y}-08-07` },
      { n: 2, start: `${y}-07-01`, end: `${y}-09-30`, due: `${y}-11-07` },
      { n: 3, start: `${y}-10-01`, end: `${y}-12-31`, due: `${y + 1}-02-07` },
      { n: 4, start: `${y + 1}-01-01`, end: `${y + 1}-03-31`, due: `${y + 1}-05-07` },
    ];
  }
  return [
    { n: 1, start: `${y}-04-06`, end: `${y}-07-05`, due: `${y}-08-07` },
    { n: 2, start: `${y}-07-06`, end: `${y}-10-05`, due: `${y}-11-07` },
    { n: 3, start: `${y}-10-06`, end: `${y + 1}-01-05`, due: `${y + 1}-02-07` },
    { n: 4, start: `${y + 1}-01-06`, end: `${y + 1}-04-05`, due: `${y + 1}-05-07` },
  ];
}

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
