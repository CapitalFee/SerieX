// Reconcile (one screen with every reconciliation field): summary header (statement
// ending balance, beginning balance, marked items, cleared balance, Difference — green when 0),
// Payments / Deposits / All tabs, one list with check boxes, search, hide transactions after the
// statement date, Mark all / Unmark all, Edit transaction, Modify (back to Begin
// Reconciliation), Save for later and Finish now (with the "not balanced" choices and the
// reconciliation report afterwards).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, Pencil, Settings2 } from 'lucide-react';
import { api, qs, type ApiError } from '@/api/client';
import { invalidateAll, queryClient } from '@/api/hooks';
import { emptyLine, emptyTxn, type ID, type Name, type ReconcileEntry, type ReconcileFinish, type Reconciliation, type Txn } from '@/api/types';
import { Button, Checkbox, EmptyState, RadioGroup, SearchBox, SegmentedControl, Spinner, msgBox, showDialog, toast, useHotkeys } from '@/components';
import { fmtDate, fmtMoney, round2 } from '@/util/format';
import { openTxn, openWindow } from '@/windows/windowStore';
import { useWindow } from '@/windows/WindowContext';
import { CheckTable, type CheckColumn } from './CheckTable';
import { adjustmentsEffect, groupLabels, reconcileQuery } from './reconcileShared';
import { dollars, todayIso } from './shared';
import './banking.css';

export interface ReconcileWindowProps {
  accountId: number;
}

type Tab = 'dec' | 'inc' | 'all';

