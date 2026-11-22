// Low-level text parsing: find dates and money amounts wherever they sit in a blob of text.
// Everything in the importer is built on these two scanners.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

const pad = (n) => String(n).padStart(2, '0');

function validYMD(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}
const fullYear = (yy) => (yy < 100 ? (yy >= 70 ? 1900 + yy : 2000 + yy) : yy);

// Each pattern: regex + a function turning the match into an ISO date (or null).
// `order` is 'dmy' (UK default) or 'mdy' for ambiguous numeric dates.
function datePatterns(order) {
  return [
    { re: /\b(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?\b/g, f: (m) => validYMD(+m[1], +m[2], +m[3]) },
    { re: /\b(\d{4})\/(\d{1,2})\/(\d{1,2})\b/g, f: (m) => validYMD(+m[1], +m[2], +m[3]) },
    { re: /(?<![\d/.-])(\d{1,2})(?:st|nd|rd|th)?[\s.\-/]*(?:of\s+)?${MON}[\s.,\-/]*(\d{4}|\d{2})(?![\d]|[.,]\d)/gi, f: (m) => validYMD(fullYear(+m[3]), MONTHS[m[2].toLowerCase()], +m[1]) },
    { re: /\b${MON}\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi, f: (m) => validYMD(+m[3], MONTHS[m[1].toLowerCase()], +m[2]) },
    {
      re: /(?<![\d/.-])(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})(?![\d/])/g,
      f: (m) => {
        let a = +m[1], b = +m[2];
        const y = fullYear(+m[3]);
        if (order === 'mdy') return validYMD(y, a, b) || validYMD(y, b, a);
        return validYMD(y, b, a) || validYMD(y, a, b); // dd/mm/yyyy, falling back to mm/dd if dd/mm is impossible
      },
    },
  ].map((p) => ({ ...p, re: new RegExp(p.re.source.replace(/\$\{MON\}/g, MON), p.re.flags) }));
}

/**
 * All dates in `text`, in order of appearance (non-overlapping).
 * Options: order ('dmy'|'mdy'), defaultYear / period {start,end} to resolve "13 Mar" with no year.
 */
