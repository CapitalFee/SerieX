// Create Estimates (EST): no accounting effect. ESTIMATE #, status (Pending / Accepted / Closed /
// Rejected), lines ITEM, DESCRIPTION, QTY, RATE, AMOUNT, TAX; "Create invoice" turns it into an
// invoice with the lines linked to the estimate (the estimate then becomes Closed).
import { useEffect, useRef } from 'react';
import { FileText } from 'lucide-react';
import { api } from '@/api/client';
import type { ListEntry, Name, Txn } from '@/api/types';
import { AddressBlock, ClassPicker, DateField, RepPicker, Select, TextField, confirmBox } from '@/components';
import { HeaderRow, HeaderSpacer, TxnFormFrame, useTxnForm, type FooterTotal } from '@/forms';
import { openTxn, openWindow } from '@/windows/windowStore';
import { CustomerHistoryPanel } from './CustomerHistoryPanel';
import { printSalesForm } from './printing';
import { SalesLinesGrid } from './SalesLinesGrid';
import { confirmReinvoice } from './InvoiceForm';
import { blankSales, CustomerField, fromTemplate, loadCustomers, loadItemsById, loadPrefs, nextRef, SalesFooter, useSalesState, validateSalesForm, withCustomer } from './salesForm';
import { HeaderField, money$ } from './shared';

export interface EstimateFormProps {
  id?: number;
  customerId?: number;
  template?: Txn;
}

const STATUSES = ['Pending', 'Accepted', 'Closed', 'Rejected'];

async function makeEstimate(props: EstimateFormProps): Promise<Txn> {
  const prefs = await loadPrefs();
  const ref = await nextRef('EST');
  if (props.template) return { ...fromTemplate(props.template), type: 'EST', refNumber: ref, status: 'Pending' };
  let t: Txn = { ...blankSales('EST', prefs), refNumber: ref, status: 'Pending' };
  if (props.customerId) {
    const [all, itemsById, terms] = await Promise.all([loadCustomers(), loadItemsById(), api.get<ListEntry[]>('/lists/terms?active=all').catch(() => [] as ListEntry[])]);
    const n = all.find((x) => x.id === props.customerId) ?? (await api.get<Name>(`/names/${props.customerId}`));
    t = withCustomer(t, n, all, prefs, itemsById, { terms });
  }
  return t;
}

