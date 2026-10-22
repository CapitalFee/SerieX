// What each report supports in the report window: column options, comparisons, detail columns,
// required ids and which reports the Report Center hides for the company's preferences.
import type { Prefs, ReportInfo, ReportParamKind } from '@/api/types';
import { STATIC_REPORTS } from '@/state/catalog';

/** One choice of a drop-down. */
export interface Opt {
  value: string;
  label: string;
}

/** Parameters some reports accept beyond what the catalog lists (sales tax basis). */
const EXTRA_PARAMS: Record<string, ReportParamKind[]> = {
  sales_tax_liability: ['basis'],
  sales_tax_revenue_summary: ['basis'],
};

/** Report information with defaults for reports missing from the server catalog. */
export function reportInfo(catalog: ReportInfo[] | undefined, key: string): ReportInfo {
  const hit = catalog?.find((r) => r.key === key);
  const extra = EXTRA_PARAMS[key]?.filter((p) => !hit?.params.includes(p));
  if (hit && extra?.length) return { ...hit, params: [...hit.params, ...extra] };
  if (hit) return hit;
  const st = STATIC_REPORTS.find((r) => r.key === key);
  return {
    key,
    title: st?.title ?? 'Report',
    category: st?.category ?? '',
    description: '',
    params: ['dates'],
    defaultDates: 'thisMonthToDate',
  };
}

/** True when the report has this parameter kind. */
export const hasParam = (info: ReportInfo, p: ReportParamKind) => info.params.includes(p);

const PERIODS: Opt[] = [
  { value: 'total', label: 'Total only' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'Year' },
];

/** Reports whose columns can also be classes or customers:jobs. */
const PL_COLUMN_REPORTS = new Set(['profit_loss', 'custom_summary', 'profit_loss_unclassified']);

/** "Display columns by" choices, or null when the report has no column choice. */
export function columnOptions(info: ReportInfo, prefs: Prefs, rp: Record<string, string>): Opt[] | null {
  if (!hasParam(info, 'columns')) return null;
  const out = [...PERIODS];
  if (PL_COLUMN_REPORTS.has(info.key) && (info.key !== 'custom_summary' || !rp.rows || rp.rows === 'account')) {
    if (prefs.useClassTracking && info.key !== 'profit_loss_unclassified') out.push({ value: 'class', label: 'Class' });
    out.push({ value: 'customer', label: 'Customer or Job' });
  }
  return out;
}

/** Default "Display columns by" value of a report. */
export function defaultColumns(key: string): string {
  return key.startsWith('budget_') ? 'month' : 'total';
}

/** Comparison families: the report window switches between these keys with "Compare to". */
const COMPARE_FAMILIES: Opt[][] = [
  [
    { value: 'profit_loss', label: 'No comparison' },
    { value: 'profit_loss_prev_period', label: 'Previous period' },
    { value: 'profit_loss_prev_year', label: 'Same period last year' },
    { value: 'profit_loss_ytd', label: 'Year to date' },
  ],
  [
    { value: 'balance_sheet', label: 'No comparison' },
    { value: 'balance_sheet_prev_period', label: 'Previous period' },
    { value: 'balance_sheet_prev_year', label: 'Same date last year' },
  ],
];

/** Comparison reports that only some servers have: offered once the catalog lists them. */
const OPTIONAL_COMPARE = new Set(['profit_loss_prev_period', 'balance_sheet_prev_period']);

/**
 * "Compare to" choices of a report (null when it has none). With the catalog, choices the server
 * does not offer are left out.
 */
export function compareOptions(key: string, catalog?: Pick<ReportInfo, 'key'>[]): Opt[] | null {
  const fam = COMPARE_FAMILIES.find((f) => f.some((o) => o.value === key));
  if (!fam) return null;
  const has = new Set((catalog ?? []).map((r) => r.key));
  return fam.filter((o) => o.value === key || !OPTIONAL_COMPARE.has(o.value) || has.has(o.value));
}

/** Every column a detail report can show with `cols=` (server finDetailCol order). */
export const DETAIL_COLUMNS: Opt[] = [
  { value: 'trans', label: 'Trans #' },
  { value: 'type', label: 'Type' },
  { value: 'date', label: 'Date' },
  { value: 'num', label: 'Num' },
  { value: 'name', label: 'Name' },
  { value: 'memo', label: 'Memo' },
  { value: 'account', label: 'Account' },
  { value: 'class', label: 'Class' },
  { value: 'item', label: 'Item' },
  { value: 'clr', label: 'Clr (cleared)' },
  { value: 'split', label: 'Split (other account)' },
  { value: 'debit', label: 'Debit' },
  { value: 'credit', label: 'Credit' },
  { value: 'amount', label: 'Amount' },
  { value: 'balance', label: 'Balance' },
];

