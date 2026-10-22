// Create Invoices (INV): full invoice fields and templates (Product / Service / Professional) with the
// friendlier form frame: inline errors, sticky totals, toast after saving, history panel.
// Extras: Receive payment, Create credit memo, Add time/costs (billable costs), Apply credits,
// Mark as pending, Print. props.estimateId prefills the invoice from an estimate (lines linked).
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BadgePercent, Clock3, FileMinus2, HandCoins } from 'lucide-react';
import { api } from '@/api/client';
import { INVOICE_TEMPLATE_OPTIONS, type BillableCost, type ID, type ListEntry, type Name, type Txn, type TxnLine } from '@/api/types';
import { AddressBlock, Button, ClassPicker, DateField, RepPicker, Select, ShipViaPicker, TermsPicker, TextField, alertBox, confirmBox, msgBox, toast } from '@/components';
import { HeaderRow, HeaderSpacer, TxnFormFrame, useTxnForm, type FooterTotal, type StampKind } from '@/forms';
import { openWindow } from '@/windows/windowStore';
import { todayIso } from '@/util/dates';
import { round2 } from '@/util/format';
import { CustomerHistoryPanel } from './CustomerHistoryPanel';
import { applyCreditsToInvoice, chooseBillableCosts } from './dialogs';
import { printSalesForm } from './printing';
import { SalesLinesGrid, type SalesLayout } from './SalesLinesGrid';
import { blankSales, CustomerField, fromTemplate, loadCustomers, loadItemsById, loadPrefs, nextRef, paymentsApplied, SalesFooter, useSalesState, validateSalesForm, withCustomer } from './salesForm';
import { displayStatus, HeaderField, money$, retaxLines } from './shared';

export interface InvoiceFormProps {
  id?: number;
  customerId?: number;
  estimateId?: number;
  /** Prefill of a new invoice (memorized transactions, copies). */
  template?: Txn;
  /** The user already agreed to invoice this estimate again (it was invoiced or closed before). */
  estimateConfirmed?: boolean;
}

/**
 * Before invoicing an estimate that was already invoiced or closed: "Create another invoice
 * anyway?" (otherwise the same work could be billed twice). Resolves true to go on.
 */
export async function confirmReinvoice(est: Txn): Promise<boolean> {
  const invoices = (est.linked ?? []).filter((l) => l.type === 'INV');
  if (!invoices.length && est.status !== 'Closed') return true;
  const which = invoices.map((l) => l.refNumber || '(no number)');
  const msg = invoices.length
    ? `This estimate was already invoiced on ${which.length === 1 ? 'invoice' : 'invoices'} ${which.join(', ')}. Create another invoice anyway?`
    : 'This estimate is closed. Create an invoice from it anyway?';
  const r = await msgBox({ title: 'Estimate Already Invoiced', message: msg, buttons: ['Yes', 'No'], defaultButton: 'No', icon: 'warning' });
  return r === 'Yes';
}

const TEMPLATES = INVOICE_TEMPLATE_OPTIONS;

function layoutOf(template: string): SalesLayout {
  if (template === 'Service Invoice') return 'service';
  if (template === 'Professional Invoice') return 'professional';
  return 'product';
}

/**
 * Builds a new invoice: defaults, template, customer or estimate prefill, next number. An estimate
 * that was already invoiced is used only when the user confirms (onDeclined runs otherwise and the
 * invoice starts blank for the estimate's customer).
 */