export function findDates(text, { order = 'dmy', defaultYear, period } = {}) {
  const found = [];
  const taken = [];
  const overlaps = (s, e) => taken.some(([a, b]) => s < b && e > a);
  for (const { re, f } of datePatterns(order)) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const iso = f(m);
      if (!iso) continue;
      const s = m.index, e = m.index + m[0].length;
      if (overlaps(s, e)) continue;
      taken.push([s, e]);
      found.push({ iso, index: s, length: m[0].length, raw: m[0] });
    }
  }
  // Day + month with no year ("13 Mar", "13/03"): only when we know which year to use.
  if (defaultYear || period) {
    const short = [
      { re: new RegExp(`(?<![\\d/.-])(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON}(?![\\w])(?!\\s*\\d{4}(?!\\d))(?!\\s*\\d{2}(?![\\d.,]))`, 'gi'), f: (m) => [+m[1], MONTHS[m[2].toLowerCase()]] },
    ];
    for (const { re, f } of short) {
      let m;
      while ((m = re.exec(text))) {
        const [d, mo] = f(m);
        const s = m.index, e = m.index + m[0].length;
        if (overlaps(s, e)) continue;
        const iso = inferYear(d, mo, { defaultYear, period });
        if (!iso) continue;
        taken.push([s, e]);
        found.push({ iso, index: s, length: m[0].length, raw: m[0], inferredYear: true });
      }
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

function inferYear(day, month, { defaultYear, period }) {
  if (period?.start && period?.end) {
    for (const y of [Number(period.start.slice(0, 4)), Number(period.end.slice(0, 4))]) {
      const iso = validYMD(y, month, day);
      if (iso && iso >= period.start && iso <= period.end) return iso;
    }
  }
  return defaultYear ? validYMD(defaultYear, month, day) : null;
}

/** Parse one standalone date string. */
export function parseDate(str, opts = {}) {
  const s = String(str ?? '').trim();
  if (!s) return null;
  if (/^\d{8}(\d{6})?/.test(s) && !/[/.-]/.test(s)) { // OFX style 20250406[120000]
    const iso = validYMD(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8));
    if (iso) return iso;
  }
  const hits = findDates(s, opts);
  return hits.length ? hits[0].iso : null;
}

// ---------------------------------------------------------------- amounts

const CUR = '(?:£|GBP|\\$|USD|€|EUR)';
const AMOUNT_RE = new RegExp(
  '(?<![\\w.,/\\-:])' + // not glued to a word, another number, a date or a time
  '(?<pre>[-−–+]|\\()?\\s*' +
  `(?<cur>${CUR})?\\s*` +
  '(?<pre2>[-−–])?\\s*' +
  '(?<num>\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+\\.\\d{1,2}|\\d+)' +
  '(?<post>\\)|[-−–](?![\\d\\w])|\\s?(?:CR|DR|Cr|Dr|cr|dr)(?![a-zA-Z]))?' +
  `(?<cur2>\\s?(?:GBP|USD|EUR))?(?![\\w/:]|\\.\\d)`,
  'g',
);

const CURRENCY_CODE = { '£': 'GBP', GBP: 'GBP', $: 'USD', USD: 'USD', '€': 'EUR', EUR: 'EUR' };

/** Parse a standalone amount string into pence (signed), or null. */
export function parseAmount(str) {
  if (typeof str === 'number') return Math.round(str * 100);
  const s = String(str ?? '').trim();
  if (!s) return null;
  const hits = findAmounts(s, { allowBare: true });
  if (!hits.length) return null;
  // A standalone cell has exactly one amount; if there are several take the first.
  return hits[0].pence;
}

/**
 * All money amounts in `text`. An amount needs two decimal places OR a currency marker, so
 * that reference numbers, years and phone numbers are not mistaken for money
 * (use allowBare for cells that are known to hold just a number).
 */
export function findAmounts(text, { allowBare = false } = {}) {
  const out = [];
  AMOUNT_RE.lastIndex = 0;
  let m;
  while ((m = AMOUNT_RE.exec(text))) {
    const g = m.groups;
    const hasDecimals = /\.\d{1,2}$/.test(g.num);
    const cur = g.cur || g.cur2?.trim();
    if (!hasDecimals && !cur && !allowBare) continue;
    if (!hasDecimals && !cur && allowBare && /^\d{9,}$/.test(g.num)) continue;
    let n = g.num.replace(/,/g, '');
    let value = Math.round(parseFloat(n) * 100);
    if (Number.isNaN(value)) continue;
    let negative = false;
    const post = (g.post || '').trim();
    if (g.pre && /[-−–]/.test(g.pre)) negative = true;
    if (g.pre2) negative = true;
    if (g.pre === '(' && post === ')') negative = true;
    if (/^[-−–]$/.test(post)) negative = true;
    if (/^dr$/i.test(post)) negative = true;
    const credit = /^cr$/i.test(post);
    const explicitSign = negative || /^\+$/.test(g.pre || '') || credit || post !== '';
    if (g.pre === '(' && post !== ')') { // an unmatched "(" is just punctuation
      /* leave sign as parsed from other markers */
    }
    const lead = m[0].length - m[0].trimStart().length; // regex may swallow leading spaces; report the real start
    out.push({
      pence: negative ? -value : value, abs: value, index: m.index + lead, length: m[0].trim().length, raw: m[0].trim(),
      currency: CURRENCY_CODE[cur] || null, hasDecimals, explicitSign, credit, debit: /^dr$/i.test(post),
    });
  }
  return out;
}

/** Replace date matches with spaces so the amount scanner cannot trip over them. */
export function maskRanges(text, ranges) {
  let out = text.split('');
  for (const r of ranges) for (let i = r.index; i < r.index + r.length; i++) out[i] = ' ';
  return out.join('');
}

export function cleanDescription(s) {
  return String(s)
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–—:,.|/\\*]+|[\s\-–—:,.|/\\*]+$/g, '')
    .trim();
}

export const money = (pence) => (pence == null ? '' : `£${(Math.abs(pence) / 100).toFixed(2)}`);
