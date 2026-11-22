// Free-form extraction: turns lines of text (from a PDF, OCR, pasted text, Word, e-mail...) into
// candidate transactions, wherever the dates and amounts happen to be.
//
// Three strategies, picked automatically:
//   statement – many dated rows (bank/card statements, ledgers). Uses column headers where there
//               are any, and running-balance arithmetic to decide money-in vs money-out.
//   document  – one invoice or receipt: finds vendor, dates, net/VAT/total, invoice number...
//   notes     – loose sentences like "paid £45 to Screwfix on 3 March for tools".

import { findDates, findAmounts, maskRanges, cleanDescription } from './parse.js';

// ---------------------------------------------------------------- line model

/**
 * Line model used throughout:
 *   text        trimmed text
 *   raw         untrimmed text – all character offsets (dates, amounts, cells) refer to this string
 *   cells       [{text, start, end, x0, x1}] – start/end are offsets into raw; x0/x1 are layout positions
 *   positional  true when x0/x1 are real page coordinates (PDF); false when they are just char offsets
 */
export function linesFromText(text) {
  return String(text).replace(/\r/g, '').split('\n').map((raw0, i) => {
    const raw = raw0.replace(/\t/g, '  ');
    const cells = [];
    const re = /\S+(?: \S+)*/g; // runs of words separated by single spaces = one cell
    let m;
    while ((m = re.exec(raw))) cells.push({ text: m[0], start: m.index, end: m.index + m[0].length, x0: m.index, x1: m.index + m[0].length });
    return { text: raw.trim(), raw, cells, positional: false, page: 1, n: i };
  });
}

// ---------------------------------------------------------------- vocab

const HEADER_VOCAB = [
  ['date', /^(?:transaction |trans\.? |posting |booking |value |entry )?date$/i],
  ['desc', /^(?:description|details|transaction(?:s| details| description)?|narrative|particulars|payee|memo|reference|counter ?party)$/i],
  ['out', /^(?:paid out|money out|debits?|withdrawals?|payments? out|out|debit amount|amount out|dr)(?: \(?£\)?)?$/i],
  ['in', /^(?:paid in|money in|credits?|deposits?|payments? in|in|credit amount|amount in|receipts?|cr)(?: \(?£\)?)?$/i],
  ['amount', /^(?:amount|value|amount \(?gbp\)?|net|gross)(?: \(?£\)?)?$/i],
  ['balance', /^(?:running )?balance(?: \(?£\)?)?$/i],
];

const HEADER_PHRASES = /\b(transaction date|posting date|booking date|value date|date|description|details|transaction details|narrative|particulars|paid out|money out|withdrawals?|debits?|payments out|paid in|money in|deposits?|credits?|payments in|amount|running balance|balance)\b/gi;

const SKIP_LINE = /(balance (?:brought|carried) (?:forward|fwd)|b\/f|c\/f|opening balance|closing balance|start balance|end balance|previous balance|new balance|statement (?:date|period|number)|page \d+ of \d+|sort code|account (?:number|no)|iban|bic|swift|overdraft limit|total (?:paid|money|credits?|debits?|in|out)\b|^total\b|your account summary|interest rate|credit limit|available balance|minimum payment)/i;
const BALANCE_LINE = /(balance (?:brought|carried) (?:forward|fwd)|opening balance|start balance|previous balance|b\/f)/i;

const IN_CUES = /\b(received|deposit|credit(?:ed)?|refund|interest paid|salary|wages from|payment from|from|inbound|bacs credit|faster payment(?:s)? in|transfer in|dividend|invoice paid|income|sale|sales|paid by|customer)\b/i;
const OUT_CUES = /\b(payment|purchase|card|debit|direct debit|d\/d|\bdd\b|standing order|\bs\/o\b|\bso\b|pos|atm|cash withdrawal|withdrawal|fee|charge|to|transfer out|bought|paid|spent|subscription|bill|contactless|visa|mastercard)\b/i;

// ---------------------------------------------------------------- helpers

