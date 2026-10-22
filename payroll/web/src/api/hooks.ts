// React-query hooks for the SerieX Payroll API.
//
// Query keys (use them with queryClient.invalidateQueries / setQueryData):
//   ['meta']  ['app-info']  ['company']  ['prefs']  ['state-settings']  ['access']
//   ['employees', params]  ['employee', id]  ['employee-summary', id, year]  ['employee-defaults']
//   ['items', params]  ['pay-schedules', params]
//   ['books', 'accounts', types]  ['books', 'vendors']  ['books', 'classes']  ['books', 'jobs']
//   ['books', 'status']  ['books', 'sync', params]
//   ['paychecks', params]  ['paycheck', id]  ['payroll', 'scheduled']
//   ['liabilities', 'due', params]  ['liabilities', 'balances', params]  ['payment-schedules']
//   ['liability-payments', params]  ['liability-adjustments', params]
//   ['filings', year]  ['report', key, params]  ['reports-catalog']
//
// The cache is partitioned by company: the query hash includes the open company id, so data of
// one company file is never shown for another one, while the keys above stay as documented.
// Global data (meta, app info) is fetched from /api/... and works without an open company.
import { QueryClient, hashKey, keepPreviousData, useQuery, type QueryKey } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, getCompanyId, qs } from './client';
import type {
  AppInfo,
  BooksAccount,
  BooksListEntry,
  BooksName,
  BooksStatus,
  Employee,
  EmployeeDefaults,
  EmployeeSummary,
  FormFiling,
  Id,
  ItemType,
  LiabilityAdjustment,
  LiabilityBalance,
  LiabilityDue,
  LiabilityPayment,
  Meta,
  Paycheck,
  PaycheckKind,
  PaycheckSummary,
  PaymentSchedule,
  PayrollCompany,
  PayrollItem,
  PayrollPrefs,
  PaySchedule,
  ReportInfo,
  ReportResult,
  ScheduledPayroll,
  StateSettings,
  SyncItem,
} from './types';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 0,
      queryKeyHashFn: (key: QueryKey) => (getCompanyId() ?? '') + '|' + hashKey(key),
    },
  },
});

/** Refresh every open window after a change (called after every save/delete). */
export function invalidateAll(): Promise<void> {
  return queryClient.invalidateQueries();
}

const hasCompany = () => !!getCompanyId();

/** "active" filter of list endpoints (server default is "active"). */
export type ActiveFilter = 'all' | 'active' | 'inactive';

// ---------------------------------------------------------------------------
// Global

/** Lists for pickers and wizards (GET /api/meta): item types, tax codes, states, statuses... */
export function useMeta() {
  return useQuery({
    queryKey: ['meta'],
    queryFn: ({ signal }) => api.global.get<Meta>('/meta', { signal, noPrompt: true }),
    staleTime: Infinity,
  });
}

