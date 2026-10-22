// Helpers shared by the company module windows: data hooks for the company
// endpoints that have no hook in api/hooks.ts, small formatting helpers, and window/transaction openers.
import { useQuery } from '@tanstack/react-query';
import { ApiError, api, getCompanyId, qs } from '@/api/client';
import type { BackupEntry, BackupKind, BackupStatus, Budget, CompanyFile, ID, Prefs, ReminderGroup, ReportResult, Todo, TxnType, User } from '@/api/types';
import { queryClient } from '@/api/hooks';
import { useSession } from '@/state/session';
import { openTxn } from '@/windows/windowStore';
import { todayIso } from '@/util/dates';
import { useAppInfo } from '@/shell/AppSwitcher';

export const PRODUCT_NAME = 'SerieX Books';

/** The version the server reports (GET /api/info), for example "2026.10.2"; '' until it answers. */
export function useProductVersion(): string {
  return useAppInfo().data?.version ?? '';
}

const hasCompany = () => !!getCompanyId();

// ---------------------------------------------------------------------------
// Data hooks

/** Company files on the server (global, works without an open company). */
export function useCompanyFiles() {
  return useQuery({
    queryKey: ['global', 'companies'],
    queryFn: () => api.global.get<CompanyFile[]>('/companies', { noPrompt: true }),
    staleTime: 0,
  });
}

/** Reminders groups (GET /reminders). */
export function useReminders() {
  return useQuery({ queryKey: ['reminders'], queryFn: () => api.get<ReminderGroup[]>('/reminders'), enabled: hasCompany() });
}

/** To dos (GET /todos). */
export function useTodos(params: { status?: 'open' | 'done'; nameId?: ID | null } = {}) {
  return useQuery({ queryKey: ['todos', params], queryFn: () => api.get<Todo[]>('/todos' + qs(params)), enabled: hasCompany() });
}

/** Users of the company file (GET /users). */
export function useUsers() {
  return useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users'), enabled: hasCompany() });
}

/**
 * Whether the signed-in user may change company-wide settings (Company Information, Preferences,
 * closing date, users). Like the server: while no user has a password everybody works as the
 * administrator. `undefined` while the user list is still loading.
 */
export function useIsAdmin(): boolean | undefined {
  const authRequired = useSession((s) => s.authRequired);
  const user = useSession((s) => s.user);
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<User[]>('/users'),
    enabled: hasCompany() && authRequired,
    retry: false,
  });
  if (!authRequired) return true;
  if (users.error) return !(users.error instanceof ApiError && users.error.status === 403);
  if (!users.data) return undefined;
  const me = users.data.find((u) => u.name.toLowerCase() === (user || 'Admin').toLowerCase());
  return !!me && me.isAdmin && me.active;
}

/** Shown in company-wide settings windows when the user is not an administrator. */
export const ADMIN_ONLY_NOTE = 'Only an administrator can change these settings.';

/** Budgets (GET /budgets). */
export function useBudgets() {
  return useQuery({ queryKey: ['budgets'], queryFn: () => api.get<Budget[]>('/budgets'), enabled: hasCompany() });
}

/** Closing date and whether it has a password (GET /closing-date). */
export function useClosingDate() {
  return useQuery({
    queryKey: ['closing-date'],
    queryFn: () => api.get<{ closingDate: string; hasPassword: boolean }>('/closing-date'),
    enabled: hasCompany(),
    // another user (or another session) may have changed it: read it again whenever a screen showing
    // it opens, instead of showing the remembered value
    refetchOnMount: 'always',
  });
}

/** One bank feed account row (GET /bank-feeds/accounts). */
export interface FeedAccount {
  accountId: ID;
  accountName: string;
  accountType: string;
  newCount: number;
  lastImport: string;
}

/** Bank feed accounts with the number of items to review. */
export function useFeedAccounts() {
  return useQuery({ queryKey: ['bank-feed-accounts'], queryFn: () => api.get<FeedAccount[]>('/bank-feeds/accounts'), enabled: hasCompany() });
}

/** Completed reconciliations of every account, newest first. */
export function useReconciliations() {
  return useQuery({
    queryKey: ['reconciliations', 'all'],
    queryFn: () => api.get<{ id: ID; accountId: ID; statementDate: string; completedAt: string }[]>('/reconciliations'),
    enabled: hasCompany(),
  });
}

/** A report fetched for a dashboard widget (no placeholder data, so ranges never mix). */
export function useWidgetReport(key: string, params: Record<string, string>, enabled = true) {
  return useQuery({
    queryKey: ['report', key, params],
    queryFn: () => api.get<ReportResult>(`/reports/${key}` + qs(params)),
    enabled: hasCompany() && enabled,
    staleTime: 60_000,
  });
}

/** Income, expenses and net income of one column of a Profit and Loss result. */
export function plTotals(r: ReportResult | undefined, col: string): { income: number; expenses: number; net: number } {
  if (!r) return { income: 0, expenses: 0, net: 0 };
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  let income = 0;
  let net = 0;
  for (const row of r.rows) {
    const label = String(row.cells.label ?? '');
    if (row.kind === 'subtotal' && (label === 'Total Income' || label === 'Total Other Income')) income += num(row.cells[col]);
    if (row.kind === 'grandtotal' && label === 'Net Income') net = num(row.cells[col]);
  }
  return { income, expenses: income - net, net };
}

// ---------------------------------------------------------------------------
// Formatting

/** "$1,234" (whole dollars) for dashboards. */
export function money0(n: number): string {
  const v = Math.round(n);
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US');
}

