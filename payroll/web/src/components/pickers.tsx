// List pickers (ComboBox + data hooks): SerieX Books accounts, vendors, classes and jobs (through
// the payroll API), employees, payroll items, pay schedules, states and pay frequencies.
// Same behavior as the SerieX Books pickers:
//
// Quick create: typing a name that is not in the list offers '+ Add "<text>"', which opens
// a small quick create popover (accounts: name and type; vendors: name), creates the record in
// SerieX Books (POST /books/accounts, POST /books/vendors), selects it and announces it with
// notifyCreated(). "Add with details…" and "+ Add new" open the full New Account / New Vendor
// dialog. On the payroll item, pay schedule and employee pickers "+ Add new" opens the matching
// edit window with openWindow(); that window announces the new record with the window event
// "sx-created" ({kind, id}) — call notifyCreated() after a successful POST — and the picker that
// asked for it selects the new record. With `quickCreate={false}` a message box asks instead
// ("Add Name Only / Add with Details / Cancel").
//
// Context: accounts show their type and balance, items their type, schedules their frequency;
// recently picked entries (per company and picker kind) are listed first when the field is empty.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '@/api/client';
import {
  queryClient,
  useBooksAccounts,
  useBooksAccountsById,
  useBooksClasses,
  useBooksJobs,
  useBooksVendors,
  useEmployees,
  useItems,
  useItemsById,
  useMeta,
  usePaySchedules,
} from '@/api/hooks';
import {
  FREQUENCY_LABELS,
  ITEM_TYPE_LABELS,
  ITEM_TYPE_ORDER,
  type BooksAccount,
  type BooksListEntry,
  type BooksName,
  type Employee,
  type Frequency,
  type Id,
  type ItemType,
  type NewBooksAccount,
  type NewBooksVendor,
  type PayrollItem,
  type PaySchedule,
  type StateInfo,
} from '@/api/types';
import { openWindow, useWindowStore } from '@/windows/windowStore';
import { fmtMoney } from '@/util/format';
import { getRecentPicks, recordRecentPick } from '@/util/recent';
import { ComboBox, type ComboBoxProps, type ComboColumn } from './ComboBox';
import { useGridCell } from './Grid';
import { alertBox, msgBox, showDialog } from './dialogs';
import { Button } from './buttons';
import { Checkbox, Field, Select, TextField } from './inputs';
import { BOOKS_ACCOUNT_TYPES, QuickCreateAccount, QuickCreateVendor, newVendorRecord } from './quickCreate';
import { toast } from './toast';

// ---------------------------------------------------------------------------
// "sx-created" window event

/** Name of the window event dispatched by edit windows after creating a record. */
export const CREATED_EVENT = 'sx-created';

/** Kinds of records announced with "sx-created". */
export type CreatedKind = 'account' | 'vendor' | 'item' | 'employee' | 'pay_schedule';

/** Detail of the "sx-created" event. */
export interface CreatedDetail {
  kind: CreatedKind;
  id: Id;
}

/**
 * Announces a newly created record (call it in the payroll item wizard, pay schedule dialog and
 * employee dialog after a successful POST). A picker that opened the window through
 * "+ Add new" selects it.
 */
export function notifyCreated(detail: CreatedDetail): void {
  window.dispatchEvent(new CustomEvent<CreatedDetail>(CREATED_EVENT, { detail }));
}

let waitToken = 0;

/** Stops every pending "+ Add new" waiter (used before announcing a quick-created record). */
export function cancelCreatedWaiters(): void {
  waitToken++;
}

/** Options of {@link awaitCreated}. */
export interface AwaitCreatedOptions {
  /**
   * Window id of the edit window that was opened (openWindow's result): when that window closes
   * without announcing a record (Cancel), the waiter stops, so a record created later elsewhere is
   * not put in this field.
   */
  windowId?: string;
}

/**
 * Waits for the next "sx-created" event of a kind. Only the most recent waiter of the whole app
 * is served, so an abandoned Add New never selects a record in another field.
 * Returns a function that stops waiting.
 */