function findPeriod(lines, order) {
  for (const l of lines.slice(0, 60)) {
    if (!/(statement|period|from|between)/i.test(l.text)) continue;
    const ds = findDates(l.text, { order });
    if (ds.length >= 2 && ds[1].iso > ds[0].iso) return { start: ds[0].iso, end: ds[1].iso };
  }
  return null;
}

function guessYear(lines, order) {
  const counts = {};
  for (const l of lines) for (const d of findDates(l.text, { order })) counts[d.iso.slice(0, 4)] = (counts[d.iso.slice(0, 4)] || 0) + 1;
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (best) return Number(best[0]);
  const m = lines.slice(0, 40).map((l) => l.text).join(' ').match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

/** Detect a column-header line and return the column roles with x-positions. */
function detectHeader(line) {
  const cols = [];
  for (const c of line.cells) {
    const t = c.text.replace(/[:*]/g, '').trim();
    const hit = HEADER_VOCAB.find(([, re]) => re.test(t));
    if (hit) cols.push({ role: hit[0], x0: c.x0, x1: c.x1 });
  }
  if (cols.length < 2) {
    // single-spaced text such as "Date Description Paid out Paid in Balance": scan phrases
    const found = [];
    let m;
    HEADER_PHRASES.lastIndex = 0;
    while ((m = HEADER_PHRASES.exec(line.raw))) {
      const role = HEADER_VOCAB.find(([, re]) => re.test(m[0].trim()))?.[0];
      if (role) found.push({ role, x0: m.index, x1: m.index + m[0].length });
    }
    if (found.length > cols.length) return finishHeader(found);
  }
  return finishHeader(cols);
}
function finishHeader(cols) {
  const roles = new Set(cols.map((c) => c.role));
  const money = ['out', 'in', 'amount'].filter((r) => roles.has(r));
  if (cols.length >= 3 && roles.has('date') && money.length) return { cols, roles };
  if (cols.length >= 2 && money.length && (roles.has('desc') || roles.has('balance'))) return { cols, roles };
  return null;
}

function roleForX(header, x0, x1) {
  let best = null, bestD = Infinity;
  for (const c of header.cols) {
    if (!['out', 'in', 'amount', 'balance'].includes(c.role)) continue;
    const d = Math.min(Math.abs(x1 - c.x1), Math.abs((x0 + x1) / 2 - (c.x0 + c.x1) / 2), Math.abs(x0 - c.x0));
    if (d < bestD) { bestD = d; best = c.role; }
  }
  return best;
}

const stripAliasNoise = (s) => s.toLowerCase().replace(/\b(ltd|limited|llp|plc|inc|llc|co|company|t\/a|trading as)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export function aliasesFrom(profile = {}) {
  const raw = [profile.name, profile.tradingName, ...(String(profile.aliases || '').split(/[,;\n]/))];
  return raw.map((a) => stripAliasNoise(a || '')).filter((a) => a.length >= 3);
}
const mentionsAlias = (text, aliases) => { const t = stripAliasNoise(text); return aliases.some((a) => t.includes(a)); };

// ---------------------------------------------------------------- statement strategy

function extractStatement(lines, ctx) {
  const order = ctx.order || 'dmy';
  const period = findPeriod(lines, order);
  const defaultYear = guessYear(lines, order);
  const dateOpts = { order, period, defaultYear };
  const items = [];
  let header = null;
  let opening = null;
  let prev = null;
  let pending = null;
  let lastWasRow = false;

  for (const line of lines) {
    const t = line.text;
    const text = line.raw;
    if (!t) { lastWasRow = false; continue; }
    const hdr = detectHeader(line);
    if (hdr) { header = hdr; lastWasRow = false; continue; }

    const dts = findDates(text, dateOpts);
    const amounts = findAmounts(maskRanges(text, dts)).filter((a) => a.hasDecimals || a.currency);

    if (BALANCE_LINE.test(t) && amounts.length) { opening = amounts[amounts.length - 1].pence; lastWasRow = false; continue; }
    if (SKIP_LINE.test(t) && !dts.length) { lastWasRow = false; continue; }

    const hasDate = dts.length > 0;
    const spans = [...dts, ...amounts].map((x) => ({ index: x.index, length: x.length }));
    const description = cleanDescription(maskRanges(text, spans).replace(/\s+/g, ' ')).replace(/\b(?:paid out|paid in|balance)\s*$/i, '').trim();
    // A line with a date and a description but no amounts: the amounts are on the next line.
    if (hasDate && !amounts.length && /[A-Za-z]{2}/.test(description)) {
      pending = { date: dts[0].iso, description, inferred: !!dts[0].inferredYear };
      lastWasRow = false;
      continue;
    }
    // A row that shares the previous row's date (common in Lloyds/Halifax-style statements).
    const carry = !hasDate && amounts.length > 0 && (pending || (lastWasRow && prev)) && (description.length >= 2 || pending);

    if ((hasDate && amounts.length) || carry) {
      const fromPending = !hasDate && pending;
      const rowDate = hasDate ? dts[0].iso : fromPending ? pending.date : prev.date;
      const rowDesc = fromPending ? cleanDescription(`${pending.description} ${description}`) : description;
      const item = buildRow({ line, amounts, header, date: rowDate, description: rowDesc, inferred: hasDate ? !!dts[0].inferredYear : !!pending?.inferred, carry: carry && !fromPending });
      items.push(item);
      prev = item;
      pending = null;
      lastWasRow = true;
    } else if (!hasDate && !amounts.length && lastWasRow && prev && /[A-Za-z]/.test(t) && t.length < 80 && !/^(page|continued|statement)/i.test(t)) {
      // wrapped description line belonging to the previous row
      prev.description = cleanDescription(`${prev.description} ${t}`).slice(0, 200);
      prev.raw += ` ${t}`;
    } else {
      lastWasRow = false;
    }
  }
  resolveSigns(items, opening, ctx.hints);
  return items;
}

function buildRow({ line, amounts, header, date, description, inferred, carry }) {
  const item = {
    date, description, amount: null, balance: null, flags: [], raw: line.text, confidence: 0.9, kind: 'row',
    _abs: null, _sign: null, _signSource: null, page: line.page,
  };
  if (inferred) { item.flags.push('year_inferred'); item.confidence -= 0.05; }
  if (carry) { item.flags.push('date_carried'); item.confidence -= 0.1; }
  const foreign = amounts.find((a) => a.currency && a.currency !== 'GBP');
  if (foreign) { item.flags.push(`foreign_currency:${foreign.currency}`); item.confidence -= 0.2; }

  // Where an amount sits horizontally: real page x for PDFs, character offset for plain text.
  const posOf = (a) => {
    if (line.positional) {
      const c = line.cells.find((c) => a.index >= c.start && a.index < c.end);
      if (c) return [c.x0, c.x1];
    }
    return [a.index, a.index + a.length];
  };

  if (header) {
    const byRole = {};
    for (const a of amounts) {
      const [x0, x1] = posOf(a);
      const role = roleForX(header, x0, x1);
      if (role) (byRole[role] ||= []).push(a);
    }
    if (byRole.balance?.[0]) item.balance = byRole.balance[0].pence;
    const out = byRole.out?.[0], inn = byRole.in?.[0], amt = byRole.amount?.[0];
    if (out && !inn) { item._abs = Math.abs(out.pence); item._sign = -1; item._signSource = 'column'; }
    else if (inn && !out) { item._abs = Math.abs(inn.pence); item._sign = 1; item._signSource = 'column'; }
    else if (amt) { item._abs = Math.abs(amt.pence); item._sign = amt.explicitSign ? (amt.pence < 0 ? -1 : 1) : null; item._signSource = amt.explicitSign ? 'explicit' : null; }
    if (item._abs != null) return item;
  }

  // No usable header: infer from how many amounts the row has.
  let main = amounts[0];
  if (amounts.length >= 2) item.balance = amounts[amounts.length - 1].pence;
  item._abs = Math.abs(main.pence);
  if (main.credit) { item._sign = 1; item._signSource = 'explicit'; }
  else if (main.explicitSign) { item._sign = main.pence < 0 || main.debit ? -1 : 1; item._signSource = 'explicit'; }
  if (amounts.length > 2) item.flags.push('many_amounts');
  return item;
}

/** Decide money-in / money-out for rows whose sign is unknown, using balances then wording. */
export function resolveSigns(items, opening, hints = null) {
  const withBal = items.filter((i) => i.balance != null);
  if (withBal.length >= 2 || (withBal.length && opening != null)) {
    const pairScore = (asc) => {
      let s = 0;
      for (let i = 1; i < items.length; i++) {
        const a = items[asc ? i - 1 : i], b = items[asc ? i : i - 1];
        if (a.balance == null || b.balance == null) continue;
        if (Math.abs(b.balance - a.balance) === (asc ? items[i]._abs : items[i - 1]._abs)) s++;
      }
      return s;
    };
    const asc = pairScore(true), desc = pairScore(false);
    const ascending = asc >= desc;
    if (Math.max(asc, desc) > 0) {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it._sign != null) continue;
        let delta = null;
        if (ascending) {
          const before = i === 0 ? opening : items[i - 1].balance;
          if (before != null && it.balance != null) delta = it.balance - before;
        } else {
          const after = items[i + 1]?.balance;
          if (after != null && it.balance != null) delta = it.balance - after;
          else if (i === items.length - 1 && opening != null && it.balance != null) delta = it.balance - opening;
        }
        if (delta != null && Math.abs(delta) === it._abs) { it._sign = delta < 0 ? -1 : 1; it._signSource = 'balance'; }
      }
    }
  }
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const hit = (list, d) => (list || []).some((w) => w && d.includes(w));
  for (const it of items) {
    if (it._sign == null && hints) {
      // The app knows your customers, suppliers and open invoice numbers.
      const d = norm(it.description);
      if (hit(hints.inWords, d) && !hit(hints.outWords, d)) { it._sign = 1; it._signSource = 'known'; it.confidence = Math.min(it.confidence, 0.85); }
      else if (hit(hints.outWords, d) && !hit(hints.inWords, d)) { it._sign = -1; it._signSource = 'known'; it.confidence = Math.min(it.confidence, 0.85); }
    }
    if (it._sign == null) {
      const inScore = IN_CUES.test(it.description) ? 1 : 0;
      const outScore = OUT_CUES.test(it.description) ? 1 : 0;
      if (inScore > outScore) { it._sign = 1; it._signSource = 'wording'; it.confidence = Math.min(it.confidence, 0.6); it.flags.push('direction_guessed'); }
      else if (outScore > inScore) { it._sign = -1; it._signSource = 'wording'; it.confidence = Math.min(it.confidence, 0.65); it.flags.push('direction_guessed'); }
      else { it._sign = -1; it._signSource = 'default'; it.confidence = Math.min(it.confidence, 0.4); it.flags.push('direction_guessed'); }
    } else if (it._signSource === 'column' || it._signSource === 'balance') it.confidence = Math.min(0.98, it.confidence + 0.05);
    it.amount = it._sign * it._abs;
    if (!it.description) { it.description = '(no description)'; it.confidence -= 0.2; it.flags.push('no_description'); }
    it.confidence = Math.max(0.05, Math.round(it.confidence * 100) / 100);
    delete it._abs; delete it._sign; delete it._signSource;
  }
}

