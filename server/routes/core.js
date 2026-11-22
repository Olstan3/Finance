import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getSettings, saveSettings, audit, DATA_DIR } from '../db.js';
import { ValidationError, listInvoices } from '../domain/invoices.js';
import { TAX_YEAR_DATA, SUPPORTED_TAX_YEARS, VAT_RATES, THRESHOLDS } from '../domain/taxRates.js';
import { SECTION_LABELS, BUILTIN_CATEGORIES } from '../domain/categories.js';
import { currentTaxYear, today } from '../util/dates.js';
import { mailConfigured } from '../mail.js';
import { accountBalances } from '../domain/reports.js';
import { merchantKey } from '../domain/categorizer.js';
import { seedDemo, resetAll, isEmpty } from '../seed.js';

const bad = (msg, field) => { throw new ValidationError(msg, field); };
const idOf = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n)) { const e = new Error('Not found'); e.status = 404; throw e; } return n; };
const str = (v, max = 300) => (v == null ? '' : String(v).trim().slice(0, max));

const TAX_FIELDS = new Set(BUILTIN_CATEGORIES.map((c) => c.taxField));

export function validateSettings(p) {
  const out = {};
  if (p.profile) {
    const pr = p.profile; const o = {};
    for (const k of ['name', 'tradingName', 'email', 'phone', 'address', 'postcode', 'businessDescription', 'businessPostcode', 'aliases']) if (pr[k] !== undefined) o[k] = str(pr[k], 500);
    if (pr.utr !== undefined) { const u = str(pr.utr).replace(/\s/g, ''); if (u && !/^\d{10}$/.test(u)) bad('A UTR is 10 digits', 'utr'); o.utr = u; }
    if (pr.nino !== undefined) { const n = str(pr.nino).replace(/\s/g, '').toUpperCase(); if (n && !/^[A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]$/.test(n)) bad('A National Insurance number looks like QQ123456C', 'nino'); o.nino = n; }
    if (o.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email)) bad('That email address does not look right', 'email');
    if (pr.region !== undefined) { if (!['england', 'scotland'].includes(pr.region)) bad('Region must be England/Wales/NI or Scotland', 'region'); o.region = pr.region; }
    out.profile = o;
  }
  if (p.accountingBasis !== undefined) { if (!['cash', 'accruals'].includes(p.accountingBasis)) bad('Basis must be cash or accruals', 'accountingBasis'); out.accountingBasis = p.accountingBasis; }
  if (p.businessStartDate !== undefined) { if (p.businessStartDate && !/^\d{4}-\d{2}-\d{2}$/.test(p.businessStartDate)) bad('Use a valid date', 'businessStartDate'); out.businessStartDate = p.businessStartDate || ''; }
  if (p.vat) {
    const v = p.vat; const o = {};
    if (v.registered !== undefined) o.registered = !!v.registered;
    if (v.number !== undefined) o.number = str(v.number, 20);
    if (v.scheme !== undefined) { if (!['standard', 'cash'].includes(v.scheme)) bad('Only the standard and cash accounting VAT schemes are supported', 'scheme'); o.scheme = v.scheme; }
    if (v.stagger !== undefined) { if (![1, 2, 3].includes(Number(v.stagger))) bad('Stagger must be 1, 2 or 3', 'stagger'); o.stagger = Number(v.stagger); }
    out.vat = o;
  }
  if (p.invoice) {
    const i = p.invoice; const o = {};
    for (const k of ['prefix', 'creditPrefix']) if (i[k] !== undefined) o[k] = str(i[k], 12);
    for (const k of ['notes', 'footer', 'bankDetails']) if (i[k] !== undefined) o[k] = str(i[k], 1000);
    for (const k of ['nextNumber', 'nextCreditNumber', 'paymentTermsDays', 'padding']) if (i[k] !== undefined) { const n = Number(i[k]); if (!Number.isInteger(n) || n < 0 || n > 1e6) bad(`${k} must be a whole number`, k); o[k] = n; }
    out.invoice = o;
  }
  if (p.mtd?.quarterlyScheme !== undefined) { if (!['standard', 'calendar'].includes(p.mtd.quarterlyScheme)) bad('Bad quarterly scheme', 'quarterlyScheme'); out.mtd = { quarterlyScheme: p.mtd.quarterlyScheme }; }
  if (p.importer?.autoRecordConfidence !== undefined) { const c = Number(p.importer.autoRecordConfidence); if (!(c >= 0.3 && c <= 1)) bad('Confidence must be between 0.3 and 1', 'autoRecordConfidence'); out.importer = { autoRecordConfidence: c }; }
  if (p.defaultAccountId !== undefined) out.defaultAccountId = p.defaultAccountId ? Number(p.defaultAccountId) : null;
  return out;
}

