// Bill for Received Items: choose the vendor and one of its open item receipts; the bill form
// opens on that receipt with "Bill received" checked (saving turns it into a bill).
import { useEffect, useState } from 'react';
import { PackageCheck } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import type { ID, TxnSummary } from '@/api/types';
import { Button, Checkbox, EmptyState, Field, ListView, NamePicker, Spinner } from '@/components';
import { useWindow } from '@/windows/WindowContext';
import { openWindow } from '@/windows/windowStore';
import { todayIso } from '@/util/dates';
import { fmtMoney } from '@/util/format';
import './vendors.css';

export interface SelectItemReceiptProps {
  vendorId?: number;
}

export default function SelectItemReceipt(props: SelectItemReceiptProps) {
  const win = useWindow();
  const [vendorId, setVendorId] = useState<ID | null>(props.vendorId ?? null);
  const [sel, setSel] = useState<ID | null>(null);
  const [useReceiptDate, setUseReceiptDate] = useState(false);
  // every open receipt (for the vendor list hint) and the chosen vendor's receipts
  const all = useQuery({ queryKey: ['item-receipts', 'all'], queryFn: () => api.get<TxnSummary[]>('/item-receipts') });
  const receipts = (all.data ?? []).filter((r) => !vendorId || r.nameId === vendorId);

  useEffect(() => {
    if (!receipts.some((r) => r.id === sel)) setSel(receipts[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId, all.data]);

  const ok = async (id: ID | null = sel) => {
    const r = receipts.find((x) => x.id === id);
    if (!r) return;
    await win.close(true);
    openWindow('bill', { id: r.id, enterBill: true, billDate: useReceiptDate ? r.date : todayIso() });
  };

  const vendorsWithReceipts = new Set((all.data ?? []).map((r) => r.nameId));

  return (
    <div className="vx-selrcpt">
      <Field label="Vendor" htmlFor="vx-sr-vendor" hint={all.data ? `${all.data.length} open item receipt${all.data.length === 1 ? '' : 's'} from ${vendorsWithReceipts.size} vendor${vendorsWithReceipts.size === 1 ? '' : 's'}` : undefined}>
        <NamePicker id="vx-sr-vendor" kinds={['vendor']} value={vendorId} onChange={(id) => setVendorId(id)} placeholder="All vendors" addNew={false} autoFocus />
      </Field>
      <div className="vx-subhead">Choose the item receipt that corresponds to your bill</div>
      {all.isLoading ? (
        <Spinner center />
      ) : (
        <ListView<TxnSummary>
          className="vx-fill vx-selrcpt-list"
          aria-label="Item receipts"
          rows={receipts}
          selectedKey={sel}
          onSelect={(k) => setSel(k as ID)}
          onActivate={(r) => void ok(r.id)}
          columns={[
            { key: 'date', label: 'DATE', width: 90, type: 'date' },
            { key: 'nameFull', label: 'VENDOR', width: 170 },
            { key: 'refNumber', label: 'REF NO.', width: 80 },
            { key: 'memo', label: 'MEMO', width: 140, grow: true },
            { key: 'amount', label: 'AMOUNT', width: 90, type: 'money', render: (r) => fmtMoney(r.amount) },
          ]}
          emptyText={
            <EmptyState
              compact
              icon={PackageCheck}
              title="No open item receipts"
              message={vendorId ? 'This vendor has no items received without a bill.' : 'When you receive items before the bill (Vendors > Receive Items), they wait here for the bill.'}
            />
          }
        />
      )}
      <div className="vx-selrcpt-foot">
        <Checkbox label="Use the item receipt date for the bill date" checked={useReceiptDate} onChange={setUseReceiptDate} />
        <span className="vx-spacer" />
        <Button label="Cancel" onClick={() => void win.close()} />
        <Button variant="primary" label="Enter bill" disabled={!sel} onClick={() => void ok()} />
      </div>
    </div>
  );
}
