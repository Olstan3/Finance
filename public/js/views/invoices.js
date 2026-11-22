import { useState, useEffect, useMemo } from 'preact/hooks';
import { html, Btn, Badge, Notice, Modal, Field, MoneyInput, Empty, Loading, useAsync, Seg, Icon } from '../components/ui.js';
import { StatusBadge, PageHead, AccountSelect } from '../components/shared.js';
import { ContactModal } from './contacts.js';
import { api, qs } from '../api.js';
import { useStore, refreshMeta, toast, toastError } from '../store.js';
import { gbp, fmtDate, isoToday, addDays, debounce } from '../util.js';
import { go } from '../main.js';

const rateOf = (meta, code) => meta.vatCodes.find((v) => v.code === code)?.rate || 0;
export function calcLines(meta, lines) {
  let net = 0, vat = 0;
  for (const l of lines) { const n = Math.round((Number(l.quantity) || 0) * (l.unit_price || 0)); net += n; vat += Math.round(n * rateOf(meta, l.vat_code)); }
  return { net, vat, gross: net + vat };
}

/** Shared by invoices and recurring invoices. */
export function LinesEditor({ lines, onChange, meta, showVat, error }) {
  const upd = (i, patch) => onChange(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const t = calcLines(meta, lines);
  const defVat = meta.settings.vat.registered ? 'S' : 'N';
  return html`<div>
    <div class="table-wrap"><table class="lines"><thead><tr><th>Description</th><th style="width:80px" class="num">Qty</th><th style="width:130px" class="num">Unit price</th>${showVat && html`<th style="width:150px">VAT</th>`}<th style="width:120px" class="num">Amount</th><th style="width:40px"></th></tr></thead>
      <tbody>${lines.map((l, i) => html`<tr key=${i}>
        <td><input type="text" aria-label="Description" value=${l.description} placeholder="What you did or sold" onInput=${(e) => upd(i, { description: e.target.value })} /></td>
        <td><input type="number" aria-label="Quantity" min="0" step="any" value=${l.quantity} style="text-align:right" onInput=${(e) => upd(i, { quantity: e.target.value })} /></td>
        <td><${MoneyInput} aria-label="Unit price" allowNegative value=${l.unit_price} onChange=${(v) => upd(i, { unit_price: v ?? 0 })} /></td>
        ${showVat && html`<td><select aria-label="VAT" value=${l.vat_code} onChange=${(e) => upd(i, { vat_code: e.target.value })}>${meta.vatCodes.map((v) => html`<option value=${v.code}>${v.label}</option>`)}</select></td>`}
        <td class="num">${gbp(Math.round((Number(l.quantity) || 0) * (l.unit_price || 0)))}</td>
        <td><button class="btn ghost small" aria-label="Remove line" disabled=${lines.length === 1} onClick=${() => onChange(lines.filter((_, k) => k !== i))}><${Icon} name="x" size=${14} /></button></td></tr>`)}</tbody></table></div>
    ${error && html`<div class="field-error" style="margin-top:6px">${error}</div>`}
    <div class="row" style="margin-top:8px"><${Btn} small icon="plus" onClick=${() => onChange([...lines, { description: '', quantity: 1, unit_price: 0, vat_code: defVat }])}>Add line</${Btn}></div>
    <div class="totals" style="margin-top:12px"><div><span>Subtotal</span><span>${gbp(t.net)}</span></div>${(showVat || t.vat !== 0) && html`<div><span>VAT</span><span>${gbp(t.vat)}</span></div>`}<div class="grand"><span>Total</span><span>${gbp(t.gross)}</span></div></div>
  </div>`;
}

// ----------------------------------------------------------------------------- list
export function InvoiceList({ query }) {
  const { meta } = useStore();
  const status = query.status || '';
  const [q, setQ] = useState(''); const [key, setKey] = useState('');
  const { data, error, loading, reload } = useAsync(() => api.get(`/api/invoices${qs({ status, q: key })}`), [status, key]);
  const search = debounce(setKey, 300);
  const tabs = [['', 'All'], ['draft', 'Drafts'], ['unpaid', 'Unpaid'], ['overdue', 'Overdue'], ['paid', 'Paid']];
  const unpaidTotal = (data || []).filter((i) => ['sent', 'part_paid', 'overdue'].includes(i.derived_status) && i.kind === 'invoice').reduce((a, i) => a + i.outstanding, 0);
  return html`<div>
    <${PageHead} title="Invoices" sub=${data ? `${data.length} shown${unpaidTotal ? ` · ${gbp(unpaidTotal)} unpaid` : ''}` : ''}><${Btn} kind="primary" icon="plus" onClick=${() => go('/invoices/new')}>New invoice</${Btn}></${PageHead}>
    <div class="filters"><${Seg} label="Filter" value=${status} onChange=${(v) => go(`/invoices${qs({ status: v })}`)} options=${tabs.map(([value, label]) => ({ value, label }))} />
      <input type="search" placeholder="Search number, customer, reference…" aria-label="Search invoices" style="max-width:300px" value=${q} onInput=${(e) => { setQ(e.target.value); search(e.target.value); }} /></div>
    ${error && html`<${Loading} error=${error} retry=${reload} />`}
    ${data && data.length === 0 && html`<div class="card"><${Empty} title=${status ? 'No invoices match' : 'No invoices yet'}>${status ? 'Try another filter.' : html`<a href="#/invoices/new">Create your first invoice</a> – or import an existing one from a document.`}</${Empty}></div>`}
    ${data && data.length > 0 && html`<div class="table-wrap" style=${loading ? 'opacity:.6' : ''}><table><thead><tr><th>Number</th><th>Customer</th><th>Issued</th><th>Due</th><th>Status</th><th class="num">Total</th><th class="num">Owed</th></tr></thead>
      <tbody>${data.map((i) => html`<tr class="clickable" key=${i.id} onClick=${() => go(`/invoices/${i.id}`)}>
        <td class="nowrap"><strong>${i.number}</strong>${i.kind === 'credit_note' ? html` <${Badge}>Credit</${Badge}>` : ''}${i.recurring_id ? html` <span title="Created by a recurring invoice"><${Icon} name="repeat" size=${13} /></span>` : ''}</td>
        <td>${i.contact_name || html`<span class="muted">—</span>`}</td><td class="nowrap">${fmtDate(i.issue_date)}</td><td class="nowrap">${i.kind === 'credit_note' ? '' : fmtDate(i.due_date)}</td>
        <td><${StatusBadge} s=${i.derived_status} /></td><td class="num">${gbp(i.totals.gross)}</td><td class="num">${i.derived_status === 'draft' || i.derived_status === 'void' || i.derived_status === 'paid' ? '–' : gbp(i.outstanding)}</td></tr>`)}</tbody></table></div>`}
  </div>`;
}

// ----------------------------------------------------------------------------- editor
export function InvoiceEditor({ id }) {
  const { meta } = useStore();
  const settings = meta.settings;
  const isNew = !id;
  const vatOn = settings.vat.registered;
  const incomeCats = meta.categories.filter((c) => c.kind === 'income' && ['self_employment', 'property'].includes(c.section));
  const contacts = useAsync(() => api.get('/api/contacts'), []);
  const existing = useAsync(() => (id ? api.get(`/api/invoices/${id}`) : Promise.resolve(null)), [id]);
  const next = useAsync(() => (isNew ? api.get('/api/invoices/next-number') : Promise.resolve(null)), []);
  const [f, setF] = useState(null);
  const [dueTouched, setDueTouched] = useState(false);
  const [err, setErr] = useState({});
  const [saving, setSaving] = useState(false);
  const [newContact, setNewContact] = useState(false);
  const blank = () => ({ contact_id: null, issue_date: isoToday(), due_date: addDays(isoToday(), settings.invoice.paymentTermsDays || 30), reference: '', notes: settings.invoice.notes || '', terms: '', category_id: 'se_turnover', lines: [{ description: '', quantity: 1, unit_price: 0, vat_code: vatOn ? 'S' : 'N' }], number: '' });
  useEffect(() => { if (isNew && !f) setF(blank()); }, []);
  useEffect(() => { if (existing.data && !f) { const x = existing.data; setF({ ...x, lines: x.lines.map((l) => ({ ...l })) }); setDueTouched(true); } }, [existing.data]);
  if (!isNew && existing.error) return html`<${Loading} error=${existing.error} />`;
  if (!f) return html`<${Loading} />`;
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const showVat = vatOn || f.lines.some((l) => l.vat_code !== 'N');
  const pickContact = (cid) => {
    set('contact_id', cid);
    const c = (contacts.data || []).find((x) => x.id === cid);
    if (!dueTouched && c?.payment_terms_days != null) set('due_date', addDays(f.issue_date, c.payment_terms_days));
  };
  const setIssue = (d) => { setF((x) => ({ ...x, issue_date: d, due_date: dueTouched ? x.due_date : addDays(d, (contacts.data || []).find((c) => c.id === x.contact_id)?.payment_terms_days ?? settings.invoice.paymentTermsDays ?? 30) })); };
  const save = async (issue) => {
    setSaving(true); setErr({});
    const body = { contact_id: f.contact_id, issue_date: f.issue_date, due_date: f.due_date || null, reference: f.reference, notes: f.notes, terms: f.terms, category_id: f.category_id, number: f.number || undefined,
      lines: f.lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), unit_price: l.unit_price || 0, vat_code: l.vat_code })) };
    try {
      let inv = isNew ? await api.post('/api/invoices', body) : await api.put(`/api/invoices/${id}`, body);
      if (issue && inv.status === 'draft') inv = await api.post(`/api/invoices/${inv.id}/status`, { status: 'sent' });
      toast(issue ? `${inv.number} issued` : 'Saved'); await refreshMeta(); go(`/invoices/${inv.id}`);
    } catch (e) { setErr({ [e.field || '_']: e.message }); window.scrollTo(0, 0); }
    setSaving(false);
  };
  const editable = isNew || existing.data?.status !== 'void';
  return html`<div>
    <${PageHead} title=${isNew ? 'New invoice' : `Edit ${f.number}`} sub=${isNew && next.data ? `Will be numbered ${next.data.number}` : ''}><a class="btn" href=${isNew ? '#/invoices' : `#/invoices/${id}`}>Cancel</a></${PageHead}>
    ${err._ && html`<${Notice} tone="error">${err._}</${Notice}>`}
    ${!editable && html`<${Notice} tone="warn">Voided invoices cannot be edited.</${Notice}>`}
    <div class="card"><div class="form-grid">
      <${Field} label="Customer" error=${err.contact_id}><div class="row" style="flex-wrap:nowrap"><select value=${f.contact_id || ''} onChange=${(e) => pickContact(e.target.value ? Number(e.target.value) : null)}><option value="">— Choose —</option>${(contacts.data || []).map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select><${Btn} small onClick=${() => setNewContact(true)} aria-label="New customer">+</${Btn}></div></${Field}>
      <${Field} label="Issue date" error=${err.issue_date}><input type="date" value=${f.issue_date} onInput=${(e) => setIssue(e.target.value)} /></${Field}>
      <${Field} label="Due date" error=${err.due_date}><input type="date" value=${f.due_date || ''} onInput=${(e) => { setDueTouched(true); set('due_date', e.target.value); }} /></${Field}>
      <${Field} label="Reference" hint="Their PO number, project name…"><input type="text" value=${f.reference || ''} onInput=${(e) => set('reference', e.target.value)} /></${Field}>
      <${Field} label="Counts as" hint="Which tax box this income goes into"><select value=${f.category_id || ''} onChange=${(e) => set('category_id', e.target.value)}>${incomeCats.map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select></${Field}>
      ${!isNew && html`<${Field} label="Number" error=${err.number}><input type="text" value=${f.number} onInput=${(e) => set('number', e.target.value)} /></${Field}>`}
    </div></div>
    <div class="card"><h2 style="margin-bottom:10px">Items</h2><${LinesEditor} lines=${f.lines} onChange=${(l) => set('lines', l)} meta=${meta} showVat=${showVat} error=${err.lines} />
      ${!vatOn && html`<p class="muted small" style="margin-top:10px">You're not VAT registered, so no VAT is added. (Turn this on in Settings → Tax & VAT.)</p>`}</div>
    <div class="card"><div class="form-grid"><${Field} label="Notes (shown on the invoice)" class="span2"><textarea value=${f.notes || ''} onInput=${(e) => set('notes', e.target.value)} /></${Field}><${Field} label="Terms" class="span2"><textarea value=${f.terms || ''} placeholder="e.g. Late payment interest may be charged" onInput=${(e) => set('terms', e.target.value)} /></${Field}></div></div>
    <div class="row" style="margin-top:16px">${(isNew || existing.data?.status === 'draft') ? html`<${Btn} kind="primary" disabled=${saving || !editable} onClick=${() => save(true)}>Save & issue</${Btn}><${Btn} disabled=${saving || !editable} onClick=${() => save(false)}>Save as draft</${Btn}>` : html`<${Btn} kind="primary" disabled=${saving || !editable} onClick=${() => save(false)}>Save changes</${Btn}>`}</div>
    ${newContact && html`<${ContactModal} onClose=${() => setNewContact(false)} onSaved=${(c) => { setNewContact(false); contacts.reload().then(() => c && pickContact(c.id)); }} />`}
  </div>`;
}

// ----------------------------------------------------------------------------- detail
function PaymentModal({ inv, onClose, onDone }) {
  const { meta } = useStore();
  const refund = inv.kind === 'credit_note';
  const [amount, setAmount] = useState(Math.abs(inv.outstanding));
  const [date, setDate] = useState(isoToday());
  const [account, setAccount] = useState(meta.accounts.find((a) => a.kind !== 'cash')?.id);
  const [err, setErr] = useState('');
  const save = async () => { try { await api.post(`/api/invoices/${inv.id}/payments`, { amount, date, account_id: account }); toast(refund ? 'Refund recorded' : 'Payment recorded'); await refreshMeta(); onDone(); } catch (e) { setErr(e.message); } };
  return html`<${Modal} title=${refund ? 'Record refund' : 'Record payment'} onClose=${onClose} footer=${html`<${Btn} onClick=${onClose}>Cancel</${Btn}><${Btn} kind="primary" onClick=${save}>Save</${Btn}>`}>
    ${err && html`<${Notice} tone="error">${err}</${Notice}>`}
    <div class="form-grid"><${Field} label="Amount"><${MoneyInput} value=${amount} onChange=${setAmount} /></${Field}><${Field} label="Date received"><input type="date" value=${date} onInput=${(e) => setDate(e.target.value)} /></${Field}>
      <${Field} label="Paid into" class="span2"><${AccountSelect} value=${account} meta=${meta} onChange=${setAccount} /></${Field}></div>
    <p class="muted small">This adds a bank transaction, so it counts as income in the tax year you were paid. Bank imports are matched to invoices automatically, so you usually won't need this.</p></${Modal}>`;
}

function SendModal({ inv, onClose, onDone, mailOn }) {
  const biz = useStore().meta.settings.profile;
  const [to, setTo] = useState(inv.contact?.email || '');
  const [subject, setSubject] = useState(`${inv.kind === 'credit_note' ? 'Credit note' : 'Invoice'} ${inv.number} from ${biz.tradingName || biz.name || 'us'}`);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const go2 = async (email) => { setBusy(true); try { const r = await api.post(`/api/invoices/${inv.id}/send`, { email, to, subject, message: message || undefined }); toast(email ? `Emailed to ${r.emailed.to}` : 'Marked as sent'); await refreshMeta(); onDone(); } catch (e) { setErr(e.message); } setBusy(false); };
  return html`<${Modal} title="Send invoice" onClose=${onClose} footer=${html`<${Btn} onClick=${onClose}>Cancel</${Btn}><${Btn} onClick=${() => go2(false)} disabled=${busy}>Just mark as sent</${Btn}>${mailOn && html`<${Btn} kind="primary" icon="mail" disabled=${busy || !to} onClick=${() => go2(true)}>Email PDF</${Btn}>`}`}>
    ${err && html`<${Notice} tone="error">${err}</${Notice}>`}
    ${!mailOn && html`<${Notice}>Email isn't set up on this computer (see the README for <code>SMTP_URL</code>). Download the PDF, send it yourself, then mark it as sent.</${Notice}>`}
    ${mailOn && html`<div class="stack"><${Field} label="To"><input type="email" value=${to} onInput=${(e) => setTo(e.target.value)} /></${Field}><${Field} label="Subject"><input type="text" value=${subject} onInput=${(e) => setSubject(e.target.value)} /></${Field}><${Field} label="Message" hint="Leave blank for the standard message with your payment details"><textarea value=${message} onInput=${(e) => setMessage(e.target.value)} /></${Field}></div>`}
  </${Modal}>`;
}

export function InvoiceDetail({ id }) {
  const { meta } = useStore();
  const { data: inv, error, reload } = useAsync(() => api.get(`/api/invoices/${id}`), [id]);
  const [modal, setModal] = useState(null);
  const [pdf, setPdf] = useState(false);
  if (error && !inv) return html`<${Loading} error=${error} retry=${reload} />`;
  if (!inv) return html`<${Loading} />`;
  const st = inv.derived_status;
  const act = (fn, msg) => async () => { try { const r = await fn(); if (msg) toast(msg); await refreshMeta(); return r; } catch (e) { toastError(e); } finally { reload(); } };
  const showVat = meta.settings.vat.registered || inv.totals.vat !== 0;
  const remove = async () => { if (!confirm('Delete this draft?')) return; try { await api.del(`/api/invoices/${id}`); toast('Deleted'); await refreshMeta(); go('/invoices'); } catch (e) { toastError(e); } };
  const void_ = act(() => api.post(`/api/invoices/${id}/status`, { status: 'void' }), 'Voided');
  const dup = async () => { try { const n = await api.post(`/api/invoices/${id}/duplicate`); toast(`Copied to ${n.number}`); go(`/invoices/${n.id}/edit`); } catch (e) { toastError(e); } };
  const credit = async () => { if (!confirm('Create a credit note for the whole invoice?')) return; try { const n = await api.post(`/api/invoices/${id}/credit-note`); toast(`Created ${n.number}`); go(`/invoices/${n.id}/edit`); } catch (e) { toastError(e); } };
  return html`<div>
    <${PageHead} title=${html`${inv.kind === 'credit_note' ? 'Credit note' : 'Invoice'} ${inv.number} <${StatusBadge} s=${st} />`} sub=${html`${inv.contact_name ? html`<a href="#/contacts">${inv.contact_name}</a> · ` : ''}issued ${fmtDate(inv.issue_date)}${inv.due_date && inv.kind === 'invoice' ? ` · due ${fmtDate(inv.due_date)}` : ''}${inv.recurring_id ? ' · from a recurring invoice' : ''}`}>
      <a class="btn" href="#/invoices">All invoices</a>
      ${st === 'draft' && html`<${Btn} icon="edit" onClick=${() => go(`/invoices/${id}/edit`)}>Edit</${Btn}><${Btn} kind="primary" onClick=${() => setModal('send')}>Issue & send…</${Btn}>`}
      ${['sent', 'part_paid', 'overdue'].includes(st) && html`<${Btn} kind="primary" onClick=${() => setModal('pay')}>${inv.kind === 'credit_note' ? 'Record refund' : 'Record payment'}</${Btn}><${Btn} icon="mail" onClick=${() => setModal('send')}>Send</${Btn}>`}
    </${PageHead}>
    ${st === 'overdue' && html`<${Notice} tone="error">This invoice is overdue by ${Math.round((Date.parse(meta.today) - Date.parse(inv.due_date)) / 86400000)} days. ${inv.contact?.email ? 'Send a reminder with the Send button.' : ''}</${Notice}>`}
    <div class="grid" style="grid-template-columns:minmax(0,1fr) 300px;align-items:start">
      <div class="card"><div class="table-wrap"><table class="lines"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th>${showVat && html`<th class="num">VAT</th>`}<th class="num">Amount</th></tr></thead>
        <tbody>${inv.lines.map((l) => html`<tr><td>${l.description}</td><td class="num">${Number(l.quantity)}</td><td class="num">${gbp(l.unit_price)}</td>${showVat && html`<td class="num">${(meta.vatCodes.find((v) => v.code === l.vat_code)?.label || '').replace(/ \d+%.*/, '')}</td>`}<td class="num">${gbp(Math.round(l.quantity * l.unit_price) * inv.totals.sign)}</td></tr>`)}</tbody></table></div>
        <div class="totals" style="margin-top:14px"><div><span>Subtotal</span><span>${gbp(inv.totals.net)}</span></div>${showVat && html`<div><span>VAT</span><span>${gbp(inv.totals.vat)}</span></div>`}<div class="grand"><span>Total</span><span>${gbp(inv.totals.gross)}</span></div>
          ${inv.paid !== 0 && html`<div><span>${inv.kind === 'credit_note' ? 'Refunded' : 'Paid'}</span><span>${gbp(-inv.paid)}</span></div><div style="font-weight:700"><span>Balance</span><span>${gbp(inv.outstanding)}</span></div>`}</div>
        ${(inv.notes || inv.reference) && html`<p class="muted" style="margin-top:14px">${inv.reference ? `Ref: ${inv.reference}. ` : ''}${inv.notes}</p>`}</div>
      <div class="stack">
        <div class="card"><h3>Payments</h3>${inv.payments.length ? inv.payments.map((p) => html`<div class="row small" style="padding:6px 0;border-bottom:1px solid var(--border)"><span class="grow">${fmtDate(p.date)}</span><strong>${gbp(p.amount)}</strong></div>`) : html`<p class="muted small">None yet.</p>`}</div>
        <div class="card stack"><h3>Actions</h3>
          <${Btn} icon="pdf" onClick=${() => setPdf((v) => !v)}>${pdf ? 'Hide PDF' : 'Preview PDF'}</${Btn}>
          <a class="btn" href=${`/api/invoices/${id}/pdf?download=1`}><${Icon} name="download" /> Download PDF</a>
          <${Btn} onClick=${dup}>Duplicate</${Btn}>
          ${st !== 'draft' && st !== 'void' && inv.kind === 'invoice' && html`<${Btn} onClick=${credit}>Create credit note</${Btn}>`}
          ${st === 'draft' ? html`<${Btn} kind="danger" onClick=${remove}>Delete draft</${Btn}>` : st !== 'void' && inv.payments.length === 0 ? html`<${Btn} kind="danger" onClick=${() => { if (confirm('Void this invoice? The number stays used.')) void_(); }}>Void</${Btn}>` : ''}</div>
      </div></div>
    ${pdf && html`<div class="card" style="margin-top:16px"><iframe class="pdf-frame" title="Invoice PDF" src=${`/api/invoices/${id}/pdf`}></iframe></div>`}
    ${modal === 'pay' && html`<${PaymentModal} inv=${inv} onClose=${() => setModal(null)} onDone=${() => { setModal(null); reload(); }} />`}
    ${modal === 'send' && html`<${SendModal} inv=${inv} mailOn=${meta.mailConfigured} onClose=${() => setModal(null)} onDone=${() => { setModal(null); reload(); }} />`}
  </div>`;
}