export function awaitCreated(kind: CreatedKind, onCreated: (id: Id) => void, opts: AwaitCreatedOptions = {}): () => void {
  const token = ++waitToken;
  let unsubscribe: (() => void) | null = null;
  let closeTimer: number | undefined;
  const handler = (e: Event) => {
    const d = (e as CustomEvent<CreatedDetail>).detail;
    if (!d || token !== waitToken) {
      stop();
      return;
    }
    if (d.kind !== kind) return;
    stop();
    onCreated(d.id);
  };
  const stop = () => {
    window.removeEventListener(CREATED_EVENT, handler);
    unsubscribe?.();
    unsubscribe = null;
    window.clearTimeout(closeTimer);
  };
  window.addEventListener(CREATED_EVENT, handler);
  if (opts.windowId) {
    const wid = opts.windowId;
    unsubscribe = useWindowStore.subscribe((st) => {
      if (st.windows.some((w) => w.id === wid)) return;
      unsubscribe?.();
      unsubscribe = null;
      // the window may announce the record right after closing: stop a moment later
      closeTimer = window.setTimeout(stop, 1500);
    });
  }
  return stop;
}

/**
 * "+ Add new" waiter of a picker (same as SerieX Books). In a Grid cell editor the waiter outlives
 * the editor (the edit window takes the focus, so the cell editor closes): the new record is still
 * put in that cell, and the cell is activated again.
 */
