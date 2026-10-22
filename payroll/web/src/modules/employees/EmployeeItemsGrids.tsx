// Payroll Info grids of the employee window and the employee defaults:
//   EARNINGS: ITEM NAME / HOURLY/ANNUAL RATE / DEFAULT HOURS
//   ADDITIONS, DEDUCTIONS AND COMPANY CONTRIBUTIONS: ITEM NAME / AMOUNT / LIMIT
//   (Taxes > Other) ITEM NAME / RATE
// Deduction amounts and limits are shown as negative numbers (they reduce the paycheck); the
// records keep positive values (the server accepts both).
import { useMemo } from 'react';
import { useItemsById } from '@/api/hooks';
import { WAGE_TYPES, type EmployeeItem, type Id, type ItemType, type PayrollItem } from '@/api/types';
import { Grid, MoneyField, NumberField, PayrollItemPicker, useNewRow, type GridColumn, type GridEditorProps } from '@/components';
import { fmtMoney, fmtPercent, fmtQty } from '@/util/format';
import { OTHER_ITEM_TYPES } from './shared';

/** An empty grid line. */
export function blankItemLine(): EmployeeItem {
  return { itemId: 0, rate: 0, annualLimit: null, qty: null, itemName: '', itemType: '', calc: '' };
}

/** Lines with an item (the grid's empty lines dropped). */
export function realLines(rows: EmployeeItem[]): EmployeeItem[] {
  return rows.filter((r) => r.itemId > 0);
}

/** A line for a picked item: name, type and calculation copied, default rate and limit from the item. */
export function lineFor(item: PayrollItem, prev: EmployeeItem = blankItemLine()): EmployeeItem {
  const same = prev.itemId === item.id;
  return {
    itemId: item.id,
    itemName: item.name,
    itemType: item.type,
    calc: item.calc,
    rate: same ? prev.rate : item.type === 'overtime' ? 0 : item.rate,
    annualLimit: same ? prev.annualLimit : item.annualLimit,
    qty: same ? prev.qty : null,
  };
}

const isPercent = (r: EmployeeItem, it?: PayrollItem) => {
  const calc = it?.calc ?? r.calc;
  const type = it?.type ?? r.itemType;
  return calc === 'percent' || calc === 'match' || type === 'other_tax' || (type === 'commission' && calc === 'quantity');
};

function itemPicker(types: ItemType[], byId: Map<Id, PayrollItem>, exclude: () => Id[]) {
  return function ItemCell(p: GridEditorProps<EmployeeItem>) {
    // "+ Add new" opens the payroll item wizard; in the Taxes dialog the dialog steps aside while
    // the wizard is open (components/layers.ts) and the new item is put in this cell
    return (
      <PayrollItemPicker
        inGrid
        autoFocus
        aria-label="Item name"
        types={types}
        value={p.row.itemId || null}
        fallbackLabel={p.row.itemName}
        filter={(i) => i.id === p.row.itemId || (i.active && !exclude().includes(i.id))}
        onChange={(id, it) => {
          const item = it ?? (id ? byId.get(id) : undefined);
          if (!id || !item) {
            if (!p.isNew) p.onRowChange({ ...blankItemLine() });
            return;
          }
          p.onRowChange(lineFor(item, p.row));
        }}
        listWidth={360}
      />
    );
  };
}

/** Rate text of a line (percent, overtime multiplier or amount; deductions negative). */
function rateText(r: EmployeeItem, it: PayrollItem | undefined, signed: boolean): string {
  const type = (it?.type ?? r.itemType) as ItemType | '';
  if (type === 'overtime') return it?.rate ? `${fmtQty(it.rate)} × regular rate` : '';
  if (isPercent(r, it)) return r.rate ? fmtPercent(r.rate) : '';
  if (!r.rate) return '';
  return fmtMoney(signed && type === 'deduction' ? -r.rate : r.rate);
}

function RateEditor({ p, byId, signed }: { p: GridEditorProps<EmployeeItem>; byId: Map<Id, PayrollItem>; signed: boolean }) {
  const it = byId.get(p.row.itemId);
  const neg = signed && (it?.type ?? p.row.itemType) === 'deduction';
  if (isPercent(p.row, it)) {
    // no "%" suffix while editing: the cell shows "5.0%" when not editing, and an editor whose
    // edit text equals its display keeps the whole value selected when the cell is entered
    // (typing replaces it, as in the other grid cells)
    return <NumberField inGrid autoFocus aria-label="Rate" value={p.row.rate} nullable={false} onChange={(v) => p.onChange(Math.abs(v ?? 0))} />;
  }
  return <MoneyField inGrid autoFocus aria-label="Amount" value={neg ? -p.row.rate : p.row.rate} onChange={(v) => p.onChange(Math.abs(v ?? 0))} />;
}

/** Props of the item grids. */
export interface ItemGridProps {
  rows: EmployeeItem[];
  onChange(rows: EmployeeItem[]): void;
  readOnly?: boolean;
  /** Items already used elsewhere on the record (one item appears once per employee). */
  excludeIds?: Id[];
  'aria-label'?: string;
  minRows?: number;
}

