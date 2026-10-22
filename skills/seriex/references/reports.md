# SerieX Books: Reports

Reference for running, reading and saving SerieX Books reports through the local HTTP API,
and for pointing the user to the same report in the app. Everything below was checked
against a live server running the sample company ("Harborview Landscaping & Supply
(Sample)", today = 2026-10-20). All paths are company scoped: `BASE = http://127.0.0.1:<port>/api/c/<cid>`.

## Contents

1. [Quick start](#1-quick-start)
2. [Endpoints](#2-endpoints)
3. [Owner questions and the report that answers them](#3-owner-questions-and-the-report-that-answers-them)
4. [Report catalog (all 82 keys)](#4-report-catalog-all-82-keys)
5. [Parameters](#5-parameters)
6. [Response format and how to read it](#6-response-format-and-how-to-read-it)
7. [Drill-down: from an amount to the transactions](#7-drill-down-from-an-amount-to-the-transactions)
8. [CSV export, printing, display options](#8-csv-export-printing-display-options)
9. [Memorized reports](#9-memorized-reports)
10. [Audit trail (`GET /audit` and the `audit_trail` report)](#10-audit-trail)
11. [Customer statements (`GET /statements`)](#11-customer-statements)
12. [Errors](#12-errors)
13. [Gotchas](#13-gotchas)
14. [Where reports are in the app](#14-where-reports-are-in-the-app)

---

## 1. Quick start

```bash
BASE=http://127.0.0.1:47180/api/c/sample-harborview     # desktop app default port; see servers.json
curl -s "$BASE/reports" | jq '.[] | {key,title,category}'                 # catalog
curl -s "$BASE/reports/profit_loss?dates=lastMonth"                        # P&L for last month
curl -s "$BASE/reports/profit_loss?from=2026-01-01&to=2026-09-30&columns=month&basis=cash"
curl -s "$BASE/reports/balance_sheet?asOf=2026-09-30"
curl -s "$BASE/reports/ar_aging_summary?asOf=2026-10-20"
```

Net Income of a P&L, in one line:

```bash
curl -s "$BASE/reports/profit_loss?dates=lastMonth" \
 | jq '.rows[] | select(.kind=="grandtotal" and .cells.label=="Net Income") | .cells.total'
# -3676.62
```

All reports are read only. Running a report never changes data.

---

## 2. Endpoints

| Method + path | Purpose |
|---|---|
| `GET /reports` | Catalog: every report the server has (array of `ReportInfo`). |
| `GET /reports/{key}?<params>` | Run one report; returns a `ReportResult`. |
| `GET /memorized-reports` | List saved reports. |
| `POST /memorized-reports` | Save a report (name + key + params). |
| `PUT /memorized-reports/{id}` | Change a saved report (partial update). |
| `DELETE /memorized-reports/{id}` | Delete a saved report. |
| `GET /audit?from&to&user&txnId&action` | Raw audit log rows (administrator only). |
| `GET /statements?customerIds&from&to&statementDate&mode&includeZero` | Customer statement data. |
| `GET /budgets` | Budgets (needed for `budgetId` of the budget reports). |
| `GET /txns/{id}` | Open the transaction behind a report row (`txnId`). |

### `GET /reports` (catalog)

Returns `ReportInfo[]` in the order of the app's report list (category, then registration order):

```json
{"key":"ar_aging_summary","title":"A/R Aging Summary","category":"Customers and Invoices",
 "description":"How much does each customer owe, and how much of it is overdue?",
 "params":["asOf","agingInterval","filters"],"defaultDates":"today"}
```

- `params` says which parameter groups apply: `dates` (from/to range), `asOf` (one date),
  `basis`, `columns`, `filters` (the standard filters, section 5.6), `accountId`, `nameId`,
  `itemId`, `classId`, `budgetId`, `agingInterval`.
- `defaultDates` is the date preset used when the request has no `dates`, `from` or `to`.
- The catalog is fixed by the server version (it does not depend on company preferences).
  The app's report list (All Reports) hides some reports when a feature is off (class tracking, sales
  tax, inventory, purchase orders, estimates), but the API still runs them.

### `GET /reports/{key}`

- Unknown key: `404 {"code":"not_found","error":"Unknown report \"nope\""}`.
- `audit_trail` requires an administrator (otherwise `403 forbidden`).
- `account_quickreport`, `name_quickreport`, `item_quickreport` need an id (section 5.7),
  otherwise `400 validation`. These keys are only for requests: with the user, call these
  reports by their titles, "Account Activity", "Name Activity" (shown as "Customer Activity",
  "Vendor Activity"...) and "Item Activity".
- Every other key runs with no parameters at all (verified for all 82 keys).

---

## 3. Owner questions and the report that answers them

"Read" says where the number is in the response (section 6 explains rows and cells).

| Question | Request | Read |
|---|---|---|
| How much profit did I make this year / last month? | `profit_loss?dates=thisFiscalYearToDate` (or `dates=lastMonth`, or `from=&to=`) | row `kind=grandtotal`, `label="Net Income"`, cell `total` |
| Profit by month / quarter | `profit_loss?dates=thisFiscalYearToDate&columns=month` | one cell per month `p0..pN`, plus `total` |
| Profit compared with last year | `profit_loss_prev_year?from=2026-01-01&to=2026-09-30` | cells `cur`, `prev`, `chg`, `pct` |
| Profit compared with the previous period | `profit_loss_prev_period?dates=lastMonth` | same cells |
| Gross profit, total income, total expenses | `profit_loss?...` | rows `Gross Profit` (`kind=total`), `Total Income`, `Total COGS`, `Total Expense` (`kind=subtotal`) |
| Profit by class / by customer or job | `profit_loss_by_class`, `profit_loss_by_job` (or `profit_loss?columns=class` / `columns=customer`) | one column per class or job |
| How much cash do I have? | `balance_sheet?asOf=2026-10-20` | row `Total Checking/Savings` (bank-type accounts). Also `GET /accounts` (balance of each Bank account). |
| Where did my cash go? | `cash_flows?dates=thisFiscalYearToDate` | `Net cash provided by Operating/Investing/Financing Activities`, `Cash at end of period` |
| What do I own and owe? Net worth? | `balance_sheet?asOf=...` | `TOTAL ASSETS`, `Total Liabilities`, `Total Equity` |
| Who owes me money? | `ar_aging_summary` (as of today) | one row per customer or job; `grandtotal` row cell `total` = total A/R |
| Which invoices are overdue? | `ar_aging_detail` or `open_invoices`; with contacts: `collections` | data rows have `txnId`, `due`, `aging` (days overdue), `open` |
| Whom do I owe? | `ap_aging_summary`; bills list: `unpaid_bills_detail` | `grandtotal` cell `total` = total A/P |
| Sales by customer | `sales_by_customer_summary?dates=thisFiscalYearToDate` | rows per customer or job |
| Sales by item, margins | `sales_by_item_summary?dates=...` | `qty`, `amount`, `cogs`, `margin`, `marginpct` |
| Which customers are most profitable? | `income_by_customer_summary` (income minus expenses per customer or job) or `job_profitability_summary` | |
| Expenses by vendor | `expenses_by_vendor_summary?dates=...` | rows per vendor |
| Expenses by category (account) | `profit_loss?dates=...` (Expense section) or `custom_summary` | |
| Every transaction behind one expense account | `transaction_detail_by_account?accountIds=<id>&from=&to=` | data rows with `txnId` |
| General ledger for one account (with beginning balance) | `general_ledger?accountIds=<id>&from=&to=` or `account_quickreport?accountId=<id>&from=&to=` (includes subaccounts) | section row cell `balance` = beginning balance; `Total <account>` row = ending balance |
| How much sales tax do I owe? | `sales_tax_liability?dates=lastMonth` (or `from=&to=`) | cell `payable` (= balance owed as of `to`), `collected` (= collected in the period), per tax item and agency |
| What is my inventory worth? | `inventory_valuation_summary?asOf=...` | `grandtotal` cell `value` (equals the Inventory Asset balance) |
| What should I reorder? | `inventory_stock_status_by_item` | `order` cell is `"✓"` when on hand + on PO is at or below the reorder point |
| Anything uncategorized / "To Review with Accountant"? | `transaction_detail_by_account?dates=all&accountIds=<ids>` with the ids of "Uncategorized Income", "Uncategorized Expenses", "To Review with Accountant" (find them in `GET /accounts`) | one block per account; empty result = nothing to fix |
| Am I on budget? | `budget_vs_actual?budgetId=<id>&from=&to=&columns=total` (ids from `GET /budgets`) | cells `a_total` (actual), `b_total` (budget), `o_total` ($ over), `pct_total` (% of budget) |
| What did this transaction post? | `journal?txnId=<id>` | debit and credit lines of that one transaction |
| Who changed what? | `audit_trail?dates=...` or `GET /audit` | section 10 |
| How much did I pay each 1099 vendor? | `1099_summary?dates=lastFiscalYear` | |
| Missing or duplicate check numbers? | `missing_checks?accountId=<bank id>` | rows labeled `*** Missing numbers here ***` / `*** Duplicate document numbers ***` |
| What did each deposit contain? | `deposit_detail?dates=...` | |

---

## 4. Report catalog (all 82 keys)

Columns of each table:

- **Answers**: the question the report answers.
- **Default**: date preset used when no dates are sent (section 5.1).
- **Options**: parameters besides the standard filters (`dates` = from/to range, `asOf` = one date).
- **Filters**: the standard filters the report really applies (from the app's own list,
  spot-checked against the server). Letters: A accounts (`accountIds`), N names (`nameIds`
  + `includeJobs`), I items (`itemIds`), C classes (`classIds`), T transaction types (`types`),
  Cl cleared status (`cleared`), $ amount (`amountMin`/`amountMax`), M memo (`memo`),
  R number (`refNumber`), q text search (`q`). "all" = A N I C T Cl $ M R. A filter a report
  does not apply is **silently ignored** (no error).

### Financial Statements

| Key | Title | Answers | Default | Options | Filters |
|---|---|---|---|---|---|
| `profit_loss` | Profit and Loss | How much did I make or lose in a period? | thisMonthToDate | dates, basis, columns (period, `class`, `customer`) | A N I C T $ M R q, `noClass` |
| `profit_loss_detail` | Profit and Loss Detail | Which transactions make up income and expenses? | thisFiscalYearToDate | dates, basis | A N I C T $ M R q, `noClass` |
| `profit_loss_ytd` | Profit and Loss: Year-to-Date Comparison | This period next to fiscal year to date | thisMonthToDate | dates, basis | same as P&L |
| `profit_loss_prev_year` | Profit and Loss: This Year vs. Last Year | This period vs the same period last year ($ and % change) | thisFiscalYearToDate | dates, basis | same as P&L |
| `profit_loss_prev_period` | Profit and Loss: This Period vs. Last Period | This period vs the period just before, same length | thisMonthToDate | dates, basis | same as P&L |
| `profit_loss_by_job` | Profit and Loss by Job | How much did each customer or job make or lose? | thisFiscalYearToDate | dates, basis | same as P&L |
| `profit_loss_by_class` | Profit and Loss by Class | How much did each class make or lose? | thisFiscalYearToDate | dates, basis | same as P&L |
| `profit_loss_unclassified` | Profit and Loss: No Class | Income and expenses without a class | thisFiscalYearToDate | dates, basis, columns | A N I C T $ M R q |
| `income_by_customer_summary` | Income by Customer Summary | Net income (income minus expenses) per customer or job | thisFiscalYearToDate | dates, basis, columns (period only) | A N I C T $ M R q, `noClass` |
| `income_by_customer_detail` | Income by Customer Detail | The income and expense lines of each customer or job | thisFiscalYearToDate | dates, basis | same |
| `expenses_by_vendor_summary` | Expenses by Vendor Summary | Total expenses per vendor | thisFiscalYearToDate | dates, basis, columns (period only) | same |
| `expenses_by_vendor_detail` | Expenses by Vendor Detail | The expense lines of each vendor | thisFiscalYearToDate | dates, basis | same |
| `balance_sheet` | Balance Sheet | What do I own and owe, and my equity, as of a date? | thisFiscalYearToDate (as of its end) | asOf, basis, columns (period: one balance column per period end) | all + q, `noClass` |
| `balance_sheet_detail` | Balance Sheet Detail | Beginning balance, transactions and ending balance of every balance sheet account | thisMonthToDate | dates, basis | none |
| `balance_sheet_summary` | Balance Sheet Summary | Balance sheet totals by account type only | thisFiscalYearToDate | asOf, basis, columns | all + q |
| `balance_sheet_prev_year` | Balance Sheet: This Year vs. Last Year | Balances vs the same date last year | thisFiscalYearToDate | asOf, basis | all + q |
| `balance_sheet_prev_period` | Balance Sheet: This Period vs. Last Period | Balances vs the end of the previous period | thisMonthToDate | asOf, basis | all + q |
| `cash_flows` | Statement of Cash Flows | Cash in and out from operating, investing and financing | thisFiscalYearToDate | dates, columns (period) | none (basis ignored) |

### Customers and Invoices

| Key | Title | Answers | Default | Options | Filters |
|---|---|---|---|---|---|
| `ar_aging_summary` | A/R Aging Summary | How much does each customer owe, and how much is overdue? | today | asOf, `agingInterval`, `agingThrough` | N T C M R |
| `ar_aging_detail` | A/R Aging Detail | Which invoices are open, and how many days overdue? | today | asOf, `agingInterval`, `agingThrough`, `bucket` | N T C M R |
| `customer_balance_summary` | Customer Balance Summary | How much does each customer owe? | all | asOf | N |
| `customer_balance_detail` | Customer Balance Detail | Which invoices and payments make up each balance? | all | dates | N T M R |
| `open_invoices` | Open Invoices | Which invoices are unpaid or partly paid? | today | asOf | N T C M R |
| `collections` | Overdue Invoices with Contacts | Which customers are overdue, and how do I reach them? | today | asOf | N T C M R |
| `transaction_list_by_customer` | Transaction List by Customer | What did I enter for each customer? | thisFiscalYearToDate | dates | N T C $ M R |

### Sales

| Key | Title | Answers | Default | Options | Filters |
|---|---|---|---|---|---|
| `sales_by_customer_summary` | Sales by Customer Summary | Total sales per customer or job | thisMonthToDate | dates, basis, columns (period) | N I T M R |
| `sales_by_customer_detail` | Sales by Customer Detail | What did each customer buy, and when? | thisMonthToDate | dates, basis | N I T M R |
| `sales_by_item_summary` | Sales by Item Summary | Quantity, sales, COGS and gross margin per item | thisMonthToDate | dates, basis, `includeSubitems=0` | N I T M R |
| `sales_by_item_detail` | Sales by Item Detail | Which sales make up each item's total? | thisMonthToDate | dates, basis, `includeSubitems=0` | N I T M R |
| `sales_by_rep_summary` | Sales by Rep Summary | Total sales per sales rep | thisMonthToDate | dates, basis, columns (period) | N I T M R |
| `sales_by_rep_detail` | Sales by Rep Detail | Which sales did each rep make? | thisMonthToDate | dates, basis, `repId=<id>` or `repId=none` | N I T M R |
| `pending_sales` | Pending Sales | Which sales are marked pending? | all | dates | N M R |

### Jobs

| Key | Title | Answers | Default | Options | Filters |
|---|---|---|---|---|---|
| `job_profitability_summary` | Job Profitability Summary | Actual cost, revenue and difference per job | all | dates, basis | N |
| `job_estimates_vs_actuals_summary` | Job Estimates vs. Actuals Summary | Estimated vs actual cost and revenue per job | all | dates, basis | N |

### Vendors and Bills (includes sales tax reports)

| Key | Title | Answers | Default | Options | Filters |
|---|---|---|---|---|---|
| `1099_summary` | 1099 Summary | How much did I pay each 1099 vendor (checks and bill payments from bank accounts)? | lastFiscalYear | dates | A N |
| `1099_detail` | 1099 Detail | Which payments make up each 1099 vendor's total? | lastFiscalYear | dates | A N |
| `ap_aging_summary` | A/P Aging Summary | How much do I owe each vendor, and how much is overdue? | today | asOf, `agingInterval`, `agingThrough` | N T C M R |
| `ap_aging_detail` | A/P Aging Detail | Which bills are unpaid, and how many days overdue? | today | asOf, `agingInterval`, `agingThrough`, `bucket` | N T C M R |
| `vendor_balance_summary` | Vendor Balance Summary | How much do I owe each vendor? | all | asOf | N |
| `vendor_balance_detail` | Vendor Balance Detail | Which bills and payments make up each vendor balance? | all | dates | N T M R |
| `unpaid_bills_detail` | Unpaid Bills Detail | Which bills are unpaid, by vendor? | today | asOf | N T C M R |
| `transaction_list_by_vendor` | Transaction List by Vendor | What did I enter for each vendor? | thisFiscalYearToDate | dates | N T C $ M R |
| `sales_tax_liability` | Sales Tax Liability | Sales tax collected in the period and owed to each agency | lastMonth | dates, basis (not in catalog but accepted) | none |
| `sales_tax_revenue_summary` | Sales Tax Revenue Summary | Taxable and non-taxable sales per tax item | lastMonth | dates, basis (accepted) | none |
| `sales_tax_sales_detail` | Sales Tax Sales Detail | Which sales make up each tax item's totals? | lastMonth | dates, `taxItemIds` (`-2` = no tax item), `show=sales\|nontax\|taxable` | none |

### Purchases

| Key | Title | Answers | Default | Options | Filters |
|---|---|---|---|---|---|
| `purchases_by_vendor_summary` | Purchases by Vendor Summary | How much did I buy from each vendor? | thisMonthToDate | dates, basis, columns (period) | N I T M R |
| `purchases_by_vendor_detail` | Purchases by Vendor Detail | Which items did I buy from each vendor? | thisMonthToDate | dates, basis | N I T M R |
| `purchases_by_item_summary` | Purchases by Item Summary | Quantity and cost purchased per item | thisMonthToDate | dates, basis | N I T M R |
| `purchases_by_item_detail` | Purchases by Item Detail | Which purchases make up each item's total? | thisMonthToDate | dates, basis | N I T M R |
| `open_purchase_orders` | Open Purchase Orders | Which purchase orders are still open? | all | dates | N I M R |
| `open_purchase_orders_detail` | Open Purchase Orders Detail | Which items are still on order, by vendor? | all | dates | N I M R |

### Inventory

| Key | Title | Answers | Default | Options | Filters |
|---|---|---|---|---|---|
| `inventory_valuation_summary` | Inventory Valuation Summary | What is my inventory worth (quantity, average cost, value)? | today | asOf | I |
| `inventory_valuation_detail` | Inventory Valuation Detail | Which transactions changed inventory value? | thisMonthToDate | dates, `itemId` | I |
| `inventory_stock_status_by_item` | Inventory Stock Status by Item | On hand, on order, reorder point; do I need to reorder? | thisMonthToDate (used for Sales/Week) | dates | I |
| `inventory_stock_status_by_vendor` | Inventory Stock Status by Vendor | Same, grouped by preferred vendor | thisMonthToDate | dates | I |
| `physical_inventory_worksheet` | Physical Inventory Worksheet | A counting sheet with quantity on hand | today | none | none |

### Banking

| Key | Title | Answers | Default | Options | Filters |
|---|---|---|---|---|---|
| `deposit_detail` | Deposit Detail | Which payments make up each deposit? | thisMonthToDate | dates | A N $ M R |
| `check_detail` | Check Detail | What did each check pay for? | thisMonthToDate | dates | A N $ M R |
| `missing_checks` | Missing Checks | Are check numbers missing or used twice? | all | `accountId` (default: first active bank account by name), dates | none |

### For Your Accountant

| Key | Title | Answers | Default | Options | Filters |
|---|---|---|---|---|---|
| `trial_balance` | Trial Balance | Debit or credit balance of every account as of the To date | thisMonthToDate (as of its end) | dates (only `to` matters), basis | all + q, `noClass` |
| `general_ledger` | General Ledger | Beginning balance, transactions, running balance of every account | thisMonthToDate | dates, basis, `cols` | all + q, `plOnly`, `noClass` |
| `journal` | Journal | Every transaction with its debits and credits | thisMonthToDate | dates, `txnId` (one transaction) | all + q, `plOnly`, `noClass` |
| `transaction_detail_by_account` | Transaction Detail by Account | Transactions grouped by account with a running total | thisMonthToDate | dates, basis, `cols` | all + q, `plOnly`, `noClass` |
| `transaction_list_by_date` | Transaction List by Date | Every transaction in the period, one line each | thisMonthToDate | dates, `cols` | all + q |
| `audit_trail` | Audit Trail | Transactions added, changed, voided or deleted, with history | thisMonthToDate | dates (by date entered or changed), `user` | none (admin only) |
| `account_quickreport` | Account Activity | Transactions of one account and its subaccounts | all | `accountId` (required), dates, basis | none offered |
| `custom_summary` | Custom Summary Report | Income and expenses by account, customer or job, vendor, item or class | thisMonthToDate | dates, basis, columns, `rows` | A N I C T $ M R q, `noClass` |
| `custom_transaction_detail` | Custom Transaction Detail Report | Transaction lines with chosen columns, filters and grouping | thisMonthToDate | dates, basis, `cols`, `totalBy` | all + q, `plOnly`, `noClass` |

### Budgets

| Key | Title | Answers | Default | Options | Filters |
|---|---|---|---|---|---|
| `budget_overview` | Budget Overview | Budgeted amounts by account and month | budget's fiscal year | `budgetId`, dates, columns (default `month`), `classId`, `nameId` | — |
| `budget_vs_actual` | Budget vs. Actual | Actual vs budget, $ over budget, % of budget | budget's fiscal year | `budgetId`, dates, columns (default `month`), basis, `classId`, `nameId` | — |
| `profit_loss_budget_performance` | Budget Progress (Profit and Loss) | This period and year to date, actual vs budget, plus annual budget | thisMonthToDate | `budgetId`, dates, basis, `classId`, `nameId` | — |

### Lists

All take no parameters; the date in the header is today.

| Key | Title | Answers |
|---|---|---|
| `account_listing` | Account Listing | Chart of accounts with type, balance, description, tax line |
| `item_listing` | Item Listing | Items with cost, price, tax code, on hand, on PO, reorder point, vendor |
| `item_price_list` | Item Price List | Price of each item |
| `terms_listing` | Terms Listing | Payment terms |
| `customer_phone_list` | Customer Phone List | Customer phone numbers |
| `customer_contact_list` | Customer Contact List | Customer contacts, addresses, balances |
| `vendor_phone_list` | Vendor Phone List | Vendor phone numbers |
| `vendor_contact_list` | Vendor Contact List | Vendor contacts, addresses, balances |
| `other_names_phone_list` | Other Names Phone List | Phone numbers of other names |

### Activity Reports (opened from lists, not shown in All Reports)

| Key | Title | Answers | Default | Options | Filters |
|---|---|---|---|---|---|
| `name_quickreport` | Name Activity (title becomes "Customer Activity", "Vendor Activity", ...) | All transactions of one customer (with jobs), vendor or other name | all | `nameId` (required), dates | — (none offered in the app) |
| `item_quickreport` | Item Activity | All transactions that use one item (purchases, sales...) | all | `itemId` (required), dates | — |

---

## 5. Parameters

All parameters are query-string values. Ids are integers; lists are comma separated
(`accountIds=40,44`). Dates are `YYYY-MM-DD` only (`10/01/2026` is rejected).
Unknown parameters are ignored and echoed back in `params`.

### 5.1 Date range: `dates`, `from`, `to`

Resolution order:

1. If `from` or `to` is present (even empty), the preset is ignored.
   - `from` empty or missing means "from the beginning".
   - `to` missing or empty: `to = today`; but `from=X` with no `to` gives `to = 9999-12-31`
     (header "January 1, 2026 through December 31, 9999"). **Always send both.**
2. Else `dates=<preset>`; else the report's `defaultDates`; else `thisMonthToDate`.
3. An unknown preset (including the app's own `dates=custom`) behaves like `thisMonthToDate`.
4. `from` after `to` gives `400 "The From date must be on or before the To date."`.

Presets (weeks start Sunday; quarters and years follow the fiscal year start month in
company settings). Values resolved by the live server with today = 2026-10-20 (Tuesday),
fiscal year starting in January:

| Preset | From | To | Preset | From | To |
|---|---|---|---|---|---|
| `all` | (none) | today 2026-10-20 | `lastWeek` | 2026-10-11 | 2026-10-17 |
| `today` | 2026-10-20 | 2026-10-20 | `lastWeekToDate` | 2026-10-11 | 2026-10-13 |
| `yesterday` | 2026-10-19 | 2026-10-19 | `lastMonth` | 2026-09-01 | 2026-09-30 |
| `thisWeek` | 2026-10-18 | 2026-10-24 | `lastMonthToDate` | 2026-09-01 | 2026-09-20 |
| `thisWeekToDate` | 2026-10-18 | 2026-10-20 | `lastFiscalQuarter` | 2026-07-01 | 2026-09-30 |
| `thisMonth` | 2026-10-01 | 2026-10-31 | `lastFiscalQuarterToDate` | 2026-07-01 | 2026-07-20 |
| `thisMonthToDate` | 2026-10-01 | 2026-10-20 | `lastFiscalYear` | 2025-01-01 | 2025-12-31 |
| `thisFiscalQuarter` | 2026-10-01 | 2026-12-31 | `lastFiscalYearToDate` | 2025-01-01 | 2025-10-20 |
| `thisFiscalQuarterToDate` | 2026-10-01 | 2026-10-20 | `nextWeek` | 2026-10-25 | 2026-10-31 |
| `thisFiscalYear` | 2026-01-01 | 2026-12-31 | `nextFourWeeks` | 2026-10-25 | 2026-11-21 |
| `thisFiscalYearToDate` | 2026-01-01 | 2026-10-20 | `nextMonth` | 2026-11-01 | 2026-11-30 |
| | | | `nextFiscalQuarter` / `nextFiscalYear` | 2027-01-01 | 2027-03-31 / 2027-12-31 |

- `dates=all` ends **today**, so future-dated transactions are left out. For everything,
  send `from=&to=9999-12-31`.
- `today=YYYY-MM-DD` overrides "today" for preset resolution (handy to ask "last month as
  of March 15": `dates=lastMonth&today=2026-03-15`). The app never sends it.
- The resolved dates are always in the response: `params.from`, `params.to`, `params.asOf`
  and the human header `dateRangeLabel`.

### 5.2 As-of date: `asOf`

For reports whose catalog params contain `asOf` (balance sheets, aging, balances, open
invoices, unpaid bills, inventory valuation summary, collections).

- `asOf=YYYY-MM-DD`. If missing, `asOf = to` (so `to=2026-06-30` or `dates=lastMonth` also
  work: `ar_aging_summary?dates=lastMonth` is "as of 2026-09-30").
- Invalid: `400 {"code":"validation","field":"asOf","error":"Invalid date \"...\""}`.
- On aging/balance reports the echoed `params.from/to` may still show today's preset; only
  `asOf` matters there.
- `trial_balance` uses `to` (or `asOf`) only; its `from` is ignored and the header says "As of".

### 5.3 Accounting basis: `basis`

- `basis=accrual` or `basis=cash`. Anything else falls back to the company preference
  (Edit > Preferences > Reports, `prefs.reportBasis`, default accrual).
- Only reports whose catalog params include `basis` honor it, plus the three sales tax
  reports (whose default comes from the **sales tax** preference `salesTaxBasis`, not the
  report preference).
- `cash_flows` always uses accrual postings; `journal`, `transaction_list_by_date`,
  aging/balance/banking/inventory/list reports have no basis.
- Cash basis in plain words: invoices, bills, credit memos, vendor credits and item receipts
  count only when (and in the share) they are paid or credited, on the payment's date.
  A/R and A/P then only keep unapplied amounts. Response field `basis` says
  `"Accrual Basis"` or `"Cash Basis"` (empty for reports without a basis).

### 5.4 Columns: `columns`

| Value | Meaning | Reports |
|---|---|---|
| `total` (or missing) | one amount column | all with `columns` |
| `week`, `month`, `quarter`, `year` | one column per period inside the range, plus `total` when there are 2 or more | P&L family with `columns`, `custom_summary`, `cash_flows`, income/expenses/sales/purchases/rep summaries, budgets |
| `class` | one column per class (+ `No Class`) + `TOTAL` | `profit_loss`, `custom_summary` (rows by account) |
| `customer` | one column per customer or job (+ `Not Specified`) + `TOTAL` | `profit_loss`, `custom_summary` (rows by account) |

- Column keys: periods `p0, p1, ...`; class `c<classId>` and `c0` (No Class);
  customer `n<nameId>`, `nt<customerId>` ("Total <customer>" when it has jobs), `n0`
  (Not Specified); single column `total`.
- Period labels: whole months `"Jul 26"`, quarters `"Jul - Sep 26"`, partial periods
  `"Oct 1 - 20, 26"`.
- Balance sheet with periods: one balance column per period end (`"Mar 31, 26"`); the first
  period starts at `from` (with only `asOf`, at the fiscal year start of `asOf`).
- A summary with a single period (e.g. `columns=quarter` over one quarter) has only `p0`
  and no `total` column.
- `columns=vendor` / `item` (mentioned in a code comment) are **not** implemented; any
  other value behaves like `total`. Rows by vendor/item/class are done with
  `custom_summary?rows=...`.
- The title changes with columns on `profit_loss`: `columns=class` gives "Profit and Loss by
  Class", `columns=customer` gives "Profit and Loss by Job".

### 5.5 Comparisons

Comparisons are separate report keys (the app's "Compare to" box switches keys):

| Base | Previous period | Same period / date last year | Year to date |
|---|---|---|---|
| `profit_loss` | `profit_loss_prev_period` | `profit_loss_prev_year` | `profit_loss_ytd` |
| `balance_sheet` | `balance_sheet_prev_period` | `balance_sheet_prev_year` | — |

- Cells: `cur`, `prev`, `chg` ($ change = cur − prev), `pct` (% change); YTD: `cur`, `ytd`.
- `pct` = (cur − prev) / |prev| × 100, one decimal; **100 (or −100) when prev is 0**, 0 when both are 0.
- P&L previous period: a whole-month range (month, quarter, year) compares with the same
  number of whole months just before; otherwise the same number of days just before
  (Oct 1–20 compares with Sep 11–30).
- Balance sheet previous period: the day before the period's `from` (this month to date
  compares with last month end); with only `asOf`, one month earlier (a month end compares
  with the previous month end).
- Budget comparisons: `budget_vs_actual` (cells `a_<p>`, `b_<p>`, `o_<p>` = actual − budget,
  `pct_<p>` = actual / budget × 100, null when budget is 0; `<p>` is `p0..` or `total`) and
  `profit_loss_budget_performance` (`cur`, `bcur`, `ytd`, `bytd`, `annual`).

### 5.6 Standard filters

| Parameter | Value | Meaning |
|---|---|---|
| `accountIds` | ids | Only these accounts. **Exact ids: subaccounts are NOT included** (filtering on a parent account with no own postings returns nothing). List every subaccount id. |
| `nameIds` | ids | Only these customers/vendors/other names. Jobs of a listed customer are included unless `includeJobs=0`. |
| `includeJobs` | `0` / `1` (default 1) | See above. |
| `itemIds` | ids | Only lines with these items. Ledger reports (P&L, GL, ...): exact ids. Sales/purchase/inventory reports: sub-items included (turn off with `includeSubitems=0` on sales by item). |
| `classIds` | ids | Only these classes (exact ids). Alias `classId` on ledger and budget reports. |
| `noClass` | `1` | Only lines without a class ("No class only"). |
| `noCustomer` | `1` | Only lines without a customer or job. |
| `plOnly` | `1` | Income and expense accounts only (GL, journal, transaction detail, custom detail). |
| `types` | codes | Transaction types: `INV` invoice, `SALESRCPT` sales receipt, `PMT` customer payment, `CREDMEM` credit memo, `STMTCHG` statement charge, `EST` estimate, `DEP` deposit, `CHK` check, `REFUND` refund, `BILL` bill, `BILLCRED` vendor credit, `BILLPMT` bill payment, `ITEMRCPT` item receipt, `PURCHORD` purchase order, `CCCHARGE` credit card charge, `CCCREDIT` credit card credit, `TRANSFER` transfer, `GENJRNL` journal entry, `INVADJ` inventory adjustment, `TAXPMT` sales tax payment. |
| `cleared` | `cleared`, `uncleared`, `reconciled` | Bank/credit card cleared status (`reconciled` = reconciled only; ledger reports). Income and expense lines are never cleared. |
| `amountMin`, `amountMax` | number | Transaction total between these (absolute value). |
| `memo` | text | Memo contains (case-insensitive). |
| `refNumber` | text | Transaction number contains. |
| `q` | text | Number, memo or name contains (ledger reports only). |
| `vendorIds`, `customerIds` | ids | Attribution as in the vendor/customer reports (used by drill-downs; `customerIds` includes jobs). |

Examples verified on the sample company (Jan 1 – Oct 20, 2026, Net Income 37,955.27 unfiltered):
`classIds=35` → 44,637.95; `nameIds=22` (customer with jobs) → 17,649.03; `nameIds=22&includeJobs=0` → 8,194.27;
`accountIds=40,44` → only Rent and Utilities; `accountIds=34` (parent "Insurance Expense") → nothing;
`types=CHK&amountMin=1000` → checks of 1,000 or more only.

### 5.7 Report-specific parameters

| Parameter | Reports | Meaning |
|---|---|---|
| `accountId` | `account_quickreport` (required; includes subaccounts), `missing_checks` | Account id. |
| `nameId` | `name_quickreport` (required); budgets (customer or job filter) | Name id. |
| `itemId` | `item_quickreport` (required), `inventory_valuation_detail` | Item id (sub-items included). |
| `classId` | budget reports | Class filter for budget lines and actuals. |
| `budgetId` | budget reports | Budget id from `GET /budgets`. Missing: the latest budget (by fiscal year) is used; with no budget the report has one text row "No budgets yet. Create one with Budgets in the Company menu." Unknown id: `404 "Budget 99 not found"`. A balance sheet budget on `budget_vs_actual`: `400`. When no dates are sent, the budget's fiscal year is used. Response `params` adds `budgetId` and `budgetName`. |
| `agingInterval` | A/R and A/P aging | Days per aging column (default 30). |
| `agingThrough` | A/R and A/P aging | Last aging column, in days past due (default 90; at most 36 columns). `agingInterval=15&agingThrough=60` gives `current, d1 (1-15), d2 (16-30), d3 (31-45), d4 (46-60), over (> 60), total`. |
| `bucket` | `ar_aging_detail`, `ap_aging_detail` | Only one aging column: `current`, `d1`, `d2`, ..., `over`. |
| `cols` | `general_ledger`, `transaction_detail_by_account`, `custom_transaction_detail`, `transaction_list_by_date` | Comma list, in order, of: `trans`, `type`, `date`, `num`, `name`, `memo`, `account`, `class`, `item`, `clr`, `split`, `debit`, `credit`, `amount`, `balance`. Unknown keys are dropped; empty means the default set. |
| `totalBy` | `custom_transaction_detail` | `account` (default), `name`, `class`, `type`, `item`, `none` (one flat list). |
| `rows` | `custom_summary` | `account` (default: P&L layout), `customer`, `vendor`, `item`, `class`. Non-account rows show net income per row (income positive, expenses negative); `columns` then only accepts periods. |
| `repId` | `sales_by_rep_detail` | One sales rep id, or `none` for sales without a rep. |
| `includeSubitems` | sales by item reports | `0` = the listed item only. |
| `taxItemIds`, `show` | `sales_tax_sales_detail` | Tax item ids (`-2` = sales without a tax item); `show=sales|nontax|taxable` keeps only transactions with that kind of amount. |
| `txnId` | `journal` | One transaction ("Transaction Journal"); dates are ignored. |
| `user` | `audit_trail` | Only changes by this user name (case-insensitive). |
| `netTotal`, `plTo` | `transaction_detail_by_account` | Set by drill-downs from Retained Earnings and equity totals; do not set by hand. |

### 5.8 What the server does NOT do

These are display options handled only by the app (stored as `ui.*` keys in memorized
report params; the server ignores them):

- **Sorting** (`ui.sort`; a code comment mentions `sortBy`, but the server never reads it).
  Sort the rows yourself.
- **Show / hide zero rows**: the ledger reports never return accounts whose amounts are all
  zero; there is no server switch to include them. The app's "Hide rows where every amount is
  zero" (`ui.hz`) and "Leave zero amounts blank" (`ui.bz`) are display-only.
- **Totals only / collapse**: done in the app (`ui.collapse`). Over the API, keep rows with
  `kind` in `subtotal|total|grandtotal`, or use a summary report (`balance_sheet_summary`).
- Hiding columns on summary reports (`ui.hide`), number format (`ui.neg`, `ui.red`, `ui.k`
  thousands, `ui.nc` no cents), custom title/subtitle/footer.
- There is no "include inactive" option.

---

## 6. Response format and how to read it

```
ReportResult {
  key, title, companyName,
  dateRangeLabel   "September 1 through September 30, 2026" | "As of June 30, 2026" | "All Transactions through ..." | ""
  basis            "Accrual Basis" | "Cash Basis" | ""
  columns: [{key, label, type}]      type: text | money | number | date | percent
  rows:    [{kind, level, cells, txnId?, drill?, cellDrills?, group?}]
  params:  {resolved parameters as strings: from, to, asOf, basis, columns?, plus everything sent}
  generatedAt      UTC timestamp
}
```

- **columns**: the first column is always `label` (row label, text). The rest are keyed;
  `label` of a column is its header ("Sep 26", "Budget", "1 - 30").
- **rows[].kind**:
  - `section`: a heading that opens a group (no amounts, except detail reports where the
    section row of an account carries the beginning balance in `cells.balance`);
  - `data`: an account, name, item or transaction line;
  - `subtotal`: closes a section ("Total Income", "Total Checking/Savings", "Total Abbott, Rachel");
  - `total`: a major computed total (`Gross Profit`, `Net Operating Income`, `Net Other Income`,
    `Net cash increase for period`);
  - `grandtotal`: the bottom line (`Net Income`, `TOTAL ASSETS`, `TOTAL LIABILITIES & EQUITY`,
    `TOTAL`, `Cash at end of period`);
  - `blank`: spacer row (banking reports).
- **level**: indentation depth of the label (0 = left).
- **group**: id shared by a section, its children and its subtotal (for collapsing).
- **cells**: object keyed by column key. Money is a JSON number in dollars, rounded to cents
  (`12991.9`, `-3676.62`). Percent is a number meaning percent (`48.53` = 48.53%), `null` when
  it cannot be computed. Dates are `"YYYY-MM-DD"` strings or `null`. Quantities are numbers.
  A cell can be missing or `null` (e.g. `credit` is `null` on a debit line; `aging` is missing
  on items that are not overdue; summary rows of detail reports only have totals).
- Rows are already in display order; parent accounts with active subaccounts appear as
  `section` + children + `"<Parent> - Other"` (the parent's own postings) + `"Total <Parent>"`.
  Customers with jobs, items with sub-items and classes with subclasses follow the same pattern.
- `rows` is never null (an empty report has `[]` or only a zero `TOTAL` row).

### Sign conventions

- P&L style reports: amounts in their **normal sign**: income positive, expenses positive,
  COGS positive; contra lines are negative (Sales Discounts, Purchase Discounts).
  Net Income negative = loss.
- Balance sheet: assets, liabilities and equity positive in their normal sign
  (Accumulated Depreciation and Owners Draw show negative).
- `custom_summary` with `rows` other than account, `income_by_customer_summary`: net income
  (income +, expense −). `expenses_by_vendor_summary`: expenses positive.
- Detail reports (`transaction_detail_by_account`, `general_ledger`, `account_quickreport`):
  `amount` is in the account's normal sign (for a bank account, deposits +, checks −);
  `debit` / `credit` are positive or null.
- Aging and open balances: positive = owed; credits and unapplied payments negative.

### Finding a specific number

Labels of structure rows are fixed English strings; labels of account rows depend on
preferences (with account numbers on they look like `"6100 · Rent Expense"`; preference
"report account display" can show descriptions), so identify accounts by the ids in their
drill-down (`drill.params.accountIds`) rather than by label.

| Number | Report | Row (kind, label) | Cell |
|---|---|---|---|
| Net Income | `profit_loss` | grandtotal, `Net Income` | `total` (or each period key) |
| Gross Profit | `profit_loss` | total, `Gross Profit` | `total` |
| Total income / COGS / expenses | `profit_loss` | subtotal, `Total Income` / `Total COGS` / `Total Expense` / `Total Other Income` / `Total Other Expense` | `total` |
| Cash in bank | `balance_sheet` | subtotal, `Total Checking/Savings` | `total` |
| A/R, A/P on the balance sheet | `balance_sheet` | subtotal, `Total Accounts Receivable`, `Total Accounts Payable` | `total` |
| Total assets / liabilities / equity | `balance_sheet` | grandtotal `TOTAL ASSETS`; subtotal `Total Liabilities`, `Total Equity` | `total` |
| This year's profit on the balance sheet | `balance_sheet` | data, `Net Income` (fiscal year to date) | `total` |
| Total owed to me | `ar_aging_summary` | grandtotal, `TOTAL` | `total` (buckets `current`, `d1`..., `over`) |
| Total I owe | `ap_aging_summary` | grandtotal, `TOTAL` | `total` |
| Ending cash | `cash_flows` | grandtotal, `Cash at end of period` | `total` |
| Inventory value | `inventory_valuation_summary` | grandtotal, `TOTAL` | `value` |
| Sales tax owed | `sales_tax_liability` | grandtotal, `TOTAL` | `payable` |
| Trial balance totals | `trial_balance` | grandtotal, `TOTAL` | `debit`, `credit` |

Sections are omitted when empty: a P&L with no other income/expense has no
"Other Income/Expense" rows; `Net Income` is always present.

### Real response: Profit and Loss, September 2026 (trimmed)

`GET /reports/profit_loss?from=2026-09-01&to=2026-09-30` returned 39 rows; 9 kept, some
drills shortened to `{"...": "..."}`.

```json
{
 "key": "profit_loss",
 "title": "Profit and Loss",
 "companyName": "Harborview Landscaping & Supply (Sample)",
 "dateRangeLabel": "September 1 through September 30, 2026",
 "basis": "Accrual Basis",
 "columns": [
  {"key": "label", "label": "", "type": "text"},
  {"key": "total", "label": "Sep 26", "type": "money"}
 ],
 "rows": [
  {"kind": "section", "level": 0, "cells": {"label": "Operating Income and Expense"}, "group": "g1"},
  {"kind": "section", "level": 1, "cells": {"label": "Income"}, "group": "g2"},
  {"kind": "data", "level": 2, "cells": {"label": "Delivery Income", "total": 75},
   "drill": {"report": "transaction_detail_by_account",
             "params": {"accountIds": "49", "basis": "accrual", "from": "2026-09-01", "to": "2026-09-30"}},
   "group": "g2",
   "cellDrills": {"total": {"report": "transaction_detail_by_account",
             "params": {"accountIds": "49", "basis": "accrual", "from": "2026-09-01", "to": "2026-09-30"}}}},
  {"kind": "section", "level": 2, "cells": {"label": "Landscaping Services"}, "group": "g3"},
  {"kind": "data", "level": 3, "cells": {"label": "Design Services", "total": 1615}, "drill": {"...": "..."}, "group": "g3"},
  {"kind": "subtotal", "level": 2, "cells": {"label": "Total Landscaping Services", "total": 12991.9},
   "drill": {"report": "transaction_detail_by_account",
             "params": {"accountIds": "18,19,20,21,48", "basis": "accrual", "from": "2026-09-01", "to": "2026-09-30"}},
   "group": "g3"},
  {"kind": "subtotal", "level": 1, "cells": {"label": "Total Income", "total": 13066.9}, "drill": {"...": "..."}, "group": "g2"},
  {"kind": "total", "level": 1, "cells": {"label": "Gross Profit", "total": 3445.09},
   "drill": {"report": "profit_loss_detail",
             "params": {"accountIds": "18,19,20,21,22,23,24,25,26,27,28,48,49,50,51,52", "basis": "accrual",
                        "from": "2026-09-01", "to": "2026-09-30"}},
   "group": "g1"},
  {"kind": "grandtotal", "level": 0, "cells": {"label": "Net Income", "total": -3676.62},
   "drill": {"report": "profit_loss_detail", "params": {"accountIds": "18,19,...,56", "basis": "accrual",
             "from": "2026-09-01", "to": "2026-09-30"}}}
 ],
 "params": {"asOf": "2026-09-30", "basis": "accrual", "from": "2026-09-01", "to": "2026-09-30"},
 "generatedAt": "2026-10-21T02:41:14Z"
}
```

The full row list of that report, as `kind level label total`:

```
section 0 Operating Income and Expense
section 1 Income
data 2 Delivery Income 75
section 2 Landscaping Services
data 3 Design Services 1615 | Installation Services 3695 | Maintenance Services 4925 | Materials Sales 2756.9
subtotal 2 Total Landscaping Services 12991.9
subtotal 1 Total Income 13066.9
section 1 Cost of Goods Sold ... subtotal 1 Total COGS 9621.81
total 1 Gross Profit 3445.09
section 1 Expense ... subtotal 1 Total Expense 7177.36
total 0 Net Operating Income -3732.27
section 0 Other Income/Expense / section 1 Other Income / data 2 Interest Income 55.65 / subtotal 1 Total Other Income 55.65
total 0 Net Other Income 55.65
grandtotal 0 Net Income -3676.62
```

### Shape of the other report families (verified)

- **Balance sheet**: `ASSETS` > `Current Assets` > `Checking/Savings`, `Accounts Receivable`,
  `Other Current Assets` > `Total Current Assets`; `Fixed Assets`; `Other Assets`;
  `TOTAL ASSETS`; `LIABILITIES & EQUITY` > `Liabilities` > `Current Liabilities` >
  `Accounts Payable`, `Credit Cards`, `Other Current Liabilities`; `Long Term Liabilities`;
  `Total Liabilities`; `Equity` (equity accounts, `Retained Earnings`, `Net Income`);
  `Total Equity`; `TOTAL LIABILITIES & EQUITY`. Retained Earnings includes all prior years'
  net income; Net Income is the fiscal year to date. On the cash basis A/R and A/P drop out.
- **Cash flows**: `OPERATING ACTIVITIES` (`Net Income`, then "Adjustments to reconcile Net
  Income..." with A/R, other current assets, A/P, credit cards, other current liabilities),
  `INVESTING ACTIVITIES` (fixed and other assets), `FINANCING ACTIVITIES` (long term
  liabilities, equity), `Net cash increase for period`, `Cash at beginning of period`,
  `Cash at end of period`. "Cash" means Bank-type accounts only (Undeposited Funds is an
  operating adjustment).
- **Trial balance**: one `data` row per account with `debit` or `credit` (the other is null),
  a computed `Retained Earnings` row when needed, `TOTAL`.
- **Aging summary**: one row per customer (jobs nested), cells `current`, `d1..dN`, `over`,
  `total`. **Aging detail**: sections per aging column, data rows with `txnId`, `type`,
  `date`, `num`, `name`, `terms`, `due`, `aging` (days past due; missing when not overdue),
  `open`. Aging counts from the due date (preference "aging from" can switch to the
  transaction date); documents without a due date (credit memos) age from their date.
- **Detail reports** (`profit_loss_detail`, `general_ledger`, `transaction_detail_by_account`,
  `account_quickreport`, `balance_sheet_detail`): per account a `section` (beginning balance
  in `cells.balance` for GL, account activity and balance sheet detail), `data` rows with
  `txnId`, a `subtotal` "Total <account>" (`amount`, `debit`, `credit`, `balance` = ending),
  and a `grandtotal`. `transaction_detail_by_account` has **no beginning balance**: its
  `balance` is a running total starting at 0. The TOTAL row's `amount` and `balance` are
  left out when the accounts have different normal sides (income and expense mixed).
- **Summaries by name/item** (sales, purchases, income, expenses): rows per customer or job,
  vendor or item with sections for parents; `grandtotal` `TOTAL`.
- **Journal**: per transaction a group of `data` rows (first row has `trans`, `type`, `date`,
  `num`; following rows blank them), a `subtotal` with the transaction's debit and credit,
  then `TOTAL`. Voided transactions appear with zero amounts.
- **Audit trail**: section 10.

Number of rows with default parameters on the sample company: from 1 (`pending_sales`) to
1,318 (`profit_loss_detail`, year to date). Detail reports over long ranges are large; narrow
the dates or filter by account.

---

## 7. Drill-down: from an amount to the transactions

Three fields identify what is behind a row:

1. `txnId` (detail rows): the transaction id. Open it with `GET /txns/{id}`, or see its
   postings with `GET /reports/journal?txnId={id}`.
2. `cellDrills[<columnKey>]`: the report to run for that cell's amount (multi-column reports
   have one per column).
3. `drill`: the row's default target (the `total` column's drill when there is one, else
   the first). Use `cellDrills[col] ?? drill`.

A drill is `{report, params}`: run `GET /reports/{report}?{params}` exactly. Filters of the
source report (`nameIds`, `classIds`, `itemIds`, `types`, `includeJobs`, `noClass`,
`noCustomer`, `cleared`, `memo`, `refNumber`, `amountMin`, `amountMax`, `vendorIds`,
`customerIds`) are carried over, so the drilled total matches the amount.

Where amounts drill to (verified):

| From | Drills to |
|---|---|
| P&L / balance sheet / trial balance / cash flow account rows and subtotals | `transaction_detail_by_account` with `accountIds` (all accounts under a subtotal) and the column's dates/class/customer |
| Gross Profit, Net Operating Income, Net Other Income, Net Income | `profit_loss_detail` with the accounts that make them up |
| Balance sheet Net Income | `profit_loss` for the fiscal year to date |
| Balance sheet Retained Earnings and equity totals | `transaction_detail_by_account` with `netTotal=credit` (and `plTo`) |
| Cash flows Net Income | `profit_loss` |
| A/R / A/P aging summary cell | `ar_aging_detail` / `ap_aging_detail` with `nameIds`, `includeJobs`, `asOf`, aging params and `bucket` |
| Customer / vendor balance summary | `customer_balance_detail` / `vendor_balance_detail` |
| Sales by customer / item summary | `sales_by_customer_detail` / `sales_by_item_detail` |
| Income by customer / expenses by vendor summary | the matching detail report (`customerIds` / `vendorIds`) |
| Inventory valuation summary | `inventory_valuation_detail` |
| Stock status, item lists, sales tax items | `item_quickreport` |
| Customer/vendor lists | `name_quickreport` |
| Detail rows | `txnId` |

Example: the P&L "Delivery Income" drill
`transaction_detail_by_account?accountIds=49&basis=accrual&from=2026-09-01&to=2026-09-30`
returns one invoice (`txnId` 1570, amount 75) and a TOTAL of 75, matching the P&L cell.
The Net Income drill (`profit_loss_detail`) ends with `Net Income` = −3,676.62.

Report rows do not carry an `accountId` field; the account ids are in the drill params.

---

## 8. CSV export, printing, display options

- The API has **no CSV or PDF export for reports**. In the app, the report window's
  **Export CSV** button builds the file in the browser (header lines, then the visible rows;
  numbers unformatted, dates as MM/DD/YYYY), and **Print** prints the visible report.
- Over the API, build CSV yourself: header = `columns[].label` (first column is the label),
  then for each row `"  " * level + cells.label`, then each `cells[col.key]`.

```bash
curl -s "$BASE/reports/profit_loss?dates=lastMonth" | python3 -c '
import json,sys,csv
r=json.load(sys.stdin); w=csv.writer(sys.stdout)
w.writerow([c["label"] or r["title"] for c in r["columns"]])
for x in r["rows"]:
    w.writerow([("  "*x["level"])+str(x["cells"].get("label",""))]+[x["cells"].get(c["key"],"") for c in r["columns"][1:]])'
```

- Display options in the app (Customize > Numbers / Header / Columns) are client side only;
  see section 5.8.

---

## 9. Memorized reports

A memorized report is a name + report key + saved parameters. Menu: **Reports > Memorized
Reports > Memorized Report List**; the report window's **Memorize** button (Ctrl+M) creates
one. The first 8 also appear under Reports in the left navigation.

Object:

| Field | Type | Notes |
|---|---|---|
| `id` | int | read only |
| `name` | string | required, trimmed, unique (case-insensitive) |
| `reportKey` | string | required; **not checked** against the catalog (an unknown key is saved, then fails with 404 when run) |
| `params` | object of strings | the report parameters; may contain `ui.*` display options saved by the app |
| `groupName` | string | optional; the app offers Accountant, Banking, Company, Customers, Vendors |

### `GET /memorized-reports`

Returns all, sorted by group then name. There is no `GET /memorized-reports/{id}` (404).

### `POST /memorized-reports` → 201

```bash
curl -s -X POST "$BASE/memorized-reports" -H 'Content-Type: application/json' \
  -d '{"name":"Q3 P&L by month","reportKey":"profit_loss","params":{"from":"2026-07-01","to":"2026-09-30","columns":"month"},"groupName":"Company"}'
# {"id":1,"name":"Q3 P&L by month","reportKey":"profit_loss","params":{"columns":"month","from":"2026-07-01","to":"2026-09-30"},"groupName":"Company"}
```

Errors (400 validation): `name` missing ("Please enter a name for the memorized report."),
`reportKey` missing ("The report is missing."), duplicate name, any case ("A memorized report
named \"...\" already exists. Please choose a different name.").

### `PUT /memorized-reports/{id}` → 200

Partial: fields you omit keep their values; `params`, when sent, **replaces** the whole map.

```bash
curl -s -X PUT "$BASE/memorized-reports/1" -H 'Content-Type: application/json' \
  -d '{"params":{"dates":"lastFiscalQuarter","columns":"month"}}'
```

Unknown id: 404 "Memorized report not found."

### `DELETE /memorized-reports/{id}` → 204

Unknown id: 404.

### Running a memorized report

`GET /reports/{reportKey}?{params}`; drop keys starting with `ui.` (the server ignores
them anyway). Fixed `from`/`to` always show the same period; a `dates` preset rolls forward
(`dates=lastMonth` is always last month). Save presets when the user wants "the latest".

---

## 10. Audit trail

### Report: `GET /reports/audit_trail?dates=...&user=...`

- Administrator only. The date range selects transactions by the **date and time they
  were entered or last changed**, not by transaction date.
- Rows: a section per user ("Transactions entered or modified by Admin"), then per
  transaction a section ("Bill 41-7799"), then one `data` row per version with
  `state` (`Latest`, `Prior`, `Deleted`), `entered` ("10/20/2026 17:00:00", local time),
  `user`, `date`, `name`, `memo`, `account`, `split`, `amount`, and indented line rows
  (level 3). Rows carry `txnId`.

### Raw log: `GET /audit`

Administrator only (`403 "Only an administrator can view the audit trail."`). Newest first,
at most 2000 rows.

| Query | Meaning |
|---|---|
| `from`, `to` | local dates (`YYYY-MM-DD`) of the change timestamp |
| `user` | user name (case-insensitive) |
| `txnId` | history of one transaction |
| `action` | `add`, `modify`, `delete`, `void`, `closing_date` |

Row: `{id, ts (UTC), user, action, txnId, txnType, refNumber, txnDate, name, amount, details}`;
`details` holds `{"before": <txn or null>, "after": <txn or null>}` full transaction snapshots
(large). Use `?txnId=` for "who changed this invoice?".

---

## 11. Customer statements

`GET /statements?customerIds=22&from=2026-09-01&to=2026-10-20&statementDate=2026-10-20`
(menu: Customers > Create Statements...). Returns an array, one per customer:

```json
{"customer": {"...": "..."}, "billAddress": "Rachel Abbott\n12 Bluff Rd\nHarborview, CA 94950",
 "statementDate": "2026-10-20", "from": "2026-09-01", "to": "2026-10-20",
 "openingBalance": 0, "endingBalance": 2710.16,
 "rows": [{"txnId":1566,"date":"2026-09-28","type":"INV","refNumber":"1251",
           "description":"Spring Cleanup: INV #1251. Due 09/28/2026. Orig. Amount $510.00.",
           "dueDate":"2026-09-28","amount":510,"balance":510}],
 "aging": {"current":0,"d1_30":2710.16,"d31_60":0,"d61_90":0,"over90":0}, "amountDue": 2710.16}
```

`mode=range` (default, transactions in from–to) or `mode=open` (open transactions only);
no `customerIds` = all top-level customers; `includeZero=1` includes zero balances;
`to` defaults to `statementDate`, which defaults to today.

---

## 12. Errors

| Situation | Status / body |
|---|---|
| Unknown report key | 404 `{"code":"not_found","error":"Unknown report \"x\""}` |
| Bad date | 400 `{"code":"validation","field":"from"|"to"|"asOf","error":"Invalid From date \"2026-13-01\""}` |
| From after To | 400 `field: "from"`, "The From date must be on or before the To date." |
| Missing required id | 400 `field: "accountId"` "Select an account for the Account Activity report." / `nameId` "Select a name for the activity report." / `itemId` "Select an item for the Item Activity report." |
| Unknown account on missing checks | 400 `field: "accountId"` "Account not found." |
| Unknown budget | 404 "Budget N not found" |
| Journal with unknown `txnId` | 404 "Transaction N not found" |
| Audit as non-admin | 403 forbidden |
| Login required | 401 auth (send `X-Session`) |

Invalid ids in filters are not errors: an unknown id just returns an empty report.

---

## 13. Gotchas

1. **Parent accounts in `accountIds` do not include their subaccounts** (ledger reports).
   Filtering on "Insurance Expense" (parent) returned nothing while its subaccounts had
   1,850 in the month. Send all ids, or use `account_quickreport?accountId=` which does
   include subaccounts. Items behave differently: ledger reports use exact item ids, but
   sales/purchase/inventory reports include sub-items.
2. **Unsupported filters are silently ignored**, e.g. `sales_by_customer_summary?classIds=35`
   returns the unfiltered total. Check the Filters column in section 4.
3. Always send both `from` and `to` (a lone `from` runs to 9999-12-31). `dates=all` stops at today.
4. As-of reports read `asOf` (or `to`), not `from`.
5. Sales tax reports default to the sales tax basis preference, not the report basis preference.
6. Comparisons, by-class and by-job are separate keys or `columns` values, not a `compare` parameter.
7. Sorting, hiding zero rows, collapsing and number formats are app-only (`ui.*`).
8. `% Change` is 100 when the prior amount is 0; percentages are in percent units (12.5 = 12.5%).
9. `transaction_detail_by_account` has no beginning balance (running total from 0); use
   `general_ledger` or `account_quickreport` for real balances.
10. Customer/Vendor Balance Detail hide names whose balance is zero at the end date, and with
    a `from` date their running Balance starts at 0. For all activity of one name use
    `name_quickreport?nameId=` or the transaction lists.
11. Sales Tax Liability "Total Sales" per tax item: when a combined tax group has two
    components, the same sale is counted under each, so the agency and grand totals of `sales`
    count it twice. Read `taxable`/`collected`/`payable` per item, not a sum of `sales`.
12. Account labels change with preferences (account numbers, descriptions); match accounts
    by drill `accountIds`, structure rows by their fixed labels.
13. Memorized reports accept any `reportKey` string; verify the key against `GET /reports`.
14. Amounts are floats in dollars, already rounded to cents; the server computes in cents,
    so totals add up exactly.

---

## 14. Where reports are in the app

- **Reports menu**: Report Center (opens the "All Reports" window); Memorized Reports (list +
  groups); Insights (charts built from `profit_loss` by month, `sales_by_customer_summary`,
  `expenses_by_vendor_summary`);
  Activity Report (Ctrl+Q, from a selected account, name or item); one submenu per category
  with every report (e.g. Reports > Customers and Invoices > A/R Aging Summary);
  Transaction History (Ctrl+H); Transaction Journal (Ctrl+Y, = `journal?txnId=`).
- **Left navigation > Reports**: All Reports, Profit and Loss, Balance Sheet, starred
  reports, up to 8 memorized reports, Memorized Reports.
- **All Reports** (Reports > Report Center): reports by category with descriptions; a star
  adds a report to the navigation.
- **Report window toolbar**: Customize (filters, columns, header, numbers), Memorize (Ctrl+M),
  Print, Export CSV, Expand/Collapse all, Hide header, Refresh. The filter bar above the
  report holds Report period (dates preset), From/To or As of, Accounting method (basis),
  Display columns by (columns), Compare to, Days per aging period / Through days past due,
  Budget, Class, Customer or Job, Account / Name / Item (activity reports), Rows by
  (custom summary), Total by (custom detail), Sort by.
- **Customize > Filters** tab maps to: Accounts (`accountIds`, "Income and expense accounts
  only" = `plOnly`), Customers, vendors and other names (`nameIds`), Items, Classes
  ("No class only" = `noClass`), Transaction types, Cleared status (Either / Cleared /
  Not cleared), Amount (Between...), Memo contains, Number contains.
  **Customize > Columns** = `cols` on detail reports. Double-clicking a row follows its
  drill or opens its transaction.
