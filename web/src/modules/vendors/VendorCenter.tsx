// Vendors window: toolbar (New Vendor, New Transactions ▾, Print ▾, Export ▾, Money Out, Pay Bills),
// money bar (Purchase orders, Overdue, Open bills, Paid last 30 days — clickable
// filters), left pane tabs "Vendors" (list with view filter, search, bulk select, hover actions)
// and "Transactions" (by type); right pane: vendor information + Transactions / Contacts /
// To Do's / Notes, or the transactions of the chosen type.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FileSpreadsheet,
  ListChecks,
  MoreHorizontal,
  Plus,
  Printer,
  Receipt,
  Truck,
  Wallet,
} from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll, useOpenDocs, useTxnList } from '@/api/hooks';
import type { ID, Name, TxnSummary } from '@/api/types';
import {
  Button,
  DropdownButton,
  EmptyState,
  ListView,
  MoneyBar,
  SearchBox,
  Select,
  Splitter,
  Tabs,
  Toolbar,
  ToolbarButton,
  ToolSeparator,
  CREATED_EVENT,
  alertBox,
  confirmBox,
  showContextMenu,
  toast,
  useHotkeys,
  type ListColumn,
  type MenuItem,
} from '@/components';
import { formatAddress } from '@/components/inputs';
import { openTxn, openWindow } from '@/windows/windowStore';
import { addDays, resolvePreset, todayIso } from '@/util/dates';
import { downloadCsv } from '@/util/csv';
import { escHtml, printHtml } from '@/util/print';
import { fmtDate, fmtMoney } from '@/util/format';
import { DATE_CHOICES, VendorDetails, VENDOR_TXN_TYPES, dateChoiceOptions, txnColumnsFor, txnMenu, txnStatus, usePaneWidth } from './VendorDetails';
import { openVendorActivity, sum2, useOpenPOs, useVendors } from './shared';
import { payBillDialog } from './vendorDialogs';
import './vendors.css';

export interface VendorCenterProps {
  selectId?: number;
}

type View = 'active' | 'all' | 'inactive' | 'balance' | 'overdue' | 'po' | 'paid';

const VIEW_OPTIONS: { value: View; label: string }[] = [
  { value: 'active', label: 'Active vendors' },
  { value: 'all', label: 'All vendors' },
  { value: 'inactive', label: 'Inactive vendors' },
  { value: 'balance', label: 'Vendors with open balances' },
  { value: 'overdue', label: 'Vendors with overdue bills' },
  { value: 'po', label: 'Vendors with open purchase orders' },
  { value: 'paid', label: 'Vendors paid in the last 30 days' },
];

type LeftTab = 'vendors' | 'txns';

/** Smallest widths of the left pane (per left tab) and of the right pane. */
const leftMin = (tab: LeftTab) => (tab === 'txns' ? 180 : 220);
const SPLIT_MIN_SECOND = 360;

/** localStorage key of the left pane width the user dragged the divider to (per left tab). */
const splitKey = (tab: LeftTab) => `sx.split.vendor-center.${tab}`;

/**
 * Width of the left pane: the width the user dragged it to, else a default from the room in the
 * window (about a third for the vendor list, 300-400 px; about a fifth for the short list of
 * transaction types). Only a dragged width is remembered, so a larger screen gets a larger default.
 */
function leftPaneWidth(tab: LeftTab, bodyWidth: number): number {
  try {
    const v = Number(localStorage.getItem(splitKey(tab)));
    if (v > 0) return v;
  } catch {
    /* no storage: default width */
  }
  return tab === 'txns' ? Math.round(Math.min(260, Math.max(190, bodyWidth * 0.22))) : Math.round(Math.min(400, Math.max(300, bodyWidth * 0.34)));
}

/** Vendor row of the left list with the money bar aggregates. */
interface VendorRow {
  id: ID;
  v: Name;
  name: string;
  balance: number;
  overdue: number;
  po: number;
  paid30: number;
}

