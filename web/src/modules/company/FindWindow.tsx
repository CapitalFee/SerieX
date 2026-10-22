// Edit > Find (Ctrl+F): find transactions.
// Simple: transaction type, name, dates, number, amount and text. Advanced: pick filters one by one (Account, Amount, Date, Item, Memo, Name, Number, Status,
// Transaction Type, Text) and see the current choices. Results: DATE, TYPE, NUM, NAME, ACCOUNT,
// MEMO, AMOUNT with Go To (Enter / double-click), Report (Find Report) and Export (CSV).
// Props preset the filters and run the search (Chart of Accounts > Find Transactions in Account
// passes accountId; a name or item can be passed the same way). Opening the window again with other
// props replaces the filters.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, ExternalLink, FileBarChart, RotateCcw, Search, X } from 'lucide-react';
import { api, getCompanyId, qs } from '@/api/client';
import { useCompanyInfo } from '@/api/hooks';
import { TXN_TYPE_LABELS, type ID, type TxnListResult, type TxnSummary, type TxnType } from '@/api/types';
import {
  AccountLabel,
  AccountPicker,
  Button,
  Checkbox,
  DateField,
  EmptyState,
  Field,
  ItemLabel,
  ItemPicker,
  ListView,
  MoneyField,
  NameLabel,
  NamePicker,
  RadioGroup,
  SegmentedControl,
  Select,
  StatusPill,
  TextField,
  type ListColumn,
} from '@/components';
import { useQuery } from '@tanstack/react-query';
import { openTxn, openWindow, useWindowStore } from '@/windows/windowStore';
import { useOptionalWindow } from '@/windows/WindowContext';
import { downloadCsv } from '@/util/csv';
import { DATE_PRESETS, resolvePreset, todayIso } from '@/util/dates';
import { fmtDate } from '@/util/format';
import './company.css';

export interface FindWindowProps {
  advanced?: boolean;
  type?: TxnType;
  /** Transactions with a posting to this account. */
  accountId?: ID;
  /** Transactions of this name (a customer includes its jobs). */
  nameId?: ID;
  /** Transactions with this item. */
  itemId?: ID;
}

type AmountMode = 'any' | 'eq' | 'gte' | 'lte' | 'between';
type Status = '' | 'open' | 'paid' | 'pending' | 'void';

interface Filters {
  types: TxnType[];
  nameId: ID | null;
  accountId: ID | null;
  itemId: ID | null;
  datePreset: string;
  from: string;
  to: string;
  ref: string;
  memo: string;
  q: string;
  amountMode: AmountMode;
  amount: number | null;
  amount2: number | null;
  status: Status;
}

const EMPTY: Filters = {
  types: [],
  nameId: null,
  accountId: null,
  itemId: null,
  datePreset: 'all',
  from: '',
  to: '',
  ref: '',
  memo: '',
  q: '',
  amountMode: 'any',
  amount: null,
  amount2: null,
  status: '',
};

/** Transaction types in the order the Find window lists them. */
const TYPES: TxnType[] = [
  'INV',
  'PMT',
  'SALESRCPT',
  'CREDMEM',
  'STMTCHG',
  'EST',
  'REFUND',
  'DEP',
  'CHK',
  'BILL',
  'BILLCRED',
  'BILLPMT',
  'ITEMRCPT',
  'PURCHORD',
  'CCCHARGE',
  'CCCREDIT',
  'TRANSFER',
  'GENJRNL',
  'INVADJ',
  'TAXPMT',
];

const ADV_FILTERS: { key: string; label: string }[] = [
  { key: 'account', label: 'Account' },
  { key: 'amount', label: 'Amount' },
  { key: 'date', label: 'Date' },
  { key: 'item', label: 'Item' },
  { key: 'memo', label: 'Memo' },
  { key: 'name', label: 'Name' },
  { key: 'number', label: 'Number' },
  { key: 'status', label: 'Paid status' },
  { key: 'type', label: 'Transaction type' },
  { key: 'text', label: 'Text (anywhere)' },
];

const LIMIT = 500;

