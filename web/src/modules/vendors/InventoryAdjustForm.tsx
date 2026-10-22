// Adjust Inventory (INVADJ): adjustment type (Quantity / Total Value / Quantity and
// Total Value), date, ref. no., adjustment account, customer:job, class; lines ITEM, DESCRIPTION,
// CURRENT QTY, NEW QTY, QTY DIFFERENCE (+ CURRENT VALUE, NEW VALUE in value modes); memo, total value
// of the adjustment and number of item adjustments. Value modes save extra.valueAdjustment = true.
//
// CURRENT QTY / CURRENT VALUE are the figures as of the adjustment date (end of that day, from the
// Inventory Valuation Summary), without this adjustment when it is edited. They
// are reloaded when the date or the items change; when the date changes, the NEW QTY / NEW VALUE
// already entered are kept (the difference is recalculated), since they are what was counted.
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { BarChart3 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api, getCompanyId, qs } from '@/api/client';
import { useItemsById, usePrefValues } from '@/api/hooks';
import { emptyLine, emptyTxn, type Account, type ID, type Item, type ReportResult, type Txn, type TxnLine } from '@/api/types';
import { AccountPicker, ClassPicker, DateField, Grid, ItemLabel, ItemPicker, NamePicker, SegmentedControl, TextField, useNewRow, type GridColumn, type GridEditorProps } from '@/components';
import { focusField } from '@/components/focus';
import { TxnFormFrame, TxnHeaderField, copyAsNew, stripEmptyLines, useTxnForm, type TxnProblem } from '@/forms';
import { useWindow } from '@/windows/WindowContext';
import { todayIso } from '@/util/dates';
import { fmtDate, fmtMoney, fmtQty, round2, roundTo } from '@/util/format';
import { openReport, sum2 } from './shared';
import './vendors.css';

export interface InventoryAdjustFormProps {
  id?: number;
  /** Start with a line for this item (Item List > Adjust quantity/value on hand). */
  itemId?: number;
  template?: Txn;
}

type Mode = 'qty' | 'value' | 'both';

/** Quantity and asset value of an item on hand. */
interface OnHand {
  qty: number;
  value: number;
}

/** Quantity and value on hand of these items at the end of `date` (Inventory Valuation Summary). */
async function fetchOnHand(date: string, ids: ID[], signal?: AbortSignal): Promise<{ date: string; map: Map<ID, OnHand> }> {
  const r = await api.get<ReportResult>('/reports/inventory_valuation_summary' + qs({ from: '', to: date, itemIds: ids.join(','), includeSubitems: '0' }), { signal });
  const map = new Map<ID, OnHand>();
  for (const row of r.rows) {
    const id = Number(row.drill?.params?.itemIds);
    if (!id || !ids.includes(id) || (map.has(id) && row.kind !== 'data')) continue;
    map.set(id, { qty: Number(row.cells.onhand ?? 0) || 0, value: Number(row.cells.value ?? 0) || 0 });
  }
  // items without any inventory activity by that date are not listed
  for (const id of ids) if (!map.has(id)) map.set(id, { qty: 0, value: 0 });
  return { date, map };
}

const NEGATIVE_QTY = 'A counted quantity cannot be below zero.';

function modeOf(t: Txn): Mode {
  const ex = (t.extra ?? {}) as Record<string, unknown>;
  if (ex.adjustmentType === 'qty' || ex.adjustmentType === 'value' || ex.adjustmentType === 'both') return ex.adjustmentType;
  if (ex.valueAdjustment === true) return t.lines.some((l) => (l.qty ?? 0) !== 0) ? 'both' : 'value';
  return 'qty';
}

