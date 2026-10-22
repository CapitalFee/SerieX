// Create Credit Memos/Refunds (CREDMEM). After saving a new credit memo the
// "Available Credit" question offers: keep it as a credit, give a refund, or apply it to invoices.
// Toolbar: "Use credit to give refund" and "Use credit to apply to invoice".
import { useEffect, useRef } from 'react';
import { BadgePercent, HandCoins } from 'lucide-react';
import { api } from '@/api/client';
import type { ListEntry, Name, Txn } from '@/api/types';
import { AddressBlock, ClassPicker, DateField, TextField, alertBox, confirmBox, toast } from '@/components';
import { HeaderRow, HeaderSpacer, TxnFormFrame, useTxnForm, type FooterTotal } from '@/forms';
import { openWindow } from '@/windows/windowStore';
import { round2 } from '@/util/format';
import { CustomerHistoryPanel } from './CustomerHistoryPanel';
import { applyCreditToInvoices, askCreditUse } from './dialogs';
import { printSalesForm } from './printing';
import { SalesLinesGrid } from './SalesLinesGrid';
import { blankSales, CustomerField, fromTemplate, loadCustomers, loadItemsById, loadPrefs, nextRef, SalesFooter, useSalesState, validateSalesForm, withCustomer } from './salesForm';
import { HeaderField, money$ } from './shared';

export interface CreditMemoFormProps {
  id?: number;
  customerId?: number;
  template?: Txn;
}

async function makeCredit(props: CreditMemoFormProps): Promise<Txn> {
  const prefs = await loadPrefs();
  const ref = await nextRef('CREDMEM');
  if (props.template) return { ...fromTemplate(props.template), type: 'CREDMEM', refNumber: ref };
  let t: Txn = { ...blankSales('CREDMEM', prefs), refNumber: ref };
  if (props.customerId) {
    const [all, itemsById] = await Promise.all([loadCustomers(), loadItemsById()]);
    const n = all.find((x) => x.id === props.customerId) ?? (await api.get<Name>(`/names/${props.customerId}`));
    t = withCustomer(t, n, all, prefs, itemsById, { terms: [] as ListEntry[] });
  }
  return t;
}

/** What happens with the credit after a new credit memo is saved (the "Available Credit" question). */
async function afterNewCredit(saved: Txn) {
  if (saved.openBalance <= 0) return;
  const choice = await askCreditUse(saved.openBalance, saved.nameFull);
  if (choice === 'refund') openWindow('refund', { creditId: saved.id, customerId: saved.nameId ?? undefined });
  else if (choice === 'apply') {
    const fresh = await api.get<Txn>(`/txns/${saved.id}`);
    if (await applyCreditToInvoices(fresh)) toast(`Credit memo ${saved.refNumber} applied`, { kind: 'success' });
  }
}

