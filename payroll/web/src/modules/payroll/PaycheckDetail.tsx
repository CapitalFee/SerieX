// Paycheck Details (a dialog in Pay Employees, a window for a saved paycheck):
//   header: employee, PAY PERIOD, check date, Pay by direct deposit, Class
//   Earnings grid (ITEM NAME, RATE, HOURS, CUSTOMER:JOB, CLASS) + sick/vacation block
//   Additions and Deductions grid (ITEM NAME, RATE, QUANTITY)
//   Company Costs and Employee Pay and Taxes (ITEM NAME, AMOUNT, YTD): typing an amount makes the
//   line manual (marked ✎, the heading says "(adjusted)"); right click → Use calculated amount.
// Every change is recalculated by the server (POST /paychecks/calculate, debounced); the
// browser never computes amounts. A saved paycheck keeps its amounts (Recalculate off) until an
// earnings line or another payroll item changes; a typed tax only changes that tax and net pay.
// Used inside a dialog by Pay Employees (draft paychecks) and by the paycheckDetail window
// (saved paychecks).
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, PencilLine } from 'lucide-react';
import { useEmployee, useItemsById, usePrefValues } from '@/api/hooks';
import { WAGE_TYPES, type Id, type ItemType, type Paycheck, type PaycheckInput, type PaycheckLine, type PayrollItem, type SummaryRow } from '@/api/types';
import {
  Button,
  Checkbox,
  ClassPicker,
  DateField,
  ErrorBanner,
  Grid,
  JobPicker,
  PayrollItemPicker,
  Spinner,
  alertBox,
  confirmBox,
  showDialog,
  type GridColumn,
} from '@/components';
import { fmtDate, fmtMoney, fmtQty } from '@/util/format';
import { calculatePaycheck, errorText, fmtHours, newLine, sendableLines, signedAmount, sum2, toInput } from './shared';
import './payroll.css';

/** Button that closed the editor. */
export type DetailAction = 'prev' | 'next' | 'close' | 'cancel';

export interface PaycheckDetailProps {
  /** The paycheck to edit: a calculated draft (id 0) or a saved paycheck. */
  paycheck: Paycheck;
  /** "draft": Save & Previous / Save & Next / Save & Close / Cancel; "saved": OK / Cancel. */
  mode?: 'draft' | 'saved';
  hasPrev?: boolean;
  hasNext?: boolean;
  /**
   * Called with the button and the edited, recalculated paycheck (null on Cancel) and whether
   * anything changed. In "saved" mode a promise keeps the buttons busy while the parent saves;
   * reject it (or resolve false) to keep the editor open.
   */
  onDone(action: DetailAction, pc: Paycheck | null, changed: boolean): void | boolean | Promise<void | boolean>;
  /** Reports unsaved changes (the window marks itself dirty). */
  onDirtyChange?(dirty: boolean): void;
  /** Shown inside a dialog (limits the height). */
  inDialog?: boolean;
  /**
   * Lines the paycheck was calculated from (Pay Employees): earnings items without hours that
   * the calculation left out still show in the Earnings grid, ready for hours.
   */
  inputLines?: PaycheckLine[];
}

const OTHER_TYPES: ItemType[] = ['addition', 'deduction', 'contribution', 'other_tax'];

type Header = Omit<PaycheckInput, 'lines'>;

interface Lines {
  earn: PaycheckLine[];
  other: PaycheckLine[];
  tax: PaycheckLine[];
}

/** Which part of the editor a line belongs to. */
function partOf(l: Pick<PaycheckLine, 'category' | 'itemType'>): keyof Lines {
  if (l.category === 'earning' || (l.itemType && (WAGE_TYPES as string[]).includes(l.itemType))) return 'earn';
  if (l.itemType === 'other_tax' || l.category === 'addition' || l.category === 'deduction' || l.category === 'contribution') return 'other';
  return 'tax';
}

function split(lines: PaycheckLine[]): Lines {
  const out: Lines = { earn: [], other: [], tax: [] };
  for (const l of lines) out[partOf(l)].push({ ...l });
  return out;
}

