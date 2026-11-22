import { useState } from 'preact/hooks';
import { html, Btn, Badge, Notice, Modal, Field, MoneyInput, Empty, Loading, useAsync, Tabs, PeriodSelect, Icon } from '../components/ui.js';
import { PageHead, FormCard } from '../components/shared.js';
import { api } from '../api.js';
import { useStore, toast, toastError, setTaxYear, selection, refreshMeta } from '../store.js';
import { gbp, gbp0, fmtDate, isoToday } from '../util.js';
import { go } from '../main.js';

const Line = ({ label, value, strong, sub }) => html`<tr style=${strong ? 'font-weight:700' : ''}><td>${label}${sub ? html`<div class="muted small">${sub}</div>` : ''}</td><td class="num">${typeof value === 'number' ? gbp(value) : value}</td></tr>`;

// ------------------------------------------------------------------------------------------ overview
function Overview({ d, key_ }) {
  const jump = (a) => { if (!a) return; if (a.tab) return go(`/tax?tab=${a.tab}`); if (a.view) go(`/${a.view}${a.filter ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(a.filter).map(([k, v]) => [k, String(v)]))) : ''}`); };
  const issues = d.warnings.filter((w) => w.level !== 'info');
  const infos = d.warnings.filter((w) => w.level === 'info');
  const next = d.deadlines.find((x) => x.date >= isoToday());
  const bs = d.balanceSheet, ct = d.ct;
  return html`<div class="stack">
    <${Notice} tone="warn"><strong>Filing:</strong> HMRC's free service for company tax returns closed on 31 March 2026. A Company Tax Return (CT600) now has to be filed with <strong>HMRC-recognised software, with accounts and computations in iXBRL format</strong>, or by an accountant. Ledgerline can't do that final step – it gets you everything the software or your accountant needs: the figures, draft accounts, a tax computation and a <strong>trial balance</strong> to import.</${Notice}>
    ${issues.map((w) => html`<${Notice} tone=${w.level === 'error' ? 'error' : 'warn'} actions=${w.action && html`<button class="link" onClick=${() => jump(w.action)}>Fix</button>`}>${w.text}</${Notice}>`)}
    <div class="grid g2">
      <div class="card"><div class="card-head"><h2 class="grow">Corporation Tax for this period</h2>${next && html`<${Badge} tone=${next.daysAway < 60 ? 'warn' : 'info'}>${next.daysAway} days to the next deadline</${Badge}>`}</div>
        <div class="hero">${gbp0(ct.tax)}</div>
        <p class="muted">${ct.rows[0].charge.band === 'small' ? 'at the 19% small profits rate' : ct.rows[0].charge.band === 'marginal' ? 'in the marginal relief band (effective rate between 19% and 25%)' : 'at the 25% main rate'}${ct.rows.length > 1 ? ' (two tax periods)' : ''}, due <strong>${fmtDate(ct.rows[ct.rows.length - 1].dueDate)}</strong></p>
        <table><tbody><${Line} label="Turnover" value=${d.pnl.turnover} /><${Line} label="Expenses (incl. depreciation)" value=${-d.pnl.totalExpenses} /><${Line} label="Profit before tax" value=${d.pnl.profitBeforeTax} strong />
          <${Line} label="Profits chargeable to Corporation Tax" value=${ct.rows.reduce((a, r) => a + r.chargeable, 0)} sub="After adding back depreciation and deducting capital allowances" /><${Line} label="Profit after tax" value=${d.pnl.profitBeforeTax - ct.tax} strong /></tbody></table></div>
      <div class="card"><div class="card-head"><h2 class="grow">Deadlines</h2></div>
        ${d.deadlines.filter((x) => x.daysAway > -30).slice(0, 6).map((x) => html`<div class="row" style="padding:7px 0;border-bottom:1px solid var(--border);flex-wrap:nowrap"><div class="grow"><div style="font-weight:560">${x.title}</div><div class="muted small">${fmtDate(x.date)}${x.detail ? ' · ' + x.detail : ''}</div></div><${Badge} tone=${x.daysAway < 0 ? 'bad' : x.daysAway < 60 ? 'warn' : ''}>${x.daysAway < 0 ? `${-x.daysAway}d ago` : `${x.daysAway} days`}</${Badge}></div>`)}</div>
    </div>
    <div class="card"><h2 style="margin-bottom:10px">Get it filed</h2>
      <div class="row"><a class="btn primary" href=${`/api/company/pdf?pack=all&period=${key_}&download=1`}><${Icon} name="download" /> Draft accounts + computation + CT600 figures (PDF)</a>
        <a class="btn" href=${`/api/company/trial-balance.csv?period=${key_}`}><${Icon} name="download" /> Trial balance (CSV)</a></div>
      <ol class="stack small" style="padding-left:1.3em;margin:12px 0 0">
        <li>Clear every red and amber item above, and make sure the balance sheet <strong>balances</strong> (Accounts tab).</li>
        <li>Check the draft accounts and computation with both directors. Approve the accounts at a board meeting and keep a signed copy.</li>
        <li>Give your <strong>trial balance</strong> to an accountant or import it into HMRC-recognised filing software. It produces the iXBRL accounts and computation and submits the CT600. File and pay by the dates above.</li>
        <li>File the accounts at Companies House (this is separate from HMRC) and the annual confirmation statement.</li>
        <li>If you're VAT registered, file the VAT return from <a href="#/reports?tab=vat">Reports</a>.</li></ol></div>
    ${infos.length > 0 && html`<div class="card"><h3 style="margin-bottom:8px">Notes</h3>${infos.map((w) => html`<p class="small muted" style="margin:0 0 6px">• ${w.text}</p>`)}</div>`}
    <div class="card"><h3 style="margin-bottom:6px">No salary – what that means</h3>
      <p class="small muted" style="margin:0">With no employees and no pay to the directors there's no payroll (PAYE/RTI) to run and no employer National Insurance. Profit stays in the company and is taxed as Corporation Tax; the directors take money out as <strong>dividends</strong> (from profit already taxed), or lend/borrow via their <strong>director's loan accounts</strong>. Taking money out any other way creates an overdrawn loan, which triggers extra tax – the Directors tab tracks it.</p></div>
  </div>`;
}

