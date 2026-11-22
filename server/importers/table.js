// Tabular imports (CSV / TSV / XLSX): find the header row wherever it is, map columns by name
// (or by content when there is no header), and turn rows into transactions.

import { findDates, parseAmount, parseDate, cleanDescription } from './parse.js';
import { resolveSigns } from './extract.js';

// ---------------------------------------------------------------- CSV parsing

/** RFC-4180 style parser with delimiter sniffing. Returns an array of string arrays. */
export function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const delim = sniffDelimiter(src);
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

function sniffDelimiter(src) {
  const sample = src.split('\n').slice(0, 15).filter((l) => l.trim());
  let best = ',', bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = sample.map((l) => { let n = 0, q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === d && !q) n++; } return n; });
    const nonZero = counts.filter((c) => c > 0);
    if (!nonZero.length) continue;
    const mode = nonZero.sort((a, b) => a - b)[Math.floor(nonZero.length / 2)];
    const consistent = counts.filter((c) => c === mode).length;
    const score = consistent * 10 + mode;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

// ---------------------------------------------------------------- column mapping

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const SYN = {
  date: ['date', 'transactiondate', 'postingdate', 'bookingdate', 'completeddate', 'starteddate', 'valuedate', 'transdate', 'dateoftransaction', 'posteddate', 'processeddate', 'datetime', 'timestamp', 'effectivedate'],
  desc: ['name', 'payee', 'counterparty', 'counterpartyname', 'merchant', 'beneficiary', 'description', 'transactiondescription', 'details', 'transactiondetails', 'narrative', 'particulars', 'memo', 'reference', 'paymentreference', 'notes', 'detail', 'text', 'title'],
  amount: ['amount', 'transactionamount', 'amountgbp', 'value', 'amountinpounds', 'net', 'netamount', 'gross', 'total'],
  debit: ['debit', 'debitamount', 'paidout', 'moneyout', 'withdrawals', 'withdrawal', 'out', 'paymentsout', 'amountdebit', 'debits', 'moneyoutgbp', 'paidoutgbp'],
  credit: ['credit', 'creditamount', 'paidin', 'moneyin', 'deposits', 'deposit', 'in', 'paymentsin', 'amountcredit', 'credits', 'moneyingbp', 'paidingbp', 'receipts'],
  balance: ['balance', 'runningbalance', 'balancegbp', 'accountbalance', 'closingbalance'],
  type: ['type', 'transactiontype', 'drcr', 'debitcredit', 'crdr', 'creditdebit', 'indicator', 'direction'],
  currency: ['currency', 'ccy'],
};
const TYPE_DEBIT = new Set(['dr', 'debit', 'd', 'out', 'moneyout', 'paidout', 'withdrawal', 'payment', 'dd', 'debitcard']);
const TYPE_CREDIT = new Set(['cr', 'credit', 'c', 'in', 'moneyin', 'paidin', 'deposit', 'receipt']);

function headerScore(cells) {
  const roles = new Set();
  for (const c of cells) {
    const n = norm(c);
    if (!n) continue;
    for (const [role, list] of Object.entries(SYN)) if (list.includes(n)) roles.add(role);
  }
  const money = roles.has('amount') || roles.has('debit') || roles.has('credit');
  return { roles, ok: roles.size >= 2 && money && (roles.has('date') || roles.has('desc')) };
}

function mapColumns(cells) {
  const idx = { desc: [] };
  const taken = new Set();
  const normed = cells.map(norm);
  for (const role of ['date', 'amount', 'debit', 'credit', 'balance', 'type', 'currency']) {
    for (const syn of SYN[role]) { // priority = order in the synonym list
      const i = normed.findIndex((n, k) => n === syn && !taken.has(k));
      if (i >= 0) { idx[role] = i; taken.add(i); break; }
    }
  }
  for (const syn of SYN.desc) {
    const i = normed.findIndex((n, k) => n === syn && !taken.has(k));
    if (i >= 0 && idx.desc.length < 3) { idx.desc.push(i); taken.add(i); }
  }
  return idx;
}

