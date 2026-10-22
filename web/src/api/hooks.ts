// React-query hooks for server data (the REST endpoints of the server).
//
// Query keys (use them with queryClient.invalidateQueries / setQueryData):
//   ['accounts', params]  ['names', kind, params]  ['items', params]  ['list', list]
//   ['company']  ['prefs']  ['txn', id]  ['txns', params]  ['register', accountId, params]
//   ['report', key, params]  ['reports-catalog']  ['open-docs', params]  ['undeposited', params]
//   ['name-summary', id]  ['next-ref', type, accountId]  ['ai-assistants']
//
// The cache is partitioned by company: the query hash includes the open company id, so data of
// one company file is never shown for another one, while the keys above stay as documented.
import { QueryClient, hashKey, keepPreviousData, useQuery, type QueryKey } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api, getCompanyId, qs } from './client';
import type {
  Account,
  AccountType,
  AiAccessKey,
  AiAssistantsSettings,
  AiAssistantsStatus,
  AiSetupResult,
  AiSetupTarget,
  CompanyInfo,
  ID,
  Item,
  ItemType,
  ListEntry,
  ListName,
  Name,
  NameKind,
  OpenDocsResult,
  Prefs,
  RegisterResult,
  ReportInfo,
  ReportResult,
  Txn,
  TxnListResult,
  TxnType,
  UndepositedItem,
} from './types';

/** The app's react-query client (App wraps everything in <QueryClientProvider client={queryClient}>). */
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
// Lists

/** Parameters of {@link useAccounts}. */
export interface AccountsParams {
  /** Only these account types (server side filter). */
  types?: AccountType[];
  /** Default "active". Pickers use "all" so a selected inactive account still shows. */
  active?: ActiveFilter;
}

/** Chart of accounts in tree order (GET /accounts). Balances are in natural sign. */
export function useAccounts(params: AccountsParams = {}) {
  return useQuery({
    queryKey: ['accounts', params],
    queryFn: ({ signal }) => api.get<Account[]>('/accounts' + qs({ active: params.active, types: params.types }), { signal }),
    enabled: hasCompany(),
  });
}

/** Parameters of {@link useNames}. */
export interface NamesParams {
  active?: ActiveFilter;
  /** Server side text search. */
  q?: string;
}

/**
 * Customers (with jobs in tree order), vendors or other names (GET /names).
 * `kind` undefined returns every kind.
 */
export function useNames(kind?: NameKind, params: NamesParams = {}) {
  return useQuery({
    queryKey: ['names', kind ?? null, params],
    queryFn: ({ signal }) => api.get<Name[]>('/names' + qs({ kind, active: params.active, q: params.q }), { signal }),
    enabled: hasCompany(),
  });
}

/** Parameters of {@link useItems}. */
export interface ItemsParams {
  types?: ItemType[];
  active?: ActiveFilter;
}

/** Item list in tree order (GET /items). */
export function useItems(params: ItemsParams = {}) {
  return useQuery({
    queryKey: ['items', params],
    queryFn: ({ signal }) => api.get<Item[]>('/items' + qs({ active: params.active, types: params.types }), { signal }),
    enabled: hasCompany(),
  });
}

/**
 * A simple list (classes, terms, payment methods...). Always fetched with active=all and
 * filtered on the client, so every caller shares one cache entry ['list', list].
 */
export function useList(list: ListName, params: { active?: ActiveFilter } = {}) {
  return useQuery({
    queryKey: ['list', list],
    queryFn: ({ signal }) => api.get<ListEntry[]>(`/lists/${list}?active=all`, { signal }),
    enabled: hasCompany(),
    select: LIST_SELECT[params.active ?? 'active'],
  });
}

// stable select functions (a new function each render would recompute and return new arrays)
const LIST_SELECT: Record<ActiveFilter, (rows: ListEntry[]) => ListEntry[]> = {
  all: (rows) => rows,
  active: (rows) => rows.filter((r) => r.active),
  inactive: (rows) => rows.filter((r) => !r.active),
};

/** Map id → item of every item (active and inactive), for salesCalc and line logic. */
export function useItemsById(): Map<ID, Item> {
  const { data } = useItems({ active: 'all' });
  return useMemo(() => new Map((data ?? []).map((i) => [i.id, i])), [data]);
}

/** Map id → account of every account (active and inactive). */
export function useAccountsById(): Map<ID, Account> {
  const { data } = useAccounts({ active: 'all' });
  return useMemo(() => new Map((data ?? []).map((a) => [a.id, a])), [data]);
}