/** Application info and SerieX Books reachability (GET /api/info). */
export function useAppInfo() {
  return useQuery({
    queryKey: ['app-info'],
    queryFn: ({ signal }) => api.global.get<AppInfo>('/info', { signal, noPrompt: true }),
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Company

/** Company payroll information (GET /company). */
export function useCompany() {
  return useQuery({
    queryKey: ['company'],
    queryFn: ({ signal }) => api.get<PayrollCompany>('/company', { signal }),
    enabled: hasCompany(),
  });
}

/** Default preferences (same as the server's DefaultPrefs), used until /prefs is loaded. */
export const DEFAULT_PREFS: PayrollPrefs = {
  defaultBankAccountId: null,
  displayNameOrder: 'first',
  copyEarningsFromPrevious: true,
  recallHours: true,
  jobCosting: false,
  classTracking: 'none',
  showSsnOnReports: false,
  postToBooks: true,
  payStubShowCompanyAddress: true,
  payStubShowPto: true,
  payStubShowYtd: true,
  payStubShowSsnLast4: true,
  warnDuplicateCheckNumbers: true,
  dueSoonDays: 14,
};

/** Payroll preferences (GET /prefs). See also {@link usePrefValues}. */
export function usePrefs() {
  return useQuery({
    queryKey: ['prefs'],
    queryFn: ({ signal }) => api.get<PayrollPrefs>('/prefs', { signal }),
    enabled: hasCompany(),
    staleTime: 5 * 60_000,
  });
}

/** Payroll preferences with defaults filled in while loading (never undefined). */
export function usePrefValues(): PayrollPrefs {
  const { data } = usePrefs();
  return useMemo(() => ({ ...DEFAULT_PREFS, ...(data ?? {}) }), [data]);
}

/** State tax settings of the company (GET /state-settings): ids and UI rates per state. */
export function useStateSettings() {
  return useQuery({
    queryKey: ['state-settings'],
    queryFn: ({ signal }) => api.get<StateSettings[]>('/state-settings', { signal }),
    enabled: hasCompany(),
  });
}

/** Payroll access list (GET /access). */
export function useAccess() {
  return useQuery({
    queryKey: ['access'],
    queryFn: ({ signal }) => api.get<{ users: string[]; booksUsers: { name: string; isAdmin: boolean }[] }>('/access', { signal }),
    enabled: hasCompany(),
  });
}

// ---------------------------------------------------------------------------
// Employees

/** Parameters of {@link useEmployees}. */
export interface EmployeesParams {
  /** Default "active". Pickers use "all" so a selected inactive employee still shows. */
  active?: ActiveFilter;
  /** Server side text search. */
  q?: string;
}

/** Employees sorted by display name (GET /employees), SSNs masked. */
export function useEmployees(params: EmployeesParams = {}) {
  return useQuery({
    queryKey: ['employees', params],
    queryFn: ({ signal }) => api.get<Employee[]>('/employees' + qs({ active: params.active, q: params.q }), { signal }),
    enabled: hasCompany(),
  });
}

/** One employee (GET /employees/{id}); disabled when id is 0/null. */
export function useEmployee(id: Id | null | undefined) {
  return useQuery({
    queryKey: ['employee', id ?? 0],
    queryFn: ({ signal }) => api.get<Employee>(`/employees/${id}`, { signal }),
    enabled: hasCompany() && !!id,
  });
}

/** Year-to-date summary of an employee (GET /employees/{id}/summary?year=). */
export function useEmployeeSummary(id: Id | null | undefined, year?: number) {
  return useQuery({
    queryKey: ['employee-summary', id ?? 0, year ?? null],
    queryFn: ({ signal }) => api.get<EmployeeSummary>(`/employees/${id}/summary` + qs({ year }), { signal }),
    enabled: hasCompany() && !!id,
  });
}

/** New employee defaults (GET /employee-defaults). */
export function useEmployeeDefaults() {
  return useQuery({
    queryKey: ['employee-defaults'],
    queryFn: ({ signal }) => api.get<EmployeeDefaults>('/employee-defaults', { signal }),
    enabled: hasCompany(),
  });
}

// ---------------------------------------------------------------------------
// Payroll items and pay schedules

/** Parameters of {@link useItems}. */
export interface ItemsParams {
  types?: ItemType[];
  active?: ActiveFilter;
}

/** Payroll items sorted by type then name (GET /items). */
export function useItems(params: ItemsParams = {}) {
  return useQuery({
    queryKey: ['items', params],
    queryFn: ({ signal }) => api.get<PayrollItem[]>('/items' + qs({ active: params.active, types: params.types }), { signal }),
    enabled: hasCompany(),
  });
}

/** Map id → payroll item of every item (active and inactive). */
export function useItemsById(): Map<Id, PayrollItem> {
  const { data } = useItems({ active: 'all' });
  return useMemo(() => new Map((data ?? []).map((i) => [i.id, i])), [data]);
}

/** Pay schedules (GET /pay-schedules). */
export function usePaySchedules(params: { active?: ActiveFilter } = {}) {
  return useQuery({
    queryKey: ['pay-schedules', params],
    queryFn: ({ signal }) => api.get<PaySchedule[]>('/pay-schedules' + qs({ active: params.active }), { signal }),
    enabled: hasCompany(),
  });
}

// ---------------------------------------------------------------------------
// SerieX Books lists (through the payroll server)

/**
 * SerieX Books accounts (GET /books/accounts?types=), active and inactive, in Books order.
 * `types` are Books account types ("Bank", "Expense", "Other Current Liability"...).
 */
export function useBooksAccounts(types?: string[]) {
  const t = types && types.length ? [...types] : undefined;
  return useQuery({
    queryKey: ['books', 'accounts', t ?? null],
    queryFn: ({ signal }) => api.get<BooksAccount[]>('/books/accounts' + qs({ types: t }), { signal }),
    enabled: hasCompany(),
  });
}

/** Map id → Books account (every account). */
export function useBooksAccountsById(): Map<Id, BooksAccount> {
  const { data } = useBooksAccounts();
  return useMemo(() => new Map((data ?? []).map((a) => [a.id, a])), [data]);
}

/** SerieX Books vendors (GET /books/vendors): tax agencies and benefit providers. */
export function useBooksVendors() {
  return useQuery({
    queryKey: ['books', 'vendors'],
    queryFn: ({ signal }) => api.get<BooksName[]>('/books/vendors', { signal }),
    enabled: hasCompany(),
  });
}

/** SerieX Books classes (GET /books/classes). */
export function useBooksClasses() {
  return useQuery({
    queryKey: ['books', 'classes'],
    queryFn: ({ signal }) => api.get<BooksListEntry[]>('/books/classes', { signal }),
    enabled: hasCompany(),
  });
}

/** SerieX Books customers and jobs (GET /books/jobs), full names "Customer:Job". */
export function useBooksJobs() {
  return useQuery({
    queryKey: ['books', 'jobs'],
    queryFn: ({ signal }) => api.get<BooksName[]>('/books/jobs', { signal }),
    enabled: hasCompany(),
  });
}

/** Link status with SerieX Books (GET /books/status). Refreshed every minute. */
export function useBooksStatus() {
  return useQuery({
    queryKey: ['books', 'status'],
    queryFn: ({ signal }) => api.get<BooksStatus>('/books/status', { signal, noPrompt: true }),
    enabled: hasCompany(),
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
}

/** Records not (yet) posted to SerieX Books (GET /books/sync?status=open|all&from=&to=). */
export function useBooksSync(params: { status?: 'open' | 'all'; from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: ['books', 'sync', params],
    queryFn: ({ signal }) => api.get<SyncItem[]>('/books/sync' + qs(params), { signal }),
    enabled: hasCompany(),
  });
}

// ---------------------------------------------------------------------------
// Paychecks and payroll runs

/** Query parameters of GET /paychecks. */
export interface PaychecksParams {
  employeeId?: Id | null;
  from?: string;
  to?: string;
  kind?: PaycheckKind;
  runId?: Id | null;
  includeVoided?: boolean;
  q?: string;
}

/** Paycheck list, newest first (GET /paychecks). Keeps the previous rows while refetching. */
export function usePaychecks(params: PaychecksParams = {}, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['paychecks', params],
    queryFn: ({ signal }) =>
      api.get<PaycheckSummary[]>('/paychecks' + qs({ ...params, includeVoided: params.includeVoided ? 1 : undefined }), { signal }),
    enabled: hasCompany() && opts.enabled !== false,
    placeholderData: keepPreviousData,
  });
}

/** One saved paycheck with its lines and summaries (GET /paychecks/{id}). */
export function usePaycheck(id: Id | null | undefined) {
  return useQuery({
    queryKey: ['paycheck', id ?? 0],
    queryFn: ({ signal }) => api.get<Paycheck>(`/paychecks/${id}`, { signal }),
    enabled: hasCompany() && !!id,
  });
}

/** Next payrolls of the active pay schedules (GET /payroll/scheduled). */
export function useScheduledPayrolls() {
  return useQuery({
    queryKey: ['payroll', 'scheduled'],
    queryFn: ({ signal }) => api.get<ScheduledPayroll[]>('/payroll/scheduled', { signal }),
    enabled: hasCompany(),
  });
}

// ---------------------------------------------------------------------------
// Liabilities

/** Parameters of {@link useLiabilitiesDue}. */
export interface LiabilitiesDueParams {
  from?: string;
  to?: string;
  showPaid?: boolean;
}

/** Scheduled liabilities with due dates and status (GET /liabilities/due). */
export function useLiabilitiesDue(params: LiabilitiesDueParams = {}, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['liabilities', 'due', params],
    queryFn: ({ signal }) => api.get<LiabilityDue[]>('/liabilities/due' + qs({ ...params, showPaid: params.showPaid ? 1 : 0 }), { signal }),
    enabled: hasCompany() && opts.enabled !== false,
  });
}

