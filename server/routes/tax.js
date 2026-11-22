import { getSettings, setTaxInput, getTaxInput } from '../db.js';
import { ValidationError } from '../domain/invoices.js';
import { buildTaxReturn, DEFAULT_INPUTS, loadInputs } from '../domain/taxReturn.js';
import { taxYearEntries } from '../domain/ledger.js';
import { capitalAllowances, POOLS } from '../domain/capitalAllowances.js';
import { listTransactions } from '../domain/transactions.js';
import { worksheetPdf } from '../pdf/documents.js';
import { SUPPORTED_TAX_YEARS } from '../domain/taxRates.js';
import { isISO, isTaxYearLabel, taxYearRange, fmtDate } from '../util/dates.js';

const idOf = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n)) { const e = new Error('Not found'); e.status = 404; throw e; } return n; };
const bad = (m, f) => { throw new ValidationError(m, f); };
const yearOf = (req) => {
  const y = req.params.year;
  if (!isTaxYearLabel(y) || !SUPPORTED_TAX_YEARS.includes(y)) bad(`Tax year ${y} is not supported. Supported: ${SUPPORTED_TAX_YEARS.join(', ')}`);
  return y;
};
const int = (v, name, { min = 0 } = {}) => { const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < min) bad(`${name} must be a number${min === 0 ? ' (zero or more)' : ''}`, name); return n; };

// Validators for each tax-input key: return the cleaned value or throw.
const INPUT_VALIDATORS = {
  employment: (v) => { if (!Array.isArray(v) || v.length > 20) bad('Employment must be a list', 'employment'); return v.map((e) => ({ employer: String(e.employer || '').slice(0, 100), payeRef: String(e.payeRef || '').slice(0, 30), pay: int(e.pay || 0, 'pay'), tax: int(e.tax || 0, 'tax'), benefits: int(e.benefits || 0, 'benefits'), expenses: int(e.expenses || 0, 'expenses') })); },
  pensions: (v) => ({ pay: int(v?.pay || 0, 'pension income'), tax: int(v?.tax || 0, 'pension tax') }),
  otherIncome: (v) => ({ amount: int(v?.amount || 0, 'other income'), tax: int(v?.tax || 0, 'tax') }),
  studentLoan: (v) => { if (!['none', 'plan1', 'plan2', 'plan4', 'plan5'].includes(v?.plan || 'none')) bad('Unknown student loan plan', 'plan'); return { plan: v.plan || 'none', postgrad: !!v.postgrad, paidViaPaye: int(v.paidViaPaye || 0, 'repaid through PAYE') }; },
  marriageAllowance: (v) => { if (!['none', 'give', 'receive'].includes(v)) bad('Marriage Allowance must be none, give or receive'); return v; },
  tradingAllowance: (v) => { if (!['auto', 'claim', 'no'].includes(v)) bad('Bad trading allowance option'); return v; },
  propertyAllowance: (v) => { if (!['auto', 'claim', 'no'].includes(v)) bad('Bad property allowance option'); return v; },
  payments: (v) => { if (!Array.isArray(v) || v.length > 50) bad('Payments must be a list'); return v.map((p) => { if (!isISO(p.date)) bad('Each payment needs a valid date', 'payments'); return { date: p.date, amount: int(p.amount, 'payment amount', { min: 1 }), note: String(p.note || '').slice(0, 100) }; }); },
  capitalPoolsBF: (v) => (v == null ? null : { main: int(v.main || 0, 'main pool'), special: int(v.special || 0, 'special pool') }),
  homeOfficeHours: (v) => { const o = {}; for (const [k, h] of Object.entries(v || {})) { if (!/^\d{4}-\d{2}$/.test(k)) bad('Bad month'); const n = Number(h); if (!Number.isFinite(n) || n < 0 || n > 744) bad('Hours per month must be 0–744'); o[k] = n; } return o; },
  quarterlySubmitted: (v) => v || {},
  notes: (v) => String(v || '').slice(0, 5000),
};
const MONEY_KEYS = ['interestManual', 'dividendsManual', 'giftAidManual', 'pensionRasManual', 'childBenefit', 'cisDeducted', 'otherTaxDeducted', 'seLossesBF', 'propLossesBF', 'propFinanceBF', 'cgtLossesBF', 'seOwnUse', 'seOtherAdjustments'];

