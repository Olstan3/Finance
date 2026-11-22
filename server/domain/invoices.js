import { VAT_RATES } from './taxRates.js';
import { addDays, today, isISO } from '../util/dates.js';
import { getSettings, saveSettings, audit } from '../db.js';

export class ValidationError extends Error {
  constructor(msg, field) { super(msg); this.status = 400; this.field = field; }
}

export const vatRateOf = (code) => (VAT_RATES[code] ? VAT_RATES[code].rate : 0);

export function lineTotals(line) {
  const net = Math.round((Number(line.quantity) || 0) * (Number(line.unit_price) || 0));
  const vat = Math.round(net * vatRateOf(line.vat_code));
  return { net, vat, gross: net + vat };
}

/** Totals for an invoice; credit notes are negative. */
export function invoiceTotals(lines, kind = 'invoice') {
  const sign = kind === 'credit_note' ? -1 : 1;
  let net = 0, vat = 0;
  const byCode = {};
  for (const l of lines) {
    const t = lineTotals(l);
    net += t.net; vat += t.vat;
    byCode[l.vat_code] = (byCode[l.vat_code] || 0) + t.vat;
  }
  return { net: sign * net, vat: sign * vat, gross: sign * (net + vat), byCode, sign };
}

/** The VAT code carrying most VAT (or most net) – used to tag payment transactions. */
function dominantVatCode(lines) {
  const m = {};
  for (const l of lines) { const t = lineTotals(l); m[l.vat_code] = (m[l.vat_code] || 0) + t.vat * 1e6 + t.net; }
  return Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] || 'N';
}

export function derivedStatus(inv, asOf = today()) {
  if (inv.status === 'void') return 'void';
  if (inv.status === 'draft') return 'draft';
  const outstanding = inv.totals.gross - inv.paid;
  if (inv.totals.gross !== 0 && outstanding === 0) return 'paid';
  if (inv.totals.gross === 0 && inv.status === 'sent') return 'paid';
  if (inv.paid !== 0) return inv.due_date && inv.due_date < asOf ? 'overdue' : 'part_paid';
  return inv.due_date && inv.due_date < asOf ? 'overdue' : 'sent';
}

function hydrate(db, row, asOf) {
  if (!row) return null;
  const lines = db.all('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY sort, id', row.id);
  const payments = db.all('SELECT id, date, amount, account_id, description FROM transactions WHERE invoice_id = ? ORDER BY date, id', row.id);
  const totals = invoiceTotals(lines, row.kind);
  const paid = payments.reduce((a, p) => a + p.amount, 0);
  const inv = { ...row, lines, payments, totals, paid, outstanding: totals.gross - paid };
  inv.derived_status = derivedStatus(inv, asOf);
  const contact = row.contact_id ? db.get('SELECT * FROM contacts WHERE id = ?', row.contact_id) : null;
  inv.contact = contact;
  inv.contact_name = contact?.name || null;
  return inv;
}

export function getInvoice(db, id, asOf) {
  return hydrate(db, db.get('SELECT * FROM invoices WHERE id = ?', id), asOf);
}