/** EARNINGS grid (wage items with the hourly rate or annual salary, and default hours). */
export function EarningsGrid({ rows, onChange, readOnly, excludeIds = [], minRows = 4, ...rest }: ItemGridProps) {
  const byId = useItemsById();
  const newRow = useNewRow(blankItemLine);
  const used = () => [...rows.map((r) => r.itemId), ...excludeIds];
  const columns = useMemo<GridColumn<EmployeeItem>[]>(
    () => [
      {
        key: 'itemId',
        label: 'Item name',
        width: 170,
        grow: true,
        editor: itemPicker(WAGE_TYPES, byId, used),
        render: (r) => byId.get(r.itemId)?.name ?? r.itemName,
      },
      {
        key: 'rate',
        label: 'Hourly/annual rate',
        width: 160,
        align: 'right',
        title: 'Hourly rate for hourly items, annual salary for salary items, percent for commission, amount for bonus',
        editor: (p) => <RateEditor p={p} byId={byId} signed={false} />,
        readOnly: (r) => !r.itemId || (byId.get(r.itemId)?.type ?? r.itemType) === 'overtime',
        render: (r) => rateText(r, byId.get(r.itemId), false),
      },
      {
        key: 'qty',
        label: 'Default hours',
        width: 120,
        align: 'right',
        title: 'Hours filled in on each paycheck (leave blank to enter them when you pay)',
        editor: 'qty',
        nullable: true,
        readOnly: (r) => {
          const t = byId.get(r.itemId)?.type ?? r.itemType;
          return !r.itemId || !(t === 'hourly' || t === 'salary' || t === 'overtime');
        },
        render: (r) => (r.qty === null || r.qty === undefined ? '' : fmtQty(r.qty)),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byId, rows, excludeIds],
  );
  return <Grid<EmployeeItem> aria-label={rest['aria-label'] ?? 'Earnings'} columns={columns} rows={rows} onChange={onChange} newRow={newRow} readOnly={readOnly} minRows={minRows} persistKey="emp-earnings" />;
}

/** ADDITIONS, DEDUCTIONS AND COMPANY CONTRIBUTIONS grid (amount or percent, annual limit). */
export function OtherItemsGrid({ rows, onChange, readOnly, excludeIds = [], minRows = 4, ...rest }: ItemGridProps) {
  const byId = useItemsById();
  const newRow = useNewRow(blankItemLine);
  const used = () => [...rows.map((r) => r.itemId), ...excludeIds];
  const columns = useMemo<GridColumn<EmployeeItem>[]>(
    () => [
      {
        key: 'itemId',
        label: 'Item name',
        width: 170,
        grow: true,
        editor: itemPicker(OTHER_ITEM_TYPES, byId, used),
        render: (r) => byId.get(r.itemId)?.name ?? r.itemName,
      },
      {
        key: 'rate',
        label: 'Amount',
        width: 130,
        align: 'right',
        title: 'Amount or percent per paycheck (deductions are shown as negative numbers)',
        editor: (p) => <RateEditor p={p} byId={byId} signed />,
        readOnly: (r) => !r.itemId,
        render: (r) => rateText(r, byId.get(r.itemId), true),
      },
      {
        key: 'annualLimit',
        label: 'Limit',
        width: 130,
        align: 'right',
        title: 'Annual limit (or one-time limit when the item says so); blank uses the item limit',
        editor: (p) => {
          const neg = (byId.get(p.row.itemId)?.type ?? p.row.itemType) === 'deduction';
          const v = p.row.annualLimit;
          return (
            <MoneyField
              inGrid
              autoFocus
              nullable
              aria-label="Limit"
              value={v === null ? null : neg ? -v : v}
              onChange={(x) => p.onChange(x === null ? null : Math.abs(x))}
            />
          );
        },
        readOnly: (r) => !r.itemId,
        render: (r) => {
          if (r.annualLimit === null || r.annualLimit === undefined) return '';
          const neg = (byId.get(r.itemId)?.type ?? r.itemType) === 'deduction';
          return fmtMoney(neg ? -r.annualLimit : r.annualLimit);
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byId, rows, excludeIds],
  );
  return (
    <Grid<EmployeeItem>
      aria-label={rest['aria-label'] ?? 'Additions, deductions and company contributions'}
      columns={columns}
      rows={rows}
      onChange={onChange}
      newRow={newRow}
      readOnly={readOnly}
      minRows={minRows}
      persistKey="emp-items"
    />
  );
}

/** Taxes > Other grid: local and other taxes (Other Tax items) with an optional rate. */
export function OtherTaxesGrid({ rows, onChange, readOnly, excludeIds = [], minRows = 5, ...rest }: ItemGridProps) {
  const byId = useItemsById();
  const newRow = useNewRow(blankItemLine);
  const used = () => [...rows.map((r) => r.itemId), ...excludeIds];
  const columns = useMemo<GridColumn<EmployeeItem>[]>(
    () => [
      {
        key: 'itemId',
        label: 'Item name',
        width: 220,
        grow: true,
        editor: itemPicker(['other_tax'], byId, used),
        render: (r) => byId.get(r.itemId)?.name ?? r.itemName,
      },
      {
        key: 'rate',
        label: 'Rate',
        width: 110,
        align: 'right',
        title: 'Percent of local wages (blank uses the rate of the payroll item)',
        editor: (p) => <RateEditor p={p} byId={byId} signed={false} />,
        readOnly: (r) => !r.itemId,
        render: (r) => (r.rate ? fmtPercent(r.rate) : byId.get(r.itemId)?.rate ? `${fmtPercent(byId.get(r.itemId)!.rate)} (item)` : ''),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byId, rows, excludeIds],
  );
  return <Grid<EmployeeItem> aria-label={rest['aria-label'] ?? 'Other taxes'} columns={columns} rows={rows} onChange={onChange} newRow={newRow} readOnly={readOnly} minRows={minRows} persistKey="emp-othertax" />;
}
