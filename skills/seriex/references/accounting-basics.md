# Accounting basics for SerieX

Read this when you need to pick the right kind of transaction for what the user describes,
explain what a change does to their books, or spot a bookkeeping mistake. It is written for
you (the assistant); the last section shows how to say these things to a business owner.

## Contents

1. [How SerieX keeps the books](#1-how-seriex-keeps-the-books)
2. [Account types](#2-account-types)
3. [Accounts SerieX manages for you](#3-accounts-seriex-manages-for-you)
4. [What each transaction does to the books](#4-what-each-transaction-does-to-the-books)
5. [Picking the right transaction](#5-picking-the-right-transaction)
6. [Common mistakes to catch](#6-common-mistakes-to-catch)
7. [Cash basis and accrual basis](#7-cash-basis-and-accrual-basis)
8. [Names, jobs, classes and items](#8-names-jobs-classes-and-items)
9. [Protecting finished periods](#9-protecting-finished-periods)
10. [Void or delete](#10-void-or-delete)
11. [When to send the user to an accountant](#11-when-to-send-the-user-to-an-accountant)
12. [Talking to the owner](#12-talking-to-the-owner)

## 1. How SerieX keeps the books

SerieX uses double-entry bookkeeping. Every saved transaction writes
ledger entries to two or more accounts, and the entries of one transaction always add up to
zero. In the ledger a positive amount is a debit and a negative amount is a credit. If the
entries do not balance, SerieX refuses the save with "Transaction not in balance".

You almost never write ledger entries yourself. You save a business document (an invoice, a
bill, a check...) and SerieX works out the entries from it: the account of the form's header
(for example Accounts Receivable on an invoice, the bank account on a check) on one side, and
the accounts of the lines or items on the other. Only journal entries take raw debit and
credit lines.

Money in the API is in dollars with two decimals (stored as whole cents). Dates are
`YYYY-MM-DD`. There is one currency per company file: SerieX has no multi-currency.

Recorded transactions keep the accounts they were posted to. If an item's income account
changes later, old invoices stay where they were; only new or edited lines use the new account.

## 2. Account types

The account type decides which report the account appears on and which way it grows.

| Type (API value) | What it holds | Grows with a | Report |
|---|---|---|---|
| `Bank` | Checking, savings, petty cash | debit | Balance Sheet |
| `Accounts Receivable` | What customers owe (open invoices) | debit | Balance Sheet |
| `Other Current Asset` | Inventory, undeposited funds, prepaid costs, short loans to others | debit | Balance Sheet |
| `Fixed Asset` | Vehicles, equipment, buildings, and their accumulated depreciation | debit | Balance Sheet |
| `Other Asset` | Long-term deposits, intangible assets | debit | Balance Sheet |
| `Accounts Payable` | What the business owes vendors (open bills) | credit | Balance Sheet |
| `Credit Card` | Credit card balances owed | credit | Balance Sheet |
| `Other Current Liability` | Sales tax owed, payroll taxes owed, short loans | credit | Balance Sheet |
| `Long Term Liability` | Loans and mortgages due after a year | credit | Balance Sheet |
| `Equity` | Owner's investment and draws, opening balance equity, retained earnings | credit | Balance Sheet |
| `Income` | Sales of products and services | credit | Profit and Loss |
| `Cost of Goods Sold` | Direct costs of what was sold (materials, subcontractors, inventory cost) | debit | Profit and Loss |
| `Expense` | Running costs (rent, fuel, insurance, supplies) | debit | Profit and Loss |
| `Other Income` | Income outside normal business (interest earned, gain on a sale of equipment) | credit | Profit and Loss |
| `Other Expense` | Costs outside normal business (interest paid on loans in some charts, penalties) | debit | Profit and Loss |
| `Non-Posting` | Estimates and purchase orders; never on the financial statements | none | none |

Balance Sheet accounts carry their balance forward forever. Profit and Loss accounts start each
fiscal year at zero: last year's net income moves into Retained Earnings automatically (no
closing entry is needed).

Accounts can have subaccounts (for example "Automobile Expense" with "Fuel" and "Vehicle
Repairs" under it). Reports show the subaccounts and a total for the parent.

## 3. Accounts SerieX manages for you

SerieX creates and uses these accounts itself. Their meaning matters when you read reports or
look for problems.

| Account | What it means | What to watch |
|---|---|---|
| Accounts Receivable | Total of open customer invoices and statement charges, less unused credits. | Old open invoices (A/R aging). Customer credit balances that were never applied or refunded. |
| Accounts Payable | Total of open bills, less unused vendor credits. | Bills paid by a check written to an expense account instead of Pay Bills: the bill stays open. |
| Undeposited Funds | Customer payments received but not yet put in the bank with Make Deposits. | A growing balance usually means payments were recorded but the matching bank deposit was entered separately (double-counted income) or never entered. |
| Sales Tax Payable | Sales tax collected and not yet paid to the tax agency. | Pay it with Pay Sales Tax, never with an expense check. |
| Inventory Asset | Value of inventory on hand at average cost. | Negative quantities (sold more than recorded as bought). |
| Cost of Goods Sold | Cost of inventory sold, computed by SerieX at average cost when an inventory item is sold. | Large swings after back-dated purchases (average cost is recomputed). |
| Opening Balance Equity | The other side of opening balances typed into new accounts. | Should be moved to the owner's equity accounts once the opening balances are confirmed (an accountant's call). |
| Retained Earnings | Profits of earlier years, computed by SerieX. | Never post to it by hand unless an accountant asks. |
| Uncategorized Income / Uncategorized Expenses | Places to park amounts whose category is not known yet (also used for purchase items without an account). | Should be empty at month end; offer to categorize. |
| To Review with Accountant | Amounts the owner wants an accountant to look at. | List them for the accountant; do not guess. |

## 4. What each transaction does to the books

Type codes are the values of the transaction `type` field in the API. "Up" and "down" mean the
account's balance as shown on reports.

| Type | Form | Effect on the books |
|---|---|---|
| `EST` | Estimate | Nothing. A non-posting quote that can become an invoice. |
| `INV` | Invoice | Accounts Receivable up; each line's income account up; Sales Tax Payable up for tax; for inventory items, Cost of Goods Sold up and Inventory Asset down (average cost). |
| `SALESRCPT` | Sales Receipt | Like an invoice, but the money goes to the deposit account (Undeposited Funds or a bank) instead of Accounts Receivable. |
| `STMTCHG` | Statement Charge | Accounts Receivable up and the item's income account up, without an invoice form (for statements). |
| `PMT` | Receive Payment | Deposit account (Undeposited Funds or a bank) up; Accounts Receivable down; early-payment discounts go to the chosen discount account. Applying an existing credit has no ledger effect. |
| `CREDMEM` | Credit Memo | The reverse of an invoice: income down, Accounts Receivable down (a credit the customer can use); inventory items come back into stock. |
| `REFUND` | Refund (check for a customer's credit) | Bank down; Accounts Receivable up (uses up the customer's credit). |
| `DEP` | Make Deposits | Bank up; each line's account down: usually Undeposited Funds (payments being deposited), or an income or other account for other money. Cash back goes to its own account. |
| `PURCHORD` | Purchase Order | Nothing. A non-posting order that can be received into an item receipt or bill. |
| `ITEMRCPT` | Item Receipt (items arrived, no bill yet) | Accounts Payable up; Inventory Asset (or the item's expense account) up. Converted into a bill when the bill arrives. |
| `BILL` | Enter Bills | Accounts Payable up; each line's expense, cost or asset account up. |
| `BILLCRED` | Vendor Credit | The reverse of a bill: Accounts Payable down; the line accounts down. |
| `BILLPMT` | Pay Bills | Bank or credit card account pays; Accounts Payable down; early-payment discounts go to the chosen discount account. |
| `CHK` | Write Checks (also debit card and cash payments) | Bank down; each line's expense, cost, asset, liability or equity account up. |
| `CCCHARGE` | Credit Card Charge | Credit card balance up; each line's account up. |
| `CCCREDIT` | Credit Card Credit (a return or refund on the card) | Credit card balance down; the line accounts down. |
| `TRANSFER` | Transfer Funds | One balance-sheet account down, the other up. No income or expense. |
| `GENJRNL` | Journal Entry | Exactly the debit and credit lines given. |
| `INVADJ` | Adjust Quantity/Value on Hand | Inventory Asset up or down; the adjustment account (often an Inventory Adjustments cost account) the other way. |
| `TAXPMT` | Pay Sales Tax | Bank down; Sales Tax Payable down. |

Paychecks and payroll tax payments are created by SerieX Payroll and appear in SerieX Books
as checks and journal-type entries with employee names. Let SerieX Payroll make them.

## 5. Picking the right transaction

Ask a short question when the user's words fit more than one row ("Did the customer already
pay, or will they pay later?"). Choose from what they say, not from what is easiest to enter.

| The user says... | Use | Why not the obvious shortcut |
|---|---|---|
| "I sold X and got paid on the spot" | Sales Receipt | An invoice would sit open until a payment is recorded. |
| "I did a job, they'll pay later" | Invoice | |
| "Customer paid invoice 1043" | Receive Payment applied to that invoice, then Make Deposits (unless it went straight to a bank account) | A deposit coded to income would count the sale twice and leave the invoice open. |
| "Put these checks in the bank" | Make Deposits from Undeposited Funds | |
| "Refund a customer" | Credit Memo, then Refund (or apply the credit to another invoice) | |
| "A bill came in, I'll pay it later" | Enter Bills | |
| "Pay the electric bill" | If a bill was entered: Pay Bills. If not: Write Checks (or Credit Card Charge) | Writing a check for an entered bill doubles the expense and leaves the bill open. |
| "Bought supplies with the company card" | Credit Card Charge | |
| "Paid the credit card bill" | Write Checks, Transfer, or Pay Bills (if the card statement was entered as a bill) **to the credit card account** | It is not an expense: the purchases were already expenses. |
| "Moved money from savings to checking" | Transfer Funds | It is neither income nor expense. |
| "Loan payment" | Write Checks split: principal to the loan's liability account, interest to an interest expense account | The whole payment is not an expense. Ask for the split (from the lender's statement). |
| "I put my own money into the business" | Deposit to an owner's equity (contribution or investment) account | It is not income. |
| "I took money out for myself" | Check or transfer to an owner's draw (equity) account | It is not an expense (for sole owners and partners; corporations pay owners through payroll or dividends — ask the accountant). |
| "Bought a truck / big equipment" | Check, bill or loan to a Fixed Asset account | Expensing it understates profit; depreciation is the accountant's job. |
| "Bank charged a fee" / "Earned interest" | Write Checks to bank charges / Deposit to interest income, or enter them on the reconcile screen | |
| "Paid the sales tax" | Pay Sales Tax | An expense check leaves Sales Tax Payable too high and expenses too high. |
| "Bought stock to resell" | Bill, check or card charge with inventory **item** lines (or a purchase order first) | Expense lines skip the inventory count and cost of goods sold. |
| "Counted the shelf and we have fewer" | Adjust Quantity/Value on Hand | |
| "Customer's check bounced" | Record the bank's return as a check from the bank account to Accounts Receivable for that customer (re-opens what they owe) plus any bank fee; or invoice the customer for the bounced amount and fee | Deleting the old payment rewrites history that was already deposited. Confirm the approach with the user or accountant. |
| "Pay employees" | SerieX Payroll | Hand-made paychecks in Books do not track payroll taxes, forms or year-to-date amounts. |

## 6. Common mistakes to catch

When you review a company or before you save, look for these:

- Income recorded twice: a payment received against an invoice, and also a deposit coded to an
  income account for the same money. Signs: Undeposited Funds keeps growing; invoices stay open.
- Expenses recorded twice: a bill entered, then a check written to the expense account instead
  of Pay Bills. Signs: old open bills in A/P aging that the user says were paid.
- Owner draws or loan principal recorded as expenses (profit looks lower than it is).
- Transfers recorded as income or expense.
- Sales tax paid with an expense check.
- Amounts left in Uncategorized Income, Uncategorized Expenses or To Review with Accountant.
- A balance left in Opening Balance Equity long after setup.
- Negative inventory quantities, or inventory bought with expense lines.
- A bank account balance in SerieX that does not match the bank statement: reconcile it.
- Transactions dated in the wrong year (a typo like 2062), which also distort reports.
- Duplicate transactions from importing the same bank file twice or entering by hand what a
  bank import also added.

## 7. Cash basis and accrual basis

SerieX stores one set of entries and can show reports either way.

- **Accrual basis** (the default for most reports): income counts when invoiced, expenses
  when billed. Best to see how the business is really doing.
- **Cash basis**: income counts when payment is received, expenses when paid. Often what small
  businesses file taxes on. Accounts Receivable and Accounts Payable disappear from the cash
  basis balance sheet.

When the user asks "how much did I make", say which basis you used, and offer the other one if
the numbers will be used for taxes. The company's default basis is a preference.

## 8. Names, jobs, classes and items

- **Names**: customers (with their jobs), vendors and "other names" (anyone who is neither,
  such as the owner; SerieX Payroll's employees also appear in SerieX Books as other names).
  All of them share one list, so a name can be used only once, whatever its kind. Employees
  themselves are kept in SerieX Payroll.
- **Jobs**: a customer can have jobs (sub-customers), shown as "Customer:Job". Invoices and
  costs can go to a job to see profit per job.
- **Billable costs**: a cost line on a bill, check or card charge marked billable to a
  customer or job can later be added to that customer's invoice.
- **Classes**: an optional second way to slice income and expenses (locations, departments).
  Reports can show a column per class.
- **Items**: what appears on sales and purchase forms. Each item points to the accounts it
  posts to. Item types: service, inventory part, non-inventory part, other charge, subtotal,
  group, discount, payment, sales tax item, sales tax group. Picking the item picks the
  account, so the right item matters more than the right account on sales forms.
- **Terms** set due dates and early-payment discounts (for example "2% 10 Net 30").

## 9. Protecting finished periods

- **Closing date**: once the user's books for a period are done (often after the accountant's
  review or after taxes are filed), an administrator sets a closing date. Changes dated on or
  before it need the closing date password. As the assistant you never ask for that password
  and never send it; if a change in a closed period is really needed, the user makes it in
  SerieX themself.
- **Reconciled transactions**: entries marked cleared on a finished reconciliation match a
  bank statement. Changing their amount, account or date breaks the next reconciliation.
  SerieX warns (`reconciled`) first; treat that warning as a stop sign and explain it.
- **Deposited payments**: changing a payment already included in a deposit changes that
  deposit too (`deposited` warning).

## 10. Void or delete

- **Void** keeps the transaction (with its number, date, name and a "VOID" memo) but sets its
  amounts to zero, so nothing posts. Use it for anything that was printed, sent, handed over or
  is part of a history the user may need to show (a check that was written but never cashed,
  an invoice sent by mistake).
- **Delete** removes the transaction. Use it for true duplicates and entries made by mistake
  that nobody else has seen.
- Both are recorded in the audit trail. Both refuse or warn when other transactions depend on
  this one (payments applied, deposits, refunds); remove the dependent ones first, or ask.
- Neither is needed to fix a typo: edit the transaction instead.

## 11. When to send the user to an accountant

You can explain and record ordinary transactions. Suggest an accountant or tax professional
(and say why) for: depreciation and fixed asset rules, how owners of a corporation should be
paid, loan and lease accounting, cleaning up Opening Balance Equity or Retained Earnings,
inventory write-downs, year-end adjustments, sales tax rules for a specific state, payroll tax
questions beyond what SerieX Payroll computes, and anything about what to file with tax
agencies. Never present a tax position as certain.

## 12. Talking to the owner

Most SerieX users are business owners, not accountants. Speak in their words.

| Instead of | Say |
|---|---|
| "Debit A/R, credit income" | "This records that Rivera Builders owes you $2,400 and counts it as sales for June." |
| "Credit memo applied to the open invoice" | "I gave them a $150 credit and used it to lower what they owe on invoice 1043." |
| "Undeposited Funds has a balance of $3,210" | "You have $3,210 in customer payments recorded but not yet matched to a bank deposit." |
| "A/P aging" | "The list of bills you still owe, by how late they are." |
| "Accrual basis" | "Counting sales when you invoice, not when you get paid." |
| "Reconcile" | "Check your SerieX bank account against the bank statement, line by line." |

Before saving, describe the change in one or two sentences with the date, the name, the
amount and where it lands ("a $45.20 credit card charge on June 3 to Fuel, paid with the
company Visa"). After saving, say what you did, give the new number or document number, and
say where to see it in SerieX (for example "Customers > Customer Center, Rivera Builders").
