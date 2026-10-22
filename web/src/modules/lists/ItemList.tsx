// Item List (Lists > Item List; "Products & Services").
// Columns NAME (tree), DESCRIPTION, TYPE, ACCOUNT, TOTAL QUANTITY ON HAND, ON PURCHASE ORDER,
// PRICE with the bottom menus Item ▾, Activities ▾, Reports ▾; plus search, type filter chips,
// bulk select (make inactive / export) and hover actions. Double-click edits the item.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Package, Plus } from 'lucide-react';
import { api } from '@/api/client';
import { useAccountsById, useItems, usePrefValues } from '@/api/hooks';
import type { ID, Item, ItemType } from '@/api/types';
import { Button, Checkbox, DropdownButton, EmptyState, FilterChips, ListView, useHotkeys, type ListColumn, type MenuItem } from '@/components';
import { downloadCsv } from '@/util/csv';
import { fmtMoney, fmtPercent, fmtQty } from '@/util/format';
import { openWindow } from '@/windows/windowStore';
import {
  accountLabel,
  actionsColumn,
  deleteBlocker,
  deleteRecord,
  descendantIds,
  downloadExport,
  ListPage,
  ListSearchBox,
  matchesSearch,
  openItemActivity,
  openReport,
  plural,
  printList,
  runBulk,
  setRecordActive,
  useBulkSelect,
  useCreatedListener,
  useElementWidth,
  useRevealRow,
  useAutoSelect,
  useLocalState,
} from './common';

export interface ItemListProps {
  /** Item to select when the window opens. */
  selectId?: number;
}

const GROUPS: { key: string; label: string; types: ItemType[] }[] = [
  { key: 'service', label: 'Services', types: ['Service'] },
  { key: 'inventory', label: 'Inventory', types: ['Inventory Part'] },
  { key: 'noninv', label: 'Non-inventory', types: ['Non-inventory Part'] },
  { key: 'charge', label: 'Other charges', types: ['Other Charge'] },
  { key: 'other', label: 'Discounts & groups', types: ['Subtotal', 'Group', 'Discount', 'Payment'] },
  { key: 'tax', label: 'Sales tax', types: ['Sales Tax Item', 'Sales Tax Group'] },
];

/** Price column text (percent for percent rates and tax items, blank where nothing applies). */
function itemPriceText(i: Item): string {
  switch (i.type) {
    case 'Sales Tax Item':
    case 'Sales Tax Group':
      return fmtPercent(i.taxRate);
    case 'Subtotal':
    case 'Group':
    case 'Payment':
      return '';
    default:
      return i.rateIsPercent ? fmtPercent(i.salesPrice) : fmtMoney(i.salesPrice);
  }
}

