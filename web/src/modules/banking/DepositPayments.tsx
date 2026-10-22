// "Payments to Deposit" dialog: payments, sales receipts and the payment lines of invoices / sales
// receipts waiting in Undeposited Funds, with a payment method filter, Select all / Select none and
// the selected total.
import { useMemo, useState } from 'react';
import type { ID, TxnLine, UndepositedItem } from '@/api/types';
import { Button, Select, showDialog } from '@/components';
import { fmtMoney } from '@/util/format';
import { CheckTable, type CheckColumn } from './CheckTable';

/**
 * Key of a row waiting in Undeposited Funds: the transaction id for a whole payment, minus the line
 * id for a payment line of an invoice or sales receipt (ids of both kinds can be equal).
 */
export function depositKey(i: Pick<UndepositedItem, 'txnId' | 'lineId'>): number {
  return i.lineId ? -i.lineId : i.txnId;
}

/** The waiting row a deposit line deposits (same key as {@link depositKey}); 0 for other lines. */
export function depositLineKey(l: Pick<TxnLine, 'linkedTxnId' | 'linkedLineId'>): number {
  return l.linkedLineId ? -l.linkedLineId : l.linkedTxnId ?? 0;
}

/** Type text of a waiting row: "Payment", "Sales Receipt", "Invoice 1265 – payment (Check 5512)". */
export function depositTypeLabel(i: UndepositedItem): string {
  if (!i.lineId) return i.typeLabel;
  return `${i.typeLabel}${i.refNumber ? ' ' + i.refNumber : ''} – payment${i.checkNumber ? ` (Check ${i.checkNumber})` : ''}`;
}

/** Check number of a waiting row (older servers: the payment number). */
export function depositCheckNumber(i: UndepositedItem): string {
  return i.checkNumber ?? (i.type === 'PMT' ? i.refNumber : '');
}

interface Props {
  items: UndepositedItem[];
  initial: number[];
  onDone: (keys: number[] | null) => void;
}

/** Width of the dialog; it stays inside the screen (at most 96% of its width). */
const DIALOG_WIDTH = 1040;

// Type and Name share the room left by the fixed columns (Name gets more: customer:job names are
// long). The smallest widths add up to 906px, less than the list of the dialog even with a scroll
// bar (about 990px; about 930px on a 1024px screen, where the dialog is about 980px wide), so
// Amount and Payment method always show in full without scrolling sideways. Cut text shows in a
// tooltip.
const COLUMNS: CheckColumn<UndepositedItem>[] = [
  { key: 'date', label: 'Date', width: 92, type: 'date' },
  { key: 'typeLabel', label: 'Type', width: 180, grow: 1, render: (i) => depositTypeLabel(i), sortValue: (i) => depositTypeLabel(i) },
  { key: 'refNumber', label: 'No.', width: 80 },
  { key: 'checkNumber', label: 'Chk No.', width: 80, render: (i) => depositCheckNumber(i), sortValue: (i) => depositCheckNumber(i) },
  { key: 'paymentMethodName', label: 'Payment method', width: 136 },
  { key: 'nameFull', label: 'Name', width: 190, grow: 2 },
  { key: 'amount', label: 'Amount', width: 112, type: 'money' },
];

function PaymentsToDeposit({ items, initial, onDone }: Props) {
  const [checked, setChecked] = useState<Set<number>>(() => new Set(initial));
  const [method, setMethod] = useState('');
  const methods = useMemo(() => Array.from(new Set(items.map((i) => i.paymentMethodName).filter(Boolean))).sort(), [items]);
  const shown = useMemo(() => (method ? items.filter((i) => i.paymentMethodName === method) : items), [items, method]);
  const sel = items.filter((i) => checked.has(depositKey(i)));
  const total = sel.reduce((s, i) => s + i.amount, 0);
  const toggle = (key: number) =>
    setChecked((c) => {
      const n = new Set(c);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const setAll = (on: boolean) =>
    setChecked((c) => {
      const n = new Set(c);
      for (const i of shown) {
        if (on) n.add(depositKey(i));
        else n.delete(depositKey(i));
      }
      return n;
    });
  return (
    <div className="bk-dlg" style={{ width: DIALOG_WIDTH }}>
      <div className="bk-dlg-body">
        <p className="bk-dlg-intro">Choose the customer payments and sales receipts you are taking to the bank together. They are waiting in Undeposited Funds.</p>
        <div className="bk-dlg-filter">
          <label className="sx-label-plain" htmlFor="bk-pm-filter">
            Show payment method
          </label>
          <Select
            id="bk-pm-filter"
            value={method}
            width={200}
            onChange={setMethod}
            options={[{ value: '', label: 'All types' }, ...methods.map((m) => ({ value: m, label: m }))]}
          />
          <span className="bk-grow" />
          <Button small label="Select all" onClick={() => setAll(true)} disabled={!shown.length} />
          <Button small label="Select none" onClick={() => setAll(false)} disabled={!shown.length} />
        </div>
        <CheckTable<UndepositedItem>
          className="bk-dlg-table"
          rows={shown}
          getKey={depositKey}
          columns={COLUMNS}
          checked={checked}
          onToggle={(id) => toggle(id)}
          onToggleAll={setAll}
          autoFocus
          aria-label="Payments to deposit"
          emptyText={items.length ? 'No payments use this payment method.' : 'There are no payments waiting to be deposited.'}
        />
        <div className="bk-dlg-summary">
          <span>
            {sel.length} of {items.length} payment{items.length === 1 ? '' : 's'} selected for deposit
          </span>
          <span>
            Payments subtotal <strong>${fmtMoney(total)}</strong>
          </span>
        </div>
      </div>
      <div className="sx-dlg-buttons">
        <Button label="Cancel" onClick={() => onDone(null)} />
        <Button variant="primary" label="OK" onClick={() => onDone(Array.from(checked).filter((k) => items.some((i) => depositKey(i) === k)))} />
      </div>
    </div>
  );
}

/** Shows the Payments to Deposit dialog; resolves the keys ({@link depositKey}) of the chosen rows, or null on Cancel. */
export function choosePaymentsToDeposit(items: UndepositedItem[], initial: ID[]): Promise<number[] | null> {
  return showDialog<number[] | null>({
    title: 'Payments to Deposit',
    width: DIALOG_WIDTH,
    cancelValue: null,
    render: (close) => <PaymentsToDeposit items={items} initial={initial} onDone={close} />,
  });
}
