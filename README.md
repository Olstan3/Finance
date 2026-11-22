# Ledgerline

Self-hosted accounts and Self Assessment for UK sole traders and landlords. It reads your bank statements, invoices and receipts, sorts income and expenses into the right HMRC boxes, issues invoices (including recurring ones), and prepares the figures for your tax return – all stored on **your own computer**.

> **Read this first.** Ledgerline *prepares* your return. It does **not** submit anything to HMRC and it is not tax advice. You (or your accountant) enter the figures in HMRC's online service or approved software. See [What it doesn't do](#what-it-doesnt-do) and [How far to trust the numbers](#how-far-to-trust-the-numbers).

## Quick start

Requires **Node.js 22.13 or newer**.

```bash
npm install
npm start            # then open http://localhost:3000
```

Want to look around first? `npm run demo` loads a made-up freelance designer with a rental flat (two tax years of transactions, invoices, a recurring retainer, mileage, a share sale) and starts the app. Settings → Security & data → *Start again* wipes it.

| Command | What it does |
|---|---|
| `npm start` | Run the app (data in `./data`) |
| `npm test` | 99 unit/integration tests (tax engine, importers, invoices, VAT, API) |
| `npm run e2e` | Browser test of the whole workflow (needs Playwright: `npm i -D playwright && npx playwright install chromium`) |
| `npm run seed` | Load demo data into an empty database |

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

**Tax** (tax years 2023/24 – 2026/27, England/Wales/NI and Scotland)

- Worksheets mirroring **SA100, SA102, SA103, SA105, SA108** plus an SA110-style calculation, as screen and PDF, with **drill-down** from any figure to the transactions behind it.
- Income Tax (Personal Allowance taper, savings starting rate, Personal Savings Allowance, dividend allowance, Scottish bands, Gift Aid/pension band extension, Marriage Allowance), Class 2 & 4 NIC, student loans, High Income Child Benefit Charge, residential finance-cost relief (20%), trading and property allowances (auto-picked when they beat actual expenses), loss carry-forward, Capital Gains Tax, payments on account and the 31 January cash needed.
- Cash basis (default) or accruals; mileage log (45p/25p), use-of-home flat rate, capital allowances (AIA, writing-down, first-year, balancing charges).
- **VAT** nine-box return (standard or cash accounting), VAT registration threshold monitor.
- **Making Tax Digital** quarterly cumulative figures by HMRC category, with deadlines.

## What it doesn't do

Be clear-eyed about these before relying on it:

- **It does not file.** There is no HMRC API integration (that needs HMRC developer registration and production approval). You copy the figures across.
- **Individuals only.** No limited-company accounts or CT600, partnerships (SA104), foreign income (SA106), trusts (SA107) or residence/remittance (SA109).
- **No flat-rate VAT scheme**, no foreign-currency conversion (foreign amounts are flagged, not converted).
- Not handled: sideways trading-loss relief, Business Asset Disposal Relief, share pooling/matching, married-couple/blind allowances, Class 3, non-standard coding-out. Notes in the app say so where relevant.
- Under the accruals basis, purchases are recognised when paid (only sales invoices are accrued).
- Scanned PDFs with no text layer can't be read – upload a photo instead (OCR) or paste the text.

## How far to trust the numbers

**Tax calculations** are covered by hand-checked tests (e.g. £50,000 profit → £7,486 tax + £2,245.80 Class 4; the £100k–£125k allowance taper; Scottish bands; CGT rate change on 30 Oct 2024). Compare the estimate with HMRC's own calculation after you file.

**Rates and box numbers were cross-checked from search results, because gov.uk could not be reached from the environment this was built in.** Concretely:

- 2023/24–2025/26 rates are standard published figures. **2026/27 is marked "provisional"** in the app and in the PDF – in particular the Scottish bands (from the Scottish Budget 2026–27), Class 2 weekly rate / small-profits threshold, student-loan thresholds and the main-pool writing-down rate (14%). Check them against HMRC before filing.
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
