import express from 'express';
import path from 'node:path';
import { getSettings } from '../db.js';
import { ValidationError, getInvoice, linkTransactionToInvoice, unlinkTransaction, listInvoices } from '../domain/invoices.js';
import { createTransaction, updateTransaction, deleteTransaction, bulkUpdate, listTransactions, getTransaction } from '../domain/transactions.js';
import { stageBatch, getBatch, listBatches, commitBatch, undoBatch, saveDocument, documentPath, buildHints } from '../domain/importService.js';
import { parseUpload, MAX_UPLOAD_BYTES } from '../importers/index.js';
import { today, taxYearRange, isTaxYearLabel } from '../util/dates.js';

const idOf = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n)) { const e = new Error('Not found'); e.status = 404; throw e; } return n; };
const bad = (m, f) => { throw new ValidationError(m, f); };

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`; // neutralise spreadsheet formulas
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Names that mean "us" on a document (decides whether an invoice is ours or a supplier's). */
const identityFor = (settings) => settings.entityType === 'company'
  ? { ...settings.profile, name: settings.company.name, tradingName: '', aliases: [settings.profile.aliases, ...settings.company.directors.map((d) => d.name)].filter(Boolean).join(', ') }
  : settings.profile;

export default function ledger(r, { db }) {
  // ---------------------------------------------------------------- transactions
  r.get('/transactions', (req, res) => res.json(listTransactions(db, req.query)));
  r.get('/transactions/export.csv', (req, res) => {
    const out = listTransactions(db, { ...req.query, limit: 500000 });
    const head = ['Date', 'Account', 'Description', 'Money in', 'Money out', 'Category', 'VAT', 'Business %', 'Contact', 'Invoice', 'Status', 'Notes'];
    const lines = [head.join(',')];
    for (const t of out.rows.slice().reverse()) {
      lines.push([t.date, t.account_name, t.description, t.amount > 0 ? (t.amount / 100).toFixed(2) : '', t.amount < 0 ? (-t.amount / 100).toFixed(2) : '', t.category_name || 'UNCATEGORISED', (t.vat_amount / 100).toFixed(2), t.business_pct, t.contact_name, t.invoice_number, t.status, t.notes].map(csvCell).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transactions-${today()}.csv"`);
    res.send('﻿' + lines.join('\r\n'));
  });
  r.post('/transactions', (req, res) => {
    const b = req.body || {};
    const acct = b.account_id || getSettings(db).defaultAccountId || db.get('SELECT id FROM accounts WHERE archived = 0 AND kind != ? ORDER BY id LIMIT 1', 'cash')?.id;
    res.status(201).json(createTransaction(db, { ...b, account_id: acct, source: 'manual' }));
  });
  r.post('/transactions/bulk', (req, res) => res.json(bulkUpdate(db, req.body.ids, req.body.patch || {}, req.body.action)));
  r.get('/transactions/:id', (req, res) => { const t = getTransaction(db, idOf(req)); t ? res.json(t) : res.status(404).json({ error: 'Transaction not found' }); });
  r.put('/transactions/:id', (req, res) => res.json(updateTransaction(db, idOf(req), req.body || {})));
  r.delete('/transactions/:id', (req, res) => { deleteTransaction(db, idOf(req)); res.json({ deleted: true }); });
  r.post('/transactions/:id/link-invoice', (req, res) => {
    const inv = linkTransactionToInvoice(db, idOf(req), Number(req.body.invoice_id));
    res.json({ invoice: inv, transaction: getTransaction(db, idOf(req)) });
  });
  r.delete('/transactions/:id/link-invoice', (req, res) => { unlinkTransaction(db, idOf(req)); res.json(getTransaction(db, idOf(req))); });
  r.get('/transactions/:id/invoice-candidates', (req, res) => {
    const t = getTransaction(db, idOf(req)); if (!t) return res.status(404).json({ error: 'Not found' });
    res.json(listInvoices(db, { status: 'unpaid' }).filter((i) => i.kind === 'invoice').map((i) => ({ id: i.id, number: i.number, contact: i.contact_name, outstanding: i.outstanding, total: i.totals.gross, due_date: i.due_date, exact: i.outstanding === t.amount })));
  });

  // ---------------------------------------------------------------- import
  const uploadParser = express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES });
  const stage = async (parsed, { filename, accountId, buffer, kind, text }) => {
    const settings = getSettings(db);
    const doc = buffer ? saveDocument(db, { filename, buffer, kind, text: text || parsed.text }) : { id: null };
    const batch = stageBatch(db, parsed, { filename, accountId, documentId: doc.id, settings });
    if (doc.duplicate) batch.summary.warnings = [`You have uploaded this exact file before (as “${doc.filename}”). Duplicate transactions are skipped automatically.`, ...(batch.summary.warnings || [])];
    return batch;
  };
  r.post('/import/upload', uploadParser, async (req, res) => {
    const filename = String(req.query.filename || 'upload').slice(0, 200);
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buffer.length) bad('That file is empty.');
    const settings = getSettings(db);
    const accountId = req.query.accountId ? Number(req.query.accountId) : null;
    const parsed = await parseUpload({ filename, buffer }, { profile: identityFor(settings), hints: buildHints(db) });
    res.status(201).json(await stage(parsed, { filename, accountId, buffer, kind: parsed.kind }));
  });
  r.post('/import/text', async (req, res) => {
    const text = String(req.body?.text || '');
    if (text.trim().length < 5) bad('Paste some text first.');
    if (text.length > 2_000_000) bad('That is too much text to import in one go.');
    const settings = getSettings(db);
    const parsed = await parseUpload({ filename: 'pasted.txt', buffer: Buffer.from(text, 'utf8') }, { profile: identityFor(settings), hints: buildHints(db) });
    res.status(201).json(await stage(parsed, { filename: 'Pasted text', accountId: req.body.accountId ? Number(req.body.accountId) : null, buffer: Buffer.from(text, 'utf8'), kind: 'text', text }));
  });
  r.get('/import/batches', (req, res) => res.json(listBatches(db)));
  r.get('/import/batches/:id', (req, res) => { const b = getBatch(db, idOf(req)); b ? res.json(b) : res.status(404).json({ error: 'Import not found' }); });
  r.post('/import/batches/:id/commit', (req, res) => res.json(commitBatch(db, idOf(req), req.body?.edits || {})));
  r.post('/import/batches/:id/undo', (req, res) => res.json(undoBatch(db, idOf(req))));
  r.delete('/import/batches/:id', (req, res) => {
    const b = getBatch(db, idOf(req)); if (!b) return res.status(404).json({ error: 'Import not found' });
    if (b.status === 'committed') bad('This import has been recorded. Use Undo instead.');
    db.run('DELETE FROM import_batches WHERE id = ?', b.id); res.json({ deleted: true });
  });

  // ---------------------------------------------------------------- documents (evidence)
  r.get('/documents/:id/file', (req, res) => {
    const d = documentPath(db, idOf(req)); if (!d) return res.status(404).json({ error: 'File not found' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.download(d.path, path.basename(d.filename || 'document'));
  });
  void taxYearRange; void isTaxYearLabel;
}
