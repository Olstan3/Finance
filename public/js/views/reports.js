import { useState } from 'preact/hooks';
import { html, Btn, Badge, Notice, Empty, Loading, useAsync, Tabs, TaxYearSelect, Modal, Field } from '../components/ui.js';
import { PageHead } from '../components/shared.js';
import { api, qs } from '../api.js';
import { useStore, toast, toastError, setTaxYear, selection } from '../store.js';
import { gbp, fmtDate } from '../util.js';
import { go } from '../main.js';

function PnL({ year }) {
  const { data: p, error, loading, reload } = useAsync(() => api.get(`/api/reports/pnl?taxYear=${year}`), [year]);
  if (error && !p) return html`<${Loading} error=${error} retry=${reload} />`;
  if (!p) return html`<${Loading} />`;
  const rows = (list, tone) => list.map((r) => html`<tr><td><a href=${`#/transactions${qs({ categoryId: r.category_id, taxYear: year })}`} style="color:inherit">${r.name}</a></td><td class="num">${r.count}</td><td class="num">${gbp(r.amount)}</td></tr>`);
  return html`<div style=${loading ? 'opacity:.6' : ''}>
    ${(p.uncategorised > 0) && html`<${Notice} tone="warn"><a href=${`#/transactions?uncategorised=1&taxYear=${year}`}>${p.uncategorised} uncategorised transaction${p.uncategorised > 1 ? 's' : ''}</a> are not included below.</${Notice}>`}
    <p class="muted small">${fmtDate(p.from)} to ${fmtDate(p.to)} · ${p.basis === 'accruals' ? 'Accruals basis (income counted when invoiced)' : 'Cash basis (income counted when paid)'} · figures exclude VAT when you're VAT registered.</p>
    <div class="table-wrap"><table><thead><tr><th>Category</th><th class="num">Items</th><th class="num">Amount</th></tr></thead>
      <tbody><tr><th colspan="3" style="background:transparent">Income</th></tr>${rows(p.income)}${p.income.length === 0 ? html`<tr><td colspan="3" class="muted">No income recorded.</td></tr>` : ''}
      <tr style="font-weight:700"><td>Total income</td><td></td><td class="num">${gbp(p.totalIncome)}</td></tr>
      <tr><th colspan="3" style="background:transparent">Expenses</th></tr>${rows(p.expenses)}${p.basis !== 'accruals' ? rows(p.capital) : ''}${p.expenses.length === 0 ? html`<tr><td colspan="3" class="muted">No expenses recorded.</td></tr>` : ''}
      <tr style="font-weight:700"><td>Total expenses</td><td></td><td class="num">${gbp(p.totalExpenses)}</td></tr></tbody>
      <tfoot><tr><td>Net profit</td><td></td><td class="num">${gbp(p.netProfit)}</td></tr></tfoot></table></div>
    <p class="muted small" style="margin-top:10px">This is an accounting view. For tax, disallowable expenses, capital allowances and allowances are applied on the <a href="#/tax">Tax return</a>.</p></div>`;
}

function Vat() {
  const { meta } = useStore();
  const per = useAsync(() => api.get('/api/reports/vat/periods'), []);
  const [sel, setSel] = useState('');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [fileModal, setFileModal] = useState(false); const [ref, setRef] = useState('');
  const range = sel === 'custom' ? custom : sel ? { from: sel.split('|')[0], to: sel.split('|')[1] } : null;
  const ok = range?.from && range?.to;
  const rep = useAsync(() => (ok ? api.get(`/api/reports/vat${qs(range)}`) : Promise.resolve(null)), [range?.from, range?.to]);
  const filed = useAsync(() => api.get('/api/reports/vat/filed'), [rep.data?.filed?.at]);
  if (!meta.settings.vat.registered) return html`<div class="card"><${Empty} title="You're not VAT registered">Turn on VAT in <a href="#/settings?tab=tax">Settings → Tax & VAT</a> if your taxable turnover passes £90,000 (or you register voluntarily). Then invoices can carry VAT and this page prepares your nine-box return.${per.data?.threshold && html`<p style="margin-top:12px">Taxable turnover over the last 12 months: <strong>${gbp(per.data.threshold.turnover)}</strong> (${Math.round(per.data.threshold.pct * 100)}% of the limit).</p>`}</${Empty}></div>`;
  const v = rep.data;
  const markFiled = async () => { try { await api.post('/api/reports/vat/filed', { ...range, reference: ref }); toast('Marked as filed'); setFileModal(false); rep.reload(); } catch (e) { toastError(e); } };
  return html`<div>
    <div class="filters"><select aria-label="VAT period" style="width:auto" value=${sel} onChange=${(e) => setSel(e.target.value)}><option value="">Choose a VAT period…</option>${(per.data?.periods || []).map((p) => html`<option value=${`${p.start}|${p.end}`}>${fmtDate(p.start)} – ${fmtDate(p.end)} (due ${fmtDate(p.due)})</option>`)}<option value="custom">Custom dates…</option></select>
      ${sel === 'custom' && html`<input type="date" aria-label="From" style="width:auto" value=${custom.from} onInput=${(e) => setCustom({ ...custom, from: e.target.value })} /><input type="date" aria-label="To" style="width:auto" value=${custom.to} onInput=${(e) => setCustom({ ...custom, to: e.target.value })} />`}
      ${v && html`<a class="btn" href=${`/api/reports/vat/pdf${qs(range)}`} target="_blank">Download worksheet</a>${v.filed ? html`<${Badge} tone="good">Filed ${v.filed.at?.slice(0, 10)}</${Badge}>` : html`<${Btn} onClick=${() => setFileModal(true)}>Mark as filed</${Btn}>`}`}</div>
    ${!ok && html`<p class="muted">Pick a period to see the nine boxes for your VAT return.</p>`}
    ${v && html`<div class="card"><p class="muted small">${v.scheme === 'cash' ? 'Cash accounting: VAT is counted when you are paid / pay.' : 'Standard accounting: VAT is counted on invoice and transaction dates.'} Due to HMRC by <strong>${fmtDate(v.dueDate)}</strong>.</p>
      ${v.estimatedVatCount > 0 && html`<${Notice} tone="warn">${v.estimatedVatCount} item${v.estimatedVatCount > 1 ? 's have' : ' has'} no VAT code, so no VAT is included for ${v.estimatedVatCount > 1 ? 'them' : 'it'}. Purchases only reclaim VAT where you recorded a VAT amount from an invoice.</${Notice}>`}
      <div class="table-wrap"><table><tbody>
        ${[['1', 'VAT due on sales and other outputs', v.boxes.box1], ['2', 'VAT due on acquisitions from the EU (Northern Ireland only)', v.boxes.box2], ['3', 'Total VAT due', v.boxes.box3], ['4', 'VAT reclaimed on purchases and other inputs', v.boxes.box4], ['5', v.position === 'payable' ? 'Net VAT to pay HMRC' : 'Net VAT to reclaim from HMRC', Math.abs(v.boxes.box5)], ['6', 'Total value of sales, excluding VAT (whole £)', v.boxes.box6], ['7', 'Total value of purchases, excluding VAT (whole £)', v.boxes.box7], ['8', 'Supplies to EU member states (NI goods)', v.boxes.box8], ['9', 'Acquisitions from EU member states (NI goods)', v.boxes.box9]].map(([b, l, val]) => html`<tr style=${['3', '5'].includes(b) ? 'font-weight:700;background:var(--accent-soft)' : ''}><td style="width:60px" class="muted">Box ${b}</td><td>${l}</td><td class="num">${gbp(val)}</td></tr>`)}</tbody></table></div>
      <details style="margin-top:12px"><summary style="cursor:pointer">Show the ${v.sales.length} sales and ${v.purchases.length} purchases behind these boxes</summary>
        <div class="table-wrap" style="margin-top:8px;max-height:320px;overflow:auto"><table><thead><tr><th>Date</th><th>Item</th><th>Type</th><th class="num">Net</th><th class="num">VAT</th></tr></thead><tbody>
        ${[...v.sales.map((r) => ({ ...r, t: 'Sale' })), ...v.purchases.map((r) => ({ ...r, t: 'Purchase' }))].sort((a, b) => (a.date < b.date ? -1 : 1)).map((r) => html`<tr><td class="nowrap">${fmtDate(r.date)}</td><td>${r.description}</td><td>${r.t}</td><td class="num">${gbp(r.net)}</td><td class="num">${gbp(r.vat)}</td></tr>`)}</tbody></table></div></details>
      <p class="muted small" style="margin-top:10px">Ledgerline prepares the figures; submit them through your HMRC VAT online account or MTD-compatible software.</p></div>`}
    ${(filed.data || []).length > 0 && html`<div class="card"><h3 style="margin-bottom:8px">Returns marked as filed</h3>${filed.data.map((f) => html`<div class="row small" style="padding:4px 0"><span class="grow">${fmtDate(f.period_start)} – ${fmtDate(f.period_end)}${f.reference ? ` · ref ${f.reference}` : ''}</span><span>${f.boxes.box5 >= 0 ? 'Paid' : 'Reclaimed'} ${gbp(Math.abs(f.boxes.box5))}</span></div>`)}</div>`}
    ${fileModal && html`<${Modal} title="Mark VAT return as filed" onClose=${() => setFileModal(false)} footer=${html`<${Btn} onClick=${() => setFileModal(false)}>Cancel</${Btn}><${Btn} kind="primary" onClick=${markFiled}>Save</${Btn}>`}><${Field} label="HMRC submission reference (optional)"><input type="text" value=${ref} onInput=${(e) => setRef(e.target.value)} /></${Field}><p class="muted small">This only records that you filed it with HMRC, so you can see your history. It doesn't send anything.</p></${Modal}>`}
  </div>`;
}

function Aging() {
  const { data: a, error, reload } = useAsync(() => api.get('/api/invoices/aging'), []);
  if (error) return html`<${Loading} error=${error} retry=${reload} />`;
  if (!a) return html`<${Loading} />`;
  if (a.total === 0) return html`<div class="card"><${Empty} title="Nobody owes you anything">Unpaid invoices will show here, grouped by how late they are.</${Empty}></div>`;
  const B = [['current', 'Not yet due'], ['d1_30', '1–30 days'], ['d31_60', '31–60 days'], ['d61_90', '61–90 days'], ['d90plus', '90+ days']];
  return html`<div><div class="grid g4" style="grid-template-columns:repeat(5,minmax(0,1fr));margin-bottom:16px">${B.map(([k, l]) => html`<div class="tile"><div class="label">${l}</div><div class="value">${gbp(a.buckets[k])}</div></div>`)}</div>
    <div class="table-wrap"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Due</th><th>Late by</th><th class="num">Owed</th></tr></thead><tbody>${a.rows.map((r) => html`<tr class="clickable" onClick=${() => go(`/invoices/${r.id}`)}><td><strong>${r.number}</strong></td><td>${r.contact}</td><td>${fmtDate(r.due_date)}</td><td>${r.overdueDays ? html`<${Badge} tone=${r.overdueDays > 30 ? 'bad' : 'warn'}>${r.overdueDays} days</${Badge}>` : '–'}</td><td class="num">${gbp(r.outstanding)}</td></tr>`)}</tbody>
    <tfoot><tr><td colspan="4">Total owed</td><td class="num">${gbp(a.total)}</td></tr></tfoot></table></div></div>`;
}

function Quarterly({ year }) {
  const { data, error, reload } = useAsync(() => api.get(`/api/reports/quarterly?taxYear=${year}`), [year]);
  if (error && !data) return html`<${Loading} error=${error} retry=${reload} />`;
  if (!data) return html`<${Loading} />`;
  const mark = async (q) => { try { await api.put(`/api/tax/${year}/quarterly/${q.n}`, { submitted: q.status !== 'submitted' }); reload(); } catch (e) { toastError(e); } };
  return html`<div class="stack">
    <${Notice}>Making Tax Digital for Income Tax: if your qualifying income (self-employment + property turnover) is over £50,000 for the 2024/25 tax year, you must send HMRC quarterly updates from 6 April 2026 (over £30,000 from April 2027, over £20,000 from April 2028). The figures below are cumulative for the year to date, ready to enter into HMRC-recognised software or your online account. Ledgerline does not send them for you.</${Notice}>
    ${data.map((q) => { const se = q.cumulative.selfEmployment; const pr = q.cumulative.property; const hasProp = Object.values(pr).some((v) => v);
      return html`<div class="card"><div class="card-head"><h2 class="grow">Update ${q.n}: ${fmtDate(q.start)} – ${fmtDate(q.end)}</h2><${Badge} tone=${q.status === 'submitted' ? 'good' : q.status === 'overdue' ? 'bad' : q.status === 'due' ? 'warn' : ''}>${{ submitted: 'Marked as sent', overdue: 'Overdue', due: 'Due', open: 'In progress', future: 'Not started' }[q.status]}</${Badge}><span class="muted small">due ${fmtDate(q.due)}</span></div>
        <div class="grid g2"><div><h3>Self-employment, year to date</h3><table><tbody>
          <tr><td>Turnover</td><td class="num">${gbp(se.income.turnover)}</td></tr><tr><td>Other income</td><td class="num">${gbp(se.income.other)}</td></tr>
          ${Object.entries(se.expenses).filter(([, v]) => v).map(([k, v]) => html`<tr><td class="muted">${q.labels[k] || k}</td><td class="num">${gbp(v)}</td></tr>`)}
          <tr style="font-weight:700"><td>Total expenses</td><td class="num">${gbp(se.totalExpenses)}</td></tr><tr style="font-weight:700"><td>Profit to date</td><td class="num">${gbp(q.cumulativeProfit)}</td></tr></tbody></table></div>
          <div>${hasProp ? html`<h3>UK property, year to date</h3><table><tbody>${Object.entries(pr).filter(([, v]) => v).map(([k, v]) => html`<tr><td>${{ rentIncome: 'Rental income', premisesRunningCosts: 'Rent, rates, insurance', repairsAndMaintenance: 'Repairs', financialCosts: 'Finance costs (non-residential)', professionalFees: 'Professional fees', costOfServices: 'Services', other: 'Other' }[k]}</td><td class="num">${gbp(v)}</td></tr>`)}</tbody></table>` : html`<p class="muted small">No property figures in this period.</p>`}
          <p class="muted small" style="margin-top:10px">This quarter alone: turnover ${gbp(q.period.selfEmployment.income.turnover)}, expenses ${gbp(q.period.selfEmployment.totalExpenses)}.</p></div></div>
        <div class="row" style="margin-top:10px"><${Btn} small onClick=${() => mark(q)}>${q.status === 'submitted' ? 'Unmark' : 'Mark as sent to HMRC'}</${Btn}></div></div>`; })}
  </div>`;
}

export default function Reports({ query }) {
  const { meta, taxYear } = useStore();
  const isCo = meta.settings.entityType === 'company';
  const year = selection(meta, taxYear);
  const tab = query.tab || (isCo ? 'vat' : 'pnl');
  const tabs = isCo ? [{ id: 'vat', label: 'VAT return' }, { id: 'aging', label: 'Who owes you' }] : [{ id: 'pnl', label: 'Profit & loss' }, { id: 'vat', label: 'VAT return' }, { id: 'aging', label: 'Who owes you' }, { id: 'quarterly', label: 'Quarterly updates (MTD)' }];
  return html`<div>
    <${PageHead} title="Reports">${!isCo && html`<${TaxYearSelect} value=${year} years=${meta.taxYears} onChange=${(y) => setTaxYear(y)} />`}</${PageHead}>
    ${isCo && html`<${Notice}>Your company's profit and loss account and balance sheet are under <a href="#/tax?tab=accounts">Company tax → Accounts</a>.</${Notice}>`}
    <${Tabs} value=${tab} onChange=${(t) => go(`/reports?tab=${t}`)} tabs=${tabs} />
    ${tab === 'pnl' && !isCo && html`<${PnL} year=${year} />`}${tab === 'vat' && html`<${Vat} />`}${tab === 'aging' && html`<${Aging} />`}${tab === 'quarterly' && !isCo && html`<${Quarterly} year=${year} />`}
  </div>`;
}
