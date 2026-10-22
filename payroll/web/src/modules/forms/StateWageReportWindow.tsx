// State quarterly unemployment / wage report (California DE 9 + DE 9C style): the report lines
// (employees paid for the pay period including the 12th, subject and taxable wages, the UI rate
// and contributions, other state payroll taxes, income tax withheld, payments, total due), the
// other state programs (extra.programs: the ones paid to another agency, e.g. a NY disability /
// paid family leave insurer, are shown for information only, not as amounts due) and the wage
// list per employee; the wage list exports as a CSV file (Excel).
import { useMemo } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import { api, qs } from '@/api/client';
import { useCompany, useFilings, useStateSettings } from '@/api/hooks';
import type { StateWageRow, TaxForm } from '@/api/types';
import { ToolbarButton, alertBox } from '@/components';
import { useSession } from '@/state/session';
import { escHtml } from '@/util/print';
import { fmtMoney, fmtPercent } from '@/util/format';
import { TaxFormFrame } from './TaxFormFrame';
import { lastEndedQuarter } from './Form941Window';
import { QuarterSelect, StateSelect, YearSelect, useFormYears, usePeriodSwitch } from './period';

export interface StateWageReportWindowProps {
  /** Year. */
  year: number;
  /** Quarter (1-4). */
  quarter: number;
  /** State code. */
  state: string;
}

const empRows = (form: TaxForm): StateWageRow[] => (Array.isArray(form.extra?.employees) ? (form.extra.employees as StateWageRow[]) : []);

/** One other state program of the report (form.extra.programs). */
interface ProgramRow {
  key: string;
  name: string;
  /** Collected for another agency (an insurer): not reported or paid with this return. */
  paidElsewhere?: boolean;
  employerWages?: number;
  employerRate?: number;
  employer?: number;
  employeeWages?: number;
  employee?: number;
}

const programRows = (form: TaxForm): ProgramRow[] => (Array.isArray(form.extra?.programs) ? (form.extra.programs as ProgramRow[]) : []);
const programLabel = (p: ProgramRow) => (p.name.includes(p.key) ? p.name : `${p.name} (${p.key})`);
const optMoney = (v: number | undefined) => (v === undefined || v === null ? '' : fmtMoney(v));
const optRate = (v: number | undefined) => (v === undefined || v === null || !v ? '' : fmtPercent(v));
const ELSEWHERE_NOTE =
  'Programs paid to another agency (for example a disability or paid family leave insurer) are listed for your information only. They are not part of the total due on this report; pay them to that agency.';

export default function StateWageReportWindow(props: StateWageReportWindowProps) {
  const lq = lastEndedQuarter();
  const { data: company } = useCompany();
  const { data: settings } = useStateSettings();
  const { data: filings } = useFilings();
  const isAdmin = useSession((s) => s.isAdmin);
  const years = useFormYears([props.year ?? lq.year]);
  const states = useMemo(() => {
    const set = new Set<string>();
    (settings ?? []).forEach((s) => set.add(s.state));
    (filings ?? []).filter((f) => f.form === 'STATE-UI' && f.state).forEach((f) => set.add(f.state));
    if (company?.primaryState) set.add(company.primaryState);
    if (props.state) set.add(props.state);
    return [...set].sort();
  }, [settings, filings, company, props.state]);
  const initialState = props.state || company?.primaryState || '';
  const { period, change } = usePeriodSwitch('stateWageReport', { year: props.year || lq.year, quarter: props.quarter || lq.quarter, state: initialState || undefined });
  const year = period.year;
  const quarter = period.quarter ?? 1;
  const state = period.state || initialState;

  const exportCsv = async (reveal: boolean) => {
    try {
      await api.download('/forms/state-ui/csv' + qs({ year, quarter, state, reveal: reveal ? 1 : undefined }), `${state}-wage-report-${year}-Q${quarter}.csv`);
    } catch (e) {
      await alertBox(e instanceof Error ? e.message : String(e), 'Export', 'error');
    }
  };

  return (
    <TaxFormFrame
      key={`${year}-${quarter}-${state}`}
      kind="STATE-UI"
      year={year}
      quarter={quarter}
      state={state || undefined}
      periodControls={
        <>
          <StateSelect value={state} states={states} onChange={(s) => void change({ year, quarter, state: s })} />
          <YearSelect value={year} years={years} onChange={(y) => void change({ year: y, quarter, state })} />
          <QuarterSelect value={quarter} onChange={(q) => void change({ year, quarter: q, state })} />
        </>
      }
      extraTools={(form) => (
        <ToolbarButton
          label="Excel"
          icon={FileSpreadsheet}
          disabled={!form}
          menu={[
            { label: 'Export the wage list (CSV)...', onClick: () => void exportCsv(false) },
            { label: 'Export with full social security numbers...', disabled: !isAdmin, onClick: () => void exportCsv(true) },
          ]}
        />
      )}
      after={(form) => (
        <>
          <ProgramList form={form} />
          <WageList form={form} />
        </>
      )}
      printExtra={(form) => programsHtml(form) + wageListHtml(form)}
    />
  );
}

