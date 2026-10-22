// Write Checks (CHK): bank account + ending balance, a check face (No., Date, Pay to the order
// of, amount, amount in words, address, memo), "Print later", and the Expenses / Items lines.
// Choosing a payee fills the address and recalls the payee's last check (or the vendor's
// pre-fill accounts). Typing the check amount fills the expense line.
import { useEffect, useRef } from 'react';
import { Eraser } from 'lucide-react';
import { api, type ApiError } from '@/api/client';
import { useAccountsById } from '@/api/hooks';
import { emptyLine, emptyTxn, type Name, type Txn } from '@/api/types';
import { AccountPicker, AddressBlock, Button, Checkbox, DateField, MoneyField, NamePicker, TextField, confirmBox, formatAddress, msgBox, promptBox, toast } from '@/components';
import { ExpenseItemTabs, TxnFormFrame, stripEmptyLines, useTxnForm, type TxnProblem } from '@/forms';
import { fmtMoney } from '@/util/format';
import { useWindow } from '@/windows/WindowContext';
import { confirmCheckNumbers, confirmPrinted, printCheckVouchers } from './checkPrint';
import { amountInWords, applyTotal, fetchAccounts, fetchPrefs, focusWhenReady, fromTemplate, linesTotal, nextCheckNumber, pickAccount, todayIso } from './shared';
import './banking.css';

export interface WriteCheckFormProps {
  id?: number;
  accountId?: number;
  payeeId?: number;
  /** Prefill of a new check (memorized transaction, copy). */
  template?: Txn;
}

/** Name and address printed on a check for a payee. */
export function checkAddress(n: Name): string {
  const text = formatAddress(n.printOnCheckAs || n.companyName || n.name, n.billAddress);
  // the address often repeats the name on its first line
  const lines = text.split('\n');
  return lines.filter((l, i) => i === 0 || l.trim().toLowerCase() !== lines[i - 1].trim().toLowerCase()).join('\n');
}

/** Problems of the lines of a check / credit card charge before saving. */
export function purchaseLineProblems(t: Txn, what: string): TxnProblem[] {
  const lines = t.lines.filter((l) => l.kind === 'expense' || l.kind === 'item');
  if (!lines.length) return [{ field: 'lines', message: `Enter the ${what} amount and choose an account on the Expenses tab (or an item on the Items tab).` }];
  const out: TxnProblem[] = [];
  lines.forEach((l, i) => {
    if (l.kind === 'expense' && !l.accountId && l.amount) out.push({ field: 'lines', message: `Line ${i + 1}: choose the account for ${fmtMoney(l.amount)}.` });
    if (l.kind === 'item' && !l.itemId && l.amount) out.push({ field: 'lines', message: `Line ${i + 1}: choose an item.` });
  });
  if (!out.length && linesTotal(t.lines) < 0) out.push({ field: 'lines', message: `The ${what} total cannot be negative.` });
  return out.slice(0, 1);
}

