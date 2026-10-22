// Lines grid of the sales forms (invoices, sales receipts, credit memos, estimates).
//
// Column sets follow the form templates:
//   product      QTY, ITEM CODE, DESCRIPTION, PRICE EACH, (CLASS), AMOUNT, TAX
//   service      ITEM, QTY, DESCRIPTION, RATE, (CLASS), AMOUNT, TAX
//   professional DATE, ITEM, DESCRIPTION, QTY, RATE, (CLASS), AMOUNT, TAX
//   standard     ITEM, DESCRIPTION, QTY, RATE, (CLASS), AMOUNT, TAX   (receipts, credit memos, estimates)
// Choosing an item fills the description, rate, taxable flag (item taxable and customer taxable)
// and quantity 1; qty × rate = amount, editing the amount recomputes the rate. Group items expand
// into a line with the group's name and description followed by their member lines; where QTY
// comes after ITEM (Service, Professional, standard layouts) the number of groups is asked first.
// Subtotal and percent lines (discounts, % charges) are computed by computeSales, so their amount
// cells are read-only.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePrefValues } from '@/api/hooks';
import { emptyLine, type ID, type Item, type ItemType, type TxnLine } from '@/api/types';
import { AccountLabel, Button, ClassPicker, Grid, ItemLabel, ItemPicker, ListEntryLabel, NumberField, showDialog, type GridApi, type GridColumn, type GridEditorProps, type MenuItem } from '@/components';
import { fmtMoney, fmtQty, lineAmount, round2, roundTo } from '@/util/format';
import { lineTaxable } from './shared';

/** Column layout of {@link SalesLinesGrid}. */
export type SalesLayout = 'product' | 'service' | 'professional' | 'standard';

/** Props of {@link SalesLinesGrid}. */
export interface SalesLinesGridProps {
  /** Item lines of the form (the computed ones: subtotals and percent lines filled in). */
  lines: TxnLine[];
  onChange(lines: TxnLine[]): void;
  layout: SalesLayout;
  itemsById: Map<ID, Item>;
  /** Customer tax code (new lines are taxable only when the customer is). */
  customerTaxable: boolean;
  readOnly?: boolean;
  /** Extra right-click entries. */
  contextMenu?(row: TxnLine | null, index: number): MenuItem[];
  /** Grid column widths are remembered under this key. */
  persistKey: string;
  minRows?: number;
}

const NO_QTY_TYPES = new Set(['Subtotal', 'Discount', 'Payment', 'Sales Tax Item', 'Sales Tax Group']);
const EXCLUDE_ITEM_TYPES: ItemType[] = ['Sales Tax Group'];

function renumber(lines: TxnLine[]): TxnLine[] {
  return lines.map((l, i) => (l.seq === i + 1 ? l : { ...l, seq: i + 1 }));
}

/** Rate shown in the grid: percent rates with "%", money-like rates with 2+ decimals. */
export function fmtRate(l: Pick<TxnLine, 'rate' | 'rateIsPercent'>): string {
  if (l.rate === null || l.rate === undefined) return '';
  if (l.rateIsPercent) return `${fmtQty(l.rate)}%`;
  return Number.isInteger(Math.round(l.rate * 100 * 1e6) / 1e6) ? fmtMoney(l.rate) : fmtQty(l.rate);
}

/** A line filled from an item (description, rate, qty 1, taxable), keeping the given fields. */
export function lineFromItem(base: TxnLine, it: Item, customerTaxable: boolean, qtyMul = 1): TxnLine {
  const type = it.type;
  const taxable = lineTaxable(it, customerTaxable);
  if (type === 'Subtotal') return { ...base, itemId: it.id, description: it.description, qty: null, rate: null, rateIsPercent: false, amount: 0, taxable: false };
  if (type === 'Sales Tax Item') return { ...base, itemId: it.id, description: it.description, qty: null, rate: it.taxRate, rateIsPercent: true, amount: 0, taxable: false };
  if (it.rateIsPercent) return { ...base, itemId: it.id, description: it.description, qty: null, rate: it.salesPrice, rateIsPercent: true, amount: 0, taxable };
  if (type === 'Discount') {
    const rate = -Math.abs(it.salesPrice);
    return { ...base, itemId: it.id, description: it.description, qty: null, rate, rateIsPercent: false, amount: rate, taxable };
  }
  if (type === 'Payment') return { ...base, itemId: it.id, description: it.description, qty: null, rate: null, rateIsPercent: false, amount: base.amount ? -Math.abs(base.amount) : 0, taxable: false };
  const qty = base.qty ? base.qty : roundTo(1 * qtyMul, 5);
  const rate = it.salesPrice ?? 0;
  return { ...base, itemId: it.id, description: it.description, qty, rate, rateIsPercent: false, amount: lineAmount(qty, rate), taxable };
}

