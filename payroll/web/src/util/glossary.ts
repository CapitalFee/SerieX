// Plain-English explanations of accounting and payroll terms, shown by <HelpTip term="..."/> ("?" tooltips)
// next to labels such as "Class", "Pay schedule", "Wage base", "EIN" or "Deposit schedule".
//
//   explain('Undeposited Funds')  → { term: 'Undeposited Funds', text: 'A holding account ...' }
//   explain('A/R account')        → the "Accounts Receivable" entry (aliases are matched too)

/** One glossary entry. */
export interface GlossaryEntry {
  /** Display name of the term ("Undeposited Funds"). */
  term: string;
  /** One or two short sentences in plain English. */
  text: string;
}

const ENTRIES: GlossaryEntry[] = [
  {
    term: 'Undeposited Funds',
    text: 'A holding account for payments you received but have not taken to the bank yet. When you record the bank deposit, the payments move from here into your bank account, so the deposit matches your bank statement.',
  },
  {
    term: 'Accounts Receivable',
    text: 'Money customers owe you. Invoices and statement charges add to it; payments and credit memos reduce it. Also called A/R.',
  },
  {
    term: 'Accounts Payable',
    text: 'Money you owe vendors. Bills add to it; bill payments and vendor credits reduce it. Also called A/P.',
  },
  {
    term: 'Class',
    text: 'An optional tag (for example a location, department or line of business) that lets you run Profit & Loss reports for each part of the business.',
  },
  {
    term: 'Terms',
    text: 'When payment is due, for example "Net 30" (30 days after the date) or "2% 10 Net 30" (2% discount if paid within 10 days). The due date is calculated from the terms.',
  },
  {
    term: 'Billable',
    text: 'Marks a cost you paid for a customer so you can add it to their next invoice (Add Time/Costs). Billable costs stay listed until they are invoiced.',
  },
  {
    term: 'Memo',
    text: 'A short internal note. It shows in registers and reports, and on some printed forms, but does not change any amounts.',
  },
  {
    term: 'Customer:Job',
    text: 'The customer, or a job (project) of that customer, written "Customer:Job". Transactions for a job are also included in the customer’s balance.',
  },
  {
    term: 'Sales Tax Item',
    text: 'One sales tax rate collected for one tax agency (for example "State tax 6%"). Tax you collect goes to Sales Tax Payable until you pay the agency.',
  },
  {
    term: 'Sales Tax Group',
    text: 'Several sales tax items charged together as one rate (for example state + county + city). Each part is tracked for its own agency.',
  },
  {
    term: 'Inventory Part',
    text: 'A product you buy, keep in stock and sell. Quantities on hand and their average cost are tracked; the cost moves to Cost of Goods Sold when you sell it.',
  },
  {
    term: 'Non-inventory Part',
    text: 'A product you sell or buy but do not track in stock (for example items bought for one job, or small supplies).',
  },
  {
    term: 'Service',
    text: 'Work you charge for (labor, consulting, fees). It can also be bought from a subcontractor.',
  },
  {
    term: 'Other Charge',
    text: 'A miscellaneous charge such as shipping, delivery or a service fee. It can be a fixed amount or a percentage of the line above.',
  },
  {
    term: 'Subtotal',
    text: 'A line that adds up the lines above it (since the previous subtotal), so you can apply a discount or a percentage charge to them.',
  },
  {
    term: 'Group',
    text: 'A set of items entered together with one pick. Each item of the group becomes its own line on the form.',
  },
  {
    term: 'Opening Balance Equity',
    text: 'A temporary equity account that balances the opening balances you enter for accounts. An accountant usually moves its amount to owner’s equity once setup is done.',
  },
  {
    term: 'Retained Earnings',
    text: 'Profit from prior years that stayed in the business. It is calculated automatically at the start of each fiscal year.',
  },
  {
    term: 'Reconcile',
    text: 'Comparing your records with the bank or credit card statement and checking off each transaction that appears on it, until the difference is zero.',
  },
  {
    term: 'Cleared',
    text: 'A transaction that has appeared on the bank statement (checked off while reconciling). "R" means it is reconciled; "*" means it is marked but not reconciled yet.',
  },
  {
    term: 'Accrual basis',
    text: 'Income counts when you invoice and expenses when you enter the bill, whether or not money changed hands yet.',
  },
  {
    term: 'Cash basis',
    text: 'Income counts when you receive the payment and expenses when you pay them. Unpaid invoices and bills are left out.',
  },
  {
    term: 'Journal entry',
    text: 'A transaction that moves amounts between accounts directly, with debits and credits. Used for adjustments such as depreciation or corrections.',
  },
  {
    term: 'Debit',
    text: 'The left side of an entry. Debits increase assets and expenses and decrease liabilities, equity and income. Total debits always equal total credits.',
  },
  {
    term: 'Credit',
    text: 'The right side of an entry. Credits increase liabilities, equity and income and decrease assets and expenses. (A vendor or customer "credit" is an amount owed back.)',
  },
  {
    term: 'Purchase order',
    text: 'An order you send to a vendor. It does not change your books; it tracks what you ordered until the items are received.',
  },
  {
    term: 'Item receipt',
    text: 'Records items received from a vendor before the bill arrives. Stock goes up now; you turn it into a bill when the bill comes.',
  },
  {
    term: 'Estimate',
    text: 'A quote or bid for a customer. It does not change your books; you can turn it into an invoice when the customer accepts.',
  },
  {
    term: 'Credit memo',
    text: 'Reduces what a customer owes (returns, refunds or corrections). You can apply it to an invoice, refund it, or keep it as an available credit.',
  },
  {
    term: 'Statement charge',
    text: 'A charge added directly to a customer’s account register, billed later on a statement instead of an invoice.',
  },
  {
    term: 'Deposit',
    text: 'Money put into a bank account, usually several customer payments taken to the bank together.',
  },
  {
    term: 'Transfer',
    text: 'Moves money between two of your own accounts (for example from savings to checking). It is not income or an expense.',
  },
  {
    term: 'Closing date',
    text: 'Transactions dated on or before this date are locked, usually because the books for that period are finished. Changing them needs the closing date password.',
  },
  {
    term: 'Discount',
    text: 'An amount or percentage subtracted from the line above it (or from a subtotal), or an early-payment discount taken on a payment.',
  },
  {
    term: 'Average cost',
    text: 'The value of the stock on hand divided by its quantity. It is used to value inventory and to calculate the cost of each sale.',
  },
  {
    term: 'Cost of goods sold',
    text: 'What the products you sold cost you. It is recorded automatically when you sell inventory and is subtracted from income to get gross profit.',
  },
  {
    term: 'Pending',
    text: 'A sale that is not final yet. A pending invoice or sales receipt does not affect your books until you mark it final.',
  },
  {
    term: 'Void',
    text: 'Keeps the transaction (and its number) on record but sets all its amounts to zero. Use it instead of deleting when you want a paper trail.',
  },

  // ------------------------------------------------------------------ payroll terms
  {
    term: 'Payroll item',
    text: 'One kind of line on a paycheck: a wage (salary, hourly, overtime, bonus), an addition, a deduction, a company contribution or a tax. Each item knows how it is calculated, which taxes apply and which SerieX Books accounts it posts to.',
  },
  {
    term: 'Pay schedule',
    text: 'How often a group of employees is paid (weekly, every two weeks, twice a month...), when the next pay period ends and when its paychecks are dated. The Payroll Center lists each schedule’s payroll when it is due.',
  },
  {
    term: 'Pay period',
    text: 'The days of work a paycheck pays for. The check date is the day the employee is paid, which may be a few days after the pay period ends.',
  },
  {
    term: 'Check date',
    text: 'The date of the paycheck: the day the employee is paid. Taxes, tax forms and W-2s are counted by check date, not by the pay period dates.',
  },
  {
    term: 'Gross pay',
    text: 'Everything the employee earned in the pay period (wages, overtime, bonuses, commissions) before any tax or deduction is taken out.',
  },
  {
    term: 'Net pay',
    text: 'What the employee actually receives: gross pay minus the taxes withheld and the deductions. It is the amount of the paycheck or direct deposit.',
  },
  {
    term: 'Federal withholding',
    text: 'Federal income tax taken out of the employee’s pay, figured from their Form W-4 with the IRS tables (Publication 15-T). You pay it to the IRS with social security and Medicare (Form 941).',
  },
  {
    term: 'Social security',
    text: 'Tax that funds retirement benefits: 6.2% taken from the employee and 6.2% paid by the company, on wages up to a yearly limit (the wage base).',
  },
  {
    term: 'Medicare',
    text: 'Tax that funds health insurance for retirees: 1.45% taken from the employee and 1.45% paid by the company, on all wages. Employees also pay 0.9% Additional Medicare tax on wages over $200,000 in a year.',
  },
  {
    term: 'Federal unemployment',
    text: 'FUTA: a federal tax only the company pays (usually 0.6% of the first $7,000 of each employee’s wages in a year), reported once a year on Form 940.',
  },
  {
    term: 'State unemployment',
    text: 'SUI: the state tax that funds unemployment benefits, mostly paid by the company at a rate the state gives you each year, on wages up to the state’s wage base.',
  },
  {
    term: 'State disability',
    text: 'SDI: a state tax in some states (for example California, New Jersey, New York) that funds disability and family leave benefits, usually taken from the employee’s pay.',
  },
  {
    term: 'Wage base',
    text: 'The wages a tax is figured on. For taxes with a yearly limit (social security, FUTA, state unemployment) it stops growing once the employee reaches the limit for the year.',
  },
  {
    term: 'Supplemental wages',
    text: 'Pay other than the regular wages, such as bonuses and commissions. Federal tax on them can be withheld at a flat 22% rate (37% above $1 million in a year).',
  },
  {
    term: 'Form W-4',
    text: 'The form employees fill in to tell you how much federal income tax to withhold: filing status, multiple jobs, dependents, other income and extra withholding. Forms from 2019 or earlier use allowances instead.',
  },
  {
    term: 'Exempt',
    text: 'The employee claimed no income tax withholding on the W-4 (they expect to owe no tax). Social security and Medicare are still withheld. The claim must be renewed every year.',
  },
  {
    term: 'Pre-tax deduction',
    text: 'A deduction taken before some taxes are figured, so it lowers the taxable wages, for example 401(k) contributions (no income tax) or section 125 health insurance (no income, social security or Medicare tax).',
  },
  {
    term: 'Company contribution',
    text: 'An amount the company pays for the employee on top of their pay, such as a 401(k) match or health insurance. It is a company cost and does not change the paycheck amount.',
  },
  {
    term: 'Tax treatment',
    text: 'Tells payroll how an item is taxed and where it goes on the W-2 (for example 401(k) is box 12 code D and not subject to federal withholding).',
  },
  {
    term: 'Payroll liability',
    text: 'Money payroll owes to someone else: taxes withheld from employees, the company’s share of payroll taxes, and deductions owed to benefit providers. Pay them with Pay Payroll Taxes by their due dates.',
  },
  {
    term: 'Tax balance adjustment',
    text: 'A correction of payroll tax or deduction amounts without a paycheck, for example to fix a few cents of rounding or a wrong tax amount. It can change an employee’s year-to-date totals.',
  },
  {
    term: 'Deposit schedule',
    text: 'How often you must deposit federal withholding, social security and Medicare. The IRS tells you each year: monthly (by the 15th of the next month) if you reported $50,000 or less in the lookback period, otherwise semiweekly.',
  },
  {
    term: 'EIN',
    text: 'Federal employer identification number: the nine-digit number the IRS gave your business (12-3456789). It is printed on every payroll tax form and W-2.',
  },
  {
    term: 'Withholding account number',
    text: 'The number your state gave you when you registered to withhold state income tax. It is printed on the state forms and on box 15 of the W-2.',
  },
  {
    term: 'Year-to-date amounts',
    text: 'Wages, taxes and deductions paid earlier in the year before you started using SerieX Payroll. They count for the yearly limits and the tax forms, but are not posted to SerieX Books.',
  },
  {
    term: 'Earlier tax payments',
    text: 'Payroll tax and deduction payments made earlier in the year, before you started using SerieX Payroll. Entering them keeps the amounts owed and the Form 941 deposits right.',
  },
  {
    term: 'Form 941',
    text: 'The employer’s quarterly federal tax return: wages paid, federal income tax withheld and social security and Medicare for the quarter, and the deposits made.',
  },
  {
    term: 'Form 940',
    text: 'The employer’s yearly federal unemployment (FUTA) tax return.',
  },
  {
    term: 'W-2',
    text: 'The yearly wage and tax statement each employee gets by January 31 to file their tax return. The W-3 is the summary of all W-2s sent to the Social Security Administration.',
  },
  {
    term: 'Credit reduction',
    text: 'When a state owes the federal unemployment fund money, employers in that state lose part of their FUTA credit and pay extra federal unemployment tax for the year (Form 940 Schedule A).',
  },
  {
    term: 'Direct deposit',
    text: 'Paying the net pay straight into the employee’s bank account instead of printing a check.',
  },
  {
    term: 'Sick and vacation hours',
    text: 'Paid time off the employee earns (accrues) per paycheck, per hour worked or at the start of the year, and uses when paid with a sick or vacation payroll item.',
  },
  {
    term: 'Statutory employee',
    text: 'A worker the IRS treats as an employee for social security and Medicare but not for federal income tax withholding (for example some drivers and salespeople). Box 13 of the W-2 is checked.',
  },
  {
    term: 'Tax payment',
    text: 'The check (or e-payment) that pays payroll taxes or deductions to a tax agency or benefit provider. Its lines are the payroll items it pays, so the amounts owed go down by those amounts.',
  },
  {
    term: 'Tax payment schedule',
    text: 'How often each group of payroll taxes and deductions is paid (after each payroll, semiweekly, monthly, quarterly or yearly), to whom and how (check or e-pay). Pay Payroll Taxes uses it to list what is due and when.',
  },
  {
    term: 'Extra paycheck',
    text: 'A paycheck outside the regular pay schedules, for example a bonus or pay for an employee who has no schedule.',
  },
  {
    term: 'Final paycheck',
    text: 'The last paycheck of an employee who leaves. It saves their release date (last day on payroll), so later payrolls of their pay schedule leave them out.',
  },
  {
    term: 'Tax table',
    text: 'The rates, wage limits and withholding brackets payroll uses for a year (federal and each state). SerieX Payroll has them built in; an administrator can correct a table for the company and go back to the built-in one.',
  },
  {
    term: 'Unemployment account number',
    text: 'The number your state gave you when you registered for state unemployment insurance. It is printed on the state unemployment wage reports.',
  },
  {
    term: 'Box 12',
    text: 'The W-2 box for special amounts, each with a code letter: for example D for 401(k) deferrals, W for HSA contributions and DD for the cost of employer health coverage.',
  },
  {
    term: 'Section 125',
    text: 'A cafeteria plan: health insurance premiums and some other benefits taken from pay before income, social security and Medicare taxes are figured.',
  },
  {
    term: 'Employee defaults',
    text: 'The pay schedule, earnings, deductions, taxes and sick and vacation settings every new employee starts with. Changing them does not change existing employees.',
  },
  {
    term: 'Drill down',
    text: 'Click an amount in a report to see what makes it up: a total opens a detail report, an amount on a transaction line opens the paycheck or tax payment.',
  },
  {
    term: 'Books Sync',
    text: 'Payroll posts every paycheck, tax payment and adjustment to the SerieX Books company file. Books Sync lists what is not posted yet (for example while SerieX Books was not running) and posts it again.',
  },
];

