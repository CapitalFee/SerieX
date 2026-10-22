// Sales Tax Payment (TAXPMT): check-like form — bank account, pay to (tax agency), no., date, amount
// in words, address, memo, print later — with the sales tax items paid as lines.
import { useEffect, useMemo, useRef } from 'react';
import { Percent } from 'lucide-react';
import { useAccounts, useCompanyInfo, useItemsById, useNextRef, usePrefValues } from '@/api/hooks';
import { emptyLine, emptyTxn, type ID, type Name, type Txn, type TxnLine } from '@/api/types';
import { AccountPicker, AddressBlock, Checkbox, DateField, Grid, ItemLabel, ItemPicker, NamePicker, TextField, useNewRow, type GridColumn, type GridEditorProps } from '@/components';
import { TxnFormFrame, TxnHeaderField, copyAsNew, stripEmptyLines, useTxnForm, type TxnProblem } from '@/forms';
import { useWindow } from '@/windows/WindowContext';
import { openWindow } from '@/windows/windowStore';
import { todayIso } from '@/util/dates';
import { escHtml, printHtml } from '@/util/print';
import { fmtDate, fmtMoney, round2 } from '@/util/format';
import { amountInWords, sum2, vendorAddressText } from './shared';
import './vendors.css';

export interface SalesTaxPaymentFormProps {
  id?: number;
  template?: Txn;
}