/** Guess column roles from the data itself when there is no header row. */
function inferColumns(rows) {
  const width = Math.max(...rows.map((r) => r.length));
  const cell = (r, c) => String(r[c] instanceof Date ? 'date' : r[c] ?? '').trim();
  // 1. the date column is the one that parses as a date most often
  let dateCol = null, bestRatio = 0;
  for (let c = 0; c < width; c++) {
    const vals = rows.slice(0, 80).map((r) => (r[c] instanceof Date ? 'x' : cell(r, c))).filter(Boolean);
    const ok = rows.slice(0, 80).filter((r) => r[c] instanceof Date || parseDate(cell(r, c))).length;
    const ratio = vals.length ? ok / Math.max(vals.length, 1) : 0;
    if (ratio > bestRatio && ratio >= 0.5 && ok >= 1) { bestRatio = ratio; dateCol = c; }
  }
  if (dateCol == null) return null;
  // 2. judge the other columns only on rows that really are transactions (have a date)
  const data = rows.filter((r) => r[dateCol] instanceof Date || parseDate(cell(r, dateCol))).slice(0, 80);
  const stats = [];
  for (let c = 0; c < width; c++) {
    if (c === dateCol) continue;
    const vals = data.map((r) => cell(r, c)).filter(Boolean);
    const n = vals.length || 1;
    const nums = vals.filter((v) => /^[-+(£$€]?\s*[\d,]+(\.\d+)?\)?\s*(?:CR|DR)?$/i.test(v) && /\d/.test(v)).length / n;
    const avgLen = vals.reduce((a, v) => a + v.length, 0) / n;
    stats.push({ c, nums, avgLen, filled: vals.length / (data.length || 1) });
  }
  const numCols = stats.filter((s) => s.nums > 0.6 && s.filled > 0.2);
  const descCol = stats.filter((s) => s.nums < 0.3 && s.filled > 0.3).sort((a, b) => b.avgLen - a.avgLen)[0]?.c;
  if (!numCols.length) return null;
  const idx = { date: dateCol, desc: descCol != null ? [descCol] : [] };
  if (numCols.length === 1) idx.amount = numCols[0].c;
  else if (numCols.length === 2) { idx.amount = numCols[0].c; idx.balance = numCols[1].c; }
  else { idx.debit = numCols[0].c; idx.credit = numCols[1].c; idx.balance = numCols[numCols.length - 1].c; }
  return idx;
}

const cellStr = (v) => {
  if (v == null) return '';
  if (v instanceof Date) return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
  return String(v).trim();
};

function detectDateOrder(rows, dateCol) {
  let first13 = false, second13 = false;
  for (const r of rows.slice(0, 400)) {
    const m = cellStr(r[dateCol]).match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-]\d{2,4}/);
    if (!m) continue;
    if (+m[1] > 12) first13 = true;
    if (+m[2] > 12) second13 = true;
  }
  return second13 && !first13 ? 'mdy' : 'dmy';
}

/**
 * rows: array of arrays (strings, numbers or Dates).
 * Returns { items, warnings, meta }.
 */
