import { h } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import htm from 'htm';
import { parseMoney, toInput, cls } from '../util.js';
import { useStore } from '../store.js';

export const html = htm.bind(h);

const ICONS = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  upload: 'M12 16V4m0 0l-4 4m4-4l4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6',
  repeat: 'M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  chart: 'M4 20V10M10 20V4M16 20v-8M22 20H2',
  tax: 'M9 14l6-6M9.5 8.5h.01M14.5 13.5h.01M5 3h14a1 1 0 0 1 1 1v17l-3-2-2 2-3-2-3 2-2-2-3 2V4a1 1 0 0 1 1-1z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14', check: 'M5 13l4 4L19 7', x: 'M6 6l12 12M18 6L6 18', menu: 'M4 6h16M4 12h16M4 18h16',
  alert: 'M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  info: 'M12 16v-4m0-4h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z',
  download: 'M12 4v12m0 0l-4-4m4 4l4-4M4 20h16', mail: 'M3 6h18v12H3zM3 7l9 6 9-6', trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4', calc: 'M6 3h12v18H6zM9 7h6M9 12h.01M12 12h.01M15 12h.01M9 16h.01M12 16h.01M15 16h.01', pdf: 'M7 3h7l5 5v13H7zM14 3v5h5',
  paperclip: 'M21 11l-9 9a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8', sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
};
export function Icon({ name, size }) {
  return html`<svg viewBox="0 0 24 24" width=${size || 18} height=${size || 18} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${ICONS[name] || ''} /></svg>`;
}

export function Btn({ kind, small, icon, children, ...rest }) {
  return html`<button type="button" class=${cls('btn', kind, small && 'small')} ...${rest}>${icon && html`<${Icon} name=${icon} />`}${children}</button>`;
}

export function Badge({ tone, children, title }) { return html`<span class=${cls('badge', tone)} title=${title}>${children}</span>`; }

export function Notice({ tone = 'info', children, actions }) {
  const icon = tone === 'error' || tone === 'warn' ? 'alert' : tone === 'good' ? 'check' : 'info';
  return html`<div class=${cls('notice', tone === 'info' ? '' : tone)} role=${tone === 'error' ? 'alert' : 'status'}><${Icon} name=${icon} /><div class="grow">${children}</div>${actions}</div>`;
}

export function Empty({ title, children }) { return html`<div class="empty"><h3>${title}</h3><div>${children}</div></div>`; }

export function Field({ label, hint, error, children, class: c }) {
  return html`<label class=${cls('field', c)}>${label}${children}${hint && html`<span class="hint">${hint}</span>`}${error && html`<span class="field-error">${error}</span>`}</label>`;
}

/** Money input: shows pounds, reports pence. Keeps what you type until blur. */
export function MoneyInput({ value, onChange, allowNegative = false, ...rest }) {
  const [text, setText] = useState(value == null ? '' : toInput(value));
  const last = useRef(value);   // the last value this field reported to its parent
  const prop = useRef(value);   // the last value the parent passed down
  // Only a *change of the parent's value* can overwrite what the user typed. (Comparing against `last` alone
  // races: an early keystroke updates `last` before the mount-time effect runs, which then wrongly clears the field.)
  useEffect(() => {
    if (value === prop.current) return;
    prop.current = value;
    if (value !== last.current) { last.current = value; setText(value == null ? '' : toInput(value)); }
  }, [value]);
  const commit = (t) => {
    const p = parseMoney(t);
    const v = p == null ? null : allowNegative ? p : Math.abs(p);
    last.current = v;
    onChange(v);
    return v;
  };
  return html`<div class="money"><span>£</span><input type="text" inputmode="decimal" value=${text} ...${rest}
    onInput=${(e) => { setText(e.target.value); const p = parseMoney(e.target.value); if (p != null) { last.current = allowNegative ? p : Math.abs(p); onChange(last.current); } else if (e.target.value === '') { last.current = null; onChange(null); } }}
    onBlur=${(e) => { const v = commit(e.target.value); setText(v == null ? '' : toInput(v)); /* read the DOM value: the `text` state in this closure can be one keystroke behind when focus moves quickly */ }} /></div>`;
}

export function Modal({ title, onClose, children, footer, wide }) {
  const ref = useRef();
  useEffect(() => {
    const prev = document.activeElement;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector('input:not([type=checkbox]), select, textarea, button.primary')?.focus();
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, []);
  return html`<div class="overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class=${cls('modal', wide && 'wide')} role="dialog" aria-modal="true" aria-label=${title} ref=${ref}>
      <div class="modal-head"><h2 class="grow">${title}</h2><button class="btn ghost small" onClick=${onClose} aria-label="Close"><${Icon} name="x" /></button></div>
      <div class="modal-body">${children}</div>
      ${footer && html`<div class="modal-foot">${footer}</div>`}
    </div></div>`;
}

export function Tabs({ tabs, value, onChange }) {
  return html`<div class="tabs" role="tablist">${tabs.map((t) => html`<button role="tab" aria-selected=${value === t.id} onClick=${() => onChange(t.id)}>${t.label}${t.badge ? html` <span class="badge warn">${t.badge}</span>` : ''}</button>`)}</div>`;
}

export function Seg({ options, value, onChange, label }) {
  return html`<div class="seg" role="group" aria-label=${label}>${options.map((o) => html`<button aria-pressed=${value === o.value} onClick=${() => onChange(o.value)}>${o.label}</button>`)}</div>`;
}

export function Toasts() {
  const { toasts } = useStore();
  return html`<div class="toasts" aria-live="polite">${toasts.map((t) => html`<div class=${cls('toast', t.kind === 'error' && 'error')} key=${t.id}>${t.message}</div>`)}</div>`;
}

/** Run an async loader whenever deps change. Keeps the previous data while reloading (no flash). */
export function useAsync(fn, deps) {
  const [s, set] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const run = useCallback(() => {
    const my = ++seq.current;
    set((x) => ({ ...x, loading: true }));
    return Promise.resolve().then(fn).then(
      (data) => { if (my === seq.current) set({ data, error: null, loading: false }); },
      (error) => { if (my === seq.current) set((x) => ({ data: x.data, error, loading: false })); },
    );
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...s, reload: run };
}

export function Loading({ error, retry }) {
  if (error) return html`<${Notice} tone="error" actions=${retry && html`<button class="link" onClick=${retry}>Try again</button>`}>${error.message}</${Notice}>`;
  return html`<p class="muted">Loading…</p>`;
}

export function TaxYearSelect({ value, onChange, years }) {
  return html`<select aria-label="Tax year" value=${value} onChange=${(e) => onChange(e.target.value)} style="width:auto">${years.map((y) => html`<option value=${y.label}>${y.label.replace('-', '/')} tax year${y.status === 'provisional' ? ' (provisional)' : ''}</option>`)}</select>`;
}

export function PeriodSelect({ value, onChange, periods }) {
  return html`<select aria-label="Accounting period" value=${value} onChange=${(e) => onChange(e.target.value)} style="width:auto">${[...periods].reverse().map((p) => html`<option value=${p.key}>${p.label}</option>`)}</select>`;
}

export const Pager = ({ total, offset, limit, onChange }) => total <= limit ? null : html`<div class="row" style="justify-content:flex-end;margin-top:10px">
  <span class="muted small">${offset + 1}–${Math.min(total, offset + limit)} of ${total}</span>
  <${Btn} small disabled=${offset === 0} onClick=${() => onChange(Math.max(0, offset - limit))}>Previous</${Btn}>
  <${Btn} small disabled=${offset + limit >= total} onClick=${() => onChange(offset + limit)}>Next</${Btn}></div>`;