async function makeInvoice(props: InvoiceFormProps, opts: { confirm?: (est: Txn) => Promise<boolean>; onDeclined?: () => void } = {}): Promise<Txn> {
  const prefs = await loadPrefs();
  const ref = await nextRef('INV');
  if (props.template) return { ...fromTemplate(props.template), type: 'INV', refNumber: ref };
  let t: Txn = { ...blankSales('INV', prefs), refNumber: ref };
  let custId = props.customerId ?? null;
  let est: Txn | null = null;
  if (props.estimateId) est = await api.get<Txn>(`/txns/${props.estimateId}`);
  if (est && !props.estimateConfirmed && !(await (opts.confirm ?? confirmReinvoice)(est))) {
    custId = est.nameId ?? custId;
    est = null;
    opts.onDeclined?.();
  }
  const cid = est?.nameId ?? custId;
  if (cid) {
    const [all, itemsById, terms] = await Promise.all([loadCustomers(), loadItemsById(), api.get<ListEntry[]>('/lists/terms?active=all').catch(() => [] as ListEntry[])]);
    const n = all.find((x) => x.id === cid) ?? (await api.get<Name>(`/names/${cid}`));
    t = withCustomer(t, n, all, prefs, itemsById, { terms });
  }
  if (est) {
    t = {
      ...t,
      classId: est.classId,
      repId: est.repId ?? t.repId,
      taxItemId: est.taxItemId ?? t.taxItemId,
      customerMessageId: est.customerMessageId,
      memo: est.memo,
      poNumber: est.poNumber,
      lines: est.lines
        .filter((l) => l.kind === 'item')
        .map((l, i) => ({ ...l, id: 0, seq: i + 1, linkedTxnId: est!.id, linkedLineId: l.id, billedTxnId: null, receivedQty: 0, cogs: 0 })),
    };
  }
  return t;
}

