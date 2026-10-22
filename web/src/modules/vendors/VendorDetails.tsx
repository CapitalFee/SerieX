// Right side of the Vendor Center for one vendor: information card (with report links) and the
// Transactions | Contacts | To Do's | Notes tabs.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { CalendarClock, Mail, MapPin, Pencil, Phone, Plus } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { invalidateAll, queryClient, useList, useTxnList, type TxnListParams } from '@/api/hooks';
import type { ID, Name, Todo, TxnSummary, TxnType } from '@/api/types';
import { Button, Checkbox, DateField, EmptyState, ListView, Select, StatusPill, Tabs, TextArea, TextField, toast, type ListColumn } from '@/components';
import { openTxn, openWindow } from '@/windows/windowStore';
import { DATE_PRESETS, resolvePreset, todayIso } from '@/util/dates';
import { fmtDate, fmtMoney } from '@/util/format';
import { formatAddress } from '@/components/inputs';
import { billStatus, openReport, openVendorActivity, useOpenPOs } from './shared';
import './vendors.css';

/** "Show" choices of the vendor transactions list. */
export const VENDOR_TXN_TYPES: { key: string; label: string; types: TxnType[] }[] = [
  { key: 'all', label: 'All transactions', types: ['PURCHORD', 'ITEMRCPT', 'BILL', 'BILLCRED', 'BILLPMT', 'CHK', 'CCCHARGE', 'CCCREDIT', 'TAXPMT'] },
  { key: 'po', label: 'Purchase orders', types: ['PURCHORD'] },
  { key: 'rcpt', label: 'Item receipts', types: ['ITEMRCPT'] },
  { key: 'bill', label: 'Bills', types: ['BILL'] },
  { key: 'credit', label: 'Vendor credits', types: ['BILLCRED'] },
  { key: 'pmt', label: 'Bill payments', types: ['BILLPMT'] },
  { key: 'chk', label: 'Checks', types: ['CHK'] },
  { key: 'cc', label: 'Credit card activities', types: ['CCCHARGE', 'CCCREDIT'] },
  { key: 'tax', label: 'Sales tax payments', types: ['TAXPMT'] },
];

/** Date filter choices (subset of the report presets, plus "All"). */
export const DATE_CHOICES = ['all', 'thisMonthToDate', 'thisMonth', 'lastMonth', 'thisFiscalQuarterToDate', 'thisFiscalYearToDate', 'thisFiscalYear', 'lastFiscalYear'];

export function dateChoiceOptions() {
  return DATE_CHOICES.map((k) => ({ value: k, label: k === 'all' ? 'All dates' : DATE_PRESETS.find((p) => p.key === k)?.label ?? k }));
}

/** Status shown in transaction lists. */
export function txnStatus(r: TxnSummary, today = todayIso()): string {
  if (r.voided) return 'Void';
  if (r.type === 'BILL' || r.type === 'BILLCRED' || r.type === 'ITEMRCPT') return billStatus(r, today);
  if (r.type === 'PURCHORD') return r.status === 'Closed' ? 'Closed' : 'Open';
  if (r.toBePrinted) return 'To print';
  return '';
}

/** Which columns a transaction list shows. */
export interface TxnColumnOptions {
  vendor?: boolean;
  type?: boolean;
  dueDate?: boolean;
  account?: boolean;
  open?: boolean;
  status?: boolean;
  /** Open balance of open purchase orders by id (from useOpenPOs): shown in OPEN BAL. for POs. */
  poOpen?: Map<ID, number>;
  /** Width of TYPE (default: 134, or at least 112 when it takes the spare width). */
  typeWidth?: number;
  /** Width of NUM (default 96 in roomy lists, else 72). */
  numWidth?: number;
}

/** Width of a date column: "09/30/2026" (about 74 px) plus the cell padding (16 px). */
export const DATE_COL_WIDTH = 90;

/** Width of a STATUS column: the widest pill, "Partially paid" (102 px), plus the cell padding. */
export const STATUS_COL_WIDTH = 118;