export default function SalesTaxPaymentForm(props: SalesTaxPaymentFormProps) {
  const win = useWindow();
  const company = useCompanyInfo();
  const itemsById = useItemsById();
  const prefsNow = usePrefValues();
  const prefsRef = useRef(prefsNow);
  prefsRef.current = prefsNow;
  const refTouched = useRef(false);
  const { data: banks } = useAccounts({ types: ['Bank'], active: 'all' });

  const form = useTxnForm({
    type: 'TAXPMT',
    id: props.id,
    makeNew: () => {
      refTouched.current = false;
      const t = props.template ? { ...copyAsNew(props.template), date: props.template.date || todayIso() } : emptyTxn('TAXPMT', todayIso());
      t.type = 'TAXPMT';
      if (!t.accountId) t.accountId = prefsRef.current.defaultCheckAccountId ?? null;
      // a copy does not pay the copied payment's tax period (Pay Sales Tax records it)
      if (t.extra && 'salesTaxThrough' in t.extra) {
        const { salesTaxThrough: _through, ...rest } = t.extra;
        t.extra = rest;
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
      if (!t.lines.length) p.push({ field: 'lines', message: 'Add the sales tax items you are paying.' });
      t.lines.forEach((l, i) => {
        // lines without an item are sales tax adjustments paid to an account (Pay Sales Tax)
        if (!l.itemId && !l.accountId) p.push({ field: 'lines', message: `Line ${i + 1} needs a sales tax item.` });
      });
      if (sum2(t.lines.map((l) => l.amount)) < 0) p.push({ field: 'lines', message: 'The payment cannot be less than zero.' });
      return p;
    },
  });
  const { txn } = form;
  const saved = !!txn.id;
  const readOnly = txn.voided;
  const acct = banks?.find((a) => a.id === txn.accountId) ?? null;
  const total = sum2(txn.lines.map((l) => l.amount || 0));
  const nextRef = useNextRef('CHK', txn.accountId, { enabled: !saved && !!txn.accountId });

  useEffect(() => {
    win.setTitle(saved ? `Sales Tax Payment ${txn.refNumber}`.trim() : 'Sales Tax Payment');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved, txn.refNumber]);

  useEffect(() => {
    if (saved || refTouched.current || txn.toBePrinted || !nextRef.data || txn.refNumber === nextRef.data.refNumber) return;
    if (form.dirty) form.update({ refNumber: nextRef.data.refNumber });
    else form.reset({ ...form.txn, refNumber: nextRef.data.refNumber });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextRef.data, saved, txn.toBePrinted]);

  const newRow = useNewRow(() => emptyLine('item'));
  const columns = useMemo<GridColumn<TxnLine>[]>(
    () => [
      {
        key: 'itemId',
        label: 'SALES TAX ITEM',
        width: 200,
        editor: (p: GridEditorProps<TxnLine>) => (
          <ItemPicker
            inGrid
            autoFocus
            types={['Sales Tax Item']}
            aria-label="Sales tax item"
            value={p.value as ID | null}
            onChange={(id, it) => p.onRowChange({ itemId: id, description: it ? it.description || it.name : p.row.description })}
          />
        ),
        render: (r) =>
          r.itemId || !r.accountId ? (
            <ItemLabel id={r.itemId} />
          ) : (
            <span className="vx-taxadj" title="Sales tax adjustment paid to Sales Tax Payable">
              Adjustment
            </span>
          ),
      },
      { key: 'description', label: 'DESCRIPTION', width: 240, grow: true, editor: 'text' },
      { key: 'amount', label: 'AMOUNT', width: 120, align: 'right', editor: 'money' },
    ],
    [],
  );

  const onAgency = (id: ID | null, n: Name | null) => form.update({ nameId: id, nameFull: n?.fullName ?? '', billAddress: n ? vendorAddressText(n) : '' });

  const print = () => {
    const lines = txn.lines
      .filter((l) => l.itemId || l.amount)
      .map((l) => `<tr><td>${escHtml(l.itemId ? itemsById.get(l.itemId)?.fullName ?? '' : l.accountId ? 'Adjustment' : '')}</td><td>${escHtml(l.description)}</td><td class="num">${fmtMoney(l.amount)}</td></tr>`)
      .join('');
    const addr = escHtml(txn.billAddress).replace(/\n/g, '<br>');
    void printHtml(
      `Sales Tax Payment ${txn.refNumber}`,
      `<div class="chk"><div class="row"><b>${escHtml(company.data?.name ?? '')}</b><span>No. ${escHtml(txn.refNumber)}</span></div><div class="row"><span></span><span>${fmtDate(txn.date)}</span></div>
       <div class="row"><span>PAY TO THE ORDER OF <b>${escHtml(txn.nameFull)}</b></span><span class="amt">$**${fmtMoney(total)}</span></div><div class="words">${escHtml(amountInWords(total))}*****</div>
       <div class="addr">${addr}</div><div>MEMO ${escHtml(txn.memo)}</div></div>
       <div class="stub"><b>${escHtml(txn.nameFull)}</b> ${fmtDate(txn.date)}<table><thead><tr><th>Tax item</th><th>Description</th><th class="num">Amount</th></tr></thead><tbody>${lines}</tbody></table></div>`,
      `.chk{height:3.3in;border-bottom:1px dashed #999;padding:8px}.row{display:flex;justify-content:space-between;margin:6px 0}.amt{border:1px solid #000;padding:2px 8px}
       .words{border-bottom:1px solid #000;margin:8px 0}.addr{margin:12px 0 12px 40px}.stub{padding:8px}`,
    );
  };

  const header = (
    <div className="vx-chkform">
      <div className="vx-acctbar">
        <TxnHeaderField label="Bank account" required htmlFor="vx-tp-acct" width={260}>
          <AccountPicker id="vx-tp-acct" name="accountId" types={['Bank']} value={txn.accountId} readOnly={readOnly} addNew={false} onChange={(id) => form.update({ accountId: id })} />
        </TxnHeaderField>
        <div className="vx-endbal">
          <span className="sx-label">Ending balance</span>
          <strong>{acct ? fmtMoney(acct.balance) : '—'}</strong>
        </div>
      </div>
      <div className="vx-check">
        <TxnHeaderField label="Pay to the order of" required htmlFor="vx-tp-agency" help="The tax agency (a vendor) you pay the sales tax to." className="vx-a-payee">
          <NamePicker id="vx-tp-agency" name="nameId" kinds={['vendor']} value={txn.nameId} fallbackLabel={txn.nameFull} readOnly={readOnly} autoFocus={!saved} onChange={onAgency} />
        </TxnHeaderField>
        <TxnHeaderField label="No." htmlFor="vx-tp-no" className="vx-a-no">
          <TextField
            id="vx-tp-no"
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
        <TxnHeaderField label="Date" required htmlFor="vx-tp-date" className="vx-a-date">
          <DateField id="vx-tp-date" name="date" value={txn.date} readOnly={readOnly} onChange={(d) => form.update({ date: d })} />
        </TxnHeaderField>
        <div className="vx-check-words">
          <span>{amountInWords(total)}</span>
        </div>
        <TxnHeaderField label="Address" htmlFor="vx-tp-addr" className="vx-a-addr">
          <AddressBlock id="vx-tp-addr" name="billAddress" rows={3} value={txn.billAddress} readOnly={readOnly} onChange={(v) => form.update({ billAddress: v })} />
        </TxnHeaderField>
        <div className="vx-a-amt vx-check-amtbox">
          <span className="sx-label">Amount</span>
          <span className="vx-check-dollar">${fmtMoney(total)}</span>
        </div>
        <TxnHeaderField label="Memo" htmlFor="vx-tp-memo" className="vx-a-memo" help="Memo">
          <TextField id="vx-tp-memo" name="memo" value={txn.memo} readOnly={readOnly} onChange={(v) => form.update({ memo: v })} />
        </TxnHeaderField>
      </div>
    </div>
  );

  return (
    <TxnFormFrame
      form={form}
      title="Sales Tax Payment"
      status={txn.voided ? 'Void' : null}
      header={header}
      stamp={txn.voided ? 'VOID' : null}
      readOnly={readOnly}
      onPrint={print}
      extraButtons={[{ key: 'pay', label: 'Pay sales tax', icon: Percent, color: '#7c3aed', onClick: () => openWindow('paySalesTax') }]}
      lines={
        <Grid<TxnLine>
          aria-label="Sales tax items paid"
          columns={columns}
          rows={txn.lines}
          onChange={form.setLines}
          newRow={newRow}
          readOnly={readOnly}
          minRows={4}
          persistKey="taxpmt-lines"
        />
      }
      bottomLeft={<Checkbox label="Print later" checked={txn.toBePrinted} disabled={readOnly} onChange={(c) => form.update({ toBePrinted: c, refNumber: c ? '' : txn.refNumber })} />}
      totals={[{ key: 'amt', label: 'Payment amount', value: total, strong: true }]}
    />
  );
}
