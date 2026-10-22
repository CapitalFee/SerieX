// Pay Employees (Run Payroll for a pay schedule, Extra Paycheck, Final Paycheck), a three-step
// flow in one window:
//   (1) Hours and Pay: PERIOD END, CHECK DATE, BANK ACCOUNT + balance; grid ✓, EMPLOYEE, one
//       column per earnings item (hours, quantity or amount), TOTAL HOURS; Select All,
//       Paycheck Details…, Continue.
//   (2) Review: CHECK NUMBERS (print later / number now + first check number), grid
//       EMPLOYEE, GROSS PAY, TAXES, DEDUCTIONS, NET PAY, EMPLOYER TAXES, CONTRIBUTIONS, TOTAL
//       HOURS, DIRECT DEP. with totals; Create Paychecks.
//   (3) Done: Print Paychecks / Print Pay Stubs and the SerieX Books posting result (problems
//       open the Books Sync window).
// Run Payroll without a schedule first asks for the schedule; a final paycheck without
// employees first asks for the employees and the release date.
// All amounts come from POST /paychecks/calculate (debounced); the browser only adds hours.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, CheckCircle2, CheckSquare, ChevronLeft, FileText, Landmark, Printer, Square, UserMinus } from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll, useBooksAccounts, useEmployees, usePaychecks, useScheduledPayrolls } from '@/api/hooks';
import type { CreatePayrollRequest, CreatePayrollResult, Id, Paycheck, PaycheckInput, PaycheckLine, PayrollDraft, PayrollDraftEmployee, PayrollItem, RunKind } from '@/api/types';
import {
  AccountPicker,
  Button,
  DateField,
  EmptyState,
  ErrorBanner,
  Grid,
  ListView,
  RadioGroup,
  Spinner,
  StatusPill,
  TextField,
  confirmBox,
  useFormErrors,
  type GridColumn,
} from '@/components';
import { fmtDate, fmtMoney } from '@/util/format';
import { todayIso } from '@/util/dates';
import { useWindow } from '@/windows/WindowContext';
import { openRecord, openWindow } from '@/windows/windowStore';
import { CheckList } from './CheckList';
import { openPaycheckDetail } from './PaycheckDetail';
import {
  calculatePaycheck,
  checkNumberLabel,
  earningCell,
  errorText,
  fmtHours,
  inputKey,
  linesHours,
  nextCheckNumber,
  rememberPaycheck,
  sendableLines,
  showError,
  sum2,
  syncInfo,
  toInput,
} from './shared';
import './payroll.css';

export interface PayEmployeesProps {
  /** Kind of payroll run (default scheduled). */
  kind?: 'scheduled' | 'unscheduled' | 'termination';
  /** Pay schedule of a Run Payroll run. */
  scheduleId?: number;
  /** Employees to pay (unscheduled / termination). */
  employeeIds?: number[];
}

type Step = 'choose' | 'enter' | 'review' | 'done';

interface Row {
  employeeId: Id;
  name: string;
  selected: boolean;
  /** The employee is set up for direct deposit. */
  ddSetUp: boolean;
  warnings: string[];
  input: PaycheckInput;
  /** Last calculation and the input key it belongs to. */
  calc: Paycheck | null;
  calcKey: string;
  error: string | null;
  /** Changed by the user (shown pale yellow). */
  edited: boolean;
}

const STEP_TITLES: Record<Exclude<Step, 'choose'>, string> = {
  enter: 'Hours and Pay',
  review: 'Review',
  done: 'Done',
};

/** Name of each kind of run (window title and the run label). */
const RUN_TITLES: Record<RunKind, string> = {
  scheduled: 'Run Payroll',
  unscheduled: 'Extra Paycheck',
  termination: 'Final Paycheck',
};

function makeRow(e: PayrollDraftEmployee, d: PayrollDraft): Row {
  return {
    employeeId: e.employeeId,
    name: e.employeeName,
    selected: e.selected,
    ddSetUp: e.directDeposit,
    warnings: e.warnings ?? [],
    input: {
      id: 0,
      employeeId: e.employeeId,
      kind: 'regular',
      // a schedule has one period; otherwise the server starts the period by each employee's pay frequency
      periodStart: d.kind === 'scheduled' ? d.periodStart : '',
      periodEnd: d.periodEnd,
      checkDate: d.checkDate,
      bankAccountId: d.bankAccountId,
      checkNumber: '',
      toBePrinted: !e.directDeposit,
      directDeposit: e.directDeposit,
      memo: '',
      classId: null,
      noAccrual: false,
      lines: e.lines.map((l) => ({ ...l })),
      recalculate: true,
    },
    calc: null,
    calcKey: '',
    error: null,
    edited: false,
  };
}

const earningLines = (r: Row) => r.input.lines.filter((l) => l.category === 'earning' || l.itemType === '' || ['hourly', 'overtime', 'salary', 'bonus', 'commission', 'tips', 'reported_tips'].includes(l.itemType));

/** The current calculation of a row (null when its input changed since). */
const currentCalc = (r: Row) => (r.calc && r.calcKey === inputKey(r.input) ? r.calc : null);