/** Text of the description line put above a group's members ("Spring Planting Package (2): Lavender border..."). */
export function groupLineText(g: Item, qty: number): string {
  const name = qty !== 1 ? `${g.fullName} (${fmtQty(qty)})` : g.fullName;
  return g.description ? `${name}: ${g.description}` : name;
}

/**
 * Expands Group item lines into a description line with the group's name and description, then
 * its member item lines (quantities multiplied by the group quantity).
 */
export function expandGroups(lines: TxnLine[], itemsById: Map<ID, Item>, customerTaxable: boolean): TxnLine[] {
  if (!lines.some((l) => l.itemId && itemsById.get(l.itemId)?.type === 'Group')) return lines;
  const out: TxnLine[] = [];
  for (const l of lines) {
    const g = l.itemId ? itemsById.get(l.itemId) : undefined;
    if (!g || g.type !== 'Group') {
      out.push(l);
      continue;
    }
    const mul = l.qty && l.qty > 0 ? l.qty : 1;
    // the group itself does not post: a description-only line shows (and prints) its name and description
    out.push({ ...emptyLine('item'), description: groupLineText(g, mul), classId: l.classId, serviceDate: l.serviceDate });
    for (const m of g.groupLines) {
      const it = itemsById.get(m.itemId);
      if (!it) continue;
      out.push(lineFromItem({ ...emptyLine('item'), classId: l.classId, serviceDate: l.serviceDate }, it, customerTaxable, (m.qty || 1) * mul));
    }
  }
  return renumber(out);
}

/** "How many?" box for a group item picked where QTY comes after ITEM; resolves null when cancelled. */
export function askGroupQty(g: Item, initial: number | null): Promise<number | null> {
  return showDialog<number | null>({
    title: `Add ${g.fullName}`,
    width: 420,
    cancelValue: null,
    render: (close) => <GroupQtyBody g={g} initial={initial && initial > 0 ? initial : 1} close={close} />,
  });
}

function GroupQtyBody({ g, initial, close }: { g: Item; initial: number; close: (v: number | null) => void }) {
  const [qty, setQty] = useState<number | null>(initial);
  const latest = useRef<number | null>(initial);
  const ok = () => {
    const q = latest.current;
    if (q && q > 0) close(q);
  };
  return (
    <div className="sx-cust-dlg">
      <p>
        <b>{g.fullName}</b> is a group of {g.groupLines.length} {g.groupLines.length === 1 ? 'item' : 'items'}. How many do you sell? Each item&apos;s quantity is multiplied by this
        number.
      </p>
      <label className="sx-cust-flabel">
        QUANTITY
        <NumberField
          autoFocus
          width={90}
          aria-label="Quantity of the group"
          value={qty}
          onChange={(v) => {
            latest.current = v;
            setQty(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              setTimeout(ok, 0);
            }
          }}
        />
      </label>
      <div className="sx-dlg-buttons">
        <Button variant="secondary" label="Cancel" onClick={() => close(null)} />
        <Button variant="primary" label="OK" disabled={!qty || qty <= 0} onClick={ok} />
      </div>
    </div>
  );
}

