import { useState } from 'preact/hooks';
import { html, Btn, Badge, Modal, Field, Notice, Empty, Loading, useAsync, Icon } from '../components/ui.js';
import { PageHead } from '../components/shared.js';
import { LinesEditor, calcLines } from './invoices.js';
import { api } from '../api.js';
import { useStore, refreshMeta, toast, toastError } from '../store.js';
import { gbp, fmtDate, isoToday, FREQ_LABELS } from '../util.js';

const MODES = { draft: 'Create a draft for me to check', issue: 'Issue automatically', issue_email: 'Issue and email automatically' };

function TemplateModal({ t, onClose, onSaved }) {
  const { meta } = useStore();
  const vatOn = meta.settings.vat.registered;
  const contacts = useAsync(() => api.get('/api/contacts'), []);
  const [f, setF] = useState(t ? { ...t, lines: t.lines.map((l) => ({ ...l })) } : { name: '', contact_id: null, frequency: 'monthly', interval_count: 1, start_date: isoToday(), end_date: '', max_runs: '', due_days: meta.settings.invoice.paymentTermsDays || 30, mode: 'draft', category_id: 'se_turnover', reference: '', notes: '', lines: [{ description: 'Services for {month} {year}', quantity: 1, unit_price: 0, vat_code: vatOn ? 'S' : 'N' }] });
  const [err, setErr] = useState({}); const [saving, setSaving] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const incomeCats = meta.categories.filter((c) => c.kind === 'income' && ['self_employment', 'property'].includes(c.section));
  const save = async () => {
    setSaving(true); setErr({});
    const body = { ...f, interval_count: Number(f.interval_count) || 1, due_days: Number(f.due_days), max_runs: f.max_runs ? Number(f.max_runs) : null, end_date: f.end_date || null, lines: f.lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), unit_price: l.unit_price || 0, vat_code: l.vat_code })) };
    try { const saved = t ? await api.put(`/api/recurring/${t.id}`, body) : await api.post('/api/recurring', body); toast('Saved'); onSaved(saved); }
    catch (e) { setErr({ [e.field || '_']: e.message }); }
    setSaving(false);
  };
  return html`<${Modal} wide title=${t ? 'Edit recurring invoice' : 'New recurring invoice'} onClose=${onClose} footer=${html`<${Btn} onClick=${onClose}>Cancel</${Btn}><${Btn} kind="primary" onClick=${save} disabled=${saving}>Save</${Btn}>`}>
    ${err._ && html`<${Notice} tone="error">${err._}</${Notice}>`}
    <div class="form-grid">
      <${Field} label="Name" error=${err.name} hint="Only for you – e.g. “Monthly retainer”"><input type="text" value=${f.name} onInput=${(e) => set('name', e.target.value)} /></${Field}>
      <${Field} label="Customer" error=${err.contact_id}><select value=${f.contact_id || ''} onChange=${(e) => set('contact_id', e.target.value ? Number(e.target.value) : null)}><option value="">— Choose —</option>${(contacts.data || []).map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select></${Field}>
      <${Field} label="Repeats every"><div class="row" style="flex-wrap:nowrap"><input type="number" min="1" style="width:70px" value=${f.interval_count} onInput=${(e) => set('interval_count', e.target.value)} /><select value=${f.frequency} onChange=${(e) => set('frequency', e.target.value)}><option value="weekly">week(s)</option><option value="monthly">month(s)</option><option value="quarterly">quarter(s)</option><option value="yearly">year(s)</option></select></div></${Field}>
      <${Field} label="First invoice date" error=${err.start_date}><input type="date" value=${f.start_date} onInput=${(e) => set('start_date', e.target.value)} /></${Field}>
      <${Field} label="Stop after" hint="Optional" error=${err.end_date}><input type="date" value=${f.end_date || ''} onInput=${(e) => set('end_date', e.target.value)} /></${Field}>
      <${Field} label="Or after this many invoices" hint="Optional"><input type="number" min="1" value=${f.max_runs || ''} onInput=${(e) => set('max_runs', e.target.value)} /></${Field}>
      <${Field} label="Payment due after (days)"><input type="number" min="0" value=${f.due_days} onInput=${(e) => set('due_days', e.target.value)} /></${Field}>
      <${Field} label="Each time"><select value=${f.mode} onChange=${(e) => set('mode', e.target.value)}>${Object.entries(MODES).map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select></${Field}>
      <${Field} label="Counts as"><select value=${f.category_id} onChange=${(e) => set('category_id', e.target.value)}>${incomeCats.map((c) => html`<option value=${c.id}>${c.name}</option>`)}</select></${Field}>
      <${Field} label="Reference" class="span2"><input type="text" value=${f.reference || ''} onInput=${(e) => set('reference', e.target.value)} /></${Field}>
    </div>
    <h3 style="margin:18px 0 8px">Items</h3>
    <${LinesEditor} lines=${f.lines} onChange=${(l) => set('lines', l)} meta=${meta} showVat=${vatOn || f.lines.some((l) => l.vat_code !== 'N')} error=${err.lines} />
    <p class="muted small" style="margin-top:10px">Tip: write <code>{month}</code>, <code>{year}</code>, <code>{quarter}</code> or <code>{prevMonth}</code> in descriptions – they're filled in for each invoice (“Retainer for {month} {year}” becomes “Retainer for March 2026”).</p>
  </${Modal}>`;
}

