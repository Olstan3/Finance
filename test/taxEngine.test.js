import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateIncomeTax, calculateCgt } from '../server/domain/taxEngine.js';

const gbp = (x) => Math.round(x * 100);
const base = { taxYear: '2025-26', region: 'england', hasSelfEmployment: false };

test('sole trader £50,000 profit, 2025-26: tax, Class 4 and payments on account', () => {
  const r = calculateIncomeTax({ ...base, selfEmploymentProfit: gbp(50000), hasSelfEmployment: true });
  assert.equal(r.taxable.total, gbp(37430));
  assert.equal(r.tax.incomeTax, gbp(7486));
  assert.equal(r.nic.class4, gbp(2245.8));
  assert.equal(r.nic.class2, 0, 'Class 2 is no longer compulsory from 2024-25');
  assert.equal(r.totalLiability, gbp(9731.8));
  assert.equal(r.balance, gbp(9731.8));
  assert.equal(r.paymentsOnAccount.length, 2);
  assert.equal(r.paymentsOnAccount[0].amount, gbp(4865.9));
  assert.equal(r.paymentsOnAccount[0].due, '2027-01-31');
  assert.equal(r.paymentsOnAccount[1].due, '2027-07-31');
  assert.equal(r.balancingPaymentDue, '2027-01-31');
});

test('£100,000 profit: no allowance taper yet; Class 4 3% upper slice', () => {
  const r = calculateIncomeTax({ ...base, selfEmploymentProfit: gbp(100000), hasSelfEmployment: true });
  assert.equal(r.personalAllowance, gbp(12570));
  assert.equal(r.tax.incomeTax, gbp(27432)); // 7,540 + 49,730 * 40%
  assert.equal(r.nic.class4, gbp(3256.6)); // 6% of 37,700 + 2% of 49,730
});

test('£110,000: personal allowance tapers £1 per £2 over £100k', () => {
  const r = calculateIncomeTax({ ...base, employmentPay: gbp(110000) });
  assert.equal(r.personalAllowance, gbp(7570));
  assert.equal(r.tax.incomeTax, gbp(33432));
});

test('£130,000: no allowance, additional rate above £125,140', () => {
  const r = calculateIncomeTax({ ...base, employmentPay: gbp(130000) });
  assert.equal(r.personalAllowance, 0);
  assert.equal(r.tax.incomeTax, gbp(44703)); // 7,540 + 34,976 + 2,187
});

test('Scottish taxpayer, £50,000 earnings, 2025-26', () => {
  const r = calculateIncomeTax({ ...base, region: 'scotland', employmentPay: gbp(50000) });
  assert.equal(r.tax.incomeTax, gbp(9013.8));
  assert.ok(r.bands.some((b) => b.band === 'Intermediate rate'));
});

test('dividends sit on top of earnings and use the £500 allowance', () => {
  const r = calculateIncomeTax({ ...base, employmentPay: gbp(30000), dividends: gbp(10000) });
  assert.equal(r.tax.nonSavings, gbp(3486));
  assert.equal(r.tax.dividends, gbp(831.25)); // (10,000 - 500) * 8.75%
  assert.equal(r.tax.incomeTax, gbp(4317.25));
  assert.equal(r.allowancesUsed.dividendAllowance, gbp(500));
});

test('2026-27 dividend rates are 10.75% (provisional table)', () => {
  const r = calculateIncomeTax({ ...base, taxYear: '2026-27', employmentPay: gbp(30000), dividends: gbp(10000) });
  assert.equal(r.tax.dividends, gbp(1021.25)); // 9,500 * 10.75%
  assert.equal(r.rateStatus, 'provisional');
});

test('savings: PSA applies when starting-rate band is used up by earnings', () => {
  const r = calculateIncomeTax({ ...base, employmentPay: gbp(20000), savingsInterest: gbp(2000) });
  assert.equal(r.tax.savings, gbp(200)); // 1,000 PSA at 0%, 1,000 at 20%
  assert.equal(r.tax.incomeTax, gbp(1686));
});

