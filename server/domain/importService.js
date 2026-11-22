// Import orchestration: parsed items -> enriched preview batch -> committed transactions/invoices.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getSettings, audit } from '../db.js';
import { suggestCategory, buildHistory, loadRules, merchantKey } from './categorizer.js';
import { createTransaction, fingerprint, detectTransfers, normDesc } from './transactions.js';
import { listInvoices, createInvoice, linkTransactionToInvoice, ValidationError } from './invoices.js';
import { today, daysBetween, addDays } from '../util/dates.js';
import { vatFromGross } from '../util/money.js';

const MATCH_DAYS = 14;

/** Words that tell the parser which way money moved: your customers and open invoice numbers (in), suppliers (out). */
export function buildHints(db) {
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const contacts = db.all('SELECT name, kind FROM contacts WHERE archived = 0');
  const inWords = contacts.filter((c) => c.kind !== 'supplier').map((c) => norm(c.name)).filter((n) => n.length >= 4);
  const outWords = contacts.filter((c) => c.kind === 'supplier').map((c) => norm(c.name)).filter((n) => n.length >= 4);
  for (const i of db.all("SELECT number FROM invoices WHERE status = 'sent' AND kind = 'invoice'")) inWords.push(norm(i.number));
  return { inWords, outWords };
}

export function saveDocument(db, { filename, buffer, kind, text }) {
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const existing = db.get('SELECT * FROM documents WHERE sha256 = ?', sha);
  if (existing) return { id: existing.id, duplicate: true, filename: existing.filename };
  const ext = (path.extname(filename || '') || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
  const stored = `${sha}${ext}`;
  const dir = path.join(DATA_DIR, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, stored);
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, buffer);
  const r = db.run(
    'INSERT INTO documents (filename, mime, size, sha256, stored_name, kind, extracted) VALUES (?, ?, ?, ?, ?, ?, ?)',
    String(filename || 'upload').slice(0, 200), null, buffer.length, sha, stored, kind || null, text ? String(text).slice(0, 50000) : null,
  );
  return { id: r.id, duplicate: false, filename };
}

export function documentPath(db, id) {
  const d = db.get('SELECT * FROM documents WHERE id = ?', id);
  if (!d || !d.stored_name) return null;
  const p = path.join(DATA_DIR, 'uploads', path.basename(d.stored_name));
  return fs.existsSync(p) ? { path: p, filename: d.filename } : null;
}

function defaultAccountFor(db, kind) {
  return db.get('SELECT id FROM accounts WHERE kind = ? AND archived = 0 ORDER BY id LIMIT 1', kind)?.id
    || db.get('SELECT id FROM accounts WHERE archived = 0 ORDER BY id LIMIT 1').id;
}

function findContact(db, contacts, name) {
  if (!name) return null;
  const n = normDesc(name);
  if (n.length < 3) return null;
  return contacts.find((c) => normDesc(c.name) === n)
    || contacts.find((c) => { const cn = normDesc(c.name); return cn.length >= 4 && (n.includes(cn) || cn.includes(n)); })
    || null;
}

function vatFor(item, settings, direction) {
  if (!settings.vat.registered) return { vat_code: 'N', vat_amount: 0 };
  if (item.vat != null && item.kind === 'document') {
    const rate = item.vatRate ?? (item.net ? item.vat / item.net : null);
    const code = item.vat === 0 ? 'Z' : rate && Math.abs(rate - 0.05) < 0.01 ? 'R' : 'S';
    return { vat_code: code, vat_amount: item.vat };
  }
  // Bank rows have no VAT detail. Money IN is assumed to carry output VAT (you must account for it);
  // money OUT is NOT assumed to be reclaimable without a VAT receipt.
  if (direction === 'in') return { vat_code: 'S', vat_amount: Math.abs(vatFromGross(item.amount, 0.2)), estimated: true };
  return { vat_code: 'N', vat_amount: 0 };
}

/** Existing transactions per fingerprint, for duplicate detection. */
function fingerprintCounts(db) {
  const m = new Map();
  for (const r of db.all('SELECT fingerprint AS fp, COUNT(*) AS n FROM transactions WHERE fingerprint IS NOT NULL GROUP BY fingerprint')) m.set(r.fp, r.n);
  return m;
}

function invoiceCandidates(db) {
  return listInvoices(db, { status: 'unpaid' }).filter((i) => i.kind === 'invoice' && i.outstanding > 0);
}

