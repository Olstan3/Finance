// Suggests a category for a transaction. Order of authority:
//   1. the user's own rules            (confidence 0.95)
//   2. what the user chose before for the same merchant  (0.80 – 0.92)
//   3. a built-in dictionary of common UK merchants/phrases (0.45 – 0.88)
// Anything below the "auto-record" confidence is saved with status "review" so the user checks it.

const R = (re, category, { dir = 'any', conf = 0.8, why, pct } = {}) => ({ re, category, dir, conf, why, pct });

export const BUILTIN_RULES = [
  // ---- HMRC and tax (most specific first)
  R(/\bhmrc\b.*\bvat\b|\bvat\b.*\bhmrc\b|\bhmrc vat\b/i, 'vat_payment', { conf: 0.92, why: 'VAT payment/refund' }),
  R(/\b(hmrc|h m revenue|self assessment|cumbernauld|shipley|payment on account|class 2|class 4|ni contributions?)\b/i, 'hmrc_payment', { conf: 0.82, why: 'HMRC tax payment' }),
  // ---- transfers
  R(/\b(transfer (to|from)|own account|internal transfer|between accounts|monzo pot|starling space|\bpot\b|savings account|\bisa\b|top.?up)\b/i, 'transfer', { conf: 0.62, why: 'Looks like a transfer between your accounts' }),
  // ---- income
  R(/\b(interest (paid|earned|credited|gross)|gross interest|savings interest|credit interest)\b/i, 'int_bank', { dir: 'in', conf: 0.82, why: 'Bank interest' }),
  R(/\bdividends?\b/i, 'div_uk', { dir: 'in', conf: 0.82, why: 'Dividend' }),
  R(/\b(stripe|paypal|shopify|sumup|izettle|square|gocardless|etsy|worldpay|ebay|amazon payments)\b.*\b(payout|transfer|payment|settlement)\b|\bpayout\b/i, 'se_turnover', { dir: 'in', conf: 0.8, why: 'Payment-processor payout' }),
  R(/\b(rent|tenant|rental)\b/i, 'prop_rent', { dir: 'in', conf: 0.6, why: 'Looks like rent received' }),
  R(/\b(salary|wages|payroll)\b/i, 'drawings', { dir: 'in', conf: 0.5, why: 'Employment pay is entered in the Employment section, not here' }),
  // ---- property
  R(/\blandlord insurance\b/i, 'prop_rates_ins', { dir: 'out', conf: 0.88, why: 'Landlord insurance' }),
  R(/\b(mortgage|bm solutions|kensington mortgage|paragon|mortgage express)\b/i, 'prop_finance_res', { dir: 'out', conf: 0.62, why: 'Mortgage interest on a rental? (capital repayments are not deductible)' }),
  R(/\b(letting agent|property management|foxtons|savills|hamptons|your move|connells|rightmove|zoopla|openrent|tenant find)\b/i, 'prop_professional', { dir: 'out', conf: 0.78, why: 'Letting/property fees' }),
  R(/\b(gas safe|epc|gas safety|electrical safety|eicr|ground rent|service charge)\b/i, 'prop_other', { dir: 'out', conf: 0.6, why: 'Property compliance/charges' }),
  // ---- personal / not business
  R(/\b(council tax)\b/i, 'drawings', { dir: 'out', conf: 0.85, why: 'Council tax is personal' }),
  R(/\b(just ?giving|oxfam|cancer research|red cross|british heart|unicef|donation|gift ?aid|charity|rnli|macmillan|save the children|nspcc|shelter)\b/i, 'gift_aid', { dir: 'out', conf: 0.55, why: 'Charity donation (only counts if Gift Aid was declared)' }),
  R(/\b(pension|sipp|scottish widows|standard life|aegon|royal london|legal (&|and) general|people'?s pension)\b/i, 'pension_contrib', { dir: 'out', conf: 0.55, why: 'Pension contribution' }),
  // ---- business expenses
  R(/\b(shell|bp|esso|texaco|jet|gulf|murco|petrol|diesel|fuel|forecourt|applegreen|motorway services|moto|welcome break|roadchef)\b/i, 'se_travel', { dir: 'out', conf: 0.8, why: 'Fuel' }),
  R(/\b(trainline|national rail|lner|gwr|avanti|southeastern|northern rail|scotrail|tfl|transport for london|oyster|uber|bolt|addison lee|ryanair|easyjet|british airways|eurostar|heathrow express|ncp|ringo|justpark|paybyphone|parking|congestion charge|dart charge|toll)\b/i, 'se_travel', { dir: 'out', conf: 0.85, why: 'Travel' }),
  R(/\b(adobe|microsoft|msft|office 365|google (workspace|gsuite|cloud|storage|one)|dropbox|zoom|slack|notion|github|atlassian|jetbrains|figma|canva|squarespace|wix|godaddy|namecheap|123-?reg|cloudflare|digitalocean|heroku|amazon web services|aws|openai|anthropic|mailchimp|xero|quickbooks|freeagent|sage|1password|lastpass|icloud)\b/i, 'se_admin', { dir: 'out', conf: 0.82, why: 'Software / online service' }),
  R(/\b(o2|vodafone|ee limited|three|giffgaff|bt group|plusnet|talktalk|tesco mobile|virgin media)\b/i, 'se_admin', { dir: 'out', conf: 0.62, why: 'Phone/internet – business use may be partial', pct: 100 }),
  R(/\b(facebk|facebook ads|meta platforms|google ads|adwords|linkedin|twitter ads|instagram|vistaprint|moo\.com|flyeralarm|yell\.com|trustpilot)\b/i, 'se_advertising', { dir: 'out', conf: 0.8, why: 'Advertising' }),
  R(/\b(bank charges?|monthly (account )?fee|account fee|overdraft (fee|interest)|interest charged|card fee|transaction fee|stripe fee|paypal fee|gocardless fee|foreign (transaction|exchange) fee|service charge|merchant services)\b/i, 'se_bank', { dir: 'out', conf: 0.85, why: 'Bank/card charges' }),
  R(/\b(accountant|accountancy|solicitor|legal fees?|law firm|barrister|bookkeep|tax advis[oe]r|companies house|ico fee|professional indemnity)\b/i, 'se_professional', { dir: 'out', conf: 0.8, why: 'Professional fees' }),
  R(/\b(insurance|aviva|axa|hiscox|zurich|direct line|simply business|nfu mutual)\b/i, 'se_premises', { dir: 'out', conf: 0.66, why: 'Insurance' }),
  R(/\b(british gas|edf|octopus energy|e\.on|eon next|scottish power|ovo|bulb|thames water|severn trent|business rates)\b/i, 'se_premises', { dir: 'out', conf: 0.55, why: 'Utilities – only the business share is allowable' }),
  R(/\b(screwfix|toolstation|b&q|wickes|travis perkins|jewson|homebase|machine mart|rs components|farnell|city electrical|plumbase|selco|buildbase)\b/i, 'se_cogs', { dir: 'out', conf: 0.72, why: 'Trade supplier' }),
  R(/\b(staples|ryman|viking direct|paperchase|printerland|cartridge)\b/i, 'se_admin', { dir: 'out', conf: 0.78, why: 'Stationery / office' }),
  R(/\b(salary|wages|payroll|nest pension|employer)\b/i, 'se_wages', { dir: 'out', conf: 0.55, why: 'Staff cost?' }),
  R(/\b(plumber|electrician|roofer|builder|handyman|repair|maintenance|locksmith)\b/i, 'se_repairs', { dir: 'out', conf: 0.5, why: 'Repairs (business or rental property?)' }),
  R(/\b(amazon|amzn|ebay|argos|currys|ikea)\b/i, 'se_admin', { dir: 'out', conf: 0.45, why: 'General retailer – check what it was for' }),
  // ---- everyday personal spending
  R(/\b(tesco|sainsbury'?s?|asda|morrisons|waitrose|aldi|lidl|co-?op|iceland|ocado|marks (and|&) spencer|greggs|pret|costa|starbucks|caffe nero|mcdonald'?s?|kfc|burger king|subway|nandos|wetherspoon|restaurant|deliveroo|just eat|uber eats|netflix|spotify|disney|prime video|puregym|odeon|vue cinema|primark|h&m|zara|boots)\b/i, 'drawings', { dir: 'out', conf: 0.7, why: 'Everyday personal spending' }),
  // ---- fallbacks by direction
  R(/\b(loan|funding circle|zopa|lendinvest|bounce back)\b/i, 'capital_in', { dir: 'in', conf: 0.5, why: 'Loan received?' }),
];

const NOISE = /\b(card|payment|pmt|purchase|pos|dd|d\/d|direct|debit|so|standing|order|faster|fp|bacs|transfer|trf|ref|reference|visa|mastercard|contactless|ltd|limited|plc|uk|gb|gbr|the|to|from|via|on|at|of|and|co|inc|www|com|online|recurring|cr|dr|mobile)\b/gi;

/** A short, stable key identifying "the same merchant" across differently-worded bank lines. */
export function merchantKey(description) {
  const words = String(description || '')
    .toLowerCase()
    .replace(/[^a-z& ]+/g, ' ')
    .replace(NOISE, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  return words.slice(0, 2).join(' ') || null;
}

/** Build a lookup of merchantKey -> {category -> count} from previously confirmed transactions. */
export function buildHistory(db) {
  const rows = db.all(
    `SELECT description, category_id, business_pct, COUNT(*) AS n FROM transactions
     WHERE category_id IS NOT NULL AND status = 'confirmed' AND source != 'invoice' GROUP BY description, category_id, business_pct`,
  );
  const map = new Map();
  for (const r of rows) {
    const key = merchantKey(r.description);
    if (!key) continue;
    const entry = map.get(key) || { total: 0, cats: new Map() };
    entry.total += r.n;
    const c = entry.cats.get(r.category_id) || { n: 0, pct: r.business_pct };
    c.n += r.n; entry.cats.set(r.category_id, c);
    map.set(key, entry);
  }
  return map;
}

export function loadRules(db) {
  return db.all('SELECT * FROM rules ORDER BY priority, id').map((r) => ({ ...r }));
}

function ruleMatches(rule, text) {
  const t = text.toLowerCase();
  const p = String(rule.pattern).toLowerCase();
  switch (rule.match_type) {
    case 'starts': return t.startsWith(p);
    case 'exact': return t === p;
    case 'regex': try { return new RegExp(rule.pattern, 'i').test(text); } catch { return false; }
    default: return t.includes(p);
  }
}

/**
 * @param item  { description, amount, counterparty? }
 * @param ctx   { rules, history, validCategories:Set }
 */
export function suggestCategory(item, ctx) {
  const dir = item.amount >= 0 ? 'in' : 'out';
  const text = `${item.description || ''} ${item.counterparty || ''}`;

  for (const r of ctx.rules || []) {
    if (r.direction !== 'any' && r.direction !== dir) continue;
    if (ruleMatches(r, text) && (!ctx.validCategories || ctx.validCategories.has(r.category_id))) {
      return { category_id: r.category_id, confidence: 0.95, reason: `Your rule "${r.pattern}"`, source: 'rule', rule_id: r.id, business_pct: r.business_pct, contact_id: r.contact_id || null };
    }
  }

  const key = merchantKey(item.description);
  const h = key && ctx.history?.get(key);
  if (h) {
    const [cat, c] = [...h.cats.entries()].sort((a, b) => b[1].n - a[1].n)[0];
    const agree = c.n / h.total;
    if (agree >= 0.75 && (!ctx.validCategories || ctx.validCategories.has(cat))) {
      return { category_id: cat, confidence: Math.min(0.92, 0.78 + 0.04 * Math.min(c.n, 3)), reason: `You categorised "${key}" like this ${c.n} time(s) before`, source: 'learned', business_pct: c.pct };
    }
  }

  for (const b of BUILTIN_RULES) {
    if (b.dir !== 'any' && b.dir !== dir) continue;
    if (b.re.test(text)) {
      return { category_id: b.category, confidence: b.conf, reason: b.why, source: 'builtin', business_pct: b.pct ?? 100 };
    }
  }

  if (dir === 'in') return { category_id: 'se_turnover', confidence: 0.4, reason: 'Money in – assumed to be business income; please check', source: 'fallback', business_pct: 100 };
  return { category_id: null, confidence: 0, reason: 'No match – choose a category', source: 'none', business_pct: 100 };
}