// ---------------------------------------------------------------------------
// Company

/** Company information (GET /company). */
export function useCompanyInfo() {
  return useQuery({
    queryKey: ['company'],
    queryFn: ({ signal }) => api.get<CompanyInfo>('/company', { signal }),
    enabled: hasCompany(),
  });
}

/** Default preferences (same as the server's store.DefaultPrefs), used until /prefs is loaded. */
export const DEFAULT_PREFS: Prefs = {
  useAccountNumbers: false,
  showLowestSubaccountOnly: false,
  requireAccounts: true,
  useClassTracking: false,
  promptForClass: false,
  autoAssignJournalNumbers: false,
  datePastWarnDays: 90,
  dateFutureWarnDays: 30,
  billsDueDays: 10,
  warnDuplicateBillNumbers: true,
  autoUseVendorDiscounts: false,
  vendorDiscountAccountId: null,
  printAccountNamesOnVoucher: false,
  warnDuplicateCheckNumbers: true,
  autoFillPayee: true,
  defaultCheckAccountId: null,
  defaultBillPayAccountId: null,
  defaultDepositAccountId: null,
  autoRecall: true,
  windowMode: 'multiple',
  iconBar: 'left',
  inventoryEnabled: true,
  purchaseOrdersEnabled: true,
  warnDuplicatePONumbers: true,
  warnNotEnoughInventory: true,
  reportBasis: 'accrual',
  agingFrom: 'due',
  reportAccountDisplay: 'name',
  estimatesEnabled: true,
  warnDuplicateInvoiceNumbers: true,
  useUndepositedFunds: true,
  autoApplyPayments: true,
  autoCalcPayments: true,
  useCustomerDiscounts: false,
  customerDiscountAccountId: null,
  defaultShipViaId: null,
  defaultFob: '',
  defaultMarkupPercent: 0,
  defaultInvoiceTemplate: 'Product Invoice',
  salesTaxEnabled: false,
  defaultSalesTaxItemId: null,
  salesTaxBasis: 'accrual',
  salesTaxFrequency: 'monthly',
  markTaxableAmountsT: true,
  showHomePageOnOpen: true,
  showRemindersOnOpen: false,
};

/** Company preferences (GET /prefs). See also {@link usePrefValues}. */
export function usePrefs() {
  return useQuery({
    queryKey: ['prefs'],
    queryFn: ({ signal }) => api.get<Prefs>('/prefs', { signal }),
    enabled: hasCompany(),
    staleTime: 5 * 60_000,
  });
}

/** Company preferences with defaults filled in while loading (never undefined). */
export function usePrefValues(): Prefs {
  const { data } = usePrefs();
  return useMemo(() => ({ ...DEFAULT_PREFS, ...(data ?? {}) }), [data]);
}

/**
 * AI Assistants: whether this company file is shared with AI assistants and how to
 * connect them (GET /ai-assistants). The access key is never part of it (see readAiAccessKey).
 * Read again when the browser tab comes back into view: sharing or the passwords may have been
 * changed in another tab, and the window then drops the access key it holds.
 */