function matchInvoice(item, invoices, contactId) {
  if (item.amount <= 0) return null;
  const text = normDesc(`${item.description} ${item.reference || ''}`).replace(/ /g, '');
  const byNumber = invoices.find((i) => text.includes(normDesc(i.number).replace(/ /g, '')) && i.outstanding >= item.amount);
  if (byNumber) return { invoice_id: byNumber.id, number: byNumber.number, confidence: 0.97, how: 'invoice number in description' };
  const sameAmount = invoices.filter((i) => i.outstanding === item.amount || i.totals.gross === item.amount);
  if (sameAmount.length === 1) {
    const inv = sameAmount[0];
    const nameHit = contactId && inv.contact_id === contactId;
    return { invoice_id: inv.id, number: inv.number, confidence: nameHit ? 0.95 : 0.7, how: nameHit ? 'amount and customer match' : 'amount matches' };
  }
  if (sameAmount.length > 1 && contactId) {
    const c = sameAmount.filter((i) => i.contact_id === contactId);
    if (c.length === 1) return { invoice_id: c[0].id, number: c[0].number, confidence: 0.9, how: 'amount and customer match' };
  }
  return null;
}

/** Match a statement row to a receipt/invoice already recorded without a bank line (and vice-versa). */
function matchReconcile(db, item) {
  const abs = Math.abs(item.amount);
  const lo = addDays(item.date, -MATCH_DAYS), hi = addDays(item.date, MATCH_DAYS);
  if (item.kind === 'document') {
    const t = db.get(
      `SELECT id, description FROM transactions WHERE source != 'document' AND document_id IS NULL AND invoice_id IS NULL
         AND ABS(amount) = ? AND (amount > 0) = ? AND date BETWEEN ? AND ? ORDER BY ABS(julianday(date) - julianday(?)) LIMIT 1`,
      abs, item.amount > 0 ? 1 : 0, lo, hi, item.date,
    );
    return t ? { type: 'bank_txn', id: t.id, description: t.description } : null;
  }
  const t = db.get(
    `SELECT id, description FROM transactions WHERE source = 'document' AND ABS(amount) = ? AND (amount > 0) = ? AND date BETWEEN ? AND ?
       ORDER BY ABS(julianday(date) - julianday(?)) LIMIT 1`,
    abs, item.amount > 0 ? 1 : 0, lo, hi, item.date,
  );
  return t ? { type: 'doc_txn', id: t.id, description: t.description } : null;
}

/** Turn raw parser output into previewable, categorised, de-duplicated items. */
export function enrichItems(db, parsed, { accountId, settings = getSettings(db) } = {}) {
  const rules = loadRules(db);
  const history = buildHistory(db);
  const validCategories = new Set(db.all('SELECT id FROM categories').map((c) => c.id));
  const contacts = db.all('SELECT id, name FROM contacts WHERE archived = 0');
  const invoices = invoiceCandidates(db);
  const existing = fingerprintCounts(db);
  const seen = new Map();
  const threshold = settings.importer.autoRecordConfidence ?? 0.7;
  const isDoc = (it) => it.kind === 'document';

  const out = [];
  parsed.items.forEach((raw, idx) => {
    if (raw.amount == null || raw.amount === 0) return;
    const doc = isDoc(raw);
    const flags = [...(raw.flags || [])];
    const direction = raw.amount >= 0 ? 'in' : 'out';
    const acct = doc && !accountId ? defaultAccountFor(db, 'cash') : accountId || defaultAccountFor(db, 'bank');
    const date = raw.date || today();
    if (!raw.date && !flags.includes('no_date')) flags.push('no_date');

    const contact = findContact(db, contacts, raw.counterparty) || findContact(db, contacts, raw.description);
    const sugg = suggestCategory({ description: raw.description, amount: raw.amount, counterparty: raw.counterparty }, { rules, history, validCategories, entityType: settings.entityType });
    let category_id = sugg.category_id;
    // Documents addressed to you from a customer: your sales invoice is income
    if (doc && direction === 'in') category_id = category_id && category_id !== 'drawings' ? category_id : (settings.entityType === 'company' ? 'co_other_income' : 'se_turnover');
    const confidence = Math.min(sugg.confidence, raw.confidence ?? 1);

    const vat = vatFor(raw, settings, direction);
    const fp = fingerprint({ account_id: acct, date, amount: raw.amount, description: raw.description, externalId: raw.externalId });
    const occ = (seen.get(fp) || 0) + 1;
    seen.set(fp, occ);
    const duplicate = !doc && occ <= (existing.get(fp) || 0);

    const target = doc && direction === 'in' && raw.docType === 'invoice' ? 'invoice' : 'transaction';
    const invoiceMatch = target === 'transaction' && !doc ? matchInvoice(raw, invoices, contact?.id) : null;
    const reconcile = matchReconcile(db, { ...raw, date });

    out.push({
      idx, include: !duplicate, date, description: raw.description, amount: raw.amount, balance: raw.balance ?? null,
      category_id, category_confidence: Math.round(sugg.confidence * 100) / 100, category_reason: sugg.reason, category_source: sugg.source,
      confidence: Math.round(confidence * 100) / 100, business_pct: sugg.business_pct ?? 100,
      contact_id: contact?.id || sugg.contact_id || null, contact_name: contact?.name || raw.counterparty || null,
      vat_code: vat.vat_code, vat_amount: vat.vat_amount, vat_estimated: !!vat.estimated,
      net: raw.net ?? null, doc_vat: raw.vat ?? null, doc_vat_rate: raw.vatRate ?? null, due_date: raw.dueDate || null, reference: raw.reference || null, doc_type: raw.docType || null,
      kind: raw.kind || 'row', target, account_id: acct, flags, raw: raw.raw, duplicate,
      invoice_match: invoiceMatch, reconcile, external_id: raw.externalId || null, paid: raw.paid ?? null,
      merchant: merchantKey(raw.description),
      needs_review: confidence < threshold || !category_id || flags.includes('direction_guessed') || flags.includes('no_date') || flags.some((f) => f.startsWith('foreign')),
    });
  });
  return out;
}

