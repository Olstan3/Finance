import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { html, Icon, Toasts, Field, Btn, Notice } from './components/ui.js';
import { api, onLocked } from './api.js';
import { useStore, refreshMeta, setState, toastError } from './store.js';
import { cls } from './util.js';
import Dashboard from './views/dashboard.js';
import Transactions from './views/transactions.js';
import Import from './views/import.js';
import { InvoiceList, InvoiceEditor, InvoiceDetail } from './views/invoices.js';
import Recurring from './views/recurring.js';
import Contacts from './views/contacts.js';
import Reports from './views/reports.js';
import Tax from './views/tax.js';
import Company from './views/company.js';
import Settings from './views/settings.js';

// ---- hash router: "#/invoices/12/edit?x=1"
function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/dashboard';
  const [path, q = ''] = raw.split('?');
  return { segments: path.split('/').filter(Boolean), query: Object.fromEntries(new URLSearchParams(q)), path };
}
export function useRoute() {
  const [r, setR] = useState(parseHash());
  useEffect(() => { const f = () => { setR(parseHash()); window.scrollTo(0, 0); }; addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return r;
}
export const go = (path) => { location.hash = path; };

const NAV = [
  ['dashboard', 'Dashboard', 'home'], ['transactions', 'Transactions', 'list'], ['import', 'Import', 'upload'], ['invoices', 'Invoices', 'file'],
  ['recurring', 'Recurring', 'repeat'], ['contacts', 'Customers', 'users'], ['sep'], ['reports', 'Reports', 'chart'], ['tax', 'Tax return', 'tax'], ['settings', 'Settings', 'gear'],
];

function Login({ onDone }) {
  const [pw, setPw] = useState(''); const [err, setErr] = useState('');
  const submit = async (e) => { e.preventDefault(); try { await api.post('/api/auth/login', { passcode: pw }); onDone(); } catch (x) { setErr(x.message); } };
  return html`<main style="max-width:380px;margin:12vh auto;padding:0 18px"><form class="card stack" onSubmit=${submit}>
    <h1>Ledgerline</h1><p class="muted">Enter your passcode to open your accounts.</p>
    <${Field} label="Passcode" error=${err}><input type="password" autofocus value=${pw} onInput=${(e) => setPw(e.target.value)} autocomplete="current-password" /></${Field}>
    <${Btn} kind="primary" type="submit">Unlock</${Btn}></form></main>`;
}

function themeInit() {
  try { const t = localStorage.getItem('ledgerline-theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch { /* storage unavailable */ }
}
function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('ledgerline-theme', next); } catch { /* ignore */ }
}

function Shell() {
  const route = useRoute();
  const { meta } = useStore();
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [route.path]);
  if (!meta) return html`<p class="boot">Loading Ledgerline…</p>`;
  const [section = 'dashboard', a, b] = route.segments;
  const counts = meta.counts;
  const isCo = meta.settings.entityType === 'company';
  let view;
  switch (section) {
    case 'dashboard': view = html`<${Dashboard} />`; break;
    case 'transactions': view = html`<${Transactions} query=${route.query} />`; break;
    case 'import': view = html`<${Import} />`; break;
    case 'invoices': view = a === 'new' ? html`<${InvoiceEditor} key="new" query=${route.query} />` : a && b === 'edit' ? html`<${InvoiceEditor} key=${a} id=${Number(a)} />` : a ? html`<${InvoiceDetail} key=${a} id=${Number(a)} />` : html`<${InvoiceList} query=${route.query} />`; break;
    case 'recurring': view = html`<${Recurring} />`; break;
    case 'contacts': view = html`<${Contacts} />`; break;
    case 'reports': view = html`<${Reports} query=${route.query} />`; break;
    case 'tax': view = isCo ? html`<${Company} query=${route.query} />` : html`<${Tax} query=${route.query} />`; break;
    case 'settings': view = html`<${Settings} query=${route.query} />`; break;
    default: view = html`<div class="card"><h2>Page not found</h2><p><a href="#/dashboard">Back to the dashboard</a></p></div>`;
  }
  const badge = { transactions: counts.review + counts.uncategorised, invoices: counts.overdue };
  return html`<div class="shell">
    <div class="topbar"><button class="btn ghost" aria-label="Open menu" onClick=${() => setOpen(true)}><${Icon} name="menu" /></button><strong>Ledgerline</strong></div>
    <aside class=${cls('side', open && 'open')} aria-label="Main">
      <div class="brand"><span class="brand-mark"><svg viewBox="0 0 32 32" width="18" height="18"><path d="M8 21h16M8 15h10M8 9h6" stroke="var(--accent-ink)" stroke-width="3" stroke-linecap="round" fill="none"/></svg></span>Ledgerline</div>
      <nav class="nav">${NAV.map(([id, label0, icon]) => { const label = id === 'tax' && isCo ? 'Company tax' : id === 'contacts' && isCo ? 'Customers & suppliers' : label0; return id === 'sep' ? html`<div class="nav-sep" />` : html`<a href=${`#/${id}`} aria-current=${section === id ? 'page' : undefined}><${Icon} name=${icon} />${label}${badge[id] ? html`<span class=${cls('count', id === 'invoices' && 'bad')}>${badge[id]}</span>` : ''}</a>`; })}</nav>
      <div class="side-foot"><button class="btn small ghost" onClick=${toggleTheme}>Light / dark</button><div style="margin-top:6px">Your data stays on this computer.</div></div>
    </aside>
    ${open && html`<div class="overlay" style="z-index:35;background:rgba(0,0,0,.3)" onClick=${() => setOpen(false)}></div>`}
    <main class="main" id="main">${view}</main>
  </div>`;
}

function App() {
  const [auth, setAuth] = useState('checking');
  const [err, setErr] = useState(null);
  const boot = async () => {
    try {
      const s = await api.get('/api/auth/status');
      if (s.locked && !s.authenticated) return setAuth('locked');
      await refreshMeta(); setAuth('ready');
    } catch (e) { setErr(e); setAuth('error'); }
  };
  useEffect(() => { boot(); return onLocked(() => setAuth('locked')); }, []);
  if (auth === 'checking') return html`<p class="boot">Loading Ledgerline…</p>`;
  if (auth === 'error') return html`<main style="max-width:520px;margin:10vh auto;padding:0 18px"><${Notice} tone="error">${err?.message}</${Notice}></main>`;
  if (auth === 'locked') return html`<${Login} onDone=${boot} />`;
  return html`<${Shell} />`;
}

themeInit();
render(html`<${App} /><${Toasts} />`, document.getElementById('app'));
window.addEventListener('unhandledrejection', (e) => { toastError(e.reason); });
export { setState };
