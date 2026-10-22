// Bill Payment by Check / by Credit Card: the check-style view of a bill payment with the
// bills it pays. Amounts paid per bill can be changed (the payment amount follows); bills can be
// added or removed (open bills of the same vendor are listed). A new form pays one vendor's bills.
// A saved payment with an unapplied part (a bill it paid was voided or deleted) keeps its amount:
// checking bills uses up the unapplied part, like a vendor credit in Pay Bills.
import { useEffect, useMemo, useRef } from 'react';
import { Wallet } from 'lucide-react';
import { useAccounts, useCompanyInfo, useNextRef, useOpenDocs, usePrefValues } from '@/api/hooks';
import { emptyLink, emptyTxn, type ID, type Name, type OpenDoc, type Txn, type TxnLink } from '@/api/types';
import { AccountPicker, AddressBlock, Checkbox, DateField, Grid, NamePicker, TextField, type GridColumn } from '@/components';
import { TxnFormFrame, TxnHeaderField, useTxnForm, type TxnProblem } from '@/forms';
import { useWindow } from '@/windows/WindowContext';
import { openTxn, openWindow } from '@/windows/windowStore';
import { todayIso } from '@/util/dates';
import { escHtml, printHtml } from '@/util/print';
import { fmtDate, fmtMoney, round2 } from '@/util/format';
import { amountInWords, fetchName, sum2, vendorAddressText } from './shared';
import './vendors.css';

export interface BillPaymentFormProps {
  id?: number;
  vendorId?: number;
  template?: Txn;
}

/** One bill row of the payment grid. */
interface PaidRow {
  id: ID;
  doc: OpenDoc;
  sel: boolean;
  amount: number;
  discount: number;
  credits: number;
}

function ownLink(l: TxnLink, selfId: ID): boolean {
  return l.fromTxnId === null || l.fromTxnId === 0 || l.fromTxnId === selfId;
}

