// New / Edit Item dialog with one layout per item type:
//   Service / Non-inventory Part / Other Charge: one block (description, rate, taxable, account) or,
//     with "used in assemblies / bought for a job / reimbursable" checked, Purchase information
//     (description, cost, expense account, preferred vendor) next to Sales information.
//   Inventory Part: purchase + sales information and Inventory information (asset account, reorder
//     point min/max, on hand, average cost, on P.O.; new: on hand, total value, as of).
//   Subtotal, Group (member grid), Discount (amount or %, account, before tax), Payment (method,
//     group with undeposited funds / deposit to), Sales Tax Item (rate, agency), Sales Tax Group
//     (member tax items with rates and the group rate).
// props: id (edit), type / name (prefill from pickers), copyOf (Duplicate Item).
// A save sends the item's updatedAt as it was opened: when someone else changed it since, the
// server refuses and the dialog offers to reload the latest version (useStaleCopy).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { api, ApiError } from '@/api/client';
import { invalidateAll, useAccounts, useItems, useItemsById, useNames, usePrefValues } from '@/api/hooks';
import { ITEM_TYPES, type Account, type ID, type Item, type ItemType } from '@/api/types';
import {
  AccountPicker,
  Checkbox,
  DateField,
  defaultExpenseAccount,
  defaultIncomeAccount,
  EditDialog,
  Field,
  Grid,
  ItemLabel,
  ItemPicker,
  MoneyField,
  NamePicker,
  newItemRecord,
  notifyCreated,
  NumberField,
  PaymentMethodPicker,
  RadioGroup,
  SegmentedControl,
  Select,
  Spinner,
  TextArea,
  TextField,
  toast,
  useFormErrors,
  type GridColumn,
} from '@/components';
import { todayIso } from '@/util/dates';
import { fmtMoney, fmtPercent, fmtQty, round2 } from '@/util/format';
import { openWindow } from '@/windows/windowStore';
import { useWindow } from '@/windows/WindowContext';
import { descendantIds, focusLater, snapshotOf, useStaleCopy } from './common';
import './lists.css';

export interface ItemEditDialogProps {
  id?: number;
  type?: ItemType;
  /** Name typed in a picker ("Add with details…"). */
  name?: string;
  /** Duplicate Item: copy this item into a new one. */
  copyOf?: number;
}

const TYPE_TEXT: Record<ItemType, string> = {
  Service: 'Services you charge for or buy, like labor, consulting hours or professional fees.',
  'Inventory Part': 'Goods you buy, keep in stock and resell. SerieX Books tracks the quantity on hand and the average cost.',
  'Non-inventory Part': "Goods you buy but don't track in stock, like supplies you resell or materials bought for a specific job.",
  'Other Charge': 'Miscellaneous charges such as delivery, setup fees or service charges. A fixed amount or a percentage.',
  Subtotal: 'Adds up the lines above it on a sales form, so you can apply a percentage discount to several lines.',
  Group: 'A set of items you often sell together. Adding the group to a form adds every item in it.',
  Discount: 'Subtracts an amount or a percentage from the line above it (or from a subtotal).',
  Payment: 'Records a payment received at the time of sale on an invoice, which lowers the balance due.',
  'Sales Tax Item': 'One sales tax rate you collect for a tax agency (for example a state, county or city tax).',
  'Sales Tax Group': 'Several sales tax items charged together. Customers see one combined rate.',
};

const PURCHASE_BOX: Partial<Record<ItemType, string>> = {
  Service: 'I also buy this service (for example from a subcontractor)',
  'Non-inventory Part': 'I also buy this item (for example for a customer or job)',
  'Other Charge': 'I also pay this charge (for example a cost I pass on to customers)',
};

const HAS_PARENT: ItemType[] = ['Service', 'Inventory Part', 'Non-inventory Part', 'Other Charge', 'Discount'];

const blankOpening = (): Opening => ({ qty: null, value: null, date: todayIso() });

/** What the dialog compares to tell whether the user changed anything. */
function itemSnapshot(rec: Item, isSub: boolean, members: Member[], opening: Opening, isNew: boolean): string {
  return snapshotOf({ rec, isSub, members, opening: isNew && rec.type === 'Inventory Part' ? opening : null });
}

interface Member {
  itemId: ID | null;
  qty: number | null;
}

interface Opening {
  qty: number | null;
  value: number | null;
  date: string;
}