export default function core(r, { db }) {
  r.get('/meta', (req, res) => {
    const settings = getSettings(db);
    const asOf = today();
    res.json({
      app: 'Ledgerline', version: '0.1.0', today: asOf, currentTaxYear: currentTaxYear(), settings,
      taxYears: SUPPORTED_TAX_YEARS.map((y) => ({ label: y, status: TAX_YEAR_DATA[y].status, notes: TAX_YEAR_DATA[y].notes || [] })),
      categories: db.all('SELECT * FROM categories ORDER BY sort, name'), sections: SECTION_LABELS,
      accounts: accountBalances(db), vatCodes: Object.values(VAT_RATES), thresholds: THRESHOLDS,
      mailConfigured: mailConfigured(),
      counts: {
        review: db.get("SELECT COUNT(*) AS n FROM transactions WHERE status = 'review'").n,
        uncategorised: db.get('SELECT COUNT(*) AS n FROM transactions WHERE category_id IS NULL').n,
        overdue: listInvoices(db, { status: 'overdue' }, asOf).length,
      },
    });
  });

  r.get('/settings', (req, res) => res.json(getSettings(db)));
  r.put('/settings', (req, res) => {
    const patch = validateSettings(req.body || {});
    const s = saveSettings(db, patch);
    audit(db, 'settings', 'app', 'update', Object.keys(patch));
    res.json(s);
  });

  // ---- accounts
  r.get('/accounts', (req, res) => res.json(accountBalances(db)));
  r.post('/accounts', (req, res) => {
    const name = str(req.body.name, 80); if (!name) bad('Give the account a name', 'name');
    const kind = ['bank', 'cash', 'card', 'paypal', 'other'].includes(req.body.kind) ? req.body.kind : 'bank';
    const id = db.run('INSERT INTO accounts (name, kind, opening_balance) VALUES (?, ?, ?)', name, kind, Math.round(Number(req.body.opening_balance) || 0)).id;
    res.status(201).json(db.get('SELECT * FROM accounts WHERE id = ?', id));
  });
  r.put('/accounts/:id', (req, res) => {
    const id = idOf(req);
    const cur = db.get('SELECT * FROM accounts WHERE id = ?', id); if (!cur) return res.status(404).json({ error: 'Account not found' });
    db.run('UPDATE accounts SET name = ?, kind = ?, opening_balance = ? WHERE id = ?', str(req.body.name ?? cur.name, 80) || cur.name, req.body.kind ?? cur.kind, Math.round(Number(req.body.opening_balance ?? cur.opening_balance) || 0), id);
    res.json(db.get('SELECT * FROM accounts WHERE id = ?', id));
  });
  r.delete('/accounts/:id', (req, res) => {
    const id = idOf(req);
    const n = db.get('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?', id).n;
    if (n) { db.run('UPDATE accounts SET archived = 1 WHERE id = ?', id); return res.json({ archived: true }); }
    db.run('DELETE FROM accounts WHERE id = ?', id); res.json({ deleted: true });
  });

  // ---- contacts
  r.get('/contacts', (req, res) => {
    const q = str(req.query.q); const kind = req.query.kind;
    const rows = db.all(`SELECT * FROM contacts WHERE archived = 0 ${q ? 'AND (name LIKE ? OR email LIKE ?)' : ''} ${kind ? "AND kind IN (?, 'both')" : ''} ORDER BY name`, ...(q ? [`%${q}%`, `%${q}%`] : []), ...(kind ? [kind] : []));
    const invs = listInvoices(db, {});
    res.json(rows.map((c) => {
      const mine = invs.filter((i) => i.contact_id === c.id && i.status !== 'void' && i.status !== 'draft' && i.kind === 'invoice');
      return { ...c, invoiced: mine.reduce((a, i) => a + i.totals.gross, 0), outstanding: mine.reduce((a, i) => a + Math.max(0, i.outstanding), 0), invoiceCount: mine.length };
    }));
  });
  const contactFields = (b, cur = {}) => {
    const name = str(b.name ?? cur.name, 120); if (!name) bad('Name is required', 'name');
    const email = str(b.email ?? cur.email, 200); if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad('That email address does not look right', 'email');
    const terms = b.payment_terms_days ?? cur.payment_terms_days; const t = terms === '' || terms == null ? null : Number(terms);
    if (t != null && (!Number.isInteger(t) || t < 0 || t > 365)) bad('Payment terms are a number of days', 'payment_terms_days');
    return [name, ['customer', 'supplier', 'both'].includes(b.kind ?? cur.kind) ? (b.kind ?? cur.kind) : 'customer', email || null, str(b.phone ?? cur.phone, 40) || null, str(b.address ?? cur.address, 400) || null, str(b.vat_number ?? cur.vat_number, 20) || null, str(b.notes ?? cur.notes, 1000) || null, t];
  };
  r.post('/contacts', (req, res) => {
    const f = contactFields(req.body);
    const id = db.run('INSERT INTO contacts (name, kind, email, phone, address, vat_number, notes, payment_terms_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ...f).id;
    res.status(201).json(db.get('SELECT * FROM contacts WHERE id = ?', id));
  });
  r.put('/contacts/:id', (req, res) => {
    const id = idOf(req); const cur = db.get('SELECT * FROM contacts WHERE id = ?', id); if (!cur) return res.status(404).json({ error: 'Contact not found' });
    db.run('UPDATE contacts SET name = ?, kind = ?, email = ?, phone = ?, address = ?, vat_number = ?, notes = ?, payment_terms_days = ? WHERE id = ?', ...contactFields(req.body, cur), id);
    res.json(db.get('SELECT * FROM contacts WHERE id = ?', id));
  });
  r.delete('/contacts/:id', (req, res) => {
    const id = idOf(req);
    const used = db.get('SELECT (SELECT COUNT(*) FROM invoices WHERE contact_id = ?) + (SELECT COUNT(*) FROM transactions WHERE contact_id = ?) AS n', id, id).n;
    if (used) { db.run('UPDATE contacts SET archived = 1 WHERE id = ?', id); return res.json({ archived: true }); }
    db.run('DELETE FROM contacts WHERE id = ?', id); res.json({ deleted: true });
  });

  // ---- categories (built-ins are fixed; you can add your own mapped to a tax box)
  r.get('/categories', (req, res) => res.json(db.all('SELECT * FROM categories ORDER BY sort, name')));
  r.post('/categories', (req, res) => {
    const name = str(req.body.name, 80); if (!name) bad('Name is required', 'name');
    const kind = req.body.kind; if (!['income', 'expense', 'capital', 'other'].includes(kind)) bad('Choose income or expense', 'kind');
    const taxField = req.body.tax_field; if (!TAX_FIELDS.has(taxField)) bad('Choose which tax box this feeds into', 'tax_field');
    const base = BUILTIN_CATEGORIES.find((c) => c.taxField === taxField);
    const id = `custom_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30)}_${Date.now().toString(36).slice(-4)}`;
    db.run('INSERT INTO categories (id, name, kind, section, tax_field, allowable, builtin, sort) VALUES (?, ?, ?, ?, ?, 1, 0, 1000)', id, name, kind, base?.section || 'none', taxField);
    res.status(201).json(db.get('SELECT * FROM categories WHERE id = ?', id));
  });
  r.put('/categories/:id', (req, res) => {
    const cur = db.get('SELECT * FROM categories WHERE id = ?', req.params.id); if (!cur) return res.status(404).json({ error: 'Not found' });
    if (cur.builtin) bad('Built-in categories cannot be edited. Add your own category instead.');
    db.run('UPDATE categories SET name = ? WHERE id = ?', str(req.body.name, 80) || cur.name, cur.id);
    res.json(db.get('SELECT * FROM categories WHERE id = ?', cur.id));
  });
  r.delete('/categories/:id', (req, res) => {
    const cur = db.get('SELECT * FROM categories WHERE id = ?', req.params.id); if (!cur) return res.status(404).json({ error: 'Not found' });
    if (cur.builtin) bad('Built-in categories cannot be deleted.');
    if (db.get('SELECT COUNT(*) AS n FROM transactions WHERE category_id = ?', cur.id).n) bad('This category is used by transactions. Re-categorise them first.');
    db.run('DELETE FROM rules WHERE category_id = ?', cur.id); db.run('DELETE FROM categories WHERE id = ?', cur.id); res.json({ deleted: true });
  });

  // ---- rules
  r.get('/rules', (req, res) => res.json(db.all('SELECT r.*, c.name AS category_name FROM rules r JOIN categories c ON c.id = r.category_id ORDER BY priority, id')));
  const ruleFields = (b) => {
    const pattern = str(b.pattern, 120); if (pattern.length < 2) bad('Enter the text to look for (at least 2 characters)', 'pattern');
    const match = ['contains', 'starts', 'exact', 'regex'].includes(b.match_type) ? b.match_type : 'contains';
    if (match === 'regex') { try { new RegExp(pattern); } catch { bad('That is not a valid pattern', 'pattern'); } }
    if (!db.get('SELECT 1 AS x FROM categories WHERE id = ?', b.category_id)) bad('Choose a category', 'category_id');
    const pct = b.business_pct == null ? 100 : Number(b.business_pct); if (!Number.isInteger(pct) || pct < 0 || pct > 100) bad('Business use is 0–100%', 'business_pct');
    return [pattern, match, ['in', 'out', 'any'].includes(b.direction) ? b.direction : 'any', b.category_id, b.contact_id || null, pct, Number(b.priority) || 100];
  };
  r.post('/rules', (req, res) => { const id = db.run('INSERT INTO rules (pattern, match_type, direction, category_id, contact_id, business_pct, priority) VALUES (?, ?, ?, ?, ?, ?, ?)', ...ruleFields(req.body)).id; res.status(201).json(db.get('SELECT * FROM rules WHERE id = ?', id)); });
  r.put('/rules/:id', (req, res) => { const id = idOf(req); db.run('UPDATE rules SET pattern = ?, match_type = ?, direction = ?, category_id = ?, contact_id = ?, business_pct = ?, priority = ? WHERE id = ?', ...ruleFields(req.body), id); res.json(db.get('SELECT * FROM rules WHERE id = ?', id)); });
  r.delete('/rules/:id', (req, res) => { db.run('DELETE FROM rules WHERE id = ?', idOf(req)); res.json({ deleted: true }); });
  r.post('/rules/from-transaction/:id', (req, res) => {
    const t = db.get('SELECT * FROM transactions WHERE id = ?', idOf(req)); if (!t) return res.status(404).json({ error: 'Transaction not found' });
    if (!t.category_id) bad('Categorise the transaction first');
    const key = merchantKey(t.description) || t.description.slice(0, 20);
    const id = db.run('INSERT INTO rules (pattern, match_type, direction, category_id, business_pct, priority) VALUES (?, ?, ?, ?, ?, ?)', key, 'contains', t.amount > 0 ? 'in' : 'out', t.category_id, t.business_pct, 100).id;
    const applied = db.run("UPDATE transactions SET category_id = ?, business_pct = ?, status = 'confirmed' WHERE category_id IS NULL AND LOWER(description) LIKE ? AND (amount > 0) = ?", t.category_id, t.business_pct, `%${key}%`, t.amount > 0 ? 1 : 0).changes;
    res.status(201).json({ rule: db.get('SELECT * FROM rules WHERE id = ?', id), applied });
  });

  // ---- demo data / reset
  r.post('/demo/load', (req, res) => res.status(201).json(seedDemo(db)));
  r.post('/admin/reset', (req, res) => {
    if (req.body?.confirm !== 'DELETE') bad('Type DELETE to confirm.');
    resetAll(db); audit(db, 'admin', 'all', 'reset');
    res.json({ ok: true, empty: isEmpty(db) });
  });

  // ---- backup / export
  r.get('/backup', (req, res) => {
    const tmp = path.join(os.tmpdir(), `ledgerline-backup-${Date.now()}.sqlite`);
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    res.download(tmp, `ledgerline-backup-${today()}.sqlite`, () => fs.rm(tmp, { force: true }, () => {}));
  });
  r.get('/export/json', (req, res) => {
    const dump = {};
    for (const t of ['accounts', 'contacts', 'categories', 'rules', 'transactions', 'invoices', 'invoice_lines', 'recurring_templates', 'assets', 'mileage', 'disposals', 'tax_inputs', 'vat_returns']) dump[t] = db.all(`SELECT * FROM ${t}`);
    dump.settings = getSettings(db); dump.exportedAt = new Date().toISOString();
    res.setHeader('Content-Disposition', `attachment; filename="ledgerline-export-${today()}.json"`);
    res.json(dump);
  });
  void DATA_DIR;
}
