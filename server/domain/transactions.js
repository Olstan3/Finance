import crypto from 'node:crypto';
import { VAT_RATES } from './taxRates.js';
import { ValidationError } from './invoices.js';
import { isISO, taxYearRange, isTaxYearLabel, addDays, daysBetween } from '../util/dates.js';
import { audit } from '../db.js';

export const normDesc = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function fingerprint({ account_id, date, amount, description, externalId }) {
  return crypto.createHash('sha1').update(`${account_id}|${date}|${amount}|${externalId || ''}|${normDesc(description)}`).digest('hex').slice(0, 20);
}

function check(db, d, { partial = false } = {}) {
  if (!partial || d.date !== undefined) if (!isISO(d.date)) throw new ValidationError('Date must be a valid date', 'date');
  if (!partial || d.amount !== undefined) if (!Number.isInteger(d.amount) || d.amount === 0) throw new ValidationError('Amount must be a non-zero whole number of pence', 'amount');
  if (!partial || d.description !== undefined) if (!String(d.description || '').trim()) throw new ValidationError('Description is required', 'description');
  if (d.account_id !== undefined && !db.get('SELECT 1 AS x FROM accounts WHERE id = ?', d.account_id)) throw new ValidationError('Choose a valid account', 'account_id');
  if (d.category_id && !db.get('SELECT 1 AS x FROM categories WHERE id = ?', d.category_id)) throw new ValidationError('Unknown category', 'category_id');
  if (d.vat_code && !VAT_RATES[d.vat_code]) throw new ValidationError('Unknown VAT code', 'vat_code');
  if (d.business_pct != null && (!Number.isInteger(d.business_pct) || d.business_pct < 0 || d.business_pct > 100)) throw new ValidationError('Business use must be 0–100%', 'business_pct');
  if (d.vat_amount != null && !Number.isInteger(d.vat_amount)) throw new ValidationError('VAT must be whole pence', 'vat_amount');
}

export function createTransaction(db, d) {
  const data = { vat_code: 'N', vat_amount: 0, business_pct: 100, status: 'confirmed', source: 'manual', ...d };
  check(db, data);
  const fp = fingerprint(data);
  const r = db.run(
    `INSERT INTO transactions (account_id, date, description, amount, category_id, contact_id, invoice_id, vat_code, vat_amount, business_pct,
       tag, notes, status, source, confidence, batch_id, document_id, fingerprint, balance, reference)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    data.account_id, data.date, String(data.description).trim(), data.amount, data.category_id || null, data.contact_id || null, data.invoice_id || null,
    data.vat_code, Math.abs(data.vat_amount || 0), data.business_pct, data.tag || null, data.notes || null, data.status, data.source,
    data.confidence ?? null, data.batch_id || null, data.document_id || null, fp, data.balance ?? null, data.reference || null,
  );
  return getTransaction(db, r.id);
}

const SELECT = `
  SELECT t.*, c.name AS category_name, c.kind AS category_kind, ct.name AS contact_name, a.name AS account_name, i.number AS invoice_number,
         d.filename AS document_name
  FROM transactions t
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN contacts ct ON ct.id = t.contact_id
  LEFT JOIN accounts a ON a.id = t.account_id
  LEFT JOIN invoices i ON i.id = t.invoice_id
  LEFT JOIN documents d ON d.id = t.document_id`;

export const getTransaction = (db, id) => db.get(`${SELECT} WHERE t.id = ?`, id);

const EDITABLE = ['date', 'description', 'amount', 'category_id', 'contact_id', 'vat_code', 'vat_amount', 'business_pct', 'tag', 'notes', 'status', 'account_id', 'reference'];

export function updateTransaction(db, id, patch) {
  const cur = db.get('SELECT * FROM transactions WHERE id = ?', id);
  if (!cur) { const e = new Error('Transaction not found'); e.status = 404; throw e; }
  const clean = {};
  for (const k of EDITABLE) if (patch[k] !== undefined) clean[k] = patch[k] === '' ? null : patch[k];
  if (clean.vat_amount != null) clean.vat_amount = Math.abs(clean.vat_amount);
  check(db, { ...clean }, { partial: true });
  // A person choosing a category has verified it.
  if (clean.category_id !== undefined && clean.status === undefined && cur.status === 'review') clean.status = 'confirmed';
  if (cur.invoice_id && (clean.amount !== undefined || clean.date !== undefined)) { /* allowed: payments can be corrected */ }
  const merged = { ...cur, ...clean };
  clean.fingerprint = fingerprint(merged);
  const keys = Object.keys(clean);
  if (keys.length) db.run(`UPDATE transactions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => clean[k]), id);
  audit(db, 'transaction', id, 'update', clean);
  return getTransaction(db, id);
}

