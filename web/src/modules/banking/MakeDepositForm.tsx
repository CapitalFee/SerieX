// Make Deposits (DEP): Deposit To, Date, Memo; payments waiting in Undeposited Funds are added
// with the Payments to Deposit dialog (opened automatically for a new deposit when some wait);
// other amounts go on the grid (RECEIVED FROM, FROM ACCOUNT, MEMO, CHK NO., PMT METH., CLASS,
// AMOUNT); cash back (account, memo, amount) and the deposit total.
import { useEffect, useMemo, useRef } from 'react';
import { HandCoins } from 'lucide-react';
import { api, qs } from '@/api/client';
import { useAccountsById, useCompanyInfo, useNames, usePrefValues, useUndeposited } from '@/api/hooks';
import { emptyLine, emptyTxn, type ID, type Txn, type TxnLine, type UndepositedItem } from '@/api/types';
import {
  AccountLabel,
  AccountPicker,
  ClassPicker,
  DateField,
  Grid,
  ListEntryLabel,
  MoneyField,
  NameLabel,
  NamePicker,
  PaymentMethodPicker,
  TextField,
  type GridColumn,
  type GridEditorProps,
} from '@/components';
import { HeaderRow, TotalsBlock, TxnFormFrame, TxnHeaderField, stripEmptyLines, useTxnForm, type TxnProblem } from '@/forms';
import { escHtml, printHtml } from '@/util/print';
import { fmtDate, fmtMoney, round2 } from '@/util/format';
import { useWindow } from '@/windows/WindowContext';
import { choosePaymentsToDeposit, depositCheckNumber, depositKey, depositLineKey, depositTypeLabel } from './DepositPayments';
import { LINE_EXCLUDED_TYPES, fetchAccounts, fetchPrefs, findUndeposited, fromTemplate, pickAccount, todayIso } from './shared';
import './banking.css';

export interface MakeDepositFormProps {
  id?: number;
  accountId?: number;
  template?: Txn;
}

const isUF = (a: { special: string }) => a.special === 'UndepositedFunds';

