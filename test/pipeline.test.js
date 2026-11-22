import { test } from 'node:test';
import assert from 'node:assert/strict';
import PDFDocument from 'pdfkit';
import { freshDb, addContact, gbp } from './helpers.js';
import { parseUpload } from '../server/importers/index.js';
import { stageBatch, commitBatch, undoBatch, saveDocument, buildHints } from '../server/domain/importService.js';
import { createInvoice, setInvoiceStatus, getInvoice } from '../server/domain/invoices.js';
import { getSettings, saveSettings } from '../server/db.js';

const buf = (s) => Buffer.from(s, 'utf8');

function pdfOf(draw) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    draw(doc);
    doc.end();
  });
}
const at = (doc, x, y, s, opts = {}) => doc.fontSize(9).text(s, x, y, { lineBreak: false, ...opts });

async function statementPdf() {
  return pdfOf((doc) => {
    doc.fontSize(14).text('ACME BANK – Business Current Account', 40, 40);
    at(doc, 40, 62, 'Statement period 1 April 2025 to 30 April 2025   Sort code 20-45-67  Account 12345678');
    const y0 = 100;
    at(doc, 40, y0, 'Date'); at(doc, 110, y0, 'Description'); at(doc, 330, y0, 'Paid out', { width: 60, align: 'right' }); at(doc, 400, y0, 'Paid in', { width: 60, align: 'right' }); at(doc, 470, y0, 'Balance', { width: 60, align: 'right' });
    const rows = [
      ['01 Apr', 'Balance brought forward', '', '', '1,000.00'],
      ['03 Apr', 'CARD PAYMENT SCREWFIX', '120.00', '', '880.00'],
      ['07 Apr', 'FASTER PAYMENT J SMITH INV-0001', '', '500.00', '1,380.00'],
      ['09 Apr', 'DIRECT DEBIT ADOBE', '19.99', '', '1,360.01'],
    ];
    rows.forEach((r, i) => {
      const y = y0 + 20 + i * 16;
      at(doc, 40, y, r[0]); at(doc, 110, y, r[1]);
      if (r[2]) at(doc, 330, y, r[2], { width: 60, align: 'right' });
      if (r[3]) at(doc, 400, y, r[3], { width: 60, align: 'right' });
      at(doc, 470, y, r[4], { width: 60, align: 'right' });
    });
  });
}

async function invoicePdf() {
  return pdfOf((doc) => {
    at(doc, 40, 40, 'Northern Paper Supplies Ltd');
    at(doc, 40, 54, 'VAT Reg: GB 123 4567 89');
    at(doc, 400, 40, 'TAX INVOICE');
    at(doc, 400, 54, 'Invoice number: NP-20931');
    at(doc, 400, 68, 'Invoice date: 14 March 2025');
    at(doc, 400, 82, 'Payment due: 13 April 2025');
    at(doc, 40, 120, 'Bill to:'); at(doc, 40, 134, 'ST Design');
    at(doc, 40, 180, 'A3 Card stock'); at(doc, 400, 180, '180.00');
    at(doc, 40, 196, 'Delivery'); at(doc, 400, 196, '20.00');
    at(doc, 300, 240, 'Subtotal'); at(doc, 400, 240, '200.00');
    at(doc, 300, 256, 'VAT @ 20%'); at(doc, 400, 256, '40.00');
    at(doc, 300, 272, 'Total due'); at(doc, 400, 272, '240.00');
  });
}

test('PDF bank statement with positioned columns: direction from columns, categories suggested', async () => {
  const parsed = await parseUpload({ filename: 'april.pdf', buffer: await statementPdf() }, {});
  assert.equal(parsed.kind, 'pdf');
  assert.equal(parsed.mode, 'statement');
  assert.deepEqual(parsed.items.map((i) => i.amount), [-gbp(120), gbp(500), -gbp(19.99)]);
  assert.deepEqual(parsed.items.map((i) => i.date), ['2025-04-03', '2025-04-07', '2025-04-09']);
  assert.ok(parsed.items.every((i) => !i.flags.includes('direction_guessed')));
});

test('PDF supplier invoice: fields found in different places on the page', async () => {
  const parsed = await parseUpload({ filename: 'inv.pdf', buffer: await invoicePdf() }, { profile: { tradingName: 'ST Design' } });
  assert.equal(parsed.mode, 'document');
  const d = parsed.items[0];
  assert.equal(d.amount, -gbp(240));
  assert.equal(d.vat, gbp(40));
  assert.equal(d.net, gbp(200));
  assert.equal(d.date, '2025-03-14');
  assert.equal(d.dueDate, '2025-04-13');
  assert.equal(d.reference, 'NP-20931');
  assert.match(d.counterparty, /Northern Paper/);
  assert.equal(d.direction, 'out');
});

