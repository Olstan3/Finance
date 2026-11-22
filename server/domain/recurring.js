import { addDays, addMonths, parseISO, today, isISO } from '../util/dates.js';
import { ValidationError, createInvoice, getInvoice, setInvoiceStatus } from './invoices.js';
import { audit } from '../db.js';

export const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The date of the occurrence after `date`. `anchorDay` keeps month-end schedules from drifting. */
export function advance(date, frequency, interval = 1, anchorDay) {
  const n = Math.max(1, Math.floor(interval) || 1);
  switch (frequency) {
    case 'weekly': return addDays(date, 7 * n);
    case 'monthly': return addMonths(date, n, anchorDay);
    case 'quarterly': return addMonths(date, 3 * n, anchorDay);
    case 'yearly': return addMonths(date, 12 * n, anchorDay);
    default: throw new ValidationError(`Unknown frequency ${frequency}`);
  }
}

/** Replace {month}, {year}, {date}, {quarter}, {prevMonth} placeholders with values for `date`. */
export function renderPlaceholders(text, date) {
  const d = parseISO(date);
  const m = d.getUTCMonth();
  return String(text).replace(/\{(month|year|date|quarter|prevMonth|nextMonth)\}/g, (_, k) => {
    switch (k) {
      case 'month': return MONTH_NAMES[m];
      case 'prevMonth': return MONTH_NAMES[(m + 11) % 12];
      case 'nextMonth': return MONTH_NAMES[(m + 1) % 12];
      case 'year': return String(d.getUTCFullYear());
      case 'quarter': return `Q${Math.floor(m / 3) + 1}`;
      case 'date': return date;
      default: return _;
    }
  });
}

function validate(data) {
  if (!String(data.name || '').trim()) throw new ValidationError('Give the recurring invoice a name', 'name');
  if (!FREQUENCIES.includes(data.frequency)) throw new ValidationError('Choose a frequency', 'frequency');
  if (!isISO(data.start_date)) throw new ValidationError('Start date must be a valid date', 'start_date');
  if (data.end_date && !isISO(data.end_date)) throw new ValidationError('End date must be a valid date', 'end_date');
  if (data.end_date && data.end_date < data.start_date) throw new ValidationError('End date cannot be before the start date', 'end_date');
  if (!data.contact_id) throw new ValidationError('Choose a customer', 'contact_id');
  if (!Array.isArray(data.lines) || !data.lines.length) throw new ValidationError('Add at least one line item', 'lines');
  if (!['draft', 'issue', 'issue_email'].includes(data.mode || 'draft')) throw new ValidationError('Bad mode', 'mode');
}

export function hydrateTemplate(row) {
  return row ? { ...row, lines: JSON.parse(row.lines || '[]'), active: !!row.active } : null;
}

export function listTemplates(db) {
  return db.all('SELECT t.*, c.name AS contact_name FROM recurring_templates t LEFT JOIN contacts c ON c.id = t.contact_id ORDER BY t.active DESC, t.next_date').map(hydrateTemplate);
}
export const getTemplate = (db, id) => hydrateTemplate(db.get('SELECT t.*, c.name AS contact_name FROM recurring_templates t LEFT JOIN contacts c ON c.id = t.contact_id WHERE t.id = ?', id));

