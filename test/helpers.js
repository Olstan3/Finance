import { openDb, saveSettings } from '../server/db.js';

export const gbp = (x) => Math.round(x * 100);

export function freshDb(settings = {}) {
  const db = openDb(':memory:');
  if (Object.keys(settings).length) saveSettings(db, settings);
  return db;
}

export function addContact(db, name = 'Acme Ltd', extra = {}) {
  return db.run('INSERT INTO contacts (name, kind, email) VALUES (?, ?, ?)', name, extra.kind || 'customer', extra.email || null).id;
}

/** Insert a transaction directly. amount in pounds (negative = money out). */
export function addTxn(db, { date, amount, category = null, desc = 'Test', vat = 0, vatCode = 'N', account = 1, pct = 100, status = 'confirmed', invoice = null }) {
  return db.run(
    `INSERT INTO transactions (account_id, date, description, amount, category_id, vat_code, vat_amount, business_pct, status, invoice_id, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
    account, date, desc, gbp(amount), category, vatCode, gbp(vat), pct, status, invoice,
  ).id;
}
