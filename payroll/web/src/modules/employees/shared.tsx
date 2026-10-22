// Shared helpers of the employees module: list page layout, plain-English
// delete / make-inactive flows, labels of payroll item types and tax treatments, blank
// employee records and small formatting helpers. Styles: employees.css (class prefix "sxp-emp-").
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ApiError, api } from '@/api/client';
import { invalidateAll } from '@/api/hooks';
import {
  ITEM_TYPE_LABELS,
  TAX_CODE_LABELS,
  type Accrual,
  type Employee,
  type EmployeeDefaults,
  type EmployeeItem,
  type ItemType,
  type Meta,
  type PayrollItem,
  type PTOSettings,
  type TaxTracking,
} from '@/api/types';
import { alertBox, msgBox } from '@/components/dialogs';
import { CREATED_EVENT, type CreatedDetail } from '@/components/pickers';
import { toast } from '@/components/toast';
import { useSession } from '@/state/session';
import { fmtMoney, fmtPercent, fmtQty } from '@/util/format';
import { escHtml, printHtml } from '@/util/print';
import { openWindow } from '@/windows/windowStore';
import './employees.css';

// ---------------------------------------------------------------------------
// small utilities

/** "1 employee" / "3 employees". */
export function plural(n: number, one: string, many = one + 's'): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** Capitalizes the first letter. */
export function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** "$1,234.56" */
export function money$(n: number | null | undefined): string {
  const v = n ?? 0;
  return (v < 0 ? '-$' : '$') + fmtMoney(Math.abs(v));
}

/** Message of a thrown error (null for a cancelled server question). */
export function errMessage(e: unknown): string | null {
  const err = e as ApiError;
  if (err && err.code === 'cancelled') return null;
  return (err && err.message) || 'Something went wrong. Please try again.';
}

/** True for an error the user cancelled (a server question answered No). */
export function isCancelled(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'cancelled';
}

/** Shows an error in a message box (nothing for a cancelled question). */
export async function showError(e: unknown, title = 'Warning'): Promise<void> {
  const m = errMessage(e);
  if (m) await alertBox(m, title);
}

/** A view preference remembered in this browser (per viewer convenience, "sxp." keys). */
export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? initial : (JSON.parse(s) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (n: T) => {
      setV(n);
      try {
        localStorage.setItem(key, JSON.stringify(n));
      } catch {
        /* storage unavailable: keep it for this session only */
      }
    },
    [key],
  );
  return [v, set];
}

/** Width of an element in px (follows resizes). */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** Plain text search: every word must appear in one of the texts. */
export function matchesSearch(q: string, ...texts: (string | null | undefined)[]): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = texts.filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** Calls `fn` with every record created elsewhere (the "sx-created" window event). */
export function useCreatedListener(kind: CreatedDetail['kind'], fn: (d: CreatedDetail) => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent<CreatedDetail>).detail;
      if (d && d.kind === kind) ref.current(d);
    };
    window.addEventListener(CREATED_EVENT, h);
    return () => window.removeEventListener(CREATED_EVENT, h);
  }, [kind]);
}

/**
 * Selection that waits for a just-created record: `pick(id)` selects it as soon as it is in
 * `rows` (the list refreshes a moment after the save), scrolls it into view and focuses the
 * list. `pending()` is true meanwhile, so "select the first row" logic leaves the selection alone.
 */