export function summarise(items, parsed) {
  const inc = items.filter((i) => i.include);
  return {
    mode: parsed.mode, kind: parsed.kind, total: items.length, included: inc.length,
    duplicates: items.filter((i) => i.duplicate).length,
    moneyIn: inc.filter((i) => i.amount > 0).reduce((a, i) => a + i.amount, 0),
    moneyOut: inc.filter((i) => i.amount < 0).reduce((a, i) => a + i.amount, 0),
    needsReview: inc.filter((i) => i.needs_review).length,
    autoRecorded: inc.filter((i) => !i.needs_review).length,
    warnings: parsed.warnings || [],
    dateFrom: items.map((i) => i.date).sort()[0] || null, dateTo: items.map((i) => i.date).sort().pop() || null,
  };
}

export function stageBatch(db, parsed, { filename, accountId, documentId, settings }) {
  const items = enrichItems(db, parsed, { accountId, settings });
  const summary = summarise(items, parsed);
  const r = db.run(
    'INSERT INTO import_batches (filename, source_kind, status, account_id, document_id, summary, items) VALUES (?, ?, ?, ?, ?, ?, ?)',
    filename || null, parsed.kind, 'preview', accountId || null, documentId || null, JSON.stringify(summary), JSON.stringify(items),
  );
  return getBatch(db, r.id);
}

export function getBatch(db, id) {
  const b = db.get('SELECT * FROM import_batches WHERE id = ?', id);
  if (!b) return null;
  return { ...b, summary: JSON.parse(b.summary || '{}'), items: JSON.parse(b.items || '[]') };
}

export function listBatches(db) {
  return db.all('SELECT id, filename, source_kind, status, account_id, summary, created_at, committed_at FROM import_batches ORDER BY id DESC LIMIT 100')
    .map((b) => ({ ...b, summary: JSON.parse(b.summary || '{}') }));
}

const ITEM_EDITABLE = ['include', 'date', 'description', 'amount', 'category_id', 'contact_id', 'business_pct', 'vat_code', 'vat_amount', 'account_id'];

