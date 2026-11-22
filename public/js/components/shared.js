import { html, Btn, Badge } from './ui.js';
import { gbp, fmtDate } from '../util.js';

/** Grouped category <select>. direction 'in'/'out' floats the relevant groups to the top. */
export function CategorySelect({ value, onChange, meta, direction, allowEmpty = true, ...rest }) {
  const cats = meta.categories;
  const groups = [];
  const order = direction === 'in' ? ['income', 'expense', 'capital', 'other', 'transfer', 'personal', 'tax'] : ['expense', 'capital', 'income', 'other', 'transfer', 'personal', 'tax'];
  const byKind = (k) => cats.filter((c) => c.kind === k);
  const label = { income: 'Income', expense: 'Expenses', capital: 'Equipment & capital', other: 'Reliefs & other', transfer: 'Not profit', personal: 'Not profit', tax: 'Not profit' };
  const seen = new Set();
  for (const k of order) {
    const items = byKind(k).filter((c) => !seen.has(c.id));
    items.forEach((c) => seen.add(c.id));
    if (!items.length) continue;
    const existing = groups.find((g) => g.label === label[k]);
    if (existing) existing.items.push(...items); else groups.push({ label: label[k], items });
  }
  return html`<select value=${value || ''} onChange=${(e) => onChange(e.target.value || null)} ...${rest}>
    ${allowEmpty && html`<option value="">— Choose a category —</option>`}
    ${groups.map((g) => html`<optgroup label=${g.label}>${g.items.map((c) => html`<option value=${c.id}>${c.name}${c.section === 'property' ? ' (property)' : ''}</option>`)}</optgroup>`)}
  </select>`;
}

export function AccountSelect({ value, onChange, meta, ...rest }) {
  return html`<select value=${value ?? ''} onChange=${(e) => onChange(e.target.value ? Number(e.target.value) : null)} ...${rest}>${meta.accounts.map((a) => html`<option value=${a.id}>${a.name}</option>`)}</select>`;
}

export function VatSelect({ value, onChange, meta, ...rest }) {
  return html`<select value=${value} onChange=${(e) => onChange(e.target.value)} ...${rest}>${meta.vatCodes.map((v) => html`<option value=${v.code}>${v.label}</option>`)}</select>`;
}

export const MoneyCell = ({ p, signed = true }) => html`<span class=${p > 0 && signed ? 'in' : ''}>${gbp(p)}</span>`;

export function StatusBadge({ s }) {
  const map = { draft: ['Draft', ''], sent: ['Awaiting payment', 'info'], part_paid: ['Part paid', 'warn'], paid: ['Paid', 'good'], overdue: ['Overdue', 'bad'], void: ['Void', ''] };
  const [label, tone] = map[s] || [s, ''];
  return html`<${Badge} tone=${tone}>${label}</${Badge}>`;
}

export function PageHead({ title, sub, children }) {
  return html`<div class="page-head"><div class="grow"><h1>${title}</h1>${sub && html`<div class="sub">${sub}</div>`}</div><div class="actions">${children}</div></div>`;
}

export function FlagBadges({ item }) {
  const f = item.flags || [];
  const out = [];
  if (item.duplicate) out.push(html`<${Badge} tone="warn" title="Already in your records">Duplicate</${Badge}>`);
  if (f.includes('direction_guessed')) out.push(html`<${Badge} tone="warn" title="Could not tell whether money went in or out – check the sign">Check direction</${Badge}>`);
  if (f.includes('no_date')) out.push(html`<${Badge} tone="warn">No date</${Badge}>`);
  if (f.some((x) => x.startsWith('foreign_currency'))) out.push(html`<${Badge} tone="warn" title="Not in pounds – amount is NOT converted">${(f.find((x) => x.startsWith('foreign')) || '').split(':')[1] || 'FX'}</${Badge}>`);
  if (f.includes('unpaid_supplier_invoice')) out.push(html`<${Badge} tone="warn" title="Unpaid supplier invoice – under the cash basis it only counts when paid">Unpaid bill</${Badge}>`);
  if (f.includes('totals_mismatch')) out.push(html`<${Badge} tone="warn" title="Net + VAT did not equal the total on the document">Totals differ</${Badge}>`);
  if (f.includes('ocr')) out.push(html`<${Badge} tone="info">OCR</${Badge}>`);
  if (item.invoice_match) out.push(html`<${Badge} tone="good" title=${item.invoice_match.how}>Pays ${item.invoice_match.number}</${Badge}>`);
  if (item.reconcile) out.push(html`<${Badge} tone="info" title="Will be merged instead of added twice">${item.reconcile.type === 'bank_txn' ? 'Matches bank line' : 'Matches receipt'}</${Badge}>`);
  if (item.target === 'invoice') out.push(html`<${Badge} tone="info">Becomes invoice</${Badge}>`);
  return out;
}

export { Btn, fmtDate };