/** Reports that accept `cols=` and their default columns (same as the server). */
export const DETAIL_COLS_DEFAULT: Record<string, string[]> = {
  transaction_detail_by_account: ['type', 'date', 'num', 'name', 'memo', 'class', 'clr', 'split', 'amount', 'balance'],
  general_ledger: ['type', 'date', 'num', 'name', 'memo', 'split', 'debit', 'credit', 'balance'],
  custom_transaction_detail: ['type', 'date', 'num', 'name', 'memo', 'account', 'class', 'clr', 'split', 'amount', 'balance'],
  transaction_list_by_date: ['type', 'date', 'num', 'name', 'memo', 'account', 'clr', 'split', 'amount'],
};

/** Custom Summary "Rows by" choices. */
export const ROWS_BY: Opt[] = [
  { value: 'account', label: 'Account' },
  { value: 'customer', label: 'Customer or Job' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'item', label: 'Item' },
  { value: 'class', label: 'Class' },
];

/** Custom Transaction Detail "Total by" choices. */
export const TOTAL_BY: Opt[] = [
  { value: 'account', label: 'Account' },
  { value: 'name', label: 'Name' },
  { value: 'class', label: 'Class' },
  { value: 'type', label: 'Transaction type' },
  { value: 'item', label: 'Item' },
  { value: 'none', label: 'Nothing (one list)' },
];

/** A filter of the Customize panel. */
export type FilterKind = 'accounts' | 'names' | 'items' | 'classes' | 'types' | 'cleared' | 'amount' | 'memo' | 'refNumber';

const ALL_FILTERS: FilterKind[] = ['accounts', 'names', 'items', 'classes', 'types', 'cleared', 'amount', 'memo', 'refNumber'];
const TEXT: FilterKind[] = ['memo', 'refNumber'];
/**
 * Filters of the reports built from the general ledger that show only income and expense lines:
 * every filter except the cleared status. Income and expense lines are never cleared (only balance
 * sheet accounts are reconciled), so "Cleared" would always show nothing and "Not cleared" everything.
 */
const SUMMARY: FilterKind[] = ['accounts', 'names', 'items', 'classes', 'types', 'amount', 'memo', 'refNumber'];

/**
 * Filters each report really applies (each one checked against the server), so the Customize
 * panel never offers a filter that would silently do nothing. Every report of the catalog that
 * takes filters is listed.
 */
const FILTERS_BY_REPORT: Record<string, FilterKind[]> = {
  ar_aging_summary: [...TEXT, 'names', 'types', 'classes'],
  ar_aging_detail: [...TEXT, 'names', 'types', 'classes'],
  open_invoices: [...TEXT, 'names', 'types', 'classes'],
  collections: [...TEXT, 'names', 'types', 'classes'],
  customer_balance_summary: ['names'],
  customer_balance_detail: [...TEXT, 'names', 'types'],
  transaction_list_by_customer: [...TEXT, 'amount', 'names', 'types', 'classes'],
  sales_by_customer_summary: [...TEXT, 'names', 'items', 'types'],
  sales_by_customer_detail: [...TEXT, 'names', 'items', 'types'],
  sales_by_item_summary: [...TEXT, 'names', 'items', 'types'],
  sales_by_item_detail: [...TEXT, 'names', 'items', 'types'],
  sales_by_rep_summary: [...TEXT, 'names', 'items', 'types'],
  sales_by_rep_detail: [...TEXT, 'names', 'items', 'types'],
  pending_sales: [...TEXT, 'names'],
  job_profitability_summary: ['names'],
  job_estimates_vs_actuals_summary: ['names'],
  ap_aging_summary: [...TEXT, 'names', 'types', 'classes'],
  ap_aging_detail: [...TEXT, 'names', 'types', 'classes'],
  vendor_balance_summary: ['names'],
  vendor_balance_detail: [...TEXT, 'names', 'types'],
  unpaid_bills_detail: [...TEXT, 'names', 'types', 'classes'],
  transaction_list_by_vendor: [...TEXT, 'amount', 'names', 'types', 'classes'],
  purchases_by_vendor_summary: [...TEXT, 'names', 'items', 'types'],
  purchases_by_vendor_detail: [...TEXT, 'names', 'items', 'types'],
  purchases_by_item_summary: [...TEXT, 'names', 'items', 'types'],
  purchases_by_item_detail: [...TEXT, 'names', 'items', 'types'],
  open_purchase_orders: [...TEXT, 'names', 'items'],
  open_purchase_orders_detail: [...TEXT, 'names', 'items'],
  inventory_valuation_summary: ['items'],
  inventory_valuation_detail: ['items'],
  inventory_stock_status_by_item: ['items'],
  inventory_stock_status_by_vendor: ['items'],
  deposit_detail: [...TEXT, 'amount', 'accounts', 'names'],
  check_detail: [...TEXT, 'amount', 'accounts', 'names'],
  // 1099 reports: the payment account and the vendor only
  '1099_summary': ['accounts', 'names'],
  '1099_detail': ['accounts', 'names'],
  // summary reports of income and expense built from the general ledger:
  // income and expense lines are never cleared, so "Cleared status" is not offered on them
  profit_loss: SUMMARY,
  profit_loss_detail: SUMMARY,
  profit_loss_ytd: SUMMARY,
  profit_loss_prev_year: SUMMARY,
  profit_loss_prev_period: SUMMARY,
  profit_loss_by_job: SUMMARY,
  profit_loss_by_class: SUMMARY,
  profit_loss_unclassified: SUMMARY,
  custom_summary: SUMMARY,
  income_by_customer_summary: SUMMARY,
  income_by_customer_detail: SUMMARY,
  expenses_by_vendor_summary: SUMMARY,
  expenses_by_vendor_detail: SUMMARY,
  // balances of every account, bank and credit card accounts included, whose entries are cleared
  // when reconciled: every filter ("Cleared" shows the balances of the cleared entries only). The
  // summary and the comparisons apply every filter too; they offer them once the catalog lists
  // "filters" for them
  balance_sheet: ALL_FILTERS,
  balance_sheet_summary: ALL_FILTERS,
  balance_sheet_prev_year: ALL_FILTERS,
  balance_sheet_prev_period: ALL_FILTERS,
  trial_balance: ALL_FILTERS,
  // transaction reports built from the general ledger (bank lines too): every filter
  general_ledger: ALL_FILTERS,
  journal: ALL_FILTERS,
  transaction_detail_by_account: ALL_FILTERS,
  transaction_list_by_date: ALL_FILTERS,
  custom_transaction_detail: ALL_FILTERS,
  // activity reports choose their record with the picker in the filter bar
  name_quickreport: [],
  item_quickreport: [],
};

