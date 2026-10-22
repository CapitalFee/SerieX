// Money Out: money bar (Open POs, Overdue, Open bills, Paid last 30 days) that
// filters the list, filters VENDOR / TYPE / STATUS / DATE, and one list of purchase orders, item
// receipts, bills, vendor credits and bill payments with a primary action per row (Pay, Create
// bill, Enter bill, Open) and bulk "Pay selected bills".
import { useMemo, useState } from 'react';
import { ChevronDown, FileSpreadsheet, ListChecks, Plus, Wallet } from 'lucide-react';
import { useOpenDocs, useTxnList } from '@/api/hooks';
import type { ID, TxnSummary, TxnType } from '@/api/types';
import {
  Button,
  EmptyState,
  ListView,
  MoneyBar,
  NamePicker,
  SearchBox,
  Select,
  StatusPill,
  Toolbar,
  ToolbarButton,
  ToolbarSpacer,
  ToolSeparator,
  showContextMenu,
  type ListColumn,
  type MenuItem,
} from '@/components';
import { openTxn, openWindow } from '@/windows/windowStore';
import { addDays, resolvePreset, todayIso } from '@/util/dates';
import { downloadCsv } from '@/util/csv';
import { fmtMoney } from '@/util/format';
import { DATE_CHOICES, DATE_COL_WIDTH, STATUS_COL_WIDTH, dateChoiceOptions, txnMenu, txnOpenBalance, txnStatus } from './VendorDetails';
import { sum2, useOpenPOs } from './shared';
import { payBillDialog } from './vendorDialogs';
import './vendors.css';

export interface BillTrackerProps {}

type TypeKey = 'all' | 'bills' | 'po' | 'rcpt' | 'credit' | 'pmt';
type StatusKey = 'all' | 'open' | 'overdue' | 'paid' | 'closed';

const TYPE_OPTIONS: { value: TypeKey; label: string; types: TxnType[] }[] = [
  { value: 'all', label: 'All types', types: ['PURCHORD', 'ITEMRCPT', 'BILL', 'BILLCRED', 'BILLPMT'] },
  { value: 'bills', label: 'Bills', types: ['BILL'] },
  { value: 'po', label: 'Purchase orders', types: ['PURCHORD'] },
  { value: 'rcpt', label: 'Item receipts', types: ['ITEMRCPT'] },
  { value: 'credit', label: 'Vendor credits', types: ['BILLCRED'] },
  { value: 'pmt', label: 'Bill payments', types: ['BILLPMT'] },
];

const STATUS_OPTIONS: { value: StatusKey; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'paid', label: 'Paid' },
  { value: 'closed', label: 'Closed' },
];

function matchStatus(r: TxnSummary, st: StatusKey, today: string): boolean {
  if (st === 'all') return true;
  const s = txnStatus(r, today);
  switch (st) {
    case 'open':
      return !r.voided && (['Open', 'Overdue', 'Partially paid', 'Unapplied', 'Partial', 'Not billed'].includes(s) || (r.type === 'PURCHORD' && s === 'Open'));
    case 'overdue':
      return s === 'Overdue';
    case 'paid':
      return s === 'Paid' || s === 'Applied' || r.type === 'BILLPMT';
    case 'closed':
      return s === 'Closed' || s === 'Paid' || s === 'Applied';
  }
  return true;
}