export function useRevealRow<T>(rootRef: RefObject<HTMLElement | null>, rows: readonly T[], getKey: (r: T) => number | string, select: (k: number | string) => void, rowHeight = 26) {
  const want = useRef<{ key: number | string; at: number } | null>(null);
  useEffect(() => {
    const w = want.current;
    if (!w) return;
    const i = rows.findIndex((r) => getKey(r) === w.key);
    if (i < 0) {
      if (Date.now() - w.at > 4000) want.current = null;
      return;
    }
    want.current = null;
    select(w.key);
    requestAnimationFrame(() => {
      const sc = rootRef.current?.querySelector<HTMLElement>('.sx-lv-scroll');
      if (!sc) return;
      const head = Math.max(rowHeight, 30);
      const top = i * rowHeight;
      const view = sc.clientHeight - head;
      if (top < sc.scrollTop || top + rowHeight > sc.scrollTop + view) sc.scrollTop = Math.max(0, top - Math.round(view / 2));
      rootRef.current?.querySelector<HTMLElement>('.sx-lv')?.focus({ preventScroll: true });
    });
  });
  const pick = useCallback((k: number | string) => {
    want.current = { key: k, at: Date.now() };
  }, []);
  const pending = useCallback(() => !!want.current && Date.now() - want.current.at < 4000, []);
  return { pick, pending };
}

/** A ref that always holds the latest value. */
export function useLatest<T>(v: T): { current: T } {
  const r = useRef(v);
  r.current = v;
  return r;
}

/** Opens a report window. */
export function openReport(key: string, params: Record<string, string> = {}, title?: string): void {
  openWindow('report', title ? { key, params, title } : { key, params });
}

