// PDF output: customer invoices and tax/VAT worksheets. Pure pdfkit, no browser needed.

import PDFDocument from 'pdfkit';
import { fmtGBP } from '../util/money.js';
import { fmtDate } from '../util/dates.js';
import { VAT_RATES } from '../domain/taxRates.js';

const collect = (doc) => new Promise((resolve, reject) => {
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);
});

const INK = '#1b2330', MUTED = '#5b6675', LINE = '#d9dee6', ACCENT = '#0f5c4d';

export async function invoicePdf(inv, settings) {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `${inv.kind === 'credit_note' ? 'Credit note' : 'Invoice'} ${inv.number}` } });
  const done = collect(doc);
  const p = settings.profile;
  const biz = p.tradingName || p.name || 'Your business';
  const W = doc.page.width - 96;
  const isCredit = inv.kind === 'credit_note';

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(20).text(biz, 48, 48, { width: W * 0.55 });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  const addr = [p.name && p.tradingName ? p.name : '', ...String(p.address || '').split('\n'), p.postcode, p.email, p.phone].filter(Boolean).join('\n');
  if (addr) doc.text(addr, { width: W * 0.55 });
  if (settings.vat.registered && settings.vat.number) doc.text(`VAT no. ${settings.vat.number}`);

  doc.font('Helvetica-Bold').fontSize(22).fillColor(ACCENT).text(isCredit ? 'CREDIT NOTE' : 'INVOICE', 48, 48, { width: W, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor(INK);
  const meta = [['Number', inv.number], ['Issue date', fmtDate(inv.issue_date)]];
  if (inv.due_date && !isCredit) meta.push(['Due date', fmtDate(inv.due_date)]);
  if (inv.reference) meta.push(['Reference', inv.reference]);
  let y = 78;
  for (const [k, v] of meta) {
    doc.fillColor(MUTED).text(k, 330, y, { width: 90 }).fillColor(INK).text(String(v), 420, y, { width: W - 372, align: 'right' });
    y += 15;
  }

  // Bill to
  let by = Math.max(doc.y, 150) + 8;
  doc.fillColor(MUTED).fontSize(8).text(isCredit ? 'CREDIT TO' : 'BILL TO', 48, by);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(inv.contact_name || '—', 48, by + 12);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  const c = inv.contact;
  const caddr = [c?.address, c?.email, c?.vat_number ? `VAT no. ${c.vat_number}` : ''].filter(Boolean).join('\n');
  if (caddr) doc.text(caddr, 48, doc.y, { width: 260 });

  // Lines table
  let ty = Math.max(doc.y, by + 50) + 22;
  const cols = { desc: 48, qty: 48 + W * 0.52, price: 48 + W * 0.62, vat: 48 + W * 0.77, amt: 48 + W * 0.85 };
  const header = () => {
    doc.rect(48, ty - 4, W, 20).fill('#f1f4f8');
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8);
    doc.text('DESCRIPTION', cols.desc + 6, ty + 2).text('QTY', cols.qty, ty + 2, { width: 40, align: 'right' }).text('UNIT PRICE', cols.price, ty + 2, { width: 55, align: 'right' })
      .text('VAT', cols.vat, ty + 2, { width: 40, align: 'right' }).text('AMOUNT', cols.amt, ty + 2, { width: W - (cols.amt - 48) - 4, align: 'right' });
    ty += 26;
  };
  header();
  const sign = inv.totals.sign;
  doc.font('Helvetica').fontSize(9.5).fillColor(INK);
  for (const l of inv.lines) {
    const net = Math.round(l.quantity * l.unit_price) * sign;
    const h = doc.heightOfString(l.description, { width: cols.qty - cols.desc - 16 });
    if (ty + h + 12 > doc.page.height - 200) { doc.addPage(); ty = 56; header(); doc.font('Helvetica').fontSize(9.5).fillColor(INK); }
    doc.text(l.description, cols.desc + 6, ty, { width: cols.qty - cols.desc - 16 });
    doc.text(String(Number(l.quantity)), cols.qty, ty, { width: 40, align: 'right' }).text(fmtGBP(l.unit_price), cols.price, ty, { width: 55, align: 'right' })
      .text(VAT_RATES[l.vat_code]?.rate ? `${VAT_RATES[l.vat_code].rate * 100}%` : l.vat_code === 'Z' ? '0%' : '–', cols.vat, ty, { width: 40, align: 'right' })
      .text(fmtGBP(net), cols.amt, ty, { width: W - (cols.amt - 48) - 4, align: 'right' });
    ty += Math.max(h, 12) + 8;
    doc.moveTo(48, ty - 4).lineTo(48 + W, ty - 4).strokeColor(LINE).lineWidth(0.5).stroke();
  }

  // Totals
  if (ty > doc.page.height - 220) { doc.addPage(); ty = 56; }
  ty += 6;
  const tx = 48 + W * 0.55, tw = W * 0.45;
  const row = (label, value, bold = false, color = INK) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 10).fillColor(color).text(label, tx, ty, { width: tw * 0.55 }).text(value, tx + tw * 0.45, ty, { width: tw * 0.55, align: 'right' });
    ty += bold ? 20 : 16;
  };
  row('Subtotal', fmtGBP(inv.totals.net));
  if (settings.vat.registered || inv.totals.vat) row('VAT', fmtGBP(inv.totals.vat));
  doc.moveTo(tx, ty - 2).lineTo(tx + tw, ty - 2).strokeColor(INK).lineWidth(0.8).stroke(); ty += 4;
  row(isCredit ? 'Total credit' : 'Total', fmtGBP(inv.totals.gross), true);
  if (inv.paid) row(isCredit ? 'Refunded' : 'Paid', fmtGBP(inv.paid), false, MUTED);
  if (!isCredit) row('Balance due', fmtGBP(inv.outstanding), true, inv.outstanding > 0 ? ACCENT : MUTED);

  // Payment details, notes
  ty += 14;
  const block = (title, text) => {
    if (!text) return;
    if (ty > doc.page.height - 120) { doc.addPage(); ty = 56; }
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(title, 48, ty);
    doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(text, 48, ty + 12, { width: W * 0.6 });
    ty = doc.y + 12;
  };
  if (!isCredit) block('PAYMENT DETAILS', settings.invoice.bankDetails);
  block('NOTES', inv.notes);
  block('TERMS', inv.terms);
  if (settings.invoice.footer) doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(settings.invoice.footer, 48, doc.page.height - 70, { width: W, align: 'center' });

  if (inv.derived_status === 'paid' && !isCredit) {
    doc.save().rotate(-14, { origin: [440, 190] }).font('Helvetica-Bold').fontSize(46).fillColor('#0f5c4d').opacity(0.16).text('PAID', 380, 168, { lineBreak: false }).restore();
  }
  doc.end();
  return done;
}

