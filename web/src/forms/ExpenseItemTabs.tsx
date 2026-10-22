// "Expenses | Items" two-tab lines area of checks, bills, credits, item receipts and credit card
// charges/credits. Tab labels show the totals ("Expenses $1,250.00").
//
// Expenses: ACCOUNT, AMOUNT, MEMO, CUSTOMER OR JOB, BILLABLE?, CLASS (with class tracking).
// Items:    ITEM, DESCRIPTION, QTY, COST, AMOUNT, CUSTOMER OR JOB, BILLABLE?, CLASS, PO NO.
// Choosing an item fills the purchase description and cost; qty × cost = amount (editing the
// amount with a quantity recomputes the cost). When the payee of a NEW transaction changes, the
// last transaction of that payee is recalled (prefs.autoRecall) or the vendor's pre-fill accounts
// are put on the Expenses tab.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, qs } from '@/api/client';
import { usePrefValues } from '@/api/hooks';
import { emptyLine, type AccountType, type ID, type LinkedTxn, type Name, type Txn, type TxnLine, type TxnListResult, type TxnType } from '@/api/types';
import { Grid, type GridColumn, type GridEditorProps } from '@/components/Grid';
import { AccountLabel, AccountPicker, ClassPicker, ItemLabel, ItemPicker, ListEntryLabel, NameLabel, NamePicker } from '@/components/pickers';
import { Tabs } from '@/components/layout';
import { fmtMoney, fmtQty, lineAmount, round2, roundTo } from '@/util/format';
import { isEmptyLine } from './useTxnForm';

/** Props of {@link ExpenseItemTabs}. */
export interface ExpenseItemTabsProps {
  /** All lines of the transaction (kinds "expense" and "item"; others are kept untouched). */
  lines: TxnLine[];
  onChange(lines: TxnLine[]): void;
  /** Transaction type (recall looks for the payee's last transaction of this type). */
  txnType: TxnType;
  /** Payee / vendor of the form. */
  payeeId?: ID | null;
  /** True for a new (unsaved) transaction: enables recall / pre-fill when the payee changes. */
  isNew?: boolean;
  /** Called with the recalled transaction after a recall (copy its memo, amount...). */
  onRecall?(txn: Txn): void;
  /** Hide the Items tab (e.g. when inventory/items are not used). */
  hideItems?: boolean;
  /** Linked transactions of the form (to show PO numbers of received lines). */
  linked?: LinkedTxn[];
  /** Show the BILLABLE? columns (default true). */
  showBillable?: boolean;
  readOnly?: boolean;
  /** Tab shown first (default: Items when there are only item lines, else Expenses). */
  defaultTab?: 'expenses' | 'items';
  /** Minimum visible grid lines (default 6). */
  minRows?: number;
  className?: string;
}

/**
 * True for the transactions the lists create for opening balances (New Customer / Vendor /
 * Account / Item with an opening balance: `extra.openingBalance`). Recall skips them.
 */
export function isOpeningBalanceTxn(t: Pick<Txn, 'extra'> | null | undefined): boolean {
  return !!t && !!t.extra && t.extra.openingBalance === true;
}

/** Account types an expense line may not use. */
const EXCLUDED_EXPENSE_TYPES: AccountType[] = ['Accounts Receivable', 'Accounts Payable', 'Non-Posting'];

function fmtCost(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return Number.isInteger(Math.round(n * 100 * 1e6) / 1e6) ? fmtMoney(n) : fmtQty(n);
}

function renumber(lines: TxnLine[]): TxnLine[] {
  return lines.map((l, i) => (l.seq === i + 1 ? l : { ...l, seq: i + 1 }));
}

function untouched(lines: TxnLine[]): boolean {
  return lines.every((l) => isEmptyLine(l) || (l.kind === 'expense' && !l.amount && !(l.description ?? '').trim() && l.nameId === null));
}