const allLines = (ls: Lines) => [...ls.earn, ...ls.other, ...ls.tax];

/**
 * Merges a calculation into the lines being edited: earnings lines keep their order (a line the
 * server dropped because it has no hours yet stays in the grid), the other items and taxes are
 * the calculated ones, and rows without an item stay where they are.
 */
function mergeCalc(prev: Lines, pc: Paycheck): Lines {
  const calc = split(pc.lines);
  const used = new Set<number>();
  let pos = 0;
  const earn = prev.earn.map((l) => {
    if (l.itemId <= 0) return l;
    for (let i = pos; i < calc.earn.length; i++) {
      if (!used.has(i) && calc.earn[i].itemId === l.itemId) {
        used.add(i);
        pos = i + 1;
        return { ...calc.earn[i] };
      }
    }
    return l;
  });
  calc.earn.forEach((l, i) => {
    if (!used.has(i)) earn.push({ ...l });
  });
  return { earn, other: [...calc.other, ...prev.other.filter((l) => l.itemId <= 0)], tax: calc.tax };
}

function headerOf(pc: PaycheckInput): Header {
  const { lines: _lines, ...h } = toInput(pc);
  return h;
}

/** Rate shown with at least 2 decimals ("25.00", "37.5000" → "37.50", "0.655"). */
function fmtRate(r: number | null | undefined): string {
  if (r === null || r === undefined) return '';
  const s = fmtQty(r);
  const dot = s.indexOf('.');
  if (dot < 0) return s + '.00';
  return s.length - dot - 1 < 2 ? s + '0' : s;
}