export function useAiAssistants() {
  return useQuery({
    queryKey: ['ai-assistants'],
    queryFn: ({ signal }) => api.get<AiAssistantsStatus>('/ai-assistants', { signal, noPrompt: true }),
    enabled: hasCompany(),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}

/** Saves the AI assistant settings of this company file (PUT /ai-assistants, administrators). */
export async function saveAiAssistants(settings: AiAssistantsSettings): Promise<AiAssistantsStatus> {
  const r = await api.put<AiAssistantsStatus>('/ai-assistants', settings, { noPrompt: true });
  queryClient.setQueryData(['ai-assistants'], r);
  return r;
}

/** The access key for AI assistants with its keyVersion (GET /ai-assistants/key; administrators on this computer). Never cached. */
export function readAiAccessKey(): Promise<AiAccessKey> {
  return api.get<AiAccessKey>('/ai-assistants/key', { noPrompt: true });
}

/** Makes a new access key (POST /ai-assistants/new-key); assistants given the old key must be updated. */
export function makeAiAccessKey(): Promise<AiAccessKey> {
  return api.post<AiAccessKey>('/ai-assistants/new-key', {}, { noPrompt: true });
}

/** Adds SerieX to an AI assistant app's settings file on this computer (POST /ai-assistants/setup). */
export async function setUpAiApp(target: AiSetupTarget): Promise<AiSetupResult> {
  const r = await api.post<AiSetupResult>('/ai-assistants/setup', { target }, { noPrompt: true });
  await queryClient.invalidateQueries({ queryKey: ['ai-assistants'] });
  return r;
}

// ---------------------------------------------------------------------------
// Transactions

/** One transaction (GET /txns/{id}); disabled when id is 0/null. */
export function useTxn(id: ID | null | undefined) {
  return useQuery({
    queryKey: ['txn', id ?? 0],
    queryFn: ({ signal }) => api.get<Txn>(`/txns/${id}`, { signal }),
    enabled: hasCompany() && !!id,
  });
}

/** Query parameters of GET /txns (the ledger transaction query). */
export interface TxnListParams {
  types?: TxnType[];
  nameId?: ID | null;
  includeJobs?: boolean | 0 | 1;
  accountId?: ID | null;
  itemId?: ID | null;
  from?: string;
  to?: string;
  q?: string;
  ref?: string;
  memo?: string;
  amountMin?: number | null;
  amountMax?: number | null;
  openOnly?: boolean | 0 | 1;
  status?: string;
  limit?: number;
  offset?: number;
  sort?: 'date' | '-date' | 'ref' | 'name' | 'amount' | string;
}

function boolParams<T extends Record<string, unknown>>(p: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) out[k] = typeof v === 'boolean' ? (v ? 1 : undefined) : v;
  return out;
}

/** Transaction search (GET /txns) → rows + total. Keeps the previous rows while refetching. */
export function useTxnList(params: TxnListParams, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['txns', params],
    queryFn: ({ signal }) => api.get<TxnListResult>('/txns' + qs(boolParams(params as Record<string, unknown>)), { signal }),
    enabled: hasCompany() && opts.enabled !== false,
    placeholderData: keepPreviousData,
  });
}

/** Account register (GET /registers/{accountId}). */
export function useRegister(accountId: ID | null | undefined, params: { from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: ['register', accountId ?? 0, params],
    queryFn: ({ signal }) => api.get<RegisterResult>(`/registers/${accountId}` + qs(params), { signal }),
    enabled: hasCompany() && !!accountId,
    placeholderData: keepPreviousData,
  });
}

/** Open charges/credits of a customer or vendor (GET /open-docs). */
export interface OpenDocsParams {
  nameId?: ID | null;
  kind: 'receivable' | 'payable';
  date?: string;
  excludeTxnId?: ID | null;
  includeJobs?: boolean | 0 | 1;
}

/** Open invoices/credits (receivable) or open bills/credits (payable). */
export function useOpenDocs(params: OpenDocsParams, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['open-docs', params],
    queryFn: ({ signal }) => api.get<OpenDocsResult>('/open-docs' + qs(boolParams(params as unknown as Record<string, unknown>)), { signal }),
    enabled: hasCompany() && opts.enabled !== false,
  });
}

/** Payments waiting in Undeposited Funds (GET /undeposited). */
export function useUndeposited(params: { excludeDepositId?: ID | null } = {}) {
  return useQuery({
    queryKey: ['undeposited', params],
    queryFn: ({ signal }) => api.get<UndepositedItem[]>('/undeposited' + qs(params), { signal }),
    enabled: hasCompany(),
  });
}

/** Summary of a customer/vendor for history panels (GET /names/{id}/summary). */
export interface NameSummary {
  openBalance: number;
  overdue: number;
  unbilledCosts: number;
  lastPayment: { date: string; amount: number } | null;
  openEstimates: number;
  openPOs: number;
  creditLimit: number | null;
}

/** Name summary for history panels; disabled when id is 0/null. */
export function useNameSummary(id: ID | null | undefined) {
  return useQuery({
    queryKey: ['name-summary', id ?? 0],
    queryFn: ({ signal }) => api.get<NameSummary>(`/names/${id}/summary`, { signal }),
    enabled: hasCompany() && !!id,
  });
}

/** Next reference number the server would assign (GET /next-ref). */
export function useNextRef(type: TxnType, accountId?: ID | null, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['next-ref', type, accountId ?? null],
    queryFn: ({ signal }) => api.get<{ refNumber: string }>('/next-ref' + qs({ type, accountId }), { signal }),
    enabled: hasCompany() && opts.enabled !== false,
    staleTime: 0,
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

/** Report catalog (GET /reports). */
export function useReportsCatalog() {
  return useQuery({
    queryKey: ['reports-catalog'],
    queryFn: ({ signal }) => api.get<ReportInfo[]>('/reports', { signal }),
    enabled: hasCompany(),
    staleTime: Infinity,
  });
}
