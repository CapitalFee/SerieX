// Money In: the money bar (Estimates, Unbilled activity, Overdue, Open invoices, Paid last
// 30 days) as filters over one list of sales transactions, with CUSTOMER OR JOB, TYPE, STATUS and DATE
// filters, an ACTION ▾ menu per row (Receive payment, Open, Print, Create invoice) and batch actions.
import { useMemo, useState } from 'react';
import { ChevronDown, FilePlus2, RotateCcw, TrendingUp } from 'lucide-react';
import { api } from '@/api/client';
import { useCompanyInfo, useItemsById, usePrefValues, useTxnList } from '@/api/hooks';
import type { ID, Txn, TxnSummary, TxnType } from '@/api/types';
import { Button, DropdownButton, EmptyState, ListView, MoneyBar, NamePicker, Select, StatusPill, showContextMenu, toast, type ListColumn, type MenuItem } from '@/components';
import { openTxn, openWindow } from '@/windows/windowStore';
import { downloadCsv } from '@/util/csv';
import { addDays, resolvePreset, todayIso } from '@/util/dates';
import { fmtDate, fmtMoney } from '@/util/format';
import { useMoneyBar, type BillableRow } from './centerData';
import { printSalesForm } from './printing';
import { displayStatus, isOverdue, money$ } from './shared';
import './customers.css';

export interface IncomeTrackerProps {}

type Seg = 'estimates' | 'unbilled' | 'overdue' | 'open' | 'paid';

const TYPES: { value: string; label: string; types: TxnType[] }[] = [
  { value: 'all', label: 'All types', types: ['EST', 'INV', 'STMTCHG', 'SALESRCPT', 'PMT', 'CREDMEM'] },
  { value: 'EST', label: 'Estimates', types: ['EST'] },
  { value: 'INV', label: 'Invoices', types: ['INV'] },
  { value: 'STMTCHG', label: 'Statement charges', types: ['STMTCHG'] },
  { value: 'SALESRCPT', label: 'Sales receipts', types: ['SALESRCPT'] },
  { value: 'PMT', label: 'Received payments', types: ['PMT'] },
  { value: 'CREDMEM', label: 'Credit memos', types: ['CREDMEM'] },
  { value: 'received', label: 'Payments and sales receipts', types: ['PMT', 'SALESRCPT'] },
];
const STATUSES = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'paid', label: 'Paid' },
  { value: 'Pending', label: 'Pending (estimates)' },
  { value: 'Accepted', label: 'Accepted (estimates)' },
  { value: 'Closed', label: 'Closed (estimates)' },
];
const DATES = [
  { value: 'all', label: 'All dates' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'last365', label: 'Last 365 days' },
  { value: 'thisMonth', label: 'This month' },
  { value: 'thisFiscalQuarter', label: 'This fiscal quarter' },
  { value: 'thisFiscalYear', label: 'This fiscal year' },
  { value: 'lastMonth', label: 'Last month' },
  { value: 'lastFiscalYear', label: 'Last fiscal year' },
];

const PRINTABLE: Partial<Record<TxnType, { title: string; num: string }>> = {
  INV: { title: 'Invoice', num: 'Invoice #' },
  EST: { title: 'Estimate', num: 'Estimate #' },
  SALESRCPT: { title: 'Sales Receipt', num: 'Sale No.' },
  CREDMEM: { title: 'Credit Memo', num: 'Credit No.' },
};