/** Hours as the paycheck screens show them ("40.00"). */
export function fmtHours(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return (Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// list page layout (same structure as the SerieX Books list windows)

/** Props of {@link ListPage}. */
export interface ListPageProps {
  /** Left part of the top bar (search box). */
  toolbar: ReactNode;
  /** Quick filters (chips) next to the search box (own row on narrow windows). */
  filters?: ReactNode;
  /** Right part of the top bar (the New button...). */
  actions?: ReactNode;
  /** Bar under the top bar (notices). */
  notice?: ReactNode;
  /** The list (or an empty state). */
  children: ReactNode;
  /** Bottom menu buttons ("Payroll Item ▾", "Activities ▾", "Reports ▾"). */
  footer?: ReactNode;
  /** Text at the bottom right ("58 payroll items"). */
  status?: ReactNode;
  rootRef?: RefObject<HTMLDivElement>;
}

/** Standard list window: top bar, list, bottom menu buttons. */
export function ListPage({ toolbar, filters, actions, notice, children, footer, status, rootRef }: ListPageProps) {
  const own = useRef<HTMLDivElement>(null);
  const ref = rootRef ?? own;
  const width = useElementWidth(ref);
  const stacked = !!filters && width > 0 && width < 900;
  return (
    <div className="sxp-emp-page" ref={ref}>
      <div className="sxp-emp-head">
        {toolbar}
        {!stacked && filters}
        {actions && <div className="sxp-emp-head-right">{actions}</div>}
      </div>
      {stacked && <div className="sxp-emp-head">{filters}</div>}
      {notice}
      {children}
      {(footer || status) && (
        <div className="sxp-emp-foot">
          {footer}
          {status !== undefined && <span className="sxp-emp-count">{status}</span>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// delete / make inactive flows

/** Options of {@link deleteRecord}. */
export interface DeleteOptions {
  /** "employee", "payroll item", "pay schedule". */
  what: string;
  name: string;
  request: () => Promise<unknown>;
  /** Offered when the record is in use (known before, or refused by the server). */
  makeInactive?: () => Promise<unknown>;
  /** Known reason the record cannot be deleted (checked before asking the server). */
  blocked?: string | null;
}

async function offerInactive(title: string, message: string, name: string, makeInactive: () => Promise<unknown>): Promise<void> {
  const r = await msgBox({ title, message, buttons: ['Make &Inactive', 'Cancel'], icon: 'warning' });
  if (r !== 'Make Inactive') return;
  try {
    await makeInactive();
    await invalidateAll();
    toast(`"${name}" is now inactive`);
  } catch (e2) {
    await showError(e2);
  }
}

/** Asks, deletes, refreshes and confirms with a toast; offers "Make inactive" when the record is in use. */
export async function deleteRecord({ what, name, request, makeInactive, blocked }: DeleteOptions): Promise<boolean> {
  const title = `Cannot Delete ${what.split(' ').map(cap).join(' ')}`;
  if (blocked) {
    if (makeInactive) await offerInactive(title, blocked, name, makeInactive);
    else await alertBox(blocked, title, 'warning');
    return false;
  }
  const answer = await msgBox({
    title: `Delete ${what.split(' ').map(cap).join(' ')}`,
    message: `Delete the ${what} "${name}"?\n\nThis cannot be undone.`,
    buttons: ['&Delete', 'Cancel'],
    icon: 'warning',
  });
  if (answer !== 'Delete') return false;
  try {
    await request();
    await invalidateAll();
    toast(`${cap(what)} "${name}" deleted`);
    return true;
  } catch (e) {
    const msg = errMessage(e);
    if (msg === null) return false;
    if (makeInactive && e instanceof ApiError && /inactive/i.test(msg)) {
      await offerInactive(title, msg, name, makeInactive);
      return false;
    }
    await alertBox(msg, 'Warning');
    return false;
  }
}

/** Makes a record active/inactive, refreshes and confirms with a toast. */
export async function setRecordActive(name: string, active: boolean, request: () => Promise<unknown>): Promise<boolean> {
  try {
    await request();
    await invalidateAll();
    toast(active ? `"${name}" is active again` : `"${name}" is now inactive`, { kind: 'success' });
    return true;
  } catch (e) {
    await showError(e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// printing a list

/** One printed column. */
export interface PrintColumn {
  label: string;
  align?: 'left' | 'right';
}

/** Prints a list as a simple report (company name, title, date, table). */
export function printList(title: string, columns: PrintColumn[], rows: { cells: string[]; inactive?: boolean }[]): Promise<void> {
  const company = useSession.getState().company?.name ?? '';
  const today = new Date().toLocaleDateString('en-US');
  const head = columns.map((c) => `<th class="${c.align === 'right' ? 'num' : ''}">${escHtml(c.label)}</th>`).join('');
  const body = rows
    .map(
      (r) =>
        `<tr${r.inactive ? ' class="muted"' : ''}>` +
        r.cells.map((c, i) => `<td class="${columns[i]?.align === 'right' ? 'num' : ''}">${escHtml(c)}${i === 0 && r.inactive ? ' (inactive)' : ''}</td>`).join('') +
        '</tr>',
    )
    .join('');
  const html =
    `<div class="muted" style="font-size:10px">${escHtml(today)}</div>` +
    `<div class="center bold" style="font-size:13px">${escHtml(company)}</div>` +
    `<h1 class="center">${escHtml(title)}</h1>` +
    `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  return printHtml(title, html, 'h1.center, .center{text-align:center} tbody tr:nth-child(even) td{background:#f6f6f6}');
}

// ---------------------------------------------------------------------------
// payroll items

/** "Type" column text of the Payroll Items list. */
export function itemTypeText(i: Pick<PayrollItem, 'type' | 'taxCode' | 'taxKey'>): string {
  if (i.type === 'state_tax') {
    switch (i.taxCode) {
      case 'SIT':
        return 'State Withholding Tax';
      case 'SUI_ER':
      case 'SUI_EE':
        return 'State Unemployment Tax';
      case 'ST_EE':
      case 'ST_ER':
        return /SDI|TDI|DBL|DI$/i.test(i.taxKey) ? 'State Disability Tax' : 'Other State Tax';
    }
    return 'State Tax';
  }
  return ITEM_TYPE_LABELS[i.type] ?? i.type;
}

/** Tax treatment text of tax items ("Federal income tax", "Social security, company"...) in the Payroll Items list. */
const TAX_TRACK_TEXT: Record<string, string> = {
  FIT: 'Federal income tax',
  SS_EE: 'Social security, employee',
  SS_ER: 'Social security, company',
  MED_EE: 'Medicare, employee',
  MED_ER: 'Medicare, company',
  ADDL_MED: 'Additional Medicare',
  FUTA: 'Federal unemployment',
  SIT: 'State income tax',
  SUI_ER: 'State unemployment, company',
  SUI_EE: 'State unemployment, employee',
  ST_EE: 'State program, employee',
  ST_ER: 'State program, company',
  LOCAL_EE: 'Local tax, employee',
  LOCAL_ER: 'Local tax, company',
};

/** Label of a tax treatment for an item type (the same key may have several labels). */
export function trackingLabel(meta: Meta | undefined, key: TaxTracking | string, type?: ItemType): string {
  const list = meta?.taxTracking ?? [];
  const exact = list.find((t) => t.key === key && (!type || t.itemTypes.includes(type)));
  return exact?.label ?? list.find((t) => t.key === key)?.label ?? key;
}

/** "Tax Treatment" column text of the Payroll Items list. */
export function itemTrackingText(meta: Meta | undefined, i: PayrollItem): string {
  if (i.type === 'federal_tax' || i.type === 'state_tax' || i.type === 'other_tax') {
    const t = TAX_TRACK_TEXT[i.taxCode] ?? i.taxCode;
    return (i.taxCode === 'ST_EE' || i.taxCode === 'ST_ER') && i.taxKey ? `${t} (${i.taxKey})` : t;
  }
  return trackingLabel(meta, i.taxTracking, i.type);
}

/** Full name of a tax code ("Social Security (company)"). */
export function taxCodeLabel(code: string): string {
  return (TAX_CODE_LABELS as Record<string, string>)[code] ?? code;
}

/** "Amount" column text: default rate, percent, overtime multiplier or match. */
export function itemAmountText(i: PayrollItem): string {
  if (i.type === 'overtime') return i.rate ? `${fmtQty(i.rate)}x` : '';
  if (i.calc === 'match') return i.rate ? `${fmtPercent(i.rate)} up to ${fmtPercent(i.matchCapPct)}` : '';
  if (i.calc === 'percent' || (i.type === 'commission' && i.calc === 'quantity')) return i.rate ? fmtPercent(i.rate) : '';
  if (i.type === 'other_tax' || i.calc === 'tax') return i.rate ? fmtPercent(i.rate) : '';
  if (!i.rate) return '';
  return fmtMoney(i.type === 'deduction' ? -i.rate : i.rate);
}

/** Expense or liability account shown in the list (liability for deductions and taxes). */
export function itemAccountText(i: PayrollItem): string {
  if (i.category === 'earning' || i.category === 'addition') return i.expenseAccountName;
  return i.liabilityAccountName || i.expenseAccountName;
}

/** Item types of the "Additions, Deductions and Company Contributions" grid. */
export const OTHER_ITEM_TYPES: ItemType[] = ['addition', 'deduction', 'contribution'];

// ---------------------------------------------------------------------------
// employees

/** Paid time off accrual choices (Sick and Vacation dialog). */
export const ACCRUAL_OPTIONS: { value: Accrual; label: string }[] = [
  { value: 'none', label: 'Does not accrue' },
  { value: 'beginning_of_year', label: 'Beginning of year' },
  { value: 'per_paycheck', label: 'Every paycheck' },
  { value: 'per_hour', label: 'Every hour on paycheck' },
];

/** Employee type choices (Employment Info). */
export const EMPLOYMENT_TYPES: { value: Employee['employmentType']; label: string }[] = [
  { value: 'regular', label: 'Regular' },
  { value: 'officer', label: 'Officer' },
  { value: 'statutory', label: 'Statutory' },
  { value: 'owner', label: 'Owner' },
];

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Paid time off settings that do not accrue. */
export function blankPTO(): PTOSettings {
  return { accrual: 'none', hours: 0, perHoursWorked: 0, maxHours: null, resetEachYear: false, yearBeginsMonth: 1, beginAccruingDate: '', available: 0, accruedYtd: 0, usedYtd: 0 };
}

/** A new employee record filled from the employee defaults. */
export function blankEmployee(d: EmployeeDefaults | null | undefined): Employee {
  const copyItems = (l: EmployeeItem[] | undefined) => (l ?? []).map((x) => ({ ...x }));
  return {
    id: 0,
    booksNameId: null,
    firstName: '',
    middleName: '',
    lastName: '',
    suffix: '',
    displayName: '',
    printAs: '',
    ssn: '',
    birthDate: '',
    gender: '',
    address: { line1: '', line2: '', city: '', state: '', zip: '' },
    phone: '',
    mobile: '',
    email: '',
    employeeNumber: '',
    hireDate: '',
    originalHireDate: '',
    releaseDate: '',
    employmentType: 'regular',
    payScheduleId: d?.payScheduleId ?? null,
    payFrequency: d?.payFrequency ?? 'biweekly',
    classId: d?.classId ?? null,
    workState: d?.workState ?? '',
    earnings: copyItems(d?.earnings),
    items: copyItems(d?.items),
    w4: { version: '2020', filingStatus: 'single', step2: false, dependents: 0, otherIncome: 0, deductions: 0, extraWithholding: 0, allowances: 0, exempt: false, nonresidentAlien: false },
    subjectSs: true,
    subjectMedicare: true,
    subjectFuta: true,
    stateW4: { filingStatus: '', allowances: 0, extraWithholding: 0, exempt: false, data: {} },
    subjectSui: d?.subjectSui ?? true,
    subjectSdi: d?.subjectSdi ?? true,
    directDeposit: { enabled: false, bankName: '', routing: '', account: '', accountType: 'checking' },
    sick: { ...blankPTO(), ...(d?.sick ?? {}) },
    vacation: { ...blankPTO(), ...(d?.vacation ?? {}) },
    notes: '',
    active: true,
    ssnOnFile: false,
    payScheduleName: '',
    hourlyRate: 0,
    annualSalary: 0,
    ytdGross: 0,
    lastCheckDate: '',
    hasPaychecks: false,
    booksSyncError: '',
  };
}

/** Default display name ("First Last" or "Last, First" per the company preference). */
export function defaultDisplayName(first: string, last: string, order: 'first' | 'last'): string {
  const f = first.trim();
  const l = last.trim();
  if (order === 'last') return f ? `${l}, ${f}` : l;
  return `${f} ${l}`.trim();
}

/** Employee status words: Inactive / Released / '' (active). */
export function employeeStatus(e: Pick<Employee, 'active' | 'releaseDate'>, today: string): string {
  if (!e.active) return 'Inactive';
  if (e.releaseDate && e.releaseDate <= today) return 'Released';
  return '';
}

/** "1,234.56/hr" or "52,000.00/yr" pay rate text of an employee. */
export function payRateText(e: Pick<Employee, 'hourlyRate' | 'annualSalary'>): string {
  if (e.annualSalary) return `${money$(e.annualSalary)}/yr`;
  if (e.hourlyRate) return `${money$(e.hourlyRate)}/hr`;
  return '';
}

/** Multi-line address text. */
export function addressText(a: Employee['address']): string {
  return [a.line1, a.line2, [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join('\n');
}

/** Short form of a SerieX Books error for a message (the network details in parentheses dropped). */
export function shortBooksError(msg: string): string {
  return msg.replace(/\s*\((?:Get|Post|Put|Delete|dial)\b[^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Creates or updates the employee's SerieX Books "other" name (POST /employees/{id}/books-sync) and
 * says how it went. Resolves true when SerieX Books has the name.
 */
export async function syncEmployeeToBooks(e: Pick<Employee, 'id' | 'displayName'>): Promise<boolean> {
  try {
    const r = await api.post<Employee>(`/employees/${e.id}/books-sync`, {});
    await invalidateAll();
    if (r.booksSyncError) {
      await alertBox(`SerieX Books was not updated: ${shortBooksError(r.booksSyncError)}`, 'SerieX Books', 'warning');
      return false;
    }
    toast(`"${r.displayName}" is in SerieX Books`, { kind: 'success' });
    return true;
  } catch (err) {
    await showError(err);
    return false;
  }
}
