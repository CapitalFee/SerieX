// Memorized Transaction List (Lists > Memorized Transaction List, Ctrl+T).
// Columns TRANSACTION NAME (grouped), TYPE, SOURCE ACCOUNT, AMOUNT, FREQUENCY, AUTO, NEXT DATE.
// SOURCE ACCOUNT and the Enter / Edit links are shown only when they fit, so the list never
// scrolls sideways (e.g. a floating window at its default size).
// Enter Transaction opens the right form filled from the template; "Enter now" saves it directly;
// Edit opens the Memorize Transaction dialog; Delete asks first. Scheduled entries that are due
// can be entered in one go.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Repeat } from 'lucide-react';
import { api } from '@/api/client';
import { useAccountsById } from '@/api/hooks';
import type { Account, MemorizedTxn } from '@/api/types';
import { alertBox, Badge, Button, DropdownButton, EmptyState, ListView, toast, useHotkeys, type ListColumn, type MenuItem } from '@/components';
import { invalidateAll } from '@/api/hooks';
import { todayIso } from '@/util/dates';
import { fmtDate, fmtMoney } from '@/util/format';
import { openWindow } from '@/windows/windowStore';
import { actionsColumn, deleteRecord, errMessage, ListPage, ListSearchBox, matchesSearch, plural, printList, useAutoSelect, useElementWidth } from './common';
import { enterNow, enterTransaction, frequencyLabel, isDue, typeLabel, useMemorized } from './memorized';

export interface MemorizedTxnListProps {
  selectId?: number;
}

interface Row {
  key: string;
  level: number;
  group?: string;
  m?: MemorizedTxn;
}

const AR_TYPES = ['INV', 'CREDMEM', 'STMTCHG', 'PMT', 'REFUND'];

/** Widths of the columns always shown (the name column grows); NEXT DATE fits a date and "Due". */
const COL = { name: 190, type: 98, amount: 88, freq: 108, auto: 50, next: 132 };
const BASE_WIDTH = Object.values(COL).reduce((a, b) => a + b, 0);
const SOURCE_WIDTH = 150;
const ACTIONS_WIDTH = 104;
const AP_TYPES = ['BILL', 'BILLCRED', 'ITEMRCPT', 'BILLPMT'];

