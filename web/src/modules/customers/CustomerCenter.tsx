// Customer Center: Customers & Jobs | Transactions tabs on the left, customer information and
// its transactions on the right, with a money bar (Estimates, Unbilled,
// Overdue, Open invoices, Paid last 30 days) as clickable filters, search, row actions, bulk
// selection and right-click menus.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  CirclePlus,
  ClipboardList,
  FilePlus2,
  FileSpreadsheet,
  HandCoins,
  Mail,
  Pencil,
  Phone,
  Printer,
  ReceiptText,
  TrendingUp,
  UserPlus,
  Users,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '@/api/client';
import { invalidateAll, useCompanyInfo, useList, useNameSummary, useNames, usePrefValues, useTxnList } from '@/api/hooks';
import type { ID, Name, Todo, TxnListResult, TxnSummary, TxnType } from '@/api/types';
import {
  Button,
  Card,
  Checkbox,
  DateField,
  DropdownButton,
  EmptyState,
  ListView,
  MoneyBar,
  SearchBox,
  Select,
  Spinner,
  Splitter,
  StatusPill,
  Tabs,
  TextArea,
  TextField,
  Toolbar,
  ToolbarSpacer,
  alertBox,
  confirmBox,
  msgBox,
  toast,
  useHotkeys,
  type ListColumn,
  type MenuItem,
} from '@/components';
import type { WindowKind } from '@/windows/kinds';
import { openTxn, openWindow } from '@/windows/windowStore';
import { downloadCsv } from '@/util/csv';
import { resolvePreset, todayIso } from '@/util/dates';
import { fmtDate, fmtMoney } from '@/util/format';
import { escHtml, printHtml } from '@/util/print';
import { useMoneyBar } from './centerData';
import { CUSTOMER_TXN_TYPES, displayStatus, isOverdue, money$ } from './shared';

export interface CustomerCenterProps {
  selectId?: number;
}

type View = 'active' | 'all' | 'balance' | 'overdue' | 'inactive';
type BarKey = 'estimates' | 'unbilled' | 'overdue' | 'open' | 'paid';

const VIEWS: { value: View; label: string }[] = [
  { value: 'active', label: 'Active customers' },
  { value: 'all', label: 'All customers' },
  { value: 'balance', label: 'Customers with open balances' },
  { value: 'overdue', label: 'Customers with overdue invoices' },
  { value: 'inactive', label: 'Inactive customers' },
];

/** SHOW choices of the customer's transactions (and the types they list). */
const SHOW: { value: string; label: string; types: TxnType[] }[] = [
  { value: 'all', label: 'All transactions', types: CUSTOMER_TXN_TYPES },
  { value: 'INV', label: 'Invoices', types: ['INV'] },
  { value: 'EST', label: 'Estimates', types: ['EST'] },
  { value: 'SALESRCPT', label: 'Sales receipts', types: ['SALESRCPT'] },
  { value: 'PMT', label: 'Received payments', types: ['PMT'] },
  { value: 'CREDMEM', label: 'Credit memos', types: ['CREDMEM'] },
  { value: 'STMTCHG', label: 'Statement charges', types: ['STMTCHG'] },
  { value: 'REFUND', label: 'Refunds', types: ['REFUND'] },
];

/** Left "Transactions" tab entries (in workflow order). */
const TXN_TYPES: { type: TxnType; label: string }[] = [
  { type: 'EST', label: 'Estimates' },
  { type: 'INV', label: 'Invoices' },
  { type: 'STMTCHG', label: 'Statement Charges' },
  { type: 'SALESRCPT', label: 'Sales Receipts' },
  { type: 'PMT', label: 'Received Payments' },
  { type: 'CREDMEM', label: 'Credit Memos' },
  { type: 'REFUND', label: 'Refunds' },
];

const DATE_CHOICES = [
  { value: 'all', label: 'All dates' },
  { value: 'thisMonth', label: 'This month' },
  { value: 'thisFiscalQuarter', label: 'This fiscal quarter' },
  { value: 'thisFiscalYear', label: 'This fiscal year' },
  { value: 'lastMonth', label: 'Last month' },
  { value: 'lastFiscalQuarter', label: 'Last fiscal quarter' },
  { value: 'lastFiscalYear', label: 'Last fiscal year' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'last365', label: 'Last 365 days' },
];

function dateRange(key: string, fyStart: number): { from?: string; to?: string } {
  const today = todayIso();
  if (key === 'all') return {};
  if (key === 'last30') return { from: addDaysIso(today, -30), to: today };
  if (key === 'last365') return { from: addDaysIso(today, -365), to: today };
  const r = resolvePreset(key, today, fyStart);
  return { from: r.from || undefined, to: r.to || undefined };
}
function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** FILTER BY choices for a SHOW value. */
function filterChoices(show: string): { value: string; label: string }[] {
  if (show === 'INV' || show === 'STMTCHG') return [
    { value: 'all', label: 'All' },
    { value: 'open', label: 'Open' },
    { value: 'overdue', label: 'Overdue' },
    { value: 'paid', label: 'Paid' },
  ];
  if (show === 'EST') return [
    { value: 'all', label: 'All' },
    { value: 'open', label: 'Open (pending, accepted)' },
    { value: 'Closed', label: 'Closed' },
    { value: 'Rejected', label: 'Rejected' },
  ];
  if (show === 'CREDMEM' || show === 'PMT') return [
    { value: 'all', label: 'All' },
    { value: 'open', label: 'With credit left' },
  ];
  return [
    { value: 'all', label: 'All' },
    { value: 'open', label: 'Open' },
  ];
}

/** Rows kept by the customer list filters: matches plus their ancestors (so the tree stays readable). */
function keepWithAncestors(all: Name[], match: (n: Name) => boolean): Name[] {
  const byId = new Map(all.map((n) => [n.id, n]));
  const keep = new Set<ID>();
  for (const n of all) {
    if (!match(n)) continue;
    keep.add(n.id);
    let p = n.parentId ? byId.get(n.parentId) : undefined;
    for (let i = 0; p && i < 10; i++) {
      keep.add(p.id);
      p = p.parentId ? byId.get(p.parentId) : undefined;
    }
  }
  return all.filter((n) => keep.has(n.id));
}