test('savings starting rate band shelters interest when other income is low', () => {
  const r = calculateIncomeTax({ ...base, selfEmploymentProfit: gbp(13000), hasSelfEmployment: true, savingsInterest: gbp(3000) });
  assert.equal(r.tax.savings, 0);
  assert.equal(r.tax.incomeTax, gbp(86));
});

test('Gift Aid extends the basic-rate band by the grossed-up donation', () => {
  const without = calculateIncomeTax({ ...base, employmentPay: gbp(55000) });
  const withGa = calculateIncomeTax({ ...base, employmentPay: gbp(55000), giftAidNet: gbp(800) });
  assert.equal(without.tax.incomeTax, gbp(9432));
  assert.equal(withGa.tax.incomeTax, gbp(9232));
  assert.equal(withGa.giftAidGross, gbp(1000));
});

test('High Income Child Benefit Charge: 50% at £70,000 ANI', () => {
  const r = calculateIncomeTax({ ...base, employmentPay: gbp(70000), childBenefit: gbp(2212.8) });
  assert.equal(r.hicbc.percentage, 50);
  assert.equal(r.hicbc.amount, gbp(1106.4));
});

test('HICBC is fully clawed back at £80,000+, and not charged below £60,000', () => {
  assert.equal(calculateIncomeTax({ ...base, employmentPay: gbp(85000), childBenefit: gbp(1000) }).hicbc.amount, gbp(1000));
  assert.equal(calculateIncomeTax({ ...base, employmentPay: gbp(59999), childBenefit: gbp(1000) }).hicbc.amount, 0);
});

test('pension payments reduce ANI and can avoid the HICBC', () => {
  const r = calculateIncomeTax({ ...base, employmentPay: gbp(70000), childBenefit: gbp(2000), pensionRasNet: gbp(8000) });
  // gross 10,000 -> ANI 60,000 -> no charge
  assert.equal(r.adjustedNetIncome, gbp(60000));
  assert.equal(r.hicbc.amount, 0);
});

test('Student Loan Plan 2 repayment through Self Assessment', () => {
  const r = calculateIncomeTax({ ...base, employmentPay: gbp(40000), studentLoan: { plan: 'plan2' } });
  assert.equal(r.studentLoan.due, gbp(1037.7));
  const paid = calculateIncomeTax({ ...base, employmentPay: gbp(40000), studentLoan: { plan: 'plan2', paidViaPaye: gbp(1000) } });
  assert.equal(paid.studentLoan.due, gbp(37.7));
});

test('2023-24: Class 2 compulsory above £12,570 and Class 4 at 9%', () => {
  const r = calculateIncomeTax({ ...base, taxYear: '2023-24', selfEmploymentProfit: gbp(20000), hasSelfEmployment: true });
  assert.equal(r.nic.class2, gbp(179.4));
  assert.equal(r.nic.class4, gbp(668.7));
});

test('small sole trader: no payments on account below £1,000', () => {
  const r = calculateIncomeTax({ ...base, selfEmploymentProfit: gbp(15000), hasSelfEmployment: true });
  assert.equal(r.totalLiability, gbp(631.8));
  assert.equal(r.paymentsOnAccount.length, 0);
});

test('payments on account: not required once 80%+ of the bill is collected at source', () => {
  // Tax on £55,000 total income is £9,432. £7,600 PAYE = 80.6% -> no POAs; £7,486 = 79.4% -> POAs due.
  const mk = (paye) => calculateIncomeTax({
    ...base, employmentPay: gbp(50000), selfEmploymentProfit: gbp(5000), hasSelfEmployment: true,
    taxDeductedAtSource: { paye: gbp(paye) },
  });
  const over = mk(7600);
  assert.equal(over.tax.incomeTax, gbp(9432));
  assert.equal(over.paymentsOnAccount.length, 0);
  assert.ok(over.balance > 0);
  const under = mk(7486);
  assert.equal(under.paymentsOnAccount.length, 2);
  assert.equal(under.paymentsOnAccount[0].amount, Math.round((gbp(9432) - gbp(7486)) / 2));
});