// ---------------------------------------------------------------- notes strategy

function extractNotes(lines, ctx) {
  const order = ctx.order || 'dmy';
  const dateOpts = { order, defaultYear: guessYear(lines, order) || ctx.defaultYear };
  const items = [];
  for (const line of lines) {
    const t = line.raw;
    if (!t.trim()) continue;
    const dts = findDates(t, dateOpts);
    const amounts = findAmounts(maskRanges(t, dts)).filter((a) => a.hasDecimals || a.currency);
    if (!amounts.length) continue;
    const spans = [...dts, ...amounts].map((x) => ({ index: x.index, length: x.length }));
    const description = cleanDescription(maskRanges(t, spans).replace(/\b(?:on|dated|for|of)\s*$/i, '').replace(/\s+/g, ' '));
    const a = amounts[0];
    const out = /\b(paid to|paid for|paid|bought|purchase[d]?|spent|cost|fee|bill|subscription|expense)\b/i.test(t);
    const inStrong = /\b(received|income|invoice paid|earned|sold|sale|payment from|paid by|client paid|customer paid|refund)\b/i.test(t);
    const outStrong = /\b(paid to|paid for|bought|purchase[d]?|spent|subscription|expense)\b/i.test(t);
    const inn = inStrong && (!outStrong || /\b(received|from)\b/i.test(t)) ;
    const flags = [];
    let sign = -1;
    if (a.explicitSign) sign = a.pence < 0 ? -1 : 1; else if (inn) sign = 1; else sign = -1;
    let confidence = 0.6;
    if (!dts.length) { flags.push('no_date'); confidence -= 0.2; }
    if (!a.explicitSign && !(inn || out || inStrong)) { flags.push('direction_guessed'); confidence -= 0.15; }
    items.push({
      date: dts[0]?.iso || null, description: description || '(no description)', amount: sign * Math.abs(a.pence), balance: null,
      flags, raw: t.trim(), confidence: Math.max(0.1, confidence), kind: 'note',
    });
  }
  return items;
}