export function tableToItems(rows, ctx = {}) {
  const warnings = [];
  if (!rows.length) return { items: [], warnings: ['The file is empty.'], meta: {} };

  let headerAt = -1, best = null;
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const s = headerScore(rows[i].map(cellStr));
    if (s.ok && (!best || s.roles.size > best.roles.size)) { best = s; headerAt = i; if (s.roles.size >= 4) break; }
  }
  let idx, body;
  if (headerAt >= 0) { idx = mapColumns(rows[headerAt].map(cellStr)); body = rows.slice(headerAt + 1); }
  else {
    idx = inferColumns(rows);
    body = rows;
    if (!idx) return { items: [], warnings: ['Could not work out which columns hold the date and amount. Add a header row, or use "paste text" instead.'], meta: {} };
    warnings.push('No header row found – columns were guessed from the data. Please check the preview.');
  }

  const order = ctx.order || (idx.date != null ? detectDateOrder(body, idx.date) : 'dmy');
  const items = [];
  let skipped = 0;
  for (const r of body) {
    const get = (i) => (i == null ? '' : cellStr(r[i]));
    const dateStr = get(idx.date);
    const date = parseDate(dateStr, { order }) || null;
    const descParts = [];
    for (const i of idx.desc) { const v = get(i); if (v && !descParts.some((p) => p.toLowerCase() === v.toLowerCase())) descParts.push(v); }
    const description = cleanDescription(descParts.join(' – '));

    let amount = null, abs = null, sign = null, source = null;
    const rawAmt = idx.amount != null ? r[idx.amount] : null;
    const debit = idx.debit != null ? parseAmount(typeof r[idx.debit] === 'number' ? r[idx.debit] : get(idx.debit)) : null;
    const credit = idx.credit != null ? parseAmount(typeof r[idx.credit] === 'number' ? r[idx.credit] : get(idx.credit)) : null;
    if ((debit || credit) && !(debit && credit)) {
      if (credit) { abs = Math.abs(credit); sign = 1; } else { abs = Math.abs(debit); sign = -1; }
      source = 'column';
    } else if (debit && credit) { amount = Math.abs(credit) - Math.abs(debit); abs = Math.abs(amount); sign = amount < 0 ? -1 : 1; source = 'column'; }
    else if (rawAmt != null && String(rawAmt).trim() !== '') {
      const p = parseAmount(typeof rawAmt === 'number' ? rawAmt : cellStr(rawAmt));
      if (p != null) {
        abs = Math.abs(p);
        const t = norm(get(idx.type));
        if (idx.type != null && TYPE_DEBIT.has(t)) { sign = -1; source = 'type'; }
        else if (idx.type != null && TYPE_CREDIT.has(t)) { sign = 1; source = 'type'; }
        else if (p < 0 || /-|\(|dr\b/i.test(cellStr(rawAmt))) { sign = -1; source = 'explicit'; }
        else if (p > 0 && body.some((x) => { const q = parseAmount(typeof x[idx.amount] === 'number' ? x[idx.amount] : cellStr(x[idx.amount])); return q != null && q < 0; })) { sign = 1; source = 'explicit'; }
      }
    }
    if (abs == null) { if (dateStr || description) skipped++; continue; }
    if (!date && !description) { skipped++; continue; }
    const balStr = idx.balance != null ? (typeof r[idx.balance] === 'number' ? r[idx.balance] : get(idx.balance)) : '';
    const balance = balStr !== '' ? parseAmount(balStr) : null;
    const flags = [];
    if (!date) flags.push('no_date');
    const cur = idx.currency != null ? get(idx.currency).toUpperCase() : '';
    if (cur && cur !== 'GBP' && cur !== '£') flags.push(`foreign_currency:${cur}`);
    items.push({
      date, description: description || '(no description)', balance, flags, raw: r.map(cellStr).join(' | ').slice(0, 300), confidence: 0.95, kind: 'row',
      _abs: abs, _sign: sign, _signSource: source,
    });
  }
  if (skipped) warnings.push(`${skipped} row(s) without a usable date/amount were skipped (headers, totals or blank lines).`);
  resolveSigns(items, null, ctx.hints);
  if (items.length && items.every((i) => i.flags.includes('direction_guessed')) && idx.amount != null && idx.debit == null) {
    warnings.push('Every amount in this file is positive and there is no Debit/Credit or Type column, so money in/out had to be guessed. Check the Direction on each row before recording.');
  }
  for (const it of items) {
    if (it.flags.includes('no_date')) it.confidence = Math.min(it.confidence, 0.5);
    if (it._signSource === undefined) { /* resolved in resolveSigns */ }
  }
  return { items, warnings, meta: { headerRow: headerAt, columns: idx, order } };
}

export { findDates };