/** Editable sales lines grid (see the file header). */
export function SalesLinesGrid({ lines, onChange, layout, itemsById, customerTaxable, readOnly, contextMenu, persistKey, minRows = 6 }: SalesLinesGridProps) {
  const prefs = usePrefValues();
  const ctx = useRef({ itemsById, customerTaxable });
  ctx.current = { itemsById, customerTaxable };

  const itemOf = (l: TxnLine) => (l.itemId ? ctx.current.itemsById.get(l.itemId) : undefined);
  const isComputed = (l: TxnLine) => {
    const it = itemOf(l);
    return it?.type === 'Subtotal' || l.rateIsPercent;
  };
  const noQty = (l: TxnLine) => {
    const it = itemOf(l);
    return (!!it && NO_QTY_TYPES.has(it.type)) || l.rateIsPercent;
  };

  const onRowChange = (next: TxnLine, prev: TxnLine, key: string): TxnLine => {
    let r = next.kind === 'item' ? next : { ...next, kind: 'item' as const };
    const it = itemOf(r);
    if (key === 'itemId') {
      if (!r.itemId) return { ...r, rate: null, rateIsPercent: false };
      if (it && it.type !== 'Group') r = lineFromItem(r, it, ctx.current.customerTaxable);
      return r;
    }
    if (key === 'qty' || key === 'rate') {
      if (!r.rateIsPercent && it?.type !== 'Subtotal') r = { ...r, amount: lineAmount(r.qty, r.rate) };
      if (it?.type === 'Discount' && !r.rateIsPercent && r.amount > 0) r = { ...r, amount: -r.amount, rate: r.rate !== null ? -Math.abs(r.rate) : r.rate };
    } else if (key === 'amount') {
      let amt = r.amount;
      if ((it?.type === 'Discount' || it?.type === 'Payment') && amt > 0) amt = -amt;
      r = { ...r, amount: round2(amt) };
      if (it?.type !== 'Payment') {
        if (r.qty) r = { ...r, rate: roundTo(r.amount / r.qty, 5) };
        else r = { ...r, rate: r.amount };
      }
    }
    return r;
  };

  // QTY after ITEM: the number of groups cannot be typed before the group expands, so it is asked first
  const qtyAfterItem = layout !== 'product';
  const asking = useRef(false);
  const gridApi = useRef<GridApi | null>(null);
  // cell to edit once the box closed and the lines are rendered (the box took the keyboard away
  // from the grid); a layout effect, so the cell is focused before the grid's blur check runs
  const focusAfter = useRef<{ row: number; key?: string } | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  useLayoutEffect(() => {
    const f = focusAfter.current;
    if (!f) return;
    focusAfter.current = null;
    gridApi.current?.activate(f.row, f.key);
  }, [lines, focusTick]);
  const change = (rows: TxnLine[]) => {
    const gi = rows.findIndex((l) => !!l.itemId && ctx.current.itemsById.get(l.itemId)?.type === 'Group');
    const g = gi >= 0 ? ctx.current.itemsById.get(rows[gi].itemId!) : undefined;
    if (!g || !qtyAfterItem) {
      onChange(renumber(expandGroups(rows, ctx.current.itemsById, ctx.current.customerTaxable)));
      return;
    }
    if (asking.current) return;
    asking.current = true;
    void askGroupQty(g, rows[gi].qty).then((q) => {
      asking.current = false;
      // cancelled: the lines stay as they were before the group was picked, and the ITEM cell of
      // that line gets the keyboard back to pick another item
      if (q === null) {
        focusAfter.current = { row: gi, key: 'itemId' };
        setFocusTick((n) => n + 1);
        return;
      }
      const next = rows.map((l, i) => (i === gi ? { ...l, qty: q } : l));
      const { itemsById: byId, customerTaxable: taxable } = ctx.current;
      // the quantity was given in the box: editing goes on with the line after the group's items
      focusAfter.current = { row: expandGroups(next.slice(0, gi + 1), byId, taxable).length };
      onChange(renumber(expandGroups(next, byId, taxable)));
    });
  };

  const itemEditor = (p: GridEditorProps<TxnLine>) => (
    <ItemPicker
      inGrid
      autoFocus
      aria-label="Item"
      excludeTypes={EXCLUDE_ITEM_TYPES}
      value={p.value as ID | null}
      onChange={(id, rec) => {
        // use the picked record itself: an item created a moment ago (quick create) is not in itemsById yet
        if (id && rec && rec.type !== 'Group' && rec.id !== p.row.itemId) p.onRowChange(lineFromItem({ ...p.row, itemId: id }, rec, ctx.current.customerTaxable));
        else p.onChange(id);
      }}
    />
  );
  const rateEditor = (p: GridEditorProps<TxnLine>) => (
    <NumberField inGrid autoFocus aria-label="Rate" value={p.value as number | null} suffix={p.row.rateIsPercent ? '%' : undefined} onChange={(v) => p.onChange(v)} />
  );
  const taxEditor = (p: GridEditorProps<TxnLine>) => (
    <select
      className="sx-select sx-in-grid"
      autoFocus
      aria-label="Tax"
      value={p.row.taxable ? 'Tax' : 'Non'}
      onChange={(e) => p.onChange(e.target.value === 'Tax')}
      onKeyDown={(e) => {
        if (e.key === 't' || e.key === 'T') {
          e.preventDefault();
          p.onChange(true);
        } else if (e.key === 'n' || e.key === 'N') {
          e.preventDefault();
          p.onChange(false);
        }
      }}
    >
      <option value="Tax">Tax</option>
      <option value="Non">Non</option>
    </select>
  );

  const columns = useMemo<GridColumn<TxnLine>[]>(() => {
    const item: GridColumn<TxnLine> = {
      key: 'itemId',
      label: layout === 'product' ? 'ITEM CODE' : 'ITEM',
      width: 170,
      editor: itemEditor,
      render: (r) =>
        r.itemId ? (
          <ItemLabel id={r.itemId} />
        ) : r.accountId ? (
          <span className="sx-muted" title="Posts to this account (reimbursed expense)">
            <AccountLabel id={r.accountId} />
          </span>
        ) : null,
    };
    const qty: GridColumn<TxnLine> = {
      key: 'qty',
      label: layout === 'product' ? 'QUANTITY' : 'QTY',
      width: layout === 'product' ? 86 : 62,
      editor: 'qty',
      align: 'right',
      readOnly: (r) => noQty(r),
    };
    const desc: GridColumn<TxnLine> = { key: 'description', label: 'DESCRIPTION', width: 220, grow: true, editor: 'text' };
    const rate: GridColumn<TxnLine> = {
      key: 'rate',
      label: layout === 'product' ? 'PRICE EACH' : 'RATE',
      width: 92,
      editor: rateEditor,
      align: 'right',
      render: (r) => fmtRate(r),
      readOnly: (r) => itemOf(r)?.type === 'Subtotal' || itemOf(r)?.type === 'Payment',
    };
    const cls: GridColumn<TxnLine> = {
      key: 'classId',
      label: 'CLASS',
      width: 110,
      hidden: !prefs.useClassTracking,
      editor: (p) => <ClassPicker inGrid autoFocus aria-label="Class" value={p.value as ID | null} onChange={(id) => p.onChange(id)} />,
      render: (r) => <ListEntryLabel list="class" id={r.classId} />,
    };
    const amount: GridColumn<TxnLine> = {
      key: 'amount',
      label: 'AMOUNT',
      width: 100,
      editor: 'money',
      align: 'right',
      readOnly: (r) => isComputed(r),
      render: (r) => (r.itemId || r.amount ? fmtMoney(r.amount) : ''),
    };
    const tax: GridColumn<TxnLine> = {
      key: 'taxable',
      label: 'TAX',
      width: 52,
      align: 'center',
      hidden: !prefs.salesTaxEnabled,
      editor: taxEditor,
      readOnly: (r) => !r.itemId || itemOf(r)?.type === 'Subtotal' || itemOf(r)?.type === 'Payment',
      render: (r) => (r.itemId && itemOf(r)?.type !== 'Subtotal' && itemOf(r)?.type !== 'Payment' ? (r.taxable ? 'Tax' : 'Non') : ''),
      title: 'Taxable (Tax) or not taxable (Non)',
    };
    const svcDate: GridColumn<TxnLine> = { key: 'serviceDate', label: 'DATE', width: 96, editor: 'date' };
    switch (layout) {
      case 'product':
        return [qty, item, desc, rate, cls, amount, tax];
      case 'service':
        return [item, qty, desc, rate, cls, amount, tax];
      case 'professional':
        // the TAX column stays while sales tax is on: the lines are taxed, so the user must see (and change) it
        return [svcDate, item, desc, qty, rate, cls, amount, tax];
      default:
        return [item, desc, qty, rate, cls, amount, tax];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, prefs.useClassTracking, prefs.salesTaxEnabled]);

  return (
    <Grid<TxnLine>
      aria-label="Lines"
      className="sx-cust-lines"
      columns={columns}
      rows={lines}
      onChange={change}
      newRow={() => emptyLine('item')}
      onRowChange={onRowChange}
      apiRef={gridApi}
      readOnly={readOnly}
      minRows={minRows}
      contextMenu={contextMenu}
      persistKey={persistKey}
      rowClassName={(r) => (itemOf(r)?.type === 'Subtotal' ? 'sx-cust-subtotal-row' : undefined)}
    />
  );
}
