import { useState } from 'preact/hooks';
import { html, Btn, Notice, Loading, useAsync, TaxYearSelect, Badge, Icon } from '../components/ui.js';
import { PageHead } from '../components/shared.js';
import { GroupedColumns } from '../components/charts.js';
import { api } from '../api.js';
import { useStore, refreshMeta, toast, toastError, setTaxYear } from '../store.js';
import { gbp, gbp0, fmtDate } from '../util.js';
import { go } from '../main.js';

const SERIES = [{ key: 'income', name: 'Money in', color: '--series-1' }, { key: 'expenses', name: 'Money out', color: '--series-2' }];

export default function Dashboard() {
  const { meta, taxYear } = useStore();
  const year = taxYear || meta.currentTaxYear;
  const { data: d, error, loading, reload } = useAsync(() => api.get(`/api/reports/dashboard?taxYear=${year}`), [year]);
  const [demoBusy, setDemoBusy] = useState(false);
  if (error && !d) return html`<${Loading} error=${error} retry=${reload} />`;
  if (!d) return html`<${Loading} />`;
  const empty = d.accounts.every((a) => a.transactions === 0) && d.receivables.total === 0 && d.totals.income === 0;
  const loadDemo = async () => { setDemoBusy(true); try { await api.post('/api/demo/load'); await refreshMeta(); toast('Demo data loaded – have a look around.'); reload(); } catch (e) { toastError(e); } setDemoBusy(false); };
  const att = d.attention;
  const settings = meta.settings;
  return html`<div>
    <${PageHead} title="Dashboard" sub=${`${year.replace('-', '/')} tax year · ${fmtDate(d.period.start)} to ${fmtDate(d.period.end)}`}>
      <${TaxYearSelect} value=${year} years=${meta.taxYears} onChange=${(y) => setTaxYear(y)} />
      <${Btn} kind="primary" icon="plus" onClick=${() => go('/invoices/new')}>New invoice</${Btn}>
    </${PageHead}>

    ${empty && html`<div class="card" style="margin-bottom:16px"><h2>Welcome – let's get your accounts going</h2>
      <p class="muted">Ledgerline reads bank statements, invoices and receipts, sorts income and expenses into the right HMRC boxes, and prepares your Self Assessment worksheets. Everything is stored on this computer.</p>
      <ol class="stack small" style="padding-left:1.2em;margin:10px 0">
        <li><a href="#/settings">Add your details</a> (name, UTR, whether you're VAT registered).</li>
        <li><a href="#/import">Drop in a bank statement</a> – CSV, PDF, Excel, OFX, photos of receipts, even pasted text.</li>
        <li><a href="#/invoices/new">Create an invoice</a>, or set up a <a href="#/recurring">recurring one</a>.</li>
        <li>Open <a href="#/tax">Tax return</a> at the end of the year to see every form's figures.</li>
      </ol>
      <${Btn} onClick=${loadDemo} disabled=${demoBusy}>${demoBusy ? 'Loading…' : 'Or explore with demo data'}</${Btn}></div>`}

    ${(att.uncategorised > 0 || att.needsReview > 0 || d.receivables.overdueCount > 0) && html`<${Notice} tone="warn">
      ${att.uncategorised > 0 && html`<a href="#/transactions?uncategorised=1">${att.uncategorised} uncategorised transaction${att.uncategorised > 1 ? 's' : ''}</a> are left out of your figures. `}
      ${att.needsReview > 0 && html`<a href="#/transactions?status=review">${att.needsReview} to review</a>. `}
      ${d.receivables.overdueCount > 0 && html`<a href="#/invoices?status=overdue">${d.receivables.overdueCount} overdue invoice${d.receivables.overdueCount > 1 ? 's' : ''}</a> worth ${gbp0(d.receivables.overdueTotal)}.`}
    </${Notice}>`}

    <div class="grid g4" style="margin-bottom:16px">
      <div class="tile"><div class="label">Profit so far</div><div class="hero" style="font-size:2.4rem">${gbp0(d.totals.profit)}</div><div class="foot">${gbp0(d.totals.income)} in − ${gbp0(d.totals.expenses)} out</div></div>
      <div class="tile"><div class="label">Estimated tax & NI</div><div class="value">${gbp0(d.estimate.totalLiability)}</div><div class="foot">Income tax ${gbp0(d.estimate.incomeTax)} · Class 4 ${gbp0(d.estimate.class4)}${d.estimate.rateStatus === 'provisional' ? ' · provisional rates' : ''}</div></div>
      <div class="tile"><div class="label">Owed to you</div><div class="value">${gbp0(d.receivables.total)}</div><div class="foot">${d.receivables.overdueCount ? html`<span style="color:var(--bad);font-weight:600">${d.receivables.overdueCount} overdue</span>` : 'Nothing overdue'}${d.receivables.drafts ? ` · ${d.receivables.drafts} draft` : ''}</div></div>
      <div class="tile"><div class="label">In the bank</div><div class="value">${gbp0(d.accounts.filter((a) => a.kind !== 'cash').reduce((s, a) => s + a.balance, 0))}</div><div class="foot">${d.accounts.filter((a) => a.kind !== 'cash').length} account${d.accounts.length > 2 ? 's' : ''}</div></div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h2 class="grow">Money in and out by month</h2><span class="muted small">Tax months run from the 6th to the 5th</span></div>
      <${GroupedColumns} data=${d.monthly.map((m) => ({ label: m.label, values: { income: m.income, expenses: m.expenses } }))} series=${SERIES} ariaLabel=${`Money in and money out by tax month, ${year}`} loading=${loading} />
    </div>

    <div class="grid g2">
      <div class="card"><div class="card-head"><h2 class="grow">Coming up</h2></div>
        ${d.deadlines.length ? d.deadlines.map((x) => html`<div class="row" style="padding:7px 0;border-bottom:1px solid var(--border);flex-wrap:nowrap">
          <div class="grow"><div style="font-weight:560">${x.title}</div><div class="muted small">${fmtDate(x.date)}${x.detail ? ' · ' + x.detail : ''}</div></div>
          <${Badge} tone=${x.daysAway < 0 ? 'bad' : x.daysAway < 30 ? 'warn' : ''}>${x.daysAway < 0 ? `${-x.daysAway}d ago` : x.daysAway === 0 ? 'Today' : `${x.daysAway} days`}</${Badge}></div>`) : html`<p class="muted">No upcoming deadlines.</p>`}
        ${d.vatThreshold?.near && html`<${Notice} tone=${d.vatThreshold.over ? 'error' : 'warn'}>Taxable turnover over the last 12 months is ${gbp0(d.vatThreshold.turnover)} – ${Math.round(d.vatThreshold.pct * 100)}% of the £90,000 VAT registration threshold.</${Notice}>`}
      </div>
      <div class="card"><div class="card-head"><h2 class="grow">Money owed to you</h2><a href="#/reports?tab=aging" class="small">Aged debtors</a></div>
        ${d.receivables.total === 0 ? html`<p class="muted">No unpaid invoices.</p>` : html`<div class="stack">${[['current', 'Not yet due'], ['d1_30', '1–30 days late'], ['d31_60', '31–60 days late'], ['d61_90', '61–90 days late'], ['d90plus', '90+ days late']].filter(([k]) => d.receivables.buckets[k] > 0).map(([k, label]) => html`<div><div class="row"><span class="grow">${label}</span><strong>${gbp0(d.receivables.buckets[k])}</strong></div><div class=${`bar-meter ${k === 'current' ? '' : k === 'd1_30' ? 'warn' : 'bad'}`}><i style=${`width:${Math.max(3, (d.receivables.buckets[k] / d.receivables.total) * 100)}%`}></i></div></div>`)}</div>`}
        ${d.upcomingRecurring.length > 0 && html`<h3 style="margin:16px 0 6px">Next recurring invoices</h3>${d.upcomingRecurring.map((r) => html`<div class="row small" style="padding:3px 0"><span class="grow">${r.name}${r.contact ? ' · ' + r.contact : ''}</span><span class="muted">${fmtDate(r.date)}</span></div>`)}`}
      </div>
    </div>
    ${!settings.profile.name && html`<p class="muted small" style="margin-top:16px"><${Icon} name="info" size=${14} /> Add your name and UTR in <a href="#/settings">Settings</a> so they appear on your return worksheets.</p>`}
  </div>`;
}
