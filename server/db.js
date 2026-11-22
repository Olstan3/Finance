import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { seedCategories } from './domain/categories.js';

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'bank',
  opening_balance INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'customer',
  email TEXT, phone TEXT, address TEXT, vat_number TEXT, notes TEXT,
  payment_terms_days INTEGER, archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, section TEXT NOT NULL,
  tax_field TEXT NOT NULL, allowable INTEGER NOT NULL DEFAULT 1, builtin INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 1000
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY, pattern TEXT NOT NULL, match_type TEXT NOT NULL DEFAULT 'contains',
  direction TEXT NOT NULL DEFAULT 'any', category_id TEXT NOT NULL REFERENCES categories(id),
  contact_id INTEGER REFERENCES contacts(id), business_pct INTEGER NOT NULL DEFAULT 100,
  priority INTEGER NOT NULL DEFAULT 100, hits INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY, filename TEXT NOT NULL, mime TEXT, size INTEGER, sha256 TEXT,
  stored_name TEXT, kind TEXT, extracted TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_sha ON documents(sha256);

CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY, filename TEXT, source_kind TEXT, status TEXT NOT NULL DEFAULT 'preview',
  account_id INTEGER, document_id INTEGER, summary TEXT, items TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), committed_at TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'invoice',
  contact_id INTEGER REFERENCES contacts(id), issue_date TEXT NOT NULL, due_date TEXT,
  status TEXT NOT NULL DEFAULT 'draft', reference TEXT, notes TEXT, terms TEXT,
  category_id TEXT REFERENCES categories(id), recurring_id INTEGER, tag TEXT,
  sent_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), document_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_invoices_issue ON invoices(issue_date);
CREATE INDEX IF NOT EXISTS idx_invoices_contact ON invoices(contact_id);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL, quantity REAL NOT NULL DEFAULT 1, unit_price INTEGER NOT NULL DEFAULT 0,
  vat_code TEXT NOT NULL DEFAULT 'N', sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lines_invoice ON invoice_lines(invoice_id);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL, description TEXT NOT NULL, amount INTEGER NOT NULL,
  category_id TEXT REFERENCES categories(id), contact_id INTEGER REFERENCES contacts(id),
  invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  vat_code TEXT NOT NULL DEFAULT 'N', vat_amount INTEGER NOT NULL DEFAULT 0,
  business_pct INTEGER NOT NULL DEFAULT 100, tag TEXT, notes TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed', source TEXT NOT NULL DEFAULT 'manual',
  confidence REAL, batch_id INTEGER, document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  fingerprint TEXT, balance INTEGER, reference TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_txn_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_txn_cat ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_txn_invoice ON transactions(invoice_id);
CREATE INDEX IF NOT EXISTS idx_txn_fp ON transactions(fingerprint);
CREATE INDEX IF NOT EXISTS idx_txn_batch ON transactions(batch_id);

