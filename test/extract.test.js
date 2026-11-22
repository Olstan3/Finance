import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFromLines, linesFromText } from '../server/importers/extract.js';

const run = (text, ctx = {}) => extractFromLines(linesFromText(text), ctx);
const p = (x) => Math.round(x * 100);

test('statement with Paid out / Paid in / Balance columns: direction comes from the column', () => {
  const r = run(`
Business Account Statement
Sort code 20-45-67   Account number 12345678
Statement period 01 Apr 2025 to 30 Apr 2025

Date         Description                    Paid out     Paid in     Balance
01 Apr 2025  Balance brought forward                                 1,000.00
03 Apr 2025  SHELL SERVICE STATION             45.00                    955.00
07 Apr 2025  FASTER PAYMENT FROM ACME LTD                  1,200.00   2,155.00
12 Apr 2025  ADOBE SYSTEMS                      19.99                  2,135.01
`);
  assert.equal(r.mode, 'statement');
  assert.equal(r.items.length, 3);
  assert.deepEqual(r.items.map((i) => i.amount), [-p(45), p(1200), -p(19.99)]);
  assert.deepEqual(r.items.map((i) => i.date), ['2025-04-03', '2025-04-07', '2025-04-12']);
  assert.match(r.items[1].description, /ACME LTD/);
  assert.equal(r.items[0].balance, p(955));
  assert.ok(r.items.every((i) => !i.flags.includes('direction_guessed')));
});

test('statement with no headers and no signs: running balance reveals money in vs out (oldest first)', () => {
  const r = run(`
03/04/2025 Card payment Screwfix 120.00 880.00
07/04/2025 Customer payment J Smith 500.00 1,380.00
09/04/2025 Direct debit Octopus Energy 64.00 1,316.00
11/04/2025 Mystery thing 16.00 1,300.00
`);
  assert.equal(r.mode, 'statement');
  assert.deepEqual(r.items.map((i) => i.amount), [-p(120), p(500), -p(64), -p(16)]);
});

test('same, newest first (descending) – ordering is detected from the balances', () => {
  const r = run(`
11/04/2025 Customer receipt A Client 250.00 1,300.00
09/04/2025 Transfer 40.00 1,050.00
07/04/2025 Misc 10.00 1,090.00
03/04/2025 Deposit 100.00 1,100.00
`);
  // balances: 1000 -> +100 -> 1100 -> -10 -> 1090 -> -40 -> 1050 -> +250 -> 1300
  assert.deepEqual(r.items.map((i) => i.amount), [p(250), -p(40), -p(10), p(100)].map((x) => x));
});

test('explicit signs, brackets and DR/CR markers are honoured', () => {
  const r = run(`
01/05/2025 Amazon -25.00
02/05/2025 Refund 10.00 CR
03/05/2025 Parking (3.50)
04/05/2025 Loan fee 5.00 DR
`);
  assert.deepEqual(r.items.map((i) => i.amount), [-p(25), p(10), -p(3.5), -p(5)]);
});

test('dates without a year are resolved from the statement period, including across New Year', () => {
  const r = run(`
Statement period: 15 Dec 2025 to 14 Jan 2026
28 Dec  Tesco Stores  12.50-
03 Jan  Client payment  500.00
`);
  assert.deepEqual(r.items.map((i) => i.date), ['2025-12-28', '2026-01-03']);
});

test('rows that share the previous row\'s date and wrapped descriptions are kept together', () => {
  const r = run(`
Date        Details                      Debit      Credit    Balance
05 Jun 2025 CARD PAYMENT TO NATIONAL
            RAIL LONDON                  32.40                 967.60
            TFL TRAVEL CHARGE            8.40                  959.20
06 Jun 2025 BACS CREDIT BRIGHT CO                   300.00     1,259.20
`);
  assert.equal(r.items.length, 3);
  assert.match(r.items[0].description, /NATIONAL RAIL LONDON/);
  assert.equal(r.items[1].date, '2025-06-05');
  assert.equal(r.items[1].amount, -p(8.4));
  assert.equal(r.items[2].amount, p(300));
});

test('page furniture, totals and opening balance lines never become transactions', () => {
  const r = run(`
Date        Description         Paid out   Paid in   Balance
Opening balance                                       500.00
02/06/2025  Coffee shop         3.50                  496.50
Page 1 of 2
Total paid out 3.50
Closing balance                                       496.50
`);
  assert.equal(r.items.length, 1);
});

