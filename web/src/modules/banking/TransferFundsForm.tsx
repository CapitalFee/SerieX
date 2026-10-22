// Transfer Money (TRANSFER): date, transfer from (account + balance), transfer
// to (account + balance), amount and memo, with a plain-English summary of what will happen.
import { useEffect } from 'react';
import { ArrowRight } from 'lucide-react';
import { useAccountsById } from '@/api/hooks';
import { emptyTxn, type Account, type Txn } from '@/api/types';
import { AccountPicker, DateField, MoneyField, TextField } from '@/components';
import { HeaderRow, TxnFormFrame, TxnHeaderField, useTxnForm } from '@/forms';
import { fmtDate, fmtMoney } from '@/util/format';
import { useWindow } from '@/windows/WindowContext';
import { TRANSFER_TYPES, fetchAccounts, fetchPrefs, focusWhenReady, fromTemplate, isDebitNormal, pickAccount, todayIso } from './shared';
import './banking.css';

export interface TransferFundsFormProps {
  id?: number;
  /** Account to transfer from (new transfer). */
  accountId?: number;
  template?: Txn;
}

/** What a transfer does to an account, in plain words. */
function effect(a: Account, isFrom: boolean): string {
  const up = isDebitNormal(a.type) ? !isFrom : isFrom;
  const owed = a.type === 'Credit Card' || a.type.includes('Liability');
  return `${a.fullName} goes ${up ? 'up' : 'down'}${owed ? (up ? ' (you owe more)' : ' (you owe less)') : ''}`;
}

function Balance({ account, label }: { account: Account | undefined; label: string }) {
  return (
    <div className="bk-xfer-bal">
      <span className="bk-muted">{label}</span>
      <span className={'bk-xfer-bal-amt' + ((account?.balance ?? 0) < 0 ? ' bk-neg' : '')}>{account ? fmtMoney(account.balance) : '—'}</span>
    </div>
  );
}

export default function TransferFundsForm(props: TransferFundsFormProps) {
  const win = useWindow();
  const accounts = useAccountsById();
  const form = useTxnForm({
    type: 'TRANSFER',
    id: props.id,
    makeNew: async () => {
      const today = todayIso();
      const [accts, p] = await Promise.all([fetchAccounts(), fetchPrefs()]);
      const t = fromTemplate(props.template, today) ?? { ...emptyTxn('TRANSFER', today), memo: 'Funds Transfer' };
      t.type = 'TRANSFER';
      t.accountId = pickAccount(accts, t.accountId ?? props.accountId ?? p.defaultCheckAccountId, TRANSFER_TYPES);
      // the destination stays blank on purpose: moving money to the wrong account is easy to miss
      return t;
    },
    // a new transfer starts in Transfer Funds From (its default account is selected, so typing replaces it)
    onLoaded: (_loaded, isNew) => {
      if (isNew) focusWhenReady(() => document.getElementById(`${win.id}-from`));
    },
    prepare: (t) => ({ ...t, lines: [] }),
    validate: (t) => {
      if (t.accountId && t.accountId === t.toAccountId) return { field: 'toAccountId', message: 'Choose a different account to transfer to.' };
      if (!(t.amount > 0)) return { field: 'amount', message: 'Enter the amount to transfer.' };
      return null;
    },
  });
  const t = form.txn;
  const from = t.accountId ? accounts.get(t.accountId) : undefined;
  const to = t.toAccountId ? accounts.get(t.toAccountId) : undefined;

  // a new transfer keeps the plain form title; an existing one is named after the record
  const recordTitle = t.id ? `Transfer ${fmtDate(t.date)}` : '';
  useEffect(() => {
    win.setTitle(recordTitle || 'Transfer Money');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordTitle]);

  const summary =
    from && to && t.amount > 0
      ? `$${fmtMoney(t.amount)} will move from ${from.fullName} to ${to.fullName}: ${effect(from, true)} and ${effect(to, false)}.`
      : 'Choose the two accounts and the amount to move between them.';

  return (
    <TxnFormFrame
      form={form}
      title="Transfer"
      status={t.cleared === 'R' ? 'Reconciled' : t.cleared === '*' ? 'Cleared' : null}
      header={
        <>
          <HeaderRow>
            <TxnHeaderField label="DATE" width={150} htmlFor={`${win.id}-date`}>
              <DateField id={`${win.id}-date`} name="date" required value={t.date} onChange={(d) => form.update({ date: d })} />
            </TxnHeaderField>
          </HeaderRow>
          <div className="bk-xfer">
            <div className="bk-xfer-side">
              <TxnHeaderField label="TRANSFER FUNDS FROM" htmlFor={`${win.id}-from`}>
                <AccountPicker
                  id={`${win.id}-from`}
                  name="accountId"
                  types={TRANSFER_TYPES}
                  excludeIds={t.toAccountId ? [t.toAccountId] : undefined}
                  value={t.accountId}
                  onChange={(id) => form.update({ accountId: id })}
                  readOnly={t.voided}
                />
              </TxnHeaderField>
              <Balance account={from} label="Account balance" />
            </div>
            <div className="bk-xfer-arrow" aria-hidden="true">
              <ArrowRight size={22} />
            </div>
            <div className="bk-xfer-side">
              <TxnHeaderField label="TRANSFER FUNDS TO" htmlFor={`${win.id}-to`}>
                <AccountPicker
                  id={`${win.id}-to`}
                  name="toAccountId"
                  types={TRANSFER_TYPES}
                  excludeIds={t.accountId ? [t.accountId] : undefined}
                  value={t.toAccountId}
                  onChange={(id) => form.update({ toAccountId: id })}
                  readOnly={t.voided}
                />
              </TxnHeaderField>
              <Balance account={to} label="Account balance" />
            </div>
          </div>
          <HeaderRow>
            <TxnHeaderField label="TRANSFER AMOUNT $" width={170} htmlFor={`${win.id}-amt`} align="right">
              <MoneyField id={`${win.id}-amt`} name="amount" value={t.amount} onChange={(v) => form.update({ amount: v ?? 0 })} readOnly={t.voided} />
            </TxnHeaderField>
            <TxnHeaderField label="MEMO" width={380} htmlFor={`${win.id}-memo`} help="Memo">
              <TextField id={`${win.id}-memo`} name="memo" value={t.memo} onChange={(v) => form.update({ memo: v })} readOnly={t.voided} />
            </TxnHeaderField>
          </HeaderRow>
          <p className="bk-xfer-summary">{summary}</p>
        </>
      }
      totals={[{ key: 'amt', label: 'Transfer amount', value: t.amount, strong: true }]}
      readOnly={t.voided}
    />
  );
}
