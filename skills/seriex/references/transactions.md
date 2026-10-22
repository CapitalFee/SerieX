# SerieX Books: transactions (common model) and the customer side

This file is for an assistant that helps a SerieX Books user. It covers:

- the transaction object shared by every transaction type, and the common routes
  (`/txns`, `/next-ref`, void, delete, questions, closing date);
- every customer-side transaction in detail: estimates, invoices, sales receipts,
  statement charges, payments, credit memos, refunds, deposits, billable costs,
  statements, printing flags.

Vendor and banking transactions (checks, bills, bill payments, credit card charges,
transfers, journal entries, inventory adjustments, sales tax payments, purchase orders,
Pay Bills) are in `transactions-vendors-banking.md`. They use the same transaction
object and the same routes described in parts 1 to 4 here.

All examples were run against the sample company (`sample-harborview`) and the
responses are real (trimmed). Paths are relative to `http://127.0.0.1:<port>/api/c/{cid}`.

## Contents

1. [Transaction type codes](#1-transaction-type-codes)
2. [The transaction object](#2-the-transaction-object)
3. [Conventions: dates, money, signs, numbers, defaults](#3-conventions)
4. [Common routes](#4-common-routes)
   - POST /txns, GET /txns/{id}, PUT /txns/{id}, DELETE /txns/{id}, POST /txns/{id}/void,
     GET /txns/{id}/remove-check, GET /txns, GET /txns/{id}/adjacent, GET /txns-last, GET /next-ref
5. [Questions (confirm), closing date, stale copies](#5-questions-closing-date-stale-copies)
6. [Void versus delete](#6-void-versus-delete)
7. [Sales form lines: items, discounts, subtotals, tax](#7-sales-form-lines)
8. [Estimates (EST)](#8-estimates-est)
9. [Invoices (INV)](#9-invoices-inv)
10. [Sales receipts (SALESRCPT)](#10-sales-receipts-salesrcpt)
11. [Statement charges (STMTCHG)](#11-statement-charges-stmtchg)
12. [Receive payments (PMT)](#12-receive-payments-pmt)
13. [Credit memos (CREDMEM) and applying credits](#13-credit-memos-credmem-and-applying-credits)
14. [Refunds (REFUND)](#14-refunds-refund)
15. [Make deposits (DEP)](#15-make-deposits-dep)
16. [Billable costs on invoices](#16-billable-costs-on-invoices)
17. [Helper queries](#17-helper-queries)
    - GET /open-docs, GET /undeposited, GET /billables, GET /open-estimates, GET /statements,
      GET /to-print, POST /mark-printed, GET /names/{id}/summary
18. [Accounting effect summary](#18-accounting-effect-summary)
19. [Recipes](#19-recipes)
20. [Pitfalls checklist](#20-pitfalls-checklist)

---

## 1. Transaction type codes

`type` is one of these codes (upper case; list filters accept lower case too). Any other
value gives `400 validation "Unknown transaction type "X"."`.

| Code | Label in lists and reports | Covered in | One line |
|---|---|---|---|
| `EST` | Estimate | this file | Quote to a customer. No accounting effect. |
| `INV` | Invoice | this file | Sale on credit: customer owes money (Accounts Receivable). |
| `SALESRCPT` | Sales Receipt | this file | Sale paid on the spot (money to Undeposited Funds or a bank). |
| `STMTCHG` | Statement Charge | this file | Charge added to a customer's account, billed later on a statement. |
| `PMT` | Payment | this file | Money received from a customer, applied to invoices. |
| `CREDMEM` | Credit Memo | this file | Credit owed to a customer (return, allowance). |
| `REFUND` | Refund | this file | Money paid back to a customer from a credit memo or unused payment. |
| `DEP` | Deposit | this file | Bank deposit (payments from Undeposited Funds and other money in). |
| `CHK` | Check | vendors/banking | Check or expense paid from a bank account. |
| `BILL` | Bill | vendors/banking | Vendor bill (Accounts Payable). |
| `BILLCRED` | Credit | vendors/banking | Vendor credit. |
| `BILLPMT` | Bill Pmt -Check (Bill Pmt -CCard when paid by card) | vendors/banking | Payment of bills. |
| `ITEMRCPT` | Item Receipt | vendors/banking | Items received before the bill. |
| `PURCHORD` | Purchase Order | vendors/banking | Order to a vendor. No accounting effect. |
| `CCCHARGE` | Credit Card Charge | vendors/banking | Purchase on a credit card. |
| `CCCREDIT` | Credit Card Credit | vendors/banking | Refund on a credit card. |
| `TRANSFER` | Transfer | vendors/banking | Money moved between balance sheet accounts. |
| `GENJRNL` | General Journal | vendors/banking | Journal entry (debits and credits). A journal entry with one A/R line acts as an invoice (A/R debit) or a credit (A/R credit) for that customer; see section 13. |
| `INVADJ` | Inventory Adjust | vendors/banking | Inventory quantity or value adjustment. |
| `TAXPMT` | Sales Tax Payment | vendors/banking | Payment of sales tax to an agency. |

The register shows short codes (`RCPT` for sales receipts, `ITEM RCPT` for item receipts);
the API always uses the codes in the first column.

---

## 2. The transaction object

Every type uses the same JSON object for POST, PUT and GET. Fields marked (ro) are
computed by the server: anything sent for them is ignored. Fields that do not apply to
a type are cleared by the server on save (for example `toAccountId` on an invoice).

### 2.1 Header fields

| Field | Type | Meaning |
|---|---|---|
| `id` | int | 0 or absent for a new transaction. Ignored in the body; the URL decides. |
| `type` | string | Type code (section 1). Required on POST. Cannot change on PUT (blank keeps the stored type). |
| `refNumber` | string | The number: invoice #, sale #, credit #, estimate #, the customer's check number on a payment, the check number on a refund. Max 20 characters. See 3.5 for automatic numbers. |
| `date` | string | `YYYY-MM-DD`. Required. `MM/DD/YYYY` is also accepted and converted. |
| `nameId` | int or null | Customer or job (customer side). Required for EST, INV, STMTCHG, PMT, CREDMEM, REFUND; optional for SALESRCPT; optional and rarely used on DEP (deposit lines carry their own `nameId`). Must be a customer or job on customer types, else 400. |
| `nameFull` | string (ro) | "Customer:Job" full name. |
| `accountId` | int or null | Header account. INV/CREDMEM/STMTCHG: the A/R account (default the A/R account). SALESRCPT/PMT: the deposit-to account (Bank or Other Current Asset; default Undeposited Funds, see 3.6). REFUND: the Bank or Credit Card account the refund is paid from (required). DEP: the bank account (required, not Undeposited Funds). EST: always null. |
| `arApAccountId` | int or null | PMT and REFUND only: the A/R account (default the A/R account). |
| `toAccountId` | int or null | TRANSFER only. |
| `amount` | number | Total. Input only for PMT (required), REFUND (optional: 0 means "the total of the links"), and vendor types BILLPMT, TRANSFER, TAXPMT. For every other type the server computes it from the lines and ignores what is sent. |
| `openBalance` | number (ro) | INV/STMTCHG: still owed. PMT/CREDMEM: credit not used yet. 0 for others, for voided and pending transactions. |
| `subtotal` | number (ro) | Sales forms: sum of the line amounts before header tax (Subtotal and Payment item lines excluded). |
| `dueDate` | string | INV/STMTCHG: blank means "compute from `termsId`" (section 9.2). Otherwise stored as sent. |
| `shipDate` | string | `YYYY-MM-DD` or blank. Stored only. |
| `termsId` | int or null | Terms list entry (`GET /lists/terms`). Used for the due date and the early-payment discount. |
| `classId` | int or null | Class (`GET /lists/class`). Applies to every ledger entry of the transaction unless a line has its own class. |
| `repId` | int or null | Sales rep (`GET /lists/sales_rep`). Stored only. |
| `shipViaId` | int or null | Ship via (`GET /lists/ship_via`). Stored only. |
| `customerMessageId` | int or null | Customer message printed on the form (`GET /lists/customer_message`). Stored only. |
| `paymentMethodId` | int or null | Payment method (`GET /lists/payment_method`) of a PMT or SALESRCPT. Copied to deposit lines. |
| `fob` | string | F.O.B. (max 100). Stored only. |
| `poNumber` | string | Customer's P.O. number (max 25). Searchable with `q`. |
| `memo` | string | Memo (max 4095). Used as the memo of ledger entries without their own description. |
| `billAddress`, `shipAddress` | string | Multi-line address snapshot (`\n` between lines, max 1000). The server never fills these: copy them from the customer if you want them on the form. |
| `taxItemId` | int or null | INV, SALESRCPT, CREDMEM, EST only: Sales Tax Item or Sales Tax Group charged on taxable lines. Must be one of those item types, else 400 "Please choose a sales tax item or sales tax group." |
| `taxRate` | number (ro) | Percent used (a group is the sum of its members). |
| `taxAmount` | number (ro) | Header sales tax. |
| `toBePrinted` | bool | "To be printed" flag. Invoices appear in `GET /to-print?kind=invoices`, refunds in `kind=checks`. |
| `toBeEmailed` | bool | Flag stored only. The server does not send email. |
| `isPending` | bool | INV and SALESRCPT only ("Mark as pending"): saved but not posted, no open balance, cannot be paid. Status "Pending". |
| `status` | string | EST: input, one of `Pending`, `Accepted`, `Closed`, `Rejected` (anything else becomes `Pending`). INV/STMTCHG: (ro) `Open` or `Paid` (`Pending` when pending). Others: "". |
| `voided` | bool (ro) | Set by `POST /txns/{id}/void`. |
| `cashBackAccountId`, `cashBackAmount`, `cashBackMemo` | | DEP only (section 15). |
| `template` | string | Invoice layout: `Product Invoice`, `Service Invoice`, `Professional Invoice` (the LAYOUT field shows them as Standard, Services, Services with Dates). A blank invoice template becomes the preference `defaultInvoiceTemplate`. |
| `extra` | object | Free JSON for other apps and screen-only fields. Numbers come back exactly as sent. A PUT without `extra` keeps the stored one; `"extra": {}` clears it. Known keys: `checkNumber` (SALESRCPT: customer's check number), `via` (REFUND: `check`, `cash`, `card`), `statusBeforeInvoice` (EST, set by the server), `openingBalance` (opening balance documents, never auto-numbered). |
| `lines` | array | Lines (2.2). Required (at least one) for EST, INV, SALESRCPT, STMTCHG, CREDMEM, DEP. Ignored for PMT and REFUND. |
| `links` | array | Applications (2.3). Used by PMT, CREDMEM, REFUND (and GENJRNL). Ignored by other types. |
| `linked` | array (ro) | "Transaction History": related transactions `{txnId, type, typeLabel, date, refNumber, amount, relation}`; relation is `payment`, `credit`, `refund`, `deposit`, `invoice`, `estimate`, `sales receipt`, `bill`... |
| `cleared` | string (ro) | Cleared state of the header ledger entry: "", `*`, `R` (reconciled). |
| `createdBy`, `createdAt`, `updatedAt` | string (ro) | `updatedAt` is the version stamp used to refuse stale saves (section 5.3). |

### 2.2 Line fields (`lines[]`)

| Field | Type | Meaning |
|---|---|---|
| `id` | int | 0 for a new line. On PUT, send back the stored id to update that line in place (links from other transactions to it survive); lines whose id is not sent are deleted. |
| `seq` | int | Ignored on input; the server numbers lines 1, 2, 3 in the order sent. |
| `kind` | string | Ignored on input. Server sets: `item` (sales forms), `deposit` (DEP), `expense`/`item` (purchase forms), `je` (journal). |
| `itemId` | int or null | Item (`GET /items`). |
| `accountId` | int or null | Sales forms: only for a line without an item (it then posts straight to that account). Ignored when an item is given. DEP: the "from account" of the line. |
| `description` | string | Description (max 4095). Also the memo of the line's ledger entries. A line with only a description is kept on sales forms (a text line). |
| `qty` | number or null | Quantity. |
| `rate` | number or null | Price per unit, or a percent when `rateIsPercent`. |
| `rateIsPercent` | bool | Only kept for Discount and Other Charge items; reset to false for every other item. |
| `amount` | number | Line amount. Must equal `qty × rate` (within half a cent) when both are given (except Subtotal, Payment and sales tax items, and percent lines). Subtotal and percent lines are recomputed by the server. |
| `classId` | int or null | Line class (overrides the header class for this line's entries). |
| `nameId` | int or null | DEP: "received from". Purchase forms: customer or job of a billable cost. On sales forms it overrides the customer on that line's entries (rarely used). |
| `billable` | bool | Purchase forms only (billable cost). Ignored on sales forms. |
| `billedTxnId` | int (ro) | On purchase lines: the invoice that billed this cost. |
| `taxable` | bool | Sales forms: the line is charged the header sales tax. The server does NOT derive this from the item or the customer: send it. |
| `serviceDate` | string | `YYYY-MM-DD` or blank. Stored only. |
| `paymentMethodId`, `refNumber` | | DEP lines only: payment method and check number. |
| `linkedTxnId`, `linkedLineId` | int or null | Invoice/sales receipt/credit memo line from an estimate line (`linkedLineId` = estimate line id); invoice/sales receipt line from a billable cost (`linkedLineId` = purchase line id); DEP line taking a payment out of Undeposited Funds (`linkedTxnId` = payment or sales receipt; plus `linkedLineId` for a payment-item line). `linkedTxnId` is filled from `linkedLineId` when omitted. |
| `receivedQty`, `closed` | | Purchase order lines (vendor side). |
| `cogs` | number (ro) | Cost of goods sold of an inventory line (average cost). |

### 2.3 Link fields (`links[]`)

A link applies money from one transaction to an open document.

| Field | Type | Meaning |
|---|---|---|
| `id` | int (ro) | |
| `fromTxnId` | int or null | null or 0 (or this transaction's own id) = "from this transaction". Another id = a credit used through this payment (credit memo, unused payment or A/R journal credit of the same customer). |
| `toTxnId` | int | The document: an invoice or statement charge (or A/R journal debit) for PMT/CREDMEM; a credit memo or payment (or A/R journal credit) for REFUND. |
| `amount` | number | Amount applied. Not negative. |
| `discount` | number | PMT only: early-payment discount taken on that invoice (not on a credit). |
| `discountAccountId` | int or null | Account for the discount; default is the preference `customerDiscountAccountId` (Sales Discounts in the sample). |
| `fromType`, `fromRefNumber`, `fromDate`, `toType`, `toRefNumber`, `toDate`, `toAmount` | (ro) | Descriptions of both sides. |

On GET, own links come back with `fromTxnId` equal to the transaction's own id; sending
them back unchanged on PUT is correct.

---

## 3. Conventions

### 3.1 Dates
`YYYY-MM-DD` everywhere. `date` also accepts `MM/DD/YYYY` (or `M/D/YYYY`) on save; other
formats give `400 field=date "Please enter a valid date for this transaction."`. Query
parameters must be `YYYY-MM-DD` (`Invalid date "2026/01/01" (use YYYY-MM-DD).`). "Today"
is the server computer's local date. The screens warn about dates more than
`datePastWarnDays` in the past or `dateFutureWarnDays` in the future; the server does not.

### 3.2 Money and quantities
Amounts are JSON numbers in dollars; the server stores cents and rounds half away from
zero. Largest amount 9,999,999,999.99, largest quantity 999,999,999 (bigger values: 400).

### 3.3 Signs
- Customer-side amounts are positive: invoice totals, payment amounts, credit memo totals,
  refund amounts. A negative total is refused ("An invoice cannot have a negative total.
  Enter a credit memo instead.", same idea for sales receipts, credit memos, estimates,
  statement charges, deposits).
- Discount item lines are negative (percent discount lines are made negative by the server;
  a fixed discount line must be sent negative, e.g. `"rate": -5, "amount": -5`).
- Payment item lines on invoices or sales receipts are negative (they reduce the total).
- Link amounts and discounts are never negative.

### 3.4 Ids and null
Optional ids are `null` (0 is treated as null). Unknown JSON fields are ignored silently,
so a typo such as `customerId` instead of `nameId` is not reported (it only fails later
where a customer is required; on a sales receipt it silently gives no customer).

### 3.5 Numbers (refNumber)
- Saved with a blank `refNumber`, these types get the next number of their own sequence
  (largest all-digit number of that type + 1, "1" when none): `INV`, `SALESRCPT`,
  `CREDMEM`, `EST` (and `PURCHORD`; `GENJRNL` only when the preference
  `autoAssignJournalNumbers` is on). Numbers of deleted transactions can be given again.
- `PMT` (customer's check number), `STMTCHG`, `DEP` are never numbered automatically.
- `REFUND` uses check numbers of its bank account: the server does not assign one on
  save. Get the next one with `GET /next-ref?type=REFUND&accountId=<bank>` or mark the
  refund `toBePrinted` and assign numbers with `POST /mark-printed`.
- Duplicate invoice numbers ask a question (warning `dupnum`, preference
  `warnDuplicateInvoiceNumbers`); duplicate check numbers on refunds from a bank account
  also do (`warnDuplicateCheckNumbers`). Sales receipt, credit memo and estimate numbers
  are not checked for duplicates.

### 3.6 What the server fills in and what it does not
The screens copy customer defaults into a new form. The server does not. When creating
customer transactions through the API, fill these yourself if you want them:
- `billAddress`, `shipAddress` (from the customer, `GET /names/{id}`);
- `termsId` (customer's terms), `repId`, `taxItemId` (customer's tax item, else the
  preference `defaultSalesTaxItemId`), `paymentMethodId`;
- each line's `description`, `rate`, `amount`, `taxable` (the screens set `taxable` to
  "item is taxable AND customer is taxable"; the server does not look at the customer's
  tax setting at all).

The server does fill in:
- the A/R account (INV, CREDMEM, STMTCHG, and `arApAccountId` of PMT/REFUND);
- the deposit account of PMT and SALESRCPT: Undeposited Funds, or the preference
  `defaultDepositAccountId` when `useUndepositedFunds` is off and that preference is set;
- the due date from `termsId` when `dueDate` is blank (INV, STMTCHG);
- automatic numbers (3.5), the invoice `template` default, estimate status `Pending`;
- every computed amount: Subtotal lines, percent lines, tax, totals, open balances,
  statuses, cost of goods sold;
- group items are expanded into their member lines (section 7.1).

### 3.7 Preferences that change behavior
`GET /prefs`: `salesTaxEnabled` (off = no tax computed even with a tax item),
`useUndepositedFunds`, `defaultDepositAccountId`, `customerDiscountAccountId`,
`warnDuplicateInvoiceNumbers`, `warnDuplicateCheckNumbers`, `warnNotEnoughInventory`,
`defaultInvoiceTemplate`. The server does not check `estimatesEnabled` (it only hides the
menu) and does not apply payments automatically (`autoApplyPayments` and
`autoCalcPayments` are screen behaviors).

---

## 4. Common routes

### 4.1 POST /txns: create

Body: the transaction object. Response `200` with the full saved transaction (same shape
as GET), including computed fields, the new `id`, `refNumber` and `updatedAt`.

```
POST /txns
{"type":"INV","date":"2026-10-20","nameId":25,"termsId":6,"taxItemId":3,"classId":35,
 "customerMessageId":20,"memo":"API test invoice",
 "lines":[
  {"itemId":5,"description":"Installation","qty":2,"rate":65,"amount":130},
  {"itemId":21,"description":"Bark mulch","qty":1,"rate":45,"amount":45,"taxable":true},
  {"itemId":32},
  {"itemId":33,"rateIsPercent":true,"rate":10},
  {"itemId":31,"qty":1,"rate":75,"amount":75},
  {"description":"Thank you note only line"}]}
->
{"id":1649,"type":"INV","refNumber":"1261","date":"2026-10-20","dueDate":"2026-11-19",
 "amount":235.99,"subtotal":232.5,"taxRate":7.75,"taxAmount":3.49,"openBalance":235.99,
 "status":"Open","template":"Service Invoice","accountId":4,"createdBy":"Admin",
 "updatedAt":"2026-10-21T02:37:11.734080Z",
 "lines":[{"id":2687,"seq":1,"kind":"item","itemId":5,"qty":2,"rate":65,"amount":130,"taxable":false,"cogs":0,...},
          {"seq":2,"itemId":21,"amount":45,"taxable":true,"cogs":21.86,...},
          {"seq":3,"itemId":32,"amount":175,...},              // Subtotal computed
          {"seq":4,"itemId":33,"rate":10,"rateIsPercent":true,"amount":-17.5,...}, // 10% of the line above
          {"seq":5,"itemId":31,"amount":75,...},
          {"seq":6,"itemId":null,"description":"Thank you note only line","amount":0,...}],
 "links":[],"linked":[],...}
```

Errors met most often (all `400 validation` with `field`):
- `nameId`: "Please choose a customer or job for this transaction." / "Coastal Nursery
  Wholesale is not a customer or job. Please choose a customer or job." / "The name you selected
  no longer exists."
- `date`: "Please enter a valid date for this transaction."
- `lines`: "You cannot record a blank transaction. Please enter at least one line." /
  "Line 1: the amount (65.00) does not equal quantity × rate (2 × 65 = 130.00)." /
  "Line 1: this line has an amount but no item. Please choose an item." /
  "Line 1: the item X has no income account. Edit the item and choose one."
- `accountId`, `arApAccountId`, `taxItemId`, `termsId`, `classId`... "The selected list entry
  no longer exists."; length limits on `refNumber` (20), `memo` (4095), `poNumber` (25),
  `fob` (100), addresses (1000).
- `409 confirm` questions (section 5), `403 closing_date` (section 5.2).
- Body not JSON: `400 "The request is not valid JSON."`.

### 4.2 GET /txns/{id}

Full transaction with lines, own links (with descriptions) and `linked` history.
Missing id: `404 not_found "Transaction 999999 was not found. It may have been deleted."`;
non-numeric id: `400 "invalid id "abc""`.

### 4.3 PUT /txns/{id}: change

The body REPLACES the transaction. Rules:
- Send the whole object (best: GET it, change what you need, PUT it back). Omitted
  fields become empty: an omitted `date` gives a date error, omitted `lines` gives "You
  cannot record a blank transaction", and omitted `links` on a payment or credit memo
  silently REMOVES all its applications (the invoices become open again).
- Exceptions: omitted `extra` keeps the stored `extra`; blank `type` keeps the type.
- `type` cannot change: `400 field=type "The type of an existing transaction cannot be changed."`.
- Lines with their stored `id` are updated in place; lines without `id` are added;
  stored lines not sent are deleted.
- Optional version check: if the body has `updatedAt` and it differs from the stored one,
  the save is refused with `409 conflict "Someone else changed this transaction after you
  opened it. Close it and open it again to see their changes."`. Without `updatedAt` there
  is no check. Always send the `updatedAt` you read so you do not overwrite a newer change.
- Amounts are recomputed (percent lines follow a changed subtotal, tax, totals).
- An existing sales form keeps the tax rate it was saved with as long as `taxItemId` does
  not change (changing the tax item's rate later does not change old invoices; verified).
- Changing the customer of an invoice, statement charge, credit memo or payment that has
  payments or credits of another customer applied is refused ("... is applied to this
  invoice. Remove it first, or keep the same customer."); moving it to another job of the
  same customer is allowed.
- Lowering an invoice below what is already paid is refused: "Payments and credits of
  680.00 are applied to this transaction, which is more than its new total of 85.00.
  Remove or reduce them first."
- Voided transactions can still be saved (memo etc.) but stay voided with zero amounts.
- Response: the full saved transaction (new `updatedAt`).

### 4.4 DELETE /txns/{id}

Removes the transaction and everything it posted. Response `204` (empty body). Optional
version check: header `If-Match: <updatedAt>` or `?updatedAt=<updatedAt>` (409 conflict
when stale). Accepts `?accept=` / `?force=1` and the closing date header like saves.
Transaction ids are never reused (the next new transaction gets a higher id).

### 4.5 POST /txns/{id}/void

Body `{}` (or none). Keeps the transaction but zeroes every amount, removes its ledger
entries and its own links, and prefixes the memo with `VOID: `. Voiding an already voided
transaction does nothing. Same version check (`If-Match` or `?updatedAt=`), questions and
closing date rules as DELETE. Response: the voided transaction.

```
POST /txns/1654/void  {}
-> {"id":1654,"type":"INV","refNumber":"1264","amount":0,"openBalance":0,"voided":true,
    "memo":"VOID:","status":"Open","lines":[{"amount":0,...}],...}
```
Note: a voided invoice or statement charge still shows `status` "Open"; check `voided`.

### 4.6 GET /txns/{id}/remove-check?verb=void|delete

Dry run: returns the first Yes/No question that void or delete would ask, without changing
anything. `{}` when there is none, else `{"question": "...", "warning": "<kind>"}`.
The closing date is not checked here. Real example:
```
GET /txns/1609/remove-check?verb=void
-> {"question":"Payment #7790 ($680.00) is applied to this invoice. Voiding the invoice turns
    that amount into a $680.00 credit for Coastal Credit Union. Void anyway?","warning":"applied"}
```
A removal that is not allowed at all returns the error instead, e.g. for a refunded credit:
`400 "This credit memo was refunded by refund (check 2284) ($54.54). Delete or void the refund first."`.
`verb` missing: `400 "verb must be void or delete."`.

### 4.7 GET /txns: list and search

Returns `{"rows": [TxnSummary...], "total": <count of all matches>}`.
TxnSummary: `id, type, typeLabel, refNumber, date, dueDate, nameId, nameFull, accountId,
accountName, amount, openBalance, memo, status, voided, isPending, toBePrinted`.

| Query parameter | Meaning |
|---|---|
| `types` | Comma list of type codes (`INV,PMT`). Unknown code: 400. |
| `nameId` | Customer/vendor id. Add `includeJobs=1` for its jobs too. Journal entries with that name on a line are included. |
| `accountId` | Account and its subaccounts: header account, A/R account, transfer account, or any ledger entry or line in it. |
| `itemId` | Transactions with a line of that item (or that header tax item). |
| `from`, `to` | Date range, inclusive (`YYYY-MM-DD`). |
| `q` | Text search in number, memo, name, P.O. number and line descriptions; when it is a number, also an exact amount (`q=235.99`). |
| `ref` | Exact number (case-insensitive). |
| `memo` | Memo contains. |
| `amountMin`, `amountMax` | On the absolute amount. |
| `openOnly=1` | Still open: unpaid INV/STMTCHG, unused CREDMEM/PMT credits (and vendor docs), estimates Pending/Accepted, open POs. Voided excluded. |
| `status` | `open`, `paid` (displayed status, voided excluded), `pending` (pending INV/SALESRCPT and estimates with status Pending), `voided`, or a stored status such as `Accepted`, `Rejected`, `Closed`. |
| `sort` | `date` (default), `ref`, `name`, `amount`, `type`, `due`, `open`; prefix `-` for descending (`-date`). |
| `limit`, `offset` | Default 200 rows, maximum 10000. |

```
GET /txns?types=INV,PMT&nameId=22&includeJobs=1&sort=-date&limit=3
-> {"total":32,"rows":[
 {"id":1622,"type":"INV","typeLabel":"Invoice","refNumber":"1259","date":"2026-10-17",
  "dueDate":"2026-10-17","nameId":22,"nameFull":"Abbott, Rachel","accountId":4,
  "accountName":"Accounts Receivable","amount":2200.16,"openBalance":2200.16,"memo":"",
  "status":"Open","voided":false,"isPending":false,"toBePrinted":false}, ...]}
```
`openBalance` in this list is 0 for estimates; use `GET /open-estimates` for their amount.
Screens: Customer Center (Customers > Customer Center, Ctrl+J) transaction tabs use this route.

### 4.8 GET /txns/{id}/adjacent?dir=prev|next and GET /txns-last?type=X

Previous/next transaction of the same type by (date, id): `{"id": 1623}` or `{"id": null}`
at the end. `dir` other than prev/next: 400. `GET /txns-last?type=INV` gives the most
recent one: `{"id": 1651}`. These drive the Previous/Next buttons of the forms.

### 4.9 GET /next-ref?type=X[&accountId=N]

The number the server would give a new transaction: `{"refNumber":"1263"}`.
- INV, SALESRCPT, CREDMEM, EST, PURCHORD (and GENJRNL when auto-numbering is on): next number.
- CHK, BILLPMT, REFUND, TAXPMT with `accountId` of a bank account: next check number of
  that account (largest all-digit check number + 1). Without `accountId`, or for a
  non-bank account: "".
- Other types (PMT, STMTCHG, DEP...): "".
The number is not reserved: another save can take it first.

---

## 5. Questions, closing date, stale copies

### 5.1 Yes/No questions (409 confirm)
Some saves need a Yes/No answer. The server answers `409` with
`{"code":"confirm","error":"<question>","warning":"<kind>"}`. Ask the user the question
(quote it). Only if the user says yes, resend the same request with `?accept=<kind>`
(several: `?accept=deposited,applied`; or header `X-Accept`; with the helper script:
`--accept deposited,applied`). Do not use `?force=1` here: it answers Yes to every question,
including ones the user has not seen. Questions come one at a time, so a retry can return the
next one; ask again each time.

| Kind | When (customer side) | Real message |
|---|---|---|
| `dupnum` | Invoice number already used; refund check number already used in that bank account. | "There is another invoice # 1261. Do you want to keep this number anyway?" / "Check number 2284 has already been used in Checking. Do you want to keep this number anyway?" |
| `creditlimit` | INV or STMTCHG puts the customer (or its parent) over its credit limit. | "This transaction will put Bayfront Medical Plaza over its credit limit of 15,000.00 (new balance 15,667.23). Do you want to save it anyway?" |
| `inventory` | INV or SALESRCPT sells more than on hand (preference `warnNotEnoughInventory`). Not asked for pending invoices. | "You don't have sufficient quantity available to sell 100 of the item Plants:Japanese Maple 15 gal. The quantity on hand is 8. Do you want to continue?" |
| `inactive` | A name, account or item that is inactive is newly used. | "Quinn, Megan is inactive. Do you want to use it anyway?" |
| `deposited` | Changing the amount or deposit account of a payment or sales receipt that is on a deposit; deleting or voiding it. The deposit changes with it. | "This payment has been deposited. Changing its amount or deposit account will also change the deposit. Do you want to continue?" |
| `applied` | Deleting or voiding a document that other transactions are applied to (an invoice with a payment, a credit used by a payment). | "Payment dated 10/20/2026 ($110.00) is applied to this invoice. Deleting the invoice turns that amount into a $110.00 credit for Nakamura, Ken. Delete anyway?" |
| `reconciled` | Changing amounts or accounts of reconciled entries, or removing them (also a payment on a reconciled deposit). | "This transaction has been reconciled in Checking. Changing its amount or account will change the reconciled balance. Do you want to save it anyway?" |
| `closing` | Date on or before the closing date when no closing password is set. | "This transaction is dated on or before the closing date of 06/30/2026. Saving or changing it will change account balances for a closed period. Do you want to continue?" |

Never answer a question for the user without asking. Overselling inventory makes the
quantity on hand negative (allowed after Yes).

### 5.2 Closing date (403 closing_date)
`GET /closing-date` shows it. A transaction dated on or before the closing date (the new
date, and the old date when editing or removing), and any other transaction the change
re-posts (a deposit containing an edited payment, payments losing an invoice):
- no closing password set: question kind `closing` (5.1);
- password set: `403 {"code":"closing_date","error":"This transaction is dated on or
  before the closing date of 06/30/2026. Enter the closing date password to continue."}`.
  `?accept=closing` does not help. The app passes it with the header
  `X-Closing-Password`, but an assistant never asks for, guesses or sends this password:
  the closing date protects finished periods, and the person who knows the password makes
  such a change in SerieX themself. Tell the user that nothing was saved, why, and offer a
  later date if that is what they meant.

### 5.3 Stale copies (409 conflict)
PUT with `updatedAt`, DELETE/void with `If-Match` or `?updatedAt=`: if someone saved
the transaction since it was read, `409 conflict`. Read it again and redo the change.

---

## 6. Void versus delete

| | Void | Delete |
|---|---|---|
| Transaction stays in lists | Yes, amount 0, `voided: true`, memo starts with `VOID:` | No (gone; the audit trail keeps a copy) |
| Ledger effect | All entries removed | All entries removed |
| Its own links (a payment's applications, a credit memo's applications, a refund's credits) | Removed: the invoices or credits are open again. No question is asked. | Same |
| Links of other transactions to it (payment applied to this invoice) | Removed after question `applied`; the payment keeps the money as an unused credit (customer credit) | Same |
| On a deposit | Its deposit line is set to 0 (stays on the deposit) after question `deposited` | Its deposit line is removed after question `deposited` |
| Credits that were refunded | Refused: "This payment was refunded by refund (check 2284) ($320.00). Delete or void the refund first." | Same |
| Billable costs it billed | Become billable again | Same |
| Estimate it came from | Goes back to its status before invoicing | Same |
| Use when | The document existed but is cancelled (keeps the number in the sequence, the usual choice for invoices and checks that were printed) | It was entered by mistake |

Screens: the form toolbar (**Delete ▾** > Void, Delete; Ctrl+D deletes). The
screens call `GET /txns/{id}/remove-check` first and show the question.

---

## 7. Sales form lines

Applies to EST, INV, SALESRCPT, CREDMEM and STMTCHG (STMTCHG has no header tax).

### 7.1 Item types on sales lines (verified behavior)

| Item type | What to send | What the server does |
|---|---|---|
| Service, Non-inventory Part, Other Charge | `itemId, description, qty, rate, amount, taxable` | Credits the item's income account (else its expense account, else Uncategorized Income). |
| Inventory Part | same | Also takes the quantity out of inventory: Dr Cost of Goods Sold, Cr Inventory Asset at average cost (`cogs` on the line). On a credit memo the quantity comes back. |
| Subtotal | `{"itemId": <subtotal item>}` | Amount = sum of the lines above since the previous Subtotal. Not taxable, no posting. |
| Discount | percent: `rateIsPercent: true, rate: 10` (amount computed); fixed: negative `rate`/`amount` | Percent = round(previous line amount × rate / 100), made negative. Put it right after a Subtotal line to discount several lines. Dr the discount item's account (Sales Discounts). Taxable only if `taxable: true`. |
| Other Charge with percent | `rateIsPercent: true, rate` | Percent of the previous line, positive. |
| Group | `{"itemId": <group>, "qty": 2, "taxable": true}` | Replaced by its member lines: quantity = member qty × line qty, rate = member's sales price, description = member's description, taxable = member taxable AND line taxable, class and service date copied. Amounts sent for the group line are ignored. |
| Payment | negative `amount` (e.g. a deposit received with the order) | Reduces the total. Dr the item's deposit account, or Undeposited Funds when it has none; then it can be deposited (section 15). Not allowed on statement charges. |
| Sales Tax Item / Group as a line | `rate`, `amount` | Not computed: the amount is taken as sent, `rateIsPercent` is reset to false, it is counted in `subtotal`, and it is credited to Sales Tax Payable for that item's agency. Prefer the header `taxItemId`. |
| No item, with `accountId` | `accountId, description, amount` | Credits that account (used for billable expenses, section 16). |
| No item, description only | `description` | Kept as a text line, no amount. |

A line with nothing in it (no item, account, amount, description or quantity) is dropped.

### 7.2 Sales tax and totals (server rules)
1. Subtotal and percent lines are computed first (7.1).
2. Taxable base = sum of lines with `taxable: true` (Subtotal, Payment and sales tax item
   lines excluded).
3. `taxRate` = rate of `taxItemId` (a group: sum of its members). `taxAmount` =
   round(base × rate / 100). No tax when `salesTaxEnabled` is off or `taxItemId` is null.
4. `subtotal` = sum of all lines except Subtotal and Payment lines.
5. `amount` = subtotal + taxAmount + Payment lines (negative).
6. Posting of a group's tax: each member gets round(base × member rate / 100), the last
   member takes the rounding difference; each part is credited to Sales Tax Payable with
   the member's tax agency as the name. Example: base 45, group 7.75% (6.25% + 1.5%):
   tax 3.49 = 2.81 + 0.68.

Lines are not taxable unless you say so. For a non-taxable customer send
`taxable: false` on every line (the server ignores the customer's tax setting).

---

## 8. Estimates (EST)

Screen: Customers > Create Estimates (hidden when estimates are turned off in
preferences). No accounting effect: no ledger entries, no open balance.

Fields: like an invoice (`nameId` required, `lines` required, `taxItemId`, `termsId`,
`repId`, `poNumber`, `memo`, `customerMessageId`, addresses) plus `status`:
`Pending` (default), `Accepted`, `Closed`, `Rejected`. `accountId` is always null.

```
POST /txns
{"type":"EST","date":"2026-10-20","nameId":40,"taxItemId":3,"repId":38,"poNumber":"GD-7",
 "memo":"Garden design estimate",
 "lines":[{"itemId":4,"description":"Design hours","qty":10,"rate":85,"amount":850},
          {"itemId":13,"description":"Japanese Maple","qty":2,"rate":169,"amount":338,"taxable":true}]}
-> {"id":1658,"type":"EST","refNumber":"563","status":"Pending","amount":1214.2,
    "subtotal":1188,"taxAmount":26.2,"accountId":null,"openBalance":0,...}
```

Turning an estimate into an invoice (what the screen's "Create invoice" button does):
create an INV whose lines copy the estimate lines with `linkedTxnId` = estimate id and
`linkedLineId` = estimate line id (you may change quantities or drop lines). Then:
- the estimate becomes `Closed` while any non-voided invoice uses it, and its previous
  status is kept in `extra.statusBeforeInvoice`;
- it leaves `GET /open-estimates`;
- deleting or voiding that invoice puts the estimate back to its previous status
  (verified: Closed → Pending, `extra` cleared);
- the estimate's `linked` shows the invoice (`relation: "invoice"`) and the invoice's
  `linked` shows the estimate (`relation: "estimate"`).
The screens ask before invoicing an estimate that was already invoiced or closed; the
server does not stop it.

Void or delete an estimate freely (no accounting effect). An estimate with status
`Rejected` cannot be invoiced from the screen (the button is off).

---

## 9. Invoices (INV)

Screen: Customers > Create Invoices (Ctrl+I). Toolbar extras: Receive payment, Create
credit memo, Add time/costs, Apply credits, Mark as pending, Print.

### 9.1 Fields
Required: `type`, `date`, `nameId` (customer or job), at least one line. Usually also:
`termsId`, `dueDate` (or blank to compute), `taxItemId`, `classId`, `repId`, `poNumber`,
`billAddress`, `shipAddress`, `shipDate`, `shipViaId`, `fob`, `customerMessageId`, `memo`,
`template`, `toBePrinted`, `toBeEmailed`, `isPending`. `accountId` defaults to the A/R
account (must be an Accounts Receivable account).

### 9.2 Due date
Blank `dueDate` = computed from `termsId`:
- standard terms: date + `netDays` (Net 30 → +30 days; "2% 10 Net 30" → +30);
- date-driven terms: day `dueDay` of the month, or of next month when the invoice date is
  past that day or within `dueNextMonthDays` of it;
- no terms: the invoice date.
A `dueDate` you send is kept as is. Terms are NOT taken from the customer by the server.

### 9.3 Accounting effect (verified, invoice 1649 above)
```
Accounts Receivable                       Dr 235.99   (customer or job)
Landscaping Services:Installation Services        Cr 130
Landscaping Services:Materials Sales              Cr 45
Cost of Goods Sold                        Dr 21.86     (inventory part)
Inventory Asset                                   Cr 21.86
Sales Discounts                           Dr 17.5      (discount line)
Delivery Income                                   Cr 75
Sales Tax Payable                                 Cr 2.81  (State Department of Revenue)
Sales Tax Payable                                 Cr 0.68  (State Department of Revenue)
```
Customer balance and A/R go up by the total; income is recorded on the invoice date
(accrual).

### 9.4 Pending invoices
`isPending: true`: saved without any ledger effect, `openBalance` 0, status `Pending`,
not in open documents, no inventory or credit limit question. Listed by
`GET /txns?status=pending` and the Pending Sales report. Saving it again with
`isPending: false` posts it (the questions are asked then).

### 9.5 Status and paid
`status` is `Open` until `openBalance` is 0, then `Paid` (`Pending` when pending). The
open balance falls as payments and credits are applied (sections 12, 13).

### 9.6 Printing flag
`toBePrinted: true` lists it in `GET /to-print?kind=invoices` (File > Print Forms >
Invoices). After printing, `POST /mark-printed {"txnIds":[...]}` clears the flag (invoice
numbers do not change).

---

## 10. Sales receipts (SALESRCPT)

Screen: Customers > Enter Sales Receipts. A sale paid at once.

Fields: like an invoice without terms/due date. `nameId` is optional (a walk-in sale;
the sample also has a "Cash Sales" customer). `accountId` = deposit to: default
Undeposited Funds (3.6); may be a Bank or Other Current Asset account (an A/R account is
refused: "Please choose the account to deposit this sale to."). `paymentMethodId`, and the
customer's check number in `extra.checkNumber` (shown by `GET /undeposited` as
`checkNumber`). Number: own sequence (`refNumber` blank → next).

```
POST /txns
{"type":"SALESRCPT","date":"2026-10-20","taxItemId":3,"paymentMethodId":10,"extra":{"checkNumber":"5512"},
 "lines":[{"itemId":14,"description":"Lavender","qty":4,"rate":9.95,"amount":39.8,"taxable":true}]}
-> {"id":1668,"refNumber":"3095","nameId":null,"amount":42.88,"taxAmount":3.08,"accountId":5,"openBalance":0,...}
```
Effect: Dr Undeposited Funds (or the bank) 42.88; Cr Materials Sales 39.8; Dr COGS / Cr
Inventory Asset 18.04; Cr Sales Tax Payable 2.49 + 0.59. No A/R. Money in Undeposited
Funds waits for a deposit (section 15). Sales receipts can be pending like invoices.

---

## 11. Statement charges (STMTCHG)

Screen: Customers > Enter Statement Charges (the customer's A/R register with an entry
row; it reads `GET /registers/{arAccountId}?nameId=&includeJobs=1`). A charge added to the
customer's account and billed later on a statement (monthly fee, late fee).

Fields: `nameId` (required), `date`, `lines` (the screen sends one line: item, qty, rate,
amount, description, class), `termsId` / `dueDate` (blank due date is computed from
`termsId`, else equals the date), `classId`, `refNumber` (not automatic). No sales tax:
`taxItemId` is cleared and no tax is computed even with taxable lines. Payment items are
refused ("Line 1: payment items cannot be used on statement charges.").

```
POST /txns
{"type":"STMTCHG","date":"2026-10-20","nameId":31,"termsId":5,
 "lines":[{"itemId":7,"description":"October maintenance visit","qty":2,"rate":55,"amount":110}]}
-> {"id":1670,"refNumber":"","amount":110,"taxItemId":null,"taxAmount":0,"dueDate":"2026-11-04",
    "status":"Open","openBalance":110,"accountId":4,...}
```
Effect: Dr Accounts Receivable 110 (customer or job), Cr the item's income account 110.
Paid with Receive Payments like an invoice. Note: an inventory part on a statement charge
DOES reduce inventory and post cost of goods sold (verified), although the screen says
otherwise.

---

## 12. Receive payments (PMT)

Screen: Customers > Receive Payments (also the invoice's "Receive payment" button).

### 12.1 Fields
| Field | Notes |
|---|---|
| `nameId` | Required: the customer (or job) who paid. |
| `date` | Required. |
| `amount` | Required, not negative: the money received. |
| `refNumber` | Customer's check number (or reference). Not automatic. |
| `paymentMethodId` | Check, Cash, Visa... |
| `accountId` | Deposit to: default Undeposited Funds (3.6); or a Bank / Other Current Asset account to record it straight in the bank (it will then not appear in Make Deposits). |
| `arApAccountId` | A/R account; default the A/R account. Only matters with several A/R accounts: every applied document must be in it ("Invoice #... is in X. Choose that A/R account for this payment."). |
| `memo`, `classId` | |
| `links` | Applications, see below. `lines` are ignored. |

Links:
- pay an invoice / statement charge (or A/R journal debit):
  `{"toTxnId": <invoice>, "amount": 692.12, "discount": 14.12, "discountAccountId": 50}`
  (`discount` and `discountAccountId` optional);
- use an existing credit on an invoice through this payment:
  `{"fromTxnId": <credit memo, older unused payment or A/R journal credit>, "toTxnId": <invoice>, "amount": 25}`
  (no discount allowed on a credit).

The server never applies a payment by itself: without links the whole payment is an
unused credit. Use `GET /open-docs?nameId=<customer>&includeJobs=1&date=<payment date>`
(section 17.1) to list what is open and the suggested early-payment discount.

### 12.2 Rules (validation messages)
- Sum of own link amounts ≤ `amount`: "The total amount applied (200.00) is more than the payment amount (100.00)."
- Per document, amount + discount + credits ≤ its open balance: "The amount applied to invoice #1228 (4,000.00) is more than its open balance (3,759.31)."
- Documents must belong to the same customer (any job of the same top customer is fine): "Invoice #1258 belongs to a different customer."
- Only invoices and statement charges (and A/R journal debits), not voided or pending: "Invoice #... cannot be paid or credited by this transaction."
- Credits: same customer, enough left: "The credit used from ... (x) is more than the credit available (y)."; "A discount cannot be taken on a credit."
- Discount needs an account (default preference `customerDiscountAccountId`): "Please choose a discount account for the discount on invoice #...".
- Negative amount: "The payment amount cannot be negative."
- Deleted document id in `toTxnId`: "A transaction you applied this to no longer exists."
- A $0 payment with no links is accepted (it records nothing useful; avoid it).

### 12.3 Example with an early-payment discount (verified)
Invoice 1660 for Coastal Credit Union, terms "2% 10 Net 30", dated 2026-10-15, total 706.24.
```
GET /open-docs?nameId=63&date=2026-10-20
-> {"charges":[{"txnId":1660,"type":"INV","refNumber":"1265","date":"2026-10-15","dueDate":"2026-11-14",
     "amount":706.24,"openBalance":706.24,"termsId":2,"discountDate":"2026-10-25","suggestedDiscount":14.12,
     "arApAccountId":4,...}], "credits":[...]}

POST /txns
{"type":"PMT","date":"2026-10-20","nameId":63,"amount":692.12,"paymentMethodId":10,"refNumber":"7781",
 "links":[{"toTxnId":1660,"amount":692.12,"discount":14.12}]}
-> {"id":1661,"refNumber":"7781","amount":692.12,"openBalance":0,"accountId":5,"arApAccountId":4,
    "links":[{"fromTxnId":1661,"toTxnId":1660,"amount":692.12,"discount":14.12,"discountAccountId":50,...}]}
```
Effect:
```
Undeposited Funds     Dr 692.12
Sales Discounts       Dr  14.12
Accounts Receivable          Cr 706.24   (Coastal Credit Union)
```
The invoice becomes `Paid` (open balance 0). After the discount date
`suggestedDiscount` is 0 (you may still send a discount; the user decides).

### 12.4 Overpayment and underpayment
- Overpayment: the part not applied stays on the payment as a credit (`openBalance` of the
  payment; listed in `credits` of `GET /open-docs`). Example: payment 1000 applied 680 to
  invoice 1609 → payment `openBalance` 320. Use it later on another invoice (12.5), or give
  it back with a refund (section 14). Effect: A/R is credited the full 1000, so the
  customer's balance shows the 320 credit.
- Underpayment: apply less than the open balance; the invoice stays open for the rest. To
  write the rest off, add it as `discount` on that link (the screen's "Write off the extra
  amount" does exactly that, with the chosen account).

### 12.5 Using an unused payment (or credit memo) on an invoice later
Either (a) PUT the payment with an extra own link `{"toTxnId": <invoice>, "amount": 320}`
(the "Apply credits" button of the invoice does this: it re-saves the credit), or (b) post a
new PMT with `amount: 0` and a credit link `{"fromTxnId": <old payment>, "toTxnId": <invoice>, "amount": 320}`.
Both have no new ledger effect for the same customer.

### 12.6 Parent customer paying job invoices
A payment from "Abbott, Rachel" applied to an invoice of "Abbott, Rachel:Spring Cleanup"
(510) and one of "Abbott, Rachel" (290) credits A/R separately for each name (verified):
```
Undeposited Funds   Dr 800   Abbott, Rachel
Accounts Receivable        Cr 510  Abbott, Rachel:Spring Cleanup
Accounts Receivable        Cr 290  Abbott, Rachel
```
Use `includeJobs=1` in `GET /open-docs` to see the jobs' invoices.

### 12.7 Changing or removing a payment
- Change applications: GET the payment, replace `links`, PUT it back (keep `updatedAt`).
  `GET /open-docs?...&excludeTxnId=<payment>` shows open balances as if this payment did
  not exist (what the screen uses while editing).
- PUT without `links` removes every application (the invoices reopen). Always send them.
- Changing the amount or deposit account of a deposited payment asks `deposited` and
  changes the deposit total too. A memo change does not ask.
- Deleting or voiding a payment reopens the invoices it paid (and drops its discounts)
  without a question; if it is on a deposit, the question `deposited` comes first.
  A payment that was refunded cannot be removed until the refund is removed.

---

## 13. Credit memos (CREDMEM) and applying credits

Screen: Customers > Create Credit Memos/Refunds. After saving a new credit memo the
screen offers: keep it as a credit, give a refund, or apply it to invoices.

Fields: like an invoice without terms or due date (`nameId` and lines required,
`taxItemId`, `classId`, `memo`, `customerMessageId`, addresses). `accountId` = A/R
account. Number: own sequence. Optional `links` to apply it right away.

```
POST /txns
{"type":"CREDMEM","date":"2026-10-20","nameId":33,"taxItemId":3,"memo":"Returned roses",
 "lines":[{"itemId":15,"description":"Rose bush returned","qty":2,"rate":29.95,"amount":59.9,"taxable":true},
          {"itemId":7,"description":"Service credit","qty":1,"rate":40,"amount":40}]}
-> {"id":1665,"refNumber":"4004","amount":104.54,"taxAmount":4.64,"openBalance":104.54,"accountId":4,...}
```
Effect (the mirror of an invoice):
```
Accounts Receivable                        Cr 104.54  (Garcia, Elena)
Landscaping Services:Materials Sales  Dr 59.9
Inventory Asset                       Dr 28.03        (2 roses back on hand, at average cost)
Cost of Goods Sold                         Cr 28.03
Landscaping Services:Maintenance Services Dr 40
Sales Tax Payable                     Dr 3.74 + 0.9   (tax given back)
```

Apply it to an invoice: PUT the credit memo with
`"links":[{"toTxnId":1615,"amount":50}]` (verified: credit memo `openBalance` 104.54 → 54.54,
invoice open balance down by 50), or use it inside a payment as a credit link
(`fromTxnId` = credit memo, 12.5). Rules: total applied ≤ credit memo total ("The total
amount applied (200.00) is more than the credit memo total (104.54)."), same customer,
same A/R account, open invoices or statement charges only.

Applying a credit has no ledger effect when the credit and the invoice have the same
name. When a job's credit pays an invoice of another job (or the parent) of the same
customer, A/R is moved between the two names:
```
Accounts Receivable  Dr 55  Abbott, Rachel:Backyard Patio
Accounts Receivable         Cr 55  Abbott, Rachel
```

A/R journal entries: a GENJRNL with exactly one A/R line crediting a customer is a credit
like a credit memo (it appears in `credits` of `GET /open-docs`, can be applied through a
payment credit link, or applied itself through its own `links`); one with an A/R debit is a
charge that payments can pay (verified).

Voiding or deleting a credit memo removes its applications (the invoices reopen) without a
question; if a payment used it as a credit, the question `applied` is asked; if it was
refunded, it is refused until the refund is removed.

---

## 14. Refunds (REFUND)

Screen: the "Refund" window: opened from a credit memo ("Use credit to give
refund"), from Receive Payments (overpayment, "Refund the amount to the customer"), the
"+ New" panel (Refund) or the global search ("Issue a refund"). It pays a customer back
by check, cash or credit card from a credit memo or an unused payment.

| Field | Notes |
|---|---|
| `nameId` | Required: the customer. |
| `accountId` | Required: Bank or Credit Card account the money comes from (Undeposited Funds or A/R is refused: "Please choose the bank or credit card account the refund is issued from."). |
| `links` | Required: the credits refunded, `{"toTxnId": <credit memo, payment or A/R journal credit>, "amount": x}`. |
| `amount` | Optional: 0 = total of the links; otherwise must equal it ("The refund amount (300.00) must equal the total of the credits refunded (320.00)."). |
| `refNumber` | Check number (from a bank). Not automatic: `GET /next-ref?type=REFUND&accountId=1`, or `toBePrinted: true` and `POST /mark-printed`. |
| `toBePrinted` | Check to print: listed by `GET /to-print?kind=checks`. |
| `billAddress` | Payee address printed on the check. |
| `extra.via` | Screen only: `check`, `cash`, `card`. |
| `memo`, `classId`, `arApAccountId` | |

```
POST /txns
{"type":"REFUND","date":"2026-10-20","nameId":63,"accountId":1,"refNumber":"2284",
 "memo":"Refund of overpayment","links":[{"toTxnId":1662,"amount":320}]}
-> {"id":1664,"type":"REFUND","refNumber":"2284","amount":320,"accountId":1,"arApAccountId":4,"openBalance":0,
    "links":[{"fromTxnId":1664,"toTxnId":1662,"amount":320,...,"toType":"PMT","toRefNumber":"7790"}]}
```
Effect: Checking Cr 320; Accounts Receivable Dr 320 (Coastal Credit Union). The credit's
open balance goes to 0. A refund from a credit card account credits that card account
(its balance goes up).

Errors: no links ("Choose the credit memo or unapplied payment this refund is for."),
linking an invoice ("Invoice #1228 cannot be paid or credited by this transaction."),
more than the credit available ("... is more than its credit available (...)"), duplicate
check number (`dupnum`). Voiding or deleting the refund gives the credit back (verified).

---

## 15. Make deposits (DEP)

Screen: Banking > Make Deposits. Payments and sales receipts recorded to Undeposited
Funds wait there; the "Payments to Deposit" dialog lists them (`GET /undeposited`,
section 17.2). Other money (interest, owner's money, a refund from a vendor) goes on the
same deposit as lines without a link. Cash back takes part of the deposit back in cash.

### 15.1 Fields
| Field | Notes |
|---|---|
| `accountId` | Required: Bank or Other Current Asset account, not Undeposited Funds ("You cannot deposit to Undeposited Funds. Please choose a bank account."). |
| `date`, `memo`, `classId` | |
| `lines` | At least one. Two kinds below. |
| `cashBackAccountId`, `cashBackAmount`, `cashBackMemo` | Optional cash back: amount ≥ 0, account required when amount > 0 (not A/R, A/P or non-posting). |
| `amount` | (ro) = sum of lines − cash back; cannot be negative ("The deposit total cannot be negative. Reduce the cash back amount."). |
| `refNumber` | Not automatic. |

Payment line (from Undeposited Funds):
`{"linkedTxnId": <PMT or SALESRCPT id>, "amount": <exactly its amount>}`. The server
fills `accountId` (Undeposited Funds), `nameId` (payer), `paymentMethodId` and `refNumber`
(the payment's number; for a sales receipt that is the sale number, so send `refNumber` =
`checkNumber` from `GET /undeposited` if you want the check number on the deposit).
For a payment-item line of an invoice or sales receipt add `"linkedLineId": <lineId>`.

Other line: `{"accountId": <from account>, "amount": 12.34, "description": "...",
"nameId": <optional received from>, "refNumber": "<check no>", "paymentMethodId": ...,
"classId": ...}`. The account cannot be A/R or A/P ("Line 1: you cannot use the Accounts
Receivable account ... Use a customer transaction instead.") or non-posting. To record a
customer's payment of an invoice, use Receive Payments, not a deposit line.

### 15.2 Example (verified)
```
POST /txns
{"type":"DEP","date":"2026-10-20","accountId":1,"memo":"Deposit test",
 "cashBackAccountId":3,"cashBackAmount":50,"cashBackMemo":"Petty cash",
 "lines":[{"linkedTxnId":1661,"amount":692.12},{"linkedTxnId":1662,"amount":1000},
          {"linkedTxnId":1668,"amount":42.88},
          {"accountId":47,"description":"Bank interest","amount":12.34}]}
-> {"id":1673,"amount":1697.34,"accountId":1,"cashBackAmount":50,
    "lines":[{"seq":1,"kind":"deposit","accountId":5,"nameId":63,"paymentMethodId":10,"refNumber":"7781","linkedTxnId":1661,"amount":692.12},...]}
```
Effect:
```
Checking            Dr 1697.34
Undeposited Funds          Cr 692.12  (Coastal Credit Union)
Undeposited Funds          Cr 1000    (Coastal Credit Union)
Undeposited Funds          Cr 42.88
Interest Income            Cr 12.34
Petty Cash          Dr 50             (cash back)
```

### 15.3 Errors and rules (line messages)
- Wrong amount: "Line 1: the amount must equal the payment amount (692.12)."
- Already deposited: "Line 1: payment #7781 has already been deposited."
- Payment recorded straight to a bank: "Line 1: this payment was not received into Undeposited Funds."
- Invoice or other type linked: "Line 1: this transaction has nothing waiting in Undeposited Funds."
- Voided or pending payment: "Line 1: this payment is voided or pending and cannot be deposited."
- Payment-item line: amount must equal what is waiting: "Line 1: the amount must equal the payment received on invoice #... (100.00)."

### 15.4 After depositing
- The payments leave `GET /undeposited` (use `?excludeDepositId=<deposit>` while editing
  that deposit to see them again).
- Editing a deposited payment's amount asks `deposited` and updates the deposit line and
  total. Deleting a deposited payment removes its line; voiding it sets the line to 0.
- Remove a payment from a deposit: PUT the deposit without that line (it goes back to
  Undeposited Funds). Void or delete the deposit: all its payments go back to Undeposited
  Funds (verified).
- A reconciled deposit asks `reconciled` before any of these changes.

---

## 16. Billable costs on invoices

Costs recorded on a check, bill, credit card charge or item receipt with a line that has
`billable: true` and a customer or job in the line's `nameId` can be put on an invoice
(screen: invoice toolbar "Add time/costs", or the banner "N billable costs ... are not
invoiced yet").

1. List them: `GET /billables?customerId=<customer>` (the customer and all its jobs;
   no `customerId` = every customer):
```
[{"lineId":2588,"txnId":1582,"txnType":"BILL","date":"2026-10-02","refNumber":"85-3730",
  "vendorName":"Ortega Hardscape Crew","itemId":9,"accountId":null,
  "description":"Stone wall and steps - crew of 3","qty":1,"rate":2700,"amount":2700,
  "classId":35,"nameId":35,"nameFull":"Hughes, Martin:Retaining Wall"}, ...]
```
2. Add one invoice line per cost with `linkedTxnId` = `txnId` and `linkedLineId` = `lineId`:
   - item cost: `{"itemId":9,"description":...,"qty":1,"rate":2700,"amount":2700,"linkedTxnId":1582,"linkedLineId":2588}`
   - expense cost (no item): `{"accountId":28,"description":...,"rate":400,"amount":400,"linkedTxnId":1676,"linkedLineId":2714}`
     (this is what the screen sends; any markup is up to the user: change rate/amount).
   Set `taxable` yourself (the screen uses the customer's tax setting for item costs and
   false for expense costs).
3. Save the invoice. The purchase lines get `billedTxnId` = the invoice and leave
   `/billables`. Billing the same cost again: "Line 1: this billable cost has already been
   billed on invoice #1267." Voiding or deleting the invoice makes them billable again.

Effect (verified): item costs credit the item's income account; an expense cost line with
an `accountId` credits that same expense account (here Job Expenses:Subcontractors),
which cancels the expense, while A/R goes up by the total.

`GET /names/{id}/summary` gives `unbilledCosts` for a customer (with jobs).

---

## 17. Helper queries

### 17.1 GET /open-docs
Open documents of customers (Receive Payments, Apply Credits, Refund) or vendors.

| Parameter | Meaning |
|---|---|
| `nameId` | Customer (0 or absent = everybody). |
| `includeJobs=1` | Include its jobs. |
| `kind` | `receivable` (default) or `payable` (vendor side). |
| `date` | Payment date for the early-payment discount (default today). |
| `excludeTxnId` | A payment/credit/refund being edited: computed as if it did not exist. |

Response `{"charges": [OpenDoc], "credits": [OpenDoc]}`. Receivable charges: open INV,
STMTCHG and A/R journal debits; credits: unused CREDMEM, PMT and A/R journal credits.
Voided and pending documents are left out. OpenDoc: `txnId, type, typeLabel, date,
dueDate, refNumber, nameId, nameFull, amount, openBalance, termsId, discountDate,
suggestedDiscount, memo, poNumber, arApAccountId`. `discountDate` = date + discount days
of the terms ("" when the terms have no discount); `suggestedDiscount` = round(open
balance × discount % / 100) when `date` ≤ `discountDate`, else 0. Sorted by date.

### 17.2 GET /undeposited[?excludeDepositId=N]
Payments and sales receipts in Undeposited Funds not on a (non-voided) deposit, plus
payment-item lines of invoices/sales receipts that went to Undeposited Funds:
```
[{"txnId":1625,"type":"PMT","typeLabel":"Payment","date":"2026-10-18","refNumber":"6364",
  "nameId":65,"nameFull":"Westside Office Park","paymentMethodId":10,"paymentMethodName":"Check",
  "amount":246.5,"memo":"","classId":null,"lineId":null,"checkNumber":"6364"},
 {"txnId":1684,"type":"INV","refNumber":"1271","nameFull":"Patel, Ravi","amount":100,
  "memo":"Check 4471 deposit","lineId":2727,"checkNumber":"4471",...}]
```
`lineId` not null = deposit it with `linkedTxnId` + `linkedLineId`. `checkNumber`: the
payment's number, a sales receipt's `extra.checkNumber`, or a number found in a payment
line description ("Check 4471").

### 17.3 GET /billables[?customerId=N]
See section 16.

### 17.4 GET /open-estimates?customerId=N[&includeJobs=1]
Estimates with status Pending or Accepted (not voided), as TxnSummary rows with
`openBalance` = amount. Without `includeJobs=1` only estimates of that exact name.

### 17.5 GET /statements
Screen: Customers > Create Statements. Parameters:

| Parameter | Meaning |
|---|---|
| `customerIds` | Comma list of customers (a job id gives that job's statement). Absent = every top-level customer. |
| `statementDate` | Default today. Aging and amount due are computed as of this date. |
| `mode` | `range` (default): opening balance + all A/R activity from `from` to `to`; `open`: only open documents as of the statement date. |
| `from`, `to` | Period for `range`; `to` defaults to the statement date; `from` blank = from the beginning. |
| `includeZero=1` | Also customers with nothing due and no activity (default: skipped). |

Response: array of `{customer: <full Name object with balance>, billAddress,
statementDate, from, to, openingBalance, rows: [{txnId, date, type, refNumber,
description, dueDate, amount, balance}], endingBalance, aging: {current, d1_30, d31_60,
d61_90, over90}, amountDue}`. Job transactions are described as "Job: ...". Example row:
`{"txnId":1670,"date":"2026-10-20","type":"STMTCHG","description":"Weekly Maintenance: October maintenance visit","dueDate":"2026-11-04","amount":110,"balance":1111.95}`;
payments are negative. Errors: `Invalid statement mode "bad"`, "The From date must be on
or before the To date.". Statements are read-only (nothing is saved).

### 17.6 GET /to-print and POST /mark-printed
- `GET /to-print?kind=invoices`: invoices with `toBePrinted` (not voided).
- `GET /to-print?kind=checks[&accountId=N]` (default kind): CHK, BILLPMT, REFUND, TAXPMT
  to print. Other kinds: 400 "kind must be checks or invoices".
- `POST /mark-printed {"txnIds":[...], "firstNumber":"2284"}`: clears `toBePrinted` on each
  listed transaction; check types get numbers in the given order starting at
  `firstNumber` (blank = next free check number of the account). A clash with an existing
  check number asks `dupnum`. Response `{"ok":true,"updated":1,"rows":[TxnSummary]}`.
  Empty list: 400 "Select the transactions that were printed.". Verified for a refund
  (number 2284 assigned) and an invoice (flag cleared, number unchanged).

### 17.7 GET /names/{id}/summary
History panel figures of a customer including its jobs:
`{"openBalance":4245.55,"overdue":3759.31,"unbilledCosts":0,"lastPayment":{"date":"2026-10-20","amount":900},"openEstimates":0,"openPOs":0,"creditLimit":null}`.

---

## 18. Accounting effect summary

"Dr" increases asset and expense accounts; "Cr" increases income and liability accounts.

| Transaction | Effect |
|---|---|
| Estimate | None. |
| Invoice / statement charge | A/R up (Dr) by the total for the customer or job; income accounts Cr; Sales Tax Payable Cr per tax agency; discount lines Dr their account; inventory parts: COGS Dr, Inventory Asset Cr; payment-item lines Dr Undeposited Funds. Pending invoice: none. |
| Sales receipt | Same as an invoice but the deposit account (Undeposited Funds or bank) is debited instead of A/R. |
| Credit memo | Mirror of an invoice: A/R Cr, income Dr, Sales Tax Payable Dr, inventory back (Inventory Asset Dr, COGS Cr). |
| Applying a credit memo or unused payment | None for the same name; A/R moved between names when jobs differ. |
| Payment | Deposit account (Undeposited Funds by default) Dr by the amount; discount account Dr by the discounts; A/R Cr by amount + discounts (split by each invoice's customer or job; the unapplied part under the payer). |
| Refund | Bank Cr (or credit card Cr); A/R Dr for each credit refunded. |
| Deposit | Bank Dr by the deposit total; Undeposited Funds Cr for each payment; other accounts Cr for other lines; cash back account Dr. |
| Void / delete | Removes all of the transaction's entries. |

To check the effect of one transaction: `GET /reports/journal?txnId=<id>&dates=all`
(the forms' Ctrl+Y "Transaction Journal"); rows have `cells.account`, `cells.debit`,
`cells.credit`, `cells.name`. Account balances: `GET /accounts` (`balance` of balance
sheet accounts). A/R by customer: reports `ar_aging_summary`, `customer_balance_summary`,
`open_invoices`.

---

## 19. Recipes

**Create an invoice the way the screen does**
1. `GET /names/{customerId}` for terms, rep, tax item, taxable flag, addresses (a job may
   inherit them from its parent: walk `parentId`).
2. `GET /items?active=all` for each item's `salesPrice`, `description`, `taxable`, `type`.
3. Build lines: `amount = qty × rate`; `taxable = item.taxable && customer.taxable`.
4. POST with `termsId`, blank `dueDate`, `taxItemId`, addresses, `refNumber` blank.
5. Show the user `refNumber`, `amount`, `taxAmount`, `dueDate` from the response.

**Record a customer's check for one invoice and deposit it**
1. `GET /open-docs?nameId=<c>&includeJobs=1&date=<date>`; pick the invoice; confirm the
   amount and any discount with the user.
2. `POST /txns` PMT with `amount`, `refNumber` (check no.), `paymentMethodId`, `links`.
3. Later: `GET /undeposited`, then `POST /txns` DEP to the bank with one line per payment
   (`linkedTxnId`, exact `amount`).

**Customer returns goods and wants money back**
1. CREDMEM with the returned items (inventory comes back).
2. REFUND from the bank with `links:[{"toTxnId": <credit memo>, "amount": <total>}]` and a
   check number (or `toBePrinted`).
Or apply the credit memo to an open invoice instead (PUT the credit memo with `links`).

**Invoice an accepted estimate**
GET the estimate; POST an INV copying its lines with `linkedTxnId`/`linkedLineId`; the
estimate turns Closed.

**Find unpaid invoices of a customer**
`GET /txns?types=INV,STMTCHG&nameId=<c>&includeJobs=1&openOnly=1` or `GET /open-docs`.

**Undo a mistake**
Wrong amount: GET, fix, PUT (keep `updatedAt`). Entered twice: DELETE the copy (check
`remove-check` first). Cancelled after printing: void.

---

## 20. Pitfalls checklist

- PUT replaces the whole transaction. Omitted `links` on a payment or credit memo removes
  every application without a warning; omitted `lines` or `date` is an error. GET first.
- Send `updatedAt` back on PUT (and `If-Match` on delete/void) to avoid overwriting.
- The server does not copy customer defaults (address, terms, tax item, rep, line tax
  flags) or item prices and descriptions; it trusts line amounts (checked against
  qty × rate) and the `taxable` flag of each line.
- `amount` is ignored on sales forms and deposits (computed) but required on payments.
- Payments are never applied automatically; without `links` they are unused credits.
- Statement charges have no sales tax, and they DO reduce inventory for inventory parts.
- Questions (409 confirm) must be asked to the user; resend with `?accept=<kind>`.
  A closing date password (403 closing_date) is never asked for or sent by the assistant;
  the user makes changes in a closed period in SerieX themself.
- Deleting or voiding a payment or credit memo reopens the invoices it paid without a
  question (only "deposited" or "applied by others" questions exist).
- A voided invoice still shows `status: "Open"`; look at `voided`.
- Numbers are max+1 of numeric numbers, not reserved, and can repeat after a delete.
- Unknown JSON fields are ignored silently; double-check field names (`nameId`, not
  `customerId`; `termsId`, `taxItemId`, `customerMessageId`).
- When depositing a sales receipt, send the deposit line `refNumber` = the
  `checkNumber` from `GET /undeposited` (otherwise the sale number is copied).
- Money and dates: dollars as numbers, `YYYY-MM-DD`.
