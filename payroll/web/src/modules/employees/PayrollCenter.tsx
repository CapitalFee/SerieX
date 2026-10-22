// Payroll Center (Employee Center, Payroll tab). Right side: tabs Pay Employees (payrolls of
// the pay schedules, Start Payroll / Extra Paycheck / Final Paycheck, past payrolls), Pay Taxes
// (taxes and deductions due with due dates and status, Pay Selected, More Tax Tasks, payments
// made) and Tax Forms (forms to file with due dates and status, File Form, forms filed); each
// tab carries a "!" when something is due
// or overdue. Left side: SerieX Books link status, a two-month calendar with paydays and due
// dates, and shortcuts to the payroll lists and settings.
import { useMemo, useState, type ReactNode } from 'react';
import { BookOpen, CalendarClock, ClipboardList, FileText, Landmark, Plus, RefreshCw, UserMinus, UserPlus } from 'lucide-react';
import {
  useBooksStatus,
  useFilings,
  useLiabilitiesDue,
  useLiabilityPayments,
  usePaychecks,
  usePaySchedules,
  useScheduledPayrolls,
} from '@/api/hooks';
import { FREQUENCY_LABELS, type FormFiling, type LiabilityDue, type LiabilityPayment, type PaycheckSummary, type ScheduledPayroll } from '@/api/types';
import { Button, Calendar, DropdownButton, ListView, Select, StatusPill, Tabs, msgBox, type ListColumn, type MenuItem } from '@/components';
import { openSerieXBooks } from '@/shell/booksLink';
import { addDays, addMonthsClamped, startOfMonth, todayIso } from '@/util/dates';
import { fmtDate } from '@/util/format';
import { openWindow } from '@/windows/windowStore';
import { CATEGORY_PAYROLL } from '@/state/catalog';
import { money$, openReport, plural } from './shared';

type PcTab = 'employees' | 'liabilities' | 'forms';

/** Same range as the shell's Liabilities Due list (last year and this year), so the data is shared. */
function dueRange() {
  const y = new Date().getFullYear();
  return { from: `${y - 1}-01-01`, to: `${y}-12-31` };
}

const dueKey = (r: LiabilityDue) => `${r.paymentGroup}|${r.periodStart}|${r.periodEnd}`;