/** What is still open on a transaction of a vendor list (null: nothing to show). */
export function txnOpenBalance(r: TxnSummary, poOpen?: Map<ID, number>): number | null {
  if (r.voided) return null;
  if (['BILL', 'BILLCRED', 'ITEMRCPT'].includes(r.type)) return r.openBalance;
  // purchase orders: the amount not received or billed yet (GET /open-pos)
  if (r.type === 'PURCHORD' && poOpen) return r.status === 'Closed' ? 0 : poOpen.get(r.id) ?? 0;
  return null;
}

/** Columns of a transaction list. */
export function txnColumns(o: TxnColumnOptions = {}): ListColumn<TxnSummary>[] {
  const { vendor = false, type = true, dueDate = true, account = true, open = true, status = true, poOpen } = o;
  const cols: ListColumn<TxnSummary>[] = [];
  // TYPE takes the spare width when no VENDOR / ACCOUNT column does ("Purchase Order" needs 111 px,
  // "Credit Card Charge" 133 px); else NUM does ("CLS-260824" needs 95 px)
  const typeGrows = type && !vendor && !account;
  const numGrows = !type && !vendor && !account;
  if (type) cols.push({ key: 'typeLabel', label: 'TYPE', width: o.typeWidth ?? (typeGrows ? 112 : 134), grow: typeGrows });
  if (vendor) cols.push({ key: 'nameFull', label: 'VENDOR', width: 170, grow: true });
  cols.push({ key: 'refNumber', label: 'NUM', width: o.numWidth ?? (vendor || numGrows ? 96 : 72), grow: numGrows });
  cols.push({ key: 'date', label: 'DATE', width: DATE_COL_WIDTH, type: 'date' });
  if (dueDate) cols.push({ key: 'dueDate', label: 'DUE DATE', width: DATE_COL_WIDTH, type: 'date' });
  if (account) cols.push({ key: 'accountName', label: 'ACCOUNT', width: vendor ? 150 : 128, grow: !vendor });
  cols.push({ key: 'amount', label: 'AMOUNT', width: 80, type: 'money' });
  if (open)
    cols.push({
      key: 'openBalance',
      label: 'OPEN BAL.',
      width: 80,
      type: 'money',
      sortValue: (r) => txnOpenBalance(r, poOpen) ?? 0,
      render: (r) => {
        const v = txnOpenBalance(r, poOpen);
        return v === null ? '' : fmtMoney(v);
      },
    });
  if (status) cols.push({ key: 'status', label: 'STATUS', width: STATUS_COL_WIDTH, sortValue: (r) => txnStatus(r), render: (r) => <StatusPill status={txnStatus(r)} /> });
  return cols;
}

/**
 * Column set for a list of one kind of transaction. `wide` is the width of the list in px (or
 * true / false: wide / narrow). A narrow all-transactions list leaves out ACCOUNT (below
 * {@link ACCOUNT_COLUMN_FROM}) and then DUE DATE (below {@link DUE_COLUMN_FROM}) rather than
 * cutting every column; they come back when the list is wider.
 */
export function txnColumnsFor(typeKey: string, vendor: boolean, poOpen?: Map<ID, number>, wide: boolean | number = true): ListColumn<TxnSummary>[] {
  switch (typeKey) {
    case 'bill':
      return txnColumns({ vendor, type: false, account: false });
    case 'credit':
      return txnColumns({ vendor, type: false, account: false, dueDate: false });
    case 'rcpt':
      return txnColumns({ vendor, type: false, account: false, dueDate: false });
    case 'po':
      return txnColumns({ vendor, type: false, account: false, dueDate: false, open: !!poOpen, poOpen });
    case 'pmt':
    case 'chk':
    case 'tax':
      return txnColumns({ vendor, type: false, dueDate: false, open: false });
    case 'cc':
      return txnColumns({ vendor, dueDate: false, open: false, status: false });
    default: {
      const w = typeof wide === 'number' ? wide : wide ? Infinity : ACCOUNT_COLUMN_FROM - 1;
      if (vendor || w >= ACCOUNT_COLUMN_FROM) return txnColumns({ vendor, poOpen, numWidth: 96 });
      // narrower: no ACCOUNT and TYPE takes the spare width; then no DUE DATE. NUM is 96 px wide
      // ("CLS-260824") when TYPE still gets its 112 px, else 72 px.
      const dueDate = w >= DUE_COLUMN_FROM;
      const others = DATE_COL_WIDTH * (dueDate ? 2 : 1) + 80 + 80 + STATUS_COL_WIDTH + SCROLLBAR_WIDTH;
      return txnColumns({ vendor, poOpen, account: false, dueDate, numWidth: w >= others + 112 + 96 ? 96 : 72 });
    }
  }
}