export default function tax(r, { db }) {
  r.get('/tax/:year', (req, res) => {
    const t = buildTaxReturn(db, yearOf(req));
    res.json({ ...t, entriesCount: t.counts.entries });
  });

  r.put('/tax/:year/inputs', (req, res) => {
    const y = yearOf(req); const body = req.body || {};
    db.tx(() => {
      for (const [k, v] of Object.entries(body)) {
        if (INPUT_VALIDATORS[k]) setTaxInput(db, y, k, INPUT_VALIDATORS[k](v));
        else if (MONEY_KEYS.includes(k)) setTaxInput(db, y, k, k === 'seOtherAdjustments' ? Math.round(Number(v) || 0) : int(v || 0, k));
        else if (!(k in DEFAULT_INPUTS)) bad(`Unknown input "${k}"`);
      }
    });
    res.json(loadInputs(db, y));
  });
  r.get('/tax/:year/inputs', (req, res) => res.json({ ...loadInputs(db, yearOf(req)), homeOfficeHours: getTaxInput(db, yearOf(req), 'homeOfficeHours', {}) }));

  r.put('/tax/:year/quarterly/:n', (req, res) => {
    const y = yearOf(req); const n = Number(req.params.n);
    if (![1, 2, 3, 4].includes(n)) bad('Quarter must be 1–4');
    const cur = getTaxInput(db, y, 'quarterlySubmitted', {}) || {};
    if (req.body?.submitted) cur[n] = new Date().toISOString().slice(0, 10); else delete cur[n];
    setTaxInput(db, y, 'quarterlySubmitted', cur);
    res.json(cur);
  });

  // The transactions behind one figure on a form (drill-down / audit trail).
  r.get('/tax/:year/drill', (req, res) => {
    const y = yearOf(req); const field = String(req.query.field || '');
    const { entries } = taxYearEntries(db, y);
    const rows = entries.filter((e) => e.taxField === field || (field === 'se.other' && e.kind === 'capital'));
    res.json({ field, total: rows.reduce((a, e) => a + e.net, 0), rows: rows.sort((a, b) => (a.date < b.date ? -1 : 1)) });
  });

  // Payments to HMRC found in the bank data, to attach to a tax year.
  r.get('/tax/:year/hmrc-payments', (req, res) => {
    const y = yearOf(req); const { start } = taxYearRange(y);
    const from = `${Number(start.slice(0, 4))}-04-06`; const to = `${Number(start.slice(0, 4)) + 2}-03-31`;
    res.json(listTransactions(db, { categoryId: 'hmrc_payment', from, to, limit: 200 }).rows.filter((t) => t.amount < 0).map((t) => ({ id: t.id, date: t.date, amount: -t.amount, description: t.description })));
  });

  // ---- worksheets as PDF
  r.get('/tax/:year/pdf', async (req, res) => {
    const y = yearOf(req);
    const t = buildTaxReturn(db, y);
    const only = req.query.form;
    const forms = only && only !== 'all' ? t.forms.filter((f) => f.id === only) : t.forms;
    if (!forms.length) bad('Unknown form');
    const s = getSettings(db);
    const pdf = await worksheetPdf({
      title: `Self Assessment ${y} – return worksheets`, subtitle: `${s.profile.name || ''}${s.profile.utr ? ' · UTR ' + s.profile.utr : ''} · ${fmtDate(t.period.start)} to ${fmtDate(t.period.end)}${t.status === 'provisional' ? ' · PROVISIONAL RATES' : ''}`,
      warnings: t.warnings.filter((w) => w.level !== 'info'), forms,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="self-assessment-${y}${only && only !== 'all' ? '-' + only : ''}.pdf"`);
    res.send(pdf);
  });
  r.get('/tax/:year/export.json', (req, res) => {
    const t = buildTaxReturn(db, yearOf(req));
    res.setHeader('Content-Disposition', `attachment; filename="self-assessment-${req.params.year}.json"`);
    res.json({ taxYear: t.taxYear, status: t.status, generated: new Date().toISOString(), forms: t.forms, calculation: t.calc });
  });

  // ---- capital allowances / assets
  r.get('/tax/:year/capital-allowances', (req, res) => res.json({ ...capitalAllowances(db, yearOf(req)), pools: undefined, poolsDetail: capitalAllowances(db, yearOf(req)).pools, poolTypes: POOLS }));
  r.get('/assets', (req, res) => res.json(db.all('SELECT * FROM assets ORDER BY purchase_date DESC')));
  const assetFields = (b) => {
    const name = String(b.name || '').trim(); if (!name) bad('Name the asset', 'name');
    if (!isISO(b.purchase_date)) bad('Purchase date must be a valid date', 'purchase_date');
    if (!Object.keys(POOLS).includes(b.pool)) bad('Choose the type of asset', 'pool');
    const pct = b.business_pct == null ? 100 : Number(b.business_pct); if (!Number.isInteger(pct) || pct < 1 || pct > 100) bad('Business use is 1–100%', 'business_pct');
    if (b.disposal_date && !isISO(b.disposal_date)) bad('Disposal date must be a valid date', 'disposal_date');
    return [name, b.purchase_date, int(b.cost, 'cost', { min: 1 }), b.pool, pct, b.disposal_date || null, b.disposal_date ? int(b.disposal_proceeds || 0, 'proceeds') : null, String(b.notes || '').slice(0, 300) || null, b.txn_id || null];
  };
  r.post('/assets', (req, res) => { const id = db.run('INSERT INTO assets (name, purchase_date, cost, pool, business_pct, disposal_date, disposal_proceeds, notes, txn_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ...assetFields(req.body || {})).id; res.status(201).json(db.get('SELECT * FROM assets WHERE id = ?', id)); });
  r.put('/assets/:id', (req, res) => { const id = idOf(req); db.run('UPDATE assets SET name = ?, purchase_date = ?, cost = ?, pool = ?, business_pct = ?, disposal_date = ?, disposal_proceeds = ?, notes = ?, txn_id = ? WHERE id = ?', ...assetFields(req.body || {}), id); res.json(db.get('SELECT * FROM assets WHERE id = ?', id)); });
  r.delete('/assets/:id', (req, res) => { db.run('DELETE FROM assets WHERE id = ?', idOf(req)); res.json({ deleted: true }); });

  // ---- mileage
  r.get('/mileage', (req, res) => { const y = req.query.taxYear; const w = y && isTaxYearLabel(y) ? taxYearRange(y) : null; res.json(db.all(`SELECT * FROM mileage ${w ? 'WHERE date BETWEEN ? AND ?' : ''} ORDER BY date DESC, id DESC`, ...(w ? [w.start, w.end] : []))); });
  const mileageFields = (b) => {
    if (!isISO(b.date)) bad('Date must be valid', 'date');
    const miles = Number(b.miles); if (!(miles > 0 && miles < 10000)) bad('Miles must be between 0 and 10,000', 'miles');
    return [b.date, String(b.from_place || '').slice(0, 80), String(b.to_place || '').slice(0, 80), String(b.purpose || '').slice(0, 120), miles, ['car', 'motorcycle', 'bicycle'].includes(b.vehicle) ? b.vehicle : 'car'];
  };
  r.post('/mileage', (req, res) => { const id = db.run('INSERT INTO mileage (date, from_place, to_place, purpose, miles, vehicle) VALUES (?, ?, ?, ?, ?, ?)', ...mileageFields(req.body || {})).id; res.status(201).json(db.get('SELECT * FROM mileage WHERE id = ?', id)); });
  r.put('/mileage/:id', (req, res) => { const id = idOf(req); db.run('UPDATE mileage SET date = ?, from_place = ?, to_place = ?, purpose = ?, miles = ?, vehicle = ? WHERE id = ?', ...mileageFields(req.body || {}), id); res.json(db.get('SELECT * FROM mileage WHERE id = ?', id)); });
  r.delete('/mileage/:id', (req, res) => { db.run('DELETE FROM mileage WHERE id = ?', idOf(req)); res.json({ deleted: true }); });

  // ---- capital gains disposals
  r.get('/disposals', (req, res) => { const y = req.query.taxYear; const w = y && isTaxYearLabel(y) ? taxYearRange(y) : null; res.json(db.all(`SELECT * FROM disposals ${w ? 'WHERE disposal_date BETWEEN ? AND ?' : ''} ORDER BY disposal_date DESC`, ...(w ? [w.start, w.end] : []))); });
  const disposalFields = (b) => {
    const description = String(b.description || '').trim(); if (!description) bad('Describe what was sold', 'description');
    if (!isISO(b.disposal_date)) bad('Disposal date must be valid', 'disposal_date');
    if (b.acquired_date && !isISO(b.acquired_date)) bad('Acquisition date must be valid', 'acquired_date');
    return [description, ['shares', 'property', 'crypto', 'other'].includes(b.asset_type) ? b.asset_type : 'other', b.acquired_date || null, b.disposal_date, int(b.proceeds, 'proceeds'), int(b.cost || 0, 'cost'), int(b.costs || 0, 'costs'), b.residential ? 1 : 0, String(b.notes || '').slice(0, 300) || null];
  };
  r.post('/disposals', (req, res) => { const id = db.run('INSERT INTO disposals (description, asset_type, acquired_date, disposal_date, proceeds, cost, costs, residential, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ...disposalFields(req.body || {})).id; res.status(201).json(db.get('SELECT * FROM disposals WHERE id = ?', id)); });
  r.put('/disposals/:id', (req, res) => { const id = idOf(req); db.run('UPDATE disposals SET description = ?, asset_type = ?, acquired_date = ?, disposal_date = ?, proceeds = ?, cost = ?, costs = ?, residential = ?, notes = ? WHERE id = ?', ...disposalFields(req.body || {}), id); res.json(db.get('SELECT * FROM disposals WHERE id = ?', id)); });
  r.delete('/disposals/:id', (req, res) => { db.run('DELETE FROM disposals WHERE id = ?', idOf(req)); res.json({ deleted: true }); });
}