CREATE TABLE IF NOT EXISTS recurring_templates (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, contact_id INTEGER REFERENCES contacts(id),
  frequency TEXT NOT NULL DEFAULT 'monthly', interval_count INTEGER NOT NULL DEFAULT 1,
  start_date TEXT NOT NULL, end_date TEXT, next_date TEXT NOT NULL, max_runs INTEGER,
  runs INTEGER NOT NULL DEFAULT 0, due_days INTEGER NOT NULL DEFAULT 30,
  mode TEXT NOT NULL DEFAULT 'draft', category_id TEXT REFERENCES categories(id),
  lines TEXT NOT NULL DEFAULT '[]', notes TEXT, reference TEXT, active INTEGER NOT NULL DEFAULT 1,
  last_run TEXT, anchor_day INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, purchase_date TEXT NOT NULL, cost INTEGER NOT NULL,
  pool TEXT NOT NULL DEFAULT 'main', business_pct INTEGER NOT NULL DEFAULT 100,
  disposal_date TEXT, disposal_proceeds INTEGER, notes TEXT, txn_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mileage (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, from_place TEXT, to_place TEXT, purpose TEXT,
  miles REAL NOT NULL, vehicle TEXT NOT NULL DEFAULT 'car', created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mileage_date ON mileage(date);

CREATE TABLE IF NOT EXISTS disposals (
  id INTEGER PRIMARY KEY, description TEXT NOT NULL, asset_type TEXT NOT NULL DEFAULT 'shares',
  acquired_date TEXT, disposal_date TEXT NOT NULL, proceeds INTEGER NOT NULL, cost INTEGER NOT NULL DEFAULT 0,
  costs INTEGER NOT NULL DEFAULT 0, residential INTEGER NOT NULL DEFAULT 0, notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tax_inputs (
  tax_year TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (tax_year, key)
);

CREATE TABLE IF NOT EXISTS vat_returns (
  id INTEGER PRIMARY KEY, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
  boxes TEXT NOT NULL, filed_at TEXT, reference TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT (datetime('now')), entity TEXT, entity_id TEXT,
  action TEXT, detail TEXT
);
`;

export const DATA_DIR = process.env.LEDGER_DATA_DIR || path.resolve(process.cwd(), 'data');

export function openDb(file = path.join(DATA_DIR, 'ledger.sqlite')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const v = db.prepare('PRAGMA user_version').get().user_version;
  db.exec(SCHEMA);
  if (v < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  seedCategories(db);

  // Run fn inside a transaction; roll back on any throw. Re-entrant calls join the outer one.
  let depth = 0;
  db.tx = (fn) => {
    if (depth > 0) return fn();
    db.exec('BEGIN IMMEDIATE');
    depth++;
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    } finally {
      depth--;
    }
  };
  db.all = (sql, ...p) => db.prepare(sql).all(...p);
  db.get = (sql, ...p) => db.prepare(sql).get(...p);
  db.run = (sql, ...p) => {
    const r = db.prepare(sql).run(...p);
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
  };

  if (!db.get('SELECT 1 AS x FROM accounts LIMIT 1')) {
    db.run("INSERT INTO accounts (name, kind) VALUES ('Business current account', 'bank')");
    db.run("INSERT INTO accounts (name, kind) VALUES ('Cash & receipts (no bank match yet)', 'cash')");
  }
  return db;
}

// ---------------- settings ----------------

export const DEFAULT_SETTINGS = {
  profile: {
    name: '', tradingName: '', utr: '', nino: '', email: '', phone: '', address: '', postcode: '',
    businessDescription: '', businessPostcode: '', region: 'england', aliases: '',
  },
  accountingBasis: 'cash', // cash | accruals (for income-tax purposes)
  businessStartDate: '',
  vat: { registered: false, number: '', scheme: 'standard', flatRatePct: 0, stagger: 'quarterly' },
  invoice: {
    prefix: 'INV-', nextNumber: 1, creditPrefix: 'CN-', nextCreditNumber: 1, paymentTermsDays: 30,
    notes: '', footer: 'Thank you for your business.', bankDetails: '', padding: 4,
  },
  mtd: { quarterlyScheme: 'standard' },
  importer: { autoRecordConfidence: 0.7 },
  defaultAccountId: null,
};

const isPlain = (x) => x && typeof x === 'object' && !Array.isArray(x);
function deepMerge(base, over) {
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    out[k] = isPlain(base[k]) && isPlain(over[k]) ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

export function getSettings(db) {
  const row = db.get("SELECT value FROM settings WHERE key = 'app'");
  return deepMerge(DEFAULT_SETTINGS, row ? JSON.parse(row.value) : {});
}
export function saveSettings(db, patch) {
  const merged = deepMerge(getSettings(db), patch);
  db.run("INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(merged));
  return merged;
}

export function getTaxInput(db, taxYear, key, fallback = null) {
  const r = db.get('SELECT value FROM tax_inputs WHERE tax_year = ? AND key = ?', taxYear, key);
  return r ? JSON.parse(r.value) : fallback;
}
export function setTaxInput(db, taxYear, key, value) {
  db.run(
    'INSERT INTO tax_inputs (tax_year, key, value) VALUES (?, ?, ?) ON CONFLICT(tax_year, key) DO UPDATE SET value = excluded.value',
    taxYear, key, JSON.stringify(value),
  );
}

export function audit(db, entity, entityId, action, detail) {
  db.run('INSERT INTO audit_log (entity, entity_id, action, detail) VALUES (?, ?, ?, ?)', entity, String(entityId ?? ''), action, detail ? JSON.stringify(detail) : null);
}
