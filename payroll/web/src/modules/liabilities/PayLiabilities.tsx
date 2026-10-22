// Pay Payroll Taxes: the payroll taxes and deductions due by the tax payment schedule (✓, DUE
// DATE, STATUS, PAYMENT, PERIOD, METHOD, AMOUNT DUE, AMOUNT TO PAY) with the payment date, bank
// account and check numbering. Pay Selected creates one tax payment per agency and period
// (POST /liability-payments/from-due; rows paid in part are saved one by one with the amount to
// pay spread over their items), posts them to SerieX Books, opens the created Tax Payment
// forms and shows a summary of the payments with any posting problem.
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, CheckSquare, Landmark, Square, Wallet } from 'lucide-react';
import { api, qs } from '@/api/client';
import { invalidateAll, useBooksAccounts, useCompany, useLiabilitiesDue, usePrefValues, useStateSettings } from '@/api/hooks';
import type { Id, LiabilityDue, LiabilityPayment, LiabilityPaymentLine, SyncProblem } from '@/api/types';
import {
  AccountPicker,
  Button,
  Checkbox,
  DateField,
  DropdownButton,
  EmptyState,
  ErrorBanner,
  Field,
  FormErrorsProvider,
  Grid,
  RadioGroup,
  Spinner,
  StatusPill,
  TextField,
  showDialog,
  useFormErrors,
  type GridColumn,
} from '@/components';
import { useWindow } from '@/windows/WindowContext';
import { openWindow } from '@/windows/windowStore';
import { todayIso } from '@/util/dates';
import { fmtDate, fmtMoney, round2 } from '@/util/format';
import { recordRecent } from '@/util/recent';
import { METHOD_LABELS, PAY_FREQ_LABELS, booksErr, countdown, errText, frequencyHelp, isCancelled, periodText, sum2 } from './shared';

export interface PayLiabilitiesProps {}

interface Row {
  key: string;
  due: LiabilityDue;
  pay: boolean;
  amount: number;
}

const rowKey = (d: LiabilityDue) => `${d.paymentGroup}|${d.periodStart}|${d.periodEnd}`;

/** Increments the trailing number of a check number ("1009" → "1010"). */
export function nextNumber(s: string): string {
  const m = /^(.*?)(\d+)$/.exec(s);
  if (!m) return s;
  const n = String(Number(m[2]) + 1);
  return m[1] + (n.length < m[2].length ? n.padStart(m[2].length, '0') : n);
}

/** Default memo of a tax payment: what identifies the company to the agency. */
function agencyMemo(group: string, ein: string, ids: Map<string, { wh: string; ui: string }>): string {
  if (group === 'federal_941' || group === 'federal_940') {
    const form = group === 'federal_941' ? 'Form 941' : 'Form 940';
    return ein.replace(/\D/g, '').length === 9 ? `EIN ${ein} ${form}` : form;
  }
  const m = /^state_(wh|ui):([A-Z]{2})$/.exec(group);
  if (m) {
    const s = ids.get(m[2]);
    const id = m[1] === 'wh' ? s?.wh : s?.ui;
    if (id) return `Acct ${id}`;
  }
  return '';
}

/** Spreads an amount over the items of a due row in order (each item at most its amount). */
function spreadAmount(due: LiabilityDue, amount: number): LiabilityPaymentLine[] {
  const lines: LiabilityPaymentLine[] = [];
  let left = round2(amount);
  for (const it of due.items) {
    if (left <= 0) break;
    if (it.amount <= 0) continue;
    const take = round2(Math.min(it.amount, left));
    lines.push({ kind: 'item', itemId: it.itemId, accountId: null, amount: take, memo: '', itemName: it.itemName, accountName: '' });
    left = round2(left - take);
  }
  return lines;
}