function useCreatedWaiter() {
  const stop = useRef<(() => void) | null>(null);
  const cell = useGridCell();
  const cellRef = useRef(cell);
  cellRef.current = cell;
  useEffect(
    () => () => {
      // a grid cell editor unmounts while the edit window is open: keep waiting (see above)
      if (!cellRef.current) stop.current?.();
    },
    [],
  );
  return (kind: CreatedKind, cb: (id: Id) => void | Promise<void>, windowId?: string) => {
    stop.current?.();
    const gridCell = cellRef.current;
    stop.current = awaitCreated(
      kind,
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

/** Re-activates the grid cell a picker edits after a dialog took the focus away (no-op outside a Grid). */
function useCellRefocus() {
  const cell = useGridCell();
  const cellRef = useRef(cell);
  cellRef.current = cell;
  return () => {
    const c = cellRef.current;
    if (c) setTimeout(() => c.activate(), 0);
  };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const cancelled = (e: unknown) => e instanceof ApiError && e.code === 'cancelled';

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
 * Props shared by every record picker. Other ComboBox props (width, inGrid, autoFocus, name...)
 * pass through; `name` is also the key of the field's inline error (FormErrorsProvider).
 */
export interface PickerBaseProps<R> extends PassThrough {
  /** Selected record id. */
  value: Id | null | undefined;
  /** Called with the new id (null when cleared) and the record. */
  onChange: (id: Id | null, record: R | null) => void;
  /** Allow creating records from the picker: "+ Add new", quick create, details (default depends on the picker). */
  addNew?: boolean;
  /** Quick create popover for unknown text (accounts and vendors; default true when addNew). */
  quickCreate?: boolean;
  /** List recently picked entries first when the field is empty (default true). */
  showRecent?: boolean;
  /** Extra filter applied to the records. */
  filter?: (r: R) => boolean;
}

const idOf = (r: { id: Id }) => r.id;
const inactiveOf = (r: { active: boolean }) => !r.active;

/** Recent-pick list of a picker kind, refreshed when the value changes. */
function useRecent(kind: string, enabled: boolean, value: unknown): Id[] | undefined {
  return useMemo(() => (enabled ? (getRecentPicks(kind) as Id[]) : undefined), [kind, enabled, value]); // eslint-disable-line react-hooks/exhaustive-deps
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

/** SerieX Books balance sheet account types (their balance is shown in the Balance column). */
export const BALANCE_SHEET_TYPES = [
  'Bank',
  'Accounts Receivable',
  'Other Current Asset',
  'Fixed Asset',
  'Other Asset',
  'Accounts Payable',
  'Credit Card',
  'Other Current Liability',
  'Long Term Liability',
  'Equity',
];

export { BOOKS_ACCOUNT_TYPES };

// ---------------------------------------------------------------------------
// New Account dialog ("Add with details": creates the account in SerieX Books)

function NewAccountForm({ types, name, initialType, onDone }: { types?: string[]; name?: string; initialType?: string; onDone(a: BooksAccount | null): void }) {
  const allowed = BOOKS_ACCOUNT_TYPES.filter((t) => !types || types.includes(t));
  const first = initialType && allowed.includes(initialType) ? initialType : allowed.includes('Expense') ? 'Expense' : allowed[0];
  const [acc, setAcc] = useState<NewBooksAccount>({ name: name ?? '', type: first, parentId: null, number: '' });
  const [sub, setSub] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setErr('');
    if (!acc.name.trim()) {
      setErr('Enter a name for the account.');
      return;
    }
    if (sub && !acc.parentId) {
      setErr('Select the parent account, or clear "Subaccount of".');
      return;
    }
    setBusy(true);
    try {
      const created = await api.post<BooksAccount>('/books/accounts', { ...acc, name: acc.name.trim(), parentId: sub ? acc.parentId : null });
      await queryClient.invalidateQueries({ queryKey: ['books', 'accounts'] });
      toast(`Account "${created.fullName || created.name}" created in SerieX Books`);
      onDone(created);
    } catch (e) {
      if (!cancelled(e)) setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="sxp-newrec"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="sxp-newrec-note">The account is created in the SerieX Books chart of accounts.</div>
      <div className="sxp-newrec-grid">
        <Field label="Account type">
          <Select id="sxp-na-type" value={acc.type} onChange={(v) => setAcc({ ...acc, type: v, parentId: null })} disabled={allowed.length === 1} options={allowed.map((t) => ({ value: t, label: t }))} />
        </Field>
        <Field label="Number" width={140}>
          <TextField id="sxp-na-number" value={acc.number} onChange={(v) => setAcc({ ...acc, number: v })} />
        </Field>
      </div>
      <Field label="Account name" required>
        <TextField id="sxp-na-name" value={acc.name} onChange={(v) => setAcc({ ...acc, name: v })} autoFocus />
      </Field>
      <div className="sxp-newrec-sub">
        <Checkbox checked={sub} onChange={setSub} label="Subaccount of" />
        <AccountPicker
          value={acc.parentId}
          onChange={(id) => {
            setAcc({ ...acc, parentId: id });
            if (id) setSub(true);
          }}
          types={[acc.type]}
          addNew={false}
          showRecent={false}
          disabled={!sub}
          aria-label="Subaccount of"
        />
      </div>
      {err && <div className="sxp-error">{err}</div>}
      <div className="sx-dlg-buttons">
        <Button label="Cancel" disabled={busy} onClick={() => onDone(null)} />
        <Button type="submit" label="&Save and close" variant="primary" busy={busy} />
      </div>
    </form>
  );
}

/** Shows the New Account dialog; resolves with the account created in SerieX Books, or null. */
export function newBooksAccount(opts: { types?: string[]; name?: string; type?: string } = {}): Promise<BooksAccount | null> {
  return showDialog<BooksAccount | null>({
    title: 'New Account',
    width: 500,
    cancelValue: null,
    render: (close) => <NewAccountForm types={opts.types} name={opts.name} initialType={opts.type} onDone={close} />,
  });
}

// ---------------------------------------------------------------------------
// New Vendor dialog ("Add with details": creates the vendor in SerieX Books)

function NewVendorForm({ name, onDone }: { name?: string; onDone(v: BooksName | null): void }) {
  const [v, setV] = useState<NewBooksVendor>(() => newVendorRecord(name ?? ''));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const addr = (p: Partial<NewBooksVendor['address']>) => setV({ ...v, address: { ...v.address, ...p } });
  const save = async () => {
    setErr('');
    if (!v.name.trim()) {
      setErr('Enter a name for the vendor.');
      return;
    }
    setBusy(true);
    try {
      const created = await api.post<BooksName>('/books/vendors', { ...v, name: v.name.trim() });
      await queryClient.invalidateQueries({ queryKey: ['books', 'vendors'] });
      toast(`Vendor "${created.name}" created in SerieX Books`);
      onDone(created);
    } catch (e) {
      if (!cancelled(e)) setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="sxp-newrec"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="sxp-newrec-note">The vendor (tax agency or benefit provider) is created in the SerieX Books vendor list.</div>
      <Field label="Vendor name" required>
        <TextField id="sxp-nv-name" value={v.name} onChange={(x) => setV({ ...v, name: x })} autoFocus />
      </Field>
      <Field label="Company name">
        <TextField id="sxp-nv-company" value={v.companyName} onChange={(x) => setV({ ...v, companyName: x })} />
      </Field>
      <Field label="Address">
        <TextField id="sxp-nv-a1" value={v.address.line1} onChange={(x) => addr({ line1: x })} />
      </Field>
      <TextField aria-label="Address line 2" value={v.address.line2} onChange={(x) => addr({ line2: x })} />
      <div className="sxp-newrec-grid sxp-newrec-city">
        <Field label="City">
          <TextField id="sxp-nv-city" value={v.address.city} onChange={(x) => addr({ city: x })} />
        </Field>
        <Field label="State" width={64}>
          <TextField aria-label="State" value={v.address.state} onChange={(x) => addr({ state: x.toUpperCase().slice(0, 2) })} />
        </Field>
        <Field label="ZIP" width={100}>
          <TextField aria-label="ZIP" value={v.address.zip} onChange={(x) => addr({ zip: x })} />
        </Field>
      </div>
      <div className="sxp-newrec-grid">
        <Field label="Phone">
          <TextField id="sxp-nv-phone" value={v.phone} onChange={(x) => setV({ ...v, phone: x })} />
        </Field>
        <Field label="Account no.">
          <TextField id="sxp-nv-acct" value={v.accountNumber} onChange={(x) => setV({ ...v, accountNumber: x })} />
        </Field>
      </div>
      {err && <div className="sxp-error">{err}</div>}
      <div className="sx-dlg-buttons">
        <Button label="Cancel" disabled={busy} onClick={() => onDone(null)} />
        <Button type="submit" label="&Save and close" variant="primary" busy={busy} />
      </div>
    </form>
  );
}

/** Shows the New Vendor dialog; resolves with the vendor created in SerieX Books, or null. */
export function newBooksVendor(opts: { name?: string } = {}): Promise<BooksName | null> {
  return showDialog<BooksName | null>({
    title: 'New Vendor',
    width: 500,
    cancelValue: null,
    render: (close) => <NewVendorForm name={opts.name} onDone={close} />,
  });
}

// ---------------------------------------------------------------------------
// AccountPicker

/** Props of {@link AccountPicker}. */
export interface AccountPickerProps extends PickerBaseProps<BooksAccount> {
  /** Only these SerieX Books account types ("Bank", "Expense", "Other Current Liability"...). */
  types?: string[];
  /** Hide these accounts. */
  excludeIds?: Id[];
  /** Show the Balance column for balance sheet accounts (default true). */
  showBalance?: boolean;
  /** Hide the Type column. */
  hideType?: boolean;
}

/** SerieX Books account drop-down (chart of accounts tree, type + balance columns, quick create, Add New → New Account dialog). */
export function AccountPicker({ types, excludeIds, filter, showBalance = true, hideType, addNew = true, quickCreate, showRecent = true, value, onChange, ...rest }: AccountPickerProps) {
  const { data } = useBooksAccounts();
  const quick = useQuick();
  const recent = useRecent('account', showRecent, value);
  const pick = (id: Id | null, a: BooksAccount | null) => {
    if (id !== null) recordRecentPick('account', id);
    onChange(id, a);
  };
  const items = useMemo(
    () => (data ?? []).filter((a) => (!types || types.includes(a.type)) && (!excludeIds || !excludeIds.includes(a.id)) && (!filter || filter(a))),
    [data, types, excludeIds, filter],
  );
  const columns = useMemo(() => {
    const c: ComboColumn<BooksAccount>[] = [];
    if (!hideType) c.push({ width: 150, render: (a) => a.type, className: 'sx-muted', label: 'Type' });
    if (showBalance) c.push({ width: 96, align: 'right', render: (a) => (BALANCE_SHEET_TYPES.includes(a.type) ? fmtMoney(a.balance) : ''), label: 'Balance' });
    return c;
  }, [hideType, showBalance]);

  const refocusCell = useCellRefocus();
  const setUp = async (typed: string, type?: string) => {
    const a = await newBooksAccount({ types, name: typed || undefined, type });
    if (a) pick(a.id, a);
    refocusCell();
  };
  const useQuickCreate = addNew && quickCreate !== false;

  return (
    <>
      <ComboBox<BooksAccount>
        {...rest}
        items={items}
        value={value}
        onChange={(k, a) => pick(k as Id | null, a)}
        getKey={idOf}
        getLabel={(a) => a.fullName || a.name}
        getListLabel={(a) => a.name}
        getLevel={(a) => a.level}
        getSearchText={(a) => a.number}
        isInactive={inactiveOf}
        columns={columns}
        recentKeys={recent}
        listWidth={rest.listWidth ?? 220 + columns.reduce((s, c) => s + c.width, 0)}
        onAddNew={addNew ? (t) => void setUp(t) : undefined}
        onQuickAdd={useQuickCreate ? quick.open : undefined}
        onAddWithDetails={useQuickCreate ? (t) => void setUp(t) : undefined}
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
                  if (r === 'Add with Details') await setUp(typed);
                }
              : undefined
        }
      />
      {quick.qc && (
        <QuickCreateAccount
          anchor={quick.qc.anchor}
          initialName={quick.qc.typed}
          types={types}
          onCancel={() => {
            const a = quick.qc?.anchor ?? null;
            quick.close();
            quick.refocus(a);
          }}
          onDetails={(name, type) => {
            quick.close();
            void setUp(name, type);
          }}
          onCreated={(acc) => {
            const a = quick.qc?.anchor ?? null;
            quick.close();
            cancelCreatedWaiters();
            notifyCreated({ kind: 'account', id: acc.id });
            pick(acc.id, acc);
            quick.refocus(a);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// VendorPicker

/** SerieX Books vendor drop-down (tax agencies, benefit providers; quick create, Add New → New Vendor dialog). */
export function VendorPicker({ filter, addNew = true, quickCreate, showRecent = true, value, onChange, ...rest }: PickerBaseProps<BooksName>) {
  const { data } = useBooksVendors();
  const quick = useQuick();
  const recent = useRecent('vendor', showRecent, value);
  const pick = (id: Id | null, v: BooksName | null) => {
    if (id !== null) recordRecentPick('vendor', id);
    onChange(id, v);
  };
  const items = useMemo(() => (data ?? []).filter((n) => !filter || filter(n)), [data, filter]);
  const refocusCell = useCellRefocus();
  const setUp = async (typed: string) => {
    const v = await newBooksVendor({ name: typed || undefined });
    if (v) pick(v.id, v);
    refocusCell();
  };
  const quickAdd = async (typed: string) => {
    try {
      const created = await api.post<BooksName>('/books/vendors', newVendorRecord(typed));
      await queryClient.invalidateQueries({ queryKey: ['books', 'vendors'] });
      pick(created.id, created);
    } catch (e) {
      if (!cancelled(e)) await alertBox(errText(e), 'Warning');
    }
  };
  const useQuickCreate = addNew && quickCreate !== false;
  return (
    <>
      <ComboBox<BooksName>
        {...rest}
        items={items}
        value={value}
        onChange={(k, n) => pick(k as Id | null, n)}
        getKey={idOf}
        getLabel={(n) => n.fullName || n.name}
        getListLabel={(n) => n.name}
        getLevel={(n) => n.level}
        isInactive={inactiveOf}
        recentKeys={recent}
        listWidth={rest.listWidth ?? 260}
        onAddNew={addNew ? (t) => void setUp(t) : undefined}
        onQuickAdd={useQuickCreate ? quick.open : undefined}
        onAddWithDetails={useQuickCreate ? (t) => void setUp(t) : undefined}
        onNotFound={
          useQuickCreate
            ? undefined
            : addNew
              ? async (typed) => {
                  const r = await msgBox({
                    title: 'New Vendor',
                    message: `"${typed}" is not in your vendor list yet. Add it with just the name, or open the full form to add details.`,
                    buttons: ['&Add Name Only', 'Add with &Details', 'Cancel'],
                    icon: 'question',
                  });
                  if (r === 'Add Name Only') await quickAdd(typed);
                  else if (r === 'Add with Details') await setUp(typed);
                }
              : undefined
        }
      />
      {quick.qc && (
        <QuickCreateVendor
          anchor={quick.qc.anchor}
          initialName={quick.qc.typed}
          onCancel={() => {
            const a = quick.qc?.anchor ?? null;
            quick.close();
            quick.refocus(a);
          }}
          onDetails={(name) => {
            quick.close();
            void setUp(name);
          }}
          onCreated={(ven) => {
            const a = quick.qc?.anchor ?? null;
            quick.close();
            cancelCreatedWaiters();
            notifyCreated({ kind: 'vendor', id: ven.id });
            pick(ven.id, ven);
            quick.refocus(a);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// ClassPicker / JobPicker (SerieX Books lists, read only)

/** SerieX Books class drop-down (hierarchical). Classes are added in SerieX Books. */
export function ClassPicker({ filter, addNew: _addNew, quickCreate: _q, showRecent = true, value, onChange, ...rest }: PickerBaseProps<BooksListEntry>) {
  const { data } = useBooksClasses();
  const recent = useRecent('class', showRecent, value);
  const items = useMemo(() => (data ?? []).filter((c) => !filter || filter(c)), [data, filter]);
  return (
    <ComboBox<BooksListEntry>
      {...rest}
      items={items}
      value={value}
      onChange={(k, c) => {
        if (k !== null) recordRecentPick('class', k);
        onChange(k as Id | null, c);
      }}
      getKey={idOf}
      getLabel={(c) => c.fullName || c.name}
      getListLabel={(c) => c.name}
      getLevel={(c) => c.level}
      isInactive={inactiveOf}
      recentKeys={recent}
      listWidth={rest.listWidth ?? 200}
    />
  );
}

/** SerieX Books Customer:Job drop-down (customers with their jobs indented). Customers are added in SerieX Books. */
export function JobPicker({ filter, addNew: _addNew, quickCreate: _q, showRecent = true, value, onChange, ...rest }: PickerBaseProps<BooksName>) {
  const { data } = useBooksJobs();
  const recent = useRecent('job', showRecent, value);
  const items = useMemo(() => (data ?? []).filter((n) => !filter || filter(n)), [data, filter]);
  return (
    <ComboBox<BooksName>
      {...rest}
      items={items}
      value={value}
      onChange={(k, n) => {
        if (k !== null) recordRecentPick('job', k);
        onChange(k as Id | null, n);
      }}
      getKey={idOf}
      getLabel={(n) => n.fullName || n.name}
      getListLabel={(n) => n.name}
      getLevel={(n) => n.level}
      isInactive={inactiveOf}
      recentKeys={recent}
      columns={[{ width: 70, render: (n) => (n.level > 0 ? 'Job' : 'Customer'), className: 'sx-muted', label: 'Type' }]}
      listWidth={rest.listWidth ?? 290}
    />
  );
}

// ---------------------------------------------------------------------------
// EmployeePicker

/** Employee drop-down (display names; "+ Add new" → New Employee window when `addNew`). */
export function EmployeePicker({ filter, addNew = false, quickCreate: _q, showRecent = true, value, onChange, ...rest }: PickerBaseProps<Employee>) {
  const { data } = useEmployees({ active: 'all' });
  const wait = useCreatedWaiter();
  const recent = useRecent('employee', showRecent, value);
  const pick = (id: Id | null, e: Employee | null) => {
    if (id !== null) recordRecentPick('employee', id);
    onChange(id, e);
  };
  const items = useMemo(() => (data ?? []).filter((e) => !filter || filter(e)), [data, filter]);
  const setUp = () => {
    const wid = openWindow('employeeEdit', {});
    wait(
      'employee',
      async (id) => {
        await queryClient.invalidateQueries({ queryKey: ['employees'] });
        const e = await api.get<Employee>(`/employees/${id}`).catch(() => null);
        pick(id, e);
      },
      wid,
    );
  };
  return (
    <ComboBox<Employee>
      {...rest}
      items={items}
      value={value}
      onChange={(k, e) => pick(k as Id | null, e)}
      getKey={idOf}
      getLabel={(e) => e.displayName}
      getSearchText={(e) => `${e.firstName} ${e.lastName} ${e.employeeNumber}`}
      isInactive={inactiveOf}
      recentKeys={recent}
      listWidth={rest.listWidth ?? 240}
      onAddNew={addNew ? setUp : undefined}
      onNotFound={
        addNew
          ? async (typed) => {
              const r = await msgBox({
                title: 'New Employee',
                message: `"${typed}" is not in your employee list yet. Add it now?`,
                buttons: ['Add with &Details', 'Cancel'],
                icon: 'question',
              });
              if (r === 'Add with Details') setUp();
            }
          : undefined
      }
    />
  );
}

// ---------------------------------------------------------------------------
// PayrollItemPicker

/** Props of {@link PayrollItemPicker}. */
export interface PayrollItemPickerProps extends PickerBaseProps<PayrollItem> {
  /** Only these item types. */
  types?: ItemType[];
  excludeTypes?: ItemType[];
  /** Hide the Type column. */
  hideType?: boolean;
}

/** Payroll item drop-down (sorted by type then name, Type column, "+ Add new" → payroll item wizard). */
export function PayrollItemPicker({ types, excludeTypes, hideType, filter, addNew = true, quickCreate: _q, showRecent = true, value, onChange, ...rest }: PayrollItemPickerProps) {
  const { data } = useItems({ active: 'all' });
  const wait = useCreatedWaiter();
  const recent = useRecent('item', showRecent, value);
  const pick = (id: Id | null, i: PayrollItem | null) => {
    if (id !== null) recordRecentPick('item', id);
    onChange(id, i);
  };
  const items = useMemo(() => {
    const rank = (t: ItemType) => ITEM_TYPE_ORDER.indexOf(t);
    return (data ?? [])
      .filter((i) => (!types || types.includes(i.type)) && (!excludeTypes || !excludeTypes.includes(i.type)) && (!filter || filter(i)))
      .sort((a, b) => rank(a.type) - rank(b.type) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [data, types, excludeTypes, filter]);
  const columns = useMemo<ComboColumn<PayrollItem>[]>(
    () => (hideType ? [] : [{ width: 150, render: (i) => ITEM_TYPE_LABELS[i.type] ?? i.type, className: 'sx-muted', label: 'Type' }]),
    [hideType],
  );
  const setUp = () => {
    const wid = openWindow('payrollItemEdit', { type: types?.length === 1 ? types[0] : undefined });
    wait(
      'item',
      async (id) => {
        await queryClient.invalidateQueries({ queryKey: ['items'] });
        const it = await api.get<PayrollItem>(`/items/${id}`).catch(() => null);
        pick(id, it);
      },
      wid,
    );
  };
  return (
    <ComboBox<PayrollItem>
      {...rest}
      items={items}
      value={value}
      onChange={(k, i) => pick(k as Id | null, i)}
      getKey={idOf}
      getLabel={(i) => i.name}
      isInactive={inactiveOf}
      columns={columns}
      recentKeys={recent}
      listWidth={rest.listWidth ?? (hideType ? 230 : 390)}
      onAddNew={addNew ? setUp : undefined}
      onNotFound={
        addNew
          ? async (typed) => {
              const r = await msgBox({
                title: 'New Payroll Item',
                message: `"${typed}" is not in your payroll item list yet. Add it now?`,
                buttons: ['Add with &Details', 'Cancel'],
                icon: 'question',
              });
              if (r === 'Add with Details') setUp();
            }
          : undefined
      }
    />
  );
}

// ---------------------------------------------------------------------------
// PaySchedulePicker

/** Pay schedule drop-down (Frequency column; "+ Add new" → New Pay Schedule dialog). */
export function PaySchedulePicker({ filter, addNew = true, quickCreate: _q, showRecent = false, value, onChange, ...rest }: PickerBaseProps<PaySchedule>) {
  const { data } = usePaySchedules({ active: 'all' });
  const wait = useCreatedWaiter();
  const recent = useRecent('pay_schedule', showRecent, value);
  const items = useMemo(() => (data ?? []).filter((s) => !filter || filter(s)), [data, filter]);
  const setUp = () => {
    const wid = openWindow('payScheduleEdit', {});
    wait(
      'pay_schedule',
      async (id) => {
        await queryClient.invalidateQueries({ queryKey: ['pay-schedules'] });
        const s = await api.get<PaySchedule>(`/pay-schedules/${id}`).catch(() => null);
        onChange(id, s);
      },
      wid,
    );
  };
  return (
    <ComboBox<PaySchedule>
      {...rest}
      items={items}
      value={value}
      onChange={(k, s) => {
        if (k !== null) recordRecentPick('pay_schedule', k);
        onChange(k as Id | null, s);
      }}
      getKey={idOf}
      getLabel={(s) => s.name}
      isInactive={inactiveOf}
      recentKeys={recent}
      columns={[{ width: 100, render: (s) => FREQUENCY_LABELS[s.frequency] ?? s.frequency, className: 'sx-muted', label: 'Frequency' }]}
      listWidth={rest.listWidth ?? 290}
      onAddNew={addNew ? setUp : undefined}
    />
  );
}

// ---------------------------------------------------------------------------
// StatePicker / FrequencyPicker (fixed lists)

type FixedPassThrough = Omit<PassThrough, 'fallbackLabel'>;

/** Props of {@link StatePicker}. */
export interface StatePickerProps extends FixedPassThrough {
  /** Two-letter state code ("CA"), or "" / null for none. */
  value: string | null | undefined;
  onChange: (code: string | null, state: StateInfo | null) => void;
  /** Only these state codes. */
  codes?: string[];
  /** Hide the state name column. */
  hideName?: boolean;
}

/** State drop-down (50 states + DC from GET /api/meta; shows the code, name column; auto-complete on code or name). */
export function StatePicker({ value, onChange, codes, hideName, ...rest }: StatePickerProps) {
  const { data } = useMeta();
  const items = useMemo(() => (data?.states ?? []).filter((s) => !codes || codes.includes(s.code)).sort((a, b) => a.code.localeCompare(b.code)), [data, codes]);
  return (
    <ComboBox<StateInfo>
      {...rest}
      items={items}
      value={value || null}
      onChange={(k, s) => onChange(k === null ? null : String(k), s)}
      getKey={(s) => s.code}
      getLabel={(s) => s.code}
      getSearchText={(s) => s.name}
      columns={hideName ? [] : [{ width: 150, render: (s) => s.name, className: 'sx-muted' }]}
      fallbackLabel={value ?? undefined}
      listWidth={rest.listWidth ?? (hideName ? 80 : 220)}
    />
  );
}

/** Props of {@link FrequencyPicker}. */
export interface FrequencyPickerProps extends FixedPassThrough {
  value: Frequency | null | undefined;
  onChange: (frequency: Frequency | null) => void;
  /** Only these frequencies (default all). */
  frequencies?: Frequency[];
}

const FREQUENCIES: Frequency[] = ['weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'semiannually', 'annually', 'daily'];

/** Pay frequency drop-down (Weekly, Biweekly, Semimonthly...). */
export function FrequencyPicker({ value, onChange, frequencies, ...rest }: FrequencyPickerProps) {
  const items = useMemo(() => FREQUENCIES.filter((f) => !frequencies || frequencies.includes(f)), [frequencies]);
  return (
    <ComboBox<Frequency>
      {...rest}
      items={items}
      value={value || null}
      onChange={(k) => onChange(k === null ? null : (k as Frequency))}
      getKey={(f) => f}
      getLabel={(f) => FREQUENCY_LABELS[f]}
      listWidth={rest.listWidth ?? 150}
    />
  );
}

// ---------------------------------------------------------------------------
// Read-only labels (grid cells that are not being edited, summaries)

/** Full name of a SerieX Books account id. */
export function AccountLabel({ id }: { id: Id | null | undefined }) {
  const map = useBooksAccountsById();
  if (!id) return null;
  const a = map.get(id);
  return a ? <>{a.fullName || a.name}</> : null;
}

/** Name of a SerieX Books vendor id. */
export function VendorLabel({ id }: { id: Id | null | undefined }) {
  const { data } = useBooksVendors();
  if (!id) return null;
  const v = data?.find((n) => n.id === id);
  return v ? <>{v.fullName || v.name}</> : null;
}

/** Full name of a SerieX Books class id. */
export function ClassLabel({ id }: { id: Id | null | undefined }) {
  const { data } = useBooksClasses();
  if (!id) return null;
  const c = data?.find((x) => x.id === id);
  return c ? <>{c.fullName || c.name}</> : null;
}

/** "Customer:Job" of a SerieX Books customer/job id. */
export function JobLabel({ id }: { id: Id | null | undefined }) {
  const { data } = useBooksJobs();
  if (!id) return null;
  const j = data?.find((x) => x.id === id);
  return j ? <>{j.fullName || j.name}</> : null;
}

/** Display name of an employee id. */
export function EmployeeLabel({ id }: { id: Id | null | undefined }) {
  const { data } = useEmployees({ active: 'all' });
  if (!id) return null;
  const e = data?.find((x) => x.id === id);
  return e ? <>{e.displayName}</> : null;
}

/** Name of a payroll item id. */
export function PayrollItemLabel({ id }: { id: Id | null | undefined }) {
  const map = useItemsById();
  if (!id) return null;
  return <>{map.get(id)?.name ?? ''}</>;
}
