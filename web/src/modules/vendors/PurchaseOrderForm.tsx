// Create Purchase Orders: VENDOR, CLASS, SHIP TO, DATE, P.O. NO., vendor and ship-to addresses,
// lines ITEM / DESCRIPTION / QTY / RATE / CUSTOMER / AMOUNT / RCV'D / CLSD, vendor message, memo.
// Saved POs offer Create bill and Receive items (they open the bill form prefilled from the PO).
import { useEffect, useMemo } from 'react';
import { PackageCheck, Receipt, Lock, LockOpen } from 'lucide-react';
import { api } from '@/api/client';
import { useCompanyInfo, useItemsById, useNextRef } from '@/api/hooks';
import { emptyLine, emptyTxn, type CompanyInfo, type ID, type Name, type Txn, type TxnLine } from '@/api/types';
import {
  AddressBlock,
  ClassPicker,
  DateField,
  Grid,
  ItemLabel,
  ItemPicker,
  NameLabel,
  NamePicker,
  TextField,
  formatAddress,
  useNewRow,
  type GridColumn,
  type GridEditorProps,
} from '@/components';
import { TxnFormFrame, TxnHeaderField, copyAsNew, stripEmptyLines, useTxnForm, type TxnProblem } from '@/forms';
import { useWindow } from '@/windows/WindowContext';
import { openWindow } from '@/windows/windowStore';
import { todayIso } from '@/util/dates';
import { escHtml, printHtml } from '@/util/print';
import { fmtDate, fmtMoney, fmtQty, lineAmount, round2, roundTo } from '@/util/format';
import { fetchName, sum2, vendorAddressText } from './shared';
import { VendorHistoryPanel } from './VendorHistoryPanel';
import './vendors.css';

export interface PurchaseOrderFormProps {
  id?: number;
  vendorId?: number;
  template?: Txn;
}

const PO_ITEM_TYPES = ['Inventory Part', 'Non-inventory Part', 'Service', 'Other Charge'] as const;