export function deleteTransaction(db, id) {
  db.run('DELETE FROM transactions WHERE id = ?', id);
  audit(db, 'transaction', id, 'delete');
}

export function bulkUpdate(db, ids, patch, action) {
  if (!Array.isArray(ids) || !ids.length) throw new ValidationError('No transactions selected');
  return db.tx(() => {
    let n = 0;
    for (const id of ids) {
      if (action === 'delete') { deleteTransaction(db, id); n++; continue; }
      updateTransaction(db, id, patch); n++;
    }
    return { updated: n };
  });
}

export function listTransactions(db, f = {}) {
  const where = [];
  const p = [];
  let from = f.from, to = f.to;
  if (f.taxYear && isTaxYearLabel(f.taxYear)) { const r = taxYearRange(f.taxYear); from = from || r.start; to = to || r.end; }
  if (from) { where.push('t.date >= ?'); p.push(from); }
  if (to) { where.push('t.date <= ?'); p.push(to); }
  if (f.accountId) { where.push('t.account_id = ?'); p.push(Number(f.accountId)); }
  if (f.categoryId) { where.push('t.category_id = ?'); p.push(f.categoryId); }
  if (f.contactId) { where.push('t.contact_id = ?'); p.push(Number(f.contactId)); }
  if (f.status) { where.push('t.status = ?'); p.push(f.status); }
  if (f.batchId) { where.push('t.batch_id = ?'); p.push(Number(f.batchId)); }
  if (f.uncategorised) where.push('t.category_id IS NULL');
  if (f.direction === 'in') where.push('t.amount > 0');
  if (f.direction === 'out') where.push('t.amount < 0');
  if (f.q) {
    const q = String(f.q).trim();
    const num = Number(q.replace(/[£,]/g, ''));
    where.push(`(t.description LIKE ? OR t.notes LIKE ? OR t.reference LIKE ? OR t.tag LIKE ?${Number.isFinite(num) && q !== '' ? ' OR ABS(t.amount) = ?' : ''})`);
    p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    if (Number.isFinite(num) && q !== '') p.push(Math.round(Math.abs(num) * 100));
  }
  const W = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount END), 0) AS money_in,
    COALESCE(SUM(CASE WHEN t.amount < 0 THEN t.amount END), 0) AS money_out FROM transactions t ${W}`, ...p);
  const limit = Math.min(500, Math.max(1, Number(f.limit) || 100));
  const offset = Math.max(0, Number(f.offset) || 0);
  const dir = f.sort === 'date_asc' ? 'ASC' : 'DESC';
  const order = f.sort === 'amount' ? 'ABS(t.amount) DESC' : `t.date ${dir}, t.id ${dir}`;
  const rows = db.all(`${SELECT} ${W} ORDER BY ${order} LIMIT ? OFFSET ?`, ...p, limit, offset);
  return { rows, total: total.n, moneyIn: total.money_in, moneyOut: total.money_out, limit, offset };
}

/** Pair up opposite amounts in different accounts within 3 days and mark both as transfers. */
export function detectTransfers(db, txnIds) {
  let pairs = 0;
  for (const id of txnIds) {
    const t = db.get('SELECT * FROM transactions WHERE id = ?', id);
    if (!t || t.invoice_id || t.category_id === 'transfer' || (t.category_id && t.status === 'confirmed' && t.category_id !== 'transfer' && t.confidence == null)) continue;
    const cand = db.get(
      `SELECT * FROM transactions WHERE id != ? AND account_id != ? AND amount = ? AND date BETWEEN ? AND ?
         AND invoice_id IS NULL AND (category_id IS NULL OR category_id = 'transfer' OR status = 'review') ORDER BY ABS(julianday(date) - julianday(?)) LIMIT 1`,
      t.id, t.account_id, -t.amount, addDays(t.date, -3), addDays(t.date, 3), t.date,
    );
    if (cand) {
      db.run("UPDATE transactions SET category_id = 'transfer', status = 'confirmed', vat_amount = 0, vat_code = 'O' WHERE id IN (?, ?)", t.id, cand.id);
      pairs++;
    }
  }
  return pairs;
}

export { daysBetween };
