# Ledgerline

Self-hosted accounts and tax preparation for UK **sole traders, landlords and small limited companies**. It reads your bank statements, invoices and receipts, sorts income and expenses into the right HMRC boxes, issues invoices (including recurring ones), and prepares the figures for your tax return – Self Assessment for individuals, or draft accounts, a Corporation Tax computation and CT600 figures for a company – all stored on **your own computer**.

> **Read this first.** Ledgerline *prepares* your return. It does **not** submit anything to HMRC and it is not tax advice. Individuals enter the figures in HMRC's online service or approved software. **Companies can't even do that**: HMRC's free company-return service closed on 31 March 2026, so a CT600 must be filed with HMRC-recognised commercial software (with iXBRL accounts and computations) or by an accountant – Ledgerline gives them everything they need, including a trial balance. See [What it doesn't do](#what-it-doesnt-do) and [How far to trust the numbers](#how-far-to-trust-the-numbers).

## Quick start

Requires **Node.js 22.13 or newer**.

```bash
npm install
npm start            # then open http://localhost:3000
```

Want to look around first? On the dashboard choose *Explore with demo data* (freelancer or app company), or `npm run demo` for the freelancer: a made-up freelance designer with a rental flat (two tax years of transactions, invoices, a recurring retainer, mileage, a share sale) and starts the app. Settings → Security & data → *Start again* wipes it.

| Command | What it does |
|---|---|
| `npm start` | Run the app (data in `./data`) |
| `npm test` | 126 unit/integration tests (tax engine, company accounts, importers, invoices, VAT, API) |
| `npm run e2e` | Browser test of the self-employed workflow (needs Playwright: `npm i -D playwright && npx playwright install chromium`) |
| `npm run e2e:company` | Browser test of the limited-company workflow |
| `npm run seed` / `npm run seed -- company` | Load demo data (a freelancer, or an app company) into an empty database |

## What it does

**Import – "put anything in, get transactions out"**

Drop files on the Import page or paste text. Ledgerline works out what each one is and finds the dates, amounts and descriptions *wherever they are on the page*:

| Input | How it's read |
|---|---|
| CSV, TSV, Excel (.xlsx) | Finds the header row even under preamble lines, maps columns by name (Monzo, Starling, Barclays, Lloyds, PayPal… layouts), copes with separate Debit/Credit columns, DR/CR markers, or guesses columns from the data when there's no header |
| OFX/QFX, QIF | Standard bank-download formats |
| PDF statements | Text is rebuilt with its page positions, so "Paid out / Paid in / Balance" columns are honoured. Where a statement has no signs, **the running balance is used to work out money in vs out** |
| PDF/Word/HTML/e-mail invoices and receipts | Finds vendor, invoice number, dates, net/VAT/total *anywhere* in the document, and decides whether it's a supplier's invoice (expense) or yours (income) from your name |
| Photos of receipts (JPG/PNG) | OCR runs **offline** (bundled English data) |
| Pasted text | Statement rows, an emailed invoice, or loose notes like "paid £45 to Screwfix on 3 March" |

Then, before anything is recorded:

- **Preview and edit** every row (date, description, category, flip money in/out). Nothing is saved until you press Record.
- **Categorised automatically** – your own rules first, then what you chose for the same merchant before, then a built-in UK merchant list. Each guess has a confidence; weak ones are recorded as *review* and **left out of your tax figures until you check them**.
- **Duplicates skipped** – re-import last month's statement and nothing doubles. Two genuinely identical coffees on one day are both kept.
- **Receipt ↔ bank line merging** – a receipt PDF and the bank line for the same purchase become one record carrying the VAT evidence; they're never counted twice.
- **Payments matched to invoices** – by invoice number or customer + amount – and the invoice is marked paid.
- **Transfers** between your own accounts are paired and ignored for profit.
- **Undo** any import.

**Invoicing** – customers, invoices with per-line VAT, credit notes, draft → issued → part-paid → paid/overdue, PDF download, email (optional), payment recording, who-owes-you ageing.

**Recurring invoices** – weekly/monthly/quarterly/yearly, "every N", end date or run count, and descriptions like *"Retainer for {month} {year}"*. Created as drafts, auto-issued, or auto-emailed. Missed periods are caught up with their proper dates and never duplicated; month-end schedules don't drift (31 Jan → 28 Feb → 31 Mar).

**Limited company mode** – choose "Limited company" on the dashboard or in Settings. Built for a company like two directors taking no salary, earning from subscriptions and ad/app-store income, with costs such as hosting and domains:

- **Accruals accounting** (companies can't use the cash basis). An annual plan paid up front, or a multi-year domain, can be marked as *covering a period* and is **spread by the day**, with deferred income / prepayments on the balance sheet.
- **Profit & loss account and balance sheet** (micro-entity layout) built from independent sources – bank balances, unpaid invoices, equipment, director's loans, VAT and tax owed – and **compared with the profit**. A gap is shown as an "unreconciled difference" with likely causes, never plugged.
- **Corporation Tax computation**: add back depreciation and non-deductible items, Annual Investment Allowance, losses brought forward, 19% / 25% with **marginal relief**, associated companies, short and over-12-month periods (split into two returns). **CT600 figures** with the verified box numbers, plus **CT600A** for director loans.
- **Directors**: each gets a director's-loan account. Overdrawn balances show the **s455 charge** (35.75% for loans made on/after 6 April 2026, 33.75% before) and the date to repay by.
- **Dividends** split by shareholding, blocked (unless you insist) when there isn't enough distributable profit, with **board minutes and dividend vouchers** to print, and a personal-tax estimate per director – with no salary, the Personal Allowance plus the £500 dividend allowance means about £13,070 each is tax-free.
- **Equipment** categorised as such becomes an asset, depreciated in the accounts and relieved with the AIA for tax.
- **VAT** codes for the digital-business cases: *Sale to overseas business* (outside UK VAT but in Box 6 – ad networks) and *Reverse charge* (hosting/domains/software from overseas suppliers: Boxes 1, 4, 6, 7).
- **UK-only users and ads:** a UK-only audience removes the overseas-consumer VAT problems (no EU/OSS registration, no per-country rates). Subscriptions sold to UK consumers are standard-rated at 20% once you are VAT registered. What it does *not* settle is VAT on **ad-network and app-store payouts**: that depends on which legal entity pays you (for example AdMob/AdSense payouts come from Google Ireland), not on where the users are. So Settings → Tax & VAT has a *Ad-network and app-store payouts* choice (not decided / overseas company / UK company), and until you choose, those bank rows get no VAT assumed and a **Check VAT** badge. Hosting, domain and software suppliers are still often overseas companies, so the reverse charge still applies to them.
- **Trial balance CSV**, draft accounts PDF, deadlines (Corporation Tax 9 months + 1 day, CT600 12 months, Companies House 9 months).
- Merchant recognition for AdMob/AdSense, App Store and Google Play payouts, Stripe/Paddle, AWS/Cloudflare/DigitalOcean, Namecheap/GoDaddy, GitHub and similar.

**Tax** (individuals; tax years 2023/24 – 2026/27, England/Wales/NI and Scotland)

- Worksheets mirroring **SA100, SA102, SA103, SA105, SA108** plus an SA110-style calculation, as screen and PDF, with **drill-down** from any figure to the transactions behind it.
- Income Tax (Personal Allowance taper, savings starting rate, Personal Savings Allowance, dividend allowance, Scottish bands, Gift Aid/pension band extension, Marriage Allowance), Class 2 & 4 NIC, student loans, High Income Child Benefit Charge, residential finance-cost relief (20%), trading and property allowances (auto-picked when they beat actual expenses), loss carry-forward, Capital Gains Tax, payments on account and the 31 January cash needed.
- Cash basis (default) or accruals; mileage log (45p/25p), use-of-home flat rate, capital allowances (AIA, writing-down, first-year, balancing charges).
- **VAT** nine-box return (standard or cash accounting), VAT registration threshold monitor.
- **Making Tax Digital** quarterly cumulative figures by HMRC category, with deadlines.

## What it doesn't do

Be clear-eyed about these before relying on it:

- **It does not file.** There is no HMRC API integration (that needs HMRC developer registration and production approval). Individuals copy the figures across. **A company cannot do even that**: the CT600 must go through HMRC-recognised commercial software with accounts and computations in **iXBRL**, which Ledgerline does not produce. Use the trial balance and draft pack with an accountant or filing software. Accounts for Companies House and the confirmation statement are also separate filings.
- **Partnerships (SA104), foreign income (SA106), trusts (SA107), residence/remittance (SA109)** are not covered, nor group companies, R&D relief (worth asking an accountant about if you develop software), or payroll (no PAYE/RTI – not needed while nobody is paid).
- **Company-mode gaps:** unpaid supplier bills at the year end (creditors) and other accruals aren't tracked – expenses count when paid, plus spreading; a first accounting period is assumed to start at incorporation (trading may start later); platform payouts are recorded as received (if Apple/Google take commission before paying you, record the gross and the fee, or just the net – be consistent); amounts in dollars/euros are flagged, not converted – enter the sterling amount that hit the bank.
- **No flat-rate VAT scheme**, no foreign-currency conversion (foreign amounts are flagged, not converted).
- Not handled: sideways trading-loss relief, Business Asset Disposal Relief, share pooling/matching, married-couple/blind allowances, Class 3, non-standard coding-out. Notes in the app say so where relevant.
- Under the accruals basis, purchases are recognised when paid (only sales invoices are accrued).
- Scanned PDFs with no text layer can't be read – upload a photo instead (OCR) or paste the text.

## How far to trust the numbers

**Tax calculations** are covered by hand-checked tests (e.g. £50,000 profit → £7,486 tax + £2,245.80 Class 4; the £100k–£125k allowance taper; Scottish bands; CGT rate change on 30 Oct 2024). Compare the estimate with HMRC's own calculation after you file.

**Rates and box numbers were cross-checked from search results, because gov.uk could not be reached from the environment this was built in.** Concretely:

- **Company figures:** Corporation Tax 19% / 25% with the 3/200 marginal-relief fraction and £50,000 / £250,000 limits (unchanged for 2026), the s455 rate change to 35.75% from 6 April 2026, the closure of HMRC's free CT600 service on 31 March 2026, and CT600 boxes **145, 155, 165, 475 and 510** were confirmed from search results; box 160 is inferred (†), and the other CT600 rows are listed by name without a box number. How the limits are shared between associated companies and scaled for short periods follows standard HMRC practice but wasn't independently re-verified. The micro-entity accounts wording is **draft** – have your accountant check it. VAT treatment of ad-network and app-store payouts for a UK company was **not** confirmed from any HMRC or platform source (Apple's and Google's own documents disagree on which entity acts for UK sales, and accountant forums conflict), which is why it is a setting you choose rather than a default. Check the payment documents in each platform's console, or ask an accountant, and whether such income counts towards the £90,000 registration threshold depends on the same answer.
- **Individuals (Self Assessment):** 2023/24–2025/26 rates are standard published figures. **2026/27 is marked "provisional"** in the app and in the PDF – in particular the Scottish bands (from the Scottish Budget 2026–27), Class 2 weekly rate / small-profits threshold, student-loan thresholds and the main-pool writing-down rate (14%). Check them against HMRC before filing.
- **Form box numbers:** the SA103F boxes 15–31 and 46 and SA105 boxes 20, 24, 26, 44, 45 were confirmed against HMRC's 2025–26 form listings. Boxes marked **†** are inferred from the form's numbering pattern, and boxes with no number are deliberately left blank. HMRC's online service asks for the same figures *by name*, so use the labels as your guide.
- All rates live in [`server/domain/taxRates.js`](server/domain/taxRates.js) and form layouts in [`server/domain/taxReturn.js`](server/domain/taxReturn.js). Updating for a new tax year is a data change, not an engine change.

## Configuration

Environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Interface. Leave as is unless you need network access – then **set a passcode** (Settings → Security & data) |
| `ALLOWED_HOSTS` | – | Extra hostnames you'll use to reach it (e.g. `books.home.lan`); other `Host` headers are refused |
| `LEDGER_DATA_DIR` | `./data` | Where the SQLite database and uploaded documents live |
| `SMTP_URL` | – | e.g. `smtps://user:pass@smtp.example.com` to email invoices. Never stored in the database |

## Your data and security

- Everything is one SQLite file plus the documents you upload, under `./data`. **Back it up** (Settings → Security & data → *Download full backup*). Keep records for 5 years after the 31 January filing deadline.
- Listens on `127.0.0.1` only by default. Optional passcode (scrypt-hashed, signed session cookie, rate-limited). Host-header allow-list (DNS-rebinding), cross-site write protection, strict Content-Security-Policy, uploads stored by hash and served as downloads.
- Nothing is sent anywhere – OCR and parsing are local. The only outbound traffic is email, if you configure `SMTP_URL`.
- Money is stored as integer pence; dates as ISO strings; every figure on a worksheet can be traced to its source rows.

## How it's built

No build step. Node 22 + Express, `node:sqlite`, and a Preact + htm front end served as plain files.

```
server/
  domain/        taxRates.js (data) · taxEngine.js (pure calc) · taxReturn.js (forms) · ledger.js (cash/accruals)
                 invoices.js · recurring.js · vat.js · capitalAllowances.js · categorizer.js · importService.js · reports.js
  importers/     parse.js (date/amount scanners) · extract.js (statement / document / notes) · table.js · pdf.js · ocr.js · formats.js
  routes/        thin HTTP handlers over the domain layer
  pdf/           invoices and worksheets
public/          the single-page app
test/            node:test suites      e2e/   Playwright workflow test
```

The ledger turns bank transactions, invoices, mileage and home-office claims into normalised entries, and *every* report and form reads from those, so a payment is never counted as both an invoice and a bank line.

## Disclaimer

Ledgerline is a bookkeeping and worksheet tool, not tax advice, and has not been approved or reviewed by HMRC. You are responsible for the accuracy of your return. If your affairs are complicated, ask an accountant.
