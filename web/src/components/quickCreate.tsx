// Quick create popovers used by the pickers ('+ Add "<text>"'): a small panel next
// to the field that asks only the essentials, POSTs the record, and hands it back so the picker
// selects it. "Add with details…" switches to the full edit dialog.
//
//   names:    name, kind (when several are allowed), taxable (customers, default yes)
//   items:    name, type, sales price (or cost on purchase forms), income (or expense) account
//   accounts: name, type
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { api } from '@/api/client';
import { queryClient, useAccounts, useItems, useNames, usePrefValues } from '@/api/hooks';
import {
  ACCOUNT_TYPES,
  emptyAddress,
  type Account,
  type AccountType,
  type Item,
  type ItemType,
  type Name,
  type NameKind,
} from '@/api/types';
import { Button } from './buttons';
import { tabbables } from './focus';
import { SegmentedControl } from './display';
import { ErrorBanner, FormErrorsProvider, useFormErrors, type FormErrorsState } from './formErrors';
import { Checkbox, Field, MoneyField, Select, TextField } from './inputs';
import { Popup } from './Popup';
import { AccountPicker, activateRecord, confirmInactiveUse, noteInactiveUsedOnce } from './pickers';
import { useOptionalWindow } from '@/windows/WindowContext';

// ---------------------------------------------------------------------------
// Defaults

const ITEM_ACCOUNT_HINTS: Partial<Record<ItemType, RegExp>> = {
  Service: /servic|labor|consult|fee|install|design/i,
  'Inventory Part': /merchandise|product|sales|material|goods/i,
  'Non-inventory Part': /merchandise|product|material|sales|goods/i,
  'Other Charge': /shipping|delivery|freight|reimburs|fee|other/i,
};

const ITEM_EXPENSE_HINTS: Partial<Record<ItemType, RegExp>> = {
  Service: /subcontract|contract|labor|professional/i,
  'Non-inventory Part': /material|suppl|purchas|cost of goods/i,
  'Other Charge': /freight|shipping|postage|delivery/i,
};

/**
 * A sensible income account for a new item: an active Income account whose name fits the item
 * type ("Services" for a service, "Merchandise Sales" for parts...), else the first regular
 * Income account (not Uncategorized Income, not a discount account).
 */
export function defaultIncomeAccount(accounts: readonly Account[] | undefined, itemType?: ItemType): Account | undefined {
  const income = (accounts ?? []).filter((a) => a.type === 'Income' && a.active && a.special === '' && !/discount/i.test(a.name));
  const hint = itemType ? ITEM_ACCOUNT_HINTS[itemType] : undefined;
  return (hint && income.find((a) => hint.test(a.name))) || income[0] || (accounts ?? []).find((a) => a.type === 'Income' && a.active);
}

/** A sensible expense account for an item bought on purchase forms (Cost of Goods Sold / Expense). */
export function defaultExpenseAccount(accounts: readonly Account[] | undefined, itemType?: ItemType): Account | undefined {
  const list = (accounts ?? []).filter((a) => (a.type === 'Expense' || a.type === 'Cost of Goods Sold') && a.active);
  const hint = itemType ? ITEM_EXPENSE_HINTS[itemType] : undefined;
  return (
    (hint && list.find((a) => hint.test(a.name) && a.special === '')) ||
    list.find((a) => a.special === 'CostOfGoodsSold') ||
    list.find((a) => a.special === '' && a.type === 'Cost of Goods Sold') ||
    list.find((a) => a.special === '')
  );
}

/** A complete new name record (POST /names) with sensible defaults. */
export function newNameRecord(kind: NameKind, name: string, extra: Partial<Name> = {}): Partial<Name> {
  return {
    id: 0,
    kind,
    name,
    parentId: null,
    companyName: '',
    salutation: '',
    firstName: '',
    middleName: '',
    lastName: '',
    jobTitle: '',
    phone: '',
    altPhone: '',
    mobile: '',
    fax: '',
    email: '',
    ccEmail: '',
    website: '',
    billAddress: emptyAddress(),
    shipAddress: emptyAddress(),
    accountNumber: '',
    termsId: null,
    creditLimit: null,
    typeId: null,
    repId: null,
    paymentMethodId: null,
    taxable: kind === 'customer',
    taxItemId: null,
    resaleNumber: '',
    printOnCheckAs: name,
    taxIdent: '',
    is1099: false,
    prefillAccountIds: [],
    jobStatus: '',
    jobStartDate: '',
    jobProjectedEnd: '',
    jobEndDate: '',
    jobDescription: '',
    jobTypeId: null,
    notes: '',
    active: true,
    ...extra,
  };
}

