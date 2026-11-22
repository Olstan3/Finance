import { useState, useEffect } from 'preact/hooks';
import { api } from './api.js';

const state = { meta: null, toasts: [], locked: false, taxYear: null };
const subs = new Set();
const emit = () => subs.forEach((f) => f());

export const getState = () => state;
export function setState(patch) { Object.assign(state, patch); emit(); }
export function useStore() {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((n) => n + 1); subs.add(f); return () => subs.delete(f); }, []);
  return state;
}

const YEAR_KEY = 'ledgerline-tax-year';
function storedYear(meta) {
  try {
    const y = localStorage.getItem(YEAR_KEY);
    return y && (meta.taxYears.some((t) => t.label === y) || meta.company?.periods?.some((p) => p.key === y)) ? y : null;
  } catch { return null; }
}

/** What's selected, validated for the current business type: a tax year for individuals, an accounting-period key for companies. */
export function selection(meta, selected) {
  if (meta.settings.entityType === 'company') return meta.company?.periods?.some((p) => p.key === selected) ? selected : meta.company?.current;
  return meta.taxYears.some((t) => t.label === selected) ? selected : meta.currentTaxYear;
}
/** The tax year being viewed survives reloads (kept in localStorage; the app works fine without it). */
export function setTaxYear(y) {
  try { localStorage.setItem(YEAR_KEY, y); } catch { /* storage unavailable */ }
  setState({ taxYear: y });
}

export async function refreshMeta() {
  const meta = await api.get('/api/meta');
  setState({ meta, taxYear: state.taxYear || storedYear(meta) || meta.currentTaxYear });
  return meta;
}

let toastId = 0;
export function toast(message, kind = 'info', ms = 4200) {
  const id = ++toastId;
  state.toasts = [...state.toasts, { id, message, kind }];
  emit();
  setTimeout(() => { state.toasts = state.toasts.filter((t) => t.id !== id); emit(); }, kind === 'error' ? 7000 : ms);
}
export const toastError = (e) => toast(e?.message || String(e), 'error');
