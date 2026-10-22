// Helpers shared by the vendor windows (terms math, vendor lookups, report links, check words).
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, getCompanyId } from '@/api/client';
import { DEFAULT_PREFS, queryClient, useAccounts, useList, useNames } from '@/api/hooks';
import type { Account, ID, ListEntry, Name, Prefs, SalesTaxDue, TermsData, TxnSummary, TxnType } from '@/api/types';
import { formatAddress } from '@/components/inputs';
import { openWindow } from '@/windows/windowStore';
import { addDays, daysBetween, todayIso } from '@/util/dates';
import { round2 } from '@/util/format';
import './vendors.css';

// ---------------------------------------------------------------------------
// Terms

function num(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

/** Terms data of a list entry with numbers normalized. */
export function termsData(t: ListEntry | null | undefined): TermsData {
  const d = (t?.data ?? {}) as Record<string, unknown>;
  return {
    dateDriven: d.dateDriven === true,
    netDays: num(d.netDays),
    discountPct: num(d.discountPct),
    discountDays: num(d.discountDays),
    dueDay: num(d.dueDay),
    discountDay: num(d.discountDay),
    dueNextMonthDays: num(d.dueNextMonthDays),
  };
}

/** Day `day` of the month of `year`/`month0` (month may overflow), clamped to the month length. */
function dayOfMonth(year: number, month0: number, day: number): string {
  const first = new Date(Date.UTC(year, month0, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(Math.max(day, 1), last)));
  return d.toISOString().slice(0, 10);
}

/**
 * Due date of a document dated `date` with these terms (same rule as the server):
 * standard terms → date + net days; date driven → the due day of this month, or of the next
 * month when the date is past it or within "due next month" days of it.
 * Without terms: `date + fallbackDays` (bills use prefs.billsDueDays).
 */
export function dueDateFor(date: string, terms: ListEntry | null | undefined, fallbackDays = 0): string {
  if (!date) return '';
  if (!terms) return addDays(date, fallbackDays);
  const t = termsData(terms);
  if (!t.dateDriven) return addDays(date, t.netDays ?? 0);
  const y = +date.slice(0, 4);
  const m = +date.slice(5, 7) - 1;
  const day = Math.max(1, t.dueDay ?? 1);
  let due = dayOfMonth(y, m, day);
  const until = daysBetween(date, due);
  const within = t.dueNextMonthDays ?? 0;
  if (until < 0 || (within > 0 && until <= within)) due = dayOfMonth(y, m + 1, day);
  return due;
}

/** Last day the terms discount applies ("" when the terms have no discount). */
export function discountDateFor(date: string, terms: ListEntry | null | undefined): string {
  if (!date || !terms) return '';
  const t = termsData(terms);
  if (!t.discountPct || t.discountPct <= 0) return '';
  if (!t.dateDriven) return t.discountDays ? addDays(date, t.discountDays) : '';
  if (!t.discountDay) return '';
  const y = +date.slice(0, 4);
  const m = +date.slice(5, 7) - 1;
  const dueDay = t.dueDay && t.dueDay > 0 ? t.dueDay : 31;
  let due = dayOfMonth(y, m, dueDay);
  const within = t.dueNextMonthDays ?? 0;
  if (daysBetween(date, due) < 0 || (within > 0 && daysBetween(date, due) <= within - 1)) due = dayOfMonth(y, m + 1, dueDay);
  const disc = dayOfMonth(+due.slice(0, 4), +due.slice(5, 7) - 1, t.discountDay);
  return daysBetween(date, disc) < 0 ? '' : disc;
}

/** Discount percent of the terms (0 when none). */
export function discountPctOf(terms: ListEntry | null | undefined): number {
  return terms ? termsData(terms).discountPct ?? 0 : 0;
}

/**
 * Due date of a bill dated `date` (terms, else Preferences > Bills "due after N days"). Loads the
 * terms list and preferences first when they are not cached yet (a form that just opened).
 */
export async function billDueDate(date: string, termsId: ID | null): Promise<string> {
  const [terms, prefs] = await Promise.all([
    queryClient.fetchQuery({ queryKey: ['list', 'terms'], queryFn: () => api.get<ListEntry[]>('/lists/terms?active=all'), staleTime: 60_000 }),
    queryClient.fetchQuery({ queryKey: ['prefs'], queryFn: () => api.get<Prefs>('/prefs'), staleTime: 60_000 }).catch(() => DEFAULT_PREFS),
  ]);
  return dueDateFor(date, termsId ? terms.find((t) => t.id === termsId) : null, prefs.billsDueDays);
}

/** Map id → terms entry. */
export function useTermsById(): Map<ID, ListEntry> {
  const { data } = useList('terms', { active: 'all' });
  return useMemo(() => new Map((data ?? []).map((t) => [t.id, t])), [data]);
}

// ---------------------------------------------------------------------------
// Vendors

/** All vendors (active and inactive) and a lookup map. */
export function useVendors(): { list: Name[]; byId: Map<ID, Name>; loading: boolean } {
  const q = useNames('vendor', { active: 'all' });
  const byId = useMemo(() => new Map((q.data ?? []).map((n) => [n.id, n])), [q.data]);
  return { list: q.data ?? [], byId, loading: q.isLoading };
}

/** Text of a vendor's address block on bills, checks and purchase orders. */
export function vendorAddressText(n: Name | null | undefined): string {
  if (!n) return '';
  const top = n.printOnCheckAs?.trim() || n.companyName?.trim() || n.name;
  // addresses often already start with the company name: do not repeat it
  const first = (n.billAddress?.line1 ?? '').trim().toLowerCase();
  if (first && [top, n.name, n.companyName].some((x) => (x ?? '').trim().toLowerCase() === first)) return formatAddress(null, n.billAddress);
  return formatAddress(top, n.billAddress);
}

/** Loads one name record. */
export function fetchName(id: ID): Promise<Name> {
  return api.get<Name>(`/names/${id}`);
}

/**
 * Open purchase orders of every vendor (GET /open-pos) with what is still open on each
 * (openBalance: the amount not received/billed yet), and a map PO id → open balance.
 */
export function useOpenPOs(): { list: TxnSummary[]; openById: Map<ID, number>; loading: boolean } {
  const q = useQuery({ queryKey: ['open-pos', 'all'], queryFn: ({ signal }) => api.get<TxnSummary[]>('/open-pos', { signal }), enabled: !!getCompanyId() });
  const openById = useMemo(() => new Map((q.data ?? []).map((p) => [p.id, p.openBalance])), [q.data]);
  return { list: q.data ?? [], openById, loading: q.isLoading };
}

/** Bank / credit card accounts with balances (for "pay from" pickers). */
export function usePayAccounts(): Map<ID, Account> {
  const { data } = useAccounts({ active: 'all', types: ['Bank', 'Credit Card'] });
  return useMemo(() => new Map((data ?? []).map((a) => [a.id, a])), [data]);
}

// ---------------------------------------------------------------------------
// Reports and windows

/** Opens a report window. */
export function openReport(key: string, params: Record<string, string> = {}, title?: string): void {
  openWindow('report', { key, params, ...(title ? { title } : {}) }, title ? { title } : undefined);
}

/** Vendor Activity report (all dates). */
export function openVendorActivity(n: Pick<Name, 'id' | 'name'>): void {
  openReport('name_quickreport', { nameId: String(n.id), dates: 'all' }, `Vendor Activity: ${n.name}`);
}

/** Window kind that edits a vendor-side transaction type. */
export const VENDOR_FORM_LABEL: Partial<Record<TxnType, string>> = {
  BILL: 'Bill',
  BILLCRED: 'Credit',
  BILLPMT: 'Bill Payment',
  ITEMRCPT: 'Item Receipt',
  PURCHORD: 'Purchase Order',
  CHK: 'Check',
  CCCHARGE: 'Credit Card Charge',
  CCCREDIT: 'Credit Card Credit',
  TAXPMT: 'Sales Tax Payment',
};

// ---------------------------------------------------------------------------
// Bill status

/** Plain status of a bill-like document for lists ("Paid", "Overdue", "Partially paid", "Open"). */
export function billStatus(t: { type: TxnType; amount: number; openBalance: number; dueDate: string; voided: boolean }, today = todayIso()): string {
  if (t.voided) return 'Void';
  if (t.type === 'BILL') {
    if (t.openBalance <= 0 && t.amount > 0) return 'Paid';
    if (t.dueDate && t.dueDate < today) return 'Overdue';
    if (t.openBalance < t.amount) return 'Partially paid';
    return 'Open';
  }
  if (t.type === 'BILLCRED') {
    if (t.openBalance <= 0) return 'Applied';
    if (t.openBalance < t.amount) return 'Partial';
    return 'Unapplied';
  }
  if (t.type === 'ITEMRCPT') return 'Not billed';
  return '';
}

// ---------------------------------------------------------------------------
// Check words

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function below1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) {
    parts.push(ONES[Math.floor(n / 100)] + ' hundred');
    n %= 100;
  }
  if (n >= 20) {
    parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : ''));
  } else if (n > 0) parts.push(ONES[n]);
  return parts.join(' ');
}