export default function PayEmployees(props: PayEmployeesProps) {
  const win = useWindow();
  const kind: RunKind = props.kind ?? 'scheduled';
  const fe = useFormErrors();
  const { data: banks } = useBooksAccounts(['Bank']);

  const needSchedule = kind === 'scheduled' && !props.scheduleId;
  const needEmployees = kind === 'termination' && !(props.employeeIds && props.employeeIds.length);
  const [step, setStep] = useState<Step>(needSchedule || needEmployees ? 'choose' : 'enter');
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<PayrollDraft | null>(null);
  const [rows, setRowsState] = useState<Row[]>([]);
  const rowsRef = useRef<Row[]>([]);
  const [periodEnd, setPeriodEnd] = useState('');
  const [checkDate, setCheckDate] = useState('');
  const [bankAccountId, setBankAccountId] = useState<Id | null>(null);
  const [releaseDate, setReleaseDate] = useState(todayIso());
  const [printMode, setPrintMode] = useState<'print' | 'handwritten'>('print');
  const [firstNumber, setFirstNumber] = useState('');
  const [hl, setHl] = useState<Id | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CreatePayrollResult | null>(null);
  const [tick, setTick] = useState(0);
  const pending = useRef(new Map<Id, string>());

  const setRows = (fn: (rows: Row[]) => Row[]) => {
    const n = fn(rowsRef.current);
    rowsRef.current = n;
    setRowsState(n);
  };
  const updateRow = (id: Id, fn: (r: Row) => Row) => setRows((rs) => rs.map((r) => (r.employeeId === id ? fn(r) : r)));

  // ---- window title and close question
  useEffect(() => {
    win.setTitle(step === 'choose' ? RUN_TITLES[kind] : `${RUN_TITLES[kind]} - ${STEP_TITLES[step]}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  const edited = rows.some((r) => r.edited);
  useEffect(() => {
    const open = (step === 'enter' || step === 'review') && rows.length > 0;
    win.setDirty(open && edited);
    win.setBeforeClose(open ? async () => !rowsRef.current.some((r) => r.selected) || (await confirmBox('Close without creating the paychecks? The payroll information you entered is not kept.', 'Pay Employees')) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, rows.length, edited]);

  // ---- start (POST /payroll/start)
  const start = async (scheduleId: Id | null, employeeIds: Id[], release: string) => {
    setLoading(true);
    fe.clearAll();
    try {
      const d = await api.post<PayrollDraft>('/payroll/start', { kind, payScheduleId: scheduleId, employeeIds, periodEnd: '', checkDate: '', releaseDate: release });
      setDraft(d);
      setPeriodEnd(d.periodEnd);
      setCheckDate(d.checkDate);
      setBankAccountId(d.bankAccountId);
      setFirstNumber(d.nextCheckNumber);
      setRows(() => d.employees.map((e) => makeRow(e, d)));
      setStep('enter');
    } catch (e) {
      fe.fromError(e);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (!needSchedule && !needEmployees) void start(props.scheduleId ?? null, props.employeeIds ?? [], kind === 'termination' ? releaseDate : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // the window is reused when it is opened again for other employees (Employee Center "Pay
  // employee", Final Paycheck): start over with them, asking first when hours were typed
  const idsKey = (props.employeeIds ?? []).join(',');
  const firstIds = useRef(idsKey);
  useEffect(() => {
    if (idsKey === firstIds.current) return;
    firstIds.current = idsKey;
    if (!idsKey || kind === 'scheduled' || loading || busy) return;
    void (async () => {
      const typing = (step === 'enter' || step === 'review') && rowsRef.current.some((r) => r.edited);
      if (typing && !(await confirmBox('Start the payroll again with the employees you chose? The payroll information you entered is not kept.', 'Pay Employees'))) return;
      setResult(null);
      void start(null, props.employeeIds ?? [], kind === 'termination' ? releaseDate : '');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  // ---- calculations (debounced; only selected employees)
  const calcRow = (id: Id) => {
    const r = rowsRef.current.find((x) => x.employeeId === id);
    if (!r) return;
    const key = inputKey(r.input);
    pending.current.set(id, key);
    calculatePaycheck(r.input)
      .then((pc) => updateRow(id, (x) => (inputKey(x.input) === key ? { ...x, calc: pc, calcKey: key, error: null } : x)))
      .catch((e) => updateRow(id, (x) => (inputKey(x.input) === key ? { ...x, calc: null, calcKey: key, error: errorText(e) } : x)))
      .finally(() => {
        if (pending.current.get(id) === key) pending.current.delete(id);
        setTick((t) => t + 1);
      });
  };
  const needsCalc = (r: Row) => r.selected && r.calcKey !== inputKey(r.input) && pending.current.get(r.employeeId) !== inputKey(r.input);
  useEffect(() => {
    if (step !== 'enter' && step !== 'review') return;
    const need = rows.filter(needsCalc);
    if (!need.length) return;
    const t = window.setTimeout(() => need.forEach((r) => calcRow(r.employeeId)), 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, tick, step]);

  /** Calculates every selected employee now and waits; false when one failed. */
  const settle = async (): Promise<boolean> => {
    for (let i = 0; i < 300; i++) {
      const sel = rowsRef.current.filter((r) => r.selected);
      sel.filter(needsCalc).forEach((r) => calcRow(r.employeeId));
      const waiting = sel.some((r) => r.calcKey !== inputKey(r.input) || pending.current.has(r.employeeId));
      if (!waiting) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    const bad = rowsRef.current.filter((r) => r.selected && (r.error || !currentCalc(r)));
    if (bad.length) {
      fe.setMessage(bad.map((r) => `${r.name}: ${r.error ?? 'the paycheck could not be calculated.'}`).join('\n'));
      return false;
    }
    return true;
  };

  // ---- header changes apply to every paycheck of the run
  const changeHeader = (patch: Partial<PaycheckInput>) => setRows((rs) => rs.map((r) => ({ ...r, input: { ...r.input, ...patch } })));
  const onPeriodEnd = (d: string) => {
    if (!d || d === periodEnd) return;
    setPeriodEnd(d);
    // the server computes the period start from the employee's pay frequency
    changeHeader({ periodEnd: d, periodStart: '' });
  };
  const onCheckDate = (d: string) => {
    if (!d || d === checkDate) return;
    setCheckDate(d);
    changeHeader({ checkDate: d });
  };
  const onBank = (id: Id | null) => {
    setBankAccountId(id);
    changeHeader({ bankAccountId: id });
    void nextCheckNumber(id).then((n) => n && setFirstNumber(n));
  };

  // ---- earnings cells
  const lineFor = (r: Row, it: PayrollItem): PaycheckLine[] => r.input.lines.filter((l) => l.itemId === it.id);
  const cellValue = (r: Row, it: PayrollItem): number | null => {
    const ls = lineFor(r, it);
    if (!ls.length) return null;
    const c = earningCell(it.type, it.calc);
    if (c === 'amount') return ls.reduce((s, l) => s + (l.rate ?? l.amount ?? 0), 0) || null;
    const q = ls.reduce((s, l) => s + (l.qty ?? 0), 0);
    return ls.every((l) => l.qty === null) ? null : q;
  };
  const setCell = (r: Row, it: PayrollItem, v: number | null): Row => {
    const ls = lineFor(r, it);
    if (ls.length !== 1) return r;
    const c = earningCell(it.type, it.calc);
    const patch: Partial<PaycheckLine> = c === 'amount' ? { rate: v ?? 0, amount: v ?? 0, manual: false } : { qty: v, manual: false };
    return { ...r, edited: true, input: { ...r.input, lines: r.input.lines.map((l) => (l === ls[0] ? { ...l, ...patch } : l)) } };
  };

  const columns: GridColumn<Row>[] = useMemo(() => {
    const cols: GridColumn<Row>[] = [
      { key: 'selected', label: '✓', width: 34, editor: 'checkbox', title: 'Pay this employee' },
      {
        key: 'name',
        label: 'Employee',
        width: 210,
        render: (r) => (
          <button type="button" className="sx-linkbtn py-emplink" title="See the whole paycheck" onClick={() => void openDetail(r.employeeId)}>
            {r.name}
          </button>
        ),
      },
    ];
    for (const it of draft?.earningColumns ?? []) {
      const c = earningCell(it.type, it.calc);
      // the header tooltip gives each employee's rate of the item
      const rates = (draft?.employees ?? [])
        .map((e) => {
          const l = e.lines.find((x) => x.itemId === it.id);
          if (!l || l.rate === null) return null;
          const r = it.type === 'commission' && it.calc === 'quantity' ? `${l.rate}%` : it.type === 'salary' ? `${fmtMoney(l.rate)} a period` : fmtMoney(l.rate);
          return `${e.employeeName}: ${r}`;
        })
        .filter((x): x is string => !!x);
      cols.push({
        key: 'item:' + it.id,
        label: it.name,
        width: 104,
        align: 'right',
        title:
          `${it.name} — ${c === 'hours' ? 'hours' : c === 'qty' ? 'quantity (sales)' : 'amount'}${it.type === 'overtime' ? ` at ${it.rate || 1.5} × the regular rate` : ''}` +
          (rates.length ? `\nRate: ${rates.join(', ')}` : ''),
        editor: c === 'amount' ? 'money' : 'qty',
        nullable: true,
        get: (r) => cellValue(r, it),
        set: (r, v) => setCell(r, it, v as number | null),
        readOnly: (r) => lineFor(r, it).length !== 1,
        render: (r) => {
          const ls = lineFor(r, it);
          if (!ls.length) return <span className="py-na-cell" aria-label="Not used by this employee" />;
          const v = cellValue(r, it);
          return c === 'amount' ? fmtMoney(v, { blankZero: true }) : c === 'hours' ? fmtHours(v, true) : v === null ? '' : String(v);
        },
      });
    }
    cols.push({ key: 'hours', label: 'Total Hours', width: 96, align: 'right', render: (r) => fmtHours(linesHours(earningLines(r))) });
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  // ---- Paycheck Details (Save & Previous / Save & Next walk the employees to pay)
  const openDetail = async (employeeId: Id) => {
    let current = employeeId;
    for (;;) {
      const row = rowsRef.current.find((r) => r.employeeId === current);
      if (!row) return;
      let pc = currentCalc(row);
      if (!pc) {
        try {
          pc = await calculatePaycheck(row.input);
        } catch (e) {
          await showError(e, 'Paycheck Details');
          return;
        }
      }
      const order = rowsRef.current.filter((r) => r.selected || r.employeeId === current).map((r) => r.employeeId);
      const i = order.indexOf(current);
      const res = await openPaycheckDetail({ paycheck: pc, inputLines: row.input.lines, hasPrev: i > 0, hasNext: i < order.length - 1 });
      if (res.action === 'cancel' || !res.paycheck) return;
      const saved = res.paycheck;
      const input = toInput(saved, { id: 0, recalculate: true });
      updateRow(current, (r) => ({ ...r, input, calc: saved, calcKey: inputKey(input), error: null, selected: true, edited: r.edited || res.changed }));
      if (res.action === 'close') return;
      const next = order[i + (res.action === 'next' ? 1 : -1)];
      if (next === undefined) return;
      current = next;
    }
  };

  // ---- step navigation
  const selected = rows.filter((r) => r.selected);
  const toReview = async () => {
    fe.clearAll();
    if (!selected.length) {
      fe.setMessage('Select at least one employee to pay (tick the box in the ✓ column).');
      return;
    }
    if (!bankAccountId) {
      fe.setFieldError('bankAccountId', 'Choose the bank account the paychecks are drawn on.');
      return;
    }
    setBusy(true);
    const ok = await settle();
    setBusy(false);
    if (ok) setStep('review');
  };

  const create = async () => {
    fe.clearAll();
    if (!bankAccountId) {
      fe.setFieldError('bankAccountId', 'Choose the bank account the paychecks are drawn on.');
      return;
    }
    if (printMode === 'handwritten' && !/\d$/.test(firstNumber.trim())) {
      fe.setFieldError('firstCheckNumber', 'Enter the first check number (it must end with a number).');
      return;
    }
    setBusy(true);
    try {
      if (!(await settle())) return;
      const sel = rowsRef.current.filter((r) => r.selected);
      const negative = sel.filter((r) => (currentCalc(r)?.net ?? 0) < 0);
      if (negative.length) {
        fe.setMessage(
          negative
            .map((r) => `Net pay cannot be less than zero. The paycheck of ${r.name} has a net pay of ${fmtMoney(currentCalc(r)!.net)}; reduce its deductions or taxes.`)
            .join('\n'),
        );
        return;
      }
      const first = currentCalc(sel[0]);
      const req: CreatePayrollRequest = {
        kind,
        payScheduleId: draft?.payScheduleId ?? null,
        periodStart: first?.periodStart ?? draft?.periodStart ?? '',
        periodEnd,
        checkDate,
        bankAccountId,
        printMode,
        firstCheckNumber: printMode === 'handwritten' ? firstNumber.trim() : '',
        // each paycheck keeps its own period (employees of an extra paycheck run may have different pay frequencies)
        paychecks: sel.map((r) => ({
          ...r.input,
          periodStart: r.input.periodStart || currentCalc(r)?.periodStart || '',
          bankAccountId,
          lines: sendableLines(r.input.lines),
          recalculate: true,
        })),
        ...(kind === 'termination' ? { releaseDate } : {}),
      };
      const res = await api.post<CreatePayrollResult>('/payroll/create', req);
      res.paychecks.forEach((p) => rememberPaycheck(p));
      setResult(res);
      setStep('done');
      win.setDirty(false);
      win.setBeforeClose(null);
      void invalidateAll();
    } catch (e) {
      fe.fromError(e);
    } finally {
      setBusy(false);
    }
  };

  // ---- render
  const bank = banks?.find((a) => a.id === bankAccountId);
  const steps = (
    <ol className="py-steps" aria-label="Steps">
      {(['enter', 'review', 'done'] as const).map((s, i) => (
        <li key={s} className={step === s ? 'py-on' : (['enter', 'review', 'done'].indexOf(step) > i ? 'py-past' : '')}>
          <span className="py-stepnum">{i + 1}</span>
          {STEP_TITLES[s]}
        </li>
      ))}
    </ol>
  );
  const banner = (fe.message || Object.keys(fe.errors).length > 0) && <ErrorBanner className="py-banner" errors={fe.errors} message={fe.message} onDismiss={() => fe.clearAll()} />;

  if (step === 'choose') {
    return kind === 'termination' ? (
      <ChooseEmployees
        releaseDate={releaseDate}
        onReleaseDate={setReleaseDate}
        banner={banner}
        loading={loading}
        onCancel={() => void win.close()}
        onContinue={(ids) => void start(null, ids, releaseDate)}
      />
    ) : (
      <ChooseSchedule banner={banner} loading={loading} onCancel={() => void win.close()} onStart={(id) => void start(id, [], '')} />
    );
  }

  if (loading || !draft) {
    return (
      <div className="py-page">
        {steps}
        {banner || <Spinner center label="Getting the payroll ready…" />}
      </div>
    );
  }

  // the pay period of the selected paychecks (one per pay frequency in an extra paycheck run)
  const starts = [...new Set(selected.map((r) => currentCalc(r)?.periodStart).filter((d): d is string => !!d))];
  const periodText =
    starts.length === 1 ? `Pay period ${fmtDate(starts[0])} – ${fmtDate(periodEnd)}` : starts.length > 1 ? `Pay periods by pay frequency, ending ${fmtDate(periodEnd)}` : '';
  const scheduleLabel = kind === 'scheduled' ? `PAY SCHEDULE: ${draft.scheduleName}` : RUN_TITLES[kind].toUpperCase();
  const info = (readOnlyDates: boolean) => (
    <section className="py-info" aria-label="This payroll">
      <div className="py-info-title">This Payroll</div>
      <div className="py-info-cols">
        <div className="py-info-col">
          <div className="py-info-strong">{scheduleLabel}</div>
          <div className="py-muted">
            {readOnlyDates ? 'PAYCHECKS' : 'EMPLOYEES TO PAY'}: <b>{selected.length}</b>
          </div>
          {periodText && <div className="py-muted py-small">{periodText}</div>}
        </div>
        <div className="py-info-col py-info-dates">
          <label className="sx-label" htmlFor={`${win.id}-pe`}>
            PERIOD END
          </label>
          {readOnlyDates ? <span className="py-ro">{fmtDate(periodEnd)}</span> : <DateField id={`${win.id}-pe`} name="periodEnd" required value={periodEnd} onChange={onPeriodEnd} width={140} />}
          <label className="sx-label" htmlFor={`${win.id}-cd`}>
            CHECK DATE
          </label>
          {readOnlyDates ? <span className="py-ro">{fmtDate(checkDate)}</span> : <DateField id={`${win.id}-cd`} name="checkDate" required value={checkDate} onChange={onCheckDate} width={140} />}
          {kind === 'termination' && (
            <>
              <label className="sx-label" htmlFor={`${win.id}-rd`}>
                RELEASE DATE
              </label>
              {readOnlyDates ? <span className="py-ro">{fmtDate(releaseDate)}</span> : <DateField id={`${win.id}-rd`} name="releaseDate" required value={releaseDate} onChange={(d) => d && setReleaseDate(d)} width={140} />}
            </>
          )}
        </div>
        <div className="py-info-col py-info-bank">
          <label className="sx-label" htmlFor={`${win.id}-bank`}>
            BANK ACCOUNT
          </label>
          <AccountPicker id={`${win.id}-bank`} name="bankAccountId" types={['Bank']} addNew={false} value={bankAccountId} onChange={(id) => onBank(id)} width={230} />
          <div className="py-muted">
            BALANCE: <b className={(bank?.balance ?? 0) < 0 ? 'py-neg' : undefined}>{bank ? fmtMoney(bank.balance) : '—'}</b>
          </div>
        </div>
      </div>
    </section>
  );

  // ---- step 1
  if (step === 'enter') {
    const allOn = rows.length > 0 && rows.every((r) => r.selected);
    const warnings = rows.filter((r) => r.selected).flatMap((r) => [...r.warnings, ...(currentCalc(r)?.warnings ?? []).map((w) => `${r.name}: ${w}`), ...(r.error ? [`${r.name}: ${r.error}`] : [])]);
    return (
      <div className="py-page py-enter">
        {steps}
        {info(false)}
        {banner}
        <div className="py-bar">
          <Button small variant="ghost" icon={allOn ? Square : CheckSquare} label={allOn ? 'Clear All' : 'Select All'} onClick={() => setRows((rs) => rs.map((r) => ({ ...r, selected: !allOn })))} />
          <Button
            small
            icon={FileText}
            label="Paycheck &Details…"
            disabled={!rows.length}
            onClick={() => void openDetail(hl ?? selected[0]?.employeeId ?? rows[0].employeeId)}
          />
          <span className="py-grow" />
          <span className="py-muted py-small">Type hours (or amounts) for each employee. Click a name to see the whole paycheck.</span>
        </div>
        <div className="py-gridwrap">
          {rows.length === 0 ? (
            <EmptyState
              title="No employees to pay"
              message={kind === 'scheduled' ? 'No active employee uses this pay schedule. Give employees the schedule on their Payroll Info tab.' : 'There are no active employees.'}
              action={{ label: 'Employee Center', onClick: () => openWindow('employeeCenter', { tab: 'employees' }) }}
            />
          ) : (
            <Grid<Row>
              aria-label="Employees to pay"
              columns={columns}
              rows={rows}
              onChange={(rs) => setRows(() => rs)}
              onRowChange={(next, prev, key) => (key === 'selected' && next.selected !== prev.selected ? { ...next, edited: true } : next)}
              newRow={() => rows[0]}
              allowAdd={false}
              allowInsertDelete={false}
              enterMoves="down"
              minRows={8}
              persistKey="py-payemp"
              rowClassName={(r) => (r.edited ? 'py-row-edited' : r.selected ? undefined : 'py-row-off')}
              onActiveRowChange={(i) => i !== null && rows[i] && setHl(rows[i].employeeId)}
              contextMenu={(r) => (r ? [{ label: 'Paycheck Details…', onClick: () => void openDetail(r.employeeId) }] : [])}
            />
          )}
        </div>
        {warnings.length > 0 && (
          <div className="py-warnings">
            <ul>
              {warnings.slice(0, 6).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="py-foot">
          <span className="py-muted">
            {selected.length} of {rows.length} employee{rows.length === 1 ? '' : 's'} selected · {fmtHours(sum2(selected.map((r) => linesHours(earningLines(r)))))} hours
          </span>
          <span className="py-grow" />
          <Button label="Cancel" onClick={() => void win.close()} />
          <Button variant="primary" label="&Continue" busy={busy} disabled={!selected.length} onClick={() => void toReview()} />
        </div>
      </div>
    );
  }

  // ---- step 2
  if (step === 'review') {
    const calcs = selected.map((r) => ({ r, pc: currentCalc(r) }));
    const tot = (f: (p: Paycheck) => number) => sum2(calcs.map((c) => (c.pc ? f(c.pc) : 0)));
    const warnings = calcs.flatMap((c) => (c.pc?.warnings ?? []).map((w) => `${c.r.name}: ${w}`));
    return (
      <div className="py-page py-review">
        {steps}
        {info(true)}
        <section className="py-options" aria-label="Check numbers">
          <div className="py-info-title">Check Numbers</div>
          <div className="py-options-row">
            <RadioGroup
              row
              aria-label="Check numbers"
              value={printMode}
              onChange={(v) => setPrintMode(v)}
              options={[
                { value: 'print', label: 'Print the checks later' },
                { value: 'handwritten', label: 'Number them now (handwritten checks)' },
              ]}
            />
            <label className="sx-label" htmlFor={`${win.id}-first`}>
              FIRST CHECK NUMBER
            </label>
            <TextField id={`${win.id}-first`} name="firstCheckNumber" value={firstNumber} onChange={setFirstNumber} width={100} disabled={printMode !== 'handwritten'} />
            <span className="py-grow" />
            <Button
              small
              icon={FileText}
              label="Paycheck &Details…"
              onClick={() => void openDetail((selected.find((r) => r.employeeId === hl) ?? selected[0]).employeeId)}
            />
          </div>
          <div className="py-muted py-small">
            {printMode === 'print'
              ? 'The paychecks wait in the list of checks to print (File > Print > Paychecks). Direct deposit paychecks are never printed.'
              : 'Each paycheck gets the next check number, starting with the first check number. Direct deposit paychecks are numbered DD.'}
          </div>
        </section>
        {banner}
        <div className="py-gridwrap">
          <table className="py-table" aria-label="Paychecks to create">
            <thead>
              <tr>
                <th>Employee</th>
                <th className="py-r">Gross Pay</th>
                <th className="py-r">Taxes</th>
                <th className="py-r">Deductions</th>
                <th className="py-r">Net Pay</th>
                <th className="py-r">Employer Taxes</th>
                <th className="py-r">Contributions</th>
                <th className="py-r">Total Hours</th>
                <th className="py-r">Direct Dep.</th>
              </tr>
            </thead>
            <tbody>
              {calcs.map(({ r, pc }) => (
                <tr key={r.employeeId} className={r.edited ? 'py-row-edited' : undefined} onDoubleClick={() => void openDetail(r.employeeId)} onClick={() => setHl(r.employeeId)}>
                  <td>
                    <button type="button" className="sx-linkbtn py-emplink" onClick={() => void openDetail(r.employeeId)}>
                      {r.name}
                    </button>
                  </td>
                  <td className="py-r">{pc ? fmtMoney(pc.gross) : '…'}</td>
                  <td className="py-r">{pc ? fmtMoney(-pc.employeeTaxes) : ''}</td>
                  <td className="py-r">{pc ? fmtMoney(-pc.deductions) : ''}</td>
                  <td className="py-r py-strong">{pc ? fmtMoney(pc.net) : ''}</td>
                  <td className="py-r">{pc ? fmtMoney(pc.employerTaxes) : ''}</td>
                  <td className="py-r">{pc ? fmtMoney(pc.contributions) : ''}</td>
                  <td className="py-r">{pc ? fmtHours(pc.totalHours) : ''}</td>
                  <td className="py-r">{pc && r.input.directDeposit ? fmtMoney(pc.net) : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Totals</td>
                <td className="py-r">{fmtMoney(tot((p) => p.gross))}</td>
                <td className="py-r">{fmtMoney(-tot((p) => p.employeeTaxes))}</td>
                <td className="py-r">{fmtMoney(-tot((p) => p.deductions))}</td>
                <td className="py-r">{fmtMoney(tot((p) => p.net))}</td>
                <td className="py-r">{fmtMoney(tot((p) => p.employerTaxes))}</td>
                <td className="py-r">{fmtMoney(tot((p) => p.contributions))}</td>
                <td className="py-r">{fmtHours(tot((p) => p.totalHours))}</td>
                <td className="py-r">{fmtMoney(sum2(calcs.filter((c) => c.r.input.directDeposit && c.pc).map((c) => c.pc!.net)))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        {warnings.length > 0 && (
          <div className="py-warnings">
            <ul>
              {warnings.slice(0, 6).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="py-foot">
          <Button
            icon={ChevronLeft}
            label="&Back"
            disabled={busy}
            onClick={() => {
              fe.clearAll();
              setStep('enter');
            }}
          />
          <span className="py-grow" />
          <span className="py-muted">
            {selected.length} paycheck{selected.length === 1 ? '' : 's'} · net pay {fmtMoney(tot((p) => p.net))}
          </span>
          <Button label="Cancel" disabled={busy} onClick={() => void win.close()} />
          <Button variant="primary" label="Create &Paychecks" busy={busy} onClick={() => void create()} />
        </div>
      </div>
    );
  }

  // ---- step 3
  return <Confirmation result={result!} kind={kind} bankAccountId={bankAccountId} printMode={printMode} steps={steps} rows={rows} onClose={() => void win.close(true)} />;
}

// ---------------------------------------------------------------------------
// Step 3: Done

function Confirmation({
  result,
  kind,
  bankAccountId,
  printMode,
  steps,
  rows,
  onClose,
}: {
  result: CreatePayrollResult;
  kind: RunKind;
  bankAccountId: Id | null;
  printMode: 'print' | 'handwritten';
  steps: React.ReactNode;
  rows: Row[];
  onClose: () => void;
}) {
  // the paychecks as they are now (printed, voided, deleted or posted since), in the order created
  const { data: live } = usePaychecks({ runId: result.runId, includeVoided: true }, { enabled: result.runId > 0 });
  const list = useMemo(() => {
    if (!live) return result.paychecks;
    const order = new Map(result.paychecks.map((p, i) => [p.id, i]));
    return live.filter((p) => order.has(p.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  }, [live, result.paychecks]);
  const created = result.paychecks.length;
  const valid = list.filter((p) => !p.voided);
  const voided = list.length - valid.length;
  const dd = valid.filter((p) => p.directDeposit);
  const toPrint = valid.filter((p) => p.toBePrinted);
  const numbered = valid.filter((p) => !p.directDeposit && !p.toBePrinted);
  const ids = valid.map((p) => p.id);
  // posting problems still open (a retry from Books Sync or the paycheck clears them)
  const unposted = valid.filter((p) => p.syncStatus === 'pending' || p.syncStatus === 'error');
  const posted = valid.filter((p) => p.syncStatus === 'posted').length;
  const problems = live
    ? unposted.map((p) => result.problems.find((x) => x.entity === 'paycheck' && x.id === p.id) ?? { entity: 'paycheck' as const, id: p.id, label: `Paycheck - ${p.employeeName}`, code: 'error', message: p.syncError || 'Not posted yet.' })
    : result.problems;
  const [inactive, setInactive] = useState<Set<Id>>(new Set());
  const makeInactive = async (id: Id, name: string) => {
    try {
      await api.put(`/employees/${id}/active`, { active: false });
      setInactive((s) => new Set(s).add(id));
      void invalidateAll();
    } catch (e) {
      await showError(e, `Make ${name} inactive`);
    }
  };
  return (
    <div className="py-page py-done">
      {steps}
      <div className="py-done-body">
        <div className="py-done-head">
          <CheckCircle2 size={28} className="py-ok" aria-hidden="true" />
          <div>
            <div className="py-done-title">
              {created} paycheck{created === 1 ? '' : 's'} created:
            </div>
            <ul className="py-done-counts">
              {toPrint.length > 0 && <li>{toPrint.length} for printing</li>}
              {numbered.length > 0 && (
                <li>
                  {numbered.length} {printMode === 'handwritten' ? 'handwritten' : 'printed'} (check {numbered[0].checkNumber}
                  {numbered.length > 1 ? ` – ${numbered[numbered.length - 1].checkNumber}` : ''})
                </li>
              )}
              {voided > 0 && <li>{voided} voided since</li>}
              {list.length < created && <li>{created - list.length} deleted since</li>}
              <li>{dd.length} for direct deposit</li>
            </ul>
          </div>
        </div>

        <section className="py-panel py-next">
          <div className="py-panel-head">What to do next</div>
          <div className="py-next-body">
            <Printer size={22} aria-hidden="true" className="py-muted" />
            <span>Print the paychecks or pay stubs and hand them to your employees.</span>
            <span className="py-grow" />
            <Button
              variant={toPrint.length ? 'primary' : 'secondary'}
              icon={Printer}
              label="Print Pa&ychecks"
              disabled={!toPrint.length}
              title={toPrint.length ? undefined : printMode === 'handwritten' ? 'The paychecks have check numbers (handwritten).' : 'No paycheck is waiting to be printed.'}
              onClick={() => openWindow('printPaychecks', { ids: toPrint.map((p) => p.id), bankAccountId: bankAccountId ?? undefined })}
            />
            <Button icon={FileText} label="Print Pay &Stubs" disabled={!ids.length} onClick={() => openWindow('printPayStubs', { ids })} />
          </div>
        </section>

        <section className={'py-panel py-posting' + (problems.length ? ' py-posting-bad' : '')}>
          <div className="py-panel-head">
            <Landmark size={15} aria-hidden="true" /> SerieX Books
          </div>
          <div className="py-panel-body">
            {problems.length === 0 && valid.length > 0 && valid.every((p) => p.syncStatus === 'none') ? (
              <div>The paychecks are not posted to SerieX Books: posting is turned off in Preferences (SerieX Books).</div>
            ) : problems.length === 0 ? (
              <div>
                {posted} of {valid.length} paycheck{valid.length === 1 ? ' is' : 's are'} posted to the SerieX Books check register.
              </div>
            ) : (
              <>
                <div>
                  {posted} of {valid.length} paychecks are posted to SerieX Books. The paychecks below are saved in SerieX Payroll but not posted yet:
                </div>
                <ul className="py-problems">
                  {problems.map((p, i) => (
                    <li key={i}>
                      <b>{p.label}</b>: {p.message}
                    </li>
                  ))}
                </ul>
                <Button small icon={Landmark} label="Open SerieX Books Sync" onClick={() => openWindow('booksSync', { tab: 'pending' })} />
              </>
            )}
          </div>
        </section>

        <table className="py-table py-created" aria-label="Paychecks created">
          <thead>
            <tr>
              <th>Date</th>
              <th>Num</th>
              <th>Employee</th>
              <th className="py-r">Net Pay</th>
              <th>SerieX Books</th>
              {kind === 'termination' && <th />}
            </tr>
          </thead>
          <tbody>
            {list.map((p) => {
              const s = syncInfo(p);
              return (
                <tr key={p.id} onDoubleClick={() => openRecord('paycheck', p.id)} title="Double-click to open the paycheck">
                  <td>{fmtDate(p.checkDate)}</td>
                  <td>{checkNumberLabel(p)}</td>
                  <td>
                    <button type="button" className="sx-linkbtn" onClick={() => openRecord('paycheck', p.id)}>
                      {p.employeeName}
                    </button>
                  </td>
                  <td className="py-r">{fmtMoney(p.net)}</td>
                  <td>
                    <StatusPill status={s.label} tone={s.tone} />
                  </td>
                  {kind === 'termination' && (
                    <td>
                      {inactive.has(p.employeeId) ? (
                        <span className="py-muted">Inactive</span>
                      ) : (
                        <button type="button" className="sx-linkbtn" onClick={() => void makeInactive(p.employeeId, p.employeeName)}>
                          <UserMinus size={13} aria-hidden="true" /> Make inactive
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="py-done-links">
          <button type="button" className="sx-linkbtn" onClick={() => openWindow('payLiabilities')}>
            Pay the payroll taxes now
          </button>
          {rows.some((r) => !r.selected) && <span className="py-muted py-small">Employees you did not check were not paid.</span>}
        </div>
      </div>
      <div className="py-foot">
        <span className="py-grow" />
        <Button variant="primary" label="Close" onClick={onClose} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Choosing the schedule / the employees

function ChooseSchedule({ banner, loading, onStart, onCancel }: { banner: React.ReactNode; loading: boolean; onStart: (id: Id) => void; onCancel: () => void }) {
  const { data, isLoading } = useScheduledPayrolls();
  const [sel, setSel] = useState<Id | null>(null);
  const rows = data ?? [];
  useEffect(() => {
    if (sel === null && rows.length) setSel(rows[0].payScheduleId);
  }, [rows, sel]);
  return (
    <div className="py-page">
      <div className="py-choose-head">
        <CalendarClock size={20} aria-hidden="true" />
        <div>
          <div className="py-choose-title">Which pay schedule do you want to pay?</div>
          <div className="py-muted">Each pay schedule groups the employees paid on the same dates.</div>
        </div>
      </div>
      {banner}
      <div className="py-gridwrap">
        {!isLoading && rows.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title="No payrolls to run"
            message="No active pay schedule has active employees. Pay employees with an extra paycheck, or give your employees a pay schedule."
            action={{ label: 'Extra paycheck', onClick: () => openWindow('payEmployees', { kind: 'unscheduled' }) }}
          />
        ) : (
          <ListView
            aria-label="Payrolls of the pay schedules"
            loading={isLoading}
            rows={rows}
            getKey={(r) => r.payScheduleId}
            selectedKey={sel}
            onSelect={(k) => setSel(k as Id)}
            onActivate={(r) => onStart(r.payScheduleId)}
            autoFocus
            columns={[
              { key: 'name', label: 'Schedule Name', width: 200, grow: true },
              { key: 'period', label: 'Pay Period', width: 200, render: (r) => `${fmtDate(r.periodStart)} – ${fmtDate(r.periodEnd)}` },
              { key: 'checkDate', label: 'Check Date', width: 110, type: 'date' },
              { key: 'status', label: 'Status', width: 110, render: (r) => <StatusPill status={r.status} tone={r.status === 'Overdue' ? 'danger' : r.status === 'Due' ? 'warning' : 'neutral'} /> },
              { key: 'employeeCount', label: 'Employees', width: 90, align: 'right' },
            ]}
          />
        )}
      </div>
      <div className="py-foot">
        <span className="py-grow" />
        <Button label="Cancel" onClick={onCancel} />
        <Button variant="primary" label="&Start Payroll" busy={loading} disabled={sel === null} onClick={() => sel !== null && onStart(sel)} />
      </div>
    </div>
  );
}

function ChooseEmployees({
  releaseDate,
  onReleaseDate,
  banner,
  loading,
  onContinue,
  onCancel,
}: {
  releaseDate: string;
  onReleaseDate: (d: string) => void;
  banner: React.ReactNode;
  loading: boolean;
  onContinue: (ids: Id[]) => void;
  onCancel: () => void;
}) {
  const { data, isLoading } = useEmployees({ active: 'active' });
  const rows = data ?? [];
  const [checked, setChecked] = useState<Set<Id>>(new Set());
  return (
    <div className="py-page">
      <div className="py-choose-head">
        <UserMinus size={20} aria-hidden="true" />
        <div>
          <div className="py-choose-title">Final Paycheck</div>
          <div className="py-muted">Tick the employees who are leaving. Their release date (last day on payroll) is saved on their Employment Info tab when the paychecks are created.</div>
        </div>
        <span className="py-grow" />
        <div className="py-choose-date">
          <label className="sx-label" htmlFor="py-term-release">
            RELEASE DATE
          </label>
          <DateField id="py-term-release" required value={releaseDate} onChange={(d) => d && onReleaseDate(d)} width={140} />
        </div>
      </div>
      {banner}
      <div className="py-gridwrap">
        {isLoading ? (
          <Spinner center label="Loading employees…" />
        ) : (
          <CheckList
            aria-label="Employees"
            rows={rows}
            getKey={(e) => e.id}
            checked={checked}
            autoFocus
            onToggle={(id) =>
              setChecked((c) => {
                const n = new Set(c);
                if (n.has(id)) n.delete(id);
                else n.add(id);
                return n;
              })
            }
            columns={[
              { key: 'displayName', label: 'Employee', width: 220, grow: true },
              { key: 'payScheduleName', label: 'Pay Schedule', width: 150 },
              { key: 'hireDate', label: 'Hire Date', width: 110, type: 'date' },
              { key: 'lastCheckDate', label: 'Last Paycheck', width: 120, type: 'date' },
            ]}
            emptyText="There are no active employees."
          />
        )}
      </div>
      <div className="py-foot">
        <span className="py-muted">{checked.size} selected</span>
        <span className="py-grow" />
        <Button label="Cancel" onClick={onCancel} />
        <Button variant="primary" label="&Continue" busy={loading} disabled={!checked.size} onClick={() => onContinue(rows.filter((e) => checked.has(e.id)).map((e) => e.id))} />
      </div>
    </div>
  );
}
