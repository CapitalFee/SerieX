# Workflows: multi-step jobs in SerieX

Recipes for the jobs users ask for most, each built from the single steps documented in the
other references. Commands use the helper (`python3 scripts/seriex.py ...`, shortened to
`sx` below); every write still follows the rules in SKILL.md (confirm first, back up before
bulk work, ask about SerieX's questions). In guide mode, give the same steps with the screen
paths from [app-guide.md](app-guide.md).

## Contents

1. [First look at a company (health check)](#1-first-look-at-a-company-health-check)
2. [Sort out a bank or credit card download](#2-sort-out-a-bank-or-credit-card-download)
3. [Customer money: invoice, payment, deposit](#3-customer-money-invoice-payment-deposit)
4. [Vendor money: bills and paying them](#4-vendor-money-bills-and-paying-them)
5. [Reconcile a statement](#5-reconcile-a-statement)
6. [Month-end close](#6-month-end-close)
7. [Sales tax for a period](#7-sales-tax-for-a-period)
8. [Year end](#8-year-end)
9. [Catching up months of bookkeeping](#9-catching-up-months-of-bookkeeping)
10. [Fixing common problems](#10-fixing-common-problems)
11. [Starting a new company](#11-starting-a-new-company)
12. [Bulk changes with a script](#12-bulk-changes-with-a-script)
13. [Telling the owner how the business is doing](#13-telling-the-owner-how-the-business-is-doing)

---

## 1. First look at a company (health check)

Use this when a user asks "can you look over my books", or before a bigger job. It only reads.

1. `sx status` and `sx get /company` (name, fiscal year start) and `sx get /prefs`
   (accounting basis, sales tax, inventory, Undeposited Funds use).
2. `sx get /closing-date`: is there a closing date, and how old is it?
3. `sx report balance_sheet asOf=<today>` and `sx report profit_loss dates=thisFiscalYearToDate`.
4. Look for these signals and note each one you find:

| Check | How | What it means |
|---|---|---|
| Money waiting in Undeposited Funds | `sx get /undeposited`; payments older than a couple of weeks | Payments never deposited, or the deposit was entered separately as income (double counting). |
| Uncategorized amounts | P&L rows "Uncategorized Income", "Uncategorized Expenses", "To Review with Accountant" | Categories still to decide. |
| Opening Balance Equity not zero | balance sheet | Setup balances never cleaned up (accountant). |
| Old open invoices | `sx report ar_aging_summary` (columns 61-90 and > 90) | Collections, or payments recorded without being applied. |
| Old open bills | `sx report ap_aging_summary` | Bills unpaid, or paid with a plain check (bill still open). |
| Bank lines waiting | `sx get /bank-feeds/accounts` (`newCount`) | Downloads not reviewed. |
| Last reconciliation per account | `sx get /reconciliations --fields accountName,statementDate` | Accounts not reconciled recently. |
| Reminders | `sx get /reminders` | Overdue invoices, bills due, memorized transactions due, to-dos. |
| Negative inventory | `sx report inventory_stock_status_by_item` (On Hand below 0) | Sales recorded before purchases, or missing purchases. |
| Odd dates | `sx get /txns from=<next year> to=9999-12-31 --limit 20` | Typos in years. |
| File health | `sx post /verify` (read-only check of the company file) | Damage or inconsistencies; see company-admin.md. |

5. Report back as a short list: what looks good, what needs attention (most important first),
   and what you can fix with their OK. Do not fix anything yet.

## 2. Sort out a bank or credit card download

The most useful job you can do: turning a bank file into categorized transactions without
duplicates. Details: [banking.md](banking.md) section 3.

1. Find the account: `sx get /bank-feeds/accounts`.
2. Import the user's file (this only stores lines to review, it creates no transactions):
   `sx upload /bank-feeds/<accountId>/import <file> --form flipSigns=0` (for a credit card CSV
   whose purchases are positive numbers, `flipSigns=1`). Report `imported`, `skipped`
   (duplicates) and `problems`.
3. Read the lines: `sx get /bank-feeds/<accountId>/items status=new --out lines.json`.
4. Build a proposal table, one row per line:
   - **Has `matches`**: propose *match* to the best one (same amount, close date, same payee).
     Adding it instead would record it twice.
   - **Has `suggestedAccountId`** (from a rule or past choices): propose *add* with that
     payee and account.
   - **Looks like a customer payment or a bill payment**: these cannot be added directly
     (Accounts Receivable and Accounts Payable are refused). Propose recording the payment
     with Receive Payments or Pay Bills, then matching the line to it.
   - **Transfers between the user's own accounts** (card payments, savings moves): add with
     the other bank or card account as the category; that makes a transfer. If the other
     account's download also has the line, match it there instead of adding it twice.
   - **Unknown**: look at the payee's history to guess (`sx get /names q=<payee words>`, then
     `sx report name_quickreport nameId=<id> dates=thisFiscalYearToDate`), mark your guess as
     a guess, and ask.
   - **Personal or duplicate lines**: propose *ignore*.
5. Show the table (date, description, amount, proposed action, payee, account) and ask for
   corrections. Then apply it line by line (`/add`, `/match`, `/ignore`), stopping at the first
   error to tell the user.
6. Offer bank rules for payees that recur (and look at `sx get /bank-rules/suggestions`), so
   the next download is suggested automatically. Rules only suggest; nothing is added by
   itself.
7. Summarize: counts added, matched and ignored, and how to undo one line
   (`/bank-feed-items/<id>/undo`).

## 3. Customer money: invoice, payment, deposit

Details: [transactions.md](transactions.md) sections 9, 12 and 15.

1. **Invoice.** Read the customer (terms, tax item, addresses) and the items (price,
   description, taxable); build lines with amount = quantity x rate; confirm; post `INV`; tell
   the user the invoice number, total, tax and due date.
2. **Payment.** `sx get /open-docs nameId=<customer> includeJobs=1` to see open invoices and
   credits. Confirm which invoices the money pays (and any early-payment discount). Post `PMT`
   with `amount`, `refNumber` (their check number), `paymentMethodId` and `links`. Money left
   over stays as a customer credit: say so.
3. **Deposit.** `sx get /undeposited` lists payments waiting. Group them the way the bank
   shows the deposit (one deposit per bank slip), confirm, and post `DEP` to the bank with one
   line per payment (`linkedTxnId`, exact `amount`).
4. A sale paid on the spot is one `SALESRCPT` (then deposit it like a payment).

## 4. Vendor money: bills and paying them

Details: [transactions-vendors-banking.md](transactions-vendors-banking.md).

1. **Bill.** Read the vendor (terms, address); expense lines (account) or item lines (items,
   for inventory); confirm; post `BILL`.
2. **What is due.** `sx get /open-docs kind=payable` or `sx report unpaid_bills_detail`.
   Point out bills with an early-payment discount still available.
3. **Pay.** Confirm which bills, from which account, the check numbers (or "to be printed"),
   discounts and credits. Then one `POST /pay-bills` call; it creates one payment per vendor.
4. Never pay an entered bill with a plain check to the expense account: the expense would
   count twice and the bill would stay open.

## 5. Reconcile a statement

Details and the exact requests: [banking.md](banking.md) sections 6.8 and 6.9. You need from
the user: the statement date, the ending balance, and any service charge or interest on it.

1. `sx get /reconcile/<accountId>` (beginning balance, entries not yet reconciled).
2. Mark the entries that appear on the statement (ask the user for the statement lines, or
   work from a bank download of the same period). Save a draft as you go.
3. The difference must reach 0.00. If it does not, look for: an amount typed wrong (a
   difference divisible by 9 often means two digits swapped), a missing fee or deposit, an
   entry marked twice, an entry from the next statement period, or a change to an earlier
   reconciled entry (the discrepancy report).
4. Finish only at 0.00, unless the user, knowing what it means, asks for a balance
   adjustment. Then show them the reconciliation report.

## 6. Month-end close

Walk the user through these in order, doing the reading for them:

1. All bank and card downloads reviewed (section 2).
2. Every bank and credit card account reconciled to the statement (section 5).
3. Undeposited Funds holds only payments really waiting for the bank.
4. Uncategorized Income, Uncategorized Expenses and To Review with Accountant are empty, or the user
   chose to leave items for the accountant.
5. A/R and A/P aging look right (no paid invoices still open, no bills paid twice).
6. Memorized and recurring transactions for the month are entered (`sx get /reminders`).
7. Sales tax for the period, if due (section 7). Payroll taxes paid (payroll.md).
8. Run the month's `profit_loss` and `balance_sheet` and compare with the prior month
   (`profit_loss_prev_period`); explain anything unusual.
9. Back up. Optionally, an administrator sets a closing date at the end of the month so
   finished months cannot change by accident ([company-admin.md](company-admin.md)). Setting a
   closing date is a choice for the user, not for you.

## 7. Sales tax for a period

1. `sx report sales_tax_liability from=<start> to=<end>` for the period the user files
   (basis follows the sales tax preference). Use the per-agency "tax collected" figures; the
   report's "Total Sales" column can count a sale once per tax item of a group, so do not
   quote that grand total as the company's sales.
2. The user files the return with the tax agency themselves (SerieX does not file).
3. `sx get /sales-tax/due` shows what is owed per tax item. Confirm the amount, then post a
   `TAXPMT` (one line per tax item, `extra.salesTaxThrough` = end of the period); see
   [transactions-vendors-banking.md](transactions-vendors-banking.md).
4. Never record a sales tax payment as an expense check.

## 8. Year end

1. Finish month-end for December (or the last month of the fiscal year).
2. Count inventory (`sx report physical_inventory_worksheet`) and record differences with an
   inventory adjustment.
3. 1099s: `sx report 1099_summary from=<Jan 1> to=<Dec 31>` and `1099_detail`. Check that
   vendors who need a 1099 are marked as 1099 vendors with a tax id (lists.md). SerieX
   prepares the figures; the user files.
4. Payroll year end in SerieX Payroll: W-2, W-3, Form 940, the fourth quarter Form 941
   ([payroll.md](payroll.md)).
5. Give the accountant: `trial_balance`, `balance_sheet`, `profit_loss`, `general_ledger`,
   `ar_aging_detail`, `ap_aging_detail`, and the 1099 reports, for the full year (exported to
   CSV or printed from the report window). A company backup copy is also useful.
6. After the accountant is done: their adjusting journal entries, then an administrator may
   set the closing date to the last day of the year. Retained Earnings rolls forward by
   itself; no closing entry is needed.

## 9. Catching up months of bookkeeping

When the books are months behind:

1. Back up. Agree with the user on the start date and which accounts to catch up.
2. Get statements and downloads for every bank and card account for the whole period.
3. Enter invoices and bills that exist on paper first (so payments can be applied to them),
   oldest first.
4. Import and sort the downloads month by month (section 2), matching payments to the
   invoices and bills from step 3.
5. Reconcile each account month by month, oldest first (section 5). Statement dates must
   increase, so do not skip a month.
6. Run the health check (section 1) at the end and list what is left for the user or the
   accountant.

## 10. Fixing common problems

Always explain the problem, show what you will change, and get a yes. Back up first when
more than a few transactions change.

| Problem | Fix |
|---|---|
| Payment received and the same money also deposited to income | Edit the deposit so its line is the payment from Undeposited Funds (or delete the extra deposit if a correct one exists); the invoice must show as paid. Check the bank reconciliation is unaffected. |
| Bill paid with a plain check | Change the check into a bill payment: delete or void the check and pay the bill with Pay Bills using the same date, number and amount (if the check was reconciled, ask the user and keep the date and amount the same). |
| Duplicate transaction | Confirm both copies are the same (date, amount, payee, number), then delete the copy that is not reconciled or deposited. |
| Payment not applied to an invoice | Edit the payment and add the `links` to the invoice. |
| Customer credit sitting unused | Apply it to an open invoice (edit the credit memo's `links`, or apply it on the next payment), or refund it. |
| Transaction in the wrong account or class | Edit the line's account or class (PUT the whole transaction). If reconciled, a change of account only on the other side (the expense line, not the bank line) does not affect the reconciliation. |
| Wrong year typed | Edit the date. Check the closing date first; a closed period is the user's to change. |
| Negative inventory | Find the missing purchases (bills or receipts) and enter them with the right dates; adjust only if the stock really was lost. |

## 11. Starting a new company

Details: [company-admin.md](company-admin.md) and [lists.md](lists.md).

1. Pick the business template closest to the user's business and create the company.
2. Company info and preferences: fiscal year start, the basis they report on, sales tax on or
   off (and its agencies and rates as sales tax items), inventory on or off, classes.
3. Choose a start date (often the first day of a month or year). Gather as of that date: bank
   and card statement balances, loans, open customer invoices, unpaid bills, inventory counts.
4. Review the chart of accounts with the user; add or rename accounts.
5. Import lists from CSV in this order: accounts, vendors, customers, items (lists.md, CSV
   section). CSV cannot carry opening balances.
6. Opening balances: on new balance sheet accounts (they go to Opening Balance Equity);
   customers and vendors get opening balance invoices and bills; inventory parts get their
   starting quantity and value. Better: enter each open invoice and bill itself, so aging is
   right.
7. Import bank downloads from the start date and sort them (section 2).
8. Reconcile the first statement after the start date.

Moving from QuickBooks Desktop has its own guided import (File > Utilities > Import >
QuickBooks® Desktop (IIF files)...); see [company-admin.md](company-admin.md).

## 12. Bulk changes with a script

For many similar changes (re-categorizing a vendor's year of expenses, renaming many items),
use the helper as a Python module instead of running it once per record:

```python
import sys; sys.path.insert(0, "scripts")   # this skill's scripts folder
import seriex
c = seriex.Client("books", None)            # or seriex.Client("books", "<company id>")
txn = c.call_json("GET", "/txns/1571")
# ... change txn ...
saved = c.call_json("PUT", "/txns/1571", body=json.dumps(txn).encode())
```

`call_json` raises `seriex.Fail` with the same plain explanation the command prints. Rules
for bulk work:

1. Back up first (`sx backup`).
2. Build the full list of changes first and show it (or a summary plus a file) to the user;
   one yes covers that exact list, nothing more.
3. Read each record right before changing it and send it back whole (with `updatedAt`).
4. Stop at the first error or SerieX question and report; do not answer questions in a loop.
5. Re-read a sample and run the report that should change, and tell the user the result.

## 13. Telling the owner how the business is doing

A short, plain summary works best. Run `profit_loss_prev_year` (or `_prev_period`),
`balance_sheet`, `ar_aging_summary` and `ap_aging_summary` for the period, then write:

1. **Profit**: sales, costs and net profit for the period, and the change from last year in
   dollars and percent. Say the basis.
2. **Cash**: the bank balances today, and what is coming in (A/R) and going out (A/P) soon.
3. **What stands out**: the two or three biggest changes in income or expense lines, and any
   overdue customer worth a call.
4. **What to check**: anything from the health check that could make these numbers wrong (for
   example an account not reconciled since March).

Keep it to a few short paragraphs or a small table, with exact figures where they matter.