/** Check amount in words: 1234.5 → "One thousand two hundred thirty-four and 50/100". */
export function amountInWords(amount: number): string {
  const v = Math.abs(round2(amount));
  let dollars = Math.floor(v + 1e-9);
  const cents = Math.round((v - dollars) * 100);
  if (dollars === 0) return `Zero and ${String(cents).padStart(2, '0')}/100`;
  const scales = ['', ' thousand', ' million', ' billion'];
  const chunks: string[] = [];
  let i = 0;
  while (dollars > 0 && i < scales.length) {
    const c = dollars % 1000;
    if (c) chunks.unshift(below1000(c) + scales[i]);
    dollars = Math.floor(dollars / 1000);
    i++;
  }
  const words = chunks.join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1) + ` and ${String(cents).padStart(2, '0')}/100`;
}

/** Sum of numbers rounded to cents. */
export function sum2(values: number[]): number {
  return round2(values.reduce((s, v) => s + (v || 0), 0));
}

// ---------------------------------------------------------------------------
// Sales tax due

/**
 * A sales tax adjustment row of /sales-tax/due: a change to Sales Tax Payable without a tax item
 * (e.g. a journal entry for a discount or penalty, named with the agency); taxItemId is null.
 */
export function isTaxAdjustment(d: Pick<SalesTaxDue, 'taxItemId'>): boolean {
  return !d.taxItemId;
}

/** Label of a sales tax due row: the tax item, or "Adjustment" for sales tax adjustments. */
export function taxDueLabel(d: SalesTaxDue): string {
  if (!isTaxAdjustment(d)) return d.taxItemName;
  return (d.taxItemName ?? '').trim() || 'Adjustment';
}