export default function MemorizedTxnList(props: MemorizedTxnListProps) {
  const { data, isLoading, error, refetch } = useMemorized();
  const accounts = useAccountsById();
  const [q, setQ] = useState('');
  const [selKey, setSelKey] = useState<string | null>(props.selectId ? `m${props.selectId}` : null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(rootRef);
  const today = todayIso();

  useEffect(() => {
    if (props.selectId) setSelKey(`m${props.selectId}`);
  }, [props.selectId]);

  const special = (s: string): Account | undefined => [...accounts.values()].find((a) => a.special === s);
  const sourceAccount = (m: MemorizedTxn): string => {
    const t = m.template;
    const id = t.accountId ?? (m.txnType === 'GENJRNL' ? t.lines?.[0]?.accountId : null);
    if (id) return accounts.get(id)?.fullName ?? '';
    if (t.arApAccountId) return accounts.get(t.arApAccountId)?.fullName ?? '';
    if (AR_TYPES.includes(m.txnType)) return special('AccountsReceivable')?.fullName ?? 'Accounts Receivable';
    if (AP_TYPES.includes(m.txnType)) return special('AccountsPayable')?.fullName ?? 'Accounts Payable';
    if (m.txnType === 'SALESRCPT') return special('UndepositedFunds')?.fullName ?? 'Undeposited Funds';
    return '';
  };

  const all = data ?? [];
  const rows = useMemo<Row[]>(() => {
    const list = all.filter((m) => !q.trim() || matchesSearch(q, m.name, m.groupName, typeLabel(m)));
    const out: Row[] = [];
    const groups = [...new Set(list.map((m) => m.groupName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    for (const g of groups) {
      out.push({ key: `g:${g}`, level: 0, group: g });
      for (const m of list.filter((x) => x.groupName === g)) out.push({ key: `m${m.id}`, level: 1, m });
    }
    for (const m of list.filter((x) => !x.groupName)) out.push({ key: `m${m.id}`, level: 0, m });
    return out;
  }, [all, q]);
  const selRow = rows.find((r) => r.key === selKey) ?? null;
  const sel = selRow?.m ?? null;
  useAutoSelect(rows, selRow, () => setSelKey((rows.find((r) => r.m) ?? rows[0]).key));

  const due = all.filter((m) => m.schedule === 'auto' && isDue(m, today));

  const edit = (m: MemorizedTxn | null = sel) => m && openWindow('memorizeTxn', { memorizedId: m.id });
  const del = (m: MemorizedTxn | null = sel) =>
    m &&
    deleteRecord({
      what: 'memorized transaction',
      name: m.name,
      extra: 'Transactions already entered from it are not changed.',
      request: () => api.del(`/memorized/${m.id}`),
    });
  const enter = async (m: MemorizedTxn | null = sel) => {
    if (!m) return;
    setBusy(true);
    try {
      await enterTransaction(m);
    } finally {
      setBusy(false);
    }
  };
  const processDue = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ entered: number; errors?: string[] }>('/memorized/process-due', {});
      await invalidateAll();
      toast(r.entered ? `${plural(r.entered, 'scheduled transaction')} entered` : 'Nothing was due', { kind: r.entered ? 'success' : 'info' });
      if (r.errors?.length) await alertBox(`Some transactions could not be entered:\n\n${r.errors.join('\n')}`, 'Warning');
    } catch (e) {
      const msg = errMessage(e);
      if (msg) await alertBox(msg, 'Warning');
    } finally {
      setBusy(false);
    }
  };
  const print = () =>
    printList(
      'Memorized Transaction List',
      [{ label: 'Transaction Name' }, { label: 'Type' }, { label: 'Source Account' }, { label: 'Amount', align: 'right' }, { label: 'Frequency' }, { label: 'Auto' }, { label: 'Next Date' }],
      rows.map((r) =>
        r.m
          ? { cells: [r.m.name, typeLabel(r.m), sourceAccount(r.m), fmtMoney(r.m.amount), r.m.schedule === 'none' ? 'Not scheduled' : r.m.frequency === 'never' ? 'Once' : frequencyLabel(r.m.frequency), r.m.schedule === 'auto' ? '✓' : '', fmtDate(r.m.nextDate)], level: r.level }
          : { cells: [r.group ?? '', '', '', '', '', '', ''], level: 0 },
      ),
    );

  useHotkeys({
    'ctrl+e': () => (sel ? void edit() : false),
    'ctrl+d': () => (sel ? void del() : false),
  });

  const menu: MenuItem[] = [
    { label: '&Edit Memorized Transaction', shortcut: 'Ctrl+E', disabled: !sel, onClick: () => edit() },
    { label: '&Delete Memorized Transaction', shortcut: 'Ctrl+D', disabled: !sel, onClick: () => void del() },
    { separator: true },
    { label: 'E&nter Transaction', disabled: !sel, onClick: () => void enter() },
    { label: 'Enter and &Save Now', disabled: !sel, onClick: () => sel && void enterNow(sel, isDue(sel, today) ? sel.nextDate : today) },
    { label: 'Enter All Scheduled Transactions That Are Due', disabled: !due.length, onClick: () => void processDue() },
    { separator: true },
    { label: '&Print List...', onClick: () => void print() },
  ];
  const rowMenu = (r: Row | null): MenuItem[] =>
    r?.m
      ? [
          { label: 'E&nter Transaction', onClick: () => void enter(r.m!) },
          { label: 'Enter and &Save Now', onClick: () => void enterNow(r.m!, isDue(r.m!, today) ? r.m!.nextDate : today) },
          { separator: true },
          { label: '&Edit Memorized Transaction', shortcut: 'Ctrl+E', onClick: () => edit(r.m!) },
          { label: '&Delete Memorized Transaction', shortcut: 'Ctrl+D', onClick: () => void del(r.m!) },
        ]
      : [];

  // the columns always shown take BASE_WIDTH; the optional ones are added while they fit in the
  // list (the page width less its padding, the list border and room for a vertical scroll bar),
  // and the name column takes what is left
  const room = width - 48;
  const showSource = room >= BASE_WIDTH + SOURCE_WIDTH;
  const showActions = room >= BASE_WIDTH + (showSource ? SOURCE_WIDTH : 0) + ACTIONS_WIDTH;
  const columns: ListColumn<Row>[] = [
    {
      key: 'name',
      label: 'Transaction name',
      width: COL.name,
      grow: true,
      sortValue: (r) => r.m?.name ?? r.group ?? '',
      render: (r) => (r.m ? <span className="fl-name-text">{r.m.name}</span> : <b>{r.group}</b>),
    },
    { key: 'type', label: 'Type', width: COL.type, sortValue: (r) => (r.m ? typeLabel(r.m) : ''), render: (r) => (r.m ? typeLabel(r.m) : '') },
    ...(showSource ? [{ key: 'source', label: 'Source account', width: SOURCE_WIDTH, sortValue: (r: Row) => (r.m ? sourceAccount(r.m) : ''), render: (r: Row) => (r.m ? sourceAccount(r.m) : '') } as ListColumn<Row>] : []),
    { key: 'amount', label: 'Amount', width: COL.amount, align: 'right', sortValue: (r) => r.m?.amount ?? null, render: (r) => (r.m ? <span className="fl-money">{fmtMoney(r.m.amount)}</span> : '') },
    { key: 'freq', label: 'Frequency', width: COL.freq, sortValue: (r) => (r.m ? frequencyLabel(r.m.frequency) : ''), render: (r) => (r.m ? (r.m.schedule === 'none' ? <span className="fl-dim">Not scheduled</span> : r.m.frequency === 'never' ? 'Once' : frequencyLabel(r.m.frequency)) : '') },
    { key: 'auto', label: 'Auto', width: COL.auto, align: 'center', sortValue: (r) => (r.m?.schedule === 'auto' ? 1 : 0), render: (r) => (r.m?.schedule === 'auto' ? <CheckCircle2 size={15} color="var(--sx-success)" aria-label="Entered automatically" /> : '') },
    {
      key: 'next',
      label: 'Next date',
      width: COL.next,
      sortValue: (r) => r.m?.nextDate ?? '',
      render: (r) =>
        r.m && r.m.nextDate ? (
          <span className="fl-name-cell">
            {fmtDate(r.m.nextDate)}
            {isDue(r.m, today) && (
              <Badge tone="warning" title="This scheduled transaction is due">
                Due
              </Badge>
            )}
          </span>
        ) : (
          ''
        ),
    },
    ...(showActions ? [actionsColumn<Row>((r) => (r.m ? [{ label: 'Enter', onClick: () => void enter(r.m!) }, { label: 'Edit', onClick: () => edit(r.m!) }] : []), ACTIONS_WIDTH)] : []),
  ];

  const empty = !isLoading && !error && data && all.length === 0;

  return (
    <ListPage
      rootRef={rootRef}
      toolbar={<ListSearchBox value={q} onChange={setQ} placeholder="Search memorized transactions" aria-label="Search memorized transactions" />}
      actions={
        <>
          {due.length > 0 && <Button label={`Enter ${plural(due.length, 'due transaction')}`} busy={busy} onClick={() => void processDue()} title="Saves every automatic transaction whose next date is today or earlier (or within its days in advance)" />}
          <Button variant="primary" label="Enter Transaction" disabled={!sel || busy} onClick={() => void enter()} title="Open the form filled from the selected memorized transaction" />
        </>
      }
      footer={<DropdownButton label="&Memorized Transaction" items={menu} up />}
      status={data ? plural(all.length, 'memorized transaction') : undefined}
    >
      {error ? (
        <div className="fl-emptywrap">
          <EmptyState icon={Repeat} title="The list could not be loaded" message={(error as Error).message} action={{ label: 'Try again', onClick: () => void refetch() }} />
        </div>
      ) : empty ? (
        <div className="fl-emptywrap">
          <EmptyState
            icon={Repeat}
            title="No memorized transactions yet"
            message="Save transactions you enter often (rent, utility bills, monthly invoices). Open the transaction and click Memorize (Ctrl+M). SerieX Books can remind you when they are due or enter them for you."
          />
        </div>
      ) : (
        <ListView<Row>
          className="fl-list"
          aria-label="Memorized transactions"
          columns={columns}
          rows={rows}
          getKey={(r) => r.key}
          loading={isLoading}
          selectedKey={selKey}
          onSelect={(k) => setSelKey(String(k))}
          onActivate={(r) => r.m && void enter(r.m)}
          contextMenu={rowMenu}
          getLevel={(r) => r.level}
          indentKey="name"
          persistKey="fl-memorized"
          autoFocus
          emptyText="Nothing matches your search."
        />
      )}
    </ListPage>
  );
}