/** Liability balances by payroll item (GET /liabilities/balances?from&to). */
export function useLiabilityBalances(params: { from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: ['liabilities', 'balances', params],
    queryFn: ({ signal }) => api.get<LiabilityBalance[]>('/liabilities/balances' + qs(params), { signal }),
    enabled: hasCompany(),
  });
}

/** Tax payment schedule: how and when each payment group is paid (GET /payment-schedules). */
export function usePaymentSchedules() {
  return useQuery({
    queryKey: ['payment-schedules'],
    queryFn: ({ signal }) => api.get<PaymentSchedule[]>('/payment-schedules', { signal }),
    enabled: hasCompany(),
  });
}

/** Liability payments (GET /liability-payments?from&to&kind). */
export function useLiabilityPayments(params: { from?: string; to?: string; kind?: 'payment' | 'prior' } = {}) {
  return useQuery({
    queryKey: ['liability-payments', params],
    queryFn: ({ signal }) => api.get<LiabilityPayment[]>('/liability-payments' + qs(params), { signal }),
    enabled: hasCompany(),
    placeholderData: keepPreviousData,
  });
}

/** Tax balance adjustments (GET /liability-adjustments?from&to). */
export function useLiabilityAdjustments(params: { from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: ['liability-adjustments', params],
    queryFn: ({ signal }) => api.get<LiabilityAdjustment[]>('/liability-adjustments' + qs(params), { signal }),
    enabled: hasCompany(),
    placeholderData: keepPreviousData,
  });
}