test('payments already made reduce the balance and can create a refund', () => {
  const r = calculateIncomeTax({
    ...base, selfEmploymentProfit: gbp(50000), hasSelfEmployment: true,
    paymentsMade: [{ amount: gbp(5000) }, { amount: gbp(5000) }],
  });
  assert.equal(r.balance, gbp(9731.8) - gbp(10000));
  assert.ok(r.balance < 0);
});

test('residential finance costs give a 20% tax reduction, not an expense', () => {
  const r = calculateIncomeTax({ ...base, employmentPay: gbp(30000), propertyProfit: gbp(10000), residentialFinanceCosts: gbp(6000) });
  assert.equal(r.tax.reductions[0].amount, gbp(1200));
  assert.equal(r.tax.incomeTax, gbp(4286));
});

test('Marriage Allowance: recipient gets £252 off, giver loses £1,260 of allowance', () => {
  const recv = calculateIncomeTax({ ...base, employmentPay: gbp(30000), marriageAllowance: 'receive' });
  assert.equal(recv.tax.incomeTax, gbp(3486) - gbp(252));
  const give = calculateIncomeTax({ ...base, employmentPay: gbp(13000), marriageAllowance: 'give' });
  assert.equal(give.personalAllowance, gbp(11310));
});

test('a trading loss yields no tax and no NIC', () => {
  const r = calculateIncomeTax({ ...base, selfEmploymentProfit: 0, hasSelfEmployment: true });
  assert.equal(r.totalLiability, 0);
});

test('unknown tax year fails loudly rather than guessing', () => {
  assert.throws(() => calculateIncomeTax({ ...base, taxYear: '1999-00' }), /No tax rates/);
});

// ---------------- CGT ----------------
test('CGT: gain split across basic and higher rate bands after AEA (2025-26)', () => {
  const r = calculateCgt([{ date: '2025-08-01', gain: gbp(20000), residential: false }], {
    taxYear: '2025-26', taxableIncome: gbp(30000), basicBandTop: gbp(37700),
  });
  assert.equal(r.taxableGain, gbp(17000));
  assert.equal(r.tax, gbp(3618)); // 7,700 @18% + 9,300 @24%
});

test('CGT: current-year losses first, then b/f losses only down to the AEA', () => {
  const r = calculateCgt(
    [{ date: '2025-06-01', gain: gbp(10000) }, { date: '2025-07-01', gain: -gbp(4000) }],
    { taxYear: '2025-26', taxableIncome: 0, basicBandTop: gbp(37700), lossesBroughtForward: gbp(5000) },
  );
  assert.equal(r.netGain, gbp(6000));
  assert.equal(r.lossesBroughtForwardUsed, gbp(3000));
  assert.equal(r.taxableGain, 0);
  assert.equal(r.lossesCarriedForward, gbp(2000));
  assert.equal(r.tax, 0);
});

test('CGT 2024-25: rate change on 30 Oct 2024, AEA set against the higher-rate gain first', () => {
  const r = calculateCgt(
    [{ date: '2024-09-01', gain: gbp(10000) }, { date: '2024-12-01', gain: gbp(10000) }],
    { taxYear: '2024-25', taxableIncome: 0, basicBandTop: gbp(37700) },
  );
  assert.equal(r.tax, gbp(2260)); // 7,000 @18% + 10,000 @10%
});

test('CGT: a net loss is carried forward', () => {
  const r = calculateCgt([{ date: '2025-06-01', gain: -gbp(2500) }], { taxYear: '2025-26', taxableIncome: 0 });
  assert.equal(r.tax, 0);
  assert.equal(r.lossesCarriedForward, gbp(2500));
});