export default function InventoryAdjustForm(props: InventoryAdjustFormProps) {
  const win = useWindow();
  const itemsById = useItemsById();
  const prefsNow = usePrefValues();
  const loadedOnce = useRef(false);
  /** Put the cursor in the Adjustment date once the blank adjustment is shown. */
  const focusDate = useRef(false);

  const form = useTxnForm({
    type: 'INVADJ',
    id: props.id,
    makeNew: async () => {
      const t: Txn = props.template ? { ...copyAsNew(props.template), date: props.template.date || todayIso() } : emptyTxn('INVADJ', todayIso());
      t.type = 'INVADJ';
      if (!t.accountId) {
        const accts = await api.get<Account[]>('/accounts').catch(() => [] as Account[]);
        const guess = accts.find((a) => /inventory\s*adj/i.test(a.name) && !['Accounts Receivable', 'Accounts Payable', 'Non-Posting'].includes(a.type));
        t.accountId = guess?.id ?? null;
      }
      if (props.itemId && !t.lines.length) {
        const it = await api.get<Item>(`/items/${props.itemId}`).catch(() => null);
        if (it) t.lines = [{ ...emptyLine('item', 1), itemId: it.id, description: it.description || it.purchaseDescription }];
      }
      t.extra = { ...(t.extra ?? {}), adjustmentType: modeOf(t), valueAdjustment: modeOf(t) !== 'qty' };
      return t;
    },
    // a blank adjustment loaded later (toolbar New, Save and new…) starts at the date, like a new window
    onLoaded: (_t, isNew) => {
      if (isNew && loadedOnce.current) focusDate.current = true;
      loadedOnce.current = true;
    },
    prepare: (t) => {
      const s = stripEmptyLines(t);
      const m = modeOf(t);
      const lines = s.lines.map((l) => ({
        ...l,
        kind: 'item' as const,
        qty: m === 'value' ? 0 : l.qty,
        amount: m === 'qty' ? l.amount : round2(l.amount || 0),
      }));
      return { ...s, lines, extra: { ...(s.extra ?? {}), adjustmentType: m, valueAdjustment: m !== 'qty' } };
    },
    validate: (t) => {
      const m = modeOf(t);
      const p: TxnProblem[] = [];
      if (!t.lines.length) p.push({ field: 'lines', message: 'Add at least one inventory item to adjust.' });
      t.lines.forEach((l, i) => {
        if (!l.itemId) p.push({ field: 'lines', message: `Line ${i + 1} needs an inventory item.` });
        else if (m === 'qty' && !l.qty) p.push({ field: 'lines', message: `Line ${i + 1}: enter the new quantity (it is the same as the current one).` });
        else if (m === 'value' && !l.amount) p.push({ field: 'lines', message: `Line ${i + 1}: enter the new value (it is the same as the current one).` });
        else if (m === 'both' && !l.amount && !l.qty) p.push({ field: 'lines', message: `Line ${i + 1}: change the quantity or the value.` });
        else {
          const b = baseRef.current(l);
          if (!b) p.push({ field: 'lines', message: `Line ${i + 1}: the quantity on hand on ${fmtDate(t.date)} is still loading. Try again in a moment.` });
          else if (m !== 'value' && l.qty !== null && roundTo(b.qty + l.qty, 5) < 0) p.push({ field: 'lines', message: `Line ${i + 1}: ${NEGATIVE_QTY}` });
        }
      });
      return p;
    },
  });
  const { txn, original } = form;
  const saved = !!txn.id;
  const readOnly = txn.voided;
  const mode = modeOf(txn);

  // New / Save and new: the cursor goes to the Adjustment date (also after a saved adjustment was
  // shown, where the form would otherwise pick Customer:Job), unless a message box or another
  // window has the keyboard
  useEffect(() => {
    if (form.loading || !focusDate.current) return;
    focusDate.current = false;
    const root = form.rootRef.current;
    const ae = document.activeElement as HTMLElement | null;
    if (!root || (ae && ae !== document.body && !(root.closest('[data-window-id]') ?? root).contains(ae))) return;
    focusField(root, 'date');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.loading, txn]);

  useEffect(() => {
    win.setTitle(saved ? `Inventory Adjustment ${txn.refNumber || fmtDate(txn.date)}` : 'Adjust Inventory');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved, txn.refNumber, txn.date]);

  // ---- quantity and value on hand as of the adjustment date
  const itemIds = useMemo(() => [...new Set(txn.lines.map((l) => l.itemId).filter((x): x is ID => !!x))].sort((a, b) => a - b), [txn.lines]);
  const onHand = useQuery({
    // the saved version is part of the key: after a save the figures are read again
    queryKey: ['invadj-onhand', txn.date, itemIds.join(','), original?.id ?? 0, original?.updatedAt ?? ''],
    queryFn: ({ signal }) => fetchOnHand(txn.date, itemIds, signal),
    enabled: !!getCompanyId() && !form.loading && !!txn.date && itemIds.length > 0,
    staleTime: 0,
  });
  const asOf = onHand.data && onHand.data.date === txn.date ? onHand.data.map : null;

  /** Quantity and value on hand before this adjustment as of its date (null while loading). */
  const baseOf = (itemId: ID | null): OnHand | null => {
    if (!itemId) return null;
    const b = asOf?.get(itemId);
    if (!b) return null;
    let { qty, value } = b;
    // editing a saved adjustment: the figures include it when it is dated on or before the date
    if (original && !original.voided && !original.isPending && original.date <= txn.date) {
      for (const o of original.lines) {
        if (o.itemId !== itemId) continue;
        qty -= o.qty ?? 0;
        value -= o.amount ?? 0;
      }
    }
    return { qty: roundTo(qty, 5), value: round2(value) };
  };
  const base = (l: TxnLine): OnHand | null => baseOf(l.itemId);
  const baseRef = useRef(base);
  baseRef.current = base;

  // When the date changes, keep the counted NEW QTY / NEW VALUE: re-derive the differences from
  // the figures of the new date. (Figures refreshed for the same date leave the lines alone.)
  const applied = useRef<{ date: string; map: Map<ID, OnHand> } | null>(null);
  const loadedKey = `${form.loading}:${original?.id ?? 0}`;
  useLayoutEffect(() => {
    applied.current = null;
  }, [loadedKey]);
  useLayoutEffect(() => {
    if (!asOf) return;
    const cur = new Map<ID, OnHand>();
    for (const id of asOf.keys()) {
      const b = baseOf(id);
      if (b) cur.set(id, b);
    }
    const prev = applied.current;
    if (prev && prev.date !== txn.date) {
      const m = modeOf(txn);
      let changed = false;
      const lines = txn.lines.map((l) => {
        const a = l.itemId ? prev.map.get(l.itemId) : undefined;
        const b = l.itemId ? cur.get(l.itemId) : undefined;
        if (!a || !b) return l;
        let n = l;
        if (m !== 'value' && l.qty !== null && a.qty !== b.qty) n = { ...n, qty: roundTo(l.qty + a.qty - b.qty, 5) };
        if (m !== 'qty' && l.amount && a.value !== b.value) n = { ...n, amount: round2(l.amount + a.value - b.value) };
        if (n !== l) changed = true;
        return n;
      });
      if (changed) form.setLines(lines);
      applied.current = { date: txn.date, map: cur };
    } else {
      applied.current = { date: txn.date, map: new Map([...(prev?.map ?? []), ...cur]) };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asOf, txn.date]);

  /** Value of a quantity change at the average cost on the adjustment date (estimate). */
  const estimate = (l: TxnLine): number => {
    if (!l.itemId || !l.qty) return 0;
    const b = baseOf(l.itemId);
    const it = itemsById.get(l.itemId);
    const avg = b && b.qty > 0 ? b.value / b.qty : it?.avgCost || it?.cost || 0;
    return round2(avg * l.qty);
  };
  const estimateRef = useRef(estimate);
  estimateRef.current = estimate;
  const txnDateRef = useRef(txn.date);
  txnDateRef.current = txn.date;

  const setMode = (m: Mode) => {
    if (m === mode) return;
    const lines = txn.lines.map((l) => (m === 'value' ? { ...l, qty: 0 } : m === 'qty' ? { ...l, amount: 0 } : l));
    form.update({ lines, extra: { ...(txn.extra ?? {}), adjustmentType: m, valueAdjustment: m !== 'qty' } });
  };

  const newRow = useNewRow(() => emptyLine('item'));
  const columns = useMemo<GridColumn<TxnLine>[]>(() => {
    const cols: GridColumn<TxnLine>[] = [
      {
        key: 'itemId',
        label: 'ITEM',
        width: 180,
        editor: (p: GridEditorProps<TxnLine>) => (
          <ItemPicker
            inGrid
            autoFocus
            types={['Inventory Part']}
            showOnHand
            aria-label="Item"
            value={p.value as ID | null}
            onChange={(id, it) => p.onRowChange({ itemId: id, description: it ? it.description || it.purchaseDescription : '', qty: null, amount: 0 })}
          />
        ),
        render: (r) => <ItemLabel id={r.itemId} />,
      },
      { key: 'description', label: 'DESCRIPTION', width: 180, grow: true, editor: 'text' },
    ];
    const pending = <span className="vx-muted" title="Loading the figures as of the adjustment date…">…</span>;
    if (mode !== 'value') {
      cols.push(
        {
          key: 'curQty',
          label: 'CURRENT QTY',
          width: 104,
          align: 'right',
          title: 'Quantity on hand at the end of the adjustment date',
          render: (r) => (r.itemId ? (baseRef.current(r) ? fmtQty(baseRef.current(r)!.qty) : pending) : ''),
        },
        {
          key: 'newQty',
          label: 'NEW QTY',
          width: 90,
          align: 'right',
          editor: 'qty',
          readOnly: (r) => !r.itemId || !baseRef.current(r),
          get: (r) => {
            const b = baseRef.current(r);
            return r.itemId && b && r.qty !== null ? roundTo(b.qty + (r.qty ?? 0), 5) : null;
          },
          set: (r, v) => {
            const b = baseRef.current(r);
            if (!b) return r;
            return { ...r, qty: v === null || v === undefined ? null : roundTo(Number(v) - b.qty, 5) };
          },
          render: (r) => {
            if (!r.itemId || r.qty === null) return '';
            const b = baseRef.current(r);
            if (!b) return pending;
            const n = roundTo(b.qty + (r.qty ?? 0), 5);
            return n < 0 ? (
              <span className="vx-danger-text" title={NEGATIVE_QTY}>
                {fmtQty(n)}
              </span>
            ) : (
              fmtQty(n)
            );
          },
        },
        { key: 'qty', label: 'QTY DIFFERENCE', width: 124, align: 'right', editor: 'qty', readOnly: (r) => !r.itemId, render: (r) => (r.qty === null ? '' : (r.qty > 0 ? '+' : '') + fmtQty(r.qty)) },
      );
    }
    if (mode !== 'qty') {
      cols.push(
        {
          key: 'curValue',
          label: 'CURRENT VALUE',
          width: 120,
          align: 'right',
          title: 'Asset value at the end of the adjustment date',
          render: (r) => (r.itemId ? (baseRef.current(r) ? fmtMoney(baseRef.current(r)!.value) : pending) : ''),
        },
        {
          key: 'newValue',
          label: 'NEW VALUE',
          width: 104,
          align: 'right',
          editor: 'money',
          readOnly: (r) => !r.itemId || !baseRef.current(r),
          get: (r) => {
            const b = baseRef.current(r);
            return r.itemId && b ? round2(b.value + (r.amount || 0)) : null;
          },
          set: (r, v) => {
            const b = baseRef.current(r);
            if (!b) return r;
            return { ...r, amount: round2(Number(v ?? 0) - b.value) };
          },
          render: (r) => {
            if (!r.itemId) return '';
            const b = baseRef.current(r);
            return b ? fmtMoney(b.value + (r.amount || 0)) : pending;
          },
        },
      );
    } else {
      cols.push({
        key: 'estValue',
        label: 'VALUE CHANGE',
        width: 118,
        align: 'right',
        title: 'Estimated at the average cost on the adjustment date; the exact value is calculated when you save',
        render: (r) => {
          if (!r.itemId || !r.qty) return '';
          if (saved && original?.lines.some((o) => o.id === r.id && o.qty === r.qty && o.itemId === r.itemId) && original.date === txnDateRef.current) return fmtMoney(r.amount);
          return '≈ ' + fmtMoney(estimateRef.current(r));
        },
      });
    }
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, itemsById, original, saved, asOf]);

  const realLines = txn.lines.filter((l) => l.itemId);
  /** A saved line whose value is known (same item, quantity and date as saved). */
  const savedValue = (l: TxnLine) => saved && !!original && original.date === txn.date && original.lines.some((o) => o.id === l.id && o.qty === l.qty && o.itemId === l.itemId);
  const valueChange = mode === 'qty' ? sum2(realLines.map((l) => (savedValue(l) ? l.amount : estimate(l)))) : sum2(realLines.map((l) => l.amount || 0));
  const estimated = mode === 'qty' && realLines.some((l) => !savedValue(l));

  const loadingFigures = realLines.some((l) => !baseOf(l.itemId));
  const negLine = mode === 'value' ? -1 : txn.lines.findIndex((l) => {
    const b = l.itemId && l.qty !== null ? baseOf(l.itemId) : null;
    return !!b && roundTo(b.qty + (l.qty ?? 0), 5) < 0;
  });
  const valuationReport = () => openReport('inventory_valuation_summary', { dates: 'custom', from: '', to: txn.date || todayIso() });

  const header = (
    <div className="vx-adj-head">
      <div className="vx-po-row">
        <TxnHeaderField label="Adjustment type" htmlFor="vx-adj-mode">
          <SegmentedControl
            size="sm"
            aria-label="Adjustment type"
            name="adjustmentType"
            value={mode}
            disabled={readOnly}
            onChange={(v) => setMode(v as Mode)}
            options={[
              { value: 'qty', label: 'Quantity', title: 'Change how many you have (value follows the average cost)' },
              { value: 'value', label: 'Total value', title: 'Change only the value of what you have' },
              { value: 'both', label: 'Quantity and total value', title: 'Change both the quantity and the value' },
            ]}
          />
        </TxnHeaderField>
        <div className="sx-hspacer" />
        <TxnHeaderField label="Adjustment date" required htmlFor="vx-adj-date" width={150}>
          <DateField id="vx-adj-date" name="date" value={txn.date} readOnly={readOnly} autoFocus={!props.id} onChange={(d) => form.update({ date: d })} />
        </TxnHeaderField>
        <TxnHeaderField label="Ref. no." htmlFor="vx-adj-ref" width={110}>
          <TextField id="vx-adj-ref" name="refNumber" value={txn.refNumber} readOnly={readOnly} onChange={(v) => form.update({ refNumber: v })} maxLength={20} />
        </TxnHeaderField>
      </div>
      <div className="vx-po-row">
        <TxnHeaderField
          label="Adjustment account"
          required
          htmlFor="vx-adj-acct"
          width={260}
          help="The account that takes the other side of the change, usually an expense or cost of goods sold account such as Inventory Adjustments (shrinkage, damage, count differences)."
        >
          <AccountPicker
            id="vx-adj-acct"
            name="accountId"
            value={txn.accountId}
            readOnly={readOnly}
            excludeTypes={['Accounts Receivable', 'Accounts Payable', 'Non-Posting']}
            onChange={(id) => form.update({ accountId: id })}
          />
        </TxnHeaderField>
        <TxnHeaderField label="Customer or Job" htmlFor="vx-adj-cust" width={220} help="Customer or Job">
          <NamePicker id="vx-adj-cust" name="nameId" kinds={['customer']} value={txn.nameId} fallbackLabel={txn.nameFull} readOnly={readOnly} onChange={(id, n) => form.update({ nameId: id, nameFull: n?.fullName ?? '' })} />
        </TxnHeaderField>
        {prefsNow.useClassTracking && (
          <TxnHeaderField label="Class" htmlFor="vx-adj-class" width={170} help="Class">
            <ClassPicker id="vx-adj-class" name="classId" value={txn.classId} readOnly={readOnly} onChange={(id) => form.update({ classId: id })} />
          </TxnHeaderField>
        )}
      </div>
    </div>
  );

  return (
    <TxnFormFrame
      form={form}
      title="Inventory Adjustment"
      status={txn.voided ? 'Void' : null}
      header={header}
      stamp={txn.voided ? 'VOID' : null}
      readOnly={readOnly}
      reportButtons={[{ label: 'Inventory valuation summary', onClick: valuationReport }]}
      extraButtons={[{ key: 'val', label: 'Inventory value', icon: BarChart3, color: '#0891b2', title: `Inventory Valuation Summary as of ${fmtDate(txn.date)}`, onClick: valuationReport }]}
      lines={
        <>
          {negLine >= 0 ? (
            <div className="vx-note vx-warn">
              Line {negLine + 1}: {NEGATIVE_QTY} Enter what you counted (0 or more).
            </div>
          ) : itemIds.length > 0 && !readOnly ? (
            <div className="vx-note">{loadingFigures ? `Loading the quantities on hand on ${fmtDate(txn.date)}…` : `Current quantities and values are as of ${fmtDate(txn.date)}, the adjustment date.`}</div>
          ) : null}
          <Grid<TxnLine>
            key={mode}
            aria-label="Items to adjust"
            columns={columns}
            rows={txn.lines}
            onChange={form.setLines}
            newRow={newRow}
            readOnly={readOnly}
            minRows={7}
            persistKey={`invadj2-${mode}`}
          />
        </>
      }
      footer={
        <div className="vx-memo-row">
          <TxnHeaderField label="Memo" htmlFor="vx-adj-memo" help="Memo">
            <TextField id="vx-adj-memo" name="memo" value={txn.memo} readOnly={readOnly} onChange={(v) => form.update({ memo: v })} placeholder="Why the adjustment (count, damage, shrinkage…)" />
          </TxnHeaderField>
        </div>
      }
      totals={[
        { key: 'n', label: 'Item adjustments', value: String(realLines.length) },
        { key: 'v', label: estimated ? 'Value of adjustment (est.)' : 'Total value of adjustment', value: valueChange, strong: true, tone: valueChange < 0 ? 'danger' : undefined },
      ]}
    />
  );
}