function blankItem(type: ItemType, name: string): Item {
  return {
    ...(newItemRecord(type, name) as Item),
    fullName: '',
    level: 0,
    qtyOnHand: 0,
    avgCost: 0,
    assetValue: 0,
    qtyOnPo: 0,
    hasTxns: false,
  };
}

/** Fills the default accounts of a new item for its type. */
function withDefaults(r: Item, accts: readonly Account[]): Item {
  const out = { ...r };
  const special = (s: string) => accts.find((a) => a.special === s)?.id ?? null;
  switch (r.type) {
    case 'Service':
    case 'Non-inventory Part':
    case 'Other Charge':
      out.incomeAccountId ??= defaultIncomeAccount(accts, r.type)?.id ?? null;
      out.expenseAccountId ??= defaultExpenseAccount(accts, r.type)?.id ?? null;
      break;
    case 'Inventory Part':
      out.incomeAccountId ??= defaultIncomeAccount(accts, r.type)?.id ?? null;
      out.expenseAccountId ??= special('CostOfGoodsSold');
      out.assetAccountId ??= special('InventoryAsset');
      break;
    case 'Discount':
      out.incomeAccountId ??=
        accts.find((a) => a.active && /discount/i.test(a.name) && (a.type === 'Income' || a.type === 'Expense' || a.type === 'Other Income'))?.id ??
        defaultIncomeAccount(accts)?.id ??
        null;
      break;
  }
  return out;
}

/** Section box with a caption. */
function Section({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="fl-section">
      <div className="fl-section-title">
        {title}
        {note && <span className="fl-note">{note}</span>}
      </div>
      {children}
    </div>
  );
}

/** "Amount or %" control: a money/percent field with a $ | % switch. */
function AmountOrPercent({ value, percent, onChange, name, label }: { value: number; percent: boolean; onChange: (v: number, pct: boolean) => void; name: string; label: string }) {
  return (
    <div className="fl-amtpct">
      <SegmentedControl<'amt' | 'pct'>
        size="sm"
        value={percent ? 'pct' : 'amt'}
        onChange={(v) => onChange(value, v === 'pct')}
        options={[
          { value: 'amt', label: '$', title: 'Fixed amount' },
          { value: 'pct', label: '%', title: 'Percentage of the line above' },
        ]}
        aria-label={`${label}: amount or percent`}
      />
      <div className="fl-amtpct-input">
        {percent ? (
          <NumberField name={name} value={value} nullable={false} decimals={4} suffix="%" onChange={(v) => onChange(v ?? 0, true)} aria-label={`${label} (percent)`} />
        ) : (
          <MoneyField name={name} value={value} onChange={(v) => onChange(v ?? 0, false)} aria-label={`${label} (amount)`} />
        )}
      </div>
    </div>
  );
}