/** A complete new item record (POST /items) with sensible defaults. */
export function newItemRecord(type: ItemType, name: string, extra: Partial<Item> = {}): Partial<Item> {
  return {
    id: 0,
    type,
    name,
    parentId: null,
    mpn: '',
    description: '',
    purchaseDescription: '',
    isPurchased: false,
    salesPrice: 0,
    rateIsPercent: false,
    cost: 0,
    incomeAccountId: null,
    expenseAccountId: null,
    assetAccountId: null,
    preferredVendorId: null,
    taxable: type === 'Inventory Part' || type === 'Non-inventory Part',
    reorderPoint: null,
    maxQty: null,
    taxRate: 0,
    taxAgencyId: null,
    paymentMethodId: null,
    depositAccountId: null,
    groupLines: [],
    active: true,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Shared panel

interface PanelProps {
  anchor: HTMLElement | null;
  title: string;
  width?: number;
  busy: boolean;
  fe: FormErrorsState;
  onCancel(): void;
  onSubmit(): void;
  onDetails?: () => void;
  children: ReactNode;
}

function QuickPanel({ anchor, title, width, busy, fe, onCancel, onSubmit, onDetails, children }: PanelProps) {
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const t = window.setTimeout(() => {
      const first = formRef.current?.querySelector<HTMLInputElement>('input[name="name"]');
      first?.focus();
      first?.select();
    }, 0);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <Popup anchor={anchor} open onClose={onCancel} keepFocus={false} className="sx-popup-quick">
      <FormErrorsProvider value={fe}>
        <form
          ref={formRef}
          className="sx-quick"
          style={width ? { width } : undefined}
          aria-label={title}
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) onSubmit();
          }}
          onKeyDown={(e) => {
            // The popover is a portal: without this, keys would bubble (through the React tree)
            // to the grid / dialog that owns the picker (Enter = next cell / OK, Tab = next cell).
            e.stopPropagation();
            if (e.key === 'Escape' && !e.defaultPrevented) {
              e.preventDefault();
              onCancel();
            } else if (e.key === 'Tab' && !e.defaultPrevented && formRef.current) {
              // keep Tab inside the popover
              const list = tabbables(formRef.current);
              const i = list.indexOf(document.activeElement as HTMLElement);
              if (list.length && (e.shiftKey ? i <= 0 : i === list.length - 1)) {
                e.preventDefault();
                list[e.shiftKey ? list.length - 1 : 0].focus();
              }
            }
          }}
        >
          <div className="sx-quick-head">
            <span className="sx-quick-title">{title}</span>
            <button type="button" className="sx-iconbtn" aria-label="Cancel" title="Cancel (Esc)" onClick={onCancel}>
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          {fe.message && <ErrorBanner message={fe.message} />}
          <div className="sx-quick-body">{children}</div>
          <div className="sx-quick-foot">
            {onDetails && (
              <button type="button" className="sx-linkbtn" onClick={onDetails}>
                Add with details&hellip;
              </button>
            )}
            <span className="sx-flex1" />
            <Button variant="ghost" label="Cancel" onClick={onCancel} />
            <Button variant="primary" type="submit" label="Save" busy={busy} title="Save (Enter)" />
          </div>
        </form>
      </FormErrorsProvider>
    </Popup>
  );
}

/** Runs the submit after pending field commits (a combo or money field committing on Enter/blur). */
function useLatest<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Names

const KIND_TITLE: Record<NameKind, string> = { customer: 'customer', vendor: 'vendor', other: 'name' };
const KIND_LABEL: Record<NameKind, string> = { customer: 'Customer', vendor: 'Vendor', other: 'Other' };

