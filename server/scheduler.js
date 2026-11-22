import { runDue } from './domain/recurring.js';
import { emailInvoice, mailConfigured } from './mail.js';
import { audit } from './db.js';

/** Generate any recurring invoices that have come due; email them if that template asks for it. */
export async function runScheduled(db, log = console) {
  const created = runDue(db);
  for (const c of created) {
    if (c.emailPending && mailConfigured()) {
      try { await emailInvoice(db, c.invoice.id); db.run("UPDATE invoices SET sent_at = datetime('now') WHERE id = ?", c.invoice.id); }
      catch (e) { audit(db, 'invoice', c.invoice.id, 'email_failed', { error: e.message }); log.warn?.(`Could not email ${c.invoice.number}: ${e.message}`); }
    }
  }
  if (created.length) log.info?.(`Recurring invoices: created ${created.length} (${created.map((c) => c.invoice.number).join(', ')})`);
  return created;
}

export function startScheduler(db, { intervalMs = 30 * 60 * 1000, log = console } = {}) {
  const tick = () => runScheduled(db, log).catch((e) => log.error?.('Scheduler error', e));
  tick();
  const h = setInterval(tick, intervalMs);
  h.unref();
  return () => clearInterval(h);
}
