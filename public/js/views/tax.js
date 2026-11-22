import { useState, useEffect } from 'preact/hooks';
import { html, Btn, Badge, Notice, Modal, Field, MoneyInput, Empty, Loading, useAsync, Tabs, TaxYearSelect, Icon } from '../components/ui.js';
import { PageHead } from '../components/shared.js';
import { api } from '../api.js';
import { useStore, toast, toastError, setTaxYear } from '../store.js';
import { gbp, gbp0, fmtDate, isoToday, pct, MONTHS } from '../util.js';
import { go } from '../main.js';

const Line = ({ label, value, strong, sub }) => html`<tr style=${strong ? 'font-weight:700' : ''}><td>${label}${sub ? html`<div class="muted small">${sub}</div>` : ''}</td><td class="num">${typeof value === 'number' ? gbp(value) : value}</td></tr>`;

// ------------------------------------------------------------------------------------------ overview
function Overview({ d, year }) {
  const c = d.calc;
  const dayLeft = Math.round((Date.parse(d.deadlines.online) - Date.parse(useStore().meta.today)) / 86400000);
  const errs = d.warnings.filter((w) => w.level === 'error'), warns = d.warnings.filter((w) => w.level === 'warn'), infos = d.warnings.filter((w) => w.level === 'info');
  const jump = (a) => a?.view && go(`/${a.view}${a.filter ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(a.filter).map(([k, v]) => [k, String(v)]))) : ''}`);
  return html`<div class="stack">
    ${d.status === 'provisional' && html`<${Notice} tone="warn"><strong>${year} rates are provisional.</strong> ${d.notes.join(' ')}</${Notice}>`}
    ${[...errs, ...warns].map((w) => html`<${Notice} tone=${w.level === 'error' ? 'error' : 'warn'} actions=${w.action && html`<button class="link" onClick=${() => jump(w.action)}>Fix</button>`}>${w.text}</${Notice}>`)}
    <div class="grid g2">
      <div class="card"><div class="card-head"><h2 class="grow">Your estimated bill</h2><${Badge} tone=${dayLeft < 0 ? 'bad' : dayLeft < 60 ? 'warn' : 'info'}>${dayLeft < 0 ? `${-dayLeft} days past` : `${dayLeft} days to`} 31 Jan ${d.deadlines.online.slice(0, 4)}</${Badge}></div>
        <div class="hero" style=${c.balance < 0 ? 'color:var(--good)' : ''}>${gbp0(Math.abs(c.balance))}</div>
        <p class="muted">${c.balance >= 0 ? 'still to pay HMRC for' : 'refund due for'} ${year.replace('-', '/')}${c.paymentsOnAccount.length ? html`, plus ${gbp0(c.firstPoaDueWithBalance)} first payment on account → <strong>${gbp0(c.totalDueByJanuary)}</strong> by 31 Jan` : ''}</p>
        <table><tbody><${Line} label="Income Tax" value=${c.tax.incomeTax} /><${Line} label="Class 4 National Insurance" value=${c.nic.class4} />
          ${c.nic.class2 > 0 && html`<${Line} label="Class 2 National Insurance" value=${c.nic.class2} />`}${c.studentLoan.due > 0 && html`<${Line} label="Student loan" value=${c.studentLoan.due} />`}
          ${c.hicbc.amount > 0 && html`<${Line} label="High Income Child Benefit Charge" value=${c.hicbc.amount} sub=${`${c.hicbc.percentage}% of Child Benefit clawed back`} />`}${c.cgt > 0 && html`<${Line} label="Capital Gains Tax" value=${c.cgt} />`}
          <${Line} label="Total tax and NI" value=${c.totalLiability} strong />
          ${c.credits.map((x) => html`<${Line} label=${`Less: ${x.label}`} value=${-x.amount} />`)}${c.paymentsMade > 0 && html`<${Line} label="Less: payments already made" value=${-c.paymentsMade} />`}
          <${Line} label=${c.balance >= 0 ? 'Balance to pay' : 'Refund'} value=${Math.abs(c.balance)} strong /></tbody></table>
        ${c.paymentsOnAccount.length > 0 && html`<h3 style="margin:14px 0 6px">Next year's payments on account</h3>${c.paymentsOnAccount.map((p) => html`<div class="row small" style="padding:3px 0"><span class="grow">${p.label}</span><span class="muted">${fmtDate(p.due)}</span><strong>${gbp(p.amount)}</strong></div>`)}`}
        ${c.nic.class2VoluntaryOption > 0 && html`<p class="muted small" style="margin-top:10px">Optional: voluntary Class 2 of ${gbp(c.nic.class2VoluntaryOption)} protects your State Pension record (not included above).</p>`}
      </div>
      <div class="card"><div class="card-head"><h2 class="grow">Where it comes from</h2></div>
        <table><tbody>${c.income.employment ? html`<${Line} label="Employment" value=${c.income.employment} />` : ''}${(d.se.active || c.income.selfEmployment) ? html`<${Line} label="Self-employment profit" value=${c.income.selfEmployment} sub=${d.se.usedAllowance ? 'Using the £1,000 trading allowance' : d.se.lossUsed ? `After ${gbp(d.se.lossUsed)} of losses` : ''} />` : ''}${(d.prop.active || c.income.property) ? html`<${Line} label="UK property profit" value=${c.income.property} sub=${d.prop.usedAllowance ? 'Using the £1,000 property allowance' : ''} />` : ''}
          ${(c.income.pensions + c.income.other) ? html`<${Line} label="Pensions & other" value=${c.income.pensions + c.income.other} />` : ''}${c.income.savings ? html`<${Line} label="Savings interest" value=${c.income.savings} />` : ''}${c.income.dividends ? html`<${Line} label="Dividends" value=${c.income.dividends} />` : ''}
          <${Line} label="Total income" value=${c.income.total} strong /><${Line} label="Personal Allowance" value=${-c.personalAllowance} sub=${c.personalAllowance < c.standardPersonalAllowance ? 'Reduced: income over £100,000 or Marriage Allowance' : ''} /><${Line} label="Taxable income" value=${c.taxable.total} strong /></tbody></table>
        <details style="margin-top:12px"><summary style="cursor:pointer">How the tax is worked out</summary><div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>Income type</th><th>Band</th><th class="num">Amount</th><th class="num">Rate</th><th class="num">Tax</th></tr></thead><tbody>${c.bands.map((b) => html`<tr><td>${b.type}</td><td>${b.band}</td><td class="num">${gbp0(b.amount)}</td><td class="num">${(b.rate * 100).toFixed(b.rate * 1000 % 10 ? 2 : 0)}%</td><td class="num">${gbp(b.tax)}</td></tr>`)}${c.tax.reductions.map((r) => html`<tr><td colspan="4">${r.label}</td><td class="num">-${gbp(r.amount)}</td></tr>`)}</tbody></table></div></details>
        <p class="muted small" style="margin-top:10px">Effective rate on total income: ${pct(c.effectiveRate, 1)}.</p>
      </div>
    </div>
    <div class="card"><h2>Ready to file? A checklist</h2>
      <ol class="stack small" style="padding-left:1.3em;margin:10px 0 0">
        <li>Clear the red/amber items above (uncategorised or unchecked transactions are the usual ones).</li>
        <li>Fill in <a href="#/tax?tab=income">Income & reliefs</a> for anything outside your bank data – employment (P60), pensions, student loan, Child Benefit.</li>
        <li>Open <a href="#/tax?tab=forms">Worksheets</a> and download the PDF. Each box is shown as it appears on HMRC's form, and you can click a figure to see the transactions behind it.</li>
        <li>Sign in to your HMRC online account (Government Gateway) and enter the figures. <strong>Ledgerline does not submit to HMRC</strong> – you (or your accountant) press the final button.</li>
        <li>After filing, compare HMRC's own calculation with the estimate here. Pay by <strong>${fmtDate(d.deadlines.online)}</strong>. Keep your records until <strong>${fmtDate(d.deadlines.keepRecordsUntil)}</strong>.</li></ol></div>
    ${infos.length > 0 && html`<div class="card"><h3 style="margin-bottom:8px">Notes about this return</h3>${infos.map((w) => html`<p class="small muted" style="margin:0 0 6px">• ${w.text}</p>`)}</div>`}
  </div>`;
}

// ------------------------------------------------------------------------------------------ inputs
function useDraft(initial, year) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const set = (k, v) => { setDraft((x) => ({ ...x, [k]: v })); setDirty(true); };
  const save = async (keys, reload) => {
    setSaving(true);
    try { await api.put(`/api/tax/${year}/inputs`, Object.fromEntries(keys.map((k) => [k, draft[k]]))); toast('Saved'); setDirty(false); reload(); }
    catch (e) { toastError(e); }
    setSaving(false);
  };
  return { draft, set, save, saving, dirty };
}
const M = ({ label, k, hint, draft, set, neg }) => html`<${Field} label=${label} hint=${hint}><${MoneyInput} value=${draft[k] || 0} allowNegative=${neg} onChange=${(v) => set(k, v ?? 0)} /></${Field}>`;

function IncomeTab({ d, year, reload }) {
  const { draft, set, save, saving, dirty } = useDraft({ ...d.inputs }, year);
  const emp = draft.employment || [];
  const setEmp = (i, patch) => set('employment', emp.map((e, k) => (k === i ? { ...e, ...patch } : e)));
  const keys = ['employment', 'pensions', 'otherIncome', 'interestManual', 'dividendsManual', 'giftAidManual', 'pensionRasManual', 'marriageAllowance', 'studentLoan', 'childBenefit', 'cisDeducted', 'otherTaxDeducted'];
  return html`<div class="stack">
    <div class="card"><div class="card-head"><h2 class="grow">Employment (SA102)</h2><${Btn} small icon="plus" onClick=${() => set('employment', [...emp, { employer: '', payeRef: '', pay: 0, tax: 0, benefits: 0, expenses: 0 }])}>Add employer</${Btn}></div>
      ${emp.length === 0 && html`<p class="muted small">Skip this if you weren't employed. Take the figures from your P60 (or P45 if you left).</p>`}
      ${emp.map((e, i) => html`<div class="form-grid" style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--border)"><${Field} label="Employer" class="span2"><input type="text" value=${e.employer} onInput=${(ev) => setEmp(i, { employer: ev.target.value })} /></${Field}><${Field} label="Employer PAYE reference"><input type="text" value=${e.payeRef} onInput=${(ev) => setEmp(i, { payeRef: ev.target.value })} /></${Field}>
        <${Field} label="Pay (P60)"><${MoneyInput} value=${e.pay} onChange=${(v) => setEmp(i, { pay: v ?? 0 })} /></${Field}><${Field} label="UK tax taken off"><${MoneyInput} value=${e.tax} onChange=${(v) => setEmp(i, { tax: v ?? 0 })} /></${Field}><${Field} label="Benefits (P11D)"><${MoneyInput} value=${e.benefits} onChange=${(v) => setEmp(i, { benefits: v ?? 0 })} /></${Field}><${Field} label="Expenses you paid yourself"><${MoneyInput} value=${e.expenses} onChange=${(v) => setEmp(i, { expenses: v ?? 0 })} /></${Field}>
        <div><${Btn} small kind="danger" onClick=${() => set('employment', emp.filter((_, k) => k !== i))}>Remove</${Btn}></div></div>`)}</div>
    <div class="card"><h2 style="margin-bottom:10px">Pensions, interest & dividends</h2><div class="form-grid">
      <${M} label="Pension income (incl. State Pension)" k="pensions" draft=${{ pensions: draft.pensions.pay }} set=${(_, v) => set('pensions', { ...draft.pensions, pay: v })} /><${M} label="Tax already taken off pensions" k="pensions" draft=${{ pensions: draft.pensions.tax }} set=${(_, v) => set('pensions', { ...draft.pensions, tax: v })} />
      <${M} label="Other taxable income" k="otherIncome" draft=${{ otherIncome: draft.otherIncome.amount }} set=${(_, v) => set('otherIncome', { ...draft.otherIncome, amount: v })} /><${M} label="Tax taken off that" k="otherIncome" draft=${{ otherIncome: draft.otherIncome.tax }} set=${(_, v) => set('otherIncome', { ...draft.otherIncome, tax: v })} />
      <${M} label="Extra bank interest (gross)" k="interestManual" hint="Interest on bank transactions you've categorised is already included" draft=${draft} set=${set} /><${M} label="Extra dividends" k="dividendsManual" hint="Same – categorised dividend payments are included" draft=${draft} set=${set} /></div></div>
    <div class="card"><h2 style="margin-bottom:10px">Reliefs & allowances</h2><div class="form-grid">
      <${M} label="Extra Gift Aid donations (amount paid)" k="giftAidManual" hint="Donations categorised as Gift Aid are included" draft=${draft} set=${set} /><${M} label="Extra pension contributions (net, relief at source)" k="pensionRasManual" draft=${draft} set=${set} />
      <${Field} label="Marriage Allowance"><select value=${draft.marriageAllowance} onChange=${(e) => set('marriageAllowance', e.target.value)}><option value="none">Not claiming</option><option value="give">I'm transferring £1,260 to my spouse</option><option value="receive">I'm receiving it from my spouse</option></select></${Field}></div></div>
    <div class="card"><h2 style="margin-bottom:10px">Student loans & Child Benefit</h2><div class="form-grid">
      <${Field} label="Student loan plan"><select value=${draft.studentLoan.plan} onChange=${(e) => set('studentLoan', { ...draft.studentLoan, plan: e.target.value })}><option value="none">None</option><option value="plan1">Plan 1</option><option value="plan2">Plan 2</option><option value="plan4">Plan 4 (Scotland)</option><option value="plan5">Plan 5</option></select></${Field}>
      <${Field} label="Postgraduate loan"><label class="check"><input type="checkbox" checked=${draft.studentLoan.postgrad} onChange=${(e) => set('studentLoan', { ...draft.studentLoan, postgrad: e.target.checked })} /> I have one</label></${Field}>
      <${M} label="Already repaid through your employer" k="x" hint="Shown on your P60" draft=${{ x: draft.studentLoan.paidViaPaye }} set=${(_, v) => set('studentLoan', { ...draft.studentLoan, paidViaPaye: v })} />
      <${M} label="Child Benefit received in the year" k="childBenefit" hint="For the High Income Child Benefit Charge" draft=${draft} set=${set} /></div></div>
    <div class="card"><h2 style="margin-bottom:10px">Tax already deducted</h2><div class="form-grid"><${M} label="Deducted by contractors (CIS)" k="cisDeducted" hint="From your CIS monthly statements" draft=${draft} set=${set} /><${M} label="Other tax already deducted" k="otherTaxDeducted" draft=${draft} set=${set} /></div></div>
    <div class="row"><${Btn} kind="primary" disabled=${!dirty || saving} onClick=${() => save(keys, reload)}>${saving ? 'Saving…' : 'Save changes'}</${Btn}>${dirty && html`<span class="muted small">You have unsaved changes</span>`}</div>
  </div>`;
}

// ------------------------------------------------------------------------------------------ business
const POOLS = { plant: 'Equipment & machinery (Annual Investment Allowance)', car_main: 'Car – CO2 up to 50g/km (18% pool)', car_special: 'Car – CO2 over 50g/km (6% pool)', car_zero: 'Zero-emission car (100% first-year)' };

function AssetModal({ a, onClose, onSaved }) {
  const [f, setF] = useState(a || { name: '', purchase_date: isoToday(), cost: null, pool: 'plant', business_pct: 100, disposal_date: '', disposal_proceeds: null });
  const [err, setErr] = useState({});
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => { try { a ? await api.put(`/api/assets/${a.id}`, f) : await api.post('/api/assets', f); toast('Saved'); onSaved(); } catch (e) { setErr({ [e.field || '_']: e.message }); } };
  const del = async () => { if (!confirm('Delete this asset?')) return; try { await api.del(`/api/assets/${a.id}`); onSaved(); } catch (e) { toastError(e); } };
  return html`<${Modal} title=${a ? 'Edit asset' : 'Add asset'} onClose=${onClose} footer=${html`${a && html`<${Btn} kind="danger" onClick=${del}>Delete</${Btn}>`}<span class="grow"></span><${Btn} onClick=${onClose}>Cancel</${Btn}><${Btn} kind="primary" onClick=${save}>Save</${Btn}>`}>
    ${err._ && html`<${Notice} tone="error">${err._}</${Notice}>`}
    <div class="form-grid"><${Field} label="What is it?" class="span2" error=${err.name}><input type="text" value=${f.name} onInput=${(e) => set('name', e.target.value)} /></${Field}>
      <${Field} label="Purchase date" error=${err.purchase_date}><input type="date" value=${f.purchase_date} onInput=${(e) => set('purchase_date', e.target.value)} /></${Field}><${Field} label="Cost" error=${err.cost}><${MoneyInput} value=${f.cost} onChange=${(v) => set('cost', v)} /></${Field}>
      <${Field} label="Type" class="span2"><select value=${f.pool} onChange=${(e) => set('pool', e.target.value)}>${Object.entries(POOLS).map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select></${Field}>
      <${Field} label="Business use %" error=${err.business_pct}><input type="number" min="1" max="100" value=${f.business_pct} onInput=${(e) => set('business_pct', Number(e.target.value))} /></${Field}>
      <${Field} label="Sold / scrapped on" hint="If disposed of"><input type="date" value=${f.disposal_date || ''} onInput=${(e) => set('disposal_date', e.target.value)} /></${Field}>${f.disposal_date && html`<${Field} label="Sale proceeds"><${MoneyInput} value=${f.disposal_proceeds} onChange=${(v) => set('disposal_proceeds', v)} /></${Field}>`}</div>
    <p class="muted small" style="margin-top:12px">Cash basis: ordinary equipment is simply an expense when you pay for it – only cars go here. Traditional accounts: record all equipment here instead of as an expense.</p></${Modal}>`;
}

function DisposalModal({ x, onClose, onSaved }) {
  const [f, setF] = useState(x || { description: '', asset_type: 'shares', acquired_date: '', disposal_date: isoToday(), proceeds: null, cost: null, costs: null, residential: false });
  const [err, setErr] = useState({});
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  const gain = (f.proceeds || 0) - (f.cost || 0) - (f.costs || 0);
  const save = async () => { try { x ? await api.put(`/api/disposals/${x.id}`, f) : await api.post('/api/disposals', f); toast('Saved'); onSaved(); } catch (e) { setErr({ [e.field || '_']: e.message }); } };
  const del = async () => { if (!confirm('Delete this disposal?')) return; try { await api.del(`/api/disposals/${x.id}`); onSaved(); } catch (e) { toastError(e); } };
  return html`<${Modal} title=${x ? 'Edit disposal' : 'Add a disposal (capital gain)'} onClose=${onClose} footer=${html`${x && html`<${Btn} kind="danger" onClick=${del}>Delete</${Btn}>`}<span class="grow"></span><${Btn} onClick=${onClose}>Cancel</${Btn}><${Btn} kind="primary" onClick=${save}>Save</${Btn}>`}>
    ${err._ && html`<${Notice} tone="error">${err._}</${Notice}>`}
    <div class="form-grid"><${Field} label="What did you sell?" class="span2" error=${err.description}><input type="text" value=${f.description} onInput=${(e) => set('description', e.target.value)} /></${Field}>
      <${Field} label="Type"><select value=${f.asset_type} onChange=${(e) => set('asset_type', e.target.value)}><option value="shares">Shares</option><option value="property">Property</option><option value="crypto">Crypto</option><option value="other">Other</option></select></${Field}>
      <${Field} label="Residential property?"><label class="check"><input type="checkbox" checked=${!!f.residential} onChange=${(e) => set('residential', e.target.checked)} /> Yes</label></${Field}>
      <${Field} label="Date bought"><input type="date" value=${f.acquired_date || ''} onInput=${(e) => set('acquired_date', e.target.value)} /></${Field}><${Field} label="Date sold" error=${err.disposal_date}><input type="date" value=${f.disposal_date} onInput=${(e) => set('disposal_date', e.target.value)} /></${Field}>
      <${Field} label="Sale proceeds"><${MoneyInput} value=${f.proceeds} onChange=${(v) => set('proceeds', v)} /></${Field}><${Field} label="What you paid"><${MoneyInput} value=${f.cost} onChange=${(v) => set('cost', v)} /></${Field}><${Field} label="Fees & other allowable costs"><${MoneyInput} value=${f.costs} onChange=${(v) => set('costs', v)} /></${Field}></div>
    <p style="margin-top:12px"><strong>Gain: ${gbp(gain)}</strong></p></${Modal}>`;
}

function BusinessTab({ d, year, reload }) {
  const { draft, set, save, saving, dirty } = useDraft({ ...d.inputs, homeOfficeHours: d.inputs.homeOfficeHours || {} }, year);
  const [modal, setModal] = useState(null);
  const mileage = useAsync(() => api.get(`/api/mileage?taxYear=${year}`), [year, d]);
  const claim = useAsync(() => api.get(`/api/tax/${year}/drill?field=se.travel`), [year, d]);
  const assets = useAsync(() => api.get('/api/assets'), [d]);
  const ca = useAsync(() => api.get(`/api/tax/${year}/capital-allowances`), [year, d]);
  const disposals = useAsync(() => api.get(`/api/disposals?taxYear=${year}`), [year, d]);
  const [trip, setTrip] = useState({ date: isoToday(), from_place: '', to_place: '', miles: '', purpose: '', vehicle: 'car' });
  const addTrip = async () => { try { await api.post('/api/mileage', { ...trip, miles: Number(trip.miles) }); toast('Trip added'); setTrip({ ...trip, miles: '', from_place: '', to_place: '', purpose: '' }); reload(); mileage.reload(); } catch (e) { toastError(e); } };
  const delTrip = async (id) => { try { await api.del(`/api/mileage/${id}`); reload(); mileage.reload(); } catch (e) { toastError(e); } };
  const startY = Number(year.slice(0, 4));
  const months = Array.from({ length: 12 }, (_, i) => { const m = ((3 + i) % 12) + 1; const y = m >= 4 ? startY : startY + 1; return `${y}-${String(m).padStart(2, '0')}`; });
  const hrs = draft.homeOfficeHours || {};
  const flat = (h) => (h >= 101 ? 26 : h >= 51 ? 18 : h >= 25 ? 10 : 0);
  const homeTotal = months.reduce((a, m) => a + flat(Number(hrs[m]) || 0), 0);
  const keys = ['tradingAllowance', 'propertyAllowance', 'seOwnUse', 'seOtherAdjustments', 'seLossesBF', 'propLossesBF', 'propFinanceBF', 'cgtLossesBF', 'homeOfficeHours'];
  const trips = (claim.data?.rows || []).filter((r) => r.source === 'mileage');
  const total = trips.reduce((a, r) => a + r.net, 0);
  const done = () => { setModal(null); reload(); };
  return html`<div class="stack">
    <div class="card"><h2 style="margin-bottom:6px">Mileage log</h2><p class="muted small">HMRC's simplified rate: 45p/mile for the first 10,000 business miles in the year, then 25p. Don't also claim fuel or running costs for the same car.</p>
      <div class="form-grid" style="margin:10px 0"><${Field} label="Date"><input type="date" value=${trip.date} onInput=${(e) => setTrip({ ...trip, date: e.target.value })} /></${Field}><${Field} label="From"><input type="text" value=${trip.from_place} onInput=${(e) => setTrip({ ...trip, from_place: e.target.value })} /></${Field}><${Field} label="To"><input type="text" value=${trip.to_place} onInput=${(e) => setTrip({ ...trip, to_place: e.target.value })} /></${Field}><${Field} label="Miles"><input type="number" min="0" step="0.1" value=${trip.miles} onInput=${(e) => setTrip({ ...trip, miles: e.target.value })} /></${Field}><${Field} label="Vehicle"><select value=${trip.vehicle} onChange=${(e) => setTrip({ ...trip, vehicle: e.target.value })}><option value="car">Car / van</option><option value="motorcycle">Motorcycle</option><option value="bicycle">Bicycle</option></select></${Field}><${Field} label="Purpose" class="span2"><input type="text" value=${trip.purpose} onInput=${(e) => setTrip({ ...trip, purpose: e.target.value })} /></${Field}><div style="align-self:end"><${Btn} kind="primary" onClick=${addTrip} disabled=${!trip.miles}>Add trip</${Btn}></div></div>
      ${(mileage.data || []).length > 0 && html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Trip</th><th class="num">Miles</th><th class="num">Claim</th><th></th></tr></thead><tbody>${mileage.data.map((m) => html`<tr><td class="nowrap">${fmtDate(m.date)}</td><td>${m.from_place} → ${m.to_place}<div class="muted small">${m.purpose}</div></td><td class="num">${m.miles}</td><td class="num">${gbp((trips.find((t) => t.id === m.id) || {}).net || 0)}</td><td><button class="btn ghost small" aria-label="Delete trip" onClick=${() => delTrip(m.id)}><${Icon} name="trash" size=${14} /></button></td></tr>`)}</tbody><tfoot><tr><td colspan="3">Total claim</td><td class="num">${gbp(total)}</td><td></td></tr></tfoot></table></div>`}</div>
    <div class="card"><h2 style="margin-bottom:6px">Use of home (flat rate)</h2><p class="muted small">Hours you worked from home each month: 25–50 hrs = £10, 51–100 = £18, 101+ = £26. Claimed as an "other expense".</p>
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(110px,1fr));margin:10px 0">${months.map((m) => html`<${Field} label=${`${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(2, 4)}`} hint=${flat(Number(hrs[m]) || 0) ? `£${flat(Number(hrs[m]))}` : ''}><input type="number" min="0" max="744" value=${hrs[m] ?? ''} onInput=${(e) => set('homeOfficeHours', { ...hrs, [m]: e.target.value === '' ? undefined : Number(e.target.value) })} /></${Field}>`)}</div><p><strong>Total: ${gbp(homeTotal * 100)}</strong></p></div>
    <div class="card"><div class="card-head"><h2 class="grow">Allowances, adjustments & losses</h2></div><div class="form-grid">
      <${Field} label="£1,000 trading allowance" hint="Replaces your actual expenses"><select value=${draft.tradingAllowance} onChange=${(e) => set('tradingAllowance', e.target.value)}><option value="auto">Use it only if it saves tax</option><option value="claim">Always use it</option><option value="no">Never – claim actual expenses</option></select></${Field}>
      <${Field} label="£1,000 property allowance"><select value=${draft.propertyAllowance} onChange=${(e) => set('propertyAllowance', e.target.value)}><option value="auto">Use it only if it saves tax</option><option value="claim">Always use it</option><option value="no">Never – claim actual expenses</option></select></${Field}>
      <${M} label="Goods/services taken for your own use" k="seOwnUse" draft=${draft} set=${set} /><${M} label="Other profit adjustments (+/−)" k="seOtherAdjustments" neg draft=${draft} set=${set} />
      <${M} label="Business losses brought forward" k="seLossesBF" draft=${draft} set=${set} /><${M} label="Property losses brought forward" k="propLossesBF" draft=${draft} set=${set} /><${M} label="Unused mortgage-interest relief brought forward" k="propFinanceBF" draft=${draft} set=${set} /><${M} label="Capital losses brought forward" k="cgtLossesBF" draft=${draft} set=${set} /></div>
      <div class="row" style="margin-top:12px"><${Btn} kind="primary" disabled=${!dirty || saving} onClick=${() => save(keys, reload)}>${saving ? 'Saving…' : 'Save changes'}</${Btn}></div></div>
    <div class="card"><div class="card-head"><h2 class="grow">Assets & capital allowances</h2><${Btn} small icon="plus" onClick=${() => setModal({ asset: {} })}>Add asset</${Btn}></div>
      ${ca.data && html`<p class="small">This year's allowances: <strong>${gbp(ca.data.total)}</strong>${ca.data.aia ? ` (AIA ${gbp(ca.data.aia)})` : ''}${ca.data.fya ? ` (first-year ${gbp(ca.data.fya)})` : ''}${ca.data.poolsDetail.main.wda ? ` (main pool ${gbp(ca.data.poolsDetail.main.wda)})` : ''}${ca.data.poolsDetail.special.wda ? ` (special pool ${gbp(ca.data.poolsDetail.special.wda)})` : ''}${ca.data.balancingCharges ? `. Balancing charge ${gbp(ca.data.balancingCharges)}` : ''}.</p>`}
      ${(assets.data || []).length === 0 ? html`<p class="muted small">None recorded.</p>` : html`<div class="table-wrap"><table><thead><tr><th>Asset</th><th>Bought</th><th>Type</th><th class="num">Cost</th><th class="num">Business</th></tr></thead><tbody>${assets.data.map((a) => html`<tr class="clickable" onClick=${() => setModal({ asset: a })}><td>${a.name}${a.disposal_date ? html` <${Badge}>Sold</${Badge}>` : ''}</td><td>${fmtDate(a.purchase_date)}</td><td class="small">${POOLS[a.pool]}</td><td class="num">${gbp(a.cost)}</td><td class="num">${a.business_pct}%</td></tr>`)}</tbody></table></div>`}</div>
    <div class="card"><div class="card-head"><h2 class="grow">Capital gains (shares, property, crypto)</h2><${Btn} small icon="plus" onClick=${() => setModal({ disposal: {} })}>Add disposal</${Btn}></div>
      ${(disposals.data || []).length === 0 ? html`<p class="muted small">No disposals in ${year.replace('-', '/')}.</p>` : html`<div class="table-wrap"><table><thead><tr><th>Sold</th><th>Date</th><th class="num">Proceeds</th><th class="num">Cost</th><th class="num">Gain</th></tr></thead><tbody>${disposals.data.map((x) => html`<tr class="clickable" onClick=${() => setModal({ disposal: x })}><td>${x.description}</td><td>${fmtDate(x.disposal_date)}</td><td class="num">${gbp(x.proceeds)}</td><td class="num">${gbp(x.cost + x.costs)}</td><td class="num">${gbp(x.proceeds - x.cost - x.costs)}</td></tr>`)}</tbody></table></div>`}
      ${d.cgt && html`<p class="small" style="margin-top:10px">Annual exempt amount used ${gbp(d.cgt.aeaUsed)} · taxable gain ${gbp(d.cgt.taxableGain)} · <strong>CGT ${gbp(d.cgt.tax)}</strong></p>`}</div>
    ${modal?.asset && html`<${AssetModal} a=${modal.asset.id ? modal.asset : null} onClose=${() => setModal(null)} onSaved=${done} />`}
    ${modal?.disposal && html`<${DisposalModal} x=${modal.disposal.id ? modal.disposal : null} onClose=${() => setModal(null)} onSaved=${done} />`}
  </div>`;
}

// ------------------------------------------------------------------------------------------ worksheets
function Drill({ year, field, label, onClose }) {
  const { data, error } = useAsync(() => api.get(`/api/tax/${year}/drill?field=${encodeURIComponent(field)}`), [field]);
  return html`<${Modal} wide title=${`What makes up: ${label}`} onClose=${onClose}>${error ? html`<${Loading} error=${error} />` : !data ? html`<${Loading} />` : html`
    <div class="table-wrap" style="max-height:60vh;overflow:auto"><table><thead><tr><th>Date</th><th>Description</th><th>Where from</th><th class="num">Counted</th></tr></thead><tbody>
    ${data.rows.map((r) => html`<tr><td class="nowrap">${fmtDate(r.date)}</td><td>${r.description}${r.businessPct < 100 ? html` <${Badge}>${r.businessPct}% business</${Badge}>` : ''}</td><td class="small muted">${{ txn: 'Bank transaction', invoice: 'Invoice', mileage: 'Mileage log', homeoffice: 'Home-office flat rate' }[r.source]}${r.source === 'invoice' ? html` <a href=${`#/invoices/${r.id}`}>open</a>` : ''}</td><td class="num">${gbp(r.net)}</td></tr>`)}</tbody><tfoot><tr><td colspan="3">Total</td><td class="num">${gbp(data.total)}</td></tr></tfoot></table></div>
    <p class="muted small" style="margin-top:8px">Amounts exclude VAT (if you're VAT registered) and reflect any business-use percentage.</p>`}</${Modal}>`;
}

function Forms({ d, year }) {
  const [drill, setDrill] = useState(null);
  const [all, setAll] = useState(false);
  const forms = d.forms.filter((f) => all || f.applies !== false);
  return html`<div class="stack">
    <div class="row"><a class="btn primary" href=${`/api/tax/${year}/pdf?form=all&download=1`}><${Icon} name="download" /> Download all worksheets (PDF)</a><a class="btn" href=${`/api/tax/${year}/export.json`}>Export JSON</a><label class="check small"><input type="checkbox" checked=${all} onChange=${(e) => setAll(e.target.checked)} /> Show forms that don't apply</label></div>
    <${Notice}>These are <strong>worksheets that mirror HMRC's forms</strong>, not official forms. Box numbers are shown where they were cross-checked against HMRC's 2025–26 forms; a dagger † marks boxes inferred from the form's numbering. HMRC's online service asks for the same figures by name.</${Notice}>
    ${forms.map((f) => html`<div class="card" key=${f.id}><div class="card-head"><h2 class="grow">${f.title}</h2>${f.applies === false ? html`<${Badge}>Not needed</${Badge}>` : ''}<a class="btn small" href=${`/api/tax/${year}/pdf?form=${f.id}`} target="_blank">PDF</a></div>
      <p class="muted small">${f.intro}</p>
      ${f.pages.filter((p) => p.rows.length).map((p) => html`<div class="ws-title">${p.title}</div>${p.rows.map((r) => html`<div class=${`ws-row${r.emphasis ? ' emph' : ''}`}><span class="box">${r.box ? `Box ${r.box}${r.inferred ? '†' : ''}` : ''}</span><span>${r.label}${r.field ? html`<button class="ws-drill" onClick=${() => setDrill({ field: r.field, label: r.label })}>see transactions</button>` : ''}${r.note ? html`<div class="muted small">${r.note}</div>` : ''}</span><span class="val">${r.type === 'money' ? gbp(r.value) : r.type === 'yesno' ? (r.value ? 'Yes' : 'No') : r.value ?? ''}</span></div>`)}`)}</div>`)}
    ${drill && html`<${Drill} year=${year} field=${drill.field} label=${drill.label} onClose=${() => setDrill(null)} />`}
  </div>`;
}

// ------------------------------------------------------------------------------------------ payments
function Payments({ d, year, reload }) {
  const [list, setList] = useState(d.inputs.payments || []);
  const [dirty, setDirty] = useState(false);
  const sugg = useAsync(() => api.get(`/api/tax/${year}/hmrc-payments`), [year]);
  const upd = (next) => { setList(next); setDirty(true); };
  const save = async () => { try { await api.put(`/api/tax/${year}/inputs`, { payments: list }); toast('Saved'); setDirty(false); reload(); } catch (e) { toastError(e); } };
  const has = (s) => list.some((p) => p.date === s.date && p.amount === s.amount);
  return html`<div class="stack">
    <div class="card"><h2 style="margin-bottom:6px">Payments to HMRC that count towards ${year.replace('-', '/')}</h2>
      <p class="muted small">Your January and July payments on account for this year, plus any balancing payment for earlier years that HMRC allocated here. They reduce what you owe.</p>
      ${list.map((p, i) => html`<div class="row" style="margin:8px 0;flex-wrap:nowrap"><input type="date" style="width:160px" value=${p.date} onInput=${(e) => upd(list.map((x, k) => k === i ? { ...x, date: e.target.value } : x))} /><div style="width:150px"><${MoneyInput} value=${p.amount} onChange=${(v) => upd(list.map((x, k) => k === i ? { ...x, amount: v || 0 } : x))} /></div><input type="text" placeholder="Note" value=${p.note || ''} onInput=${(e) => upd(list.map((x, k) => k === i ? { ...x, note: e.target.value } : x))} /><button class="btn ghost small" aria-label="Remove" onClick=${() => upd(list.filter((_, k) => k !== i))}><${Icon} name="x" size=${14} /></button></div>`)}
      <div class="row" style="margin-top:8px"><${Btn} small icon="plus" onClick=${() => upd([...list, { date: isoToday(), amount: 0, note: '' }])}>Add payment</${Btn}><${Btn} kind="primary" small disabled=${!dirty} onClick=${save}>Save</${Btn}></div></div>
    ${sugg.data?.length > 0 && html`<div class="card"><h3 style="margin-bottom:8px">Found in your bank transactions</h3><p class="muted small">Categorised as “HMRC tax payment”. Add the ones that belong to this tax year.</p>
      ${sugg.data.map((s) => html`<div class="row small" style="padding:5px 0;border-bottom:1px solid var(--border)"><span class="nowrap">${fmtDate(s.date)}</span><span class="grow">${s.description}</span><strong>${gbp(s.amount)}</strong>${has(s) ? html`<${Badge} tone="good">Added</${Badge}>` : html`<${Btn} small onClick=${() => upd([...list, { date: s.date, amount: s.amount, note: s.description.slice(0, 40) }])}>Add</${Btn}>`}</div>`)}</div>`}
    <div class="card"><h3>Key dates</h3><table><tbody><${Line} label="Online filing and balancing payment" value=${fmtDate(d.deadlines.online)} /><${Line} label="Paper return deadline" value=${fmtDate(d.deadlines.paper)} /><${Line} label="Keep your records until" value=${fmtDate(d.deadlines.keepRecordsUntil)} /></tbody></table></div>
  </div>`;
}

export default function Tax({ query }) {
  const { meta, taxYear } = useStore();
  const year = taxYear || meta.currentTaxYear;
  const tab = query.tab || 'overview';
  const { data: d, error, loading, reload } = useAsync(() => api.get(`/api/tax/${year}`), [year]);
  const issues = d ? d.warnings.filter((w) => w.level !== 'info').length : 0;
  return html`<div>
    <${PageHead} title="Tax return" sub=${d ? `Self Assessment ${year.replace('-', '/')} · ${fmtDate(d.period.start)} to ${fmtDate(d.period.end)}` : ''}>
      <${TaxYearSelect} value=${year} years=${meta.taxYears} onChange=${(y) => setTaxYear(y)} />
      <a class="btn" href=${`/api/tax/${year}/pdf?form=all`} target="_blank"><${Icon} name="pdf" /> Worksheets PDF</a></${PageHead}>
    <${Tabs} value=${tab} onChange=${(t) => go(`/tax?tab=${t}`)} tabs=${[{ id: 'overview', label: 'Overview', badge: issues || '' }, { id: 'income', label: 'Income & reliefs' }, { id: 'business', label: 'Business extras' }, { id: 'forms', label: 'Worksheets' }, { id: 'payments', label: 'Payments' }]} />
    ${error && !d && html`<${Loading} error=${error} retry=${reload} />`}
    ${!d && !error && html`<${Loading} />`}
    ${d && html`<div style=${loading ? 'opacity:.6' : ''} key=${year}>
      ${tab === 'overview' && html`<${Overview} d=${d} year=${year} />`}${tab === 'income' && html`<${IncomeTab} d=${d} year=${year} reload=${reload} />`}
      ${tab === 'business' && html`<${BusinessTab} d=${d} year=${year} reload=${reload} />`}${tab === 'forms' && html`<${Forms} d=${d} year=${year} />`}${tab === 'payments' && html`<${Payments} d=${d} year=${year} reload=${reload} />`}</div>`}
  </div>`;
}