/** Props of {@link QuickCreateName}. */
export interface QuickCreateNameProps {
  anchor: HTMLElement | null;
  /** Text typed in the picker. */
  initialName: string;
  /** Kinds that may be created (a choice is shown when there are several). */
  kinds: NameKind[];
  /** Kind selected at first (e.g. 'vendor' for a check payee); default the first of `kinds`. */
  defaultKind?: NameKind;
  onCreated(name: Name): void;
  onCancel(): void;
  /** "Add with details…": opens the full dialog for this kind with the name. */
  onDetails?(name: string, kind: NameKind): void;
}

/** Quick create popover for customers / vendors / other names. */
export function QuickCreateName({ anchor, initialName, kinds, defaultKind, onCreated, onCancel, onDetails }: QuickCreateNameProps) {
  const win = useOptionalWindow();
  const prefs = usePrefValues();
  const { data: names } = useNames(undefined, { active: 'all' });
  const order: NameKind[] = (['customer', 'vendor', 'other'] as NameKind[]).filter((k) => kinds.includes(k));
  const [name, setName] = useState(initialName);
  const [kind, setKind] = useState<NameKind>(defaultKind && order.includes(defaultKind) ? defaultKind : order[0] ?? 'customer');
  const [taxable, setTaxable] = useState(true);
  const [busy, setBusy] = useState(false);
  const fe = useFormErrors();
  const st = useLatest({ name, kind, taxable });
  const submit = async () => {
    await tick();
    const s = st.current;
    if (!s.name.trim()) {
      fe.setFieldError('name', 'Enter a name.');
      return;
    }
    // an inactive name with this text: use it (made active again, or once) instead of a duplicate
    const lower = s.name.trim().toLowerCase();
    const old = (names ?? []).find((n) => !n.active && ((n.fullName || n.name).toLowerCase() === lower || (n.parentId === null && n.name.toLowerCase() === lower)));
    if (old) {
      if (await confirmInactiveUse(old.fullName || old.name, () => activateRecord('names', old.id), ['names'], () => noteInactiveUsedOnce(win?.id, 'names', old.id))) onCreated({ ...old, active: true });
      return;
    }
    setBusy(true);
    try {
      const created = await api.post<Name>('/names', newNameRecord(s.kind, s.name.trim(), { taxable: s.kind === 'customer' ? s.taxable : false }));
      await queryClient.invalidateQueries({ queryKey: ['names'] });
      onCreated(created);
    } catch (e) {
      // the server knows an inactive name with this text (not in the list here yet): offer it
      const d = (e as { data?: { existingId?: number; existingActive?: boolean } }).data;
      if (d?.existingId && d.existingActive === false) {
        setBusy(false);
        const id = d.existingId;
        if (await confirmInactiveUse(s.name.trim(), () => activateRecord('names', id), ['names'], () => noteInactiveUsedOnce(win?.id, 'names', id))) {
          const rec = await api.get<Name>(`/names/${id}`).catch(() => null);
          if (rec) onCreated(rec);
        }
        return;
      }
      fe.fromError(e);
      setBusy(false);
    }
  };
  return (
    <QuickPanel
      anchor={anchor}
      title={order.length === 1 ? `New ${KIND_TITLE[kind]}` : 'New name'}
      busy={busy}
      fe={fe}
      onCancel={onCancel}
      onSubmit={() => void submit()}
      onDetails={onDetails ? () => onDetails(name.trim(), kind) : undefined}
    >
      <Field label={kind === 'customer' ? 'Customer name' : kind === 'vendor' ? 'Vendor name' : 'Name'} required>
        <TextField name="name" value={name} onChange={setName} aria-label="Name" />
      </Field>
      {order.length > 1 && (
        <Field label="Type">
          <SegmentedControl<NameKind> size="sm" value={kind} onChange={setKind} options={order.map((k) => ({ value: k, label: KIND_LABEL[k] }))} aria-label="Name type" />
        </Field>
      )}
      {kind === 'customer' && prefs.salesTaxEnabled && <Checkbox checked={taxable} onChange={setTaxable} label="Charge sales tax to this customer" />}
    </QuickPanel>
  );
}

// ---------------------------------------------------------------------------
// Items