test('foreign-currency rows are flagged, not silently treated as pounds', () => {
  const r = run(`
01/05/2025 Zoom subscription $15.99
02/05/2025 Hotel Paris 120.00 EUR
`);
  assert.ok(r.items[0].flags.some((f) => f.startsWith('foreign_currency')));
});

// --------------- documents

const ctx = { profile: { name: 'Sam Trader', tradingName: 'ST Design' } };

test('supplier invoice addressed to the user: expense, VAT and total extracted from anywhere', () => {
  const r = run(`
Northern Paper Supplies Ltd
12 Mill Road, Leeds LS1 4AB
VAT Reg: GB 123 4567 89

TAX INVOICE
Invoice number: NP-20931
Invoice date: 14 March 2025
Payment due: 13 April 2025

Bill to:
ST Design
5 High Street

Description             Qty   Unit price    Amount
A3 Card stock           10     18.00        180.00
Delivery                 1     20.00         20.00

Subtotal                                   200.00
VAT @ 20%                                   40.00
Total due                                  240.00
`, ctx);
  assert.equal(r.mode, 'document');
  const d = r.items[0];
  assert.equal(d.direction, 'out');
  assert.equal(d.amount, -p(240));
  assert.equal(d.net, p(200));
  assert.equal(d.vat, p(40));
  assert.equal(d.date, '2025-03-14');
  assert.equal(d.dueDate, '2025-04-13');
  assert.match(d.counterparty, /Northern Paper Supplies/);
  assert.equal(d.reference, 'NP-20931');
  assert.ok(d.flags.includes('unpaid_supplier_invoice'));
});

test('the user\'s own sales invoice: income, counterparty is the customer', () => {
  const r = run(`
ST Design
Sam Trader
INVOICE INV-0042
Date: 02/05/2025

Invoice to:
Bright Co Ltd

Website design              1,500.00
VAT 20%                       300.00
Total                       1,800.00
Pay to sort code 20-45-67 account 12345678
`, ctx);
  const d = r.items[0];
  assert.equal(d.direction, 'in');
  assert.equal(d.amount, p(1800));
  assert.equal(d.vat, p(300));
  assert.match(d.counterparty, /Bright Co/);
  assert.equal(d.reference, 'INV-0042');
  assert.equal(d.date, '2025-05-02');
});

test('till receipt: total, VAT included in total, card payment', () => {
  const r = run(`
SCREWFIX DIRECT
Receipt
Date 21/06/2025 14:32
Cordless drill          89.99
Drill bits               9.00
Subtotal                98.99
VAT 20%                 19.80
TOTAL                  118.79
VISA contactless
`);
  const d = r.items[0];
  assert.equal(d.amount, -p(118.79));
  assert.equal(d.date, '2025-06-21');
  assert.equal(d.docType, 'receipt');
  assert.equal(d.vat, p(19.8));
  assert.match(d.counterparty, /SCREWFIX/);
});

test('VAT rate table rows (rate / net / VAT / gross) are understood', () => {
  const r = run(`
Fuel Stop
Receipt 3 Jul 2025
VAT summary
20%   50.00   10.00   60.00
Total 60.00
`);
  const d = r.items[0];
  assert.equal(d.amount, -p(60));
  assert.equal(d.net, p(50));
  assert.equal(d.vat, p(10));
});

test('an inconsistent total is flagged', () => {
  const r = run(`
Acme Supplies Ltd
Invoice 4412
Date 1 Aug 2025
Subtotal 100.00
VAT 20.00
Total 150.00
`);
  assert.ok(r.items[0].flags.includes('totals_mismatch'));
  assert.equal(r.items[0].amount, -p(150));
});

test('loose notes: dates and amounts anywhere in a sentence', () => {
  const r = run(`
Paid £45.50 to Screwfix on 3 March 2025 for tools
Received £600 from Mrs Patel on 5/3/2025 - invoice paid
`);
  assert.equal(r.mode, 'notes');
  assert.deepEqual(r.items.map((i) => i.amount), [-p(45.5), p(600)]);
  assert.deepEqual(r.items.map((i) => i.date), ['2025-03-03', '2025-03-05']);
});

test('notes: the date and the word introducing it are removed from the description', () => {
  const r = run('Paid £45.50 to Screwfix on 3 March 2025 for tools\nBought paper dated 4/3/2025 £12.00');
  assert.equal(r.items[0].description, 'Paid to Screwfix for tools');
  assert.equal(r.items[1].description, 'Bought paper');
});

test('empty or amount-free text yields a clear warning, not garbage', () => {
  const r = run('Hello world, no money here.');
  assert.equal(r.items.length, 0);
  assert.ok(r.warnings.length);
  assert.equal(run('').mode, 'empty');
});