export default function CustomerCenter(props: CustomerCenterProps) {
  const prefs = usePrefValues();
  const [leftTab, setLeftTab] = useState<'customers' | 'transactions'>('customers');
  const [view, setView] = useState<View>('active');
  const [search, setSearch] = useState('');
  const [bar, setBar] = useState<BarKey | null>(null);
  const [selId, setSelId] = useState<ID | null>(props.selectId ?? null);
  const [checked, setChecked] = useState<Set<ID>>(new Set());
  const [txnType, setTxnType] = useState<TxnType>('INV');
  const names = useNames('customer', { active: 'all' });
  const money = useMoneyBar();
  const listRef = useRef<HTMLDivElement>(null);

  // follow props.selectId (the center is a singleton: opening it for another customer re-selects)
  useEffect(() => {
    if (props.selectId) {
      setSelId(props.selectId);
      setLeftTab('customers');
      const n = names.data?.find((x) => x.id === props.selectId);
      if (n && !n.active) setView('all');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.selectId]);

  const all = names.data ?? [];
  const byId = useMemo(() => new Map(all.map((n) => [n.id, n])), [all]);
  const overdueIds = money.overdue.nameIds;

  const rows = useMemo(() => {
    let list = all;
    if (view === 'active') list = list.filter((n) => n.active);
    else if (view === 'inactive') list = keepWithAncestors(list, (n) => !n.active);
    else if (view === 'balance') list = keepWithAncestors(list, (n) => n.active && Math.abs(n.ownBalance) > 0.004);
    else if (view === 'overdue') list = keepWithAncestors(list, (n) => overdueIds.has(n.id));
    if (bar) {
      const set = money[bar].nameIds;
      list = keepWithAncestors(list, (n) => set.has(n.id));
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = keepWithAncestors(list, (n) =>
        [n.fullName, n.companyName, n.firstName + ' ' + n.lastName, n.phone, n.mobile, n.email, n.accountNumber].some((s) => (s ?? '').toLowerCase().includes(q)),
      );
    }
    return list;
  }, [all, view, bar, search, money, overdueIds]);

  const selected = selId ? byId.get(selId) ?? null : null;
  const top = selected?.parentId ? (() => {
    let p: Name | undefined = selected;
    for (let i = 0; p?.parentId && i < 10; i++) p = byId.get(p.parentId);
    return p ?? selected;
  })() : selected;

  // keep a selection when the list changes
  useEffect(() => {
    if (leftTab !== 'customers') return;
    if (selId && rows.some((r) => r.id === selId)) return;
    if (rows.length && !props.selectId) setSelId(rows[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, leftTab]);

  // ---- actions on customers
  const newCustomer = () => openWindow('customerEdit', {});
  const addJob = (n: Name | null = selected) => {
    if (!n) {
      void alertBox('Select the customer to add a job to first.', 'Add Job');
      return;
    }
    const owner = n.parentId ? byId.get(n.parentId) ?? n : n;
    openWindow('customerEdit', { parentId: owner.id });
  };
  const edit = (n: Name | null = selected) => n && openWindow('customerEdit', { id: n.id, parentId: n.parentId ?? undefined });
  const setActive = async (list: Name[], active: boolean) => {
    try {
      for (const n of list) await api.put(`/names/${n.id}/active`, { active });
      void invalidateAll();
      toast(`${list.length === 1 ? `"${list[0].fullName}"` : `${list.length} customers`} ${active ? 'made active' : 'made inactive'}`, { kind: 'success' });
    } catch (e) {
      if ((e as { code?: string }).code !== 'cancelled') await alertBox((e as Error).message, 'Warning');
    }
  };
  const remove = async (n: Name | null = selected) => {
    if (!n) return;
    if (n.hasTxns || all.some((x) => x.parentId === n.id)) {
      const r = await msgBox({
        title: 'Cannot Delete',
        message: `"${n.fullName}" has ${n.hasTxns ? 'transactions' : 'jobs'}, so it cannot be deleted (its history would be lost).\n\nMake it inactive instead? It stays in your reports but is hidden from lists.`,
        buttons: ['Make inactive', 'Cancel'],
        icon: 'warning',
      });
      if (r === 'Make inactive') await setActive([n], false);
      return;
    }
    if (!(await confirmBox(`Delete ${n.parentId ? 'the job' : 'the customer'} "${n.fullName}"? This cannot be undone.`, 'Delete Customer or Job'))) return;
    try {
      await api.del(`/names/${n.id}`);
      void invalidateAll();
      toast(`"${n.fullName}" deleted`, { kind: 'info' });
      setSelId(null);
    } catch (e) {
      if ((e as { code?: string }).code !== 'cancelled') await alertBox((e as Error).message, 'Cannot delete');
    }
  };
  const activityReport = (n: Name | null = selected) => n && openWindow('report', { key: 'name_quickreport', params: { nameId: String(n.id), dates: 'all' } });
  const openBalance = (n: Name | null = selected) => n && openWindow('report', { key: 'customer_balance_detail', params: { nameIds: String(n.id), includeJobs: '1', dates: 'all' } });

  const txnMenu = (n: Name | null): MenuItem[] => [
    { label: 'Create &Estimates', onClick: () => openWindow('estimate', { customerId: n?.id }), hidden: !prefs.estimatesEnabled },
    { label: 'Create &Invoices', onClick: () => openWindow('invoice', { customerId: n?.id }) },
    { label: 'Enter Sales &Receipts', onClick: () => openWindow('salesReceipt', { customerId: n?.id }) },
    { label: 'Enter Statement &Charges', onClick: () => openWindow('statementCharges', { customerId: n?.id }) },
    { label: 'Receive &Payments', onClick: () => openWindow('receivePayment', { customerId: n?.id }) },
    { label: 'Create Credit &Memos/Refunds', onClick: () => openWindow('creditMemo', { customerId: n?.id }) },
  ];

  const rowMenu = (n: Name | null): MenuItem[] => {
    if (!n) return [{ label: 'New Customer…', onClick: newCustomer }];
    return [
      { label: 'Edit Customer or Job', shortcut: 'Ctrl+E', onClick: () => edit(n) },
      { label: 'Add Job', onClick: () => addJob(n) },
      { label: n.active ? 'Make Inactive' : 'Make Active', onClick: () => void setActive([n], !n.active) },
      { label: 'Delete Customer or Job', onClick: () => void remove(n) },
      { separator: true },
      { label: 'Activity Report', shortcut: 'Ctrl+Q', onClick: () => activityReport(n) },
      { label: 'Open Balance', onClick: () => openBalance(n) },
      { separator: true },
      ...txnMenu(n),
      { label: 'Create Statement…', onClick: () => openWindow('createStatements', { customerIds: [n.id] }) },
    ];
  };

  useHotkeys({
    'ctrl+e': () => {
      if (leftTab === 'customers' && selected) edit();
      else return false;
    },
    'ctrl+q': () => {
      if (leftTab === 'customers' && selected) activityReport();
      else return false;
    },
  });

  // ---- print / export
  const printList = () => {
    const body = `<h1>Customer &amp; Job List</h1><table><thead><tr><th>Name</th><th>Company</th><th>Phone</th><th>Email</th><th class="num">Balance Total</th></tr></thead><tbody>${rows
      .map(
        (n) =>
          `<tr><td style="padding-left:${6 + n.level * 14}px">${escHtml(n.name)}</td><td>${escHtml(n.companyName)}</td><td>${escHtml(n.phone)}</td><td>${escHtml(n.email)}</td><td class="num">${fmtMoney(n.balance)}</td></tr>`,
      )
      .join('')}</tbody></table>`;
    void printHtml('Customer & Job List', body);
  };
  const exportList = () => {
    downloadCsv('Customer List', [
      ['Customer', 'Company', 'First Name', 'Last Name', 'Phone', 'Email', 'Bill To', 'Balance Total', 'Active'],
      ...rows.map((n) => [
        n.fullName,
        n.companyName,
        n.firstName,
        n.lastName,
        n.phone,
        n.email,
        [n.billAddress.line1, n.billAddress.city, n.billAddress.state, n.billAddress.zip].filter(Boolean).join(', '),
        n.balance,
        n.active ? 'Yes' : 'No',
      ]),
    ]);
  };
  const loadTxns = async (n: Name) =>
    (await api.get<TxnListResult>('/txns' + qs({ nameId: n.id, includeJobs: 1, types: CUSTOMER_TXN_TYPES, limit: 5000, sort: '-date' }))).rows;
  const printTxns = async () => {
    if (!selected) return;
    const n = selected;
    const list = await loadTxns(n);
    const today = todayIso();
    void printHtml(
      `Transactions - ${n.fullName}`,
      `<h1>${escHtml(n.fullName)}</h1><h2>Customer &amp; Job Transaction List</h2><table><thead><tr><th>Type</th><th>Num</th><th>Date</th><th>Customer or Job</th><th class="num">Amount</th><th class="num">Open Balance</th><th>Status</th></tr></thead><tbody>${list
        .map(
          (r) =>
            `<tr><td>${escHtml(r.typeLabel)}</td><td>${escHtml(r.refNumber)}</td><td>${fmtDate(r.date)}</td><td>${escHtml(r.nameFull)}</td><td class="num">${fmtMoney(r.amount)}</td><td class="num">${['INV', 'STMTCHG', 'CREDMEM', 'PMT'].includes(r.type) ? fmtMoney(r.openBalance) : ''}</td><td>${escHtml(displayStatus(r, today))}</td></tr>`,
        )
        .join('')}</tbody></table>`,
    );
  };
  const exportTxns = async () => {
    if (!selected) return;
    const n = selected;
    const list = await loadTxns(n);
    const today = todayIso();
    downloadCsv(`${n.fullName} transactions`, [
      ['Type', 'Num', 'Date', 'Due Date', 'Customer or Job', 'Account', 'Amount', 'Open Balance', 'Status', 'Memo'],
      ...list.map((r) => [r.typeLabel, r.refNumber, fmtDate(r.date), fmtDate(r.dueDate), r.nameFull, r.accountName, r.amount, r.openBalance, displayStatus(r, today), r.memo]),
    ]);
  };
  const printInfo = () => {
    if (!selected) return;
    const n = selected;
    const addr = (a: Name['billAddress']) => [a.line1, a.line2, a.line3, [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '), a.country].filter(Boolean).map(escHtml).join('<br>');
    void printHtml(
      `Customer ${n.fullName}`,
      `<h1>${escHtml(n.fullName)}</h1><table style="width:auto"><tbody>
      <tr><td class="bold">Company</td><td>${escHtml(n.companyName)}</td></tr>
      <tr><td class="bold">Contact</td><td>${escHtml([n.salutation, n.firstName, n.middleName, n.lastName].filter(Boolean).join(' '))}</td></tr>
      <tr><td class="bold">Phone</td><td>${escHtml(n.phone)}</td></tr><tr><td class="bold">Email</td><td>${escHtml(n.email)}</td></tr>
      <tr><td class="bold">Bill to</td><td>${addr(n.billAddress)}</td></tr><tr><td class="bold">Ship to</td><td>${addr(n.shipAddress)}</td></tr>
      <tr><td class="bold">Balance</td><td>${fmtMoney(n.balance)}</td></tr></tbody></table>`,
    );
  };

  const nameColumns: ListColumn<Name>[] = [
    {
      key: 'check',
      label: '',
      width: 30,
      sortable: false,
      render: (n) => (
        <input
          type="checkbox"
          className="sx-cust-rowcheck"
          aria-label={`Select ${n.fullName}`}
          checked={checked.has(n.id)}
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            const s = new Set(checked);
            if (e.target.checked) s.add(n.id);
            else s.delete(n.id);
            setChecked(s);
          }}
        />
      ),
    },
    { key: 'name', label: 'NAME', width: 130, grow: true, sortValue: (n) => n.fullName },
    { key: 'balance', label: 'BALANCE TOTAL', width: 116, type: 'money', render: (n) => (n.balance ? fmtMoney(n.balance) : '') },
    {
      key: 'act',
      label: '',
      width: 30,
      sortable: false,
      render: (n) => (
        <button
          type="button"
          className="sx-cust-rowact"
          title={`Create an invoice for ${n.fullName}`}
          aria-label={`Create invoice for ${n.fullName}`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => openWindow('invoice', { customerId: n.id })}
        >
          <FilePlus2 size={14} aria-hidden="true" />
        </button>
      ),
    },
  ];

  const checkedNames = all.filter((n) => checked.has(n.id));

  return (
    <div className="sx-cust-center">
      <Toolbar aria-label="Customer Center">
        <DropdownButton
          flat
          label="New Customer && Job"
          icon={UserPlus}
          items={[
            { label: 'New &Customer…', onClick: newCustomer },
            { label: 'Add &Job…', onClick: () => addJob(), disabled: !selected },
          ]}
        />
        <DropdownButton flat label="New Transactions" icon={CirclePlus} items={txnMenu(selected)} />
        <DropdownButton
          flat
          label="Print"
          icon={Printer}
          items={[
            { label: 'Customer && Job &List', onClick: printList },
            { label: 'Customer && Job &Information', onClick: printInfo, disabled: !selected },
            { label: 'Customer && Job &Transaction List', onClick: () => void printTxns(), disabled: !selected },
            { label: 'Customer &Statements…', onClick: () => openWindow('createStatements', selected ? { customerIds: [selected.id] } : {}) },
          ]}
        />
        <DropdownButton
          flat
          label="Export"
          icon={FileSpreadsheet}
          items={[
            { label: '&Export Customer List', onClick: exportList },
            { label: 'Export &Transactions', onClick: () => void exportTxns(), disabled: !selected },
            { label: '&Import from CSV…', onClick: () => openWindow('importData', { entity: 'customers' }) },
          ]}
        />
        <Button variant="ghost" icon={TrendingUp} label="Money In" onClick={() => openWindow('incomeTracker')} />
        <ToolbarSpacer />
        <Button variant="primary" icon={FilePlus2} label="Create invoice" onClick={() => openWindow('invoice', { customerId: selected?.id })} />
        <Button variant="secondary" icon={HandCoins} label="Receive payment" onClick={() => openWindow('receivePayment', { customerId: selected?.id })} />
      </Toolbar>
      <div className="sx-cust-moneybar">
        <MoneyBar
          aria-label="Money bar"
          selected={bar}
          onSelect={(k) => {
            setBar(k as BarKey | null);
            setLeftTab('customers');
          }}
          segments={[
            { key: 'estimates', label: 'Estimates', amount: money.estimates.amount, count: money.estimates.count, color: '#0891b2', group: 'Unbilled', groupNote: 'Open estimates and billable costs' },
            { key: 'unbilled', label: 'Unbilled activity', amount: money.unbilled.amount, count: money.unbilled.count, color: '#7c3aed', group: 'Unbilled' },
            { key: 'overdue', label: 'Overdue', amount: money.overdue.amount, count: money.overdue.count, color: 'danger', group: 'Unpaid' },
            { key: 'open', label: 'Open invoices', amount: money.open.amount, count: money.open.count, color: '#94a3b8', group: 'Unpaid' },
            { key: 'paid', label: 'Paid · 30 days', amount: money.paid.amount, count: money.paid.count, color: 'success', group: 'Paid' },
          ]}
        />
      </div>
      <Splitter initial={320} min={250} minSecond={420} persistKey="cust-center">
        <div className="sx-cust-left">
          <Tabs
            variant="strip"
            fill
            active={leftTab}
            onChange={(k) => setLeftTab(k as 'customers' | 'transactions')}
            tabs={[
              { key: 'customers', label: 'Customers & Jobs' },
              { key: 'transactions', label: 'Transactions' },
            ]}
          >
            {leftTab === 'customers' ? (
              <div className="sx-cust-leftbody">
                <div className="sx-cust-filters">
                  <Select value={view} options={VIEWS} onChange={(v) => setView(v as View)} aria-label="View" />
                  <SearchBox value={search} onChange={setSearch} placeholder="Find a customer" debounce={150} />
                </div>
                {(bar || checked.size > 0) && (
                  <div className="sx-cust-chipline">
                    {bar && (
                      <span className="sx-cust-filterchip">
                        Showing: {({ estimates: 'Open estimates', unbilled: 'Unbilled activity', overdue: 'Overdue', open: 'Open invoices', paid: 'Paid last 30 days' } as const)[bar]}
                        <button type="button" className="sx-linkbtn" onClick={() => setBar(null)}>
                          Clear
                        </button>
                      </span>
                    )}
                    {checked.size > 0 && (
                      <span className="sx-cust-bulk">
                        <b>{checked.size} selected</b>
                        <DropdownButton
                          label="Batch actions"
                          items={[
                            { label: 'Make &inactive', onClick: () => void setActive(checkedNames.filter((n) => n.active), false) },
                            { label: 'Make &active', onClick: () => void setActive(checkedNames.filter((n) => !n.active), true) },
                            { label: 'Create &statements…', onClick: () => openWindow('createStatements', { customerIds: [...checked] }) },
                            {
                              label: '&Export selected (CSV)',
                              onClick: () =>
                                downloadCsv('Customers', [
                                  ['Customer', 'Company', 'Phone', 'Email', 'Balance Total'],
                                  ...checkedNames.map((n) => [n.fullName, n.companyName, n.phone, n.email, n.balance]),
                                ]),
                            },
                          ]}
                        />
                        <button type="button" className="sx-linkbtn" onClick={() => setChecked(new Set())}>
                          Clear
                        </button>
                      </span>
                    )}
                  </div>
                )}
                <div ref={listRef} className="sx-cust-listwrap">
                  {names.isLoading ? (
                    <Spinner center label="Loading customers..." />
                  ) : all.length === 0 ? (
                    <EmptyState
                      icon={Users}
                      title="No customers yet"
                      message="Customers are the people and businesses you sell to. Add one to start sending invoices."
                      action={{ label: 'Add customer', onClick: newCustomer }}
                    />
                  ) : (
                    <ListView<Name>
                      aria-label="Customers and jobs"
                      className="sx-cust-namelist"
                      columns={nameColumns}
                      rows={rows}
                      selectedKey={selId}
                      onSelect={(k) => setSelId(k as ID)}
                      onActivate={(n) => edit(n)}
                      contextMenu={rowMenu}
                      getLevel={(n) => n.level}
                      indentKey="name"
                      isInactive={(n) => !n.active}
                      showInactiveColumn={view !== 'active'}
                      persistKey="cust-names"
                      emptyText={<div className="sx-cust-empty-small">No customers match these filters.</div>}
                      onKeyDown={(e) => {
                        if (e.key === 'Delete' && selected) {
                          e.preventDefault();
                          void remove();
                        }
                      }}
                    />
                  )}
                </div>
                <div className="sx-cust-leftfoot">
                  {rows.length} {rows.length === 1 ? 'customer' : 'customers'} · Total {money$(rows.filter((r) => !r.parentId).reduce((s, r) => s + r.balance, 0))}
                </div>
              </div>
            ) : (
              <div className="sx-cust-typelist" role="listbox" aria-label="Transaction types">
                {TXN_TYPES.filter((t) => t.type !== 'EST' || prefs.estimatesEnabled).map((t) => (
                  <button key={t.type} type="button" role="option" aria-selected={txnType === t.type} className={'sx-cust-typeitem' + (txnType === t.type ? ' sx-on' : '')} onClick={() => setTxnType(t.type)}>
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </Tabs>
        </div>
        <div className="sx-cust-right">
          {leftTab === 'customers' ? (
            selected ? (
              <CustomerDetail key={selected.id} n={selected} top={top ?? selected} rowMenu={rowMenu} onEdit={() => edit()} onActivityReport={() => activityReport()} onOpenBalance={() => openBalance()} />
            ) : (
              <EmptyState icon={Users} title="Select a customer" message="Choose a customer or job on the left to see their details and transactions." />
            )
          ) : (
            <TypeTransactions type={txnType} />
          )}
        </div>
      </Splitter>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right pane: one customer

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div className="sx-cust-info-row">
      <span className="sx-cust-info-label">{label}</span>
      <span className="sx-cust-info-value">{children}</span>
    </div>
  );
}

function addrText(a: Name['billAddress']): string {
  return [a.line1, a.line2, a.line3, [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '), a.country].filter(Boolean).join('\n');
}

const INFO_PREF_KEY = 'sx.cust.infocard';

function readInfoPref(): 'open' | 'closed' | null {
  try {
    const v = localStorage.getItem(INFO_PREF_KEY);
    return v === 'open' || v === 'closed' ? v : null;
  } catch {
    return null;
  }
}

/** True while the element is shorter than `limit` px (the customer pane at 1280x720 is about 540 px). */
function usePaneIsShort(ref: React.RefObject<HTMLElement>, limit = 600): boolean {
  const [short, setShort] = useState(false);
  // measured before the first paint, so the card does not open and then fold
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setShort(el.clientHeight > 0 && el.clientHeight < limit);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, limit]);
  return short;
}

function CustomerDetail({
  n,
  top,
  rowMenu,
  onEdit,
  onActivityReport,
  onOpenBalance,
}: {
  n: Name;
  top: Name;
  rowMenu: (n: Name | null) => MenuItem[];
  onEdit: () => void;
  onActivityReport: () => void;
  onOpenBalance: () => void;
}) {
  const prefs = usePrefValues();
  const sum = useNameSummary(n.id).data;
  const termsList = useList('terms', { active: 'all' }).data;
  const types = useList('customer_type', { active: 'all' }).data;
  const reps = useList('sales_rep', { active: 'all' }).data;
  const [tab, setTab] = useState<'txns' | 'contacts' | 'todos' | 'notes'>('txns');
  const [show, setShow] = useState('all');
  const [filter, setFilter] = useState('all');
  const [dates, setDates] = useState('all');
  const listOf = (l: { id: ID; name: string }[] | undefined, id: ID | null) => (id ? l?.find((x) => x.id === id)?.name ?? '' : '');
  const contact = [n.salutation, n.firstName, n.middleName, n.lastName].filter(Boolean).join(' ');
  // the details card folds to one line when the pane is short (1280x720) so the transactions get the room;
  // the user's own choice (Show / Hide details) is remembered
  const paneRef = useRef<HTMLDivElement>(null);
  const short = usePaneIsShort(paneRef);
  const [infoPref, setInfoPref] = useState<'open' | 'closed' | null>(() => readInfoPref());
  const collapsed = infoPref ? infoPref === 'closed' : short;
  const toggleInfo = () => {
    const next = collapsed ? 'open' : 'closed';
    setInfoPref(next);
    try {
      localStorage.setItem(INFO_PREF_KEY, next);
    } catch {
      /* storage unavailable */
    }
  };
  const terms = [listOf(termsList, n.termsId), prefs.salesTaxEnabled ? (n.taxable ? 'Taxable' : 'Non-taxable') : ''].filter(Boolean).join(' · ');

  return (
    <div ref={paneRef} className="sx-cust-detail">
      <Card
        className={'sx-cust-infocard' + (collapsed ? ' sx-cust-info-collapsed' : '')}
        title={
          <span className="sx-cust-info-title">
            {/* data-name feeds the CSS that keeps the name at least ~60px wide (see customers.css) */}
            <span className="sx-cust-info-name" title={n.fullName} data-name={n.fullName}>
              <span className="sx-cust-info-name-text">{n.fullName}</span>
            </span>
            {!n.active && (
              <span className="sx-cust-info-inactive" title={n.parentId ? 'This job is inactive' : 'This customer is inactive'}>
                <StatusPill status="Inactive" />
              </span>
            )}
          </span>
        }
        subtitle={n.parentId ? `Job of ${top.name}` : n.companyName && n.companyName !== n.name ? n.companyName : undefined}
        actions={
          <>
            {collapsed && (
              <span className="sx-cust-info-minibal" title={sum?.overdue ? `Open balance · ${money$(sum.overdue)} overdue` : 'Open balance'}>
                <b>{money$(sum?.openBalance ?? n.balance)}</b>
                {!!sum?.overdue && <span className="sx-tone-text-danger sx-cust-info-minibal-due"> · {money$(sum.overdue)} overdue</span>}
              </span>
            )}
            <Button
              small
              variant="ghost"
              icon={collapsed ? ChevronDown : ChevronUp}
              label={collapsed ? 'Details' : 'Less'}
              aria-expanded={!collapsed}
              onClick={toggleInfo}
              title={collapsed ? 'Show the contact details, addresses and report links' : 'Hide the details to see more transactions'}
            />
            <Button small variant="ghost" icon={Pencil} label="Edit" onClick={onEdit} title="Edit customer (Ctrl+E)" />
            <DropdownButton label="More" items={rowMenu(n)} alignEnd />
          </>
        }
      >
        {collapsed ? (
          <div className="sx-cust-info-line">
            {n.phone && (
              <span className="sx-cust-iconline">
                <Phone size={13} aria-hidden="true" />
                {n.phone}
              </span>
            )}
            {n.email && (
              <a className="sx-cust-iconline" href={`mailto:${n.email}`} title={n.email}>
                <Mail size={13} aria-hidden="true" />
                {n.email}
              </a>
            )}
            {terms && <span className="sx-muted">{terms}</span>}
            {!n.phone && !n.email && !terms && <span className="sx-muted">No contact details.</span>}
          </div>
        ) : (
        <>
        <div className="sx-cust-info">
          <div className="sx-cust-info-col">
            <InfoRow label="Company">{n.companyName}</InfoRow>
            <InfoRow label="Full name">{contact}</InfoRow>
            <InfoRow label="Phone">
              {n.phone && (
                <span className="sx-cust-iconline">
                  <Phone size={13} aria-hidden="true" />
                  {n.phone}
                </span>
              )}
            </InfoRow>
            <InfoRow label="Email">
              {n.email && (
                <a className="sx-cust-iconline" href={`mailto:${n.email}`} title={n.email}>
                  <Mail size={13} aria-hidden="true" />
                  {n.email}
                </a>
              )}
            </InfoRow>
            <InfoRow label="Terms">{terms}</InfoRow>
            <InfoRow label={n.parentId ? 'Job status' : 'Type / Rep'}>
              {n.parentId ? n.jobStatus : [listOf(types, n.typeId), listOf(reps, n.repId)].filter(Boolean).join(' · ')}
            </InfoRow>
          </div>
          <div className="sx-cust-info-col">
            <InfoRow label="Bill to">
              <span className="sx-cust-pre">{addrText(n.billAddress)}</span>
            </InfoRow>
            {addrText(n.shipAddress) !== addrText(n.billAddress) ? (
              <InfoRow label="Ship to">
                <span className="sx-cust-pre">{addrText(n.shipAddress)}</span>
              </InfoRow>
            ) : addrText(n.shipAddress) ? (
              <InfoRow label="Ship to">
                <span className="sx-muted">Same as bill to</span>
              </InfoRow>
            ) : null}
          </div>
          <div className="sx-cust-info-side">
            <div className="sx-cust-balbox">
              <span>Open balance</span>
              <b>{money$(sum?.openBalance ?? n.balance)}</b>
              {!!sum?.overdue && <span className="sx-tone-text-danger">{money$(sum.overdue)} overdue</span>}
              {sum?.creditLimit !== null && sum?.creditLimit !== undefined && <span className="sx-muted">Credit limit {money$(sum.creditLimit)}</span>}
            </div>
          </div>
        </div>
        <div className="sx-cust-reports">
          <span className="sx-cust-reports-head">Reports for this customer</span>
          <button type="button" className="sx-linkbtn" onClick={onActivityReport}>
            Customer Activity
          </button>
          <button type="button" className="sx-linkbtn" onClick={onOpenBalance}>
            Open balance
          </button>
          {prefs.estimatesEnabled && (
            <button
              type="button"
              className="sx-linkbtn"
              onClick={() => {
                setTab('txns');
                setShow('EST');
                setFilter('all');
              }}
            >
              Show estimates
            </button>
          )}
          <button type="button" className="sx-linkbtn" onClick={() => openWindow('report', { key: 'sales_by_customer_detail', params: { nameIds: String(n.id), includeJobs: '1', dates: 'thisFiscalYearToDate' } })}>
            Sales by customer
          </button>
        </div>
        </>
        )}
      </Card>
      <Tabs
        className="sx-cust-detailtabs"
        fill
        active={tab}
        onChange={(k) => setTab(k as typeof tab)}
        tabs={[
          { key: 'txns', label: 'Transactions' },
          { key: 'contacts', label: 'Contacts' },
          { key: 'todos', label: "To Do's" },
          { key: 'notes', label: 'Notes' },
        ]}
      >
        {tab === 'txns' && <CustomerTransactions n={n} show={show} setShow={setShow} filter={filter} setFilter={setFilter} dates={dates} setDates={setDates} />}
        {tab === 'contacts' && <ContactsTab n={n} onEdit={onEdit} />}
        {tab === 'todos' && <TodosTab n={n} />}
        {tab === 'notes' && <NotesTab n={n} />}
      </Tabs>
    </div>
  );
}

/** The row action of a transaction (Receive payment / Create invoice), or null. */
function rowAction(r: TxnSummary): { label: string; run: () => void } | null {
  if ((r.type === 'INV' || r.type === 'STMTCHG') && r.openBalance > 0 && !r.voided && !r.isPending)
    return { label: 'Receive payment', run: () => openWindow('receivePayment', { customerId: r.nameId ?? undefined, invoiceId: r.id }) };
  if (r.type === 'EST' && !r.voided && (r.status === 'Pending' || r.status === 'Accepted' || !r.status)) return { label: 'Create invoice', run: () => openWindow('invoice', { estimateId: r.id }) };
  return null;
}

/**
 * Columns of the transaction lists. The STATUS cell also holds the row action: on hover (or when the
 * row is selected) the action link ("Receive payment", "Create invoice") takes the place of the pill,
 * so the list fits narrow windows.
 */
function txnColumns(withName: boolean, jobs: boolean, prefix: string): ListColumn<TxnSummary>[] {
  const today = todayIso();
  const cols: ListColumn<TxnSummary>[] = [
    ...(withName ? [] : [{ key: 'typeLabel', label: 'TYPE', width: 96, grow: !jobs } as ListColumn<TxnSummary>]),
    { key: 'refNumber', label: 'NUM', width: 60, sortValue: (r) => (/^\d+$/.test(r.refNumber) ? Number(r.refNumber) : r.refNumber) },
    { key: 'date', label: 'DATE', width: 90, type: 'date' },
  ];
  if (withName) cols.push({ key: 'nameFull', label: 'CUSTOMER OR JOB', width: 190, grow: true }, { key: 'dueDate', label: 'DUE DATE', width: 92, type: 'date' });
  else if (jobs) cols.push({ key: 'nameFull', label: 'JOB', width: 116, grow: true, render: (r) => (r.nameFull.startsWith(prefix + ':') ? r.nameFull.slice(prefix.length + 1) : '') });
  else cols.push({ key: 'accountName', label: 'ACCOUNT', width: 120 });
  cols.push(
    { key: 'amount', label: 'AMOUNT', width: 92, type: 'money' },
    { key: 'openBalance', label: 'OPEN BALANCE', width: 108, type: 'money', render: (r) => (r.type === 'INV' || r.type === 'STMTCHG' || r.type === 'CREDMEM' || r.type === 'PMT' ? fmtMoney(r.openBalance) : '') },
    {
      key: 'status',
      label: 'STATUS',
      width: 128,
      sortValue: (r) => displayStatus(r, today),
      render: (r) => {
        const act = rowAction(r);
        return (
          <span className={'sx-cust-statuscell' + (act ? ' sx-has-action' : '')}>
            <StatusPill status={displayStatus(r, today)} />
            {act && (
              <button type="button" className="sx-cust-rowlink" onMouseDown={(e) => e.stopPropagation()} onClick={act.run}>
                {act.label}
              </button>
            )}
          </span>
        );
      },
    },
  );
  return cols;
}

/** Filters of a transaction list → GET /txns parameters and a client-side filter. */
function listParams(types: TxnType[], filter: string, dates: string, fyStart: number) {
  const p: Parameters<typeof useTxnList>[0] = { types, ...dateRange(dates, fyStart), limit: 2000, sort: '-date' };
  if (filter === 'open' || filter === 'overdue') p.openOnly = true;
  else if (filter === 'paid') p.status = 'Paid';
  else if (filter === 'Closed' || filter === 'Rejected') p.status = filter;
  return p;
}

function CustomerTransactions({
  n,
  show,
  setShow,
  filter,
  setFilter,
  dates,
  setDates,
}: {
  n: Name;
  show: string;
  setShow: (v: string) => void;
  filter: string;
  setFilter: (v: string) => void;
  dates: string;
  setDates: (v: string) => void;
}) {
  const company = useCompanyInfo();
  const fy = company.data?.fiscalYearStartMonth ?? 1;
  const types = SHOW.find((s) => s.value === show)?.types ?? CUSTOMER_TXN_TYPES;
  const params = { ...listParams(types, filter, dates, fy), nameId: n.id, includeJobs: true };
  const q = useTxnList(params);
  const today = todayIso();
  const rowsAll = q.data?.rows ?? [];
  const rows = filter === 'overdue' ? rowsAll.filter((r) => isOverdue(r, today)) : rowsAll;
  const [sel, setSel] = useState<ID | null>(null);
  const hasJobs = useNames('customer', { active: 'all' }).data?.some((x) => x.parentId === n.id) ?? false;
  const filters = filterChoices(show);
  return (
    <div className="sx-cust-txns">
      <div className="sx-cust-txnfilters">
        <label className="sx-cust-flabel">
          SHOW
          <Select
            value={show}
            options={SHOW.map((s) => ({ value: s.value, label: s.label }))}
            onChange={(v) => {
              setShow(v);
              setFilter('all');
            }}
            aria-label="Show"
          />
        </label>
        <label className="sx-cust-flabel">
          FILTER BY
          <Select value={filter} options={filters} onChange={setFilter} aria-label="Filter by" />
        </label>
        <label className="sx-cust-flabel">
          DATE
          <Select value={dates} options={DATE_CHOICES} onChange={setDates} aria-label="Date" />
        </label>
        <span className="sx-cust-txncount">
          {rows.length} {rows.length === 1 ? 'transaction' : 'transactions'}
        </span>
      </div>
      <ListView<TxnSummary>
        aria-label="Customer transactions"
        className="sx-cust-txnlist"
        columns={txnColumns(false, hasJobs, n.fullName)}
        rows={rows}
        loading={q.isLoading}
        selectedKey={sel}
        onSelect={(k) => setSel(k as ID)}
        onActivate={(r) => openTxn(r.type, r.id)}
        rowClassName={(r) => (r.voided ? 'sx-cust-voidrow' : undefined)}
        contextMenu={(r) =>
          r
            ? [
                { label: 'Open', onClick: () => openTxn(r.type, r.id) },
                { label: 'Receive payment', hidden: !((r.type === 'INV' || r.type === 'STMTCHG') && r.openBalance > 0), onClick: () => openWindow('receivePayment', { customerId: r.nameId ?? undefined, invoiceId: r.id }) },
                { label: 'Create invoice from estimate', hidden: r.type !== 'EST', onClick: () => openWindow('invoice', { estimateId: r.id }) },
                { label: 'Transaction journal', onClick: () => openWindow('report', { key: 'journal', params: { txnId: String(r.id), dates: 'all' }, title: 'Transaction Journal' }) },
              ]
            : []
        }
        persistKey="cust-txns"
        emptyText={
          <EmptyState
            compact
            icon={ReceiptText}
            title="No transactions"
            message={show === 'all' && dates === 'all' && filter === 'all' ? 'This customer has no transactions yet.' : 'Nothing matches these filters.'}
            action={{ label: 'Create invoice', onClick: () => openWindow('invoice', { customerId: n.id }) }}
          />
        }
      />
    </div>
  );
}

function ContactsTab({ n, onEdit }: { n: Name; onEdit: () => void }) {
  const person = [n.salutation, n.firstName, n.middleName, n.lastName].filter(Boolean).join(' ');
  const rows: [string, string][] = [
    ['Contact', person],
    ['Job title', n.jobTitle],
    ['Main phone', n.phone],
    ['Alt. phone', n.altPhone],
    ['Mobile', n.mobile],
    ['Fax', n.fax],
    ['Main email', n.email],
    ['CC email', n.ccEmail],
    ['Website', n.website],
  ];
  const has = rows.some(([, v]) => v);
  return (
    <div className="sx-cust-pad">
      {has ? (
        <div className="sx-cust-contact">
          {rows
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k} className="sx-cust-info-row">
                <span className="sx-cust-info-label">{k}</span>
                <span className="sx-cust-info-value">{k.includes('email') ? <a href={`mailto:${v}`}>{v}</a> : v}</span>
              </div>
            ))}
        </div>
      ) : (
        <EmptyState compact title="No contact details" message="Add a contact person, phone numbers and email addresses for this customer." />
      )}
      <div>
        <Button icon={Pencil} label="Edit contact details" onClick={onEdit} />
      </div>
    </div>
  );
}

function TodosTab({ n }: { n: Name }) {
  const q = useQuery({ queryKey: ['todos', { nameId: n.id }], queryFn: ({ signal }) => api.get<Todo[]>(`/todos?nameId=${n.id}`, { signal }) });
  const [title, setTitle] = useState('');
  const [due, setDue] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api.post<Todo>('/todos', { id: 0, title: title.trim(), notes: '', dueDate: due, nameId: n.id, done: false });
      setTitle('');
      void invalidateAll();
    } catch (e) {
      await alertBox((e as Error).message, 'Warning');
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (t: Todo) => {
    await api.put(`/todos/${t.id}`, { ...t, done: !t.done }).catch((e) => alertBox((e as Error).message, 'Warning'));
    void invalidateAll();
  };
  const list = q.data ?? [];
  return (
    <div className="sx-cust-pad">
      <div className="sx-cust-todoadd">
        <TextField value={title} onChange={setTitle} placeholder={`New to do for ${n.fullName}`} aria-label="To do" onKeyDown={(e) => e.key === 'Enter' && void add()} />
        <DateField value={due} onChange={setDue} width={140} aria-label="Due date" />
        <Button variant="primary" icon={ClipboardList} label="Add to do" onClick={() => void add()} busy={busy} disabled={!title.trim()} />
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : list.length === 0 ? (
        <div className="sx-muted">No to do's for this customer.</div>
      ) : (
        <ul className="sx-cust-todos">
          {list.map((t) => (
            <li key={t.id} className={t.done ? 'sx-done' : undefined}>
              <Checkbox checked={t.done} onChange={() => void toggle(t)} label={t.title} />
              <span className={'sx-cust-tododate' + (!t.done && t.dueDate && t.dueDate < todayIso() ? ' sx-tone-text-danger' : '')}>{t.dueDate ? fmtDate(t.dueDate) : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NotesTab({ n }: { n: Name }) {
  const [text, setText] = useState(n.notes);
  const [busy, setBusy] = useState(false);
  const dirty = text !== n.notes;
  const save = async () => {
    setBusy(true);
    try {
      const fresh = await api.get<Name>(`/names/${n.id}`);
      await api.put<Name>(`/names/${n.id}`, { ...fresh, notes: text });
      void invalidateAll();
      toast('Notes saved', { kind: 'success' });
    } catch (e) {
      if ((e as { code?: string }).code !== 'cancelled') await alertBox((e as Error).message, 'Warning');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sx-cust-pad sx-cust-notes">
      <TextArea value={text} onChange={setText} aria-label="Notes" placeholder="Notes about this customer (only you see them)." />
      <div className="sx-cust-inline">
        <Button variant="primary" label="Save notes" onClick={() => void save()} disabled={!dirty} busy={busy} />
        {dirty && (
          <Button variant="ghost" label="Discard" onClick={() => setText(n.notes)} />
        )}
        <span className="sx-cust-note">{dirty ? 'Unsaved changes' : ''}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right pane: all transactions of one type

function TypeTransactions({ type }: { type: TxnType }) {
  const company = useCompanyInfo();
  const fy = company.data?.fiscalYearStartMonth ?? 1;
  const [filter, setFilter] = useState('all');
  const [dates, setDates] = useState('thisFiscalYear');
  const [search, setSearch] = useState('');
  useEffect(() => setFilter('all'), [type]);
  const params = { ...listParams([type], filter, dates, fy), q: search.trim() || undefined };
  const q = useTxnList(params);
  const today = todayIso();
  const rowsAll = q.data?.rows ?? [];
  const rows = filter === 'overdue' ? rowsAll.filter((r) => isOverdue(r, today)) : rowsAll;
  const [sel, setSel] = useState<ID | null>(null);
  const label = TXN_TYPES.find((t) => t.type === type)?.label ?? '';
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const newOf: Partial<Record<TxnType, WindowKind>> = { EST: 'estimate', INV: 'invoice', STMTCHG: 'statementCharges', SALESRCPT: 'salesReceipt', PMT: 'receivePayment', CREDMEM: 'creditMemo', REFUND: 'refund' };
  return (
    <div className="sx-cust-detail">
      <div className="sx-cust-typehead">
        <h2>{label}</h2>
        <Button variant="primary" icon={FilePlus2} label={`New ${label.replace(/s$/, '').toLowerCase()}`} onClick={() => { const k = newOf[type]; if (k) openWindow(k, {}); }} />
      </div>
      <div className="sx-cust-txnfilters">
        <label className="sx-cust-flabel">
          FILTER BY
          <Select value={filter} options={filterChoices(type)} onChange={setFilter} aria-label="Filter by" />
        </label>
        <label className="sx-cust-flabel">
          DATE
          <Select value={dates} options={DATE_CHOICES} onChange={setDates} aria-label="Date" />
        </label>
        <SearchBox value={search} onChange={setSearch} placeholder="Number, name, memo or amount" debounce={250} width={240} />
        <span className="sx-cust-txncount">
          {rows.length} {rows.length === 1 ? 'transaction' : 'transactions'} · {money$(total)}
        </span>
      </div>
      <ListView<TxnSummary>
        aria-label={label}
        className="sx-cust-txnlist"
        columns={txnColumns(true, false, '')}
        rows={rows}
        loading={q.isLoading}
        selectedKey={sel}
        onSelect={(k) => setSel(k as ID)}
        onActivate={(r) => openTxn(r.type, r.id)}
        rowClassName={(r) => (r.voided ? 'sx-cust-voidrow' : undefined)}
        persistKey={`cust-type-${type}`}
        emptyText={<EmptyState compact icon={ReceiptText} title={`No ${label.toLowerCase()}`} message="Nothing matches these filters." />}
      />
    </div>
  );
}