// ------------------------------------------------------------------------------------------ accounts
function Accounts({ d }) {
  const bs = d.balanceSheet;
  const forms = d.forms.filter((f) => ['ACCOUNTS', 'BALANCE'].includes(f.id));
  return html`<div class="stack">
    ${bs.balanced ? html`<${Notice} tone="good">The balance sheet balances: your bank balances, invoices, assets, director's loan accounts and tax owed all agree with your profit.</${Notice}>` : html`<${Notice} tone="error"><strong>The balance sheet is out by ${gbp(Math.abs(bs.difference))}.</strong> It's built from your bank balances, invoices, assets and tax owed, and compared with your profit – so a gap means something that moves money isn't in the profit and loss.
      ${bs.explain.length > 0 && html`<div style="margin-top:6px"><strong>Why it might not balance:</strong><ul style="margin:4px 0 0 1.2em;padding:0">${bs.explain.map((e) => html`<li>${e.text} (${gbp(e.amount)})</li>`)}</ul></div>`}</${Notice}>`}
    ${forms.map((f) => html`<${FormCard} form=${f} />`)}
    ${bs.accounts.length > 0 && html`<div class="card"><h3 style="margin-bottom:8px">Cash at bank, by account</h3><table><tbody>${bs.accounts.map((a) => html`<${Line} label=${a.name} value=${a.balance} />`)}</tbody></table></div>`}
  </div>`;
}