export default function InvoiceForm(props: InvoiceFormProps) {
  const savedRef = useRef<Txn | null>(null);
  // the estimate (props.estimateId) fills new invoices until one is saved: "Save and new" then starts blank
  const estimateUsed = useRef(false);
  // the "already invoiced" question is asked once per window (a new form may be built more than once)
  const reinvoice = useRef<Promise<boolean> | null>(null);
  const closing = useRef(false);
  const form = useTxnForm({
    type: 'INV',
    id: props.id,
    makeNew: () =>
      makeInvoice(estimateUsed.current ? { ...props, estimateId: undefined } : props, {
        confirm: (est) => (reinvoice.current ??= confirmReinvoice(est)),
        // declined to invoice the estimate again: close the window opened for it
        onDeclined: () => {
          if (closing.current) return;
          closing.current = true;
          setTimeout(() => void form.win?.close(true), 0);
        },
      }),
    prepare: (t) => sales.prepare(t),
    validate: (t) => validateSalesForm(t, sales.calc, form.prefs, { noun: 'invoice' }),
    toastOnSave: (s) => `Invoice ${s.refNumber} saved`,
    afterSave: (s) => {
      savedRef.current = s;
      estimateUsed.current = true;
    },
  });
  const sales = useSalesState(form);
  const t = form.txn;
  const orig = form.original;
  const prefs = form.prefs;
  const layout = layoutOf(t.template || prefs.defaultInvoiceTemplate);
  const ro = t.voided;

  useEffect(() => {
    form.win?.setTitle(form.isNew ? 'Create Invoices' : `Invoice ${t.refNumber}${t.nameFull ? ' - ' + t.nameFull : ''}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.isNew, t.id, t.refNumber, t.nameFull]);

  const applied = paymentsApplied(orig);
  const balance = round2(sales.calc.total - applied);
  const stamp: StampKind | null = t.voided ? 'VOID' : t.isPending ? 'PENDING' : orig && !form.dirty && orig.amount > 0 && orig.openBalance <= 0 && !orig.isPending ? 'PAID' : null;
  const status = orig ? displayStatus({ ...orig, isPending: orig.isPending }, todayIso()) : null;

  /** Saves first when the invoice is new or changed; resolves the saved invoice (or null). */
  const ensureSaved = async (why: string): Promise<Txn | null> => {
    if (!form.isNew && !form.dirty) return form.txn;
    if (!(await confirmBox(`The invoice must be saved ${why}. Save it now?`, 'Save Invoice'))) return null;
    savedRef.current = null;
    const ok = await form.save('stay');
    return ok ? savedRef.current : null;
  };

  const receivePayment = async () => {
    const saved = await ensureSaved('before you receive a payment for it');
    if (!saved || !saved.id) return;
    openWindow('receivePayment', { customerId: saved.nameId, invoiceId: saved.id });
  };
  const addTimeCosts = async (selectAll = false) => {
    if (!t.nameId) {
      form.setFieldError('nameId', 'Choose the customer to bill first.');
      return;
    }
    const already = new Set<ID>(t.lines.map((l) => l.linkedLineId).filter((x): x is ID => !!x));
    const added = await chooseBillableCosts(t.nameId, sales.customer?.fullName || t.nameFull || '', already, sales.customerTaxable, { selectAll });
    if (!added.length) return;
    const keep = sales.lines.filter((l) => !(l.itemId === null && !l.description && !l.amount));
    // the tax code follows the item and the customer (like a line typed by hand)
    sales.setLines(retaxLines([...keep, ...added], sales.itemsById, sales.customerTaxable).map((l, i) => ({ ...l, seq: i + 1 })));
    toast(`${added.length} billable ${added.length === 1 ? 'cost' : 'costs'} added`, { kind: 'success' });
  };
  const applyCredits = async () => {
    const saved = await ensureSaved('before credits can be applied to it');
    if (!saved || !saved.id) return;
    if (saved.openBalance <= 0) {
      await alertBox('This invoice is already paid in full. There is nothing left to apply a credit to.', 'Apply Credits');
      return;
    }
    if (await applyCreditsToInvoice(saved)) {
      await form.load(saved.id);
      toast('Credits applied', { kind: 'success' });
    }
  };

  // billable costs of this customer:job that are not on an invoice yet (the form asks about them)
  const billQ = useQuery({
    queryKey: ['billables', { customerId: t.nameId }],
    queryFn: ({ signal }) => api.get<BillableCost[]>(`/billables?customerId=${t.nameId}`, { signal }),
    enabled: !!t.nameId && !ro,
  });
  const onThisInvoice = new Set<ID>(t.lines.map((l) => l.linkedLineId).filter((x): x is ID => !!x));
  const unbilled = (billQ.data ?? []).filter((b) => !onThisInvoice.has(b.lineId));
  const unbilledTotal = round2(unbilled.reduce((s, b) => s + b.amount, 0));
  const [billHiddenFor, setBillHiddenFor] = useState<ID | null>(null);
  const showBillBanner = !ro && !!t.nameId && unbilled.length > 0 && billHiddenFor !== t.nameId;

  const totals: FooterTotal[] = [
    { key: 'total', label: 'Total', value: sales.calc.total },
    { key: 'applied', label: 'Payments applied', value: applied },
    { key: 'balance', label: 'Balance due', value: balance, strong: true, tone: balance > 0 && status === 'Overdue' ? 'danger' : undefined },
  ];

  const showShip = layout === 'product';
  const showRep = layout !== 'professional';

  return (
    <TxnFormFrame
      form={form}
      title="Invoice"
      status={t.voided ? 'Void' : t.isPending ? 'Pending' : status}
      stamp={stamp}
      showPending
      readOnly={ro}
      onPrint={() =>
        void printSalesForm(sales.prepare(t), {
          title: 'Invoice',
          numberLabel: 'Invoice #',
          itemsById: sales.itemsById,
          taxEnabled: prefs.salesTaxEnabled,
          paymentsApplied: applied,
          stamp: t.voided ? 'VOID' : t.isPending ? 'PENDING' : stamp === 'PAID' ? 'PAID' : null,
        })
      }
      titleRight={
        <HeaderField label="LAYOUT" width={190}>
          <Select name="template" value={t.template || prefs.defaultInvoiceTemplate} options={TEMPLATES} onChange={(v) => form.update({ template: v })} disabled={ro} aria-label="Invoice layout" title="Invoice layout" />
        </HeaderField>
      }
      extraButtons={[
        { key: 'pay', label: 'Receive payment', icon: HandCoins, color: '#16a34a', onClick: () => void receivePayment(), disabled: ro || t.isPending || (!!orig && orig.openBalance <= 0 && !form.dirty), primary: !form.isNew && !!orig && orig.openBalance > 0 && !t.isPending },
        { key: 'credit', label: 'Create credit memo', icon: FileMinus2, onClick: () => openWindow('creditMemo', { customerId: t.nameId ?? undefined }) },
        { key: 'costs', label: 'Add time/costs', icon: Clock3, onClick: () => void addTimeCosts(), disabled: ro, title: 'Add billable time and costs recorded on bills, checks and charges' },
        { key: 'apply', label: 'Apply credits', icon: BadgePercent, onClick: () => void applyCredits(), disabled: ro || t.isPending, title: 'Use this customer’s credit memos or unused payments on this invoice' },
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
            <HeaderField label="INVOICE #" width={110}>
              <TextField name="refNumber" value={t.refNumber} onChange={(v) => form.update({ refNumber: v })} readOnly={ro} />
            </HeaderField>
          </HeaderRow>
          <div className="sx-cust-addrrow">
            <HeaderField label="BILL TO" width={230}>
              <AddressBlock name="billAddress" rows={4} value={t.billAddress} onChange={(v) => form.update({ billAddress: v })} readOnly={ro} aria-label="Bill to" />
            </HeaderField>
            {showShip && (
              <HeaderField label="SHIP TO" width={230}>
                <AddressBlock name="shipAddress" rows={4} value={t.shipAddress} onChange={(v) => form.update({ shipAddress: v })} readOnly={ro} aria-label="Ship to" />
              </HeaderField>
            )}
            <div className="sx-cust-fieldgrid">
              <HeaderRow>
                <HeaderField label="P.O. NO." width={110}>
                  <TextField name="poNumber" value={t.poNumber} onChange={(v) => form.update({ poNumber: v })} readOnly={ro} />
                </HeaderField>
                <HeaderField label="TERMS" width={150} help="Terms">
                  <TermsPicker name="termsId" value={t.termsId} onChange={(id) => sales.setTerms(id)} readOnly={ro} />
                </HeaderField>
                <HeaderField label="DUE DATE" width={140}>
                  <DateField name="dueDate" value={t.dueDate} onChange={(d) => form.update({ dueDate: d })} readOnly={ro} />
                </HeaderField>
              </HeaderRow>
              {(showRep || showShip) && (
                <HeaderRow>
                  {showRep && (
                    <HeaderField label="REP" width={90} help="The sales rep who gets credit for this sale.">
                      <RepPicker name="repId" value={t.repId} onChange={(id) => form.update({ repId: id })} readOnly={ro} listWidth={220} />
                    </HeaderField>
                  )}
                  {showShip && (
                    <>
                      <HeaderField label="SHIP DATE" width={140}>
                        <DateField name="shipDate" value={t.shipDate} onChange={(d) => form.update({ shipDate: d })} readOnly={ro} />
                      </HeaderField>
                      <HeaderField label="SHIPPED BY" width={120}>
                        <ShipViaPicker name="shipViaId" value={t.shipViaId} onChange={(id) => form.update({ shipViaId: id })} readOnly={ro} />
                      </HeaderField>
                      <HeaderField label="F.O.B." width={90} help="Free on board: the place where the goods become the customer's responsibility.">
                        <TextField name="fob" value={t.fob} onChange={(v) => form.update({ fob: v })} readOnly={ro} />
                      </HeaderField>
                    </>
                  )}
                </HeaderRow>
              )}
            </div>
          </div>
        </>
      }
      lines={
        <>
          {showBillBanner && (
            <div className="sx-cust-billbanner" role="status">
              <Clock3 size={15} aria-hidden="true" />
              <span>
                {unbilled.length === 1 ? '1 billable cost' : `${unbilled.length} billable costs`} ({money$(unbilledTotal)}) for {sales.customer?.fullName || t.nameFull} {unbilled.length === 1 ? 'is' : 'are'} not
                invoiced yet.
              </span>
              <Button small variant="primary" label="Add them" onClick={() => void addTimeCosts(true)} title="Choose the billable time and costs to put on this invoice" />
              <Button small variant="ghost" label="Not now" onClick={() => setBillHiddenFor(t.nameId)} />
            </div>
          )}
          <SalesLinesGrid
            layout={layout}
            lines={sales.lines}
            onChange={(rows: TxnLine[]) => sales.setLines(rows)}
            itemsById={sales.itemsById}
            customerTaxable={sales.customerTaxable}
            readOnly={ro}
            persistKey={`inv-${layout}`}
          />
        </>
      }
      footer={<SalesFooter form={form} sales={sales} />}
      totals={totals}
      sidePanel={<CustomerHistoryPanel nameId={t.nameId} txn={orig} persistKey="invoice" />}
    />
  );
}