export default function VendorCenter(props: VendorCenterProps) {
  const today = todayIso();
  const { list: vendors, loading } = useVendors();
  const docs = useOpenDocs({ kind: 'payable' });
  // open purchase orders with what is still to be received / billed on each
  const openPOs = useOpenPOs();
  const paid = useTxnList({ types: ['BILLPMT'], from: addDays(today, -30), to: today, limit: 5000 });
  const [leftTab, setLeftTab] = useState<LeftTab>('vendors');
  // room for the two panes (the body's 12 px side padding excluded)
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyWidth = Math.max(0, usePaneWidth(bodyRef) - 24);
  useEffect(() => {
    try {
      // width saved by earlier versions even when it was only the default
      localStorage.removeItem('sx.split.vendor-center2');
    } catch {
      /* ignore */
    }
  }, []);
  /**
   * Divider drag: remember the width the user chose. It is worked out from the mouse like the
   * splitter does (its last move may not be on screen yet when the button is released).
   */
  const onSplitDragStart = (e: React.MouseEvent<HTMLDivElement>) => {
    const bar = (e.target as HTMLElement).closest<HTMLElement>('.sx-split-bar');
    const splitter = bar?.parentElement;
    if (e.button !== 0 || !bar || !splitter || splitter.parentElement !== bodyRef.current) return;
    const tab = leftTab;
    const box = splitter.getBoundingClientRect();
    let moved = false;
    const move = () => {
      moved = true;
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (!moved) return;
      const size = Math.max(leftMin(tab), Math.min(box.width - SPLIT_MIN_SECOND - 5, ev.clientX - box.left));
      try {
        localStorage.setItem(splitKey(tab), String(Math.round(size)));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const [view, setView] = useState<View>('active');
  const [search, setSearch] = useState('');
  const [selId, setSelId] = useState<ID | null>(props.selectId ?? null);
  const [checked, setChecked] = useState<Set<ID>>(new Set());
  const [txnType, setTxnType] = useState('bill');
  const [pendingSelect, setPendingSelect] = useState<ID | null>(null);

  useEffect(() => {
    if (props.selectId) {
      setSelId(props.selectId);
      setLeftTab('vendors');
    }
  }, [props.selectId]);

  // a vendor created anywhere (New Vendor dialog, quick create) becomes the selected one
  useEffect(() => {
    const onCreated = (e: Event) => {
      const d = (e as CustomEvent<{ kind: string; id: ID }>).detail;
      if (d?.kind !== 'name') return;
      setPendingSelect(d.id);
    };
    window.addEventListener(CREATED_EVENT, onCreated);
    return () => window.removeEventListener(CREATED_EVENT, onCreated);
  }, []);
  useEffect(() => {
    if (pendingSelect && vendors.some((v) => v.id === pendingSelect)) {
      setSelId(pendingSelect);
      setLeftTab('vendors');
      setPendingSelect(null);
    }
  }, [pendingSelect, vendors]);

  // ---- aggregates per vendor
  const agg = useMemo(() => {
    const m = new Map<ID, { overdue: number; overdueN: number; open: number; openN: number; po: number; poN: number; paid: number; paidN: number }>();
    const get = (id: ID) => {
      let a = m.get(id);
      if (!a) m.set(id, (a = { overdue: 0, overdueN: 0, open: 0, openN: 0, po: 0, poN: 0, paid: 0, paidN: 0 }));
      return a;
    };
    for (const c of docs.data?.charges ?? []) {
      if (c.openBalance <= 0) continue;
      const a = get(c.nameId);
      a.open += c.openBalance;
      a.openN++;
      if ((c.dueDate || c.date) < today) {
        a.overdue += c.openBalance;
        a.overdueN++;
      }
    }
    for (const p of openPOs.list) {
      if (!p.nameId || p.voided || p.openBalance <= 0) continue;
      const a = get(p.nameId);
      a.po += p.openBalance;
      a.poN++;
    }
    for (const p of paid.data?.rows ?? []) {
      if (!p.nameId || p.voided) continue;
      const a = get(p.nameId);
      a.paid += p.amount;
      a.paidN++;
    }
    return m;
  }, [docs.data, openPOs.list, paid.data, today]);

  const totals = useMemo(() => {
    let overdue = 0,
      overdueN = 0,
      open = 0,
      openN = 0,
      po = 0,
      poN = 0,
      paidAmt = 0,
      paidN = 0;
    agg.forEach((a) => {
      overdue += a.overdue;
      overdueN += a.overdueN;
      open += a.open;
      openN += a.openN;
      po += a.po;
      poN += a.poN;
      paidAmt += a.paid;
      paidN += a.paidN;
    });
    return { overdue, overdueN, open, openN, po, poN, paid: paidAmt, paidN };
  }, [agg]);

  const rows: VendorRow[] = useMemo(() => {
    const q = search.trim().toLowerCase();
    return vendors
      .map((v) => {
        const a = agg.get(v.id);
        return { id: v.id, v, name: v.name, balance: v.balance, overdue: a?.overdue ?? 0, po: a?.po ?? 0, paid30: a?.paid ?? 0 };
      })
      .filter((r) => {
        const v = r.v;
        switch (view) {
          case 'active':
            if (!v.active) return false;
            break;
          case 'inactive':
            if (v.active) return false;
            break;
          case 'balance':
            if (!r.balance) return false;
            break;
          case 'overdue':
            if (!r.overdue) return false;
            break;
          case 'po':
            if (!r.po) return false;
            break;
          case 'paid':
            if (!r.paid30) return false;
            break;
        }
        if (!q) return true;
        return [v.name, v.companyName, v.firstName, v.lastName, v.email, v.phone, v.accountNumber].some((s) => (s ?? '').toLowerCase().includes(q));
      });
  }, [vendors, agg, view, search]);

  const selected = vendors.find((v) => v.id === selId) ?? null;

  // the selection follows the filtered list (first vendor when the selected one is filtered out)
  useEffect(() => {
    if (leftTab !== 'vendors' || pendingSelect) return;
    if (rows.length && (!selId || !rows.some((r) => r.id === selId))) setSelId(rows[0].id);
  }, [rows, selId, leftTab, pendingSelect]);

  const moneySel: string | null = view === 'po' ? 'po' : view === 'overdue' ? 'overdue' : view === 'balance' ? 'open' : view === 'paid' ? 'paid' : null;

  // ---- actions
  const payBill = async (r: TxnSummary) => {
    await payBillDialog({ id: r.id, vendorId: r.nameId!, vendorName: r.nameFull, refNumber: r.refNumber, dueDate: r.dueDate, openBalance: r.openBalance });
  };
  const setActive = async (v: Name, active: boolean) => {
    try {
      await api.put(`/names/${v.id}/active`, { active });
      void invalidateAll();
      toast(`${v.name} is now ${active ? 'active' : 'inactive'}`);
    } catch (e) {
      if ((e as { code?: string }).code !== 'cancelled') await alertBox((e as Error).message, 'Vendor');
    }
  };
  const deleteVendor = async (v: Name) => {
    if (!(await confirmBox(`Delete the vendor "${v.name}"? This cannot be undone.`, 'Delete Vendor'))) return;
    try {
      await api.del(`/names/${v.id}`);
      void invalidateAll();
      toast(`Vendor "${v.name}" deleted`, { kind: 'info' });
      setSelId(null);
    } catch (e) {
      if ((e as { code?: string }).code !== 'cancelled') await alertBox((e as Error).message, 'Delete Vendor');
    }
  };
  const vendorMenu = (v: Name | null): MenuItem[] => {
    if (!v)
      return [
        { label: '&New vendor…', onClick: () => openWindow('vendorEdit') },
        { label: 'Show &all vendors', onClick: () => setView('all') },
      ];
    return [
      { label: '&Edit vendor…', shortcut: 'Ctrl+E', onClick: () => openWindow('vendorEdit', { id: v.id }) },
      { label: '&New vendor…', onClick: () => openWindow('vendorEdit') },
      { label: v.active ? 'Make vendor &inactive' : 'Make vendor &active', onClick: () => void setActive(v, !v.active) },
      { label: '&Delete vendor', shortcut: 'Ctrl+D', onClick: () => void deleteVendor(v) },
      { separator: true },
      { label: 'Enter &bill', onClick: () => openWindow('bill', { vendorId: v.id }) },
      { label: '&Pay bills', onClick: () => openWindow('payBills', { vendorId: v.id }) },
      { label: 'Create &purchase order', onClick: () => openWindow('purchaseOrder', { vendorId: v.id }) },
      { label: 'Write &check', onClick: () => openWindow('writeCheck', { payeeId: v.id }) },
      { label: 'Enter vendor c&redit', onClick: () => openWindow('bill', { vendorId: v.id, credit: true }) },
      { separator: true },
      { label: '&Activity Report', shortcut: 'Ctrl+Q', onClick: () => openVendorActivity(v) },
    ];
  };

  useHotkeys({
    'ctrl+e': () => {
      if (selected) openWindow('vendorEdit', { id: selected.id });
    },
    'ctrl+q': () => {
      if (selected) openVendorActivity(selected);
    },
    'ctrl+d': () => {
      if (selected && leftTab === 'vendors') void deleteVendor(selected);
    },
  });

  // ---- print / export
  const printList = () => {
    const body = `<h1>Vendor List</h1><table><thead><tr><th>Vendor</th><th>Phone</th><th>Email</th><th class="num">Balance</th></tr></thead><tbody>${rows
      .map((r) => `<tr><td>${escHtml(r.name)}</td><td>${escHtml(r.v.phone)}</td><td>${escHtml(r.v.email)}</td><td class="num">${fmtMoney(r.balance)}</td></tr>`)
      .join('')}</tbody><tfoot><tr><td colspan="3" class="bold">Total</td><td class="num bold">${fmtMoney(sum2(rows.map((r) => r.balance)))}</td></tr></tfoot></table>`;
    void printHtml('Vendor List', body);
  };
  const printVendor = async () => {
    if (!selected) return;
    const tx = await api.get<{ rows: TxnSummary[] }>(`/txns?nameId=${selected.id}&sort=-date&limit=500`);
    const body = `<h1>${escHtml(selected.name)}</h1><p>${escHtml(formatAddress(selected.companyName, selected.billAddress)).replace(/\n/g, '<br>')}</p>
      <p>Phone: ${escHtml(selected.phone)} &nbsp; Email: ${escHtml(selected.email)} &nbsp; Open balance: ${fmtMoney(selected.balance)}</p>
      <table><thead><tr><th>Type</th><th>Num</th><th>Date</th><th>Due</th><th class="num">Amount</th><th class="num">Open</th></tr></thead><tbody>${tx.rows
        .map((r) => `<tr><td>${escHtml(r.typeLabel)}</td><td>${escHtml(r.refNumber)}</td><td>${fmtDate(r.date)}</td><td>${fmtDate(r.dueDate)}</td><td class="num">${fmtMoney(r.amount)}</td><td class="num">${fmtMoney(r.openBalance, { blankZero: true })}</td></tr>`)
        .join('')}</tbody></table>`;
    void printHtml(selected.name, body);
  };
  const exportList = () =>
    downloadCsv('Vendors', [
      ['Vendor', 'Company', 'Phone', 'Email', 'Account No.', 'Balance', 'Active'],
      ...rows.map((r) => [r.name, r.v.companyName, r.v.phone, r.v.email, r.v.accountNumber, r.balance, r.v.active ? 'Yes' : 'No']),
    ]);
  const exportTxns = async () => {
    const id = selected?.id;
    const tx = await api.get<{ rows: TxnSummary[] }>(leftTab === 'vendors' && id ? `/txns?nameId=${id}&sort=-date&limit=5000` : `/txns?types=${VENDOR_TXN_TYPES.find((t) => t.key === txnType)?.types.join(',')}&sort=-date&limit=5000`);
    downloadCsv(leftTab === 'vendors' && selected ? `${selected.name} transactions` : 'Vendor transactions', [
      ['Type', 'Vendor', 'Num', 'Date', 'Due Date', 'Account', 'Amount', 'Open Balance', 'Status'],
      ...tx.rows.map((r) => [r.typeLabel, r.nameFull, r.refNumber, r.date, r.dueDate, r.accountName, r.amount, r.openBalance, txnStatus(r)]),
    ]);
  };

  // ---- bulk
  const toggleCheck = (id: ID, on: boolean) =>
    setChecked((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const bulkInactive = async (active: boolean) => {
    const ids = [...checked];
    for (const id of ids) await api.put(`/names/${id}/active`, { active }).catch(() => undefined);
    setChecked(new Set());
    void invalidateAll();
    toast(`${ids.length} vendor${ids.length === 1 ? '' : 's'} made ${active ? 'active' : 'inactive'}`);
  };
  const bulkExport = () => {
    const list = rows.filter((r) => checked.has(r.id));
    downloadCsv('Selected vendors', [['Vendor', 'Company', 'Phone', 'Email', 'Balance'], ...list.map((r) => [r.name, r.v.companyName, r.v.phone, r.v.email, r.balance])]);
  };

  const vcols: ListColumn<VendorRow>[] = [
    {
      key: 'chk',
      label: '',
      width: 30,
      sortable: false,
      render: (r) => (
        <input
          type="checkbox"
          className="vx-rowchk"
          aria-label={`Select ${r.name}`}
          checked={checked.has(r.id)}
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => toggleCheck(r.id, e.target.checked)}
        />
      ),
    },
    { key: 'name', label: 'NAME', width: 120, grow: true },
    {
      key: 'balance',
      label: 'BALANCE',
      title: 'Balance total (what you owe the vendor)',
      width: 80,
      type: 'money',
      render: (r) => <span className={r.overdue > 0 ? 'vx-danger-text' : undefined} title={r.overdue > 0 ? `${fmtMoney(r.overdue)} overdue` : undefined}>{fmtMoney(r.balance, { blankZero: true }) || '0.00'}</span>,
    },
    {
      key: 'act',
      label: '',
      width: 26,
      sortable: false,
      render: (r) => (
        <button
          type="button"
          className="vx-rowact"
          aria-label={`Actions for ${r.name}`}
          title="Actions"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            setSelId(r.id);
            const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
            showContextMenu({ x: b.left, y: b.bottom }, vendorMenu(r.v));
          }}
        >
          <MoreHorizontal size={15} />
        </button>
      ),
    },
  ];

  const newTxnItems = (v: Name | null): MenuItem[] => [
    { label: 'Enter &bills', onClick: () => openWindow('bill', v ? { vendorId: v.id } : {}) },
    { label: '&Pay bills', onClick: () => openWindow('payBills', v ? { vendorId: v.id } : {}) },
    { label: 'Purchase &orders', onClick: () => openWindow('purchaseOrder', v ? { vendorId: v.id } : {}) },
    { label: '&Receive items', onClick: () => openWindow('receiveItems', v ? { vendorId: v.id } : {}) },
    { label: 'Enter bill for recei&ved items', onClick: () => openWindow('enterBillForReceived') },
    { label: 'Vendor &credit', onClick: () => openWindow('bill', v ? { vendorId: v.id, credit: true } : { credit: true }) },
    { separator: true },
    { label: 'Write &checks', onClick: () => openWindow('writeCheck', v ? { payeeId: v.id } : {}) },
    { label: 'Credit card c&harges', onClick: () => openWindow('ccCharge') },
  ];

  const leftPane = (
    <div className="vx-left">
      <Tabs
        variant="strip"
        className="vx-lefttabs"
        active={leftTab}
        onChange={(k) => setLeftTab(k as 'vendors' | 'txns')}
        tabs={[
          { key: 'vendors', label: 'Vendors' },
          { key: 'txns', label: 'Transactions' },
        ]}
      />
      {leftTab === 'vendors' ? (
        <>
          <div className="vx-leftfilters">
            <Select value={view} options={VIEW_OPTIONS} onChange={(v) => setView(v as View)} aria-label="View" />
            <SearchBox value={search} onChange={setSearch} placeholder="Find a vendor" debounce={120} />
          </div>
          {checked.size > 0 && (
            <div className="vx-bulkbar">
              <span>{checked.size} selected</span>
              <Button small variant="ghost" label="Make inactive" onClick={() => void bulkInactive(false)} />
              <Button small variant="ghost" label="Export" onClick={bulkExport} />
              <Button small variant="ghost" label="Clear" onClick={() => setChecked(new Set())} />
            </div>
          )}
          <ListView<VendorRow>
            className="vx-fill vx-vendorlist"
            aria-label="Vendors"
            columns={vcols}
            rows={rows}
            loading={loading}
            selectedKey={selId}
            onSelect={(k) => setSelId(k as ID)}
            onActivate={(r) => openWindow('vendorEdit', { id: r.id })}
            contextMenu={(r) => vendorMenu(r?.v ?? null)}
            isInactive={(r) => !r.v.active}
            showInactiveColumn={view === 'all' || view === 'inactive'}
            indentKey="name"
            persistKey="vc-vendors3"
            emptyText={
              vendors.length === 0 ? (
                <EmptyState compact icon={Truck} title="No vendors yet" message="Vendors are the people and companies you buy from." action={{ label: 'Add a vendor', onClick: () => openWindow('vendorEdit') }} />
              ) : (
                <EmptyState compact title="No vendors match" message="Try another view or clear the search." action={{ label: 'Show all vendors', onClick: () => { setView('all'); setSearch(''); } }} />
              )
            }
          />
          <div className="vx-leftfoot">
            {rows.length} vendor{rows.length === 1 ? '' : 's'} · {fmtMoney(sum2(rows.map((r) => r.balance)))} owed
          </div>
        </>
      ) : (
        <div className="vx-typelist" role="listbox" aria-label="Transaction types">
          {VENDOR_TXN_TYPES.filter((t) => t.key !== 'all').map((t) => (
            <button key={t.key} type="button" role="option" aria-selected={txnType === t.key} className={'vx-typeitem' + (txnType === t.key ? ' vx-on' : '')} onClick={() => setTxnType(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const rightPane =
    leftTab === 'txns' ? (
      <TypeTxns typeKey={txnType} payBill={(r) => void payBill(r)} />
    ) : selected ? (
      <VendorDetails vendor={selected} payBill={(r) => void payBill(r)} />
    ) : (
      <EmptyState
        icon={Truck}
        title={vendors.length ? 'Select a vendor' : 'Add your first vendor'}
        message={vendors.length ? 'Pick a vendor on the left to see their details and transactions.' : 'Vendors are the people and companies you buy from: suppliers, contractors, utilities, landlords.'}
        action={{ label: 'New vendor', onClick: () => openWindow('vendorEdit') }}
      />
    );

  return (
    <div className="vx-center" data-testid="vendor-center">
      <Toolbar aria-label="Vendor Center">
        <ToolbarButton label="New vendor" icon={Plus} color="#2563eb" onClick={() => openWindow('vendorEdit')} />
        <ToolbarButton label="New transactions" icon={Receipt} color="#7c3aed" menu={newTxnItems(leftTab === 'vendors' ? selected : null)} />
        <ToolSeparator />
        <ToolbarButton
          label="Print"
          icon={Printer}
          menu={[
            { label: 'Vendor &list', onClick: printList },
            { label: 'Vendor &information', disabled: !selected, onClick: () => void printVendor() },
          ]}
        />
        <ToolbarButton
          label="Export"
          icon={FileSpreadsheet}
          color="#16a34a"
          menu={[
            { label: 'Export vendor &list', onClick: exportList },
            { label: 'Export &transactions', onClick: () => void exportTxns() },
            { separator: true },
            { label: '&Import vendors from a CSV file…', onClick: () => openWindow('importData', { entity: 'vendors' }) },
          ]}
        />
        <ToolSeparator />
        <ToolbarButton label="Money Out" icon={ListChecks} onClick={() => openWindow('billTracker')} />
        <ToolbarButton label="Pay bills" icon={Wallet} color="#16a34a" onClick={() => openWindow('payBills')} />
      </Toolbar>
      <MoneyBar
        className="vx-moneybar"
        aria-label="Vendor money bar"
        selected={moneySel}
        onSelect={(k) => {
          setLeftTab('vendors');
          setView(k === 'po' ? 'po' : k === 'overdue' ? 'overdue' : k === 'open' ? 'balance' : k === 'paid' ? 'paid' : 'active');
        }}
        segments={[
          { key: 'po', label: 'Open POs', count: totals.poN, amount: totals.po, color: 'info', group: 'Unbilled' },
          { key: 'overdue', label: 'Overdue', count: totals.overdueN, amount: totals.overdue, color: 'danger', group: 'Unpaid' },
          { key: 'open', label: 'Open bills', count: totals.openN, amount: totals.open, color: 'warning', group: 'Unpaid' },
          { key: 'paid', label: 'Paid', count: totals.paidN, amount: totals.paid, color: 'success', group: 'Paid', groupNote: 'Last 30 days' },
        ]}
      />
      <div className="vx-center-body" ref={bodyRef} onMouseDownCapture={onSplitDragStart}>
        {bodyWidth > 0 && (
          // one splitter per left tab: the short type list of the Transactions tab needs less room
          <Splitter key={leftTab} initial={leftPaneWidth(leftTab, bodyWidth)} min={leftMin(leftTab)} minSecond={SPLIT_MIN_SECOND}>
            {leftPane}
            <div className="vx-right">{rightPane}</div>
          </Splitter>
        )}
      </div>
    </div>
  );
}

/** Right pane of the Transactions tab: every vendor transaction of one type. */
function TypeTxns({ typeKey, payBill }: { typeKey: string; payBill: (r: TxnSummary) => void }) {
  const def = VENDOR_TXN_TYPES.find((t) => t.key === typeKey) ?? VENDOR_TXN_TYPES[0];
  const { openById: poOpen } = useOpenPOs();
  const [filter, setFilter] = useState<'all' | 'open'>('all');
  const [dates, setDates] = useState('thisFiscalYearToDate');
  const [sel, setSel] = useState<ID | null>(null);
  const range = dates === 'all' ? { from: '', to: '' } : resolvePreset(dates);
  const q = useTxnList({ types: def.types, openOnly: filter === 'open', from: range.from || undefined, to: range.to || undefined, sort: '-date', limit: 2000 });
  const rows = q.data?.rows ?? [];
  return (
    <div className="vx-details">
      <div className="vx-typehead">
        <h2 className="vx-info-name">{def.label}</h2>
        <span className="vx-muted">{q.data ? `${q.data.total} transaction${q.data.total === 1 ? '' : 's'} · ${fmtMoney(sum2(rows.map((r) => r.amount)))}` : ''}</span>
      </div>
      <div className="vx-filterbar">
        <span className="vx-fpair">
          <label className="vx-pb-cap" htmlFor="vx-tt-filter">
            Filter by
          </label>
          <Select
            id="vx-tt-filter"
            value={filter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'open', label: typeKey === 'po' ? 'Open POs' : 'Open' },
            ]}
            onChange={(v) => setFilter(v as 'all' | 'open')}
          />
        </span>
        <span className="vx-fpair">
          <label className="vx-pb-cap" htmlFor="vx-tt-date">
            Date
          </label>
          <Select id="vx-tt-date" value={DATE_CHOICES.includes(dates) ? dates : 'all'} options={dateChoiceOptions()} onChange={setDates} />
        </span>
      </div>
      <ListView<TxnSummary>
        className="vx-fill"
        aria-label={def.label}
        columns={txnColumnsFor(typeKey, true, poOpen)}
        rows={rows}
        loading={q.isLoading}
        selectedKey={sel}
        onSelect={(k) => setSel(k as ID)}
        onActivate={(r) => openTxn(r.type, r.id)}
        contextMenu={(r) => txnMenu(r, payBill)}
        rowClassName={(r) => (r.voided ? 'vx-lv-void' : undefined)}
        persistKey="vc-typetxns3"
        emptyText={<EmptyState compact title={`No ${def.label.toLowerCase()}`} message="Nothing matches these filters." />}
      />
    </div>
  );
}