export default function BillTracker(_props: BillTrackerProps) {
  const today = todayIso();
  const [vendorId, setVendorId] = useState<ID | null>(null);
  const [type, setType] = useState<TypeKey>('all');
  const [status, setStatus] = useState<StatusKey>('open');
  const [dates, setDates] = useState('all');
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState<ID | null>(null);
  const [checked, setChecked] = useState<Set<ID>>(new Set());
  const [bar, setBar] = useState<string | null>(null);

  const range = dates === 'last30' ? { from: addDays(today, -30), to: today } : dates === 'all' ? { from: '', to: '' } : resolvePreset(dates);
  const list = useTxnList({
    types: TYPE_OPTIONS.find((t) => t.value === type)?.types,
    nameId: vendorId ?? undefined,
    from: range.from || undefined,
    to: range.to || undefined,
    q: search || undefined,
    sort: '-date',
    limit: 5000,
  });
  const docs = useOpenDocs({ kind: 'payable' });
  // open purchase orders with what is still to be received / billed on each
  const openPOs = useOpenPOs();
  const paid = useTxnList({ types: ['BILLPMT'], from: addDays(today, -30), to: today, limit: 5000 });

  const bars = useMemo(() => {
    const charges = (docs.data?.charges ?? []).filter((c) => c.openBalance > 0);
    const overdue = charges.filter((c) => (c.dueDate || c.date) < today);
    const p = openPOs.list.filter((r) => !r.voided && r.openBalance > 0);
    const pd = (paid.data?.rows ?? []).filter((r) => !r.voided);
    return {
      po: { n: p.length, amt: sum2(p.map((r) => r.openBalance)) },
      overdue: { n: overdue.length, amt: sum2(overdue.map((c) => c.openBalance)) },
      open: { n: charges.length, amt: sum2(charges.map((c) => c.openBalance)) },
      paid: { n: pd.length, amt: sum2(pd.map((r) => r.amount)) },
    };
  }, [docs.data, openPOs.list, paid.data, today]);

  const rows = useMemo(() => (list.data?.rows ?? []).filter((r) => matchStatus(r, status, today)), [list.data, status, today]);
  const checkedBills = rows.filter((r) => checked.has(r.id) && r.type === 'BILL' && r.openBalance > 0 && !r.voided);

  const applyBar = (k: string | null) => {
    setBar(k);
    setChecked(new Set());
    if (k === 'po') {
      setType('po');
      setStatus('open');
      setDates('all');
    } else if (k === 'overdue') {
      setType('bills');
      setStatus('overdue');
      setDates('all');
    } else if (k === 'open') {
      setType('bills');
      setStatus('open');
      setDates('all');
    } else if (k === 'paid') {
      setType('pmt');
      setStatus('all');
      setDates('last30');
    } else {
      setType('all');
      setStatus('open');
      setDates('all');
    }
  };

  const payOne = async (r: TxnSummary) => {
    await payBillDialog({ id: r.id, vendorId: r.nameId!, vendorName: r.nameFull, refNumber: r.refNumber, dueDate: r.dueDate, openBalance: r.openBalance });
  };

  const primary = (r: TxnSummary): { label: string; run: () => void } => {
    if (!r.voided && r.type === 'BILL' && r.openBalance > 0) return { label: 'Pay', run: () => void payOne(r) };
    if (!r.voided && r.type === 'PURCHORD' && r.status !== 'Closed') return { label: 'Create bill', run: () => openWindow('bill', { poId: r.id }) };
    if (!r.voided && r.type === 'ITEMRCPT') return { label: 'Enter bill', run: () => openWindow('bill', { id: r.id, enterBill: true, billDate: todayIso() }) };
    return { label: 'Open', run: () => openTxn(r.type, r.id) };
  };

  const columns: ListColumn<TxnSummary>[] = [
    {
      key: 'chk',
      label: '',
      width: 30,
      sortable: false,
      render: (r) =>
        r.type === 'BILL' && r.openBalance > 0 && !r.voided ? (
          <input
            type="checkbox"
            className="vx-rowchk"
            aria-label={`Select bill ${r.refNumber}`}
            checked={checked.has(r.id)}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) =>
              setChecked((s) => {
                const n = new Set(s);
                if (e.target.checked) n.add(r.id);
                else n.delete(r.id);
                return n;
              })
            }
          />
        ) : null,
    },
    // "Purchase Order" / "Bill Pmt -Check" need about 111 px
    { key: 'typeLabel', label: 'TYPE', width: 112 },
    { key: 'nameFull', label: 'VENDOR', width: 170, grow: true },
    { key: 'refNumber', label: 'NUMBER', width: 96 },
    { key: 'date', label: 'DATE', width: DATE_COL_WIDTH, type: 'date' },
    { key: 'dueDate', label: 'DUE DATE', width: DATE_COL_WIDTH, type: 'date' },
    { key: 'amount', label: 'AMOUNT', width: 82, type: 'money' },
    {
      key: 'openBalance',
      label: 'OPEN BAL.',
      width: 82,
      type: 'money',
      sortValue: (r) => txnOpenBalance(r, openPOs.openById) ?? 0,
      render: (r) => {
        const v = txnOpenBalance(r, openPOs.openById);
        return v === null ? '' : fmtMoney(v);
      },
    },
    { key: 'status', label: 'STATUS', width: STATUS_COL_WIDTH, sortValue: (r) => txnStatus(r, today), render: (r) => <StatusPill status={txnStatus(r, today) || (r.type === 'BILLPMT' ? 'Paid' : '')} /> },
    {
      key: 'action',
      label: 'ACTION',
      width: 110,
      sortable: false,
      render: (r) => {
        const p = primary(r);
        return (
          <span className="vx-actcell" onMouseDown={(e) => e.stopPropagation()}>
            <button type="button" className="vx-actbtn" onClick={p.run}>
              {p.label}
            </button>
            <button
              type="button"
              className="vx-actbtn vx-actmore"
              aria-label="More actions"
              onClick={(e) => {
                const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
                showContextMenu({ x: b.left, y: b.bottom }, txnMenu(r, (x) => void payOne(x)));
              }}
            >
              <ChevronDown size={13} />
            </button>
          </span>
        );
      },
    },
  ];

  const newItems: MenuItem[] = [
    { label: '&Bill', onClick: () => openWindow('bill') },
    { label: '&Purchase order', onClick: () => openWindow('purchaseOrder') },
    { label: '&Receive items', onClick: () => openWindow('receiveItems') },
    { label: 'Vendor &credit', onClick: () => openWindow('bill', { credit: true }) },
  ];

  const totalAmt = sum2(rows.map((r) => r.amount));
  // open balance of bills, credits and receipts (and of purchase orders when only POs are listed)
  const totalOpen = sum2(rows.filter((r) => r.type !== 'PURCHORD' || type === 'po').map((r) => txnOpenBalance(r, openPOs.openById) ?? 0));
  const dateOptions = [...dateChoiceOptions().slice(0, 1), { value: 'last30', label: 'Last 30 days' }, ...dateChoiceOptions().slice(1)];

  return (
    <div className="vx-center vx-tracker">
      <Toolbar aria-label="Money Out">
        <ToolbarButton label="New" icon={Plus} color="#2563eb" menu={newItems} />
        <ToolbarButton label="Pay bills" icon={Wallet} color="#16a34a" onClick={() => openWindow('payBills')} />
        <ToolSeparator />
        <ToolbarButton label="Vendors" icon={ListChecks} onClick={() => openWindow('vendorCenter')} />
        <ToolbarButton
          label="Export"
          icon={FileSpreadsheet}
          color="#16a34a"
          onClick={() =>
            downloadCsv('Money Out', [
              ['Type', 'Vendor', 'Number', 'Date', 'Due Date', 'Amount', 'Open Balance', 'Status'],
              ...rows.map((r) => [r.typeLabel, r.nameFull, r.refNumber, r.date, r.dueDate, r.amount, r.openBalance, txnStatus(r, today)]),
            ])
          }
        />
        <ToolbarSpacer />
      </Toolbar>
      <MoneyBar
        className="vx-moneybar"
        aria-label="Bills money bar"
        selected={bar}
        onSelect={applyBar}
        segments={[
          { key: 'po', label: 'Open POs', count: bars.po.n, amount: bars.po.amt, color: 'info', group: 'Unbilled' },
          { key: 'overdue', label: 'Overdue', count: bars.overdue.n, amount: bars.overdue.amt, color: 'danger', group: 'Unpaid' },
          { key: 'open', label: 'Open bills', count: bars.open.n, amount: bars.open.amt, color: 'warning', group: 'Unpaid' },
          { key: 'paid', label: 'Paid', count: bars.paid.n, amount: bars.paid.amt, color: 'success', group: 'Paid', groupNote: 'Last 30 days' },
        ]}
      />
      <div className="vx-tracker-body">
        <div className="vx-filterbar vx-tracker-filters">
          <span className="vx-fpair">
            <label className="vx-pb-cap" htmlFor="vx-bt-vendor">
              Vendor
            </label>
            <NamePicker id="vx-bt-vendor" kinds={['vendor']} value={vendorId} onChange={(id) => setVendorId(id)} placeholder="All vendors" width={170} addNew={false} />
          </span>
          <span className="vx-fpair">
            <label className="vx-pb-cap" htmlFor="vx-bt-type">
              Type
            </label>
            <Select
              id="vx-bt-type"
              value={type}
              options={TYPE_OPTIONS.map((t) => ({ value: t.value, label: t.label }))}
              onChange={(v) => {
                setType(v as TypeKey);
                setBar(null);
              }}
            />
          </span>
          <span className="vx-fpair">
            <label className="vx-pb-cap" htmlFor="vx-bt-status">
              Status
            </label>
            <Select
              id="vx-bt-status"
              value={status}
              options={STATUS_OPTIONS}
              onChange={(v) => {
                setStatus(v as StatusKey);
                setBar(null);
              }}
            />
          </span>
          <span className="vx-fpair">
            <label className="vx-pb-cap" htmlFor="vx-bt-date">
              Date
            </label>
            <Select
              id="vx-bt-date"
              value={dates === 'last30' || DATE_CHOICES.includes(dates) ? dates : 'all'}
              options={dateOptions}
              onChange={(v) => {
                setDates(v);
                setBar(null);
              }}
            />
          </span>
          <SearchBox value={search} onChange={setSearch} placeholder="Number or memo" aria-label="Find by number or memo" debounce={250} width={170} />
        </div>
        {checkedBills.length > 0 && (
          <div className="vx-bulkbar">
            <span>
              {checkedBills.length} bill{checkedBills.length === 1 ? '' : 's'} selected · {fmtMoney(sum2(checkedBills.map((r) => r.openBalance)))}
            </span>
            <Button small variant="primary" icon={Wallet} label="Pay selected bills" onClick={() => openWindow('payBills', { billIds: checkedBills.map((r) => r.id) })} />
            <Button small variant="ghost" label="Clear" onClick={() => setChecked(new Set())} />
          </div>
        )}
        <ListView<TxnSummary>
          className="vx-fill vx-tracker-list"
          aria-label="Bills and purchase orders"
          columns={columns}
          rows={rows}
          loading={list.isLoading}
          selectedKey={sel}
          onSelect={(k) => setSel(k as ID)}
          onActivate={(r) => openTxn(r.type, r.id)}
          contextMenu={(r) => txnMenu(r, (x) => void payOne(x))}
          rowClassName={(r) => (r.voided ? 'vx-lv-void' : undefined)}
          persistKey="bill-tracker2"
          emptyText={
            <EmptyState
              compact
              title="Nothing to show"
              message={status === 'overdue' ? 'No bills are overdue. Nice!' : 'No transactions match these filters.'}
              action={{ label: 'Show everything', onClick: () => { setType('all'); setStatus('all'); setDates('all'); setVendorId(null); setSearch(''); setBar(null); } }}
            />
          }
        />
        <div className="vx-leftfoot vx-tracker-foot">
          <span>
            {rows.length} transaction{rows.length === 1 ? '' : 's'}
            {list.data && list.data.total > (list.data.rows.length ?? 0) ? ` (first ${list.data.rows.length} of ${list.data.total})` : ''}
          </span>
          <span>
            Amount {fmtMoney(totalAmt)} · Open balance {fmtMoney(totalOpen)}
          </span>
        </div>
      </div>
    </div>
  );
}