/** "$1,234.56". */
export function money2(n: number): string {
  const v = Math.round(n * 100) / 100;
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Compact axis label: 0, 950, 1.2K, 35K, 1.4M. */
export function compactMoney(n: number): string {
  const a = Math.abs(n);
  const s = n < 0 ? '-' : '';
  if (a >= 1_000_000) return `${s}$${(a / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`;
  if (a >= 1_000) return `${s}$${(a / 1_000).toFixed(a >= 10_000 ? 0 : 1)}K`;
  return `${s}$${Math.round(a)}`;
}

/** File size: "5.7 MB". */
export function fmtBytes(n: number): string {
  if (!n) return '0 KB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Local date and time of an RFC3339 timestamp: "10/17/2026 9:41 PM". */
export function fmtDateTime(ts: string | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** "2 hours ago", "yesterday", "3 days ago" (falls back to the date). */
export function timeAgo(ts: string | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts).getTime();
  if (Number.isNaN(d)) return '';
  const s = Math.max(0, (Date.now() - d) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hour${Math.floor(s / 3600) === 1 ? '' : 's'} ago`;
  const days = Math.floor(s / 86400);
  if (days === 1) return 'yesterday';
  if (days < 31) return `${days} days ago`;
  return new Date(d).toLocaleDateString('en-US');
}

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

/** Month options (value 1-12) for selects. */
export const MONTH_OPTIONS = MONTHS.map((m, i) => ({ value: i + 1, label: m }));

/** Labels of the 12 fiscal months starting at fyStart (1-12): ["Jan", "Feb", ...]. */
export function fiscalMonthLabels(fyStart: number): string[] {
  return Array.from({ length: 12 }, (_, i) => MONTHS_SHORT[(fyStart - 1 + i) % 12]);
}

/** Start and end (ISO) of the fiscal year `fy` (the calendar year in which it starts). */
export function fiscalYearRange(fy: number, fyStart: number): { from: string; to: string } {
  const p = (n: number) => String(n).padStart(2, '0');
  const from = `${fy}-${p(fyStart)}-01`;
  const endMonth = ((fyStart + 10) % 12) + 1; // month before fyStart
  const endYear = fyStart === 1 ? fy : fy + 1;
  const last = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  return { from, to: `${endYear}-${p(endMonth)}-${p(last)}` };
}

/** Fiscal year (calendar year in which it starts) that contains `iso`. */
export function fiscalYearOf(iso: string, fyStart: number): number {
  const y = +iso.slice(0, 4);
  const m = +iso.slice(5, 7);
  return m >= fyStart ? y : y - 1;
}

// ---------------------------------------------------------------------------
// Opening things

/** Opens a transaction when only its id is known (looks up its type first). */
export async function openTxnById(id: ID, type?: TxnType | string | null): Promise<void> {
  if (type) {
    openTxn(type as TxnType, id);
    return;
  }
  const t = await queryClient.fetchQuery({ queryKey: ['txn', id], queryFn: () => api.get<{ id: ID; type: TxnType }>(`/txns/${id}`), staleTime: 30_000 });
  openTxn(t.type, id);
}

// ---------------------------------------------------------------------------
// Backups (made and recorded by the server: automatic ones, Back up now, downloads)

/** Backup settings, last backup and the backups in the folder of the open company (GET /backups). */
export function useBackupStatus() {
  return useQuery({
    queryKey: ['backups'],
    queryFn: () => api.get<BackupStatus>('/backups', { noPrompt: true }),
    enabled: hasCompany(),
    // automatic backups happen in the background: keep the shown time current
    refetchInterval: 60_000,
    staleTime: 10_000,
  });
}

/** Back up now: the server copies the open company file into its backup folder. */
export async function backUpNow(): Promise<BackupEntry> {
  try {
    return await api.post<BackupEntry>('/backups', {}, { noPrompt: true });
  } finally {
    void queryClient.invalidateQueries({ queryKey: ['backups'] });
  }
}

/** How a backup was made, for lists ("Automatic", "When closed"...). */
export function backupKindLabel(kind: BackupKind): string {
  switch (kind) {
    case 'auto':
      return 'Automatic';
    case 'close':
      return 'When closed';
    case 'manual':
      return 'Back up now';
    case 'restore':
      return 'Before a restore';
    case 'download':
      return 'Downloaded';
  }
  return kind;
}

/** Today in ISO (re-exported for convenience). */
export const today = todayIso;

// ---------------------------------------------------------------------------
// New company choices

/** How often sales tax is paid (Preferences > Sales Tax, New Company). */
export const SALES_TAX_FREQUENCIES: { value: Prefs['salesTaxFrequency']; label: string }[] = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annually', label: 'Annually' },
];

/** Entity types understood by the server's equity accounts (see phase-1 notes). */
export const ENTITY_TYPES: { value: string; label: string; help: string }[] = [
  { value: 'Sole Proprietorship', label: 'Sole proprietorship', help: 'An unincorporated business owned by one person.' },
  { value: 'Partnership or LLP', label: 'Partnership or LLP', help: 'Two or more owners sharing profits; partner equity accounts are created.' },
  { value: 'LLC (single member)', label: 'LLC (single member)', help: 'A limited liability company with one owner.' },
  { value: 'LLC (multi member)', label: 'LLC (multi-member)', help: 'A limited liability company with several owners (taxed like a partnership).' },
  { value: 'Corporation', label: 'Corporation', help: 'A C corporation: capital stock and dividends accounts are created.' },
  { value: 'S Corporation', label: 'S Corporation', help: 'A corporation that passes income to its shareholders.' },
  { value: 'Non-Profit', label: 'Non-profit', help: 'A charity or other non-profit organization: net assets accounts are created.' },
  { value: 'Other/None', label: 'Other / not sure', help: 'You can change it later in Company Information.' },
];