/**
 * Width from which a vendor's all-transactions list shows the ACCOUNT column: every column at its
 * width (816 px) plus a vertical scroll bar.
 */
export const ACCOUNT_COLUMN_FROM = 830;
/** Width of a vertical scroll bar (styles/theme.css). */
const SCROLLBAR_WIDTH = 11;
/**
 * Width from which that list shows DUE DATE: TYPE then still has 134 px ("Credit Card Charge") and
 * NUM 96 px. Narrower, the list is a plain all-transactions list: no due dates (the STATUS
 * of an overdue bill says so; Show: Bills lists them).
 */
export const DUE_COLUMN_FROM = 700;

/** Layout of a pane by its size: compact when short (about 800 px screens), narrow when thin. */
export function usePaneFit(ref: RefObject<HTMLElement | null>, opts: { compactBelow: number; narrowBelow: number }): { compact: boolean; narrow: boolean } {
  const [fit, setFit] = useState({ compact: false, narrow: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      if (!width || !height) return;
      const n = { compact: height < opts.compactBelow, narrow: width < opts.narrowBelow };
      setFit((c) => (c.compact === n.compact && c.narrow === n.narrow ? c : n));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return fit;
}

/**
 * Width of a pane in px (0 until measured), followed while it is resized. `step` rounds it down
 * so that a resize re-renders only every few pixels.
 */
export function usePaneWidth(ref: RefObject<HTMLElement | null>, step = 10): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      if (w) setWidth(Math.floor(w / step) * step);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return width;
}

/** Right-click menu of a transaction row. */
export function txnMenu(r: TxnSummary | null, payBill: (r: TxnSummary) => void) {
  if (!r) return [];
  return [
    { label: '&Open', onClick: () => openTxn(r.type, r.id) },
    ...(r.type === 'BILL' && r.openBalance > 0 && !r.voided ? [{ label: '&Pay bill…', onClick: () => payBill(r) }] : []),
    ...(r.type === 'PURCHORD' && r.status !== 'Closed' && !r.voided
      ? [
          { label: 'Create &bill', onClick: () => openWindow('bill', { poId: r.id }) },
          { label: '&Receive items', onClick: () => openWindow('receiveItems', { poId: r.id }) },
        ]
      : []),
    ...(r.type === 'ITEMRCPT' && !r.voided ? [{ label: '&Enter bill for these items', onClick: () => openWindow('bill', { id: r.id, enterBill: true, billDate: todayIso() }) }] : []),
    { separator: true },
    { label: 'Transaction &journal', onClick: () => openReport('journal', { txnId: String(r.id), dates: 'all' }, 'Transaction Journal') },
  ];
}

export interface VendorDetailsProps {
  vendor: Name;
  payBill: (r: TxnSummary) => void;
}

/** Vendor information card + detail tabs. */
export function VendorDetails({ vendor, payBill }: VendorDetailsProps) {
  const [tab, setTab] = useState<'txns' | 'contacts' | 'todos' | 'notes'>('txns');
  const rootRef = useRef<HTMLDivElement>(null);
  // short windows (1280x720…): a compact card leaves room for the transactions;
  // thin windows: the card's columns are stacked
  const fit = usePaneFit(rootRef, { compactBelow: 580, narrowBelow: 600 });
  const termsList = useList('terms', { active: 'all' });
  const typeList = useList('vendor_type', { active: 'all' });
  const terms = termsList.data?.find((t) => t.id === vendor.termsId)?.name ?? '';
  const vtype = typeList.data?.find((t) => t.id === vendor.typeId)?.name ?? '';
  const fullName = [vendor.salutation, vendor.firstName, vendor.middleName, vendor.lastName].filter(Boolean).join(' ');
  const addr = formatAddress(null, vendor.billAddress);
  const termsRow = (
    <>
      <dt>Terms</dt>
      <dd>{terms || '—'}</dd>
    </>
  );

  return (
    <div className={'vx-details' + (fit.compact ? ' vx-compact' : '') + (fit.narrow ? ' vx-narrow' : '')} ref={rootRef}>
      <section className="vx-infocard">
        <div className="vx-info-head">
          <h2 className="vx-info-name" title={vendor.fullName}>
            {vendor.name}
            {!vendor.active && <StatusPill status="Inactive" className="vx-ml" />}
          </h2>
          <Button small variant="secondary" icon={Pencil} label="Edit" title="Edit vendor (Ctrl+E)" onClick={() => openWindow('vendorEdit', { id: vendor.id })} />
        </div>
        <div className="vx-info-body">
          <dl className="vx-info-grid">
            {vendor.companyName && vendor.companyName !== vendor.name && (
              <>
                <dt>Company name</dt>
                <dd>{vendor.companyName}</dd>
              </>
            )}
            {fullName && (
              <>
                <dt>Contact</dt>
                <dd>{fullName}</dd>
              </>
            )}
            <dt>Billed from</dt>
            <dd className="vx-pre" title={fit.compact ? addr : undefined}>
              {(fit.compact ? addr.replace(/\n+/g, ', ') : addr) || '—'}
            </dd>
            {/* compact card: terms move under the (shorter) address to even out the columns */}
            {fit.compact && termsRow}
          </dl>
          <dl className="vx-info-grid vx-info-contact">
            <dt>Main phone</dt>
            <dd>{vendor.phone || '—'}</dd>
            <dt>Main email</dt>
            <dd title={vendor.email || undefined}>{vendor.email ? <a href={`mailto:${vendor.email}`}>{vendor.email}</a> : '—'}</dd>
            {!fit.compact && termsRow}
            <dt>Account no.</dt>
            <dd>{vendor.accountNumber || '—'}</dd>
            {vtype && (
              <>
                <dt>Vendor type</dt>
                <dd>{vtype}</dd>
              </>
            )}
          </dl>
          <div className="vx-info-side">
            <div className="vx-info-bal">
              <span className="sx-label">Open balance</span>
              <strong className={vendor.balance > 0 ? '' : 'vx-muted'}>{fmtMoney(vendor.balance)}</strong>
            </div>
            <div className="vx-info-links">
              <span className="sx-label">Reports for this vendor</span>
              <button type="button" className="sx-linkbtn" onClick={() => openVendorActivity(vendor)}>
                Vendor Activity
              </button>
              <button type="button" className="sx-linkbtn" onClick={() => openReport('vendor_balance_detail', { nameIds: String(vendor.id), dates: 'all' }, `Open Balance: ${vendor.name}`)}>
                Open balance
              </button>
              <button type="button" className="sx-linkbtn" onClick={() => openReport('purchases_by_vendor_detail', { vendorIds: String(vendor.id), nameIds: String(vendor.id), dates: 'thisFiscalYearToDate' }, `Purchases: ${vendor.name}`)}>
                Purchases this year
              </button>
            </div>
          </div>
        </div>
      </section>
      <Tabs
        className="vx-detail-tabs"
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
        {tab === 'txns' && <VendorTxns vendor={vendor} payBill={payBill} />}
        {tab === 'contacts' && <VendorContacts vendor={vendor} />}
        {tab === 'todos' && <VendorTodos vendor={vendor} />}
        {tab === 'notes' && <VendorNotes vendor={vendor} />}
      </Tabs>
    </div>
  );
}

function VendorTxns({ vendor, payBill }: { vendor: Name; payBill: (r: TxnSummary) => void }) {
  const { openById: poOpen } = useOpenPOs();
  const paneRef = useRef<HTMLDivElement>(null);
  // the list's columns follow its width (ACCOUNT, then DUE DATE are left out when it is narrow)
  const paneWidth = usePaneWidth(paneRef, 1);
  const [show, setShow] = useState('all');
  const [filter, setFilter] = useState<'all' | 'open'>('all');
  const [dates, setDates] = useState('all');
  const [sel, setSel] = useState<ID | null>(null);
  const range = dates === 'all' ? { from: '', to: '' } : resolvePreset(dates);
  const params: TxnListParams = {
    nameId: vendor.id,
    types: VENDOR_TXN_TYPES.find((t) => t.key === show)?.types,
    openOnly: filter === 'open',
    from: range.from || undefined,
    to: range.to || undefined,
    sort: '-date',
    limit: 1000,
  };
  const q = useTxnList(params);
  const rows = q.data?.rows ?? [];
  return (
    <div className="vx-txnpane" ref={paneRef}>
      <div className="vx-filterbar">
        <span className="vx-fpair">
          <label className="vx-pb-cap" htmlFor="vx-vt-show">
            Show
          </label>
          <Select id="vx-vt-show" value={show} options={VENDOR_TXN_TYPES.map((t) => ({ value: t.key, label: t.label }))} onChange={setShow} />
        </span>
        <span className="vx-fpair">
          <label className="vx-pb-cap" htmlFor="vx-vt-filter">
            Filter by
          </label>
          <Select
            id="vx-vt-filter"
            value={filter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'open', label: 'Open' },
            ]}
            onChange={(v) => setFilter(v as 'all' | 'open')}
          />
        </span>
        <span className="vx-fpair">
          <label className="vx-pb-cap" htmlFor="vx-vt-date">
            Date
          </label>
          <Select id="vx-vt-date" value={dates} options={dateChoiceOptions()} onChange={setDates} />
        </span>
      </div>
      <ListView<TxnSummary>
        className="vx-fill"
        aria-label="Vendor transactions"
        columns={txnColumnsFor(show, false, poOpen, paneWidth || true)}
        rows={rows}
        loading={q.isLoading}
        selectedKey={sel}
        onSelect={(k) => setSel(k as ID)}
        onActivate={(r) => openTxn(r.type, r.id)}
        contextMenu={(r) => txnMenu(r, payBill)}
        rowClassName={(r) => (r.voided ? 'vx-lv-void' : undefined)}
        persistKey="vc-txns3"
        emptyText={
          <EmptyState
            compact
            title="No transactions"
            message={show === 'all' && filter === 'all' && dates === 'all' ? `Nothing has been entered for ${vendor.name} yet.` : 'Nothing matches these filters.'}
            action={{ label: 'Enter a bill', onClick: () => openWindow('bill', { vendorId: vendor.id }) }}
          />
        }
      />
      {q.data && q.data.total > 0 && (
        <div className="vx-leftfoot">
          {q.data.total} transaction{q.data.total === 1 ? '' : 's'}
          {filter === 'open' ? ` · ${fmtMoney(rows.reduce((a, r) => a + (['BILL', 'BILLCRED', 'ITEMRCPT'].includes(r.type) && !r.voided ? r.openBalance : 0), 0))} open` : ''}
        </div>
      )}
    </div>
  );
}

