import nodemailer from 'nodemailer';
import { getSettings } from './db.js';
import { getInvoice } from './domain/invoices.js';
import { invoicePdf } from './pdf/documents.js';

/** SMTP is configured with the SMTP_URL environment variable (e.g. smtps://user:pass@smtp.example.com). Nothing is stored in the database. */
export function getTransport() {
  const url = process.env.SMTP_URL;
  if (!url) return null;
  if (url === 'json') return nodemailer.createTransport({ jsonTransport: true }); // for tests
  return nodemailer.createTransport(url);
}

export const mailConfigured = () => !!process.env.SMTP_URL;

export async function emailInvoice(db, id, { to, subject, message } = {}) {
  const transport = getTransport();
  if (!transport) { const e = new Error('Email is not set up. Set the SMTP_URL environment variable (see README), or download the PDF and send it yourself.'); e.status = 400; throw e; }
  const inv = getInvoice(db, id);
  if (!inv) { const e = new Error('Invoice not found'); e.status = 404; throw e; }
  const settings = getSettings(db);
  const recipient = to || inv.contact?.email;
  if (!recipient || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient)) { const e = new Error('Add a valid email address for this customer first.'); e.status = 400; throw e; }
  const biz = settings.entityType === 'company' ? (settings.company.name || 'Ledgerline') : (settings.profile.tradingName || settings.profile.name || 'Ledgerline');
  const pdf = await invoicePdf(inv, settings);
  const label = inv.kind === 'credit_note' ? 'Credit note' : 'Invoice';
  const info = await transport.sendMail({
    from: settings.profile.email ? `"${biz.replace(/"/g, '')}" <${settings.profile.email}>` : undefined,
    to: recipient,
    subject: subject || `${label} ${inv.number} from ${biz}`,
    text: message || `Hello${inv.contact_name ? ' ' + inv.contact_name : ''},\n\nPlease find ${label.toLowerCase()} ${inv.number} attached${inv.due_date && inv.kind === 'invoice' ? `, due ${inv.due_date}` : ''}.\n\n${settings.invoice.bankDetails ? 'Payment details:\n' + settings.invoice.bankDetails + '\n\n' : ''}Kind regards,\n${biz}`,
    attachments: [{ filename: `${inv.number}.pdf`, content: pdf, contentType: 'application/pdf' }],
  });
  return { messageId: info.messageId, to: recipient };
}