export default function MakeDepositForm(props: MakeDepositFormProps) {
  const win = useWindow();
  const prefs = usePrefValues();
  const accounts = useAccountsById();
  const { data: company } = useCompanyInfo();
  const { data: names } = useNames(undefined, { active: 'all' });
  const autoOpened = useRef(false);
  const form = useTxnForm({
    type: 'DEP',
    id: props.id,
    makeNew: async () => {
      const today = todayIso();
      const [accts, p] = await Promise.all([fetchAccounts(), fetchPrefs()]);
      const t = fromTemplate(props.template, today) ?? { ...emptyTxn('DEP', today), memo: 'Deposit' };
      t.type = 'DEP';
      // payments cannot be deposited twice: a template never carries payment lines
      t.lines = t.lines.filter((l) => !l.linkedTxnId);
      t.accountId = pickAccount(accts, t.accountId ?? props.accountId ?? p.defaultDepositAccountId, ['Bank', 'Other Current Asset'], isUF);
      return t;
    },
    onLoaded: (_t, isNew) => {
      autoOpened.current = false;
      if (isNew && !props.template) void openPayments(true);
    },
    prepare: (t) => stripEmptyLines(t),
    validate: (t) => {
      const out: TxnProblem[] = [];
      if (!t.lines.length) out.push({ field: 'lines', message: 'Add the payments to deposit (Payments button) or enter the amounts to deposit on the lines.' });
      t.lines.forEach((l, i) => {
        if (!l.accountId && l.amount) out.push({ field: 'lines', message: `Line ${i + 1}: choose the account the ${fmtMoney(l.amount)} comes from.` });
      });
      if (t.cashBackAmount && !t.cashBackAccountId) out.push({ field: 'cashBackAccountId', message: 'Choose the account the cash back goes to.' });
      if (t.cashBackAmount < 0) out.push({ field: 'cashBackAmount', message: 'The cash back amount cannot be negative.' });
      const sub = round2(t.lines.reduce((s, l) => s + (l.amount || 0), 0));
      if (!out.length && sub - (t.cashBackAmount || 0) < 0) out.push({ field: 'cashBackAmount', message: 'The deposit total cannot be negative. Reduce the cash back amount.' });
      return out;
    },
  });
  const t = form.txn;
  const txnRef = useRef(t);
  txnRef.current = t;
  const account = t.accountId ? accounts.get(t.accountId) : undefined;
  const uf = useMemo(() => findUndeposited(Array.from(accounts.values())), [accounts]);
  const { data: waiting } = useUndeposited({ excludeDepositId: t.id || null });
  const onThis = new Set(t.lines.filter((l) => l.linkedTxnId).map(depositLineKey));
  const waitingCount = (waiting ?? []).filter((w) => !onThis.has(depositKey(w))).length;

  // a new deposit keeps the plain form title; an existing one is named after the record
  const recordTitle = t.id ? `Deposit ${fmtDate(t.date)}${account ? ' - ' + account.fullName : ''}` : '';
  useEffect(() => {
    win.setTitle(recordTitle || (account ? `Make Deposits - ${account.fullName}` : 'Make Deposits'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.fullName, recordTitle]);

  const subtotal = round2(t.lines.reduce((s, l) => s + (l.amount || 0), 0));
  const total = round2(subtotal - (t.cashBackAmount || 0));

  async function openPayments(auto = false) {
    // auto: called for a brand-new deposit right after it was created (before it is rendered)
    const cur = auto ? null : txnRef.current;
    let items: UndepositedItem[];
    try {
      items = await api.get<UndepositedItem[]>('/undeposited' + qs({ excludeDepositId: cur?.id || undefined }));
    } catch {
      return;
    }
    if (auto) {
      if (autoOpened.current || !items.length) return;
      autoOpened.current = true;
    }
    // rows are keyed by payment, or by payment line of an invoice / sales receipt (depositKey)
    const initial = (cur?.lines ?? []).filter((l) => l.linkedTxnId).map(depositLineKey);
    const keys = await choosePaymentsToDeposit(items, initial);
    if (!keys) return;
    const ufId: ID | null = uf?.id ?? (await fetchAccounts().then((a) => findUndeposited(a)?.id ?? null)) ?? null;
    // the form as it is now (the dialog was modal, but the deposit may have been replaced meanwhile)
    const now = txnRef.current;
    const chosen = new Set(keys);
    const keep = now.lines.filter((l) => l.linkedTxnId && chosen.has(depositLineKey(l)));
    const added = items
      .filter((i) => chosen.has(depositKey(i)) && !now.lines.some((l) => l.linkedTxnId && depositLineKey(l) === depositKey(i)))
      .map<TxnLine>((i) => ({
        ...emptyLine('deposit'),
        nameId: i.nameId,
        accountId: ufId,
        // a payment line says which invoice / receipt it belongs to
        description: i.lineId ? depositTypeLabel(i) : i.memo,
        refNumber: depositCheckNumber(i),
        paymentMethodId: i.paymentMethodId,
        classId: i.classId,
        amount: i.amount,
        linkedTxnId: i.txnId,
        linkedLineId: i.lineId ?? null,
      }));
    const others = now.lines.filter((l) => !l.linkedTxnId);
    const next = [...keep, ...added, ...others].map((l, i) => ({ ...l, seq: i + 1 }));
    const same = next.length === now.lines.length && next.every((l, i) => l.linkedTxnId === now.lines[i].linkedTxnId && l.linkedLineId === now.lines[i].linkedLineId);
    if (!same) form.setLines(next);
  }

  const linked = (r: TxnLine) => !!r.linkedTxnId;
  const columns = useMemo<GridColumn<TxnLine>[]>(
    () => [
      {
        key: 'nameId',
        label: 'RECEIVED FROM',
        width: 190,
        readOnly: linked,
        render: (r) => <NameLabel id={r.nameId} />,
        editor: (p: GridEditorProps<TxnLine>) => <NamePicker inGrid autoFocus aria-label="Received from" value={p.value as ID | null} onChange={(id) => p.onChange(id)} defaultKind="customer" />,
      },
      {
        key: 'accountId',
        label: 'FROM ACCOUNT',
        width: 190,
        readOnly: linked,
        render: (r) => <AccountLabel id={r.accountId} />,
        editor: (p: GridEditorProps<TxnLine>) => (
          <AccountPicker inGrid autoFocus aria-label="From account" excludeTypes={LINE_EXCLUDED_TYPES} value={p.value as ID | null} onChange={(id) => p.onChange(id)} />
        ),
      },
      { key: 'description', label: 'MEMO', grow: true, width: 160, editor: 'text' },
      { key: 'refNumber', label: 'CHK NO.', width: 84, editor: 'text', readOnly: linked },
      {
        key: 'paymentMethodId',
        label: 'PMT METH.',
        width: 110,
        readOnly: linked,
        render: (r) => <ListEntryLabel list="payment_method" id={r.paymentMethodId} />,
        editor: (p: GridEditorProps<TxnLine>) => <PaymentMethodPicker inGrid autoFocus aria-label="Payment method" value={p.value as ID | null} onChange={(id) => p.onChange(id)} />,
      },
      {
        key: 'classId',
        label: 'CLASS',
        width: 110,
        hidden: !prefs.useClassTracking,
        render: (r) => <ListEntryLabel list="class" id={r.classId} />,
        editor: (p: GridEditorProps<TxnLine>) => <ClassPicker inGrid autoFocus aria-label="Class" value={p.value as ID | null} onChange={(id) => p.onChange(id)} />,
      },
      { key: 'amount', label: 'AMOUNT', width: 110, editor: 'money', align: 'right', readOnly: linked },
    ],
    [prefs.useClassTracking],
  );

  const print = () => {
    const rows = t.lines
      .map(
        (l) =>
          `<tr><td>${escHtml(nameOf(l))}</td><td>${escHtml(acctOf(l.accountId))}</td><td>${escHtml(l.description)}</td><td>${escHtml(l.refNumber)}</td><td class="num">${fmtMoney(l.amount)}</td></tr>`,
      )
      .join('');
    void printHtml(
      'Deposit Summary',
      `<h2>${escHtml(company?.name ?? '')}</h2><h1>Deposit Summary</h1>
       <p>Summary of deposits to <b>${escHtml(account?.fullName ?? '')}</b> on ${escHtml(fmtDate(t.date))}</p>
       <table><thead><tr><th>Received from</th><th>From account</th><th>Memo</th><th>Chk no.</th><th class="num">Amount</th></tr></thead><tbody>${rows}</tbody></table>
       <table style="margin-top:12px;width:300px;margin-left:auto">
         <tr><td>Deposit subtotal</td><td class="num">${fmtMoney(subtotal)}</td></tr>
         ${t.cashBackAmount ? `<tr><td>Less cash back</td><td class="num">${fmtMoney(t.cashBackAmount)}</td></tr>` : ''}
         <tr class="bold"><td>Deposit total</td><td class="num">${fmtMoney(total)}</td></tr>
       </table>`,
    );
  };
  const nameOf = (l: TxnLine) => (l.nameId ? names?.find((n) => n.id === l.nameId)?.fullName ?? '' : '');
  const acctOf = (id: ID | null) => (id ? accounts.get(id)?.fullName ?? '' : '');

  return (
    <TxnFormFrame
      form={form}
      title="Deposit"
      onPrint={print}
      extraButtons={[
        {
          key: 'payments',
          label: waitingCount ? `Payments (${waitingCount} waiting)` : 'Payments',
          icon: HandCoins,
          color: waitingCount > 0 && !t.voided ? undefined : '#16a34a',
          primary: waitingCount > 0 && !t.voided,
          disabled: t.voided,
          title: 'Choose customer payments waiting in Undeposited Funds',
          onClick: () => void openPayments(false),
        },
      ]}
      header={
        <HeaderRow>
          <TxnHeaderField label="DEPOSIT TO" width={260} htmlFor={`${win.id}-acct`}>
            <AccountPicker
              id={`${win.id}-acct`}
              name="accountId"
              types={['Bank', 'Other Current Asset']}
              filter={(a) => !isUF(a)}
              value={t.accountId}
              onChange={(id) => form.update({ accountId: id })}
            />
          </TxnHeaderField>
          <TxnHeaderField label="DATE" width={140} htmlFor={`${win.id}-date`}>
            <DateField id={`${win.id}-date`} name="date" required value={t.date} onChange={(d) => form.update({ date: d })} />
          </TxnHeaderField>
          <TxnHeaderField label="MEMO" width={320} htmlFor={`${win.id}-memo`} help="Memo">
            <TextField id={`${win.id}-memo`} name="memo" value={t.memo} onChange={(v) => form.update({ memo: v })} />
          </TxnHeaderField>
          <div className="bk-hint">
            {waitingCount > 0 ? (
              <>
                <b>{waitingCount}</b> payment{waitingCount === 1 ? '' : 's'} waiting in Undeposited Funds. Click <b>Payments</b> to choose them, and list any other amounts below.
              </>
            ) : (
              <>No payments are waiting in Undeposited Funds. List the amounts you are depositing below.</>
            )}
          </div>
        </HeaderRow>
      }
      lines={
        <Grid<TxnLine>
          aria-label="Deposit lines"
          columns={columns}
          rows={t.lines}
          onChange={form.setLines}
          newRow={() => emptyLine('deposit')}
          readOnly={t.voided}
          minRows={6}
          persistKey="dep-lines"
          rowClassName={(r) => (r.linkedTxnId ? 'bk-linked-row' : undefined)}
        />
      }
      footer={
        <>
          <div className="bk-cashback">
            <div className="bk-cashback-title">Cash back</div>
            <HeaderRow>
              <TxnHeaderField label="CASH BACK GOES TO" width={230} htmlFor={`${win.id}-cbacct`}>
                <AccountPicker
                  id={`${win.id}-cbacct`}
                  name="cashBackAccountId"
                  excludeTypes={LINE_EXCLUDED_TYPES}
                  value={t.cashBackAccountId}
                  onChange={(id) => form.update({ cashBackAccountId: id })}
                  placeholder="e.g. Petty Cash"
                  readOnly={t.voided}
                />
              </TxnHeaderField>
              <TxnHeaderField label="CASH BACK MEMO" width={220} htmlFor={`${win.id}-cbmemo`}>
                <TextField id={`${win.id}-cbmemo`} name="cashBackMemo" value={t.cashBackMemo} onChange={(v) => form.update({ cashBackMemo: v })} readOnly={t.voided} />
              </TxnHeaderField>
              <TxnHeaderField label="CASH BACK AMOUNT" width={130} htmlFor={`${win.id}-cbamt`} align="right">
                <MoneyField id={`${win.id}-cbamt`} name="cashBackAmount" value={t.cashBackAmount} blankZero onChange={(v) => form.update({ cashBackAmount: v ?? 0 })} readOnly={t.voided} />
              </TxnHeaderField>
            </HeaderRow>
          </div>
          <TotalsBlock
            rows={[
              { key: 'sub', label: 'Deposit subtotal', value: subtotal },
              { key: 'cb', label: 'Less cash back', value: t.cashBackAmount ? -t.cashBackAmount : 0 },
              { key: 'tot', label: 'Deposit total', value: total, bold: true, big: true, separator: true },
            ]}
          />
        </>
      }
      totals={[
        { key: 'sub', label: 'Subtotal', value: subtotal },
        ...(t.cashBackAmount ? [{ key: 'cb', label: 'Cash back', value: -t.cashBackAmount }] : []),
        { key: 'tot', label: 'Deposit total', value: total, strong: true, tone: total < 0 ? ('danger' as const) : undefined },
      ]}
      readOnly={t.voided}
    />
  );
}