// ------------------------------------------------------------------------------------------ computation + CT600
function Computation({ d, key_, reload }) {
  const [f, setF] = useState({ ctLossesBF: d.inputs.ctLossesBF, ctOtherAdjustments: d.inputs.ctOtherAdjustments, charitableDonations: d.inputs.charitableDonations, associatedCompanies: d.inputs.associatedCompanies });
  const [dirty, setDirty] = useState(false);
  const set = (k, v) => { setF((x) => ({ ...x, [k]: v })); setDirty(true); };
  const save = async () => { try { await api.put(`/api/company/inputs?period=${key_}`, f); toast('Saved'); setDirty(false); reload(); } catch (e) { toastError(e); } };
  const forms = d.forms.filter((x) => ['COMPUTATION', 'CT600', 'CT600A'].includes(x.id) && x.applies !== false);
  return html`<div class="stack">
    <div class="card"><h2 style="margin-bottom:10px">Adjustments for this period</h2><div class="form-grid">
      <${Field} label="Trading losses brought forward" hint="From a previous period's computation"><${MoneyInput} value=${f.ctLossesBF} onChange=${(v) => set('ctLossesBF', v ?? 0)} /></${Field}>
      <${Field} label="Other adjustments (+/−)" hint="Anything else to add to or take off profit for tax"><${MoneyInput} allowNegative value=${f.ctOtherAdjustments} onChange=${(v) => set('ctOtherAdjustments', v ?? 0)} /></${Field}>
      <${Field} label="Qualifying charitable donations"><${MoneyInput} value=${f.charitableDonations} onChange=${(v) => set('charitableDonations', v ?? 0)} /></${Field}>
      <${Field} label="Associated companies" hint="Companies under common control (e.g. both directors also own another). Splits the £50k/£250k limits."><input type="number" min="0" max="50" value=${f.associatedCompanies} onInput=${(e) => set('associatedCompanies', Number(e.target.value))} /></${Field}></div>
      <div class="row" style="margin-top:12px"><${Btn} kind="primary" disabled=${!dirty} onClick=${save}>Save changes</${Btn}></div></div>
    ${forms.map((x) => html`<${FormCard} form=${x} />`)}
  </div>`;
}

// ------------------------------------------------------------------------------------------ directors + dividends
function splitPreview(directors, total) {
  const shares = directors.map((x) => Math.max(0, Number(x.shares) || 0));
  const all = shares.reduce((a, b) => a + b, 0);
  if (!all || !total) return [];
  let given = 0;
  return directors.map((x, i) => { const a = i === directors.length - 1 ? total - given : Math.round((total * shares[i]) / all); given += a; return { name: x.name, shares: shares[i], amount: a }; }).filter((x) => x.shares > 0);
}

function DividendModal({ directors, onClose, onSaved }) {
  const [f, setF] = useState({ declared_date: isoToday(), paid_date: isoToday(), total: null, notes: '' });
  const [ack, setAck] = useState(false);
  const [err, setErr] = useState(null);
  const reserves = useAsync(() => api.get(`/api/company/dividends/reserves?date=${f.declared_date}`), [f.declared_date]);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const avail = reserves.data?.available ?? 0;
  const over = f.total > avail;
  const save = async () => { setErr(null); try { await api.post('/api/company/dividends', { ...f, acknowledge: ack }); toast('Dividend recorded'); onSaved(); } catch (e) { setErr(e.message); } };
  const split = splitPreview(directors, f.total || 0);
  return html`<${Modal} title="Declare a dividend" onClose=${onClose} footer=${html`<${Btn} onClick=${onClose}>Cancel</${Btn}><${Btn} kind="primary" disabled=${!f.total || (over && !ack)} onClick=${save}>Record dividend & payment</${Btn}>`}>
    ${err && html`<${Notice} tone="error">${err}</${Notice}>`}
    <div class="form-grid"><${Field} label="Declared on"><input type="date" value=${f.declared_date} onInput=${(e) => set('declared_date', e.target.value)} /></${Field}><${Field} label="Paid on"><input type="date" value=${f.paid_date} onInput=${(e) => set('paid_date', e.target.value)} /></${Field}>
      <${Field} label="Total dividend" class="span2"><${MoneyInput} value=${f.total} onChange=${(v) => set('total', v)} /></${Field}></div>
    ${reserves.data && html`<p class="small" style="margin:10px 0">Profit available for dividends on this date: <strong>${gbp(Math.max(0, avail))}</strong> <span class="muted">(kept from earlier years ${gbp(reserves.data.retainedBefore)} + profit this year so far ${gbp(reserves.data.profitToDate)} − estimated Corporation Tax ${gbp(reserves.data.estimatedTax)} − dividends already declared this year ${gbp(reserves.data.declaredThisPeriod)})</span></p>`}
    ${over && f.total && html`<${Notice} tone="error">That is <strong>more than the profit available</strong>. A dividend paid without enough distributable profit can be unlawful, and may have to be paid back. Unless you've prepared interim accounts that show more profit, reduce it.
      <label class="check" style="margin-top:6px"><input type="checkbox" checked=${ack} onChange=${(e) => setAck(e.target.checked)} /> I understand – record it anyway</label></${Notice}>`}
    ${split.length > 0 && html`<div class="table-wrap"><table><thead><tr><th>Shareholder</th><th class="num">Shares</th><th class="num">Dividend</th></tr></thead><tbody>${split.map((s) => html`<tr><td>${s.name}</td><td class="num">${s.shares}</td><td class="num">${gbp(s.amount)}</td></tr>`)}</tbody></table></div>`}
    <p class="muted small" style="margin-top:8px">Dividends are paid per share, so everyone with the same class of shares gets the same amount per share. This also records the bank payment and creates board minutes and dividend vouchers to print.</p></${Modal}>`;
}

