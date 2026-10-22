// Enter Year-to-Date Amounts: the wages, taxes, deductions and company items an employee was paid this
// year before using SerieX Payroll, entered per quarter. Each quarter is saved as one
// year-to-date paycheck (kind "ytd": POST/PUT /paychecks; dated the quarter end, or today for
// the current quarter). They count in year-to-date totals, amounts owed, forms and W-2s, print
// nothing and are never posted to SerieX Books.
//   Introduction → Employees (year, list with what was entered) → Amounts (grid: one row per
//   payroll item, one column per quarter; "Calculate taxes" fills the taxes from the wages) →
//   Finish.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Calculator, Check, ClipboardList, Flag, Info, Users } from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll, useEmployee, useEmployees, useItemsById, useMeta, usePaychecks } from '@/api/hooks';
import type { Category, Employee, Id, Paycheck, PaycheckInput, PaycheckLine, PaycheckSummary } from '@/api/types';
import { Button, EmptyState, ErrorBanner, Grid, ListView, PayrollItemPicker, Select, Spinner, confirmBox, msgBox, toast, type GridColumn } from '@/components';
import { fmtDate, fmtMoney, round2 } from '@/util/format';
import { todayIso } from '@/util/dates';
import { useWindow } from '@/windows/WindowContext';
import { calculatePaycheck, errorText, newLine, sum2 } from './shared';
import './payroll.css';

export interface YtdSetupWizardProps {
  /** Employee to start with. */
  employeeId?: number;
}

type Step = 'intro' | 'employees' | 'amounts' | 'finish';

const STEPS: { key: Step; label: string; icon: typeof Info }[] = [
  { key: 'intro', label: 'Introduction', icon: Info },
  { key: 'employees', label: 'Employees', icon: Users },
  { key: 'amounts', label: 'Year-to-date amounts', icon: ClipboardList },
  { key: 'finish', label: 'Finish', icon: Flag },
];

const CAT_ORDER: Record<string, number> = { earning: 0, addition: 1, deduction: 2, employee_tax: 3, contribution: 4, employer_tax: 5 };
const CAT_LABEL: Record<string, string> = {
  earning: 'Wages',
  addition: 'Addition',
  deduction: 'Deduction',
  employee_tax: 'Employee tax',
  contribution: 'Company contribution',
  employer_tax: 'Company tax',
};

interface Row {
  itemId: Id;
  itemName: string;
  category: Category | '';
  q: [number, number, number, number];
}

const qEnd = (year: number, q: number) => [`${year}-03-31`, `${year}-06-30`, `${year}-09-30`, `${year}-12-31`][q];
const qStart = (year: number, q: number) => [`${year}-01-01`, `${year}-04-01`, `${year}-07-01`, `${year}-10-01`][q];
const quarterOf = (date: string) => Math.floor((Number(date.slice(5, 7)) - 1) / 3);

/** Date of the year-to-date paycheck of a quarter (the quarter end, or today in the current quarter); null for future quarters. */
function quarterDate(year: number, q: number, today: string): string | null {
  if (qStart(year, q) > today) return null;
  return qEnd(year, q) > today ? today : qEnd(year, q);
}

const emptyRow = (): Row => ({ itemId: 0, itemName: '', category: '', q: [0, 0, 0, 0] });