export default function ItemList(props: ItemListProps) {
  const prefs = usePrefValues();
  const { data, isLoading, error, refetch } = useItems({ active: 'all' });
  const accounts = useAccountsById();
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useLocalState('sx.fl.items.inactive', false);
  const [flat, setFlat] = useLocalState('sx.fl.items.flat', false);
  const [selId, setSelId] = useState<ID | null>(props.selectId ?? null);
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(rootRef);

  useEffect(() => {
    if (props.selectId) {
      setSelId(props.selectId);
      reveal(props.selectId);
    }
  }, [props.selectId]); // eslint-disable-line react-hooks/exhaustive-deps
  useCreatedListener('item', (d) => {
    setSelId(d.id);
    setQ('');
    setGroup(null);
    reveal(d.id);
  });

  const all = data ?? [];
  const base = useMemo(() => (showInactive ? all : all.filter((i) => i.active)), [all, showInactive]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const g of GROUPS) c[g.key] = base.filter((i) => g.types.includes(i.type)).length;
    return c;
  }, [base]);
  // a type whose feature is off still gets its chip when the list has items of it (imported, or
  // made before the feature was turned off), and the chosen chip never disappears under the user
  const groups = useMemo(
    () => GROUPS.filter((g) => ((g.key !== 'inventory' || prefs.inventoryEnabled) && (g.key !== 'tax' || prefs.salesTaxEnabled)) || counts[g.key] > 0 || g.key === group),
    [prefs.inventoryEnabled, prefs.salesTaxEnabled, counts, group],
  );
  const searching = q.trim() !== '';
  const rows = useMemo(() => {
    const g = GROUPS.find((x) => x.key === group);
    return base.filter((i) => (!g || g.types.includes(i.type)) && (!searching || matchesSearch(q, i.fullName, i.description, i.purchaseDescription, i.mpn, i.type)));
  }, [base, group, q, searching]);
  const treeMode = !flat && !searching;

  const reveal = useRevealRow(rootRef, rows, (r) => r.id);
  const sel = rows.find((i) => i.id === selId) ?? null;
  useAutoSelect(rows, sel, (r) => setSelId(r.id), reveal.pending);

  const bulk = useBulkSelect<Item>(rows, (i) => i.id, (i) => i.fullName);

  // account names as the pickers and reports show them ("40000 · Landscaping Services" with account numbers on)
  const special = (key: string, fallback: string) => {
    const a = [...accounts.values()].find((x) => x.special === key);
    return a ? accountLabel(a, prefs) : fallback;
  };
  const salesTaxAccount = useMemo(() => special('SalesTaxPayable', 'Sales Tax Payable'), [accounts, prefs.useAccountNumbers]); // eslint-disable-line react-hooks/exhaustive-deps
  const undepositedAccount = useMemo(() => special('UndepositedFunds', 'Undeposited Funds'), [accounts, prefs.useAccountNumbers]); // eslint-disable-line react-hooks/exhaustive-deps
  const accountOf = (id: ID | null): string => {
    const a = id ? accounts.get(id) : undefined;
    return a ? accountLabel(a, prefs) : '';
  };
  const accountText = (i: Item): string => {
    switch (i.type) {
      case 'Payment':
        return i.depositAccountId ? accountOf(i.depositAccountId) : undepositedAccount;
      case 'Sales Tax Item':
      case 'Sales Tax Group':
        return salesTaxAccount;
      case 'Subtotal':
      case 'Group':
        return '';
      default:
        return accountOf(i.incomeAccountId);
    }
  };

  // ---- actions
  const newItem = (extra: Record<string, unknown> = {}) => openWindow('itemEdit', extra);
  const edit = (i: Item | null = sel) => i && openWindow('itemEdit', { id: i.id });
  const duplicate = (i: Item | null = sel) => i && openWindow('itemEdit', { copyOf: i.id, type: i.type });
  const del = (i: Item | null = sel) =>
    i &&
    deleteRecord({
      what: 'item',
      name: i.fullName,
      blocked: deleteBlocker('item', i.fullName, { children: descendantIds(all, i.id).size - 1, hasTxns: i.hasTxns, childWord: 'subitems' }),
      request: () => api.del(`/items/${i.id}`),
      makeInactive: () => api.put(`/items/${i.id}/active`, { active: false }),
    });
  const toggleActive = (i: Item | null = sel) =>
    i &&
    setRecordActive({
      what: 'item',
      name: i.fullName,
      active: !i.active,
      childCount: i.active ? descendantIds(all, i.id).size - 1 : 0,
      childWord: 'subitems',
      request: () => api.put(`/items/${i.id}/active`, { active: !i.active }),
    });
  const activityReport = (i: Item | null = sel) => i && openItemActivity(i.id, i.fullName);

  const print = () =>
    printList(
      'Item List',
      [{ label: 'Name' }, { label: 'Description' }, { label: 'Type' }, { label: 'Account' }, { label: 'On Hand', align: 'right' }, { label: 'Price', align: 'right' }],
      rows.map((i) => ({
        cells: [treeMode ? i.name : i.fullName, i.description, i.type, accountText(i), i.type === 'Inventory Part' ? fmtQty(i.qtyOnHand) : '', itemPriceText(i)],
        level: treeMode ? i.level : 0,
        inactive: !i.active,
      })),
    );
  const exportSelected = () => {
    const list = rows.filter((i) => bulk.selected.has(i.id));
    downloadCsv('items-selected', [
      ['Name', 'Type', 'Description', 'Account', 'Quantity On Hand', 'On Purchase Order', 'Price', 'Cost', 'Active'],
      ...list.map((i) => [i.fullName, i.type, i.description, accountText(i), i.type === 'Inventory Part' ? i.qtyOnHand : '', i.type === 'Inventory Part' ? i.qtyOnPo : '', itemPriceText(i), i.cost || '', i.active ? 'Yes' : 'No']),
    ]);
  };

  useHotkeys({
    'ctrl+e': () => (sel ? void edit() : false),
    'ctrl+d': () => (sel ? void del() : false),
    'ctrl+q': () => (sel ? void activityReport() : false),
  });

  // ---- menus
  const inv = sel?.type === 'Inventory Part';
  const itemMenu: MenuItem[] = [
    { label: '&New', onClick: () => newItem() },
    { label: '&Edit Item', shortcut: 'Ctrl+E', disabled: !sel, onClick: () => edit() },
    { label: 'D&uplicate Item', disabled: !sel, onClick: () => duplicate() },
    { label: '&Delete Item', shortcut: 'Ctrl+D', disabled: !sel, onClick: () => void del() },
    { label: sel && !sel.active ? 'Make Item &Active' : 'Make Item &Inactive', disabled: !sel, onClick: () => void toggleActive() },
    { separator: true },
    { label: 'Show Inacti&ve Items', checked: showInactive, onClick: () => setShowInactive(!showInactive) },
    { label: '&Hierarchical View', checked: !flat, onClick: () => setFlat(false) },
    { label: '&Flat View', checked: flat, onClick: () => setFlat(true) },
    { separator: true },
    { label: '&Print List...', onClick: () => void print() },
    { label: 'I&mport from CSV...', onClick: () => openWindow('importData', { entity: 'items' }) },
    { label: 'E&xport to CSV', onClick: () => void downloadExport('items') },
  ];
  const activitiesMenu: MenuItem[] = [
    { label: 'Create &Invoices', onClick: () => openWindow('invoice') },
    { label: 'Enter &Sales Receipts', onClick: () => openWindow('salesReceipt') },
    { label: 'Create &Purchase Orders', hidden: !prefs.purchaseOrdersEnabled, onClick: () => openWindow('purchaseOrder') },
    { label: '&Receive Items', hidden: !prefs.inventoryEnabled, onClick: () => openWindow('receiveItems') },
    { separator: true, hidden: !prefs.inventoryEnabled },
    { label: '&Adjust Inventory...', hidden: !prefs.inventoryEnabled, onClick: () => openWindow('inventoryAdjust', inv && sel ? { itemId: sel.id } : {}) },
  ];
  const reportsMenu: MenuItem[] = [
    { label: sel ? `&Activity Report: ${sel.name}` : '&Activity Report', shortcut: 'Ctrl+Q', disabled: !sel, onClick: () => activityReport() },
    { separator: true },
    { label: 'Item &Listing', onClick: () => openReport('item_listing') },
    { label: 'Item &Price List', onClick: () => openReport('item_price_list') },
    { label: 'Sales by &Item Summary', onClick: () => openReport('sales_by_item_summary') },
    { label: 'Purchases by Item Su&mmary', onClick: () => openReport('purchases_by_item_summary') },
    { separator: true, hidden: !prefs.inventoryEnabled },
    { label: 'Inventory &Valuation Summary', hidden: !prefs.inventoryEnabled, onClick: () => openReport('inventory_valuation_summary') },
    { label: 'Inventory &Stock Status by Item', hidden: !prefs.inventoryEnabled, onClick: () => openReport('inventory_stock_status_by_item') },
  ];
  const rowMenu = (i: Item | null): MenuItem[] => {
    if (!i) return [{ label: '&New Item', onClick: () => newItem() }];
    return [
      { label: '&Edit Item', shortcut: 'Ctrl+E', onClick: () => edit(i) },
      { label: '&Activity Report', shortcut: 'Ctrl+Q', onClick: () => activityReport(i) },
      { separator: true },
      { label: '&New Item', onClick: () => newItem() },
      { label: 'D&uplicate Item', onClick: () => duplicate(i) },
      { label: '&Delete Item', shortcut: 'Ctrl+D', onClick: () => void del(i) },
      { label: i.active ? 'Make Item &Inactive' : 'Make Item &Active', onClick: () => void toggleActive(i) },
      ...(i.type === 'Inventory Part' ? [{ separator: true }, { label: '&Adjust Inventory...', onClick: () => openWindow('inventoryAdjust', { itemId: i.id }) }] : []),
    ];
  };

  // ---- columns (the narrow floating window drops the least important ones)
  const showInv = prefs.inventoryEnabled;
  const columns: ListColumn<Item>[] = [
    bulk.column,
    { key: 'name', label: 'Name', width: 180, grow: true, sortValue: (i) => i.fullName, render: (i) => <span className="fl-name-text">{treeMode ? i.name : i.fullName}</span> },
    ...(width >= 860 ? [{ key: 'description', label: 'Description', width: 150, grow: true, render: (i: Item) => <span title={i.description}>{i.description}</span> } as ListColumn<Item>] : []),
    { key: 'type', label: 'Type', width: 124 },
    ...(width >= 700 ? [{ key: 'account', label: 'Account', width: 150, grow: true, sortValue: accountText, render: (i: Item) => <span title={accountText(i)}>{accountText(i)}</span> } as ListColumn<Item>] : []),
    ...(showInv
      ? [
          {
            key: 'qtyOnHand',
            label: 'On Hand',
            title: 'Total quantity on hand',
            width: 80,
            align: 'right',
            sortValue: (i: Item) => (i.type === 'Inventory Part' ? i.qtyOnHand : null),
            render: (i: Item) => (i.type === 'Inventory Part' ? <span className={'fl-money' + (i.qtyOnHand < 0 ? ' fl-neg' : '')}>{fmtQty(i.qtyOnHand)}</span> : ''),
          } as ListColumn<Item>,
          ...(prefs.purchaseOrdersEnabled
            ? [
                {
                  key: 'qtyOnPo',
                  label: 'On P.O.',
                  title: 'On purchase order',
                  width: 72,
                  align: 'right',
                  sortValue: (i: Item) => (i.type === 'Inventory Part' ? i.qtyOnPo : null),
                  render: (i: Item) => (i.type === 'Inventory Part' ? fmtQty(i.qtyOnPo, { blankZero: true }) : ''),
                } as ListColumn<Item>,
              ]
            : []),
        ]
      : []),
    {
      key: 'price',
      label: 'Price',
      width: 88,
      align: 'right',
      sortValue: (i) => (i.type === 'Sales Tax Item' || i.type === 'Sales Tax Group' ? i.taxRate : i.salesPrice),
      render: (i) => <span className="fl-money">{itemPriceText(i)}</span>,
    },
    ...(width >= 1000
      ? [
          actionsColumn<Item>(
            (i) => [
              { label: 'Edit', onClick: () => edit(i), title: 'Edit item (Ctrl+E)' },
              { label: 'Activity Report', onClick: () => activityReport(i), title: 'Transactions with this item (Ctrl+Q)' },
            ],
            140,
          ),
        ]
      : []),
  ];

  const total = showInactive ? all.length : all.filter((i) => i.active).length;
  const status = rows.length === total ? plural(total, 'item') : `${rows.length.toLocaleString('en-US')} of ${plural(total, 'item')}`;
  const selRecords = rows.filter((i) => bulk.selected.has(i.id));
  const empty = !isLoading && !error && data && all.length === 0;

  return (
    <ListPage
      rootRef={rootRef}
      toolbar={<ListSearchBox value={q} onChange={setQ} placeholder="Search products and services" aria-label="Search items" />}
      filters={
        empty ? undefined : <FilterChips aria-label="Item type" allLabel="All" value={group} onChange={setGroup} options={groups.map((g) => ({ key: g.key, label: g.label, count: counts[g.key] }))} />
      }
      actions={<Button variant="primary" icon={Plus} label="New item" onClick={() => newItem()} />}
      bulk={
        bulk.count > 0 ? (
          <div className="fl-bulkbar" role="toolbar" aria-label="Selected items">
            <span className="fl-bulkbar-text">{plural(bulk.count, 'item')} selected</span>
            <Button
              small
              label="Make inactive"
              onClick={() => void runBulk(selRecords.filter((i) => i.active), (i) => i.fullName, (i) => api.put(`/items/${i.id}/active`, { active: false }), (n) => `${plural(n, 'item')} made inactive`).then(bulk.clear)}
            />
            <Button
              small
              label="Make active"
              onClick={() => void runBulk(selRecords.filter((i) => !i.active), (i) => i.fullName, (i) => api.put(`/items/${i.id}/active`, { active: true }), (n) => `${plural(n, 'item')} made active`).then(bulk.clear)}
            />
            <Button small label="Export to CSV" onClick={exportSelected} />
            <Button small variant="ghost" label="Clear selection" onClick={bulk.clear} />
          </div>
        ) : null
      }
      footer={
        <>
          <DropdownButton label="Ite&m" items={itemMenu} up />
          <DropdownButton label="Ac&tivities" items={activitiesMenu} up />
          <DropdownButton label="Re&ports" items={reportsMenu} up />
          <Checkbox checked={showInactive} onChange={setShowInactive} label="Include inactive" style={{ marginLeft: 8 }} />
        </>
      }
      status={data ? status : undefined}
    >
      {error ? (
        <div className="fl-emptywrap">
          <EmptyState icon={Package} title="The item list could not be loaded" message={(error as Error).message} action={{ label: 'Try again', onClick: () => void refetch() }} />
        </div>
      ) : empty ? (
        <div className="fl-emptywrap">
          <EmptyState
            icon={Package}
            title="No products or services yet"
            message="Items are the products and services you sell or buy. Add them once and SerieX Books fills in the description, price and account on every invoice, sales receipt, bill and purchase order."
            action={{ label: 'Add your first item', onClick: () => newItem(), icon: Plus }}
            secondaryAction={{ label: 'Import from a CSV file', onClick: () => openWindow('importData', { entity: 'items' }) }}
          />
        </div>
      ) : (
        <ListView<Item>
          className="fl-list"
          aria-label="Item list"
          columns={columns}
          rows={rows}
          loading={isLoading}
          selectedKey={sel?.id ?? null}
          onSelect={(k) => setSelId(k as ID)}
          onActivate={(i) => edit(i)}
          contextMenu={rowMenu}
          getLevel={treeMode ? (i) => i.level : undefined}
          indentKey="name"
          isInactive={(i) => !i.active}
          showInactiveColumn={showInactive}
          persistKey="fl-items"
          autoFocus
          emptyText="No items match your search. Clear the search or pick another type."
          onKeyDown={(e) => bulk.onListKeyDown(e, sel)}
        />
      )}
    </ListPage>
  );
}
