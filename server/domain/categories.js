// Built-in category catalogue. Each category maps to a `taxField`, which is what the Self
// Assessment worksheets and reports aggregate on. Users can add their own categories that
// map onto any existing taxField.
//
// kind: income | expense | capital | transfer | personal | tax | other
//   income / expense  -> feed profit calculations
//   capital           -> equipment/vehicle purchases (expense under cash basis, asset otherwise)
//   transfer/personal/tax/other -> ignored in profit, but tracked
// allowable: 0 for expenses that appear in the totals but are added back as disallowable

export const BUILTIN_CATEGORIES = [
  // ---- Self-employment income ----
  { id: 'se_turnover', name: 'Sales & fees (turnover)', kind: 'income', section: 'self_employment', taxField: 'se.turnover' },
  { id: 'se_other_income', name: 'Other business income', kind: 'income', section: 'self_employment', taxField: 'se.otherIncome' },
  // ---- Self-employment expenses (SA103 boxes 17-30) ----
  { id: 'se_cogs', name: 'Cost of goods & materials', kind: 'expense', section: 'self_employment', taxField: 'se.costOfGoods' },
  { id: 'se_subcontractors', name: 'Subcontractor payments (CIS)', kind: 'expense', section: 'self_employment', taxField: 'se.cis' },
  { id: 'se_wages', name: 'Wages, salaries & staff costs', kind: 'expense', section: 'self_employment', taxField: 'se.wages' },
  { id: 'se_travel', name: 'Car, van & travel', kind: 'expense', section: 'self_employment', taxField: 'se.travel' },
  { id: 'se_premises', name: 'Rent, rates, power & insurance', kind: 'expense', section: 'self_employment', taxField: 'se.premises' },
  { id: 'se_repairs', name: 'Repairs & maintenance', kind: 'expense', section: 'self_employment', taxField: 'se.repairs' },
  { id: 'se_admin', name: 'Phone, software, stationery & office', kind: 'expense', section: 'self_employment', taxField: 'se.admin' },
  { id: 'se_advertising', name: 'Advertising & marketing', kind: 'expense', section: 'self_employment', taxField: 'se.advertising' },
  { id: 'se_entertainment', name: 'Business entertainment (not allowable)', kind: 'expense', section: 'self_employment', taxField: 'se.advertising', allowable: 0 },
  { id: 'se_interest', name: 'Interest on business loans', kind: 'expense', section: 'self_employment', taxField: 'se.interest' },
  { id: 'se_bank', name: 'Bank, card & finance charges', kind: 'expense', section: 'self_employment', taxField: 'se.financeCharges' },
  { id: 'se_bad_debt', name: 'Irrecoverable debts written off', kind: 'expense', section: 'self_employment', taxField: 'se.badDebts' },
  { id: 'se_professional', name: 'Accountancy, legal & professional fees', kind: 'expense', section: 'self_employment', taxField: 'se.professional' },
  { id: 'se_depreciation', name: 'Depreciation (not allowable)', kind: 'expense', section: 'self_employment', taxField: 'se.depreciation', allowable: 0 },
  { id: 'se_other', name: 'Other business expenses', kind: 'expense', section: 'self_employment', taxField: 'se.other' },
  { id: 'se_capital', name: 'Equipment & capital purchases', kind: 'capital', section: 'self_employment', taxField: 'se.capital' },
  // ---- UK property ----
  { id: 'prop_rent', name: 'Rental income', kind: 'income', section: 'property', taxField: 'prop.rents' },
  { id: 'prop_other_income', name: 'Other property income', kind: 'income', section: 'property', taxField: 'prop.rents' },
  { id: 'prop_rates_ins', name: 'Rent, rates, insurance & ground rent', kind: 'expense', section: 'property', taxField: 'prop.rentRatesInsurance' },
  { id: 'prop_repairs', name: 'Property repairs & maintenance', kind: 'expense', section: 'property', taxField: 'prop.repairs' },
  { id: 'prop_finance_res', name: 'Mortgage interest (residential) – 20% credit', kind: 'expense', section: 'property', taxField: 'prop.residentialFinance' },
  { id: 'prop_finance_com', name: 'Loan interest (non-residential property)', kind: 'expense', section: 'property', taxField: 'prop.financeNonRes' },
  { id: 'prop_professional', name: 'Letting agent, legal & professional fees', kind: 'expense', section: 'property', taxField: 'prop.professional' },
  { id: 'prop_services', name: 'Services (cleaning, gardening, wages)', kind: 'expense', section: 'property', taxField: 'prop.services' },
  { id: 'prop_other', name: 'Other allowable property expenses', kind: 'expense', section: 'property', taxField: 'prop.other' },
  // ---- Savings, dividends, reliefs ----
  { id: 'int_bank', name: 'Bank & building society interest', kind: 'income', section: 'savings', taxField: 'int.bank' },
  { id: 'div_uk', name: 'Dividends (UK)', kind: 'income', section: 'dividends', taxField: 'div.uk' },
  { id: 'gift_aid', name: 'Gift Aid donation', kind: 'other', section: 'reliefs', taxField: 'relief.giftAid' },
  { id: 'pension_contrib', name: 'Personal pension contribution', kind: 'other', section: 'reliefs', taxField: 'relief.pensionRas' },
  // ---- Not part of profit ----
  { id: 'transfer', name: 'Transfer between accounts', kind: 'transfer', section: 'none', taxField: 'none' },
  { id: 'drawings', name: 'Owner drawings / personal spending', kind: 'personal', section: 'none', taxField: 'none' },
  { id: 'capital_in', name: 'Capital introduced / loans received', kind: 'other', section: 'none', taxField: 'none' },
  { id: 'hmrc_payment', name: 'HMRC tax payment (Self Assessment)', kind: 'tax', section: 'none', taxField: 'tax.payment' },
  { id: 'vat_payment', name: 'VAT paid to / refunded by HMRC', kind: 'tax', section: 'none', taxField: 'vat.payment' },
];

export const SECTION_LABELS = {
  self_employment: 'Self-employment',
  property: 'UK property',
  savings: 'Savings & interest',
  dividends: 'Dividends',
  reliefs: 'Reliefs',
  none: 'Not taxable / ignored',
};

export function seedCategories(db) {
  const ins = db.prepare(
    `INSERT INTO categories (id, name, kind, section, tax_field, allowable, builtin, sort)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, section = excluded.section,
       tax_field = excluded.tax_field, allowable = excluded.allowable, builtin = 1, sort = excluded.sort`,
  );
  BUILTIN_CATEGORIES.forEach((c, i) => ins.run(c.id, c.name, c.kind, c.section, c.taxField, c.allowable ?? 1, i));
}
