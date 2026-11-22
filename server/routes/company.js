import { getSettings, setTaxInput } from '../db.js';
import { ValidationError } from '../domain/invoices.js';
import { companyOverview, companyPeriods, currentPeriod, earliestActivityDate, declareDividend, deleteDividend, listDividends, directorDividendSummary, trialBalance, trialBalanceCsv, CT_INPUT_KEYS, findPeriod, distributableReserves, syncAssets } from '../domain/company.js';
import { worksheetPdf, dividendPackPdf } from '../pdf/documents.js';
import { fmtDate, isISO, isTaxYearLabel } from '../util/dates.js';

const bad = (m, f) => { throw new ValidationError(m, f); };
const periodKey = (req) => { const k = req.query.period; if (k && !/^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/.test(k)) bad('Bad period', 'period'); return k; };
const requireCompany = (db) => { const s = getSettings(db); if (s.entityType !== 'company') bad('Switch to a limited company in Settings first.'); return s; };

export default function company(r, { db }) {
  r.get('/company/periods', (req, res) => {
    const s = requireCompany(db);
    const periods = companyPeriods(s, { firstDate: earliestActivityDate(db) });
    res.json({ periods, current: currentPeriod(s, { firstDate: earliestActivityDate(db) }).key });
  });

  r.get('/company/overview', (req, res) => res.json(companyOverview(db, periodKey(req))));

  r.put('/company/inputs', (req, res) => {
    const s = requireCompany(db);
    const period = findPeriod(s, periodKey(req) || undefined, { firstDate: earliestActivityDate(db) });
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!CT_INPUT_KEYS.includes(k)) bad(`Unknown input ${k}`);
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || (k !== 'ctOtherAdjustments' && n < 0)) bad(`${k} must be a number`, k);
      if (k === 'associatedCompanies' && (n < 0 || n > 50)) bad('Associated companies must be 0–50', k);
      setTaxInput(db, period.key, k, n);
    }
    res.json(companyOverview(db, period.key).inputs);
  });

  r.get('/company/pdf', async (req, res) => {
    const s = requireCompany(db);
    const ov = companyOverview(db, periodKey(req));
    const pack = req.query.pack || 'all';
    const ids = { accounts: ['ACCOUNTS', 'BALANCE'], computation: ['COMPUTATION'], ct600: ['CT600', 'CT600A'], all: ['ACCOUNTS', 'BALANCE', 'COMPUTATION', 'CT600', 'CT600A'] }[pack];
    if (!ids) bad('Unknown pack');
    const pdf = await worksheetPdf({
      title: `${s.company.name || 'Company'} – ${ov.period.label}`, subtitle: `Draft accounts, tax computation and CT600 figures · ${fmtDate(ov.period.start)} to ${fmtDate(ov.period.end)}`,
      warnings: ov.warnings.filter((w) => w.level !== 'info'), forms: ov.forms.filter((f) => ids.includes(f.id)),
      footer: 'Prepared by Ledgerline from your records. Draft only: not filed with HMRC or Companies House. Statutory accounts and the CT600 must be filed in iXBRL format using HMRC-recognised software or by an accountant. Check every figure before relying on it.',
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="company-${pack}-${ov.period.end}.pdf"`);
    res.send(pdf);
  });

  r.get('/company/trial-balance.csv', (req, res) => {
    const s = requireCompany(db);
    const ov = companyOverview(db, periodKey(req));
    const tb = trialBalance(db, s, ov.period, { pnl: ov.pnl, ct: ov.ct, bs: ov.balanceSheet });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="trial-balance-${ov.period.end}.csv"`);
    res.send(trialBalanceCsv(tb, ov.period));
  });

  // ---- dividends
  r.get('/company/dividends', (req, res) => { requireCompany(db); res.json(listDividends(db)); });
  r.get('/company/dividends/reserves', (req, res) => { const s = requireCompany(db); const d = isISO(req.query.date) ? req.query.date : new Date().toISOString().slice(0, 10); res.json(distributableReserves(db, s, d)); });
  r.post('/company/dividends', (req, res) => {
    const s = requireCompany(db);
    try { res.status(201).json(declareDividend(db, s, req.body || {})); }
    catch (e) { if (e.code === 'insufficient_reserves') return res.status(409).json({ error: e.message, code: e.code, reserves: e.reserves, field: e.field }); throw e; }
  });
  r.delete('/company/dividends/:id', (req, res) => { requireCompany(db); deleteDividend(db, Number(req.params.id)); res.json({ deleted: true }); });
  r.get('/company/dividends/:id/pack.pdf', async (req, res) => {
    const s = requireCompany(db);
    const d = listDividends(db).find((x) => x.id === Number(req.params.id));
    if (!d) return res.status(404).json({ error: 'Dividend not found' });
    const pdf = await dividendPackPdf({ company: s.company, dividend: d, reserves: distributableReserves(db, s, d.declared_date) });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="dividend-${d.paid_date}.pdf"`);
    res.send(pdf);
  });
  r.get('/company/director-summary', (req, res) => {
    const s = requireCompany(db);
    const y = req.query.taxYear; if (!isTaxYearLabel(y)) bad('Tax year should look like 2025-26', 'taxYear');
    const other = {}; for (const [k, v] of Object.entries(req.query)) { const m = k.match(/^other_(.+)$/); if (m) other[m[1]] = Math.round(Number(v) || 0); }
    res.json(directorDividendSummary(db, s, y, other));
  });
  r.post('/company/sync-assets', (req, res) => { const s = requireCompany(db); res.json({ added: syncAssets(db, s) }); });
}
