// List pickers (ComboBox + data hooks): accounts, names, items, simple lists.
//
// Quick creation: typing a name that is not in the list offers
// '+ Add "<text>"', which opens a small quick create popover (essentials only: name and kind,
// item type / price / income account, account type), POSTs the record, selects it and announces
// it with notifyCreated(). "Add with details…" and "+ Add new" open the full edit dialog with
// openWindow(kind, { name }); the dialog announces the new record with the window event
// "sx-created" ({kind, id, list?}) — use notifyCreated() — and the picker selects it.
// With `quickCreate={false}` a message box asks instead ("Add Name Only / Add with Details / Cancel").
//
// Context: names show their open balance, items their price and quantity on hand,
// accounts their type and balance; recently picked entries (per company and picker kind) are
// listed first when the field is empty.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/api/client';
import { queryClient, useAccounts, useAccountsById, useItems, useItemsById, useList, useNames, usePrefValues } from '@/api/hooks';
import {
  BALANCE_SHEET_TYPES,
  emptyAddress,
  LIST_TITLES,
  type Account,
  type AccountType,
  type ID,
  type Item,
  type ItemType,
  type ListEntry,
  type ListName,
  type Name,
  type NameKind,
} from '@/api/types';
import { openWindow, useWindowStore } from '@/windows/windowStore';
import { useOptionalWindow } from '@/windows/WindowContext';
import { fmtMoney, fmtPercent, fmtQty } from '@/util/format';
import { getRecentPicks, recordRecentPick } from '@/util/recent';
import { ComboBox, type ComboBoxProps, type ComboColumn } from './ComboBox';
import { useGridCell } from './Grid';
import { alertBox, choiceBox, msgBox } from './dialogs';
import { QuickCreateAccount, QuickCreateItem, QuickCreateName, newNameRecord } from './quickCreate';
import { toast } from './toast';

// ---------------------------------------------------------------------------
// "sx-created" window event

/** Name of the window event dispatched by edit dialogs after creating a record. */
export const CREATED_EVENT = 'sx-created';

/** Detail of the "sx-created" event. */
export interface CreatedDetail {
  kind: 'account' | 'name' | 'item' | 'list';
  id: ID;
  /** For kind "list": which simple list. */
  list?: ListName;
  /**
   * Created by a picker's quick create popover (the picker selects it itself): "< Add New >"
   * waiters ignore it, so a record quick-created inside a dialog never lands in the field that
   * opened the dialog.
   */
  quick?: boolean;
}

/**
 * Announces a newly created record (call it in account/name/item/list edit dialogs after a
 * successful POST). A picker that opened the dialog through "< Add New >" selects it.
 */
export function notifyCreated(detail: CreatedDetail): void {
  window.dispatchEvent(new CustomEvent<CreatedDetail>(CREATED_EVENT, { detail }));
}

/** A pending "< Add New >" waiter (see awaitCreated). */
interface CreatedWaiter {
  kind: CreatedDetail['kind'];
  list: ListName | undefined;
  windowId?: string;
  /** The dialog window closed (the waiter stops a moment later). */
  closed: boolean;
  serve(id: ID): void;
  stop(): void;
}

/**
 * Pending waiters, innermost last. Dialogs opened from a dialog nest: only the innermost waiter
 * is served; once it is served or stopped, the outer one is served again.
 */
let waiters: CreatedWaiter[] = [];

function onCreatedEvent(e: Event) {
  const d = (e as CustomEvent<CreatedDetail>).detail;
  if (!d || d.quick) return;
  for (let i = waiters.length - 1; i >= 0; i--) {
    const w = waiters[i];
    if (w.kind === d.kind && (!w.list || d.list === w.list)) {
      w.stop();
      w.serve(d.id);
      return;
    }
    // an inner dialog that is still open owns what is created now; a closed one is skipped
    if (!w.closed) return;
  }
}

/**
 * Stops the waiters whose dialog is already closed (a quick-created record must not land in a
 * field whose Add New dialog was cancelled). Waiters of open dialogs keep waiting.
 */
export function cancelCreatedWaiters(): void {
  for (const w of [...waiters]) if (w.closed) w.stop();
}

/** Options of {@link awaitCreated}. */
export interface AwaitCreatedOptions {
  /**
   * Window id of the edit dialog that was opened (openWindow's result): when that window closes
   * without announcing a record (Cancel), the waiter stops, so a record created later elsewhere
   * is not put in this field.
   */
  windowId?: string;
}

/**
 * Waits for the next "sx-created" event of a kind (and list). Only the innermost pending waiter
 * of the whole app is served (a dialog opened from a dialog nests; when the inner waiter is
 * served or stopped the outer one is served again), so an abandoned Add New never selects a
 * record in another field. Quick-created records (detail.quick) are ignored.
 * Returns a function that stops waiting.
 */
