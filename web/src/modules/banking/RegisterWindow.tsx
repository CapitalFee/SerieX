// Account register (two-line layout with a one-line toggle): bank, credit card, asset,
// liability, equity, A/R and A/P accounts. Filter bar (dates, type, cleared status, search), sort,
// running balance, click ✓ to mark an entry cleared, double-click / Enter to open a transaction,
// Account Activity report, print, and a clear "add a transaction" row at the bottom (check or deposit for
// banks, charge or credit for credit cards, a two-line journal entry for other accounts).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Check, CheckCircle2, FileText, Info, Landmark, Pencil, Printer, RefreshCw, SquareCheck } from 'lucide-react';
import { api, qs, type ApiError } from '@/api/client';
import { invalidateAll, queryClient, useAccounts, useCompanyInfo, useNextRef, usePrefValues, useRegister } from '@/api/hooks';
import { TXN_TYPE_LABELS, emptyLine, emptyTxn, type ID, type Name, type RegisterRow, type Txn, type TxnListResult, type TxnType } from '@/api/types';
import {
  AccountPicker,
  Button,
  Checkbox,
  DateField,
  EmptyState,
  FormErrorsProvider,
  MoneyField,
  NamePicker,
  SearchBox,
  Select,
  Spinner,
  TextField,
  Toolbar,
  ToolbarButton,
  ToolbarSpacer,
  ToolSeparator,
  isPopupOpen,
  showContextMenu,
  toast,
  useFormErrors,
  useHotkeys,
} from '@/components';
import { isOpeningBalanceTxn, showTransactionHistory } from '@/forms';
import { DATE_PRESETS_WITH_CUSTOM, resolvePreset } from '@/util/dates';
import { fmtDate, fmtMoney } from '@/util/format';
import { escHtml, printHtml } from '@/util/print';
import { openTxn, openWindow } from '@/windows/windowStore';
import { useWindow } from '@/windows/WindowContext';
import { LINE_EXCLUDED_TYPES, REGISTER_TYPES, dollars, isDebitNormal, registerKind, todayIso, type RegisterKind } from './shared';
import { openRegister } from './UseRegisterDialog';
import './banking.css';

export interface RegisterWindowProps {
  accountId: number;
  selectTxnId?: number;
  accountName?: string;
}

type SortKey = 'date' | 'number' | 'amount' | 'payee' | 'type' | 'entered' | 'cleared';
const SORTS: { value: SortKey; label: string }[] = [
  { value: 'date', label: 'Date, Number' },
  { value: 'number', label: 'Number / Ref' },
  { value: 'amount', label: 'Amount (largest first)' },
  { value: 'payee', label: 'Payee' },
  { value: 'type', label: 'Type' },
  { value: 'cleared', label: 'Cleared status' },
  { value: 'entered', label: 'Order entered' },
];

const ONE_LINE_KEY = 'sx.bk.reg1line';
const readOneLine = () => {
  try {
    return localStorage.getItem(ONE_LINE_KEY) === '1';
  } catch {
    return false;
  }
};

function refCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** Column layout of a register kind: which column (left/right) shows increases. */
function sides(kind: RegisterKind, accountType: string): { leftIsIncrease: boolean; hasCleared: boolean; hasDue: boolean } {
  if (kind === 'ar' || kind === 'ap') return { leftIsIncrease: true, hasCleared: false, hasDue: true };
  if (kind === 'bank') return { leftIsIncrease: false, hasCleared: true, hasDue: false };
  if (kind === 'cc') return { leftIsIncrease: true, hasCleared: true, hasDue: false };
  return { leftIsIncrease: !isDebitNormal(accountType), hasCleared: true, hasDue: false };
}