export function commitBatch(db, batchId, edits = {}) {
  const batch = getBatch(db, batchId);
  if (!batch) { const e = new Error('Import not found'); e.status = 404; throw e; }
  if (batch.status !== 'preview') throw new ValidationError('This import has already been recorded.');
  const settings = getSettings(db);
  const threshold = settings.importer.autoRecordConfidence ?? 0.7;

  return db.tx(() => {
    const result = { created: 0, merged: 0, invoices: 0, linkedToInvoices: 0, skipped: 0, needsReview: 0, transfers: 0, transactionIds: [] };
    for (const base of batch.items) {
      const item = { ...base };
      const e = edits[base.idx];
      if (e) for (const k of ITEM_EDITABLE) if (e[k] !== undefined) item[k] = e[k];
      if (e?.linkInvoice === false) item.invoice_match = null;
      if (!item.include) { result.skipped++; continue; }
      const fields = {
        account_id: item.account_id, date: item.date, description: item.description, amount: item.amount,
        category_id: item.category_id || null, contact_id: item.contact_id || null, vat_code: item.vat_code, vat_amount: item.vat_amount,
        business_pct: item.business_pct ?? 100, reference: item.reference || null, batch_id: batch.id,
        document_id: item.kind === 'document' ? batch.document_id : null,
        confidence: item.confidence, balance: item.balance,
      };
      const status = (item.category_id && item.confidence >= threshold && !item.needs_review) || (e && e.category_id) ? 'confirmed' : 'review';

      // --- a sales invoice document becomes an invoice record
      if (item.target === 'invoice') {
        let contactId = item.contact_id;
        if (!contactId && item.contact_name) contactId = db.run("INSERT INTO contacts (name, kind) VALUES (?, 'customer')", item.contact_name).id;
        // An invoice record always reflects what the document says, regardless of today's VAT settings.
        const docVat = item.doc_vat || 0;
        const net = item.net ?? Math.abs(item.amount) - docVat;
        const docVatCode = docVat === 0 ? (item.doc_vat === 0 ? 'Z' : 'N') : item.doc_vat_rate && Math.abs(item.doc_vat_rate - 0.05) < 0.01 ? 'R' : 'S';
        const inv = createInvoice(db, {
          number: item.reference && !db.get('SELECT 1 AS x FROM invoices WHERE number = ?', item.reference) ? item.reference : undefined,
          contact_id: contactId, issue_date: item.date, due_date: item.due_date || addDays(item.date, settings.invoice.paymentTermsDays || 30), status: 'sent',
          category_id: item.category_id || 'se_turnover', document_id: batch.document_id, reference: 'Imported from document',
          lines: [{ description: item.description, quantity: 1, unit_price: Math.abs(net), vat_code: docVatCode }],
        });
        void inv;
        result.invoices++;
        continue;
      }

      // --- reconcile a receipt with a bank line (or a bank line with an earlier receipt)
      const rec = item.reconcile;
      if (rec && e?.reconcile !== false) {
        if (rec.type === 'bank_txn') {
          const cur = db.get('SELECT * FROM transactions WHERE id = ?', rec.id);
          if (cur) {
            db.run(
              `UPDATE transactions SET document_id = ?, vat_code = ?, vat_amount = ?, reference = COALESCE(reference, ?),
                 category_id = CASE WHEN category_id IS NULL OR status = 'review' THEN COALESCE(?, category_id) ELSE category_id END,
                 contact_id = COALESCE(contact_id, ?) WHERE id = ?`,
              batch.document_id, fields.vat_code, fields.vat_amount, fields.reference, fields.category_id, fields.contact_id, cur.id,
            );
            result.merged++;
            continue;
          }
        } else if (rec.type === 'doc_txn') {
          const cur = db.get('SELECT * FROM transactions WHERE id = ?', rec.id);
          if (cur) {
            db.run(
              `UPDATE transactions SET account_id = ?, date = ?, description = ?, source = 'import', batch_id = ?, fingerprint = ?, balance = ? WHERE id = ?`,
              fields.account_id, fields.date, `${fields.description}${cur.description && !fields.description.includes(cur.description) ? ' – ' + cur.description : ''}`.slice(0, 250),
              batch.id, fingerprint({ ...fields, externalId: item.external_id }), fields.balance, cur.id,
            );
            result.merged++;
            continue;
          }
        }
      }

      const txn = createTransaction(db, { ...fields, status, source: item.kind === 'document' ? 'document' : 'import', externalId: item.external_id });
      result.created++;
      result.transactionIds.push(txn.id);
      if (status === 'review') result.needsReview++;

      if (item.invoice_match && item.invoice_match.confidence >= 0.9 && e?.linkInvoice !== false) {
        linkTransactionToInvoice(db, txn.id, item.invoice_match.invoice_id);
        result.linkedToInvoices++;
      }
    }
    result.transfers = detectTransfers(db, result.transactionIds);
    db.run("UPDATE import_batches SET status = 'committed', committed_at = datetime('now'), summary = ? WHERE id = ?", JSON.stringify({ ...batch.summary, result }), batch.id);
    audit(db, 'import', batch.id, 'commit', result);
    return result;
  });
}

export function undoBatch(db, batchId) {
  const batch = getBatch(db, batchId);
  if (!batch) { const e = new Error('Import not found'); e.status = 404; throw e; }
  if (batch.status !== 'committed') throw new ValidationError('Only recorded imports can be undone.');
  return db.tx(() => {
    const t = db.run('DELETE FROM transactions WHERE batch_id = ?', batchId);
    const inv = db.all("SELECT id FROM invoices WHERE document_id = ? AND status = 'sent' AND NOT EXISTS (SELECT 1 FROM transactions WHERE invoice_id = invoices.id)", batch.document_id || -1);
    for (const i of inv) db.run('DELETE FROM invoices WHERE id = ?', i.id);
    db.run("UPDATE import_batches SET status = 'undone' WHERE id = ?", batchId);
    audit(db, 'import', batchId, 'undo', { transactions: t.changes, invoices: inv.length });
    return { removedTransactions: t.changes, removedInvoices: inv.length };
  });
}

export { daysBetween };