test('a scanned (text-less) PDF explains what to do instead of failing silently', async () => {
  const blank = await pdfOf(() => {});
  const parsed = await parseUpload({ filename: 'scan.pdf', buffer: blank }, {});
  assert.equal(parsed.mode, 'scanned');
  assert.match(parsed.warnings[0], /OCR|photo|paste/i);
});

test('CSV: Monzo-style, bank-style with preamble, and semicolon/European delimiters', async () => {
  const monzo = `Transaction ID,Date,Time,Type,Name,Emoji,Category,Amount,Currency,Local amount,Local currency,Notes and #tags,Address,Description
tx_1,03/04/2025,10:01:02,Card payment,Screwfix,,General,-120.00,GBP,-120.00,GBP,,,SCREWFIX 123
tx_2,07/04/2025,11:00:00,Faster payment,J Smith,,Income,500.00,GBP,500.00,GBP,,,INV-0001`;
  const m = await parseUpload({ filename: 'monzo.csv', buffer: buf(monzo) }, {});
  assert.deepEqual(m.items.map((i) => i.amount), [-gbp(120), gbp(500)]);
  assert.match(m.items[0].description, /Screwfix/);

  const pre = `Account: Business
Exported 01/05/2025

Date,Description,Debit,Credit,Balance
03/04/2025,CARD SCREWFIX,120.00,,880.00
07/04/2025,J SMITH,,500.00,1380.00
`;
  const b = await parseUpload({ filename: 'x.csv', buffer: buf(pre) }, {});
  assert.deepEqual(b.items.map((i) => i.amount), [-gbp(120), gbp(500)]);
  assert.deepEqual(b.items.map((i) => i.date), ['2025-04-03', '2025-04-07']);

  const semi = `Datum;Beschreibung;Betrag\n13/04/2025;Cafe;-3.50\n14/04/2025;Client;250.00`;
  const s = await parseUpload({ filename: 's.csv', buffer: buf(semi) }, {});
  assert.deepEqual(s.items.map((i) => i.amount), [-350, 25000]);
});

test('CSV with all-positive amounts and a balance column infers direction from the balance', async () => {
  const csv = `Date,Details,Amount,Balance\n01/04/2025,Open,0.01,1000.00\n02/04/2025,Shop,50.00,950.01\n03/04/2025,Client,200.00,1150.01`;
  const r = await parseUpload({ filename: 'a.csv', buffer: buf(csv) }, {});
  assert.deepEqual(r.items.map((i) => i.amount).slice(1), [-5000, 20000]);
});