export default function IncomeTracker(_props: IncomeTrackerProps) {
  const prefs = usePrefValues();
  const itemsById = useItemsById();
  const fy = useCompanyInfo().data?.fiscalYearStartMonth ?? 1;
  const money = useMoneyBar();
  const [seg, setSeg] = useState<Seg | null>(null);
  const [cust, setCust] = useState<ID | null>(null);
  const [type, setType] = useState('all');
  const [status, setStatus] = useState('all');
  const [dates, setDates] = useState('last365');
  const [sel, setSel] = useState<ID | null>(null);
  const [checked, setChecked] = useState<Set<ID>>(new Set());
  const today = todayIso();

  const range = useMemo(() => {
    if (dates === 'all') return {};
    if (dates === 'last30') return { from: addDays(today, -30), to: today };
    if (dates === 'last365') return { from: addDays(today, -365), to: today };
    const r = resolvePreset(dates, today, fy);
    return { from: r.from || undefined, to: r.to || undefined };
  }, [dates, today, fy]);

  const types = TYPES.find((t) => t.value === type)?.types ?? TYPES[0].types;
  const q = useTxnList(
    {
      types,
      nameId: cust ?? undefined,
      includeJobs: true,
      ...range,
      openOnly: status === 'open' || status === 'overdue' ? true : undefined,
      status: status === 'paid' ? 'Paid' : ['Pending', 'Accepted', 'Closed'].includes(status) ? status : undefined,
      limit: 3000,
      sort: '-date',
    },
    { enabled: seg !== 'unbilled' },
  );
  const rows = useMemo(() => {
    let r = q.data?.rows ?? [];
    if (status === 'overdue') r = r.filter((x) => isOverdue(x, today));
    if (seg === 'open') r = r.filter((x) => !isOverdue(x, today));
    return r;
  }, [q.data, status, today, seg]);

  // money bar segment → filters
  const pickSeg = (k: string | null) => {
    const s = k as Seg | null;
    setSeg(s);
    setChecked(new Set());
    if (!s) {
      setType('all');
      setStatus('all');
      setDates('last365');
      return;
    }
    if (s === 'estimates') {
      setType('EST');
      setStatus('open');
      setDates('all');
    } else if (s === 'overdue') {
      setType('all');
      setCust(null);
      setStatus('overdue');
      setDates('all');
    } else if (s === 'open') {
      setType('all');
      setStatus('open');
      setDates('all');
    } else if (s === 'paid') {
      setType('received');
      setStatus('all');
      setDates('last30');
    }
  };

  const printOne = async (r: TxnSummary) => {
    const p = PRINTABLE[r.type];
    if (!p) return;
    const t = await api.get<Txn>(`/txns/${r.id}`);
    await printSalesForm(t, { title: p.title, numberLabel: p.num, itemsById, taxEnabled: prefs.salesTaxEnabled, paymentsApplied: r.type === 'INV' ? t.amount - t.openBalance : undefined });
  };
  const actions = (r: TxnSummary): MenuItem[] => {
    const open = (r.type === 'INV' || r.type === 'STMTCHG') && r.openBalance > 0 && !r.voided && !r.isPending;
    return [
      { label: 'Receive payment', hidden: !open, onClick: () => openWindow('receivePayment', { customerId: r.nameId ?? undefined, invoiceId: r.id }) },
      { label: 'Create invoice', hidden: !(r.type === 'EST' && !r.voided && r.status !== 'Closed' && r.status !== 'Rejected'), onClick: () => openWindow('invoice', { estimateId: r.id }) },
      { label: 'Open', onClick: () => openTxn(r.type, r.id) },
      { label: 'Print', hidden: !PRINTABLE[r.type], onClick: () => void printOne(r) },
      { label: 'Customers', hidden: !r.nameId, onClick: () => openWindow('customerCenter', { selectId: r.nameId ?? undefined }) },
    ];
  };

  const columns: ListColumn<TxnSummary>[] = [
    {
      key: 'check',
      label: '',
      width: 30,
      sortable: false,
      render: (r) => (
        <input
          type="checkbox"
          className="sx-cust-rowcheck"
          aria-label={`Select ${r.typeLabel} ${r.refNumber}`}
          checked={checked.has(r.id)}
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            const s = new Set(checked);
            if (e.target.checked) s.add(r.id);
            else s.delete(r.id);
            setChecked(s);
          }}
        />
      ),
    },
    { key: 'typeLabel', label: 'TYPE', width: 104 },
    // the columns add up to 1000px, so the list fits at 1280x720 next to the navigation without
    // scrolling sideways; CUSTOMER OR JOB takes what is left (cut names show whole on hover)
    { key: 'nameFull', label: 'CUSTOMER OR JOB', width: 136, grow: true },
    { key: 'refNumber', label: 'NUMBER', width: 70, sortValue: (r) => (/^\d+$/.test(r.refNumber) ? Number(r.refNumber) : r.refNumber) },
    { key: 'date', label: 'DATE', width: 92, type: 'date' },
    { key: 'dueDate', label: 'DUE DATE', width: 92, type: 'date' },
    { key: 'amount', label: 'AMOUNT', width: 92, type: 'money' },
    { key: 'openBalance', label: 'OPEN BALANCE', width: 110, type: 'money', render: (r) => (['INV', 'STMTCHG', 'CREDMEM', 'PMT'].includes(r.type) ? fmtMoney(r.openBalance) : '') },
    // fits "Partially paid"; the rare "Partially applied" ends with an ellipsis (customers.css)
    { key: 'status', label: 'STATUS', width: 124, sortValue: (r) => displayStatus(r, today), render: (r) => <StatusPill status={displayStatus(r, today)} /> },
    {
      key: 'act',
      label: 'ACTION',
      // "Receive payment" and the ▾ button
      width: 150,
      sortable: false,
      render: (r) => {
        const items = actions(r).filter((x) => !x.hidden);
        const main = items[0];
        return (
          <span className="sx-cust-actcell">
            <button type="button" className="sx-cust-actmain" onMouseDown={(e) => e.stopPropagation()} onClick={() => main?.onClick?.()}>
              {main?.label}
            </button>
            {items.length > 1 && (
              <button
                type="button"
                className="sx-cust-actmore"
                aria-label="More actions"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  const b = e.currentTarget.getBoundingClientRect();
                  showContextMenu({ x: b.left - 120, y: b.bottom + 2 }, items.slice(1));
                }}
              >
                <ChevronDown size={13} aria-hidden="true" />
              </button>
            )}
          </span>
        );
      },
    },
  ];

  const billCols: ListColumn<BillableRow>[] = [
    { key: 'date', label: 'DATE', width: 90, type: 'date' },
    { key: 'nameFull', label: 'CUSTOMER OR JOB', width: 200, render: (r) => r.nameFull ?? '' },
    { key: 'txnType', label: 'SOURCE', width: 90, render: (r) => `${r.txnType === 'BILL' ? 'Bill' : r.txnType === 'CHK' ? 'Check' : r.txnType === 'CCCHARGE' ? 'Card charge' : 'Item receipt'} ${r.refNumber}` },
    { key: 'vendorName', label: 'VENDOR', width: 170 },
    { key: 'description', label: 'DESCRIPTION', width: 220, grow: true },
    { key: 'amount', label: 'AMOUNT', width: 100, type: 'money' },
    {
      key: 'act',
      label: 'ACTION',
      width: 130,
      sortable: false,
      render: (r) => (
        <button type="button" className="sx-cust-actmain" onMouseDown={(e) => e.stopPropagation()} onClick={() => openWindow('invoice', r.nameId ? { customerId: r.nameId } : {})}>
          Create invoice
        </button>
      ),
    },
  ];

  const checkedRows = rows.filter((r) => checked.has(r.id));
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const openTotal = rows.reduce((s, r) => s + (['INV', 'STMTCHG'].includes(r.type) ? r.openBalance : 0), 0);

  return (
    <div className="sx-cust-it">
      <div className="sx-cust-it-top">
        <div className="sx-cust-it-title">
          <TrendingUp size={18} aria-hidden="true" />
          <span>Money In</span>
        </div>
        <MoneyBar
          aria-label="Income money bar"
          selected={seg}
          onSelect={pickSeg}
          segments={[
            { key: 'estimates', label: 'Estimates', amount: money.estimates.amount, count: money.estimates.count, color: '#0891b2', group: 'Unbilled' },
            { key: 'unbilled', label: 'Unbilled activity', amount: money.unbilled.amount, count: money.unbilled.count, color: '#7c3aed', group: 'Unbilled' },
            { key: 'overdue', label: 'Overdue', amount: money.overdue.amount, count: money.overdue.count, color: 'danger', group: 'Unpaid' },
            { key: 'open', label: 'Open invoices', amount: money.open.amount, count: money.open.count, color: '#94a3b8', group: 'Unpaid' },
            { key: 'paid', label: 'Paid · 30 days', amount: money.paid.amount, count: money.paid.count, color: 'success', group: 'Paid' },
          ]}
        />
      </div>
      {seg === 'unbilled' ? (
        <div className="sx-cust-it-body">
          <div className="sx-cust-txnfilters">
            <b>Unbilled activity</b>
            <span className="sx-cust-note">Costs marked billable on bills, checks and card charges that are not on an invoice yet. Create the invoice and use “Add time/costs”.</span>
            <span className="sx-cust-txncount">
              {money.billables.length} items · {money$(money.unbilled.amount)}
            </span>
            <Button small variant="ghost" icon={RotateCcw} label="Show all" onClick={() => pickSeg(null)} />
          </div>
          <ListView<BillableRow>
            aria-label="Unbilled activity"
            className="sx-cust-txnlist"
            columns={billCols}
            rows={money.billables}
            getKey={(r) => r.lineId}
            persistKey="it-unbilled"
            emptyText={<EmptyState compact title="Nothing to bill" message="There are no unbilled costs." />}
          />
        </div>
      ) : (
        <div className="sx-cust-it-body">
          <div className="sx-cust-txnfilters">
            <label className="sx-cust-flabel">
              CUSTOMER OR JOB
              <NamePicker kinds={['customer']} value={cust} onChange={(id) => setCust(id)} width={220} placeholder="All customers" addNew={false} aria-label="Customer or job" />
            </label>
            <label className="sx-cust-flabel">
              TYPE
              <Select value={type} options={TYPES.map((t) => ({ value: t.value, label: t.label }))} onChange={(v) => (setType(v), setSeg(null))} aria-label="Type" />
            </label>
            <label className="sx-cust-flabel">
              STATUS
              <Select value={status} options={STATUSES} onChange={(v) => (setStatus(v), setSeg(null))} aria-label="Status" />
            </label>
            <label className="sx-cust-flabel">
              DATE
              <Select value={dates} options={DATES} onChange={(v) => (setDates(v), setSeg(null))} aria-label="Date" />
            </label>
            {(cust || type !== 'all' || status !== 'all' || dates !== 'last365') && <Button small variant="ghost" icon={RotateCcw} label="Clear filters" onClick={() => (setCust(null), pickSeg(null))} />}
            <span className="sx-cust-txncount">
              {rows.length} transactions · {money$(total)}
              {openTotal ? ` · ${money$(openTotal)} open` : ''}
            </span>
          </div>
          {checked.size > 0 && (
            <div className="sx-cust-chipline sx-cust-it-bulk">
              <span className="sx-cust-bulk">
                <b>{checked.size} selected</b>
                <DropdownButton
                  label="Batch actions"
                  items={[
                    {
                      label: '&Print selected forms',
                      onClick: () => {
                        void (async () => {
                          const list = checkedRows.filter((r) => PRINTABLE[r.type]);
                          for (const r of list) await printOne(r);
                          if (!list.length) toast('None of the selected transactions has a printable form.', { kind: 'info' });
                        })();
                      },
                    },
                    {
                      label: 'Create &statements for these customers…',
                      onClick: () => openWindow('createStatements', { customerIds: [...new Set(checkedRows.map((r) => r.nameId).filter((x): x is ID => !!x))] }),
                    },
                    {
                      label: '&Export selected (CSV)',
                      onClick: () =>
                        downloadCsv('Money In', [
                          ['Type', 'Customer or Job', 'Number', 'Date', 'Due Date', 'Amount', 'Open Balance', 'Status'],
                          ...checkedRows.map((r) => [r.typeLabel, r.nameFull, r.refNumber, fmtDate(r.date), fmtDate(r.dueDate), r.amount, r.openBalance, displayStatus(r, today)]),
                        ]),
                    },
                  ]}
                />
                <button type="button" className="sx-linkbtn" onClick={() => setChecked(new Set())}>
                  Clear
                </button>
              </span>
            </div>
          )}
          <ListView<TxnSummary>
            aria-label="Income transactions"
            className="sx-cust-txnlist"
            columns={columns}
            rows={rows}
            loading={q.isLoading}
            selectedKey={sel}
            onSelect={(k) => setSel(k as ID)}
            onActivate={(r) => openTxn(r.type, r.id)}
            contextMenu={(r) => (r ? actions(r) : [])}
            rowClassName={(r) => (r.voided ? 'sx-cust-voidrow' : undefined)}
            persistKey="it-list"
            emptyText={
              <EmptyState
                compact
                title="Nothing here"
                message="No transactions match these filters."
                action={{ label: 'Create invoice', onClick: () => openWindow('invoice', cust ? { customerId: cust } : {}) }}
              />
            }
          />
          <div className="sx-cust-it-foot">
            <Button small icon={FilePlus2} label="New invoice" onClick={() => openWindow('invoice', cust ? { customerId: cust } : {})} />
            <Button small label="Receive payment" onClick={() => openWindow('receivePayment', cust ? { customerId: cust } : {})} />
            {prefs.estimatesEnabled && <Button small label="New estimate" onClick={() => openWindow('estimate', cust ? { customerId: cust } : {})} />}
          </div>
        </div>
      )}
    </div>
  );
}
