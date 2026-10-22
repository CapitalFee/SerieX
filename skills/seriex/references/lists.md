# SerieX Books: lists and list import/export

Reference for the chart of accounts, customers/jobs, vendors, other names, items, the small
"profile" lists (terms, classes, payment methods ...) and CSV import/export of SerieX Books.
Every request and response shape below was checked against a running server.

All routes are company scoped: `http://127.0.0.1:<port>/api/c/{cid}/...` (see the main skill
file for the port, company ids and login). Write requests use `Content-Type: application/json`,
except CSV import (multipart upload).

## Contents

1. [Rules shared by every list](#1-rules-shared-by-every-list)
2. [Chart of accounts](#2-chart-of-accounts)
3. [Names: customers, jobs, vendors, other names](#3-names-customers-jobs-vendors-other-names)
4. [Items](#4-items)
5. [Simple lists (terms, classes, payment methods ...)](#5-simple-lists)
6. [CSV export and import](#6-csv-export-and-import)
7. [Error messages you will meet](#7-error-messages-you-will-meet)

---

## 1. Rules shared by every list

**PUT replaces the whole record.** `PUT /accounts/{id}`, `/names/{id}`, `/items/{id}` and
`/lists/{list}/{id}` store exactly the body you send. A field left out becomes empty / null /
false (only `type` of accounts and items, `kind` of names and the `active` flag are kept when
omitted). A `PUT /names/5` with only `{"name":"X"}` erases the email, addresses, terms, tax
settings and notes; a `PUT /accounts/45` without `parentId` moves a subaccount to the top level.
Always do: `GET` the record, change the fields, `PUT` the whole object back.

**Stale copies are refused.** Records carry `updatedAt`. If the body (or, for simple lists,
the `If-Match` header or `?updatedAt=`) holds an `updatedAt` older than the stored one, the
save fails with 409 `conflict` "Someone else changed this account after you opened it...".
Re-read and retry. Leaving `updatedAt` out skips the check.

**Read-only fields** are ignored on input: `fullName`, `level`, `balance`, `ownBalance`,
`hasTxns`, `special`, `qtyOnHand`, `avgCost`, `assetValue`, `qtyOnPo`, a Sales Tax Group's
`taxRate`, `groupLines[].itemName`.

**Names of records**
- Required, trimmed, at most 100 characters (simple lists: 31, except customer messages),
  no colon `:` (the colon separates levels), no line breaks or tabs.
- Unique among siblings, compared without regard to case ("smith, john" = "Smith, John").
- Customers, jobs, vendors and other names share one name space: a vendor cannot have the
  same name as a customer. Accounts, items and each simple list have their own name space.
- There is no merge: renaming a record to a name that already exists is refused (409).

**Hierarchy.** Accounts, items, customers (jobs) and simple list entries can be nested with
`parentId`. The server builds `fullName` = "Parent:Child:Grandchild" and `level` (0 = top).
Lists come back in tree order (parents followed by their children).

**Active / inactive.**
- `GET` lists return only active records unless `?active=all` or `?active=inactive`
  (`active` also accepts `1/true/0/false`; anything else is a 400).
- Making a record inactive also makes all its subrecords inactive. Making a record active also
  re-activates its parents, but NOT its children.
- New records are active unless the body says `"active": false`.
- Inactive records keep their history and balances; they are only hidden from pickers.

**Delete vs. inactive.** A record that is used anywhere (transactions, subrecords, items,
customers, preferences, budgets ...) cannot be deleted: the server answers 409 `conflict` with
a message that ends in "Make it inactive instead." Delete returns 204 with no body.

**Opening balances are create-only.** `openingBalance`/`openingDate` (accounts and names) and
`openingQty`/`openingValue`/`openingDate` (inventory parts) are used only by `POST`; they are
ignored on `PUT`. They are saved as ordinary transactions (see each section), so the closing
date, credit limit and other transaction warnings apply (`409 confirm` → retry with
`?accept=<kind>`, e.g. `?accept=creditlimit`). `openingDate` defaults to today; format
`YYYY-MM-DD`.

**Money** is sent as dollars (numbers, 2 decimals). Largest amount 9,999,999,999.99; largest
quantity 999,999,999.

---

## 2. Chart of accounts

Screens: **Lists > Chart of Accounts** (Ctrl+A; also Company > Chart of Accounts). Bottom
button **Account ▾**: New, Edit, Delete Account, Make Account Inactive/Active, New Subaccount,
Import from CSV..., Export to CSV. "Include inactive" checkbox shows inactive accounts.
The Number field only shows in the dialog when **Edit > Preferences > Accounting > Use account
numbers** is on (numbers are stored and exported either way).

### 2.1 Account types

`type` is one of these exact strings (the display text is the code):

| type | What it is for | Normal balance | Report | Opening balance on create |
|---|---|---|---|---|
| `Bank` | Checking, savings, petty cash | debit | Balance sheet | yes ("Statement ending balance" in the dialog) |
| `Accounts Receivable` | What customers owe. Every invoice posts here | debit | Balance sheet | no (enter per customer) |
| `Other Current Asset` | Undeposited Funds, Inventory Asset, prepaid expenses, short-term loans to others | debit | Balance sheet | yes |
| `Fixed Asset` | Equipment, vehicles, buildings, accumulated depreciation | debit | Balance sheet | yes |
| `Other Asset` | Long-term assets that are not fixed assets (deposits, intangibles) | debit | Balance sheet | yes |
| `Accounts Payable` | What the business owes vendors. Every bill posts here | credit | Balance sheet | no (enter per vendor) |
| `Credit Card` | Business credit cards | credit | Balance sheet | yes ("Amount you owe") |
| `Other Current Liability` | Sales tax payable, payroll liabilities, short-term loans | credit | Balance sheet | yes |
| `Long Term Liability` | Loans and notes paid over more than a year | credit | Balance sheet | yes |
| `Equity` | Owner's equity / draws, capital stock, Opening Balance Equity, Retained Earnings | credit | Balance sheet | yes |
| `Income` | Sales of products and services | credit | Profit and loss | no |
| `Cost of Goods Sold` | Direct cost of what is sold (materials, subcontractors, inventory cost) | debit | Profit and loss | no |
| `Expense` | Overhead expenses | debit | Profit and loss | no |
| `Other Income` | Income outside normal operations (interest earned) | credit | Profit and loss | no |
| `Other Expense` | Expenses outside normal operations (income tax, penalties) | debit | Profit and loss | no |
| `Non-Posting` | Holds estimates / purchase orders brought in by the QuickBooks import. Transactions cannot post to it. The app's dialog does not offer it; the API accepts it | n/a | none | no |

`balance` is in the account's natural sign (positive = normal balance) and includes
subaccounts; `ownBalance` is the account alone. Both are 0 for profit & loss accounts (use
reports for period totals).

### 2.2 Special (system) accounts

The `special` field (read-only) marks accounts the program relies on. A special account can be
renamed, renumbered and made inactive, but never deleted (409 "The "Undeposited Funds" account
is used by SerieX Books and cannot be deleted. Make it inactive instead."). When the program
needs one that is missing, it flags a same-named top-level account of the right type or
creates it (without a number).

| special | Default name (number) | Type | Type can change? | Used for |
|---|---|---|---|---|
| `AccountsReceivable` | Accounts Receivable (1100) | Accounts Receivable | no | Invoices, payments, credit memos |
| `UndepositedFunds` | Undeposited Funds (1150) | Other Current Asset | no | Payments received but not yet deposited; default for Payment items |
| `InventoryAsset` | Inventory Asset (1300) | Other Current Asset | no | Value of stock; default asset account of inventory parts |
| `AccountsPayable` | Accounts Payable (2000) | Accounts Payable | no | Bills, bill payments, vendor credits |
| `SalesTaxPayable` | Sales Tax Payable (2200) | Other Current Liability | no | Sales tax collected (only when sales tax is on) |
| `OpeningBalanceEquity` | Opening Balance Equity (3000) | Equity | no | Other side of account and inventory opening balances. Should end at 0 once setup is complete (move it to owner's equity with a journal entry) |
| `RetainedEarnings` | Retained Earnings (3900); non-profits: "Net Assets Without Donor Restrictions" | Equity | no | Prior years' profit (computed by reports) |
| `UncategorizedIncome` | Uncategorized Income (4990) | Income | yes | Other side of customer opening balances |
| `CostOfGoodsSold` | Cost of Goods Sold (5000) | Cost of Goods Sold | no | Default COGS account of inventory parts |
| `UncategorizedExpenses` | Uncategorized Expenses (6980) | Expense | yes | Other side of vendor opening balances |
| `AskMyAccountant` | To Review with Accountant (6990) | Expense | yes | Parking place for unclear transactions |

### 2.3 Default chart of a new company

`POST /api/companies` with `createDefaultAccounts:true` and an `industry` key (from
`GET /api/companies/templates`: `general_product`, `general_service`, `construction`, `retail`,
`consulting`, `restaurant`, `nonprofit`, `manufacturing`, `landscaping`, `none`) creates a
4-digit numbered chart: Checking 1000, Savings 1010, Petty Cash 1050, the special accounts
above, Furniture and Equipment 1500, Accumulated Depreciation 1590, Credit Card 2100, Loan
Payable 2600, owner equity accounts 3100/3110 (named by entity type: Owners Equity/Owners
Draw, Capital Stock/Dividends Paid or Shareholder Distributions, Partner Contributions/
Distributions; non-profits: Net Assets With Donor Restrictions 3200), industry income
accounts 4xxx, COGS accounts 5xxx, common expenses 6000-6650 (Advertising and Promotion,
Automobile Expense, Bank Service Charges, Computer and Internet Expenses, Depreciation
Expense, Insurance Expense with subaccount Liability Insurance, Interest Expense, Meals and
Entertainment, Office Supplies, Professional Fees, Rent Expense, Repairs and Maintenance,
Telephone Expense, Travel Expense, Utilities; industry extras 6700-6830) and Interest Income
7000.
Company files made by older versions keep their 5-digit numbers.
`none` creates only the special accounts. Sales Tax Payable is created only with sales tax on;
Inventory Asset and Cost of Goods Sold only with inventory on (or a product industry).

### 2.4 Account fields

| Field | Type | Input? | Meaning |
|---|---|---|---|
| `id` | int | path | |
| `name` | string | required | Name of this level only (no colon) |
| `number` | string | optional | Account number, unique across all accounts (exact match). "" = none |
| `type` | string | required on create | One of the types in 2.1. On PUT, "" or missing keeps the current type |
| `parentId` | int/null | optional | Parent account (subaccount). Must have the same type. 0 = null |
| `description` | string | optional | Shown in lists and reports |
| `note` | string | optional | Free note |
| `bankAcctNumber` | string | optional | Bank account number (Bank) or card number (Credit Card) |
| `routingNumber` | string | optional | Bank routing number |
| `taxLine` | string | optional | Tax-line mapping, free text. The dialog offers common Schedule C / balance sheet lines ("Office expense", "Gross receipts or sales", "B/S-Assets: Cash" ...). No report uses it yet |
| `active` | bool | optional | Default true on create |
| `openingBalance` | number | create only | Balance sheet types except A/R and A/P. Natural sign: positive = normal balance (an asset you have, a liability you owe) |
| `openingDate` | date | create only | Date of the opening balance (default today) |
| `updatedAt` | string | send back | Stale check |
| `fullName`, `level`, `special`, `balance`, `ownBalance`, `hasTxns` | | read-only | |

### 2.5 Endpoints

**GET /accounts** — chart of accounts in display order (by type in the order of 2.1, then
number when "use account numbers" is on, else name; subaccounts under their parent).
Query: `active=active|all|inactive` (default active), `types=Bank,Credit Card` (comma list of
exact type names; unknown names just return nothing).

```json
{"id":1,"name":"Checking","number":"10000","type":"Bank","parentId":null,"fullName":"Checking",
 "level":0,"description":"Harbor National Bank business checking","note":"","bankAcctNumber":"000123456789",
 "routingNumber":"000000000","taxLine":"","special":"","active":true,"balance":46016.7,
 "ownBalance":46016.7,"hasTxns":true,"updatedAt":"2026-10-21T02:33:50.804436Z"}
```

**GET /accounts/{id}** — one account (404 "Account not found.").

**POST /accounts** — create. Returns the saved account.

```bash
curl -s -X POST $B/accounts -H 'Content-Type: application/json' -d '{"name":"Operating Checking",
  "number":"10200","type":"Bank","description":"Main operating account","bankAcctNumber":"123456789",
  "routingNumber":"021000021","openingBalance":5000,"openingDate":"2026-01-01"}'
# subaccount
curl -s -X POST $B/accounts -H 'Content-Type: application/json' -d '{"name":"Payroll Sub","type":"Bank","parentId":1,"number":"10010"}'
```

Opening balance effect: a General Journal entry dated `openingDate`, memo "Account Opening
Balance", between the new account and Opening Balance Equity. Asset with 5000: account +5000
(debit), Opening Balance Equity +5000 (credit). Credit card or loan with 1200: the liability
goes up 1200 and Opening Balance Equity goes down 1200. The account gets `hasTxns:true`.

**PUT /accounts/{id}** — full replace (see section 1). `openingBalance` is ignored.

**PUT /accounts/{id}/active** — body `{"active":false}` or `{"active":true}`; returns the
account. Cascades as described in section 1. Special accounts can be made inactive.

**DELETE /accounts/{id}** — 204. Refused (409) when the account:
- is special: "... is used by SerieX Books and cannot be deleted. Make it inactive instead."
- has subaccounts or appears on any transaction: "This account has transactions or subaccounts. Make it inactive instead."
- is used by an item (income/expense/asset/deposit account): "This account is used by one or more items..."
- is used by a reconciliation, bank feed or budget.

Deleting also clears preferences and bank rules that pointed at the account.

### 2.6 Rules and gotchas

- A subaccount must have the same type as its parent (400 "A subaccount must be the same type
  as its parent account (Bank)."). Changing a parent's type changes all its subaccounts too.
- Type changes: refused for the 8 type-locked special accounts (409 "You cannot change the type
  of the "Undeposited Funds" account..."), and refused to or from Accounts Receivable /
  Accounts Payable when the account has transactions. Every other type change is allowed even
  with transactions (balances are then read with the new type's sign).
- Same name twice under the same parent: 409 "The name "Checking" is already in use. Please use
  a different name." The same name under a different parent is fine.
- Duplicate number: 400 "The account number "10200" is already in use...".
- `openingBalance` on Income/Expense: 400 "Only balance sheet accounts have an opening balance.";
  on A/R or A/P: 400 "Accounts receivable and accounts payable balances are entered for each
  customer or vendor, not for the account." The whole create is rolled back on any error.
- The dialog in the app locks the type of every special account; the server locks only the 8
  marked "no" in 2.2.

---

## 3. Names: customers, jobs, vendors, other names

One endpoint family `/names` holds four kinds of records:

| `kind` | Screen | Notes |
|---|---|---|
| `customer` (top level) | **Customers > Customer Center** (Ctrl+J), "New Customer & Job ▾ > New Customer..." | Has an A/R balance |
| `customer` with `parentId` = a **job** | Customer Center, select a customer, "New Customer & Job ▾ > Add Job..." (or row menu "Add Job") | Jobs can have sub-jobs. A job's A/R rolls up into its customer's `balance` |
| `vendor` | **Vendors > Vendor Center**, "New vendor" | Has an A/P balance; can be a 1099 vendor and a sales tax agency |
| `other` | **Lists > Other Names List** (also Banking > Other Names List) | Owners, partners, people paid by check who are neither customers nor vendors. No balance, no opening balance |

There is no employee kind in SerieX Books: employees live in SerieX Payroll.

### 3.1 Name fields

| Field | Type | Applies to | Meaning |
|---|---|---|---|
| `id` | int | all | |
| `kind` | string | all | `customer`, `vendor`, `other`. Required on create (optional when `parentId` is set: then `customer`). Kept on PUT when omitted |
| `name` | string | all | Display name of this level, e.g. "Garcia, Maria" or "Lobby Remodel" |
| `parentId` | int/null | jobs | The customer (or parent job). Only customers can have jobs |
| `companyName`, `salutation`, `firstName`, `middleName`, `lastName`, `jobTitle` | string | all | Contact |
| `phone`, `altPhone`, `mobile`, `fax`, `email`, `ccEmail`, `website` | string | all | |
| `billAddress`, `shipAddress` | object | all | `{line1,line2,line3,city,state,zip,country}`. Convention: line1 is often the addressee name, line2 the street |
| `accountNumber` | string | all | Your reference number for the name (customers: printed on statements; vendors: your account number with them) |
| `termsId` | int/null | customers, vendors | Entry of the `terms` list; sets due dates on invoices/bills |
| `creditLimit` | number/null | customers | Warning (409 confirm `creditlimit`) when an invoice would go over. null = no limit; cannot be negative |
| `typeId` | int/null | customers, vendors | Entry of `customer_type` (customers) or `vendor_type` (vendors). Ignored for other names |
| `repId` | int/null | customers | Entry of `sales_rep` |
| `paymentMethodId` | int/null | customers | Preferred `payment_method` entry |
| `taxable` | bool | customers | Sales tax code: true = "Tax", false = "Non" (reseller / exempt). **Defaults to false when omitted** (the app's dialog defaults to true) |
| `taxItemId` | int/null | customers | Sales Tax Item or Sales Tax Group used on this customer's sales forms (null = the preference "most common sales tax item") |
| `resaleNumber` | string | customers | Resale certificate number |
| `printOnCheckAs` | string | vendors | Payee name printed on checks (the dialog fills it with the name) |
| `taxIdent` | string | vendors | Vendor tax id (EIN/SSN) for 1099s |
| `is1099` | bool | vendors | Eligible for 1099. Feeds the reports "1099 Summary" and "1099 Detail" (payments from bank accounts to income/expense accounts) |
| `prefillAccountIds` | int[] | vendors | Up to 3 expense accounts that prefill new bills/checks for this vendor |
| `jobStatus` | string | jobs | "", `Pending`, `Awarded`, `In progress`, `Closed`, `Not awarded` |
| `jobStartDate`, `jobProjectedEnd`, `jobEndDate` | date | jobs | `YYYY-MM-DD` or "" |
| `jobDescription` | string | jobs | |
| `jobTypeId` | int/null | jobs | Entry of `job_type` |
| `notes` | string | all | Private notes, not printed |
| `active` | bool | all | |
| `openingBalance`, `openingDate` | number, date | customers, jobs, vendors; create only | See 3.3 |
| `balance` | number | read-only | Customers: A/R including jobs (positive = they owe you). Vendors: A/P (positive = you owe them) |
| `ownBalance` | number | read-only | Without sub-jobs |
| `fullName`, `level`, `hasTxns`, `updatedAt` | | read-only | |

There are no custom fields, price levels or contact lists on names.

### 3.2 Endpoints

**GET /names** — all names in tree order, sorted by name (kinds mixed unless filtered).
Query: `kind=customer|vendor|other` (400 for anything else), `active=...`, `q=text`
(case-insensitive substring of fullName, company, first/last name, email, phone, mobile or
account number; a customer match also returns its jobs because their fullName contains it).

**GET /names/{id}** — one name.

**GET /names/{id}/summary** — figures for the history panel of the centers. Customers include
their jobs.

```json
{"openBalance":2710.16,"overdue":2710.16,"unbilledCosts":0,
 "lastPayment":{"date":"2026-08-08","amount":343.55},"openEstimates":0,"openPOs":0,"creditLimit":null}
```
`overdue` = open invoices/statement charges (vendors: bills) past their due date;
`unbilledCosts` = billable expenses not yet invoiced (customers); `openEstimates` (customers),
`openPOs` (vendors). Other names return zeros.

**POST /names** — create.

```bash
# customer with an opening balance
curl -s -X POST $B/names -H 'Content-Type: application/json' -d '{"kind":"customer","name":"Smith, John",
  "firstName":"John","lastName":"Smith","phone":"555-0100","email":"john@example.com",
  "billAddress":{"line1":"John Smith","line2":"1 Main St","city":"Springfield","state":"IL","zip":"62701"},
  "termsId":6,"creditLimit":1000,"taxable":true,"accountNumber":"C-1",
  "openingBalance":250.50,"openingDate":"2026-09-01"}'
# job of customer 1
curl -s -X POST $B/names -H 'Content-Type: application/json' -d '{"name":"Kitchen Remodel","parentId":1,
  "taxable":true,"jobStatus":"In progress","jobStartDate":"2026-09-15"}'
# 1099 vendor with an opening balance
curl -s -X POST $B/names -H 'Content-Type: application/json' -d '{"kind":"vendor","name":"Acme Supply",
  "companyName":"Acme Supply Co","printOnCheckAs":"Acme Supply Company","taxIdent":"12-3456789",
  "is1099":true,"prefillAccountIds":[30,21],"termsId":6,"typeId":32,"openingBalance":400,"openingDate":"2026-09-01"}'
# other name
curl -s -X POST $B/names -H 'Content-Type: application/json' -d '{"kind":"other","name":"Owner Jane"}'
```

**PUT /names/{id}** — full replace (section 1). `openingBalance` ignored.

**PUT /names/{id}/active** — `{"active":false}`. Making a customer inactive makes its jobs
inactive; making a job active re-activates its customer.

**DELETE /names/{id}** — 204. Refused (409) when the name has jobs or appears on any
transaction ("This name has jobs or transactions and cannot be deleted. Make it inactive
instead."), is the preferred vendor or tax agency of an item, or is used in a budget.

### 3.3 Opening balances of names

Posted as a real transaction dated `openingDate`, memo "Opening balance", with no reference
number, using the name's terms for the due date:

| Kind | Amount > 0 | Amount < 0 | Accounting effect |
|---|---|---|---|
| customer / job | Invoice | Credit Memo (positive amount) | A/R up (or down); the other side is **Uncategorized Income** |
| vendor | Bill | Vendor Credit | A/P up (or down); the other side is **Uncategorized Expenses** |
| other | 400 "Other names do not have an opening balance." | | |

Because the other side is an income/expense account, the amount shows on the profit & loss
of the opening date (accrual basis). Date opening balances before the first period you report
on, or (better for real books) enter the actual open invoices/bills instead. A credit limit
lower than the opening balance gives 409 `confirm` `creditlimit`; retry with
`?accept=creditlimit`.

### 3.4 Rules and gotchas

- **Jobs do not inherit through the API.** The app's "Add Job" copies the customer's contact,
  addresses, terms, rep, payment method and tax settings into the new job. A job created by API
  gets only what you send (and `taxable` defaults to false). The app's sales forms fall back to
  the customer's address, terms, rep and tax item when the job's are empty, but they use the
  job's own `taxable` flag. Copy the customer's fields (at least `taxable`) when you create a job.
- Name already used: 409 with `field:"name"` and `data:{existingId, existingKind, existingActive}`.
  Messages: "The name "Smith, John" is already used by a customer. Names must be unique across
  customers, vendors and other names." / "An other name named "Owner Jane" already exists but is
  inactive. Make it active instead, or use a different name." / "...already used by another job
  of this customer."
- Changing `kind`: refused when the name has jobs, or when a customer/vendor has transactions.
  An other name can become a customer or vendor even with transactions.
- `termsId`, `typeId`, `repId`, `paymentMethodId`, `jobTypeId` must point at an entry of the
  right simple list (400 "The selected entry belongs to the wrong list (payment_method).").
  `taxItemId` must be a Sales Tax Item or Sales Tax Group.
- Jobs can be nested (Customer:Job:Phase). A vendor or other name cannot have a parent.

---

## 4. Items

Screens: **Lists > Item List** (also Customers > Item List, Vendors > Item List). Bottom
button **Item ▾**: New, Edit, Delete Item, Make Item Inactive/Active, Import from
CSV..., Export to CSV.

Items are what sales and purchase forms list on their lines. The item, not the form, decides
which accounts a line posts to.

### 4.1 Item types and what each needs

| `type` | Use | Required | Accounts used | Notes |
|---|---|---|---|---|
| `Service` | Work you charge for (hours, jobs, fees) | `incomeAccountId` | Income account on sales. With `isPurchased:true` also `expenseAccountId` on purchases (subcontracted work) | Without purchase info one account serves both sides: `expenseAccountId` is set to the income account and cost / purchase description / preferred vendor are cleared |
| `Inventory Part` | Products you buy, stock and sell, with quantity tracking | `incomeAccountId` | Income (sales), COGS `expenseAccountId` (default: Cost of Goods Sold), asset `assetAccountId` (default: Inventory Asset; must be Other Current Asset) | Always has purchase info. Average cost. Quantity changes only through transactions |
| `Non-inventory Part` | Products you buy or sell without tracking quantity (supplies, special orders) | `incomeAccountId` | As Service | |
| `Other Charge` | Delivery, fees, reimbursable charges | `incomeAccountId` | As Service | Price can be a percent (`rateIsPercent:true`, -100..100): a percentage of the line right above it |
| `Subtotal` | Adds up the lines above it, up to the previous subtotal | nothing | none | No price, no account |
| `Group` | A bundle of items entered with one line (e.g. a package) | `groupLines` (at least 1) | each member's | Members cannot be groups; `qty` per member, not negative. Its own price/accounts are cleared |
| `Discount` | Subtracts an amount or a percent | `incomeAccountId` (the account that tracks discounts, usually an income account such as "Sales Discounts") | that account | `salesPrice` is entered positive (e.g. 10 with `rateIsPercent:true` = 10%). A percent discount applies to the line right above it (put a Subtotal before it to discount several lines). `taxable:true` = discount applied before tax |
| `Payment` | A payment received on an invoice (deposit, down payment) | nothing | `depositAccountId` (null = Undeposited Funds) | `paymentMethodId` optional (payment_method list) |
| `Sales Tax Item` | One tax rate paid to one agency | `taxAgencyId` (a vendor), `taxRate` 0..100 | Sales Tax Payable | Rate kept to 4 decimals (1.123456 → 1.1235) |
| `Sales Tax Group` | Several tax items charged together (state + county + city) | `groupLines` of Sales Tax Items (each once) | Sales Tax Payable | `taxRate` (read-only) = sum of member rates. `qty` forced to 1 |

Fields that do not apply to the type are cleared on save (e.g. a cost sent for a Service
without `isPurchased`, `rateIsPercent` on a Service, accounts on a Subtotal).

### 4.2 Item fields

| Field | Type | Meaning |
|---|---|---|
| `id`, `type` | | `type` required on create; kept on PUT when omitted |
| `name`, `parentId` | | Subitem: parent must have the same type |
| `mpn` | string | Manufacturer's part number |
| `description` | string | Sales description (printed on sales forms). For tax items: text next to the tax amount |
| `purchaseDescription` | string | Description on purchase forms |
| `isPurchased` | bool | Service / Non-inventory / Other Charge: has separate purchase information. Always true for inventory parts |
| `salesPrice` | number | Price / rate; percent when `rateIsPercent` |
| `rateIsPercent` | bool | Only Other Charge and Discount |
| `cost` | number | Purchase cost per unit (not negative) |
| `incomeAccountId` | int | Income account (Discount: discount account) |
| `expenseAccountId` | int | Expense account, or COGS for inventory parts |
| `assetAccountId` | int | Inventory parts: Other Current Asset account |
| `preferredVendorId` | int | Must be a vendor |
| `taxable` | bool | Charge sales tax on this item (Discount: apply before tax) |
| `reorderPoint`, `maxQty` | number/null | Inventory parts: reorder reminder levels |
| `taxRate`, `taxAgencyId` | number, int | Sales Tax Item |
| `paymentMethodId`, `depositAccountId` | int | Payment item |
| `groupLines` | `[{itemId, qty}]` | Group / Sales Tax Group members (`itemName` read-only) |
| `active` | bool | |
| `openingQty`, `openingValue`, `openingDate` | create only | Inventory parts: quantity on hand, total value (default `openingQty × cost`), as-of date |
| `qtyOnHand`, `avgCost`, `assetValue`, `qtyOnPo`, `hasTxns`, `fullName`, `level` | read-only | |

### 4.3 Endpoints

**GET /items** — Item List order (by type in the order of 4.1, then name). Query `active`,
`types=Service,Inventory Part` (exact type names).

```json
{"id":21,"type":"Inventory Part","name":"Bark Mulch","parentId":20,"fullName":"Mulch & Soil:Bark Mulch",
 "level":1,"mpn":"BARKMULC","description":"Bark mulch (cubic yard)","purchaseDescription":"Bark mulch (cubic yard)",
 "isPurchased":true,"salesPrice":45,"rateIsPercent":false,"cost":22,"incomeAccountId":48,
 "expenseAccountId":23,"assetAccountId":6,"preferredVendorId":3,"taxable":true,"reorderPoint":15,
 "maxQty":60,"qtyOnHand":22,"avgCost":21.85818181818182,"assetValue":480.88,"qtyOnPo":0,"taxRate":0,
 "taxAgencyId":null,"paymentMethodId":null,"depositAccountId":null,"groupLines":[],"active":true,
 "hasTxns":true,"updatedAt":"2026-10-21T02:33:50.817219Z"}
```
`avgCost` is not rounded (round it for display); `cost` is the default purchase cost, `avgCost`
the running average used for cost of goods sold.

**GET /items/{id}**, **POST /items**, **PUT /items/{id}** (full replace),
**PUT /items/{id}/active** (`{"active":false}`), **DELETE /items/{id}**.

```bash
curl -s -X POST $B/items -H 'Content-Type: application/json' -d '{"type":"Service","name":"Consulting Hour",
  "description":"Consulting per hour","salesPrice":125,"incomeAccountId":17}'
curl -s -X POST $B/items -H 'Content-Type: application/json' -d '{"type":"Service","name":"Subcontract Labor",
  "salesPrice":80,"incomeAccountId":17,"isPurchased":true,"cost":50,"expenseAccountId":31,
  "purchaseDescription":"Sub labor","preferredVendorId":4}'
curl -s -X POST $B/items -H 'Content-Type: application/json' -d '{"type":"Inventory Part","name":"Widget",
  "description":"Blue widget","purchaseDescription":"Widget from Acme","salesPrice":20,"cost":8,
  "incomeAccountId":17,"taxable":true,"preferredVendorId":4,"reorderPoint":10,
  "openingQty":25,"openingDate":"2026-09-01"}'
curl -s -X POST $B/items -H 'Content-Type: application/json' -d '{"type":"Other Charge","name":"Fuel Surcharge",
  "salesPrice":5,"rateIsPercent":true,"incomeAccountId":18}'
curl -s -X POST $B/items -H 'Content-Type: application/json' -d '{"type":"Discount","name":"10% Off",
  "salesPrice":10,"rateIsPercent":true,"incomeAccountId":17,"taxable":true}'
curl -s -X POST $B/items -H 'Content-Type: application/json' -d '{"type":"Payment","name":"Deposit Received","paymentMethodId":10}'
curl -s -X POST $B/items -H 'Content-Type: application/json' -d '{"type":"Subtotal","name":"Subtotal","description":"Subtotal"}'
curl -s -X POST $B/items -H 'Content-Type: application/json' -d '{"type":"Sales Tax Item","name":"State Tax",
  "description":"State sales tax","taxRate":6.25,"taxAgencyId":8}'
curl -s -X POST $B/items -H 'Content-Type: application/json' -d '{"type":"Sales Tax Group","name":"Combined Tax",
  "description":"State + City","groupLines":[{"itemId":12},{"itemId":13}]}'
curl -s -X POST $B/items -H 'Content-Type: application/json' -d '{"type":"Group","name":"Starter Kit",
  "description":"Widget + consulting","groupLines":[{"itemId":3,"qty":2},{"itemId":1,"qty":1}]}'
```

Inventory opening balance effect: an Inventory Adjust (value adjustment) dated `openingDate`,
memo "Opening balance": quantity on hand = `openingQty`, Inventory Asset up by the value,
Opening Balance Equity up by the same value. Negative `openingQty`/`openingValue` → 400.

Delete is refused (409) when the item has subitems or transactions, is a member of a group
("This item is used in a group. Remove it from the group or make it inactive instead."), is a
customer's tax item ("This sales tax item is assigned to one or more customers..."), or is the
default sales tax item in Preferences.

### 4.4 Rules and gotchas

- Type changes are refused once the item has transactions ("You cannot change the type of an
  item that has been used in transactions.") or subitems; changing a group member into a group
  type is refused.
- Quantity on hand and average cost cannot be edited; use Vendors > Inventory Activities >
  Adjust Quantity/Value On Hand (the "Adjust Inventory" window, an inventory adjustment
  transaction).
- Changing a price, cost or tax rate does not change existing transactions.
- The API creates inventory parts and sales tax items even when inventory / sales tax are off in
  Preferences (CSV import refuses them; the app hides them). Check `GET /prefs`
  (`inventoryEnabled`, `salesTaxEnabled`) before creating them.
- Making a group member inactive is allowed; the group keeps it.

---

## 5. Simple lists

Small lists of named entries, all under `/lists/{list}`. Valid `{list}` values (anything else
→ 404 "Unknown list "price_level"."):

| `{list}` | Screen | `data` | Used by |
|---|---|---|---|
| `terms` | Lists > Customer & Vendor Profile Lists > Terms List | see below | names `termsId`, invoices, bills |
| `payment_method` | ... > Payment Method List | `{"type": ...}` | names, payments, sales receipts, Payment items |
| `ship_via` | ... > Ship Via List (the window is "Shipping Method List") | `{}` | sales forms (SHIPPED BY); Preferences "Usual shipping method" |
| `customer_message` | ... > Customer Message List | `{}` | message printed on invoices / sales receipts. Names up to 100 characters |
| `customer_type` | ... > Customer Type List | `{}` | customers `typeId`, report filters |
| `vendor_type` | ... > Vendor Type List | `{}` | vendors `typeId` |
| `job_type` | ... > Job Type List | `{}` | jobs `jobTypeId` |
| `sales_rep` | ... > Sales Rep List | `{"initials","nameId"}` | customers `repId`, sales forms |
| `class` | Lists > Class List (shown only when Edit > Preferences > Accounting > "Track classes on transactions" is on; the API works either way) | `{}` | transaction lines (class tracking), budgets |

There are no price level, custom field or vehicle lists.

Entry shape:
```json
{"id":35,"list":"terms","name":"3% 15 Net 45","parentId":null,"fullName":"3% 15 Net 45","level":0,
 "active":true,"data":{"dateDriven":false,"discountDays":15,"discountPct":3,"netDays":45},
 "updatedAt":"2026-10-21T02:39:38.249224Z"}
```

### 5.1 Endpoints

| Method + path | Purpose |
|---|---|
| `GET /lists/{list}?active=...` | All entries (tree order). There is no GET of a single entry |
| `POST /lists/{list}` | Create `{name, parentId?, active?, data?}` |
| `PUT /lists/{list}/{id}` | Full replace of `name`, `parentId`, `data`; `active` kept when omitted. Stale check with body `updatedAt` or header `If-Match` |
| `DELETE /lists/{list}/{id}` | 204. Optional `?updatedAt=` / `If-Match` stale check |

There is no `/active` route: make an entry inactive with `PUT` (send the whole entry with
`"active": false`). Subentries (`parentId`, same list) are allowed in every list; making a
parent inactive makes its subentries inactive.

Names: at most 31 characters (customer messages 100), no colon, unique among siblings of the
same list.

### 5.2 Data per list

**terms**
- Standard terms (default): `{"netDays":0..999,"discountPct":0..100,"discountDays":0..999}`.
  "2% 10 Net 30" = `{"netDays":30,"discountPct":2,"discountDays":10}`.
- Date-driven terms: `{"dateDriven":true,"dueDay":1..31,"discountPct":0..100,"discountDay":0..31,"dueNextMonthDays":0..31}`
  (due on `dueDay` of the invoice's month; due on that day of the next month when that day
  has already passed or is only `dueNextMonthDays` days or fewer away).
- Numbers must be JSON numbers (`"30"` as a string is refused). Missing numbers are 0.
  **The name is not parsed**: an entry named "Net 10" with no data has `netDays:0` (due on receipt).

**payment_method** — `{"type": T}` where T is one of `Cash`, `Check`, `American Express`,
`Discover`, `MasterCard`, `Visa`, `Debit Card`, `E-Check`, `Gift Card`, `Other`,
`Other Credit Card`. Missing type = `Other`; anything else → 400 "Choose a valid payment type."

**sales_rep** — `{"initials":"JS","nameId":12}`. Initials default to the first letters of the
words of the name (max 5 characters). `nameId` optionally links the rep to any name (customer,
vendor or other name); null when not linked.

Other lists store `data` as sent (normally `{}`).

### 5.3 Defaults in a new company

terms: 1% 10 Net 30, 2% 10 Net 30, Due on receipt, Net 15, Net 30, Net 60.
payment_method: American Express, Cash, Check, Debit Card, Discover, E-Check, Gift Card,
MasterCard, Visa. customer_message: 4 standard messages ("Thank you for your business." ...).
ship_via: Courier, FedEx, Local delivery, UPS, USPS. customer_type: Online, Referral, Repeat
customer, Walk-in. vendor_type: Contractors, Materials, Services, Supplies, Tax agencies.
class, job_type and sales_rep start empty. Ids differ per company: look them up with GET.

### 5.4 Delete rules

Refused (409) when the entry has subentries ("... has subentries and cannot be deleted. Make it
inactive instead.") or is used by a name, transaction, transaction line, item or budget ("...is
used by names or transactions and cannot be deleted. Make it inactive instead."). Deleting the
ship via that is the Preferences default clears that preference. A DELETE under the wrong
`{list}` → 404 "List entry not found."

---

## 6. CSV export and import

### 6.1 Where it is in the app

- Import: **File > Utilities > Import > Excel/CSV Files...** Choose Customers, Vendors, Items,
  Accounts or Other names, drop or choose the file. The window shows which columns it
  recognizes (unknown columns are ignored) and a short preview, then Import, then a result
  ("added", "updated", "rows skipped" with the reason of each skipped row). Also reachable from
  Chart of Accounts / Item List / Other Names List (bottom menu "Import from CSV...") and
  Customer Center (Export ▾ > Import from CSV…) and Vendor Center (Export ▾ > Import vendors
  from a CSV file…).
- Export: **File > Utilities > Export > Lists to CSV...** (checkboxes for each list; one file
  each), or "Export to CSV" in the bottom menu of Chart of Accounts, Item List and Other Names
  List. These files use exactly the import columns, so they are the best template: export,
  edit in Excel, import back.
- Not importable: Customer Center "Export ▾ > Export Customer List", Vendor Center "Export vendor
  list" and the "Export selected" buttons of the lists make display reports (columns like
  "Customer", "Balance Total"); they have no "Name" column the importer needs (the selected-items
  export does have Name/Type/Price/Cost and imports partially).
- From Excel: File > Save As > "CSV (Comma delimited)" or "Unicode Text".
- Import requires an administrator of the company file (others: 403 "Only an administrator can
  import lists."). Export does not.

### 6.2 GET /export/{entity}

`{entity}` = `accounts`, `customers` (customers and jobs), `vendors`, `items`, `other`
(404 "Unknown export "employees" (use accounts, customers, vendors, items or other).").
Returns `text/csv; charset=utf-8` with `Content-Disposition: attachment; filename="customers.csv"`.
Includes inactive records (Active = Yes/No), in list order, full names ("Parent:Child").
Text cells starting with `=`, `@`, `+` or `-` (that are not plain numbers) get a leading
apostrophe so spreadsheets do not run them as formulas.

```bash
curl -s $B/export/customers -o customers.csv
```

### 6.3 POST /import/{entity}

- Same `{entity}` values as export.
- Body: `multipart/form-data` with the file in the field named **`file`**. JSON or raw CSV
  bodies are refused (400 "Upload a CSV file in the "file" field ..." / 415).
- Encoding: UTF-8 (with or without byte-order mark), UTF-16 (Excel "Unicode Text") or
  Windows-1252 (Excel CSV on Windows; "Café" stays readable). Separator: comma, tab or
  semicolon, detected from the first non-blank line. Quotes follow normal CSV rules; a value
  containing the separator (e.g. `Garcia, Maria`) **must be in double quotes**, otherwise it is
  split into two columns.
- First non-blank row = header. Headers are matched without regard to case; column order does
  not matter; only the columns present are used; unknown columns are ignored. A "Name" column is
  required (400 "The first row of the file must be a header row with a "Name" column.").
  Blank rows are skipped. Empty file → 400 "The file is empty."
- No preview or dry-run on the server: each call writes. (The app's preview is only in the
  browser.)

```bash
curl -s -X POST -F "file=@customers.csv" $B/import/customers
# {"imported":4,"updated":0,"errors":["Row 6: terms \"Net 99\" not found in the Terms List",
#   "Row 7: the name \"Acme Supply\" is already in use by a vendor"]}
```

Response: `imported` = new records, `updated` = existing records changed, `errors` = one
message per skipped row. "Row N" is the line number in the file (the header is row 1). The
HTTP status is 200 even when rows were skipped; bad rows are skipped and good rows are saved.
Parents created automatically (see below) are not counted.

**Matching and updating**
- A row whose Name (full "Parent:Child" name) already exists, case-insensitive, **updates**
  that record; otherwise a new record is created. Importing the same file twice creates no
  duplicates. Two rows with the same Name in one file: the second updates the first.
- On update, **blank cells keep the current value** and missing columns are left alone. A CSV
  can therefore never clear a field; use the API (GET then PUT) or the screen for that.
- "Parent:Child" names create missing parents automatically (accounts and items get the row's
  type; a missing customer for "Customer:Job" is created as a plain taxable customer). Vendors
  and other names cannot contain a colon.
- Names must still be unique across customers, vendors and other names: a customers file row
  whose name is an existing vendor is skipped.
- Opening balances, quantities on hand, credit limits, tax settings, 1099 data, types, reps,
  job info, group members and anything else not in the column tables below cannot be imported.
  Set them afterwards with the API or the screens.

**Value formats**
- Yes/No columns (Active, Taxable): Yes/No, Y/N, True/False, 1/0, X, Active/Inactive,
  Tax/Taxable/Non, T/F. Blank: Active = Yes for new records; Taxable = No for new items.
- Amounts (Price, Cost, Reorder Point): `1,234.50`, `$12`, `(5.00)` (negative), `15%` (percent).
  Quote values containing a comma: `"1,250.00"`.
- Account references (item Income / Expense/COGS / Asset Account): the account's full name
  ("Landscaping Services:Design Services"), its number ("4000") or "number · name"
  ("4000 · Service Income", with the middle dot). Must already exist.
- Terms: the exact name of an existing Terms List entry (case-insensitive).
- Preferred Vendor: the name of an existing top-level vendor (for a Sales Tax Item it is the
  tax agency).
- Type columns accept the names in sections 2.1 / 4.1 and QuickBooks IIF codes (below).

### 6.4 Accounts columns

| Column | Required | Meaning |
|---|---|---|
| Name | yes | Full name, "Parent:Child" for subaccounts |
| Type | for new accounts | Account type (2.1), case-insensitive, or IIF code: BANK, AR, OCASSET, FIXASSET, OASSET, AP, CCARD, OCLIAB, LTLIAB, EQUITY, INC, COGS, EXP, EXINC (Other Income), EXEXP (Other Expense), NONPOSTING. A different type on an existing account changes its type (same rules as 2.6) |
| Number | no | Account number (unique) |
| Description | no | |
| Bank Acct No | no | Bank or card account number |
| Note | no | |
| Active | no | Yes/No |

Not importable: opening balance, routing number, tax line.

```csv
Name,Type,Number,Description,Bank Acct No,Note,Active
Business Savings,Bank,10150,High-yield savings at First Bank,4455667788,,Yes
Vehicles,Fixed Asset,15100,Company vehicles,,,
Vehicles:2022 Ford Transit,Fixed Asset,15110,Work van,,,
Marketing,Expense,60100,,,,
Marketing:Online Ads,Expense,60110,Google and social media ads,,,
Shop Supplies,Expense,64950,Small tools and shop supplies,,,
Owner Loan,Long Term Liability,27500,Loan from the owner,,,
```

### 6.5 Customers, vendors and other names columns (same columns for all three)

| Column | Field |
|---|---|
| Name | Full name (customers: "Customer:Job" for jobs). Required |
| Company | `companyName` |
| Salutation | `salutation` (Mr., Ms. ...) |
| First, Last | `firstName`, `lastName` |
| Phone, Mobile, Fax, Email | contact |
| Bill Line1, Bill Line2, Bill City, Bill State, Bill Zip | bill address |
| Ship Line1, Ship City, Ship State, Ship Zip | ship address (no line 2) |
| Terms | Terms List entry name |
| Account No | `accountNumber` |
| Notes | `notes` |
| Active | Yes/No |

New customers (and jobs) are created taxable; vendors and other names non-taxable. Not
importable: middle name, job title, alt phone, CC email, website, address line 3 / country,
ship line 2, credit limit, types, rep, payment method, tax item, resale number, print-on-check
name, tax id, 1099 flag, prefill accounts, job fields, opening balance. Import order when files
depend on each other: accounts, then vendors (needed as preferred vendors / tax agencies), then
customers, then items.

Customers:
```csv
Name,Company,Salutation,First,Last,Phone,Mobile,Fax,Email,Bill Line1,Bill Line2,Bill City,Bill State,Bill Zip,Ship Line1,Ship City,Ship State,Ship Zip,Terms,Account No,Notes,Active
"Garcia, Maria",,Ms.,Maria,Garcia,(555) 201-1000,(555) 201-1001,,maria@example.com,45 Oak Ave,,Austin,TX,78701,45 Oak Ave,Austin,TX,78701,Net 30,C-100,Prefers email,Yes
Riverside Dental,Riverside Dental LLC,,Tom,Lee,(555) 201-2000,,,office@riverside.example.com,Riverside Dental LLC,900 River Rd,Austin,TX,78702,,,,,Net 15,C-101,,Yes
Riverside Dental:Lobby Remodel,Riverside Dental LLC,,Tom,Lee,(555) 201-2000,,,,Riverside Dental LLC,900 River Rd,Austin,TX,78702,,,,,Net 15,,,Yes
```

Vendors:
```csv
Name,Company,Salutation,First,Last,Phone,Mobile,Fax,Email,Bill Line1,Bill Line2,Bill City,Bill State,Bill Zip,Ship Line1,Ship City,Ship State,Ship Zip,Terms,Account No,Notes,Active
Office Depot,Office Depot Inc.,,,,(800) 463-3768,,,orders@officedepot.example.com,Office Depot Inc.,PO Box 1000,Dallas,TX,75201,,,,,Net 30,ACCT-5521,,Yes
Lopez Electric,Lopez Electric LLC,Mr.,Juan,Lopez,(555) 300-1000,,,juan@lopez.example.com,Lopez Electric LLC,12 Spark St,Austin,TX,78703,,,,,Net 15,,Subcontractor,Yes
Texas Comptroller,Texas Comptroller of Public Accounts,,,,,,,,Texas Comptroller,PO Box 149354,Austin,TX,78714,,,,,,,Sales tax agency,Yes
```

A short file is fine too (only Name is required):
```csv
Name,Phone,Email
Riverside Dental,(555) 999-0000,
```
(updates only the phone of the existing customer; the blank email is left as it was).

### 6.6 Items columns

| Column | Meaning |
|---|---|
| Name | Full name ("Parent:Child" for subitems). Required |
| Type | Required for new items. Item type (4.1) or alias: Serv, Inventory, InvtPart, Non-inventory, Part (= Non-inventory Part), OthC, Subt, Disc, Pmt, Sales Tax, CompTax. **Group and Sales Tax Group rows cannot create items** ("group items cannot be imported; create them in the Item List") |
| Description | Sales description |
| Purchase Description | |
| Price | Sales price; `15%` = percent (Other Charge and Discount only). Sales Tax Item: the tax rate (`8.25%` or `8.25`). Ignored for Sales Tax Group |
| Cost | Purchase cost |
| Income Account | Account reference. Needed for Service, Inventory Part, Non-inventory Part, Other Charge, Discount |
| Expense/COGS Account | Expense account (COGS for inventory parts; blank = Cost of Goods Sold) |
| Asset Account | Inventory parts (blank = Inventory Asset) |
| Taxable | Yes/No |
| Preferred Vendor | Vendor name; for a Sales Tax Item this is the tax agency (required for new tax items) |
| Reorder Point | Inventory parts |
| Active | Yes/No |

Service / Non-inventory / Other Charge rows get purchase information (`isPurchased`) when the
row has a Cost, a Purchase Description, or an Expense account different from the Income
account. Inventory parts and sales tax items are refused when inventory / sales tax is off in
Preferences ("inventory is turned off: turn on inventory in Preferences (Items & Inventory) to
import inventory parts"). Quantity on hand cannot be imported: after importing inventory parts,
enter stock with Vendors > Inventory Activities > Adjust Quantity/Value On Hand (or create the
part through the API with `openingQty`).

```csv
Name,Type,Description,Purchase Description,Price,Cost,Income Account,Expense/COGS Account,Asset Account,Taxable,Preferred Vendor,Reorder Point,Active
Consulting,Service,Consulting (per hour),,125,,Service Income,,,No,,,Yes
Electrical Work,Service,Electrical work (subcontracted),Subcontracted electrician,95,60,Service Income,Professional Fees,,No,Lopez Electric,,Yes
Hardware,Inventory Part,Hardware,,,,Service Income,Cost of Goods Sold,Inventory Asset,Yes,,,Yes
Hardware:Brass Hinge,Inventory Part,Brass hinge,Brass hinge (box of 10),4.50,1.75,Service Income,Cost of Goods Sold,Inventory Asset,Yes,Office Depot,50,Yes
Printer Paper,Non-inventory Part,Printer paper (case),Printer paper (case),42,30,Service Income,Office Supplies,,Yes,Office Depot,,Yes
Rush Fee,Other Charge,Rush fee (15% of the line above),,15%,,Reimbursement Income,,,No,,,Yes
Loyalty Discount,Discount,5% loyalty discount,,5%,,Service Income,,,Yes,,,Yes
Subtotal,Subtotal,Subtotal,,,,,,,,,,Yes
Travis County Tax,Sales Tax Item,Travis County sales tax,,8.25%,,,,,,Texas Comptroller,,Yes
```
(The account names are from the "Services" default chart (`general_service`); the vendors
come from the vendors sample above, which must be imported first.)

### 6.7 Building a CSV for a user (checklist)

1. Ask the user to export the current list first (File > Utilities > Export > Lists to CSV...)
   or `GET /export/{entity}`: it shows the exact account, terms and vendor names to reference.
2. Keep the header row exactly as in the tables above (extra columns are ignored).
3. Quote every value that contains a comma; save as UTF-8.
4. Reference only accounts, terms and vendors that already exist (or import them first).
5. After the import, read the `errors` list (or the "rows skipped" list in the window), fix
   those rows and import the same file again: rows already imported are updated, not duplicated.
6. Set what CSV cannot carry (opening balances, credit limits, 1099, tax items, groups) by API
   or in the edit dialogs.

### 6.8 Export / import gotchas

- Export is not a full backup: it holds only the columns above (no balances, no quantities on
  hand, no 1099 or tax settings, no ship address line 2). Use File > Back Up Company for backups.
- A text value that starts with `=`, `@`, `+` or `-` is exported with a leading apostrophe
  ("'+1 555 0100"). The importer keeps the apostrophe, so re-importing such an export creates a
  new record named "'=..." and writes apostrophes into phones/notes. Remove those apostrophes
  before importing.
- Sample-style addresses keep the addressee in line 1 and the street in line 2; the export has
  no Ship Line2, so the ship street is lost in the CSV.

---

## 7. Error messages you will meet

| HTTP / code | Message (start) | Meaning / fix |
|---|---|---|
| 400 validation `name` | "You must enter a name for this account." / "The name cannot contain a colon (:)." / "The name is too long (100 characters maximum)." | Fix the name |
| 409 conflict | "The name "X" is already in use. Please use a different name." | Sibling with that name exists (case-insensitive) |
| 409 conflict + `data.existingId` | "The name "X" is already used by a vendor. Names must be unique across customers, vendors and other names." | Use another name, or reuse / reactivate `existingId` |
| 409 conflict | "Someone else changed this ... after you opened it..." | Stale `updatedAt`: GET again and redo the change |
| 400 `type` | "Choose a valid account type." / "Choose a valid item type." | Use the exact strings of 2.1 / 4.1 |
| 400 `parentId` | "A subaccount must be the same type as its parent account (Bank)." / "A subitem must be the same type as its parent item (Inventory Part)." / "Only customers can have jobs." / "A record cannot be placed under itself or one of its own subrecords." | |
| 400 `number` | "The account number "10200" is already in use..." | |
| 400 `openingBalance` | "Only balance sheet accounts have an opening balance." / "Accounts receivable and accounts payable balances are entered for each customer or vendor..." / "Other names do not have an opening balance." | |
| 409 confirm `creditlimit` | "This transaction will put X over its credit limit of 100.00 (new balance 500.00). Do you want to save it anyway?" | Ask the user; retry with `?accept=creditlimit` |
| 400 `incomeAccountId` | "You must choose an income account for this item." | Also given by a partial PUT that left the account out |
| 400 `expenseAccountId` | "You must choose an expense account for the purchase information of this item." | `isPurchased:true` needs `expenseAccountId` |
| 400 `assetAccountId` | "The inventory asset account must be an Other Current Asset account." | |
| 400 `taxAgencyId` | "You must choose the tax agency (a vendor) this sales tax is paid to." / "The tax agency must be a vendor." | |
| 400 `groupLines` | "A group must contain at least one item." / "A group cannot contain another group." / "A sales tax group can only contain sales tax items." | |
| 400 `termsId` etc. | "The selected entry belongs to the wrong list (payment_method)." / "The selected list entry does not exist." | Use an id from the right `/lists/{list}` |
| 400 `data.*` | "The net due days must be a number between 0 and 999." / "Choose a valid payment type." / "Sales rep initials can have at most 5 characters." | |
| 409 conflict | "... Make it inactive instead." | Delete refused because the record is in use: use `PUT .../active` |
| 403 forbidden | "Only an administrator can import lists." | Log in as an administrator |
| 404 not_found | "Account not found." / "Name not found." / "Item not found." / "Unknown list "x"." | |
