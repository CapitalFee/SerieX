// Payroll report catalog used by the Reports menu, the icon bar and report window titles.
// The server catalog (GET /reports) replaces the static fallback once loaded.
import type { ReportInfo } from '@/api/types';

/** Report menu entry (subset of the server ReportInfo). */
export type CatalogEntry = Pick<ReportInfo, 'key' | 'title' | 'category'> & Partial<Pick<ReportInfo, 'description' | 'params' | 'defaultDates'>>;

export const CATEGORY_PAYROLL = 'Payroll and Employees';
export const CATEGORY_TAX_FORMS = 'Tax Forms';

/** Category order of the Reports menu and the Report Center. Unknown categories go last. */
export const REPORT_CATEGORY_ORDER = [CATEGORY_PAYROLL, CATEGORY_TAX_FORMS];

/** Categories that need a selected record and are not listed in the menu. */
export const HIDDEN_REPORT_CATEGORIES = ['Activity Reports'];

const S = (category: string, rows: [string, string, string][]): CatalogEntry[] =>
  rows.map(([key, title, description]) => ({ key, title, category, description }));

/** Static fallback used until GET /reports answers. */
export const STATIC_REPORTS: CatalogEntry[] = [
  ...S(CATEGORY_PAYROLL, [
    ['payroll_summary', 'Payroll Summary', 'Total wages, taxes withheld, deductions from net pay, net pay and employer-paid taxes and contributions for each employee.'],
    ['payroll_item_detail', 'Payroll Item Detail', 'Each payroll transaction, grouped by payroll item.'],
    ['payroll_detail_review', 'Payroll Detail Review', 'Calculated and actual amounts of every paycheck line, with the difference when an amount was changed by hand.'],
    ['payroll_register', 'Payroll Register', 'One line per paycheck: hours, gross pay, taxes, deductions, net pay and employer costs.'],
    ['employee_earnings_summary', 'Employee Earnings Summary', 'Payroll item totals for each employee.'],
    ['payroll_liability_balances', 'Payroll Liability Balances', 'Payroll liabilities accrued, adjusted and paid, and what is still owed.'],
    ['payroll_transactions_by_payee', 'Payroll Transactions by Payee', 'Paychecks, tax payments and tax balance adjustments, grouped by employee or agency.'],
    ['payroll_transaction_detail', 'Payroll Transaction Detail', 'Every payroll transaction line with its payroll item, wage base and account.'],
    ['payroll_journal', 'Payroll Journal (SerieX Books postings)', 'The debits and credits payroll posted to SerieX Books, with account totals.'],
    ['employee_state_taxes_detail', 'Employee State Taxes Detail', 'State taxes withheld and paid for each employee, grouped by state.'],
    ['employee_withholding', 'Employee Withholding', 'Federal and state withholding setup of each employee.'],
    ['paid_time_off_list', 'Paid Time Off List', 'Sick and vacation hours available and used this year for each employee.'],
    ['employee_contact_list', 'Employee Contact List', 'Address, phone, email and hire date of each employee.'],
    ['payroll_item_listing', 'Payroll Item Settings', 'Every payroll item with its rate, limit, accounts, tax treatment and agency.'],
  ]),
  ...S(CATEGORY_TAX_FORMS, [
    ['tax_form_941_worksheet', 'Form 941 Worksheet', 'Lines of the quarterly Form 941 computed from the paychecks of the quarter.'],
    ['tax_form_940_worksheet', 'Form 940 Worksheet', 'Lines of the annual Form 940 computed from the paychecks of the year.'],
  ]),
];

/** Reports listed in the left icon bar "Run Favorite Reports" tab (fixed list). */
export const FAVORITE_REPORTS = [
  'payroll_summary',
  'payroll_register',
  'payroll_liability_balances',
  'employee_earnings_summary',
  'payroll_item_detail',
  'payroll_detail_review',
  'paid_time_off_list',
  'payroll_journal',
];

let serverCatalog: ReportInfo[] | null = null;

/** Store the server catalog (called by the shell after GET /reports). */
export function setReportCatalog(list: ReportInfo[] | null) {
  serverCatalog = list && list.length ? list : null;
}

/** Catalog to show: the server one when loaded, else the static fallback. */
export function reportCatalog(): CatalogEntry[] {
  return serverCatalog ?? STATIC_REPORTS;
}

/** Title of a report key ('' when unknown). */
export function reportTitle(key: string | undefined): string {
  if (!key) return '';
  const hit = serverCatalog?.find((r) => r.key === key) ?? STATIC_REPORTS.find((r) => r.key === key);
  return hit?.title ?? '';
}

/** Reports grouped by category in menu order (hidden categories removed). */
export function reportsByCategory(list: CatalogEntry[] = reportCatalog()): { category: string; reports: CatalogEntry[] }[] {
  const groups = new Map<string, CatalogEntry[]>();
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