const fmtVal = (r) => {
  if (r.type === 'money') return r.value == null ? '' : fmtGBP(r.value);
  if (r.type === 'yesno') return r.value ? 'Yes' : 'No';
  return r.value == null ? '' : String(r.value);
};

/**
 * Generic worksheet: { title, subtitle, notes[], sections:[{title, intro, rows:[{box,label,value,type,emphasis,inferred}]}] }
 */
export async function worksheetPdf({ title, subtitle, warnings = [], forms, footer }) {
  const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: { Title: title } });
  const done = collect(doc);
  const W = doc.page.width - 96;
  const ensure = (h) => { if (doc.y + h > doc.page.height - 72) doc.addPage(); };

  doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(title, 48, 48);
  if (subtitle) doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(subtitle);
  doc.moveDown(0.5);
  if (warnings.length) {
    const txt = warnings.map((w) => `${w.level === 'error' ? '✖' : w.level === 'warn' ? '▲' : '•'} ${w.text}`).join('\n');
    const h = doc.heightOfString(txt, { width: W - 20, lineGap: 2 }) + 16;
    ensure(h);
    const y0 = doc.y;
    doc.rect(48, y0, W, h).fill('#fff7e6');
    doc.fillColor('#6b4a00').font('Helvetica').fontSize(8.5).text(txt.replace(/[✖▲•]/g, (c) => ({ '✖': 'x', '▲': '!', '•': '-' }[c])), 58, y0 + 8, { width: W - 20, lineGap: 2 });
    doc.y = y0 + h + 6;
  }

  forms.filter((f) => f.applies !== false).forEach((form, fi) => {
    if (fi > 0 || doc.y > 200) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(15).fillColor(ACCENT).text(form.title, 48, doc.y + 4);
    if (form.intro) doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(form.intro, { width: W });
    doc.moveDown(0.4);
    for (const page of form.pages) {
      if (!page.rows.length && !page.title) continue;
      ensure(46);
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text(page.title, 48, doc.y + 6);
      doc.moveTo(48, doc.y + 2).lineTo(48 + W, doc.y + 2).strokeColor(INK).lineWidth(0.8).stroke();
      doc.y += 6;
      for (const r of page.rows) {
        const val = fmtVal(r);
        const VALW = 210; // value column width – used both to measure and to draw, so wrapped values never overrun the divider
        const labelW = W - 70 - VALW - 8;
        doc.font(r.emphasis ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
        const h = Math.max(doc.heightOfString(r.label, { width: labelW }), doc.heightOfString(val, { width: VALW })) + 7;
        ensure(h + 4);
        const y = doc.y;
        if (r.emphasis) doc.rect(48, y - 2, W, h).fill('#eef5f3');
        doc.font(r.emphasis ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(MUTED);
        doc.text(r.box ? `Box ${r.box}${r.inferred ? '†' : ''}` : '', 52, y, { width: 62 });
        doc.fillColor(INK).text(r.label, 118, y, { width: labelW });
        doc.text(val, 48 + W - VALW - 4, y, { width: VALW, align: 'right' });
        doc.y = y + h;
        doc.moveTo(48, doc.y - 3).lineTo(48 + W, doc.y - 3).strokeColor(LINE).lineWidth(0.4).stroke();
      }
    }
  });

  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // text below the margin would otherwise trigger an automatic new page
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(
      footer || 'Prepared by Ledgerline from your records. This is a worksheet, not an HMRC form – enter these figures in HMRC\'s online service or approved software and check them before filing. † box number inferred from the form layout.',
      48, doc.page.height - 56, { width: W - 60, lineBreak: true },
    );
    doc.text(`Page ${i + 1} of ${range.count}`, 48 + W - 60, doc.page.height - 56, { width: 60, align: 'right' });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}