export function awaitCreated(kind: CreatedDetail['kind'], list: ListName | undefined, onCreated: (id: ID) => void, opts: AwaitCreatedOptions = {}): () => void {
  let unsubscribe: (() => void) | null = null;
  let closeTimer: number | undefined;
  const w: CreatedWaiter = {
    kind,
    list,
    windowId: opts.windowId,
    closed: false,
    serve: onCreated,
    stop: () => {
      waiters = waiters.filter((x) => x !== w);
      if (!waiters.length) window.removeEventListener(CREATED_EVENT, onCreatedEvent);
      unsubscribe?.();
      unsubscribe = null;
      window.clearTimeout(closeTimer);
    },
  };
  if (!waiters.length) window.addEventListener(CREATED_EVENT, onCreatedEvent);
  waiters = [...waiters, w];
  if (opts.windowId) {
    const wid = opts.windowId;
    unsubscribe = useWindowStore.subscribe((st) => {
      if (st.windows.some((v) => v.id === wid)) return;
      unsubscribe?.();
      unsubscribe = null;
      w.closed = true;
      // a dialog may announce the record right after closing: stop a moment later
      closeTimer = window.setTimeout(w.stop, 1500);
    });
  }
  return w.stop;
}

/**
 * "< Add New >" / "Add with details…" waiter of a picker. In a Grid cell editor the waiter
 * outlives the editor (the dialog takes the focus, so the cell editor closes): the new record is
 * still put in that cell, and the cell is activated again.
 */
function useCreatedWaiter() {
  const stop = useRef<(() => void) | null>(null);
  const cell = useGridCell();
  const cellRef = useRef(cell);
  cellRef.current = cell;
  useEffect(
    () => () => {
      // a grid cell editor unmounts while the dialog is open: keep waiting (see above)
      if (!cellRef.current) stop.current?.();
    },
    [],
  );
  return (kind: CreatedDetail['kind'], list: ListName | undefined, cb: (id: ID) => void | Promise<void>, windowId?: string) => {
    stop.current?.();
    const gridCell = cellRef.current;
    stop.current = awaitCreated(
      kind,
      list,
      (id) => {
        stop.current = null;
        void Promise.resolve(cb(id)).then(() => {
          if (gridCell) setTimeout(() => gridCell.activate(), 0);
        });
      },
      { windowId },
    );
  };
}

// ---------------------------------------------------------------------------
// Shared props

type PassThrough = Pick<
  ComboBoxProps<unknown>,
  | 'fallbackLabel'
  | 'placeholder'
  | 'disabled'
  | 'readOnly'
  | 'autoFocus'
  | 'id'
  | 'name'
  | 'title'
  | 'className'
  | 'style'
  | 'width'
  | 'listWidth'
  | 'maxRows'
  | 'inGrid'
  | 'tabIndex'
  | 'invalid'
  | 'hideErrorMessage'
  | 'aria-label'
  | 'onKeyDown'
  | 'onFocus'
  | 'onBlur'
>;

/**
 * Props shared by every picker. Other ComboBox props (width, inGrid, autoFocus, name...) pass
 * through; `name` is also the key of the field's inline error (FormErrorsProvider).
 */
export interface PickerBaseProps<R> extends PassThrough {
  /** Selected record id. */
  value: ID | null | undefined;
  /** Called with the new id (null when cleared) and the record. */
  onChange: (id: ID | null, record: R | null) => void;
  /** Allow creating records from the picker: "+ Add new", quick create, details (default true). */
  addNew?: boolean;
  /**
   * Quick create popover for unknown text (default true when addNew; simple lists
   * without a quick form keep the classic "not in list" box).
   */
  quickCreate?: boolean;
  /** List recently picked entries first when the field is empty (default true). */
  showRecent?: boolean;
  /** Extra filter applied to the records. */
  filter?: (r: R) => boolean;
}

const idOf = (r: { id: ID }) => r.id;
const inactiveOf = (r: { active: boolean }) => !r.active;