/** Extra spellings that point to an entry (normalized like the terms). */
const ALIASES: Record<string, string> = {
  'a/r': 'Accounts Receivable',
  ar: 'Accounts Receivable',
  'a/r account': 'Accounts Receivable',
  'accounts receivable account': 'Accounts Receivable',
  receivable: 'Accounts Receivable',
  'a/p': 'Accounts Payable',
  ap: 'Accounts Payable',
  'a/p account': 'Accounts Payable',
  'accounts payable account': 'Accounts Payable',
  payable: 'Accounts Payable',
  'deposit to': 'Undeposited Funds',
  'customer job': 'Customer:Job',
  'customer:job': 'Customer:Job',
  job: 'Customer:Job',
  'tax item': 'Sales Tax Item',
  'sales tax': 'Sales Tax Item',
  'tax group': 'Sales Tax Group',
  inventory: 'Inventory Part',
  'non inventory part': 'Non-inventory Part',
  'noninventory part': 'Non-inventory Part',
  'service item': 'Service',
  obe: 'Opening Balance Equity',
  reconciliation: 'Reconcile',
  reconciled: 'Cleared',
  clr: 'Cleared',
  accrual: 'Accrual basis',
  cash: 'Cash basis',
  'general journal': 'Journal entry',
  'general journal entry': 'Journal entry',
  je: 'Journal entry',
  debits: 'Debit',
  credits: 'Credit',
  po: 'Purchase order',
  'p.o.': 'Purchase order',
  'purchase orders': 'Purchase order',
  'credit memos': 'Credit memo',
  'bank deposit': 'Deposit',
  'transfer funds': 'Transfer',
  'average costing': 'Average cost',
  'avg cost': 'Average cost',
  cogs: 'Cost of goods sold',
  'mark as pending': 'Pending',
  voided: 'Void',

  // payroll
  'payroll items': 'Payroll item',
  'pay schedules': 'Pay schedule',
  'payroll schedule': 'Pay schedule',
  'pay frequency': 'Pay schedule',
  gross: 'Gross pay',
  'gross wages': 'Gross pay',
  net: 'Net pay',
  'check amount': 'Net pay',
  fit: 'Federal withholding',
  'federal income tax': 'Federal withholding',
  'federal income tax withholding': 'Federal withholding',
  'social security tax': 'Social security',
  ss: 'Social security',
  fica: 'Social security',
  'medicare tax': 'Medicare',
  'additional medicare': 'Medicare',
  futa: 'Federal unemployment',
  'federal unemployment tax': 'Federal unemployment',
  sui: 'State unemployment',
  'state unemployment tax': 'State unemployment',
  'unemployment rate': 'State unemployment',
  'ui rate': 'State unemployment',
  sdi: 'State disability',
  'disability insurance': 'State disability',
  'wage limit': 'Wage base',
  bonus: 'Supplemental wages',
  'supplemental wage': 'Supplemental wages',
  w4: 'Form W-4',
  'w-4': 'Form W-4',
  'pre-tax': 'Pre-tax deduction',
  'pretax deduction': 'Pre-tax deduction',
  'company contributions': 'Company contribution',
  'employer contribution': 'Company contribution',
  'tax type': 'Tax treatment',
  'payroll liabilities': 'Payroll liability',
  liabilities: 'Payroll liability',
  'adjust tax balances': 'Tax balance adjustment',
  'tax adjustment': 'Tax balance adjustment',
  'liability adjustment': 'Tax balance adjustment',
  'federal deposit schedule': 'Deposit schedule',
  semiweekly: 'Deposit schedule',
  'federal employer id': 'EIN',
  'federal employer identification number': 'EIN',
  fein: 'EIN',
  'state withholding account number': 'Withholding account number',
  'state id': 'Withholding account number',
  ytd: 'Year-to-date amounts',
  'year-to-date': 'Year-to-date amounts',
  'earlier tax payment': 'Earlier tax payments',
  '941': 'Form 941',
  '940': 'Form 940',
  'w-2': 'W-2',
  w2: 'W-2',
  'w-3': 'W-2',
  'futa credit reduction': 'Credit reduction',
  'paid time off': 'Sick and vacation hours',
  pto: 'Sick and vacation hours',
  'sick and vacation': 'Sick and vacation hours',
  statutory: 'Statutory employee',
  'seriex books sync': 'Books Sync',
  'tax payments': 'Tax payment',
  'liability payment': 'Tax payment',
  'payment schedule': 'Tax payment schedule',
  'tax due dates': 'Tax payment schedule',
  'payment method': 'Tax payment schedule',
  'extra paychecks': 'Extra paycheck',
  'off-cycle paycheck': 'Extra paycheck',
  'last paycheck': 'Final paycheck',
  'tax tables': 'Tax table',
  'state unemployment account number': 'Unemployment account number',
  'ui account number': 'Unemployment account number',
  'w-2 box 12': 'Box 12',
  'box 12 code': 'Box 12',
  'cafeteria plan': 'Section 125',
  'new employee defaults': 'Employee defaults',
  'drill-down': 'Drill down',
};

/** Normalizes a term for lookups: lower case, single spaces, no trailing "?" or ":". */
export function glossaryKey(term: string): string {
  return term
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const BY_KEY = new Map<string, GlossaryEntry>();
for (const e of ENTRIES) BY_KEY.set(glossaryKey(e.term), e);
for (const [alias, term] of Object.entries(ALIASES)) {
  const e = BY_KEY.get(glossaryKey(term));
  if (e) BY_KEY.set(glossaryKey(alias), e);
}

/** Every glossary entry, in a stable order (for help pages). */
export const GLOSSARY: readonly GlossaryEntry[] = ENTRIES;

/** The entry for a term or one of its aliases ("A/R", "Deposit to", "COGS"...); undefined when unknown. */
export function explain(term: string | null | undefined): GlossaryEntry | undefined {
  if (!term) return undefined;
  const k = glossaryKey(term);
  return BY_KEY.get(k) ?? BY_KEY.get(k.replace(/-/g, ' ')) ?? BY_KEY.get(k.replace(/s$/, ''));
}