export default function ItemEditDialog(props: ItemEditDialogProps) {
  const win = useWindow();
  const prefs = usePrefValues();
  const fe = useFormErrors();
  const { data: accounts } = useAccounts({ active: 'all' });
  const { data: allItems } = useItems({ active: 'all' });
  const itemsById = useItemsById();
  const { data: vendors } = useNames('vendor', { active: 'all' });
  const [isNew, setIsNew] = useState(!props.id);
  const [rec, setRec] = useState<Item | null>(() => (props.id || props.copyOf ? null : blankItem(props.type ?? 'Service', props.name ?? '')));
  const [isSub, setIsSub] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [opening, setOpening] = useState<Opening>(blankOpening);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [originalName, setOriginalName] = useState('');
  const [defaultsFor, setDefaultsFor] = useState<string>('');
  /** The record as it was opened (with its default accounts); null until it is ready. */
  const [baseline, setBaseline] = useState<string | null>(null);
  /** Version of the item when it was opened: the server refuses the save when someone changed it since. */
  const [loadedUpdatedAt, setLoadedUpdatedAt] = useState<string | undefined>(undefined);

  /** Shows an item being edited as stored (and remembers the version it was opened at). */
  const loadItem = (it: Item) => {
    setRec(it);
    setLoadedUpdatedAt(it.updatedAt);
    setOriginalName(it.fullName);
    setDefaultsFor(it.type);
    setIsSub(it.parentId !== null);
    setMembers(it.groupLines.map((g) => ({ itemId: g.itemId, qty: g.qty })));
  };

  // load the item being edited (or copied)
  useEffect(() => {
    const src = props.id ?? props.copyOf;
    if (!src) return;
    let off = false;
    api
      .get<Item>(`/items/${src}`)
      .then((it) => {
        if (off) return;
        if (props.id) {
          loadItem(it);
          return;
        }
        setRec({ ...it, id: 0, name: `${it.name} (copy)`, hasTxns: false, qtyOnHand: 0, avgCost: 0, assetValue: 0, qtyOnPo: 0, active: true, updatedAt: undefined });
        setDefaultsFor(it.type);
        setIsSub(it.parentId !== null);
        setMembers(it.groupLines.map((g) => ({ itemId: g.itemId, qty: g.qty })));
      })
      .catch((e) => !off && setLoadError((e as Error).message));
    return () => {
      off = true;
    };
  }, [props.id, props.copyOf]); // eslint-disable-line react-hooks/exhaustive-deps

  // someone else saved the item after it was opened: load their version (false: it is gone)
  const stale = useStaleCopy(fe, 'item', async () => {
    try {
      const it = await api.get<Item>(`/items/${props.id}`);
      loadItem(it);
      setBaseline(null); // taken again from the loaded item
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
      setLoadError(`${e.message} It may have been deleted.`);
      return false;
    }
  });

  // default accounts of a new item (once per type, after the accounts are loaded)
  useEffect(() => {
    if (!rec || !accounts || defaultsFor === rec.type) return;
    setRec(withDefaults(rec, accounts));
    setDefaultsFor(rec.type);
  }, [isNew, rec, accounts, defaultsFor]);

  // unsaved changes: compared with the record as it was opened, once its default accounts are in
  // (a new item counts as changed as soon as it has a name, even one typed in a picker)
  const ready = !!rec && defaultsFor === rec.type;
  useEffect(() => {
    if (!rec || !ready || baseline !== null) return;
    const start = isNew && !props.copyOf ? { ...rec, name: '' } : rec;
    setBaseline(itemSnapshot(start, isSub, members, opening, isNew));
  }, [ready, baseline]); // eslint-disable-line react-hooks/exhaustive-deps
  // EditDialog marks the window changed and asks "Do you want to save your changes?" on close
  const dirty = !!rec && baseline !== null && itemSnapshot(rec, isSub, members, opening, isNew) !== baseline;

  const set = (patch: Partial<Item>) => setRec((r) => (r ? { ...r, ...patch } : r));

  const excluded = useMemo(() => (rec?.id ? descendantIds(allItems ?? [], rec.id) : new Set<ID>()), [allItems, rec?.id]);

  if (loadError) {
    return (
      <EditDialog title="Edit Item" onOk={() => win.close(true)} okLabel="Close">
        <div className="fl-info">
          <Info size={16} />
          <span>The item could not be loaded: {loadError}</span>
        </div>
      </EditDialog>
    );
  }
  if (!rec) {
    return (
      <div className="fl-page" style={{ alignItems: 'center', justifyContent: 'center', background: '#fff' }}>
        <Spinner label="Loading item…" />
      </div>
    );
  }

  const r = rec;
  const t = r.type;
  const purchaseBox = PURCHASE_BOX[t];
  const twoSided = t === 'Inventory Part' || (!!purchaseBox && r.isPurchased);
  const isGroup = t === 'Group' || t === 'Sales Tax Group';
  const taxOn = prefs.salesTaxEnabled;

  const changeType = (nt: ItemType) => {
    const next = blankItem(nt, r.name);
    next.id = r.id;
    next.description = r.description;
    next.active = r.active;
    next.hasTxns = r.hasTxns;
    setRec(next);
    setDefaultsFor('');
    setIsSub(false);
    setMembers([]);
    fe.clearAll();
  };

  // ---- save
  const save = async (): Promise<Item | null> => {
    fe.clearAll();
    const name = r.name.trim();
    const problems: Record<string, string> = {};
    if (!name) problems.name = 'Enter a name for the item.';
    else if (name.includes(':')) problems.name = 'An item name cannot contain a colon (:). Use "Subitem of" to put it under another item.';
    if (isSub && !r.parentId) problems.parentId = 'Choose the item this one goes under, or clear "Subitem of".';
    const parent = isSub && HAS_PARENT.includes(t) ? r.parentId : null;
    const sameName = name ? (allItems ?? []).find((i) => i.id !== r.id && i.parentId === parent && i.name.toLowerCase() === name.toLowerCase()) : undefined;
    if (sameName && !problems.name) problems.name = `There is already an item named "${sameName.fullName}"${sameName.active ? '' : ' (inactive)'}. Use a different name.`;
    const needsIncome = ['Service', 'Non-inventory Part', 'Other Charge', 'Inventory Part', 'Discount'].includes(t);
    if (needsIncome && !r.incomeAccountId) problems.incomeAccountId = t === 'Discount' ? 'Choose the account that tracks this discount.' : 'Choose the income account for this item.';
    if (twoSided && t !== 'Inventory Part' && !r.expenseAccountId) problems.expenseAccountId = 'Choose the expense account for the purchase information.';
    if (t === 'Sales Tax Item') {
      if (!r.taxAgencyId) problems.taxAgencyId = 'Choose the tax agency (vendor) you pay this tax to.';
      if (r.taxRate < 0 || r.taxRate > 100) problems.taxRate = 'Enter a rate between 0 and 100 percent.';
    }
    const groupLines = members.filter((m) => m.itemId !== null);
    if (isGroup && !groupLines.length) problems.groupLines = t === 'Sales Tax Group' ? 'Add at least one sales tax item to the group.' : 'Add at least one item to the group.';
    if (r.rateIsPercent && (r.salesPrice < -100 || r.salesPrice > 100)) problems.salesPrice = 'A percentage must be between -100 and 100.';
    if (Object.keys(problems).length) {
      fe.setErrors(problems);
      return null;
    }
    const body: Record<string, unknown> = {
      ...r,
      name,
      parentId: isSub && HAS_PARENT.includes(t) ? r.parentId : null,
      groupLines: isGroup ? groupLines.map((m) => ({ itemId: m.itemId, itemName: '', qty: t === 'Sales Tax Group' ? 1 : m.qty ?? 1 })) : [],
      // edit: the version it was opened at (also after a type change, which starts a fresh record)
      updatedAt: isNew ? undefined : loadedUpdatedAt,
    };
    if (isNew && t === 'Inventory Part' && opening.qty) {
      body.openingQty = opening.qty;
      if (opening.value !== null) body.openingValue = opening.value;
      body.openingDate = opening.date || todayIso();
    }
    try {
      const saved = isNew ? await api.post<Item>('/items', body) : await api.put<Item>(`/items/${r.id}`, body);
      await invalidateAll();
      if (isNew) notifyCreated({ kind: 'item', id: saved.id });
      toast(isNew ? `Item "${saved.fullName}" created` : `Item "${saved.fullName}" saved`);
      return saved;
    } catch (e) {
      if (!(await stale.handle(e))) fe.fromError(e, { nameField: 'name' });
      return null;
    }
  };

  // ---- shared field blocks
  const nameRow = (
    <div className="fl-grid" style={{ gridTemplateColumns: t === 'Inventory Part' || t === 'Non-inventory Part' ? 'minmax(0, 1.1fr) minmax(0, 1fr) 150px' : HAS_PARENT.includes(t) ? 'minmax(0, 1fr) minmax(0, 1fr)' : 'minmax(0, 1fr)' }}>
      <Field label={t === 'Group' || t === 'Sales Tax Group' ? 'Group name' : t === 'Sales Tax Item' ? 'Sales tax name' : t === 'Payment' ? 'Payment name' : 'Item name/number'} required>
        <TextField name="name" value={r.name} onChange={(v) => set({ name: v })} autoFocus aria-label="Item name" maxLength={100} />
      </Field>
      {HAS_PARENT.includes(t) && (
        <div className="sx-field">
          <div className="fl-fieldlabel">
            <Checkbox
              checked={isSub}
              onChange={(v) => {
                setIsSub(v);
                if (!v) set({ parentId: null });
              }}
              label="Subitem of"
            />
          </div>
          <ItemPicker
            name="parentId"
            aria-label="Parent item"
            types={[t]}
            filter={(i) => !excluded.has(i.id)}
            addNew={false}
            showRecent={false}
            compact
            disabled={!isSub}
            value={isSub ? r.parentId : null}
            onChange={(id) => set({ parentId: id })}
          />
        </div>
      )}
      {(t === 'Inventory Part' || t === 'Non-inventory Part') && (
        <Field label="Manufacturer's part no.">
          <TextField name="mpn" value={r.mpn} onChange={(v) => set({ mpn: v })} aria-label="Manufacturer's part number" />
        </Field>
      )}
    </div>
  );

  const incomePicker = (label = 'Income account') => (
    <Field label={label} required help="The income account the sale of this item is recorded in.">
      <AccountPicker
        name="incomeAccountId"
        aria-label={label}
        excludeTypes={['Accounts Receivable', 'Accounts Payable', 'Non-Posting', 'Bank', 'Credit Card']}
        value={r.incomeAccountId}
        onChange={(id) => set({ incomeAccountId: id })}
      />
    </Field>
  );

  // `stacked`: one field per row (three-column inventory layout); else price/cost next to the account
  const salesBlock = (priceLabel: string, single: boolean, stacked = false) => {
    const price = (
      <Field label={priceLabel}>
        {t === 'Other Charge' ? (
          <AmountOrPercent name="salesPrice" label={priceLabel} value={r.salesPrice} percent={r.rateIsPercent} onChange={(v, pct) => set({ salesPrice: v, rateIsPercent: pct })} />
        ) : (
          <MoneyField name="salesPrice" value={r.salesPrice} onChange={(v) => set({ salesPrice: v ?? 0 })} aria-label={priceLabel} />
        )}
      </Field>
    );
    return (
      <>
        <Field label={single || stacked ? 'Description' : 'Description on sales transactions'}>
          <TextArea name="description" value={r.description} onChange={(v) => set({ description: v })} rows={2} aria-label="Sales description" />
        </Field>
        {stacked ? (
          <>
            {price}
            {incomePicker('Income account')}
          </>
        ) : (
          <div className="fl-grid" style={{ gridTemplateColumns: t === 'Other Charge' ? '170px minmax(0, 1fr)' : '120px minmax(0, 1fr)' }}>
            {price}
            {incomePicker(single ? 'Account' : 'Income account')}
          </div>
        )}
        {taxOn && <Checkbox name="taxable" checked={r.taxable} onChange={(v) => set({ taxable: v })} label={stacked ? 'Taxable' : 'Taxable (charge sales tax on this item)'} />}
      </>
    );
  };

  const purchaseBlock = (stacked = false) => {
    const cost = (
      <Field label="Cost">
        <MoneyField name="cost" value={r.cost} onChange={(v) => set({ cost: v ?? 0 })} aria-label="Cost" />
      </Field>
    );
    const acct = (
      <Field label={t === 'Inventory Part' ? 'COGS account' : 'Expense account'} required={t !== 'Inventory Part'} help={t === 'Inventory Part' ? 'Cost of goods sold' : undefined}>
        <AccountPicker
          name="expenseAccountId"
          aria-label={t === 'Inventory Part' ? 'COGS account' : 'Expense account'}
          excludeTypes={['Accounts Receivable', 'Accounts Payable', 'Non-Posting', 'Bank', 'Credit Card']}
          value={r.expenseAccountId}
          onChange={(id) => set({ expenseAccountId: id })}
        />
      </Field>
    );
    return (
      <>
        <Field label={stacked ? 'Description' : 'Description on purchase transactions'}>
          <TextArea name="purchaseDescription" value={r.purchaseDescription} onChange={(v) => set({ purchaseDescription: v })} rows={2} aria-label="Purchase description" />
        </Field>
        {stacked ? (
          <>
            {cost}
            {acct}
          </>
        ) : (
          <div className="fl-grid" style={{ gridTemplateColumns: '120px minmax(0, 1fr)' }}>
            {cost}
            {acct}
          </div>
        )}
        <Field label="Preferred vendor">
          <NamePicker name="preferredVendorId" kinds={['vendor']} aria-label="Preferred vendor" value={r.preferredVendorId} onChange={(id) => set({ preferredVendorId: id })} />
        </Field>
      </>
    );
  };

  // ---- group grids
  const memberCols: GridColumn<Member>[] =
    t === 'Sales Tax Group'
      ? [
          {
            key: 'itemId',
            label: 'Tax item',
            width: 170,
            editor: (p) => (
              <ItemPicker inGrid autoFocus types={['Sales Tax Item']} aria-label="Tax item" value={p.value as ID | null} onChange={(id) => p.onRowChange({ itemId: id, qty: 1 })} />
            ),
            render: (m) => <ItemLabel id={m.itemId} />,
          },
          { key: 'rate', label: 'Rate', width: 70, align: 'right', render: (m) => (m.itemId ? fmtPercent(itemsById.get(m.itemId)?.taxRate ?? 0) : '') },
          { key: 'agency', label: 'Tax agency', width: 150, render: (m) => (m.itemId ? vendors?.find((v) => v.id === itemsById.get(m.itemId!)?.taxAgencyId)?.name ?? '' : '') },
          { key: 'desc', label: 'Description', grow: true, width: 150, render: (m) => (m.itemId ? itemsById.get(m.itemId)?.description ?? '' : '') },
        ]
      : [
          {
            key: 'itemId',
            label: 'Item',
            width: 200,
            editor: (p) => (
              <ItemPicker
                inGrid
                autoFocus
                excludeTypes={['Group', 'Sales Tax Group']}
                filter={(i) => i.id !== r.id}
                aria-label="Item"
                value={p.value as ID | null}
                onChange={(id) => p.onRowChange({ itemId: id, qty: p.row.qty ?? 1 })}
              />
            ),
            render: (m) => <ItemLabel id={m.itemId} />,
          },
          { key: 'desc', label: 'Description', grow: true, width: 200, render: (m) => (m.itemId ? itemsById.get(m.itemId)?.description ?? '' : '') },
          { key: 'qty', label: 'Qty', width: 70, align: 'right', editor: 'qty', render: (m) => fmtQty(m.qty) },
        ];
  const groupRate = round2(members.reduce((s, m) => s + (m.itemId ? itemsById.get(m.itemId)?.taxRate ?? 0 : 0), 0) * 100) / 100;
  const groupTotal = round2(members.reduce((s, m) => s + (m.itemId ? (itemsById.get(m.itemId)?.salesPrice ?? 0) * (m.qty ?? 0) : 0), 0));

  // ---- body per type
  let body: ReactNode;
  switch (t) {
    case 'Service':
    case 'Non-inventory Part':
    case 'Other Charge': {
      const priceLabel = t === 'Service' ? 'Rate' : t === 'Other Charge' ? 'Amount or %' : 'Price';
      body = (
        <>
          {nameRow}
          <Checkbox checked={r.isPurchased} onChange={(v) => set({ isPurchased: v })} label={purchaseBox} />
          {r.isPurchased ? (
            <div className="fl-grid fl-g2">
              <Section title="Purchase information">{purchaseBlock()}</Section>
              <Section title="Sales information">{salesBlock(t === 'Other Charge' ? 'Amount or %' : 'Sales price', false)}</Section>
            </div>
          ) : (
            salesBlock(priceLabel, true)
          )}
        </>
      );
      break;
    }
    case 'Inventory Part':
      body = (
        <>
          {nameRow}
          <div className="fl-grid fl-g3">
            <Section title="Purchase information">{purchaseBlock(true)}</Section>
            <Section title="Sales information">{salesBlock('Sales price', false, true)}</Section>
            <Section title="Inventory information">
              <Field label="Asset account" help="The Other Current Asset account that holds the value of this item in stock (usually Inventory Asset).">
                <AccountPicker name="assetAccountId" aria-label="Asset account" types={['Other Current Asset']} value={r.assetAccountId} onChange={(id) => set({ assetAccountId: id })} />
              </Field>
              <div className="fl-grid" style={{ gridTemplateColumns: 'minmax(0, 1.25fr) minmax(0, 0.75fr)' }}>
                <Field label="Reorder point" help="When the quantity on hand drops to this number, SerieX Books reminds you to reorder.">
                  <NumberField name="reorderPoint" value={r.reorderPoint} onChange={(v) => set({ reorderPoint: v })} aria-label="Reorder point (min)" />
                </Field>
                <Field label="Max">
                  <NumberField name="maxQty" value={r.maxQty} onChange={(v) => set({ maxQty: v })} aria-label="Maximum quantity" />
                </Field>
              </div>
              {isNew ? (
                <>
                  <div className="fl-grid fl-g2">
                    <Field label="On hand" help="How many you have in stock today. Leave it empty to start at zero and record purchases as they happen.">
                      <NumberField name="openingQty" value={opening.qty} onChange={(v) => setOpening((o) => ({ ...o, qty: v }))} aria-label="Quantity on hand" />
                    </Field>
                    <Field label="Total value" help="What the quantity on hand cost you in total. Leave it empty to use quantity × cost.">
                      <MoneyField
                        name="openingValue"
                        nullable
                        value={opening.value}
                        placeholder={opening.qty ? fmtMoney(round2((opening.qty ?? 0) * r.cost)) : ''}
                        onChange={(v) => setOpening((o) => ({ ...o, value: v }))}
                        aria-label="Total value"
                      />
                    </Field>
                  </div>
                  <Field label="As of">
                    <DateField name="openingDate" value={opening.date} onChange={(v) => setOpening((o) => ({ ...o, date: v }))} aria-label="As of date" />
                  </Field>
                </>
              ) : (
                <>
                  <div className="fl-grid fl-g2">
                    <Field label="On hand">
                      <div className="fl-readout">{fmtQty(r.qtyOnHand)}</div>
                    </Field>
                    <Field label="Avg. cost" help="Average cost">
                      <div className="fl-readout">{fmtMoney(r.avgCost)}</div>
                    </Field>
                  </div>
                  <div className="fl-grid fl-g2">
                    <Field label="Total value">
                      <div className="fl-readout">{fmtMoney(r.assetValue)}</div>
                    </Field>
                    <Field label="On P.O.">
                      <div className="fl-readout">{fmtQty(r.qtyOnPo)}</div>
                    </Field>
                  </div>
                  <button
                    type="button"
                    className="fl-linkbtn"
                    onClick={() => {
                      openWindow('inventoryAdjust', { itemId: r.id });
                      void win.close(true);
                    }}
                  >
                    Adjust quantity/value on hand…
                  </button>
                </>
              )}
            </Section>
          </div>
        </>
      );
      break;
    case 'Subtotal':
      body = (
        <>
          {nameRow}
          <Field label="Description">
            <TextArea name="description" value={r.description} onChange={(v) => set({ description: v })} rows={2} aria-label="Description" />
          </Field>
        </>
      );
      break;
    case 'Group':
    case 'Sales Tax Group':
      body = (
        <>
          {nameRow}
          <Field label="Description" hint={t === 'Sales Tax Group' ? 'Printed on sales forms next to the tax amount.' : undefined}>
            <TextField name="description" value={r.description} onChange={(v) => set({ description: v })} aria-label="Description" />
          </Field>
          <div className="fl-note">
            {t === 'Sales Tax Group'
              ? 'Enter each sales tax item in this group. SerieX Books charges their combined rate and keeps track of each one separately for its agency.'
              : 'Enter the items in this group and the quantity of each. Adding the group to an invoice or sales receipt adds every item in it.'}
          </div>
          <div className="fl-membergrid" data-field="groupLines" style={t === 'Sales Tax Group' ? { height: 150 } : undefined}>
            <Grid<Member>
              aria-label={t === 'Sales Tax Group' ? 'Tax items in the group' : 'Items in the group'}
              columns={memberCols}
              rows={members}
              onChange={(rows) => {
                setMembers(rows);
                fe.clear('groupLines');
              }}
              newRow={() => ({ itemId: null, qty: null })}
              minRows={4}
              persistKey={t === 'Sales Tax Group' ? 'fl-taxgroup' : 'fl-group'}
            />
          </div>
          {fe.errors.groupLines && <div className="sx-field-msg">{fe.errors.groupLines}</div>}
          <div className="fl-totalline">
            {t === 'Sales Tax Group' ? (
              <>
                <span>Group rate</span>
                <span>{fmtPercent(groupRate)}</span>
              </>
            ) : (
              <>
                <span className="fl-dim" style={{ fontWeight: 400 }}>
                  Total of the items at their sales prices
                </span>
                <span>{fmtMoney(groupTotal)}</span>
              </>
            )}
          </div>
        </>
      );
      break;
    case 'Discount':
      body = (
        <>
          {nameRow}
          <Field label="Description">
            <TextArea name="description" value={r.description} onChange={(v) => set({ description: v })} rows={2} aria-label="Description" />
          </Field>
          <div className="fl-grid fl-g2">
            <Field label="Amount or %" help="A fixed amount, or a percentage of the line right above the discount on the form (use a Subtotal item to discount several lines).">
              <AmountOrPercent name="salesPrice" label="Discount" value={r.salesPrice} percent={r.rateIsPercent} onChange={(v, pct) => set({ salesPrice: v, rateIsPercent: pct })} />
            </Field>
            <Field label="Account" required help="The account that tracks the discounts you give (usually an income account such as Sales Discounts).">
              <AccountPicker
                name="incomeAccountId"
                aria-label="Discount account"
                excludeTypes={['Accounts Receivable', 'Accounts Payable', 'Non-Posting', 'Bank', 'Credit Card']}
                value={r.incomeAccountId}
                onChange={(id) => set({ incomeAccountId: id })}
              />
            </Field>
          </div>
          {taxOn && <Checkbox name="taxable" checked={r.taxable} onChange={(v) => set({ taxable: v })} label="Apply the discount before sales tax (it lowers the taxable amount)" />}
        </>
      );
      break;
    case 'Payment':
      body = (
        <>
          {nameRow}
          <Field label="Description">
            <TextArea name="description" value={r.description} onChange={(v) => set({ description: v })} rows={2} aria-label="Description" />
          </Field>
          <Field label="Payment method" width={260}>
            <PaymentMethodPicker name="paymentMethodId" aria-label="Payment method" value={r.paymentMethodId} onChange={(id) => set({ paymentMethodId: id })} />
          </Field>
          <Section title="Where the money goes">
            <RadioGroup<'uf' | 'dep'>
              value={r.depositAccountId === null ? 'uf' : 'dep'}
              onChange={(v) => {
                if (v === 'uf') set({ depositAccountId: null });
                else {
                  const bank = accounts?.find((a) => a.type === 'Bank' && a.active);
                  set({ depositAccountId: r.depositAccountId ?? bank?.id ?? null });
                }
              }}
              options={[
                { value: 'uf', label: 'Group with other undeposited funds (deposit it later with Make Deposits)' },
                { value: 'dep', label: 'Deposit directly to:' },
              ]}
              aria-label="Deposit"
            />
            {r.depositAccountId !== null && (
              <div style={{ paddingLeft: 24, maxWidth: 360 }}>
                <AccountPicker
                  name="depositAccountId"
                  aria-label="Deposit to"
                  types={['Bank', 'Other Current Asset']}
                  value={r.depositAccountId}
                  onChange={(id) => set({ depositAccountId: id })}
                />
              </div>
            )}
          </Section>
        </>
      );
      break;
    case 'Sales Tax Item':
      body = (
        <>
          {nameRow}
          <Field label="Description" hint="Printed on sales forms next to the tax amount.">
            <TextField name="description" value={r.description} onChange={(v) => set({ description: v })} aria-label="Description" />
          </Field>
          <div className="fl-grid" style={{ gridTemplateColumns: '150px minmax(0, 1fr)' }}>
            <Field label="Tax rate (%)" required>
              <NumberField name="taxRate" value={r.taxRate} nullable={false} decimals={4} suffix="%" onChange={(v) => set({ taxRate: v ?? 0 })} aria-label="Tax rate" />
            </Field>
            <Field label="Tax agency (vendor that you collect for)" required>
              <NamePicker name="taxAgencyId" kinds={['vendor']} aria-label="Tax agency" value={r.taxAgencyId} onChange={(id) => set({ taxAgencyId: id })} />
            </Field>
          </div>
        </>
      );
      break;
  }

  const typeLocked = !isNew && r.hasTxns;
  const title = isNew ? (props.copyOf ? 'New Item (copy)' : 'New Item') : `Edit Item: ${originalName}`;

  return (
    <EditDialog
      title={title}
      errors={fe}
      dirty={dirty}
      okLabel="Save and close"
      onOk={async () => {
        if (!(await save())) return false;
        await win.close(true);
      }}
      onSaveNew={
        isNew
          ? async () => {
              const saved = await save();
              if (!saved) return;
              setIsNew(true);
              setRec(blankItem(t, ''));
              setDefaultsFor('');
              setIsSub(false);
              setMembers([]);
              setOpening(blankOpening());
              setBaseline(null);
              focusLater(win.id, 'name');
            }
          : undefined
      }
      footerLeft={!isNew ? <Checkbox checked={!r.active} onChange={(v) => set({ active: !v })} label="Item is inactive" /> : undefined}
      extraButtons={stale.button}
      top={
        <div className="fl-typehead">
          <label className="fl-typehead-label" htmlFor={`fl-itemtype-${win.id}`}>
            Type
          </label>
          <Select
            id={`fl-itemtype-${win.id}`}
            name="type"
            value={t}
            width={200}
            disabled={typeLocked}
            title={typeLocked ? 'The type of an item used in transactions cannot be changed.' : undefined}
            onChange={(v) => changeType(v as ItemType)}
            options={ITEM_TYPES.filter((x) => x === t || ((x !== 'Inventory Part' || prefs.inventoryEnabled) && ((x !== 'Sales Tax Item' && x !== 'Sales Tax Group') || prefs.salesTaxEnabled))).map((x) => ({ value: x, label: x }))}
            aria-label="Item type"
          />
          <div className="fl-typehead-desc">{TYPE_TEXT[t]}</div>
        </div>
      }
    >
      <div className="fl-form">{body}</div>
    </EditDialog>
  );
}
