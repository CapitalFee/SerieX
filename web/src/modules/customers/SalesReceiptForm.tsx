// Enter Sales Receipts (SALESRCPT): a sale paid on the spot. Like the invoice without terms or
// due date; SOLD TO, SALE NO., CHECK NO., payment method buttons and Deposit To (only when the
// company does not group payments in Undeposited Funds). Customer is optional.
import { useEffect } from 'react';
import { HandCoins } from 'lucide-react';
import { api } from '@/api/client';
import type { ListEntry, Name, Txn } from '@/api/types';
import { AccountPicker, AddressBlock, ClassPicker, DateField, TextField } from '@/components';
import { HeaderRow, HeaderSpacer, TxnFormFrame, TxnHeaderField, useTxnForm, type FooterTotal } from '@/forms';
import { openTxn } from '@/windows/windowStore';
import { fmtDate } from '@/util/format';
import { CustomerHistoryPanel } from './CustomerHistoryPanel';
import { MethodButtons } from './paymentMethods';
import { printSalesForm } from './printing';
import { SalesLinesGrid } from './SalesLinesGrid';
import { blankSales, CustomerField, fromTemplate, loadCustomers, loadItemsById, loadPrefs, nextRef, SalesFooter, useSalesState, validateSalesForm, withCustomer } from './salesForm';
import { HeaderField, money$, useUndepositedFundsId } from './shared';

export interface SalesReceiptFormProps {
  id?: number;
  customerId?: number;
  template?: Txn;
}

async function makeReceipt(props: SalesReceiptFormProps): Promise<Txn> {
  const prefs = await loadPrefs();
  const ref = await nextRef('SALESRCPT');
  if (props.template) return { ...fromTemplate(props.template), type: 'SALESRCPT', refNumber: ref };
  let t: Txn = { ...blankSales('SALESRCPT', prefs), refNumber: ref };
  if (!prefs.useUndepositedFunds && prefs.defaultDepositAccountId) t.accountId = prefs.defaultDepositAccountId;
  if (props.customerId) {
    const [all, itemsById] = await Promise.all([loadCustomers(), loadItemsById()]);
    const n = all.find((x) => x.id === props.customerId) ?? (await api.get<Name>(`/names/${props.customerId}`));
    t = withCustomer(t, n, all, prefs, itemsById, { terms: [] as ListEntry[] });
  }
  return t;
}