export default function CreditMemoForm(props: CreditMemoFormProps) {
  const isNewRef = useRef(true);
  const skipAsk = useRef(false);
  const savedRef = useRef<Txn | null>(null);
  const form = useTxnForm({
    type: 'CREDMEM',
    id: props.id,
    makeNew: () => makeCredit(props),
    prepare: (t) => sales.prepare(t),
    validate: (t) => validateSalesForm(t, sales.calc, form.prefs, { noun: 'credit memo' }),
    afterSave: (saved) => {
      savedRef.current = saved;
      if (isNewRef.current && !skipAsk.current) void afterNewCredit(saved);
      skipAsk.current = false;
    },
    toastOnSave: (s) => `Credit memo ${s.refNumber} saved (${money$(s.amount)})`,
  });
  const sales = useSalesState(form);
  isNewRef.current = form.isNew;
  const t = form.txn;
  const orig = form.original;
  const prefs = form.prefs;
  const ro = t.voided;
  const remaining = orig && !orig.voided ? orig.openBalance : 0;
  const used = orig ? round2(orig.amount - orig.openBalance) : 0;

  useEffect(() => {
    form.win?.setTitle(form.isNew ? 'Create Credit Memos/Refunds' : `Credit Memo ${t.refNumber}${t.nameFull ? ' - ' + t.nameFull : ''}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.isNew, t.id, t.refNumber, t.nameFull]);

  const ensureSaved = async (why: string): Promise<Txn | null> => {
    if (!form.isNew && !form.dirty) return form.txn;
    if (!(await confirmBox(`The credit memo must be saved ${why}. Save it now?`, 'Save Credit Memo'))) return null;
    skipAsk.current = true; // the action that asked replaces the "Available Credit" box
    savedRef.current = null;
    const ok = await form.save('stay');
    return ok ? savedRef.current : null;
  };
  const refund = async () => {
    const s = await ensureSaved('before you give a refund');
    if (!s?.id) return;
    if (s.openBalance <= 0) {
      await alertBox('This credit is already used up. There is nothing left to refund.', 'Give a Refund');
      return;
    }
    openWindow('refund', { creditId: s.id, customerId: s.nameId ?? undefined });
  };
  const apply = async () => {
    const s = await ensureSaved('before you apply it to an invoice');
    if (!s?.id) return;
    const fresh = await api.get<Txn>(`/txns/${s.id}`);
    if (await applyCreditToInvoices(fresh)) {
      await form.load(s.id);
      toast('Credit applied', { kind: 'success' });
    }
  };

  const status = t.voided ? 'Void' : orig ? (orig.openBalance <= 0 ? 'Applied' : used > 0 ? 'Partially applied' : 'Unapplied') : null;
  const totals: FooterTotal[] = [
    ...(prefs.salesTaxEnabled ? [{ key: 'tax', label: 'Tax', value: sales.calc.tax }] : []),
    ...(orig ? [{ key: 'used', label: 'Credit used', value: used }] : []),
    { key: 'total', label: orig ? 'Remaining credit' : 'Total credit', value: orig ? round2(sales.calc.total - used) : sales.calc.total, strong: true },
  ];

  return (
    <TxnFormFrame
      form={form}
      title="Credit Memo"
      status={status === 'Applied' ? 'Closed' : status}
      stamp={t.voided ? 'VOID' : null}
      readOnly={ro}
      onPrint={() => void printSalesForm(sales.prepare(t), { title: 'Credit Memo', numberLabel: 'Credit No.', itemsById: sales.itemsById, taxEnabled: prefs.salesTaxEnabled, balanceLabel: 'Total Credit', stamp: t.voided ? 'VOID' : null })}
      extraButtons={[
        { key: 'refund', label: 'Use credit to give refund', icon: HandCoins, onClick: () => void refund(), disabled: ro || (!!orig && remaining <= 0 && !form.dirty) },
        { key: 'apply', label: 'Use credit to apply to invoice', icon: BadgePercent, onClick: () => void apply(), disabled: ro || (!!orig && remaining <= 0 && !form.dirty) },
      ]}
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
            <HeaderField label="CREDIT NO." width={110}>
              <TextField name="refNumber" value={t.refNumber} onChange={(v) => form.update({ refNumber: v })} readOnly={ro} />
            </HeaderField>
          </HeaderRow>
          <div className="sx-cust-addrrow">
            <HeaderField label="CUSTOMER" width={230}>
              <AddressBlock name="billAddress" rows={4} value={t.billAddress} onChange={(v) => form.update({ billAddress: v })} readOnly={ro} aria-label="Customer address" />
            </HeaderField>
            <div className="sx-cust-fieldgrid">
              <HeaderRow>
                <HeaderField label="P.O. NO." width={120}>
                  <TextField name="poNumber" value={t.poNumber} onChange={(v) => form.update({ poNumber: v })} readOnly={ro} />
                </HeaderField>
              </HeaderRow>
              {orig && (
                <div className="sx-cust-creditinfo">
                  {remaining > 0 ? (
                    <>
                      <b>{money$(remaining)}</b> of this credit is still available. Receive Payments uses it on the oldest invoices the next time this customer pays (&quot;Apply
                      available credits&quot; is ticked), or use the buttons above.
                    </>
                  ) : (
                    <>This credit has been fully used.</>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      }
      lines={
        <SalesLinesGrid layout="standard" lines={sales.lines} onChange={(rows) => sales.setLines(rows)} itemsById={sales.itemsById} customerTaxable={sales.customerTaxable} readOnly={ro} persistKey="credmem" />
      }
      footer={<SalesFooter form={form} sales={sales} rows={[{ key: 'total', label: 'Total', value: sales.calc.total, bold: true, separator: true }]} />}
      totals={totals}
      sidePanel={<CustomerHistoryPanel nameId={t.nameId} txn={orig} persistKey="credmem" />}
    />
  );
}