function companyShipTo(c: CompanyInfo | undefined): string {
  if (!c) return '';
  const cityLine = [c.city, [c.state, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [c.name, c.address1, c.address2, cityLine, c.country].map((s) => (s ?? '').trim()).filter(Boolean).join('\n');
}

function fmtCost(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return Number.isInteger(Math.round(n * 100 * 1e6) / 1e6) ? fmtMoney(n) : fmtQty(n);
}

/** Received in full: every item line received or closed. */
function receivedInFull(lines: TxnLine[]): boolean {
  const real = lines.filter((l) => l.itemId);
  return real.length > 0 && real.every((l) => l.closed || (l.receivedQty || 0) >= (l.qty ?? 1));
}

export default function PurchaseOrderForm(props: PurchaseOrderFormProps) {
  const win = useWindow();
  const company = useCompanyInfo();
  const itemsById = useItemsById();
  const nextRef = useNextRef('PURCHORD');

  const form = useTxnForm({
    type: 'PURCHORD',
    id: props.id,
    makeNew: async () => {
      const today = todayIso();
      const t: Txn = props.template ? { ...copyAsNew(props.template), date: props.template.date || today } : emptyTxn('PURCHORD', today);
      t.type = 'PURCHORD';
      const vid = props.vendorId ?? t.nameId;
      if (vid) {
        const v = await fetchName(vid).catch(() => null);
        if (v) {
          t.nameId = v.id;
          t.nameFull = v.fullName;
          if (!t.billAddress) t.billAddress = vendorAddressText(v);
        }
      }
      if (!t.shipAddress) {
        const c = await api.get<CompanyInfo>('/company').catch(() => undefined);
        t.shipAddress = companyShipTo(c);
      }
      return t;
    },
    prepare: (t) => {
      const s = stripEmptyLines(t);
      const lines = s.lines.map((l) => ({ ...l, kind: 'item' as const, amount: round2(l.amount || 0) }));
      return { ...s, lines, amount: sum2(lines.map((l) => l.amount)) };
    },
    validate: (t) => {
      const p: TxnProblem[] = [];
      if (!t.lines.length) p.push({ field: 'lines', message: 'Add at least one item to order.' });
      t.lines.forEach((l, i) => {
        if (!l.itemId && (l.amount || l.qty)) p.push({ field: 'lines', message: `Line ${i + 1} needs an item.` });
        if ((l.qty ?? 0) < 0) p.push({ field: 'lines', message: `Line ${i + 1}: the quantity cannot be negative.` });
      });
      return p;
    },
  });
  const { txn, prefs } = form;
  const saved = !!txn.id;
  const readOnly = txn.voided;
  const total = sum2(txn.lines.map((l) => l.amount || 0));
  const extra = (txn.extra ?? {}) as Record<string, unknown>;
  const original = form.original;

  useEffect(() => {
    win.setTitle(saved ? `Purchase Order${txn.refNumber ? ' ' + txn.refNumber : ''}${txn.nameFull ? ' - ' + txn.nameFull : ''}` : 'Create Purchase Orders');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved, txn.refNumber, txn.nameFull]);

  const onVendor = (id: ID | null, n: Name | null) => {
    form.update({ nameId: id, nameFull: n?.fullName ?? '', billAddress: n ? vendorAddressText(n) : '' });
  };
  const onShipTo = (id: ID | null, n: Name | null) => {
    const addr = n ? formatAddress(n.companyName || n.fullName, n.shipAddress?.line1 || n.shipAddress?.city ? n.shipAddress : n.billAddress) : companyShipTo(company.data);
    form.update({ extra: { ...extra, shipToNameId: id ?? undefined }, shipAddress: addr });
  };

  // ---- lines grid
  const newRow = useNewRow(() => emptyLine('item'));
  const lineReadOnly = (r: TxnLine) => !!readOnly || (r.receivedQty || 0) > 0;
  const columns = useMemo<GridColumn<TxnLine>[]>(
    () => [
      {
        key: 'itemId',
        label: 'ITEM',
        width: 170,
        readOnly: (r) => lineReadOnly(r),
        editor: (p: GridEditorProps<TxnLine>) => (
          <ItemPicker
            inGrid
            autoFocus
            purchase
            aria-label="Item"
            types={[...PO_ITEM_TYPES]}
            value={p.value as ID | null}
            onChange={(id, it) => {
              if (!it) return p.onRowChange({ itemId: id });
              const rate = it.cost ?? 0;
              p.onRowChange({ itemId: id, description: it.purchaseDescription || it.description, rate, amount: lineAmount(p.row.qty, rate) });
            }}
          />
        ),
        render: (r) => <ItemLabel id={r.itemId} />,
      },
      { key: 'description', label: 'DESCRIPTION', grow: true, width: 200, editor: 'text' },
      { key: 'qty', label: 'QTY', width: 64, editor: 'qty', align: 'right' },
      { key: 'rate', label: 'RATE', width: 86, editor: 'qty', align: 'right', render: (r) => fmtCost(r.rate) },
      {
        key: 'nameId',
        label: 'CUSTOMER',
        width: 150,
        title: 'Customer or job the items are for (billable when received)',
        editor: (p: GridEditorProps<TxnLine>) => <NamePicker inGrid autoFocus kinds={['customer']} aria-label="Customer or job" value={p.value as ID | null} onChange={(id) => p.onChange(id)} />,
        render: (r) => <NameLabel id={r.nameId} kind="customer" />,
      },
      { key: 'amount', label: 'AMOUNT', width: 96, editor: 'money', align: 'right' },
      { key: 'receivedQty', label: "RCV'D", width: 58, align: 'right', title: 'Quantity received so far', render: (r) => (r.itemId ? fmtQty(r.receivedQty || 0) : '') },
      { key: 'closed', label: 'CLSD', width: 50, editor: 'checkbox', title: 'Closed: nothing more is expected on this line' },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [readOnly],
  );
  const onRowChange = (next: TxnLine, prev: TxnLine, key: string): TxnLine => {
    let r = next.kind === 'item' ? next : { ...next, kind: 'item' as const };
    if (key === 'qty' || key === 'rate') r = { ...r, amount: lineAmount(r.qty, r.rate) };
    else if (key === 'amount') r = r.qty ? { ...r, rate: roundTo(r.amount / r.qty, 5) } : { ...r, rate: r.amount };
    return r;
  };

  // ---- status
  const full = saved && receivedInFull(txn.lines);
  const anyReceived = txn.lines.some((l) => (l.receivedQty || 0) > 0);
  const status = !saved || !original ? null : txn.voided ? 'Void' : receivedInFull(original.lines) ? (original.lines.some((l) => l.closed && (l.receivedQty || 0) < (l.qty ?? 1)) ? 'Closed' : 'Received in full') : original.status === 'Closed' ? 'Closed' : original.lines.some((l) => (l.receivedQty || 0) > 0) ? 'Partially received' : 'Open';
  const isOpen = saved && original && !original.voided && !receivedInFull(original.lines);
  const allClosed = txn.lines.filter((l) => l.itemId).every((l) => l.closed);

  const toggleClosed = () => form.setLines(txn.lines.map((l) => (l.itemId && (l.receivedQty || 0) < (l.qty ?? 1) ? { ...l, closed: !allClosed } : l)));

  const print = () => {
    const c = company.data;
    const rows = txn.lines
      .filter((l) => l.itemId || l.description)
      .map(
        (l) =>
          `<tr><td>${escHtml(itemsById.get(l.itemId ?? 0)?.fullName ?? '')}</td><td>${escHtml(l.description)}</td><td class="num">${fmtQty(l.qty)}</td><td class="num">${fmtCost(l.rate)}</td><td class="num">${fmtMoney(l.amount)}</td></tr>`,
      )
      .join('');
    const addr = (s: string) => escHtml(s).replace(/\n/g, '<br>');
    const body = `
      <div class="hdr"><div><h2>${escHtml(c?.name ?? '')}</h2><div>${addr(companyShipTo(c).split('\n').slice(1).join('\n'))}</div></div>
      <div class="right"><h1>Purchase Order</h1><table class="meta"><tr><th>Date</th><th>P.O. No.</th></tr><tr><td>${fmtDate(txn.date)}</td><td>${escHtml(txn.refNumber || nextRef.data?.refNumber || '')}</td></tr></table></div></div>
      <div class="addrs"><div class="box"><div class="cap">Vendor</div>${addr(txn.billAddress)}</div><div class="box"><div class="cap">Ship To</div>${addr(txn.shipAddress)}</div></div>
      <table class="lines"><thead><tr><th>Item</th><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead><tbody>${rows}</tbody>
      <tfoot><tr><td colspan="4" class="num bold">Total</td><td class="num bold">$${fmtMoney(total)}</td></tr></tfoot></table>
      ${extra.vendorMessage ? `<p>${escHtml(String(extra.vendorMessage))}</p>` : ''}`;
    void printHtml(
      `Purchase Order ${txn.refNumber}`,
      body,
      `.hdr{display:flex;justify-content:space-between;margin-bottom:16px}.right{text-align:right}.meta{width:auto;margin-left:auto}.meta td,.meta th{border:1px solid #000;padding:2px 10px}
       .addrs{display:flex;gap:24px;margin-bottom:16px}.box{border:1px solid #000;padding:6px;width:260px;min-height:80px}.cap{font-weight:bold;border-bottom:1px solid #000;margin-bottom:4px}
       .lines td{border-bottom:1px solid #ddd}.lines tfoot td{border-top:1px solid #000}`,
    );
  };

  const header = (
    <div className="vx-po-head">
      <div className="vx-po-row">
        <TxnHeaderField label="Vendor" required htmlFor="vx-po-vendor" width={260}>
          <NamePicker id="vx-po-vendor" name="nameId" kinds={['vendor']} value={txn.nameId} fallbackLabel={txn.nameFull} readOnly={readOnly} autoFocus={!props.id && !props.vendorId} onChange={onVendor} />
        </TxnHeaderField>
        {prefs.useClassTracking && (
          <TxnHeaderField label="Class" htmlFor="vx-po-class" help="Class" width={170}>
            <ClassPicker id="vx-po-class" name="classId" value={txn.classId} readOnly={readOnly} onChange={(id) => form.update({ classId: id })} />
          </TxnHeaderField>
        )}
        <TxnHeaderField label="Ship to" htmlFor="vx-po-shipto" width={200} help="Where the vendor should deliver. Leave it blank to ship to your company, or pick a customer for a drop shipment.">
          <NamePicker
            id="vx-po-shipto"
            name="shipToNameId"
            value={(extra.shipToNameId as ID | undefined) ?? null}
            readOnly={readOnly}
            placeholder={company.data?.name ?? 'Your company'}
            onChange={onShipTo}
          />
        </TxnHeaderField>
        <div className="sx-hspacer" />
        <TxnHeaderField label="Date" required htmlFor="vx-po-date" width={150}>
          <DateField id="vx-po-date" name="date" value={txn.date} readOnly={readOnly} onChange={(d) => form.update({ date: d })} />
        </TxnHeaderField>
        <TxnHeaderField label="P.O. no." htmlFor="vx-po-ref" width={110}>
          <TextField id="vx-po-ref" name="refNumber" value={txn.refNumber} readOnly={readOnly} placeholder={!saved ? nextRef.data?.refNumber ?? '' : ''} onChange={(v) => form.update({ refNumber: v })} maxLength={20} />
        </TxnHeaderField>
      </div>
      <div className="vx-po-row">
        <TxnHeaderField label="Vendor address" htmlFor="vx-po-vaddr" width={260}>
          <AddressBlock id="vx-po-vaddr" name="billAddress" rows={4} value={txn.billAddress} readOnly={readOnly} onChange={(v) => form.update({ billAddress: v })} />
        </TxnHeaderField>
        <TxnHeaderField label="Ship to address" htmlFor="vx-po-saddr" width={300}>
          <AddressBlock id="vx-po-saddr" name="shipAddress" rows={4} value={txn.shipAddress} readOnly={readOnly} onChange={(v) => form.update({ shipAddress: v })} />
        </TxnHeaderField>
      </div>
    </div>
  );

  const extraButtons = [
    {
      key: 'bill',
      label: 'Create bill',
      icon: Receipt,
      color: '#2563eb',
      hidden: !saved,
      disabled: !isOpen || form.dirty,
      title: form.dirty ? 'Save your changes first.' : isOpen ? 'Enter the bill for the items still to receive on this purchase order' : 'Everything on this purchase order was received.',
      onClick: () => openWindow('bill', { poId: txn.id }),
    },
    {
      key: 'recv',
      label: 'Receive items',
      icon: PackageCheck,
      color: '#16a34a',
      hidden: !saved,
      disabled: !isOpen || form.dirty,
      title: form.dirty ? 'Save your changes first.' : 'Record the items you received without the bill (item receipt)',
      onClick: () => openWindow('receiveItems', { poId: txn.id }),
    },
    {
      key: 'close',
      label: allClosed ? 'Reopen PO' : 'Close PO',
      icon: allClosed ? LockOpen : Lock,
      hidden: !saved || (full && !allClosed),
      disabled: readOnly,
      title: allClosed ? 'Reopen the lines that were closed' : 'Close every line that is not fully received (you do not expect the rest)',
      onClick: toggleClosed,
    },
  ];

  return (
    <TxnFormFrame
      form={form}
      title="Purchase Order"
      status={status}
      header={header}
      stamp={txn.voided ? 'VOID' : full && original && receivedInFull(original.lines) && !anyClosedOnly(original.lines) ? 'RECEIVED' : null}
      readOnly={readOnly}
      onPrint={print}
      extraButtons={extraButtons}
      reportButtons={[{ label: 'Open purchase orders report', onClick: () => openWindow('report', { key: 'open_purchase_orders', params: { dates: 'all' } }) }]}
      lines={
        <Grid<TxnLine>
          aria-label="Purchase order lines"
          columns={columns}
          rows={txn.lines}
          onChange={form.setLines}
          newRow={newRow}
          onRowChange={onRowChange}
          readOnly={readOnly}
          minRows={7}
          persistKey="po-lines"
          rowClassName={(r) => (r.closed || (r.itemId && (r.receivedQty || 0) >= (r.qty ?? 1)) ? 'vx-row-done' : undefined)}
        />
      }
      footer={
        <div className="vx-memo-row">
          <TxnHeaderField label="Vendor message" htmlFor="vx-po-msg" help="A note printed on the purchase order for the vendor (delivery instructions, for example).">
            <TextField id="vx-po-msg" name="vendorMessage" value={(extra.vendorMessage as string) ?? ''} readOnly={readOnly} onChange={(v) => form.update({ extra: { ...extra, vendorMessage: v } })} />
          </TxnHeaderField>
          <TxnHeaderField label="Memo" htmlFor="vx-po-memo" help="Memo">
            <TextField id="vx-po-memo" name="memo" value={txn.memo} readOnly={readOnly} onChange={(v) => form.update({ memo: v })} />
          </TxnHeaderField>
        </div>
      }
      totals={[{ key: 'total', label: 'Total', value: total, strong: true }]}
      sidePanel={<VendorHistoryPanel vendorId={txn.nameId} txn={saved ? txn : null} persistKey="po" />}
    />
  );
}

/** True when some line was closed without being received in full (the PO was closed by hand). */
function anyClosedOnly(lines: TxnLine[]): boolean {
  return lines.some((l) => l.itemId && l.closed && (l.receivedQty || 0) < (l.qty ?? 1));
}