/** "Q3 2026", "Oct 2026" or "10/30/26" (the PERIOD column). */
function periodText(start: string, end: string): string {
  if (!start || !end) return '';
  const m = (iso: string) => +iso.slice(5, 7);
  const y = end.slice(0, 4);
  if (start === end) return fmtDate(end);
  if (start.slice(8) === '01' && start.slice(0, 4) === y) {
    const months = m(end) - m(start) + 1;
    const mon = new Date(Date.UTC(+y, m(start) - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    if (months === 1) return `${mon} ${y}`;
    if (months === 3 && (m(start) - 1) % 3 === 0) return `Q${(m(start) + 2) / 3} ${y}`;
    if (months === 12) return y;
  }
  return `${fmtDate(start)} - ${fmtDate(end)}`;
}

function filingPeriod(f: FormFiling): string {
  return f.period === 'Y' ? String(f.year) : `${f.period} ${f.year}`;
}

function formName(f: FormFiling): string {
  switch (f.form) {
    case '941':
      return 'Quarterly Form 941/Sch. B';
    case '940':
      return 'Annual Form 940/Sch. A';
    case 'W-2':
      return 'Annual Form W-2/W-3';
    case 'STATE-UI':
      return `${f.state} Quarterly Wage and Unemployment Report`;
  }
  return f.title || f.form;
}

/** Opens the window of a form filing. */
export function openFiling(f: FormFiling): void {
  const q = f.period.startsWith('Q') ? Number(f.period.slice(1)) : undefined;
  switch (f.form) {
    case '941':
      openWindow('form941', { year: f.year, quarter: q });
      break;
    case '940':
      openWindow('form940', { year: f.year });
      break;
    case 'W-2':
      openWindow('formW2', { year: f.year });
      break;
    case 'STATE-UI':
      openWindow('stateWageReport', { year: f.year, quarter: q, state: f.state });
      break;
    default:
      openWindow('processForms', { year: f.year });
  }
}

function filingStatus(f: FormFiling, today: string): string {
  if (f.status === 'filed') return 'Filed';
  if (f.dueDate && f.dueDate < today) return 'Overdue';
  if (f.status === 'draft') return 'Draft';
  if (f.dueDate && f.dueDate <= addDays(today, 30)) return 'Due soon';
  return 'Not filed';
}

/** Alert level of a list of statuses: bad (overdue), warn (due) or null. */
function alertOf(statuses: string[]): 'bad' | 'warn' | null {
  if (statuses.some((s) => s === 'Overdue')) return 'bad';
  if (statuses.some((s) => s === 'Due' || s === 'Due soon')) return 'warn';
  return null;
}

function TabLabel({ label, alert }: { label: string; alert: 'bad' | 'warn' | null }) {
  return (
    <span className="sxp-pc-tablabel">
      {label}
      {alert && (
        <span className={'sxp-pc-alert' + (alert === 'bad' ? ' sxp-bad' : '')} title={alert === 'bad' ? 'Overdue' : 'Due soon'}>
          !
        </span>
      )}
    </span>
  );
}

/** One recent payroll (paychecks of a run, or of a check date for single paychecks). */
interface RecentRun {
  key: string;
  date: string;
  count: number;
  gross: number;
  net: number;
  toPrint: number;
  ids: number[];
}

function recentRuns(rows: PaycheckSummary[]): RecentRun[] {
  const m = new Map<string, RecentRun>();
  for (const p of rows) {
    if (p.voided || p.kind !== 'regular') continue;
    const key = p.runId ? `r${p.runId}` : `d${p.checkDate}`;
    let r = m.get(key);
    if (!r) {
      r = { key, date: p.checkDate, count: 0, gross: 0, net: 0, toPrint: 0, ids: [] };
      m.set(key, r);
    }
    r.count++;
    r.gross = Math.round((r.gross + p.gross) * 100) / 100;
    r.net = Math.round((r.net + p.net) * 100) / 100;
    if (p.toBePrinted) r.toPrint++;
    r.ids.push(p.id);
  }
  return [...m.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12);
}

function Section({ title, note, children, grow }: { title: string; note?: ReactNode; children: ReactNode; grow?: boolean }) {
  return (
    <section className={'sxp-pc-section' + (grow ? ' sxp-grow' : '')}>
      <div className="sxp-pc-sechead">
        <h3>{title}</h3>
        {note && <span className="sxp-emp-note">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Links({ title, items }: { title: string; items: { label: string; onClick: () => void }[] }) {
  return (
    <div className="sxp-pc-actcol">
      <span className="sxp-emp-caps">{title}</span>
      {items.map((i) => (
        <button key={i.label} type="button" className="sx-linkbtn" onClick={i.onClick}>
          {i.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// right side

export function PayrollCenterMain() {
  const today = todayIso();
  const [tab, setTab] = useState<PcTab>('employees');
  const scheduled = useScheduledPayrolls();
  const due = useLiabilitiesDue(useMemo(dueRange, []));
  const year = +today.slice(0, 4);
  const [formYear, setFormYear] = useState(year);
  const filings = useFilings(formYear);

  const sched = scheduled.data ?? [];
  const dueRows = (due.data ?? []).filter((r) => r.status !== 'Paid' && r.amountDue > 0);
  const forms = filings.data ?? [];
  const alerts = {
    employees: alertOf(sched.map((s) => s.status)),
    liabilities: alertOf(dueRows.map((r) => r.status)),
    forms: alertOf(forms.map((f) => filingStatus(f, today))),
  };

  return (
    <div className="sxp-pc">
      <Tabs
        fill
        active={tab}
        onChange={(k) => setTab(k as PcTab)}
        aria-label="Payroll Center"
        tabs={[
          { key: 'employees', label: <TabLabel label="Pay Employees" alert={alerts.employees} /> },
          { key: 'liabilities', label: <TabLabel label="Pay Taxes" alert={alerts.liabilities} /> },
          { key: 'forms', label: <TabLabel label="Tax Forms" alert={alerts.forms} /> },
        ]}
      >
        {tab === 'employees' && <PayEmployeesTab rows={sched} loading={scheduled.isLoading} />}
        {tab === 'liabilities' && <PayLiabilitiesTab rows={dueRows} loading={due.isLoading} error={due.error as Error | null} />}
        {tab === 'forms' && <FileFormsTab rows={forms} loading={filings.isLoading} error={filings.error as Error | null} year={formYear} setYear={setFormYear} />}
      </Tabs>
      <BooksLine />
    </div>
  );
}

function BooksLine() {
  const st = useBooksStatus().data;
  if (!st) return null;
  const ok = st.reachable && st.sessionOk;
  return (
    <div className="sxp-pc-booksline">
      <span className={'sxp-pc-dot' + (!ok ? ' sxp-bad' : st.errorCount || st.pendingCount ? ' sxp-warn' : '')} />
      <span>
        {ok ? `Linked to SerieX Books: ${st.companyName || 'company file'}` : st.message || 'SerieX Books is not reachable.'}
        {st.postToBooks ? '' : ' · posting to SerieX Books is turned off'}
        {st.pendingCount + st.errorCount > 0 ? ` · ${plural(st.pendingCount + st.errorCount, 'record')} not posted` : ''}
      </span>
      {st.pendingCount + st.errorCount > 0 && (
        <button type="button" className="sx-linkbtn" onClick={() => openWindow('booksSync', { tab: 'pending' })}>
          Books Sync…
        </button>
      )}
    </div>
  );
}

function PayEmployeesTab({ rows, loading }: { rows: ScheduledPayroll[]; loading: boolean }) {
  const schedules = usePaySchedules({ active: 'active' }).data;
  const from = useMemo(() => addDays(todayIso(), -180), []);
  const recent = usePaychecks({ kind: 'regular', from });
  const [sel, setSel] = useState<number | null>(null);
  const cur = rows.find((r) => r.payScheduleId === sel) ?? rows[0] ?? null;
  const runs = useMemo(() => recentRuns(recent.data ?? []), [recent.data]);
  const noSchedules = schedules !== undefined && schedules.length === 0;

  const start = (r: ScheduledPayroll | null = cur) => r && openWindow('payEmployees', { kind: 'scheduled', scheduleId: r.payScheduleId });
  const scheduleMenu: MenuItem[] = [
    { label: '&New Pay Schedule...', onClick: () => openWindow('payScheduleEdit', {}) },
    { label: '&Edit Schedule...', disabled: !cur, onClick: () => cur && openWindow('payScheduleEdit', { id: cur.payScheduleId }) },
    { separator: true },
    { label: 'All Pay &Schedules', onClick: () => openWindow('paySchedules') },
  ];

  const columns: ListColumn<ScheduledPayroll>[] = [
    { key: 'name', label: 'Pay schedule', width: 170, grow: true },
    { key: 'frequency', label: 'Frequency', width: 100, render: (r) => FREQUENCY_LABELS[r.frequency] ?? r.frequency },
    { key: 'periodEnd', label: 'Pay period', width: 170, sortValue: (r) => r.periodEnd, render: (r) => `${fmtDate(r.periodStart)} - ${fmtDate(r.periodEnd)}` },
    { key: 'checkDate', label: 'Check date', width: 100, type: 'date' },
    { key: 'status', label: 'Status', width: 112, render: (r) => <StatusPill status={r.status} tone={r.status === 'Due' ? 'warning' : r.status === 'Upcoming' ? 'info' : undefined} /> },
    { key: 'employeeCount', label: 'Employees', width: 96, type: 'number' },
  ];
  const runColumns: ListColumn<RecentRun>[] = [
    { key: 'date', label: 'Date', width: 100, type: 'date' },
    { key: 'status', label: 'Status', width: 110, sortValue: (r) => (r.toPrint ? 0 : 1), render: (r) => <StatusPill status={r.toPrint ? 'To print' : 'Complete'} tone={r.toPrint ? 'warning' : 'success'} /> },
    { key: 'count', label: 'Paycheck count', width: 130, type: 'number' },
    { key: 'gross', label: 'Gross pay', width: 120, type: 'money' },
    { key: 'net', label: 'Net pay', width: 120, type: 'money', grow: true },
  ];

  return (
    <div className="sxp-pc-body">
      <Section title="Payrolls to Run" note={rows.length ? `${plural(rows.length, 'pay schedule')}` : undefined} grow>
        {noSchedules && (
          <div className="sxp-emp-notice">
            <CalendarClock size={15} aria-hidden="true" />
            <span>
              <button type="button" className="sx-linkbtn" onClick={() => openWindow('payScheduleEdit', {})}>
                Add a pay schedule
              </button>{' '}
              to pay a group of employees at the same time. Its next payroll then shows up here.
            </span>
          </div>
        )}
        <ListView<ScheduledPayroll>
          className="sxp-pc-list"
          aria-label="Payrolls to run"
          columns={columns}
          rows={rows}
          getKey={(r) => r.payScheduleId}
          loading={loading}
          selectedKey={cur?.payScheduleId ?? null}
          onSelect={(k) => setSel(k as number)}
          onActivate={(r) => start(r)}
          contextMenu={(r) => (r ? [{ label: '&Start Payroll', onClick: () => start(r) }, { label: '&Edit Schedule...', onClick: () => openWindow('payScheduleEdit', { id: r.payScheduleId }) }] : scheduleMenu)}
          persistKey="pc-scheduled"
          emptyText={
            <div className="sxp-emp-empty-small">
              {noSchedules ? 'No pay schedules.' : 'No pay schedule has active employees. Give employees a pay schedule on their Payroll Info tab.'}
            </div>
          }
        />
        <div className="sxp-pc-buttons">
          <DropdownButton label="Pay &Schedules" items={scheduleMenu} up />
          <Button label="E&xtra Paycheck" onClick={() => openWindow('payEmployees', { kind: 'unscheduled' })} />
          <Button icon={UserMinus} label="Fi&nal Paycheck" onClick={() => openWindow('payEmployees', { kind: 'termination' })} />
          <span className="sxp-emp-note" />
          <Button variant="primary" label="Start &Payroll" disabled={!cur} onClick={() => start()} />
        </div>
      </Section>
      <Section title="Past Payrolls" note="Last 6 months">
        <ListView<RecentRun>
          className="sxp-pc-list sxp-short"
          aria-label="Past payrolls"
          columns={runColumns}
          rows={runs}
          getKey={(r) => r.key}
          loading={recent.isLoading}
          onActivate={() => openWindow('editVoidPaychecks', {})}
          contextMenu={(r) =>
            r
              ? [
                  { label: 'Find and &Edit Paychecks...', onClick: () => openWindow('editVoidPaychecks', {}) },
                  { label: '&Print Paychecks...', disabled: !r.toPrint, onClick: () => openWindow('printPaychecks', { ids: r.ids }) },
                  { label: 'Print Pay &Stubs...', onClick: () => openWindow('printPayStubs', { ids: r.ids }) },
                ]
              : []
          }
          persistKey="pc-recent"
          emptyText={<div className="sxp-emp-empty-small">No paychecks in the last 6 months.</div>}
        />
      </Section>
      <div className="sxp-pc-activities">
        <Links
          title="Other activities"
          items={[
            { label: 'Add Employee', onClick: () => openWindow('employeeEdit', {}) },
            { label: 'Find and Edit Paychecks', onClick: () => openWindow('editVoidPaychecks', {}) },
            { label: 'Print Paychecks', onClick: () => openWindow('printPaychecks', {}) },
            { label: 'Print Pay Stubs', onClick: () => openWindow('printPayStubs', {}) },
            { label: 'Final Paycheck', onClick: () => openWindow('payEmployees', { kind: 'termination' }) },
          ]}
        />
        <Links
          title="Setup"
          items={[
            { label: 'Enter Year-to-Date Amounts', onClick: () => openWindow('ytdSetup', {}) },
            { label: 'Payroll Items', onClick: () => openWindow('payrollItemList') },
            { label: 'Pay Schedules', onClick: () => openWindow('paySchedules') },
            { label: 'Employee Defaults', onClick: () => openWindow('employeeDefaults') },
          ]}
        />
        <Links
          title="Reports"
          items={[
            { label: 'Payroll Summary', onClick: () => openReport('payroll_summary', { dates: 'thisFiscalQuarter' }) },
            { label: 'Payroll Detail Review', onClick: () => openReport('payroll_detail_review', { dates: 'thisMonthToDate' }) },
            { label: 'Payroll Register', onClick: () => openReport('payroll_register', { dates: 'thisFiscalQuarter' }) },
            { label: 'Report Center…', onClick: () => openWindow('reportCenter', { category: CATEGORY_PAYROLL }) },
          ]}
        />
      </div>
    </div>
  );
}

function PayLiabilitiesTab({ rows, loading, error }: { rows: LiabilityDue[]; loading: boolean; error: Error | null }) {
  const today = todayIso();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const yearStart = today.slice(0, 4) + '-01-01';
  const history = useLiabilityPayments({ from: addDays(yearStart, -366) });
  const [histKind, setHistKind] = useState<'all' | 'e-pay'>('all');
  const picked = rows.filter((r) => checked.has(dueKey(r)));
  const total = picked.reduce((s, r) => s + r.amountDue, 0);
  const allOn = rows.length > 0 && picked.length === rows.length;

  const toggle = (k: string, on: boolean) =>
    setChecked((s) => {
      const n = new Set(s);
      if (on) n.add(k);
      else n.delete(k);
      return n;
    });
  // one tax payment per payee and period (rows of the same payee and period share the check)
  const pay = async (list: LiabilityDue[]) => {
    const noPayee = list.filter((r) => !r.agencyVendorId);
    for (const r of list)
      if (r.agencyVendorId) openWindow('liabilityPayment', { agencyVendorId: r.agencyVendorId, periodStart: r.periodStart, periodEnd: r.periodEnd, kind: 'payment' });
    if (noPayee.length) {
      const names = [...new Set(noPayee.flatMap((r) => r.items.map((i) => i.itemName)))];
      const r = await msgBox({
        title: 'No Payee',
        message: `These payroll items have no payee (the agency you pay), so no tax payment can be made for them yet:\n\n${names.join(', ')}\n\nOpen each item in Payroll Items and choose the agency you pay it to, then pay it here.`,
        buttons: ['Open Payroll &Items', 'Cancel'],
        icon: 'warning',
      });
      if (r === 'Open Payroll Items') openWindow('payrollItemList');
    }
  };

  const related: MenuItem[] = [
    { label: '&Pay Payroll Taxes...', onClick: () => openWindow('payLiabilities') },
    { label: '&Record a Tax Payment...', onClick: () => openWindow('liabilityPayment', {}) },
    { label: '&Adjust Tax Balances...', onClick: () => openWindow('adjustLiabilities', {}) },
    { label: 'Record &Earlier Tax Payments...', onClick: () => openWindow('priorPayments') },
    { label: 'Tax Payment &Schedule...', onClick: () => openWindow('paymentSchedules') },
    { separator: true },
    { label: 'Payroll Liability &Balances report', onClick: () => openReport('payroll_liability_balances', { dates: 'thisFiscalYear' }) },
  ];

  const columns: ListColumn<LiabilityDue>[] = [
    {
      key: '__chk',
      label: (
        <input
          type="checkbox"
          className="sxp-pc-check"
          aria-label="Select all"
          checked={allOn}
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => setChecked(e.target.checked ? new Set(rows.map(dueKey)) : new Set())}
        />
      ),
      width: 34,
      sortable: false,
      align: 'center',
      render: (r) => (
        <input
          type="checkbox"
          className="sxp-pc-check"
          aria-label={`Select ${r.label} ${periodText(r.periodStart, r.periodEnd)}`}
          checked={checked.has(dueKey(r))}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onChange={(e) => toggle(dueKey(r), e.target.checked)}
        />
      ),
    },
    { key: 'dueDate', label: 'Due date', width: 96, type: 'date' },
    { key: 'status', label: 'Status', width: 112, render: (r) => <StatusPill status={r.status} tone={r.status === 'Due' ? 'warning' : r.status === 'Upcoming' ? 'info' : undefined} /> },
    { key: 'label', label: 'Payment', width: 200, grow: true, render: (r) => <span title={r.agencyName}>{r.label || r.agencyName || r.paymentGroup}</span> },
    { key: 'periodEnd', label: 'Period', width: 120, render: (r) => periodText(r.periodStart, r.periodEnd) },
    { key: 'method', label: 'Method', width: 80, render: (r) => (r.method === 'e-pay' ? 'E-pay' : 'Check') },
    { key: 'amountDue', label: 'Amount due', width: 110, type: 'money' },
  ];

  const hist = (history.data ?? []).filter((p) => !p.voided && (histKind === 'all' || p.method === 'e-pay')).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  const histColumns: ListColumn<LiabilityPayment>[] = [
    { key: 'date', label: 'Date', width: 92, type: 'date' },
    { key: 'kind', label: 'Type', width: 110, render: (p) => (p.kind === 'prior' ? 'Earlier payment' : p.method === 'e-pay' ? 'E-payment' : 'Check') },
    { key: 'checkNumber', label: 'Check number', width: 100 },
    { key: 'periodEnd', label: 'Period end date', width: 110, type: 'date' },
    { key: 'agencyName', label: 'Payee', width: 180, grow: true },
    { key: 'bankAccountName', label: 'Account', width: 120 },
    { key: 'amount', label: 'Amount', width: 100, type: 'money' },
  ];

  return (
    <div className="sxp-pc-body">
      <Section title="Taxes and Deductions Due" note={rows.length ? `${plural(rows.length, 'payment')} to make` : undefined} grow>
        {error && <div className="sxp-emp-notice sxp-warn">The taxes due could not be loaded: {error.message}</div>}
        <ListView<LiabilityDue>
          className="sxp-pc-list"
          aria-label="Taxes and deductions due"
          columns={columns}
          rows={rows}
          getKey={dueKey}
          loading={loading}
          selectedKey={sel}
          onSelect={(k) => setSel(k as string)}
          onActivate={(r) => void pay([r])}
          contextMenu={(r) => (r ? [{ label: 'Pa&y This Payment...', onClick: () => void pay([r]) }, { separator: true }, ...related] : related)}
          persistKey="pc-due"
          onKeyDown={(e) => {
            if (e.key === ' ' && sel) {
              e.preventDefault();
              toggle(sel, !checked.has(sel));
            }
          }}
          emptyText={<div className="sxp-emp-empty-small">No payroll taxes are due. Taxes and deductions show up here after you create paychecks.</div>}
        />
        <div className="sxp-pc-buttons">
          <DropdownButton label="&More Tax Tasks" items={related} up />
          <Button label="&Adjust Tax Balances…" onClick={() => openWindow('adjustLiabilities', {})} />
          <span className="sxp-pc-total">Selected total: {money$(total)}</span>
          <Button variant="primary" label="&Pay Selected…" disabled={!picked.length} onClick={() => void pay(picked)} />
        </div>
      </Section>
      <Section
        title="Payments Made"
        note={
          <Select
            value={histKind}
            onChange={(v) => setHistKind(v as 'all' | 'e-pay')}
            aria-label="Payments made"
            options={[
              { value: 'all', label: 'All Payments' },
              { value: 'e-pay', label: 'E-Payments' },
            ]}
          />
        }
      >
        <ListView<LiabilityPayment>
          className="sxp-pc-list sxp-short"
          aria-label="Payments made"
          columns={histColumns}
          rows={hist}
          loading={history.isLoading}
          onActivate={(p) => openWindow('liabilityPayment', { id: p.id })}
          persistKey="pc-history"
          emptyText={<div className="sxp-emp-empty-small">No tax payments yet.</div>}
        />
      </Section>
    </div>
  );
}

function FileFormsTab({ rows, loading, error, year, setYear }: { rows: FormFiling[]; loading: boolean; error: Error | null; year: number; setYear(y: number): void }) {
  const today = todayIso();
  const [sel, setSel] = useState<string | null>(null);
  const key = (f: FormFiling) => `${f.form}|${f.year}|${f.period}|${f.state}`;
  const cur = rows.find((f) => key(f) === sel) ?? null;
  const thisYear = +today.slice(0, 4);
  const years = [thisYear + 1, thisYear, thisYear - 1, thisYear - 2];
  const quarter = Math.floor((+today.slice(5, 7) - 1) / 3) + 1;
  const open = rows.filter((f) => f.status !== 'filed');
  const filed = rows.filter((f) => f.status === 'filed').sort((a, b) => (b.filedAt || '').localeCompare(a.filedAt || ''));

  const columns: ListColumn<FormFiling>[] = [
    { key: 'form', label: 'Form', width: 260, grow: true, sortValue: (f) => formName(f), render: (f) => <span title={f.title}>{formName(f)}</span> },
    { key: 'scope', label: 'Federal/State', width: 124, render: (f) => (f.state ? f.state : 'Federal') },
    { key: 'period', label: 'Filing period', width: 110, sortValue: (f) => `${f.year}${f.period}`, render: (f) => filingPeriod(f) },
    { key: 'dueDate', label: 'Due date', width: 100, type: 'date' },
    {
      key: 'status',
      label: 'Status',
      width: 100,
      sortValue: (f) => filingStatus(f, today),
      render: (f) => {
        const s = filingStatus(f, today);
        return <StatusPill status={s} tone={s === 'Due soon' ? 'warning' : s === 'Not filed' ? 'neutral' : undefined} />;
      },
    },
  ];
  const histColumns: ListColumn<FormFiling>[] = [
    { key: 'filedAt', label: 'Filed', width: 110, render: (f) => fmtDate(f.filedAt.slice(0, 10)) },
    { key: 'form', label: 'Form', width: 260, grow: true, render: (f) => formName(f) },
    { key: 'period', label: 'Period', width: 110, render: (f) => filingPeriod(f) },
  ];

  return (
    <div className="sxp-pc-body">
      <Section
        title="Forms to File"
        note={<Select value={year} onChange={(v) => setYear(Number(v))} aria-label="Year" options={years.map((y) => ({ value: y, label: String(y) }))} />}
        grow
      >
        {error && <div className="sxp-emp-notice sxp-warn">The forms could not be loaded: {error.message}</div>}
        <ListView<FormFiling>
          className="sxp-pc-list"
          aria-label="Forms to file"
          columns={columns}
          rows={open}
          getKey={key}
          loading={loading}
          selectedKey={sel}
          onSelect={(k) => setSel(k as string)}
          onActivate={(f) => openFiling(f)}
          contextMenu={(f) => (f ? [{ label: '&File Form...', onClick: () => openFiling(f) }] : [])}
          persistKey="pc-forms"
          emptyText={<div className="sxp-emp-empty-small">No forms to file for {year}. Forms appear here once you have paychecks in the year.</div>}
        />
        <div className="sxp-pc-buttons">
          <Button icon={FileText} label="All Tax &Forms…" onClick={() => openWindow('processForms', { year })} />
          <DropdownButton
            label="F&orms"
            up
            items={[
              { label: `Form &941 (Q${quarter} ${thisYear})...`, onClick: () => openWindow('form941', { year: thisYear, quarter }) },
              { label: `Form 9&40 (${year})...`, onClick: () => openWindow('form940', { year }) },
              { label: `&W-2/W-3 (${year})...`, onClick: () => openWindow('formW2', { year }) },
              { separator: true },
              { label: 'Tax Form &Worksheets (941)', onClick: () => openReport('tax_form_941_worksheet', { year: String(thisYear), quarter: String(quarter) }) },
            ]}
          />
          <span className="sxp-emp-note" />
          <Button variant="primary" label="&File Form" disabled={!cur} onClick={() => cur && openFiling(cur)} />
        </div>
      </Section>
      <Section title="Forms Filed">
        <ListView<FormFiling>
          className="sxp-pc-list sxp-short"
          aria-label="Forms filed"
          columns={histColumns}
          rows={filed}
          getKey={key}
          onActivate={(f) => openFiling(f)}
          persistKey="pc-filed"
          emptyText={<div className="sxp-emp-empty-small">No forms marked as filed for {year}.</div>}
        />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// left side

export function PayrollCenterLeft() {
  const today = todayIso();
  const st = useBooksStatus().data;
  const scheduled = useScheduledPayrolls().data ?? [];
  const due = useLiabilitiesDue(useMemo(dueRange, [])).data ?? [];
  const [view, setView] = useState(startOfMonth(today));
  const paydays = new Set(scheduled.map((s) => s.checkDate));
  const dueDays = new Set(due.filter((d) => d.status !== 'Paid' && d.amountDue > 0).map((d) => d.dueDate));
  const next = addMonthsClamped(view, 1);
  const ok = !!st && st.reachable && st.sessionOk;
  const marked = (d: string) => paydays.has(d) || dueDays.has(d);
  const pick = (d: string) => {
    if (paydays.has(d)) {
      const s = scheduled.find((x) => x.checkDate === d);
      if (s) openWindow('payEmployees', { kind: 'scheduled', scheduleId: s.payScheduleId });
    } else if (dueDays.has(d)) openWindow('payLiabilities');
  };
  return (
    <div className="sxp-pc-left">
      <div className="sxp-pc-status">
        <span className="sxp-emp-caps">SerieX Books link</span>
        <span className="sxp-pc-statusline">
          <span className={'sxp-pc-dot' + (!st ? ' sxp-warn' : !ok ? ' sxp-bad' : '')} />
          {!st ? 'Checking…' : ok ? 'Connected' : st.reachable ? 'Sign in again' : 'Not reachable'}
        </span>
        {st && <span className="sxp-emp-note">{ok ? st.companyName : st.message}</span>}
        {st && st.pendingCount + st.errorCount > 0 && <span className="sxp-emp-note">{plural(st.pendingCount + st.errorCount, 'record')} waiting to post</span>}
        <div className="sxp-pc-links">
          <button type="button" className="sx-linkbtn" onClick={() => openWindow('booksSync', {})}>
            <RefreshCw size={12} /> Books Sync…
          </button>
          <button type="button" className="sx-linkbtn" onClick={openSerieXBooks}>
            <BookOpen size={12} /> Open SerieX Books
          </button>
        </div>
      </div>
      <div className="sxp-pc-cal">
        <Calendar value="" view={view} onView={setView} onPick={pick} marked={marked} showToday={false} />
      </div>
      <div className="sxp-pc-cal">
        <Calendar value="" view={next} onView={(v) => setView(addMonthsClamped(v, -1))} onPick={pick} marked={marked} showToday={false} />
      </div>
      <div className="sxp-emp-note">Dots mark paydays of your pay schedules and the due dates of payroll taxes.</div>
      <div className="sxp-pc-links">
        <span className="sxp-emp-caps">Payroll lists and settings</span>
        <button type="button" className="sx-linkbtn" onClick={() => openWindow('payrollItemList')}>
          Payroll Items
        </button>
        <button type="button" className="sx-linkbtn" onClick={() => openWindow('paySchedules')}>
          Pay Schedules
        </button>
        <button type="button" className="sx-linkbtn" onClick={() => openWindow('employeeDefaults')}>
          Employee Defaults
        </button>
        <button type="button" className="sx-linkbtn" onClick={() => openWindow('companyPayroll')}>
          Company Payroll Information
        </button>
        <button type="button" className="sx-linkbtn" onClick={() => openWindow('taxTables', {})}>
          Tax Tables
        </button>
        <button type="button" className="sx-linkbtn" onClick={() => openWindow('preferences', {})}>
          Preferences
        </button>
      </div>
    </div>
  );
}

/** Toolbar buttons of the Payroll Center (Payroll tab). */
export function payrollToolbarItems(): { label: string; icon: typeof Plus; onClick: () => void }[] {
  return [
    { label: 'Payroll Items', icon: ClipboardList, onClick: () => openWindow('payrollItemList') },
    { label: 'Pay Schedules', icon: CalendarClock, onClick: () => openWindow('paySchedules') },
    { label: 'Employee Defaults', icon: UserPlus, onClick: () => openWindow('employeeDefaults') },
    { label: 'Payroll Setup', icon: Landmark, onClick: () => openWindow('payrollSetup') },
  ];
}

