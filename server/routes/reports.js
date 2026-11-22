import { getSettings } from '../db.js';
import { profitAndLoss, monthlySeries, dashboard, quarterlyUpdates, accountBalances } from '../domain/reports.js';
import { vatReturn, vatPeriods, vatThresholdCheck } from '../domain/vat.js';
import { ValidationError } from '../domain/invoices.js';
import { worksheetPdf } from '../pdf/documents.js';
import { isISO, isTaxYearLabel, currentTaxYear, taxYearRange, today, fmtDate } from '../util/dates.js';
import { fmtGBP } from '../util/money.js';

const year = (req) => { const y = req.query.taxYear || currentTaxYear(); if (!isTaxYearLabel(y)) throw new ValidationError('Tax year should look like 2025-26', 'taxYear'); return y; };
const range = (req) => {
  if (req.query.taxYear) return { taxYear: year(req) };
  const { from, to } = req.query;
  if (!isISO(from) || !isISO(to)) throw new ValidationError('Choose a valid date range');
  if (to < from) throw new ValidationError('The end date is before the start date');
  return { from, to };
};

export function vatWorksheet(v, settings) {
  const b = v.boxes;
  return {
    title: 'VAT return worksheet', subtitle: `Period ${fmtDate(v.from)} to ${fmtDate(v.to)} · ${v.scheme === 'cash' ? 'Cash accounting scheme' : 'Standard accounting'} · due ${fmtDate(v.dueDate)}`, warnings: v.estimatedVatCount ? [{ level: 'warn', text: `${v.estimatedVatCount} item(s) have no VAT code. They are included at face value with no VAT. Check them before filing.` }] : [],
    forms: [{ id: 'VAT100', title: `VAT return${settings.vat.number ? ' – VAT no. ' + settings.vat.number : ''}`, applies: true, pages: [{ title: 'The nine boxes', rows: [
      { type: 'money', box: '1', label: 'VAT due on sales and other outputs', value: b.box1 },
      { type: 'money', box: '2', label: 'VAT due on acquisitions from EU member states (Northern Ireland only)', value: b.box2 },
      { type: 'money', box: '3', label: 'Total VAT due (box 1 + box 2)', value: b.box3, emphasis: true },
      { type: 'money', box: '4', label: 'VAT reclaimed on purchases and other inputs', value: b.box4 },
      { type: 'money', box: '5', label: v.position === 'payable' ? 'Net VAT to pay HMRC' : 'Net VAT to reclaim from HMRC', value: Math.abs(b.box5), emphasis: true },
      { type: 'money', box: '6', label: 'Total value of sales and all other outputs, excluding VAT (whole pounds)', value: b.box6 },
      { type: 'money', box: '7', label: 'Total value of purchases and all other inputs, excluding VAT (whole pounds)', value: b.box7 },
      { type: 'money', box: '8', label: 'Total value of supplies to EU member states (NI goods)', value: b.box8 },
      { type: 'money', box: '9', label: 'Total value of acquisitions from EU member states (NI goods)', value: b.box9 },
    ] }] }],
  };
}

export default function reports(r, { db }) {
  r.get('/reports/dashboard', (req, res) => res.json(dashboard(db, year(req))));
  r.get('/reports/pnl', (req, res) => res.json(profitAndLoss(db, range(req))));
  r.get('/reports/monthly', (req, res) => { const { start, end } = taxYearRange(year(req)); res.json(monthlySeries(db, req.query.from || start, req.query.to || end, { taxMonths: !req.query.from })); });
  r.get('/reports/accounts', (req, res) => res.json(accountBalances(db)));

  // ---- VAT
  r.get('/reports/vat/periods', (req, res) => { const s = getSettings(db); res.json({ registered: s.vat.registered, periods: vatPeriods(s.vat.stagger || 1, today(), 8), threshold: vatThresholdCheck(db) }); });
  r.get('/reports/vat', (req, res) => {
    const { from, to } = req.query; if (!isISO(from) || !isISO(to) || to < from) throw new ValidationError('Choose a valid VAT period');
    const v = vatReturn(db, from, to);
    const filed = db.get('SELECT * FROM vat_returns WHERE period_start = ? AND period_end = ?', from, to);
    res.json({ ...v, filed: filed ? { at: filed.filed_at, reference: filed.reference, boxes: JSON.parse(filed.boxes) } : null });
  });
  r.get('/reports/vat/pdf', async (req, res) => {
    const { from, to } = req.query; if (!isISO(from) || !isISO(to)) throw new ValidationError('Choose a valid VAT period');
    const s = getSettings(db);
    const pdf = await worksheetPdf(vatWorksheet(vatReturn(db, from, to), s));
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `inline; filename="vat-${from}-to-${to}.pdf"`); res.send(pdf);
  });
  r.get('/reports/vat/filed', (req, res) => res.json(db.all('SELECT id, period_start, period_end, filed_at, reference, boxes FROM vat_returns ORDER BY period_end DESC').map((x) => ({ ...x, boxes: JSON.parse(x.boxes) }))));
  r.post('/reports/vat/filed', (req, res) => {
    const { from, to, reference } = req.body || {}; if (!isISO(from) || !isISO(to)) throw new ValidationError('Choose a valid VAT period');
    const v = vatReturn(db, from, to);
    db.run('DELETE FROM vat_returns WHERE period_start = ? AND period_end = ?', from, to);
    db.run("INSERT INTO vat_returns (period_start, period_end, boxes, filed_at, reference) VALUES (?, ?, ?, datetime('now'), ?)", from, to, JSON.stringify(v.boxes), String(reference || '').slice(0, 60));
    res.status(201).json({ ok: true });
  });
  r.delete('/reports/vat/filed', (req, res) => { db.run('DELETE FROM vat_returns WHERE period_start = ? AND period_end = ?', req.query.from, req.query.to); res.json({ ok: true }); });

  // ---- Making Tax Digital quarterly updates
  r.get('/reports/quarterly', (req, res) => res.json(quarterlyUpdates(db, year(req), req.query.scheme)));
  void fmtGBP;
}