function Directors({ d, reload }) {
  const { meta } = useStore();
  const [modal, setModal] = useState(false);
  const ty = meta.currentTaxYear;
  const [year, setYear] = useState(ty);
  const [other, setOther] = useState({});
  const q = Object.entries(other).filter(([, v]) => v).map(([k, v]) => `&other_${encodeURIComponent(k)}=${v}`).join('');
  const summary = useAsync(() => api.get(`/api/company/director-summary?taxYear=${year}${q}`), [year, q, d.dividends.length]);
  const del = async (div) => { if (!confirm('Delete this dividend and its bank payment?')) return; try { await api.del(`/api/company/dividends/${div.id}`); toast('Deleted'); reload(); } catch (e) { toastError(e); } };
  if (!d.directorsList.length) return html`<div class="card"><${Empty} title="Add the directors first">Add each director and how many shares they hold in <a href="#/settings">Settings</a>. Then you can declare dividends and track director's loan accounts.</${Empty}></div>`;
  return html`<div class="stack">
    <div class="grid g2">${d.directors.map((b) => html`<div class="card"><div class="card-head"><h2 class="grow">${b.director.name}</h2>${b.director.shares ? html`<${Badge}>${b.director.shares} shares</${Badge}>` : ''}</div>
      <div class="hero" style=${`font-size:2rem;${b.balance > 0 ? 'color:var(--bad)' : ''}`}>${gbp0(Math.abs(b.balance))}</div>
      <p class="muted small">${b.balance > 0 ? 'owed BY the director to the company (overdrawn loan account)' : b.balance < 0 ? 'owed TO the director by the company (e.g. expenses they paid personally)' : "director's loan account is settled"}</p>
      <p class="small muted" style="margin:0">Record spending a director paid personally by choosing their <strong>Director's loan</strong> account when importing or adding it. Money the company bank pays to a director that isn't a dividend or repayment: use the category “Director's loan”.</p></div>`)}</div>
    ${d.loans.total > 0 && html`<${Notice} tone="error">Directors owe the company <strong>${gbp(d.loans.total)}</strong> at the end of this period. If it's still unpaid on <strong>${fmtDate(d.loans.repayBy)}</strong>, the company owes extra tax of about <strong>${gbp(d.loans.s455)}</strong> (33.75% on loans made before 6 April 2026, 35.75% after). Repay it, or declare a dividend to clear it, before then.${d.loans.over10k ? ' Loans over £10,000 are also a taxable benefit for the director.' : ''}</${Notice}>`}
    <div class="card"><div class="card-head"><h2 class="grow">Dividends</h2><${Btn} kind="primary" icon="plus" onClick=${() => setModal(true)}>Declare a dividend</${Btn}></div>
      <p class="small">Available to pay out now: <strong>${gbp(Math.max(0, d.reserves.available))}</strong> <span class="muted">– profit kept in the company after estimated tax.</span></p>
      ${d.dividends.length === 0 ? html`<p class="muted">No dividends yet.</p>` : html`<div class="table-wrap"><table><thead><tr><th>Paid</th><th>Split</th><th class="num">Total</th><th></th></tr></thead><tbody>${d.dividends.map((x) => html`<tr><td class="nowrap">${fmtDate(x.paid_date)}</td><td class="small">${x.allocations.map((a) => `${a.name} ${gbp(a.amount)}`).join(' · ')}</td><td class="num">${gbp(x.total)}</td><td class="right nowrap"><a class="btn small" href=${`/api/company/dividends/${x.id}/pack.pdf`} target="_blank">Minutes & vouchers</a> <${Btn} small kind="danger" onClick=${() => del(x)}>Delete</${Btn}></td></tr>`)}</tbody></table></div>`}</div>
    <div class="card"><div class="card-head"><h2 class="grow">What each director reports personally</h2><select aria-label="Tax year" style="width:auto" value=${year} onChange=${(e) => setYear(e.target.value)}>${meta.taxYears.map((t) => html`<option value=${t.label}>${t.label.replace('-', '/')}</option>`)}</select></div>
      <p class="muted small">Dividends are personal income for the director, taxed on their own Self Assessment. With no salary, the Personal Allowance (£12,570) plus the £500 dividend allowance means roughly <strong>£13,070 each can be taken tax-free</strong> if there's no other income. Enter any other income to refine the estimate. Dividends over the allowance need reporting to HMRC (usually via a Self Assessment return) – check gov.uk for your situation.</p>
      ${summary.data && html`<div class="table-wrap"><table><thead><tr><th>Director</th><th class="num">Dividends received</th><th class="num">Other income</th><th class="num">Estimated tax on dividends</th></tr></thead><tbody>${summary.data.map((s) => html`<tr><td>${s.director.name}</td><td class="num">${gbp(s.dividends)}</td><td class="num"><div style="width:130px;margin-left:auto"><${MoneyInput} aria-label=${`Other income for ${s.director.name}`} value=${other[s.director.id] ?? 0} onChange=${(v) => setOther((o) => ({ ...o, [s.director.id]: v ?? 0 }))} /></div></td><td class="num"><strong>${gbp(s.estimatedTax)}</strong></td></tr>`)}</tbody></table></div>`}</div>
    ${modal && html`<${DividendModal} directors=${d.directorsList} onClose=${() => setModal(false)} onSaved=${() => { setModal(false); reload(); refreshMeta(); }} />`}
  </div>`;
}

// ------------------------------------------------------------------------------------------ assets
function AssetModal({ a, onClose, onSaved }) {
  const [f, setF] = useState({ ...a });
  const [err, setErr] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => { try { await api.put(`/api/assets/${a.id}`, { ...f, life_years: Number(f.life_years) }); toast('Saved'); onSaved(); } catch (e) { setErr(e.message); } };
  return html`<${Modal} title="Edit equipment" onClose=${onClose} footer=${html`<${Btn} onClick=${onClose}>Cancel</${Btn}><${Btn} kind="primary" onClick=${save}>Save</${Btn}>`}>${err && html`<${Notice} tone="error">${err}</${Notice}>`}
    <div class="form-grid"><${Field} label="Description" class="span2"><input type="text" value=${f.name} onInput=${(e) => set('name', e.target.value)} /></${Field}>
      <${Field} label="Bought"><input type="date" value=${f.purchase_date} onInput=${(e) => set('purchase_date', e.target.value)} /></${Field}><${Field} label="Cost (excluding recoverable VAT)"><${MoneyInput} value=${f.cost} onChange=${(v) => set('cost', v)} /></${Field}>
      <${Field} label="Useful life (years)" hint="How long it's depreciated over in the accounts"><input type="number" min="1" max="25" value=${f.life_years} onInput=${(e) => set('life_years', e.target.value)} /></${Field}>
      <${Field} label="Sold / scrapped on"><input type="date" value=${f.disposal_date || ''} onInput=${(e) => set('disposal_date', e.target.value)} /></${Field}>${f.disposal_date && html`<${Field} label="Sale proceeds"><${MoneyInput} value=${f.disposal_proceeds} onChange=${(v) => set('disposal_proceeds', v)} /></${Field}>`}</div></${Modal}>`;
}

function Assets({ d, reload }) {
  const [modal, setModal] = useState(null);
  const assets = useAsync(() => api.get('/api/assets'), [d]);
  const fa = d.balanceSheet.fixedAssets;
  return html`<div class="stack"><div class="card"><h2 style="margin-bottom:6px">Equipment</h2>
    <p class="muted small">A company can't use the cash basis, so a laptop isn't an expense – it's an asset, written off gradually in the accounts (depreciation) while tax relief comes from the Annual Investment Allowance (100% up to £1m, so usually all in year one). Equipment you categorise as “Equipment & computers” is added here automatically.</p>
    ${fa.rows.length === 0 ? html`<p class="muted">No equipment yet.</p>` : html`<div class="table-wrap"><table><thead><tr><th>Item</th><th>Bought</th><th class="num">Cost</th><th class="num">Life</th><th class="num">Depreciation to date</th><th class="num">Value now</th></tr></thead><tbody>${fa.rows.map((r) => html`<tr class="clickable" onClick=${() => setModal((assets.data || []).find((x) => x.id === r.id))}><td>${r.name}${r.disposed ? html` <${Badge}>Disposed</${Badge}>` : ''}</td><td>${fmtDate(r.purchase_date)}</td><td class="num">${gbp(r.cost)}</td><td class="num">${r.life_years} yrs</td><td class="num">${gbp(r.depreciation)}</td><td class="num">${gbp(r.nbv)}</td></tr>`)}</tbody><tfoot><tr><td colspan="2">Total</td><td class="num">${gbp(fa.cost)}</td><td></td><td class="num">${gbp(fa.depreciation)}</td><td class="num">${gbp(fa.nbv)}</td></tr></tfoot></table></div>`}</div>
    ${modal && html`<${AssetModal} a=${modal} onClose=${() => setModal(null)} onSaved=${() => { setModal(null); reload(); }} />`}</div>`;
}

export default function Company({ query }) {
  const { meta, taxYear } = useStore();
  const key = selection(meta, taxYear);
  const tab = query.tab || 'overview';
  const { data: d, error, loading, reload } = useAsync(() => api.get(`/api/company/overview?period=${key}`), [key]);
  const issues = d ? d.warnings.filter((w) => w.level !== 'info').length : 0;
  return html`<div>
    <${PageHead} title="Company tax & accounts" sub=${d ? `${meta.settings.company.name || 'Your company'} · ${d.period.label}` : ''}>
      <${PeriodSelect} value=${key} periods=${meta.company.periods} onChange=${(k) => setTaxYear(k)} />
      <a class="btn" href=${`/api/company/pdf?pack=all&period=${key}`} target="_blank"><${Icon} name="pdf" /> Pack PDF</a></${PageHead}>
    <${Tabs} value=${tab} onChange=${(t) => go(`/tax?tab=${t}`)} tabs=${[{ id: 'overview', label: 'Overview', badge: issues || '' }, { id: 'accounts', label: 'Accounts' }, { id: 'computation', label: 'Tax computation & CT600' }, { id: 'directors', label: 'Directors & dividends' }, { id: 'assets', label: 'Equipment' }]} />
    ${error && !d && html`<${Loading} error=${error} retry=${reload} />`}
    ${!d && !error && html`<${Loading} />`}
    ${d && html`<div style=${loading ? 'opacity:.6' : ''} key=${key}>
      ${tab === 'overview' && html`<${Overview} d=${d} key_=${key} />`}${tab === 'accounts' && html`<${Accounts} d=${d} />`}${tab === 'computation' && html`<${Computation} d=${d} key_=${key} reload=${reload} />`}
      ${tab === 'directors' && html`<${Directors} d=${d} reload=${reload} />`}${tab === 'assets' && html`<${Assets} d=${d} reload=${reload} />`}</div>`}
  </div>`;
}