export default function Recurring() {
  const { meta } = useStore();
  const { data, error, reload } = useAsync(() => api.get('/api/recurring'), []);
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState(false);
  const runAll = async () => { setBusy(true); try { const r = await api.post('/api/recurring/run-due'); toast(r.created.length ? `Created ${r.created.length} invoice(s): ${r.created.map((c) => c.invoice).join(', ')}` : 'Nothing is due yet'); await refreshMeta(); reload(); } catch (e) { toastError(e); } setBusy(false); };
  const runOne = async (t) => { if (!confirm(`Create the next “${t.name}” invoice now, dated today?`)) return; try { const r = await api.post(`/api/recurring/${t.id}/run`); toast(`Created ${r.created.map((c) => c.invoice).join(', ')}`); await refreshMeta(); reload(); } catch (e) { toastError(e); } };
  const toggle = async (t) => { try { await api.put(`/api/recurring/${t.id}`, { active: !t.active }); reload(); } catch (e) { toastError(e); } };
  const remove = async (t) => { if (!confirm(`Delete “${t.name}”? Invoices already created are kept.`)) return; try { await api.del(`/api/recurring/${t.id}`); reload(); } catch (e) { toastError(e); } };
  return html`<div>
    <${PageHead} title="Recurring invoices" sub="Retainers, rent, subscriptions – set it once and invoices appear on schedule."><${Btn} onClick=${runAll} disabled=${busy}>Run anything due now</${Btn}><${Btn} kind="primary" icon="plus" onClick=${() => setModal({})}>New recurring invoice</${Btn}></${PageHead}>
    <${Notice}>Ledgerline checks for due invoices when it starts and every 30 minutes while it's running. If the app was closed over a due date, the missed invoices are created (with their proper dates) next time you open it.</${Notice}>
    ${error && html`<${Loading} error=${error} retry=${reload} />`}
    ${data && data.length === 0 && html`<div class="card"><${Empty} title="No recurring invoices">Create one for any customer you bill on a regular schedule.</${Empty}></div>`}
    ${data && data.length > 0 && html`<div class="grid g2">${data.map((t) => { const tot = calcLines(meta, t.lines); return html`<div class="card" key=${t.id} style=${t.active ? '' : 'opacity:.65'}>
      <div class="card-head"><h2 class="grow">${t.name}</h2>${!t.active ? html`<${Badge}>Paused / finished</${Badge}>` : html`<${Badge} tone="info"><${Icon} name="repeat" size=${12} /> Every ${t.interval_count > 1 ? t.interval_count + ' ' : ''}${FREQ_LABELS[t.frequency]}${t.interval_count > 1 ? 's' : ''}</${Badge}>`}</div>
      <div class="stack small">
        <div><strong>${t.contact_name || 'No customer'}</strong> · ${gbp(tot.gross)} each time</div>
        <div class="muted">${MODES[t.mode]} · due ${t.due_days} days after issue</div>
        <div>${t.active ? html`Next: <strong>${t.upcoming.length ? fmtDate(t.upcoming[0]) : '—'}</strong>${t.upcoming.length > 1 ? html` <span class="muted">then ${t.upcoming.slice(1).map((d) => fmtDate(d, { short: true })).join(', ')}</span>` : ''}` : ''}</div>
        <div class="muted">${t.runs} created so far${t.max_runs ? ` of ${t.max_runs}` : ''}${t.end_date ? ` · ends ${fmtDate(t.end_date)}` : ''}</div>
      </div>
      <div class="row" style="margin-top:12px"><${Btn} small onClick=${() => setModal({ t })}>Edit</${Btn}>${t.active && html`<${Btn} small onClick=${() => runOne(t)}>Create next now</${Btn}>`}<${Btn} small onClick=${() => toggle(t)}>${t.active ? 'Pause' : 'Resume'}</${Btn}><${Btn} small kind="danger" onClick=${() => remove(t)}>Delete</${Btn}></div></div>`; })}</div>`}
    ${modal && html`<${TemplateModal} t=${modal.t} onClose=${() => setModal(null)} onSaved=${() => { setModal(null); reload(); }} />`}
  </div>`;
}