export default function EstimateForm(props: EstimateFormProps) {
  const savedRef = useRef<Txn | null>(null);
  const form = useTxnForm({
    type: 'EST',
    id: props.id,
    makeNew: () => makeEstimate(props),
    prepare: (t) => sales.prepare(t),
    validate: (t) => validateSalesForm(t, sales.calc, form.prefs, { noun: 'estimate' }),
    toastOnSave: (s) => `Estimate ${s.refNumber} saved (${money$(s.amount)})`,
    afterSave: (s) => {
      savedRef.current = s;
    },
  });
  const sales = useSalesState(form);
  const t = form.txn;
  const prefs = form.prefs;
  const ro = t.voided;
  const invoices = (t.linked ?? []).filter((l) => l.type === 'INV');

  useEffect(() => {
    form.win?.setTitle(form.isNew ? 'Create Estimates' : `Estimate ${t.refNumber}${t.nameFull ? ' - ' + t.nameFull : ''}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.isNew, t.id, t.refNumber, t.nameFull]);

  const createInvoice = async () => {
    let id = form.txn.id;
    // an estimate that was already invoiced (or closed) is not invoiced again without asking: double billing
    const orig = form.original;
    if (orig && !form.isNew && !(await confirmReinvoice(orig))) return;
    if (form.isNew || form.dirty) {
      if (!(await confirmBox('The estimate must be saved before you create an invoice from it. Save it now?', 'Save Estimate'))) return;
      savedRef.current = null;
      if (!(await form.save('stay'))) return;
      id = (savedRef.current as Txn | null)?.id ?? 0;
    }
    if (id) openWindow('invoice', { estimateId: id, estimateConfirmed: true });
  };

  const totals: FooterTotal[] = [
    ...(prefs.salesTaxEnabled ? [{ key: 'tax', label: 'Tax', value: sales.calc.tax }] : []),
    { key: 'total', label: 'Total', value: sales.calc.total, strong: true },
  ];

  return (
    <TxnFormFrame
      form={form}
      title="Estimate"
      status={t.voided ? 'Void' : form.isNew ? null : form.original?.status || 'Pending'}
      stamp={t.voided ? 'VOID' : null}
      readOnly={ro}
      onPrint={() => void printSalesForm(sales.prepare(t), { title: 'Estimate', numberLabel: 'Estimate #', itemsById: sales.itemsById, taxEnabled: prefs.salesTaxEnabled, balanceLabel: 'Total' })}
      extraButtons={[
        {
          key: 'inv',
          label: 'Create invoice',
          icon: FileText,
          primary: !form.isNew && (t.status === 'Pending' || t.status === 'Accepted'),
          onClick: () => void createInvoice(),
          disabled: ro || t.status === 'Rejected',
          title: 'Turn this estimate into an invoice',
        },
      ]}
      titleRight={
        <HeaderField label="STATUS" width={150} help="Pending: waiting for the customer. Accepted: the customer agreed. Closed: invoiced or no longer needed. Rejected: the customer declined.">
          <Select name="status" value={t.status || 'Pending'} options={STATUSES.map((s) => ({ value: s, label: s }))} onChange={(v) => form.update({ status: v })} disabled={ro} aria-label="Estimate status" />
        </HeaderField>
      }
      header={
        <>
          <HeaderRow>
            <CustomerField form={form} sales={sales} required autoFocus={form.isNew && !t.nameId} />
            {prefs.useClassTracking && (
              <HeaderField label="CLASS" width={170} help="Class">
                <ClassPicker name="classId" value={t.classId} onChange={(id) => form.update({ classId: id })} readOnly={ro} />
              </HeaderField>
            )}
            <HeaderSpacer />
            <HeaderField label="DATE" width={140} required>
              <DateField name="date" value={t.date} onChange={(d) => sales.setDate(d)} readOnly={ro} />
            </HeaderField>
            <HeaderField label="ESTIMATE #" width={110}>
              <TextField name="refNumber" value={t.refNumber} onChange={(v) => form.update({ refNumber: v })} readOnly={ro} />
            </HeaderField>
          </HeaderRow>
          <div className="sx-cust-addrrow">
            <HeaderField label="NAME / ADDRESS" width={230}>
              <AddressBlock name="billAddress" rows={4} value={t.billAddress} onChange={(v) => form.update({ billAddress: v })} readOnly={ro} aria-label="Name and address" />
            </HeaderField>
            <div className="sx-cust-fieldgrid">
              <HeaderRow>
                <HeaderField label="P.O. NO." width={120}>
                  <TextField name="poNumber" value={t.poNumber} onChange={(v) => form.update({ poNumber: v })} readOnly={ro} />
                </HeaderField>
                <HeaderField label="REP" width={90} help="The sales rep who gets credit for this sale.">
                  <RepPicker name="repId" value={t.repId} onChange={(id) => form.update({ repId: id })} readOnly={ro} listWidth={220} />
                </HeaderField>
              </HeaderRow>
              {invoices.length > 0 && (
                <div className="sx-cust-creditinfo">
                  Invoiced on{' '}
                  {invoices.map((l, i) => (
                    <span key={l.txnId}>
                      {i > 0 ? ', ' : ''}
                      <button type="button" className="sx-linkbtn" onClick={() => openTxn('INV', l.txnId)}>
                        invoice {l.refNumber}
                      </button>
                    </span>
                  ))}
                  .
                </div>
              )}
            </div>
          </div>
        </>
      }
      lines={<SalesLinesGrid layout="standard" lines={sales.lines} onChange={(rows) => sales.setLines(rows)} itemsById={sales.itemsById} customerTaxable={sales.customerTaxable} readOnly={ro} persistKey="estimate" />}
      footer={<SalesFooter form={form} sales={sales} rows={[{ key: 'total', label: 'Total', value: sales.calc.total, bold: true, separator: true }]} />}
      totals={totals}
      sidePanel={<CustomerHistoryPanel nameId={t.nameId} txn={form.original} persistKey="estimate" />}
    />
  );
}
