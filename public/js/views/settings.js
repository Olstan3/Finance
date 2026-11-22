import { useState, useEffect } from 'preact/hooks';
import { html, Btn, Badge, Notice, Modal, Field, MoneyInput, Empty, Loading, useAsync, Tabs, Seg } from '../components/ui.js';
import { CategorySelect, PageHead } from '../components/shared.js';
import { api } from '../api.js';
import { useStore, refreshMeta, toast, toastError } from '../store.js';
import { gbp } from '../util.js';
import { go } from '../main.js';

function useSettingsForm(path) {
  const { meta } = useStore();
  const [f, setF] = useState(() => JSON.parse(JSON.stringify(meta.settings)));
  const [err, setErr] = useState({}); const [saving, setSaving] = useState(false); const [dirty, setDirty] = useState(false);
  const set = (group, k, v) => { setF((x) => (group ? { ...x, [group]: { ...x[group], [k]: v } } : { ...x, [k]: v })); setDirty(true); };
  const save = async (patch) => {
    setSaving(true); setErr({});
    try { await api.put('/api/settings', patch); await refreshMeta(); toast('Settings saved'); setDirty(false); }
    catch (e) { setErr({ [e.field || '_']: e.message }); }
    setSaving(false);
  };
  return { f, set, err, saving, dirty, save };
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function Details() {
  const { f, set, err, saving, dirty, save } = useSettingsForm();
  const p = f.profile, c = f.company;
  const co = f.entityType === 'company';
  const dirs = c.directors || [];
  const setDir = (i, patch) => set('company', 'directors', dirs.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  return html`<div class="stack">
    <div class="card stack"><h2>What kind of business is this?</h2>
      <${Seg} label="Business type" value=${f.entityType} onChange=${(v) => set(null, 'entityType', v)} options=${[{ value: 'individual', label: 'Self-employed / landlord' }, { value: 'company', label: 'Limited company' }]} />
      <p class="muted small" style="margin:0">${co ? 'A limited company files a Company Tax Return (CT600) and accounts, uses accruals accounting, and its directors are paid by dividends or salary.' : 'You file a Self Assessment tax return with supplementary pages (SA103 self-employment, SA105 property…).'} You can switch later; your records are kept either way.</p></div>
    ${err._ && html`<${Notice} tone="error">${err._}</${Notice}>`}
    ${co ? html`<div class="card stack"><h2>Company details</h2><div class="form-grid">
        <${Field} label="Company name" class="span2"><input type="text" value=${c.name} onInput=${(e) => set('company', 'name', e.target.value)} /></${Field}>
        <${Field} label="Company number" hint="From Companies House, 8 characters" error=${err.number}><input type="text" value=${c.number} onInput=${(e) => set('company', 'number', e.target.value)} /></${Field}>
        <${Field} label="Corporation Tax UTR" hint="10 digits, sent by HMRC after you register for Corporation Tax" error=${err.utr}><input type="text" inputmode="numeric" value=${c.utr} onInput=${(e) => set('company', 'utr', e.target.value)} /></${Field}>
        <${Field} label="Date incorporated" error=${err.incorporationDate}><input type="date" value=${c.incorporationDate || ''} onInput=${(e) => set('company', 'incorporationDate', e.target.value)} /></${Field}>
        <${Field} label="Financial year ends" hint="Your accounting reference date"><div class="row" style="flex-wrap:nowrap"><input type="number" min="1" max="31" style="width:80px" value=${c.yearEndDay} onInput=${(e) => set('company', 'yearEndDay', Number(e.target.value))} /><select value=${c.yearEndMonth} onChange=${(e) => set('company', 'yearEndMonth', Number(e.target.value))}>${MONTH_NAMES.map((m, i) => html`<option value=${i + 1}>${m}</option>`)}</select></div></${Field}>
        <${Field} label="Registered office" class="span2"><textarea value=${c.registeredOffice} onInput=${(e) => set('company', 'registeredOffice', e.target.value)} /></${Field}><${Field} label="Postcode"><input type="text" value=${c.postcode} onInput=${(e) => set('company', 'postcode', e.target.value)} /></${Field}>
        <${Field} label="What the company does" class="span2"><input type="text" value=${c.natureOfBusiness} onInput=${(e) => set('company', 'natureOfBusiness', e.target.value)} /></${Field}>
        <${Field} label="Share capital paid in (£)" hint="e.g. 100 for 100 £1 shares" error=${err.shareCapital}><input type="number" min="0" step="any" value=${c.shareCapital} onInput=${(e) => set('company', 'shareCapital', Number(e.target.value))} /></${Field}>
        <${Field} label="Associated companies" hint="Others under common control. Usually 0." error=${err.associatedCompanies}><input type="number" min="0" value=${c.associatedCompanies} onInput=${(e) => set('company', 'associatedCompanies', Number(e.target.value))} /></${Field}></div></div>
      <div class="card stack"><div class="card-head"><h2 class="grow">Directors & shareholders</h2><${Btn} small icon="plus" onClick=${() => set('company', 'directors', [...dirs, { id: '', name: '', shares: 0 }])}>Add</${Btn}></div>
        <p class="muted small" style="margin:0">Each person gets a director's-loan account automatically. Shares decide how dividends are split.</p>
        ${err.directors && html`<div class="field-error">${err.directors}</div>`}
        ${dirs.length === 0 && html`<p class="muted small">No directors added yet.</p>`}
        ${dirs.map((d, i) => html`<div class="row" style="flex-wrap:nowrap"><input type="text" aria-label="Director name" placeholder="Full name" value=${d.name} onInput=${(e) => setDir(i, { name: e.target.value })} /><input type="number" aria-label="Shares" min="0" style="width:120px" placeholder="Shares" value=${d.shares} onInput=${(e) => setDir(i, { shares: Number(e.target.value) })} /><button class="btn ghost small" aria-label="Remove director" onClick=${() => set('company', 'directors', dirs.filter((_, k) => k !== i))}>✕</button></div>`)}</div>
      <div class="card stack"><h2>Contact details for invoices</h2><div class="form-grid"><${Field} label="Email" error=${err.email}><input type="email" value=${p.email} onInput=${(e) => set('profile', 'email', e.target.value)} /></${Field}><${Field} label="Phone"><input type="tel" value=${p.phone} onInput=${(e) => set('profile', 'phone', e.target.value)} /></${Field}>
        <${Field} label="Other names the company appears under" class="full" hint="Comma-separated. Helps tell whether an uploaded invoice is one you sent (income) or received (expense)."><input type="text" value=${p.aliases} onInput=${(e) => set('profile', 'aliases', e.target.value)} /></${Field}></div></div>`
    : html`<div class="card stack"><div class="form-grid"><${Field} label="Your full name" class="span2"><input type="text" value=${p.name} onInput=${(e) => set('profile', 'name', e.target.value)} /></${Field}>
      <${Field} label="Trading name" hint="If different"><input type="text" value=${p.tradingName} onInput=${(e) => set('profile', 'tradingName', e.target.value)} /></${Field}>
      <${Field} label="Unique Taxpayer Reference (UTR)" hint="10 digits, from HMRC" error=${err.utr}><input type="text" inputmode="numeric" value=${p.utr} onInput=${(e) => set('profile', 'utr', e.target.value)} /></${Field}>
      <${Field} label="National Insurance number" error=${err.nino}><input type="text" value=${p.nino} onInput=${(e) => set('profile', 'nino', e.target.value)} /></${Field}>
      <${Field} label="Email" error=${err.email}><input type="email" value=${p.email} onInput=${(e) => set('profile', 'email', e.target.value)} /></${Field}>
      <${Field} label="Phone"><input type="tel" value=${p.phone} onInput=${(e) => set('profile', 'phone', e.target.value)} /></${Field}>
      <${Field} label="Address" class="span2"><textarea value=${p.address} onInput=${(e) => set('profile', 'address', e.target.value)} /></${Field}><${Field} label="Postcode"><input type="text" value=${p.postcode} onInput=${(e) => set('profile', 'postcode', e.target.value)} /></${Field}>
      <${Field} label="What your business does" class="span2"><input type="text" value=${p.businessDescription} onInput=${(e) => set('profile', 'businessDescription', e.target.value)} /></${Field}><${Field} label="Business postcode"><input type="text" value=${p.businessPostcode} onInput=${(e) => set('profile', 'businessPostcode', e.target.value)} /></${Field}>
      <${Field} label="Other names you appear under on documents" class="full" hint="Comma-separated. Used to tell whether an uploaded invoice is one you sent (income) or received (expense)."><input type="text" value=${p.aliases} placeholder="e.g. ST Design, S Taylor" onInput=${(e) => set('profile', 'aliases', e.target.value)} /></${Field}></div></div>`}
    <div><${Btn} kind="primary" disabled=${!dirty || saving} onClick=${() => save({ entityType: f.entityType, profile: f.profile, ...(co || f.company.name ? { company: f.company } : {}) })}>Save</${Btn}></div></div>`;
}

function TaxVat() {
  const { f, set, err, saving, dirty, save } = useSettingsForm();
  return html`<div class="stack">
    ${f.entityType === 'company' ? html`<div class="card stack"><h2>Tax</h2><p class="muted small" style="margin:0">Limited companies pay Corporation Tax on profit and must use accruals accounting (income counted when invoiced or earned, not when paid). Set your year end and company details under <a href="#/settings">Your details</a>.</p></div>`
    : html`<div class="card stack"><h2>Tax</h2>${err._ && html`<${Notice} tone="error">${err._}</${Notice}>`}
      <div class="form-grid"><${Field} label="Where you live for tax" hint="Scottish taxpayers have different Income Tax bands"><select value=${f.profile.region} onChange=${(e) => set('profile', 'region', e.target.value)}><option value="england">England, Wales or Northern Ireland</option><option value="scotland">Scotland</option></select></${Field}>
        <${Field} label="How income is counted" hint="Cash basis is the default for sole traders: income when paid, expenses when paid."><select value=${f.accountingBasis} onChange=${(e) => set(null, 'accountingBasis', e.target.value)}><option value="cash">Cash basis (when money moves)</option><option value="accruals">Traditional accounting (when invoiced)</option></select></${Field}>
        <${Field} label="Business start date" hint="Optional"><input type="date" value=${f.businessStartDate || ''} onInput=${(e) => set(null, 'businessStartDate', e.target.value)} /></${Field}>
        <${Field} label="MTD quarters" hint="Standard (6 Apr–5 Jul…) or calendar (1 Apr–30 Jun…)"><select value=${f.mtd.quarterlyScheme} onChange=${(e) => set('mtd', 'quarterlyScheme', e.target.value)}><option value="standard">Standard quarters</option><option value="calendar">Calendar quarters</option></select></${Field}></div></div>`}
    <div class="card stack"><h2>VAT</h2><label class="check"><input type="checkbox" checked=${f.vat.registered} onChange=${(e) => set('vat', 'registered', e.target.checked)} /> I'm VAT registered</label>
      ${f.vat.registered && html`<div class="form-grid"><${Field} label="VAT number"><input type="text" value=${f.vat.number} onInput=${(e) => set('vat', 'number', e.target.value)} /></${Field}>
        <${Field} label="Accounting scheme"><select value=${f.vat.scheme} onChange=${(e) => set('vat', 'scheme', e.target.value)}><option value="standard">Standard (VAT on invoice date)</option><option value="cash">Cash accounting (VAT when paid)</option></select></${Field}>
        <${Field} label="Quarter ends" hint="Your VAT stagger group"><select value=${[1, 2, 3].includes(Number(f.vat.stagger)) ? Number(f.vat.stagger) : 1} onChange=${(e) => set('vat', 'stagger', Number(e.target.value))}><option value="1">Mar / Jun / Sep / Dec</option><option value="2">Jan / Apr / Jul / Oct</option><option value="3">Feb / May / Aug / Nov</option></select></${Field}>
        ${f.entityType === 'company' && html`<${Field} label="Ad-network and app-store payouts" hint="Depends on which company pays you (check AdMob, Apple and Google Play payment documents), not on where your users are. Overseas payers are shown in Box 6."><select value=${f.vat.platformPayouts || 'undecided'} onChange=${(e) => set('vat', 'platformPayouts', e.target.value)}><option value="undecided">Not decided – flag each payout</option><option value="OB">Overseas company – outside UK VAT</option><option value="S">UK company – 20% VAT included</option></select></${Field}>`}</div><p class="muted small">The flat-rate scheme isn't supported. Registering means invoices can show VAT and income/expenses are reported excluding it.${f.entityType === 'company' ? ' For overseas customers (ad networks, app stores) use the VAT code “Sale to overseas business”; for hosting, domains and software bought from overseas suppliers use “Reverse charge”.' : ''}</p>`}</div>
    <div class="card stack"><h2>Importing</h2><${Field} label=${`Confidence needed to mark an imported row as "checked": ${Math.round(f.importer.autoRecordConfidence * 100)}%`} hint="Rows below this are saved but flagged for review. Higher = you check more."><input type="range" min="0.4" max="0.95" step="0.05" value=${f.importer.autoRecordConfidence} onInput=${(e) => set('importer', 'autoRecordConfidence', Number(e.target.value))} /></${Field}></div>
    <div><${Btn} kind="primary" disabled=${!dirty || saving} onClick=${() => save({ profile: { region: f.profile.region }, accountingBasis: f.accountingBasis, businessStartDate: f.businessStartDate, mtd: f.mtd, vat: { ...f.vat, stagger: [1, 2, 3].includes(Number(f.vat.stagger)) ? Number(f.vat.stagger) : 1 }, importer: f.importer })}>Save</${Btn}></div></div>`;
}

function Invoicing() {
  const { f, set, err, saving, dirty, save } = useSettingsForm();
  const i = f.invoice;
  const n = (k) => (e) => set('invoice', k, e.target.value === '' ? '' : Number(e.target.value));
  return html`<div class="card stack">${err._ && html`<${Notice} tone="error">${err._}</${Notice}>`}
    <div class="form-grid"><${Field} label="Invoice prefix"><input type="text" value=${i.prefix} onInput=${(e) => set('invoice', 'prefix', e.target.value)} /></${Field}><${Field} label="Next invoice number" error=${err.nextNumber}><input type="number" min="1" value=${i.nextNumber} onInput=${n('nextNumber')} /></${Field}>
      <${Field} label="Credit note prefix"><input type="text" value=${i.creditPrefix} onInput=${(e) => set('invoice', 'creditPrefix', e.target.value)} /></${Field}><${Field} label="Next credit note number"><input type="number" min="1" value=${i.nextCreditNumber} onInput=${n('nextCreditNumber')} /></${Field}>
      <${Field} label="Default payment terms (days)"><input type="number" min="0" value=${i.paymentTermsDays} onInput=${n('paymentTermsDays')} /></${Field}>
      <${Field} label="Your payment details" class="span2" hint="Printed on every invoice"><textarea value=${i.bankDetails} placeholder=${'Account name\nSort code 00-00-00\nAccount 00000000'} onInput=${(e) => set('invoice', 'bankDetails', e.target.value)} /></${Field}>
      <${Field} label="Default notes" class="span2"><textarea value=${i.notes} onInput=${(e) => set('invoice', 'notes', e.target.value)} /></${Field}><${Field} label="Footer line" class="full"><input type="text" value=${i.footer} onInput=${(e) => set('invoice', 'footer', e.target.value)} /></${Field}></div>
    <div><${Btn} kind="primary" disabled=${!dirty || saving} onClick=${() => save({ invoice: f.invoice })}>Save</${Btn}></div></div>`;
}

function Accounts() {
  const { meta } = useStore();
  const [modal, setModal] = useState(null);
  const [f, setF] = useState({ name: '', kind: 'bank', opening_balance: 0 });
  const save = async () => { try { modal.id ? await api.put(`/api/accounts/${modal.id}`, f) : await api.post('/api/accounts', f); toast('Saved'); await refreshMeta(); setModal(null); } catch (e) { toastError(e); } };
  const del = async () => { if (!confirm('Remove this account? If it has transactions it will be archived instead.')) return; try { await api.del(`/api/accounts/${modal.id}`); await refreshMeta(); setModal(null); } catch (e) { toastError(e); } };
  const open = (a) => { setF(a ? { name: a.name, kind: a.kind, opening_balance: a.opening_balance ?? 0 } : { name: '', kind: 'bank', opening_balance: 0 }); setModal(a || {}); };
  return html`<div class="card"><div class="card-head"><h2 class="grow">Accounts</h2><${Btn} small icon="plus" onClick=${() => open(null)}>Add account</${Btn}></div>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th class="num">Balance</th></tr></thead><tbody>${meta.accounts.map((a) => html`<tr class="clickable" onClick=${() => api.get('/api/accounts').then(() => open({ ...a, opening_balance: a.opening_balance ?? 0 }))}><td>${a.name}</td><td><${Badge}>${a.kind}</${Badge}></td><td class="num">${gbp(a.balance)}</td></tr>`)}</tbody></table></div>
    <p class="muted small" style="margin-top:8px">The “Cash & receipts” account holds receipts and invoices you upload that don't yet match a bank line. When the bank line arrives, the two are merged automatically.</p>
    ${modal && html`<${Modal} title=${modal.id ? 'Edit account' : 'Add account'} onClose=${() => setModal(null)} footer=${html`${modal.id && html`<${Btn} kind="danger" onClick=${del}>Remove</${Btn}>`}<span class="grow"></span><${Btn} onClick=${() => setModal(null)}>Cancel</${Btn}><${Btn} kind="primary" onClick=${save}>Save</${Btn}>`}>
      <div class="form-grid"><${Field} label="Name" class="span2"><input type="text" value=${f.name} onInput=${(e) => setF({ ...f, name: e.target.value })} /></${Field}><${Field} label="Type"><select value=${f.kind} onChange=${(e) => setF({ ...f, kind: e.target.value })}><option value="bank">Bank account</option><option value="card">Credit card</option><option value="paypal">PayPal / payment provider</option><option value="dla">Director's loan account</option><option value="cash">Cash</option><option value="other">Other</option></select></${Field}>
        <${Field} label="Opening balance"><${MoneyInput} allowNegative value=${f.opening_balance} onChange=${(v) => setF({ ...f, opening_balance: v ?? 0 })} /></${Field}></div></${Modal}>`}</div>`;
}

function CategoriesRules() {
  const { meta } = useStore();
  const rules = useAsync(() => api.get('/api/rules'), []);
  const [rule, setRule] = useState(null); const [cat, setCat] = useState(null); const [err, setErr] = useState('');
  const custom = meta.categories.filter((c) => !c.builtin);
  const saveRule = async () => { try { rule.id ? await api.put(`/api/rules/${rule.id}`, rule) : await api.post('/api/rules', rule); toast('Rule saved'); setRule(null); setErr(''); rules.reload(); } catch (e) { setErr(e.message); } };
  const delRule = async (r) => { try { await api.del(`/api/rules/${r.id}`); rules.reload(); } catch (e) { toastError(e); } };
  const saveCat = async () => { try { await api.post('/api/categories', cat); toast('Category added'); await refreshMeta(); setCat(null); setErr(''); } catch (e) { setErr(e.message); } };
  const delCat = async (c) => { if (!confirm(`Delete “${c.name}”?`)) return; try { await api.del(`/api/categories/${c.id}`); await refreshMeta(); } catch (e) { toastError(e); } };
  const taxFields = [...new Map(meta.categories.map((c) => [c.tax_field, c])).values()].filter((c) => c.tax_field !== 'none' && !c.tax_field.startsWith('tax.') && !c.tax_field.startsWith('vat.'));
  return html`<div class="stack">
    <div class="card"><div class="card-head"><h2 class="grow">Rules</h2><${Btn} small icon="plus" onClick=${() => setRule({ pattern: '', match_type: 'contains', direction: 'any', category_id: '', business_pct: 100 })}>Add rule</${Btn}></div>
      <p class="muted small">If a transaction's description contains the text, it gets that category automatically on import. Your rules always beat Ledgerline's built-in guesses. You can also create one from any transaction.</p>
      ${(rules.data || []).length === 0 ? html`<p class="muted">No rules yet.</p>` : html`<div class="table-wrap"><table><thead><tr><th>When description</th><th>Direction</th><th>Category</th><th class="num">Business %</th><th></th></tr></thead><tbody>${rules.data.map((r) => html`<tr><td>${{ contains: 'contains', starts: 'starts with', exact: 'is exactly', regex: 'matches' }[r.match_type]} <strong>${r.pattern}</strong></td><td>${{ any: 'Either', in: 'Money in', out: 'Money out' }[r.direction]}</td><td>${r.category_name}</td><td class="num">${r.business_pct}%</td><td class="right"><${Btn} small onClick=${() => setRule(r)}>Edit</${Btn}> <${Btn} small kind="danger" onClick=${() => delRule(r)}>Delete</${Btn}></td></tr>`)}</tbody></table></div>`}</div>
    <div class="card"><div class="card-head"><h2 class="grow">Your own categories</h2><${Btn} small icon="plus" onClick=${() => setCat({ name: '', kind: 'expense', tax_field: 'se.other' })}>Add category</${Btn}></div>
      <p class="muted small">Built-in categories map to HMRC's boxes. Add your own (e.g. “Studio props”) and choose which box it feeds.</p>
      ${custom.length === 0 ? html`<p class="muted">None yet.</p>` : custom.map((c) => html`<div class="row" style="padding:5px 0;border-bottom:1px solid var(--border)"><span class="grow">${c.name}</span><${Badge}>${c.kind}</${Badge}><${Btn} small kind="danger" onClick=${() => delCat(c)}>Delete</${Btn}></div>`)}</div>
    ${rule && html`<${Modal} title=${rule.id ? 'Edit rule' : 'New rule'} onClose=${() => setRule(null)} footer=${html`<${Btn} onClick=${() => setRule(null)}>Cancel</${Btn}><${Btn} kind="primary" onClick=${saveRule}>Save</${Btn}>`}>${err && html`<${Notice} tone="error">${err}</${Notice}>`}
      <div class="form-grid"><${Field} label="Match"><select value=${rule.match_type} onChange=${(e) => setRule({ ...rule, match_type: e.target.value })}><option value="contains">Contains</option><option value="starts">Starts with</option><option value="exact">Is exactly</option><option value="regex">Pattern (advanced)</option></select></${Field}><${Field} label="Text" class="span2"><input type="text" value=${rule.pattern} onInput=${(e) => setRule({ ...rule, pattern: e.target.value })} /></${Field}>
        <${Field} label="Money direction"><select value=${rule.direction} onChange=${(e) => setRule({ ...rule, direction: e.target.value })}><option value="any">In or out</option><option value="in">Money in only</option><option value="out">Money out only</option></select></${Field}>
        <${Field} label="Category" class="span2"><${CategorySelect} value=${rule.category_id} meta=${meta} onChange=${(v) => setRule({ ...rule, category_id: v })} /></${Field}><${Field} label="Business use %"><input type="number" min="0" max="100" value=${rule.business_pct} onInput=${(e) => setRule({ ...rule, business_pct: Number(e.target.value) })} /></${Field}></div></${Modal}>`}
    ${cat && html`<${Modal} title="New category" onClose=${() => setCat(null)} footer=${html`<${Btn} onClick=${() => setCat(null)}>Cancel</${Btn}><${Btn} kind="primary" onClick=${saveCat}>Save</${Btn}>`}>${err && html`<${Notice} tone="error">${err}</${Notice}>`}
      <div class="form-grid"><${Field} label="Name" class="span2"><input type="text" value=${cat.name} onInput=${(e) => setCat({ ...cat, name: e.target.value })} /></${Field}><${Field} label="Counts as"><select value=${cat.kind} onChange=${(e) => setCat({ ...cat, kind: e.target.value })}><option value="expense">Expense</option><option value="income">Income</option></select></${Field}>
        <${Field} label="Goes into this tax box" class="span2"><select value=${cat.tax_field} onChange=${(e) => setCat({ ...cat, tax_field: e.target.value })}>${taxFields.map((c) => html`<option value=${c.tax_field}>${c.name}</option>`)}</select></${Field}></div></${Modal}>`}
  </div>`;
}

function Security() {
  const { meta } = useStore();
  const st = useAsync(() => api.get('/api/auth/status'), []);
  const [cur, setCur] = useState(''); const [pw, setPw] = useState(''); const [err, setErr] = useState('');
  const locked = st.data?.locked;
  const setPass = async (remove) => { setErr(''); try { await api.put('/api/auth/passcode', { current: cur, passcode: remove ? '' : pw }); toast(remove ? 'Passcode removed' : 'Passcode set'); setCur(''); setPw(''); st.reload(); } catch (e) { setErr(e.message); } };
  const [typed, setTyped] = useState('');
  const reset = async () => { try { await api.post('/api/admin/reset', { confirm: typed }); toast('All records deleted'); setTyped(''); await refreshMeta(); go('/dashboard'); } catch (e) { toastError(e); } };
  return html`<div class="stack">
    <div class="card stack"><h2>Passcode</h2><p class="muted small">Your accounts are stored only on this computer and the app only listens on this machine. Add a passcode if other people use it or you expose it on a network.</p>
      ${err && html`<${Notice} tone="error">${err}</${Notice}>`}
      <div class="form-grid">${locked && html`<${Field} label="Current passcode"><input type="password" value=${cur} onInput=${(e) => setCur(e.target.value)} autocomplete="current-password" /></${Field}>`}<${Field} label=${locked ? 'New passcode' : 'Choose a passcode'} hint="At least 6 characters"><input type="password" value=${pw} onInput=${(e) => setPw(e.target.value)} autocomplete="new-password" /></${Field}></div>
      <div class="row"><${Btn} kind="primary" disabled=${pw.length < 6} onClick=${() => setPass(false)}>${locked ? 'Change passcode' : 'Set passcode'}</${Btn}>${locked && html`<${Btn} onClick=${() => setPass(true)}>Remove passcode</${Btn}>`}</div></div>
    <div class="card stack"><h2>Your data</h2><p class="muted small">Everything lives in one SQLite file (the <code>data</code> folder) plus the documents you upload. Back it up regularly – and keep your records for at least 5 years after the 31 January filing deadline.</p>
      <div class="row"><a class="btn" href="/api/backup">Download full backup (.sqlite)</a><a class="btn" href="/api/export/json">Export everything (JSON)</a><a class="btn" href="/api/transactions/export.csv">Export all transactions (CSV)</a></div></div>
    <div class="card stack"><h2>Email</h2><p>${meta.mailConfigured ? html`<${Badge} tone="good">Email is set up</${Badge}> Invoices can be emailed from the invoice page.` : html`<${Badge}>Not set up</${Badge}> Start the app with the <code>SMTP_URL</code> environment variable to email invoices (see the README). Credentials are never stored in the database.`}</p></div>
    <div class="card stack"><h2 style="color:var(--bad)">Start again</h2><p class="muted small">Delete every transaction, invoice, contact and setting – for example to clear out the demo data. Your passcode is kept. This cannot be undone, so take a backup first.</p>
      <div class="row"><input type="text" style="max-width:200px" placeholder="Type DELETE" value=${typed} onInput=${(e) => setTyped(e.target.value)} /><${Btn} kind="danger" disabled=${typed !== 'DELETE'} onClick=${reset}>Delete all records</${Btn}></div></div>
  </div>`;
}

export default function Settings({ query }) {
  const tab = query.tab || 'details';
  return html`<div><${PageHead} title="Settings" />
    <${Tabs} value=${tab} onChange=${(t) => go(`/settings?tab=${t}`)} tabs=${[{ id: 'details', label: 'Your details' }, { id: 'tax', label: 'Tax & VAT' }, { id: 'invoicing', label: 'Invoices' }, { id: 'accounts', label: 'Accounts' }, { id: 'rules', label: 'Rules & categories' }, { id: 'security', label: 'Security & data' }]} />
    ${tab === 'details' && html`<${Details} key="d" />`}${tab === 'tax' && html`<${TaxVat} key="t" />`}${tab === 'invoicing' && html`<${Invoicing} key="i" />`}${tab === 'accounts' && html`<${Accounts} />`}${tab === 'rules' && html`<${CategoriesRules} />`}${tab === 'security' && html`<${Security} />`}</div>`;
}
