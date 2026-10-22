# SerieX Books: company files, setup and administration

Creating, copying, backing up, restoring and deleting company files; company information,
preferences, closing date, users and passwords; checking and repairing the company file; the audit trail;
memorized transactions, budgets, reminders, the to do list and printing queues; and bringing
books over from QuickBooks Desktop.

Read connecting.md first (finding the server, login, `X-Session`, errors, Yes/No questions,
closing date password). Every request example here was run against a live SerieX Books
2026.10.2 server; ids are from test files and will differ.

```
B=http://127.0.0.1:47180          # see connecting.md, section 1
C=$B/api/c/<company id>           # company routes
J='Content-Type: application/json'
# add  -H "X-Session: $TOKEN"  when the file has passwords
```

## Contents

1. [Where things are in the app](#1-where-things-are-in-the-app)
2. [Company files](#2-company-files)
   - 2.1 [Business templates](#21-business-templates-get-apicompaniestemplates)
   - 2.2 [Create a company](#22-create-a-company-post-apicompanies)
   - 2.3 [The sample company](#23-the-sample-company-post-apicompaniessample)
   - 2.4 [Copy](#24-copy-post-apicompaniesidcopy)
   - 2.5 [Download a backup file](#25-download-a-backup-file-get-apicompaniesidbackup)
   - 2.6 [Restore a backup file](#26-restore-a-backup-file-post-apicompaniesrestore)
   - 2.7 [Delete](#27-delete-delete-apicompaniesid)
3. [Automatic backups](#3-automatic-backups)
4. [Company information](#4-company-information-get--put-company)
5. [Preferences](#5-preferences-get--put-prefs)
6. [Closing date](#6-closing-date-get--put-closing-date)
7. [Users and passwords](#7-users-and-passwords-users)
8. [Check Company File and Repair Company File](#8-check-company-file-and-repair-company-file)
9. [Audit trail](#9-audit-trail-get-audit)
10. [Memorized transactions](#10-memorized-transactions-memorized)
11. [Budgets](#11-budgets-budgets)
12. [Reminders](#12-reminders-get-reminders)
13. [To do list](#13-to-do-list-todos)
14. [Checks and invoices to print](#14-checks-and-invoices-to-print)
15. [QuickBooks Desktop import](#15-quickbooks-desktop-import)
16. [Pitfalls checklist](#16-pitfalls-checklist)

---

## 1. Where things are in the app

| Task | Menu path |
|---|---|
| New company | File > New Company... |
| Open a file, restore a backup | File > Open or Restore Company... (window "Open Company or Backup", choices "Open a company file" and "Restore a backup") |
| Sample company | Welcome screen (no company open) > "Explore the sample company" |
| Back up now / download a backup / backup settings | File > Back Up Company > Back Up Now, Create Local Backup..., Automatic Backup Settings... (also Company > Backup Settings...) |
| Copy | File > Create Copy... |
| Check / repair the company file | File > Utilities > Check Company File, Repair Company File |
| QuickBooks import | File > Utilities > Import > QuickBooks® Desktop (IIF files)... (into the open, empty file); welcome screen > "Import your books" (new file) |
| Print checks / invoices | File > Print Forms > Checks..., Invoices... |
| Company information | Company > Company Information... |
| Users | Company > Set Up Users and Passwords > Set Up Users... |
| Closing date | Company > Set Closing Date... (also Edit > Preferences > Accounting) |
| Budgets | Company > Planning & Budgeting > Set Up Budgets... |
| To do list, reminders | Company > To Do List, Company > Reminders |
| Preferences | Edit > Preferences... |
| Memorized transactions | Lists > Memorized Transaction List (Ctrl+T) |
| Audit trail | Reports > For Your Accountant > Audit Trail (administrators) |
| Data folder, logs (desktop app) | Help > Open Data Folder, Help > Show Logs |

## 2. Company files

A company file is one `<id>.sxb` file in `<data>/books/` (a SQLite database). The id comes from
the name: lowercase letters, digits and dashes (`Blue Fern Consulting LLC` ->
`blue-fern-consulting-llc`); a name already used gets `-2`, `-3`. `GET /api/companies` lists them
(connecting.md, section 3). These routes are global (`/api/companies/...`, not `/api/c/...`).

### 2.1 Business templates: `GET /api/companies/templates`

-> `[{"key", "label", "description"}]` in this order. Every template also gets the common
accounts below.

| `key` | Label | Adds |
|---|---|---|
| `general_product` | Product sales | Merchandise Sales, Shipping and Delivery Income, Sales Discounts; Cost of Goods Sold, Freight and Shipping Costs; Merchant Account Fees, Postage and Delivery |
| `general_service` (default) | Services | Service Income, Reimbursement Income; Business Licenses and Permits, Dues and Subscriptions, Postage and Delivery |
| `construction` | Construction and trades | Construction Income (subaccounts Labor, Materials, Subcontracted Labor Income); Job Expenses (Equipment Rental, Job Materials, Permits and Licenses, Subcontractors); Vehicles |
| `retail` | Shop or online store | Merchandise Sales, Shipping and Delivery Income, Sales Discounts; Freight and Shipping Costs; Merchant Account Fees, Store Supplies |
| `consulting` | Consulting and professional services | Consulting Income, Reimbursement Income; Business Licenses and Permits, Continuing Education, Dues and Subscriptions, Outside Services |
| `restaurant` | Food and drink | Food Sales, Beverage Sales, Catering Income; Food Purchases, Beverage Purchases; Business Licenses and Permits, Merchant Account Fees, Linen and Laundry, Restaurant Supplies |
| `nonprofit` | Nonprofit organization | Direct Public Support (Corporate Contributions, Foundation and Trust Grants, Individual Contributions), Government Grants, Program Income, Membership Dues, Special Events Income; Contract Services, Conferences and Meetings, Printing and Copying, Postage and Delivery; net asset equity accounts |
| `manufacturing` | Manufacturing | Product Sales, Shipping and Delivery Income, Sales Discounts; Freight and Shipping Costs, Subcontracted Services, Production Supplies; Machinery and Equipment; Equipment Rental, Small Tools and Equipment |
| `landscaping` | Landscaping and garden care | Landscaping Services (Design, Installation, Maintenance Services); Job Expenses (Equipment Rental, Job Materials, Plants and Soil, Subcontractors); Vehicles |
| `none` | Other (basic accounts only) | Only the accounts SerieX needs: Accounts Receivable, Undeposited Funds, Accounts Payable, Opening Balance Equity, Retained Earnings, Uncategorized Income, Uncategorized Expenses, To Review with Accountant (plus Inventory Asset and Cost of Goods Sold with inventory, Sales Tax Payable with sales tax) |

Common accounts of every template except `none` (numbered, 4 digits): Checking, Savings, Petty
Cash, Accounts Receivable, Undeposited Funds, Furniture and Equipment, Accumulated Depreciation,
Accounts Payable, Credit Card, Loan Payable, Opening Balance Equity, owner equity accounts,
Retained Earnings, Uncategorized Income, 16 common expenses (Advertising and Promotion,
Automobile, Bank Service Charges, Computer and Internet, Depreciation, Insurance with Liability
Insurance, Interest, Meals and Entertainment, Office Supplies, Professional Fees, Rent, Repairs
and Maintenance, Telephone, Travel, Utilities), Uncategorized Expenses, To Review with Accountant,
Interest Income. Cost of Goods Sold is added for product and job templates or when inventory is
on; Inventory Asset with inventory; Sales Tax Payable with sales tax.

Owner equity accounts follow `entityType`: contains "S Corp" -> Capital Stock, Shareholder
Distributions; "Corp"/"Inc" -> Capital Stock, Dividends Paid; "Partner"/"LLP"/multi-member LLC ->
Partner Contributions, Partner Distributions; "profit"/"501" (or the nonprofit template) -> Net
Assets With Donor Restrictions, and Retained Earnings is named Net Assets Without Donor
Restrictions; anything else (sole proprietor, single member LLC) -> Owners Equity, Owners Draw.
The app's choices for `entityType`: `Sole Proprietorship`, `Partnership or LLP`,
`LLC (single member)`, `LLC (multi member)`, `Corporation`, `S Corporation`, `Non-Profit`,
`Other/None`.

### 2.2 Create a company: `POST /api/companies`

```sh
curl -s -X POST $B/api/companies -H "$J" -d '{"name":"Blue Fern Consulting LLC","industry":"consulting",
  "entityType":"LLC (single member)","fiscalYearStartMonth":1,"createDefaultAccounts":true,
  "salesTaxEnabled":false,"inventoryEnabled":false,"city":"Portland","state":"OR"}'
```

-> `200 {"id":"blue-fern-consulting-llc","name":"Blue Fern Consulting LLC","fileName":"blue-fern-consulting-llc.sxb","path":"...","modified":"2026-10-21T02:36:42Z","size":315392}`

| Field | Type | Req. | Meaning / default |
|---|---|---|---|
| `name` | string | yes | Company name, at most 100 characters. Also makes the file id. |
| `industry` | string | no | Template `key` (2.1). Default `general_service`. Unknown -> `400 field industry`. |
| `createDefaultAccounts` | bool | no | **Default `false` = only the `none` accounts.** Send `true` to get the template's chart. |
| `entityType` | string | no | Picks the owner equity accounts (2.1). |
| `fiscalYearStartMonth` | int 1-12 | no | Default 1. The income tax year starts the same month. |
| `salesTaxEnabled` | bool | no | Turns on the sales tax preference and adds Sales Tax Payable. No tax item or agency is created: add a Sales Tax Item (lists reference) and set `defaultSalesTaxItemId` in preferences, as the app's wizard does. |
| `inventoryEnabled` | bool | no | Turns on inventory **and** purchase orders; adds Inventory Asset and Cost of Goods Sold. |
| `adminPassword` | string | no | Password of the `Admin` user, at least 8 characters. Empty = no password (no login needed). |
| `legalName` | string | no | Default = `name`. |
| `country` | string | no | Default `US`. |
| `taxId`, `address1`, `address2`, `city`, `state`, `zip`, `phone`, `email`, `website` | string | no | Company information. |

What a new file has: the `Admin` user (administrator), default preferences (section 5; service
templates without inventory start with the Service Invoice template, shown as the "Services"
layout), default terms (Net 15/30/60, Due on receipt, 1% 10 Net 30, 2% 10 Net 30), payment
methods, customer messages, shipping methods (ship via), customer and vendor types. No transactions. Nothing else is asked; the app's wizard
then sets estimates / classes / PO preferences and adds bank accounts with opening balances
through the normal routes.

Errors: `400 validation` with `field` `name` ("Enter the name of your company."), `industry`,
`fiscalYearStartMonth`.

### 2.3 The sample company: `POST /api/companies/sample`

Body `{}`. Creates `sample-harborview`, "Harborview Landscaping & Supply (Sample)": 18 months of
made-up activity ending today, classes, sales tax, inventory, budgets, memorized transactions,
to dos. Takes about 2 seconds. Same response shape as 2.2.

**It deletes and re-creates an existing sample file**: everything entered in the sample is lost.
If the sample was given passwords, its administrator must log in (`X-Session`) or send
`{"user","password"}` in the body. Use the sample to try things; never for real books.

### 2.4 Copy: `POST /api/companies/{id}/copy`

Body `{"name": "Blue Fern Practice Copy"}` (required, at most 100 characters) -> the new file
(2.2 shape). The copy gets this company name and an id made from it, and keeps everything else:
transactions, users and passwords, closing date and its password, preferences, backup settings.
Needs a session of an administrator of the source file when it has passwords (`401 auth
"Please log in to this company file first."` without a session, `403` "Only an administrator of
this company file can make a copy of it." for other users). App: File > Create Copy...

### 2.5 Download a backup file: `GET /api/companies/{id}/backup`

Returns the whole file as `application/octet-stream`, with
`Content-Disposition: attachment; filename="Blue Fern Consulting LLC 2026-10-20.sxb"`. A
consistent copy is made even while people work. When the file has passwords only an
administrator may download it (`403` "Only an administrator of this company file can download a
backup of it." for other users). The download is recorded in the backup list as kind `download`.

```sh
curl -s -o "Blue Fern 2026-10-20.sxb" $B/api/companies/blue-fern-consulting-llc/backup -H "X-Session: $T"
```

This is the right way to copy a company file elsewhere (never copy the `.sxb` file itself while
SerieX runs). App: File > Back Up Company > Create Local Backup...

### 2.6 Restore a backup file: `POST /api/companies/restore`

`multipart/form-data` with field `file` (a `.sxb` backup, gzip-compressed also accepted) and
optional field `name`. Always creates a **new** company file; nothing existing is replaced.

```sh
curl -s -X POST $B/api/companies/restore -F "file=@Blue Fern 2026-10-20.sxb" -F "name=Blue Fern Restored"
```

-> `{"id":"blue-fern-restored","name":"Blue Fern Consulting LLC",...}`

- `name` only sets the new file id; the company name inside stays as it was in the backup, so the
  list shows two files with the same name. Rename one with `PUT /company` (section 4) to avoid
  mix-ups.
- The restored file keeps its users and passwords; sessions do not carry over (log in again).
- No login is needed for this route.
- Errors (`400`, `field: "file"`): "This file is not a SerieX Books company file or backup.",
  made by a different version, damaged, not enough disk space; "Upload the backup file as
  multipart form data in the "file" field."

To put a backup back **in place of** a file's current data, use an automatic backup and
`mode: "replace"` (section 3).

### 2.7 Delete: `DELETE /api/companies/{id}`

Also `POST /api/companies/{id}/delete` (same thing, for clients that cannot send a body with
DELETE). Permanently removes the company file -> `204`. Its automatic backup folder is kept.

- No passwords in the file: anyone may delete.
- With passwords: an administrator's `X-Session`, or body `{"user":"Admin","password":"..."}` of
  an administrator. Otherwise `403 forbidden` (`field: "password"`) "This company file is
  protected by passwords. Only its administrator can delete it...". Wrong password:
  `400 validation`.

Deleting cannot be undone from SerieX (only from a backup). Do it only when the user clearly
asked for that file to be deleted, after naming the file and suggesting a backup download first.

## 3. Automatic backups

Each company file is copied into its backup folder, by default `<data>/books/backups/<id>/`, as
`<id>_YYYY-MM-DD_HH-MM-SS.sxb`. Kinds of backups:

| `kind` | When |
|---|---|
| `auto` | On a timer (checked every minute): when the last backup in the folder is older than the interval (24 hours by default; server flag `-backup-interval`) **and** the file changed since. A new file gets its first one within a minute. |
| `close` | When the app closes the company (`POST /backups/close`) and when the server stops (the desktop app quits), only if the file changed. |
| `manual` | Back Up Now (`POST /backups`): always. |
| `restore` | The current data, saved just before a backup replaced it. |
| `download` | A downloaded backup (2.5). Listed as `last` but not in `backups` (it is not in the folder). |

Only the newest `keep` backups in the folder are kept (older files made for this company are
deleted). Settings are stored in the company file, so a copy or a file restored as new keeps
them; replacing a file from a backup keeps the file's current settings and backup list.

Routes (company routes under `/api/c/{cid}`):

**`GET /backups`** -> status and the backups in the folder, newest first:

```json
{"enabled": true, "folder": "", "keep": 14,
 "folderInUse": "/Users/me/Library/Application Support/SerieX/books/backups/blue-fern-consulting-llc",
 "defaultFolder": ".../books/backups/blue-fern-consulting-llc", "canChange": true,
 "intervalSeconds": 86400,
 "last": {"id": 3, "time": "2026-10-21T02:40:37Z", "kind": "download", "file": "", "path": "", "size": 331776, "exists": false},
 "nextDue": "2026-10-22T02:37:25Z", "changed": true, "error": "", "errorTime": "",
 "backups": [{"id": 2, "time": "2026-10-21T02:40:22Z", "kind": "manual",
   "file": "blue-fern-consulting-llc_2026-10-20_22-40-22.sxb", "path": ".../blue-fern-consulting-llc_2026-10-20_22-40-22.sxb",
   "size": 331776, "exists": true}]}
```

`changed`: the file changed since its last backup in the folder. `nextDue` is `""` when automatic
backups are off. `error`/`errorTime`: the last automatic backup failed (for example the folder is
gone or the disk is full); tell the user. Times are UTC.

**`GET /backups/settings`** -> `{enabled, folder, keep, folderInUse, defaultFolder, canChange}`.

**`PUT /backups/settings`** (administrator) body, partial (omitted fields are kept):
`enabled` (bool, default true), `folder` (absolute path; `""` = default folder; created when
missing; must be writable; not the company file folder), `keep` (1-365, default 14). Errors:
`400` "Keep between 1 and 365 backups.", "Enter the full location of the backup folder...".
A folder on another drive or a synced folder protects against losing the computer.

**`POST /backups`** Back up now -> the new entry `{"id":2,"time":...,"kind":"manual",...}`. Any user.

**`POST /backups/close`** -> `202 {"ok": true}`: backs up in the background if the file changed.
The app sends it when a company is closed; an assistant rarely needs it.

**`POST /backups/{bid}/restore`** body `{"mode": "new" | "replace", "name": "..."}` (`bid` = `id`
from `GET /backups`; downloads cannot be restored this way):

- `mode: "new"`: makes a new company file from the backup. Default id from
  "<company name> <date of the backup>" (for example `blue-fern-consulting-llc-2026-10-20`);
  `name` changes the id only, the company name inside stays. Returns the new file.
- `mode: "replace"` (administrator): replaces the current data with the backup. First answer is
  the Yes/No question `409 confirm`, `warning: "restore"`:
  "Replace the data of "Blue Fern Consulting LLC" with the backup from 10/20/2026 10:40 PM?
  Everything entered after that backup is removed. A backup of the current data is made first, so
  you can go back to it. Everybody working in this company file is logged out."
  Show it to the user; resend with `?accept=restore` only after a Yes. Then the current data is
  saved as a `restore` backup, the file is replaced, and **every session of the file ends**
  (including yours: log in again). Returns the company file.

Errors: `404` "This backup is not in the list of backups of the company file.", "The backup file
... is no longer in the backup folder."; `400 field mode`.

## 4. Company information: `GET` / `PUT /company`

`GET /company`:

```json
{"name": "Blue Fern Consulting LLC", "legalName": "Blue Fern Consulting LLC", "address1": "", "address2": "",
 "city": "Portland", "state": "OR", "zip": "", "country": "US", "phone": "", "fax": "", "email": "", "website": "",
 "taxId": "", "industry": "consulting", "entityType": "LLC (single member)", "fiscalYearStartMonth": 1,
 "taxYearStartMonth": 1, "closingDate": "", "hasClosingPassword": false,
 "createdAt": "2026-10-21T02:36:42Z", "companyId": "blue-fern-consulting-llc"}
```

`PUT /company` (administrator): send only the fields to change; the others keep their values.
`name` required (at most 100), `state` 40, `zip` 20, `country` 60, `email`/`website` 200, `taxId`
40, others 100; `fiscalYearStartMonth` and `taxYearStartMonth` 1-12. `closingDate`,
`hasClosingPassword`, `createdAt`, `companyId` are read only (ignored). Returns the new values.

- Changing `name` changes the name shown everywhere, not the file id.
- Changing `industry` or `entityType` later does **not** change the chart of accounts.
- `fiscalYearStartMonth` changes the "this fiscal year" date ranges of reports, the balance
  sheet's split between Retained Earnings and Net Income, and the months of budgets.
  `taxYearStartMonth` is stored for information only.

## 5. Preferences: `GET` / `PUT /prefs`

One set of preferences per company file (Edit > Preferences...). `PUT /prefs` is partial: send
only what changes; the response is the full set. Account ids of `0` mean none (`null`).
A regular user may change only the "personal" fields (marked P); everything else needs an
administrator (`403` "Only an administrator can change company preferences. You can change your
own preferences..."). Even the P fields are stored once per file, so they change it for everybody.

Fields marked "screens" only change how the app's screens behave; the server does not enforce
them (an API caller is not stopped by them). Fields marked "unused" are stored but have no effect
in this version.

| Field | Default | Tab | What it changes |
|---|---|---|---|
| `useAccountNumbers` | false | Accounting | Account numbers shown before names in lists, registers and reports (and sorting by number). |
| `showLowestSubaccountOnly` | false | Accounting | Account pickers show only the last part of a subaccount name (screens). |
| `useClassTracking` | false | Accounting | Class fields and the Class List menu appear (screens; classes are accepted either way). |
| `autoAssignJournalNumbers` | false | Accounting | A journal entry saved with a blank number gets the next number. (Invoices, sales receipts, credit memos, estimates and POs are always numbered this way. Check numbers are never filled in by the server: get the next one from `GET /next-ref?type=CHK&accountId=`.) |
| `datePastWarnDays` / `dateFutureWarnDays` | 90 / 30 | Accounting | Forms warn when the date is more than N days in the past / future; 0 = off (screens). |
| `billsDueDays` | 10 | Bills | Due date of a bill without terms = bill date + N days (0-999). |
| `warnDuplicateBillNumbers` | true | Bills | Yes/No question `dupnum` for a bill number already used for the same vendor. |
| `autoUseVendorDiscounts` | false | Bills | Pay Bills takes early-payment discounts automatically (screens). |
| `vendorDiscountAccountId` | null | Bills | Default account for discounts taken when paying bills. |
| `warnDuplicateCheckNumbers` | true | Checking | Question `dupnum` for a check, bill payment, refund or tax payment number used before in the same bank account. |
| `defaultCheckAccountId` (P) | null | Checking | Bank account used by checks and sales tax payments sent without `accountId`; Write Checks opens with it. Must be a Bank account. |
| `defaultBillPayAccountId` (P) | null | Checking | Account for bill payments sent without `accountId` (falls back to the check default). Bank or Credit Card. |
| `defaultDepositAccountId` (P) | null | Checking | Where payments and sales receipts go **only when `useUndepositedFunds` is off**. Bank or Other Current Asset. |
| `autoRecall` (P) | true | General | Forms fill in the last transaction of the chosen name (screens). |
| `autoFillPayee` (P) | true | - | Unused. |
| `windowMode` (P) | `multiple` | Workspace | `one` = tabs, `multiple` = floating windows (screens). |
| `iconBar` (P) | `left` | Workspace | `left`, `top`, `hidden` (screens). |
| `showHomePageOnOpen` (P) | true | Workspace | Open the Home page with the company (screens). |
| `showRemindersOnOpen` (P) | false | Reminders | Show Reminders when the company opens (screens). |
| `inventoryEnabled` | (setup) | Items and Inventory | Inventory menus, item type and fields appear (screens; also list CSV import). |
| `purchaseOrdersEnabled` | (setup) | Items and Inventory | Purchase order menus appear (screens). |
| `warnDuplicatePONumbers` | true | Items and Inventory | Question `dupnum` for a PO number already used. |
| `warnNotEnoughInventory` | true | Items and Inventory | Question `inventory` when an invoice or sales receipt sells more than is on hand. |
| `reportBasis` | `accrual` | Reports | Basis of reports when the report request has no `basis`: `accrual` or `cash`. |
| `agingFrom` | `due` | Reports | Aging reports count days from the due date (`due`) or the transaction date (`transaction`). |
| `reportAccountDisplay` | `name` | Reports | Reports label accounts by `name`, `description` or `both`. |
| `estimatesEnabled` | true | Sales | Estimate menus appear (screens). |
| `warnDuplicateInvoiceNumbers` | true | Sales | Question `dupnum` for an invoice number already used. |
| `useUndepositedFunds` | true | Sales | Payments and sales receipts without a deposit account go to Undeposited Funds (then Make Deposits). Off + `defaultDepositAccountId` set: they go straight to that account. |
| `autoApplyPayments` / `autoCalcPayments` | true / true | Sales | Receive Payments applies the amount to invoices / adds checked invoices to the amount (screens). |
| `customerDiscountAccountId` | null | Sales | Default account for early-payment discounts given to customers. |
| `defaultShipViaId`, `defaultFob` | null, "" | Sales | Defaults on new sales forms (screens). |
| `defaultInvoiceTemplate` | `Product Invoice` (`Service Invoice` for service templates) | Sales | "Usual invoice layout": layout of invoices saved without one: `Product Invoice` (shown as Standard), `Service Invoice` (Services), `Professional Invoice` (Services with Dates). |
| `salesTaxEnabled` | (setup) | Sales Tax | Sales tax is computed on sales forms only when on. |
| `defaultSalesTaxItemId` | null | Sales Tax | "Most common sales tax": new invoices, sales receipts and new customers start with it (screens). Must be a Sales Tax Item or Group; that item cannot be deleted while chosen. |
| `salesTaxBasis` | `accrual` | Sales Tax | When tax is owed: when invoiced (`accrual`) or when paid (`cash`). Changes Sales Tax Due and the sales tax reports. |
| `salesTaxFrequency` | `monthly` | Sales Tax | How often tax is paid: `monthly`, `quarterly`, `annually` (Pay Sales Tax suggests the period). |
| `requireAccounts`, `promptForClass`, `printAccountNamesOnVoucher`, `useCustomerDiscounts`, `defaultMarkupPercent`, `markTaxableAmountsT` | | - | Unused. |

"Fiscal year" is not a preference: it is `fiscalYearStartMonth` of company information (section
4). The closing date has its own route (section 6). Invalid values give `400` with `field`, for
example `{"code":"validation","error":"Invalid value \"modified\" for reportBasis (allowed: accrual, cash).","field":"reportBasis"}`
or "The selected account must be of type Bank." An account chosen in a preference is cleared
automatically when that account is deleted.

## 6. Closing date: `GET` / `PUT /closing-date`

`GET /closing-date` -> `{"closingDate": "2026-01-31", "hasPassword": true}` (`""` = none). Also
shown in `GET /company`.

`PUT /closing-date` (administrator) body:

| Field | Meaning |
|---|---|
| `closingDate` | `YYYY-MM-DD`. **Always send it: an omitted or empty value removes the closing date.** |
| `password` | New closing date password; omitted or `""` keeps the current one. |
| `clearPassword` | `true` removes the password. |

-> `{"closingDate":"2026-01-31","hasPassword":true}`. Each change is written to the audit trail
(action `closing_date`, details `before`, `after`, `passwordChanged`, `hasPassword`).

Effect (connecting.md, section 8): adding, changing, deleting or voiding a transaction dated on or
before the date asks the Yes/No question `closing` (no password) or needs header
`X-Closing-Password` (password set), also for administrators. Transactions dated after it are not
affected. Ask the user for the date and whether they want a password; the password is theirs to
type. Do not move or clear a closing date to make a save pass unless the user asked for exactly that.

## 7. Users and passwords: `/users`

`GET /users` -> administrators see every user, others only themselves:

```json
[{"id": 1, "name": "Admin", "isAdmin": true, "active": true, "hasPassword": true},
 {"id": 2, "name": "maria", "isAdmin": false, "active": true, "hasPassword": true}]
```

`POST /users` (administrator) body `{"name", "password", "isAdmin", "active"}` -> `201` the user.
`name` required, at most 60 characters, unique without regard to case. `active` defaults to true.
`password` omitted or `""` = no password.

`PUT /users/{id}` body `{"name", "password", "isAdmin", "active", "clearPassword"}`:
- An administrator may change everything. **`isAdmin` is always taken from the body: omitting it
  removes administrator rights.** Send the full user (`name`, `isAdmin`, `active`). `active`
  omitted keeps the current value; `password` omitted or `""` keeps the password;
  `clearPassword: true` removes it.
- A regular user may change only their own password (`{"password": "..."}`); other fields are
  ignored. Changing another user: `403` "Only an administrator can change other users."
- A new or removed password logs that user out everywhere else; making a user inactive logs them
  out everywhere.

`DELETE /users/{id}` (administrator) -> `204`; the user is logged out.

Rules: there must always be one active administrator (`409 conflict` "Admin is the only active
administrator. Another active administrator is required." / "...cannot be deleted."). There are
only two roles: administrator (everything) and regular user (all bookkeeping, not the
administrator tasks of connecting.md section 9).

How passwords turn logins on: while no active user has a password, the file opens without login
as `Admin`. **Adding a password to any user turns logins on for everybody**, and users without a
password then log in with an empty password; that includes `Admin`. So when the user wants
protection: first `PUT /users/1` with `{"name":"Admin","isAdmin":true,"password":"..."}` (the
user types the password), then add other users. If you are working without a session and you
add the first password, your next request gets `401`: log in with the new password.

```sh
curl -s -X POST $C/users -H "$J" -H "X-Session: $T" -d '{"name":"maria","password":"<typed by user>","isAdmin":false}'
# -> {"id":2,"name":"maria","isAdmin":false,"active":true,"hasPassword":true}
```

## 8. Check Company File and Repair Company File

**`POST /verify`** (any user; File > Utilities > Check Company File) -> `{"ok": true, "problems": []}`. Read-only checks: every
transaction balances; estimates, POs, voided and pending transactions post nothing; open balances
match payments and credits; A/R and A/P match open documents, in total and per customer/vendor;
payments and credits are linked within the same customer or vendor; inventory quantities and
the inventory asset account match the item movements; no orphan records. Problems are plain
sentences naming the transaction (`"Invoice #1001 (05/01/2026, id 12) is out of balance..."`), at
most 500. Fast (milliseconds on the 18-month sample).

**`POST /rebuild`** (administrator; File > Utilities > Repair Company File) -> `{"ok": true}`. Re-posts every transaction from its stored
lines in date order and recomputes balances, open amounts and inventory; entries already right are
left alone. Run the check first; suggest a backup (`POST /backups`) before the repair; run the check
again after. If problems remain after the repair, the user should restore a backup or ask for help with
the problem list.

## 9. Audit trail: `GET /audit`

Administrator only. Query: `from`, `to` (local dates `YYYY-MM-DD`, of the change, not the
transaction), `user` (any case), `txnId`, `action`. Newest first, at most 2000 rows.

```json
[{"id": 6, "ts": "2026-10-21T02:39:19Z", "user": "Admin", "action": "modify", "txnId": 1,
  "txnType": "CHK", "refNumber": "101", "txnDate": "2026-01-15", "name": "", "amount": 1200,
  "details": {"before": {...full transaction...}, "after": {...}}}]
```

`action`: `add`, `modify`, `delete`, `void` (with the full transaction `before` and `after`),
`closing_date` (section 6). Logins and list changes are not recorded; marking checks printed is
recorded as `modify`. The report "Audit Trail" (report key `audit_trail`, administrators) shows
the transaction rows formatted.

## 10. Memorized transactions: `/memorized`

A memorized transaction is a saved transaction to enter again, by hand or on a schedule
(Lists > Memorized Transaction List).

Object:

| Field | Meaning |
|---|---|
| `id` | |
| `name` | Required, unique. |
| `txnType` | Transaction type code: `INV`, `SALESRCPT`, `PMT`, `CREDMEM`, `STMTCHG`, `EST`, `DEP`, `CHK`, `REFUND`, `BILL`, `BILLCRED`, `BILLPMT`, `ITEMRCPT`, `PURCHORD`, `CCCHARGE`, `CCCREDIT`, `TRANSFER`, `GENJRNL`, `INVADJ`, `TAXPMT`. Defaults to `template.type`. |
| `template` | A transaction object (the same shape as `POST /txns`, see the transaction references). Number, dates, ids, links and computed values are removed when stored. Accounts and names in it are checked only when it is entered. |
| `schedule` | `none` (default, enter by hand), `remind` (listed in Reminders when due), `auto` (entered automatically when due). |
| `frequency` | `never` (default), `daily`, `weekly`, `biweekly`, `semimonthly` (day d<=15 -> d+15, else d-15 of next month), `monthly`, `quarterly`, `semiannually`, `annually` (month ends are kept: Jan 31 -> Feb 28). |
| `nextDate` | `YYYY-MM-DD`; required when `schedule` is not `none`. |
| `daysInAdvance` | 0-365: due this many days before `nextDate`. |
| `remaining` | Number of times left; `null` = no limit. |
| `groupName` | Free text to group the list. |
| `amount` | Read only: the template total. |

Routes:

- `GET /memorized` -> list, by group then name.
- `POST /memorized` -> `201` the object.
  ```sh
  curl -s -X POST $C/memorized -H "$J" -d '{"name":"Internet - monthly","txnType":"CHK","schedule":"remind",
    "frequency":"monthly","nextDate":"2026-10-25","daysInAdvance":7,"remaining":3,"groupName":"Monthly bills",
    "template":{"type":"CHK","accountId":1,"memo":"Internet service","lines":[{"accountId":40,"amount":89.99,"description":"Internet"}]}}'
  ```
- `PUT /memorized/{id}` -> partial update; a body without `template` keeps the stored template.
- `DELETE /memorized/{id}` -> `204` (transactions already entered stay).
- `POST /memorized/{id}/enter` body `{"date": "YYYY-MM-DD"}` (optional; default `nextDate`, else
  today) -> `{"txnId": 1649, "nextDate": "2026-11-25"}`. Saves the transaction now (normal save
  rules: Yes/No questions and the closing date apply, `?accept=` works) and moves the schedule one
  period forward, one less `remaining`. It does not check `remaining`.
- `GET /memorized/{id}/template?date=` -> the transaction ready to open in a form (`id` 0, nothing
  saved). Use it to show or adjust before saving with `POST /txns`, then call `advance`.
- `POST /memorized/{id}/advance` (optional body `{"txnId"}`) -> `{"nextDate","remaining"}`: moves
  the schedule forward without saving anything (after the user entered it through the form).
  `409` when there is no `nextDate`.
- `POST /memorized/process-due` -> `{"entered": 2, "errors": []}`: enters every `auto` one whose
  date is due (today + `daysInAdvance` or earlier), repeating until caught up, while `remaining`
  allows. Failures are listed as `"<name>: <message>"` (any Yes/No question or closing date counts
  as a failure here) and those show up in Reminders with a note.

The app runs `process-due` itself when a user opens the company file. So `auto` transactions are
entered only when someone opens the file in the app, or when you call it. Before calling it,
tell the user what is due (`GET /reminders`, group `memorized_due`, or `GET /memorized`).

Memorized reports (saved report settings) have their own routes `/memorized-reports`
(see the reports reference).

## 11. Budgets: `/budgets`

Object:

```json
{"id": 2, "name": "FY2027 Plan", "fiscalYear": 2027, "kind": "pl", "criteria": "none",
 "lines": [{"accountId": 21, "classId": null, "nameId": null,
            "amounts": [5000, 5000, 6000, 7000, 8000, 9000, 9000, 9000, 8000, 7000, 6000, 5000]}]}
```

| Field | Meaning |
|---|---|
| `name` | Required, unique. |
| `fiscalYear` | The calendar year the fiscal year **starts** in (1900-2999). |
| `kind` | `pl` (Profit and Loss: Income, COGS, Expense, Other Income, Other Expense accounts only; default) or `bs` (Balance Sheet accounts only). |
| `criteria` | `none` (default), `class` (lines may have `classId`), `customer` (lines may have `nameId`, a customer or job). `classId`/`nameId` are dropped when they do not match the criteria. |
| `lines[].amounts` | Exactly 12 amounts, month 1 = first month of the fiscal year (company information). Natural sign: positive income is income, positive expense is expense. Rounded to cents. Missing months are 0; **extra values beyond 12 are silently dropped**. |

Routes: `GET /budgets` (newest year first), `GET /budgets/{id}`, `POST /budgets` (`201`),
`PUT /budgets/{id}` (**replaces the whole budget**: send name, fiscalYear, kind, criteria and every
line; omitted lines are deleted), `DELETE /budgets/{id}` (`204`). Errors: `400` "Budget line 1: a
Profit and Loss budget can only contain income and expense accounts.", "Please enter a valid
fiscal year.", duplicate name. Reports: Budget Overview, Budget vs. Actual, Budget Progress
(Profit and Loss) (report keys `budget_overview`, `budget_vs_actual`, `profit_loss_budget_performance`,
parameter `budgetId`). App: Company > Planning & Budgeting > Set Up Budgets...

## 12. Reminders: `GET /reminders`

Read-only. Returns every group, in this order, empty ones included:
`[{"key", "label", "total", "items": [{"label", "date", "amount", "txnId", "itemId", "memorizedId", "note"?}]}]`.

| `key` | Contents |
|---|---|
| `overdue_invoices` | Invoices and statement charges with an open balance past due (due date, else date). |
| `bills_to_pay` | Open bills due within 7 days or overdue. |
| `checks_to_print` | Checks, bill payments, tax payments, refunds from a bank account marked to be printed. |
| `invoices_to_print` | Invoices marked to be printed. |
| `money_to_deposit` | Payments and sales receipts waiting in Undeposited Funds. |
| `inventory_to_reorder` | Active inventory parts at or below their reorder point (`itemId`). |
| `memorized_due` | `remind` memorized transactions due (with `daysInAdvance`), plus `auto` ones still due because entering failed (with a `note`). |
| `purchase_orders` | Open purchase orders. |
| `todos` | To dos not done, due today or earlier. |
| `sales_tax_due` | Sales Tax Payable by tax item and agency (`itemId`), per the sales tax basis. |

Example item: `{"label":"Invoice #1182 - Oakridge HOA","date":"2026-06-05","amount":2897.14,"txnId":1140,"itemId":null,"memorizedId":null}`.
This is a good "what needs attention" summary to start a session with.

## 13. To do list: `/todos`

Object `{"id", "title", "notes", "dueDate", "nameId", "done"}`. `title` required; `dueDate`
`YYYY-MM-DD` or `""`; `nameId` an existing customer, vendor or other name, or `null`.

- `GET /todos?status=open|done&nameId=` -> not done first, then by due date (no date last).
- `POST /todos` -> `201`. `PUT /todos/{id}` partial (`{"done": true}` marks it done).
  `DELETE /todos/{id}` -> `204`.

## 14. Checks and invoices to print

Transactions saved with `toBePrinted: true` wait in a queue (File > Print Forms).

`GET /to-print?kind=checks[&accountId=]` (default) or `?kind=invoices` -> transaction summaries:

```json
[{"id": 1653, "type": "CHK", "typeLabel": "Check", "refNumber": "", "date": "2026-10-20", "nameId": 9,
  "nameFull": "Marina Properties LLC", "accountId": 1, "accountName": "Checking", "amount": 50, "toBePrinted": true, ...}]
```

Checks = checks, bill payments, refunds and sales tax payments.

`POST /mark-printed` body `{"txnIds": [1653, 1654], "firstNumber": "2284"}` -> 
`{"ok": true, "updated": 2, "rows": [...]}`. Clears "to be printed" on each, and gives the checks
numbers in the order given starting at `firstNumber` (omitted: the account's next check number,
see `GET /next-ref?type=CHK&accountId=1`). Invoices keep their number. A number already used in
the same bank account asks `confirm`/`dupnum` ("Check numbers 2282 and 2283 have already been used
in Checking..."). Call it only after the user confirms the checks really printed correctly; the
printing itself happens in the app. It does not check the closing date: do not renumber checks
of a closed period without the user's clear request.

## 15. QuickBooks Desktop import

Brings lists and books from QuickBooks Desktop files into a **new** company file or into a file
with **no transactions** (lists already there are matched by name). Importing into an existing
file needs an administrator; the new-file routes need no login. Everything runs in one database
transaction: a test run changes nothing, and a real run saves all or nothing.

### 15.1 Files and the two ways in

Upload as `multipart/form-data`:

| Field | When | What |
|---|---|---|
| `iif` | always | IIF file. Lists: QuickBooks Desktop File > Utilities > Export > Lists to IIF Files (tick every list). Transactions: IIF transaction blocks (`TRNS`/`SPL`/`ENDTRNS`) from an IIF export tool or an accountant, in the same file or not. QuickBooks itself does not export all transactions to IIF. |
| `tb` | `mode: "opening"` (required) | Trial Balance report on the conversion date, saved as CSV (Reports > Accountant & Taxes > Trial Balance, then Excel > Create New Worksheet > comma separated values). |
| `invoices` | opening, optional | Open Invoices report on the same date, CSV (Reports > Customers & Receivables > Open Invoices). Not needed when nothing was owed to the user. |
| `bills` | opening, optional | Unpaid Bills Detail report on the same date, CSV (Reports > Vendors & Payables). Not needed when the user owed nothing. |
| `options` | always | JSON text, see 15.3. |

At most 128 MB together. Text in Windows-1252, UTF-8 or UTF-16 is read.

Modes (`options.mode`):

- **`"transactions"`** (default), "Every transaction": the lists and every IIF transaction, entered
  one by one like the forms do, so past reports work. Best when the user has a full IIF export.
- **`"opening"`**, "Opening balances on a conversion date": the lists, every account balance of the
  trial balance on `conversionDate`, the invoices and bills still open then (so aging is right),
  plus the IIF transactions dated **after** that date (ones on or before it are skipped: the
  balances already contain them). Best when only lists and reports are available, or the user
  wants a fresh start. What it enters: each open invoice / customer credit as an invoice / credit
  memo and each unpaid bill / vendor credit as a bill / vendor credit, each with one line to
  Opening Balance Equity; inventory quantities (when the item list has them) valued at the trial
  balance's inventory amount; one journal entry dated the conversion date with every other
  balance, which also brings Opening Balance Equity to its trial balance amount.
  `conversionDate` defaults to the date printed on the trial balance ("As of December 31, 2025").

### 15.2 Routes

| Route | Use |
|---|---|
| `POST /api/qbimport/preview` | What the files hold and how they map, for a new company (nothing is kept). |
| `POST /api/qbimport/run?dryRun=1` | Test run for a new company. **Write exactly `dryRun=1`: on this route `dryRun=true` is not understood and runs a real import that creates the file.** |
| `POST /api/qbimport/run` | Creates the new company file `options.company` and imports. |
| `POST /api/c/{cid}/qbimport/preview` | Same, into this company file (it must have no transactions). |
| `POST /api/c/{cid}/qbimport/run[?dryRun=1]` | Test run / import into this company. `409 conflict` "This company file already has 6 transactions..." otherwise. |

```sh
curl -s -X POST "$B/api/qbimport/preview" -F "iif=@lists-and-txns.iif" \
  -F 'options={"mode":"transactions","company":{"name":"Acme Design Studio","fiscalYearStartMonth":1}}'
curl -s -X POST "$C/qbimport/preview" -F "iif=@lists.iif" -F "tb=@tb.csv" -F "invoices=@invoices.csv" \
  -F "bills=@bills.csv" -F 'options={"mode":"opening","conversionDate":"2025-12-31"}'
```

### 15.3 Options

| Field | Meaning |
|---|---|
| `mode` | `"transactions"` (default) or `"opening"`. |
| `conversionDate` | Opening mode: `YYYY-MM-DD` (default: the trial balance's date). |
| `company` | New company routes only (required): the 2.2 body, at least `name`. `industry` defaults to `none`; `createDefaultAccounts` is always false (accounts come from the files); `adminPassword` sets the Admin password. |
| `skipProblems` | `false` (default): a real run saves only when there are no errors. `true`: saves what can be imported and skips the lines with errors (listed in the report). |
| `accounts` | Mapping choices by the account's `source` name: `{"action":"create","type":"Expense","name":"Optional new name"}`, `{"action":"map","targetId":7}` (an account of the company), `{"action":"use","source":"Phone"}` (same as another account of the files). |
| `items` | By item `source`: `create` (`type`), `map` (`targetId`), `use` (`source`), `none` (lines post to their account without an item). |
| `names` | By name `source`: `create` (`kind`: `customer`, `vendor`, `other`; optional `name`), `map` (`targetId`), `use` (`source`). |
| `rules` | Real run only: suggested bank rules to create, by suggestion `key` from the test run report: `{"<key>": {"matchText": "optional new text"}}`. |

Account types: `Bank`, `Accounts Receivable`, `Other Current Asset`, `Fixed Asset`, `Other Asset`,
`Accounts Payable`, `Credit Card`, `Other Current Liability`, `Long Term Liability`, `Equity`,
`Income`, `Cost of Goods Sold`, `Expense`, `Other Income`, `Other Expense`, `Non-Posting`. Item
types: `Service`, `Inventory Part`, `Non-inventory Part`, `Other Charge`, `Subtotal`, `Group`,
`Discount`, `Payment`, `Sales Tax Item`, `Sales Tax Group`.

For a new company the only accounts that exist before the import are the `none` accounts
(Accounts Receivable, Undeposited Funds, Accounts Payable, Opening Balance Equity, Retained
Earnings, Uncategorized Income/Expenses, To Review with Accountant), so `map` is useful there mainly to
merge into those; prefer `use` or `create`.

### 15.4 Preview response

```json
{"fileName": "tiny.iif", "product": "QuickBooks Pro", "version": "Version 33.0", "lines": 46,
 "sections": [{"key": "ACCNT", "label": "Accounts", "count": 8}, {"key": "TRNS", "label": "Transactions", "count": 8}],
 "transactions": [{"source": "INVOICE", "label": "Invoice", "count": 1, ...}],
 "dateFrom": "2026-01-02", "dateTo": "2026-01-28",
 "accounts": [{"source": "Opening Bal Equity", "line": 8, "sourceType": "EQUITY", "number": "3000",
   "action": "existing", "type": "Equity", "targetId": 4, "targetName": "Opening Balance Equity",
   "review": "Opening Bal Equity in the QuickBooks® file is Opening Balance Equity in SerieX Books.",
   "blocking": false, "useSource": "", "uses": 0}],
 "names": [...], "items": [...],
 "balances": [{"account": "Checking", "number": "1000", "type": "Bank", "source": -1110.55, ...}],
 "trialBalance": {"rows": 7, "debits": 29410, "credits": 29410, "asOf": "2025-12-31"},
 "openInvoices": {"count": 2, "total": 1800, "credits": 0}, "openBills": {"count": 1, "total": 410, "credits": 0},
 "target": {"transactions": 0, "empty": true},
 "problems": [{"file": "iif", "line": 43, "level": "error", "message": "This CHECK does not balance: the TRNS amount and the SPL amounts add up to -10.00 instead of zero."},
              {"file": "iif", "line": 40, "level": "note", "message": "ESTIMATE transactions do not affect the books and were skipped."}],
 "errors": 1, "notes": 1, "blocking": 0}
```

- Mapping rows (`accounts`, `names`, `items`): `action` `existing` (matched to a record already in
  the company, by name or the QuickBooks special account), `create`, `map`, `none`. `review` says
  what to check; **`blocking: true` rows need a choice** (for example an unknown account type:
  "The account type "WEIRD" of the QuickBooks® file is not known. Choose the type it gets.").
  Send the choices in `options` and preview again until `blocking` is 0. Accounts that appear only
  in transactions are created with a guessed type and a review note.
- `problems`: `level` `error` (the line is not imported; blocks a real run unless `skipProblems`)
  or `note`; `file` and `line` point into the uploaded file. `balances` are debit positive.

### 15.5 Test run, import and the after-import report

Run with `?dryRun=1` first, then without. Both return the report; `imported: true` means saved.

```json
{"dryRun": false, "imported": true, "mode": "opening", "asOf": "2026-01-28",
 "counts": [{"what": "Accounts", "created": 4, "matched": 4, "skipped": 0}, {"what": "Customers and jobs", "created": 1, "matched": 0, "skipped": 0}],
 "transactions": [{"source": "INVOICE", "label": "Invoice", "count": 0, "imported": 1, "asJournal": 0, "skipped": 0}],
 "opening": {"date": "2025-12-31", "invoices": 2, "invoicesTotal": 1800, "bills": 1, "billsTotal": 410,
   "inventoryItems": 0, "inventoryValue": 0, "journalLines": 5, "journalEntered": true},
 "paymentsApplied": 2, "depositsLinked": 1, "clearedEntries": 0,
 "trialBalance": [{"accountId": 9, "account": "Checking", "number": "1000", "type": "Bank", "source": 7339.45, "books": 7339.45, "difference": 0}],
 "totalDebits": 30010, "totalCredits": 30010,
 "checks": [{"key": "debitsCredits", "label": "Total debits equal total credits", "ok": true, "detail": "Debits 30,010.00, credits 30,010.00."},
            {"key": "balanceSheet", ...}, {"key": "trialBalance", ...}, {"key": "arAging", ...}, {"key": "apAging", ...}, {"key": "verify", ...}],
 "errors": 1, "notes": 1, "problems": [...], "truncated": false,
 "ruleSuggestions": [], "rulesCreated": []}
```

- `company` (`{"id", "name"}`) is there only when a new company file was created and saved. `count` in `transactions` is 0 in the
  report (it is the preview's figure).
- `checks`: `debitsCredits`, `balanceSheet`, `trialBalance` (every account equals the files;
  differences only in cost of goods sold and inventory are explained: SerieX computes cost of
  goods sold from average cost), `arAging`, `apAging`, `verify` (Check Company File). Show the user every
  check that is not `ok`, with its `detail`, and the `problems`.
- `trialBalance` compares each account: `source` (QuickBooks files) vs `books` (SerieX after the
  import), debit positive.
- With `skipProblems: true`, `imported` can be true while `errors` > 0: the skipped lines are
  missing from the books. Tell the user which ones.

### 15.6 What the import does on its own (good to tell the user)

- Transactions are entered by date; on the same day bills, checks and journal entries first, then
  invoices and sales receipts, then payments, then deposits.
- IIF files do not say which invoice a payment paid. Each customer payment / bill payment is
  applied first to an open invoice / bill of that name **with exactly the same open amount** (oldest
  due first), otherwise to the oldest due first. So a payment can land on a different invoice of the
  same amount than in QuickBooks; totals and aging stay right. A customer payment larger than the
  open invoices stays as a credit; a bill payment larger than the open bills is entered as a
  journal entry.
- Deposits are linked to the payments waiting in Undeposited Funds (`depositsLinked`).
- A transaction type SerieX has no form for, or one that cannot be entered on its form (the reason
  is a `note`), is entered as a general journal entry with the same accounts and amounts
  (`asJournal`). Estimates, purchase orders and sales orders are skipped (they do not post).
  A voided QuickBooks transaction (zero amounts, memo starting "VOID") comes in as an ordinary
  zero-amount transaction, not marked voided. A block whose amounts do not add up to zero is an
  error.
- Preferences turned on when the files use them: sales tax (and the first tax item as the most
  common one), inventory, class tracking, account numbers.
- QuickBooks special accounts are matched to SerieX's (Opening Bal Equity, Retained Earnings,
  Undeposited Funds, Sales Tax Payable, Inventory Asset, Cost of Goods Sold, A/R, A/P...).
  Employees (EMP rows) become other names; payroll is not imported into SerieX Payroll.
- Bank rules are suggested from how transactions were categorized (`ruleSuggestions`); they are
  created only for the keys sent in `options.rules`.

Practical sequence for an assistant: (1) confirm with the user the target (new file name, or the
open empty file) and the mode; (2) preview; report sections, transaction counts, date range and
problems; (3) resolve blocking rows with the user's choices; (4) test run; show checks and
problems; (5) ask whether to import, and whether to skip lines with problems; (6) run; (7) show
the report and suggest reconciling the bank accounts and checking the A/R and A/P aging.
App: the wizard steps are Start, Files, Preview, Mapping, Check, Bank rules, Report.

## 16. Pitfalls checklist

- `POST /api/companies` without `"createDefaultAccounts": true` gives the bare `none` chart.
- `POST /api/companies/sample` wipes the existing sample file.
- A password on one user turns logins on for all. SerieX refuses a password for any other user
  until an administrator has one, so set Admin's password first.
- `PUT /users/{id}` without `isAdmin: true` removes administrator rights.
- `PUT /closing-date` without `closingDate` removes the closing date.
- `PUT /budgets/{id}` replaces the whole budget; extra monthly amounts beyond 12 are dropped.
- Preferences are one set per file; "personal" ones change it for every user.
- Restoring as a new file keeps the old company name: rename it to tell the files apart.
- Replacing from a backup (`mode: "replace"`) ends every session, yours too.
- `auto` memorized transactions are entered only when the file is opened in the app or
  `process-due` is called; `POST /memorized/{id}/enter` ignores `remaining`.
- QuickBooks import needs a new file or one with zero transactions; payments are matched to
  invoices by amount, not by the original link. Test runs use `?dryRun=1` exactly.
- Never copy `.sxb` files directly; use `GET /api/companies/{id}/backup` or `POST /backups`.
