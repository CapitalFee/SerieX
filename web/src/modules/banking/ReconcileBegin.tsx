// Start Reconciling: account, statement date, beginning balance (from the last
// reconciliation), ending balance, service charge and interest earned (date + account), Undo
// Last Reconciliation and Locate Discrepancies. Continue saves the header as the draft and
// opens the reconcile screen.
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { History, TriangleAlert, Undo2 } from 'lucide-react';
import { api, type ApiError } from '@/api/client';
import { invalidateAll, queryClient, useAccounts, usePrefValues } from '@/api/hooks';
import type { Account, AccountType, ID, ReconcileAdj } from '@/api/types';
import { AccountPicker, Button, DateField, EditDialog, Field, FieldRow, MoneyField, Spinner, msgBox, toast, useFormErrors } from '@/components';
import { addMonthsClamped, endOfMonth } from '@/util/dates';
import { fmtDate, fmtMoney } from '@/util/format';
import { openWindow } from '@/windows/windowStore';
import { useWindow } from '@/windows/WindowContext';
import { RECONCILE_TYPES, adjAccountGuess, beginningDifference, discrepanciesQuery, openDiscrepancyReport, reconcileQuery } from './reconcileShared';
import { dollars, todayIso } from './shared';
import './banking.css';

export interface ReconcileBeginProps {
  accountId?: number;
}

const LAST_KEY = 'sx.bk.lastReconcile';

interface AdjState {
  amount: number;
  date: string;
  accountId: ID | null;
}

const toAdj = (a: AdjState): ReconcileAdj | null => (a.amount ? { amount: a.amount, date: a.date, accountId: a.accountId, classId: null } : null);

/**
 * Proposed statement date: one month after the last statement (05/25 -> 06/25). When the last
 * statement ended on a month end, the next one does too (09/30 -> 10/31, 02/28 -> 03/31).
 */
function nextStatementDate(last: string): string {
  const next = addMonthsClamped(last, 1);
  return last === endOfMonth(last) ? endOfMonth(next) : next;
}

/** Problem of a statement date compared with the last reconciliation (null when fine). */
function statementDateProblem(date: string, lastStatementDate: string | null | undefined): string | null {
  if (!date || !lastStatementDate || date > lastStatementDate) return null;
  const last = fmtDate(lastStatementDate);
  return date === lastStatementDate
    ? `This statement date is the date of your last reconciliation (${last}). Choose a later date, or undo the last reconciliation first.`
    : `This statement date is before your last reconciliation (${last}). Choose a later date, or undo the last reconciliation first.`;
}

