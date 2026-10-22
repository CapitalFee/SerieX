// Plain-English explanations of accounting terms, shown by <HelpTip term="..."/> ("?" tooltips)
// next to labels such as "Deposit to", "A/R account", "Class", "Terms" or "Billable".
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
    text: 'An optional tag (for example a location, department or line of business) that lets you run Profit and Loss reports for each part of the business.',
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
    term: 'Customer or Job',
    text: 'The customer, or a job (project) of that customer. A job is shown after its customer, separated by a colon (for example "Smith:Kitchen"). Transactions for a job are also included in the customer’s balance.',
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
  'customer job': 'Customer or Job',
  'customer:job': 'Customer or Job',
  job: 'Customer or Job',
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