export default function PayLiabilities(_props: PayLiabilitiesProps) {
  const win = useWindow();
  const prefs = usePrefValues();
  const fe = useFormErrors();
  const today = todayIso();
  const thisYear = +today.slice(0, 4);
  const [from, setFrom] = useState(`${thisYear - 1}-01-01`);
  const [to, setTo] = useState(`${thisYear}-12-31`);
  const [showPaid, setShowPaid] = useState(false);
  const due = useLiabilitiesDue({ from, to, showPaid });
  const { data: company } = useCompany();
  const { data: stateSettings } = useStateSettings();
  const banksQ = useBooksAccounts(['Bank']);
  const banks = banksQ.data;
  const [bankId, setBankId] = useState<Id | null>(null);
  const [date, setDate] = useState(today);
  const [checkMode, setCheckMode] = useState<'print' | 'assign'>('assign');
  const [checkNo, setCheckNo] = useState('');
  const [checkTouched, setCheckTouched] = useState(false);
  const [sel, setSel] = useState<Map<string, { pay: boolean; amount: number }>>(new Map());
  const [hl, setHl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    win.setTitle('Pay Payroll Taxes');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // default bank account: the payroll preference, else the first active bank account
  useEffect(() => {
    if (bankId) return;
    if (!banks?.length) {
      // SerieX Books is not reachable: the payments can still be recorded with the default bank
      // account of the payroll preferences and posted later (SerieX Books Sync)
      if (banksQ.isError && prefs.defaultBankAccountId) setBankId(prefs.defaultBankAccountId);
      return;
    }
    const def = prefs.defaultBankAccountId ? banks.find((a) => a.id === prefs.defaultBankAccountId) : undefined;
    setBankId((def ?? banks.find((a) => a.active) ?? banks[0]).id);
  }, [banks, bankId, banksQ.isError, prefs.defaultBankAccountId]);
  const bank = banks?.find((a) => a.id === bankId) ?? null;

  const next = useQuery({
    queryKey: ['books', 'next-check', bankId],
    queryFn: ({ signal }) => api.get<{ refNumber: string }>('/books/next-check' + qs({ accountId: bankId }), { signal, noPrompt: true }),
    enabled: !!bankId,
    staleTime: 0,
  });
  useEffect(() => {
    if (!checkTouched && next.data) setCheckNo(next.data.refNumber ?? '');
  }, [next.data, checkTouched]);

  const rows: Row[] = useMemo(
    () =>
      (Array.isArray(due.data) ? due.data : []).map((d) => {
        const k = rowKey(d);
        const st = sel.get(k);
        return { key: k, due: d, pay: st?.pay ?? false, amount: st?.amount ?? 0 };
      }),
    [due.data, sel],
  );
  const chosen = rows.filter((r) => r.pay && r.amount > 0);
  const totalDue = sum2(rows.map((r) => r.due.amountDue));
  const totalPay = sum2(chosen.map((r) => r.amount));
  const hlRow = rows.find((r) => r.key === hl) ?? null;
  const missingPayee = rows.some((r) => r.due.status !== 'Paid' && !r.due.agencyVendorId);

  const onRowsChange = (list: Row[]) =>
    setSel((m) => {
      const n = new Map(m);
      for (const r of list) n.set(r.key, { pay: r.pay, amount: r.amount });
      return n;
    });
  const onRowChange = (r: Row, _prev: Row, key: string): Row => {
    if (key === 'pay') return { ...r, amount: r.pay ? r.due.amountDue : 0 };
    if (key === 'amount') {
      const a = round2(r.amount || 0);
      return { ...r, amount: a, pay: a > 0 };
    }
    return r;
  };
  const selectAll = () => setSel(new Map(rows.filter((r) => r.due.amountDue > 0).map((r) => [r.key, { pay: true, amount: r.due.amountDue }])));
  const clearAll = () => setSel(new Map());

  const pay = async () => {
    fe.clearAll();
    if (!date) return fe.setErrors({ date: 'Enter the payment date.' });
    if (!bankId) return fe.setErrors({ bankAccountId: 'Choose the bank account the taxes are paid from.' });
    if (!chosen.length) return fe.setErrors({}, 'Tick the payments you want to make (✓ column).');
    const noPayee = chosen.find((r) => !r.due.agencyVendorId);
    if (noPayee)
      return fe.setErrors({}, `"${noPayee.due.label}" has no payee. Choose the vendor you pay it to in Tax Payment Schedule, then pay it.`);
    const over = chosen.find((r) => r.amount > r.due.amountDue + 0.004);
    if (over)
      return fe.setErrors(
        {},
        `The amount to pay for ${over.due.label} (${periodText(over.due.frequency, over.due.periodStart, over.due.periodEnd)}) is more than the ${fmtMoney(over.due.amountDue)} due. Use Record a Tax Payment to pay more.`,
      );
    const toPrint = checkMode === 'print';
    if (!toPrint && chosen.some((r) => r.due.method === 'check') && !checkNo.trim()) return fe.setErrors({ firstCheckNumber: 'Enter the first check number.' });

    const full = chosen.filter((r) => Math.abs(r.amount - r.due.amountDue) < 0.005);
    const partial = chosen.filter((r) => Math.abs(r.amount - r.due.amountDue) >= 0.005);
    const created: LiabilityPayment[] = [];
    const problems: SyncProblem[] = [];
    setBusy(true);
    try {
      let number = checkNo.trim();
      if (full.length) {
        const res = await api.post<{ payments: LiabilityPayment[]; problems: SyncProblem[] }>('/liability-payments/from-due', {
          rows: full.map((r) => ({ paymentGroup: r.due.paymentGroup, periodStart: r.due.periodStart, periodEnd: r.due.periodEnd })),
          date,
          bankAccountId: bankId,
          toBePrinted: toPrint,
          firstCheckNumber: toPrint ? '' : number,
        });
        created.push(...res.payments);
        problems.push(...res.problems);
        const used = res.payments.map((p) => p.checkNumber).filter((n) => /\d$/.test(n));
        if (used.length) number = nextNumber(used[used.length - 1]);
      }
      const ids = new Map((stateSettings ?? []).map((s) => [s.state, { wh: s.withholdingId, ui: s.uiId }]));
      for (const r of partial) {
        const isCheck = r.due.method === 'check';
        const body = {
          id: 0,
          kind: 'payment',
          date,
          periodStart: r.due.periodStart,
          periodEnd: r.due.periodEnd,
          agencyVendorId: r.due.agencyVendorId,
          bankAccountId: bankId,
          checkNumber: isCheck && !toPrint ? number : '',
          toBePrinted: isCheck && toPrint,
          method: r.due.method,
          memo: agencyMemo(r.due.paymentGroup, company?.ein ?? '', ids),
          lines: spreadAmount(r.due, r.amount),
        };
        const p = await api.post<LiabilityPayment>('/liability-payments', body);
        created.push(p);
        if (p.syncStatus === 'error') problems.push({ entity: 'liability_payment', id: p.id, label: `Tax payment to ${p.agencyName}`, code: 'error', message: p.syncError });
        if (isCheck && !toPrint && number) number = nextNumber(number);
      }
    } catch (e) {
      if (!isCancelled(e)) {
        fe.fromError(e);
        if (created.length) fe.setMessage(`${errText(e)} (${created.length} payment${created.length === 1 ? ' was' : 's were'} already recorded.)`);
      }
    } finally {
      setBusy(false);
    }
    if (!created.length) return;
    for (const p of created) recordRecent({ kind: 'liability_payment', id: p.id, number: p.checkNumber, name: p.agencyName, amount: p.amount, date: p.date });
    await invalidateAll();
    setSel(new Map());
    setCheckTouched(false);
    // open the created tax payments (Payment i of n), then the summary on top
    const batch = created.map((p) => p.id);
    for (const p of [...created].reverse()) openWindow('liabilityPayment', { id: p.id, batch });
    await showDialog<void>({
      title: 'Payments Made',
      width: 760,
      cancelValue: undefined,
      render: (close) => <SummaryBody payments={created} problems={problems} date={date} bankName={bank?.fullName ?? ''} close={() => close()} />,
    });
  };

  const columns: GridColumn<Row>[] = [
    { key: 'pay', label: '✓', width: 38, editor: 'checkbox', title: 'Make this payment', readOnly: (r) => r.due.amountDue <= 0 },
    {
      key: 'dueDate',
      label: 'DUE DATE',
      width: 96,
      render: (r) => <span className={r.due.status === 'Overdue' ? 'lx-danger' : undefined}>{fmtDate(r.due.dueDate)}</span>,
    },
    {
      key: 'status',
      label: 'STATUS',
      width: 204,
      render: (r) => <StatusPill status={r.due.status} detail={r.due.status === 'Paid' ? undefined : countdown(r.due.dueDate, today)} />,
    },
    {
      key: 'payment',
      label: 'PAYMENT',
      width: 210,
      grow: true,
      render: (r) => (
        <span className="lx-payment" title={r.due.agencyName ? `Payee: ${r.due.agencyName}` : 'No payee'}>
          {!r.due.agencyVendorId && <AlertTriangle size={13} className="lx-warn-ico" aria-label="No payee" />}
          {r.due.label}
          {r.due.agencyName && r.due.agencyName !== r.due.label && <span className="lx-muted"> · {r.due.agencyName}</span>}
        </span>
      ),
    },
    { key: 'period', label: 'PERIOD', width: 150, render: (r) => periodText(r.due.frequency, r.due.periodStart, r.due.periodEnd) },
    { key: 'method', label: 'METHOD', width: 74, render: (r) => METHOD_LABELS[r.due.method] ?? r.due.method },
    { key: 'amountDue', label: 'AMOUNT DUE', width: 110, align: 'right', render: (r) => fmtMoney(r.due.amountDue) },
    { key: 'amount', label: 'AMOUNT TO PAY', width: 116, align: 'right', editor: 'money', blankZero: true, readOnly: (r) => r.due.amountDue <= 0 },
  ];

  const related = [
    { label: '&Record a Tax Payment...', onClick: () => openWindow('liabilityPayment', {}) },
    { label: '&Adjust Tax Balances...', onClick: () => openWindow('adjustLiabilities', {}) },
    { label: 'Record &Earlier Tax Payments...', onClick: () => openWindow('priorPayments') },
    { label: 'Tax Payment &Schedule...', onClick: () => openWindow('paymentSchedules') },
    { separator: true },
    { label: 'Payroll &Liability Balances report', onClick: () => openWindow('report', { key: 'payroll_liability_balances', params: { from, to } }) },
  ];
  const agencies = new Set(chosen.map((r) => `${r.due.agencyVendorId}|${r.due.periodStart}|${r.due.periodEnd}`)).size;

  return (
    <FormErrorsProvider value={fe}>
      <div className="lx-page">
        <div className="lx-filters">
          <span className="lx-cap">Show taxes due</span>
          <span className="lx-flabel">From</span>
          <DateField value={from} onChange={(d) => d && setFrom(d)} width={128} aria-label="Show taxes due from" name="from" />
          <span className="lx-flabel">Through</span>
          <DateField value={to} onChange={(d) => d && setTo(d)} width={128} aria-label="Show taxes due through" name="to" />
          <span className="lx-sep" />
          <Checkbox label="Include paid" checked={showPaid} onChange={setShowPaid} />
          <span className="lx-spacer" />
          <DropdownButton label="More Tax Tasks" items={related} alignEnd />
        </div>
        {missingPayee && (
          <div className="lx-note lx-warn" role="note">
            <AlertTriangle size={15} aria-hidden="true" />
            <span>Some payments below have no payee, so they cannot be made yet.</span>
            <button type="button" className="sx-linkbtn" onClick={() => openWindow('paymentSchedules')}>
              Tax Payment Schedule
            </button>
          </div>
        )}
        {banksQ.isError && (
          <div className="lx-note lx-warn" role="note">
            <AlertTriangle size={15} aria-hidden="true" />
            <span>
              {errText(banksQ.error)} You can still record the payments: they are posted to SerieX Books later from the SerieX Books Sync window.
            </span>
            <button type="button" className="sx-linkbtn" onClick={() => void banksQ.refetch()}>
              Try again
            </button>
          </div>
        )}
        {(fe.message || Object.keys(fe.errors).length > 0) && <ErrorBanner className="lx-banner" errors={fe.errors} message={fe.message} onDismiss={() => fe.clearAll()} />}
        <div className="lx-grid">
          {due.isLoading ? (
            <Spinner center label="Loading the taxes due..." />
          ) : due.isError ? (
            <EmptyState icon={AlertTriangle} title="Could not load the taxes due" message={errText(due.error)} action={{ label: 'Try again', onClick: () => void due.refetch() }} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Landmark}
              title="No payroll taxes to pay"
              message={`Nothing is owed for ${fmtDate(from)} - ${fmtDate(to)}. Taxes and deductions show up here after you create paychecks.`}
              action={{ label: 'Record a tax payment', onClick: () => openWindow('liabilityPayment', {}) }}
              secondaryAction={{ label: 'Tax payment schedule', onClick: () => openWindow('paymentSchedules') }}
            />
          ) : (
            <Grid<Row>
              aria-label="Taxes due"
              columns={columns}
              rows={rows}
              onChange={onRowsChange}
              newRow={() => rows[0]}
              onRowChange={onRowChange}
              allowAdd={false}
              allowInsertDelete={false}
              minRows={6}
              persistKey="payliabilities"
              rowClassName={(r) => (r.pay ? 'lx-row-sel' : r.due.status === 'Paid' ? 'lx-row-paid' : undefined)}
              onActiveRowChange={(i) => i !== null && rows[i] && setHl(rows[i].key)}
              contextMenu={(r) =>
                r
                  ? [
                      { label: 'Make this payment', disabled: r.due.amountDue <= 0, onClick: () => setSel((m) => new Map(m).set(r.key, { pay: true, amount: r.due.amountDue })) },
                      { label: 'Edit payment schedule...', onClick: () => openWindow('paymentSchedules', { group: r.due.paymentGroup }) },
                    ]
                  : []
              }
            />
          )}
        </div>
        <div className="lx-totals">
          <Button small variant="ghost" icon={CheckSquare} label="Select all" disabled={!rows.length} onClick={selectAll} />
          <Button small variant="ghost" icon={Square} label="Clear all" disabled={!rows.some((r) => r.pay)} onClick={clearAll} />
          <span className="lx-spacer" />
          <span className="lx-tot">
            <span>Totals</span>
            <span className="lx-num" title="Amount due of the payments shown">{fmtMoney(totalDue)}</span>
            <span className="lx-num lx-strong" title="Total to pay">{fmtMoney(totalPay)}</span>
          </span>
        </div>
        <div className="lx-bottom">
          <section className="lx-panel">
            <div className="lx-panel-head">What this payment covers</div>
            {hlRow ? (
              <div className="lx-panel-body lx-detail">
                <div className="lx-detail-info">
                  <dl className="lx-info">
                    <dt>Payment</dt>
                    <dd>{hlRow.due.label}</dd>
                    <dt>Payee</dt>
                    <dd>{hlRow.due.agencyName || <span className="lx-danger">No payee</span>}</dd>
                    <dt>Frequency</dt>
                    <dd>
                      {PAY_FREQ_LABELS[hlRow.due.frequency as keyof typeof PAY_FREQ_LABELS] ?? hlRow.due.frequency} · {METHOD_LABELS[hlRow.due.method]}
                    </dd>
                    <dt>Due</dt>
                    <dd title={frequencyHelp(hlRow.due.paymentGroup, hlRow.due.frequency)}>{fmtDate(hlRow.due.dueDate)}</dd>
                  </dl>
                  <Button small variant="link" icon={CalendarClock} label="Edit payment schedule" onClick={() => openWindow('paymentSchedules', { group: hlRow.due.paymentGroup })} />
                </div>
                <div className="lx-items-wrap">
                  <table className="lx-items" aria-label="Payroll items of the highlighted payment">
                    <thead>
                      <tr>
                        <th>PAYROLL ITEM</th>
                        <th className="lx-num">AMOUNT DUE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {hlRow.due.items.map((it) => (
                        <tr key={it.itemId}>
                          <td>{it.itemName}</td>
                          <td className="lx-num">{fmtMoney(it.amount)}</td>
                        </tr>
                      ))}
                      {!hlRow.due.items.length && (
                        <tr>
                          <td colSpan={2} className="lx-muted">
                            Paid in full.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="lx-panel-body lx-muted">Click a payment to see its payroll items, payee and due date rule.</div>
            )}
          </section>
          <section className="lx-panel">
            <div className="lx-panel-head">Payment</div>
            <div className="lx-panel-body lx-paybody">
              <Field label="Payment date" htmlFor="lx-pl-date" width={140}>
                <DateField id="lx-pl-date" name="date" value={date} onChange={setDate} required />
              </Field>
              <Field label="Bank account" htmlFor="lx-pl-bank" width={230} hint={bank ? `Ending balance ${fmtMoney(bank.balance)}` : undefined}>
                <AccountPicker
                  id="lx-pl-bank"
                  name="bankAccountId"
                  types={['Bank']}
                  value={bankId}
                  fallbackLabel={banksQ.isError && bankId ? 'Default payroll bank account' : undefined}
                  addNew={false}
                  onChange={(id) => {
                    setBankId(id);
                    setCheckTouched(false);
                  }}
                />
              </Field>
              <div className="lx-checkopts">
                <RadioGroup<'print' | 'assign'>
                  aria-label="Check numbers"
                  value={checkMode}
                  onChange={(v) => setCheckMode(v)}
                  options={[
                    { value: 'print', label: 'Print later' },
                    { value: 'assign', label: 'Number now' },
                  ]}
                />
                {checkMode === 'assign' && (
                  <TextField
                    name="firstCheckNumber"
                    aria-label="First check number"
                    title="First check number (later checks are numbered in order; e-payments get no number)"
                    value={checkNo}
                    width={90}
                    onChange={(v) => {
                      setCheckNo(v);
                      setCheckTouched(true);
                    }}
                  />
                )}
              </div>
            </div>
          </section>
        </div>
        <div className="lx-actions">
          <span className="lx-muted">
            {chosen.length
              ? `${chosen.length} selected: about ${agencies} payment${agencies === 1 ? '' : 's'} of ${fmtMoney(totalPay)} in total (one per payee and period).`
              : 'Tick the payments you want to make, then click Pay Selected.'}
          </span>
          <span className="lx-spacer" />
          <Button label="Close" onClick={() => void win.close()} />
          <Button variant="primary" icon={Wallet} label="&Pay Selected" busy={busy} disabled={!chosen.length} onClick={() => void pay()} />
        </div>
      </div>
    </FormErrorsProvider>
  );
}

function SummaryBody({ payments, problems, date, bankName, close }: { payments: LiabilityPayment[]; problems: SyncProblem[]; date: string; bankName: string; close: () => void }) {
  const total = sum2(payments.map((p) => p.amount));
  const problemOf = (id: Id) => problems.find((p) => p.id === id);
  return (
    <div className="lx-dlg">
      {problems.length ? (
        <div className="lx-note lx-warn">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>
            {payments.length} payment{payments.length === 1 ? ' was' : 's were'} recorded, but {problems.length === 1 ? 'one is' : `${problems.length} are`} not in SerieX Books yet. Fix the
            problem and retry from the payment or the SerieX Books Sync window.
          </span>
        </div>
      ) : (
        <div className="lx-note lx-ok">
          {payments.length} payment{payments.length === 1 ? ' was' : 's were'} recorded and posted to SerieX Books. The amounts owed are lower by {fmtMoney(total)}.
        </div>
      )}
      <dl className="lx-info">
        <dt>Payment date</dt>
        <dd>{fmtDate(date)}</dd>
        <dt>Bank account</dt>
        <dd>{bankName}</dd>
      </dl>
      <div className="lx-ctable-wrap">
        <table className="lx-ctable lx-summary">
          <thead>
            <tr>
              <th>NO.</th>
              <th>PAYEE</th>
              <th>PERIOD</th>
              <th>METHOD</th>
              <th className="lx-num">AMOUNT</th>
              <th>SERIEX BOOKS</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => {
              const pr = problemOf(p.id);
              return (
                <tr key={p.id} onClick={() => openWindow('liabilityPayment', { id: p.id, batch: payments.map((x) => x.id) })} title="Open this tax payment">
                  <td>{p.method === 'e-pay' ? 'E-pay' : p.toBePrinted ? 'To print' : p.checkNumber}</td>
                  <td>{p.agencyName}</td>
                  <td>{periodText('', p.periodStart, p.periodEnd)}</td>
                  <td>{METHOD_LABELS[p.method]}</td>
                  <td className="lx-num">{fmtMoney(p.amount)}</td>
                  <td className={pr || p.syncStatus === 'error' ? 'lx-danger' : undefined} title={pr?.message ?? p.syncError}>
                    {pr ? `Not posted: ${booksErr(pr.message)}` : p.syncStatus === 'posted' ? 'Posted' : p.syncStatus === 'error' ? `Not posted: ${booksErr(p.syncError)}` : 'Waiting'}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4} className="lx-strong">
                Total
              </td>
              <td className="lx-num lx-strong">{fmtMoney(total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="sx-dlg-buttons">
        <Button variant="primary" label="Close" onClick={close} />
        {problems.length > 0 && (
          <Button
            label="Open SerieX Books Sync"
            onClick={() => {
              openWindow('booksSync', { tab: 'pending' });
              close();
            }}
          />
        )}
      </div>
    </div>
  );
}