export default function SalesReceiptForm(props: SalesReceiptFormProps) {
  const form = useTxnForm({
    type: 'SALESRCPT',
    id: props.id,
    makeNew: () => makeReceipt(props),
    prepare: (t) => sales.prepare(t),
    validate: (t) => validateSalesForm(t, sales.calc, form.prefs, { noun: 'sales receipt' }),
    required: [],
    toastOnSave: (s) => `Sales receipt ${s.refNumber} saved (${money$(s.amount)})`,
  });
  const sales = useSalesState(form);
  const t = form.txn;
  const prefs = form.prefs;
  const ro = t.voided;
  const deposited = (t.linked ?? []).find((l) => l.relation === 'deposit');
  const checkNo = String(t.extra?.checkNumber ?? '');
  const ufId = useUndepositedFundsId();
  const showDepositTo = !prefs.useUndepositedFunds || (!!t.accountId && !!ufId && t.accountId !== ufId);

  useEffect(() => {
    form.win?.setTitle(form.isNew ? 'Enter Sales Receipts' : `Sales Receipt ${t.refNumber}${t.nameFull ? ' - ' + t.nameFull : ''}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.isNew, t.id, t.refNumber, t.nameFull]);

  const totals: FooterTotal[] = [
    ...(prefs.salesTaxEnabled ? [{ key: 'tax', label: 'Tax', value: sales.calc.tax }] : []),
    { key: 'total', label: 'Total', value: sales.calc.total, strong: true },
  ];

  return (
    <TxnFormFrame
      form={form}
      title="Sales Receipt"
      status={t.voided ? 'Void' : t.isPending ? 'Pending' : deposited ? 'Deposited' : form.isNew ? null : 'Paid'}
      stamp={t.voided ? 'VOID' : t.isPending ? 'PENDING' : null}
      showPending
      readOnly={ro}
      onPrint={() => void printSalesForm(sales.prepare(t), { title: 'Sales Receipt', numberLabel: 'Sale No.', itemsById: sales.itemsById, taxEnabled: prefs.salesTaxEnabled, balanceLabel: 'Total', stamp: t.voided ? 'VOID' : null })}
      extraButtons={[
        {
          key: 'dep',
          label: deposited ? 'Open deposit' : 'Not deposited yet',
          icon: HandCoins,
          hidden: form.isNew,
          disabled: !deposited,
          onClick: () => deposited && openTxn('DEP', deposited.txnId),
          title: deposited ? `Deposited on ${fmtDate(deposited.date)}` : 'This sale is waiting in Undeposited Funds until you make a deposit.',
        },
      ]}
      header={
        <>
          <HeaderRow>
            <CustomerField form={form} sales={sales} autoFocus={form.isNew && !t.nameId} />
            {prefs.useClassTracking && (
              <HeaderField label="CLASS" width={170} help="Class">
                <ClassPicker name="classId" value={t.classId} onChange={(id) => form.update({ classId: id })} readOnly={ro} />
              </HeaderField>
            )}
            <HeaderSpacer />
            <HeaderField label="DATE" width={140} required>
              <DateField name="date" value={t.date} onChange={(d) => sales.setDate(d)} readOnly={ro} />
            </HeaderField>
            <HeaderField label="SALE NO." width={110}>
              <TextField name="refNumber" value={t.refNumber} onChange={(v) => form.update({ refNumber: v })} readOnly={ro} />
            </HeaderField>
          </HeaderRow>
          <div className="sx-cust-addrrow">
            <HeaderField label="SOLD TO" width={230}>
              <AddressBlock name="billAddress" rows={4} value={t.billAddress} onChange={(v) => form.update({ billAddress: v })} readOnly={ro} aria-label="Sold to" />
            </HeaderField>
            <div className="sx-cust-fieldgrid sx-cust-fieldgrid-left">
              <HeaderRow>
                <TxnHeaderField label="PAYMENT METHOD" width="auto">
                  <MethodButtons value={t.paymentMethodId} onChange={(id) => form.update({ paymentMethodId: id })} disabled={ro} />
                </TxnHeaderField>
              </HeaderRow>
              <HeaderRow>
                <HeaderField label="CHECK NO." width={120}>
                  <TextField name="checkNumber" value={checkNo} onChange={(v) => form.update({ extra: { ...(t.extra ?? {}), checkNumber: v } })} readOnly={ro} />
                </HeaderField>
                {showDepositTo && (
                  <HeaderField label="DEPOSIT TO" width={220} help="Undeposited Funds">
                    <AccountPicker name="accountId" types={['Bank', 'Other Current Asset']} value={t.accountId} onChange={(id) => form.update({ accountId: id })} readOnly={ro} placeholder="Undeposited Funds" />
                  </HeaderField>
                )}
              </HeaderRow>
            </div>
          </div>
        </>
      }
      lines={
        <SalesLinesGrid
          layout="standard"
          lines={sales.lines}
          onChange={(rows) => sales.setLines(rows)}
          itemsById={sales.itemsById}
          customerTaxable={sales.customerTaxable}
          readOnly={ro}
          persistKey="salesrcpt"
        />
      }
      footer={<SalesFooter form={form} sales={sales} rows={[{ key: 'total', label: 'Total', value: sales.calc.total, bold: true, separator: true }]} />}
      totals={totals}
      sidePanel={<CustomerHistoryPanel nameId={t.nameId} txn={form.original} persistKey="salesrcpt" />}
    />
  );
}