const QUICK_ITEM_TYPES: { value: ItemType; label: string }[] = [
  { value: 'Service', label: 'Service' },
  { value: 'Non-inventory Part', label: 'Non-inventory' },
  { value: 'Inventory Part', label: 'Inventory' },
  { value: 'Other Charge', label: 'Other charge' },
];

/** Props of {@link QuickCreateItem}. */
export interface QuickCreateItemProps {
  anchor: HTMLElement | null;
  initialName: string;
  /** Item types the picker accepts (types outside the quick list need the full dialog). */
  types?: ItemType[];
  /** Purchase forms: ask for the cost and an expense account instead of price and income account. */
  purchase?: boolean;
  onCreated(item: Item): void;
  onCancel(): void;
  onDetails?(name: string, type: ItemType): void;
}

/** Quick create popover for items: type, price (or cost) and account. */
export function QuickCreateItem({ anchor, initialName, types, purchase, onCreated, onCancel, onDetails }: QuickCreateItemProps) {
  const win = useOptionalWindow();
  const prefs = usePrefValues();
  const { data: accounts } = useAccounts({ active: 'all' });
  const { data: allItems } = useItems({ active: 'all' });
  const allowed = QUICK_ITEM_TYPES.filter((t) => (!types || types.includes(t.value)) && (t.value !== 'Inventory Part' || prefs.inventoryEnabled));
  const [name, setName] = useState(initialName);
  const [type, setType] = useState<ItemType>(allowed[0]?.value ?? 'Service');
  const [price, setPrice] = useState<number>(0);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const fe = useFormErrors();
  const usesExpense = purchase && type !== 'Inventory Part';
  // default account follows the type until the user picks one
  const suggested = usesExpense ? defaultExpenseAccount(accounts, type) : defaultIncomeAccount(accounts, type);
  const acct = touched ? accountId : suggested?.id ?? null;
  const st = useLatest({ name, type, price, acct, usesExpense });
  const submit = async () => {
    await tick();
    const s = st.current;
    if (!s.name.trim()) {
      fe.setFieldError('name', 'Enter a name.');
      return;
    }
    const lower = s.name.trim().toLowerCase();
    const old = (allItems ?? []).find((i) => !i.active && ((i.fullName || i.name).toLowerCase() === lower || (i.parentId === null && i.name.toLowerCase() === lower)));
    if (old) {
      if (await confirmInactiveUse(`The item ${old.fullName || old.name}`, () => activateRecord('items', old.id), ['items'], () => noteInactiveUsedOnce(win?.id, 'items', old.id))) onCreated({ ...old, active: true });
      return;
    }
    if (!s.acct) {
      fe.setFieldError(s.usesExpense ? 'expenseAccountId' : 'incomeAccountId', 'Choose an account.');
      return;
    }
    const income = s.usesExpense ? defaultIncomeAccount(accounts, s.type)?.id ?? null : s.acct;
    const rec = purchase
      ? newItemRecord(s.type, s.name.trim(), { cost: s.price, isPurchased: true, incomeAccountId: income, expenseAccountId: s.usesExpense ? s.acct : null })
      : newItemRecord(s.type, s.name.trim(), { salesPrice: s.price, incomeAccountId: s.acct });
    setBusy(true);
    try {
      const created = await api.post<Item>('/items', rec);
      await queryClient.invalidateQueries({ queryKey: ['items'] });
      onCreated(created);
    } catch (e) {
      fe.fromError(e);
      setBusy(false);
    }
  };
  return (
    <QuickPanel
      anchor={anchor}
      title="New product or service"
      width={allowed.length > 3 ? 410 : undefined}
      busy={busy}
      fe={fe}
      onCancel={onCancel}
      onSubmit={() => void submit()}
      onDetails={onDetails ? () => onDetails(name.trim(), type) : undefined}
    >
      <Field label="Name" required>
        <TextField name="name" value={name} onChange={setName} aria-label="Item name" />
      </Field>
      {allowed.length > 1 && (
        <Field label="Type" help={type === 'Service' ? 'Service' : type === 'Inventory Part' ? 'Inventory Part' : type === 'Other Charge' ? 'Other Charge' : 'Non-inventory Part'}>
          <SegmentedControl<ItemType> size="sm" value={type} onChange={setType} options={allowed} aria-label="Item type" block />
        </Field>
      )}
      <div className="sx-quick-row">
        <Field label={purchase ? 'Cost' : 'Sales price'} width={120}>
          <MoneyField name={purchase ? 'cost' : 'salesPrice'} value={price} onChange={(v) => setPrice(v ?? 0)} aria-label={purchase ? 'Cost' : 'Sales price'} />
        </Field>
        <Field label={usesExpense ? 'Expense account' : 'Income account'} required style={{ flex: 1, minWidth: 0 }}>
          <AccountPicker
            name={usesExpense ? 'expenseAccountId' : 'incomeAccountId'}
            types={usesExpense ? ['Expense', 'Cost of Goods Sold', 'Other Expense'] : ['Income', 'Other Income']}
            addNew={false}
            showRecent={false}
            showBalance={false}
            hideType
            value={acct}
            onChange={(id) => {
              setTouched(true);
              setAccountId(id);
            }}
            aria-label={usesExpense ? 'Expense account' : 'Income account'}
          />
        </Field>
      </div>
    </QuickPanel>
  );
}