function VendorContacts({ vendor }: { vendor: Name }) {
  const fullName = [vendor.salutation, vendor.firstName, vendor.middleName, vendor.lastName].filter(Boolean).join(' ');
  const rows: { icon: React.ReactNode; label: string; value: React.ReactNode }[] = [
    { icon: <Phone size={14} />, label: 'Main phone', value: vendor.phone },
    { icon: <Phone size={14} />, label: 'Mobile', value: vendor.mobile },
    { icon: <Phone size={14} />, label: 'Alt. phone', value: vendor.altPhone },
    { icon: <Phone size={14} />, label: 'Fax', value: vendor.fax },
    { icon: <Mail size={14} />, label: 'Main email', value: vendor.email ? <a href={`mailto:${vendor.email}`}>{vendor.email}</a> : '' },
    { icon: <Mail size={14} />, label: 'CC email', value: vendor.ccEmail },
    { icon: <MapPin size={14} />, label: 'Website', value: vendor.website },
  ].filter((r) => !!r.value);
  return (
    <div className="vx-contacts">
      <div className="vx-contact-card">
        <div className="vx-contact-name">{fullName || vendor.companyName || vendor.name}</div>
        {vendor.jobTitle && <div className="vx-muted">{vendor.jobTitle}</div>}
        {rows.length === 0 ? (
          <p className="vx-muted">No contact details yet.</p>
        ) : (
          <dl className="vx-contact-list">
            {rows.map((r) => (
              <div key={r.label}>
                <dt>
                  {r.icon} {r.label}
                </dt>
                <dd>{r.value}</dd>
              </div>
            ))}
          </dl>
        )}
        <Button small icon={Pencil} label="Edit contact details" onClick={() => openWindow('vendorEdit', { id: vendor.id })} />
      </div>
    </div>
  );
}

