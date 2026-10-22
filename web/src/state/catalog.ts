// Report catalog used by the Reports menu and for report window titles.
// The server catalog (GET /reports) replaces the static fallback once loaded.
import type { ReportInfo } from '@/api/types';

/** Category order of the Reports menu. Unknown categories go last. */
export const REPORT_CATEGORY_ORDER = [
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

/** Categories that need a selected record and are not listed in the menu. */
export const HIDDEN_REPORT_CATEGORIES = ['Activity Reports'];

const S = (category: string, rows: [string, string][]): Pick<ReportInfo, 'key' | 'title' | 'category'>[] =>
  rows.map(([key, title]) => ({ key, title, category }));

/** Static fallback used until GET /reports answers. */
export const STATIC_REPORTS: Pick<ReportInfo, 'key' | 'title' | 'category'>[] = [
  ...S('Financial Statements', [
    ['profit_loss', 'Profit and Loss'],
    ['profit_loss_detail', 'Profit and Loss Detail'],
    ['profit_loss_ytd', 'Profit and Loss: Year-to-Date Comparison'],
    ['profit_loss_prev_year', 'Profit and Loss: This Year vs. Last Year'],
    ['profit_loss_by_job', 'Profit and Loss by Job'],
    ['profit_loss_by_class', 'Profit and Loss by Class'],
    ['profit_loss_unclassified', 'Profit and Loss: No Class'],
    ['income_by_customer_summary', 'Income by Customer Summary'],
    ['income_by_customer_detail', 'Income by Customer Detail'],
    ['expenses_by_vendor_summary', 'Expenses by Vendor Summary'],
    ['expenses_by_vendor_detail', 'Expenses by Vendor Detail'],
    ['balance_sheet', 'Balance Sheet'],
    ['balance_sheet_detail', 'Balance Sheet Detail'],
    ['balance_sheet_summary', 'Balance Sheet Summary'],
    ['balance_sheet_prev_year', 'Balance Sheet: This Year vs. Last Year'],
    ['cash_flows', 'Statement of Cash Flows'],
  ]),
  ...S('Customers and Invoices', [
    ['ar_aging_summary', 'A/R Aging Summary'],
    ['ar_aging_detail', 'A/R Aging Detail'],
    ['customer_balance_summary', 'Customer Balance Summary'],
    ['customer_balance_detail', 'Customer Balance Detail'],
    ['open_invoices', 'Open Invoices'],
    ['collections', 'Overdue Invoices with Contacts'],
    ['transaction_list_by_customer', 'Transaction List by Customer'],
  ]),
  ...S('Sales', [
    ['sales_by_customer_summary', 'Sales by Customer Summary'],
    ['sales_by_customer_detail', 'Sales by Customer Detail'],
    ['sales_by_item_summary', 'Sales by Item Summary'],
    ['sales_by_item_detail', 'Sales by Item Detail'],
    ['sales_by_rep_summary', 'Sales by Rep Summary'],
    ['sales_by_rep_detail', 'Sales by Rep Detail'],
    ['pending_sales', 'Pending Sales'],
  ]),
  ...S('Jobs', [
    ['job_profitability_summary', 'Job Profitability Summary'],
    ['job_estimates_vs_actuals_summary', 'Job Estimates vs. Actuals Summary'],
  ]),
  ...S('Vendors and Bills', [
    ['ap_aging_summary', 'A/P Aging Summary'],
    ['ap_aging_detail', 'A/P Aging Detail'],
    ['vendor_balance_summary', 'Vendor Balance Summary'],
    ['vendor_balance_detail', 'Vendor Balance Detail'],
    ['unpaid_bills_detail', 'Unpaid Bills Detail'],
    ['transaction_list_by_vendor', 'Transaction List by Vendor'],
    ['sales_tax_liability', 'Sales Tax Liability'],
    ['sales_tax_revenue_summary', 'Sales Tax Revenue Summary'],
  ]),
  ...S('Purchases', [
    ['purchases_by_vendor_summary', 'Purchases by Vendor Summary'],
    ['purchases_by_vendor_detail', 'Purchases by Vendor Detail'],
    ['purchases_by_item_summary', 'Purchases by Item Summary'],
    ['purchases_by_item_detail', 'Purchases by Item Detail'],
    ['open_purchase_orders', 'Open Purchase Orders'],
    ['open_purchase_orders_detail', 'Open Purchase Orders Detail'],
  ]),
  ...S('Inventory', [
    ['inventory_valuation_summary', 'Inventory Valuation Summary'],
    ['inventory_valuation_detail', 'Inventory Valuation Detail'],
    ['inventory_stock_status_by_item', 'Inventory Stock Status by Item'],
    ['inventory_stock_status_by_vendor', 'Inventory Stock Status by Vendor'],
    ['physical_inventory_worksheet', 'Physical Inventory Worksheet'],
  ]),
  ...S('Banking', [
    ['deposit_detail', 'Deposit Detail'],
    ['check_detail', 'Check Detail'],
    ['missing_checks', 'Missing Checks'],
  ]),
  ...S('For Your Accountant', [
    ['trial_balance', 'Trial Balance'],
    ['general_ledger', 'General Ledger'],
    ['journal', 'Journal'],
    ['transaction_detail_by_account', 'Transaction Detail by Account'],
    ['transaction_list_by_date', 'Transaction List by Date'],
    ['audit_trail', 'Audit Trail'],
    ['custom_summary', 'Custom Summary Report'],
    ['custom_transaction_detail', 'Custom Transaction Detail Report'],
  ]),
  ...S('Budgets', [
    ['budget_overview', 'Budget Overview'],
    ['budget_vs_actual', 'Budget vs. Actual'],
    ['profit_loss_budget_performance', 'Budget Progress (Profit and Loss)'],
  ]),
  ...S('Lists', [
    ['account_listing', 'Account Listing'],
    ['item_listing', 'Item Listing'],
    ['item_price_list', 'Item Price List'],
    ['terms_listing', 'Terms Listing'],
    ['customer_phone_list', 'Customer Phone List'],
    ['customer_contact_list', 'Customer Contact List'],
    ['vendor_phone_list', 'Vendor Phone List'],
    ['vendor_contact_list', 'Vendor Contact List'],
    ['other_names_phone_list', 'Other Names Phone List'],
  ]),
  ...S('Activity Reports', [
    ['account_quickreport', 'Account Activity'],
    ['name_quickreport', 'Name Activity'],
    ['item_quickreport', 'Item Activity'],
  ]),
];

let serverCatalog: ReportInfo[] | null = null;

/** Store the server catalog (called by the shell after GET /reports). */
export function setReportCatalog(list: ReportInfo[] | null) {
  serverCatalog = list && list.length ? list : null;
}

/** Catalog to show: the server one when loaded, else the static fallback. */
export function reportCatalog(): Pick<ReportInfo, 'key' | 'title' | 'category'>[] {
  return serverCatalog ?? STATIC_REPORTS;
}

/** Title of a report key ('' when unknown). */
export function reportTitle(key: string | undefined): string {
  if (!key) return '';
  const hit = serverCatalog?.find((r) => r.key === key) ?? STATIC_REPORTS.find((r) => r.key === key);
  return hit?.title ?? '';
}

/** Reports grouped by category in menu order (hidden categories removed). */
export function reportsByCategory(list = reportCatalog()): { category: string; reports: Pick<ReportInfo, 'key' | 'title' | 'category'>[] }[] {
  const groups = new Map<string, Pick<ReportInfo, 'key' | 'title' | 'category'>[]>();
  for (const r of list) {
    if (HIDDEN_REPORT_CATEGORIES.includes(r.category) || r.key.endsWith('_quickreport')) continue;
    if (!groups.has(r.category)) groups.set(r.category, []);
    groups.get(r.category)!.push(r);
  }
  const rank = (c: string) => {
    const i = REPORT_CATEGORY_ORDER.indexOf(c);
    return i < 0 ? 999 : i;
  };
  return Array.from(groups.entries())
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([category, reports]) => ({ category, reports }));
}