export default function ReconcileBegin(props: ReconcileBeginProps) {
  const win = useWindow();
  const prefs = usePrefValues();
  const { data: accounts } = useAccounts({ active: 'all' });
  const fe = useFormErrors();
  const [accountId, setAccountId] = useState<ID | null>(props.accountId ?? null);
  const [stmtDate, setStmtDate] = useState('');
  const [ending, setEnding] = useState(0);
  const [sc, setSc] = useState<AdjState>({ amount: 0, date: '', accountId: null });
  const [int, setInt] = useState<AdjState>({ amount: 0, date: '', accountId: null });
  const [loadedFor, setLoadedFor] = useState<ID | null>(null);
  const [busy, setBusy] = useState(false);

  // default account: the one given, else the last reconciled one, else the checking account
  useEffect(() => {
    if (accountId || !accounts) return;
    let last: ID | null = null;
    try {
      last = Number(localStorage.getItem(LAST_KEY)) || null;
    } catch {
      /* ignore */
    }
    const ok = (id: ID | null | undefined) => !!id && accounts.some((a) => a.id === id && a.active && RECONCILE_TYPES.includes(a.type));
    setAccountId(ok(last) ? last : ok(prefs.defaultCheckAccountId) ? prefs.defaultCheckAccountId : accounts.find((a) => a.active && a.type === 'Bank')?.id ?? null);
  }, [accounts, accountId, prefs.defaultCheckAccountId]);

  const { data: start, isFetching, refetch } = useQuery({ ...reconcileQuery(accountId), enabled: !!accountId });
  const account: Account | undefined = start?.account ?? accounts?.find((a) => a.id === accountId);
  const isCC = account?.type === 'Credit Card';
  const acctList = useMemo(() => accounts ?? [], [accounts]);

  // fill the fields from the saved draft (or defaults) once per account
  useEffect(() => {
    if (!start || !accountId || loadedFor === accountId || start.account.id !== accountId) return;
    const d = start.draft;
    const today = todayIso();
    const date = d?.statementDate || (start.lastStatementDate ? nextStatementDate(start.lastStatementDate) : endOfMonth(addMonthsClamped(today, -1)));
    setStmtDate(date);
    setEnding(d ? d.endingBalance : 0);
    const guessSc = adjAccountGuess(acctList, 'service', start.account.type as AccountType);
    const guessInt = adjAccountGuess(acctList, 'interest', start.account.type as AccountType);
    setSc({ amount: d?.serviceCharge?.amount ?? 0, date: d?.serviceCharge?.date || date, accountId: d?.serviceCharge?.accountId ?? guessSc });
    setInt({ amount: d?.interest?.amount ?? 0, date: d?.interest?.date || date, accountId: d?.interest?.accountId ?? guessInt });
    setLoadedFor(accountId);
    fe.clearAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, accountId, loadedFor, acctList]);

  // follow the statement date in the adjustment dates until they are changed by hand
  const changeDate = (d: string) => {
    setSc((s) => (s.date === stmtDate || !s.date ? { ...s, date: d } : s));
    setInt((s) => (s.date === stmtDate || !s.date ? { ...s, date: d } : s));
    setStmtDate(d);
    // say it next to the field right away, not only after Continue
    fe.setFieldError('statementDate', statementDateProblem(d, start?.lastStatementDate));
  };

  const cont = async () => {
    fe.clearAll();
    if (!accountId) return fe.setFieldError('accountId', 'Choose the account to reconcile.');
    if (!stmtDate) return fe.setFieldError('statementDate', 'Enter the statement date.');
    const dateProblem = statementDateProblem(stmtDate, start?.lastStatementDate);
    if (dateProblem) return fe.setFieldError('statementDate', dateProblem);
    if (sc.amount < 0) return fe.setFieldError('scAmount', 'The service charge cannot be negative.');
    if (sc.amount && !sc.accountId) return fe.setFieldError('scAccount', `Choose the account for the ${isCC ? 'finance charge' : 'service charge'}.`);
    if (int.amount < 0) return fe.setFieldError('intAmount', 'The interest earned cannot be negative.');
    if (int.amount && !int.accountId) return fe.setFieldError('intAccount', 'Choose the account for the interest earned.');
    setBusy(true);
    try {
      // header only: the check marks already saved stay as they are
      await api.put(`/reconcile/${accountId}/draft`, { statementDate: stmtDate, endingBalance: ending, serviceCharge: toAdj(sc), interest: isCC ? null : toAdj(int) });
      try {
        localStorage.setItem(LAST_KEY, String(accountId));
      } catch {
        /* ignore */
      }
      await queryClient.invalidateQueries({ queryKey: ['reconcile', accountId] });
      await win.close(true);
      openWindow('reconcile', { accountId }, { title: `Reconcile - ${account?.fullName ?? ''}` });
    } catch (e) {
      fe.fromError(e);
    } finally {
      setBusy(false);
    }
  };

  const undoLast = async () => {
    if (!accountId || !start?.lastStatementDate) return;
    const r = await msgBox({
      title: 'Undo Previous Reconciliation',
      message: `Undo the last reconciliation of ${account?.fullName} (statement date ${fmtDate(start.lastStatementDate)})?\n\nEvery transaction cleared in that reconciliation becomes uncleared again, so you can reconcile that statement again. Service charges, interest and adjustments entered then stay in the register: do not enter them a second time.`,
      buttons: ['Undo reconciliation', 'Cancel'],
      icon: 'warning',
    });
    if (r !== 'Undo reconciliation') return;
    try {
      await api.post(`/reconcile/${accountId}/undo-last`);
      void invalidateAll();
      // the defaults (statement date, adjustment dates) follow the new last statement: recompute
      // them only once the new beginning balance and last statement date are loaded
      await refetch();
      setLoadedFor(null);
      toast(`The ${fmtDate(start.lastStatementDate)} reconciliation was undone`, { kind: 'success' });
    } catch (e) {
      if ((e as ApiError).code !== 'cancelled') fe.fromError(e);
    }
  };

  const ready = !!start && loadedFor === accountId;

  // reconciled transactions changed since the last statement: the beginning balance moved away from it
  const diff = start && start.account.id === accountId ? beginningDifference(start) : 0;
  const { data: disc } = useQuery({ ...discrepanciesQuery(accountId), enabled: !!accountId && diff !== 0 });
  const nChanged = disc?.changes.length ?? 0;
  const showDiscrepancies = () => {
    if (!accountId) return;
    void win.close(true).then(() => openDiscrepancyReport(accountId, account?.fullName));
  };

  return (
    <EditDialog
      title="Start Reconciling"
      errors={fe}
      onOk={cont}
      okLabel="Continue"
      busy={busy}
      okDisabled={!ready}
      footerLeft={
        <>
          <Button
            variant="ghost"
            small
            icon={History}
            label="Locate discrepancies"
            onClick={showDiscrepancies}
            disabled={!accountId || !start?.lastStatementDate}
            title="Discrepancy report: reconciled transactions changed, unmarked or deleted since they were reconciled"
          />
          <Button variant="ghost" small icon={Undo2} label="Undo last reconciliation" onClick={() => void undoLast()} disabled={!start?.lastStatementDate} />
        </>
      }
    >
      <div className="bk-begin">
        <p className="bk-begin-intro">Choose the account to reconcile, then enter the ending balance from your statement.</p>
        <FieldRow align="end">
          <Field label="Account" htmlFor="bk-rb-acct" width={300}>
            <AccountPicker
              id="bk-rb-acct"
              name="accountId"
              types={RECONCILE_TYPES}
              value={accountId}
              onChange={(id) => {
                setAccountId(id);
                setLoadedFor(null);
              }}
              addNew={false}
              autoFocus={!props.accountId}
            />
          </Field>
          <div className="bk-begin-last">{start ? (start.lastStatementDate ? `Last reconciled on ${fmtDate(start.lastStatementDate)}` : 'Never reconciled') : isFetching ? <Spinner size={14} /> : ''}</div>
        </FieldRow>
        <div className="bk-begin-grid">
          <Field label="Statement date" htmlFor="bk-rb-date">
            <DateField id="bk-rb-date" name="statementDate" value={stmtDate} required onChange={changeDate} width={150} autoFocus={!!props.accountId} />
          </Field>
          <Field label="Beginning balance" help="The ending balance of your last reconciliation (the total of every transaction already reconciled). It should match the beginning balance on your statement.">
            <div className="bk-begin-amt">{start ? fmtMoney(start.beginningBalance) : ''}</div>
          </Field>
          <Field label="Ending balance" htmlFor="bk-rb-end" hint="From your statement">
            <MoneyField id="bk-rb-end" name="endingBalance" value={ending} onChange={(v) => setEnding(v ?? 0)} width={150} />
          </Field>
        </div>
        {diff !== 0 && start?.lastEndingBalance !== null && start?.lastEndingBalance !== undefined && (
          <div className="bk-begin-warn" role="alert">
            <TriangleAlert size={16} aria-hidden="true" />
            <span>
              Your beginning balance is <b>{dollars(Math.abs(diff))}</b> {diff < 0 ? 'lower' : 'higher'} than your last statement's ending balance ({fmtMoney(start.lastEndingBalance)}), because{' '}
              {nChanged > 1 ? `${nChanged} reconciled transactions were` : 'a reconciled transaction was'} changed since.{' '}
              <button type="button" className="sx-linkbtn" onClick={showDiscrepancies}>
                See the Discrepancy report
              </button>
              .
            </span>
          </div>
        )}
        <div className="bk-begin-adj">
          <div className="bk-begin-adj-title">{isCC ? 'Enter any finance charge from the statement' : 'Enter any service charge or interest earned shown on the statement'}</div>
          <div className="bk-begin-adj-row">
            <Field label={isCC ? 'Finance charge' : 'Service charge'} htmlFor="bk-rb-sc">
              <MoneyField id="bk-rb-sc" name="scAmount" value={sc.amount} blankZero onChange={(v) => setSc((s) => ({ ...s, amount: v ?? 0 }))} width={120} />
            </Field>
            <Field label="Date" htmlFor="bk-rb-scd">
              <DateField id="bk-rb-scd" name="scDate" value={sc.date} onChange={(d) => setSc((s) => ({ ...s, date: d }))} width={140} />
            </Field>
            <Field label="Account" htmlFor="bk-rb-sca" width={240}>
              <AccountPicker id="bk-rb-sca" name="scAccount" types={['Expense', 'Other Expense', 'Cost of Goods Sold']} value={sc.accountId} onChange={(id) => setSc((s) => ({ ...s, accountId: id }))} />
            </Field>
          </div>
          {!isCC && (
            <div className="bk-begin-adj-row">
              <Field label="Interest earned" htmlFor="bk-rb-int">
                <MoneyField id="bk-rb-int" name="intAmount" value={int.amount} blankZero onChange={(v) => setInt((s) => ({ ...s, amount: v ?? 0 }))} width={120} />
              </Field>
              <Field label="Date" htmlFor="bk-rb-intd">
                <DateField id="bk-rb-intd" name="intDate" value={int.date} onChange={(d) => setInt((s) => ({ ...s, date: d }))} width={140} />
              </Field>
              <Field label="Account" htmlFor="bk-rb-inta" width={240}>
                <AccountPicker id="bk-rb-inta" name="intAccount" types={['Income', 'Other Income']} value={int.accountId} onChange={(id) => setInt((s) => ({ ...s, accountId: id }))} />
              </Field>
            </div>
          )}
        </div>
      </div>
    </EditDialog>
  );
}
