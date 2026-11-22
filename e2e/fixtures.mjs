// Builds the sample files the browser test uploads: a bank-statement PDF with positioned columns,
// a supplier invoice PDF, a Monzo-style CSV and a photographed-receipt PNG.
import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';

const pdf = (file, draw) => new Promise((res) => {
  const d = new PDFDocument({ size: 'A4', margin: 40 }); const c = [];
  d.on('data', (x) => c.push(x)); d.on('end', () => { fs.writeFileSync(file, Buffer.concat(c)); res(); });
  draw(d); d.end();
});
const at = (d, x, y, s, o = {}) => d.fontSize(9).text(s, x, y, { lineBreak: false, ...o });

export async function makeFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  await pdf(path.join(dir, 'april-statement.pdf'), (d) => {
    d.fontSize(14).text('ACME BANK – Business Current Account', 40, 40);
    at(d, 40, 62, 'Statement period 1 April 2025 to 30 April 2025   Sort code 20-45-67  Account 12345678');
    const y0 = 100;
    at(d, 40, y0, 'Date'); at(d, 110, y0, 'Description'); at(d, 330, y0, 'Paid out', { width: 60, align: 'right' }); at(d, 400, y0, 'Paid in', { width: 60, align: 'right' }); at(d, 470, y0, 'Balance', { width: 60, align: 'right' });
    [['01 Apr', 'Balance brought forward', '', '', '1,000.00'], ['03 Apr', 'CARD PAYMENT SCREWFIX', '120.00', '', '880.00'], ['07 Apr', 'FASTER PAYMENT BRIGHT CO LTD', '', '1,500.00', '2,380.00'],
      ['09 Apr', 'DIRECT DEBIT ADOBE SYSTEMS', '54.99', '', '2,325.01'], ['14 Apr', 'SHELL SERVICE STATION', '62.40', '', '2,262.61'], ['22 Apr', 'PAYMENT RECEIVED HARBOUR STUDIO', '', '2,000.00', '4,262.61']].forEach((r, i) => {
      const y = y0 + 20 + i * 16; at(d, 40, y, r[0]); at(d, 110, y, r[1]);
      if (r[2]) at(d, 330, y, r[2], { width: 60, align: 'right' }); if (r[3]) at(d, 400, y, r[3], { width: 60, align: 'right' }); at(d, 470, y, r[4], { width: 60, align: 'right' });
    });
  });
  await pdf(path.join(dir, 'supplier-invoice.pdf'), (d) => {
    at(d, 40, 40, 'Northern Paper Supplies Ltd'); at(d, 40, 54, 'VAT Reg: GB 123 4567 89');
    at(d, 400, 40, 'TAX INVOICE'); at(d, 400, 54, 'Invoice number: NP-20931'); at(d, 400, 68, 'Invoice date: 14 March 2025'); at(d, 400, 82, 'Payment due: 13 April 2025');
    at(d, 40, 120, 'Bill to:'); at(d, 40, 134, 'ST Design');
    at(d, 40, 180, 'A3 Card stock'); at(d, 400, 180, '180.00'); at(d, 40, 196, 'Delivery'); at(d, 400, 196, '20.00');
    at(d, 300, 240, 'Subtotal'); at(d, 400, 240, '200.00'); at(d, 300, 256, 'VAT @ 20%'); at(d, 400, 256, '40.00'); at(d, 300, 272, 'Total due'); at(d, 400, 272, '240.00');
  });
  fs.writeFileSync(path.join(dir, 'monzo.csv'), `Date,Time,Type,Name,Category,Amount,Currency,Notes and #tags,Description
03/05/2025,10:01:02,Card payment,Trainline,Transport,-34.20,GBP,,TRAINLINE LONDON
05/05/2025,11:00:00,Faster payment,Mrs Patel,Income,850.00,GBP,,RENT MAY
09/05/2025,09:12:00,Card payment,Mystery Cafe,Eating out,-7.80,GBP,,UNKNOWN PLACE
12/05/2025,14:20:00,Card payment,Staples,Shopping,-23.99,GBP,,STAPLES STATIONERY
`);
  fs.writeFileSync(path.join(dir, 'receipt.html'), `<html><body style="font-family:'Courier New',monospace;font-size:26px;padding:30px;width:620px;background:#fff;color:#000"><div style="text-align:center"><b>SCREWFIX DIRECT</b><br>Receipt<br>Date 21/06/2025 14:32</div><br>Cordless drill &nbsp;&nbsp;&nbsp; 89.99<br>Drill bits &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; 9.00<br>Subtotal &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; 98.99<br>VAT 20% &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; 19.80<br><b>TOTAL &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; 118.79</b><br>VISA contactless</body></html>`);
}