/** Other state programs: amounts reported with this return, and (for information) the ones paid elsewhere. */
function ProgramList({ form }: { form: TaxForm }) {
  const rows = programRows(form);
  if (!rows.length) return null;
  const elsewhere = rows.some((r) => r.paidElsewhere);
  return (
    <section className="fx-sched" aria-label="Other state programs">
      <h2>Other state programs this quarter</h2>
      <div className="fx-sched-sub">{elsewhere ? ELSEWHERE_NOTE : 'The contributions and withholdings below are part of the total due on this report.'}</div>
      <table className="fx-table">
        <thead>
          <tr>
            <th>PROGRAM</th>
            <th className="fx-num">EMPLOYER WAGES</th>
            <th className="fx-num">RATE</th>
            <th className="fx-num">EMPLOYER TAX</th>
            <th className="fx-num">EMPLOYEE WAGES</th>
            <th className="fx-num">WITHHELD</th>
            <th>PAID WITH</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.paidElsewhere ? 'fx-info-row' : undefined}>
              <td>{programLabel(r)}</td>
              <td className="fx-num">{optMoney(r.employerWages)}</td>
              <td className="fx-num">{optRate(r.employerRate)}</td>
              <td className="fx-num">{optMoney(r.employer)}</td>
              <td className="fx-num">{optMoney(r.employeeWages)}</td>
              <td className="fx-num">{optMoney(r.employee)}</td>
              <td>{r.paidElsewhere ? <span className="fx-info-tag" title="Not part of the total due on this report">Other agency (info only)</span> : 'This report'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function programsHtml(form: TaxForm): string {
  const rows = programRows(form);
  if (!rows.length) return '';
  const trs = rows
    .map(
      (r) =>
        `<tr${r.paidElsewhere ? ' class="info"' : ''}><td>${escHtml(programLabel(r))}</td><td class="v">${optMoney(r.employerWages)}</td><td class="v">${optRate(r.employerRate)}</td><td class="v">${optMoney(r.employer)}</td><td class="v">${optMoney(r.employeeWages)}</td><td class="v">${optMoney(r.employee)}</td><td>${r.paidElsewhere ? 'Another agency (information only)' : 'This report'}</td></tr>`,
    )
    .join('');
  const note = rows.some((r) => r.paidElsewhere) ? `<p style="font-size:9px">${escHtml(ELSEWHERE_NOTE)}</p>` : '';
  return `<div class="pf"><div class="pf-title"><b>${escHtml(form.title)}</b><span>Other state programs</span></div>
    <table class="pf-sched"><tr><th>Program</th><th>Employer wages</th><th>Rate</th><th>Employer contributions</th><th>Employee wages</th><th>Withheld from employees</th><th>Paid with</th></tr>${trs}</table>${note}</div>`;
}

function WageList({ form }: { form: TaxForm }) {
  const rows = empRows(form);
  const sum = (f: (r: StateWageRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  return (
    <section className="fx-sched" aria-label="Employee wages">
      <h2>Report of wages (continuation): employees paid this quarter</h2>
      <div className="fx-sched-sub">
        {form.state} unemployment insurance wages by employee. If you change tax rates on this form, the changes only apply to this form; they do not change the tax rates of your payroll items.
      </div>
      <table className="fx-table">
        <thead>
          <tr>
            <th>EMPLOYEE</th>
            <th>SSN</th>
            <th className="fx-num">TOTAL SUBJECT WAGES</th>
            <th className="fx-num">UI TAXABLE WAGES</th>
            <th className="fx-num">EXCESS WAGES</th>
            <th className="fx-num">PIT WAGES</th>
            <th className="fx-num">PIT WITHHELD</th>
            <th className="fx-num">WEEKS</th>
            <th>M1 M2 M3</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.employeeId}>
              <td>{r.name}</td>
              <td>{r.ssn}</td>
              <td className="fx-num">{fmtMoney(r.gross)}</td>
              <td className="fx-num">{fmtMoney(r.suiWages)}</td>
              <td className="fx-num">{fmtMoney(r.excessWages)}</td>
              <td className="fx-num">{fmtMoney(r.sitWages)}</td>
              <td className="fx-num">{fmtMoney(r.sitWithheld)}</td>
              <td className="fx-num">{r.weeksWorked}</td>
              <td>{r.monthsEmployed.map((m) => (m ? '✓' : '–')).join('   ')}</td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={9} className="fx-muted">
                No employee was paid {form.state} wages this quarter.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2}>Total ({rows.length} employee{rows.length === 1 ? '' : 's'})</td>
            <td className="fx-num">{fmtMoney(sum((r) => r.gross))}</td>
            <td className="fx-num">{fmtMoney(sum((r) => r.suiWages))}</td>
            <td className="fx-num">{fmtMoney(sum((r) => r.excessWages))}</td>
            <td className="fx-num">{fmtMoney(sum((r) => r.sitWages))}</td>
            <td className="fx-num">{fmtMoney(sum((r) => r.sitWithheld))}</td>
            <td />
            <td />
          </tr>
        </tfoot>
      </table>
    </section>
  );
}

function wageListHtml(form: TaxForm): string {
  const rows = empRows(form);
  const trs = rows
    .map(
      (r) =>
        `<tr><td>${escHtml(r.name)}</td><td>${escHtml(r.ssn)}</td><td class="v">${fmtMoney(r.gross)}</td><td class="v">${fmtMoney(r.suiWages)}</td><td class="v">${fmtMoney(r.excessWages)}</td><td class="v">${fmtMoney(r.sitWages)}</td><td class="v">${fmtMoney(r.sitWithheld)}</td><td class="v">${r.weeksWorked}</td></tr>`,
    )
    .join('');
  const sum = (f: (r: StateWageRow) => number) => fmtMoney(rows.reduce((s, r) => s + f(r), 0));
  return `<div class="pf"><div class="pf-title"><b>${escHtml(form.title)}</b><span>Report of wages (continuation)</span></div>
    <table class="pf-sched"><tr><th>Employee</th><th>SSN</th><th>Total subject wages</th><th>UI taxable wages</th><th>Excess wages</th><th>PIT wages</th><th>PIT withheld</th><th>Weeks</th></tr>${trs}
    <tr><td colspan="2"><b>Total</b></td><td class="v"><b>${sum((r) => r.gross)}</b></td><td class="v"><b>${sum((r) => r.suiWages)}</b></td><td class="v"><b>${sum((r) => r.excessWages)}</b></td><td class="v"><b>${sum((r) => r.sitWages)}</b></td><td class="v"><b>${sum((r) => r.sitWithheld)}</b></td><td></td></tr></table></div>`;
}