// ---------------------------------------------------------------------------
// Tax forms

/** Forms to file with status and due dates (GET /forms/filings). `year` filters on the client. */
export function useFilings(year?: number) {
  return useQuery({
    queryKey: ['filings', year ?? null],
    queryFn: ({ signal }) => api.get<FormFiling[]>('/forms/filings' + qs({ year }), { signal }),
    enabled: hasCompany(),
    select: (rows: FormFiling[]) => (year ? rows.filter((r) => r.year === year) : rows),
  });
}

// ---------------------------------------------------------------------------
// Reports

/** Runs a report (GET /reports/{key}?params). Keeps the previous result while params change. */
export function useReport(key: string | null | undefined, params: Record<string, string> = {}, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['report', key ?? '', params],
    queryFn: ({ signal }) => api.get<ReportResult>(`/reports/${key}` + qs(params), { signal }),
    enabled: hasCompany() && !!key && opts.enabled !== false,
    placeholderData: keepPreviousData,
    staleTime: 0,
  });
}

/** Report catalog (GET /reports). The shell copies it into state/catalog for menus and titles. */
export function useReportCatalog() {
  return useQuery({
    queryKey: ['reports-catalog'],
    queryFn: ({ signal }) => api.get<ReportInfo[]>('/reports', { signal, noPrompt: true }),
    enabled: hasCompany(),
    staleTime: 10 * 60_000,
  });
}