export function createTemplate(db, data) {
  validate(data);
  const anchor = parseISO(data.start_date).getUTCDate();
  const r = db.run(
    `INSERT INTO recurring_templates (name, contact_id, frequency, interval_count, start_date, end_date, next_date, max_runs, due_days, mode, category_id, lines, notes, reference, active, anchor_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    data.name.trim(), data.contact_id, data.frequency, Math.max(1, Number(data.interval_count) || 1), data.start_date, data.end_date || null,
    data.start_date, data.max_runs || null, data.due_days ?? 30, data.mode || 'draft', data.category_id || 'se_turnover',
    JSON.stringify(data.lines), data.notes || null, data.reference || null, data.active === false ? 0 : 1, anchor,
  );
  audit(db, 'recurring', r.id, 'create');
  return getTemplate(db, r.id);
}

export function updateTemplate(db, id, data) {
  const cur = getTemplate(db, id);
  if (!cur) { const e = new Error('Recurring invoice not found'); e.status = 404; throw e; }
  const m = { ...cur, ...data };
  validate(m);
  // Changing the start date of a template that has not run yet re-bases its schedule.
  const next = cur.runs === 0 && data.start_date ? data.start_date : (data.next_date || cur.next_date);
  const anchor = parseISO(next).getUTCDate();
  db.run(
    `UPDATE recurring_templates SET name = ?, contact_id = ?, frequency = ?, interval_count = ?, start_date = ?, end_date = ?, next_date = ?,
       max_runs = ?, due_days = ?, mode = ?, category_id = ?, lines = ?, notes = ?, reference = ?, active = ?, anchor_day = ? WHERE id = ?`,
    m.name.trim(), m.contact_id, m.frequency, Math.max(1, Number(m.interval_count) || 1), m.start_date, m.end_date || null, next,
    m.max_runs || null, m.due_days ?? 30, m.mode || 'draft', m.category_id || 'se_turnover', JSON.stringify(m.lines),
    m.notes || null, m.reference || null, m.active ? 1 : 0, anchor, id,
  );
  return getTemplate(db, id);
}

export function deleteTemplate(db, id) {
  db.run('UPDATE invoices SET recurring_id = NULL WHERE recurring_id = ?', id);
  db.run('DELETE FROM recurring_templates WHERE id = ?', id);
}

/** The next `count` scheduled issue dates (respecting end date / max runs). */
export function previewDates(t, count = 6) {
  const out = [];
  let d = t.next_date;
  let runs = t.runs;
  while (out.length < count) {
    if (t.end_date && d > t.end_date) break;
    if (t.max_runs && runs >= t.max_runs) break;
    out.push(d);
    runs++;
    d = advance(d, t.frequency, t.interval_count, t.anchor_day);
  }
  return out;
}

function generateOne(db, t, issueDate) {
  const lines = t.lines.map((l) => ({ ...l, description: renderPlaceholders(l.description, issueDate), unit_price: Math.round(l.unit_price) }));
  const due = addDays(issueDate, t.due_days ?? 30);
  const inv = createInvoice(db, {
    contact_id: t.contact_id, issue_date: issueDate, due_date: due, status: 'draft',
    reference: t.reference ? renderPlaceholders(t.reference, issueDate) : null,
    notes: t.notes ? renderPlaceholders(t.notes, issueDate) : undefined,
    category_id: t.category_id, recurring_id: t.id, lines,
  });
  if (t.mode === 'issue' || t.mode === 'issue_email') return setInvoiceStatus(db, inv.id, 'sent');
  return getInvoice(db, inv.id);
}

/**
 * Generate every invoice that is due on or before `asOf`, for one template or all of them.
 * Missed periods are caught up (one invoice per missed date). Safe to call repeatedly: the
 * schedule pointer advances in the same transaction as the invoice is created.
 */
export function runDue(db, { asOf = today(), templateId, force = false } = {}) {
  const templates = templateId ? [getTemplate(db, templateId)].filter(Boolean) : listTemplates(db).filter((t) => t.active);
  const created = [];
  for (const t0 of templates) {
    let t = t0;
    let guard = 0;
    while (guard++ < 120) {
      const exhausted = (t.max_runs && t.runs >= t.max_runs) || (t.end_date && t.next_date > t.end_date);
      if (exhausted) { if (t.active) db.run('UPDATE recurring_templates SET active = 0 WHERE id = ?', t.id); break; }
      const due = t.next_date <= asOf || (force && guard === 1);
      if (!due) break;
      const issueDate = force && t.next_date > asOf ? asOf : t.next_date;
      const inv = db.tx(() => {
        const made = generateOne(db, t, issueDate);
        const next = advance(t.next_date, t.frequency, t.interval_count, t.anchor_day);
        db.run('UPDATE recurring_templates SET next_date = ?, runs = runs + 1, last_run = ? WHERE id = ?', next, issueDate, t.id);
        return made;
      });
      created.push({ templateId: t.id, templateName: t.name, invoice: inv, emailPending: t.mode === 'issue_email' });
      t = getTemplate(db, t.id);
    }
  }
  return created;
}
