// Payroll Items (Lists > Payroll Items, Employees > Payroll Items). Columns NAME, TYPE, AMOUNT,
// YEARLY LIMIT, TAX TREATMENT, PAID TO, ACCOUNT with the bottom menus Payroll Item ▾, Activities ▾,
// Reports ▾ and Include inactive; plus search and type chips like the current SerieX Books
// lists. Double-click edits the item in the payroll item wizard.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ListChecks, Plus } from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll, useItems, useMeta } from '@/api/hooks';
import { ITEM_TYPE_ORDER, type Id, type ItemType, type PayrollItem } from '@/api/types';
import {
  Button,
  Checkbox,
  DropdownButton,
  EmptyState,
  Field,
  FilterChips,
  ListView,
  SearchBox,
  StatePicker,
  alertBox,
  showDialog,
  toast,
  useHotkeys,
  type ListColumn,
  type MenuItem,
} from '@/components';
import { useSession } from '@/state/session';
import { downloadCsv } from '@/util/csv';
import { fmtMoney } from '@/util/format';
import { openWindow } from '@/windows/windowStore';
import {
  ListPage,
  deleteRecord,
  itemAccountText,
  itemAmountText,
  itemTrackingText,
  itemTypeText,
  matchesSearch,
  openReport,
  plural,
  printList,
  setRecordActive,
  showError,
  useCreatedListener,
  useElementWidth,
  useLocalState,
  useRevealRow,
} from './shared';

export interface PayrollItemListProps {}

const GROUPS: { key: string; label: string; types: ItemType[] }[] = [
  { key: 'wages', label: 'Wages', types: ['salary', 'hourly', 'overtime', 'bonus', 'commission', 'tips', 'reported_tips'] },
  { key: 'additions', label: 'Additions', types: ['addition'] },
  { key: 'deductions', label: 'Deductions', types: ['deduction'] },
  { key: 'contributions', label: 'Contributions', types: ['contribution'] },
  { key: 'taxes', label: 'Taxes', types: ['federal_tax', 'state_tax', 'other_tax'] },
];

/** "Add default payroll items for a state" dialog: resolves with the state code or null. */
function askState(primary: string): Promise<string | null> {
  return showDialog<string | null>({
    title: 'Add Default Payroll Items',
    width: 460,
    cancelValue: null,
    render: (close) => <StateAsk initial={primary} onDone={close} />,
  });
}

function StateAsk({ initial, onDone }: { initial: string; onDone(v: string | null): void }) {
  const [st, setSt] = useState(initial);
  return (
    <div className="sxp-emp-dlg">
      <div className="sxp-emp-dlg-body">
        <div className="sxp-emp-hint">
          SerieX Payroll adds the standard wage, deduction and federal tax items that are missing, and the tax items of the state you choose (withholding, unemployment and the
          state programs). Items you already have are kept.
        </div>
        <Field label="State" width={240}>
          <StatePicker value={st} onChange={(c) => setSt(c ?? '')} autoFocus aria-label="State" />
        </Field>
      </div>
      <div className="sx-dlg-buttons">
        <Button label="Cancel" onClick={() => onDone(null)} />
        <Button variant="primary" label="Add items" disabled={!st} onClick={() => onDone(st)} />
      </div>
    </div>
  );
}