/** Categories whose reports are built from the general ledger (they apply every standard filter). */
const LEDGER_CATEGORIES = new Set(['Financial Statements', 'For Your Accountant', 'Budgets']);

/**
 * Filters the Customize panel offers for a report (empty when it has none). A report missing from
 * the list above (a newer server) gets every filter when it is built from the general ledger, and
 * none otherwise, rather than filters that might do nothing.
 */
export function supportedFilters(info: ReportInfo): FilterKind[] {
  if (!hasParam(info, 'filters')) return [];
  return FILTERS_BY_REPORT[info.key] ?? (LEDGER_CATEGORIES.has(info.category) ? ALL_FILTERS : []);
}

/**
 * Reports where "Income and expense accounts only" (plOnly=1) changes the result: the transaction
 * reports that also list balance sheet accounts. The profit and loss reports show only those
 * accounts anyway, and the balance sheet and trial balance ignore it.
 */
const PL_ONLY_REPORTS = new Set(['general_ledger', 'journal', 'transaction_detail_by_account', 'custom_transaction_detail']);

/** Reports that apply "No class only" (noClass=1); Profit and Loss: No Class has only those already. */
const NO_CLASS_REPORTS = new Set([
  'profit_loss',
  'profit_loss_detail',
  'profit_loss_ytd',
  'profit_loss_prev_year',
  'profit_loss_prev_period',
  'profit_loss_by_job',
  'profit_loss_by_class',
  'income_by_customer_summary',
  'income_by_customer_detail',
  'expenses_by_vendor_summary',
  'expenses_by_vendor_detail',
  'balance_sheet',
  'balance_sheet_summary',
  'balance_sheet_prev_year',
  'balance_sheet_prev_period',
  'trial_balance',
  'general_ledger',
  'journal',
  'transaction_detail_by_account',
  'custom_summary',
  'custom_transaction_detail',
]);

/** True when the Accounts filter offers "Income and expense accounts only" for this report. */
export const offersPlOnly = (info: Pick<ReportInfo, 'key'>) => PL_ONLY_REPORTS.has(info.key);

/** True when the Classes filter offers "No class only" for this report. */
export const offersNoClass = (info: Pick<ReportInfo, 'key'>) => NO_CLASS_REPORTS.has(info.key);

/** Report params of each filter: the first ones say the filter is set, all of them are removed with it. */
const FILTER_PARAMS: Record<FilterKind | 'plOnly' | 'noClass', { set: string[]; also?: string[]; label: string }> = {
  accounts: { set: ['accountIds'], label: 'Accounts' },
  plOnly: { set: ['plOnly'], label: 'Income and expense accounts only' },
  names: { set: ['nameIds'], also: ['includeJobs'], label: 'Names' },
  items: { set: ['itemIds'], label: 'Items' },
  classes: { set: ['classIds'], label: 'Classes' },
  noClass: { set: ['noClass'], label: 'No class only' },
  types: { set: ['types'], label: 'Transaction types' },
  cleared: { set: ['cleared'], label: 'Cleared status' },
  amount: { set: ['amountMin', 'amountMax'], label: 'Amount' },
  memo: { set: ['memo'], label: 'Memo' },
  refNumber: { set: ['refNumber'], label: 'Number' },
};