function VendorTodos({ vendor }: { vendor: Name }) {
  const q = useQuery({ queryKey: ['todos', { nameId: vendor.id }], queryFn: () => api.get<Todo[]>(`/todos?nameId=${vendor.id}`) });
  const [title, setTitle] = useState('');
  const [due, setDue] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api.post<Todo>('/todos', { id: 0, title: title.trim(), notes: '', dueDate: due, nameId: vendor.id, done: false });
      setTitle('');
      void queryClient.invalidateQueries({ queryKey: ['todos'] });
      toast('To do added');
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (t: Todo) => {
    await api.put(`/todos/${t.id}`, { ...t, done: !t.done });
    void queryClient.invalidateQueries({ queryKey: ['todos'] });
  };
  const todos = q.data ?? [];
  return (
    <div className="vx-todos">
      <div className="vx-todo-add">
        <TextField
          value={title}
          placeholder={`New to do for ${vendor.name}…`}
          aria-label="To do"
          onChange={setTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
        />
        <DateField value={due} onChange={setDue} width={150} aria-label="Due date" />
        <Button small variant="primary" icon={Plus} label="Add" disabled={!title.trim()} busy={busy} onClick={() => void add()} />
      </div>
      {todos.length === 0 ? (
        <EmptyState compact icon={CalendarClock} title="No to do's" message="Add reminders about this vendor, such as calls to make or orders to follow up." />
      ) : (
        <ul className="vx-todo-list">
          {todos.map((t) => (
            <li key={t.id} className={t.done ? 'vx-done' : undefined}>
              <Checkbox checked={t.done} onChange={() => void toggle(t)} label={t.title} />
              <span className={'vx-todo-date' + (!t.done && t.dueDate && t.dueDate < todayIso() ? ' vx-danger-text' : '')}>{fmtDate(t.dueDate)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function VendorNotes({ vendor }: { vendor: Name }) {
  const [text, setText] = useState(vendor.notes ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(vendor.notes ?? ''), [vendor.id, vendor.notes]);
  const changed = useMemo(() => text !== (vendor.notes ?? ''), [text, vendor.notes]);
  const save = async () => {
    setBusy(true);
    try {
      const full = await api.get<Name>(`/names/${vendor.id}`);
      await api.put<Name>(`/names/${vendor.id}`, { ...full, notes: text });
      void invalidateAll();
      toast('Notes saved');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="vx-notes">
      <TextArea value={text} onChange={setText} aria-label="Notes" placeholder="Notes about this vendor (account contacts, delivery days, special terms…)" />
      <div className="vx-notes-bar">
        <span className="vx-muted">{changed ? 'Unsaved changes' : ''}</span>
        <Button small label="Revert" disabled={!changed} onClick={() => setText(vendor.notes ?? '')} />
        <Button small variant="primary" label="Save notes" disabled={!changed} busy={busy} onClick={() => void save()} />
      </div>
    </div>
  );
}