// ---------------------------------------------------------------- document strategy

const TOTAL_LABELS = [
  [/\b(?:grand total|total (?:amount )?(?:due|payable)|amount (?:due|payable)|balance due|total due|please pay|total to pay)\b/i, 100, 'total'],
  [/\b(?:invoice total|total (?:gbp|inc(?:l|luding)?\.? (?:vat|tax)|incl\.? vat)|total \(inc)/i, 90, 'total'],
  [/\b(?:order total|total paid|amount paid|total charged|card payment|amount charged|total)\b/i, 70, 'total'],
];
const SUBTOTAL_LABEL = /\b(?:sub-?\s?total|net (?:amount|total|value)?|total (?:ex|excl|excluding)\.? (?:vat|tax)|(?:amount|value|goods) (?:ex|excl|excluding)\.? (?:vat|tax)|total net|net price)\b/i;
const VAT_LABEL = /\b(?:vat|v\.a\.t\.?|sales tax|tax)\b/i;
const VAT_NOT_AMOUNT = /\b(?:vat|tax)\s*(?:reg(?:istration)?|number|no\.?|#|id|ref)\b|\bvat\s*:?\s*gb/i;

function labelOf(text, amount) { return text.slice(0, amount.index).trim() || text.replace(amount.raw, '').trim(); }

function extractDocument(lines, ctx) {
  const order = ctx.order || 'dmy';
  const fullText = lines.map((l) => l.text).join('\n');
  const aliases = aliasesFrom(ctx.profile);

  // ---- money
  let gross = null, grossScore = -1, net = null, vat = null, vatRate = null;
  const allAmounts = [];
  let paid = /\b(?:paid in full|payment received|thank you for your payment|paid by|amount paid|receipt)\b/i.test(fullText);
  lines.forEach((l, li) => {
    const text = l.raw || l.text;
    const dts = findDates(text, { order });
    const ams = findAmounts(maskRanges(text, dts)).filter((a) => a.hasDecimals || a.currency);
    ams.forEach((a) => allAmounts.push({ ...a, li }));
    if (!ams.length) return;
    const last = ams[ams.length - 1];
    const label = labelOf(text, ams[0]) || text;
    const labelFull = text;
    // percentage on the line, e.g. "VAT @ 20%" or "20%   100.00  20.00  120.00"
    const pct = text.match(/(\d{1,2}(?:\.\d+)?)\s?%/);
    if (/balance due/i.test(labelFull) && ams.length && ams[ams.length - 1].abs === 0) paid = true;
    // VAT summary table row: "20%   net   vat   gross" (label may be on an earlier line)
    if (pct && ams.length >= 3 && !/total/i.test(label)) {
      const [n, v, g] = ams.slice(-3);
      if (Math.abs(Math.round(n.abs * (Number(pct[1]) / 100)) - v.abs) <= 2 && Math.abs(n.abs + v.abs - g.abs) <= 2) {
        net = (net || 0) + n.abs; vat = (vat || 0) + v.abs; vatRate = Number(pct[1]) / 100;
        return;
      }
    }
    if (VAT_LABEL.test(label) && !VAT_NOT_AMOUNT.test(text) && !SUBTOTAL_LABEL.test(label) && !/total/i.test(label)) {
      if (false) { /* handled above */ } else if (pct && ams.length === 2 && ams[0].abs > ams[1].abs) { // "VAT 20%  100.00  20.00"
        vat = (vat || 0) + ams[1].abs; vatRate = Number(pct[1]) / 100;
      } else { vat = (vat || 0) + last.abs; if (pct) vatRate = Number(pct[1]) / 100; }
      return;
    }
    if (SUBTOTAL_LABEL.test(label)) { net = net ?? last.abs; return; }
    for (const [re, score] of TOTAL_LABELS) {
      if (re.test(label) || (re.test(labelFull) && !SUBTOTAL_LABEL.test(labelFull))) {
        if (score >= grossScore) { gross = last.abs; grossScore = score; }
        break;
      }
    }
  });

  const flags = [];
  let confidence = 0.8;
  if (gross == null && net != null && vat != null) { gross = net + vat; }
  if (gross == null && allAmounts.length) {
    gross = Math.max(...allAmounts.map((a) => a.abs));
    flags.push('total_guessed'); confidence -= 0.3;
  }
  if (gross != null && net != null && vat != null && Math.abs(net + vat - gross) > 2) {
    flags.push('totals_mismatch'); confidence -= 0.15;
    net = gross - vat;
  }
  if (gross != null && vat == null && net != null && gross > net) vat = gross - net;
  if (gross != null && net == null && vat != null) net = gross - vat;
  if (gross != null && vat == null && net == null && vatRate && /\b(?:inc(?:l|luding)?\.?|includes?) (?:vat|tax)\b/i.test(fullText)) {
    vat = Math.round((gross * vatRate) / (1 + vatRate)); net = gross - vat;
  }
  if (gross == null) return null;

  // ---- dates
  const labelled = [];
  lines.forEach((l, li) => {
    const text = l.raw;
    for (const d of findDates(text, { order })) {
      const before = (lines[li - 1]?.text || '') + ' ' + text.slice(Math.max(0, d.index - 40), d.index);
      labelled.push({ ...d, before: before.toLowerCase(), li });
    }
  });
  const issue = labelled.find((d) => /(invoice date|date of issue|issue date|issued|tax point|date of invoice|order date|purchase date|transaction date|receipt date|\bdate\b)/.test(d.before) && !/(due|pay by|payable by|period|birth)/.test(d.before.slice(-30)))
    || labelled.find((d) => !/(due|pay by|payable|period|birth|expiry)/.test(d.before.slice(-30)))
    || labelled[0];
  const due = labelled.find((d) => /(due date|payment due|due on|pay by|payable by|due)/.test(d.before.slice(-30)) && d.iso !== issue?.iso);

  // ---- parties
  const kwLine = /^(?:tax )?(?:invoice|receipt|credit note|statement|quote|quotation|proforma|order confirmation|purchase order|page|date|vat|tel|phone|email|e-mail|www|http|company|reg(?:istered)?|bill|ship|deliver|from|to|sold|invoice no|total|subtotal|description|qty|price|amount)\b/i;
  const company = /\b(?:ltd|limited|llp|plc|inc|llc|co\.?|company|services|solutions|group|partners|& sons|stores|supermarkets?|hotel|cafe|café|restaurant|garage|motors|insurance|energy|telecom|software|systems|studios?)\b/i;
  const clean = (s) => cleanDescription(String(s).replace(/^(?:from|supplier|seller|sold by|vendor|merchant|issued by|billed from)\s*[:\-]?\s*/i, ''));
  const topLines = lines.slice(0, 14).filter((l) => l.text);
  let vendor = null;
  const labelledVendor = lines.findIndex((l) => /^(?:from|supplier|seller|sold by|vendor|merchant|issued by|billed from)\s*[:\-]/i.test(l.text));
  if (labelledVendor >= 0) vendor = clean(lines[labelledVendor].text) || clean(lines[labelledVendor + 1]?.text || '');
  if (!vendor) {
    vendor = clean((topLines.find((l) => company.test(l.text) && !kwLine.test(l.text) && !/\d{3,}/.test(l.text.replace(/[^\d]/g, '').slice(0, 3) ? '' : '')) || {}).text || '')
      || clean((topLines.find((l) => /[A-Za-z]{3}/.test(l.text) && !kwLine.test(l.text) && !/^\d/.test(l.text) && !/@|www\.|https?:/.test(l.text)) || {}).text || '');
  }
  let customer = null;
  const billIdx = lines.findIndex((l) => /^(?:bill(?:ed)? to|invoice to|invoiced to|customer|client|sold to|to)\s*[:\-]?\s*/i.test(l.text) && !/^to\s*$/i.test(l.text));
  if (billIdx >= 0) {
    const same = lines[billIdx].text.replace(/^(?:bill(?:ed)? to|invoice to|invoiced to|customer|client|sold to|to)\s*[:\-]?\s*/i, '');
    customer = clean(same) || clean(lines[billIdx + 1]?.text || '');
  }
  const billBlock = billIdx >= 0 ? lines.slice(billIdx, billIdx + 5).map((l) => l.text).join(' ') : '';
  const headBlock = lines.slice(0, 8).map((l) => l.text).join(' ');
  let direction = null, dirConf = 0.4;
  if (aliases.length && billBlock && mentionsAlias(billBlock, aliases)) { direction = 'out'; dirConf = 0.95; }
  else if (aliases.length && mentionsAlias(headBlock, aliases)) { direction = 'in'; dirConf = 0.9; }
  else if (aliases.length && mentionsAlias(fullText, aliases) && /(pay(?:able)? to|remit|bank details)/i.test(fullText)) { direction = 'in'; dirConf = 0.7; }
  else if (/\b(?:receipt|thank you for (?:your )?(?:purchase|order|shopping)|order confirmation|card (?:ending|payment|no)|contactless|visa|mastercard|cashier|till|you paid|payment (?:received|method))\b/i.test(fullText)) { direction = 'out'; dirConf = 0.7; }
  else { direction = 'out'; dirConf = 0.4; flags.push('direction_guessed'); confidence -= 0.1; }

  const invRe = /\b(?:invoice|inv|receipt|order|ref(?:erence)?|document)[ \t]*(?:no\.?|number|num|#|id)?[ \t]*[:#]?[ \t]*(?=[A-Z0-9\-\/]*\d)([A-Z0-9][A-Z0-9\-\/]{2,})/gi;
  const invNo = [...fullText.matchAll(invRe)].map((m) => m[1]).find((s) => !/^(?:date|total|vat)/i.test(s));
  const docType = /credit note/i.test(fullText) ? 'credit_note' : /\breceipt\b/i.test(fullText) && !/invoice/i.test(headBlock) ? 'receipt' : /invoice/i.test(fullText) ? 'invoice' : 'receipt';

  const counterparty = direction === 'in' ? customer : vendor;
  const sign = docType === 'credit_note' ? -1 : 1;
  const amount = (direction === 'in' ? 1 : -1) * sign * gross;
  const foreign = allAmounts.find((a) => a.currency && a.currency !== 'GBP');
  if (foreign) { flags.push(`foreign_currency:${foreign.currency}`); confidence -= 0.25; }
  if (!issue) { flags.push('no_date'); confidence -= 0.2; }
  if (!counterparty) { flags.push('no_counterparty'); confidence -= 0.1; }
  const isUnpaidInvoice = docType === 'invoice' && !paid;
  if (isUnpaidInvoice && direction === 'out') flags.push('unpaid_supplier_invoice');

  const description = [counterparty, docType === 'receipt' ? 'receipt' : docType === 'credit_note' ? 'credit note' : 'invoice', invNo].filter(Boolean).join(' – ');
  return {
    date: issue?.iso || null, dueDate: due?.iso || null, description: description || '(document)',
    amount, balance: null, net: net != null ? net : null, vat: vat != null ? vat : null, vatRate,
    counterparty: counterparty || null, reference: invNo || null, docType, direction, directionConfidence: dirConf, paid,
    flags, raw: lines.slice(0, 6).map((l) => l.text).join(' | ').slice(0, 300), confidence: Math.max(0.1, Math.round(confidence * 100) / 100),
    kind: 'document',
  };
}

// ---------------------------------------------------------------- entry point

/**
 * @param lines  line objects (see linesFromText / pdf.js)
 * @param ctx    { profile, order }
 * @returns { mode, items, warnings }
 */
export function extractFromLines(lines, ctx = {}) {
  const order = ctx.order || 'dmy';
  const text = lines.map((l) => l.text).join('\n');
  if (!text.trim()) return { mode: 'empty', items: [], warnings: ['No readable text was found in this file.'] };

  const stmtScore = (text.match(/\b(?:statement|sort code|account (?:number|no)|balance brought forward|opening balance|closing balance|paid in|paid out|money in|money out|debit|credit|transaction)\b/gi) || []).length;
  const docScore = (text.match(/\b(?:invoice|receipt|tax invoice|sub-?total|grand total|amount due|total due|balance due|vat (?:no|number|reg)|bill to|invoice (?:no|number|date))\b/gi) || []).length;
  const defaultYear = guessYear(lines, order);
  const period = findPeriod(lines, order);
  const rowLike = lines.filter((l) => {
    const ds = findDates(l.raw, { order, defaultYear, period });
    return ds.length && findAmounts(maskRanges(l.raw, ds)).some((a) => a.hasDecimals || a.currency);
  });
  const startsWithDate = rowLike.filter((l) => { const d = findDates(l.text, { order, defaultYear, period })[0]; return d && d.index <= 3; }).length;
  // A statement-style header has a date, balance or paired in/out column. (Invoice line-item tables
  // such as "Description  Qty  Amount" do not, so they are not mistaken for statements.)
  const stmtHeader = lines.map(detectHeader).find((h) => h && (h.roles.has('date') || h.roles.has('balance') || (h.roles.has('in') && h.roles.has('out'))));
  const hasHeader = !!stmtHeader;

  let mode;
  if (hasHeader && !(docScore >= 4 && stmtScore < 2)) mode = 'statement';
  else if (rowLike.length >= 3 && (stmtScore >= 2 || startsWithDate / rowLike.length >= 0.6) && !(docScore >= 4 && stmtScore < 2)) mode = 'statement';
  else if (docScore >= 2 || (rowLike.length <= 2 && /\b(total|vat|amount)\b/i.test(text))) mode = 'document';
  else if (rowLike.length >= 2 && startsWithDate / rowLike.length >= 0.6) mode = 'statement';
  else mode = 'notes';

  const warnings = [];
  let items = [];
  if (mode === 'statement') items = extractStatement(lines, ctx);
  else if (mode === 'document') {
    const doc = extractDocument(lines, ctx);
    if (doc) items = [doc];
    else { items = extractNotes(lines, ctx); mode = 'notes'; }
  } else items = extractNotes(lines, ctx);

  if (!items.length) warnings.push('No transactions could be found in this text. Try the "paste text" option or a CSV export.');
  if (items.some((i) => i.flags.includes('direction_guessed'))) warnings.push('Some rows had no sign or column to show whether money went in or out; the direction was guessed – please check the highlighted rows.');
  return { mode, items, warnings };
}

export { stripAliasNoise, mentionsAlias };
