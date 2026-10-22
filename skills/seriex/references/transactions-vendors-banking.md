# SerieX Books: vendor, banking and general transactions

How to enter, read, change, void and delete purchase orders, item receipts, bills, vendor
credits, bill payments (Pay Bills), checks, credit card charges and credits, transfers,
journal entries, inventory adjustments and sales tax payments in SerieX Books, through the
local HTTP API or through the screens.

All behavior below was checked in the server code (`server/internal/ledger`) and with live
requests against the sample company "sample-harborview". Ids in examples come from that test
file: always look up real ids (`GET /accounts`, `GET /names?kind=vendor`, `GET /items`,
`GET /lists/terms`, `GET /lists/class`) before writing.

## Contents

1. [Shared rules (short reminder)](#1-shared-rules-short-reminder)
2. [Type table](#2-type-table)
3. [Purchase lines: expense lines and item lines](#3-purchase-lines-expense-lines-and-item-lines)
4. [Purchase orders (PURCHORD)](#4-purchase-orders-purchord)
5. [Item receipts (ITEMRCPT) and converting them to bills](#5-item-receipts-itemrcpt-and-converting-them-to-bills)
6. [Bills (BILL)](#6-bills-bill)
7. [Vendor credits (BILLCRED)](#7-vendor-credits-billcred)
8. [Paying bills: POST /pay-bills](#8-paying-bills-post-pay-bills)
9. [Bill payments as transactions (BILLPMT)](#9-bill-payments-as-transactions-billpmt)
10. [Checks (CHK) and printing checks](#10-checks-chk-and-printing-checks)
11. [Credit card charges and credits (CCCHARGE, CCCREDIT)](#11-credit-card-charges-and-credits-cccharge-cccredit)
12. [Transfers (TRANSFER)](#12-transfers-transfer)
13. [Journal entries (GENJRNL)](#13-journal-entries-genjrnl)
14. [Inventory adjustments (INVADJ) and average cost](#14-inventory-adjustments-invadj-and-average-cost)
15. [Sales tax: GET /sales-tax/due and payments (TAXPMT)](#15-sales-tax-get-sales-taxdue-and-payments-taxpmt)
16. [Deposits](#16-deposits)
17. [Void and delete: what happens to related records](#17-void-and-delete-what-happens-to-related-records)
18. [1099 reporting](#18-1099-reporting)
19. [Checking the effect: accounts and reports](#19-checking-the-effect-accounts-and-reports)
20. [Surprises and known issues](#20-surprises-and-known-issues)

---

## 1. Shared rules (short reminder)

The full envelope (POST/PUT `/api/c/{cid}/txns`, `GET /txns`, `GET /txns/{id}`, void, delete,
`GET /next-ref`, confirm questions, closing date) is in **transactions.md**. What matters here:

- Create: `POST /api/c/{cid}/txns` with a `Txn` JSON body. Read: `GET /txns/{id}`.
  Change: `PUT /txns/{id}`. Void: `POST /txns/{id}/void` (body `{}`). Delete: `DELETE /txns/{id}`.
  Dry run of the void/delete question: `GET /txns/{id}/remove-check?verb=void|delete` returns
  `{}` or `{question, warning}`.
- Every save returns the full saved transaction (computed fields filled in).
- Money is dollars with 2 decimals. Dates are `YYYY-MM-DD` (`MM/DD/YYYY` is also accepted).
  Optional ids are `null` when empty.
- `PUT` replaces the whole transaction: fields you leave out become empty (for example
  `classId` is cleared). Always `GET`, change, and `PUT` the full object back. Only `extra`
  is kept when the body has no `extra` key. Send back `updatedAt`; an older copy gets
  409 `conflict` ("Someone else changed this transaction...").
- Send back line `id`s of lines you keep, so links to those lines (PO lines, billable costs)
  survive the edit. Lines without an `id` are new lines; missing ones are deleted.
- Line `kind` is set by the server: you may omit it (see section 3).
- Yes/No questions come back as 409 `{"code":"confirm","warning":"<kind>"}`. Repeat the same
  request with `?accept=<kind>` only after the user agrees (not `?force=1`, which answers every question).
  Kinds seen in this area: `dupnum` (number already used), `applied` (payments/credits are
  applied to it), `inactive`, `reconciled`, `closing`.
- Header amounts (`amount`, `openBalance`, `status`) are computed for every type here except
  `BILLPMT`, `TRANSFER` and header-only `TAXPMT`, where you send `amount`.

## 2. Type table

| Code | Screen name (menu) | `nameId` | Header `accountId` (default when null) | Lines | Ledger effect |
|---|---|---|---|---|---|
| `PURCHORD` | Purchase Order (Vendors > Create Purchase Orders) | vendor, required | ignored (always null) | item lines (an account line is also allowed) | none (non-posting) |
| `ITEMRCPT` | Item Receipt (Vendors > Receive Items) | vendor, required | A/P account (A/P) | expense + item | A/P credit; inventory asset / expense debits |
| `BILL` | Bill (Vendors > Enter Bills) | vendor, required | A/P account (A/P) | expense + item | A/P credit; expense / asset debits |
| `BILLCRED` | Credit (Enter Bills, "Credit" switch) | vendor, required | A/P account (A/P) | expense + item | A/P debit; expense / asset credits |
| `BILLPMT` | Bill Pmt -Check / Bill Pmt -CCard (Vendors > Pay Bills) | vendor, required | bank or credit card (prefs `defaultBillPayAccountId`, else `defaultCheckAccountId`) | none (links to bills) | bank/card credit; A/P debit; discount credit |
| `CHK` | Check (Banking > Write Checks) | any name or none | bank only (prefs `defaultCheckAccountId`) | expense + item | bank credit; line accounts debit |
| `CCCHARGE` | Credit Card Charge (Banking > Enter Credit Card Charges) | any name or none | credit card only (no default: required) | expense + item | card credit (you owe more); line accounts debit |
| `CCCREDIT` | Credit Card Credit (same screen, "Credit") | any name or none | credit card only (required) | expense + item | card debit (you owe less); line accounts credit |
| `TRANSFER` | Transfer (Banking > Transfer Funds, window "Transfer Money") | not used (stored only) | from-account (required) + `toAccountId` | none | from-account credit, to-account debit |
| `GENJRNL` | General Journal (Company > Make General Journal Entries, window "Journal Entry") | optional header name (reports show it); A/R and A/P lines need their own name | ignored (always null) | `je` lines, + debit / - credit | exactly the lines |
| `INVADJ` | Inventory Adjust (Vendors > Inventory Activities > Adjust Quantity/Value On Hand, window "Adjust Inventory") | optional (screen offers CUSTOMER OR JOB) | adjustment account (required) | inventory part lines | inventory asset vs adjustment account |
| `TAXPMT` | Sales Tax Payment (Vendors > Sales Tax > Pay Sales Tax) | vendor (the tax agency), required | bank only (prefs `defaultCheckAccountId`) | sales tax item lines, or account lines | bank credit; Sales Tax Payable debit |
| `DEP` | Deposit (Banking > Make Deposits) | see transactions.md | | | |

Name kinds are `customer`, `vendor`, `other` (Other Names list). "Any name" means any of them.

Automatic numbers: only `PURCHORD` (and `GENJRNL` when preference `autoAssignJournalNumbers`
is on) get a number when `refNumber` is blank. Bills, credits, receipts, checks, card charges,
bill payments and tax payments stay blank unless you send a number. Get the next check number
with `GET /next-ref?type=CHK&accountId=<bank id>` (same sequence for `CHK`, `BILLPMT`,
`REFUND`, `TAXPMT` of that bank account; returns `""` for a credit card account).
Number fields hold at most 20 characters.

Feature preferences (`purchaseOrdersEnabled`, `inventoryEnabled`, `salesTaxEnabled`) only hide
menus in the screens; the API accepts these types either way.

## 3. Purchase lines: expense lines and item lines

Used by `CHK`, `BILL`, `ITEMRCPT`, `BILLCRED`, `CCCHARGE`, `CCCREDIT` (the "Expenses" and
"Items" tabs of the screens). `PURCHORD` lines follow the item rules but post nothing.

Line fields (all optional unless said):

| Field | Meaning |
|---|---|
| `accountId` | Expense line: the account (required when the line has an amount). Ignored on item lines. |
| `itemId` | Item line. A line with an item is `kind:"item"`, without one `kind:"expense"`. |
| `description` | Line memo (max 4095 characters). Blank lines (no account, item or amount) are dropped. |
| `qty`, `rate` | Item quantity and cost per unit. When both are sent, `amount` must equal `qty × rate` (tolerance about half a cent), else 400 "Line 1: the amount (7.00) does not equal quantity × rate (2 × 3.25 = 6.50)." |
| `amount` | Line amount in dollars. Must be sent (the server does not compute `qty × rate` for you). |
| `nameId` | Customer or job the cost is for (CUSTOMER OR JOB column). Must be a **customer** ("Line 1: X is not a customer or job."). |
| `billable` | `true` makes the line a billable cost for that customer or job (listed by `GET /billables?customerId=`, added to an invoice on the customer side, see transactions.md). Kept only on CHK, BILL, ITEMRCPT, CCCHARGE and only when `nameId` is set; dropped (false) on vendor credits, card credits, POs and journal entries. |
| `classId` | Class (when class tracking is used). |
| `linkedLineId` | The purchase order line this line receives (see section 4). `linkedTxnId` is filled from it. |

What each line posts (sign shown for a bill/check/charge/receipt; vendor credits and card
credits post the opposite):

- Expense line: debit `accountId`.
- Inventory Part item: debit the item's asset account (Inventory Asset) and add
  `qty` units to stock at this cost. **A line with no `qty` counts as 1 unit.**
- Non-inventory Part, Service, Other Charge: debit the item's expense account
  (or its income account when it has no expense account).
- Group item: replaced by its member lines (quantity × group quantity, rate = member cost,
  purchase description).
- Subtotal item: no posting (total of the lines above it).
- Not allowed: Payment items and Sales Tax Group items ("Line 1: Sales Tax Group items cannot
  be used on purchase forms."). A Sales Tax Item is refused too unless it has an expense
  account ("the item Harbor County has no expense account"); pay sales tax with `TAXPMT`.
- An item (other than an inventory part) without an expense or income account is refused:
  "Line 1: the item X has no expense account. Edit the item and choose one."
- Lines may not use Accounts Receivable, Accounts Payable or Non-Posting accounts:
  "Line 1: you cannot use the Accounts Payable account Accounts Payable on this line. Use a
  vendor transaction instead."
- The ledger entry of a line carries the line's `nameId` (customer or job), or the header payee
  when the line has none. The header entry carries the payee.

Totals: `amount` = sum of line amounts (Subtotal lines excluded). A negative total is refused
("A bill cannot have a negative total. Enter a vendor credit instead.", "A check cannot have a
negative amount. Record a deposit instead.", and so on). A transaction with no lines is refused
("You cannot record a blank transaction. Please enter at least one line.").

Edits keep the accounts that existing lines were posted to: if an item's accounts change later,
unchanged lines of old transactions keep posting to the old accounts.

## 4. Purchase orders (PURCHORD)

Screen: Vendors > Create Purchase Orders. Saved POs have "Receive items" and "Create bill"
buttons. Open POs also show in Vendors > Money Out.

A PO records what was ordered. It posts nothing to the books (no effect on balances or reports
other than the Open Purchase Orders reports).

Request fields:

| Field | Notes |
|---|---|
| `type` | `"PURCHORD"` |
| `date` | required |
| `nameId` | vendor, required |
| `refNumber` | blank = next PO number (largest numeric PO number + 1; a deleted last number is reused). Duplicate number asks `dupnum` when preference `warnDuplicatePONumbers` is on. |
| `classId`, `memo`, `billAddress` (vendor address text), `shipAddress` | optional |
| `status` | `"Open"` or `"Closed"`. Sending `"Closed"` closes every line ("closed by hand"); sending `"Open"` on a closed PO reopens every line. Otherwise the server sets it. |
| `extra.vendorMessage`, `extra.shipToNameId` | used by the screen (message printed on the PO, ship-to name) |
| `lines[]` | `itemId`, `description`, `qty`, `rate`, `amount` (= qty × rate), optional `nameId` (customer), `classId`, `closed` (true = nothing more expected on this line). `billable` is dropped on POs. |

Read-only on lines: `receivedQty` (quantity received so far by receipts, bills, checks and card
charges that link to the line; a linked line without qty counts as 1).

Status is computed after every save that touches the PO: `"Open"` while some item line is not
closed and not fully received, `"Closed"` when every line is received or closed.
Over-receiving is allowed without any warning (receivedQty can exceed qty).

Example (verified):

```
POST /api/c/sample-harborview/txns
{"type":"PURCHORD","date":"2026-10-20","nameId":4,"classId":36,"memo":"Test PO","lines":[
 {"itemId":25,"description":"Sprinkler head","qty":100,"rate":3.25,"amount":325},
 {"itemId":27,"description":"Timer","qty":5,"rate":48,"amount":240},
 {"itemId":30,"description":"Fertilizer for Abbott patio","qty":2,"rate":15,"amount":30,"nameId":23}]}
-> {"id":1649,"type":"PURCHORD","refNumber":"6041","amount":595,"openBalance":0,"status":"Open",
    "accountId":null,"lines":[{"id":2687,"kind":"item","qty":100,"receivedQty":0,"closed":false,...},...]}
```

`openBalance` of a PO read with `GET /txns/{id}` is always 0. Use `GET /open-pos`.

### GET /open-pos

`GET /api/c/{cid}/open-pos?vendorId=<id>` (vendorId optional) lists open, non-voided POs as
transaction summary rows. Here `openBalance` = value not received yet:
for each line not closed, (qty − receivedQty) × rate.

```
GET /open-pos?vendorId=4
-> [{"id":1649,"type":"PURCHORD","typeLabel":"Purchase Order","refNumber":"6041","date":"2026-10-20",
     "nameId":4,"nameFull":"AquaFlow Irrigation Supply","amount":595,"openBalance":130,"status":"Open",...}]
```

### Receiving against a PO

There is no special endpoint. Create an item receipt (section 5), or a bill, check or credit
card charge, whose item lines carry `linkedLineId` = the PO line `id` (from `GET /txns/{poId}`).
The screen fills, for every PO line not closed, `qty` = qty − receivedQty, the same `rate`,
`description`, `nameId` (with `billable: true` when there is a customer) and the PO class.
The server fills `linkedTxnId` and updates `receivedQty` and the PO status. Deleting or voiding
the receiving transaction gives the quantity back to the PO (verified).

Deleting a PO that was received against silently removes the link from the bills/receipts
(their lines keep their amounts). Voiding a PO zeroes its lines and keeps the links.

## 5. Item receipts (ITEMRCPT) and converting them to bills

Screens: Vendors > Receive Items (the Enter Bills form with "Bill received" unchecked);
Vendors > Receive Items and Enter Bill (a bill that receives POs);
Vendors > Enter Bill for Received Items (pick a receipt; the form opens with "Bill received"
checked).

An item receipt records goods that arrived before the bill. It posts like a bill
(Inventory Asset or expense up, Accounts Payable up), so it is included in the A/P balance,
vendor balances, A/P aging and Unpaid Bills Detail (shown as type "Item Receipt").
It has no terms and no due date, its `openBalance` always equals its `amount`, and it
**cannot be paid** (Pay Bills answers "Bill 1651 was not found."). Convert it to a bill first.

Fields: as a bill (section 6) without terms/due date. `memo` blank becomes
"Received items (bill to follow)" on a new receipt. `refNumber` stays blank unless sent.

```
POST /txns
{"type":"ITEMRCPT","date":"2026-10-20","nameId":4,"lines":[
 {"itemId":25,"description":"Sprinkler head","qty":60,"rate":3.25,"amount":195,"linkedLineId":2687},
 {"itemId":27,"description":"Timer","qty":5,"rate":48,"amount":240,"linkedLineId":2688},
 {"itemId":30,"description":"Fertilizer for Abbott patio","qty":2,"rate":15,"amount":30,"nameId":23,"billable":true,"linkedLineId":2689}]}
-> {"id":1651,"type":"ITEMRCPT","amount":465,"openBalance":465,"accountId":10,
    "memo":"Received items (bill to follow)","linked":[{"txnId":1649,"relation":"purchase order",...}],...}
Ledger: Accounts Payable credit 465; Inventory Asset debit 195 and 240; Job Expenses:Job Materials debit 30 (Abbott job).
```

### GET /item-receipts

`GET /item-receipts?vendorId=<id>` (vendorId optional): item receipts not converted and not
voided, as summary rows.

### POST /txns/{id}/convert-to-bill

Turns the item receipt into a bill **with the same id** (lines, links to the PO and billable
flags are kept; inventory and ledger are re-posted on the new date).

Body (all optional; an empty body or `{}` is fine):

| Field | Meaning |
|---|---|
| `date` | bill date (default: keep the receipt date) |
| `dueDate` | due date; blank = computed from terms (or `billsDueDays`) |
| `refNumber` | the vendor's bill number |
| `termsId` | terms id; `0` clears |
| `memo` | memo; when not sent, the default receipt memo is removed |

```
POST /txns/1651/convert-to-bill
{"date":"2026-10-21","refNumber":"AQ-5521","termsId":2}
-> {"id":1651,"type":"BILL","refNumber":"AQ-5521","date":"2026-10-21","dueDate":"2026-11-20","termsId":2,
    "amount":465,"openBalance":465,"status":"Open","memo":"",...}
```

Errors: 400 "Only item receipts can be converted to a bill." (any other type). Accepts
`?accept=dupnum` like a save. A `PUT /txns/{id}` with `"type":"BILL"` on an item receipt does the
same (that is what the screen does). Any other type change, including bill back to receipt,
is refused: "The type of an existing transaction cannot be changed."

## 6. Bills (BILL)

Screen: Vendors > Enter Bills (Bill/Credit switch, Expenses and Items tabs, "Select PO",
"Pay bill"). Also from Vendor Center.

Request fields:

| Field | Required | Notes |
|---|---|---|
| `type` | yes | `"BILL"` |
| `date` | yes | |
| `nameId` | yes | a vendor ("Please choose a vendor for this transaction.", "Abbott, Rachel is not a vendor. Please choose a vendor.") |
| `accountId` | no | an Accounts Payable account; null = the main A/P account. Another type: "Please choose an Accounts Payable account." |
| `refNumber` | no | the vendor's invoice number (max 20). Same number on another bill of the same vendor asks `dupnum` ("You have already used the reference number CN-1001 on another bill from Coastal Nursery Wholesale. Do you want to keep it anyway?") when preference `warnDuplicateBillNumbers` is on. |
| `termsId` | no | terms. **The API does not copy the vendor's terms**: the screen does. Look up the vendor (`GET /names/{id}` field `termsId`) and send it. |
| `dueDate` | no | blank = computed: standard terms → date + `netDays`; date-driven terms → `dueDay` of this or next month; no terms → date + preference `billsDueDays` (10 by default). |
| `billAddress` | no | vendor address text (the screen fills it; the API leaves it blank) |
| `memo`, `classId` | no | |
| `lines` | yes | section 3 |

Computed: `amount`, `openBalance` (amount − payments − discounts − credits applied),
`status` `"Open"` or `"Paid"`. A voided bill shows `status:"Open"` with `voided:true`: check
`voided`.

Verified example with an expense line billable to a job and an inventory line:

```
POST /txns
{"type":"BILL","date":"2026-10-20","nameId":1,"refNumber":"CN-1001","memo":"Test bill","lines":[
 {"accountId":41,"description":"Pump repair at Abbott job","amount":120,"nameId":23,"billable":true,"classId":35},
 {"itemId":12,"description":"Boxwood 5 gal","qty":10,"rate":18,"amount":180}]}
-> {"id":1652,"type":"BILL","dueDate":"2026-10-30","termsId":null,"amount":300,"openBalance":300,"status":"Open",
    "lines":[{"id":2694,"kind":"expense","accountId":41,"billable":true,"nameId":23,...},
             {"id":2695,"kind":"item","itemId":12,"accountId":null,...}]}
Ledger: Accounts Payable credit 300 (vendor); Repairs and Maintenance debit 120 (Abbott, Rachel:Backyard Patio);
Inventory Asset debit 180; Boxwood +10 on hand.
```

The due date was date + 10 days because no `termsId` was sent, although the vendor's terms
are "2% 10 Net 30". A later `PUT` with `"termsId":2,"dueDate":""` recomputed `2026-11-19`.

Edit rules:
- The new total may not be below what is already paid and credited: "Payments and credits of
  296.00 are applied to this transaction, which is more than its new total of 192.00. Remove or
  reduce them first."
- The vendor may not change while payments of the old vendor are applied: "Bill payment
  (check 2284) of Coastal Nursery Wholesale is applied to this bill. Remove it first, or keep
  the same vendor."

Open bills of a vendor: `GET /open-docs?kind=payable&nameId=<id>` (section 8) or
`GET /txns?types=BILL&nameId=<id>&openOnly=1`.

## 7. Vendor credits (BILLCRED)

Screen: Vendors > Enter Bills, switch "Credit". Type label in lists: "Credit".

Same fields and lines as a bill; no terms or due date. Posts the opposite of a bill:
Accounts Payable debit (you owe less), line accounts credited (an inventory line takes the
units out of stock at the given cost).

```
POST /txns
{"type":"BILLCRED","date":"2026-10-20","nameId":1,"refNumber":"CR-77","memo":"Returned damaged boxwood","lines":[
 {"itemId":12,"description":"Boxwood returned","qty":2,"rate":18,"amount":36},
 {"accountId":41,"description":"Repair refund","amount":4}]}
-> {"id":1654,"type":"BILLCRED","amount":40,"openBalance":40,...}
Ledger: Accounts Payable debit 40; Inventory Asset credit 36; Repairs and Maintenance credit 4.
```

`openBalance` = credit not used yet. Use it in Pay Bills (`credits` of a bill, section 8) or as
a link `fromTxnId` on a bill payment. A saved credit may not go below what was used: "X of this
credit has already been used, which is more than its new total of Y."
A negative total: "A vendor credit cannot have a negative total. Enter a bill instead."

## 8. Paying bills: POST /pay-bills

Screen: Vendors > Pay Bills (choose bills, amount, discount and credits per bill, payment
date, method "Check" or "Credit card", account, "To be printed" or "Assign check no.").
The "Pay bill" button of a saved bill uses the same endpoint for one bill.

### Step 1: list what can be paid

`GET /api/c/{cid}/open-docs?kind=payable&nameId=<vendor>&date=<payment date>`
(nameId optional = all vendors; date default today). Returns:

- `charges`: open bills, and journal entries with one A/P line that credits a vendor.
  Sorted by due date. Item receipts are not included.
- `credits`: vendor credits with credit left, bill payments with an unapplied part (their bill
  was voided or deleted), journal entries with one A/P line that debits a vendor.

Each row: `txnId`, `type`, `typeLabel`, `date`, `dueDate`, `refNumber`, `nameId`, `nameFull`,
`amount`, `openBalance`, `termsId`, `discountDate`, `suggestedDiscount`, `memo`, `poNumber`,
`arApAccountId`. `suggestedDiscount` = terms discount on the open balance when `date` is on or
before `discountDate` (date + `discountDays` for standard terms), else 0.

```
GET /open-docs?kind=payable&nameId=1&date=2026-10-25
-> {"charges":[{"txnId":1652,"type":"BILL","date":"2026-10-20","dueDate":"2026-11-19","refNumber":"CN-1001",
     "amount":336,"openBalance":336,"termsId":2,"discountDate":"2026-10-30","suggestedDiscount":6.72,...},...],
    "credits":[{"txnId":1654,"type":"BILLCRED","typeLabel":"Credit","refNumber":"CR-77","openBalance":40,...}]}
```

### Step 2: pay

`POST /api/c/{cid}/pay-bills`

| Field | Type | Meaning |
|---|---|---|
| `date` | string | payment date, required |
| `accountId` | id | bank or credit card account to pay from, required |
| `toBePrinted` | bool | bank only: leave the check number blank and put the payments in the print queue |
| `firstCheckNumber` | string | bank only, when not to be printed: number of the first check; blank = next number of that bank account. Following payments get the next numbers ("1009"→"1010", "A-099"→"A-100"). |
| `bills[]` | list | one entry per bill (or A/P journal entry) |
| `bills[].billId` | id | the bill |
| `bills[].amount` | number | cash paid on it (0 allowed when discount or credits cover it) |
| `bills[].discount` | number | discount taken (any amount; the terms date is not enforced) |
| `bills[].discountAccountId` | id | account for the discount; null = preference `vendorDiscountAccountId` (sample: "Purchase Discounts", a Cost of Goods Sold account) |
| `bills[].credits[]` | list | `{creditId, amount}`: vendor credits, unapplied bill payments or A/P debit journal entries of the same vendor |

The server creates **one bill payment per vendor** (and per A/P account), in vendor name order.
Each payment: `amount` = sum of cash amounts for that vendor, `memo` = the vendor's account
number, `billAddress` = vendor name and address. A payment whose cash amount is 0 (only credits
used) gets no check number. Credit card payments get no number and label "Bill Pmt -CCard".

Verified example: one bill paid with a 2% discount and a credit, a second bill of the same
vendor, and a bill of another vendor:

```
POST /pay-bills
{"date":"2026-10-25","accountId":1,"bills":[
 {"billId":1652,"amount":289.28,"discount":6.72,"credits":[{"creditId":1654,"amount":40}]},
 {"billId":1653,"amount":50},
 {"billId":1426,"amount":369.77}]}
-> {"payments":[
   {"id":1655,"type":"BILLPMT","typeLabel":"Bill Pmt -Check","refNumber":"2284","date":"2026-10-25","nameId":1,
    "nameFull":"Coastal Nursery Wholesale","accountId":1,"amount":339.28,"memo":"HV-2201","toBePrinted":false,...},
   {"id":1656,"type":"BILLPMT","refNumber":"2285","nameId":17,"amount":369.77,...}]}
```

Accounting effect of payment 1655: Checking credit 339.28, Purchase Discounts credit 6.72,
Accounts Payable debit 346.00. The credit (40) has no ledger effect: it only closes the bill and
the credit against each other. Bill 1652 became `openBalance 0`, `status "Paid"`; credit 1654
`openBalance 0`.

Errors (400, field `bills` unless noted):
- "Enter a valid payment date." (field `date`)
- "Select a bank or credit card account to pay the bills from." (field `accountId`)
- "Select at least one bill to pay."
- "Bill 1651 was not found." (not a bill: item receipt, wrong id...)
- "Bill CN-1001 is already paid." (also for a voided bill)
- "Bill 13-4541 is listed more than once."
- "Enter an amount to pay for bill CN-1001." (amount + discount + credits is 0)
- "The amount paid, discount and credits for bill CN-1001 (346.72) exceed its open balance of 336.00."
- "A credit can only be applied to bills of the same vendor."
- "The credits applied exceed the available credit of credit CR-77."
- "Vendor credit 99 was not found."
- "Select the account to post the discount for bill X to." (field `discountAccountId`; no account and no preference)
- 409 `dupnum` "Check number 2284 has already been used in Checking. Do you want to keep this
  number anyway?" (repeat with `?accept=dupnum` if the user agrees)

The whole request is one database transaction: on any error nothing is saved.

## 9. Bill payments as transactions (BILLPMT)

Screen: opening a bill payment (from Vendor Center, a register or a report) shows
"Bill Payment by Check" or "Bill Payment by Credit Card" (followed by the account name): change amounts per bill, add or remove
bills of the same vendor.

You can also create one with `POST /txns` (one vendor) and change it with `PUT`.

| Field | Notes |
|---|---|
| `type` | `"BILLPMT"` |
| `date`, `nameId` (vendor) | required |
| `accountId` | bank or credit card; null = preference `defaultBillPayAccountId`, else `defaultCheckAccountId` |
| `arApAccountId` | A/P account; null = main A/P. Every bill must be in this A/P account ("Bill X is in Y. Choose that A/P account for this bill payment."). |
| `refNumber`, `toBePrinted`, `memo`, `billAddress` | check number and check face |
| `amount` | must equal the sum of the cash links; 0 or omitted = computed |
| `links[]` | `{toTxnId, amount, discount, discountAccountId}` for cash paid on a bill (`fromTxnId` null). A credit used through this payment: `{fromTxnId: <credit id>, toTxnId: <bill id>, amount}` (no discount on a credit). |
| `lines` | ignored |

```
POST /txns
{"type":"BILLPMT","date":"2026-10-26","nameId":17,"accountId":1,"refNumber":"2287","links":[{"toTxnId":1545,"amount":10}]}
-> {"id":1660,"type":"BILLPMT","amount":10,"arApAccountId":10,"links":[{"fromTxnId":1660,"toTxnId":1545,"amount":10,"discount":0,...}],...}
```

`GET /txns/{id}` returns `links` with read-only descriptions (`fromType`, `toType`,
`toRefNumber`, `toAmount`...). When you `PUT`, send back every link you want to keep,
including credit links (`fromTxnId` = the credit): the links you send replace all links the
payment owns.

Errors: "Please select at least one bill to pay." (field `links`); "The payment amount (12.00)
must equal the total of the amounts applied to bills (10.00)." (field `amount`); "Bill #13-4541
belongs to a different vendor."; "The amount applied to X (..) is more than its open balance
(..)."; "Applied amounts and discounts cannot be negative."; "The amount cannot be negative."

Unapplied bill payments: when the bill a payment paid is voided or deleted, the payment stays
as it is (same check, same amount) and the freed amount becomes a credit for the vendor
(`openBalance` of the payment > 0, listed in `open-docs` credits). Use it with Pay Bills
`credits` (`creditId` = the bill payment id) or by editing that payment and adding a link to
another bill **without changing its amount** (verified: amount 339.28 kept, 40 applied to another
bill, 10 still unapplied). Changing the amount of such a payment requires its links to add up to
the new amount again.

Accounting: bank or card credit by `amount`; each discount: credit the discount account;
Accounts Payable debit by amount + discounts. Type label "Bill Pmt -Check" from a bank account,
"Bill Pmt -CCard" from a credit card account.

## 10. Checks (CHK) and printing checks

Screen: Banking > Write Checks (also Favorites > Write Checks, Alt+W). The screen asks for the
next number, fills the payee address, recalls the payee's last check (preference `autoRecall`)
and offers "Print later".

| Field | Notes |
|---|---|
| `type` | `"CHK"` |
| `date` | required |
| `accountId` | a **Bank** account; null = preference `defaultCheckAccountId`. A credit card account: "Please choose a bank account." |
| `nameId` | payee: any customer, vendor or other name, or null. Vendors marked 1099 count in the 1099 reports (section 18). |
| `refNumber` | check number; **not assigned automatically**. Get it with `GET /next-ref?type=CHK&accountId=1` → `{"refNumber":"2284"}`. A number already used in that bank account by a check, bill payment, refund or tax payment asks `dupnum` (preference `warnDuplicateCheckNumbers`). |
| `toBePrinted` | true = print later (the screen sends `refNumber:""`; the server keeps any number you send) |
| `billAddress` | name and address printed on the check |
| `memo`, `classId` | |
| `lines` | expense and item lines (section 3) |

```
POST /txns
{"type":"CHK","date":"2026-10-21","accountId":1,"nameId":11,"refNumber":"2291","memo":"Hardscape crew + supplies","lines":[
 {"accountId":28,"description":"Patio labor","amount":800,"nameId":23,"billable":true,"classId":35},
 {"itemId":19,"description":"Flagstone","qty":20,"rate":3.5,"amount":70}]}
-> {"id":1663,"type":"CHK","refNumber":"2291","amount":870,...}
Ledger: Checking credit 870; Job Expenses:Subcontractors debit 800 (Abbott job); Inventory Asset debit 70.
```

Other uses verified: a loan payment (lines: loan account 450 principal, Interest Expense 85.50),
a reimbursement to an "other" name, a check to a customer. Paying a bill with a check: use Pay
Bills (section 8), not a check, or the bill stays open.

There is no separate payroll tax payment type in Books (payroll taxes are paid in SerieX
Payroll with Pay Payroll Taxes). A liability payment entered in Books is a check whose line uses the liability account.

### Printing: GET /to-print and POST /mark-printed

Screens: File > Print Forms > Checks, Banking > Print Checks.

- `GET /to-print?kind=checks&accountId=<bank id>` lists checks, bill payments, refunds and tax
  payments marked to be printed (accountId optional).
- `POST /mark-printed` body `{"txnIds":[1658],"firstNumber":"2286"}` gives the listed
  transactions check numbers in that order, starting at `firstNumber` (blank = next number of the
  account), and clears `toBePrinted`. Returns `{"ok":true,"updated":1,"rows":[...]}`. Numbers
  already used ask `dupnum` for the whole batch (nothing is saved until accepted).

Customer refunds use the same queue; see transactions.md.

## 11. Credit card charges and credits (CCCHARGE, CCCREDIT)

Screen: Banking > Enter Credit Card Charges ("Charge" / "Credit" switch).

Same fields and lines as a check, but `accountId` must be a **Credit Card** account and has no
default ("Please choose a credit card account."). `refNumber` is free text (no check-number
rules). Payee: any name or none.

- Charge: card balance up (you owe more), line accounts debited.
- Credit (refund from a merchant): card balance down, line accounts credited.

```
POST /txns
{"type":"CCCHARGE","date":"2026-10-21","accountId":11,"nameId":5,"refNumber":"7781","memo":"Fuel","lines":[
 {"accountId":53,"amount":64.2},
 {"itemId":29,"description":"Landscape fabric for Abbott","qty":1,"rate":35,"amount":35,"nameId":23,"billable":true}]}
-> {"id":1666,"type":"CCCHARGE","amount":99.2,...}
Ledger: Harbor National Visa credit 99.20; Automobile Expense:Fuel debit 64.20; Job Expenses:Job Materials debit 35.

POST /txns
{"type":"CCCREDIT","date":"2026-10-22","accountId":11,"nameId":5,"memo":"Fuel refund","lines":[{"accountId":53,"amount":14.2}]}
Ledger: Harbor National Visa debit 14.20; Automobile Expense:Fuel credit 14.20.
```

Paying the card bill: a `TRANSFER` from the bank to the card account (section 12), a check with
the card account on an expense line, or, if the card company sends a bill, a bill to the card
company paid with Pay Bills. Paying vendor bills with the card: Pay Bills with the card as
`accountId`.

## 12. Transfers (TRANSFER)

Screen: Banking > Transfer Funds (the window is "Transfer Money").

| Field | Notes |
|---|---|
| `type` | `"TRANSFER"` |
| `date` | required |
| `accountId` | transfer from (required) |
| `toAccountId` | transfer to (required, different) |
| `amount` | required, more than 0 |
| `memo`, `classId` | optional (screen default memo "Funds Transfer") |
| `lines` | ignored |

Both accounts must be balance sheet accounts other than A/R and A/P: bank, other current
asset, fixed asset, other asset, credit card, other current or long term liability, equity.

```
POST /txns
{"type":"TRANSFER","date":"2026-10-21","accountId":1,"toAccountId":2,"amount":500,"memo":"Funds Transfer"}
-> {"id":1669,"type":"TRANSFER","amount":500,"accountId":1,"toAccountId":2,"lines":[],...}
Ledger: Checking credit 500; Savings debit 500.
```

From a bank to a credit card account pays the card down (card balance falls). Errors: "Please
choose the account to transfer funds from." (`accountId`), "...to." (`toAccountId`),
"The accounts to transfer funds from and to must be different.", "Funds can only be transferred
between bank, asset, liability, credit card and equity accounts (not Accounts Receivable or
Accounts Payable).", "Please enter the amount to transfer." (`amount`, also for negative).
A `nameId` is stored (reports may show it) but the ledger entries carry no name.

## 13. Journal entries (GENJRNL)

Screen: Company > Make General Journal Entries (window "Journal Entry"; columns ACCOUNT, DEBIT,
CREDIT, MEMO, NAME, BILLABLE?, CLASS; "Reverse" builds the reversing entry).

| Field | Notes |
|---|---|
| `type` | `"GENJRNL"` |
| `date` | required |
| `refNumber` | entry number; blank stays blank unless preference `autoAssignJournalNumbers` is on (then next number; `GET /next-ref?type=GENJRNL`) |
| `memo`, `classId` | header memo and class (used for lines without their own) |
| `accountId` | ignored (always null) |
| `nameId` | optional header name: stored, and reports show it for lines without a name; the ledger entries carry only line names, so A/R and A/P lines need their own `nameId` |
| `lines[]` | `accountId` (required), `amount` (**positive = debit, negative = credit**), `description`, `nameId`, `classId` |
| `links[]` | optional, see "Applying" below |

Rules (all verified):
- At least two lines: "A journal entry needs at least two lines: one debit and one credit."
- Debits must equal credits: "Transaction not in balance. The total debits (15.00) must equal the
  total credits (14.00)."
- A line on Accounts Payable needs a vendor in `nameId`; a line on Accounts Receivable needs a
  customer: "Line 1: when you use Accounts Payable in a journal entry, you must choose a vendor in
  the Name column."
- Any account type except Non-Posting may be used (A/R and A/P allowed, unlike other forms).
- Lines post exactly as entered, each with its own name and class. `amount` of the header =
  total debits.
- `billable` is always saved as false on journal entries, even though the screen shows a
  BILLABLE? column (see section 20).

```
POST /txns
{"type":"GENJRNL","date":"2026-10-21","memo":"Bank fee correction","lines":[
 {"accountId":31,"amount":15,"description":"Wire fee","classId":35},
 {"accountId":1,"amount":-15,"description":"Wire fee"}]}
-> {"id":1672,"type":"GENJRNL","refNumber":"","amount":15,"accountId":null,
    "lines":[{"kind":"je","accountId":31,"amount":15,...},{"kind":"je","accountId":1,"amount":-15,...}]}
```

### Journal entries that act as bills, credits, invoices

A journal entry with **exactly one** A/R or A/P line is an open document of that line's name:

| Line | Acts like | Where it shows |
|---|---|---|
| A/P credit (negative) with a vendor | a bill | `open-docs?kind=payable` charges; payable in Pay Bills (`billId` = the entry id), discounts allowed |
| A/P debit (positive) with a vendor | a vendor credit | `open-docs?kind=payable` credits; usable in Pay Bills `credits` |
| A/R debit / credit with a customer | an invoice / a credit memo | customer side, see transactions.md |

Its `openBalance` is the A/P (A/R) amount less what is applied. With two or more A/R/A/P lines
it is not an open document (openBalance 0).

```
POST /txns  {"type":"GENJRNL","date":"2026-10-21","refNumber":"JE-1","memo":"Mulch owed","lines":[
  {"accountId":10,"amount":-100,"nameId":3},{"accountId":27,"amount":100}]}      -> openBalance 100 (a charge)
POST /txns  {"type":"GENJRNL","date":"2026-10-21","refNumber":"JE-2","memo":"Mulch credit","lines":[
  {"accountId":10,"amount":30,"nameId":3},{"accountId":27,"amount":-30}]}        -> openBalance 30 (a credit)
POST /pay-bills {"date":"2026-10-22","accountId":1,"firstCheckNumber":"2295",
  "bills":[{"billId":1673,"amount":60,"discount":2,"credits":[{"creditId":1674,"amount":30}]}]}
-> JE-1 openBalance 8, JE-2 openBalance 0
```

Applying: an entry that **debits a vendor on A/P** (or credits a customer on A/R) may apply
itself to that name's bills (invoices) with `links: [{"toTxnId": <bill id>, "amount": 3}]`
(same vendor exactly, same A/P account, no discount). Any other entry with links:
"Only a journal entry with one line crediting a customer (Accounts Receivable) or debiting a
vendor (Accounts Payable) can be applied to invoices or bills." Discounts: "A discount cannot be
taken when applying a journal entry."

Editing an entry that has payments or credits applied: its A/R/A/P line must keep the same
account type, name and side, and cover what is applied: "Payments or credits of 92.00 are
applied to this journal entry. Remove them before changing its Accounts Payable line." /
"...which is more than its new amount of 80.00."

Sales tax adjustment: a journal entry line on Sales Tax Payable with the tax agency in
`nameId` appears in `GET /sales-tax/due` as an adjustment row (section 15).

## 14. Inventory adjustments (INVADJ) and average cost

Screen: Vendors > Inventory Activities > Adjust Quantity/Value On Hand (window "Adjust
Inventory"; Adjustment type: Quantity, Total value, Quantity and total value). Also from the
Item List (Activities ▾ > Adjust Inventory...).

| Field | Notes |
|---|---|
| `type` | `"INVADJ"` |
| `date` | required |
| `accountId` | adjustment account, required (no default; any account except A/R, A/P, Non-Posting). Sample: "Inventory Adjustments" (Cost of Goods Sold). The screen guesses an account named like "Inventory Adj...". |
| `nameId` | optional (screen: CUSTOMER OR JOB), `classId`, `memo`, `refNumber` optional |
| `extra.valueAdjustment` | `true` for value modes (amounts you give); absent/false = quantity mode |
| `lines[]` | `itemId` (an **Inventory Part**, else "Line 1: please choose an inventory part."), `qty` = **change** in quantity (+ found, − lost), `amount` = change in value (value modes only), `description` |

Quantity mode (`valueAdjustment` false): each line needs a non-zero `qty` ("Line 1: please enter
the change in quantity."). Any `amount` you send is ignored: the value is computed at the item's
average cost on that date, and is recomputed when earlier transactions change.

```
POST /txns
{"type":"INVADJ","date":"2026-10-21","accountId":52,"memo":"Count adjustment","lines":[{"itemId":21,"qty":-2,"description":"Shrinkage"}]}
-> {"id":1677,"type":"INVADJ","amount":-43.72,"lines":[{"itemId":21,"qty":-2,"amount":-43.72,"cogs":-43.72}],...}
Ledger: Inventory Adjustments debit 43.72; Inventory Asset credit 43.72. Bark Mulch on hand 22 -> 20 (average 21.858 unchanged).
```

Value modes (`"extra":{"valueAdjustment":true}`): `amount` is the value change you give; `qty`
may be 0 (value only) or not (quantity and value).

```
POST /txns
{"type":"INVADJ","date":"2026-10-21","accountId":52,"memo":"Write down","extra":{"valueAdjustment":true},"lines":[
 {"itemId":22,"qty":0,"amount":-10,"description":"Value write-down"},
 {"itemId":23,"qty":5,"amount":250,"description":"Found 5 bags"}]}
-> {"id":1678,"amount":240,...}
Topsoil: 13 on hand, value 237.40 -> 227.40 (average 18.26 -> 17.49). Decorative Rock: 14 -> 19, value +250.
```

The screen shows CURRENT QTY / NEW QTY / CURRENT VALUE / NEW VALUE (from the Inventory Valuation
Summary as of the date) and sends only the differences. It also saves `extra.adjustmentType`
(`qty`, `value`, `both`), which the server does not use. The screen refuses a new quantity below
zero; the API does not check this.

Accounting: Inventory Asset changes by the total value; the adjustment account takes the
opposite side. `amount` of the transaction = total value change (negative for a loss).

### Average cost (how inventory values are computed)

From `core_inventory.go`, verified:
- Each item keeps `qtyOnHand`, `assetValue` and `avgCost` (see `GET /items/{id}`).
- Purchases (bill, item receipt, check, card charge item lines) and value adjustments add their
  own amounts ("known cost"). Vendor credits and card credits remove their own amounts.
- Sales, credit memo returns and quantity adjustments are valued at the running average
  (value ÷ quantity) at that point in date order. When stock is zero or negative they use the last
  average the item had, or the item's `cost` field if it never had stock. A move that brings the
  quantity back to exactly zero takes all remaining value, so value is 0 whenever quantity is 0.
- Moves are replayed in order of date, then transaction id. Any save, void or delete that
  touches an item re-values its later moves: the cost of goods sold of later sales and the amounts
  of later quantity adjustments change. Verified: a bill dated before an adjustment raised the
  adjustment from −21.86 to −23.84; deleting the bill brought it back to −21.86.
- Changing an item's `cost` field does not change recorded transactions.

## 15. Sales tax: GET /sales-tax/due and payments (TAXPMT)

Screens: Vendors > Sales Tax > Pay Sales Tax (pay from account, check date, "show sales tax due
through", check number or to be printed; one payment per agency); Vendors > Sales Tax > Manage
Sales Tax; report Sales Tax Liability.

### GET /sales-tax/due

`GET /sales-tax/due?asOf=YYYY-MM-DD&paidThrough=YYYY-MM-DD` (both optional; asOf default today).
Returns what is owed per sales tax item as of `asOf` (positive = owed), following preference
`salesTaxBasis` (accrual, or cash = tax counts when the invoice is paid). Payments count whatever
their date, unless `paidThrough` limits them to payments dated up to it.

```
GET /sales-tax/due
-> [{"taxItemId":1,"taxItemName":"Harbor County","agencyId":15,"agencyName":"State Department of Revenue","amountDue":225.26},
    {"taxItemId":2,"taxItemName":"Harborview City","agencyId":15,"agencyName":"State Department of Revenue","amountDue":54.07}]
```

Rows with 0 due are left out. Tax item rows never go below 0. Adjustment rows (entries on Sales
Tax Payable without a tax item, such as a journal entry naming the agency) come one per agency
with `"taxItemId":0,"taxItemName":""`, and may be negative:

```
{"taxItemId":0,"taxItemName":"","agencyId":15,"agencyName":"State Department of Revenue","amountDue":-4.5}
```

A tax item with no agency has `agencyId` null: set the agency on the tax item before paying.

### Sales tax payment (TAXPMT)

| Field | Notes |
|---|---|
| `type` | `"TAXPMT"` |
| `date` | required |
| `accountId` | **Bank** account; null = `defaultCheckAccountId`. "Please choose the bank account to pay the sales tax from." |
| `nameId` | the agency, a **vendor**, required ("Abbott, Rachel is not a sales tax agency. Please choose a sales tax agency (vendor).") |
| `refNumber`, `toBePrinted`, `billAddress`, `memo` | check fields (check number rules as for checks) |
| `extra.salesTaxThrough` | last day of the period paid (the screen sends it, memo "Sales tax through MM/DD/YYYY"). Used to decide which tax a payment covered; default = payment date. |
| `lines[]` | one per tax item: `itemId` (a **Sales Tax Item**, not a group: "Line 1: Harborview Combined is not a sales tax item."), `description`, `amount`. Adjustments: a line with `accountId` = Sales Tax Payable, no item, amount (may be negative). |
| `amount` | computed from lines; send it only for a payment with no lines (then all goes to Sales Tax Payable without a tax item) |

```
POST /txns
{"type":"TAXPMT","date":"2026-10-31","accountId":1,"nameId":15,"refNumber":"2297","memo":"Sales tax through 10/31/2026",
 "extra":{"salesTaxThrough":"2026-10-31"},"lines":[
 {"itemId":1,"description":"Harbor County","amount":225.26},
 {"itemId":2,"description":"Harborview City","amount":54.07},
 {"accountId":12,"description":"Sales tax adjustment - State Department of Revenue","amount":-4.5}]}
-> {"id":1684,"type":"TAXPMT","refNumber":"2297","amount":274.83,...}
Ledger: Checking credit 274.83; Sales Tax Payable debit per line (with the tax item and agency).
GET /sales-tax/due?asOf=2026-10-31 -> []
```

Errors: "You cannot record a blank transaction. Please enter the sales tax to pay." (no lines and
no amount). The screen also refuses a payment of zero or less to an agency ("A refund from the
agency is entered as a deposit instead").

## 16. Deposits

Make Deposits (`DEP`), including deposits that are not customer payments (interest, loan
proceeds, owner money, refunds from vendors) and cash back, is documented in **transactions.md**.

## 17. Void and delete: what happens to related records

Void keeps the transaction with all amounts 0 and memo prefixed "VOID: "; delete removes it.
Both reverse the ledger and inventory, and refresh open balances and PO received quantities.
A voided transaction stays voided if edited (its amounts stay 0).

| You remove | Question asked (409 confirm, `warning`) | Result after `?accept=` |
|---|---|---|
| A bill with a bill payment applied | `applied`: "Bill payment (check 2284) ($50.00) is applied to this bill. Voiding the bill turns that amount into a $50.00 credit for Coastal Nursery Wholesale. The bill payment stays recorded as it is; you can apply the credit to another bill of this vendor in Pay Bills. Void anyway?" | The check is unchanged; its amount becomes an unapplied credit (section 9). A discount taken on the bill is removed (the payment is re-posted without it). |
| A vendor credit or A/P journal credit used on bills | `applied`: "This vendor credit is applied to bill #CN-1001 ($40.00). Deleting it makes it open again for $40.00. Delete anyway?" | Those bills reopen by that amount. |
| A bill payment | none | Its bills reopen; credits it used become available again. |
| An item receipt / bill / check that received a PO | none | PO `receivedQty` goes back down, PO reopens. |
| A purchase order | none | Receiving transactions lose the link (delete) or keep it (void). |
| An inventory purchase or adjustment | none | Stock and later costs are recomputed. |
| Anything with reconciled entries (text from the code, not tested live) | `reconciled`: "This transaction has been reconciled. Voiding it will change the reconciled balance of the account. Are you sure you want to void it?" | |

Ask `GET /txns/{id}/remove-check?verb=void` first to get the question text to show the user.
Prefer void over delete for checks and bill payments that were printed or sent (the number stays
in the register).

## 18. 1099 reporting

A vendor is a 1099 vendor when its record has `is1099: true` ("Vendor eligible for 1099" in the
vendor dialog; tax ID in `taxIdent`). Reports `1099_summary` and `1099_detail`
(`GET /reports/1099_summary?from=&to=`) count, for 1099 vendors:
- checks (`CHK`) from **bank** accounts with that vendor as payee: only lines posted to income,
  cost of goods sold or expense accounts (inventory, assets, loans are left out);
- bill payments (`BILLPMT`) from **bank** accounts: the cash applied to each bill, spread over
  that bill's income/COGS/expense lines in proportion.

Not counted: credit card charges and bill payments made by credit card (reported by the card
company), discounts, credits applied, journal entries. Verified: check 2291 to Ortega Hardscape
Crew (850 subcontractor labor + 70 inventory) shows 850 in 1099 Detail.

## 19. Checking the effect: accounts and reports

- `GET /accounts`: `balance` (natural sign) of balance sheet accounts only. **Income, cost of
  goods sold and expense accounts always show 0 here**: use reports for them.
- One transaction's debits and credits: `GET /reports/journal?txnId=<id>` (rows with `account`,
  `debit`, `credit`, `name`, `memo`).
- Useful report keys (`GET /reports/<key>?from=&to=` or `?asOf=`): `profit_loss`,
  `balance_sheet`, `ap_aging_summary`, `ap_aging_detail`, `vendor_balance_summary`,
  `vendor_balance_detail`, `unpaid_bills_detail` (includes item receipts), `open_purchase_orders`,
  `open_purchase_orders_detail`, `purchases_by_vendor_summary`, `purchases_by_item_detail`,
  `expenses_by_vendor_summary`, `inventory_valuation_summary`, `inventory_valuation_detail`,
  `check_detail`, `missing_checks`, `sales_tax_liability`, `1099_summary`, `account_quickreport`
  (`accountId=`), `transaction_list_by_vendor`.
- Vendor overview: `GET /names/{id}/summary` → `{openBalance, overdue, lastPayment:{date,amount}, openPOs, ...}`.
- Item stock and cost: `GET /items/{id}` → `qtyOnHand`, `avgCost`, `assetValue`.
- Screen: Vendors > Money Out shows open POs, unpaid and overdue bills and recent payments.

## 20. Surprises and known issues

1. Bills created through the API do not take the vendor's terms or address: send `termsId` and
   `billAddress` yourself, otherwise the due date is date + `billsDueDays` (10) days.
2. Check numbers are never assigned by the server (except Pay Bills and mark-printed). Call
   `GET /next-ref?type=CHK&accountId=` and send `refNumber`.
3. An inventory item line without `qty` adds or removes **1 unit**.
4. `amount` of a purchase line must be sent and must match `qty × rate`; the server does not
   compute it.
5. Item receipts are in A/P and A/P reports but cannot be paid until converted to bills.
6. Over-receiving a purchase order is accepted silently.
7. Bug: a voided transaction that has lines with both `qty` and `rate` cannot be saved again,
   even to change only the memo: `PUT` returns "Line 1: the amount (0.00) does not equal quantity
   × rate (10 × 2.1 = 21.00)." The same message comes from `POST /txns/{id}/convert-to-bill` on a
   voided item receipt. (Reproduce: create an ITEMRCPT with qty 10 × 2.1, void it, PUT it back
   unchanged.)
8. Bug: the journal entry screen has a BILLABLE? column, but the server always stores
   `billable:false` on journal entry lines and `GET /billables` never lists them. (Reproduce:
   POST a GENJRNL line with `"nameId":<customer>,"billable":true`; the response has
   `billable:false`.)
9. A voided bill reports `status:"Open"` (and Pay Bills says "is already paid" for it). Use
   `voided`.
10. Sales tax items cannot be put on checks or bills (error says the item has no expense
    account), although the posting code would send them to Sales Tax Payable. Use `TAXPMT`.
11. Deleting a purchase order that was received against asks nothing and unlinks the receipts.
12. `GET /accounts` shows 0 for every income and expense account.
13. Pay Bills does not check the discount date: any discount up to the open balance is accepted.
