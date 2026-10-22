// Small dialogs of the vendor module: Open Purchase Orders (receive against POs) and Pay Bill
// (pay one bill right away).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/api/client';
import { invalidateAll, useAccounts, useNextRef, useOpenDocs, usePrefValues } from '@/api/hooks';
import { emptyLine, type ID, type OpenDocsResult, type PayBillsRequest, type PayBillsResult, type Txn, type TxnLine, type TxnSummary } from '@/api/types';
import {
  AccountPicker,
  Button,
  Checkbox,
  DateField,
  ErrorBanner,
  Field,
  FieldRow,
  FormErrorsProvider,
  MoneyField,
  TextField,
  showDialog,
  toast,
  useFormErrors,
} from '@/components';
import { openTxn } from '@/windows/windowStore';
import { todayIso } from '@/util/dates';
import { fmtDate, fmtMoney, lineAmount, round2 } from '@/util/format';
import { sum2 } from './shared';
import './vendors.css';

// ---------------------------------------------------------------------------
// Checkable table used by selection dialogs

/** A column of {@link CheckTable}. */
export interface CheckCol<T> {
  key: string;
  label: string;
  width?: number;
  align?: 'left' | 'right';
  render: (row: T) => ReactNode;
}

/** Simple table with a check box per row (dialog selection lists). */
export function CheckTable<T>({
  rows,
  cols,
  getKey,
  checked,
  onToggle,
  empty,
  height = 220,
}: {
  rows: T[];
  cols: CheckCol<T>[];
  getKey: (r: T) => ID;
  checked: Set<ID>;
  onToggle: (key: ID, on: boolean) => void;
  empty?: ReactNode;
  height?: number;
}) {
  return (
    <div className="vx-ctable-wrap" style={{ height }}>
      <table className="vx-ctable">
        <thead>
          <tr>
            <th className="vx-ctable-chk" aria-label="Select" />
            {cols.map((c) => (
              <th key={c.key} style={{ width: c.width, textAlign: c.align ?? 'left' }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const k = getKey(r);
            const on = checked.has(k);
            return (
              <tr key={k} className={on ? 'vx-on' : undefined} onClick={(e) => (e.target as HTMLElement).tagName !== 'INPUT' && onToggle(k, !on)}>
                <td className="vx-ctable-chk">
                  <input type="checkbox" checked={on} onChange={(e) => onToggle(k, e.target.checked)} aria-label="Select row" />
                </td>
                {cols.map((c) => (
                  <td key={c.key} style={{ textAlign: c.align ?? 'left' }}>
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && empty && <div className="vx-ctable-empty">{empty}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Open purchase orders

/** Asks which open purchase orders to receive against. Resolves the chosen PO ids (null = cancel). */
export function selectPurchaseOrders(vendorName: string, pos: TxnSummary[]): Promise<ID[] | null> {
  return showDialog<ID[] | null>({
    title: 'Open Purchase Orders',
    width: 600,
    cancelValue: null,
    render: (close) => <SelectPOBody vendorName={vendorName} pos={pos} close={close} />,
  });
}

function SelectPOBody({ vendorName, pos, close }: { vendorName: string; pos: TxnSummary[]; close: (v: ID[] | null) => void }) {
  const [sel, setSel] = useState<Set<ID>>(() => new Set(pos.length === 1 ? [pos[0].id] : []));
  return (
    <div className="vx-dlg">
      <div>
        Select the purchase orders from <strong>{vendorName}</strong> that these items or expenses are for. Their remaining quantities are added to the Items tab.
      </div>
      <CheckTable
        rows={pos}
        getKey={(r) => r.id}
        checked={sel}
        onToggle={(k, on) => setSel((s) => {
          const n = new Set(s);
          if (on) n.add(k);
          else n.delete(k);
          return n;
        })}
        cols={[
          { key: 'date', label: 'DATE', width: 90, render: (r) => fmtDate(r.date) },
          { key: 'ref', label: 'PO NO.', width: 80, render: (r) => r.refNumber },
          { key: 'memo', label: 'MEMO', render: (r) => r.memo },
          { key: 'amt', label: 'AMOUNT', width: 100, align: 'right', render: (r) => fmtMoney(r.amount) },
        ]}
      />
      <div className="sx-dlg-buttons">
        <Button variant="primary" label="OK" disabled={sel.size === 0} onClick={() => close(pos.filter((p) => sel.has(p.id)).map((p) => p.id))} />
        <Button label="Cancel" onClick={() => close(null)} />
      </div>
    </div>
  );
}

/**
 * Item lines receiving the remaining quantities of purchase orders (linked to the PO lines).
 * PO lines already on the form (`existing`) are skipped.
 */
export async function poLinesFor(poIds: ID[], existing: TxnLine[], seen?: Txn[]): Promise<TxnLine[]> {
  const used = new Set(existing.map((l) => l.linkedLineId).filter(Boolean));
  const out: TxnLine[] = [];
  for (const id of poIds) {
    const po = await api.get<Txn>(`/txns/${id}`);
    seen?.push(po);
    for (const l of po.lines) {
      if (!l.itemId || l.closed || used.has(l.id)) continue;
      const ordered = l.qty ?? 1;
      const rest = round2(ordered - (l.receivedQty || 0));
      if (rest <= 0) continue;
      out.push({
        ...emptyLine('item'),
        itemId: l.itemId,
        description: l.description,
        qty: rest,
        rate: l.rate,
        amount: lineAmount(rest, l.rate),
        nameId: l.nameId,
        billable: !!l.nameId,
        // the PO's header class applies to lines without their own class
        classId: l.classId ?? po.classId ?? null,
        linkedTxnId: po.id,
        linkedLineId: l.id,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pay one bill

/** The bill to pay with {@link payBillDialog}. */
export interface BillToPay {
  id: ID;
  vendorId: ID;
  vendorName: string;
  refNumber: string;
  dueDate: string;
  openBalance: number;
}

/** Pays one bill now (one bill payment through POST /pay-bills). Resolves the payment or null. */
export function payBillDialog(bill: BillToPay): Promise<TxnSummary | null> {
  return showDialog<TxnSummary | null>({
    title: `Pay Bill${bill.refNumber ? ' ' + bill.refNumber : ''} - ${bill.vendorName}`,
    width: 560,
    cancelValue: null,
    render: (close) => <PayBillBody bill={bill} close={close} />,
  });
}

function PayBillBody({ bill, close }: { bill: BillToPay; close: (v: TxnSummary | null) => void }) {
  const prefs = usePrefValues();
  const fe = useFormErrors();
  const { data: accounts } = useAccounts({ types: ['Bank', 'Credit Card'], active: 'all' });
  const [date, setDate] = useState(todayIso());
  const [accountId, setAccountId] = useState<ID | null>(prefs.defaultBillPayAccountId ?? null);
  const acct = accounts?.find((a) => a.id === accountId) ?? null;
  const isBank = acct?.type === 'Bank';
  const [toPrint, setToPrint] = useState(false);
  const [checkNo, setCheckNo] = useState('');
  const [checkNoTouched, setCheckNoTouched] = useState(false);
  const next = useNextRef('CHK', accountId, { enabled: !!accountId && isBank });
  useEffect(() => {
    if (!checkNoTouched && next.data) setCheckNo(next.data.refNumber);
  }, [next.data, checkNoTouched]);
  useEffect(() => {
    if (accountId === null && accounts?.length) setAccountId(accounts.find((a) => a.type === 'Bank' && a.active)?.id ?? null);
  }, [accounts, accountId]);

  // the early payment discount is suggested for the payment date
  const docsQuery = useOpenDocs({ kind: 'payable', nameId: bill.vendorId, date: date || todayIso() });
  const lastDocs = useRef<OpenDocsResult | undefined>(undefined);
  if (docsQuery.data) lastDocs.current = docsQuery.data;
  const docsData = docsQuery.data ?? lastDocs.current;
  const credits = useMemo(() => (docsData?.credits ?? []).filter((c) => c.openBalance > 0), [docsData]);
  const charge = docsData?.charges.find((c) => c.txnId === bill.id);
  const open = charge?.openBalance ?? bill.openBalance;
  const [useCredits, setUseCredits] = useState(false);
  const creditAvail = sum2(credits.map((c) => c.openBalance));
  const creditUse = useCredits ? Math.min(creditAvail, open) : 0;
  const discOk = !!charge && charge.suggestedDiscount > 0 && (!charge.discountDate || date <= charge.discountDate);
  const [discount, setDiscount] = useState(0);
  const [discTouched, setDiscTouched] = useState(false);
  // the early payment discount is taken automatically only with Preferences > Bills "Automatically use discounts"
  useEffect(() => {
    if (!discTouched) setDiscount(discOk && prefs.autoUseVendorDiscounts ? charge!.suggestedDiscount : 0);
  }, [discOk, charge, discTouched, prefs.autoUseVendorDiscounts]);
  const [discAcct, setDiscAcct] = useState<ID | null>(prefs.vendorDiscountAccountId ?? null);
  const maxPay = round2(open - creditUse - discount);
  const [amount, setAmount] = useState<number | null>(null);
  const pay = amount ?? Math.max(0, maxPay);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    fe.clearAll();
    if (!date) return fe.setErrors({ date: 'Enter the payment date.' });
    if (!accountId) return fe.setErrors({ accountId: 'Choose the account to pay from.' });
    if (pay < 0) return fe.setErrors({ amount: 'The amount cannot be negative.' });
    if (round2(pay + discount + creditUse) > open + 0.0001)
      return fe.setErrors({ amount: `The payment, discount and credits (${fmtMoney(pay + discount + creditUse)}) are more than the ${fmtMoney(open)} still owed.` });
    if (pay + discount + creditUse <= 0) return fe.setErrors({ amount: 'Enter the amount to pay.' });
    if (discount > 0 && !discAcct) return fe.setErrors({ discountAccountId: 'Choose the account for the discount.' });
    // credits: oldest first
    let left = creditUse;
    const used: { creditId: ID; amount: number }[] = [];
    for (const c of credits) {
      if (left <= 0) break;
      const a = round2(Math.min(left, c.openBalance));
      used.push({ creditId: c.txnId, amount: a });
      left = round2(left - a);
    }
    const req: PayBillsRequest = {
      date,
      accountId,
      toBePrinted: isBank && toPrint,
      firstCheckNumber: isBank && !toPrint ? checkNo.trim() : '',
      bills: [{ billId: bill.id, amount: pay, discount, discountAccountId: discount > 0 ? discAcct : null, credits: used }],
    };
    setBusy(true);
    try {
      const res = await api.post<PayBillsResult>('/pay-bills', req);
      void invalidateAll();
      const p = res.payments[0] ?? null;
      if (p) {
        toast(`Bill payment${p.refNumber ? ' ' + p.refNumber : ''} saved: ${fmtMoney(p.amount)} to ${bill.vendorName}`, {
          action: { label: 'Open', onClick: () => openTxn(p.type, p.id) },
        });
      }
      close(p);
    } catch (e) {
      fe.fromError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormErrorsProvider value={fe}>
      <div
        className="vx-dlg"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLElement).getAttribute('aria-expanded') !== 'true') {
            e.preventDefault();
            void submit();
          }
        }}
      >
        {(fe.message || Object.keys(fe.errors).length > 0) && <ErrorBanner errors={fe.errors} message={fe.message} onDismiss={() => fe.clearAll()} />}
        <dl className="vx-dlg-info">
          <dt>Vendor</dt>
          <dd>{bill.vendorName}</dd>
          <dt>Bill</dt>
          <dd>
            {bill.refNumber || '(no number)'}
            {bill.dueDate ? ` · due ${fmtDate(bill.dueDate)}` : ''}
          </dd>
          <dt>Still owed</dt>
          <dd className="vx-strong">{fmtMoney(open)}</dd>
        </dl>
        <FieldRow>
          <Field label="Payment date" htmlFor="vx-pb-date" width={150}>
            <DateField id="vx-pb-date" name="date" value={date} onChange={setDate} />
          </Field>
          <Field label="Pay from" htmlFor="vx-pb-acct" width={260} hint={acct ? `Balance ${fmtMoney(acct.balance)}` : undefined}>
            <AccountPicker id="vx-pb-acct" name="accountId" types={['Bank', 'Credit Card']} value={accountId} onChange={(id) => setAccountId(id)} addNew={false} />
          </Field>
        </FieldRow>
        {isBank && (
          <FieldRow align="end">
            <Field label="Check no." htmlFor="vx-pb-no" width={150}>
              <TextField
                id="vx-pb-no"
                name="firstCheckNumber"
                value={toPrint ? 'To print' : checkNo}
                disabled={toPrint}
                onChange={(v) => {
                  setCheckNo(v);
                  setCheckNoTouched(true);
                }}
              />
            </Field>
            <Checkbox label="Print the check later" checked={toPrint} onChange={setToPrint} style={{ marginBottom: 6 }} />
          </FieldRow>
        )}
        {credits.length > 0 && (
          <Checkbox
            label={`Use available credits (${fmtMoney(creditAvail)} from ${credits.length} vendor credit${credits.length === 1 ? '' : 's'})`}
            checked={useCredits}
            onChange={(c) => {
              setUseCredits(c);
              setAmount(null);
            }}
          />
        )}
        {discOk && discount === 0 && (
          <div className="vx-note">
            Early payment discount of {fmtMoney(charge!.suggestedDiscount)} available until {fmtDate(charge!.discountDate)}.
            <button
              type="button"
              className="sx-linkbtn"
              onClick={() => {
                setDiscount(charge!.suggestedDiscount);
                setDiscTouched(true);
                setAmount(null);
              }}
            >
              Take the discount
            </button>
          </div>
        )}
        {discount > 0 && (
          <FieldRow align="end">
            <Field label="Discount" htmlFor="vx-pb-disc" width={150} help={discOk ? `Early payment discount available until ${fmtDate(charge!.discountDate)}. Set it to 0 to pay the full amount.` : undefined}>
              <MoneyField
                id="vx-pb-disc"
                name="discount"
                value={discount}
                onChange={(v) => {
                  setDiscount(v ?? 0);
                  setDiscTouched(true);
                  setAmount(null);
                }}
              />
            </Field>
            <Field label="Discount account" htmlFor="vx-pb-dacct" width={260}>
              <AccountPicker id="vx-pb-dacct" name="discountAccountId" value={discAcct} onChange={(id) => setDiscAcct(id)} />
            </Field>
          </FieldRow>
        )}
        <FieldRow align="end">
          <Field label="Amount to pay" htmlFor="vx-pb-amt" width={150}>
            <MoneyField id="vx-pb-amt" name="amount" value={pay} onChange={(v) => setAmount(v ?? 0)} autoFocus />
          </Field>
          {pay < maxPay && pay > 0 && <span className="vx-muted" style={{ paddingBottom: 6 }}>{fmtMoney(round2(maxPay - pay))} will stay open on this bill.</span>}
        </FieldRow>
        <div className="sx-dlg-buttons">
          <Button variant="primary" label="&Pay bill" busy={busy} onClick={() => void submit()} />
          <Button label="Cancel" onClick={() => close(null)} />
        </div>
      </div>
    </FormErrorsProvider>
  );
}