// ---------------------------------------------------------------------------
// Accounts

/** Props of {@link QuickCreateAccount}. */
export interface QuickCreateAccountProps {
  anchor: HTMLElement | null;
  initialName: string;
  /** Account types the picker accepts. */
  types?: AccountType[];
  excludeTypes?: AccountType[];
  onCreated(account: Account): void;
  onCancel(): void;
  onDetails?(name: string, type: AccountType): void;
}

/** Quick create popover for accounts: name and type. */
export function QuickCreateAccount({ anchor, initialName, types, excludeTypes, onCreated, onCancel, onDetails }: QuickCreateAccountProps) {
  const win = useOptionalWindow();
  const { data: accounts } = useAccounts({ active: 'all' });
  const allowed = ACCOUNT_TYPES.filter(
    (t) => (!types || types.includes(t)) && (!excludeTypes || !excludeTypes.includes(t)) && t !== 'Accounts Receivable' && t !== 'Accounts Payable' && t !== 'Non-Posting',
  );
  const [name, setName] = useState(initialName);
  const [type, setType] = useState<AccountType>(allowed.includes('Expense') ? 'Expense' : allowed[0] ?? 'Expense');
  const [busy, setBusy] = useState(false);
  const fe = useFormErrors();
  const st = useLatest({ name, type });
  const submit = async () => {
    await tick();
    const s = st.current;
    if (!s.name.trim()) {
      fe.setFieldError('name', 'Enter a name.');
      return;
    }
    const lower = s.name.trim().toLowerCase();
    const old = (accounts ?? []).find((a) => !a.active && ((a.fullName || a.name).toLowerCase() === lower || (a.parentId === null && a.name.toLowerCase() === lower)));
    if (old) {
      if (await confirmInactiveUse(`The account ${old.fullName || old.name}`, () => activateRecord('accounts', old.id), ['accounts'], () => noteInactiveUsedOnce(win?.id, 'accounts', old.id))) onCreated({ ...old, active: true });
      return;
    }
    setBusy(true);
    try {
      const created = await api.post<Account>('/accounts', {
        id: 0,
        name: s.name.trim(),
        number: '',
        type: s.type,
        parentId: null,
        description: '',
        note: '',
        bankAcctNumber: '',
        routingNumber: '',
        taxLine: '',
        active: true,
      });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      onCreated(created);
    } catch (e) {
      fe.fromError(e);
      setBusy(false);
    }
  };
  return (
    <QuickPanel
      anchor={anchor}
      title="New account"
      busy={busy}
      fe={fe}
      onCancel={onCancel}
      onSubmit={() => void submit()}
      onDetails={onDetails ? () => onDetails(name.trim(), type) : undefined}
    >
      <Field label="Account name" required>
        <TextField name="name" value={name} onChange={setName} aria-label="Account name" />
      </Field>
      <Field label="Account type">
        <Select name="type" value={type} onChange={(v) => setType(v as AccountType)} options={allowed.map((t) => ({ value: t, label: t }))} aria-label="Account type" />
      </Field>
    </QuickPanel>
  );
}
