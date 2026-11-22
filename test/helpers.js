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
export function addTxn(db, { date, amount, category = null, desc = 'Test', vat = 0, vatCode = 'N', account = 1, pct = 100, status = 'confirmed', invoice = null, spread = null, contact = null }) {
  return db.run(
    `INSERT INTO transactions (account_id, date, description, amount, category_id, vat_code, vat_amount, business_pct, status, invoice_id, source, spread_from, spread_to, contact_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`,
    account, date, desc, gbp(amount), category, vatCode, gbp(vat), pct, status, invoice, spread?.[0] ?? null, spread?.[1] ?? null, contact,
  ).id;
}

/** A limited company incorporated 1 April 2025 with a 31 March year end and two 50/50 director-shareholders. */
export function companyDb(extra = {}) {
  const db = freshDb({
    entityType: 'company',
    company: { name: 'Pixel Pond Ltd', number: '12345678', utr: '1234567890', incorporationDate: '2025-04-01', yearEndMonth: 3, yearEndDay: 31, shareCapital: 100, directors: [{ id: 'd1', name: 'Sam', shares: 50, contact_id: null }, { id: 'd2', name: 'Alex', shares: 50, contact_id: null }] },
    ...extra,
  });
  const c1 = db.run("INSERT INTO contacts (name, kind) VALUES ('Sam', 'director')").id;
  const c2 = db.run("INSERT INTO contacts (name, kind) VALUES ('Alex', 'director')").id;
  saveSettings(db, { company: { directors: [{ id: 'd1', name: 'Sam', shares: 50, contact_id: c1 }, { id: 'd2', name: 'Alex', shares: 50, contact_id: c2 }] } });
  const dla1 = db.run("INSERT INTO accounts (name, kind, director_id) VALUES ('Director loan – Sam', 'dla', 'd1')").id;
  const dla2 = db.run("INSERT INTO accounts (name, kind, director_id) VALUES ('Director loan – Alex', 'dla', 'd2')").id;
  return { db, c1, c2, dla1, dla2 };
}
