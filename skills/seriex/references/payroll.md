# SerieX Payroll reference

SerieX Payroll is the US payroll companion of SerieX Books. It calculates paychecks,
tracks payroll tax liabilities, prepares tax forms, and posts every paycheck, tax payment
and tax balance adjustment to the linked SerieX Books company as ordinary Books
transactions. It never moves money and never files anything with an agency.

Everything below was checked in the source (payroll/server, payroll/web) and, where an
example is shown, against a live server (version 2026.10.2) with the Books sample company.

## Contents

1. [How Payroll relates to Books](#1-how-payroll-relates-to-books)
2. [API basics](#2-api-basics)
3. [Verified end-to-end recipe](#3-verified-end-to-end-recipe)
4. [Payroll setup](#4-payroll-setup)
5. [Payroll items](#5-payroll-items)
6. [Pay schedules and employee defaults](#6-pay-schedules-and-employee-defaults)
7. [Employees](#7-employees)
8. [Running payroll](#8-running-payroll)
9. [Paychecks: view, edit, void, delete, print](#9-paychecks-view-edit-void-delete-print)
10. [Liabilities](#10-liabilities)
11. [Tax forms](#11-tax-forms)
12. [Reports](#12-reports)
13. [Books link: posting, sync, verify](#13-books-link-posting-sync-verify)
14. [Company information, preferences, access, audit, tax tables](#14-company-information-preferences-access-audit-tax-tables)
15. [Limits](#15-limits)
16. [Screen map](#16-screen-map)
17. [Pitfalls](#17-pitfalls)
18. [Full route list](#18-full-route-list)

---

## 1. How Payroll relates to Books

**Two servers.** Payroll is its own program (`seriex-payroll`) with its own port and web screens.

```
seriex-payroll -host 127.0.0.1 -port N -data DIR -web WEBDIST -books http://127.0.0.1:BOOKSPORT
```

- `-books` is the address of the SerieX Books server Payroll talks to. Default
  `http://127.0.0.1:8080` (or env `SXP_BOOKS`). Payroll cannot work without a reachable
  Books server: the company list, logins, account pickers and posting all go through Books.
- Books is started with `-payroll <payroll address>` (default `http://127.0.0.1:8090`, env
  `SXB_PAYROLL`; empty hides the app switcher). Books only uses it for the app switcher and
  `GET /api/info` (`payrollUrl`, `payrollReachable`).
- Desktop app: Books on 127.0.0.1:47180, Payroll on 127.0.0.1:47190 by default (real ports in
  `<data>/servers.json`). The desktop data folder holds `books/` (`<id>.sxb`) and `payroll/`
  (`<id>.sxp`).
- Payroll health: `GET /api/health`. Payroll info: `GET /api/info` ->
  `{"app":"SerieX Payroll","version":"2026.10.2","booksUrl":"http://127.0.0.1:47180","booksReachable":true,"taxYears":[2025,2026]}`.

**One payroll file per Books company.** The payroll company id is the Books company file id.
The payroll file is `<payroll data dir>/<books id>.sxp` (SQLite). It is created only by
Payroll Setup (`POST /api/companies/{id}/setup`). Company-scoped payroll routes are
`/api/c/{books id}/...`, exactly like Books. A Books company without a `.sxp` file has no payroll
yet (`payrollSetUp:false`).

**Switching apps.** Books menu File > Switch to SerieX Payroll... (or the app switcher button
in the top bar) opens `<payroll url>/?company=<id>`. Payroll menu File > Switch to SerieX Books...
goes back.

**Users and logins are the Books users.** Payroll has no users of its own.
- If no user of the Books company has a password, every Payroll request runs as "Admin"
  (administrator) with no login.
- Otherwise log in to Payroll with the Books user name and password:
  `POST /api/companies/{id}/login {"user","password"}` -> `{"token","user","isAdmin"}`. Payroll
  logs in to Books behind the scenes and keeps the Books session. Send `X-Session: <payroll token>`
  on every company request. Sessions live in memory (restarting Payroll logs everyone out;
  12 hours idle expires them).
- Books administrators can do everything. A non-administrator can use Payroll only if an
  administrator added them to Payroll access (Edit > Preferences > Access, `PUT /access`).
  Otherwise login fails with code `auth`: "Clerk does not have access to payroll. Ask a SerieX
  Books administrator to give you access (Payroll User Access)."
- Administrator-only actions: Payroll Setup, change company payroll information, preferences,
  user access, tax table changes, viewing full SSNs (`/employees/{id}/ssn`, `reveal=1` on forms),
  creating the W-2 electronic file. Error code `forbidden` (403).
- Postings to Books use the logged-in user's Books session, so Books' own rules apply
  (closing date, warnings).

**What Payroll creates in Books.**

| Payroll record | Books record | When |
|---|---|---|
| Payroll Setup (createAccounts) | Accounts "Payroll Expenses" (Expense) + subaccounts Wages, Payroll Taxes, Benefits, Reimbursements; "Payroll Liabilities" (Other Current Liability) + subaccounts Federal Taxes (941), Federal Unemployment (940), State Withholding, State Unemployment & Disability, Local Taxes, Retirement Plans, Health & Benefits, Other Deductions | setup |
| Payroll Setup (createAgencies), default items for a new state | Vendors "United States Treasury", the state withholding agency, the state unemployment agency (e.g. CA "Employment Development Department"); "<name> (Agency)" when a customer/other name already uses the name | setup, `POST /items/defaults` |
| Employee | Books "other" name (kind `other`) with the employee's display name, address, phone, email (suffix " (Employee)" if a customer/vendor has the name); made inactive with the employee; deleted (or made inactive) when the employee is deleted | every employee save |
| Paycheck | Check (`CHK`) from the paycheck's bank account to the employee's name | create / edit / void / delete |
| Tax payment (liability payment) | Check (`CHK`) to the agency vendor | create / edit / void / delete |
| Tax balance adjustment (liability adjustment) with `affectsAccounts:true` | General journal entry (`GENJRNL`) | create / edit / delete |
| Year-to-date entries, earlier tax payments, adjustments that do not affect accounts | nothing (never posted) | |

Every posted Books transaction carries `extra.payroll = {"app":"SerieX Payroll","kind":"paycheck"|"liability_payment"|"adjustment","id":<payroll id>}`.
Books does not lock these transactions: a user can change or delete them in Books. Verify
(section 13) finds such differences; re-posting the record puts payroll's version back.

**Accounting effect of a paycheck** (verified, Books check for Maria Lopez, net 1,489.94):

| Line | Account | Amount | Meaning |
|---|---|---|---|
| Hourly Wage | Payroll Expenses:Wages | +1,800.00 | wage expense up |
| Overtime Rate | Payroll Expenses:Wages | +135.00 | |
| 401(k) Employee | Payroll Liabilities:Retirement Plans | -96.75 | liability up (credit) |
| Federal Withholding, Social Security (employee), Medicare (employee) | Payroll Liabilities:Federal Taxes (941) | -136.74, -119.97, -28.06 | liability up |
| CA - Withholding | Payroll Liabilities:State Withholding | -38.38 | |
| CA - State Disability Insurance (employee) | Payroll Liabilities:State Unemployment & Disability | -25.16 | |
| 401(k) Company Match | Payroll Expenses:Benefits / Payroll Liabilities:Retirement Plans | +77.40 / -77.40 | employer cost: expense up and liability up |
| Social Security (company), Medicare (company) | Payroll Expenses:Payroll Taxes / Federal Taxes (941) | +119.97/-119.97, +28.06/-28.06 | |
| Federal Unemployment | Payroll Taxes / Federal Unemployment (940) | +11.61 / -11.61 | |
| CA - Unemployment (company), CA - Employment Training Tax | Payroll Taxes / State Unemployment & Disability | +65.79/-65.79, +1.94/-1.94 | |

The check total (lines added up) is the net pay, so the bank account goes down by net pay.
In plain words: wages and employer costs are expenses; everything withheld or owed to an
agency or plan sits in a Payroll Liabilities account until a tax payment takes it out.
Books check fields: date = check date, memo `Pay Period: 10/04/2026 - 10/17/2026[ <paycheck memo>]`,
address box = employee print-as name and address, ref number = check number (`DD<paycheck id>`
for direct deposit; empty while the paycheck waits to be printed), Books "to be printed" is
always false (Payroll prints paychecks itself). Reported tips (`notPaid`) are not posted.

**A tax payment** (liability payment) posts a check to the agency: each line debits (`+`) the item's
liability account (liability goes down), optional expense lines (penalties, interest) debit an
expense account; memo `Payroll Liabilities MM/DD/YYYY - MM/DD/YYYY[ <memo>]`; address box =
the vendor's Books address; ref number = check number (none for e-pay or to-be-printed).

**A tax balance adjustment** with `affectsAccounts:true` posts a journal entry: for each line,
`+amount` to the item's expense account and `-amount` to its liability account (a positive
amount increases the liability), with the employee's (or, for company adjustments, the agency's)
Books name on the lines. Deduction and employee tax items have no expense account; the
employee's first earnings item expense account is used instead.

---

## 2. API basics

- Base: `http://127.0.0.1:<payroll port>/api`. Company routes: `/api/c/{cid}/...`.
- Writes need `Content-Type: application/json`. Money is dollars with 2 decimals, dates are
  `YYYY-MM-DD`, optional ids are `null` when absent. Fields marked read-only are recomputed
  by the server and ignored on input.
- Errors: `{"error": message, "code": code, "field"?: jsonField}`. Same codes as Books
  (`validation` 400, `not_found` 404, `conflict` 409, `confirm` 409, `closing_date` 403,
  `auth` 401, `forbidden` 403, `internal` 500) plus two Payroll-only codes:
  - `books_unavailable` 503: SerieX Books did not answer (not running, wrong `-books` address).
  - `books_auth` 401: the stored Books session expired; log in to Payroll again.
- `confirm` = a Yes/No question. Payroll has no warning kinds: the only answer is to re-send
  the same request with `?force=1` (helper: `--force`). Ask the user the question first and
  re-send only after a clear yes to that question. Books questions raised while posting (for
  example voiding a reconciled check) also come back as `confirm` with the message prefixed
  "SerieX Books: "; `?force=1` is passed on to Books.
- `closing_date` (from Books): the app passes the closing date password on to Books with the
  header `X-Closing-Password`. An assistant never asks for or sends it: tell the user nothing
  changed and that they can make this change in SerieX themself.
- Books problems while posting a new or edited record do not fail the request: the record is
  saved, its `syncStatus` becomes `error` with `syncError`, and it waits in Books Sync
  (section 13). Void and delete are different: they stop with the Books error and change
  nothing in payroll.
- Missing company file: `{"code":"not_found","error":"Company file not found or could not be opened: company file \"nope\" not found"}`.

---

## 3. Verified end-to-end recipe

These calls were run in order against a live server (Books on 47180, Payroll on 47190,
company `sample-harborview`, no passwords). `P=http://127.0.0.1:47190/api`, `C=$P/c/sample-harborview`.

```bash
# 1. Is the Books company there, and is payroll set up?
curl -s $P/companies
# [{"id":"sample-harborview","name":"Harborview Landscaping & Supply (Sample)","payrollSetUp":false,"setupDone":false,"booksModified":"..."}]

# 2. Payroll Setup (creates the .sxp file, Books accounts and agency vendors, default items, a pay schedule)
curl -s -X POST $P/companies/sample-harborview/setup -H 'Content-Type: application/json' -d '{
 "primaryState":"CA","ein":"12-3456789","federalDepositSchedule":"monthly","firstPayrollYear":2026,
 "defaultBankAccountId":1,"createAccounts":true,"createAgencies":true,
 "payFrequency":"biweekly","nextPeriodEnd":"2026-10-17","nextCheckDate":"2026-10-23","uiRate":3.4}'

# 3. Item ids (Hourly Wage 4, Overtime Rate 5, Salary 1, 401(k) Employee 15, 401(k) Company Match 20, Health Insurance 17 here)
curl -s "$C/items"

# 4. Employees (hourly with 401(k) and match; salaried with direct deposit)
curl -s -X POST $C/employees -H 'Content-Type: application/json' -d '{
 "firstName":"Maria","lastName":"Lopez","ssn":"123-45-6789","hireDate":"2026-01-05",
 "address":{"line1":"12 Oak St","city":"Harborview","state":"CA","zip":"94950"},
 "payScheduleId":1,"workState":"CA",
 "earnings":[{"itemId":4,"rate":22.5,"qty":80},{"itemId":5,"rate":0}],
 "items":[{"itemId":15,"rate":5},{"itemId":20,"rate":0}],
 "w4":{"version":"2020","filingStatus":"single"},"stateW4":{"filingStatus":"single","allowances":1}}'
curl -s -X POST $C/employees -H 'Content-Type: application/json' -d '{
 "firstName":"James","lastName":"Chen","ssn":"234-56-7890","payScheduleId":1,"workState":"CA",
 "earnings":[{"itemId":1,"rate":65000}],"items":[{"itemId":17,"rate":120}],
 "w4":{"version":"2020","filingStatus":"mfj","dependents":2000},"stateW4":{"filingStatus":"married","allowances":2},
 "directDeposit":{"enabled":true,"bankName":"First Bank","routing":"021000021","account":"55551234"}}'

# 5. Scheduled payroll: list, defaults, preview, create
curl -s $C/payroll/scheduled
curl -s -X POST $C/payroll/start -H 'Content-Type: application/json' -d '{"kind":"scheduled","payScheduleId":1}'
curl -s -X POST $C/paychecks/calculate -H 'Content-Type: application/json' -d '{"employeeId":1,"periodStart":"2026-10-04","periodEnd":"2026-10-17","checkDate":"2026-10-23","bankAccountId":1,"lines":[{"itemId":4,"rate":22.5,"qty":80},{"itemId":5,"qty":4}]}'
curl -s -X POST $C/payroll/create -H 'Content-Type: application/json' -d '{"kind":"scheduled","payScheduleId":1,
 "periodStart":"2026-10-04","periodEnd":"2026-10-17","checkDate":"2026-10-23","bankAccountId":1,"printMode":"print",
 "paychecks":[
  {"employeeId":1,"periodStart":"2026-10-04","periodEnd":"2026-10-17","lines":[{"itemId":4,"rate":22.5,"qty":80},{"itemId":5,"qty":4}]},
  {"employeeId":2,"periodStart":"2026-10-04","periodEnd":"2026-10-17","directDeposit":true,"lines":[{"itemId":1,"rate":2500,"qty":80}]}]}'
# -> {"runId":1,"paychecks":[{"id":1,...,"net":1489.94,"booksTxnId":1649,"syncStatus":"posted"},{"id":2,"checkNumber":"DD2",...}],"posted":2,"problems":[]}

# 6. The checks in Books (on the BOOKS server)
curl -s "http://127.0.0.1:47180/api/c/sample-harborview/txns?from=2026-10-23&to=2026-10-23"
curl -s "http://127.0.0.1:47180/api/c/sample-harborview/txns/1649"

# 7. Liabilities due, pay the 941 deposit, check balances
curl -s $C/liabilities/due
curl -s -X POST $C/liability-payments/from-due -H 'Content-Type: application/json' -d '{"rows":[{"paymentGroup":"federal_941","periodStart":"2026-10-01","periodEnd":"2026-10-31"}],"date":"2026-10-24","bankAccountId":1}'
curl -s $C/liabilities/balances

# 8. Form 941 and the Payroll Summary report
curl -s "$C/forms/941?year=2026&quarter=4"
curl -s "$C/reports/payroll_summary?from=2026-10-01&to=2026-10-31"

# 9. Payroll and Books agree?
curl -s -X POST $C/books/verify -H 'Content-Type: application/json' -d '{"from":"2026-01-01","to":"2026-12-31"}'
# -> {"checked":4,"problems":[],"accounts":[{"accountName":"Payroll Liabilities:Federal Taxes (941)","payrollBalance":0,"booksBalance":0,"difference":0,...},...]}

# 10. Void a paycheck (Books check voided first)
curl -s -X POST $C/paychecks/2/void -H 'Content-Type: application/json' -d '{}'
```

---

## 4. Payroll setup

Screens: File > Open or Set Up Company... (company list offers Open and Set Up Payroll), then
the Payroll Setup wizard. Steps: Payroll file, Company info, State taxes, Pay schedules, Payroll
items, Employees, Year-to-date pay, Review and finish. Reopen with Employees > Payroll Setup...

Only the first step is a special route. The other steps use the normal routes
(`PUT /company`, `PUT /state-settings/{state}`, `/pay-schedules`, `/items`, `/employees`,
year-to-date paychecks). The wizard ends with `PUT /company {"setupDone":true}`. The wizard
stores its own progress in `setupState` (free JSON, owned by the screen).

### GET /api/companies

Books company files with payroll status. `[{id, name, payrollSetUp, setupDone, booksModified}]`.
`payrollSetUp` = a `.sxp` file exists. Fails with `books_unavailable` when Books is down.

### GET /api/companies/{id}/auth

`{"required":false,"users":["Admin"]}` (from Books). `required` = a login is needed.

### GET /api/companies/{id}/bank-accounts

Books bank accounts for the setup bank picker (works before the payroll file exists).
`[{id,name,fullName,number,type,level,balance,active}]`.

### POST /api/companies/{id}/setup (administrators only)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `primaryState` | 2-letter code | required | State where employees work; must have tax tables (50 states + DC). |
| `ein` | string | Books company `taxId` when it has 9 digits | Federal EIN, 9 digits (dashes allowed). |
| `federalDepositSchedule` | `monthly` \| `semiweekly` | `monthly` | Sets the 941 payment schedule. |
| `firstPayrollYear` | int | current year | 2000-2100. |
| `defaultBankAccountId` | Books account id | first active Books bank account | Default paycheck bank (stored in prefs). |
| `createAccounts` | bool | **false** | Find or create the payroll accounts in Books (section 1). The screen sends true. |
| `createAgencies` | bool | **false** | Find or create the agency vendors. The screen sends true. |
| `payFrequency` | `daily`,`weekly`,`biweekly`,`semimonthly`,`monthly`,`quarterly`,`semiannually`,`annually` | `biweekly` | First pay schedule (named after the frequency, e.g. "Biweekly"). |
| `nextPeriodEnd` | date | today | Next pay period end. |
| `nextCheckDate` | date | `nextPeriodEnd` | Next check date. |
| `uiRate` | percent or null | null = state's new employer rate | Company SUI rate for `firstPayrollYear`. |

Effects: creates the payroll file, company record (name, legal name, address, phone, email
copied from Books), state settings of the primary state, one pay schedule, the default payroll
items (section 5) pointing at the accounts/vendors, and default payment schedules (section 10).
Returns the company (`GET /company` shape).

Errors: `{"code":"validation","error":"Choose the state where your employees work.","field":"primaryState"}`,
`"\"ZZ\" is not a US state."`, `"The federal employer identification number (EIN) must have 9 digits."`,
`"Choose a SerieX Books bank account for paychecks."`, `conflict` "Payroll is already set up for
this company file.", `conflict` when a Books account with a payroll name has the wrong type
("The SerieX Books account \"Payroll Expenses\" is a Bank account; payroll needs an Expense account
with this name. Rename that account in SerieX Books and try again.").

Then complete setup: company contact and IDs (`PUT /company`), state account numbers and rates
(`PUT /state-settings/{state}`), agencies for deduction items (they start with no payee),
employees, year-to-date amounts, `PUT /company {"setupDone":true}`.

---

## 5. Payroll items

Screens: Lists > Payroll Items; Employees > Payroll Items > New Payroll Item...

### Default items (created by setup; CA example verified)

| Item | Type | Notes |
|---|---|---|
| Salary, Sick Salary, Vacation Salary | `salary` | Sick/Vacation versions use PTO hours (`pto`). |
| Hourly Wage, Sick Hourly, Vacation Hourly, Holiday Hourly | `hourly` | |
| Overtime Rate | `overtime` | rate 1.5 = multiplier; tax treatment qualified overtime (W-2 box 12 TT, premium part). |
| Double-time Rate | `overtime` | rate 2; not qualified overtime. |
| Bonus | `bonus` | supplemental (federal flat 22% rate). |
| Commission | `commission` | calc `quantity` (rate % x sales entered as quantity). |
| Paid Tips, Reported Tips | `tips`, `reported_tips` | Reported tips are taxed but not paid (`notPaid`). |
| Mileage Reimbursement | `addition` | calc `quantity`, rate = IRS mileage rate (0.76 after 2026-07-01), not wages. |
| 401(k) Employee | `deduction` | 5% of gross, annual limit 24,500 (2026), pre-tax for income taxes only, box 12 D. |
| Roth 401(k) | `deduction` | post-tax, box 12 AA. |
| Health Insurance | `deduction` | section 125, pre-tax for all taxes, box 12 DD. |
| HSA Employee, Dependent Care FSA | `deduction` | pre-tax; box 12 W / box 10. |
| 401(k) Company Match | `contribution` | calc `match`: 100% of the 401(k) Employee deduction up to 4% of gross. |
| Health Insurance Company | `contribution` | box 12 DD (informational). |
| Federal Withholding, Social Security (employee), Social Security (company), Medicare (employee), Medicare (company), Additional Medicare (employee), Federal Unemployment | `federal_tax` | agency United States Treasury. |
| `<ST> - Withholding` (if the state has income tax), `<ST> - Unemployment (company)`, `<ST> - Unemployment (employee)` (AK, NJ, PA), one item per state program (CA: "CA - State Disability Insurance (employee)", "CA - Employment Training Tax") | `state_tax` | agency = state agencies. |

Deduction and contribution items start with **no agency** (payment group `unassigned`). Give
them an agency vendor (`agencyVendorId`) before paying them with Pay Payroll Taxes.

### Item fields (`PayrollItem`)

| Field | Meaning |
|---|---|
| `id` (ro), `name` | Name, max 100 chars, no colon, unique. |
| `type` | `salary`,`hourly`,`overtime`,`bonus`,`commission`,`tips`,`reported_tips`,`addition`,`deduction`,`contribution`,`federal_tax`,`state_tax`,`other_tax` (local tax). |
| `taxCode` | Tax items: `FIT`,`SS_EE`,`SS_ER`,`MED_EE`,`MED_ER`,`ADDL_MED`,`FUTA`,`SIT`,`SUI_ER`,`SUI_EE`,`ST_EE`,`ST_ER` (state programs), `LOCAL_EE`,`LOCAL_ER` (other_tax). One active item per tax code + state (+ program). |
| `state`, `taxKey` | State of a state tax; program key for ST_EE/ST_ER (e.g. `SDI`, `ETT`). |
| `pto` | Hourly/salary items: `""`, `sick`, `vacation` (hours used reduce that balance). |
| `calc` | `fixed` (dollars per paycheck), `percent` (of gross wages), `per_hour` (x hours worked), `quantity` (x quantity entered), `match` (contributions), `tax` (tax items). Wage items are always `fixed` except commission (`fixed`/`quantity`). |
| `rate` | Hourly rate / multiplier (overtime) / amount / percent. Deduction amounts may be sent negative; stored positive. Tax items: 0 = table rate; >0 overrides the table rate for ST_*, LOCAL_*, SUI_ER. |
| `annualLimit`, `limitKind` | Limit in dollars (null = none); `annual` or `one_time`. |
| `matchItemId`, `matchCapPct` | Match: the employee deduction matched; cap as % of gross. |
| `taxTracking` | W-2 treatment: `compensation`,`none`,`reported_tips`,`paid_tips`,`qualified_overtime`,`401k`,`403b`,`457b`,`roth_401k`,`roth_403b`,`simple_ira`,`section_125`,`hsa`,`dependent_care`,`group_term_life`,`health_coverage`,`fringe`,`other`. Default `compensation` (deductions: `other`). |
| `w2Box12`, `w2Box14` | Box 12 code (`GET /api/meta` `box12Codes`), box 14 label (max 40). |
| `taxability` | Map of wage bases `FIT`,`SS`,`MED`,`FUTA`,`SIT`,`SUI`,`SDI`,`LOCAL` -> bool. Earnings/additions/contributions: true = counts as wages. Deductions: true = pre-tax for that base. Omitted = default for the tax treatment (`taxTracking`; "Tax treatment" on screen). |
| `supplemental` | Bonus/commission withheld at the supplemental flat rate. |
| `notPaid` (ro) | true for reported tips. |
| `expenseAccountId` | Required for earnings, additions, employer taxes, contributions. |
| `liabilityAccountId` | Required for deductions, employee taxes, employer taxes, contributions. |
| `agencyVendorId` | Books vendor paid for this liability. |
| `paymentGroup` | `""` = default (see section 10) or `vendor:<agencyVendorId>`. |
| `active` | |
| ro: `category`, `effectiveGroup`, `expenseAccountName`, `liabilityAccountName`, `agencyName`, `hasPaychecks` | |

### Routes

- `GET /items?active=active|all|inactive&types=deduction,contribution` -> list sorted by type then name.
- `GET /items/{id}`.
- `POST /items` -> creates (body = item). Example verified:
  `{"name":"Wage Garnishment","type":"deduction","calc":"fixed","rate":50,"liabilityAccountId":72,"agencyVendorId":73}`.
- `PUT /items/{id}` -> **full replacement**: GET the item, change fields, PUT the whole object.
  A partial body fails (`"Enter a name for the payroll item."`) or resets fields.
- `DELETE /items/{id}` -> 204; `conflict` "This payroll item is used in paychecks and cannot be
  deleted. You can make it inactive instead."
- `PUT /items/{id}/active {"active":false}`.
- `POST /items/defaults {"state":"NV","year":2026}` -> adds the default items that do not exist
  yet (for a second work state), creating missing agency vendors in Books.
  `{"created":2,"warnings":[]}`.

Validation examples: "Choose the expense account for this item." (`expenseAccountId`),
"Choose the liability account for this item." (`liabilityAccountId`), "The active payroll item
\"X\" already tracks this tax. Make it inactive first or edit it instead.", "This payroll item is
used in paychecks, so its type cannot be changed. Create a new item instead." (`conflict`).
Account and vendor ids are checked against Books when Books is reachable ("The expense account
does not exist in SerieX Books.").

---

## 6. Pay schedules and employee defaults

Screens: Lists > Pay Schedules; Employees > Employee Defaults...

`PaySchedule`: `{id, name, frequency, nextPeriodEnd, nextCheckDate, semiFirstDay, active, nextPeriodStart (ro), employeeCount (ro)}`.

- `GET /pay-schedules?active=active|all|inactive`, `GET /pay-schedules/{id}`.
- `POST /pay-schedules` / `PUT /pay-schedules/{id}` (full object). Rules: name max 60 and
  unique; check date within a year of the period end; semimonthly: `semiFirstDay` 1-27 (default
  15) and the period ends on that day or the month end ("A semimonthly pay period ends on day 15
  or on the last day of the month."); daily periods end Monday-Friday. Changing the frequency
  changes the pay frequency of every employee on the schedule.
- `POST /pay-schedules/{id}/assign` -> assigns the schedule to active employees with the same
  frequency and no schedule: `{"assigned":0}`.
- `DELETE /pay-schedules/{id}` -> `conflict` while employees use it.
- Creating a scheduled payroll moves the schedule's next period and check date forward.

`EmployeeDefaults`: `{payScheduleId, payFrequency, classId, workState, earnings[], items[], sick, vacation, subjectSui, subjectSdi}`.
`GET /employee-defaults`, `PUT /employee-defaults` (full object). The New Employee screen
pre-fills from it. **The API does not apply these defaults** to `POST /employees` (only
`subjectSui`/`subjectSdi` when not sent): send schedule, work state and items yourself.

---

## 7. Employees

Screens: Employees > Employee Center > **New Employee…** (the "New Employee" dialog has the
sections Personal, Address & Contact, Additional Info, Payroll Info, Employment Info).

### Employee fields

| Field | Notes |
|---|---|
| `firstName`, `lastName` | required. `middleName`, `suffix`. |
| `displayName` | `""` = "First Last" (or "Last, First" per prefs). Unique, max 100, no colon. |
| `printAs` | Name on checks. |
| `ssn` | Input: 9 digits (dashes ok). `""` or the masked value keeps the stored number. Output: `XXX-XX-6789`. Never-issued patterns or duplicates -> `confirm`. |
| `birthDate`, `gender`, `address{line1,line2,city,state,zip}`, `phone`, `mobile`, `email`, `employeeNumber`, `notes` | |
| `hireDate`, `originalHireDate`, `releaseDate` | Release date >= hire date. Employees released before a scheduled period starts drop out of scheduled payrolls. |
| `employmentType` | `regular` (default), `officer`, `statutory` (no federal withholding), `owner`. |
| `payScheduleId` | Sets `payFrequency` from the schedule. |
| `payFrequency` | Required when no schedule. |
| `classId` | Books class (class tracking). |
| `workState` | Required; must have tax tables. |
| `earnings[]` | Wage items: `{itemId, rate, qty}`. Hourly: rate per hour; salary: **annual** salary; `qty` = default hours per paycheck. Rate 0 on hourly/salary -> `confirm`. |
| `items[]` | Additions, deductions, contributions, local taxes: `{itemId, rate, annualLimit, qty}`; rate 0 = item default. |
| `w4` | `{version:"2020"|"pre2020", filingStatus, step2, dependents (Step 3 yearly $), otherIncome (4a yearly), deductions (4b yearly), extraWithholding (4c per period), allowances (pre2020 only), exempt, nonresidentAlien, exemptYear}`. 2020 statuses: `single`, `mfj`, `hoh`; pre2020: `single`, `married`, `married_single`. An exempt W-4 expires Feb 15 of the next year; after that paychecks withhold as single with a warning. |
| `subjectSs`, `subjectMedicare`, `subjectFuta` | Default true when not sent on a new employee. |
| `stateW4` | `{filingStatus (state keys from GET /api/meta, e.g. CA single/married/head_of_household), allowances, extraWithholding (negative only CT, LA), exempt, data{}}`. `data` holds state inputs listed in meta `states[].inputs` (CA `additionalAllowances`, CO, IL, IN, MA, MD `localRate`, VA). |
| `subjectSui`, `subjectSdi` | Default from employee defaults (true). |
| `directDeposit` | `{enabled, bankName, routing, account, accountType:"checking"|"savings", clear}`. **Recorded only** (no bank file is ever produced). Routing must pass the ABA check digit; account 4-17 digits; output masked (`*****0021`, `****1234`); `""` or masked keeps stored numbers; `clear:true` erases them. |
| `sick`, `vacation` | `{accrual:"none"|"per_paycheck"|"per_hour"|"beginning_of_year", hours, perHoursWorked, maxHours, resetEachYear, yearBeginsMonth, beginAccruingDate}`; ro `available`, `accruedYtd`, `usedYtd`. `beginning_of_year` accrues on year starts on/after the hire (or begin) date. |
| `active` | |
| ro | `booksNameId`, `ssnOnFile`, `payScheduleName`, `hourlyRate`, `annualSalary`, `ytdGross`, `lastCheckDate`, `hasPaychecks`, `booksSyncError` (problem creating the Books name). |

### Routes

- `GET /employees?active=active|all|inactive&q=text` (q searches name, number, email, phone, city).
- `GET /employees/{id}` (masked numbers).
- `POST /employees`, `PUT /employees/{id}` -> **full object** (GET, modify, PUT back; omitted
  earnings/items are removed). `?force=1` answers the `confirm` questions (after the user's yes). Each save creates or
  updates the employee's Books "other" name; a Books problem is returned in `booksSyncError`
  (the employee is still saved). Example confirm:
  `{"code":"confirm","error":"000-12-3456 is not a valid social security number (the Social Security Administration never issues it). Hourly Wage has no rate (0.00). Do you want to save the employee anyway?"}`.
- `DELETE /employees/{id}` -> `conflict` "Maria Lopez has paychecks and cannot be deleted. You can make the employee inactive instead."
- `PUT /employees/{id}/active {"active":false}`.
- `GET /employees/{id}/ssn` (administrators; audited) -> `{"ssn":"123-45-6789"}`.
- `GET /employees/{id}/summary?year=2026` -> `{ytdGross, ytdNet, ytdTaxes, ytdDeductions, lastPaycheck, sick, vacation, ytdByItem[]}`.
- `POST /employees/{id}/books-sync` -> creates/updates the Books name again.
- PTO: `GET /employees/{id}/pto-adjustments?kind=sick|vacation`;
  `POST /employees/{id}/pto-adjustments {"kind","date","hours"}` (+/- hours) or
  `{"kind","date","available":16}` (sets hours available as of date, e.g. opening balance);
  `DELETE /employees/{id}/pto-adjustments/{adjId}`.

### Mid-year start: year-to-date amounts

Screen: Employees > Enter Year-to-Date Amounts... For employees paid earlier in the year by another
system, enter what was paid per quarter. Each quarter is one paycheck of `kind:"ytd"`:

```bash
curl -s -X POST $C/paychecks -H 'Content-Type: application/json' -d '{"employeeId":2,"kind":"ytd","checkDate":"2026-09-30","lines":[
 {"itemId":1,"amount":15000,"manual":true},{"itemId":17,"amount":720,"manual":true},
 {"itemId":22,"amount":600,"manual":true},{"itemId":23,"amount":885.36,"manual":true},{"itemId":25,"amount":207.06,"manual":true},
 {"itemId":29,"amount":300,"manual":true},{"itemId":31,"amount":185.64,"manual":true},
 {"itemId":24,"amount":885.36,"manual":true},{"itemId":26,"amount":207.06,"manual":true},
 {"itemId":28,"amount":42,"manual":true},{"itemId":30,"amount":238,"manual":true},{"itemId":32,"amount":7,"manual":true}]}'
# -> id 3, kind ytd, periodStart 2026-07-01, periodEnd 2026-09-30, bankAccountId null, syncStatus "none"
```

- Send every line with `manual:true` and its amount. Wage bases are computed by the server.
- The period is the calendar quarter of `checkDate` (default check date = quarter end).
- YTD entries count for wage base limits, annual limits, YTD totals, liabilities, forms and
  W-2s. They print nothing and are never posted to Books.
- Their taxes appear as taxes due (often Overdue). Record what was already paid as earlier tax
  payments (Employees > Payroll Taxes > Record Earlier Tax Payments...,
  `POST /liability-payments` with `kind:"prior"`, section 10), which are also never posted.
- Edit a YTD entry with `PUT /paychecks/{id}` and `recalculate:false` sending every line.
  Entering YTD amounts after later paychecks exist does not recalculate those paychecks (the
  response warns).

---

## 8. Running payroll

Screens: Employees > Payroll Center (Pay Employees tab), Employees > Pay Employees >
Run Payroll... / Extra Paycheck... / Final Paycheck... (API kinds `scheduled` / `unscheduled` /
`termination`). The Pay Employees steps are Hours and Pay, Review, Done.

Flow: list scheduled payrolls -> start (defaults) -> calculate each paycheck (preview) ->
create (saves and posts). There is no separate approve step: Create Paychecks is the approval.
Then print paychecks (or they are direct deposits / handwritten).

### GET /payroll/scheduled

```json
[{"payScheduleId":1,"name":"Biweekly","frequency":"biweekly","periodStart":"2026-10-04","periodEnd":"2026-10-17","checkDate":"2026-10-23","status":"Due","employeeCount":2}]
```
Status: `Overdue` (check date past), `Due` (within 7 days), `Upcoming`. Schedules with no
employees are left out.

### POST /payroll/start

Body `StartPayrollRequest`: `{kind:"scheduled"|"unscheduled"|"termination", payScheduleId, employeeIds[], periodEnd, checkDate, releaseDate}`.
- scheduled: needs `payScheduleId`; uses the schedule's next period and check date.
- unscheduled: `employeeIds` empty = every active employee listed with `selected:false`;
  period end and check date default to today.
- termination: `employeeIds` required ("Choose the employees who get a final paycheck.").

Returns the draft (verified):
```json
{"kind":"scheduled","payScheduleId":1,"scheduleName":"Biweekly","periodStart":"2026-10-04","periodEnd":"2026-10-17","checkDate":"2026-10-23",
 "bankAccountId":1,"nextCheckNumber":"2284","earningColumns":[...],
 "employees":[{"employeeId":1,"employeeName":"Maria Lopez","selected":true,"totalHours":80,"directDeposit":false,"payFrequency":"biweekly","lastCheckDate":"","warnings":[],
   "lines":[{"itemId":4,"rate":22.5,"qty":80,"amount":1800,"itemName":"Hourly Wage","category":"earning",...},{"itemId":5,"rate":33.75,"qty":null,"amount":0,...}]}]}
```
Default earnings: copied from the employee's last paycheck (prefs `copyEarningsFromPrevious`,
hours when `recallHours`; one-time amounts like bonuses are not repeated), plus the employee's
earnings items. A salaried employee's first salary line gets the period's hours (2080 / periods).
`nextCheckNumber` is the next number Books suggests for the bank account.

### POST /paychecks/calculate (preview, nothing saved)

Body `PaycheckInput`:

| Field | Meaning |
|---|---|
| `id` | 0 for a new paycheck; a saved id to preview an edit. |
| `employeeId` | required. |
| `kind` | `regular` (default) or `ytd`. |
| `periodStart`, `periodEnd`, `checkDate` | Check date required; period end defaults to check date; start defaults from the employee's frequency. |
| `bankAccountId`, `checkNumber`, `toBePrinted`, `directDeposit`, `memo`, `classId`, `noAccrual` | |
| `lines[]` | `{itemId, rate, qty, amount, manual, jobNameId, classId}`. |
| `recalculate` | For a saved paycheck: false keeps every amount sent. |

Rules (from the code):
- Earnings lines come only from the request. Hourly: `rate` x `qty` hours. Salary: the
  per-period amount is always the employee's annual salary / pay periods (the `rate` sent is used
  only when the employee has no annual salary), split across the salary lines (for example
  Salary and Vacation Salary) by their hours; to pay another amount send the line with
  `manual:true` and `amount`. Overtime: `qty` hours; rate = multiplier x the employee's hourly
  rate unless given. Bonus/tips: `rate` = amount.
- Every other line (additions, deductions, contributions, taxes) is computed from the employee's
  setup unless the line is sent with `manual:true` (its `amount` is kept; `computed` shows the
  calculated amount). Extra one-time items can be sent as lines (computed by the item's method,
  e.g. `{"itemId":14,"qty":100}` = 100 miles).
- Percent deductions are a percent of earnings (additions excluded). Annual limits and wage
  base caps use year-to-date amounts. Match = rate % of the matched deduction, capped at
  `matchCapPct` % of gross.
- Federal withholding: IRS Pub 15-T percentage method; supplemental items at 22% (37% over
  $1,000,000; aggregate method if no federal income tax was withheld from regular wages this
  year or last). State withholding from the state tables; supplemental at the state rate.
- Warnings in `warnings[]`, e.g. "Federal Withholding: employee is exempt.", "401(k) Employee:
  limited to ... by the annual limit of ...", "SerieX Payroll has no 2027 tax tables yet; ...".

Response = `Paycheck` (see 9) with every line: `amount`, `wageBase` (taxable this check),
`subjectWages`, `computed`, `ytd`, plus totals `gross`, `deductions`, `employeeTaxes`, `net`,
`employerTaxes`, `contributions`, `totalHours`, `sick`/`vacation` snapshots. Verified example:
gross 1935, deductions 96.75, employeeTaxes 348.31, net 1489.94, employerTaxes 227.37, contributions 77.4.

### POST /payroll/create (Create Paychecks)

Body `CreatePayrollRequest`:

| Field | Meaning |
|---|---|
| `kind` | `scheduled`, `unscheduled` (default), `termination`. |
| `payScheduleId` | required for scheduled. |
| `periodStart`, `periodEnd`, `checkDate` | Period end and check date required. |
| `bankAccountId` | required (Books bank account). |
| `printMode` | `print` (default: checks wait in "to be printed"; numbered when marked printed) or `handwritten` (numbers from `firstCheckNumber`, must end with a digit). |
| `firstCheckNumber` | handwritten only. |
| `paychecks[]` | One `PaycheckInput` per employee (earnings lines, manual overrides, `directDeposit`). Check date and bank are taken from the request. |
| `releaseDate` | termination: written to the employees' release date (default check date). |

Behavior: all paychecks are recalculated and saved in one transaction, then posted to Books
one by one. Direct deposit paychecks get check number `DD<paycheck id>`. A scheduled run moves
the pay schedule past the period. Paying the same scheduled period twice asks `confirm` ("The
Biweekly payroll for the pay period ending 10/17/2026 was already created (1 paycheck). Do you
want to create these paychecks anyway?"). Duplicate handwritten check numbers ask `confirm`
(prefs `warnDuplicateCheckNumbers`). Errors: "The paycheck of X has no earnings...", "Net pay
cannot be less than zero. The paycheck of James Chen has a net pay of -20.00; reduce its
deductions or taxes.", "James Chen is not set up for direct deposit.".

Response: `{"runId":1,"paychecks":[PaycheckSummary...],"posted":2,"problems":[SyncProblem...]}`.
Posting problems never undo the payroll; once Books is unreachable or the session expired, the
remaining paychecks are marked with the same error.

### POST /paychecks (one paycheck)

Same body as calculate. `kind:"regular"`: an unscheduled single paycheck (bank defaults to
prefs default; `toBePrinted` or `directDeposit` clear the check number). Saved, then posted.
`kind:"ytd"`: a year-to-date entry (see 7). Returns the full `Paycheck`.

---

## 9. Paychecks: view, edit, void, delete, print

Screens: Employees > Find and Edit Paychecks... (also Edit > Find Paychecks, Ctrl+F); File >
Print > Paychecks... / Pay Stubs...

### Paycheck object

`PaycheckInput` fields plus read-only: `runId`, `employeeName`, `gross`, `notPaid`,
`deductions`, `employeeTaxes`, `net`, `employerTaxes`, `contributions`, `totalHours`,
`employeeSummary[]`, `companySummary[]` (`{itemId,itemName,category,amount,ytd}`), `sick`,
`vacation` (`{availableBefore,accrued,used,availableAfter}`), `voided`, `booksTxnId`,
`syncStatus` (`none`|`pending`|`posted`|`error`), `syncError`, `bankAccountName`, `warnings`,
`createdBy`, `createdAt`, `updatedAt`. Line categories: `earning`, `addition`, `deduction`,
`employee_tax`, `employer_tax`, `contribution`.

### Routes

- `GET /paychecks?employeeId=&from=&to=&kind=regular|ytd&runId=&includeVoided=1&q=` ->
  `PaycheckSummary[]`, newest first. Voided paychecks are hidden unless `includeVoided=1`.
- `GET /paychecks/{id}` -> full paycheck.
- `PUT /paychecks/{id}` -> edit (past paychecks can be edited). The employee cannot change.
  Header fields not sent are reset (`memo` -> "", `checkNumber` -> "", `toBePrinted`,
  `directDeposit` -> false, `classId`, `noAccrual`); dates and bank default to the stored ones.
  Omit `lines` to keep the saved lines; send `lines` with `recalculate:true` to recompute, or
  `recalculate:false` to keep every amount sent (lines not sent are dropped). The Books check is
  updated in place (same Books id). **Always GET the paycheck and send the whole object back.**
  `conflict` "This paycheck is void and cannot be changed."
- `POST /paychecks/{id}/void` -> voids the Books check first (stops on a Books error, e.g. a
  `confirm` for a reconciled check: ask the user, then `?force=1` only after their yes), then sets every amount to 0, memo
  `VOID: ...`, keeps the record. `conflict` "This paycheck is already void."
- `DELETE /paychecks/{id}` -> deletes the Books check first, then the paycheck. 204.
- To replace a wrong paycheck: void (or delete) it and create a new one with `POST /paychecks`
  (or an extra paycheck, API kind `unscheduled`).
- `GET /paychecks/to-print?bankAccountId=` -> paychecks waiting to be printed (not voided, not
  direct deposit).
- `POST /paychecks/mark-printed {"ids":[1],"firstNumber":"2284"}` -> numbers the paychecks in
  the given order, clears "to be printed", re-posts them (Books check gets the number):
  `{"updated":1,"posted":1,"problems":[]}`.
- `GET /paystubs?ids=1,2` -> pay stub data (company, employee, earnings, taxes, deductions,
  additions, contributions, gross/net with YTD, PTO, `netInWords`). Printing happens in the
  browser (File > Print).

---

## 10. Liabilities

Screens: Employees > Payroll Center > Pay Taxes tab; Employees > Payroll Taxes > Pay Payroll
Taxes... / Record a Tax Payment... / Adjust Tax Balances... / Record Earlier Tax Payments... /
Tax Payment Schedule... The screens call liability payments "tax payments", liability
adjustments "tax balance adjustments" and prior payments "earlier tax payments".

### Payment groups and schedules

Liabilities of the items in one payment group are paid together on one schedule:

| Group | Items | Default frequency, method |
|---|---|---|
| `federal_941` | FIT, SS_EE, SS_ER, MED_EE, MED_ER, ADDL_MED | `monthly` or `semiweekly` (per deposit schedule), e-pay |
| `federal_940` | FUTA | `quarterly`, e-pay |
| `state_wh:XX` | SIT of state XX | `monthly`, e-pay |
| `state_ui:XX` | SUI_ER, SUI_EE, ST_EE, ST_ER of XX | `quarterly`, e-pay |
| `vendor:<id>` | deductions, contributions, local taxes with that agency | `after_payroll`, check |
| `unassigned` | items without an agency | `after_payroll`, check (cannot be paid from the due list) |

Due dates: monthly = 15th of the next month; semiweekly = Pub 15 rule (paydays Wed-Fri due
the next Wednesday, Sat-Tue due the next Friday, plus holidays); quarterly = last day of the
month after the quarter (state groups follow the state's quarterly report date); annually =
Jan 31; after_payroll = check date. Weekends and legal holidays move the date forward. FUTA
paid quarterly follows the $500 rule (undeposited FUTA of $500 or less carries to the next
quarter; the rest of the year is due Jan 31).

- `GET /payment-schedules` -> `[{paymentGroup,label,agencyVendorId,agencyName,frequency,method,itemNames}]`.
- `PUT /payment-schedules` body = array (or `{"schedules":[...]}`); only the groups sent
  change: `[{"paymentGroup":"vendor:73","frequency":"monthly","method":"check","agencyVendorId":73}]`.
  Frequencies: `semiweekly`, `monthly`, `quarterly`, `annually`, `after_payroll`.

### GET /liabilities/due?from=&to=&showPaid=1

Periods overlapping from..to (all when omitted); paid periods hidden unless `showPaid=1`.

```json
{"paymentGroup":"federal_941","label":"Federal 941/944/943","agencyVendorId":69,"agencyName":"United States Treasury",
 "periodStart":"2026-10-01","periodEnd":"2026-10-31","dueDate":"2026-11-16","status":"Upcoming","frequency":"monthly","method":"e-pay",
 "amountDue":837.92,"items":[{"itemId":22,"itemName":"Federal Withholding","amount":177.72},...]}
```
Status: `Paid`, `Overdue`, `Due` (within prefs `dueSoonDays`, default 14), `Upcoming`.
Payments are applied oldest period first; an overpayment is used for other periods.

### GET /liabilities/balances?from=&to=

Per item: `{itemId,itemName,itemType,paymentGroup,agencyName,accrued,adjusted,paid,balance}`
(balance = accrued + adjusted - paid).

### POST /liability-payments/from-due (Pay Payroll Taxes)

`{"rows":[{"paymentGroup","periodStart","periodEnd"}], "date", "bankAccountId", "toBePrinted", "firstCheckNumber", "memo"}`.
Creates one payment per agency and period, for the full remaining amount of each item. Checks
(method `check`, not to be printed) get the first number given or the next Books number; e-pay
gets none. Default memo: "EIN 12-3456789 Form 941" for federal, "Acct <state id>" for state
groups. Each payment is posted to Books. Response `{"payments":[LiabilityPayment...],"problems":[]}`.
Errors: "These taxes have no payee. Choose the agency of the payroll items, or the payee
of \"Unassigned (no payee)\" in Tax Payment Schedule." (`rows[0]`), "... is already paid.".

### LiabilityPayment and custom payments (Record a Tax Payment)

`{id, kind:"payment"|"prior", date, periodStart, periodEnd, agencyVendorId, bankAccountId, checkNumber, toBePrinted, method:"check"|"e-pay", memo, lines[]}`,
lines `{kind:"item", itemId, amount, memo}` or `{kind:"expense", accountId, amount, memo}`;
read-only `amount`, `agencyName`, `bankAccountName`, `voided`, `booksTxnId`, `syncStatus`,
`syncError`, `createdBy`, `createdAt`.

- `POST /liability-payments` (custom payment), verified:
  `{"date":"2026-10-24","periodStart":"2026-10-01","periodEnd":"2026-10-31","agencyVendorId":73,"bankAccountId":1,"method":"check","checkNumber":"5001","memo":"Plan 123","lines":[{"kind":"item","itemId":15,"amount":96.75},{"kind":"item","itemId":20,"amount":77.40},{"kind":"expense","accountId":62,"amount":5,"memo":"Late fee"}]}`.
  `kind:"payment"` requires agency and bank. Period defaults: end = date, start = first of that
  month. Paying more than an item's balance asks `confirm` ("The amount paid for 401(k) Employee
  (200.00) is more than its liability balance (96.75). Record the payment anyway?"). A used check
  number asks `confirm`.
- Earlier tax payments (`kind:"prior"`): history for year-to-date amounts; item lines only; agency and
  bank optional; never posted.
- `GET /liability-payments?from=&to=&kind=&agencyVendorId=&includeVoided=0` (voided payments are
  **included** unless `includeVoided=0`). `GET /liability-payments/{id}`.
- `PUT /liability-payments/{id}` (full object; re-posts). `conflict` if void.
- `POST /liability-payments/{id}/void` -> voids the Books check first, sets amounts to 0, memo `VOID: ...`.
- `DELETE /liability-payments/{id}` -> deletes the Books check first.

To create a vendor for a plan or agency from Payroll: `POST /books/vendors {"name","companyName","address":{...},"phone","accountNumber"}`.

### Liability adjustments (Adjust Tax Balances)

`{id, date, effectiveDate, employeeId (null = company), memo, affectsAccounts, classId, lines:[{itemId, amount, wageBase, memo}]}`.
Positive amount increases the liability; `wageBase` changes the item's taxable wages (employee
adjustments only). `affectsAccounts:true` posts a Books journal entry (section 1).
- `GET /liability-adjustments?from=&to=&employeeId=`, `GET /liability-adjustments/{id}`.
- `POST /liability-adjustments`, `PUT /liability-adjustments/{id}` (re-posts, or removes the
  journal entry when it no longer affects accounts).
- `DELETE /liability-adjustments/{id}` (Books entry deleted first).
- Errors: "Enter at least one amount or wage base to adjust.", "Income subject to tax (X) can
  only be adjusted for an employee.".

---

## 11. Tax forms

Screens: Employees > Tax Forms > All Tax Forms... / Form 941... / Form 940... / W-2/W-3... /
State Unemployment Report...; Payroll Center > Tax Forms tab.

Payroll computes the forms from paychecks (including YTD entries), adjustments and payments,
shows them as paper-like pages that can be printed, and keeps a "filed" copy. **It submits
nothing.** The user files and pays through the agency (for example IRS e-file through a provider
or a paper return, EFTPS for federal deposits, SSA Business Services Online for W-2s, the state's
online portal for state reports), copying the numbers from SerieX.

### GET /forms/filings?year=2026

Every form period with wages plus saved filings: `[{id, form:"941"|"940"|"W-2"|"STATE-UI", year, period:"Q1".."Q4"|"Y", state, status:"new"|"draft"|"filed", filedAt, updatedAt, dueDate, title}]`.

### Form 941, 940, state wage report (`TaxForm`)

- `GET /forms/941?year=2026&quarter=4`, `GET /forms/940?year=2026`,
  `GET /forms/state-ui?year=2026&quarter=4&state=CA` (`reveal=1`: full SSNs, administrators,
  audited). `snapshot=1` returns the copy saved when it was marked filed.
- Shape: `{form, year, period, state, title, company{ein,name,tradeName,address,stateId,contactName,contactPhone,email}, lines[], status, filedAt, dueDate, warnings[], extra{}}`.
  Line: `{key, col, label, section, kind:"money"|"number"|"count"|"check"|"text", value, text, checked, computed, editable, overridden}`.
- Verified 941 Q4 2026 (one month of payroll): line 2 4218.25, line 3 177.72, 5a 4315 (col 2
  535.06), 5c 4315 (125.14), line 6 837.92, line 13 deposits 837.92, line 16 box 1 checked
  (under $2,500). Line 1 counts employees paid for the pay period including the 12th of the
  quarter's last month (Dec 12 for Q4). `extra`: `monthlyLiability`, `depositSchedule`,
  `actualTaxes`, Schedule B rows for semiweekly depositors.
- 940 `extra`: `scheduleA` (credit reduction by state), `part5Required`.
- State report (verified CA "DE 9 / DE 9C"): employee counts per month, subject wages, UI
  taxable wages and rate, program lines (SDI, ETT), state income tax withheld, totals;
  `extra.employees[]` = `{employeeId,name,ssn,gross,suiWages,excessWages,sitWages,sitWithheld,weeksWorked,monthsEmployed[3]}`.
  Warns when the state UI account number is missing.
- `PUT` same query + `{"overrides":{"7":0.01,"5a:1":100},"texts":{"sign:name":"Pat Owner"},"checks":{"17":true},"status":"draft"|"filed"}`.
  Keys are `key` or `key:col` of **editable** lines only (otherwise "Line X of ... cannot be
  changed."). Each PUT **replaces all** saved values (send the full set each time). Omitted
  `status` keeps the current status. `filed` stores a snapshot; if payroll data changes later
  the form warns "Payroll data changed after this form was filed on <date> (lines ...). File
  <correction form> if the filed return is wrong.".
- `GET /forms/state-ui/csv?year=&quarter=&state=` -> CSV download (`CA-wage-report-2026-Q4.csv`)
  with one row per employee and a TOTAL row, for state portals that accept uploads.

### W-2 / W-3

- `GET /forms/w2?year=2026[&reveal=1]` -> `{year, company, employees:[W2], w3, status, filedAt}`.
  W2 has boxes `box1`..`box11`, `box12[{code,amount}]`, `statutory`, `retirementPlan`,
  `thirdPartySick`, `box14[{label,amount}]`, `box14b` (tipped occupation codes), `states[{state,stateId,wages,tax}]`,
  `locals[]`, `reviewed`, `warnings`. Verified: hourly employee box1 1838.25 (401(k) excluded),
  box3/5 1935, box12 D 96.75 and TT 45 (qualified overtime premium), box13 retirement plan, box14 CA SDI.
- `PUT /forms/w2?year=2026 {"reviewed":[1,2],"status":"draft"|"filed","occupationCodes":{"1":["102"]}}`.
- `GET /forms/w2/efw2?year=2026&submitterId=ABCD1234[&submitterName&contact&phone&ext&email&fax&preparer=L&resub=1&wfid&terminating&pin]`
  (administrators) -> the SSA EFW2 text file `W2REPORT_2026.txt` (RA, RE, RW, RO, RT, RU, RF
  records, 512 characters each; header `X-RW-Records`). `submitterId` = the 8-character SSA BSO
  User ID (required). Problems (missing contact, invalid SSNs, incomplete address, bad EIN
  prefix) come as a `confirm`; `?force=1` creates the file anyway (show the problems to the
  user first: a file with them is usually rejected by SSA). The user uploads it to SSA
  Business Services Online themselves. Contact defaults: company contact name, contact phone,
  company email.

---

## 12. Reports

Screens: Reports > Report Center, Reports > Payroll and Employees, Reports > Tax Forms.

`GET /reports` lists `{key,title,category,description,params,defaultDates}`.
`GET /reports/{key}?...` returns the Books report shape: `{key,title,companyName,dateRangeLabel,basis,columns[{key,label,type}],rows[{kind:"section"|"data"|"subtotal"|"total"|"grandtotal"|"blank",level,cells{},target?,drill?}],params,generatedAt}`.

| Key | Title | Params (default dates) |
|---|---|---|
| `payroll_summary` | Payroll Summary | dates, employeeId, columns `employee` (default) \| `total` \| `month` \| `quarter` \| `year` (this quarter) |
| `payroll_item_detail` | Payroll Item Detail | dates, employeeId, itemId, includeVoided, paidFor (this month to date) |
| `payroll_detail_review` | Payroll Detail Review | dates, employeeId, itemId, differences=1 (only hand-changed lines) |
| `payroll_register` | Payroll Register | dates, employeeId, includeVoided (this quarter) |
| `employee_earnings_summary` | Employee Earnings Summary | dates, employeeId (this quarter) |
| `payroll_liability_balances` | Payroll Liability Balances | dates, columns `month` (default) \| `quarter` \| `year` \| `total` (this year) |
| `payroll_transactions_by_payee` | Payroll Transactions by Payee | dates, employeeId, includeVoided |
| `payroll_transaction_detail` | Payroll Transaction Detail | dates, employeeId, itemId, includeVoided |
| `payroll_journal` | Payroll Journal (SerieX Books postings) | dates, employeeId |
| `employee_state_taxes_detail` | Employee State Taxes Detail | dates, employeeId, itemId, state (this year to date) |
| `employee_withholding` | Employee Withholding | employeeId, active |
| `paid_time_off_list` | Paid Time Off List | asOf, employeeId, active |
| `employee_contact_list` | Employee Contact List | employeeId, active |
| `payroll_item_listing` | Payroll Item Settings | itemId, active |
| `tax_form_941_worksheet` | Form 941 Worksheet | year, quarter |
| `tax_form_940_worksheet` | Form 940 Worksheet | year |

Dates: `from`/`to` (YYYY-MM-DD) or `dates=<preset>`: `all`, `today`, `thisWeek`,
`thisWeekToDate`, `thisMonth`, `thisMonthToDate`, `thisQuarter`, `thisQuarterToDate`,
`thisYear`, `thisYearToDate`, `lastWeek`, `lastMonth`, `lastQuarter`, `lastYear` (and the
`...ToDate`/`next...` variants; Books' `...Fiscal...` names also work). Payroll quarters and years
are calendar periods. `active` = `active` (default) | `all` | `inactive`. SSNs print in full only
for administrators with prefs `showSsnOnReports` (audited).

Payroll Summary columns are `e<employeeId>_hours`, `e<id>_rate`, `e<id>_amount`, `total_hours`,
`total_amount`; sections Gross Pay, Deductions from Gross Pay, Adjusted Gross Pay, Taxes Withheld,
Net Pay, Employer Taxes and Contributions. Data rows drill to `payroll_item_detail`.

---

## 13. Books link: posting, sync, verify

Screen: Employees > SerieX Books Sync... (tabs Not posted and Verify).

**Posting states** (`syncStatus` on paychecks, tax payments, adjustments): `posted`
(in Books, `booksTxnId` set), `pending` (waiting), `error` (Books refused or was unreachable;
`syncError` says why), `none` (never posted: YTD, earlier tax payment, adjustment without accounts, or
saved while posting was off).

- `GET /books/status` -> `{url, reachable, companyName, sessionOk, postToBooks, pendingCount, errorCount, message}`
  ("Connected to SerieX Books.", "SerieX Books is not running at ...", "Your SerieX Books session
  has expired...", "Posting to SerieX Books is turned off in the payroll preferences.").
- `GET /books/sync?status=open|all&from=&to=` -> `[{entity,id,date,label,amount,booksTxnId,status,error,syncedAt}]`.
  Verified error item: `{"entity":"paycheck","id":4,"label":"Paycheck - Maria Lopez","status":"error","error":"SerieX Books: the server at http://127.0.0.1:47180 is not reachable (...). Start SerieX Books and try again."}`.
- `POST /books/sync/retry {"items":[{"entity":"paycheck"|"liability_payment"|"adjustment"|"employee","id":4}]}`
  -> `{"posted":1,"problems":[]}`. Empty body or `items:[]` = every pending/error record.
  Naming an already-posted record re-posts it (puts payroll's version back in Books, or creates
  a new check if the Books one was deleted). Pass `?force=1` when Books asked a question and the
  user said yes; a closing date refusal is for the user to handle in SerieX.
- Posting off: prefs `postToBooks:false` saves records with `syncStatus:"none"`. Turning it back
  on marks them `pending`; run retry to post them.

**Payroll and Books agree check (Verify).** `POST /books/verify {"from":"2026-01-01","to":"2026-12-31"}`
(both optional; **`to` defaults to today**, so future-dated paychecks are skipped unless you send `to`).

```json
{"checked":6,"problems":[{"entity":"paycheck","id":5,"label":"Paycheck - James Chen (10/30/2026)","booksTxnId":1656,"problem":"missing in SerieX Books"}],
 "accounts":[{"accountId":66,"accountName":"Payroll Liabilities:Federal Unemployment (940)","payrollBalance":55.41,"booksBalance":13.41,"difference":0,"notInBooks":42,"notPosted":0}]}
```
- `problems`: each posted record is compared with its Books transaction: missing, voided on one
  side only, type, date, bank account, payee, check number, amount, amount per account.
- `accounts`: for every payroll liability account, payroll's balance as of `to` versus the Books
  trial balance (accrual). `notInBooks` = part never posted by design (YTD, earlier tax payments,
  adjustments without accounts, records saved while posting was off); `notPosted` = waiting in
  Books Sync. `difference` = payrollBalance - notInBooks - notPosted - booksBalance.
- Healthy file: `problems` empty and every `difference` 0. Fix: retry the listed records
  (`POST /books/sync/retry` with their refs), or correct the Books transaction.

**Books pickers through Payroll** (use the logged-in user's Books session):
`GET /books/accounts?types=Bank,Expense`, `POST /books/accounts {"name","type","parentId","number"}`,
`GET /books/vendors`, `POST /books/vendors`, `GET /books/classes`, `GET /books/jobs` (customers:jobs),
`GET /books/next-check?accountId=1` -> `{"refNumber":"5002"}`, `GET /books/open-url` -> `{"url":"http://127.0.0.1:47180"}`.

---

## 14. Company information, preferences, access, audit, tax tables

**Company** (Employees > Company Payroll Information...): `GET /company` ->
`{booksCompanyId, name, legalName, tradeName, address, phone, email, ein ("12-3456789"), contactName, contactTitle, contactPhone, primaryState, federalDepositSchedule, firstPayrollYear, setupDone, setupState, booksUrl}`.
`PUT /company` is a **partial** update (only keys sent change; administrators). Changing the
deposit schedule also changes the 941 payment schedule if it still had the old default.
`POST /company/refresh` copies name, address, phone, email, EIN from Books.

**State settings**: `GET /state-settings` -> `[{state, withholdingId, uiId, uiRates{"2026":3.4}, otherRates{"2026":{"SDI:EE":1.2}}, stateName}]`.
`PUT /state-settings/{state}` partial (`uiRates`/`otherRates` replaced as a whole when sent).
The SUI rate is per year: a year without a saved rate uses the state's **new employer** rate.

**Preferences** (Edit > Preferences, tabs Payroll & Employees, SerieX Books, Access):
`GET /prefs`, `PUT /prefs` partial (administrators). Fields and defaults:
`defaultBankAccountId`, `displayNameOrder` "first", `copyEarningsFromPrevious` true,
`recallHours` true, `jobCosting` false, `classTracking` "none"|"paycheck"|"earnings",
`showSsnOnReports` false, `postToBooks` true, `payStubShowCompanyAddress` true,
`payStubShowPto` true, `payStubShowYtd` true, `payStubShowSsnLast4` true,
`warnDuplicateCheckNumbers` true, `dueSoonDays` 14 (0-90).

**Access**: `GET /access` -> `{"users":["Clerk"],"booksUsers":[{"name":"Admin","isAdmin":true},...]}`;
`PUT /access {"users":["Clerk"]}` (administrators; names must be Books users; removed users are logged out).

**Audit trail** (Reports > Audit Trail): `GET /audit?from=&to=&entity=paycheck&user=` -> up to
2000 rows `{id, ts, user, action, entity, entityId, summary, details}`.

**Tax tables** (Employees > Tax Tables...): `GET /tax-tables?year=2026` ->
`{year, version, federal{...rates, wage bases, limits}, states[{state,name,method,flatRate,suiWageBase,suiNewRate,programs,confidence,overridden}], overrides[]}`.
`GET|PUT|DELETE /tax-tables/{year}/federal` and `/tax-tables/{year}/states/{state}`: PUT takes
the full object (GET, change, PUT), stored as a company correction over the built-in table
(administrators); DELETE restores the built-in table. Static lists for screens: `GET /api/meta`
(item types, tax codes, frequencies, tax tracking types, box 12 codes, states with filing
statuses/programs/inputs, W-4 statuses, tax years).

---

## 15. Limits

- **No money movement.** Paychecks are records plus printable checks and stubs. Direct deposit
  bank details are only stored (masked); no bank or ACH file is produced, so the user must send
  direct deposits through their bank. Tax "payments" only record the payment and post the
  check to Books; the user pays the IRS (EFTPS), the state or the plan themselves.
- **No filing.** Forms 941, 940, W-2/W-3 and state wage reports are computed, printable and can
  be marked filed in SerieX, but nothing is transmitted. The EFW2 file must be uploaded by the
  user to SSA Business Services Online. State reports: copy the numbers or upload the CSV where
  the state accepts it.
- **Tax tables for 2025 and 2026 only** (`taxYears:[2025,2026]`). A check dated in 2027 uses the
  2026 tables plus the 2027 values announced so far (social security wage base 192,300; HSA
  limits) and every such paycheck warns "SerieX Payroll has no 2027 tax tables yet; ...". Earlier
  years use the earliest tables. Administrators can correct tables per year.
- Local income taxes are only percent-of-wages `other_tax` items that the user sets up.
- Payroll needs SerieX Books running at its `-books` address for the company list, logins,
  pickers and posting; when Books stops, existing sessions keep working and postings wait in
  Books Sync.

---

## 16. Screen map

| Task | Menu path |
|---|---|
| Set up payroll | File > Open or Set Up Company... (Set Up Payroll); Employees > Payroll Setup... |
| Company EIN, contact, state IDs and SUI rates | Employees > Company Payroll Information... |
| Preferences, posting on/off, user access | Edit > Preferences... |
| Payroll items | Lists > Payroll Items; Employees > Payroll Items |
| Pay schedules | Lists > Pay Schedules |
| Employees | Employees > Employee Center (Lists > Employee List) |
| Employee defaults | Employees > Employee Defaults... |
| Year-to-date amounts | Employees > Enter Year-to-Date Amounts... |
| Run payroll | Employees > Payroll Center (Pay Employees tab); Employees > Pay Employees > Run Payroll... / Extra Paycheck... / Final Paycheck... (steps Hours and Pay, Review, Done) |
| Edit, void, find paychecks | Employees > Find and Edit Paychecks...; Edit > Find Paychecks... (Ctrl+F) |
| Print paychecks, pay stubs | File > Print > Paychecks... / Pay Stubs... |
| Pay payroll taxes | Employees > Payroll Center (Pay Taxes tab); Employees > Payroll Taxes > Pay Payroll Taxes... / Record a Tax Payment... / Adjust Tax Balances... / Record Earlier Tax Payments... / Tax Payment Schedule... |
| Tax forms | Employees > Tax Forms > All Tax Forms... (or Form 941... / Form 940... / W-2/W-3... / State Unemployment Report...); Payroll Center (Tax Forms tab) |
| Reports | Reports > Report Center / Payroll and Employees / Tax Forms |
| Books posting problems, Verify | Employees > SerieX Books Sync... |
| Tax tables | Employees > Tax Tables... |
| Audit trail | Reports > Audit Trail |
| Switch apps | Payroll: File > Switch to SerieX Books...; Books: File > Switch to SerieX Payroll... |

---

## 17. Pitfalls

1. Setup via the API: send `createAccounts:true` and `createAgencies:true` (they default to
   false, which leaves items without accounts, so paychecks cannot post). Always send the real
   `ein`: otherwise the Books tax id is used, and the Books sample's "00-0000000" becomes the EIN.
2. Deduction and contribution items start without an agency (group `unassigned`); Pay Payroll
   Taxes refuses them until an agency is set (item `agencyVendorId` or the payment schedule).
3. `PUT /items/{id}`, `PUT /employees/{id}`, `PUT /pay-schedules/{id}`, `PUT /employee-defaults`
   and tax table PUTs replace the whole object. `PUT /company`, `PUT /prefs`,
   `PUT /state-settings/{state}` are partial. `PUT /paychecks/{id}` resets header fields not sent
   (memo, check number, direct deposit). GET first, change, send everything back.
4. Earnings lines are never added by the server: a paycheck contains only the earnings lines sent
   (use `/payroll/start` lines). Everything else is computed unless `manual:true`. A salary line's
   amount comes from the employee's annual salary, not from the `rate` sent.
5. Employee defaults are not applied by `POST /employees`; send schedule, work state and items.
6. YTD entries create taxes due that look overdue; record earlier tax payments for what was paid.
7. `POST /books/verify` without `to` checks only up to today.
8. SUI rate must be entered for each year (`uiRates` by year); otherwise the new employer rate is used.
9. The tax payment list (`GET /liability-payments`) includes voided payments by default; the paycheck list hides them.
10. Void/delete stop when Books refuses (reconciled check -> `confirm`, closing date -> `closing_date`);
    ask the user; resend with `?force=1` only after their yes; a closing date refusal is theirs to handle in SerieX.
11. A check that waits to be printed is in Books without a number until `mark-printed`.
12. Form PUT replaces all saved overrides/texts/checks; form line keys with a column use `key:col`
    (for example `sign:name`, `5a:1`).
13. Only Books administrators can set up payroll, change company info/preferences/access/tax
    tables, see full SSNs and create the EFW2 file.

---

## 18. Full route list

Global: `GET /api/health`, `GET /api/info`, `GET /api/meta`, `GET /api/companies`,
`GET /api/companies/{id}/auth`, `POST /api/companies/{id}/login`, `POST /api/companies/{id}/setup`,
`GET /api/companies/{id}/bank-accounts`, `POST /api/c/{cid}/logout`.

Company scoped (`/api/c/{cid}` prefix):

| Area | Routes |
|---|---|
| Company | `GET/PUT /company`, `POST /company/refresh`, `GET/PUT /prefs`, `GET /state-settings`, `PUT /state-settings/{state}`, `GET/PUT /access`, `GET /audit` |
| Books link | `GET /books/status`, `GET /books/open-url`, `GET/POST /books/accounts`, `GET/POST /books/vendors`, `GET /books/classes`, `GET /books/jobs`, `GET /books/next-check`, `GET /books/sync`, `POST /books/sync/retry`, `POST /books/verify` |
| Tax tables | `GET /tax-tables`, `GET/PUT/DELETE /tax-tables/{year}/federal`, `GET/PUT/DELETE /tax-tables/{year}/states/{state}` |
| Items | `GET/POST /items`, `POST /items/defaults`, `GET/PUT/DELETE /items/{id}`, `PUT /items/{id}/active` |
| Employees | `GET/POST /employees`, `GET/PUT/DELETE /employees/{id}`, `PUT /employees/{id}/active`, `GET /employees/{id}/ssn`, `GET /employees/{id}/summary`, `POST /employees/{id}/books-sync`, `GET/POST /employees/{id}/pto-adjustments`, `DELETE /employees/{id}/pto-adjustments/{adjId}`, `GET/PUT /employee-defaults` |
| Pay schedules | `GET/POST /pay-schedules`, `GET/PUT/DELETE /pay-schedules/{id}`, `POST /pay-schedules/{id}/assign` |
| Payroll | `GET /payroll/scheduled`, `POST /payroll/start`, `POST /payroll/create`, `POST /paychecks/calculate`, `GET/POST /paychecks`, `GET /paychecks/to-print`, `POST /paychecks/mark-printed`, `GET/PUT/DELETE /paychecks/{id}`, `POST /paychecks/{id}/void`, `GET /paystubs` |
| Liabilities | `GET /liabilities/due`, `GET /liabilities/balances`, `GET/PUT /payment-schedules`, `GET/POST /liability-payments`, `POST /liability-payments/from-due`, `GET/PUT/DELETE /liability-payments/{id}`, `POST /liability-payments/{id}/void`, `GET/POST /liability-adjustments`, `GET/PUT/DELETE /liability-adjustments/{id}` |
| Forms | `GET /forms/filings`, `GET/PUT /forms/941`, `GET/PUT /forms/940`, `GET/PUT /forms/w2`, `GET /forms/w2/efw2`, `GET/PUT /forms/state-ui`, `GET /forms/state-ui/csv` |
| Reports | `GET /reports`, `GET /reports/{key}` |