/** True when a filter of the Customize panel is set in the params ("Income and expense accounts only" counts as Accounts, "No class only" as Classes). */
export function filterIsSet(kind: FilterKind, rp: Record<string, string>): boolean {
  const keys = [...FILTER_PARAMS[kind].set, ...(kind === 'accounts' ? FILTER_PARAMS.plOnly.set : kind === 'classes' ? FILTER_PARAMS.noClass.set : [])];
  return keys.some((p) => rp[p] !== undefined && rp[p] !== '');
}

/**
 * Filters set in `rp` that a report does not offer, so it could neither show them nor turn them
 * off ("Compare to" switches to another report with the same params): their names and the params
 * to remove.
 */
export function unusableFilters(info: ReportInfo, rp: Record<string, string>): { labels: string[]; params: string[] } {
  const has = new Set<string>(supportedFilters(info));
  if (has.has('accounts') && offersPlOnly(info)) has.add('plOnly');
  if (has.has('classes') && offersNoClass(info)) has.add('noClass');
  const labels: string[] = [];
  const params: string[] = [];
  for (const [kind, f] of Object.entries(FILTER_PARAMS)) {
    if (has.has(kind) || !f.set.some((p) => rp[p] !== undefined && rp[p] !== '')) continue;
    labels.push(f.label);
    params.push(...f.set, ...(f.also ?? []));
  }
  return { labels, params };
}

/** Reports that cannot run without a record id (the window asks for it first). */
export const REQUIRED_ID: Record<string, 'accountId' | 'nameId' | 'itemId'> = {
  account_quickreport: 'accountId',
  name_quickreport: 'nameId',
  item_quickreport: 'itemId',
};

/** Plain-English prompt shown while a required id is missing. */
export const REQUIRED_ID_PROMPT: Record<string, string> = {
  accountId: 'Choose an account in the Account box above to see its transactions.',
  nameId: 'Choose a customer, vendor or other name in the Name box above to see its transactions.',
  itemId: 'Choose an item in the Item box above to see its transactions.',
};

/** Reports the Report Center offers (activity reports need a record and are opened from lists). */
export function isListedReport(r: Pick<ReportInfo, 'key' | 'category'>): boolean {
  return r.category !== 'Activity Reports' && !r.key.endsWith('_quickreport');
}

/** False when the company's preferences turn the report's feature off. */
export function reportEnabled(r: Pick<ReportInfo, 'key' | 'category'>, prefs: Prefs): boolean {
  const k = r.key;
  if (!prefs.useClassTracking && (k === 'profit_loss_by_class' || k === 'profit_loss_unclassified')) return false;
  if (!prefs.salesTaxEnabled && k.startsWith('sales_tax_')) return false;
  if (!prefs.inventoryEnabled && r.category === 'Inventory') return false;
  if (!prefs.purchaseOrdersEnabled && k.startsWith('open_purchase_orders')) return false;
  if (!prefs.estimatesEnabled && k === 'job_estimates_vs_actuals_summary') return false;
  return true;
}

/** Category order of the Report Center (server order, activity reports last). */
export const CATEGORY_ORDER = [
  'Financial Statements',
  'Customers and Invoices',
  'Sales',
  'Jobs',
  'Vendors and Bills',
  'Purchases',
  'Inventory',
  'Banking',
  'For Your Accountant',
  'Budgets',
  'Lists',
];

/** Short plain-English description of each category (Report Center headings). */
export const CATEGORY_HELP: Record<string, string> = {
  'Financial Statements': 'Profit and loss, balance sheet and cash flow: how your business is doing overall.',
  'Customers and Invoices': 'Who owes you money, how much, and for how long.',
  Sales: 'What you sold, to whom, and by which sales rep.',
  Jobs: 'Profit and estimates compared with actual results for each job.',
  'Vendors and Bills': 'What you owe your vendors and the sales tax you owe.',
  Purchases: 'What you bought and from whom, and open purchase orders.',
  Inventory: 'What your inventory is worth and what you need to reorder.',
  Banking: 'Deposits, checks and missing check numbers.',
  'For Your Accountant': 'Trial balance, general ledger, journal and audit trail.',
  Budgets: 'Your budgets compared with actual results.',
  Lists: 'Printable lists of accounts, items, terms, customers and vendors.',
};

/** Memorized report groups offered by default. */
export const DEFAULT_GROUPS = ['Accountant', 'Banking', 'Company', 'Customers', 'Vendors'];
