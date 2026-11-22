import { useState, useEffect } from 'preact/hooks';
import { html, Btn, Badge, Modal, Field, MoneyInput, Seg, Empty, Loading, useAsync, Pager, Notice } from '../components/ui.js';
import { CategorySelect, AccountSelect, VatSelect, PageHead } from '../components/shared.js';
import { api, qs } from '../api.js';
import { useStore, refreshMeta, toast, toastError } from '../store.js';
import { gbp, fmtDate, isoToday, debounce } from '../util.js';
import { go } from '../main.js';

const LIMIT = 100;
const VAT_RATE = { S: 0.2, R: 0.05 };

export function TransactionModal({ txn, onClose, onSaved, defaults = {} }) {
  const { meta } = useStore();
  const vatOn = meta.settings.vat.registered;
  const isNew = !txn;
  const [f, setF] = useState(() => txn ? { ...txn, direction: txn.amount >= 0 ? 'in' : 'out', abs: Math.abs(txn.amount) } : {
    date: isoToday(), description: '', direction: 'out', abs: null, category_id: null, account_id: meta.accounts.find((a) => a.kind !== 'cash')?.id || meta.accounts[0].id,
    vat_code: 'N', vat_amount: 0, business_pct: 100, contact_id: null, notes: '', tag: '', ...defaults,
  });
  const [err, setErr] = useState({});
  const [saving, setSaving] = useState(false);
  const [cands, setCands] = useState([]);
  const contacts = useAsync(() => api.get('/api/contacts'), []);
  useEffect(() => { if (txn && txn.amount > 0 && !txn.invoice_id) api.get(`/api/transactions/${txn.id}/invoice-candidates`).then(setCands).catch(() => {}); }, []);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const autoVat = (code, abs) => { const r = VAT_RATE[code]; return r && abs ? Math.round((abs * r) / (1 + r)) : 0; };
  const save = async () => {
    setSaving(true); setErr({});
    const body = { date: f.date, description: f.description, amount: (f.direction === 'in' ? 1 : -1) * (f.abs || 0), category_id: f.category_id, account_id: f.account_id,
      contact_id: f.contact_id || null, vat_code: f.vat_code, vat_amount: f.vat_amount || 0, business_pct: Number(f.business_pct), notes: f.notes || '', tag: f.tag || '' };
    try { const saved = isNew ? await api.post('/api/transactions', body) : await api.put(`/api/transactions/${txn.id}`, body); toast(isNew ? 'Transaction added' : 'Saved'); await refreshMeta(); onSaved(saved); }
    catch (e) { setErr({ [e.field || '_']: e.message }); }
    setSaving(false);
  };
  const link = async (invoiceId) => { try { await api.post(`/api/transactions/${txn.id}/link-invoice`, { invoice_id: Number(invoiceId) }); toast('Linked – the invoice is now marked as paid'); await refreshMeta(); onSaved(); } catch (e) { toastError(e); } };
  const unlink = async () => { try { await api.del(`/api/transactions/${txn.id}/link-invoice`); toast('Unlinked'); onSaved(); } catch (e) { toastError(e); } };
  const mkRule = async () => { try { const r = await api.post(`/api/rules/from-transaction/${txn.id}`); toast(`Rule saved${r.applied ? ` and applied to ${r.applied} other transaction(s)` : ''}`); onSaved(); } catch (e) { toastError(e); } };
  const remove = async () => { if (!confirm('Delete this transaction?')) return; try { await api.del(`/api/transactions/${txn.id}`); toast('Deleted'); await refreshMeta(); onSaved(); } catch (e) { toastError(e); } };
  return html`<${Modal} title=${isNew ? 'Add transaction' : 'Edit transaction'} onClose=${onClose} footer=${html`
      ${!isNew && html`<${Btn} kind="danger" onClick=${remove}>Delete</${Btn}>`}<span class="grow"></span>
      <${Btn} onClick=${onClose}>Cancel</${Btn}><${Btn} kind="primary" onClick=${save} disabled=${saving}>${saving ? 'Saving…' : 'Save'}</${Btn}>`}>
    ${err._ && html`<${Notice} tone="error">${err._}</${Notice}>`}
    ${txn?.document_name && html`<p class="small"><a href=${`/api/documents/${txn.document_id}/file`}>Attached evidence: ${txn.document_name}</a></p>`}
    <div class="form-grid">
      <div class="full"><${Seg} label="Direction" value=${f.direction} onChange=${(v) => set('direction', v)} options=${[{ value: 'out', label: 'Money out' }, { value: 'in', label: 'Money in' }]} /></div>
      <${Field} label="Date" error=${err.date}><input type="date" value=${f.date} onInput=${(e) => set('date', e.target.value)} /></${Field}>
      <${Field} label="Amount" error=${err.amount}><${MoneyInput} value=${f.abs} onChange=${(v) => { set('abs', v); if (vatOn && VAT_RATE[f.vat_code]) set('vat_amount', autoVat(f.vat_code, v)); }} /></${Field}>
      <${Field} label="Description" class="span2" error=${err.description}><input type="text" value=${f.description} onInput=${(e) => set('description', e.target.value)} /></${Field}>
      <${Field} label="Category" error=${err.category_id}><${CategorySelect} value=${f.category_id} meta=${meta} direction=${f.direction} onChange=${(v) => set('category_id', v)} /></${Field}>
      <${Field} label="Account"><${AccountSelect} value=${f.account_id} meta=${meta} onChange=${(v) => set('account_id', v)} /></${Field}>
      <${Field} label="Customer / supplier"><select value=${f.contact_id || ''} onChange=${(e) => set('contact_id', e.target.value ? Number(e.target.value) : null)}><option value="">—</option>${(contacts.data || []).map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select></${Field}>
      ${f.direction === 'out' && html`<${Field} label="Business use %" hint="Phone, car, home… only the business share is claimed" error=${err.business_pct}><input type="number" min="0" max="100" step="1" value=${f.business_pct} onInput=${(e) => set('business_pct', e.target.value)} /></${Field}>`}
      ${vatOn && html`<${Field} label="VAT code"><${VatSelect} value=${f.vat_code} meta=${meta} onChange=${(v) => { set('vat_code', v); set('vat_amount', autoVat(v, f.abs)); }} /></${Field}>
        <${Field} label="VAT included" hint=${f.direction === 'out' ? 'Only claim VAT you hold a VAT invoice for' : ''}><${MoneyInput} value=${f.vat_amount} onChange=${(v) => set('vat_amount', v || 0)} /></${Field}>`}
      <${Field} label="Tag" hint="e.g. a property address or project"><input type="text" value=${f.tag || ''} onInput=${(e) => set('tag', e.target.value)} /></${Field}>
      <${Field} label="Notes" class="full"><textarea value=${f.notes || ''} onInput=${(e) => set('notes', e.target.value)} /></${Field}>
    </div>
    ${!isNew && txn.invoice_id && html`<${Notice} tone="good" actions=${html`<button class="link" onClick=${unlink}>Unlink</button>`}>Settles invoice <a href=${`#/invoices/${txn.invoice_id}`}>${txn.invoice_number}</a></${Notice}>`}
    ${!isNew && !txn.invoice_id && cands.length > 0 && html`<div class="card" style="margin-top:12px"><h3>Does this pay an invoice?</h3><div class="row" style="margin-top:8px"><select id="cand" style="max-width:340px">${cands.map((c) => html`<option value=${c.id}>${c.number} – ${c.contact || 'no customer'} – ${gbp(c.outstanding)} due${c.exact ? ' (exact match)' : ''}</option>`)}</select><${Btn} onClick=${() => link(document.getElementById('cand').value)}>Link to invoice</${Btn}></div></div>`}
    ${!isNew && txn.category_id && html`<p class="small" style="margin-top:12px"><button class="link" onClick=${mkRule}>Always categorise “${txn.description.slice(0, 30)}” like this</button></p>`}
  </${Modal}>`;
}