export default function PayrollItemList(_props: PayrollItemListProps) {
  const meta = useMeta().data;
  const primary = useSession((s) => s.company?.primaryState ?? '');
  const { data, isLoading, error, refetch } = useItems({ active: 'all' });
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useLocalState('sxp.emp.items.inactive', false);
  const [selId, setSelId] = useState<Id | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(rootRef);


  const all = data ?? [];
  const base = useMemo(() => (showInactive ? all : all.filter((i) => i.active)), [all, showInactive]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const g of GROUPS) c[g.key] = base.filter((i) => g.types.includes(i.type)).length;
    return c;
  }, [base]);
  const rows = useMemo(() => {
    const g = GROUPS.find((x) => x.key === group);
    const rank = (t: ItemType) => ITEM_TYPE_ORDER.indexOf(t);
    return base
      .filter((i) => (!g || g.types.includes(i.type)) && matchesSearch(q, i.name, itemTypeText(i), i.agencyName, i.expenseAccountName, i.liabilityAccountName, i.taxCode, i.state))
      .sort((a, b) => rank(a.type) - rank(b.type) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [base, group, q]);
  const sel = rows.find((i) => i.id === selId) ?? null;
  const reveal = useRevealRow(rootRef, rows, (i) => i.id, (k) => setSelId(k as Id));
  useCreatedListener('item', (d) => {
    setQ('');
    setGroup(null);
    reveal.pick(d.id);
  });
  useEffect(() => {
    if (!sel && rows.length && !reveal.pending()) setSelId(rows[0].id);
  }, [sel, rows, reveal]);

  // ---- actions
  const newItem = (type?: ItemType) => openWindow('payrollItemEdit', type ? { type } : {});
  const edit = (i: PayrollItem | null = sel) => i && openWindow('payrollItemEdit', { id: i.id });
  const del = (i: PayrollItem | null = sel) =>
    i &&
    deleteRecord({
      what: 'payroll item',
      name: i.name,
      blocked: i.hasPaychecks ? `"${i.name}" is used on paychecks, so it cannot be deleted. Make it inactive instead: it stays on past paychecks but no longer appears in lists.` : null,
      request: () => api.del(`/items/${i.id}`),
      makeInactive: () => api.put(`/items/${i.id}/active`, { active: false }),
    });
  const toggleActive = (i: PayrollItem | null = sel) => i && setRecordActive(i.name, !i.active, () => api.put(`/items/${i.id}/active`, { active: !i.active }));
  const quickReport = (i: PayrollItem | null = sel) => i && openReport('payroll_item_detail', { itemId: String(i.id), dates: 'thisFiscalYear' }, `Payroll Item Activity: ${i.name}`);
  const addDefaults = async () => {
    const st = await askState(primary);
    if (!st) return;
    try {
      const r = await api.post<{ created: number; warnings?: string[] }>('/items/defaults', { state: st });
      await invalidateAll();
      toast(r.created ? `${plural(r.created, 'payroll item')} added` : 'Every default payroll item already exists', { kind: 'success' });
      if (r.warnings?.length) await alertBox(r.warnings.join('\n'), 'Warning');
    } catch (e) {
      await showError(e);
    }
  };

  useHotkeys({
    'ctrl+e': () => (sel ? void edit() : false),
    'ctrl+d': () => (sel ? void del() : false),
    'ctrl+q': () => (sel ? void quickReport() : false),
    'ctrl+n': () => newItem(),
  });

  const limitText = (i: PayrollItem) => (i.annualLimit === null || i.annualLimit === undefined ? '' : fmtMoney(i.type === 'deduction' ? -i.annualLimit : i.annualLimit));

  const print = () =>
    printList(
      'Payroll Items',
      [{ label: 'Name' }, { label: 'Type' }, { label: 'Amount', align: 'right' }, { label: 'Yearly Limit', align: 'right' }, { label: 'Tax Treatment' }, { label: 'Paid To' }, { label: 'Account' }],
      rows.map((i) => ({ cells: [i.name, itemTypeText(i), itemAmountText(i), limitText(i), itemTrackingText(meta, i), i.agencyName, itemAccountText(i)], inactive: !i.active })),
    );
  const exportCsv = () =>
    downloadCsv('payroll-items', [
      ['Name', 'Type', 'Amount', 'Yearly Limit', 'Tax Treatment', 'Paid To', 'Expense Account', 'Liability Account', 'Tax Code', 'State', 'Active'],
      ...rows.map((i) => [i.name, itemTypeText(i), itemAmountText(i), limitText(i), itemTrackingText(meta, i), i.agencyName, i.expenseAccountName, i.liabilityAccountName, i.taxCode, i.state, i.active ? 'Yes' : 'No']),
    ]);

  // ---- menus
  const itemMenu: MenuItem[] = [
    { label: '&New', shortcut: 'Ctrl+N', onClick: () => newItem() },
    { label: '&Edit Payroll Item', shortcut: 'Ctrl+E', disabled: !sel, onClick: () => edit() },
    { label: '&Delete Payroll Item', shortcut: 'Ctrl+D', disabled: !sel, onClick: () => void del() },
    { label: sel && !sel.active ? 'Make Payroll Item &Active' : 'Make Payroll Item &Inactive', disabled: !sel, onClick: () => void toggleActive() },
    { separator: true },
    { label: 'Show Inacti&ve Payroll Items', checked: showInactive, onClick: () => setShowInactive(!showInactive) },
    { label: 'Add Default Payroll Items for a &State...', onClick: () => void addDefaults() },
    { separator: true },
    { label: '&Print List...', onClick: () => void print() },
    { label: 'E&xport to CSV', onClick: exportCsv },
  ];
  const activitiesMenu: MenuItem[] = [
    { label: '&Pay Employees...', onClick: () => openWindow('employeeCenter', { tab: 'payroll' }) },
    { label: 'Pay Payroll &Taxes...', onClick: () => openWindow('payLiabilities') },
    { label: '&Adjust Tax Balances...', onClick: () => openWindow('adjustLiabilities', {}) },
    { label: 'Tax &Forms...', onClick: () => openWindow('processForms', {}) },
    { separator: true },
    { label: 'Tax Payment &Schedule...', onClick: () => openWindow('paymentSchedules') },
    { label: 'Enter &Year-to-Date Amounts...', onClick: () => openWindow('ytdSetup', {}) },
  ];
  const reportsMenu: MenuItem[] = [
    { label: sel ? `&Activity Report: ${sel.name}` : '&Activity Report', shortcut: 'Ctrl+Q', disabled: !sel, onClick: () => quickReport() },
    { separator: true },
    { label: 'Payroll Item Se&ttings', onClick: () => openReport('payroll_item_listing', {}) },
    { label: 'Payroll Item &Detail', onClick: () => openReport('payroll_item_detail', { dates: 'thisMonthToDate' }) },
    { label: 'Payroll &Summary', onClick: () => openReport('payroll_summary', { dates: 'thisFiscalQuarter' }) },
    { label: 'Payroll Liability &Balances', onClick: () => openReport('payroll_liability_balances', { dates: 'thisFiscalYear' }) },
  ];
  const rowMenu = (i: PayrollItem | null): MenuItem[] =>
    i
      ? [
          { label: '&Edit Payroll Item', shortcut: 'Ctrl+E', onClick: () => edit(i) },
          { label: 'Ac&tivity Report', shortcut: 'Ctrl+Q', onClick: () => quickReport(i) },
          { separator: true },
          { label: '&New', onClick: () => newItem() },
          { label: '&Delete Payroll Item', onClick: () => void del(i) },
          { label: i.active ? 'Make Payroll Item &Inactive' : 'Make Payroll Item &Active', onClick: () => void toggleActive(i) },
        ]
      : [{ label: '&New', onClick: () => newItem() }];

  const columns: ListColumn<PayrollItem>[] = [
    { key: 'name', label: 'Name', width: 190, grow: true },
    { key: 'type', label: 'Type', width: 165, sortValue: (i) => itemTypeText(i), render: (i) => itemTypeText(i) },
    { key: 'amount', label: 'Amount', width: 110, align: 'right', sortValue: (i) => i.rate, render: (i) => <span className="sxp-emp-money">{itemAmountText(i)}</span> },
    { key: 'annualLimit', label: 'Yearly limit', width: 118, align: 'right', sortValue: (i) => i.annualLimit, render: (i) => <span className="sxp-emp-money">{limitText(i)}</span> },
    { key: 'tracking', label: 'Tax treatment', width: 150, sortValue: (i) => itemTrackingText(meta, i), render: (i) => itemTrackingText(meta, i) },
    ...(width >= 820 ? [{ key: 'agencyName', label: 'Paid to', width: 170, render: (i: PayrollItem) => <span title={i.agencyName}>{i.agencyName}</span> } as ListColumn<PayrollItem>] : []),
    ...(width >= 1000
      ? [{ key: 'account', label: 'Account', width: 200, sortValue: (i: PayrollItem) => itemAccountText(i), render: (i: PayrollItem) => <span title={itemAccountText(i)}>{itemAccountText(i)}</span> } as ListColumn<PayrollItem>]
      : []),
  ];

  const total = showInactive ? all.length : all.filter((i) => i.active).length;
  const status = rows.length === total ? plural(total, 'payroll item') : `${rows.length.toLocaleString('en-US')} of ${plural(total, 'payroll item')}`;
  const empty = !isLoading && !error && data && all.length === 0;

  return (
    <ListPage
      rootRef={rootRef}
      toolbar={<SearchBox value={q} onChange={setQ} placeholder="Search payroll items" aria-label="Search payroll items" />}
      filters={empty ? undefined : <FilterChips aria-label="Item type" allLabel="All" value={group} onChange={setGroup} options={GROUPS.map((g) => ({ key: g.key, label: g.label, count: counts[g.key] }))} />}
      actions={<Button variant="primary" icon={Plus} label="New payroll item" onClick={() => newItem()} />}
      footer={
        <>
          <DropdownButton label="Payroll &Item" items={itemMenu} up />
          <DropdownButton label="Ac&tivities" items={activitiesMenu} up />
          <DropdownButton label="Re&ports" items={reportsMenu} up />
          <Checkbox checked={showInactive} onChange={setShowInactive} label="Include inactive" style={{ marginLeft: 8 }} />
        </>
      }
      status={data ? status : undefined}
    >
      {error ? (
        <div className="sxp-emp-emptywrap">
          <EmptyState icon={ListChecks} title="The payroll items could not be loaded" message={(error as Error).message} action={{ label: 'Try again', onClick: () => void refetch() }} />
        </div>
      ) : empty ? (
        <div className="sxp-emp-emptywrap">
          <EmptyState
            icon={ListChecks}
            title="No payroll items yet"
            message="Payroll items are the wages, additions, deductions, company contributions and taxes on your paychecks. Add the standard items for your state to start."
            action={{ label: 'Add default payroll items', onClick: () => void addDefaults(), icon: Plus }}
            secondaryAction={{ label: 'New payroll item', onClick: () => newItem() }}
          />
        </div>
      ) : (
        <ListView<PayrollItem>
          className="sxp-emp-list"
          aria-label="Payroll items"
          columns={columns}
          rows={rows}
          loading={isLoading}
          selectedKey={sel?.id ?? null}
          onSelect={(k) => setSelId(k as Id)}
          onActivate={(i) => edit(i)}
          contextMenu={rowMenu}
          isInactive={(i) => !i.active}
          showInactiveColumn={showInactive}
          persistKey="emp-items"
          autoFocus
          emptyText="No payroll items match your search. Clear the search or pick another type."
        />
      )}
    </ListPage>
  );
}