/** Recent-pick list of a picker kind, refreshed when the value changes. */
function useRecent(kind: string, enabled: boolean, value: unknown): ID[] | undefined {
  return useMemo(() => (enabled ? (getRecentPicks(kind) as ID[]) : undefined), [kind, enabled, value]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Quick create popover state of a picker. */
function useQuick() {
  const [qc, setQc] = useState<{ typed: string; anchor: HTMLElement | null } | null>(null);
  const refocus = (anchor: HTMLElement | null) => {
    const input = anchor?.querySelector<HTMLInputElement>('input');
    if (input && input.isConnected) setTimeout(() => input.focus(), 0);
  };
  return { qc, open: (typed: string, anchor: HTMLElement | null) => setQc({ typed, anchor }), close: () => setQc(null), refocus };
}

// ---------------------------------------------------------------------------
// "Use Once" of inactive records

/** Records the server asks about when a transaction uses an inactive one. */
export type InactiveRecordKind = 'accounts' | 'names' | 'items';

/** Inactive records the user chose to "Use Once", per window id (keys "names:65"). */
const usedOnce = new Map<string, Set<string>>();

/** Key of a record in the "Use Once" sets ("names:65"). */
export const inactiveRecordKey = (kind: InactiveRecordKind, id: ID) => `${kind}:${id}`;

/** Remembers that the user chose "Use Once" for an inactive record in a window. */
export function noteInactiveUsedOnce(windowId: string | null | undefined, kind: InactiveRecordKind, id: ID): void {
  if (!windowId) return;
  let set = usedOnce.get(windowId);
  if (!set) usedOnce.set(windowId, (set = new Set()));
  set.add(inactiveRecordKey(kind, id));
}

/**
 * The inactive records the user chose to "Use Once" in a window (keys from inactiveRecordKey).
 * Transaction forms send accept=inactive when saving, so the server does not ask again.
 */
export function inactiveUsedOnce(windowId: string | null | undefined): ReadonlySet<string> {
  return (windowId && usedOnce.get(windowId)) || new Set<string>();
}

/** Forgets the "Use Once" answers of a window (it saved, moved to another transaction or closed). */
export function forgetInactiveUsedOnce(windowId: string | null | undefined): void {
  if (windowId) usedOnce.delete(windowId);
}

/**
 * Asks what to do with an inactive record the user picked or typed ("X is inactive"):
 * Make Active (PUT .../active, then the lists are refreshed), Use Once (selected, it stays
 * inactive; `onUseOnce` runs, and the form tells the server when the transaction is saved, so
 * it does not ask again) or Cancel.
 * Resolves true when the record may be used.
 */
export async function confirmInactiveUse(label: string, activate: () => Promise<unknown>, refreshKey: unknown[], onUseOnce?: () => void): Promise<boolean> {
  const r = await msgBox({
    title: 'Inactive Entry',
    message: `${label} is inactive.\n\nMake it active again, or use it this one time and keep it inactive?`,
    buttons: ['Make &Active', '&Use Once', 'Cancel'],
    icon: 'question',
  });
  if (r === 'Use Once') {
    onUseOnce?.();
    return true;
  }
  if (r !== 'Make Active') return false;
  try {
    await activate();
    await queryClient.invalidateQueries({ queryKey: refreshKey });
    toast(`${label} is active again`, { kind: 'success' });
    return true;
  } catch (e) {
    if ((e as { code?: string }).code !== 'cancelled') await alertBox((e as Error).message, 'Warning');
    return false;
  }
}

/** "Make active" of a name / item / account record (PUT /{names|items|accounts}/{id}/active). */
export const activateRecord = (path: 'names' | 'items' | 'accounts', id: ID) => api.put(`/${path}/${id}/active`, { active: true });

// ---------------------------------------------------------------------------
// AccountPicker

/** Props of {@link AccountPicker}. */
export interface AccountPickerProps extends PickerBaseProps<Account> {
  /** Only these account types. */
  types?: AccountType[];
  /** Hide these account types (e.g. A/R and A/P on expense lines). */
  excludeTypes?: AccountType[];
  /** Hide these accounts (e.g. the "from" account in a transfer). */
  excludeIds?: ID[];
  /** Show the Balance column for balance sheet accounts (default true). */
  showBalance?: boolean;
  /** Hide the Type column. */
  hideType?: boolean;
}

/** Account drop-down (Chart of Accounts tree, type + balance columns, quick create, Add New → New Account dialog). */
export function AccountPicker({ types, excludeTypes, excludeIds, filter, showBalance = true, hideType, addNew = true, quickCreate, showRecent = true, value, onChange, ...rest }: AccountPickerProps) {
  const prefs = usePrefValues();
  const { data } = useAccounts({ active: 'all' });
  const win = useOptionalWindow();
  const wait = useCreatedWaiter();
  const quick = useQuick();
  const recent = useRecent('account', showRecent, value);
  const pick = (id: ID | null, a: Account | null) => {
    if (id !== null) recordRecentPick('account', id);
    onChange(id, a);
  };
  const items = useMemo(
    () =>
      (data ?? []).filter(
        (a) =>
          (!types || types.includes(a.type)) &&
          (!excludeTypes || !excludeTypes.includes(a.type)) &&
          (!excludeIds || !excludeIds.includes(a.id)) &&
          (!filter || filter(a)),
      ),
    [data, types, excludeTypes, excludeIds, filter],
  );
  const num = (a: Account, n: string) => (prefs.useAccountNumbers && a.number ? `${a.number} · ${n}` : n);
  const getLabel = useMemo(() => (a: Account) => num(a, prefs.showLowestSubaccountOnly ? a.name : a.fullName), [prefs.useAccountNumbers, prefs.showLowestSubaccountOnly]); // eslint-disable-line react-hooks/exhaustive-deps
  // the name without the number: typing "Utilities" (or "68600") finds "68600 · Utilities"
  const getMatchText = useMemo(() => (a: Account) => (prefs.showLowestSubaccountOnly ? a.name : a.fullName), [prefs.showLowestSubaccountOnly]);
  const columns = useMemo(() => {
    const c: ComboColumn<Account>[] = [];
    if (!hideType) c.push({ width: 150, render: (a) => a.type, className: 'sx-muted', label: 'Type' });
    if (showBalance) c.push({ width: 96, align: 'right', render: (a) => (BALANCE_SHEET_TYPES.includes(a.type) ? fmtMoney(a.balance) : ''), label: 'Balance' });
    return c;
  }, [hideType, showBalance]);

  const setUp = (typed: string, type?: AccountType) => {
    const wid = openWindow('accountEdit', { type: type ?? types?.[0], name: typed || undefined });
    wait(
      'account',
      undefined,
      async (id) => {
        await queryClient.invalidateQueries({ queryKey: ['accounts'] });
        const a = await api.get<Account>(`/accounts/${id}`).catch(() => null);
        pick(id, a);
      },
      wid,
    );
  };
  const useQuickCreate = addNew && quickCreate !== false;

  return (
    <>
      <ComboBox<Account>
        {...rest}
        items={items}
        value={value}
        onChange={(k, a) => pick(k as ID | null, a)}
        getKey={idOf}
        getLabel={getLabel}
        getListLabel={(a) => num(a, a.name)}
        getLevel={(a) => a.level}
        getSearchText={(a) => `${a.number} ${a.description}`}
        getMatchText={getMatchText}
        getCode={(a) => a.number}
        isInactive={inactiveOf}
        onPickInactive={(a) => confirmInactiveUse(`The account ${getMatchText(a)}`, () => activateRecord('accounts', a.id), ['accounts'], () => noteInactiveUsedOnce(win?.id, 'accounts', a.id))}
        columns={columns}
        recentKeys={recent}
        listWidth={rest.listWidth ?? 220 + columns.reduce((s, c) => s + c.width, 0)}
        onAddNew={addNew ? (t) => setUp(t) : undefined}
        onQuickAdd={useQuickCreate ? quick.open : undefined}
        onAddWithDetails={useQuickCreate ? (t) => setUp(t) : undefined}
        onNotFound={
          useQuickCreate
            ? undefined
            : addNew
              ? async (typed) => {
                  const r = await msgBox({
                    title: 'New Account',
                    message: `"${typed}" is not in your chart of accounts yet. Add it now?`,
                    buttons: ['Add with &Details', 'Cancel'],
                    icon: 'question',
                  });
                  if (r === 'Add with Details') setUp(typed);
                }
              : undefined
        }
      />
      {quick.qc && (
        <QuickCreateAccount
          anchor={quick.qc.anchor}
          initialName={quick.qc.typed}
          types={types}
          excludeTypes={excludeTypes}
          onCancel={() => {
            const a = quick.qc?.anchor ?? null;
            quick.close();
            quick.refocus(a);
          }}
          onDetails={(name, type) => {
            quick.close();
            setUp(name, type);
          }}
          onCreated={(acc) => {
            const a = quick.qc?.anchor ?? null;
            quick.close();
            cancelCreatedWaiters();
            notifyCreated({ kind: 'account', id: acc.id, quick: true });
            pick(acc.id, acc);
            quick.refocus(a);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// NamePicker

const KIND_LABEL: Record<NameKind, string> = { customer: 'Customer', vendor: 'Vendor', other: 'Other' };
const KIND_LIST: Record<NameKind, string> = { customer: 'Customer', vendor: 'Vendor', other: 'Other Name' };
const KIND_WINDOW = { customer: 'customerEdit', vendor: 'vendorEdit', other: 'otherNameEdit' } as const;

/** Props of {@link NamePicker}. */
export interface NamePickerProps extends PickerBaseProps<Name> {
  /** Kinds of names listed (default all: customers & jobs, vendors, other names). */
  kinds?: NameKind[];
  /** List the jobs under their customers (default true). */
  includeJobs?: boolean;
  /** Show the Type column (default when more than one kind is listed). */
  showType?: boolean;
  /** Offer "Add Name Only" in the not-in-list box (only when quickCreate is false; default true). */
  quickAdd?: boolean;
  /** Show the open balance column (default true for customers and vendors). */
  showBalance?: boolean;
  /**
   * Kind offered first when a new name is created from the picker (quick create popover and the
   * "Select Name Type" box), e.g. 'vendor' for a check payee. Default: the first of `kinds`
   * (customer when all kinds are listed).
   */
  defaultKind?: NameKind;
}

function treeSort(names: Name[]): Name[] {
  const byParent = new Map<ID | null, Name[]>();
  const ids = new Set(names.map((n) => n.id));
  for (const n of names) {
    const p = n.parentId !== null && ids.has(n.parentId) ? n.parentId : null;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p)!.push(n);
  }
  const out: Name[] = [];
  const walk = (p: ID | null) => {
    const kids = byParent.get(p);
    if (!kids) return;
    if (p === null) kids.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    for (const k of kids) {
      out.push(k);
      walk(k.id);
    }
  };
  walk(null);
  return out;
}

const blankName = (kind: NameKind, name: string): Partial<Name> => newNameRecord(kind, name);

/** Customer:Job / Vendor / Other name drop-down (tree of jobs, Type and open balance columns, quick create). */
export function NamePicker({ kinds, includeJobs = true, showType, quickAdd = true, showBalance, defaultKind, filter, addNew = true, quickCreate, showRecent = true, value, onChange, ...rest }: NamePickerProps) {
  const single = kinds && kinds.length === 1 ? kinds[0] : undefined;
  const { data } = useNames(single, { active: 'all' });
  const win = useOptionalWindow();
  const wait = useCreatedWaiter();
  const quick = useQuick();
  const recentKind = `name:${single ?? 'all'}`;
  const recent = useRecent(recentKind, showRecent, value);
  const pick = (id: ID | null, n: Name | null) => {
    if (id !== null) recordRecentPick(recentKind, id);
    onChange(id, n);
  };
  const items = useMemo(() => {
    let list = (data ?? []).filter((n) => (!kinds || kinds.includes(n.kind)) && (includeJobs || n.parentId === null) && (!filter || filter(n)));
    if (!single) list = treeSort(list);
    return list;
  }, [data, kinds, single, includeJobs, filter]);
  const typeCol = showType ?? !single;
  const balCol = showBalance ?? single !== 'other';
  const columns = useMemo<ComboColumn<Name>[]>(() => {
    const c: ComboColumn<Name>[] = [];
    if (typeCol) c.push({ width: 84, render: (n) => (n.kind === 'customer' && n.parentId ? 'Job' : KIND_LABEL[n.kind]), className: 'sx-muted', label: 'Type' });
    if (balCol) c.push({ width: 96, align: 'right', render: (n) => (n.kind === 'other' ? '' : fmtMoney(n.balance, { blankZero: true })), label: 'Open balance' });
    return c;
  }, [typeCol, balCol]);
  const allowed: NameKind[] = kinds ?? ['customer', 'vendor', 'other'];
  const listName = single ? KIND_LIST[single] : 'Name';

  const pickKind = async (): Promise<NameKind | null> => {
    if (allowed.length === 1) return allowed[0];
    const order: NameKind[] = ['vendor', 'customer', 'other'];
    const v = await choiceBox({
      title: 'Select Name Type',
      message: 'Select which type of name to add, then click OK.',
      choices: order.filter((k) => allowed.includes(k)).map((k) => ({ value: k, label: KIND_LABEL[k] })),
      defaultValue: defaultKind && allowed.includes(defaultKind) ? defaultKind : undefined,
    });
    return (v as NameKind | null) ?? null;
  };

  const setUp = async (typed: string, kindGiven?: NameKind) => {
    const kind = kindGiven ?? (await pickKind());
    if (!kind) return;
    const wid = openWindow(KIND_WINDOW[kind], { name: typed || undefined });
    wait(
      'name',
      undefined,
      async (id) => {
        await queryClient.invalidateQueries({ queryKey: ['names'] });
        const n = await api.get<Name>(`/names/${id}`).catch(() => null);
        pick(id, n);
      },
      wid,
    );
  };

  const doQuickAdd = async (typed: string) => {
    // an inactive name with this text: offer to use it instead of creating a duplicate
    const lower = typed.trim().toLowerCase();
    const old = items.find((n) => !n.active && ((n.fullName || n.name).toLowerCase() === lower || (n.parentId === null && n.name.toLowerCase() === lower)));
    if (old) {
      if (await confirmInactiveUse(old.fullName || old.name, () => activateRecord('names', old.id), ['names'], () => noteInactiveUsedOnce(win?.id, 'names', old.id))) pick(old.id, old);
      return;
    }
    const kind = await pickKind();
    if (!kind) return;
    try {
      const created = await api.post<Name>('/names', blankName(kind, typed));
      await queryClient.invalidateQueries({ queryKey: ['names'] });
      pick(created.id, created);
    } catch (e) {
      if ((e as { code?: string }).code !== 'cancelled') await alertBox((e as Error).message, 'Warning');
    }
  };
  const useQuickCreate = addNew && quickCreate !== false;

  return (
    <>
      <ComboBox<Name>
        {...rest}
        items={items}
        value={value}
        onChange={(k, n) => pick(k as ID | null, n)}
        getKey={idOf}
        getLabel={(n) => n.fullName || n.name}
        getListLabel={(n) => n.name}
        getLevel={(n) => n.level}
        getSearchText={(n) => `${n.companyName} ${n.firstName} ${n.lastName}`}
        isInactive={inactiveOf}
        onPickInactive={(n) => confirmInactiveUse(n.fullName || n.name, () => activateRecord('names', n.id), ['names'], () => noteInactiveUsedOnce(win?.id, 'names', n.id))}
        columns={columns}
        recentKeys={recent}
        listWidth={rest.listWidth ?? 240 + columns.reduce((s, c) => s + c.width, 0)}
        onAddNew={addNew ? (t) => void setUp(t) : undefined}
        onQuickAdd={useQuickCreate ? quick.open : undefined}
        onAddWithDetails={useQuickCreate ? (t) => void setUp(t) : undefined}
        onNotFound={
          useQuickCreate
            ? undefined
            : addNew
              ? async (typed) => {
                  const buttons = quickAdd ? ['&Add Name Only', 'Add with &Details', 'Cancel'] : ['Add with &Details', 'Cancel'];
                  const r = await msgBox({
                    title: `New ${listName}`,
                    message: quickAdd
                      ? `"${typed}" is not in your ${listName.toLowerCase()} list yet. Add it with just the name, or open the full form to add details.`
                      : `"${typed}" is not in your ${listName.toLowerCase()} list yet. Add it now?`,
                    buttons,
                    icon: 'question',
                  });
                  if (r === 'Add Name Only') await doQuickAdd(typed);
                  else if (r === 'Add with Details') await setUp(typed);
                }
              : undefined
        }
      />
      {quick.qc && (
        <QuickCreateName
          anchor={quick.qc.anchor}
          initialName={quick.qc.typed}
          kinds={allowed}
          defaultKind={defaultKind}
          onCancel={() => {
            const a = quick.qc?.anchor ?? null;
            quick.close();
            quick.refocus(a);
          }}
          onDetails={(name, kind) => {
            quick.close();
            void setUp(name, kind);
          }}
          onCreated={(n) => {
            const a = quick.qc?.anchor ?? null;
            quick.close();
            cancelCreatedWaiters();
            notifyCreated({ kind: 'name', id: n.id, quick: true });
            pick(n.id, n);
            quick.refocus(a);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// ItemPicker

/** Props of {@link ItemPicker}. */
export interface ItemPickerProps extends PickerBaseProps<Item> {
  /** Only these item types. */
  types?: ItemType[];
  excludeTypes?: ItemType[];
  /** Purchase side: show purchase description and cost instead of sales description and price. */
  purchase?: boolean;
  /** Hide the description/price/on hand columns. */
  compact?: boolean;
  /** Show the quantity on hand column (default when inventory is turned on). */
  showOnHand?: boolean;
}

/** Item drop-down (tree, description, price and on hand columns, quick create, Add New → New Item dialog). */
export function ItemPicker({ types, excludeTypes, purchase, compact, showOnHand, filter, addNew = true, quickCreate, showRecent = true, value, onChange, ...rest }: ItemPickerProps) {
  const prefs = usePrefValues();
  const { data } = useItems({ active: 'all' });
  const win = useOptionalWindow();
  const wait = useCreatedWaiter();
  const quick = useQuick();
  const recent = useRecent('item', showRecent, value);
  const pick = (id: ID | null, it: Item | null) => {
    if (id !== null) recordRecentPick('item', id);
    onChange(id, it);
  };
  const onHand = showOnHand ?? prefs.inventoryEnabled;
  const items = useMemo(
    () => (data ?? []).filter((i) => (!types || types.includes(i.type)) && (!excludeTypes || !excludeTypes.includes(i.type)) && (!filter || filter(i))),
    [data, types, excludeTypes, filter],
  );
  const columns = useMemo<ComboColumn<Item>[]>(() => {
    if (compact) return [];
    const c: ComboColumn<Item>[] = [
      { width: 200, render: (i) => (purchase ? i.purchaseDescription || i.description : i.description), className: 'sx-muted', label: 'Description' },
      {
        width: 80,
        align: 'right',
        label: purchase ? 'Cost' : 'Price',
        render: (i) => {
          const v = purchase ? i.cost : i.type === 'Sales Tax Item' ? i.taxRate : i.salesPrice;
          if (i.rateIsPercent || i.type === 'Sales Tax Item') return v ? fmtPercent(v) : '';
          return fmtMoney(v, { blankZero: true });
        },
      },
    ];
    if (onHand)
      c.push({ width: 76, align: 'right', className: 'sx-muted', label: 'On hand', render: (i) => (i.type === 'Inventory Part' ? fmtQty(i.qtyOnHand) : '') });
    return c;
  }, [compact, purchase, onHand]);
  const setUp = (typed: string, type?: ItemType) => {
    // a picker limited to some types (the Tax field: Sales Tax Item / Group) opens the dialog on the first one
    const wid = openWindow('itemEdit', { type: type ?? types?.[0], allowedTypes: types, name: typed || undefined });
    wait(
      'item',
      undefined,
      async (id) => {
        await queryClient.invalidateQueries({ queryKey: ['items'] });
        const it = await api.get<Item>(`/items/${id}`).catch(() => null);
        pick(id, it);
      },
      wid,
    );
  };
  const QUICK_TYPES: ItemType[] = ['Service', 'Non-inventory Part', 'Inventory Part', 'Other Charge'];
  const canQuick = !types || types.some((t) => QUICK_TYPES.includes(t));
  const useQuickCreate = addNew && quickCreate !== false && canQuick;
  return (
    <>
      <ComboBox<Item>
        {...rest}
        items={items}
        value={value}
        onChange={(k, i) => pick(k as ID | null, i)}
        getKey={idOf}
        getLabel={(i) => i.fullName || i.name}
        getListLabel={(i) => i.name}
        getLevel={(i) => i.level}
        getSearchText={(i) => `${i.description} ${i.purchaseDescription} ${i.mpn}`}
        isInactive={inactiveOf}
        onPickInactive={(i) => confirmInactiveUse(`The item ${i.fullName || i.name}`, () => activateRecord('items', i.id), ['items'], () => noteInactiveUsedOnce(win?.id, 'items', i.id))}
        columns={columns}
        recentKeys={recent}
        listWidth={rest.listWidth ?? (compact ? 240 : 230 + columns.reduce((s, c) => s + c.width, 0))}
        onAddNew={addNew ? (t) => setUp(t) : undefined}
        onQuickAdd={useQuickCreate ? quick.open : undefined}
        onAddWithDetails={useQuickCreate ? (t) => setUp(t) : undefined}
        onNotFound={
          useQuickCreate
            ? undefined
            : addNew
              ? async (typed) => {
                  const r = await msgBox({
                    title: 'New Item',
                    message: `"${typed}" is not in your item list yet. Add it now?`,
                    buttons: ['Add with &Details', 'Cancel'],
                    icon: 'question',
                  });
                  if (r === 'Add with Details') setUp(typed);
                }
              : undefined
        }
      />
      {quick.qc && (
        <QuickCreateItem
          anchor={quick.qc.anchor}
          initialName={quick.qc.typed}
          types={types}
          purchase={purchase}
          onCancel={() => {
            const a = quick.qc?.anchor ?? null;
            quick.close();
            quick.refocus(a);
          }}
          onDetails={(name, type) => {
            quick.close();
            setUp(name, type);
          }}
          onCreated={(it) => {
            const a = quick.qc?.anchor ?? null;
            quick.close();
            cancelCreatedWaiters();
            notifyCreated({ kind: 'item', id: it.id, quick: true });
            pick(it.id, it);
            quick.refocus(a);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// ListPicker and presets

const QUICK_ADD_LISTS: ListName[] = ['class', 'customer_type', 'vendor_type', 'job_type', 'ship_via', 'customer_message', 'payment_method'];

/** Props of {@link ListPicker}. */
export interface ListPickerProps extends PickerBaseProps<ListEntry> {
  /** Which simple list. */
  list: ListName;
}

/** Drop-down of a simple list (class, terms, payment method, ship via, rep, customer message...). */
export function ListPicker({ list, filter, addNew = true, quickCreate, showRecent = true, value, onChange: onChangeProp, ...rest }: ListPickerProps) {
  const { data } = useList(list, { active: 'all' });
  const wait = useCreatedWaiter();
  const recentKind = `list:${list}`;
  const recent = useRecent(recentKind, showRecent && list !== 'terms', value);
  const onChange = (id: ID | null, e: ListEntry | null) => {
    if (id !== null) recordRecentPick(recentKind, id);
    onChangeProp(id, e);
  };
  const items = useMemo(() => (filter ? (data ?? []).filter(filter) : data ?? []), [data, filter]);
  const title = LIST_TITLES[list];
  const labelOf = (e: ListEntry) => (list === 'sales_rep' ? (e.data?.initials as string) || e.name : e.fullName || e.name);
  const setUp = (typed: string) => {
    const wid = openWindow('listEntryEdit', { list, name: typed || undefined });
    wait(
      'list',
      list,
      async (id) => {
        await queryClient.invalidateQueries({ queryKey: ['list', list] });
        const rows = await api.get<ListEntry[]>(`/lists/${list}?active=all`).catch(() => [] as ListEntry[]);
        onChange(id, rows.find((r) => r.id === id) ?? null);
      },
      wid,
    );
  };
  const quick = QUICK_ADD_LISTS.includes(list);
  const createNow = async (typed: string, anchor?: HTMLElement | null) => {
    const lower = typed.trim().toLowerCase();
    const old = (data ?? []).find((e) => !e.active && (e.fullName || e.name).toLowerCase() === lower);
    if (old) {
      if (await confirmInactiveUse(old.fullName || old.name, () => api.put(`/lists/${list}/${old.id}`, { ...old, active: true }), ['list', list])) onChange(old.id, old);
      anchor?.querySelector<HTMLInputElement>('input')?.focus();
      return;
    }
    try {
      const created = await api.post<ListEntry>(`/lists/${list}`, { id: 0, list, name: typed, parentId: null, active: true, data: {} });
      await queryClient.invalidateQueries({ queryKey: ['list', list] });
      cancelCreatedWaiters();
      notifyCreated({ kind: 'list', id: created.id, list, quick: true });
      onChange(created.id, created);
      toast(`${title} "${created.name}" added`, { kind: 'success' });
      anchor?.querySelector<HTMLInputElement>('input')?.focus();
    } catch (e) {
      if ((e as { code?: string }).code !== 'cancelled') await alertBox((e as Error).message, 'Warning');
    }
  };
  // simple lists only need a name: '+ Add "<text>"' creates the entry right away
  const useQuickCreate = addNew && quickCreate !== false && quick;
  return (
    <ComboBox<ListEntry>
      {...rest}
      items={items}
      value={value}
      onChange={(k, e) => onChange(k as ID | null, e)}
      getKey={idOf}
      getLabel={labelOf}
      getListLabel={(e) => (list === 'sales_rep' && e.data?.initials ? `${e.data.initials} - ${e.name}` : e.name)}
      getLevel={(e) => e.level}
      getSearchText={(e) => e.name}
      isInactive={inactiveOf}
      onPickInactive={(e) => confirmInactiveUse(e.fullName || e.name, () => api.put(`/lists/${list}/${e.id}`, { ...e, active: true }), ['list', list])}
      recentKeys={recent}
      listWidth={rest.listWidth ?? 200}
      onAddNew={addNew ? setUp : undefined}
      onQuickAdd={useQuickCreate ? (t, a) => void createNow(t, a) : undefined}
      onAddWithDetails={addNew && quickCreate !== false ? setUp : undefined}
      onNotFound={
        useQuickCreate
          ? undefined
          : addNew
            ? async (typed) => {
                const r = await msgBox({
                  title: `New Entry: ${title}`,
                  message: `"${typed}" is not in the ${title} list yet. Add it now?`,
                  buttons: quick ? ['&Add Name Only', 'Add with &Details', 'Cancel'] : ['Add with &Details', 'Cancel'],
                  icon: 'question',
                });
                if (r === 'Add Name Only') await createNow(typed);
                else if (r === 'Add with Details') setUp(typed);
              }
            : undefined
      }
    />
  );
}

/** Props of the preset list pickers (TermsPicker, ClassPicker...). */
export type PresetListPickerProps = Omit<ListPickerProps, 'list'>;

/** Terms drop-down (Net 30, 2% 10 Net 30...). */
export function TermsPicker(p: PresetListPickerProps) {
  return <ListPicker list="terms" {...p} />;
}
/** Class drop-down (hierarchical). */
export function ClassPicker(p: PresetListPickerProps) {
  return <ListPicker list="class" {...p} />;
}
/** Payment method drop-down (Cash, Check, Visa...). */
export function PaymentMethodPicker(p: PresetListPickerProps) {
  return <ListPicker list="payment_method" {...p} />;
}
/** Ship Via drop-down. */
export function ShipViaPicker(p: PresetListPickerProps) {
  return <ListPicker list="ship_via" {...p} />;
}
/** Sales rep drop-down (shows the rep's initials, as the REP column of forms does). */
export function RepPicker(p: PresetListPickerProps) {
  return <ListPicker list="sales_rep" {...p} />;
}
/** Customer message drop-down. */
export function CustomerMessagePicker(p: PresetListPickerProps) {
  return <ListPicker list="customer_message" {...p} />;
}

// ---------------------------------------------------------------------------
// Read-only labels (grid cells that are not being edited, summaries)

/** Account name of an id as the pickers show it (number · full name per preferences). */
export function AccountLabel({ id }: { id: ID | null | undefined }) {
  const map = useAccountsById();
  const prefs = usePrefValues();
  if (!id) return null;
  const a = map.get(id);
  if (!a) return null;
  const n = prefs.showLowestSubaccountOnly ? a.name : a.fullName;
  return <>{prefs.useAccountNumbers && a.number ? `${a.number} · ${n}` : n}</>;
}

/** Full name ("Customer:Job") of a name id. `kind` reuses the picker's cached list of that kind. */
export function NameLabel({ id, kind }: { id: ID | null | undefined; kind?: NameKind }) {
  const { data } = useNames(kind, { active: 'all' });
  if (!id) return null;
  return <>{data?.find((n) => n.id === id)?.fullName ?? ''}</>;
}

/** Full name of an item id. */
export function ItemLabel({ id }: { id: ID | null | undefined }) {
  const map = useItemsById();
  if (!id) return null;
  return <>{map.get(id)?.fullName ?? ''}</>;
}

/** Name of a simple list entry (initials for sales reps). */
export function ListEntryLabel({ list, id }: { list: ListName; id: ID | null | undefined }) {
  const { data } = useList(list, { active: 'all' });
  if (!id) return null;
  const e = data?.find((x) => x.id === id);
  if (!e) return null;
  return <>{list === 'sales_rep' ? (e.data?.initials as string) || e.name : e.fullName || e.name}</>;
}