/** GET /txns parameters of the filters. */
function toParams(f: Filters) {
  const amt =
    f.amountMode === 'eq'
      ? { amountMin: f.amount, amountMax: f.amount }
      : f.amountMode === 'gte'
        ? { amountMin: f.amount }
        : f.amountMode === 'lte'
          ? { amountMax: f.amount }
          : f.amountMode === 'between'
            ? { amountMin: f.amount, amountMax: f.amount2 }
            : {};
  return {
    types: f.types.length ? f.types : undefined,
    nameId: f.nameId,
    includeJobs: f.nameId ? 1 : undefined,
    accountId: f.accountId,
    itemId: f.itemId,
    from: f.from || undefined,
    to: f.to || undefined,
    ref: f.ref.trim() || undefined,
    memo: f.memo.trim() || undefined,
    q: f.q.trim() || undefined,
    openOnly: f.status === 'open' ? 1 : undefined,
    status: f.status === 'paid' ? 'Paid' : f.status === 'pending' ? 'pending' : f.status === 'void' ? 'void' : undefined,
    ...amt,
    sort: '-date',
    limit: LIMIT,
  };
}

/** Filters preset by the window props. */
function presetFilters(p: Pick<FindWindowProps, 'type' | 'accountId' | 'nameId' | 'itemId'>): Filters {
  return { ...EMPTY, types: p.type ? [p.type] : [], accountId: p.accountId ?? null, nameId: p.nameId ?? null, itemId: p.itemId ?? null };
}

const PRESET_PROPS = ['advanced', 'type', 'accountId', 'nameId', 'itemId'] as const;

/** Clear the preset props of the Find window (kept in the window store) after they were applied. */
function consumePresetProps(winId: string) {
  const w = useWindowStore.getState().windows.find((v) => v.id === winId);
  if (!w || !PRESET_PROPS.some((k) => w.props[k] !== undefined)) return;
  const cleared: Record<string, undefined> = {};
  for (const k of PRESET_PROPS) cleared[k] = undefined;
  useWindowStore.setState((s) => ({ windows: s.windows.map((v) => (v.id === winId ? { ...v, props: { ...v.props, ...cleared } } : v)) }));
}

/** Status shown for a transaction: an open invoice or statement charge past its due date is "Overdue". */
function statusOf(r: TxnSummary, today: string): string {
  if (r.voided) return 'Void';
  if ((r.type === 'INV' || r.type === 'STMTCHG') && !r.isPending && r.openBalance > 0 && r.dueDate && r.dueDate < today) return 'Overdue';
  return r.status;
}

