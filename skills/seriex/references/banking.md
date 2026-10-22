# SerieX Books: Banking (bank feeds, bank rules, registers, reconcile)

Reference for helping a user bring bank and credit card activity into SerieX Books,
categorize it, look at account registers, and reconcile against a bank statement.
The check, deposit, transfer and credit card forms themselves are covered elsewhere;
this file covers what happens around them.

Every request example below was run against a live server with the sample company
(`sample-harborview`). Ids in examples come from that company and will differ in a real file.

## Contents

1. [Conventions](#1-conventions)
2. [Where things are in the app](#2-where-things-are-in-the-app)
3. [Bank feeds (bank file import)](#3-bank-feeds-bank-file-import)
   - 3.1 [GET /bank-feeds/accounts](#31-get-bank-feedsaccounts)
   - 3.2 [POST /bank-feeds/{accountId}/import](#32-post-bank-feedsaccountidimport)
   - 3.3 [GET /bank-feeds/{accountId}/items](#33-get-bank-feedsaccountiditems)
   - 3.4 [POST /bank-feed-items/{id}/add](#34-post-bank-feed-itemsidadd)
   - 3.5 [Splitting one bank line over several accounts](#35-splitting-one-bank-line-over-several-accounts)
   - 3.6 [POST /bank-feed-items/{id}/match](#36-post-bank-feed-itemsidmatch)
   - 3.7 [POST /bank-feed-items/{id}/ignore](#37-post-bank-feed-itemsidignore)
   - 3.8 [POST /bank-feed-items/{id}/undo](#38-post-bank-feed-itemsidundo)
   - 3.9 [Recipe: review a bank download](#39-recipe-review-a-bank-download)
4. [Bank rules](#4-bank-rules)
   - 4.1 [Rule object and how rules apply](#41-rule-object-and-how-rules-apply)
   - 4.2 [Rule endpoints (CRUD)](#42-rule-endpoints-crud)
   - 4.3 [Rule suggestions](#43-rule-suggestions)
5. [Registers and cleared marks](#5-registers-and-cleared-marks)
   - 5.1 [GET /registers/{accountId}](#51-get-registersaccountid)
   - 5.2 [PUT /gl/{id}/cleared](#52-put-glidcleared)
6. [Reconcile](#6-reconcile)
   - 6.1 [Concepts](#61-concepts)
   - 6.2 [GET /reconcile/{accountId}](#62-get-reconcileaccountid)
   - 6.3 [PUT /reconcile/{accountId}/draft](#63-put-reconcileaccountiddraft)
   - 6.4 [POST /reconcile/{accountId}/finish](#64-post-reconcileaccountidfinish)
   - 6.5 [POST /reconcile/{accountId}/undo-last](#65-post-reconcileaccountidundo-last)
   - 6.6 [GET /reconciliations and the report](#66-get-reconciliations-and-the-report)
   - 6.7 [GET /reconcile/{accountId}/discrepancies](#67-get-reconcileaccountiddiscrepancies)
   - 6.8 [Recipe: reconcile one statement](#68-recipe-reconcile-one-statement)
   - 6.9 [Recipe: find a reconciliation difference](#69-recipe-find-a-reconciliation-difference)
7. [Pitfalls checklist](#7-pitfalls-checklist)

---

## 1. Conventions

```
B=http://127.0.0.1:47180/api/c/sample-harborview   # desktop app default port; check <data>/servers.json
```

- All routes below are company routes: `/api/c/{cid}/...`. Writes need
  `Content-Type: application/json`, except the bank file import, which is `multipart/form-data`.
- Money is in dollars with 2 decimals in JSON.
- **Two sign conventions exist. Do not mix them up.**
  - **Bank feed amounts** (`BankFeedItem.amount`, `BankFeedMatch.amount`): `+` = money came
    into the account, `-` = money went out. For a credit card, `-` is a charge (purchase) and
    `+` is a payment or refund to the card.
  - **Register and reconcile amounts** use the account's *natural* sign: `+` increases the
    account balance. Bank account: `+` deposit, `-` check/payment. Credit card: `+` charge
    (more owed), `-` payment/credit. Register rows split this into `increase` / `decrease`.
- **`txnId` vs `glId`.** A transaction (`txnId`) posts one or more ledger entries (`glId`).
  Cleared marks and reconciliation work on ledger entries of one account, so reconcile requests
  take `glId`s. One transaction can have more than one entry in the same account (for example a
  journal entry with two lines to the same bank account); mark all of them.
- Cleared status of an entry: `""` = uncleared, `"*"` = cleared (marked, not yet reconciled),
  `"R"` = reconciled.
- Errors follow the shared format (`{"error","code","field"?,"warning"?}`). The "Yes/No" kind
  (`code: "confirm"`) is answered by repeating the request with `?accept=<warning>` or `?force=1`.
  Banking uses warning kinds `account` (bank file for another account), `reconciled`
  (changing a reconciled transaction), `dupnum` (check number already used), `closing`.
  One confirm in this area has **no** warning kind (bank feed match with a different amount):
  answer it with `?force=1`.

## 2. Where things are in the app

| Task | Menu path |
|---|---|
| "Bank Imports" window (review downloaded transactions) | Banking > Bank Feeds > Bank Feeds Center (or **Bank Imports** in the navigation) |
| Import a bank file | Banking > Bank Feeds > Import Bank File (OFX / CSV)..., or "Import file" button in Bank Imports (drag and drop also works) |
| Bank rules and suggested rules | Banking > Bank Feeds > Manage Rules..., or "Rules" button in Bank Imports |
| Register of an account | Banking > Use Register (Ctrl+R; the dialog is "Open a Register"), or double-click a balance sheet account in Lists > Chart of Accounts |
| Reconcile | Banking > Reconcile... (window "Start Reconciling", then "Reconcile - <account>") |
| Undo last reconciliation, discrepancy report | Buttons "Undo last reconciliation" and "Locate discrepancies" in Start Reconciling |
| Old reconciliation reports | Banking > Previous Reconciliation reports... |

Bank Imports window layout: account tiles at the top (with the count waiting), tabs
**For review** (status `new`), **Categorized** (`added` + `matched`), **Excluded** (`ignored`).
Clicking a row opens an editor with Payee, Category (account), Class, Memo, Ref no., a
**Split** button, **Create rule from this**, **Exclude**, and **Add** or **Match**. Several
rows can be checked and accepted at once with **Accept** (each row uses its match if it has one,
otherwise its suggested category).

---

## 3. Bank feeds (bank file import)

There is no live bank connection. The user downloads a file from the bank website (OFX, QFX,
QBO or CSV) and imports it. Imported lines wait in the Bank Imports window until each is **added** (a new
transaction is created), **matched** (linked to a transaction already in the register) or
**ignored** (excluded). Only bank and credit card accounts can use bank feeds.

### 3.1 GET /bank-feeds/accounts

Lists bank and credit card accounts (active ones, plus inactive ones that have downloaded lines),
banks first, then cards, by name.

```
curl -s $B/bank-feeds/accounts
[{"accountId":1,"accountName":"Checking","accountType":"Bank","newCount":20,
  "lastImport":"2026-10-21T02:31:53Z","dateOrder":"","flipSigns":false}, ...]
```

| Field | Meaning |
|---|---|
| `newCount` | Lines waiting for review (status `new`). |
| `lastImport` | Time of the last import, UTC, `""` if never. |
| `dateOrder` | Saved CSV date order for this account: `"mdy"`, `"dmy"`, `""` (none saved). |
| `flipSigns` | Saved CSV "flip signs" choice for this account (see 3.2). |

### 3.2 POST /bank-feeds/{accountId}/import

Uploads one bank file into the downloaded lines of a bank or credit card account.
Maximum 20 MB.

Request: `multipart/form-data`.

| Field | Required | Meaning |
|---|---|---|
| `file` | yes | The file. Format is detected from the content, not the extension. |
| `flipSigns` | no | CSV only. `1`/`true`/`yes` = reverse the amount signs; anything else (e.g. `0`) = do not. Omitted = use the account's saved choice. |
| `dateOrder` | no | CSV only. `mdy` or `dmy`. Omitted = detect from the file, then the saved choice, then month first. |

Query: `?accept=account` (or `?force=1`) to import a file whose account number belongs to
another account (see below).

```
curl -s -X POST $B/bank-feeds/1/import -F "file=@checking-sept.csv"
{"imported":6,"skipped":0,"batchId":"20261020-223422-f8eb6e","format":"csv","invalid":2,
 "problems":[{"row":10,"reason":"the date \"N/A\" could not be read"},
             {"row":11,"reason":"the amount \"abc\" could not be read"}],
 "dateOrder":"mdy","flipSigns":false}
```

Response fields: `imported` (new lines stored), `skipped` (duplicates of lines already
downloaded), `batchId`, `format` (`"ofx"` for OFX/QFX/QBO, else `"csv"`), `invalid` (rows not
read), `problems` (first 20 unreadable rows; `row` = line number in a CSV file, or the
transaction's position in an OFX file), `dateOrder` (CSV only: how dates were read),
`flipSigns` (signs were reversed). Importing does **not** create any transactions.

#### OFX / QFX / QBO

Detected when the file contains `OFXHEADER` or `<OFX>` in its first 4 KB, or `<STMTTRN>`
anywhere. Both SGML (OFX 1.x) and XML (OFX 2.x) work. Per `<STMTTRN>`:
date = `DTPOSTED` (else `DTUSER`), amount = `TRNAMT`, bank id = `FITID`,
description = `NAME` (else `MEMO`), check number = `CHECKNUM` (or `REFNUM` when
`TRNTYPE` is `CHECK`). The file's account number is `ACCTID` inside `BANKACCTFROM` or
`CCACCTFROM`.

**Account number check (OFX only).** The file's `ACCTID` is compared with the account's
`bankAcctNumber` (digits only; equal, or one ends with the other with at least 4 digits).
- The account has no number and no other bank/card account has this number: the number is
  **saved onto the account** silently and the import goes ahead.
- The number belongs to another account, or the account has a different number: the server asks.
  ```
  {"code":"confirm","error":"This file is for account …6789 (Checking). Import it into Savings anyway?","warning":"account"}
  ```
  Usually the right answer is to import into the other account. Repeat with `?accept=account`
  only if the user confirms. Accepting does not change any account number.

#### CSV

- Encoding: UTF-8 (with or without BOM), UTF-16, else read as Windows-1252.
- Delimiter: comma, semicolon or tab, guessed from the **first non-blank line** of the file.
- Header row: the first of the first 20 rows that has a Date column and an Amount (or Debit,
  or Credit) column. Title lines above it are skipped (but see the bug note in section 7).
- Column names are matched case-insensitively with punctuation ignored:

| Role | Header names accepted (first found wins) |
|---|---|
| Date | date, transaction date, trans date, posted date, posting date, post date, effective date, booking date, value date; else any header containing "date" |
| Description | description, payee, name, transaction description, payee name, merchant, merchant name, details, transaction details, original description, narrative; else the memo column |
| Memo (used when the description cell is empty) | memo, notes, note, reference, additional info |
| Amount (signed) | amount, transaction amount, amount usd, net amount |
| Debit (money out) | debit, debits, debit amount, amount debit, withdrawal, withdrawals, withdrawal amount, money out, paid out, outflow, charge, charges |
| Credit (money in) | credit, credits, credit amount, amount credit, deposit, deposits, deposit amount, money in, paid in, inflow, payment, payments |
| Check number | check, check number, check no, check num, chk, chk no, check or slip, num, number, cheque, cheque number |
| Direction indicator | type, transaction type, debit credit, dr cr, cr dr, credit debit |

- When there is an Amount column it is used and Debit/Credit columns are ignored. Without one,
  amount = |credit| - |debit|.
- A positive Amount on a row whose indicator column says `debit`, `dr`, `d` or `withdrawal`
  becomes negative.
- Money text accepted: `1,234.56`, `-45.00`, `$45.00`, `(45.00)`, `45.00-`, `45.00 DR` (negative),
  `45.00 CR`, `1.234,56`, `45,00`.
- Dates accepted: `10/03/2026`, `10/3/26`, `2026-10-03`, `2026/10/3`, `10-3-2026`, `10.3.2026`,
  `20261003`, `Oct 3, 2026`, `October 3, 2026`, `Oct 3 2026`, `3 Oct 2026`, `03-Oct-2026`,
  `3-Oct-26`; a time after the date is ignored. Numeric dates are read month first unless
  `dateOrder=dmy` is sent, or the file shows a first part above 12 (e.g. `13/10/2026`), or the
  account's saved order is `dmy`.
- **Signs:** the server expects `+` money in, `-` money out. Many credit card CSV exports list
  purchases as positive numbers. For those, send `flipSigns=1`. It only applies to files with
  one signed Amount column and no debit/credit indicator values (files with Debit/Credit columns
  already say the direction, and the flag is ignored for them).
- **Saved choices:** when `flipSigns` or `dateOrder` is sent with a CSV, it is remembered for
  that account and reused for later CSV files that do not send it (shown in 3.1). Verified: after
  one card import with `flipSigns=1`, a later CSV with no `flipSigns` field was also flipped.
  Always send `flipSigns` explicitly for CSV imports, and check `flipSigns` in the response.

#### Duplicate detection

Each line is compared with every earlier downloaded line of the same account, whatever its
status (ignored lines count too):
- Same `FITID` (OFX) as an earlier line: skipped.
- A line with a FITID that has the same date, amount and description (case-insensitive,
  spaces collapsed) as an earlier line without FITID (from a CSV): skipped. Verified: an OFX
  line identical to an earlier CSV line was skipped.
- A line without FITID (CSV): skipped when an earlier line has the same date, amount and
  description. Repeated identical lines are counted (two identical coffees on one day both import
  the first time; re-importing the file skips both).

Duplicates are only checked against earlier downloaded lines, not against transactions typed into
the register. Those are found by matching (3.3). If the bank prints a different description in
its CSV and OFX downloads, the same transaction can come in twice; ignore the extra line.

#### Import errors

| Error (`code` 400 `validation`, field `file` unless noted) | Meaning |
|---|---|
| Please choose a file to import. | No `file` part (or not multipart). |
| The file is too large (20 MB maximum)... | Ask for a shorter date range. |
| The CSV file needs a header row with a Date column, a Description (or Payee/Name) column and an Amount column (or Debit and Credit columns). | No usable header row in the first 20 rows. (Only Date and an amount column are really required.) |
| No transactions were found in the file. | Header but no rows. |
| None of the N transactions in the file could be read (for example, line L: ...). | Every row failed. |
| The file could not be read as CSV (line N: ...). | Broken quoting. |
| Bank imports can only be used with bank and credit card accounts. (field `accountId`) | Wrong account type. |
| 404 Account not found. | Bad account id. |
| 409 confirm, warning `account` | See the account number check above. |

### 3.3 GET /bank-feeds/{accountId}/items

Query: `status` = `new` | `added` | `matched` | `ignored` | `all` (default `all`).
Other values: 400 `Invalid status "x".` Lines are sorted by date, then id.

```
curl -s "$B/bank-feeds/1/items?status=new"
[{"id":28,"accountId":1,"date":"2026-09-01","description":"ACH DEBIT MARINA PROPERTIES LLC",
  "amount":-3200,"checkNumber":"","status":"new","txnId":null,
  "matches":[{"txnId":1493,"type":"CHK","typeLabel":"Check","date":"2026-09-01","refNumber":"",
              "nameFull":"Marina Properties LLC","amount":-3200}],
  "suggestedNameId":9,"suggestedAccountId":40,"suggestedPayee":"Marina Properties LLC"},
 {"id":34,"date":"2026-09-22","description":"SQ *SEABREEZE DELI 0922","amount":-18.6,
  "matches":[],"suggestedNameId":null,"suggestedAccountId":37,"suggestedPayee":"Seabreeze Deli", ...}]
```

| Field | Meaning |
|---|---|
| `amount` | Feed sign: `+` money in, `-` money out. |
| `checkNumber` | From the file. |
| `status` | `new` (For review), `added`, `matched`, `ignored` (Excluded). An added/matched line whose transaction was later deleted shows `new` again with `txnId: null`. |
| `txnId` | The linked transaction for `added` / `matched`. |
| `matches` | For `new`: register transactions it may match, best first. For `added`/`matched`: the linked transaction. Match amounts are in feed sign. |
| `suggestedNameId`, `suggestedAccountId`, `suggestedPayee` | For `new` only: the proposed payee and category. `suggestedPayee` is display text (a rule's "Show payee as" text or the payee's name). |

**How match candidates are found** (status `new` only): transactions already in this account's
register that are not reconciled, not already linked to another added/matched line of the
same account, with exactly the same amount, dated within 10 days. A transaction whose ref number
equals the line's check number comes first, then the closest date. A transfer or card payment can
be matched once in each of the two accounts' feeds.

**How suggestions are made** (status `new`; computed on every request, never stored, never
applied automatically), first rule that applies wins:
1. **Bank rules**, lowest `priority` first (then lowest id): the rule's account is empty or this
   account, its direction fits the sign, and the description contains its `matchText`
   (case-insensitive, plain substring). Payee = the rule's `nameId`; category = the rule's
   `targetAccountId`, or when the rule has a payee but no category, the account last used with
   that payee.
2. An earlier line with exactly the same description that was **added**: same payee and the
   first line's account of that transaction.
3. A payee (any active customer, vendor, employee or other name of 3+ characters) whose name
   appears as whole words in the description; longest name wins; vendors preferred for money
   out, customers for money in. Category = the account last used with that payee on checks,
   deposits, card charges/credits or bills (not A/R, A/P or Undeposited Funds), else the vendor's
   prefill account.

### 3.4 POST /bank-feed-items/{id}/add

Creates a new transaction from a waiting line (status must be `new`) and links them.
Use this when the transaction is not in the register yet. If `matches` is not empty, match
instead (3.6), otherwise the transaction ends up twice in the books.

Body (`BankFeedAdd`):

| Field | Type | Required | Meaning |
|---|---|---|---|
| `accountId` | number | yes | The category: the account on the other side (expense, income, asset, liability, equity). A bank or credit card account makes a transfer. Usually `suggestedAccountId`. |
| `nameId` | number or null | no | Payee (customer, vendor, employee, other name). Usually `suggestedNameId`. `0` = none. Ignored for transfers. |
| `classId` | number or null | no | Class (from `GET /lists/class`). Goes on the line (on the transaction header for a transfer). |
| `memo` | string | no | Default: the bank description. Used as the transaction memo and the line description. |
| `refNumber` | string | no | Check/ref number. Default: the line's `checkNumber`. |

Response: `{"txnId": 1649}`. Unknown fields are ignored.

What is created (dated the bank line's date, amount = absolute bank amount):

| Feed account | Bank line | `accountId` is | Transaction created | Accounting effect |
|---|---|---|---|---|
| Bank | money out | not bank/card | Check (`CHK`), payee on header, one expense line | Bank down; category up (e.g. expense up) |
| Bank | money in | not bank/card | Deposit (`DEP`), payee on header and on the line ("received from") | Bank up; category credited (e.g. income up) |
| Credit card | charge (`-`) | not bank/card | Credit Card Charge (`CCCHARGE`) | Amount owed up; expense up |
| Credit card | payment/refund (`+`) | not bank/card | Credit Card Credit (`CCCREDIT`) | Amount owed down; category credited |
| Bank or card | either | another bank/card account | Transfer (`TRANSFER`), no payee | Money moves between the two accounts (out of the feed account for money out, into it for money in) |

The new transaction is an ordinary transaction (open, edit or delete it with the transaction
routes). It is **not** marked cleared: adding or matching never changes cleared marks.

```
curl -s -X POST $B/bank-feed-items/30/add -H 'Content-Type: application/json' \
  -d '{"accountId":37,"memo":"Lunch with crew"}'
{"txnId":1649}
```

Errors:

| Error | Meaning / what to do |
|---|---|
| 400 Please choose an account for this transaction. (`accountId`) | `accountId` missing or 0. |
| 400 Choose a different account: the money cannot move from Checking to itself. | Category is the feed account itself. |
| 400 Line 1: you cannot use the Accounts Receivable account ... Use a customer transaction instead. (`lines`) | A/R or A/P as category. Customer payments and bill payments are entered with Receive Payments / Pay Bills, then the bank line is matched to them (or to the deposit). |
| 400 A transaction with a zero amount cannot be added. | Zero line: ignore it. |
| 400 The name you selected no longer exists... (`nameId`) / Line 1: the selected class or payment method no longer exists. | Bad id. |
| 409 This downloaded transaction has already been added/matched/ignored. Undo it first. | Status is not `new`. |
| 409 confirm, warning `dupnum`: Check number 2259 has already been used in Checking... | Repeat with `?accept=dupnum`, or send another `refNumber`. |
| 403 closing_date | The date is on or before the closing date (header `X-Closing-Password`). |
| 404 Downloaded transaction not found. | Bad item id. |

### 3.5 Splitting one bank line over several accounts

There is no split option in `/add`. The Bank Imports screen does it in two steps, and so should
the assistant:
1. Create the transaction with `POST /txns` (type `CHK` for bank money out, `DEP` for bank money
   in, `CCCHARGE` / `CCCREDIT` for a card), dated the bank date, `accountId` = feed account, line
   amounts adding up to the absolute bank amount, and `"extra":{"bankFeedSplit":<item id>}`.
2. Match the line to it: `POST /bank-feed-items/{id}/match {"txnId": <new id>}`.

```
curl -s -X POST $B/txns -H 'Content-Type: application/json' -d '{"type":"CHK","date":"2026-10-14",
  "accountId":1,"nameId":20,"memo":"HARBOR HARDWARE #12 PURCHASE","extra":{"bankFeedSplit":12},
  "lines":[{"kind":"expense","accountId":56,"amount":50,"description":"Shovels"},
           {"kind":"expense","accountId":41,"amount":36.43,"description":"Gate repair parts"}]}'
curl -s -X POST $B/bank-feed-items/12/match -H 'Content-Type: application/json' -d '{"txnId":1661}'
```

The status is then `matched` (the screen shows "Added (split)" because of `extra.bankFeedSplit`).
Undo (3.8) only unlinks a matched line; to remove a split, undo the line and then
`DELETE /txns/{txnId}` (the screen does both).

### 3.6 POST /bank-feed-items/{id}/match

Links a waiting line (status `new`) to a transaction already in the register. Nothing is
created or changed in the books.

Body: `{"txnId": 1493}` (usually `matches[0].txnId`).

```
curl -s -X POST $B/bank-feed-items/28/match -H 'Content-Type: application/json' -d '{"txnId":1493}'
{"ok":true,"txnId":1493}
```

| Error | Meaning |
|---|---|
| 400 Please choose the register transaction to match. (`txnId`) | Missing id. |
| 400 The selected transaction is not in the Checking register. | That transaction does not post to the feed account. |
| 409 The selected transaction is already matched to another downloaded transaction. | Linked to another line of this account. |
| 409 confirm (no warning kind): The amount of the register transaction (-1,953.52) is different from the downloaded amount (-128.35). Do you want to match them anyway? | Usually the wrong transaction. If the user confirms, repeat with `?force=1`. Better: correct the register transaction first. |
| 409 This downloaded transaction has already been ... Undo it first. | Status is not `new`. |

A reconciled transaction is never offered in `matches`, but can still be matched by id.

### 3.7 POST /bank-feed-items/{id}/ignore

No body. Moves a `new` line to Excluded (`ignored`). Use for lines that are not business
transactions, duplicates, or lines already handled another way. Ignoring an ignored line is fine
(`{"ok":true}`); an added or matched line gives 409 "... Undo it first."

### 3.8 POST /bank-feed-items/{id}/undo

No body. Puts any line back to `new` (For review).

| Status before | What undo does |
|---|---|
| `added` | Deletes the transaction that `/add` created, unless one of its entries is reconciled (then the transaction stays and is only unlinked). |
| `matched` | Only unlinks; the register transaction stays (also for splits, see 3.5). |
| `ignored` | Back to `new`. |
| `new` | Nothing (still `{"ok":true}`). |

Response: `{"ok":true,"deleted":true}` (`deleted` = a transaction was deleted).

```
curl -s -X POST $B/bank-feed-items/32/undo
{"deleted":true,"ok":true}
```

Pitfall: after undoing an `added` line whose transaction was reconciled (`deleted:false`), do not
add it again, or the transaction is duplicated; match it to the existing transaction instead.

### 3.9 Recipe: review a bank download

1. `GET /bank-feeds/accounts` to find the account id. If the user has a file, import it
   (3.2). For a card CSV, look at the first rows: if purchases are positive numbers, send
   `flipSigns=1`; otherwise send `flipSigns=0`.
2. `GET /bank-feeds/{accountId}/items?status=new`.
3. For each line:
   - `matches` not empty: confirm the first match looks right (same payee/date), then
     `/match` with that `txnId`.
   - Else if `suggestedAccountId` is set: `/add` with `accountId=suggestedAccountId` and
     `nameId=suggestedNameId`.
   - Else ask the user what it was (payee and category), then `/add`. Customer payments and bill
     payments should not be added with `/add` (A/R and A/P are refused): enter them with
     Receive Payments / Pay Bills (or the deposit), then match.
   - Personal, duplicate or already-handled lines: `/ignore`.
4. When the same kind of line keeps coming back, create a bank rule (section 4) so next time it
   is suggested automatically.
5. Show the user what was done (count added / matched / ignored), and how to undo.

---

## 4. Bank rules

Rules turn bank descriptions into suggestions (payee and category) in Bank Imports. They never
add anything by themselves: there is no auto-add. A rule only fills `suggestedNameId`,
`suggestedAccountId`, `suggestedPayee` of waiting lines, and the user (or assistant) still adds
each line. Rules apply immediately to every line still waiting, including lines imported before
the rule existed.

### 4.1 Rule object and how rules apply

| Field | Type | Meaning (screen label) |
|---|---|---|
| `id` | number | Read only. |
| `name` | string | "Rule name". Blank = the match text. |
| `accountId` | number or null | "Applies to": the bank/card account it looks at. `null` = all accounts. Must be a bank or credit card account. |
| `matchText` | string, required | "Bank text contains": case-insensitive plain substring of the bank description (`DELI` also matches `DELIVERY`). |
| `direction` | `"any"` (default), `"in"`, `"out"` | "Money": which sign of bank line it applies to. |
| `nameId` | number or null | "Payee" suggested. |
| `targetAccountId` | number or null | "Category (account)" suggested. Cannot be A/R or A/P. A bank or card account here means the line will be added as a transfer (e.g. card payments from checking). If empty and a payee is set, the account last used with that payee is suggested. |
| `renameTo` | string | "Show payee as": text shown instead of the bank description in Bank Imports. Display only; it does not create or rename a payee. Send `nameId` when adding. |
| `priority` | integer, default 0 | When several rules match, the **lowest number wins** (ties: oldest rule). The screen gives a new rule the highest existing number + 1. |

### 4.2 Rule endpoints (CRUD)

- `GET /bank-rules`: all rules, sorted by priority then id.
- `POST /bank-rules`: create. Returns **201** with the stored rule.
- `PUT /bank-rules/{id}`: update. Only the fields sent change (the body is merged into the stored
  rule); send `null` to clear `accountId`, `nameId` or `targetAccountId`. Returns the rule.
- `DELETE /bank-rules/{id}`: 204. 404 "Bank rule not found." if missing.

```
curl -s -X POST $B/bank-rules -H 'Content-Type: application/json' -d '{"name":"Seabreeze Deli",
  "matchText":"SEABREEZE DELI","direction":"out","accountId":1,"renameTo":"Seabreeze Deli",
  "targetAccountId":37,"priority":5}'
{"id":5,"name":"Seabreeze Deli","accountId":1,"matchText":"SEABREEZE DELI","direction":"out",
 "renameTo":"Seabreeze Deli","nameId":null,"targetAccountId":37,"priority":5}

curl -s -X PUT $B/bank-rules/5 -H 'Content-Type: application/json' -d '{"priority":1}'
```

Verified: with this rule, a later OFX import line "SQ *SEABREEZE DELI 0922" came in with
`suggestedAccountId: 37` and `suggestedPayee: "Seabreeze Deli"`; a rule with a lower priority
number that also matched took over as soon as its priority was changed.

Validation errors (400): "Please enter the text the bank description must contain."
(`matchText`); "Invalid direction "both" (any, in or out)."; "Bank imports can only be used with
bank and credit card accounts." (`accountId` not a bank/card); "A bank rule cannot assign
Accounts Receivable or Accounts Payable." (`targetAccountId`); "The payee of the rule does not
exist." (`nameId`); "The account of the rule does not exist."

### 4.3 Rule suggestions

`GET /bank-rules/suggestions` proposes rules from how past bank and card transactions were
categorized; `POST /bank-rules/suggestions/dismiss` hides one for good. The Bank Rules window
shows them above the list with **Add rule**, **Review...** and **Dismiss**. (The same logic is
offered by the QuickBooks Desktop import.)

What it looks at: checks, credit card charges and credits, and deposits in bank or card
accounts that are not voided, not pending and not opening balances. Transactions that went to
A/R, A/P, Undeposited Funds or a non-posting account are left out (those are matched in Bank
Feeds, not ruled).

How it decides:
- **Groups**: same payee and direction; for transactions without a payee, the first two
  meaningful words of the bank description (generic words such as POS, ACH, DEBIT, CARD, PAYMENT,
  INC, LLC are skipped), else of the memo.
- A group needs **3 or more transactions on at least 2 different dates**, and **80% or more
  of them in the same account** (the "category"; an account must take 90% of a transaction's
  amount to count).
- **Match text**, in this order: words shared by the downloaded bank descriptions behind the
  group (`matchFrom: "bank"`), else bank-like memos (`"memo"`), else the payee's name without
  legal suffixes like LLC or Inc (`"name"`; the bank may print it differently, so check it
  against real bank text before relying on it). A bank or memo text is used only if, among all
  transactions containing it, at least 80% went to the same account.
- Skipped when an existing rule already covers the group (same text, same payee, or its text
  is found in half of the group), or when the key was dismissed.
- `confidence: "high"` when the text comes from bank/memo with 4+ transactions and 95%+ share,
  or from the name with 6+ transactions, 100% share, over 3+ months; otherwise `"medium"`.
- Sorted high confidence first, then by count; at most 50.

```
curl -s $B/bank-rules/suggestions
{"suggestions":[{"key":"out|seabreeze deli",
  "rule":{"id":0,"name":"SEABREEZE DELI","accountId":1,"matchText":"SEABREEZE DELI","direction":"out",
          "renameTo":"","nameId":null,"targetAccountId":37,"priority":0},
  "payee":"","category":"Meals and Entertainment","accountName":"Checking","matchFrom":"bank",
  "count":3,"matching":3,"total":73.75,"first":"2026-09-08","last":"2026-09-22",
  "confidence":"medium",
  "reason":"3 of 3 downloaded payments whose bank text contains \"SEABREEZE DELI\" were classified as Meals and Entertainment.",
  "others":[],"examples":[{"txnId":1655,"date":"2026-09-22","amount":18.6,"text":"SQ *SEABREEZE DELI 0922"}, ...]}]}
```

| Field | Meaning |
|---|---|
| `key` | Stable id (`direction|text`), used to dismiss. |
| `rule` | The rule to create (`id` 0, `priority` 0). `accountId` is set when all transactions came from one account. |
| `payee`, `category`, `accountName` | Display names of the rule's payee, category and account. |
| `count`, `matching` | Transactions in the pattern, and how many went to `category`. |
| `total`, `first`, `last` | Their total amount (positive) and date range. |
| `others` | Other categories used in the pattern, with counts ("Split over several accounts" for splits). |
| `examples` | Up to 3 latest transactions (`text` = bank description, memo or payee). |

To accept a suggestion: show the user `reason` and `rule`, then `POST /bank-rules` with
`suggestion.rule`, setting `priority` to (highest existing priority + 1) as the screen does.
It then disappears from the suggestions.

`POST /bank-rules/suggestions/dismiss` body `{"key":"out|seabreeze deli"}` returns 204; empty key
gives 400 "Choose the suggestion to dismiss." Dismissed keys are stored in the company file and
there is **no endpoint to bring a dismissed suggestion back** (the user can still create the
rule by hand).

The sample company's suggestions include payments to the owner (Owners Draw) and card payments
(category = the credit card account). These are valid patterns, but confirm with the user before
creating rules from them.

---

## 5. Registers and cleared marks

### 5.1 GET /registers/{accountId}

The account register: one row per transaction with a running balance.

| Query | Meaning |
|---|---|
| `from`, `to` | Optional `YYYY-MM-DD`. Bad date: 400 `Invalid date "2026-13-01" (use YYYY-MM-DD).` (field `from`/`to`). |
| `nameId` | Only entries of that name (the running balance then only adds those entries). |
| `includeJobs` | With `nameId` of a customer: include its jobs. |

The register screen's type, cleared-status and text filters are done in the screen, not by the
server.

```
curl -s "$B/registers/1?from=2026-09-01&to=2026-09-30"
{"account":{"id":1,"fullName":"Checking","type":"Bank","balance":45942.95, ...},
 "increaseLabel":"DEPOSIT","decreaseLabel":"PAYMENT","endingBalance":50099.59,
 "rows":[{"txnId":1493,"glId":6023,"date":"2026-09-01","refNumber":"","type":"CHK","typeAbbrev":"CHK",
          "nameId":9,"nameFull":"Marina Properties LLC","otherAccount":"Rent Expense",
          "memo":"Yard and office rent (autopay)","increase":0,"decrease":3200,"cleared":"",
          "balance":55144.83,"dueDate":"","openBalance":0,"voided":false}, ...]}
```

| Field | Meaning |
|---|---|
| `account` | The account with `balance` (today, all dates, including subaccounts) and `ownBalance`. |
| `increaseLabel` / `decreaseLabel` | Column names: Bank DEPOSIT/PAYMENT; Credit Card CHARGE/PAYMENT; A/R AMT CHRG/AMT PAID; A/P BILLED/PAID; other INCREASE/DECREASE. |
| `rows[].glId` | First ledger entry of the transaction in this account (use it for cleared marks). |
| `rows[].increase` / `decrease` | Natural-sign amount of the transaction in this account (entries summed). |
| `rows[].balance` | Running balance after the row; it starts from the balance before `from`. |
| `rows[].otherAccount` | The other account, or `-split-` when there are several. |
| `rows[].cleared` | `""`, `"*"` (cleared), `"R"` (reconciled). |
| `rows[].voided` | Voided transactions are listed with zero amounts. |
| `rows[].dueDate`, `openBalance` | Only for A/R and A/P registers. |
| `endingBalance` | Balance after the last row (with `to`, the balance at that date). |

Rows are sorted by date, then ref number, then id. The route works for any account, but the app
only opens registers for balance sheet accounts (use reports for income and expense accounts).

### 5.2 PUT /gl/{id}/cleared

Sets the cleared mark of a register entry (the check mark column in the register; also its
right-click menu "Mark as cleared" / "Mark as uncleared").

Body: `{"cleared": "*"}` (cleared) or `{"cleared": ""}` (uncleared). `"R"` cannot be set
directly; only finishing a reconciliation does that (400 `Cleared status must be blank or "*".`).

- `{id}` is a `glId`. The mark applies to every entry the transaction posted to that account.
- An entry marked `"*"` shows as already marked in the Reconcile window.
- **Reconciled entry:** the server asks first:
  `{"code":"confirm","warning":"reconciled","error":"This transaction has been reconciled. Changing its cleared status will change the beginning balance of your next reconciliation; the previous reconciliation report will list it as a change. Do you want to continue?"}`.
  With `?accept=reconciled` the entry leaves its reconciliation: the next beginning balance
  changes by its amount and the discrepancy report lists it as "Uncleared". Only do this if the
  user understands it.
- 404 "Ledger entry not found." for a bad id.

```
curl -s -X PUT $B/gl/6023/cleared -H 'Content-Type: application/json' -d '{"cleared":"*"}'
{"cleared":"*","ok":true}
```

---

## 6. Reconcile

### 6.1 Concepts

- Reconciling proves that the register agrees with the bank statement. Bank, credit card and other
  balance sheet accounts can be reconciled; A/R and A/P cannot (400 "... cannot be reconciled.
  Choose a bank, credit card or other balance sheet account ...").
- **Beginning balance** = total of every entry already reconciled (`R`) in the account. It should
  equal the statement's beginning balance. It is 0 for an account never reconciled (then the first
  statement must include the opening balance entry).
- **Cleared balance** = beginning balance + the natural-sign amounts of the entries marked for
  this statement + the service charge and interest entered on the Start Reconciling step
  (bank: minus service charge, plus interest; credit card: plus finance charge, minus credit).
- **Difference** = statement ending balance - cleared balance. It must be **0.00** to finish
  (unless an adjustment is entered on purpose).
- Natural sign: for a credit card, the ending balance is the amount owed (positive), charges are
  `+` and payments are `-`.
- Statement dates must increase: a new statement date must be after the last reconciliation's
  statement date. To redo an older one, undo the later reconciliations first (last one first).
- Only the account's **last** reconciliation can be undone.

### 6.2 GET /reconcile/{accountId}

Everything the Reconcile window needs.

```
curl -s $B/reconcile/1
{"account":{...},"lastStatementDate":"2026-08-31","beginningBalance":59064.83,
 "lastEndingBalance":59064.83,"draft":null,
 "entries":[{"glId":5963,"txnId":1480,"type":"BILLPMT","typeLabel":"Bill Pmt -Check","date":"2026-08-28",
             "refNumber":"2257","nameFull":"Treeline Arborists","memo":"","amount":-720,"cleared":""}, ...]}
```

| Field | Meaning |
|---|---|
| `beginningBalance` | Sum of reconciled entries (natural sign). |
| `lastStatementDate`, `lastEndingBalance` | Of the last reconciliation (`""` / `null` if never). If `beginningBalance` differs from `lastEndingBalance`, reconciled transactions were changed, unmarked or deleted since: see 6.7 before going on. |
| `draft` | Saved work in progress (6.3) or `null`. `draft.markedGlIds` = entries currently marked `"*"`. |
| `entries` | **Every** entry of the account that is not reconciled, all dates (also after the statement date), in natural sign. `cleared: "*"` = already marked. |

### 6.3 PUT /reconcile/{accountId}/draft

Saves the statement header and marks so the user can finish later ("Save for later" in the
Reconcile window; "Continue" in Start Reconciling also saves the header this way). Nothing is
posted.

Body (`ReconcileDraft`):

| Field | Type | Meaning |
|---|---|---|
| `statementDate` | `YYYY-MM-DD` or `""` | Must be after the last reconciliation's statement date. |
| `endingBalance` | number | Statement ending balance. |
| `serviceCharge` | `{amount,date,accountId,classId}` or null | Service charge (finance charge for a card). Stored only, not posted. |
| `interest` | same, or null | Interest earned. Stored only. |
| `markedGlIds` | number[] or absent | Replaces all `"*"` marks of the account with exactly these entries. `[]` clears all marks. **Absent or null keeps the current marks.** |

Returns `{"ok":true}`. Errors: invalid date; "This statement date is not after your last
reconciliation (08/31/2026). Choose a later date, or undo the last reconciliation first.";
"A marked entry (id N) does not belong to this account." / "... has already been reconciled."

Pitfall (verified): the header fields are replaced as a whole. A draft sent without
`serviceCharge` / `interest` erases the ones saved before. Always send the full draft.

### 6.4 POST /reconcile/{accountId}/finish

"Finish now" / "Reconcile Now". Body (`ReconcileFinish`):

| Field | Type | Required | Meaning |
|---|---|---|---|
| `statementDate` | `YYYY-MM-DD` | yes | After the last reconciliation's date. |
| `endingBalance` | number | yes | From the statement (natural sign; card = amount owed). |
| `clearedGlIds` | number[] | yes | The entries that appear on the statement. **Only these are reconciled**: entries marked `"*"` but not listed here become uncleared. Include entries from earlier dates that cleared now. |
| `serviceCharge` | `{amount, date, accountId, classId}` or null | no | Not yet entered fee from the statement. `amount` >= 0, `accountId` required when amount is not 0 (e.g. Bank Service Charges), `date` defaults to the statement date. |
| `interest` | same, or null | no | Interest earned not yet entered (e.g. account Interest Income). |
| `enterAdjustment` | boolean | no | Only when the difference is not 0 and the user agreed: posts a balance adjustment for the difference. |

What finishing does:
1. Enters the service charge and interest as new transactions, already reconciled:
   - Bank: service charge = Check (memo "Service Charge"): bank down, expense up. Interest =
     Deposit (memo "Interest Earned"): bank up, income up.
   - Credit card: service charge = Credit Card Charge (memo "Finance Charge"): owed up, expense
     up. Interest = Credit Card Credit (memo "Interest Earned").
   - Other balance sheet accounts: General Journal entries.
2. Checks the difference. Not zero and `enterAdjustment` false: 400 (nothing is saved, not even the
   service charge):
   `The difference between the statement ending balance (52,174.81) and the cleared balance (52,183.60) is -8.79. Mark the missing transactions, correct the ending balance, or enter an adjustment for the difference.`
   (difference = ending - cleared).
3. With `enterAdjustment: true`: posts a General Journal "Balance Adjustment" dated the statement
   date between the account and the Expense account **Reconciliation Discrepancies** (created if
   missing). This hides the problem rather than solving it; only use it when the user decides so.
4. Marks the listed entries (plus those from steps 1 and 3) `R`, stores a snapshot for the report,
   clears leftover `"*"` marks, deletes the draft.

Response (`Reconciliation`):
```
curl -s -X POST $B/reconcile/1/finish -H 'Content-Type: application/json' -d '{"statementDate":"2026-09-30",
  "endingBalance":52174.81,"clearedGlIds":[5932,5963,6023, ...],
  "serviceCharge":{"amount":12,"date":"2026-09-30","accountId":31,"classId":null},
  "interest":{"amount":3.21,"date":"","accountId":47,"classId":null}}'
{"id":18,"accountId":1,"accountName":"Checking","statementDate":"2026-09-30","beginningBalance":62064.83,
 "endingBalance":52174.81,"clearedBalance":52174.81,"completedAt":"2026-10-21T02:38:41Z","completedBy":"Admin"}
```

Other errors: "Please choose an account for the service charge." (`serviceCharge.accountId`);
"The service charge amount cannot be negative."; "A marked entry (id N) does not belong to this
account." / "... has already been reconciled." / "A marked transaction no longer exists. Close the
reconcile window and start again." (`clearedGlIds`); closing date (403) for adjustments dated in a
closed period.

In the app, after finishing a credit card reconciliation with a balance owed, a "Make Payment"
box offers to write a check now or enter a bill for later; then the user picks the report type
(summary, detail, both).

### 6.5 POST /reconcile/{accountId}/undo-last

No body. Un-reconciles the account's last reconciliation (latest statement date).

```
curl -s -X POST $B/reconcile/1/undo-last
{"ok":true,"reconciliationId":18,"statementDate":"2026-09-30"}
```

- Every entry it reconciled becomes **uncleared** (`""`, not `"*"`), so the next Reconcile starts
  with nothing marked for that statement.
- The reconciliation and its report are deleted (404 afterwards). Reconciliation ids can be
  reused later; do not keep old ids.
- **Service charge, interest and adjustment transactions it entered stay in the register.** When
  redoing the statement, do not enter them again: mark those entries instead (or delete them if
  they were wrong).
- 409 "This account has no previous reconciliation to undo." when there is none.

### 6.6 GET /reconciliations and the report

`GET /reconciliations?accountId=1` (account optional): list, newest statement first, each like the
finish response.

`GET /reconciliations/{id}/report`:
```
{"reconciliation":{...},
 "cleared":[{"glId":5932,"txnId":1472,"type":"CHK","typeLabel":"Check","date":"2026-08-25","refNumber":"2256",
             "nameFull":"Dana Whitfield","memo":"Owner draw","amount":-3000,"cleared":"R"}, ...],
 "uncleared":[{"glId":6236,"txnId":1553,"typeLabel":"Bill Pmt -Check","date":"2026-09-23","refNumber":"2268",
               "nameFull":"Harborview Water Department","amount":-364.01,"cleared":""}, ...],
 "clearedIncrease":17047.87,"clearedDecrease":26937.89,"registerBalance":50090.8,"changes":[]}
```

| Field | Meaning |
|---|---|
| `cleared` | What this reconciliation cleared, with the amounts as they were when reconciled. |
| `uncleared` | Entries dated on or before the statement date that it did not clear (still open, or cleared by a later reconciliation): the outstanding checks and deposits. |
| `clearedIncrease` / `clearedDecrease` | Totals of cleared deposits/charges and of cleared payments. |
| `registerBalance` | Register balance at the statement date (= cleared balance - outstanding items). |
| `changes` | Transactions of this reconciliation changed afterwards (same shape as 6.7). |

404 "Reconciliation not found." for a bad id. In the app: Banking > Previous Reconciliation
reports..., then pick the account and statement (Summary, Detail or both).

### 6.7 GET /reconcile/{accountId}/discrepancies

The "Previous Reconciliation Discrepancy" report: reconciled transactions that were changed after
being reconciled.

```
curl -s $B/reconcile/1/discrepancies
{"accountId":1,"accountName":"Checking","lastStatementDate":"2026-08-31","lastEndingBalance":59064.83,
 "beginningBalance":62064.83,"difference":3000,
 "changes":[{"reconciliationId":17,"statementDate":"2026-08-31","txnId":1472,"type":"CHK","typeLabel":"Check",
   "date":"2026-08-25","refNumber":"2256","nameFull":"Dana Whitfield","reconciledAmount":-3000,
   "currentAmount":0,"change":"Uncleared","effect":3000}]}
```

| Field | Meaning |
|---|---|
| `difference` | `beginningBalance - lastEndingBalance`. Not 0 means the next reconciliation will not start where the statement does. |
| `changes[].change` | `Amount changed`, `Uncleared`, `Voided` or `Deleted`. |
| `changes[].reconciledAmount` / `currentAmount` | Natural sign, then and now (0 when unmarked or deleted). |
| `changes[].effect` | `currentAmount - reconciledAmount`: how much it moved the beginning balance. |

The list is historical: a change stays listed under its old reconciliation even after it was put
right in a later one (verified: an unmarked check re-reconciled in the next statement still showed
as "Uncleared" under the old one, while `difference` was back to 0). Use `difference` to know
whether the problem is still open.

Changing a reconciled transaction always asks first (`warning: "reconciled"`): editing its amount
or account (`PUT /txns/{id}`), deleting it, voiding it, or unmarking it (5.2).

### 6.8 Recipe: reconcile one statement

Screen steps for the user: Banking > Reconcile... > choose the account, enter Statement date and
Ending balance (and any service charge / interest with their accounts) > Continue > tick each
transaction that is on the statement (tabs "Checks and payments" / "Deposits and other credits";
"Hide after statement date"; "Mark all") until Difference is 0.00 > Finish now > pick a report.

API steps:
1. Get from the user (or the statement): statement date, ending balance, service charge and
   interest amounts if any. Ask for the statement's beginning balance too, to compare.
2. `GET /reconcile/{accountId}`. If `beginningBalance` is not the statement's beginning balance,
   stop and go to 6.9 (step 1).
3. If the bank's transactions for the period were imported, finish Bank Imports first (3.9): every
   bank line then points to a register transaction (`txnId`), which tells exactly which entries to
   mark: for each feed item dated in the statement period with status `added` or `matched`, mark the
   `entries` with that `txnId`. Otherwise go through the statement with the user line by line,
   matching by amount, check number and date.
4. Compute cleared balance and difference yourself (6.1) before sending. Optionally save progress
   with `PUT .../draft` (full body).
5. Difference 0: `POST .../finish`. Show the result, and offer the report
   (`GET /reconciliations/{id}/report`): its `uncleared` list is the outstanding items.
6. Difference not 0: do not send `enterAdjustment` on your own. Use 6.9 and ask the user.

Note: a bank line for a fee or interest that was entered through the reconcile step (already
reconciled) is not offered as a match in Bank Imports; match it by id or ignore it. Doing Bank
Imports before reconciling avoids this.

### 6.9 Recipe: find a reconciliation difference

Work through these in order and tell the user what each check found.

1. **Beginning balance wrong** (`beginningBalance` from 6.2 is not the statement's beginning
   balance, or not equal to `lastEndingBalance`): `GET /reconcile/{accountId}/discrepancies`.
   Each change shows what moved and by how much (`effect`). Fix by putting the transaction back
   (edit the amount back with `?accept=reconciled`, or re-create a deleted one), or by marking it
   again and including its `glId` in this reconciliation. If it cannot be sorted out, undo the last
   reconciliation(s) (6.5) and redo them. If the account was never reconciled, the beginning
   balance is 0 and the opening balance entry must be marked.
2. **Difference equals one transaction's amount**: a statement line not marked, or a marked line
   not on the statement (often one dated after the statement date, or a check that has not cleared
   the bank yet).
3. **Difference is twice an amount**: a transaction entered with the wrong direction (a deposit
   entered as a payment, or the reverse), or a card CSV imported with the wrong `flipSigns`.
4. **Difference divisible by 9**: likely two digits swapped in an amount (e.g. 56.10 typed as
   65.10). Compare amounts with the statement.
5. **Missing bank items**: fees, interest, automatic payments or deposits on the statement that are
   not in the register. Enter them (service charge / interest fields, Bank Imports, or the forms).
6. **Duplicates**: the same transaction entered by hand and also added from Bank Imports. Look in
   the register (5.1) for two transactions with the same amount and close dates; undo the feed
   line (3.8) or delete the extra one.
7. **Counts and totals**: compare the number and total of checks/payments and of deposits marked
   with the statement's totals (the screen shows counts; compute from `entries`).
8. **Last resort**: with the user's agreement, `enterAdjustment: true` (6.4). Tell them it posts a
   journal entry to the "Reconciliation Discrepancies" expense account and that the difference
   should still be found later.

---

## 7. Pitfalls checklist

- Bank feed amounts are `+` in / `-` out; register and reconcile amounts are natural sign. A
  credit card bank line of `-42.50` is a charge, and the same charge is `+42.50` in reconcile.
- `/add` creates a transaction. If the line has `matches`, use `/match`, or the transaction is
  doubled.
- Rules and suggestions never add anything; they only fill the `suggested*` fields.
- `renameTo` is display text only; pass `nameId` to set the payee.
- `/add` cannot split and refuses A/R and A/P; see 3.5 and 3.9.
- Adding or matching does not mark anything cleared; reconcile does.
- CSV `flipSigns` / `dateOrder` sent once are remembered for the account and silently reused on
  later CSV files. Send `flipSigns` every time and check the response.
- An OFX import into an account with no account number saves the file's number onto that account.
- `PUT .../draft` without `serviceCharge`/`interest` erases them; without `markedGlIds` keeps the
  marks.
- `finish` reconciles only `clearedGlIds`; `"*"` marks not listed are dropped.
- `undo-last` leaves service charge, interest and adjustment transactions in the register, and
  unmarks everything (not back to `"*"`).
- Statement dates must increase; only the last reconciliation can be undone.
- Undoing an `added` line whose transaction is reconciled keeps the transaction (`deleted:false`);
  match it again instead of adding.
- The discrepancy list is historical; use `difference` to see if a problem is still open.
- Known bug (verified): a semicolon- or tab-separated CSV with a title line above the header
  fails with "The CSV file needs a header row...", because the separator is guessed from the first
  line only. Ask the user to delete the lines above the header, or save the file comma-separated.