export function listInvoices(db, { status, contactId, from, to, q } = {}, asOf) {
  const where = [];
  const params = [];
  if (contactId) { where.push('contact_id = ?'); params.push(contactId); }
  if (from) { where.push('issue_date >= ?'); params.push(from); }
  if (to) { where.push('issue_date <= ?'); params.push(to); }
  if (q) { where.push('(number LIKE ? OR reference LIKE ? OR contact_id IN (SELECT id FROM contacts WHERE name LIKE ?))'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const rows = db.all(`SELECT * FROM invoices ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY issue_date DESC, id DESC`, ...params);
  let list = rows.map((r) => hydrate(db, r, asOf));
  if (status) list = list.filter((i) => i.derived_status === status || (status === 'unpaid' && ['sent', 'part_paid', 'overdue'].includes(i.derived_status)));
  return list;
}

export function nextInvoiceNumber(db, kind = 'invoice') {
  return db.tx(() => {
    const s = getSettings(db);
    const isCredit = kind === 'credit_note';
    const prefix = isCredit ? s.invoice.creditPrefix : s.invoice.prefix;
    let n = isCredit ? s.invoice.nextCreditNumber : s.invoice.nextNumber;
    const pad = s.invoice.padding || 4;
    let number;
    do { number = `${prefix}${String(n).padStart(pad, '0')}`; n++; } while (db.get('SELECT 1 AS x FROM invoices WHERE number = ?', number));
    saveSettings(db, { invoice: isCredit ? { nextCreditNumber: n } : { nextNumber: n } });
    return number;
  });
}

function validateInvoice(data) {
  if (!isISO(data.issue_date)) throw new ValidationError('Issue date must be a valid date', 'issue_date');
  if (data.due_date && !isISO(data.due_date)) throw new ValidationError('Due date must be a valid date', 'due_date');
  if (data.due_date && data.due_date < data.issue_date) throw new ValidationError('Due date cannot be before the issue date', 'due_date');
  if (!Array.isArray(data.lines) || data.lines.length === 0) throw new ValidationError('Add at least one line item', 'lines');
  for (const l of data.lines) {
    if (!String(l.description || '').trim()) throw new ValidationError('Every line needs a description', 'lines');
    if (!Number.isFinite(Number(l.quantity))) throw new ValidationError('Line quantity must be a number', 'lines');
    if (!Number.isInteger(Number(l.unit_price))) throw new ValidationError('Line price must be in whole pence', 'lines');
    if (l.vat_code && !VAT_RATES[l.vat_code]) throw new ValidationError(`Unknown VAT code ${l.vat_code}`, 'lines');
  }
}

export function defaultIncomeCategory(db) {
  const s = getSettings(db);
  void s;
  return 'se_turnover';
}

export function createInvoice(db, data) {
  const kind = data.kind === 'credit_note' ? 'credit_note' : 'invoice';
  const settings = getSettings(db);
  const issue = data.issue_date || today();
  const terms = data.contact_id ? db.get('SELECT payment_terms_days AS d FROM contacts WHERE id = ?', data.contact_id)?.d : null;
  const due = data.due_date === undefined ? addDays(issue, terms ?? settings.invoice.paymentTermsDays ?? 30) : data.due_date;
  const payload = { ...data, issue_date: issue, due_date: due };
  validateInvoice(payload);
  return db.tx(() => {
    const number = data.number?.trim() || nextInvoiceNumber(db, kind);
    if (db.get('SELECT 1 AS x FROM invoices WHERE number = ?', number)) throw new ValidationError(`Invoice number ${number} already exists`, 'number');
    const r = db.run(
      `INSERT INTO invoices (number, kind, contact_id, issue_date, due_date, status, reference, notes, terms, category_id, recurring_id, tag, sent_at, document_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      number, kind, data.contact_id || null, issue, due || null, data.status || 'draft', data.reference || null,
      data.notes ?? settings.invoice.notes ?? null, data.terms || null, data.category_id || defaultIncomeCategory(db),
      data.recurring_id || null, data.tag || null, data.sent_at || null, data.document_id || null,
    );
    saveLines(db, r.id, data.lines);
    audit(db, 'invoice', r.id, 'create', { number });
    return getInvoice(db, r.id);
  });
}

function saveLines(db, invoiceId, lines) {
  db.run('DELETE FROM invoice_lines WHERE invoice_id = ?', invoiceId);
  lines.forEach((l, i) => {
    db.run(
      'INSERT INTO invoice_lines (invoice_id, description, quantity, unit_price, vat_code, sort) VALUES (?, ?, ?, ?, ?, ?)',
      invoiceId, String(l.description).trim(), Number(l.quantity), Math.round(Number(l.unit_price)), l.vat_code || 'N', i,
    );
  });
}

export function updateInvoice(db, id, data) {
  const cur = db.get('SELECT * FROM invoices WHERE id = ?', id);
  if (!cur) { const e = new Error('Invoice not found'); e.status = 404; throw e; }
  if (cur.status === 'void') throw new ValidationError('A voided invoice cannot be edited');
  const merged = { ...cur, ...data, lines: data.lines ?? db.all('SELECT * FROM invoice_lines WHERE invoice_id = ?', id) };
  validateInvoice(merged);
  if (data.number && data.number !== cur.number && db.get('SELECT 1 AS x FROM invoices WHERE number = ? AND id != ?', data.number, id)) {
    throw new ValidationError(`Invoice number ${data.number} already exists`, 'number');
  }
  return db.tx(() => {
    db.run(
      `UPDATE invoices SET number = ?, contact_id = ?, issue_date = ?, due_date = ?, reference = ?, notes = ?, terms = ?,
         category_id = ?, tag = ? WHERE id = ?`,
      merged.number, merged.contact_id || null, merged.issue_date, merged.due_date || null, merged.reference || null,
      merged.notes || null, merged.terms || null, merged.category_id || null, merged.tag || null, id,
    );
    if (data.lines) saveLines(db, id, data.lines);
    audit(db, 'invoice', id, 'update');
    return getInvoice(db, id);
  });
}

export function setInvoiceStatus(db, id, status) {
  if (!['draft', 'sent', 'void'].includes(status)) throw new ValidationError('Bad status');
  const inv = getInvoice(db, id);
  if (!inv) { const e = new Error('Invoice not found'); e.status = 404; throw e; }
  if (status === 'void' && inv.payments.length) throw new ValidationError('Remove or reallocate the payments before voiding this invoice');
  db.run('UPDATE invoices SET status = ?, sent_at = CASE WHEN ? = \'sent\' AND sent_at IS NULL THEN datetime(\'now\') ELSE sent_at END WHERE id = ?', status, status, id);
  audit(db, 'invoice', id, `status:${status}`);
  return getInvoice(db, id);
}

export function deleteInvoice(db, id) {
  const inv = getInvoice(db, id);
  if (!inv) { const e = new Error('Invoice not found'); e.status = 404; throw e; }
  if (inv.status !== 'draft') throw new ValidationError('Only drafts can be deleted. Void the invoice instead so the number sequence stays intact.');
  db.run('DELETE FROM invoices WHERE id = ?', id);
  audit(db, 'invoice', id, 'delete', { number: inv.number });
}

/** Record a payment (or refund, for credit notes) against an invoice. `amount` is a positive magnitude. */
export function recordPayment(db, invoiceId, { account_id, date, amount, description }) {
  const inv = getInvoice(db, invoiceId);
  if (!inv) { const e = new Error('Invoice not found'); e.status = 404; throw e; }
  if (inv.status === 'void' || inv.status === 'draft') throw new ValidationError('Issue the invoice before recording a payment');
  if (!Number.isInteger(amount) || amount <= 0) throw new ValidationError('Payment amount must be greater than zero', 'amount');
  if (!isISO(date)) throw new ValidationError('Payment date must be a valid date', 'date');
  if (!db.get('SELECT 1 AS x FROM accounts WHERE id = ?', account_id)) throw new ValidationError('Choose an account', 'account_id');
  const sign = inv.totals.sign;
  const signed = sign * amount;
  // Outstanding balance expressed as a positive number in the invoice's own direction
  // (credit notes are negative internally, so multiply by the sign).
  const remainingMag = sign * (inv.totals.gross - inv.paid);
  if (amount > remainingMag) {
    throw new ValidationError(`Payment is more than the outstanding balance (£${(Math.max(0, remainingMag) / 100).toFixed(2)})`, 'amount');
  }
  const gross = inv.totals.gross || 1;
  const vat = Math.round((Math.abs(signed) * Math.abs(inv.totals.vat)) / Math.abs(gross));
  return db.tx(() => {
    const r = db.run(
      `INSERT INTO transactions (account_id, date, description, amount, category_id, contact_id, invoice_id, vat_code, vat_amount, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'invoice')`,
      account_id, date, description || `${inv.kind === 'credit_note' ? 'Refund' : 'Payment'} ${inv.number}${inv.contact_name ? ' – ' + inv.contact_name : ''}`,
      signed, inv.category_id || 'se_turnover', inv.contact_id, invoiceId, dominantVatCode(inv.lines), vat,
    );
    audit(db, 'invoice', invoiceId, 'payment', { amount: signed });
    return { transactionId: r.id, invoice: getInvoice(db, invoiceId) };
  });
}

/** Link an existing bank transaction to an invoice (e.g. after import), copying VAT pro-rata. */
export function linkTransactionToInvoice(db, txnId, invoiceId) {
  const inv = getInvoice(db, invoiceId);
  const t = db.get('SELECT * FROM transactions WHERE id = ?', txnId);
  if (!inv || !t) throw new ValidationError('Transaction or invoice not found');
  const gross = inv.totals.gross || 1;
  const vat = Math.round((Math.abs(t.amount) * Math.abs(inv.totals.vat)) / Math.abs(gross));
  db.run(
    `UPDATE transactions SET invoice_id = ?, contact_id = ?, category_id = ?, vat_code = ?, vat_amount = ?, status = 'confirmed' WHERE id = ?`,
    invoiceId, inv.contact_id, inv.category_id || 'se_turnover', dominantVatCode(inv.lines), vat, txnId,
  );
  return getInvoice(db, invoiceId);
}

export function unlinkTransaction(db, txnId) {
  db.run('UPDATE transactions SET invoice_id = NULL WHERE id = ?', txnId);
}

export function duplicateInvoice(db, id) {
  const inv = getInvoice(db, id);
  if (!inv) { const e = new Error('Invoice not found'); e.status = 404; throw e; }
  return createInvoice(db, {
    kind: inv.kind, contact_id: inv.contact_id, issue_date: today(), reference: inv.reference, notes: inv.notes, terms: inv.terms,
    category_id: inv.category_id, tag: inv.tag, lines: inv.lines.map((l) => ({ ...l })),
  });
}

export function creditNoteFor(db, id) {
  const inv = getInvoice(db, id);
  if (!inv) { const e = new Error('Invoice not found'); e.status = 404; throw e; }
  return createInvoice(db, {
    kind: 'credit_note', contact_id: inv.contact_id, issue_date: today(), due_date: null, reference: `Credit against ${inv.number}`,
    category_id: inv.category_id, tag: inv.tag, lines: inv.lines.map((l) => ({ ...l })),
  });
}

/** Aged receivables as at a date: buckets by days overdue. */
export function receivablesAging(db, asOf = today()) {
  const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
  const rows = [];
  for (const inv of listInvoices(db, {}, asOf)) {
    if (!['sent', 'part_paid', 'overdue'].includes(inv.derived_status) || inv.kind === 'credit_note') continue;
    const out = inv.outstanding;
    if (out <= 0) continue;
    const overdueDays = inv.due_date ? Math.max(0, Math.round((Date.parse(asOf) - Date.parse(inv.due_date)) / 86400000)) : 0;
    const b = overdueDays === 0 ? 'current' : overdueDays <= 30 ? 'd1_30' : overdueDays <= 60 ? 'd31_60' : overdueDays <= 90 ? 'd61_90' : 'd90plus';
    buckets[b] += out;
    rows.push({ id: inv.id, number: inv.number, contact: inv.contact_name, due_date: inv.due_date, outstanding: out, overdueDays, bucket: b });
  }
  return { asOf, buckets, total: Object.values(buckets).reduce((a, b) => a + b, 0), rows };
}