/** Expenses / Items tabs with editable grids for purchase forms. */
export function ExpenseItemTabs(props: ExpenseItemTabsProps) {
  const { lines, onChange, txnType, payeeId, isNew, onRecall, hideItems, linked, showBillable = true, readOnly, minRows = 6, className } = props;
  const prefs = usePrefValues();
  const expenses = useMemo(() => lines.filter((l) => l.kind === 'expense'), [lines]);
  const items = useMemo(() => lines.filter((l) => l.kind === 'item'), [lines]);
  const others = useMemo(() => lines.filter((l) => l.kind !== 'expense' && l.kind !== 'item'), [lines]);
  const [tab, setTab] = useState<'expenses' | 'items'>(() => props.defaultTab ?? (items.length && !expenses.length ? 'items' : 'expenses'));
  const linesRef = useRef(lines);
  linesRef.current = lines;

  const expTotal = round2(expenses.reduce((s, l) => s + (l.amount || 0), 0));
  const itemTotal = round2(items.reduce((s, l) => s + (l.amount || 0), 0));

  const setExpenses = (rows: TxnLine[]) => {
    const cur = linesRef.current;
    const next = renumber([...rows, ...cur.filter((l) => l.kind === 'item'), ...cur.filter((l) => l.kind !== 'expense' && l.kind !== 'item')]);
    linesRef.current = next;
    onChange(next);
  };
  const setItems = (rows: TxnLine[]) => {
    const cur = linesRef.current;
    const next = renumber([...cur.filter((l) => l.kind === 'expense'), ...rows, ...cur.filter((l) => l.kind !== 'expense' && l.kind !== 'item')]);
    linesRef.current = next;
    onChange(next);
  };

  // ---- recall / pre-fill when the payee changes on a new transaction
  const prevPayee = useRef(payeeId);
  const seq = useRef(0);
  useEffect(() => {
    if (payeeId === prevPayee.current) return;
    prevPayee.current = payeeId;
    if (!isNew || !payeeId || readOnly || !untouched(linesRef.current)) return;
    const my = ++seq.current;
    (async () => {
      if (prefs.autoRecall) {
        // the payee's last real transaction of this type (not voided, not an opening balance)
        const res = await api.get<TxnListResult>('/txns' + qs({ nameId: payeeId, types: [txnType], limit: 6, sort: '-date' }));
        let full: Txn | null = null;
        for (const r of res.rows) {
          if (r.voided) continue;
          if (my !== seq.current) return;
          const t = await api.get<Txn>(`/txns/${r.id}`);
          if (isOpeningBalanceTxn(t)) continue;
          full = t;
          break;
        }
        if (full && my === seq.current) {
          if (!untouched(linesRef.current)) return;
          const copied = full.lines
            .filter((l) => l.kind === 'expense' || l.kind === 'item')
            .map((l) => ({ ...l, id: 0, linkedTxnId: null, linkedLineId: null, billedTxnId: null, receivedQty: 0, cogs: 0 }));
          const next = renumber([...copied, ...others]);
          linesRef.current = next;
          onChange(next);
          if (copied.length && copied.every((l) => l.kind === 'item')) setTab('items');
          else setTab('expenses');
          onRecall?.(full);
          return;
        }
      }
      const name = await api.get<Name>(`/names/${payeeId}`);
      if (my !== seq.current || !untouched(linesRef.current)) return;
      const ids = name.prefillAccountIds ?? [];
      const prefilled = ids.map((a, i) => ({ ...emptyLine('expense', i + 1), accountId: a }));
      const next = renumber([...prefilled, ...linesRef.current.filter((l) => l.kind === 'item' && !isEmptyLine(l)), ...others]);
      linesRef.current = next;
      onChange(next);
      if (prefilled.length) setTab('expenses');
    })().catch(() => {
      /* recall is a convenience: ignore failures */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payeeId]);

  // ---- columns
  const custEditor = (p: GridEditorProps<TxnLine>) => (
    <NamePicker
      inGrid
      autoFocus
      kinds={['customer']}
      aria-label="Customer or job"
      value={p.value as ID | null}
      onChange={(id) => p.onRowChange({ nameId: id, billable: !!id })}
    />
  );
  const classEditor = (p: GridEditorProps<TxnLine>) => <ClassPicker inGrid autoFocus aria-label="Class" value={p.value as ID | null} onChange={(id) => p.onChange(id)} />;
  const billableCol: GridColumn<TxnLine> = {
    key: 'billable',
    label: 'BILLABLE?',
    width: 84,
    editor: 'checkbox',
    readOnly: (r) => !r.nameId,
    hidden: !showBillable,
    title: 'Billable to the customer',
  };
  const classCol: GridColumn<TxnLine> = {
    key: 'classId',
    label: 'CLASS',
    width: 110,
    editor: classEditor,
    hidden: !prefs.useClassTracking,
    render: () => null,
  };

  const expenseCols = useMemo<GridColumn<TxnLine>[]>(
    () => [
      {
        key: 'accountId',
        label: 'ACCOUNT',
        width: 200,
        editor: (p) => (
          <AccountPicker inGrid autoFocus aria-label="Account" excludeTypes={EXCLUDED_EXPENSE_TYPES} value={p.value as ID | null} onChange={(id) => p.onChange(id)} />
        ),
      },
      { key: 'amount', label: 'AMOUNT', width: 100, editor: 'money', align: 'right', blankZero: true },
      { key: 'description', label: 'MEMO', grow: true, width: 200, editor: 'text' },
      { key: 'nameId', label: 'CUSTOMER OR JOB', width: 170, editor: custEditor },
      billableCol,
      classCol,
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showBillable, prefs.useClassTracking],
  );

  const poRef = (id: ID | null) => (id ? linked?.find((l) => l.txnId === id)?.refNumber ?? '' : '');
  const itemCols = useMemo<GridColumn<TxnLine>[]>(
    () => [
      {
        key: 'itemId',
        label: 'ITEM',
        width: 160,
        editor: (p) => (
          <ItemPicker
            inGrid
            autoFocus
            purchase
            aria-label="Item"
            types={['Service', 'Inventory Part', 'Non-inventory Part', 'Other Charge']}
            value={p.value as ID | null}
            onChange={(id, it) => {
              if (!it) {
                p.onRowChange({ itemId: id });
                return;
              }
              const rate = it.cost ?? 0;
              p.onRowChange({ itemId: id, description: it.purchaseDescription || it.description, rate, amount: lineAmount(p.row.qty, rate) });
            }}
          />
        ),
      },
      { key: 'description', label: 'DESCRIPTION', grow: true, width: 200, editor: 'text' },
      { key: 'qty', label: 'QTY', width: 60, editor: 'qty', align: 'right' },
      { key: 'rate', label: 'COST', width: 80, editor: 'qty', align: 'right', render: (r) => fmtCost(r.rate) },
      { key: 'amount', label: 'AMOUNT', width: 95, editor: 'money', align: 'right' },
      { key: 'nameId', label: 'CUSTOMER OR JOB', width: 150, editor: custEditor },
      billableCol,
      classCol,
      { key: 'linkedTxnId', label: 'PO NO.', width: 72, render: (r) => poRef(r.linkedTxnId) },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showBillable, prefs.useClassTracking, linked],
  );

  // display of picker columns when not editing comes from the pickers' data: render names
  const onExpenseRow = (next: TxnLine, prev: TxnLine, key: string): TxnLine => {
    let r = next;
    if (key === 'nameId' && !r.nameId && r.billable) r = { ...r, billable: false };
    if (r.kind !== 'expense') r = { ...r, kind: 'expense' };
    return r;
  };
  const onItemRow = (next: TxnLine, prev: TxnLine, key: string): TxnLine => {
    let r = next.kind === 'item' ? next : { ...next, kind: 'item' as const };
    if (key === 'qty' || key === 'rate') r = { ...r, amount: lineAmount(r.qty, r.rate) };
    else if (key === 'amount') {
      if (r.qty) r = { ...r, rate: roundTo(r.amount / r.qty, 5) };
      else r = { ...r, rate: r.amount };
    }
    if (key === 'nameId' && !r.nameId && r.billable) r = { ...r, billable: false };
    return r;
  };

  const tabs = [
    { key: 'expenses', label: `Expenses  $${fmtMoney(expTotal)}` },
    ...(hideItems ? [] : [{ key: 'items', label: `Items  $${fmtMoney(itemTotal)}` }]),
  ];

  return (
    <Tabs tabs={tabs} active={hideItems ? 'expenses' : tab} onChange={(k) => setTab(k as 'expenses' | 'items')} fill className={'sx-expitem' + (className ? ' ' + className : '')} aria-label="Expenses and items">
      {tab === 'expenses' || hideItems ? (
        <Grid<TxnLine>
          aria-label="Expenses"
          columns={expenseCols.map((c) => withPickerDisplay(c))}
          rows={expenses}
          onChange={setExpenses}
          newRow={() => emptyLine('expense')}
          onRowChange={onExpenseRow}
          readOnly={readOnly}
          minRows={minRows}
          persistKey={`exp-${txnType}`}
        />
      ) : (
        <Grid<TxnLine>
          aria-label="Items"
          columns={itemCols.map((c) => withPickerDisplay(c))}
          rows={items}
          onChange={setItems}
          newRow={() => emptyLine('item')}
          onRowChange={onItemRow}
          readOnly={readOnly}
          minRows={minRows}
          persistKey={`item-${txnType}`}
        />
      )}
    </Tabs>
  );
}

// Non-editing cells of picker columns show the record name (looked up in the cached lists).
function withPickerDisplay(c: GridColumn<TxnLine>): GridColumn<TxnLine> {
  switch (c.key) {
    case 'accountId':
      return { ...c, render: (r) => <AccountLabel id={r.accountId} /> };
    case 'itemId':
      return { ...c, render: (r) => <ItemLabel id={r.itemId} /> };
    case 'nameId':
      return { ...c, render: (r) => <NameLabel id={r.nameId} kind="customer" /> };
    case 'classId':
      return { ...c, render: (r) => <ListEntryLabel list="class" id={r.classId} /> };
    default:
      return c;
  }
}