export default function WriteCheckForm(props: WriteCheckFormProps) {
  const win = useWindow();
  const accounts = useAccountsById();
  const savedRef = useRef<Txn | null>(null);
  const form = useTxnForm({
    type: 'CHK',
    afterSave: (saved) => {
      savedRef.current = saved;
    },
    id: props.id,
    makeNew: async () => {
      const today = todayIso();
      const [accts, p] = await Promise.all([fetchAccounts(), fetchPrefs()]);
      const t = fromTemplate(props.template, today) ?? emptyTxn('CHK', today);
      t.type = 'CHK';
      t.accountId = pickAccount(accts, t.accountId ?? props.accountId ?? p.defaultCheckAccountId, ['Bank']);
      if (!t.toBePrinted && !t.refNumber) t.refNumber = await nextCheckNumber(t.accountId);
      const payee = props.template ? (t.billAddress ? null : t.nameId) : props.payeeId;
      if (payee) {
        try {
          const n = await api.get<Name>(`/names/${payee}`);
          t.nameId = n.id;
          t.nameFull = n.fullName;
          t.billAddress = checkAddress(n);
        } catch {
          /* unknown payee: leave it blank */
        }
      }
      return t;
    },
    // a new check starts in the payee (or, with a payee already chosen, in the amount)
    onLoaded: (loaded, isNew) => {
      if (isNew) focusWhenReady(() => document.getElementById(loaded.nameId ? `${win.id}-amt` : `${win.id}-payee`));
    },
    prepare: (t) => stripEmptyLines(t),
    validate: (t) => purchaseLineProblems(t, 'check'),
  });
  const t = form.txn;
  const account = t.accountId ? accounts.get(t.accountId) : undefined;
  const total = linesTotal(t.lines);

  // a new check keeps the plain form title; an existing one is named after the record
  const recordTitle = t.id ? `Check${t.toBePrinted ? ' (to print)' : t.refNumber ? ' ' + t.refNumber : ''}${t.nameFull ? ' - ' + t.nameFull : ''}` : '';
  useEffect(() => {
    win.setTitle(recordTitle || (account ? `Write Checks - ${account.fullName}` : 'Write Checks'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.fullName, recordTitle]);

  const changeAccount = async (id: number | null) => {
    if (id === t.accountId) return;
    const patch: Partial<Txn> = { accountId: id };
    if (form.isNew && !t.toBePrinted) patch.refNumber = await nextCheckNumber(id);
    form.update(patch);
  };

  const changePayee = (id: number | null, n: Name | null) => {
    form.update({ nameId: id, nameFull: n?.fullName ?? '', billAddress: n ? checkAddress(n) : '' });
  };

  const togglePrintLater = async (on: boolean) => {
    if (on) form.update({ toBePrinted: true, refNumber: '' });
    else form.update({ toBePrinted: false, refNumber: form.original && !form.original.toBePrinted ? form.original.refNumber : await nextCheckNumber(t.accountId) });
  };

  const clearSplits = async () => {
    const real = t.lines.filter((l) => l.amount || l.accountId || l.itemId);
    if (real.length && !(await confirmBox('Remove every line from the Expenses and Items tabs?', 'Clear Splits'))) return;
    form.setLines([]);
  };

  const print = async () => {
    try {
      await printCheck();
    } catch (e) {
      // "cancelled": the user answered No to a server question (e.g. the check number is already used)
      if ((e as ApiError).code !== 'cancelled') await msgBox({ title: 'Print Check', message: (e as Error).message, icon: 'error' });
    }
  };

  const printCheck = async () => {
    let id = form.txn.id;
    if (form.dirty || form.isNew) {
      savedRef.current = null;
      if (!(await form.save('stay'))) return;
      id = (savedRef.current as Txn | null)?.id ?? 0;
    }
    if (!id) return;
    const saved = await api.get<Txn>(`/txns/${id}`);
    let first = saved.refNumber;
    if (saved.toBePrinted) {
      let proposed = await nextCheckNumber(saved.accountId);
      // ask for the number, and ask again while the number is already used and the user wants to change it
      for (;;) {
        const v = await promptBox('Check number to print on this check:', { defaultValue: proposed, title: 'Print Check' });
        if (v === null) return;
        const ok = saved.accountId ? await confirmCheckNumbers(saved.accountId, accounts.get(saved.accountId)?.fullName ?? 'this account', v, 1) : v.trim();
        if (ok !== null) {
          first = ok;
          break;
        }
        proposed = v.trim();
      }
    }
    await printCheckVouchers([saved], first);
    if (saved.toBePrinted && (await confirmPrinted([saved.id], first))) {
      toast(`Check ${first} marked as printed`, { kind: 'success' });
      await form.load(saved.id);
    }
  };

  const status = t.voided ? null : t.cleared === 'R' ? 'Reconciled' : t.cleared === '*' ? 'Cleared' : t.toBePrinted ? 'To print' : null;

  return (
    <TxnFormFrame
      form={form}
      title="Check"
      status={status}
      onPrint={() => void print()}
      titleRight={
        <div className="bk-acctbar">
          <div className="bk-acctbar-field">
            <label className="sx-label" htmlFor={`${win.id}-acct`}>
              BANK ACCOUNT
            </label>
            <AccountPicker id={`${win.id}-acct`} name="accountId" types={['Bank']} value={t.accountId} onChange={(id) => void changeAccount(id)} width={250} />
          </div>
          <div className="bk-acctbar-bal">
            <span className="sx-label">ENDING BALANCE</span>
            <span className={'bk-bal' + ((account?.balance ?? 0) < 0 ? ' bk-neg' : '')}>{account ? fmtMoney(account.balance) : ''}</span>
          </div>
        </div>
      }
      header={
        <div className="bk-checkface">
          <div className="bk-cf-top">
            <div className="bk-cf-num">
              <label className="bk-cf-label" htmlFor={`${win.id}-no`}>
                NO.
              </label>
              <div>
                <TextField id={`${win.id}-no`} name="refNumber" value={t.toBePrinted ? 'To Print' : t.refNumber} readOnly={t.toBePrinted} onChange={(v) => form.update({ refNumber: v })} width={96} />
              </div>
            </div>
            <div className="bk-cf-date">
              <label className="bk-cf-label" htmlFor={`${win.id}-date`}>
                DATE
              </label>
              <div>
                <DateField id={`${win.id}-date`} name="date" required value={t.date} onChange={(d) => form.update({ date: d })} width={130} />
              </div>
            </div>
          </div>
          <div className="bk-cf-pay">
            <label className="bk-cf-label bk-cf-label-2" htmlFor={`${win.id}-payee`}>
              PAY TO THE
              <br />
              ORDER OF
            </label>
            <div className="bk-cf-payee">
              <NamePicker id={`${win.id}-payee`} name="nameId" value={t.nameId} fallbackLabel={t.nameFull} onChange={changePayee} placeholder="Choose a payee" defaultKind="vendor" />
            </div>
            <span className="bk-cf-dollar">$</span>
            <div className="bk-cf-amount">
              <MoneyField
                id={`${win.id}-amt`}
                name="amount"
                aria-label="Check amount"
                value={total}
                onChange={(v) => form.setLines(applyTotal(t.lines, v ?? 0, () => emptyLine('expense')))}
                width={150}
              />
            </div>
          </div>
          <div className="bk-cf-words">
            <span className="bk-cf-words-text">{amountInWords(total)}</span>
            <span className="bk-cf-stars" aria-hidden="true" />
            <span className="bk-cf-label">DOLLARS</span>
          </div>
          <div className="bk-cf-bottom">
            <div className="bk-cf-addr">
              <label className="bk-cf-label" htmlFor={`${win.id}-addr`}>
                ADDRESS
              </label>
              <AddressBlock id={`${win.id}-addr`} name="billAddress" rows={4} value={t.billAddress} onChange={(v) => form.update({ billAddress: v })} />
            </div>
            <div className="bk-cf-memo">
              <label className="bk-cf-label" htmlFor={`${win.id}-memo`}>
                MEMO
              </label>
              <div>
                <TextField id={`${win.id}-memo`} name="memo" value={t.memo} onChange={(v) => form.update({ memo: v })} />
              </div>
            </div>
          </div>
        </div>
      }
      lines={
        <ExpenseItemTabs
          lines={t.lines}
          onChange={form.setLines}
          txnType="CHK"
          payeeId={t.nameId}
          isNew={form.isNew}
          linked={t.linked}
          readOnly={t.voided}
          onRecall={(r) => {
            if (!form.txn.memo && r.memo) form.update({ memo: r.memo.replace(/^VOID: /, '') });
          }}
        />
      }
      bottomLeft={
        <>
          <Checkbox label="Print later" checked={t.toBePrinted} disabled={t.voided} onChange={(v) => void togglePrintLater(v)} title="Keep this check in the list of checks to print (File > Print Forms > Checks)" />
          <Button variant="ghost" icon={Eraser} label="Clear splits" disabled={t.voided} onClick={() => void clearSplits()} />
        </>
      }
      totals={[{ key: 'total', label: 'Check amount', value: total, strong: true }]}
      readOnly={t.voided}
    />
  );
}