export default function BillPaymentForm(props: BillPaymentFormProps) {
  const win = useWindow();
  const company = useCompanyInfo();
  const { data: payAccounts } = useAccounts({ types: ['Bank', 'Credit Card'], active: 'all' });
  const refTouched = useRef(false);
  /** Amount of a saved payment that has an unapplied part (it does not follow the bills), else null. */
  const fixedRef = useRef<number | null>(null);
  const prefsNow = usePrefValues();
  const prefsRef = useRef(prefsNow);
  prefsRef.current = prefsNow;

  const form = useTxnForm({
    type: 'BILLPMT',
    id: props.id,
    makeNew: () => {
      // a copy / memorized template keeps its vendor, account and memo; the bills are chosen again
      const tpl = props.template;
      const t = emptyTxn('BILLPMT', tpl?.date || todayIso());
      t.nameId = props.vendorId ?? tpl?.nameId ?? null;
      t.nameFull = tpl?.nameFull ?? '';
      t.billAddress = tpl?.billAddress ?? '';
      t.memo = tpl?.memo ?? '';
      t.accountId = tpl?.accountId ?? prefsRef.current.defaultBillPayAccountId ?? null;
      refTouched.current = false;
      return t;
    },
    prepare: (t) => {
      const links = t.links.filter((l) => l.amount > 0 || l.discount > 0);
      const amount = fixedRef.current ?? sum2(links.filter((l) => ownLink(l, t.id)).map((l) => l.amount));
      return { ...t, links, lines: [], amount };
    },
    validate: (t) => {
      const p: TxnProblem[] = [];
      const fixed = fixedRef.current;
      if (fixed === null) {
        if (!t.links.length) p.push({ field: 'links', message: 'Check at least one bill to pay.' });
      } else {
        const applied = sum2(t.links.filter((l) => ownLink(l, t.id)).map((l) => l.amount));
        if (applied > fixed + 0.004)
          p.push({ field: 'links', message: `The amounts paid add up to ${fmtMoney(applied)}, more than this payment's ${fmtMoney(fixed)}. Lower the amounts paid on the bills.` });
      }
      return p;
    },
    onLoaded: (t, isNew) => {
      // payments made in Pay Bills have no check address yet: show the vendor's (no change mark)
      if (!isNew && !t.billAddress && t.nameId) {
        void fetchName(t.nameId)
          .then((n) => {
            const f = formRef.current;
            if (f.txn.id === t.id && !f.dirty && !f.txn.billAddress) f.reset({ ...f.txn, billAddress: vendorAddressText(n) });
          })
          .catch(() => undefined);
      }
    },
  });
  const formRef = useRef(form);
  formRef.current = form;
  const { txn, original } = form;
  const saved = !!txn.id;
  const readOnly = txn.voided;
  // a saved payment with an unapplied part keeps the amount it was saved with
  const fixedAmount = original && !original.voided && original.openBalance > 0.004 ? original.amount : null;
  fixedRef.current = fixedAmount;
  const acct = payAccounts?.find((a) => a.id === txn.accountId) ?? null;
  const isCard = acct?.type === 'Credit Card';
  const docs = useOpenDocs({ kind: 'payable', nameId: txn.nameId, excludeTxnId: txn.id || null }, { enabled: !!txn.nameId });
  const nextRef = useNextRef('CHK', txn.accountId, { enabled: !saved && !!txn.accountId && !isCard });

  useEffect(() => {
    win.setTitle(`Bill Payment by ${isCard ? 'Credit Card' : 'Check'}${acct ? ' - ' + acct.name : ''}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCard, acct?.name]);

  // a new payment gets the next check number of the account
  useEffect(() => {
    if (saved || refTouched.current || txn.toBePrinted || isCard || !nextRef.data) return;
    if (txn.refNumber === nextRef.data.refNumber) return;
    // keep the "no changes" state of a blank form
    if (form.dirty) form.update({ refNumber: nextRef.data.refNumber });
    else form.reset({ ...form.txn, refNumber: nextRef.data.refNumber });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextRef.data, saved, txn.toBePrinted, isCard]);

  // ---- bills grid
  const rows: PaidRow[] = useMemo(() => {
    const charges = docs.data?.charges ?? [];
    const out: PaidRow[] = charges.map((d) => {
      const own = txn.links.find((l) => l.toTxnId === d.txnId && ownLink(l, txn.id));
      const cred = sum2(txn.links.filter((l) => l.toTxnId === d.txnId && !ownLink(l, txn.id)).map((l) => l.amount));
      return { id: d.txnId, doc: d, sel: !!own || cred > 0, amount: own?.amount ?? 0, discount: own?.discount ?? 0, credits: cred };
    });
    return out.sort((a, b) => (a.doc.dueDate || a.doc.date).localeCompare(b.doc.dueDate || b.doc.date) || a.id - b.id);
  }, [docs.data, txn.links, txn.id]);

  const setRows = (next: PaidRow[]) => {
    const keepCredits = (billId: ID, sel: boolean) => (sel ? txn.links.filter((l) => l.toTxnId === billId && !ownLink(l, txn.id)) : []);
    const links: TxnLink[] = [];
    for (const r of next) {
      if (!r.sel) continue;
      const prev = txn.links.find((l) => l.toTxnId === r.id && ownLink(l, txn.id));
      if (r.amount > 0 || r.discount > 0) links.push({ ...(prev ?? emptyLink(r.id)), fromTxnId: null, toTxnId: r.id, amount: r.amount, discount: r.discount });
      links.push(...keepCredits(r.id, true));
    }
    form.update({ links, amount: fixedAmount ?? sum2(links.filter((l) => ownLink(l, txn.id)).map((l) => l.amount)) });
  };
  const onRowChange = (next: PaidRow, prev: PaidRow, key: string): PaidRow => {
    if (key === 'sel') {
      if (next.sel) {
        let amount = Math.max(0, round2(next.doc.openBalance - next.discount - next.credits));
        // a payment with an unapplied part: pay at most what is still unapplied
        if (fixedAmount !== null) amount = Math.max(0, Math.min(amount, round2(fixedAmount - sum2(rows.filter((r) => r.sel && r.id !== next.id).map((r) => r.amount)))));
        return { ...next, amount };
      }
      return { ...next, amount: 0, discount: 0, credits: 0 };
    }
    if (key === 'amount') {
      const amount = Math.max(0, round2(next.amount || 0));
      return { ...next, amount, sel: amount > 0 || next.credits > 0 };
    }
    return next;
  };
  const columns: GridColumn<PaidRow>[] = [
    { key: 'sel', label: '✓', width: 34, editor: 'checkbox', readOnly: () => !!readOnly, title: 'Paid by this payment' },
    { key: 'dueDate', label: 'DATE DUE', width: 92, render: (r) => fmtDate(r.doc.dueDate || r.doc.date) },
    { key: 'type', label: 'TYPE', width: 90, render: (r) => r.doc.typeLabel },
    { key: 'ref', label: 'REF. NO.', width: 100, grow: true, render: (r) => r.doc.refNumber },
    { key: 'orig', label: 'ORIG. AMT.', width: 100, align: 'right', render: (r) => fmtMoney(r.doc.amount) },
    { key: 'due', label: 'AMT. DUE', width: 100, align: 'right', title: 'Open balance before this payment', render: (r) => fmtMoney(r.doc.openBalance) },
    { key: 'discount', label: 'DISC.', width: 80, align: 'right', render: (r) => fmtMoney(r.discount, { blankZero: true }) },
    { key: 'credits', label: 'CREDITS', width: 84, align: 'right', render: (r) => fmtMoney(r.credits, { blankZero: true }) },
    { key: 'amount', label: 'AMT. PAID', width: 110, align: 'right', editor: 'money', blankZero: true, readOnly: () => !!readOnly },
  ];

  const onVendor = (id: ID | null, n: Name | null) => {
    form.update({ nameId: id, nameFull: n?.fullName ?? '', billAddress: n ? vendorAddressText(n) : '', links: [], amount: 0, memo: n?.accountNumber ?? '' });
  };

  const applied = sum2(txn.links.filter((l) => ownLink(l, txn.id)).map((l) => l.amount));
  /** The payment (check) amount. */
  const total = fixedAmount ?? applied;
  const unapplied = fixedAmount === null ? 0 : round2(fixedAmount - applied);

  const print = () => {
    const stub = rows
      .filter((r) => r.sel)
      .map((r) => `<tr><td>${fmtDate(r.doc.date)}</td><td>${escHtml(r.doc.typeLabel)}</td><td>${escHtml(r.doc.refNumber)}</td><td class="num">${fmtMoney(r.doc.amount)}</td><td class="num">${fmtMoney(r.amount)}</td></tr>`)
      .join('');
    const addr = (s: string) => escHtml(s).replace(/\n/g, '<br>');
    const check = `<div class="chk"><div class="row"><b>${escHtml(company.data?.name ?? '')}</b><span>No. ${escHtml(txn.refNumber)}</span></div>
      <div class="row"><span></span><span>${fmtDate(txn.date)}</span></div>
      <div class="row"><span>PAY TO THE ORDER OF <b>${escHtml(txn.nameFull)}</b></span><span class="amt">$**${fmtMoney(total)}</span></div>
      <div class="words">${escHtml(amountInWords(total))}*****</div><div class="addr">${addr(txn.billAddress)}</div><div>MEMO ${escHtml(txn.memo)}</div></div>`;
    const stubHtml = `<div class="stub"><b>${escHtml(txn.nameFull)}</b> ${fmtDate(txn.date)}<table><thead><tr><th>Date</th><th>Type</th><th>Reference</th><th class="num">Original Amt.</th><th class="num">Payment</th></tr></thead><tbody>${stub}</tbody></table><div class="num"><b>Check Amount ${fmtMoney(total)}</b></div></div>`;
    void printHtml(
      `Bill Payment ${txn.refNumber}`,
      check + stubHtml + stubHtml,
      `.chk{height:3.3in;border-bottom:1px dashed #999;padding:8px}.row{display:flex;justify-content:space-between;margin:6px 0}.amt{border:1px solid #000;padding:2px 8px}
       .words{border-bottom:1px solid #000;margin:8px 0}.addr{margin:12px 0 12px 40px}.stub{height:3.3in;padding:8px;border-bottom:1px dashed #999}`,
    );
  };

  const header = (
    <div className="vx-chkform">
      <div className="vx-acctbar">
        <TxnHeaderField label={isCard ? 'Credit card' : 'Bank account'} required htmlFor="vx-bp-acct" width={260}>
          <AccountPicker id="vx-bp-acct" name="accountId" types={['Bank', 'Credit Card']} value={txn.accountId} readOnly={readOnly} addNew={false} onChange={(id) => form.update({ accountId: id })} />
        </TxnHeaderField>
        <div className="vx-endbal">
          <span className="sx-label">Ending balance</span>
          <strong>{acct ? fmtMoney(acct.balance) : '—'}</strong>
        </div>
      </div>
      <div className="vx-check">
        <TxnHeaderField label="Pay to the order of" required htmlFor="vx-bp-vendor" className="vx-a-payee">
          <NamePicker
            id="vx-bp-vendor"
            name="nameId"
            kinds={['vendor']}
            value={txn.nameId}
            fallbackLabel={txn.nameFull}
            readOnly={readOnly || saved}
            title={saved ? 'The vendor of a saved bill payment cannot change. Delete it and pay again instead.' : undefined}
            autoFocus={!saved && !props.vendorId}
            onChange={onVendor}
          />
        </TxnHeaderField>
        <TxnHeaderField label="No." htmlFor="vx-bp-no" className="vx-a-no">
          <TextField
            id="vx-bp-no"
            name="refNumber"
            value={txn.toBePrinted ? 'To print' : txn.refNumber}
            disabled={txn.toBePrinted}
            readOnly={readOnly}
            onChange={(v) => {
              refTouched.current = true;
              form.update({ refNumber: v });
            }}
          />
        </TxnHeaderField>
        <TxnHeaderField label="Date" required htmlFor="vx-bp-date" className="vx-a-date">
          <DateField id="vx-bp-date" name="date" value={txn.date} readOnly={readOnly} onChange={(d) => form.update({ date: d })} />
        </TxnHeaderField>
        <div className="vx-check-words">
          <span>{amountInWords(total)}</span>
        </div>
        <TxnHeaderField label="Address" htmlFor="vx-bp-addr" className="vx-a-addr">
          <AddressBlock id="vx-bp-addr" name="billAddress" rows={3} value={txn.billAddress} readOnly={readOnly} onChange={(v) => form.update({ billAddress: v })} />
        </TxnHeaderField>
        <div className="vx-a-amt vx-check-amtbox">
          <span className="sx-label">Amount</span>
          <span className="vx-check-dollar">${fmtMoney(total)}</span>
        </div>
        <TxnHeaderField label="Memo" htmlFor="vx-bp-memo" className="vx-a-memo" help="Printed on the check. Bill payments put your account number with the vendor here.">
          <TextField id="vx-bp-memo" name="memo" value={txn.memo} readOnly={readOnly} onChange={(v) => form.update({ memo: v })} />
        </TxnHeaderField>
      </div>
    </div>
  );

  return (
    <TxnFormFrame
      form={form}
      title={isCard ? 'Bill Payment (Credit Card)' : 'Bill Payment'}
      status={txn.voided ? 'Void' : null}
      header={header}
      stamp={txn.voided ? 'VOID' : null}
      readOnly={readOnly}
      onPrint={isCard ? undefined : print}
      hideSaveNew
      extraButtons={[{ key: 'pb', label: 'Pay bills', icon: Wallet, color: '#16a34a', onClick: () => openWindow('payBills') }]}
      lines={
        <div className="vx-grid-wrap" data-field="links">
          <div className="vx-subhead vx-bp-cap">Bills paid in this transaction</div>
          {fixedAmount !== null && !readOnly && (
            <div className={'vx-note' + (unapplied < 0 ? ' vx-warn' : '')}>
              {unapplied < 0
                ? `The amounts paid are ${fmtMoney(-unapplied)} more than this payment's ${fmtMoney(fixedAmount)}. Lower the amounts paid on the bills.`
                : unapplied === 0
                  ? `All of this payment's ${fmtMoney(fixedAmount)} is applied to bills.`
                  : `${fmtMoney(unapplied)} of this payment is not applied to a bill (a bill it paid was voided or deleted). Check bills of ${txn.nameFull || 'this vendor'} to apply it; the payment amount stays ${fmtMoney(fixedAmount)}.`}
            </div>
          )}
          <Grid<PaidRow>
            aria-label="Bills paid"
            columns={columns}
            rows={rows}
            onChange={setRows}
            newRow={() => ({ id: 0, doc: rows[0]?.doc, sel: false, amount: 0, discount: 0, credits: 0 }) as PaidRow}
            onRowChange={onRowChange}
            allowAdd={false}
            allowInsertDelete={false}
            readOnly={readOnly}
            minRows={4}
            persistKey="billpmt"
            rowClassName={(r) => (r.sel ? 'vx-row-sel' : 'vx-row-dim')}
            contextMenu={(r) => (r ? [{ label: 'Open bill', onClick: () => openTxn(r.doc.type, r.id) }] : [])}
          />
          {txn.nameId && !docs.isLoading && rows.length === 0 && <div className="vx-muted vx-bp-empty">This vendor has no open bills.</div>}
        </div>
      }
      bottomLeft={!isCard && <Checkbox label="Print later" checked={txn.toBePrinted} disabled={readOnly} onChange={(c) => form.update({ toBePrinted: c, refNumber: c ? '' : txn.refNumber })} />}
      totals={
        fixedAmount === null
          ? [{ key: 'amt', label: 'Payment amount', value: total, strong: true }]
          : [
              { key: 'applied', label: 'Applied to bills', value: applied },
              { key: 'unapplied', label: 'Unapplied amount', value: unapplied, tone: unapplied < 0 ? 'danger' : undefined },
              { key: 'amt', label: 'Payment amount', value: total, strong: true },
            ]
      }
    />
  );
}