export default function YtdSetupWizard(props: YtdSetupWizardProps) {
  const win = useWindow();
  const today = todayIso();
  const { data: meta } = useMeta();
  const [step, setStep] = useState<Step>(props.employeeId ? 'amounts' : 'intro');
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const [employeeId, setEmployeeId] = useState<Id | null>(props.employeeId ?? null);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (props.employeeId) {
      setEmployeeId(props.employeeId);
      setStep('amounts');
    }
  }, [props.employeeId]);
  useEffect(() => {
    win.setTitle('Enter Year-to-Date Amounts');
    win.setBeforeClose(async () => !dirtyRef.current || (await confirmBox('Close without saving the year-to-date amounts you entered?', 'Year-to-Date Amounts')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => win.setDirty(dirty), [dirty, win]);

  const { data: ytdList, refetch } = usePaychecks({ kind: 'ytd', from: `${year}-01-01`, to: `${year}-12-31` });
  const byEmployee = useMemo(() => {
    const m = new Map<Id, PaycheckSummary[]>();
    for (const p of ytdList ?? []) m.set(p.employeeId, [...(m.get(p.employeeId) ?? []), p]);
    return m;
  }, [ytdList]);

  const goto = async (s: Step) => {
    if (s === step) return;
    if (step === 'amounts' && dirty && !(await confirmBox('Leave this page without saving the amounts you entered?', 'Year-to-Date Amounts'))) return;
    if (step === 'amounts') setDirty(false);
    if (s === 'amounts' && !employeeId) return;
    setStep(s);
  };
  const years = (meta?.taxYears?.length ? meta.taxYears : [year - 1, year]).slice().sort((a, b) => b - a);
  const idx = STEPS.findIndex((s) => s.key === step);

  return (
    <div className="py-wizard">
      <nav className="py-wiz-rail" aria-label="Steps">
        <div className="py-wiz-railtitle">Year-to-Date Amounts</div>
        {STEPS.map((s, i) => {
          const Icon = s.icon;
          return (
            <button
              key={s.key}
              type="button"
              className={'py-wiz-step' + (i === idx ? ' py-on' : '') + (i < idx ? ' py-done' : '')}
              onClick={() => void goto(s.key)}
              disabled={s.key === 'amounts' && !employeeId}
              aria-current={i === idx ? 'step' : undefined}
            >
              <span className="py-wiz-num">{i < idx ? <Check size={13} /> : <Icon size={13} />}</span>
              {s.label}
            </button>
          );
        })}
        <div className="py-wiz-railfoot py-muted py-small">Year-to-date amounts are never posted to SerieX Books.</div>
      </nav>
      <div className="py-wiz-main">
        {step === 'intro' && (
          <>
            <div className="py-wiz-body">
              <div className="py-wiz-head">
                <h2>Enter the paychecks you paid this year before using SerieX Payroll</h2>
                <div className="py-muted">Year-to-date amounts make the year totals, the tax limits and the year-end forms correct.</div>
              </div>
              <ol className="py-wiz-list">
                <li>Choose the year and an employee.</li>
                <li>
                  Enter, for each quarter, the wages paid, the taxes withheld, the deductions and the company taxes and contributions. Use the totals of your previous payroll records.
                  Earlier quarters can be entered as one total per quarter.
                </li>
                <li>Click Calculate taxes to fill the taxes from the wages, then correct them to what was actually withheld.</li>
                <li>Save, and repeat for every employee paid this year.</li>
              </ol>
              <div className="sxp-banner">
                Each quarter is saved as one year-to-date entry dated the end of the quarter (today for the current quarter). It counts in year-to-date totals, amounts owed, Forms
                941/940 and W-2s, is not printed and is never posted to SerieX Books. Enter the tax payments you already made for these amounts with Record Earlier Tax Payments.
              </div>
            </div>
            <div className="py-foot">
              <span className="py-grow" />
              <Button label="Cancel" onClick={() => void win.close()} />
              <Button variant="primary" label="&Next" onClick={() => setStep('employees')} />
            </div>
          </>
        )}

        {step === 'employees' && (
          <EmployeesStep
            year={year}
            years={years}
            onYear={setYear}
            byEmployee={byEmployee}
            selected={employeeId}
            onSelect={setEmployeeId}
            onOpen={(id) => {
              setEmployeeId(id);
              setStep('amounts');
            }}
            onBack={() => setStep('intro')}
            onFinish={() => setStep('finish')}
          />
        )}

        {step === 'amounts' && employeeId && (
          <AmountsStep
            key={`${employeeId}:${year}`}
            employeeId={employeeId}
            year={year}
            today={today}
            existing={byEmployee.get(employeeId) ?? []}
            onDirty={setDirty}
            onSaved={() => {
              setDirty(false);
              void refetch();
            }}
            onBack={async () => {
              if (dirtyRef.current && !(await confirmBox('Go back without saving the amounts you entered?', 'Year-to-Date Amounts'))) return;
              setDirty(false);
              setStep('employees');
            }}
          />
        )}

        {step === 'finish' && (
          <>
            <div className="py-wiz-body">
              <div className="py-wiz-head">
                <h2>Year-to-date amounts for {year}</h2>
                <div className="py-muted">These employees have year-to-date amounts. Check them with the Payroll Summary report before you run payroll.</div>
              </div>
              <FinishList year={year} byEmployee={byEmployee} />
            </div>
            <div className="py-foot">
              <Button label="&Back" onClick={() => setStep('employees')} />
              <span className="py-grow" />
              <Button variant="primary" label="&Finish" onClick={() => void win.close(true)} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function EmployeesStep({
  year,
  years,
  onYear,
  byEmployee,
  selected,
  onSelect,
  onOpen,
  onBack,
  onFinish,
}: {
  year: number;
  years: number[];
  onYear: (y: number) => void;
  byEmployee: Map<Id, PaycheckSummary[]>;
  selected: Id | null;
  onSelect: (id: Id) => void;
  onOpen: (id: Id) => void;
  onBack: () => void;
  onFinish: () => void;
}) {
  const { data, isLoading } = useEmployees({ active: 'all' });
  const rows = useMemo(() => (data ?? []).filter((e) => e.active || byEmployee.has(e.id)), [data, byEmployee]);
  const gross = (e: Employee) => sum2((byEmployee.get(e.id) ?? []).map((p) => p.gross));
  return (
    <>
      <div className="py-wiz-body">
        <div className="py-wiz-head py-wiz-headrow">
          <div>
            <h2>Choose an employee</h2>
            <div className="py-muted">Double-click an employee (or select one and click Enter Amounts) to enter the amounts paid before you started using SerieX Payroll.</div>
          </div>
          <div className="py-wiz-year">
            <label className="sx-label" htmlFor="py-ytd-year">
              YEAR
            </label>
            <Select id="py-ytd-year" value={year} width={100} onChange={(v) => onYear(Number(v))} options={years.map((y) => ({ value: y, label: String(y) }))} />
          </div>
        </div>
        <div className="py-wiz-list-wrap">
          <ListView<Employee>
            aria-label="Employees"
            loading={isLoading}
            rows={rows}
            selectedKey={selected}
            onSelect={(k) => onSelect(k as Id)}
            onActivate={(e) => onOpen(e.id)}
            isInactive={(e) => !e.active}
            autoFocus
            emptyText="There are no employees. Add them in the Employee Center first."
            columns={[
              { key: 'displayName', label: 'Employee', width: 220, grow: true },
              { key: 'hireDate', label: 'Hire Date', width: 110, type: 'date' },
              { key: 'entries', label: `${year} Entries`, width: 120, align: 'right', render: (e) => (byEmployee.get(e.id)?.length ? `${byEmployee.get(e.id)!.length} quarter${byEmployee.get(e.id)!.length === 1 ? '' : 's'}` : '—'), sortValue: (e) => byEmployee.get(e.id)?.length ?? 0 },
              { key: 'gross', label: 'Gross Pay Entered', width: 150, align: 'right', render: (e) => (byEmployee.has(e.id) ? fmtMoney(gross(e)) : ''), sortValue: gross },
            ]}
          />
        </div>
      </div>
      <div className="py-foot">
        <Button label="&Back" onClick={onBack} />
        <span className="py-grow" />
        <Button label="&Finish" onClick={onFinish} />
        <Button variant="primary" label="&Enter Amounts" disabled={!selected} onClick={() => selected && onOpen(selected)} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function AmountsStep({
  employeeId,
  year,
  today,
  existing,
  onDirty,
  onSaved,
  onBack,
}: {
  employeeId: Id;
  year: number;
  today: string;
  existing: PaycheckSummary[];
  onDirty: (d: boolean) => void;
  onSaved: () => void;
  onBack: () => void;
}) {
  const items = useItemsById();
  const { data: emp } = useEmployee(employeeId);
  const [rows, setRowsState] = useState<Row[] | null>(null);
  const rowsRef = useRef<Row[]>([]);
  const [saved, setSaved] = useState<(Paycheck | null)[]>([null, null, null, null]);
  const [calc, setCalc] = useState<(Paycheck | null)[]>([null, null, null, null]);
  const [error, setError] = useState<string | null>(null);
  /** Warnings of the last save (paychecks dated after the amounts that were not recalculated). */
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  /** Tax cells filled by "Calculate taxes" (item:quarter); typed cells are never replaced. */
  const autoRef = useRef<Set<string>>(new Set());
  const dates = [0, 1, 2, 3].map((q) => quarterDate(year, q, today));

  const setRows = (r: Row[]) => {
    rowsRef.current = r;
    setRowsState(r);
  };

  // load: saved year-to-date paychecks + the employee's items + the taxes that apply
  const existingKey = existing.map((p) => `${p.id}:${p.checkDate}`).join(',');
  useEffect(() => {
    if (!emp || !items.size) return;
    let live = true;
    (async () => {
      try {
        const full = await Promise.all(existing.map((p) => api.get<Paycheck>(`/paychecks/${p.id}`)));
        const template = await calculatePaycheck(ytdInput(employeeId, dates.find(Boolean) ?? `${year}-03-31`, []));
        if (!live) return;
        const map = new Map<Id, Row>();
        const add = (itemId: Id, name: string, cat: Category | '') => {
          if (!map.has(itemId)) map.set(itemId, { itemId, itemName: name, category: cat, q: [0, 0, 0, 0] });
          return map.get(itemId)!;
        };
        for (const ei of emp.earnings) {
          const it = items.get(ei.itemId);
          if (it?.active !== false && it) add(it.id, it.name, 'earning');
        }
        for (const ei of emp.items) {
          const it = items.get(ei.itemId);
          if (it) add(it.id, it.name, it.category);
        }
        for (const l of template.lines) if (l.category !== 'earning') add(l.itemId, l.itemName, l.category);
        const byQ: (Paycheck | null)[] = [null, null, null, null];
        for (const p of full) {
          const q = quarterOf(p.checkDate);
          byQ[q] = p;
          for (const l of p.lines) {
            const r = add(l.itemId, l.itemName, l.category);
            r.q[q] = round2(r.q[q] + l.amount);
          }
        }
        const list = [...map.values()].sort((a, b) => (CAT_ORDER[a.category] ?? 9) - (CAT_ORDER[b.category] ?? 9));
        setRows(list);
        setSaved(byQ);
        setCalc(byQ);
        setError(null);
      } catch (e) {
        if (live) setError(errorText(e));
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emp?.id, items.size, existingKey, year]);

  const edit = (r: Row[]) => {
    // a typed tax is the user's: the next calculation keeps it
    const prev = rowsRef.current;
    r.forEach((row, i) => {
      const old = prev[i];
      if (!old || old.itemId !== row.itemId) return;
      row.q.forEach((v, q) => {
        if (v !== old.q[q]) autoRef.current.delete(`${row.itemId}:${q}`);
      });
    });
    setRows(r);
    onDirty(true);
    setCalc([null, null, null, null]);
  };

  /** Lines of a quarter: every row (manual, so what you see is what is saved). */
  const linesOf = (q: number): PaycheckLine[] =>
    rowsRef.current
      .filter((r) => r.itemId > 0)
      .map((r) => newLine(r.itemId, { amount: r.q[q], manual: true, category: r.category, itemName: r.itemName }));
  const hasAmounts = (q: number) => rowsRef.current.some((r) => r.itemId > 0 && r.q[q] !== 0);

  /**
   * Fills the taxes from the wages. Capped taxes (social security, FUTA, state unemployment)
   * depend on the wages of the earlier quarters, so each quarter is calculated on the
   * cumulative amounts of the year so far and its taxes are the difference with the previous
   * quarter. Taxes typed by the user are kept; empty ones and the ones filled by an earlier
   * calculation are replaced. Federal and state withholding are not calculated for past
   * quarters: type what was withheld.
   */
  const calculateTaxes = async () => {
    setBusy('Calculating taxes…');
    setError(null);
    try {
      const out = rowsRef.current.map((r) => ({ ...r, q: [...r.q] as Row['q'] }));
      const auto = new Set(autoRef.current);
      const base = out.filter((r) => r.itemId > 0 && !isTax(r.category));
      const prevCum = new Map<Id, number>();
      const start = `${year}-01-01`;
      for (let q = 0; q < 4; q++) {
        if (!dates[q]) continue;
        const lines = base.map((r) => newLine(r.itemId, { amount: round2(r.q.slice(0, q + 1).reduce((a, b) => a + b, 0)), manual: true, category: r.category }));
        if (!lines.some((l) => l.amount !== 0)) continue;
        // dated January 1st: only the amounts sent count (no saved year-to-date amounts)
        const pc = await calculatePaycheck(ytdInput(employeeId, start, lines));
        const cum = new Map<Id, number>();
        for (const l of pc.lines) if (isTax(l.category)) cum.set(l.itemId, round2((cum.get(l.itemId) ?? 0) + l.amount));
        for (const row of out) {
          if (!isTax(row.category)) continue;
          const key = `${row.itemId}:${q}`;
          const amount = round2((cum.get(row.itemId) ?? 0) - (prevCum.get(row.itemId) ?? 0));
          if (row.q[q] === 0 || auto.has(key)) {
            row.q[q] = amount;
            auto.add(key);
          }
        }
        cum.forEach((v, k) => prevCum.set(k, v));
      }
      autoRef.current = auto;
      setRows(out);
      onDirty(true);
      await refreshTotals(out);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  /** Gross and net pay of each quarter as the server adds them up (every line as entered). */
  const refreshTotals = async (list: Row[]) => {
    const res: (Paycheck | null)[] = [null, null, null, null];
    for (let q = 0; q < 4; q++) {
      if (!dates[q] || !list.some((r) => r.itemId > 0 && r.q[q] !== 0)) continue;
      const lines = list.filter((r) => r.itemId > 0).map((r) => newLine(r.itemId, { amount: r.q[q], manual: true, category: r.category }));
      res[q] = await calculatePaycheck(ytdInput(employeeId, `${year}-01-01`, lines));
    }
    setCalc(res);
  };

  const save = async () => {
    setBusy('Saving…');
    setError(null);
    setWarnings([]);
    // a failed quarter keeps what the earlier ones saved (the next Save updates them)
    const out: (Paycheck | null)[] = [...saved];
    try {
      for (let q = 0; q < 4; q++) {
        const date = dates[q];
        const cur = saved[q];
        if (!hasAmounts(q)) {
          if (cur) await api.del(`/paychecks/${cur.id}`);
          out[q] = null;
          continue;
        }
        if (!date) continue;
        const input = ytdInput(employeeId, cur?.checkDate ?? date, linesOf(q));
        out[q] = cur
          ? await api.put<Paycheck>(`/paychecks/${cur.id}`, { ...input, id: cur.id, recalculate: false })
          : await api.post<Paycheck>('/paychecks', input);
      }
      setSaved(out);
      setCalc(out);
      await invalidateAll();
      toast(`Year-to-date amounts of ${emp?.displayName ?? 'the employee'} saved`, { kind: 'success' });
      onSaved();
      // paychecks dated after the amounts keep their old wage bases and limits (not recalculated);
      // the earliest quarter saved counts every one of them
      const warn = out.find((p) => p && p.warnings?.length)?.warnings ?? [];
      if (warn.length) {
        setWarnings(warn);
        await msgBox({ title: 'Year-to-Date Amounts', message: `The year-to-date amounts of ${emp?.displayName ?? 'the employee'} are saved.\n\n${warn.join('\n')}`, icon: 'warning', width: 520 });
      }
    } catch (e) {
      setSaved(out);
      setError(errorText(e));
      void invalidateAll();
    } finally {
      setBusy(null);
    }
  };

  if (!rows) return error ? <ErrorBanner message={error} /> : <Spinner center label="Loading year-to-date amounts…" />;

  const qCol = (q: number): GridColumn<Row> => ({
    key: 'q' + q,
    label: `Q${q + 1} ${year}`,
    width: 112,
    align: 'right',
    editor: 'money',
    blankZero: true,
    title: dates[q] ? `${fmtDate(qStart(year, q))} – ${fmtDate(qEnd(year, q))}, saved as of ${fmtDate(dates[q]!)}` : 'This quarter has not started yet.',
    readOnly: () => !dates[q],
    get: (r) => (isNeg(r.category) ? -r.q[q] : r.q[q]),
    set: (r, v) => {
      const q2 = [...r.q] as Row['q'];
      q2[q] = Math.abs((v as number) ?? 0);
      return { ...r, q: q2 };
    },
    render: (r) => (r.itemId ? fmtMoney(isNeg(r.category) ? -r.q[q] : r.q[q], { blankZero: true }) : ''),
  });
  const columns: GridColumn<Row>[] = [
    {
      key: 'itemId',
      label: 'Item name',
      width: 230,
      editor: (p) =>
        p.isNew || !p.row.itemId ? (
          <PayrollItemPicker
            inGrid
            autoFocus
            aria-label="Payroll item"
            value={p.value || null}
            onChange={(id, it) => p.onRowChange({ itemId: id ?? 0, itemName: it?.name ?? '', category: it?.category ?? '' })}
          />
        ) : (
          <span className="py-cellro">{p.row.itemName}</span>
        ),
      render: (r) => r.itemName,
    },
    { key: 'category', label: 'Type', width: 140, render: (r) => CAT_LABEL[r.category] ?? '' },
    qCol(0),
    qCol(1),
    qCol(2),
    qCol(3),
    { key: 'total', label: 'Total', width: 118, align: 'right', grow: true, render: (r) => (r.itemId ? fmtMoney((isNeg(r.category) ? -1 : 1) * sum2(r.q), { blankZero: true }) : '') },
  ];
  const quarterTotal = (q: number, f: (p: Paycheck) => number) => {
    const p = calc[q];
    return p ? fmtMoney(f(p)) : hasAmounts(q) ? '…' : '';
  };

  return (
    <>
      <div className="py-wiz-body">
        <div className="py-wiz-head py-wiz-headrow">
          <div>
            <h2>Year-to-date totals: {emp?.displayName}</h2>
            <div className="py-muted">
              Enter the totals paid in each quarter of {year}. Withheld taxes and deductions are shown negative. Leave taxes at 0 and click Calculate taxes to fill them from the
              wages.
            </div>
          </div>
        </div>
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
        {warnings.length > 0 && (
          <div className="py-warnings" role="status">
            <AlertTriangle size={15} aria-hidden="true" />
            <ul>
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="py-wiz-grid">
          <Grid<Row>
            aria-label="Year-to-date amounts"
            columns={columns}
            rows={rows}
            onChange={edit}
            newRow={emptyRow}
            minRows={10}
            persistKey="py-ytd"
            enterMoves="down"
          />
        </div>
        <table className="py-table py-ytd-totals" aria-label="Quarter totals">
          <thead>
            <tr>
              <th />
              {[0, 1, 2, 3].map((q) => (
                <th key={q} className="py-r">
                  Q{q + 1} {dates[q] ? `(as of ${fmtDate(dates[q]!)})` : '(not started)'}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Gross pay</td>
              {[0, 1, 2, 3].map((q) => (
                <td key={q} className="py-r">
                  {quarterTotal(q, (p) => p.gross)}
                </td>
              ))}
            </tr>
            <tr>
              <td className="py-strong">Net pay</td>
              {[0, 1, 2, 3].map((q) => (
                <td key={q} className="py-r py-strong">
                  {quarterTotal(q, (p) => p.net)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="py-foot">
        <Button label="&Back" disabled={!!busy} onClick={() => void onBack()} />
        <span className="py-grow" />
        {busy && <Spinner size={13} label={busy} />}
        <Button icon={Calculator} label="Calculate &taxes" disabled={!!busy} onClick={() => void calculateTaxes()} />
        <Button variant="primary" label="&Save Amounts" disabled={!!busy} onClick={() => void save()} />
      </div>
    </>
  );
}

function FinishList({ year, byEmployee }: { year: number; byEmployee: Map<Id, PaycheckSummary[]> }) {
  const { data } = useEmployees({ active: 'all' });
  const rows = (data ?? []).filter((e) => byEmployee.has(e.id));
  if (!rows.length) return <EmptyState compact title="No year-to-date amounts" message={`No year-to-date amounts are entered for ${year}.`} />;
  return (
    <table className="py-table" aria-label="Employees with year-to-date amounts">
      <thead>
        <tr>
          <th>Employee</th>
          <th className="py-r">Quarters</th>
          <th className="py-r">Gross</th>
          <th className="py-r">Taxes</th>
          <th className="py-r">Deductions</th>
          <th className="py-r">Net</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((e) => {
          const list = byEmployee.get(e.id)!;
          return (
            <tr key={e.id}>
              <td>{e.displayName}</td>
              <td className="py-r">{list.length}</td>
              <td className="py-r">{fmtMoney(sum2(list.map((p) => p.gross)))}</td>
              <td className="py-r">{fmtMoney(-sum2(list.map((p) => p.employeeTaxes)))}</td>
              <td className="py-r">{fmtMoney(-sum2(list.map((p) => p.deductions)))}</td>
              <td className="py-r">{fmtMoney(sum2(list.map((p) => p.net)))}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const isTax = (c: Category | '') => c === 'employee_tax' || c === 'employer_tax';
const isNeg = (c: Category | '') => c === 'deduction' || c === 'employee_tax';

function ytdInput(employeeId: Id, date: string, lines: PaycheckLine[]): PaycheckInput {
  return {
    id: 0,
    employeeId,
    kind: 'ytd',
    periodStart: '',
    periodEnd: '',
    checkDate: date,
    bankAccountId: null,
    checkNumber: '',
    toBePrinted: false,
    directDeposit: false,
    memo: '',
    classId: null,
    noAccrual: true,
    lines,
    recalculate: true,
  };
}
