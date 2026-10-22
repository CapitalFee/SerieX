// What each payroll report supports in the report window: the parameters it takes (from the
// server catalog, GET /reports), "Show columns" choices, and the Report Center categories.
import type { ReportInfo } from '@/api/types';
import { CATEGORY_PAYROLL, CATEGORY_TAX_FORMS, REPORT_CATEGORY_ORDER, STATIC_REPORTS } from '@/state/catalog';

/** One choice of a drop-down. */
export interface Opt {
  value: string;
  label: string;
}

/** Parameters each report takes when the server catalog is not loaded yet (same as the server). */
const STATIC_PARAMS: Record<string, { params: string[]; dates: string }> = {
  payroll_summary: { params: ['dates', 'employeeId', 'columns'], dates: 'thisFiscalQuarter' },
  payroll_item_detail: { params: ['dates', 'employeeId', 'itemId', 'includeVoided'], dates: 'thisMonthToDate' },
  payroll_detail_review: { params: ['dates', 'employeeId', 'itemId', 'differences'], dates: 'thisMonthToDate' },
  payroll_register: { params: ['dates', 'employeeId', 'includeVoided'], dates: 'thisFiscalQuarter' },
  employee_earnings_summary: { params: ['dates', 'employeeId'], dates: 'thisFiscalQuarter' },
  payroll_liability_balances: { params: ['dates', 'columns'], dates: 'thisFiscalYear' },
  payroll_transactions_by_payee: { params: ['dates', 'employeeId', 'includeVoided'], dates: 'thisMonthToDate' },
  payroll_transaction_detail: { params: ['dates', 'employeeId', 'itemId', 'includeVoided'], dates: 'thisMonthToDate' },
  payroll_journal: { params: ['dates', 'employeeId'], dates: 'thisMonthToDate' },
  employee_state_taxes_detail: { params: ['dates', 'employeeId', 'itemId', 'state'], dates: 'thisFiscalYearToDate' },
  employee_withholding: { params: ['employeeId', 'active'], dates: 'today' },
  paid_time_off_list: { params: ['asOf', 'employeeId', 'active'], dates: 'today' },
  employee_contact_list: { params: ['employeeId', 'active'], dates: 'today' },
  payroll_item_listing: { params: ['itemId', 'active'], dates: 'today' },
  tax_form_941_worksheet: { params: ['year', 'quarter'], dates: 'thisFiscalQuarter' },
  tax_form_940_worksheet: { params: ['year'], dates: 'thisFiscalYear' },
};

/** Report information with defaults for reports missing from the server catalog. */
export function reportInfo(catalog: ReportInfo[] | undefined, key: string): ReportInfo {
  const hit = catalog?.find((r) => r.key === key);
  if (hit) return hit;
  const st = STATIC_REPORTS.find((r) => r.key === key);
  const p = STATIC_PARAMS[key];
  return {
    key,
    title: st?.title ?? 'Report',
    category: st?.category ?? '',
    description: st?.description ?? '',
    params: p?.params ?? ['dates'],
    defaultDates: p?.dates ?? 'thisMonthToDate',
  };
}

/** True when the report has this parameter. */
export const hasParam = (info: ReportInfo, p: string) => info.params.includes(p);

/** "Show columns" choices of the reports that have them (null when the report has none). */
export function columnOptions(info: ReportInfo): Opt[] | null {
  if (!hasParam(info, 'columns')) return null;
  if (info.key === 'payroll_summary') {
    return [
      { value: 'employee', label: 'Employee' },
      { value: 'total', label: 'Total only' },
      { value: 'month', label: 'Month' },
      { value: 'quarter', label: 'Quarter' },
      { value: 'year', label: 'Year' },
    ];
  }
  return [
    { value: 'month', label: 'Month' },
    { value: 'quarter', label: 'Quarter' },
    { value: 'year', label: 'Year' },
    { value: 'total', label: 'Total only' },
  ];
}

/** Default "Show columns" value of a report (same as the server). */
export function defaultColumns(key: string): string {
  return key === 'payroll_summary' ? 'employee' : 'month';
}

/** Report period labels for payroll: quarters and years are calendar periods. */
export function payrollPresetLabel(label: string): string {
  return label.replace(/Fiscal/g, 'Calendar');
}

/** Reports the Report Center offers. */
export function isListedReport(r: Pick<ReportInfo, 'key' | 'category'>): boolean {
  return r.category !== 'Activity Reports' && !r.key.endsWith('_quickreport');
}

/** Category order of the Report Center (server order, unknown categories last). */
export const CATEGORY_ORDER = REPORT_CATEGORY_ORDER;

/** Short plain-English description of each category (Report Center headings). */
export const CATEGORY_HELP: Record<string, string> = {
  [CATEGORY_PAYROLL]: 'Wages, taxes, deductions and net pay by employee and payroll item, liabilities owed, and what payroll posted to SerieX Books.',
  [CATEGORY_TAX_FORMS]: 'Worksheets with the lines of the federal payroll tax returns, computed from your paychecks.',
};
