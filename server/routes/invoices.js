import { getSettings } from '../db.js';
import {
  ValidationError, getInvoice, listInvoices, createInvoice, updateInvoice, deleteInvoice, setInvoiceStatus, recordPayment,
  duplicateInvoice, creditNoteFor, receivablesAging, nextInvoiceNumber,
} from '../domain/invoices.js';
import { listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, runDue, previewDates } from '../domain/recurring.js';
import { invoicePdf } from '../pdf/documents.js';
import { emailInvoice, mailConfigured } from '../mail.js';
import { today } from '../util/dates.js';

const idOf = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n)) { const e = new Error('Not found'); e.status = 404; throw e; } return n; };
const found = (x, what = 'Not found') => { if (!x) { const e = new Error(what); e.status = 404; throw e; } return x; };

export default function invoices(r, { db }) {
  r.get('/invoices', (req, res) => res.json(listInvoices(db, req.query, today()).map((i) => ({ ...i, lines: undefined }))));
  r.get('/invoices/aging', (req, res) => res.json(receivablesAging(db, req.query.asOf || today())));
  r.get('/invoices/next-number', (req, res) => {
    const s = getSettings(db).invoice; const kind = req.query.kind === 'credit_note';
    res.json({ number: `${kind ? s.creditPrefix : s.prefix}${String(kind ? s.nextCreditNumber : s.nextNumber).padStart(s.padding || 4, '0')}` });
  });
  r.post('/invoices', (req, res) => res.status(201).json(createInvoice(db, req.body || {})));
  r.get('/invoices/:id', (req, res) => res.json(found(getInvoice(db, idOf(req)), 'Invoice not found')));
  r.put('/invoices/:id', (req, res) => res.json(updateInvoice(db, idOf(req), req.body || {})));
  r.delete('/invoices/:id', (req, res) => { deleteInvoice(db, idOf(req)); res.json({ deleted: true }); });
  r.post('/invoices/:id/status', (req, res) => res.json(setInvoiceStatus(db, idOf(req), req.body?.status)));
  r.post('/invoices/:id/payments', (req, res) => {
    const b = req.body || {};
    const account_id = b.account_id || db.get("SELECT id FROM accounts WHERE archived = 0 AND kind != 'cash' ORDER BY id LIMIT 1")?.id;
    res.status(201).json(recordPayment(db, idOf(req), { account_id, date: b.date || today(), amount: Math.round(Number(b.amount)), description: b.description }));
  });
  r.post('/invoices/:id/duplicate', (req, res) => res.status(201).json(duplicateInvoice(db, idOf(req))));
  r.post('/invoices/:id/credit-note', (req, res) => res.status(201).json(creditNoteFor(db, idOf(req))));
  r.get('/invoices/:id/pdf', async (req, res) => {
    const inv = found(getInvoice(db, idOf(req)), 'Invoice not found');
    const pdf = await invoicePdf(inv, getSettings(db));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${inv.number}.pdf"`);
    res.send(pdf);
  });
  r.post('/invoices/:id/send', async (req, res) => {
    const id = idOf(req);
    const inv = found(getInvoice(db, id), 'Invoice not found');
    let emailed = null;
    if (req.body?.email) {
      if (!mailConfigured()) throw new ValidationError('Email is not set up. Set SMTP_URL (see README) or download the PDF to send it yourself.');
      emailed = await emailInvoice(db, id, { to: req.body.to, subject: req.body.subject, message: req.body.message });
    }
    const updated = inv.status === 'draft' ? setInvoiceStatus(db, id, 'sent') : inv;
    if (emailed) db.run("UPDATE invoices SET sent_at = datetime('now') WHERE id = ?", id);
    res.json({ invoice: getInvoice(db, id) || updated, emailed });
  });

  // ---- recurring
  r.get('/recurring', (req, res) => res.json(listTemplates(db).map((t) => ({ ...t, upcoming: previewDates(t, 3) }))));
  r.post('/recurring', (req, res) => res.status(201).json(createTemplate(db, req.body || {})));
  r.post('/recurring/run-due', (req, res) => res.json({ created: runDue(db).map((c) => ({ template: c.templateName, invoice: c.invoice.number, id: c.invoice.id })) }));
  r.get('/recurring/:id', (req, res) => { const t = found(getTemplate(db, idOf(req)), 'Recurring invoice not found'); res.json({ ...t, upcoming: previewDates(t, 6) }); });
  r.put('/recurring/:id', (req, res) => res.json(updateTemplate(db, idOf(req), req.body || {})));
  r.delete('/recurring/:id', (req, res) => { deleteTemplate(db, idOf(req)); res.json({ deleted: true }); });
  r.post('/recurring/:id/run', (req, res) => {
    const made = runDue(db, { templateId: idOf(req), force: true });
    res.json({ created: made.map((c) => ({ invoice: c.invoice.number, id: c.invoice.id })) });
  });
  void nextInvoiceNumber;
}
