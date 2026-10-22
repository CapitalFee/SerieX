// Shared helpers of the lists module: list page layout, bulk selection and row
// action columns for ListView, delete / make-inactive flows with plain-English messages,
// printing a list, openers for registers, activity reports and transaction forms, and the handling of
// "someone else changed this record after you opened it" (useStaleCopy).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { RotateCw } from 'lucide-react';
import { api, ApiError } from '@/api/client';
import { invalidateAll } from '@/api/hooks';
import { BALANCE_SHEET_TYPES, type Account, type ID, type Prefs, type TxnType } from '@/api/types';
import { Button } from '@/components/buttons';
import { alertBox, msgBox } from '@/components/dialogs';
import { SearchBox, type SearchBoxProps } from '@/components/display';
import type { FormErrorsState } from '@/components/formErrors';
import { type ListColumn } from '@/components/ListView';
import { toast } from '@/components/toast';
import { CREATED_EVENT, type CreatedDetail } from '@/components/pickers';
import { useSession } from '@/state/session';
import { escHtml, printHtml } from '@/util/print';
import type { WindowKind } from '@/windows/kinds';
import { openWindow } from '@/windows/windowStore';
import './lists.css';

// ---------------------------------------------------------------------------
// small utilities

/** "1 account" / "3 accounts". */
export function plural(n: number, one: string, many = one + 's'): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** Capitalizes the first letter. */
export function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Message of a thrown error (null for a cancelled server question). */
export function errMessage(e: unknown): string | null {
  const err = e as ApiError;
  if (err && err.code === 'cancelled') return null;
  return (err && err.message) || 'Something went wrong. Please try again.';
}

/** A boolean / string view preference remembered in this browser (per viewer convenience). */
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

/**
 * Puts the keyboard focus on the control named `name` inside a window once the window settles
 * (after "Save and new" the dialog's buttons are busy for a moment and focus may wander).
 */
export function focusLater(windowId: string, name: string): void {
  let tries = 0;
  let held = 0;
  const go = () => {
    const el = document.querySelector<HTMLElement>(`[data-window-id="${windowId}"] [name="${name}"]`);
    if (el && document.activeElement === el) held++;
    else if (el) {
      held = 0;
      el.focus();
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
    }
    // stop once the field kept the focus for a moment
    if (held < 2 && ++tries < 8) setTimeout(go, 50);
  };
  setTimeout(go, 20);
}

/** JSON of a value with sorted object keys, to compare a record with the copy it started from. */
export function snapshotOf(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, (x as Record<string, unknown>)[k]]),
        )
      : x,
  );
}

/** Calls `fn` with the id of every record created elsewhere (the "sx-created" window event). */
export function useCreatedListener(kind: CreatedDetail['kind'], fn: (d: CreatedDetail) => void, list?: string): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent<CreatedDetail>).detail;
      if (!d || d.kind !== kind || (list && d.list !== list)) return;
      ref.current(d);
    };
    window.addEventListener(CREATED_EVENT, h);
    return () => window.removeEventListener(CREATED_EVENT, h);
  }, [kind, list]);
}

/**
 * Scrolls a ListView (inside rootRef) to a row once it is in `rows`, and puts the keyboard focus
 * on the list. Call the returned function with the row key to reveal (e.g. a record just created).
 */
