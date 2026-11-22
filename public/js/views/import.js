import { useState, useRef, useMemo } from 'preact/hooks';
import { html, Btn, Badge, Notice, Empty, useAsync, Icon, Modal } from '../components/ui.js';
import { CategorySelect, AccountSelect, FlagBadges, PageHead } from '../components/shared.js';
import { api } from '../api.js';
import { useStore, refreshMeta, toast, toastError } from '../store.js';
import { gbp, fmtDate } from '../util.js';

const MODE_TEXT = {
  statement: 'bank / card statement', table: 'spreadsheet table', ofx: 'OFX bank file', qif: 'QIF bank file', document: 'single invoice or receipt', notes: 'free-form notes', scanned: 'scanned document', error: 'unreadable', empty: 'empty',
};
const PREVIEW_ROWS = 300;

function BatchPreview({ batch: initial, onDone, onDiscard }) {
  const { meta } = useStore();
  const [batch] = useState(initial);
  const [edits, setEdits] = useState({});
  const [onlyReview, setOnlyReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [acct, setAcct] = useState(batch.items[0]?.account_id || meta.accounts[0].id);
  const items = batch.items;
  const eff = (it) => ({ ...it, ...(edits[it.idx] || {}) });
  const upd = (idx, patch) => setEdits((e) => ({ ...e, [idx]: { ...(e[idx] || {}), ...patch } }));
  const included = items.map(eff).filter((i) => i.include);
  const totals = useMemo(() => ({ in: included.filter((i) => i.amount > 0).reduce((a, i) => a + i.amount, 0), out: included.filter((i) => i.amount < 0).reduce((a, i) => a + i.amount, 0) }), [edits]);
  const needs = included.filter((i) => (!i.category_id || i.needs_review) && !(edits[i.idx]?.category_id)).length;
  const shown = items.map(eff).filter((i) => !onlyReview || i.needs_review || i.duplicate).slice(0, PREVIEW_ROWS);
  const allOn = items.length > 0 && items.every((i) => eff(i).include);

  const record = async () => {
    setBusy(true);
    try {
      const payload = { ...edits };
      for (const it of items) if (it.account_id !== acct) payload[it.idx] = { ...(payload[it.idx] || {}), account_id: acct };
      const r = await api.post(`/api/import/batches/${batch.id}/commit`, { edits: payload });
      setResult(r); await refreshMeta(); onDone?.(r);
    } catch (e) { toastError(e); }
    setBusy(false);
  };
  const discard = async () => { try { await api.del(`/api/import/batches/${batch.id}`); onDiscard(batch.id); } catch (e) { toastError(e); } };

  if (result) return html`<div class="card"><${Notice} tone="good"><strong>${batch.filename}</strong>: recorded ${result.created} transaction${result.created === 1 ? '' : 's'}${result.invoices ? `, ${result.invoices} invoice${result.invoices === 1 ? '' : 's'}` : ''}${result.merged ? `, merged ${result.merged} with existing records` : ''}${result.linkedToInvoices ? `, matched ${result.linkedToInvoices} payment${result.linkedToInvoices === 1 ? '' : 's'} to invoices` : ''}${result.transfers ? `, paired ${result.transfers} transfer${result.transfers === 1 ? '' : 's'}` : ''}.</${Notice}>
    <div class="row">${result.needsReview > 0 ? html`<a class="btn primary" href=${`#/transactions?status=review&taxYear=all`}>Review ${result.needsReview} flagged</a>` : html`<${Badge} tone="good">Everything categorised confidently</${Badge}>`}<a class="btn" href="#/tax">See tax return</a></div></div>`;

  return html`<div class="card">
    <div class="card-head">
      <div class="grow"><h2>${batch.filename || 'Pasted text'}</h2><div class="muted small">Detected a ${MODE_TEXT[batch.summary.mode] || batch.summary.mode}${batch.summary.dateFrom ? ` · ${fmtDate(batch.summary.dateFrom)} to ${fmtDate(batch.summary.dateTo)}` : ''}</div></div>
      <div class="row small"><label>Record into <${AccountSelect} value=${acct} meta=${meta} onChange=${setAcct} style="width:auto;display:inline-block" /></label></div>
    </div>
    ${(batch.summary.warnings || []).map((w) => html`<${Notice} tone="warn">${w}</${Notice}>`)}
    ${items.length === 0 ? html`<${Empty} title="Nothing found">We couldn't find any transactions in this file. Try pasting the text, or a CSV export from your bank.</${Empty}>` : html`
    <div class="row" style="margin-bottom:10px"><${Badge} tone="info">${included.length} to record</${Badge}><span>in <strong>${gbp(totals.in)}</strong> · out <strong>${gbp(-totals.out)}</strong></span>
      ${batch.summary.duplicates > 0 && html`<${Badge} tone="warn">${batch.summary.duplicates} duplicate${batch.summary.duplicates > 1 ? 's' : ''} skipped</${Badge}>`}
      ${needs > 0 && html`<${Badge} tone="warn">${needs} need${needs === 1 ? 's' : ''} a look</${Badge}>`}
      <span class="grow"></span><label class="check small"><input type="checkbox" checked=${onlyReview} onChange=${(e) => setOnlyReview(e.target.checked)} /> Only rows needing a look</label></div>
    <div class="table-wrap" style="max-height:60vh;overflow:auto"><table class="preview">
      <thead><tr><th style="width:34px"><input type="checkbox" aria-label="Include all" checked=${allOn} onChange=${() => items.forEach((i) => upd(i.idx, { include: !allOn }))} /></th><th>Date</th><th>Description</th><th class="num">Amount</th><th style="min-width:210px">Category</th><th>Notes</th></tr></thead>
      <tbody>${shown.map((it) => html`<tr key=${it.idx} class=${!it.include ? 'faded' : ''}>
        <td><input type="checkbox" aria-label="Include" checked=${it.include} onChange=${(e) => upd(it.idx, { include: e.target.checked })} /></td>
        <td><input type="date" value=${it.date} style="width:140px" onInput=${(e) => upd(it.idx, { date: e.target.value })} /></td>
        <td><input type="text" value=${it.description} onInput=${(e) => upd(it.idx, { description: e.target.value })} />${it.contact_name ? html`<div class="muted small">${it.contact_name}</div>` : ''}</td>
        <td class="num"><span class=${it.amount > 0 ? 'in' : ''}>${gbp(it.amount)}</span> <button class="btn ghost small" title="Money went the other way? Flip it" aria-label="Flip money in/out" onClick=${() => upd(it.idx, { amount: -it.amount })}>⇄</button></td>
        <td><${CategorySelect} value=${it.category_id} meta=${meta} direction=${it.amount > 0 ? 'in' : 'out'} onChange=${(v) => upd(it.idx, { category_id: v })} class=${!it.category_id ? 'invalid' : ''} />${it.category_reason && it.category_id ? html`<div class="muted small" title="Why this category">${it.category_reason}</div>` : ''}</td>
        <td><div class="row" style="gap:4px"><${FlagBadges} item=${it} />${it.needs_review && !it.duplicate && !it.flags.length && it.category_id ? html`<${Badge} tone="warn" title=${`Confidence ${Math.round(it.confidence * 100)}%`}>Check</${Badge}>` : ''}</div></td></tr>`)}</tbody></table></div>
    ${items.length > PREVIEW_ROWS && html`<p class="muted small">Showing the first ${PREVIEW_ROWS} of ${items.length} rows. All included rows are recorded.</p>`}
    <div class="row" style="margin-top:14px"><${Btn} kind="primary" onClick=${record} disabled=${busy || included.length === 0}>${busy ? 'Recording…' : `Record ${included.length} item${included.length === 1 ? '' : 's'}`}</${Btn}><${Btn} onClick=${discard}>Discard</${Btn}>
      <span class="muted small">Rows needing a look are recorded too, marked “review”, and left out of your tax figures until you categorise them.</span></div>`}
  </div>`;
}

export default function Import() {
  const { meta } = useStore();
  const [batches, setBatches] = useState([]);
  const [busy, setBusy] = useState('');
  const [over, setOver] = useState(false);
  const [text, setText] = useState('');
  const [acct, setAcct] = useState(meta.accounts.find((a) => a.kind !== 'cash')?.id || meta.accounts[0].id);
  const [tick, setTick] = useState(0);
  const input = useRef();
  const recent = useAsync(() => api.get('/api/import/batches'), [tick]);

  const upload = async (files) => {
    for (const file of [...files]) {
      setBusy(`Reading ${file.name}…`);
      try { const b = await api.upload(`/api/import/upload?filename=${encodeURIComponent(file.name)}&accountId=${acct}`, file); setBatches((x) => [b, ...x]); }
      catch (e) { toastError(new Error(`${file.name}: ${e.message}`)); }
    }
    setBusy(''); setTick((t) => t + 1);
  };
  const paste = async () => {
    setBusy('Reading text…');
    try { const b = await api.post('/api/import/text', { text, accountId: acct }); setBatches((x) => [b, ...x]); setText(''); } catch (e) { toastError(e); }
    setBusy(''); setTick((t) => t + 1);
  };
  const resume = async (id) => { try { const b = await api.get(`/api/import/batches/${id}`); setBatches((x) => x.some((y) => y.id === id) ? x : [b, ...x]); } catch (e) { toastError(e); } };
  const undo = async (b) => { if (!confirm(`Undo the import of “${b.filename}”? The transactions it created will be removed.`)) return; try { const r = await api.post(`/api/import/batches/${b.id}/undo`); toast(`Removed ${r.removedTransactions} transaction(s)`); await refreshMeta(); setTick((t) => t + 1); } catch (e) { toastError(e); } };
  const hasBank = meta.accounts.some((a) => a.kind !== 'cash');

  return html`<div>
    <${PageHead} title="Import" sub="Drop in anything with money on it. Ledgerline finds the dates, amounts and descriptions wherever they are." />
    <div class=${`drop${over ? ' over' : ''}`} onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)} onDrop=${(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files); }}>
      <div class="big"><${Icon} name="upload" size=${22} /> Drop files here</div>
      <div class="muted">Bank statements (CSV, Excel, OFX, QIF, PDF) · invoices and receipts (PDF, Word, photos, emails) · or paste text below</div>
      <div class="row" style="justify-content:center;margin-top:14px">
        <input ref=${input} type="file" multiple style="display:none" accept=".csv,.tsv,.txt,.xlsx,.ofx,.qfx,.qif,.pdf,.docx,.html,.htm,.eml,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff" onChange=${(e) => { upload(e.target.files); e.target.value = ''; }} />
        <${Btn} kind="primary" onClick=${() => input.current.click()} disabled=${!!busy}>${busy || 'Choose files'}</${Btn}>
        <label class="small muted">Bank account <${AccountSelect} value=${acct} meta=${meta} onChange=${setAcct} style="width:auto;display:inline-block" /></label>
      </div>
    </div>
    ${!hasBank && html`<${Notice} tone="warn">Add a bank account in Settings first so imported rows have somewhere to go.</${Notice}>`}
    <details class="card" style="margin:14px 0"><summary style="cursor:pointer;font-weight:600">Paste text instead (from a bank website, an email, notes…)</summary>
      <div class="stack" style="margin-top:10px"><textarea rows="6" placeholder=${'e.g.\n03/04/2025  SHELL FUEL  45.00\nPaid £120 to Screwfix on 5 April for tools\nor a whole invoice pasted from an email'} value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
      <div><${Btn} onClick=${paste} disabled=${text.trim().length < 5 || !!busy}>Read this text</${Btn}></div></div></details>

    <div class="stack" style="margin:14px 0">${batches.map((b) => html`<${BatchPreview} key=${b.id} batch=${b} onDone=${() => setTick((t) => t + 1)} onDiscard=${(id) => { setBatches((x) => x.filter((y) => y.id !== id)); setTick((t) => t + 1); }} />`)}</div>

    <div class="card"><div class="card-head"><h2>Recent imports</h2></div>
      ${recent.data?.length ? html`<div class="table-wrap"><table><thead><tr><th>When</th><th>File</th><th>Type</th><th class="num">Rows</th><th>Status</th><th></th></tr></thead><tbody>
        ${recent.data.map((b) => html`<tr><td class="nowrap">${(b.committed_at || b.created_at).slice(0, 16).replace('T', ' ')}</td><td>${b.filename}</td><td>${MODE_TEXT[b.summary?.mode] || b.source_kind || ''}</td><td class="num">${b.summary?.included ?? b.summary?.total ?? ''}</td>
          <td><${Badge} tone=${b.status === 'committed' ? 'good' : b.status === 'preview' ? 'warn' : ''}>${b.status === 'preview' ? 'Not recorded yet' : b.status === 'committed' ? 'Recorded' : 'Undone'}</${Badge}></td>
          <td class="right">${b.status === 'preview' ? html`<${Btn} small onClick=${() => resume(b.id)}>Review</${Btn}>` : b.status === 'committed' ? html`<${Btn} small kind="danger" onClick=${() => undo(b)}>Undo</${Btn}>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">Nothing imported yet.</p>`}
    </div>
  </div>`;
}