export default function RegisterWindow(props: RegisterWindowProps) {
  const win = useWindow();
  const accountId = props.accountId;
  const { data: company } = useCompanyInfo();
  const fy = company?.fiscalYearStartMonth ?? 1;
  const [preset, setPreset] = useState('all');
  const [range, setRange] = useState<{ from: string; to: string }>({ from: '', to: '' });
  const [typeFilter, setTypeFilter] = useState('');
  const [clearedFilter, setClearedFilter] = useState<'' | 'uncleared' | 'cleared' | 'reconciled'>('');
  const [search, setSearch] = useState('');
  const [oneLine, setOneLine] = useState(readOneLine);
  const [sort, setSort] = useState<SortKey>('date');
  const [selected, setSelected] = useState<ID | null>(props.selectTxnId ?? null);
  const [overrides, setOverrides] = useState<Record<number, '' | '*' | 'R'>>({});
  const { data, isLoading, isFetching, error, refetch } = useRegister(accountId, range.from || range.to ? range : {});
  const { data: allAccounts } = useAccounts({ active: 'all' });
  const account = data?.account;
  const kind = registerKind(account?.type);
  const side = sides(kind, account?.type ?? '');

  useEffect(() => {
    if (account) win.setTitle(account.fullName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.fullName]);

  useEffect(() => {
    setOverrides({});
  }, [data]);

  const applyPreset = (key: string) => {
    setPreset(key);
    if (key === 'custom') return;
    if (key === 'all') setRange({ from: '', to: '' });
    else setRange(resolvePreset(key, todayIso(), fy));
  };

  const rows = useMemo(() => {
    let list = (data?.rows ?? []).map((r) => (overrides[r.txnId] !== undefined ? { ...r, cleared: overrides[r.txnId] } : r));
    if (typeFilter) list = list.filter((r) => r.type === typeFilter);
    if (clearedFilter === 'uncleared') list = list.filter((r) => r.cleared === '');
    else if (clearedFilter === 'cleared') list = list.filter((r) => r.cleared !== '');
    else if (clearedFilter === 'reconciled') list = list.filter((r) => r.cleared === 'R');
    const q = search.trim().toLowerCase();
    if (q) {
      const qn = q.replace(/[$,]/g, '');
      list = list.filter(
        (r) =>
          r.nameFull.toLowerCase().includes(q) ||
          r.memo.toLowerCase().includes(q) ||
          r.refNumber.toLowerCase().includes(q) ||
          r.otherAccount.toLowerCase().includes(q) ||
          (qn && (String(r.increase || '').includes(qn) || String(r.decrease || '').includes(qn) || fmtMoney(r.increase || r.decrease).replace(/,/g, '').includes(qn))),
      );
    }
    if (sort !== 'date') {
      const arr = list.slice();
      const by: Record<Exclude<SortKey, 'date'>, (a: RegisterRow, b: RegisterRow) => number> = {
        number: (a, b) => refCompare(a.refNumber, b.refNumber) || a.date.localeCompare(b.date),
        amount: (a, b) => Math.max(b.increase, b.decrease) - Math.max(a.increase, a.decrease),
        payee: (a, b) => a.nameFull.localeCompare(b.nameFull, undefined, { sensitivity: 'base' }) || a.date.localeCompare(b.date),
        type: (a, b) => a.typeAbbrev.localeCompare(b.typeAbbrev) || a.date.localeCompare(b.date),
        entered: (a, b) => a.txnId - b.txnId,
        cleared: (a, b) => a.cleared.localeCompare(b.cleared) || a.date.localeCompare(b.date),
      };
      arr.sort(by[sort]);
      list = arr;
    }
    return list;
  }, [data, overrides, typeFilter, clearedFilter, search, sort]);

  const typesPresent = useMemo(() => Array.from(new Set((data?.rows ?? []).map((r) => r.type))).sort(), [data]);

  // ---- virtual list
  const rowH = oneLine ? 28 : 46;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, [data]);
  const headH = oneLine ? 30 : 48;
  const scrollToIndex = (i: number, where: 'nearest' | 'center' = 'nearest') => {
    const el = scrollRef.current;
    if (!el || i < 0) return;
    const top = i * rowH;
    const bodyH = el.clientHeight - headH;
    if (where === 'center') el.scrollTop = Math.max(0, top - bodyH / 2);
    else if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowH > el.scrollTop + bodyH) el.scrollTop = top + rowH - bodyH;
  };
  // 1-line / 2-line: keep the same first visible row (the row height changes, the pixel offset must follow)
  const keepRow = useRef<number | null>(null);
  const toggleOneLine = (v: boolean) => {
    const el = scrollRef.current;
    keepRow.current = el ? Math.floor(el.scrollTop / rowH) : null;
    setOneLine(v);
    try {
      localStorage.setItem(ONE_LINE_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (keepRow.current === null || !el) return;
    el.scrollTop = keepRow.current * rowH;
    setScrollTop(el.scrollTop);
    keepRow.current = null;
  }, [oneLine, rowH]);

  // first load: scroll to the selected transaction or to the end (newest entries)
  const didInitialScroll = useRef(false);
  const pendingSelect = useRef<ID | null>(props.selectTxnId ?? null);
  useLayoutEffect(() => {
    if (!data || !scrollRef.current) return;
    if (pendingSelect.current) {
      const i = rows.findIndex((r) => r.txnId === pendingSelect.current);
      if (i >= 0) {
        setSelected(pendingSelect.current);
        scrollToIndex(i, 'center');
        pendingSelect.current = null;
        didInitialScroll.current = true;
        return;
      }
    }
    if (!didInitialScroll.current) {
      didInitialScroll.current = true;
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  });
  // opening the same register again with another selectTxnId (from a report or search)
  useEffect(() => {
    if (props.selectTxnId) pendingSelect.current = props.selectTxnId;
  }, [props.selectTxnId]);

  const first = Math.max(0, Math.floor(scrollTop / rowH) - 6);
  const last = Math.min(rows.length, first + Math.ceil(viewH / rowH) + 14);
  const selIndex = selected === null ? -1 : rows.findIndex((r) => r.txnId === selected);
  const selRow = selIndex >= 0 ? rows[selIndex] : null;

  // ---- actions
  const open = (r: RegisterRow | null) => {
    if (r) openTxn(r.type, r.txnId);
  };
  const toggleCleared = async (r: RegisterRow) => {
    if (!side.hasCleared || r.voided || !r.glId) return;
    const next = r.cleared === '' ? '*' : '';
    setOverrides((o) => ({ ...o, [r.txnId]: next }));
    try {
      await api.put(`/gl/${r.glId}/cleared`, { cleared: next });
      void queryClient.invalidateQueries({ queryKey: ['register', accountId] });
      void queryClient.invalidateQueries({ queryKey: ['reconcile', accountId] });
    } catch (e) {
      setOverrides((o) => {
        const n = { ...o };
        delete n[r.txnId];
        return n;
      });
      const err = e as ApiError;
      if (err.code !== 'cancelled') toast(err.message, { kind: 'error' });
    }
  };
  const activityReport = () => openWindow('report', { key: 'account_quickreport', params: { accountId: String(accountId), dates: 'all' } });
  const payeeReport = (r: RegisterRow) =>
    r.nameId && openWindow('report', { key: 'name_quickreport', params: { nameId: String(r.nameId), dates: 'all' }, title: `Activity Report: ${r.nameFull}` });
  const journal = (r: RegisterRow) => openWindow('report', { key: 'journal', params: { txnId: String(r.txnId), dates: 'all' }, title: 'Transaction Journal' }, { title: 'Transaction Journal' });
  // Transaction History of the selected entry (the transactions linked to it), as on a form
  const history = async (r: RegisterRow) => {
    try {
      const t = await queryClient.fetchQuery({ queryKey: ['txn', r.txnId], queryFn: () => api.get<Txn>(`/txns/${r.txnId}`), staleTime: 0 });
      await showTransactionHistory(t);
    } catch (e) {
      const err = e as ApiError;
      if (err.code !== 'cancelled') toast(err.message, { kind: 'error' });
    }
  };

  const leftLabel = side.leftIsIncrease ? data?.increaseLabel ?? 'INCREASE' : data?.decreaseLabel ?? 'DECREASE';
  const rightLabel = side.leftIsIncrease ? data?.decreaseLabel ?? 'DECREASE' : data?.increaseLabel ?? 'INCREASE';
  const leftOf = (r: RegisterRow) => (side.leftIsIncrease ? r.increase : r.decrease);
  const rightOf = (r: RegisterRow) => (side.leftIsIncrease ? r.decrease : r.increase);
  const payeeLabel = kind === 'ar' ? 'CUSTOMER' : kind === 'ap' ? 'VENDOR' : kind === 'bank' || kind === 'cc' ? 'PAYEE' : 'NAME';

  const print = () => {
    const head = `<tr><th>Date</th><th>Number</th><th>Type</th><th>${escHtml(payeeLabel)}</th><th>Account</th><th>Memo</th><th class="num">${escHtml(leftLabel)}</th>${side.hasCleared ? '<th>✓</th>' : ''}<th class="num">${escHtml(rightLabel)}</th><th class="num">Balance</th></tr>`;
    const body = rows
      .map(
        (r) =>
          `<tr><td>${fmtDate(r.date)}</td><td>${escHtml(r.refNumber)}</td><td>${escHtml(r.typeAbbrev)}</td><td>${escHtml(r.nameFull)}</td><td>${escHtml(r.otherAccount)}</td><td>${escHtml(r.memo)}</td><td class="num">${fmtMoney(leftOf(r), { blankZero: true })}</td>${side.hasCleared ? `<td>${r.cleared === 'R' ? '✓' : r.cleared === '*' ? '*' : ''}</td>` : ''}<td class="num">${fmtMoney(rightOf(r), { blankZero: true })}</td><td class="num">${fmtMoney(r.balance)}</td></tr>`,
      )
      .join('');
    const period = range.from || range.to ? `${fmtDate(range.from) || 'Beginning'} - ${fmtDate(range.to) || 'Today'}` : 'All dates';
    void printHtml(
      `${account?.fullName ?? ''} Register`,
      `<h2>${escHtml(company?.name ?? '')}</h2><h1>${escHtml(account?.fullName ?? '')} Register</h1><p class="muted">${escHtml(period)}</p><table><thead>${head}</thead><tbody>${body}</tbody></table><p class="bold right">Ending balance ${fmtMoney(data?.endingBalance ?? 0)}</p>`,
      'table{font-size:10px} td,th{border-bottom:1px solid #ddd}',
    );
  };

  useHotkeys({
    'ctrl+q': () => {
      activityReport();
    },
    'ctrl+e': () => open(selRow),
    // with no entry selected the key is not handled: Reports > Transaction History / Journal then shows its hint
    'ctrl+h': () => {
      if (!selRow) return false;
      void history(selRow);
    },
    'ctrl+y': () => {
      if (!selRow) return false;
      journal(selRow);
    },
  });

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key;
    const move = (i: number) => {
      if (!rows.length) return;
      const n = Math.max(0, Math.min(rows.length - 1, i));
      setSelected(rows[n].txnId);
      scrollToIndex(n);
    };
    const page = Math.max(1, Math.floor((viewH - headH) / rowH) - 1);
    if (k === 'ArrowDown') move(selIndex + 1);
    else if (k === 'ArrowUp') move(selIndex < 0 ? rows.length - 1 : selIndex - 1);
    else if (k === 'PageDown') move(selIndex + page);
    else if (k === 'PageUp') move(selIndex - page);
    else if (k === 'Home') move(0);
    else if (k === 'End') move(rows.length - 1);
    else if (k === 'Enter') open(selRow);
    else if (k === ' ' && selRow) void toggleCleared(selRow);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const rowMenu = (r: RegisterRow) => [
    { label: '&Edit transaction', shortcut: 'Ctrl+E', onClick: () => open(r) },
    ...(side.hasCleared && !r.voided ? [{ label: r.cleared === '' ? 'Mark as &cleared' : 'Mark as &uncleared', onClick: () => void toggleCleared(r) }] : []),
    { separator: true },
    { label: 'Transaction &history', shortcut: 'Ctrl+H', onClick: () => void history(r) },
    { label: 'Transaction &journal', shortcut: 'Ctrl+Y', onClick: () => journal(r) },
    ...(r.nameId ? [{ label: `&Activity Report: ${r.nameFull}`, onClick: () => payeeReport(r) }] : []),
  ];

  // ---- layout
  // text columns may shrink (with an ellipsis and a tooltip) so the amounts and the balance always fit
  const cols: string[] = ['112px', '84px', oneLine ? 'minmax(0, 1.2fr)' : 'minmax(0, 1fr)'];
  if (oneLine) cols.push('minmax(0, 0.7fr)', 'minmax(0, 0.7fr)');
  if (side.hasDue) cols.push('96px');
  cols.push('112px');
  if (side.hasCleared) cols.push('34px');
  cols.push('112px', '124px');
  const gridStyle: CSSProperties = { gridTemplateColumns: cols.join(' ') };
  const nCols = cols.length;

  if (account && !REGISTER_TYPES.includes(account.type)) {
    return (
      <div className="bk-reg">
        <EmptyState
          icon={Landmark}
          title={`${account.fullName} has no register`}
          message="Registers are for bank, credit card, asset, liability and equity accounts. Use the Account Activity report to see the transactions of an income or expense account."
          action={{ label: 'Show Account Activity', onClick: activityReport }}
        />
      </div>
    );
  }

  const filtered = rows.length !== (data?.rows.length ?? 0);
  // a parent account: the register lists only its own entries, the Chart of Accounts balance includes the subaccounts
  const subaccounts = account ? (allAccounts ?? []).filter((a) => a.parentId === account.id) : [];

  return (
    <div className="bk-reg" data-kind={kind}>
      <Toolbar aria-label="Register">
        <ToolbarButton label="Edit transaction" icon={Pencil} disabled={!selRow} onClick={() => open(selRow)} shortcut="Ctrl+E" />
        <ToolbarButton label="Activity Report" icon={FileText} onClick={activityReport} shortcut="Ctrl+Q" />
        <ToolbarButton label="Print" icon={Printer} onClick={print} disabled={!rows.length} />
        {kind !== 'ar' && kind !== 'ap' && <ToolbarButton label="Reconcile" icon={SquareCheck} onClick={() => openWindow('reconcileBegin', { accountId })} />}
        <ToolSeparator />
        <ToolbarButton label="Refresh" icon={RefreshCw} onClick={() => void refetch()} />
        <ToolbarSpacer />
        {isFetching && !isLoading && <Spinner size={14} />}
      </Toolbar>
      <div className="bk-reg-filters" role="group" aria-label="Filters">
        <label className="bk-flabel" htmlFor={`${win.id}-preset`}>
          Dates
        </label>
        <Select id={`${win.id}-preset`} value={preset} width={150} onChange={applyPreset} options={DATE_PRESETS_WITH_CUSTOM.map((p) => ({ value: p.key, label: p.label }))} />
        <DateField
          aria-label="From"
          value={range.from}
          width={124}
          placeholder="From"
          onChange={(d) => {
            setPreset('custom');
            setRange((r) => ({ ...r, from: d }));
          }}
        />
        <span className="bk-muted">to</span>
        <DateField
          aria-label="To"
          value={range.to}
          width={124}
          placeholder="To"
          onChange={(d) => {
            setPreset('custom');
            setRange((r) => ({ ...r, to: d }));
          }}
        />
        <Select
          aria-label="Type"
          value={typeFilter}
          width={150}
          onChange={setTypeFilter}
          options={[{ value: '', label: 'All types' }, ...typesPresent.map((t) => ({ value: t, label: TXN_TYPE_LABELS[t as TxnType] ?? t }))]}
        />
        {side.hasCleared && (
          <Select
            aria-label="Cleared status"
            value={clearedFilter}
            width={130}
            onChange={(v) => setClearedFilter(v as typeof clearedFilter)}
            options={[
              { value: '', label: 'Any status' },
              { value: 'uncleared', label: 'Uncleared' },
              { value: 'cleared', label: 'Cleared' },
              { value: 'reconciled', label: 'Reconciled' },
            ]}
          />
        )}
        <SearchBox value={search} onChange={setSearch} placeholder="Search payee, memo, number, amount" width={240} debounce={150} />
      </div>
      {account && subaccounts.length > 0 && (
        <div className="bk-reg-subnote" role="note">
          <Info size={15} aria-hidden="true" />
          <span>
            This register shows only entries posted directly to <b>{account.fullName}</b>. Including its subaccounts the balance is <b>{dollars(account.balance)}</b>.
          </span>
          <span className="bk-reg-subnote-links">
            <span className="bk-muted">{subaccounts.length === 1 ? 'Subaccount register:' : 'Subaccount registers:'}</span>
            {subaccounts.slice(0, 4).map((a) => (
              <button key={a.id} type="button" className="sx-linkbtn" onClick={() => openRegister(a.id, a.fullName)} title={`Open the ${a.fullName} register`}>
                {a.name}
              </button>
            ))}
            {subaccounts.length > 4 ? <span className="bk-muted">+{subaccounts.length - 4} more</span> : null}
          </span>
        </div>
      )}
      <div className="bk-reg-main">
        {isLoading ? (
          <Spinner center label="Loading register..." />
        ) : error ? (
          <EmptyState title="The register could not be loaded" message={(error as Error).message} action={{ label: 'Try again', onClick: () => void refetch() }} />
        ) : (
          <div ref={scrollRef} className={'bk-reg-scroll' + (oneLine ? ' bk-one' : '')} tabIndex={0} onKeyDown={onListKey} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} role="grid" aria-label={`${account?.fullName ?? ''} register`}>
            <div className="bk-reg-head" style={gridStyle} role="row">
              <div className="bk-rc" style={{ gridRow: 1, gridColumn: 1 }}>
                DATE
              </div>
              <div className="bk-rc" style={{ gridRow: 1, gridColumn: 2 }}>
                NUMBER
              </div>
              <div className="bk-rc" style={{ gridRow: 1, gridColumn: 3 }}>
                {oneLine ? 'TYPE · ' : ''}
                {payeeLabel}
              </div>
              {oneLine && (
                <>
                  <div className="bk-rc" style={{ gridRow: 1, gridColumn: 4 }}>
                    ACCOUNT
                  </div>
                  <div className="bk-rc" style={{ gridRow: 1, gridColumn: 5 }}>
                    MEMO
                  </div>
                </>
              )}
              {side.hasDue && (
                <div className="bk-rc" style={{ gridRow: 1, gridColumn: oneLine ? 6 : 4 }}>
                  DUE DATE
                </div>
              )}
              <div className="bk-rc bk-num" style={{ gridRow: 1, gridColumn: nCols - (side.hasCleared ? 3 : 2) }}>
                {leftLabel}
              </div>
              {side.hasCleared && (
                <div className="bk-rc bk-clr" style={{ gridRow: 1, gridColumn: nCols - 2 }} title="Cleared: ✓ cleared, R reconciled">
                  ✓
                </div>
              )}
              <div className="bk-rc bk-num" style={{ gridRow: 1, gridColumn: nCols - 1 }}>
                {rightLabel}
              </div>
              <div className="bk-rc bk-num" style={{ gridRow: 1, gridColumn: nCols }}>
                BALANCE
              </div>
              {!oneLine && (
                <>
                  <div className="bk-rc" style={{ gridRow: 2, gridColumn: 2 }}>
                    TYPE
                  </div>
                  <div className="bk-rc" style={{ gridRow: 2, gridColumn: 3 }}>
                    ACCOUNT
                  </div>
                  <div className="bk-rc" style={{ gridRow: 2, gridColumn: `4 / ${nCols}` }}>
                    MEMO
                  </div>
                </>
              )}
            </div>
            <div className="bk-reg-body" style={{ height: rows.length * rowH }}>
              {rows.slice(first, last).map((r, n) => {
                const i = first + n;
                const sel = r.txnId === selected;
                const amtL = leftOf(r);
                const amtR = rightOf(r);
                return (
                  <div
                    key={r.txnId}
                    role="row"
                    aria-selected={sel}
                    className={'bk-reg-row' + (i % 2 ? ' bk-alt' : '') + (sel ? ' bk-sel' : '') + (r.voided ? ' bk-void' : '')}
                    style={{ ...gridStyle, top: i * rowH, height: rowH }}
                    onMouseDown={(e) => {
                      if (e.button === 0 || e.button === 2) setSelected(r.txnId);
                    }}
                    onDoubleClick={() => open(r)}
                    onContextMenu={(e) => showContextMenu(e, rowMenu(r))}
                  >
                    <div className="bk-rc" style={{ gridRow: 1, gridColumn: 1 }}>
                      {fmtDate(r.date)}
                    </div>
                    <div className="bk-rc" style={{ gridRow: 1, gridColumn: 2 }}>
                      {r.refNumber}
                    </div>
                    <div className="bk-rc bk-payee" style={{ gridRow: 1, gridColumn: 3 }} title={r.nameFull}>
                      {oneLine && <span className="bk-type-tag">{r.typeAbbrev}</span>}
                      <span className="bk-ell">{r.nameFull}</span>
                    </div>
                    {oneLine && (
                      <>
                        <div className="bk-rc bk-sub" style={{ gridRow: 1, gridColumn: 4 }} title={r.otherAccount}>
                          <span className="bk-ell">{r.otherAccount}</span>
                        </div>
                        <div className="bk-rc bk-sub" style={{ gridRow: 1, gridColumn: 5 }} title={r.memo}>
                          <span className="bk-ell">{r.voided ? 'VOID' : r.memo}</span>
                        </div>
                      </>
                    )}
                    {side.hasDue && (
                      <div className="bk-rc" style={{ gridRow: 1, gridColumn: oneLine ? 6 : 4 }}>
                        {fmtDate(r.dueDate)}
                      </div>
                    )}
                    <div className="bk-rc bk-num" style={{ gridRow: 1, gridColumn: nCols - (side.hasCleared ? 3 : 2) }}>
                      {fmtMoney(amtL, { blankZero: true })}
                    </div>
                    {side.hasCleared && (
                      <div
                        className={'bk-rc bk-clr bk-clr-cell' + (r.voided ? ' bk-noclr' : '')}
                        style={{ gridRow: 1, gridColumn: nCols - 2 }}
                        role="checkbox"
                        aria-checked={r.cleared !== ''}
                        aria-label={r.cleared === 'R' ? 'Reconciled' : r.cleared === '*' ? 'Cleared' : 'Not cleared'}
                        title={r.cleared === 'R' ? 'Reconciled (click to un-reconcile)' : r.cleared === '*' ? 'Cleared (click to unmark)' : 'Click to mark as cleared'}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => void toggleCleared(r)}
                        onDoubleClick={(e) => e.stopPropagation()}
                      >
                        {r.cleared === 'R' ? <CheckCircle2 size={15} className="bk-clr-r" /> : r.cleared === '*' ? <Check size={15} className="bk-clr-c" /> : null}
                      </div>
                    )}
                    <div className="bk-rc bk-num" style={{ gridRow: 1, gridColumn: nCols - 1 }}>
                      {fmtMoney(amtR, { blankZero: true })}
                    </div>
                    <div className={'bk-rc bk-num bk-balance' + (r.balance < 0 ? ' bk-neg' : '')} style={{ gridRow: 1, gridColumn: nCols }}>
                      {fmtMoney(r.balance)}
                    </div>
                    {!oneLine && (
                      <>
                        <div className="bk-rc bk-sub bk-type" style={{ gridRow: 2, gridColumn: 2 }}>
                          {r.typeAbbrev}
                        </div>
                        <div className="bk-rc bk-sub" style={{ gridRow: 2, gridColumn: 3 }} title={r.otherAccount}>
                          <span className="bk-ell">{r.otherAccount}</span>
                        </div>
                        <div className="bk-rc bk-sub" style={{ gridRow: 2, gridColumn: `4 / ${nCols}` }} title={r.memo}>
                          {r.voided ? <span className="bk-void-tag">VOID</span> : null}
                          <span className="bk-ell">{r.voided ? r.memo.replace(/^VOID: ?/, '') : r.memo}</span>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            {!rows.length && (
              <div className="bk-reg-empty">
                {filtered || range.from || range.to ? 'No transactions match these filters.' : 'This account has no transactions yet. Use the row below to add one.'}
              </div>
            )}
          </div>
        )}
      </div>
      {account && (kind === 'bank' || kind === 'cc' || kind === 'other') ? (
        <QuickEntry
          accountId={accountId}
          kind={kind}
          accountType={account.type}
          gridStyle={gridStyle}
          nCols={nCols}
          hasCleared={side.hasCleared}
          leftIsIncrease={side.leftIsIncrease}
          leftLabel={leftLabel}
          rightLabel={rightLabel}
          onRecorded={(id) => {
            pendingSelect.current = id;
            setSelected(id);
          }}
        />
      ) : account ? (
        <div className="bk-reg-arap-hint">
          {kind === 'ar' ? (
            <>
              Customer invoices, payments and credits appear here.
              <Button small label="Create invoice" onClick={() => openWindow('invoice')} />
              <Button small label="Receive payment" onClick={() => openWindow('receivePayment')} />
            </>
          ) : (
            <>
              Vendor bills and bill payments appear here.
              <Button small label="Enter bill" onClick={() => openWindow('bill')} />
              <Button small label="Pay bills" onClick={() => openWindow('payBills')} />
            </>
          )}
        </div>
      ) : null}
      <div className="bk-reg-foot">
        <Checkbox label="1-line" checked={oneLine} onChange={toggleOneLine} />
        <label className="bk-flabel" htmlFor={`${win.id}-sort`}>
          Sort by
        </label>
        <Select id={`${win.id}-sort`} value={sort} width={180} onChange={(v) => setSort(v as SortKey)} options={SORTS} />
        <span className="bk-muted bk-reg-count">
          {filtered ? `Showing ${rows.length} of ${data?.rows.length ?? 0} transactions` : `${rows.length} transaction${rows.length === 1 ? '' : 's'}`}
        </span>
        <span className="bk-grow" />
        <span className="bk-reg-endlabel">ENDING BALANCE</span>
        <span className={'bk-reg-end' + ((data?.endingBalance ?? 0) < 0 ? ' bk-neg' : '')}>{data ? fmtMoney(data.endingBalance) : ''}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick entry row ("Add check / Add deposit")

interface QuickEntryProps {
  accountId: ID;
  kind: RegisterKind;
  accountType: string;
  gridStyle: CSSProperties;
  nCols: number;
  hasCleared: boolean;
  leftIsIncrease: boolean;
  leftLabel: string;
  rightLabel: string;
  onRecorded: (txnId: ID) => void;
}

interface Entry {
  date: string;
  number: string;
  nameId: ID | null;
  left: number;
  right: number;
  accountId: ID | null;
  memo: string;
}

const blankEntry = (date: string, number = ''): Entry => ({ date, number, nameId: null, left: 0, right: 0, accountId: null, memo: '' });

function QuickEntry({ accountId, kind, accountType, gridStyle, nCols, hasCleared, leftIsIncrease, leftLabel, rightLabel, onRecorded }: QuickEntryProps) {
  const win = useWindow();
  const prefs = usePrefValues();
  const [e, setE] = useState<Entry>(() => blankEntry(todayIso()));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ label: string; type: TxnType; id: ID } | null>(null);
  const fe = useFormErrors();
  const rootRef = useRef<HTMLDivElement>(null);
  const eRef = useRef(e);
  eRef.current = e;

  // Next check number of the account. A query (not a one-time fetch), so it follows checks
  // written elsewhere: every save refreshes it (invalidateAll), and so does coming back to the
  // register. The row takes the new number only while the user has not typed one of their own.
  const { data: nextRef, refetch: refetchNext } = useNextRef('CHK', accountId, { enabled: kind === 'bank' });
  const autoRef = useRef('');
  useEffect(() => {
    if (kind !== 'bank' || !nextRef) return;
    const n = nextRef.refNumber ?? '';
    const prev = autoRef.current;
    autoRef.current = n;
    setE((cur) => (cur.number === '' || cur.number === prev ? { ...cur, number: n } : cur));
  }, [kind, nextRef]);
  useEffect(() => {
    if (kind === 'bank' && win.isActive) void refetchNext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.isActive]);

  // which transaction the row will create
  const plan = (x: Entry) => {
    const increase = leftIsIncrease ? x.left : x.right;
    const decrease = leftIsIncrease ? x.right : x.left;
    const what: { type: TxnType; label: string } =
      kind === 'bank'
        ? decrease > 0 || !increase
          ? { type: 'CHK', label: 'Check' }
          : { type: 'DEP', label: 'Deposit' }
        : kind === 'cc'
          ? increase > 0 || !decrease
            ? { type: 'CCCHARGE', label: 'Charge' }
            : { type: 'CCCREDIT', label: 'Credit' }
          : { type: 'GENJRNL', label: 'Journal entry' };
    return { increase, decrease, what };
  };
  const willCreate = plan(e).what;

  const restore = () => {
    fe.clearAll();
    setE(blankEntry(e.date, kind === 'bank' ? autoRef.current : ''));
  };

  // Choosing a payee on an empty row recalls the payee's last check (or card charge) like Write
  // Checks does: its amount, its account (when it used one account) and its memo; else the
  // payee's pre-fill account.
  const recallSeq = useRef(0);
  const recall = async (nameId: ID | null) => {
    if (!nameId || (kind !== 'bank' && kind !== 'cc')) return;
    const start = eRef.current;
    if (start.left || start.right || start.accountId) return;
    const my = ++recallSeq.current;
    const type: TxnType = kind === 'bank' ? 'CHK' : 'CCCHARGE';
    let other: ID | null = null;
    let amount = 0;
    let memo = '';
    try {
      if (prefs.autoRecall) {
        const res = await api.get<TxnListResult>('/txns' + qs({ nameId, types: [type], limit: 6, sort: '-date' }));
        for (const r of res.rows) {
          if (r.voided) continue;
          const t = await api.get<Txn>(`/txns/${r.id}`);
          if (my !== recallSeq.current) return;
          if (isOpeningBalanceTxn(t)) continue;
          const lines = t.lines.filter((l) => (l.kind === 'expense' || l.kind === 'item') && (l.amount || l.accountId || l.itemId));
          amount = t.amount > 0 ? t.amount : 0;
          if (lines.length === 1 && lines[0].kind === 'expense' && lines[0].accountId && lines[0].accountId !== accountId) other = lines[0].accountId;
          else if (lines.length !== 1) amount = 0; // a split cannot be shown on one register line
          memo = t.memo.replace(/^VOID: ?/, '');
          break;
        }
      }
      if (!other) {
        const n = await api.get<Name>(`/names/${nameId}`);
        other = (n.prefillAccountIds ?? []).find((a) => a !== accountId) ?? null;
        if (!other) amount = 0;
      }
    } catch {
      return; // recall is a convenience
    }
    if (my !== recallSeq.current || (!other && !amount)) return;
    setE((c) => (c.nameId !== nameId || c.left || c.right || c.accountId ? c : { ...c, accountId: other, left: amount, memo: c.memo || memo }));
  };

  const fail = (field: string, message: string) => {
    fe.setFieldError(field, message);
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLInputElement>(`[name="${field}"]`)?.focus());
  };

  const record = async () => {
    const e = eRef.current;
    const { increase, decrease, what: willCreate } = plan(e);
    fe.clearAll();
    if (!e.date) return fail('qeDate', 'Enter the date.');
    if (e.left && e.right) return fail('qeRight', `Enter either ${leftLabel.toLowerCase()} or ${rightLabel.toLowerCase()}, not both.`);
    if (!(e.left > 0) && !(e.right > 0)) return fail('qeLeft', `Enter the amount under ${leftLabel} or ${rightLabel}.`);
    if (!e.accountId) return fail('qeAccount', 'Choose the other account of this transaction.');
    if (e.accountId === accountId) return fail('qeAccount', 'Choose a different account than this register.');
    const amount = e.left || e.right;
    let t: Txn;
    if (willCreate.type === 'GENJRNL') {
      // this account goes up or down by the amount; the other account takes the other side
      const thisDebit = isDebitNormal(accountType) ? increase > 0 : decrease > 0;
      t = {
        ...emptyTxn('GENJRNL', e.date),
        refNumber: e.number,
        memo: e.memo,
        lines: [
          { ...emptyLine('je', 1), accountId, amount: thisDebit ? amount : -amount, description: e.memo, nameId: e.nameId },
          { ...emptyLine('je', 2), accountId: e.accountId, amount: thisDebit ? -amount : amount, description: e.memo, nameId: e.nameId },
        ],
      };
    } else {
      const kindOfLine = willCreate.type === 'DEP' ? 'deposit' : 'expense';
      t = {
        ...emptyTxn(willCreate.type, e.date),
        accountId,
        nameId: willCreate.type === 'DEP' ? null : e.nameId,
        refNumber: willCreate.type === 'DEP' && e.number === autoRef.current ? '' : e.number,
        memo: e.memo || (willCreate.type === 'DEP' ? 'Deposit' : ''),
        lines: [{ ...emptyLine(kindOfLine, 1), accountId: e.accountId, amount, description: e.memo, nameId: willCreate.type === 'DEP' ? e.nameId : null }],
      };
    }
    setBusy(true);
    try {
      const saved = await api.post<Txn>('/txns', t);
      void invalidateAll();
      // confirmation in the row itself: a toast would cover the Record button
      setDone({ label: `${willCreate.label}${saved.refNumber ? ' ' + saved.refNumber : ''} recorded`, type: saved.type, id: saved.id });
      onRecorded(saved.id);
      // the proposed number stays until the refreshed next number arrives (then it replaces it)
      setE(blankEntry(e.date, kind === 'bank' ? autoRef.current : ''));
      void refetchNext();
      rootRef.current?.querySelector<HTMLInputElement>('[name="qeDate"]')?.focus();
    } catch (err) {
      const ex = err as ApiError;
      if (ex.code === 'cancelled') return;
      fe.setMessage(ex.message);
    } finally {
      setBusy(false);
    }
  };

  const dirty = !!(e.nameId || e.left || e.right || e.accountId || e.memo);
  useEffect(() => {
    if (dirty) setDone(null);
  }, [dirty]);
  const problem = fe.message ?? Object.values(fe.errors)[0] ?? null;
  const leftCol = nCols - (hasCleared ? 3 : 2);
  return (
    <FormErrorsProvider value={fe}>
      <div
        ref={rootRef}
        className="bk-qe"
        onKeyDown={(ev) => {
          if (ev.defaultPrevented || isPopupOpen()) return;
          if (ev.key === 'Enter' && !ev.altKey && !ev.ctrlKey && (ev.target as HTMLElement).tagName === 'INPUT') {
            ev.preventDefault();
            // the field already committed its value on Enter; record after that render
            setTimeout(() => void record(), 0);
          } else if (ev.key === 'Escape' && dirty) {
            ev.preventDefault();
            restore();
          }
        }}
      >
        <div className="bk-qe-title">
          <span className="bk-qe-badge">New {willCreate.label.toLowerCase()}</span>
          <span className="bk-muted" hidden={!!problem}>
            {kind === 'bank'
              ? `Type an amount under ${leftLabel} for a check or under ${rightLabel} for a deposit, choose the account, then Record (Enter).`
              : kind === 'cc'
                ? `Type an amount under ${leftLabel} for a charge or under ${rightLabel} for a credit, choose the account, then Record (Enter).`
                : 'Type an amount, choose the other account, then Record (Enter). A journal entry is created.'}
          </span>
          {problem ? (
            <span className="bk-qe-error" role="alert">
              {problem}
            </span>
          ) : done ? (
            <span className="bk-qe-done" role="status">
              <CheckCircle2 size={14} /> {done.label}
              <button type="button" className="sx-linkbtn" onClick={() => openTxn(done.type, done.id)}>
                Open
              </button>
            </span>
          ) : null}
        </div>
        <div className="bk-qe-grid" style={gridStyle}>
          <div style={{ gridRow: 1, gridColumn: 1 }}>
            <DateField name="qeDate" aria-label="Date" value={e.date} required onChange={(d) => setE((c) => ({ ...c, date: d }))} hideErrorMessage />
          </div>
          <div style={{ gridRow: 1, gridColumn: 2 }}>
            <TextField name="qeNumber" aria-label="Number" placeholder="Number" value={e.number} onChange={(v) => setE((c) => ({ ...c, number: v }))} />
          </div>
          <div style={{ gridRow: 1, gridColumn: `3 / ${leftCol}` }}>
            <NamePicker
              name="qeName"
              aria-label={kind === 'bank' || kind === 'cc' ? 'Payee' : 'Name'}
              placeholder={kind === 'bank' || kind === 'cc' ? 'Payee' : 'Name'}
              value={e.nameId}
              onChange={(id) => {
                setE((c) => ({ ...c, nameId: id }));
                void recall(id);
              }}
              // a new name is most likely a vendor for a check or a card charge / refund, a customer for a deposit
              defaultKind={willCreate.type === 'DEP' ? 'customer' : willCreate.type === 'GENJRNL' ? undefined : 'vendor'}
              hideErrorMessage
            />
          </div>
          <div style={{ gridRow: 1, gridColumn: leftCol }}>
            <MoneyField name="qeLeft" aria-label={leftLabel} placeholder={leftLabel.toLowerCase()} value={e.left} blankZero onChange={(v) => setE((c) => ({ ...c, left: v ?? 0 }))} hideErrorMessage />
          </div>
          <div style={{ gridRow: 1, gridColumn: nCols - 1 }}>
            <MoneyField name="qeRight" aria-label={rightLabel} placeholder={rightLabel.toLowerCase()} value={e.right} blankZero onChange={(v) => setE((c) => ({ ...c, right: v ?? 0 }))} hideErrorMessage />
          </div>
          <div style={{ gridRow: 2, gridColumn: 2 }} className="bk-qe-type">
            {willCreate.type === 'GENJRNL' ? 'GENJRNL' : willCreate.type}
          </div>
          <div style={{ gridRow: 2, gridColumn: 3 }}>
            <AccountPicker name="qeAccount" aria-label="Account" placeholder="Account" excludeTypes={LINE_EXCLUDED_TYPES} excludeIds={[accountId]} value={e.accountId} onChange={(id) => setE((c) => ({ ...c, accountId: id }))} hideErrorMessage />
          </div>
          <div style={{ gridRow: 2, gridColumn: `4 / ${nCols}` }}>
            <TextField name="qeMemo" aria-label="Memo" placeholder="Memo" value={e.memo} onChange={(v) => setE((c) => ({ ...c, memo: v }))} />
          </div>
          {/* the buttons come last in the keyboard order (after Account and Memo); the grid places them on the right */}
          <div style={{ gridRow: 1, gridColumn: nCols }} className="bk-qe-btns">
            <Button variant="primary" small label="Record" busy={busy} onClick={() => void record()} title="Record this transaction (Enter)" />
          </div>
          <div style={{ gridRow: 2, gridColumn: nCols }} className="bk-qe-btns">
            <Button small variant="ghost" label="Restore" disabled={!dirty} onClick={restore} title="Clear this row (Esc)" />
          </div>
        </div>
      </div>
    </FormErrorsProvider>
  );
}