export function useRevealRow<T>(rootRef: RefObject<HTMLElement | null>, rows: readonly T[], getKey: (r: T) => ID | string, rowHeight = 26) {
  const want = useRef<{ key: ID | string; at: number } | null>(null);
  useEffect(() => {
    const w = want.current;
    if (!w) return;
    const i = rows.findIndex((r) => getKey(r) === w.key);
    if (i < 0) {
      if (Date.now() - w.at > 4000) want.current = null;
      return;
    }
    want.current = null;
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
  const reveal = useCallback((k: ID | string) => {
    want.current = { key: k, at: Date.now() };
  }, []);
  /** True while a row is waiting to be revealed (do not move the selection meanwhile). */
  const pending = useCallback(() => !!want.current && Date.now() - want.current.at < 4000, []);
  return Object.assign(reveal, { pending });
}

/**
 * Keeps a row selected: when the selected row is not shown (search, filters, first load), the
 * first visible row is selected, unless a just-created row is about to appear.
 */
export function useAutoSelect<T>(rows: readonly T[], selected: T | null, select: (r: T) => void, pending?: () => boolean): void {
  useEffect(() => {
    if (!selected && rows.length && !pending?.()) select(rows[0]);
  });
}

/** Ids of a record and all its descendants (records with parentId). */
export function descendantIds<T extends { id: ID; parentId: ID | null }>(rows: readonly T[], id: ID): Set<ID> {
  const out = new Set<ID>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (r.parentId !== null && out.has(r.parentId) && !out.has(r.id)) {
        out.add(r.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Plain text search: every word must appear in one of the texts. */
export function matchesSearch(q: string, ...texts: (string | null | undefined)[]): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = texts.filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

// ---------------------------------------------------------------------------
// accounts

/** True for balance sheet account types (they have a register and a balance). */
export function isBalanceSheet(a: Pick<Account, 'type'> | null | undefined): boolean {
  return !!a && BALANCE_SHEET_TYPES.includes(a.type);
}

/** Account name as the lists show it: "10000 · Checking" when account numbers are on. */
export function accountLabel(a: Pick<Account, 'number' | 'fullName' | 'name'>, prefs: Pick<Prefs, 'useAccountNumbers'>, full = true): string {
  const n = full ? a.fullName || a.name : a.name;
  return prefs.useAccountNumbers && a.number ? `${a.number} · ${n}` : n;
}

/** Opens the register of a balance sheet account. */
export function openRegister(a: Pick<Account, 'id' | 'fullName' | 'name'>): void {
  openWindow('register', { accountId: a.id, accountName: a.fullName || a.name });
}

/** Opens a report window. */
export function openReport(key: string, params: Record<string, string> = {}, title?: string): void {
  openWindow('report', title ? { key, params, title } : { key, params });
}

/** Account Activity report (all dates). */
export function openAccountActivity(a: Pick<Account, 'id' | 'fullName' | 'name'>): void {
  openReport('account_quickreport', { accountId: String(a.id), dates: 'all' }, `Account Activity: ${a.fullName || a.name}`);
}

/** Item Activity report (all dates). */
export function openItemActivity(id: ID, name: string): void {
  openReport('item_quickreport', { itemId: String(id), dates: 'all' }, `Item Activity: ${name}`);
}

/** Activity report of an other name (all dates). */
export function openNameActivity(id: ID, name: string): void {
  openReport('name_quickreport', { nameId: String(id), dates: 'all' }, `Other Name Activity: ${name}`);
}

// ---------------------------------------------------------------------------
// transaction forms (memorized transactions)

/**
 * Window kind (and extra props) of the form of each transaction type (same mapping as openTxn).
 * `needsId`: the window cannot start from a memorized template (or does not move the schedule
 * on), so a memorized transaction of that type is saved directly instead.
 */
export const TXN_FORMS: Record<TxnType, { kind: WindowKind; props?: Record<string, unknown>; needsId?: boolean }> = {
  INV: { kind: 'invoice' },
  SALESRCPT: { kind: 'salesReceipt' },
  PMT: { kind: 'receivePayment' },
  CREDMEM: { kind: 'creditMemo' },
  STMTCHG: { kind: 'statementCharges', needsId: true },
  EST: { kind: 'estimate' },
  DEP: { kind: 'makeDeposit' },
  CHK: { kind: 'writeCheck' },
  REFUND: { kind: 'refund' },
  BILL: { kind: 'bill' },
  BILLCRED: { kind: 'bill', props: { credit: true } },
  BILLPMT: { kind: 'billPayment', needsId: true },
  ITEMRCPT: { kind: 'receiveItems' },
  PURCHORD: { kind: 'purchaseOrder' },
  CCCHARGE: { kind: 'ccCharge' },
  CCCREDIT: { kind: 'ccCharge', props: { credit: true } },
  TRANSFER: { kind: 'transferFunds' },
  GENJRNL: { kind: 'journalEntry' },
  INVADJ: { kind: 'inventoryAdjust' },
  TAXPMT: { kind: 'salesTaxPayment', needsId: true },
};

// ---------------------------------------------------------------------------
// list page layout

/** Props of {@link ListPage}. */
export interface ListPageProps {
  /** Left part of the top bar (search box). */
  toolbar: ReactNode;
  /** Quick filters (chips): next to the search box on wide pages, on their own row when narrow. */
  filters?: ReactNode;
  /** Right part of the top bar (the New button...). */
  actions?: ReactNode;
  /** Bar shown under the top bar (bulk actions, notices). */
  bulk?: ReactNode;
  /** The list (or an empty state). */
  children: ReactNode;
  /** Bottom menu buttons ("Account ▾", "Activities ▾", "Reports ▾"). */
  footer?: ReactNode;
  /** Text at the bottom right ("58 accounts"). */
  status?: ReactNode;
  rootRef?: RefObject<HTMLDivElement>;
}

/**
 * Search box for the top bar of a list window: 210 px wide, wider when its placeholder needs it
 * (measured in the app's own font, so "Search memorized transactions" is never cut), narrower
 * only when the window has no room.
 */
export function ListSearchBox(props: SearchBoxProps) {
  return <SearchBox {...props} width={props.width ?? 210} />;
}

/** Standard list window: top bar, optional bulk bar, list, bottom menu buttons. */
export function ListPage({ toolbar, filters, actions, bulk, children, footer, status, rootRef }: ListPageProps) {
  const own = useRef<HTMLDivElement>(null);
  const ref = rootRef ?? own;
  const width = useElementWidth(ref);
  const stacked = !!filters && width > 0 && width < 940;
  return (
    <div className="fl-page" ref={ref}>
      <div className="fl-head">
        {toolbar}
        {!stacked && filters}
        {actions && <div className="fl-head-right">{actions}</div>}
      </div>
      {stacked && <div className="fl-head">{filters}</div>}
      {bulk}
      {children}
      {(footer || status) && (
        <div className="fl-foot">
          {footer}
          {status !== undefined && <span className="fl-count">{status}</span>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// bulk selection column

function TriCheck({ checked, indeterminate, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: (v: boolean) => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <span className="fl-check" onDoubleClick={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <input
        ref={ref}
        type="checkbox"
        tabIndex={-1}
        aria-label={label}
        checked={checked}
        // keep the keyboard focus on the list
        onMouseDown={(e) => e.preventDefault()}
        onChange={(e) => onChange(e.target.checked)}
      />
    </span>
  );
}

/** Bulk selection state with a check box column for ListView. Space toggles the current row. */
export function useBulkSelect<T>(rows: readonly T[], getKey: (r: T) => ID, rowLabel: (r: T) => string) {
  const [sel, setSel] = useState<Set<ID>>(() => new Set());
  const visible = useMemo(() => new Set(rows.map(getKey)), [rows, getKey]);
  const selected = useMemo(() => new Set([...sel].filter((k) => visible.has(k))), [sel, visible]);
  const toggle = useCallback((k: ID, on?: boolean) => {
    setSel((s) => {
      const n = new Set(s);
      const want = on ?? !n.has(k);
      if (want) n.add(k);
      else n.delete(k);
      return n;
    });
  }, []);
  const all = rows.length > 0 && selected.size === rows.length;
  const column: ListColumn<T> = {
    key: '__sel',
    label: <TriCheck checked={all} indeterminate={selected.size > 0} label="Select all" onChange={(on) => setSel(on ? new Set(rows.map(getKey)) : new Set())} />,
    width: 34,
    sortable: false,
    align: 'center',
    render: (r) => <TriCheck checked={selected.has(getKey(r))} label={`Select ${rowLabel(r)}`} onChange={(on) => toggle(getKey(r), on)} />,
  };
  const clear = useCallback(() => setSel(new Set()), []);
  // Space toggles the current row, except while the user is typing a name (type-ahead)
  const lastType = useRef(0);
  const onListKeyDown = useCallback(
    (e: React.KeyboardEvent, current: T | null) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === ' ') {
        if (Date.now() - lastType.current < 900) {
          e.preventDefault();
          return;
        }
        if (current) {
          e.preventDefault();
          toggle(getKey(current));
        }
      } else if (e.key.length === 1) lastType.current = Date.now();
    },
    [toggle, getKey],
  );
  return { selected, count: selected.size, column, toggle, clear, onListKeyDown };
}

// ---------------------------------------------------------------------------
// row hover actions

/** One hover action of a row. */
export interface RowAction {
  label: string;
  onClick: () => void;
  title?: string;
}

function RowActions({ actions }: { actions: RowAction[] }) {
  return (
    <span className="fl-rowact" onDoubleClick={(e) => e.stopPropagation()}>
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          tabIndex={-1}
          title={a.title}
          onClick={(e) => {
            e.stopPropagation();
            a.onClick();
          }}
        >
          {a.label}
        </button>
      ))}
    </span>
  );
}

/** Column of links shown when the mouse is over a row (or the row is selected). */
export function actionsColumn<T>(get: (r: T) => RowAction[], width = 150): ListColumn<T> {
  return { key: '__act', label: '', width, sortable: false, align: 'right', render: (r) => <RowActions actions={get(r)} /> };
}

// ---------------------------------------------------------------------------
// someone else changed the record (saves based on an older copy)

/**
 * True for the server's refusal of a save, delete or make-inactive based on an older copy of the
 * record ("Someone else changed this … after you opened it", 409 conflict). Other 409 conflicts
 * (a name already in use, an account with transactions…) are not this.
 */
export function isStaleCopyError(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409 && /after you opened it/i.test(e.message);
}

/** What an edit dialog gets from {@link useStaleCopy}. */
export interface StaleCopy {
  /** True while the last save was refused because someone else changed the record. */
  stale: boolean;
  /**
   * Call it in the save's catch: false for any other error (show it as usual). For the refusal it
   * shows the problem in the banner and asks whether to load the latest version now.
   */
  handle: (e: unknown) => Promise<boolean>;
  /** "Reload" button (loads the latest version) for the dialog's footer while `stale` (else null). */
  button: ReactNode;
  /** Loads the latest version (the changes made in the window are dropped). */
  reload: () => Promise<void>;
}

/**
 * Handling of "someone else changed this record after you opened it" in an edit dialog.
 * `what` is "account", "item", "terms"…; `reload` loads the latest copy of the record into the
 * dialog (returns false when it no longer exists, after showing that). The dialog sends the
 * record's updatedAt as it was opened, so the server refuses a save based on an older copy.
 */
export function useStaleCopy(fe: FormErrorsState, what: string, reload: () => Promise<boolean | void>): StaleCopy {
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const doReload = useCallback(async () => {
    setBusy(true);
    try {
      const ok = await reloadRef.current();
      setStale(false);
      if (ok !== false) {
        fe.clearAll();
        toast(`Loaded the latest version of this ${what}. Make your changes again if they are still needed.`, { kind: 'info' });
      }
    } catch (e) {
      fe.setMessage(`The latest version could not be loaded: ${errMessage(e) ?? 'please try again.'}`);
    } finally {
      setBusy(false);
    }
  }, [fe, what]);
  const handle = useCallback(
    async (e: unknown): Promise<boolean> => {
      if (!isStaleCopyError(e)) return false;
      setStale(true);
      fe.setErrors({}, `Someone else changed this ${what} after you opened it, so your changes were not saved. Click "Reload" to see their changes, then make yours again.`);
      const r = await msgBox({
        title: 'Changed by Someone Else',
        message: `Someone else changed this ${what} after you opened it, so your changes were not saved.\n\nLoad the latest version now? The changes you made in this window will be lost. (Choose Not Now to keep this window as it is, for example to note your changes first.)`,
        buttons: ['&Reload', '&Not Now'],
        cancelButton: 'Not Now',
        icon: 'warning',
      });
      if (r === 'Reload') await doReload();
      return true;
    },
    [fe, what, doReload],
  );
  const button = stale ? (
    <Button label="Reload" icon={RotateCw} busy={busy} onClick={() => void doReload()} style={{ marginRight: 8 }} title="Load the latest version, saved by someone else (your changes in this window are dropped)" />
  ) : null;
  return { stale, handle, button, reload: doReload };
}

/**
 * Shown when a delete or make-inactive from a list is refused because someone else changed the
 * record since the list was shown: the list is refreshed so the latest version is on screen.
 */
async function staleFromList(what: string, name: string): Promise<void> {
  await invalidateAll();
  await alertBox(`Someone else changed the ${what} "${name}" after the list was shown, so nothing was changed.\n\nThe list now shows the latest version. Check it and try again.`, 'Changed by Someone Else', 'warning');
}

// ---------------------------------------------------------------------------
// delete / make inactive flows

/** Options of {@link deleteRecord}. */
export interface DeleteOptions {
  /** "account", "item", "class"... */
  what: string;
  name: string;
  request: () => Promise<unknown>;
  /** Offered when the server refuses because the record is in use. */
  makeInactive?: () => Promise<unknown>;
  /** Extra sentence in the question. */
  extra?: string;
  /** Known reason the record cannot be deleted (checked before asking the server). */
  blocked?: string | null;
}

/** Asks, deletes, refreshes and confirms with a toast; offers "Make inactive" when the record is in use. */
export async function deleteRecord({ what, name, request, makeInactive, extra, blocked }: DeleteOptions): Promise<boolean> {
  if (blocked) {
    if (makeInactive) {
      const r = await msgBox({ title: `Cannot Delete ${cap(what)}`, message: blocked, buttons: ['Make &Inactive', 'Cancel'], icon: 'warning' });
      if (r === 'Make Inactive') {
        try {
          await makeInactive();
          await invalidateAll();
          toast(`"${name}" is now inactive`);
        } catch (e2) {
          const m2 = errMessage(e2);
          if (isStaleCopyError(e2)) await staleFromList(what, name);
          else if (m2) await alertBox(m2, 'Warning');
        }
      }
    } else await alertBox(blocked, `Cannot Delete ${cap(what)}`, 'warning');
    return false;
  }
  const answer = await msgBox({
    title: `Delete ${cap(what)}`,
    message: `Delete the ${what} "${name}"?${extra ? '\n\n' + extra : ''}\n\nThis cannot be undone.`,
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
    if (isStaleCopyError(e)) {
      await staleFromList(what, name);
      return false;
    }
    if (makeInactive && e instanceof ApiError && /inactive/i.test(msg)) {
      const r = await msgBox({ title: `Cannot Delete ${cap(what)}`, message: msg, buttons: ['Make &Inactive', 'Cancel'], icon: 'warning' });
      if (r === 'Make Inactive') {
        try {
          await makeInactive();
          await invalidateAll();
          toast(`"${name}" is now inactive`);
        } catch (e2) {
          const m2 = errMessage(e2);
          if (isStaleCopyError(e2)) await staleFromList(what, name);
          else if (m2) await alertBox(m2, 'Warning');
        }
      }
      return false;
    }
    await alertBox(msg, 'Warning');
    return false;
  }
}

const INACTIVE_HINT = 'Make it inactive instead: it stays in past transactions but no longer appears in lists and drop-downs.';

/** Why a record that has transactions or sub-records cannot be deleted (null when it can). */
export function deleteBlocker(what: string, name: string, info: { special?: boolean; children?: number; hasTxns?: boolean; childWord?: string }): string | null {
  if (info.special) return `SerieX Books uses the ${what} "${name}" for special purposes, so it cannot be deleted. ${INACTIVE_HINT}`;
  if (info.children) return `"${name}" has ${plural(info.children, (info.childWord ?? 'subentries').replace(/s$/, ''), info.childWord ?? 'subentries')}, so it cannot be deleted. Delete or move them first, or make it inactive.`;
  if (info.hasTxns) return `"${name}" is used in transactions, so it cannot be deleted. ${INACTIVE_HINT}`;
  return null;
}

/** Options of {@link setRecordActive}. */
export interface ActiveOptions {
  what: string;
  name: string;
  active: boolean;
  request: () => Promise<unknown>;
  /** Number of sub-records that become inactive too (asks first). */
  childCount?: number;
  /** "subaccounts", "subitems"... */
  childWord?: string;
}

/** Makes a record active/inactive (asking first when sub-records follow), refreshes and confirms. */
export async function setRecordActive({ what, name, active, request, childCount = 0, childWord = 'subentries' }: ActiveOptions): Promise<boolean> {
  if (!active && childCount > 0) {
    const r = await msgBox({
      title: 'Make Inactive',
      message: `Making the ${what} "${name}" inactive also makes its ${plural(childCount, childWord.replace(/s$/, ''), childWord)} inactive.\n\nInactive records stay in old transactions but are hidden from lists and drop-downs. Continue?`,
      buttons: ['&Make Inactive', 'Cancel'],
      icon: 'question',
    });
    if (r !== 'Make Inactive') return false;
  }
  try {
    await request();
    await invalidateAll();
    toast(active ? `"${name}" is active again` : `"${name}" is now inactive`, { kind: 'success' });
    return true;
  } catch (e) {
    if (isStaleCopyError(e)) {
      await staleFromList(what, name);
      return false;
    }
    const msg = errMessage(e);
    if (msg) await alertBox(msg, 'Warning');
    return false;
  }
}

/** Runs one request per record (bulk actions) and reports how many worked. */
export async function runBulk<T>(records: T[], label: (r: T) => string, request: (r: T) => Promise<unknown>, done: (n: number) => string): Promise<void> {
  const problems: string[] = [];
  let ok = 0;
  for (const r of records) {
    try {
      await request(r);
      ok++;
    } catch (e) {
      const m = errMessage(e);
      if (m) problems.push(`${label(r)}: ${m}`);
    }
  }
  await invalidateAll();
  if (ok) toast(done(ok));
  if (problems.length) await alertBox(`Some records could not be changed:\n\n${problems.slice(0, 8).join('\n')}${problems.length > 8 ? `\n…and ${problems.length - 8} more` : ''}`, 'Warning');
}

// ---------------------------------------------------------------------------
// printing

/** One printed column. */
export interface PrintColumn {
  label: string;
  align?: 'left' | 'right';
}

/** One printed row: cell texts, indentation level, inactive mark. */
export interface PrintRow {
  cells: string[];
  level?: number;
  inactive?: boolean;
}

/** Prints a list as a simple report (company name, title, date, table). */
export function printList(title: string, columns: PrintColumn[], rows: PrintRow[]): Promise<void> {
  const company = useSession.getState().company?.name ?? '';
  const today = new Date().toLocaleDateString('en-US');
  const head = columns.map((c) => `<th class="${c.align === 'right' ? 'num' : ''}">${escHtml(c.label)}</th>`).join('');
  const body = rows
    .map(
      (r) =>
        `<tr${r.inactive ? ' class="muted"' : ''}>` +
        r.cells
          .map((c, i) => {
            const pad = i === 0 && r.level ? ` style="padding-left:${6 + r.level * 16}px"` : '';
            return `<td class="${columns[i]?.align === 'right' ? 'num' : ''}"${pad}>${escHtml(c)}${i === 0 && r.inactive ? ' (inactive)' : ''}</td>`;
          })
          .join('') +
        '</tr>',
    )
    .join('');
  const html =
    `<div class="center muted" style="font-size:10px;text-align:left">${escHtml(today)}</div>` +
    `<div class="center bold" style="font-size:13px">${escHtml(company)}</div>` +
    `<h1 class="center">${escHtml(title)}</h1>` +
    `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  return printHtml(title, html, 'h1.center, .center{text-align:center} tbody tr:nth-child(even) td{background:#f6f6f6}');
}

/** Downloads a list export from the server (GET /export/{entity}). */
export async function downloadExport(entity: 'accounts' | 'customers' | 'vendors' | 'items' | 'other'): Promise<void> {
  try {
    await api.download(`/export/${entity}`, `${entity}.csv`);
  } catch (e) {
    const m = errMessage(e);
    if (m) await alertBox(m, 'Export');
  }
}