/** The Paycheck Details editor. */
export function PaycheckDetail(props: PaycheckDetailProps) {
  const mode = props.mode ?? 'draft';
  const prefs = usePrefValues();
  const items = useItemsById();
  const { data: emp } = useEmployee(props.paycheck.employeeId);

  const [pc, setPc] = useState<Paycheck>(props.paycheck);
  const [header, setHeader] = useState<Header>(() => headerOf(props.paycheck));
  const [lines, setLines] = useState<Lines>(() => (props.inputLines ? mergeCalc(split(props.inputLines), props.paycheck) : split(props.paycheck.lines)));
  const [dirty, setDirtyState] = useState(false);
  const [calcBusy, setCalcBusy] = useState(false);
  const [calcError, setCalcError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const headerRef = useRef(header);
  headerRef.current = header;
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const seq = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const inflight = useRef<Promise<Paycheck | null> | null>(null);
  const lastGood = useRef<Paycheck>(props.paycheck);
  const errRef = useRef<string | null>(null);
  /**
   * Whether the amounts are calculated again (Recalculate). A draft always is. A saved paycheck
   * keeps its amounts (taxes included) until an earnings line or another payroll item changes;
   * typing a summary amount or changing the header leaves the other amounts as they were saved.
   */
  const recalcRef = useRef(mode === 'draft');

  const setDirty = (d: boolean) => {
    setDirtyState(d);
    props.onDirtyChange?.(d);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // ---- recalculation
  const runCalc = (): Promise<Paycheck | null> => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const my = ++seq.current;
    const input: PaycheckInput = { ...headerRef.current, lines: sendableLines(allLines(linesRef.current)), recalculate: recalcRef.current };
    setCalcBusy(true);
    const p = calculatePaycheck(input)
      .then((r) => {
        if (my !== seq.current) return null;
        lastGood.current = r;
        setPc(r);
        const n = mergeCalc(linesRef.current, r);
        linesRef.current = n;
        setLines(n);
        errRef.current = null;
        setCalcError(null);
        return r;
      })
      .catch((e) => {
        if (my === seq.current) {
          errRef.current = errorText(e) ?? 'The paycheck could not be calculated.';
          setCalcError(errRef.current);
        }
        return null;
      })
      .finally(() => {
        if (my === seq.current) {
          setCalcBusy(false);
          inflight.current = null;
        }
      });
    inflight.current = p;
    return p;
  };
  const schedule = () => {
    window.clearTimeout(timer.current);
    setCalcBusy(true);
    timer.current = window.setTimeout(() => void runCalc(), 350);
  };
  /** Waits for the calculation of the latest changes; null when it failed. */
  const flush = async (): Promise<Paycheck | null> => {
    for (let i = 0; i < 50; i++) {
      if (timer.current !== undefined) {
        await runCalc();
        continue;
      }
      const p = inflight.current;
      if (!p) break;
      await p;
    }
    return errRef.current ? null : lastGood.current;
  };

  /** Changes the lines; `amounts` false for summary amounts (the other amounts stay as saved). */
  const editLines = (fn: (l: Lines) => Lines, amounts = true) => {
    const n = fn(linesRef.current);
    linesRef.current = n;
    setLines(n);
    setDirty(true);
    if (amounts) recalcRef.current = true;
    schedule();
  };
  const editHeader = (patch: Partial<Header>) => {
    const n = { ...headerRef.current, ...patch };
    headerRef.current = n;
    setHeader(n);
    setDirty(true);
    schedule();
  };

  // ---- summary edits (manual amounts)
  const findLines = (itemId: Id) => allLines(linesRef.current).filter((l) => l.itemId === itemId);
  const setManual = async (row: SummaryRow, amount: number) => {
    const it = items.get(row.itemId);
    const found = findLines(row.itemId);
    if (found.length > 1) {
      await alertBox(`${row.itemName} is on several lines of this paycheck. Change the rate or hours of its lines instead.`, 'Paycheck Details');
      return;
    }
    const value = Math.abs(amount);
    editLines((ls) => {
      const patch = (l: PaycheckLine) => (l.itemId === row.itemId ? { ...l, amount: value, manual: true } : l);
      if (found.length === 1) return { earn: ls.earn.map(patch), other: ls.other.map(patch), tax: ls.tax.map(patch) };
      // an item with year-to-date amounts only: add its line
      const l = newLine(row.itemId, { amount: value, manual: true, itemName: row.itemName, category: row.category, itemType: it?.type ?? '' });
      const part = partOf(l);
      return { ...ls, [part]: [...ls[part], l] };
    }, row.category !== 'employee_tax' && row.category !== 'employer_tax');
    // show the typed amount until the calculation answers
    const upd = (rows: SummaryRow[]) => rows.map((r) => (r.itemId === row.itemId ? { ...r, amount: value } : r));
    setPc((p) => ({ ...p, employeeSummary: upd(p.employeeSummary), companySummary: upd(p.companySummary) }));
  };
  const useCalculated = (itemId: Id) => {
    // without Recalculate the server keeps the amount sent: send the calculated one
    const un = (l: PaycheckLine) => (l.itemId === itemId ? { ...l, manual: false, amount: recalcRef.current ? l.amount : l.computed } : l);
    editLines((ls) => ({ earn: ls.earn.map(un), other: ls.other.map(un), tax: ls.tax.map(un) }), false);
  };
  const manualItems = useMemo(() => new Set(allLines(lines).filter((l) => l.manual).map((l) => l.itemId)), [lines]);

  // ---- grids
  const earnColumns: GridColumn<PaycheckLine>[] = [
    {
      key: 'itemId',
      label: 'Item name',
      width: 220,
      editor: (p) => (
        <PayrollItemPicker
          inGrid
          autoFocus
          aria-label="Earnings item"
          types={WAGE_TYPES}
          value={p.value || null}
          onChange={(id, it) => p.onRowChange({ itemId: id ?? 0, itemName: it?.name ?? '', itemType: it?.type ?? '', category: 'earning', pto: it?.pto ?? '', rate: null, manual: false, amount: 0 })}
        />
      ),
      render: (r) => r.itemName || items.get(r.itemId)?.name || '',
    },
    {
      key: 'rate',
      label: 'Rate',
      width: 100,
      align: 'right',
      editor: 'qty',
      nullable: true,
      // a commission on sales is a percent of the quantity
      render: (r) => {
        const it = items.get(r.itemId);
        return it?.type === 'commission' && it.calc === 'quantity' && r.rate !== null ? fmtQty(r.rate) + '%' : fmtRate(r.rate);
      },
    },
    {
      key: 'qty',
      label: 'Hours',
      width: 90,
      align: 'right',
      editor: 'qty',
      nullable: true,
      title: 'Hours worked (quantity for commissions)',
      readOnly: (r) => {
        const it = items.get(r.itemId);
        return !!it && !(it.type === 'hourly' || it.type === 'overtime' || it.type === 'salary' || (it.type === 'commission' && it.calc === 'quantity'));
      },
      render: (r) => fmtHours(r.qty),
    },
    {
      key: 'jobNameId',
      label: 'Customer:Job',
      width: 190,
      hidden: !prefs.jobCosting,
      editor: (p) => <JobPicker inGrid autoFocus aria-label="Customer:Job" value={p.value ?? null} onChange={(id, j) => p.onRowChange({ jobNameId: id, jobName: j?.fullName ?? '' })} />,
      render: (r) => r.jobName,
    },
    {
      key: 'classId',
      label: 'Class',
      width: 140,
      hidden: prefs.classTracking !== 'earnings',
      editor: (p) => <ClassPicker inGrid autoFocus aria-label="Class" value={p.value ?? null} onChange={(id) => p.onChange(id)} />,
    },
  ];

  const otherColumns: GridColumn<PaycheckLine>[] = [
    {
      key: 'itemId',
      label: 'Item name',
      width: 220,
      editor: (p) => (
        <PayrollItemPicker
          inGrid
          autoFocus
          aria-label="Payroll item"
          types={OTHER_TYPES}
          value={p.value || null}
          onChange={(id, it) => p.onRowChange({ itemId: id ?? 0, itemName: it?.name ?? '', itemType: it?.type ?? '', category: it?.category ?? '', rate: null, qty: null, manual: false, amount: 0 })}
        />
      ),
      render: (r) => r.itemName || items.get(r.itemId)?.name || '',
    },
    {
      key: 'rate',
      label: 'Rate',
      width: 100,
      align: 'right',
      editor: 'qty',
      nullable: true,
      get: (r) => r.rate,
      set: (r, v) => ({ ...r, rate: v === null ? null : Math.abs(v as number) }),
      render: (r) => {
        if (r.rate === null || !r.itemId) return '';
        const it = items.get(r.itemId);
        const s = it?.calc === 'percent' || it?.calc === 'match' ? fmtQty(r.rate) + '%' : fmtRate(r.rate);
        return (r.category === 'deduction' || r.category === 'employee_tax') && r.rate ? '-' + s : s;
      },
    },
    {
      key: 'qty',
      label: 'Quantity',
      width: 90,
      align: 'right',
      editor: 'qty',
      nullable: true,
      readOnly: (r) => items.get(r.itemId)?.calc !== 'quantity',
      render: (r) => (r.qty === null ? '' : fmtQty(r.qty)),
    },
  ];

  const onEarnRows = (rows: PaycheckLine[]) => editLines((ls) => ({ ...ls, earn: rows }));
  const onOtherRows = (rows: PaycheckLine[]) => {
    // removing an item of the employee's setup keeps it on the check with no amount (it would come back otherwise)
    const defaults = new Set((emp?.items ?? []).map((i) => i.itemId));
    const kept = new Set(rows.map((r) => r.itemId));
    const gone = linesRef.current.other.filter((l) => l.itemId > 0 && defaults.has(l.itemId) && !kept.has(l.itemId));
    const back = gone.map((l) => ({ ...l, amount: 0, rate: 0, manual: true }));
    editLines((ls) => ({ ...ls, other: [...rows, ...back] }));
  };
  // a new rate, hours or quantity: the amount is calculated again
  const lineChange = (next: PaycheckLine, _prev: PaycheckLine, key: string): PaycheckLine => (key === 'rate' || key === 'qty' ? { ...next, manual: false } : next);

  const summaryColumns: GridColumn<SummaryRow>[] = [
    {
      key: 'itemName',
      label: 'Item name',
      width: 200,
      grow: true,
      render: (r) => (
        <span className="py-sumname">
          {r.itemName}
          {manualItems.has(r.itemId) && <PencilLine size={12} className="py-man-icon" aria-label="entered by you" />}
        </span>
      ),
    },
    {
      key: 'amount',
      label: 'Amount',
      width: 100,
      align: 'right',
      editor: 'money',
      get: (r) => signedAmount(r.category, r.amount),
      set: (r, v) => ({ ...r, amount: Math.abs((v as number) ?? 0) }),
      render: (r) => <span className={manualItems.has(r.itemId) ? 'py-man' : undefined}>{fmtMoney(signedAmount(r.category, r.amount))}</span>,
    },
    { key: 'ytd', label: 'YTD', width: 100, align: 'right', render: (r) => fmtMoney(signedAmount(r.category, r.ytd)) },
  ];
  const onSummaryRows = (prevRows: SummaryRow[]) => (rows: SummaryRow[]) => {
    rows.forEach((r, i) => {
      const old = prevRows[i];
      if (old && old.itemId === r.itemId && Math.abs(old.amount - r.amount) > 0.001) void setManual(r, r.amount);
    });
  };
  const summaryMenu = (r: SummaryRow | null) =>
    r ? [{ label: 'Use calculated amount', disabled: !manualItems.has(r.itemId), onClick: () => useCalculated(r.itemId) }] : [];

  // ---- buttons
  const finish = async (action: DetailAction) => {
    if (action === 'cancel') {
      if (dirty && mode === 'saved' && !(await confirmBox('Discard your changes to this paycheck?', 'Paycheck Details'))) return;
      await props.onDone('cancel', null, false);
      return;
    }
    setSaving(true);
    try {
      // commit the cell being edited (blur) and wait for its calculation
      (document.activeElement as HTMLElement | null)?.blur?.();
      await new Promise((r) => setTimeout(r, 0));
      const r = await flush();
      if (!r) {
        await alertBox(errRef.current ?? 'The paycheck could not be calculated. Check its lines.', 'Paycheck Details', 'warning');
        return;
      }
      if (r.net < 0) {
        await alertBox(`Net pay cannot be less than zero. The paycheck of ${r.employeeName} has a net pay of ${fmtMoney(r.net)}; reduce its deductions or taxes.`, 'Paycheck Details', 'warning');
        return;
      }
      if (sendableLines(r.lines).length === 0 || r.gross === 0) {
        if (!(await confirmBox(`The paycheck of ${r.employeeName} has no earnings. Keep it this way?`, 'Paycheck Details'))) return;
      }
      // the lines as edited (earnings items without hours stay, ready for the next change)
      const res = await props.onDone(action, { ...r, lines: sendableLines(allLines(linesRef.current)), recalculate: recalcRef.current }, dirty);
      if (res !== false) setDirty(false);
    } catch (e) {
      const t = errorText(e);
      if (t) setCalcError(t);
    } finally {
      setSaving(false);
    }
  };

  // ---- display values
  const earnTotal = sum2(lines.earn.filter((l) => l.itemId > 0).map((l) => l.amount));
  const hours = pc.totalHours;
  const sick = pc.sick;
  const vac = pc.vacation;
  const eeAdjusted = pc.employeeSummary.some((r) => manualItems.has(r.itemId));
  const coAdjusted = pc.companySummary.some((r) => manualItems.has(r.itemId));
  const ddAllowed = !!emp?.directDeposit.enabled || header.directDeposit;
  const busy = saving;

  return (
    <div className={'py-detail' + (props.inDialog ? ' py-detail-dlg' : '')}>
      <div className="py-detail-scroll">
        <div className="py-detail-head">
          <div className="py-detail-emp">{pc.employeeName}</div>
          <div className="py-detail-period">
            <span className="sx-label">PAY PERIOD</span>
            <DateField value={header.periodStart} onChange={(d) => d && editHeader({ periodStart: d })} width={124} aria-label="Pay period start" required />
            <span className="py-dash">–</span>
            <DateField value={header.periodEnd} onChange={(d) => d && editHeader({ periodEnd: d })} width={124} aria-label="Pay period end" required />
          </div>
          <div className="py-detail-check">
            <span className="sx-label">CHECK DATE</span>
            <span className="py-ro">{fmtDate(header.checkDate)}</span>
          </div>
          {prefs.classTracking === 'paycheck' && (
            <div className="py-detail-class">
              <span className="sx-label">CLASS</span>
              <ClassPicker value={header.classId} onChange={(id) => editHeader({ classId: id })} width={150} aria-label="Class" />
            </div>
          )}
          <Checkbox
            label="Pay by direct deposit"
            checked={header.directDeposit}
            disabled={!ddAllowed}
            title={ddAllowed ? undefined : 'Set up direct deposit on the Payroll Info tab of the employee first.'}
            onChange={(v) => editHeader({ directDeposit: v, toBePrinted: v ? false : header.toBePrinted })}
          />
        </div>

        {calcError && <ErrorBanner className="py-detail-banner" message={calcError} onDismiss={() => setCalcError(null)} />}
        {pc.warnings.length > 0 && (
          <div className="py-warnings" role="status">
            <AlertTriangle size={15} aria-hidden="true" />
            <ul>
              {pc.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="py-detail-earn">
          <section className="py-panel py-earn-panel">
            <div className="py-panel-head">Earnings</div>
            <Grid<PaycheckLine>
              aria-label="Earnings"
              columns={earnColumns}
              rows={lines.earn}
              onChange={onEarnRows}
              onRowChange={lineChange}
              newRow={() => newLine(0, { category: 'earning' })}
              minRows={4}
              persistKey="py-detail-earn"
              enterMoves="next"
            />
            <div className="py-totalsline">
              <span className="py-totals-label">TOTALS</span>
              <span className="py-num">{fmtMoney(earnTotal)}</span>
              <span className="py-num py-muted">{fmtHours(hours)} hrs</span>
            </div>
          </section>
          <section className="py-panel py-pto">
            <dl>
              <dt>Sick hours left</dt>
              <dd>{fmtHours(sick.availableAfter)}</dd>
              <dt>Vacation hours left</dt>
              <dd>{fmtHours(vac.availableAfter)}</dd>
              <dt>Sick hours earned</dt>
              <dd>{fmtHours(sick.accrued)}</dd>
              <dt>Vacation hours earned</dt>
              <dd>{fmtHours(vac.accrued)}</dd>
            </dl>
            <Checkbox label="Earns no sick or vacation hours" checked={header.noAccrual} onChange={(v) => editHeader({ noAccrual: v })} title="For bonus checks and other paychecks that should not earn sick or vacation hours" />
          </section>
        </div>

        <div className="py-detail-bottom">
          <div className="py-detail-left">
            <section className="py-panel">
              <div className="py-panel-head">Additions and Deductions</div>
              <Grid<PaycheckLine>
                aria-label="Additions and deductions"
                columns={otherColumns}
                rows={lines.other}
                onChange={onOtherRows}
                onRowChange={lineChange}
                newRow={() => newLine(0)}
                minRows={3}
                persistKey="py-detail-other"
              />
            </section>
            <section className="py-panel">
              <div className="py-panel-head">
                Company Costs{coAdjusted ? ' (changed by hand)' : ''}
                <span className="py-grow" />
                <HowCalculated />
              </div>
              <Grid<SummaryRow>
                aria-label="Company costs"
                columns={summaryColumns}
                rows={pc.companySummary}
                onChange={onSummaryRows(pc.companySummary)}
                newRow={() => ({ itemId: 0, itemName: '', category: 'employer_tax', amount: 0, ytd: 0 })}
                allowAdd={false}
                allowInsertDelete={false}
                contextMenu={summaryMenu}
                minRows={3}
                persistKey="py-detail-co"
              />
            </section>
          </div>
          <section className="py-panel py-detail-right">
            <div className="py-panel-head">
              Employee Pay and Taxes{eeAdjusted ? ' (changed by hand)' : ''}
              <span className="py-grow" />
              <HowCalculated />
            </div>
            <Grid<SummaryRow>
              aria-label="Employee pay and taxes"
              columns={summaryColumns}
              rows={pc.employeeSummary}
              onChange={onSummaryRows(pc.employeeSummary)}
              newRow={() => ({ itemId: 0, itemName: '', category: 'employee_tax', amount: 0, ytd: 0 })}
              allowAdd={false}
              allowInsertDelete={false}
              contextMenu={summaryMenu}
              minRows={6}
              persistKey="py-detail-ee"
            />
            <div className="py-checkamount">
              <span>Check Amount:</span>
              <span className="py-num">{fmtMoney(pc.net)}</span>
            </div>
          </section>
        </div>
      </div>

      <div className="py-detail-foot">
        <span className="py-calcstate" aria-live="polite">
          {calcBusy ? (
            <Spinner size={13} label="Calculating…" />
          ) : !dirty ? (
            ''
          ) : recalcRef.current ? (
            'Changes are recalculated as you type.'
          ) : (
            'The other amounts stay as saved until you change the earnings or the other payroll items.'
          )}
        </span>
        <span className="py-grow" />
        {mode === 'draft' ? (
          <>
            <Button label="Save && &Previous" disabled={busy || !props.hasPrev} onClick={() => void finish('prev')} />
            <Button label="Save && &Next" disabled={busy || !props.hasNext} onClick={() => void finish('next')} />
            <Button variant="primary" label="&Save && Close" busy={busy} onClick={() => void finish('close')} />
            <Button label="Cancel" disabled={busy} onClick={() => void finish('cancel')} />
          </>
        ) : (
          <>
            <Button variant="primary" label="&OK" busy={busy} onClick={() => void finish('close')} />
            <Button label="Cancel" disabled={busy} onClick={() => void finish('cancel')} />
          </>
        )}
      </div>
    </div>
  );
}

function HowCalculated() {
  return (
    <button
      type="button"
      className="sx-linkbtn py-howlink"
      onClick={() =>
        void alertBox(
          'Earnings come from the rates and hours above (salary: the annual salary divided by the pay periods). Deductions and company contributions use the amounts and limits of the employee setup. Taxes use the employee\'s W-4, the year-to-date wages and the tax tables of the check date\'s year.\n\nType an amount to use it instead of the calculated one; it is marked with a pencil. Right-click the line and choose "Use calculated amount" to go back.',
          'How are these items calculated?',
        )
      }
    >
      How are these items calculated?
    </button>
  );
}

/**
 * Shows the Paycheck Details of a draft paycheck in a dialog. Resolves with
 * the button and the edited paycheck (null on Cancel).
 */
export function openPaycheckDetail(opts: { paycheck: Paycheck; inputLines?: PaycheckLine[]; hasPrev?: boolean; hasNext?: boolean; title?: string }): Promise<{ action: DetailAction; paycheck: Paycheck | null; changed: boolean }> {
  return showDialog<{ action: DetailAction; paycheck: Paycheck | null; changed: boolean }>({
    title: opts.title ?? 'Paycheck Details',
    width: 1060,
    cancelValue: { action: 'cancel', paycheck: null, changed: false },
    render: (close) => (
      <PaycheckDetail
        inDialog
        mode="draft"
        paycheck={opts.paycheck}
        inputLines={opts.inputLines}
        hasPrev={opts.hasPrev}
        hasNext={opts.hasNext}
        onDone={(action, paycheck, changed) => close({ action, paycheck, changed })}
      />
    ),
  });
}

/** The item of an id (helper for callers that show item names). */
export function itemName(items: Map<Id, PayrollItem>, id: Id): string {
  return items.get(id)?.name ?? '';
}

export default PaycheckDetail;