export default function ReconcileWindow({ accountId }: ReconcileWindowProps) {
  const win = useWindow();
  const { data: start, isLoading, error, refetch } = useQuery(reconcileQuery(accountId));
  const [marked, setMarked] = useState<Set<ID> | null>(null);
  const savedMarks = useRef<string>('');
  const knownIds = useRef<Set<ID>>(new Set());
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [hideAfter, setHideAfter] = useState(true);
  const [hi, setHi] = useState<ReconcileEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const account = start?.account;
  const draft = start?.draft ?? null;
  const labels = groupLabels(account?.type ?? 'Bank');
  const isCC = account?.type === 'Credit Card';

  useEffect(() => {
    if (account) win.setTitle(`Reconcile - ${account.fullName}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.fullName]);

  // marks: from the server the first time; afterwards keep the user's marks (refreshes after
  // editing a transaction must not lose them) and add entries newly marked elsewhere
  useEffect(() => {
    if (!start) return;
    const ids = new Set(start.entries.map((e) => e.glId));
    setMarked((cur) => {
      if (cur === null) {
        const init = new Set(start.draft?.markedGlIds ?? start.entries.filter((e) => e.cleared === '*').map((e) => e.glId));
        savedMarks.current = Array.from(init).sort().join(',');
        knownIds.current = ids;
        return init;
      }
      const next = new Set<ID>();
      cur.forEach((id) => ids.has(id) && next.add(id));
      start.entries.forEach((e) => {
        if (!knownIds.current.has(e.glId) && e.cleared === '*') next.add(e.glId);
      });
      knownIds.current = ids;
      return next;
    });
  }, [start]);

  const marks = marked ?? new Set<ID>();
  const entries = start?.entries ?? [];
  const stmtDate = draft?.statementDate ?? '';
  const ending = draft?.endingBalance ?? 0;
  const adj = adjustmentsEffect(account?.type ?? 'Bank', draft?.serviceCharge, draft?.interest);

  const totals = useMemo(() => {
    let inc = 0;
    let dec = 0;
    let nInc = 0;
    let nDec = 0;
    for (const e of entries) {
      if (!marks.has(e.glId)) continue;
      if (e.amount >= 0) {
        inc += e.amount;
        nInc++;
      } else {
        dec += -e.amount;
        nDec++;
      }
    }
    return { inc: round2(inc), dec: round2(dec), nInc, nDec };
  }, [entries, marks]);
  const beginning = start?.beginningBalance ?? 0;
  const cleared = round2(beginning + totals.inc - totals.dec + adj.sc + adj.int);
  const difference = round2(ending - cleared);
  const balanced = difference === 0;

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (tab === 'dec' && e.amount >= 0) return false;
      if (tab === 'inc' && e.amount < 0) return false;
      // a marked transaction stays visible: it counts in the cleared balance
      if (hideAfter && stmtDate && e.date > stmtDate && !marks.has(e.glId)) return false;
      if (q) {
        const amt = fmtMoney(Math.abs(e.amount));
        if (!(e.nameFull.toLowerCase().includes(q) || e.memo.toLowerCase().includes(q) || e.refNumber.toLowerCase().includes(q) || amt.includes(q) || amt.replace(/,/g, '').includes(q)))
          return false;
      }
      return true;
    });
  }, [entries, tab, search, hideAfter, stmtDate, marks]);
  const hiddenAfter = hideAfter && stmtDate ? entries.filter((e) => e.date > stmtDate && !marks.has(e.glId)).length : 0;

  const changed = marked !== null && Array.from(marks).sort().join(',') !== savedMarks.current;

  const toggle = (id: ID) =>
    setMarked((c) => {
      const n = new Set(c ?? []);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const setAll = (on: boolean) =>
    setMarked((c) => {
      const n = new Set(c ?? []);
      for (const e of shown) {
        if (on) n.add(e.glId);
        else n.delete(e.glId);
      }
      return n;
    });

  const saveDraft = async (): Promise<boolean> => {
    if (!draft) return false;
    try {
      await api.put(`/reconcile/${accountId}/draft`, {
        statementDate: draft.statementDate,
        endingBalance: draft.endingBalance,
        serviceCharge: draft.serviceCharge,
        interest: draft.interest,
        markedGlIds: Array.from(marks),
      });
      savedMarks.current = Array.from(marks).sort().join(',');
      void queryClient.invalidateQueries({ queryKey: ['register', accountId] });
      return true;
    } catch (e) {
      if ((e as ApiError).code !== 'cancelled') toast((e as Error).message, { kind: 'error' });
      return false;
    }
  };

  // closing with unsaved marks asks to keep them for later
  const changedRef = useRef(changed);
  changedRef.current = changed;
  const saveRef = useRef(saveDraft);
  saveRef.current = saveDraft;
  useEffect(() => {
    win.setDirty(changed);
  }, [changed, win]);
  useEffect(() => {
    win.setBeforeClose(async () => {
      if (!changedRef.current) return true;
      const r = await msgBox({
        title: 'Leave Reconcile',
        message: 'Do you want to save your check marks so you can finish this reconciliation later?',
        buttons: ['Save for later', "Don't save", 'Cancel'],
        icon: 'question',
      });
      if (r === 'Save for later') return saveRef.current();
      return r === "Don't save";
    });
    return () => win.setBeforeClose(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveForLater = async () => {
    setBusy(true);
    const ok = await saveDraft();
    setBusy(false);
    if (ok) {
      toast('Reconciliation saved. Open Reconcile again to finish it.', { kind: 'success' });
      await win.close(true);
    }
  };

  const modify = async () => {
    if (changed && !(await saveDraft())) return;
    openWindow('reconcileBegin', { accountId });
  };

  const finish = async () => {
    if (!draft) return;
    let enterAdjustment = false;
    if (!balanced) {
      const r = await msgBox({
        title: 'Reconcile Adjustment',
        message: `This account is not balanced yet: there is a difference of ${dollars(difference)} between the statement ending balance and the cleared balance.\n\nReturn to reconcile to look for the transactions you missed. Or enter a balance adjustment: a journal entry of $${fmtMoney(Math.abs(difference))} to the "Reconciliation Discrepancies" expense account, so the account matches the statement.`,
        buttons: ['Return to reconcile', 'Save for later', 'Enter adjustment'],
        icon: 'warning',
        defaultButton: 'Return to reconcile',
        cancelButton: 'Return to reconcile',
      });
      if (r === 'Save for later') return saveForLater();
      if (r !== 'Enter adjustment') return;
      enterAdjustment = true;
    }
    const body: ReconcileFinish = {
      statementDate: draft.statementDate,
      endingBalance: draft.endingBalance,
      clearedGlIds: Array.from(marks),
      serviceCharge: draft.serviceCharge,
      interest: draft.interest,
      enterAdjustment,
    };
    setBusy(true);
    try {
      const rec = await api.post<Reconciliation>(`/reconcile/${accountId}/finish`, body);
      void invalidateAll();
      savedMarks.current = Array.from(marks).sort().join(',');
      setMarked(new Set(marks));
      await win.close(true);
      // credit cards ("Make Payment"): pay the statement balance now with a check, or later with a bill
      const pay = isCC && round2(rec.endingBalance) > 0 ? await choosePayment(rec) : null;
      const mode = await chooseReport(rec);
      if (mode) openWindow('reconcileReport', { reconciliationId: rec.id, mode, requestId: Date.now() }, { title: `Reconciliation Report - ${rec.accountName}` });
      if (pay) await openCardPayment(pay, rec, lastCardPayee(entries));
    } catch (e) {
      if ((e as ApiError).code !== 'cancelled') await msgBox({ title: 'Reconcile', message: (e as Error).message, icon: 'error' });
    } finally {
      setBusy(false);
    }
  };

  useHotkeys({
    'ctrl+e': () => {
      if (hi) openTxn(hi.type, hi.txnId);
    },
  });

  if (isLoading || marked === null) {
    if (error) return <EmptyState title="The account could not be loaded" message={(error as Error).message} action={{ label: 'Try again', onClick: () => void refetch() }} />;
    return <Spinner center label="Loading..." />;
  }
  if (!draft) {
    return (
      <div className="bk-rec">
        <EmptyState
          icon={Settings2}
          title={`Start by entering the statement of ${account?.fullName ?? 'this account'}`}
          message="Enter the statement date and ending balance (and any service charge or interest) before you check off the transactions."
          action={{ label: 'Begin reconciliation', onClick: () => openWindow('reconcileBegin', { accountId }) }}
        />
      </div>
    );
  }

  const decCol = isCC ? 'Payment' : account?.type === 'Bank' ? 'Payment' : 'Decrease';
  const incCol = isCC ? 'Charge' : account?.type === 'Bank' ? 'Deposit' : 'Increase';
  const columns: CheckColumn<ReconcileEntry>[] = [
    { key: 'date', label: 'Date', width: 96, type: 'date' },
    { key: 'refNumber', label: isCC ? 'Ref #' : 'Chk #', width: 84 },
    { key: 'nameFull', label: 'Payee', width: 200, grow: true },
    { key: 'typeLabel', label: 'Type', width: 120 },
    { key: 'memo', label: 'Memo', width: 180, grow: true },
    ...(tab !== 'inc' ? [{ key: 'dec', label: decCol, width: 112, align: 'right' as const, sortValue: (e: ReconcileEntry) => (e.amount < 0 ? -e.amount : null), render: (e: ReconcileEntry) => (e.amount < 0 ? fmtMoney(-e.amount) : '') }] : []),
    ...(tab !== 'dec' ? [{ key: 'inc', label: incCol, width: 112, align: 'right' as const, sortValue: (e: ReconcileEntry) => (e.amount >= 0 ? e.amount : null), render: (e: ReconcileEntry) => (e.amount >= 0 ? fmtMoney(e.amount) : '') }] : []),
  ];
  const decTab = { value: 'dec' as Tab, label: labels.tabDecrease };
  const incTab = { value: 'inc' as Tab, label: labels.tabIncrease };
  const tabs = isCC ? [incTab, decTab, { value: 'all' as Tab, label: 'All' }] : [decTab, incTab, { value: 'all' as Tab, label: 'All' }];

  return (
    <div className="bk-rec">
      <div className="bk-rec-head">
        <div className="bk-rec-title">
          <div className="bk-rec-acct">{account?.fullName}</div>
          <div className="bk-muted">
            Statement ending date <b>{fmtDate(stmtDate)}</b>
          </div>
        </div>
        <div className="bk-rec-cards">
          <div className="bk-rec-card">
            <span className="bk-rec-card-label">Statement ending balance</span>
            <span className="bk-rec-card-val">{fmtMoney(ending)}</span>
            <button type="button" className="sx-linkbtn bk-rec-edit" onClick={() => void modify()}>
              Edit
            </button>
          </div>
          <span className="bk-rec-op">−</span>
          <div className="bk-rec-card">
            <span className="bk-rec-card-label">Cleared balance</span>
            <span className="bk-rec-card-val">{fmtMoney(cleared)}</span>
          </div>
          <span className="bk-rec-op">=</span>
          <div className={'bk-rec-card bk-rec-diff' + (balanced ? ' bk-ok' : ' bk-bad')} role="status" aria-live="polite">
            <span className="bk-rec-card-label">Difference</span>
            <span className="bk-rec-card-val">
              {balanced ? <CheckCircle2 size={20} /> : <CircleAlert size={18} />}
              {fmtMoney(difference)}
            </span>
          </div>
        </div>
      </div>
      <div className="bk-rec-breakdown">
        <span>
          Beginning balance <b>{fmtMoney(beginning)}</b>
        </span>
        <span>
          − {labels.countDecrease(totals.nDec)} <b>{fmtMoney(totals.dec)}</b>
        </span>
        <span>
          + {labels.countIncrease(totals.nInc)} <b>{fmtMoney(totals.inc)}</b>
        </span>
        {!!draft.serviceCharge?.amount && (
          <span>
            {isCC ? 'Finance charge' : 'Service charge'} <b>{fmtMoney(adj.sc)}</b>
          </span>
        )}
        {!!draft.interest?.amount && (
          <span>
            Interest earned <b>{fmtMoney(adj.int)}</b>
          </span>
        )}
        {balanced ? <span className="bk-rec-okmsg">Balanced — you can finish now.</span> : <span className="bk-muted">Check off each transaction that appears on your statement until the difference is 0.00.</span>}
      </div>
      <div className="bk-rec-tools">
        <SegmentedControl<Tab> value={tab} options={tabs} onChange={setTab} size="sm" aria-label="Show" />
        <SearchBox value={search} onChange={setSearch} placeholder="Search" width={170} debounce={120} />
        <Checkbox
          label={`Hide after statement date${hiddenAfter ? ` (${hiddenAfter})` : ''}`}
          checked={hideAfter}
          onChange={setHideAfter}
          title="Hide transactions dated after the statement ending date (marked ones stay visible)"
        />
        <span className="bk-grow" />
        <Button small label="Mark all" onClick={() => setAll(true)} disabled={!shown.length} />
        <Button small label="Unmark all" onClick={() => setAll(false)} disabled={!shown.length} />
      </div>
      <CheckTable<ReconcileEntry>
        className="bk-rec-list"
        rows={shown}
        getKey={(e) => e.glId}
        columns={columns}
        checked={marks}
        onToggle={(id) => toggle(id)}
        onToggleAll={setAll}
        onHighlight={setHi}
        contextMenu={(e) => [
          { label: marks.has(e.glId) ? '&Unmark' : '&Mark as cleared', onClick: () => toggle(e.glId) },
          { label: '&Edit transaction', shortcut: 'Ctrl+E', onClick: () => openTxn(e.type, e.txnId) },
        ]}
        rowClassName={(e) => (stmtDate && e.date > stmtDate ? 'bk-dim' : undefined)}
        autoFocus
        aria-label="Transactions to reconcile"
        emptyText={entries.length ? 'No transactions match these filters.' : 'Every transaction of this account is already reconciled.'}
      />
      <div className="bk-rec-foot">
        <Button icon={Settings2} label="Modify" onClick={() => void modify()} title="Change the statement date, ending balance, service charge or interest" />
        <Button icon={Pencil} label="Edit transaction" onClick={() => hi && openTxn(hi.type, hi.txnId)} disabled={!hi} title="Open the highlighted transaction (Ctrl+E)" />
        <span className="bk-grow" />
        <span className="bk-muted bk-rec-count">
          {marks.size} of {entries.length} marked
        </span>
        <Button label="Save for later" onClick={() => void saveForLater()} disabled={busy} title="Keep your check marks and finish later" />
        <Button variant="primary" label="Finish now" onClick={() => void finish()} busy={busy} title={balanced ? 'Complete this reconciliation' : 'The difference is not 0.00 yet'} />
      </div>
    </div>
  );
}

type PayChoice = 'check' | 'bill';

/** Payee of the latest check or bill payment that paid this card (the bank to pay again), if any. */
function lastCardPayee(entries: ReconcileEntry[]): string {
  const paid = entries.filter((e) => e.amount < 0 && (e.type === 'CHK' || e.type === 'BILLPMT') && e.nameFull).sort((a, b) => b.date.localeCompare(a.date));
  return paid[0]?.nameFull ?? '';
}

/** Opens Write Checks (pay now) or Enter Bills (pay later) with the statement balance on an expense line to the card. */
async function openCardPayment(choice: PayChoice, rec: Reconciliation, payeeName: string): Promise<void> {
  let nameId: ID | null = null;
  if (payeeName) {
    const kind = choice === 'bill' ? 'vendor' : undefined;
    const names = await queryClient
      .fetchQuery({ queryKey: ['names', kind ?? null, { active: 'all' }], queryFn: () => api.get<Name[]>('/names' + qs({ kind, active: 'all' })), staleTime: 30_000 })
      .catch(() => [] as Name[]);
    nameId = names.find((n) => n.fullName === payeeName && (choice === 'check' || n.kind === 'vendor'))?.id ?? null;
  }
  const memo = `Payment of the ${fmtDate(rec.statementDate)} statement`;
  const line = { ...emptyLine('expense', 1), accountId: rec.accountId, amount: round2(rec.endingBalance), description: memo };
  const type = choice === 'check' ? 'CHK' : 'BILL';
  const template: Txn = { ...emptyTxn(type, todayIso()), nameId, memo, lines: [line] };
  openWindow(choice === 'check' ? 'writeCheck' : 'bill', { template });
}

/** "Make Payment" box of a credit card reconciliation: write a check now, enter a bill for later, or neither. */
function choosePayment(rec: Reconciliation): Promise<PayChoice | null> {
  return showDialog<PayChoice | null>({
    title: 'Make Payment',
    width: 440,
    cancelValue: null,
    render: (close) => <PaymentChoice rec={rec} onDone={close} />,
  });
}

function PaymentChoice({ rec, onDone }: { rec: Reconciliation; onDone: (v: PayChoice | null) => void }) {
  const [choice, setChoice] = useState<PayChoice>('check');
  return (
    <div className="bk-dlg">
      <div className="bk-dlg-body">
        <p className="bk-rec-done">
          <CheckCircle2 size={18} /> {rec.accountName} is reconciled through {fmtDate(rec.statementDate)}.
        </p>
        <p className="bk-dlg-intro">
          The statement balance is <b>${fmtMoney(rec.endingBalance)}</b>. How do you want to pay it?
        </p>
        <RadioGroup<PayChoice>
          value={choice}
          onChange={setChoice}
          aria-label="Payment"
          options={[
            { value: 'check', label: 'Write a check for payment now' },
            { value: 'bill', label: 'Enter a bill for payment later' },
          ]}
        />
      </div>
      <div className="sx-dlg-buttons">
        <Button label="Not now" onClick={() => onDone(null)} />
        <Button variant="primary" label="OK" onClick={() => onDone(choice)} />
      </div>
    </div>
  );
}

/** "Reconciliation complete" box: choose the report type (or close). */
function chooseReport(rec: Reconciliation): Promise<'summary' | 'detail' | 'both' | null> {
  return showDialog<'summary' | 'detail' | 'both' | null>({
    title: 'Reconciliation Complete',
    width: 420,
    cancelValue: null,
    render: (close) => <ReportChoice rec={rec} onDone={close} />,
  });
}

function ReportChoice({ rec, onDone }: { rec: Reconciliation; onDone: (v: 'summary' | 'detail' | 'both' | null) => void }) {
  const [mode, setMode] = useState<'summary' | 'detail' | 'both'>('summary');
  return (
    <div className="bk-dlg">
      <div className="bk-dlg-body">
        <p className="bk-rec-done">
          <CheckCircle2 size={18} /> {rec.accountName} is reconciled through {fmtDate(rec.statementDate)}. Ending balance ${fmtMoney(rec.endingBalance)}.
        </p>
        <p className="bk-dlg-intro">Select the type of reconciliation report to display:</p>
        <RadioGroup<'summary' | 'detail' | 'both'>
          value={mode}
          onChange={setMode}
          aria-label="Report type"
          options={[
            { value: 'summary', label: 'Summary' },
            { value: 'detail', label: 'Detail' },
            { value: 'both', label: 'Both' },
          ]}
        />
      </div>
      <div className="sx-dlg-buttons">
        <Button label="Close" onClick={() => onDone(null)} />
        <Button variant="primary" label="Display" onClick={() => onDone(mode)} />
      </div>
    </div>
  );
}
