// Enter Credit Card Charges (CCCHARGE / CCCREDIT): credit card account + ending balance,
// purchased from, Charge / Credit, date, ref no., amount, memo, and the Expenses / Items lines.
import { useEffect } from 'react';
import { Eraser } from 'lucide-react';
import { useAccountsById } from '@/api/hooks';
import { emptyLine, emptyTxn, type Txn } from '@/api/types';
import { AccountPicker, Button, DateField, MoneyField, NamePicker, SegmentedControl, TextField, confirmBox } from '@/components';
import { ExpenseItemTabs, HeaderRow, TxnFormFrame, TxnHeaderField, stripEmptyLines, useTxnForm } from '@/forms';
import { fmtDate, fmtMoney } from '@/util/format';
import { useWindow } from '@/windows/WindowContext';
import { purchaseLineProblems } from './WriteCheckForm';
import { applyTotal, fetchAccounts, focusWhenReady, fromTemplate, linesTotal, pickAccount, todayIso } from './shared';
import './banking.css';

export interface CreditCardChargeFormProps {
  id?: number;
  accountId?: number;
  /** New form starts as a credit (refund from the merchant). */
  credit?: boolean;
  template?: Txn;
}

export default function CreditCardChargeForm(props: CreditCardChargeFormProps) {
  const win = useWindow();
  const accounts = useAccountsById();
  const form = useTxnForm({
    type: props.credit ? 'CCCREDIT' : 'CCCHARGE',
    navType: props.credit ? 'CCCREDIT' : 'CCCHARGE',
    id: props.id,
    makeNew: async () => {
      const today = todayIso();
      const accts = await fetchAccounts();
      const tpl = fromTemplate(props.template, today);
      const t = tpl ?? emptyTxn(props.credit ? 'CCCREDIT' : 'CCCHARGE', today);
      if (t.type !== 'CCCHARGE' && t.type !== 'CCCREDIT') t.type = props.credit ? 'CCCREDIT' : 'CCCHARGE';
      t.accountId = pickAccount(accts, t.accountId ?? props.accountId, ['Credit Card']);
      return t;
    },
    // a new charge starts in Purchased From (or, with a payee already chosen, in the amount)
    onLoaded: (loaded, isNew) => {
      if (isNew) focusWhenReady(() => document.getElementById(loaded.nameId ? `${win.id}-amt` : `${win.id}-payee`));
    },
    prepare: (t) => stripEmptyLines(t),
    validate: (t) => purchaseLineProblems(t, t.type === 'CCCREDIT' ? 'credit' : 'charge'),
  });
  const t = form.txn;
  const isCredit = t.type === 'CCCREDIT';
  const account = t.accountId ? accounts.get(t.accountId) : undefined;
  const total = linesTotal(t.lines);

  // a new charge keeps the plain form title; an existing one is named after the record
  const recordTitle = t.id ? `${isCredit ? 'Credit Card Credit' : 'Credit Card Charge'} - ${t.nameFull || fmtDate(t.date)}` : '';
  useEffect(() => {
    win.setTitle(recordTitle || (account ? `Enter Credit Card Charges - ${account.fullName}` : 'Enter Credit Card Charges'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.fullName, recordTitle]);

  const clearSplits = async () => {
    const real = t.lines.filter((l) => l.amount || l.accountId || l.itemId);
    if (real.length && !(await confirmBox('Remove every line from the Expenses and Items tabs?', 'Clear Splits'))) return;
    form.setLines([]);
  };

  const status = t.voided ? null : t.cleared === 'R' ? 'Reconciled' : t.cleared === '*' ? 'Cleared' : null;

  return (
    <TxnFormFrame
      form={form}
      title={isCredit ? 'Credit Card Credit' : 'Credit Card Charge'}
      status={status}
      titleRight={
        <div className="bk-acctbar">
          <div className="bk-acctbar-field">
            <label className="sx-label" htmlFor={`${win.id}-acct`}>
              CREDIT CARD
            </label>
            <AccountPicker id={`${win.id}-acct`} name="accountId" types={['Credit Card']} value={t.accountId} onChange={(id) => form.update({ accountId: id })} width={250} />
          </div>
          <div className="bk-acctbar-bal">
            <span className="sx-label">ENDING BALANCE</span>
            <span className="bk-bal">{account ? fmtMoney(account.balance) : ''}</span>
          </div>
        </div>
      }
      header={
        <div className="bk-checkface bk-cc">
          <HeaderRow>
            <TxnHeaderField label="PURCHASED FROM" width={300} htmlFor={`${win.id}-payee`}>
              <NamePicker
                id={`${win.id}-payee`}
                name="nameId"
                value={t.nameId}
                fallbackLabel={t.nameFull}
                onChange={(id, n) => form.update({ nameId: id, nameFull: n?.fullName ?? '' })}
                placeholder="Store or vendor"
                defaultKind="vendor"
              />
            </TxnHeaderField>
            <TxnHeaderField label="DATE" width={140} htmlFor={`${win.id}-date`}>
              <DateField id={`${win.id}-date`} name="date" required value={t.date} onChange={(d) => form.update({ date: d })} />
            </TxnHeaderField>
            <TxnHeaderField label="REF NO." width={110} htmlFor={`${win.id}-ref`}>
              <TextField id={`${win.id}-ref`} name="refNumber" value={t.refNumber} onChange={(v) => form.update({ refNumber: v })} />
            </TxnHeaderField>
            <TxnHeaderField label="AMOUNT" width={140} htmlFor={`${win.id}-amt`} align="right">
              <MoneyField id={`${win.id}-amt`} name="amount" value={total} onChange={(v) => form.setLines(applyTotal(t.lines, v ?? 0, () => emptyLine('expense')))} />
            </TxnHeaderField>
          </HeaderRow>
          <HeaderRow>
            <TxnHeaderField label="TYPE" help="A charge is a purchase on the card. A credit is a refund from the merchant that lowers what you owe.">
              <SegmentedControl<'CCCHARGE' | 'CCCREDIT'>
                name="type"
                aria-label="Charge or credit"
                value={isCredit ? 'CCCREDIT' : 'CCCHARGE'}
                disabled={!form.isNew}
                options={[
                  { value: 'CCCHARGE', label: 'Charge', title: 'A purchase made with the card' },
                  { value: 'CCCREDIT', label: 'Credit', title: 'A refund or credit from the merchant' },
                ]}
                onChange={(v) => form.update({ type: v })}
              />
            </TxnHeaderField>
            <TxnHeaderField label="MEMO" width={500} htmlFor={`${win.id}-memo`} help="Memo">
              <TextField id={`${win.id}-memo`} name="memo" value={t.memo} onChange={(v) => form.update({ memo: v })} />
            </TxnHeaderField>
          </HeaderRow>
        </div>
      }
      lines={
        <ExpenseItemTabs
          lines={t.lines}
          onChange={form.setLines}
          txnType={t.type}
          payeeId={t.nameId}
          isNew={form.isNew}
          linked={t.linked}
          readOnly={t.voided}
          onRecall={(r) => {
            if (!form.txn.memo && r.memo) form.update({ memo: r.memo.replace(/^VOID: /, '') });
          }}
        />
      }
      bottomLeft={<Button variant="ghost" icon={Eraser} label="Clear splits" disabled={t.voided} onClick={() => void clearSplits()} />}
      totals={[{ key: 'total', label: isCredit ? 'Credit amount' : 'Charge amount', value: total, strong: true }]}
      readOnly={t.voided}
    />
  );
}
