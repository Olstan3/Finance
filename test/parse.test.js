import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDates, findAmounts, parseDate, parseAmount } from '../server/importers/parse.js';

const iso = (s, o) => findDates(s, o).map((d) => d.iso);

test('dates: every common UK statement/invoice format', () => {
  assert.deepEqual(iso('Paid on 06/04/2025'), ['2025-04-06']);
  assert.deepEqual(iso('06-04-25'), ['2025-04-06']);
  assert.deepEqual(iso('6.4.2025'), ['2025-04-06']);
  assert.deepEqual(iso('2025-04-06T10:11:12Z'), ['2025-04-06']);
  assert.deepEqual(iso('6 Apr 2025'), ['2025-04-06']);
  assert.deepEqual(iso('06-Apr-25'), ['2025-04-06']);
  assert.deepEqual(iso('6th April 2025'), ['2025-04-06']);
  assert.deepEqual(iso('April 6, 2025'), ['2025-04-06']);
  assert.deepEqual(iso('Sept 3 2025'), ['2025-09-03']);
  assert.deepEqual(iso('31/12/2025 and 01/01/2026'), ['2025-12-31', '2026-01-01']);
});

test('dates: dd/mm is the default, mm/dd only when dd/mm is impossible or requested', () => {
  assert.deepEqual(iso('03/04/2025'), ['2025-04-03']);
  assert.deepEqual(iso('03/04/2025', { order: 'mdy' }), ['2025-03-04']);
  assert.deepEqual(iso('04/13/2025'), ['2025-04-13']);
});

test('dates: rejects impossible dates and does not read amounts or refs as dates', () => {
  assert.deepEqual(iso('31/02/2025'), []);
  assert.deepEqual(iso('13 Mar  45.00 Tesco'), []);
  assert.deepEqual(iso('Ref 20250406 abc'), []);
  assert.deepEqual(iso('Sort code 20-45-67'), []);
});

test('dates without a year are resolved from the statement period', () => {
  const period = { start: '2025-12-15', end: '2026-01-14' };
  assert.deepEqual(iso('28 Dec  Tesco  12.50', { period }), ['2025-12-28']);
  assert.deepEqual(iso('03 Jan  Rent  500.00', { period }), ['2026-01-03']);
  assert.deepEqual(iso('13 Mar  45.00 Tesco', { defaultYear: 2025 }), ['2025-03-13']);
  assert.deepEqual(iso('28 Dec Tesco'), [], 'no year context -> no guess');
});

test('parseDate handles OFX stamps', () => {
  assert.equal(parseDate('20250406120000[0:GMT]'), '2025-04-06');
  assert.equal(parseDate('20250406'), '2025-04-06');
});

const amts = (s, o) => findAmounts(s, o).map((a) => a.pence);

test('amounts: symbols, separators, signs', () => {
  assert.deepEqual(amts('Total £1,234.56'), [123456]);
  assert.deepEqual(amts('-45.00'), [-4500]);
  assert.deepEqual(amts('(45.00)'), [-4500]);
  assert.deepEqual(amts('45.00-'), [-4500]);
  assert.deepEqual(amts('45.00 DR'), [-4500]);
  assert.deepEqual(amts('45.00 CR'), [4500]);
  assert.deepEqual(amts('£-12.30'), [-1230]);
  assert.deepEqual(amts('GBP 99.99'), [9999]);
  assert.deepEqual(amts('£5'), [500]);
  assert.deepEqual(amts('1,000,000.00'), [100000000]);
});

test('amounts: not fooled by references, years, phone numbers, sort codes, times', () => {
  assert.deepEqual(amts('Invoice 12345 dated 2025'), []);
  assert.deepEqual(amts('Call 01234 567890'), []);
  assert.deepEqual(amts('Sort 20-45-67 Acct 12345678'), []);
  assert.deepEqual(amts('Ref 10:45:30'), []);
  assert.deepEqual(amts('Order #8123456789 2 x 10'), []);
});

test('amounts: several on one line, in order', () => {
  assert.deepEqual(amts('Tesco   25.00   1,975.00'), [2500, 197500]);
  assert.deepEqual(amts('Net 100.00 VAT (20%) 20.00 Total 120.00'), [10000, 2000, 12000]);
});

test('parseAmount for standalone cells', () => {
  assert.equal(parseAmount('£1,200'), 120000);
  assert.equal(parseAmount('1200'), 120000);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount(12.5), 1250);
});