export default function Transactions({ query }) {
  const { meta } = useStore();
  const [offset, setOffset] = useState(0);
  const [sel, setSel] = useState(new Set());
  const [modal, setModal] = useState(null);
  const [q, setQ] = useState(query.q || '');
  const [bulkCat, setBulkCat] = useState('');
  const f = { taxYear: query.taxYear ?? meta.currentTaxYear, accountId: query.accountId, categoryId: query.categoryId, status: query.status, direction: query.direction, uncategorised: query.uncategorised, q: query.q };
  const key = JSON.stringify(f);
  const { data, error, loading, reload } = useAsync(() => api.get(`/api/transactions${qs({ ...f, taxYear: f.taxYear === 'all' ? '' : f.taxYear, limit: LIMIT, offset })}`), [key, offset]);
  useEffect(() => { setOffset(0); setSel(new Set()); }, [key]);
  const setFilter = (k, v) => { const nq = { ...query, [k]: v }; if (!v) delete nq[k]; go(`/transactions${qs(nq)}`); };
  const search = debounce((v) => setFilter('q', v), 350);
  const rows = data?.rows || [];
  const allSel = rows.length > 0 && rows.every((r) => sel.has(r.id));
  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const recat = async (t, category_id) => { try { await api.put(`/api/transactions/${t.id}`, { category_id }); await refreshMeta(); reload(); } catch (e) { toastError(e); } };
  const confirmOne = async (t) => { try { await api.put(`/api/transactions/${t.id}`, { status: 'confirmed' }); await refreshMeta(); reload(); } catch (e) { toastError(e); } };
  const bulk = async (action, patch) => { try { await api.post('/api/transactions/bulk', { ids: [...sel], action, patch }); toast(action === 'delete' ? 'Deleted' : 'Updated'); setSel(new Set()); setBulkCat(''); await refreshMeta(); reload(); } catch (e) { toastError(e); } };
  const done = async () => { setModal(null); await refreshMeta(); reload(); };

  return html`<div>
    <${PageHead} title="Transactions" sub=${data ? `${data.total} transaction${data.total === 1 ? '' : 's'} · in ${gbp(data.moneyIn)} · out ${gbp(-data.moneyOut)}` : ''}>
      <a class="btn" href=${`/api/transactions/export.csv${qs({ ...f, taxYear: f.taxYear === 'all' ? '' : f.taxYear })}`}>Export CSV</a>
      <${Btn} kind="primary" icon="plus" onClick=${() => setModal({ new: true })}>Add transaction</${Btn}>
    </${PageHead}>
    <div class="filters" role="search">
      <select aria-label="Tax year" style="width:auto" value=${f.taxYear} onChange=${(e) => setFilter('taxYear', e.target.value)}><option value="all">All time</option>${meta.taxYears.map((y) => html`<option value=${y.label}>${y.label.replace('-', '/')}</option>`)}</select>
      <select aria-label="Account" style="width:auto" value=${f.accountId || ''} onChange=${(e) => setFilter('accountId', e.target.value)}><option value="">All accounts</option>${meta.accounts.map((a) => html`<option value=${a.id}>${a.name}</option>`)}</select>
      <select aria-label="Status" style="width:auto" value=${f.uncategorised ? 'uncat' : f.status || ''} onChange=${(e) => { const v = e.target.value; const nq = { ...query }; delete nq.status; delete nq.uncategorised; if (v === 'uncat') nq.uncategorised = 1; else if (v) nq.status = v; go(`/transactions${qs(nq)}`); }}>
        <option value="">Everything</option><option value="review">Needs review (${meta.counts.review})</option><option value="uncat">Uncategorised (${meta.counts.uncategorised})</option><option value="confirmed">Confirmed</option></select>
      <select aria-label="Direction" style="width:auto" value=${f.direction || ''} onChange=${(e) => setFilter('direction', e.target.value)}><option value="">In and out</option><option value="in">Money in</option><option value="out">Money out</option></select>
      <input type="search" aria-label="Search" placeholder="Search description, amount…" style="max-width:260px" value=${q} onInput=${(e) => { setQ(e.target.value); search(e.target.value); }} />
    </div>
    ${sel.size > 0 && html`<div class="notice" style="align-items:center"><strong>${sel.size} selected</strong><span class="grow"></span>
      <div style="min-width:240px"><${CategorySelect} value=${bulkCat} meta=${meta} onChange=${(v) => setBulkCat(v || '')} /></div>
      <${Btn} small kind="primary" disabled=${!bulkCat} onClick=${() => bulk('update', { category_id: bulkCat })}>Set category</${Btn}>
      <${Btn} small onClick=${() => bulk('update', { status: 'confirmed' })}>Mark confirmed</${Btn}>
      <${Btn} small kind="danger" onClick=${() => { if (confirm(`Delete ${sel.size} transaction(s)?`)) bulk('delete'); }}>Delete</${Btn}></div>`}
    ${error && html`<${Loading} error=${error} retry=${reload} />`}
    ${data && rows.length === 0 && html`<div class="card"><${Empty} title="No transactions here">${f.uncategorised || f.status ? 'Nothing needs attention – nice.' : html`<a href="#/import">Import a bank statement</a> or add one manually.`}</${Empty}></div>`}
    ${rows.length > 0 && html`<div class=${`table-wrap${loading ? ' is-loading' : ''}`} style=${loading ? 'opacity:.6' : ''}><table>
      <thead><tr><th style="width:34px"><input type="checkbox" aria-label="Select all" checked=${allSel} onChange=${() => setSel(allSel ? new Set() : new Set(rows.map((r) => r.id)))} /></th><th>Date</th><th>Description</th><th style="min-width:230px">Category</th><th class="num">Amount</th><th></th></tr></thead>
      <tbody>${rows.map((t) => html`<tr key=${t.id}>
        <td><input type="checkbox" aria-label=${`Select ${t.description}`} checked=${sel.has(t.id)} onChange=${() => toggle(t.id)} /></td>
        <td class="nowrap">${fmtDate(t.date)}</td>
        <td><button class="link" style="text-decoration:none;color:inherit;text-align:left" onClick=${() => setModal({ txn: t })}>${t.description}</button>
          <div class="muted small">${t.account_name}${t.contact_name ? ' · ' + t.contact_name : ''}${t.business_pct < 100 ? ` · ${t.business_pct}% business` : ''}${t.invoice_number ? ' · ' : ''}${t.invoice_number ? html`<a href=${`#/invoices/${t.invoice_id}`}>${t.invoice_number}</a>` : ''}${t.document_name ? ' · 📎' : ''}</div></td>
        <td><${CategorySelect} value=${t.category_id} meta=${meta} direction=${t.amount > 0 ? 'in' : 'out'} onChange=${(v) => recat(t, v)} aria-label="Category" class=${!t.category_id ? 'invalid' : ''} /></td>
        <td class="num"><span class=${t.amount > 0 ? 'in' : ''}>${gbp(t.amount)}</span></td>
        <td class="nowrap">${t.status === 'review' ? html`<button class="btn small" onClick=${() => confirmOne(t)} title="Mark as checked">✓ Looks right</button>` : t.status === 'ignored' ? html`<${Badge}>Ignored</${Badge}>` : ''}</td></tr>`)}</tbody></table></div>
      <${Pager} total=${data.total} offset=${offset} limit=${LIMIT} onChange=${setOffset} />`}
    ${modal && html`<${TransactionModal} txn=${modal.txn} onClose=${() => setModal(null)} onSaved=${done} />`}
  </div>`;
}