test('OFX and QIF', async () => {
  const ofx = `OFXHEADER:100\nDATA:OFXSGML\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>GBP<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20250403120000<TRNAMT>-120.00<FITID>A1<NAME>SCREWFIX<MEMO>CARD</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20250407<TRNAMT>500.00<FITID>A2<NAME>J SMITH</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const o = await parseUpload({ filename: 'x.ofx', buffer: buf(ofx) }, {});
  assert.deepEqual(o.items.map((i) => [i.date, i.amount]), [['2025-04-03', -12000], ['2025-04-07', 50000]]);
  const qif = `!Type:Bank\nD03/04/2025\nT-120.00\nPScrewfix\n^\nD07/04/2025\nT500.00\nPJ Smith\nMinvoice\n^`;
  const q = await parseUpload({ filename: 'x.qif', buffer: buf(qif) }, {});
  assert.deepEqual(q.items.map((i) => i.amount), [-12000, 50000]);
});

test('e-mailed receipt (.eml with quoted-printable HTML) is read like any document', async () => {
  const eml = `From: receipts@trainline.com
Subject: Your booking receipt
Date: Tue, 3 Jun 2025 10:22:11 +0100
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: quoted-printable

<html><body><h1>Trainline Receipt</h1><table><tr><td>London to Leeds</td><td>=C2=A361.50</td></tr>
<tr><td>Total paid</td><td>=C2=A361.50</td></tr></table></body></html>`;
  const r = await parseUpload({ filename: 'receipt.eml', buffer: buf(eml) }, {});
  assert.equal(r.items[0].amount, -gbp(61.5));
  assert.equal(r.items[0].date, '2025-06-03');
});

// ----------- staging + committing

test('staging categorises, flags low-confidence rows, and commit records them', async () => {
  const db = freshDb();
  const csv = `Date,Description,Amount\n03/04/2025,SHELL FUEL,-45.00\n07/04/2025,ADOBE SYSTEMS,-19.99\n09/04/2025,MYSTERY PAYEE 123,-12.00\n11/04/2025,STRIPE PAYOUT,800.00`;
  const parsed = await parseUpload({ filename: 'b.csv', buffer: buf(csv) }, {});
  const doc = saveDocument(db, { filename: 'b.csv', buffer: buf(csv), kind: 'csv' });
  const batch = stageBatch(db, parsed, { filename: 'b.csv', accountId: 1, documentId: doc.id, settings: getSettings(db) });
  assert.equal(batch.items.length, 4);
  const byDesc = Object.fromEntries(batch.items.map((i) => [i.description, i]));
  assert.equal(byDesc['SHELL FUEL'].category_id, 'se_travel');
  assert.equal(byDesc['ADOBE SYSTEMS'].category_id, 'se_admin');
  assert.equal(byDesc['STRIPE PAYOUT'].category_id, 'se_turnover');
  assert.equal(byDesc['MYSTERY PAYEE 123'].category_id, null);
  assert.equal(byDesc['MYSTERY PAYEE 123'].needs_review, true);
  assert.equal(batch.summary.needsReview, 1);
  const res = commitBatch(db, batch.id);
  assert.equal(res.created, 4);
  assert.equal(res.needsReview, 1);
  const rows = db.all('SELECT description, status, category_id FROM transactions ORDER BY date');
  assert.equal(rows.find((r) => r.description === 'SHELL FUEL').status, 'confirmed');
  assert.equal(rows.find((r) => r.description === 'MYSTERY PAYEE 123').status, 'review');
  assert.throws(() => commitBatch(db, batch.id), /already been recorded/);
});

test('importing the same statement twice records nothing the second time; undo removes a batch', async () => {
  const db = freshDb();
  const csv = `Date,Description,Amount\n03/04/2025,SHELL FUEL,-45.00\n03/04/2025,COFFEE,-3.50\n03/04/2025,COFFEE,-3.50`;
  const run = async () => {
    const parsed = await parseUpload({ filename: 'b.csv', buffer: buf(csv) }, {});
    const b = stageBatch(db, parsed, { filename: 'b.csv', accountId: 1, settings: getSettings(db) });
    return { b, res: commitBatch(db, b.id) };
  };
  const first = await run();
  assert.equal(first.res.created, 3, 'two identical coffees on one day are both real');
  const second = await run();
  assert.equal(second.b.summary.duplicates, 3);
  assert.equal(second.res.created, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM transactions').n, 3);
  const undo = undoBatch(db, first.b.id);
  assert.equal(undo.removedTransactions, 3);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM transactions').n, 0);
});

test('learned categories: correcting a merchant once teaches future imports', async () => {
  const db = freshDb();
  db.run("INSERT INTO transactions (account_id, date, description, amount, category_id, status, source) VALUES (1, '2025-01-01', 'JOES CAFE LEEDS', -800, 'se_other', 'confirmed', 'manual')");
  db.run("INSERT INTO transactions (account_id, date, description, amount, category_id, status, source) VALUES (1, '2025-02-01', 'JOES CAFE LEEDS', -900, 'se_other', 'confirmed', 'manual')");
  const parsed = await parseUpload({ filename: 'c.csv', buffer: buf('Date,Description,Amount\n05/04/2025,CARD PAYMENT JOES CAFE,-9.00') }, {});
  const b = stageBatch(db, parsed, { filename: 'c.csv', accountId: 1, settings: getSettings(db) });
  assert.equal(b.items[0].category_id, 'se_other');
  assert.equal(b.items[0].category_source, 'learned');
});

test('user rules beat built-in guesses', async () => {
  const db = freshDb();
  db.run("INSERT INTO rules (pattern, match_type, direction, category_id, business_pct) VALUES ('screwfix', 'contains', 'out', 'prop_other', 100)");
  const parsed = await parseUpload({ filename: 'c.csv', buffer: buf('Date,Description,Amount\n05/04/2025,SCREWFIX DIRECT,-30.00') }, {});
  const b = stageBatch(db, parsed, { filename: 'c.csv', accountId: 1, settings: getSettings(db) });
  assert.equal(b.items[0].category_id, 'prop_other');
  assert.equal(b.items[0].category_source, 'rule');
});

test('incoming bank payment is auto-matched to an open invoice by number, and marks it paid', async () => {
  const db = freshDb();
  const c = addContact(db, 'J Smith');
  const inv = setInvoiceStatus(db, createInvoice(db, { contact_id: c, issue_date: '2025-03-20', lines: [{ description: 'Work', quantity: 1, unit_price: gbp(500), vat_code: 'N' }] }).id, 'sent');
  const parsed = await parseUpload({ filename: 'b.csv', buffer: buf(`Date,Description,Amount\n07/04/2025,FASTER PAYMENT J SMITH ${inv.number},500.00`) }, { hints: buildHints(db) });
  const b = stageBatch(db, parsed, { filename: 'b.csv', accountId: 1, settings: getSettings(db) });
  assert.equal(b.items[0].invoice_match.invoice_id, inv.id);
  const res = commitBatch(db, b.id);
  assert.equal(res.linkedToInvoices, 1);
  assert.equal(getInvoice(db, inv.id).derived_status, 'paid');
});

test('a receipt PDF merges with the matching bank line instead of double counting', async () => {
  const db = freshDb({ profile: { name: 'ST Design' } });
  // 1) bank statement line first
  const parsed1 = await parseUpload({ filename: 'b.csv', buffer: buf('Date,Description,Amount\n16/03/2025,NORTHERN PAPER SUPPLIES,-240.00') }, {});
  commitBatch(db, stageBatch(db, parsed1, { filename: 'b.csv', accountId: 1, settings: getSettings(db) }).id);
  // 2) then the supplier invoice document
  const pdf = await invoicePdf();
  const parsed2 = await parseUpload({ filename: 'inv.pdf', buffer: pdf }, { profile: { tradingName: 'ST Design' } });
  const doc = saveDocument(db, { filename: 'inv.pdf', buffer: pdf, kind: 'pdf' });
  saveSettings(db, { vat: { registered: true } });
  const b2 = stageBatch(db, parsed2, { filename: 'inv.pdf', documentId: doc.id, settings: getSettings(db) });
  assert.equal(b2.items[0].reconcile?.type, 'bank_txn');
  const res = commitBatch(db, b2.id);
  assert.equal(res.merged, 1);
  assert.equal(res.created, 0);
  const t = db.all('SELECT * FROM transactions');
  assert.equal(t.length, 1);
  assert.equal(t[0].document_id, doc.id);
  assert.equal(t[0].vat_amount, gbp(40), 'VAT evidence from the invoice is attached to the bank line');
});

test('your own sales-invoice document becomes an invoice record for the right customer', async () => {
  const db = freshDb({ profile: { name: 'Sam Trader', tradingName: 'ST Design' } });
  const text = `ST Design\nSam Trader\nINVOICE INV-0042\nDate: 02/05/2025\nDue date: 01/06/2025\nInvoice to:\nBright Co Ltd\nWebsite design 1,500.00\nVAT 20% 300.00\nTotal 1,800.00`;
  const parsed = await parseUpload({ filename: 'old-invoice.txt', buffer: buf(text) }, { profile: getSettings(db).profile });
  const b = stageBatch(db, parsed, { filename: 'old-invoice.txt', settings: getSettings(db) });
  assert.equal(b.items[0].target, 'invoice');
  commitBatch(db, b.id);
  const inv = db.get('SELECT * FROM invoices');
  assert.equal(inv.number, 'INV-0042');
  assert.equal(inv.status, 'sent');
  const full = getInvoice(db, inv.id);
  assert.equal(full.contact_name, 'Bright Co Ltd');
  assert.equal(full.totals.gross, gbp(1800));
  assert.equal(full.due_date, '2025-06-01');
});

test('transfers between two of your accounts are paired and ignored for profit', async () => {
  const db = freshDb();
  db.run("INSERT INTO accounts (name, kind) VALUES ('Savings', 'bank')");
  const run = async (acct, csv) => commitBatch(db, stageBatch(db, await parseUpload({ filename: 'x.csv', buffer: buf(csv) }, {}), { filename: 'x.csv', accountId: acct, settings: getSettings(db) }).id);
  await run(1, 'Date,Description,Debit,Credit\n10/04/2025,MOVE MONEY,1000.00,');
  await run(3, 'Date,Description,Debit,Credit\n11/04/2025,MOVE MONEY,,1000.00');
  const cats = db.all('SELECT category_id FROM transactions').map((r) => r.category_id);
  assert.deepEqual(cats, ['transfer', 'transfer']);
});

test('an all-positive single Amount column with no cues is guessed AND flagged for review (never silently trusted)', async () => {
  const r = await parseUpload({ filename: 'x.csv', buffer: buf('Date,Description,Amount\n10/04/2025,THING ONE,10.00\n11/04/2025,THING TWO,20.00') }, {});
  assert.ok(r.items.every((i) => i.flags.includes('direction_guessed')));
  assert.ok(r.warnings.some((w) => /positive/i.test(w)));
});

test('VAT-registered: money in carries estimated output VAT; money out claims none without a VAT invoice', async () => {
  const db = freshDb({ vat: { registered: true } });
  const parsed = await parseUpload({ filename: 'x.csv', buffer: buf('Date,Description,Amount\n10/04/2025,STRIPE PAYOUT,1200.00\n11/04/2025,SHELL FUEL,-60.00') }, {});
  const b = stageBatch(db, parsed, { filename: 'x.csv', accountId: 1, settings: getSettings(db) });
  const payout = b.items.find((i) => i.description === 'STRIPE PAYOUT');
  const fuel = b.items.find((i) => i.description === 'SHELL FUEL');
  assert.equal(payout.vat_amount, gbp(200));
  assert.equal(payout.vat_estimated, true);
  assert.equal(fuel.vat_amount, 0);
});
