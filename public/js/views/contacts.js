import { useState } from 'preact/hooks';
import { html, Btn, Modal, Field, Empty, Loading, useAsync, Badge } from '../components/ui.js';
import { PageHead } from '../components/shared.js';
import { api } from '../api.js';
import { toast, toastError } from '../store.js';
import { gbp0 } from '../util.js';
import { debounce } from '../util.js';

export function ContactModal({ contact, onClose, onSaved, kind = 'customer' }) {
  const [f, setF] = useState(contact || { name: '', kind, email: '', phone: '', address: '', vat_number: '', notes: '', payment_terms_days: '' });
  const [err, setErr] = useState({}); const [saving, setSaving] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setSaving(true); setErr({});
    try { const saved = contact ? await api.put(`/api/contacts/${contact.id}`, f) : await api.post('/api/contacts', f); toast(contact ? 'Saved' : 'Added'); onSaved(saved); }
    catch (e) { setErr({ [e.field || '_']: e.message }); }
    setSaving(false);
  };
  const remove = async () => { if (!confirm(`Remove ${contact.name}? If they have invoices they will be archived instead.`)) return; try { await api.del(`/api/contacts/${contact.id}`); toast('Removed'); onSaved(null); } catch (e) { toastError(e); } };
  return html`<${Modal} title=${contact ? 'Edit contact' : 'New contact'} onClose=${onClose} footer=${html`${contact && html`<${Btn} kind="danger" onClick=${remove}>Remove</${Btn}>`}<span class="grow"></span><${Btn} onClick=${onClose}>Cancel</${Btn}><${Btn} kind="primary" onClick=${save} disabled=${saving}>Save</${Btn}>`}>
    ${err._ && html`<div class="notice error">${err._}</div>`}
    <div class="form-grid">
      <${Field} label="Name" class="span2" error=${err.name}><input type="text" value=${f.name} onInput=${(e) => set('name', e.target.value)} /></${Field}>
      <${Field} label="Type"><select value=${f.kind} onChange=${(e) => set('kind', e.target.value)}><option value="customer">Customer</option><option value="supplier">Supplier</option><option value="both">Both</option></select></${Field}>
      <${Field} label="Email" error=${err.email}><input type="email" value=${f.email || ''} onInput=${(e) => set('email', e.target.value)} /></${Field}>
      <${Field} label="Phone"><input type="tel" value=${f.phone || ''} onInput=${(e) => set('phone', e.target.value)} /></${Field}>
      <${Field} label="VAT number"><input type="text" value=${f.vat_number || ''} onInput=${(e) => set('vat_number', e.target.value)} /></${Field}>
      <${Field} label="Payment terms (days)" hint="Overrides your default on new invoices" error=${err.payment_terms_days}><input type="number" min="0" value=${f.payment_terms_days ?? ''} onInput=${(e) => set('payment_terms_days', e.target.value)} /></${Field}>
      <${Field} label="Address" class="full"><textarea value=${f.address || ''} onInput=${(e) => set('address', e.target.value)} /></${Field}>
      <${Field} label="Notes" class="full"><textarea value=${f.notes || ''} onInput=${(e) => set('notes', e.target.value)} /></${Field}>
    </div></${Modal}>`;
}

export default function Contacts() {
  const [q, setQ] = useState('');
  const [key, setKey] = useState('');
  const [modal, setModal] = useState(null);
  const { data, error, reload } = useAsync(() => api.get(`/api/contacts?q=${encodeURIComponent(key)}`), [key]);
  const search = debounce((v) => setKey(v), 300);
  return html`<div>
    <${PageHead} title="Customers & suppliers" sub="People you invoice or buy from. The importer uses these names to recognise payments."><${Btn} kind="primary" icon="plus" onClick=${() => setModal({})}>New contact</${Btn}></${PageHead}>
    <div class="filters"><input type="search" placeholder="Search…" aria-label="Search contacts" style="max-width:280px" value=${q} onInput=${(e) => { setQ(e.target.value); search(e.target.value); }} /></div>
    ${error && html`<${Loading} error=${error} retry=${reload} />`}
    ${data && (data.length === 0 ? html`<div class="card"><${Empty} title="No contacts yet">Add your first customer to start invoicing.</${Empty}></div>` : html`<div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Type</th><th>Email</th><th class="num">Invoices</th><th class="num">Invoiced</th><th class="num">Owes you</th></tr></thead>
      <tbody>${data.map((c) => html`<tr class="clickable" key=${c.id} onClick=${() => setModal({ c })}><td><strong>${c.name}</strong></td><td><${Badge}>${c.kind}</${Badge}></td><td>${c.email || ''}</td><td class="num">${c.invoiceCount}</td><td class="num">${gbp0(c.invoiced)}</td><td class="num">${c.outstanding ? html`<strong>${gbp0(c.outstanding)}</strong>` : '–'}</td></tr>`)}</tbody></table></div>`)}
    ${modal && html`<${ContactModal} contact=${modal.c} onClose=${() => setModal(null)} onSaved=${() => { setModal(null); reload(); }} />`}
  </div>`;
}