export default function FindWindow({ advanced, type, accountId, nameId, itemId }: FindWindowProps) {
  const info = useCompanyInfo();
  const fy = info.data?.fiscalYearStartMonth ?? 1;
  const [mode, setMode] = useState<'simple' | 'advanced'>(advanced || accountId || itemId ? 'advanced' : 'simple');
  const [f, setF] = useState<Filters>(() => presetFilters({ type, accountId, nameId, itemId }));
  const [run, setRun] = useState<Filters>(f);
  const [sel, setSel] = useState<number | null>(null);
  const [adv, setAdv] = useState(accountId ? 'account' : itemId ? 'item' : nameId ? 'name' : 'type');

  // Opened again with props (from another form, or Find Transactions in Account): search for them.
  // The window store merges the props of a new request into the open window's props, so the props
  // given now are the ones that changed.
  const prevProps = useRef({ type, accountId, nameId, itemId });
  useEffect(() => {
    const old = prevProps.current;
    prevProps.current = { type, accountId, nameId, itemId };
    const changed = {
      type: type !== old.type ? type : undefined,
      accountId: accountId !== old.accountId ? accountId : undefined,
      nameId: nameId !== old.nameId ? nameId : undefined,
      itemId: itemId !== old.itemId ? itemId : undefined,
    };
    if (!changed.type && !changed.accountId && !changed.nameId && !changed.itemId) return;
    const n = presetFilters(changed);
    setF(n);
    setRun(n);
    // the left filter list shows the filter of the new request
    if (changed.accountId) setAdv('account');
    else if (changed.itemId) setAdv('item');
    else if (changed.nameId) setAdv('name');
    else if (changed.type) setAdv('type');
    if (changed.accountId || changed.itemId) setMode('advanced');
  }, [type, accountId, nameId, itemId]);
  useEffect(() => {
    if (advanced !== undefined) setMode(advanced ? 'advanced' : 'simple');
  }, [advanced]);
  // Once applied, the preset props are taken off the window. An open window ignores a request whose
  // props equal its own, so without this, asking again for the same account (after Reset, or after
  // the account filter was removed) would show the old filters instead of searching the account.
  const win = useOptionalWindow();
  const winId = win?.id;
  useEffect(() => {
    if (winId) consumePresetProps(winId);
  }, [winId, advanced, type, accountId, nameId, itemId]);

  const params = useMemo(() => toParams(run), [run]);
  const q = useQuery({
    queryKey: ['txns', 'find', params],
    queryFn: () => api.get<TxnListResult>('/txns' + qs(params as Record<string, unknown>)),
    enabled: !!getCompanyId(),
  });
  const rows = q.data?.rows ?? [];
  const selected = rows.find((r) => r.id === sel) ?? null;

  useEffect(() => {
    if (rows.length && (sel === null || !rows.some((r) => r.id === sel))) setSel(rows[0].id);
  }, [rows, sel]);

  const set = (patch: Partial<Filters>) => setF((cur) => ({ ...cur, ...patch }));
  const setPreset = (key: string) => {
    if (key === 'all') set({ datePreset: key, from: '', to: '' });
    else if (key === 'custom') set({ datePreset: key });
    else {
      const r = resolvePreset(key, todayIso(), fy);
      set({ datePreset: key, from: r.from, to: r.to });
    }
  };
  const find = () => setRun({ ...f });
  const reset = () => {
    setF(EMPTY);
    setRun(EMPTY);
  };

  const goTo = (r: TxnSummary | null) => r && openTxn(r.type, r.id);
  const report = () => {
    const p = toParams(run);
    const params: Record<string, string> = {};
    if (p.from || p.to) {
      if (p.from) params.from = p.from;
      params.to = p.to ?? todayIso();
    } else params.dates = 'all';
    if (p.types) params.types = p.types.join(',');
    if (p.nameId) {
      params.nameIds = String(p.nameId);
      params.includeJobs = '1';
    }
    if (p.accountId) params.accountIds = String(p.accountId);
    if (p.itemId) params.itemIds = String(p.itemId);
    if (p.memo) params.memo = p.memo;
    if (p.ref) params.refNumber = p.ref;
    if (p.q) params.q = p.q;
    if ('amountMin' in p && p.amountMin !== null && p.amountMin !== undefined) params.amountMin = String(p.amountMin);
    if ('amountMax' in p && p.amountMax !== null && p.amountMax !== undefined) params.amountMax = String(p.amountMax);
    openWindow('report', { key: 'transaction_list_by_date', params, title: 'Find Report' }, { title: 'Find Report' });
  };
  const exportCsv = () => {
    downloadCsv('Find results.csv', [
      ['Date', 'Type', 'Num', 'Name', 'Account', 'Memo', 'Amount', 'Open balance', 'Status'],
      ...rows.map((r) => [fmtDate(r.date), r.typeLabel, r.refNumber, r.nameFull, r.accountName, r.memo, r.amount, r.openBalance, statusOf(r, today)]),
    ]);
  };

  const today = todayIso();
  const columns: ListColumn<TxnSummary>[] = [
    // fits the widest MM/DD/YYYY date (digits differ in width) with the cell padding
    { key: 'date', label: 'Date', width: 96, type: 'date' },
    { key: 'typeLabel', label: 'Type', width: 120 },
    { key: 'refNumber', label: 'Num', width: 76 },
    { key: 'nameFull', label: 'Name', width: 170 },
    { key: 'accountName', label: 'Account', width: 150 },
    // grows into the free width. The fixed widths add up to 950px, so the list fits the default
    // 1000px floating window (968px list area) even with a vertical scrollbar (11px here, up to 17px
    // elsewhere) and does not scroll sideways
    { key: 'memo', label: 'Memo', width: 130, grow: true },
    {
      key: 'status',
      label: 'Status',
      // fits the widest pill (Overdue, Pending) with the cell padding, so no ellipsis follows it
      width: 108,
      render: (r) => {
        const st = statusOf(r, today);
        return ['Void', 'Overdue', 'Paid', 'Open', 'Pending', 'Closed'].includes(st) ? <StatusPill status={st} /> : null;
      },
      sortValue: (r) => statusOf(r, today),
    },
    { key: 'amount', label: 'Amount', width: 100, type: 'money', align: 'right' },
  ];

  const nameLabel =
    f.types.length === 1 && ['BILL', 'BILLCRED', 'BILLPMT', 'ITEMRCPT', 'PURCHORD'].includes(f.types[0])
      ? 'Vendor'
      : f.types.length === 1 && ['INV', 'PMT', 'CREDMEM', 'EST', 'STMTCHG', 'SALESRCPT', 'REFUND'].includes(f.types[0])
        ? 'Customer or Job'
        : 'Name';

  const dateFields = (
    <>
      <Field label="Date" width={170}>
        <Select
          value={f.datePreset}
          onChange={setPreset}
          options={[...DATE_PRESETS.map((p) => ({ value: p.key, label: p.label })), { value: 'custom', label: 'Custom' }]}
          aria-label="Dates"
        />
      </Field>
      <Field label="From" width={130}>
        <DateField value={f.from} onChange={(v) => set({ from: v, datePreset: 'custom' })} />
      </Field>
      <Field label="To" width={130}>
        <DateField value={f.to} onChange={(v) => set({ to: v, datePreset: 'custom' })} />
      </Field>
    </>
  );

  // current choices of the advanced filters
  const choices: { key: string; label: string; value: React.ReactNode; clear: () => void }[] = [];
  if (f.types.length)
    choices.push({ key: 'type', label: 'Transaction type', value: f.types.map((t) => TXN_TYPE_LABELS[t]).join(', '), clear: () => set({ types: [] }) });
  if (f.nameId) choices.push({ key: 'name', label: 'Name', value: <NameLabel id={f.nameId} />, clear: () => set({ nameId: null }) });
  if (f.accountId) choices.push({ key: 'account', label: 'Account', value: <AccountLabel id={f.accountId} />, clear: () => set({ accountId: null }) });
  if (f.itemId) choices.push({ key: 'item', label: 'Item', value: <ItemLabel id={f.itemId} />, clear: () => set({ itemId: null }) });
  if (f.from || f.to)
    choices.push({
      key: 'date',
      label: 'Date',
      value: `${f.from ? fmtDate(f.from) : 'start'} - ${f.to ? fmtDate(f.to) : 'today'}`,
      clear: () => set({ from: '', to: '', datePreset: 'all' }),
    });
  if (f.amountMode !== 'any' && f.amount !== null)
    choices.push({
      key: 'amount',
      label: 'Amount',
      value:
        f.amountMode === 'between' ? `${f.amount} - ${f.amount2 ?? ''}` : `${f.amountMode === 'eq' ? '=' : f.amountMode === 'gte' ? '>=' : '<='} ${f.amount}`,
      clear: () => set({ amountMode: 'any', amount: null, amount2: null }),
    });
  if (f.ref.trim()) choices.push({ key: 'number', label: 'Number', value: f.ref, clear: () => set({ ref: '' }) });
  if (f.memo.trim()) choices.push({ key: 'memo', label: 'Memo', value: f.memo, clear: () => set({ memo: '' }) });
  if (f.q.trim()) choices.push({ key: 'text', label: 'Text', value: f.q, clear: () => set({ q: '' }) });
  if (f.status)
    choices.push({
      key: 'status',
      label: 'Paid status',
      value: { open: 'Open', paid: 'Paid', pending: 'Pending', void: 'Void' }[f.status],
      clear: () => set({ status: '' }),
    });

  const total = q.data?.total ?? 0;

  return (
    <div
      className="cx-find"
      onKeyDown={(e) => {
        if (
          e.key === 'Enter' &&
          !e.defaultPrevented &&
          (e.target as HTMLElement).closest('.cx-find-filters') &&
          (e.target as HTMLElement).getAttribute('aria-expanded') !== 'true'
        ) {
          e.preventDefault();
          find();
        }
      }}
    >
      <div className="cx-find-filters">
        <div className="cx-row" style={{ marginBottom: 10 }}>
          <SegmentedControl
            size="sm"
            value={mode}
            onChange={setMode}
            aria-label="Find mode"
            options={[
              { value: 'simple', label: 'Simple' },
              { value: 'advanced', label: 'Advanced' },
            ]}
          />
          <span className="cx-spacer" />
          <Button size="sm" variant="ghost" icon={RotateCcw} label="Reset" onClick={reset} />
          <Button size="sm" variant="primary" icon={Search} label="Find" onClick={find} />
        </div>
        {mode === 'simple' ? (
          <div className="cx-find-simple">
            <Field label="Transaction type" width={170}>
              <Select
                value={f.types.length === 1 ? f.types[0] : f.types.length > 1 ? '__multi' : ''}
                onChange={(v) => set({ types: v ? (v === '__multi' ? f.types : [v as TxnType]) : [] })}
                options={[
                  { value: '', label: 'All transactions' },
                  ...(f.types.length > 1 ? [{ value: '__multi', label: 'Several types' }] : []),
                  ...TYPES.map((t) => ({ value: t, label: TXN_TYPE_LABELS[t] })),
                ]}
              />
            </Field>
            <Field label={nameLabel} width={210}>
              <NamePicker value={f.nameId} onChange={(id) => set({ nameId: id })} addNew={false} placeholder="Any name" />
            </Field>
            {dateFields}
            <Field label="Number" width={110}>
              <TextField value={f.ref} onChange={(v) => set({ ref: v })} placeholder="Any" />
            </Field>
            <Field label="Amount" width={120}>
              <MoneyField
                value={f.amountMode === 'eq' ? f.amount : null}
                nullable
                onChange={(v) => set({ amount: v, amountMode: v === null ? 'any' : 'eq' })}
                placeholder="Any"
              />
            </Field>
            <Field label="Text (number, name, memo)" width={220}>
              <TextField value={f.q} onChange={(v) => set({ q: v })} placeholder="Anything" />
            </Field>
          </div>
        ) : (
          <div className="cx-find-adv">
            <div className="cx-find-advlist" role="listbox" aria-label="Filter">
              {ADV_FILTERS.map((x) => (
                <button
                  key={x.key}
                  type="button"
                  role="option"
                  aria-selected={adv === x.key}
                  className={'cx-find-advitem' + (adv === x.key ? ' cx-on' : '')}
                  onClick={() => setAdv(x.key)}
                >
                  {x.label}
                  {choices.some((c) => c.key === x.key) && <span className="cx-dot" aria-label="set" />}
                </button>
              ))}
            </div>
            <div className="cx-find-adveditor">
              {adv === 'account' && (
                <Field label="Account" width={280} hint="Transactions with a posting to this account.">
                  <AccountPicker value={f.accountId} onChange={(id) => set({ accountId: id })} addNew={false} />
                </Field>
              )}
              {adv === 'amount' && (
                <div className="cx-stack" style={{ gap: 8 }}>
                  <RadioGroup<AmountMode>
                    value={f.amountMode}
                    onChange={(v) => set({ amountMode: v })}
                    options={[
                      { value: 'any', label: 'Any amount' },
                      { value: 'eq', label: 'Equal to' },
                      { value: 'gte', label: 'At least (>=)' },
                      { value: 'lte', label: 'At most (<=)' },
                      { value: 'between', label: 'Between' },
                    ]}
                  />
                  {f.amountMode !== 'any' && (
                    <div className="cx-row">
                      <MoneyField value={f.amount} nullable width={120} onChange={(v) => set({ amount: v })} aria-label="Amount" />
                      {f.amountMode === 'between' && (
                        <>
                          <span>and</span>
                          <MoneyField value={f.amount2} nullable width={120} onChange={(v) => set({ amount2: v })} aria-label="Second amount" />
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
              {adv === 'date' && (
                <div className="cx-row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  {dateFields}
                </div>
              )}
              {adv === 'item' && (
                <Field label="Item" width={280}>
                  <ItemPicker value={f.itemId} onChange={(id) => set({ itemId: id })} addNew={false} />
                </Field>
              )}
              {adv === 'memo' && (
                <Field label="Memo contains" width={280}>
                  <TextField value={f.memo} onChange={(v) => set({ memo: v })} autoFocus />
                </Field>
              )}
              {adv === 'name' && (
                <Field label="Name" width={280} hint="A customer includes its jobs.">
                  <NamePicker value={f.nameId} onChange={(id) => set({ nameId: id })} addNew={false} />
                </Field>
              )}
              {adv === 'number' && (
                <Field label="Number contains" width={200}>
                  <TextField value={f.ref} onChange={(v) => set({ ref: v })} autoFocus />
                </Field>
              )}
              {adv === 'status' && (
                <RadioGroup<Status>
                  value={f.status}
                  onChange={(v) => set({ status: v })}
                  options={[
                    { value: '', label: 'All' },
                    { value: 'open', label: 'Open (not paid in full)' },
                    { value: 'paid', label: 'Paid in full' },
                    { value: 'pending', label: 'Pending' },
                    { value: 'void', label: 'Voided' },
                  ]}
                />
              )}
              {adv === 'type' && (
                <div className="cx-find-types">
                  {TYPES.map((t) => (
                    <Checkbox
                      key={t}
                      checked={f.types.includes(t)}
                      onChange={(on) => set({ types: on ? [...f.types, t] : f.types.filter((x) => x !== t) })}
                      label={TXN_TYPE_LABELS[t]}
                    />
                  ))}
                </div>
              )}
              {adv === 'text' && (
                <Field label="Text anywhere (number, name, memo, line descriptions)" width={320}>
                  <TextField value={f.q} onChange={(v) => set({ q: v })} autoFocus />
                </Field>
              )}
            </div>
            <div className="cx-find-choices">
              <div className="cx-section-title" style={{ marginBottom: 6 }}>
                Current choices
              </div>
              {choices.length === 0 ? (
                <div className="cx-muted cx-small">No filters: every transaction matches.</div>
              ) : (
                <ul>
                  {choices.map((c) => (
                    <li key={c.key}>
                      <button type="button" className="cx-choice-label" onClick={() => setAdv(c.key)}>
                        <b>{c.label}</b>
                        <span className="cx-ellipsis">{c.value}</span>
                      </button>
                      <button
                        type="button"
                        className="sx-iconbtn"
                        title={`Remove the ${c.label.toLowerCase()} filter`}
                        aria-label={`Remove the ${c.label.toLowerCase()} filter`}
                        onClick={c.clear}
                      >
                        <X size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="cx-find-results">
        <div className="cx-row" style={{ padding: '8px 14px' }}>
          <b>{q.isLoading ? 'Searching...' : `${total} match${total === 1 ? '' : 'es'}`}</b>
          {total > rows.length && <span className="cx-muted cx-small">Showing the {rows.length} most recent. Add filters to narrow the search.</span>}
          <span className="cx-spacer" />
          <Button size="sm" icon={ExternalLink} label="Go To" disabled={!selected} onClick={() => goTo(selected)} />
          <Button size="sm" icon={FileBarChart} label="Report" disabled={!rows.length} onClick={report} title="Show these transactions as a report" />
          <Button size="sm" icon={Download} label="Export" disabled={!rows.length} onClick={exportCsv} title="Download the results as a CSV file" />
        </div>
        <div className="cx-find-list">
          {!q.isLoading && rows.length === 0 ? (
            <EmptyState icon={Search} title="No transactions match" message="Change or remove some filters and click Find." compact />
          ) : (
            <ListView<TxnSummary>
              columns={columns}
              rows={rows}
              loading={q.isLoading}
              selectedKey={sel}
              onSelect={(k) => setSel(Number(k))}
              onActivate={goTo}
              isInactive={(r) => r.voided}
              contextMenu={(r) => (r ? [{ label: '&Go To', onClick: () => goTo(r) }] : [])}
              persistKey="find"
              aria-label="Matching transactions"
            />
          )}
        </div>
      </div>
    </div>
  );
}
