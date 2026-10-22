// Home page in the look of the SerieX Books Home page: dashboard cards (next payroll, payroll
// taxes due, last payroll, tax forms due) above the payroll workflow diagram, with the PAYROLL SUMMARY
// (this year's totals) and the SerieX Books link status on the right. A banner leads back to
// Payroll Setup while it is not finished.
import { useMemo, useState, type ReactNode } from 'react';
import { AlertCircle, BookOpen, CalendarClock, CheckCircle2, Circle, FileText, HandCoins, Link2, ReceiptText, RefreshCw, WandSparkles } from 'lucide-react';
import { invalidateAll, useBooksStatus, useCompany, useEmployees, useFilings, useLiabilitiesDue, usePaychecks, useScheduledPayrolls } from '@/api/hooks';
import type { FormFiling, LiabilityDue, PaycheckSummary, ScheduledPayroll } from '@/api/types';
import { Badge, Button, Card, Spinner } from '@/components';
import { openWindow } from '@/windows/windowStore';
import { useSession } from '@/state/session';
import { groupDue, startPayEmployees } from '@/shell/data';
import { openSerieXBooks } from '@/shell/booksLink';
import { longDate, todayIso } from '@/util/dates';
import { fmtDate } from '@/util/format';
import { PayrollWorkflow } from './PayrollWorkflow';
import { SETUP_STEPS } from './setupSteps';
import { money0, money2 } from './shared';
import './company.css';

export interface HomePageProps {}

const STATUS_TONE: Record<string, 'danger' | 'warning' | 'neutral' | 'success'> = { Overdue: 'danger', Due: 'warning', Upcoming: 'neutral', Paid: 'success' };

export default function HomePage(_props: HomePageProps) {
  const companyName = useSession((s) => s.company?.name ?? '');
  const [spin, setSpin] = useState(false);
  return (
    <div className="cx-home pc-home">
      <div className="cx-home-top">
        <div className="cx-home-hello">
          <b>{companyName}</b>
          <span className="cx-muted">{longDate(todayIso())}</span>
        </div>
        <span className="cx-spacer" />
        <Button
          variant="ghost"
          size="sm"
          icon={RefreshCw}
          label="Refresh"
          busy={spin}
          onClick={() => {
            setSpin(true);
            void invalidateAll().finally(() => setSpin(false));
          }}
        />
      </div>
      <HomeDashboard />
    </div>
  );
}

// ---------------------------------------------------------------------------

function useYear() {
  const t = todayIso();
  const y = t.slice(0, 4);
  return { year: Number(y), from: `${y}-01-01`, to: `${y}-12-31`, today: t };
}

/** Paychecks of this calendar year that count (not voided). */
function usePaychecksThisYear() {
  const { from, to } = useYear();
  const q = usePaychecks({ from, to });
  const rows = useMemo(() => (q.data ?? []).filter((p) => !p.voided), [q.data]);
  return { ...q, rows };
}

function HomeDashboard() {
  const company = useCompany().data;
  const books = useBooksStatus().data;
  const { year } = useYear();
  const dueRange = useMemo(() => ({ from: `${year - 1}-01-01`, to: `${year}-12-31` }), [year]);
  const due = useLiabilitiesDue(dueRange);
  const dueRows = useMemo(() => (Array.isArray(due.data) ? due.data : []), [due.data]);
  const groups = useMemo(() => groupDue(dueRows), [dueRows]);
  const overdue = groups.filter((g) => g.status === 'Overdue');
  const pending = (books?.pendingCount ?? 0) + (books?.errorCount ?? 0);

  return (
    <div className="cx-home-body">
      {company && !company.setupDone && <SetupBanner state={company.setupState} />}
      <div className="cx-dash pc-dash">
        <NextPayrollCard />
        <LiabilitiesCard loading={due.isLoading} error={due.error as Error | null} groups={groups} rows={dueRows} />
        <LastPayrollCard />
        <FormsCard year={year} />
      </div>
      <div className="cx-home-lower">
        <Card title="Workflows" subtitle="The order of payroll work each pay period. Click an icon to start." className="cx-wf-card">
          <PayrollWorkflow pending={pending} overdue={overdue.length} />
        </Card>
        <div className="cx-home-side">
          <PayrollSummaryCard />
          <BooksCard />
        </div>
      </div>
    </div>
  );
}

/** Payroll Setup is not finished: show how far it got and a way back. */
function SetupBanner({ state }: { state: Record<string, unknown> }) {
  const done = Array.isArray(state?.done) ? (state.done as string[]) : [];
  const count = SETUP_STEPS.filter((s) => s.key === 'file' || done.includes(s.key)).length;
  return (
    <section className="cx-getstarted pc-setupbanner">
      <div className="cx-row">
        <WandSparkles size={18} color="var(--sx-accent)" />
        <div>
          <div className="cx-h2" style={{ margin: 0 }}>
            Finish setting up payroll
          </div>
          <div className="cx-muted cx-small">
            {count} of {SETUP_STEPS.length} steps done. Add your payroll items, employees and the amounts you already paid this year before your first payroll.
          </div>
        </div>
        <div className="cx-gs-progress" aria-hidden="true">
          <span style={{ width: `${(count / SETUP_STEPS.length) * 100}%` }} />
        </div>
        <span className="cx-spacer" />
        <Button variant="primary" label="Continue Payroll Setup" onClick={() => openWindow('payrollSetup')} />
      </div>
    </section>
  );
}

/** A dashboard card with a title row and a body (same look as the SerieX Books Home page). */
function DashCard({ title, icon, onTitle, children, footer }: { title: string; icon: ReactNode; onTitle?: () => void; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="cx-dcard">
      <header className="cx-dcard-head">
        <span className="cx-dcard-icon">{icon}</span>
        {onTitle ? (
          <button type="button" className="cx-dcard-title cx-linklike" onClick={onTitle}>
            {title}
          </button>
        ) : (
          <span className="cx-dcard-title">{title}</span>
        )}
      </header>
      <div className="cx-dcard-body">{children}</div>
      {footer && <footer className="cx-dcard-foot">{footer}</footer>}
    </section>
  );
}

function NextPayrollCard() {
  const q = useScheduledPayrolls();
  const rows: ScheduledPayroll[] = q.data ?? [];
  const next = rows[0];
  return (
    <DashCard
      title="Pay employees"
      icon={<CalendarClock size={15} />}
      onTitle={startPayEmployees}
      footer={
        <div className="cx-row" style={{ gap: 6 }}>
          <Button size="sm" variant={next && next.status !== 'Upcoming' ? 'primary' : 'secondary'} label="Pay Employees" onClick={startPayEmployees} />
          <button type="button" className="sx-linkbtn cx-small" onClick={() => openWindow('payEmployees', { kind: 'unscheduled' })}>
            Extra paycheck
          </button>
        </div>
      }
    >
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <div className="cx-muted cx-small">{(q.error as Error).message}</div>
      ) : !next ? (
        <div className="cx-muted cx-small">
          No payroll is coming up. Give your employees a pay schedule, or pay them with an extra paycheck.{' '}
          <button type="button" className="sx-linkbtn" onClick={() => openWindow('paySchedules')}>
            Pay schedules
          </button>
        </div>
      ) : (
        <>
          <div className="cx-figure-label">Next check date</div>
          <div className="cx-dcard-big">
            {fmtDate(next.checkDate)} <span>{next.name}</span>
          </div>
          <ul className="cx-tasklist">
            {rows.slice(0, 3).map((r) => (
              <li key={r.payScheduleId}>
                <button
                  type="button"
                  className="cx-task"
                  onClick={() => openWindow('payEmployees', { kind: 'scheduled', scheduleId: r.payScheduleId })}
                  title={`Pay period ${fmtDate(r.periodStart)} - ${fmtDate(r.periodEnd)}`}
                >
                  {r.status === 'Overdue' ? <AlertCircle size={14} color="var(--sx-danger)" /> : <Circle size={14} color="#94a3b8" />}
                  <span className="cx-task-text">
                    {r.name} · {r.employeeCount} employee{r.employeeCount === 1 ? '' : 's'}
                  </span>
                  <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status}</Badge>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </DashCard>
  );
}

function LiabilitiesCard({ loading, error, groups, rows }: { loading: boolean; error: Error | null; groups: ReturnType<typeof groupDue>; rows: LiabilityDue[] }) {
  // a payment group mixes overdue and later periods: the figures add up the periods themselves
  const open = rows.filter((r) => r.status !== 'Paid' && r.amountDue > 0);
  const sum = (list: LiabilityDue[]) => Math.round(list.reduce((s, r) => s + r.amountDue, 0) * 100) / 100;
  const total = sum(open);
  const overdue = sum(open.filter((r) => r.status === 'Overdue'));
  const dueSoon = sum(open.filter((r) => r.status === 'Due'));
  const openPay = () => openWindow('payLiabilities');
  return (
    <DashCard title="Payroll taxes" icon={<HandCoins size={15} />} onTitle={openPay}>
      {loading ? (
        <Spinner />
      ) : error ? (
        <div className="cx-muted cx-small">{error.message}</div>
      ) : groups.length === 0 ? (
        <div className="cx-alldone">
          <CheckCircle2 size={18} color="var(--sx-success)" />
          <span>Nothing to pay right now.</span>
        </div>
      ) : (
        <>
          <div className="cx-dcard-big">
            {money0(total)} <span>to pay</span>
          </div>
          <div className="cx-figrow">
            <button type="button" className="cx-figure" onClick={openPay}>
              <span className="cx-figure-value">{money0(overdue)}</span>
              <span className={'cx-figure-label' + (overdue > 0 ? ' cx-tone-danger' : '')}>Overdue</span>
            </button>
            <button type="button" className="cx-figure cx-right" onClick={openPay}>
              <span className="cx-figure-value">{money0(dueSoon)}</span>
              <span className="cx-figure-label">Due soon</span>
            </button>
          </div>
          <ul className="cx-tasklist" style={{ marginTop: 6 }}>
            {groups.slice(0, 3).map((g) => (
              <li key={g.paymentGroup}>
                <button type="button" className="cx-task" onClick={openPay} title={g.agencyName}>
                  {g.status === 'Overdue' ? <AlertCircle size={14} color="var(--sx-danger)" /> : <Circle size={14} color="#94a3b8" />}
                  <span className="cx-task-text">
                    {g.label} <span className="cx-muted cx-small">due {fmtDate(g.dueDate)}</span>
                  </span>
                  <span className="cx-num">{money2(g.amount)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </DashCard>
  );
}

/** Paychecks of the most recent check date (the last payroll). */
function lastPayroll(rows: PaycheckSummary[]) {
  const regular = rows.filter((p) => p.kind === 'regular');
  if (!regular.length) return null;
  const date = regular.reduce((m, p) => (p.checkDate > m ? p.checkDate : m), '');
  const checks = regular.filter((p) => p.checkDate === date);
  const sum = (f: (p: PaycheckSummary) => number) => checks.reduce((s, p) => s + f(p), 0);
  return {
    date,
    count: checks.length,
    gross: sum((p) => p.gross),
    taxes: sum((p) => p.employeeTaxes),
    deductions: sum((p) => p.deductions),
    net: sum((p) => p.net),
    employer: sum((p) => p.employerTaxes + p.contributions),
  };
}

function LastPayrollCard() {
  const q = usePaychecksThisYear();
  const last = useMemo(() => lastPayroll(q.rows), [q.rows]);
  const open = () => (last ? openWindow('report', { key: 'payroll_register', params: { from: last.date, to: last.date } }) : openWindow('editVoidPaychecks'));
  return (
    <DashCard title="Last payroll" icon={<ReceiptText size={15} />} onTitle={open}>
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <div className="cx-muted cx-small">{(q.error as Error).message}</div>
      ) : !last ? (
        <div className="cx-muted cx-small">No paychecks this year yet.</div>
      ) : (
        <>
          <div className="cx-figure-label">
            {fmtDate(last.date)} · {last.count} paycheck{last.count === 1 ? '' : 's'}
          </div>
          <button type="button" className="cx-figure" onClick={open} style={{ width: '100%' }}>
            <span className="cx-dcard-big" style={{ margin: '2px 0 4px' }}>
              {money2(last.net)} <span>net pay</span>
            </span>
          </button>
          <table className="cx-baltable cx-inwidget pc-mini">
            <tbody>
              <tr>
                <td>Gross pay</td>
                <td className="cx-num cx-right">{money2(last.gross)}</td>
              </tr>
              <tr>
                <td>Taxes withheld</td>
                <td className="cx-num cx-right">{money2(last.taxes)}</td>
              </tr>
              <tr>
                <td>Employer taxes & contributions</td>
                <td className="cx-num cx-right">{money2(last.employer)}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}
    </DashCard>
  );
}

/** Short name of a form to file ("Form 941 (Q3 2026)", "CA unemployment (Q3 2026)"). */
function formLabel(f: FormFiling): string {
  const per = f.period && f.period !== String(f.year) ? `${f.period} ${f.year}` : String(f.year);
  switch (f.form) {
    case '941':
      return `Form 941 (${per})`;
    case '940':
      return `Form 940 (${f.year})`;
    case 'W2':
    case 'W-2':
      return `W-2 and W-3 (${f.year})`;
    case 'STATE-UI':
      return f.title && f.title.length <= 32 ? f.title : `${f.state} unemployment report (${per})`;
    default:
      return f.title || `${f.form} (${per})`;
  }
}

function FormsCard({ year }: { year: number }) {
  const q = useFilings();
  const today = todayIso();
  const open = (q.data ?? []).filter((f) => f.status !== 'filed' && (f.year === year || f.year === year - 1)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const go = () => openWindow('processForms', { year });
  return (
    <DashCard title="Tax forms" icon={<FileText size={15} />} onTitle={go}>
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <div className="cx-muted cx-small">{(q.error as Error).message}</div>
      ) : open.length === 0 ? (
        <div className="cx-alldone">
          <CheckCircle2 size={18} color="var(--sx-success)" />
          <span>No forms to file yet.</span>
        </div>
      ) : (
        <>
          <div className="cx-figure-label">Next form due</div>
          <div className="cx-dcard-big">
            {fmtDate(open[0].dueDate)} <span>{formLabel(open[0])}</span>
          </div>
          <ul className="cx-tasklist">
            {open.slice(0, 3).map((f) => (
              <li key={`${f.form}:${f.period}:${f.state}`}>
                <button type="button" className="cx-task" onClick={go}>
                  {f.dueDate < today ? <AlertCircle size={14} color="var(--sx-danger)" /> : <Circle size={14} color="#94a3b8" />}
                  <span className="cx-task-text" title={f.title}>
                    {formLabel(f)}
                  </span>
                  <span className="cx-muted cx-small">{fmtDate(f.dueDate)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </DashCard>
  );
}

function PayrollSummaryCard() {
  const { year } = useYear();
  const q = usePaychecksThisYear();
  const employees = useEmployees({ active: 'active' });
  const t = useMemo(() => {
    const sum = (f: (p: PaycheckSummary) => number) => q.rows.reduce((s, p) => s + f(p), 0);
    return {
      gross: sum((p) => p.gross),
      taxes: sum((p) => p.employeeTaxes),
      deductions: sum((p) => p.deductions),
      net: sum((p) => p.net),
      employer: sum((p) => p.employerTaxes),
      contributions: sum((p) => p.contributions),
      count: q.rows.filter((p) => p.kind === 'regular').length,
    };
  }, [q.rows]);
  const open = () => openWindow('report', { key: 'payroll_summary', params: { dates: 'thisFiscalYearToDate', columns: 'total' } });
  return (
    <Card
      title="Payroll summary"
      subtitle={String(year)}
      flush
      actions={
        <button type="button" className="sx-linkbtn cx-small" onClick={open}>
          Report
        </button>
      }
    >
      {q.isLoading ? (
        <div style={{ padding: 12 }}>
          <Spinner />
        </div>
      ) : (
        <table className="cx-baltable pc-summary">
          <tbody>
            <tr onClick={open}>
              <td>Gross pay</td>
              <td className="cx-num cx-right">{money2(t.gross)}</td>
            </tr>
            <tr onClick={open}>
              <td>Taxes withheld</td>
              <td className="cx-num cx-right">{money2(t.taxes)}</td>
            </tr>
            <tr onClick={open}>
              <td>Deductions</td>
              <td className="cx-num cx-right">{money2(t.deductions)}</td>
            </tr>
            <tr onClick={open} className="pc-strong">
              <td>Net pay</td>
              <td className="cx-num cx-right">{money2(t.net)}</td>
            </tr>
            <tr onClick={open}>
              <td>Employer taxes</td>
              <td className="cx-num cx-right">{money2(t.employer)}</td>
            </tr>
            <tr onClick={open}>
              <td>Company contributions</td>
              <td className="cx-num cx-right">{money2(t.contributions)}</td>
            </tr>
            <tr onClick={() => openWindow('editVoidPaychecks')}>
              <td>Paychecks</td>
              <td className="cx-num cx-right">{t.count}</td>
            </tr>
            <tr onClick={() => openWindow('employeeCenter')}>
              <td>Active employees</td>
              <td className="cx-num cx-right">{employees.data?.length ?? ''}</td>
            </tr>
          </tbody>
        </table>
      )}
    </Card>
  );
}

function BooksCard() {
  const q = useBooksStatus();
  const s = q.data;
  const pending = (s?.pendingCount ?? 0) + (s?.errorCount ?? 0);
  const state = !s ? null : !s.reachable ? 'down' : !s.sessionOk ? 'session' : !s.postToBooks ? 'off' : 'ok';
  return (
    <Card title="SerieX Books" subtitle={state === 'ok' ? 'Connected' : undefined}>
      {q.isLoading ? (
        <Spinner />
      ) : !s ? (
        <div className="cx-muted cx-small">{(q.error as Error | null)?.message ?? 'The link status is not available.'}</div>
      ) : (
        <div className="cx-stack" style={{ gap: 8 }}>
          <div className="cx-row" style={{ alignItems: 'flex-start', gap: 8 }}>
            {state === 'ok' ? (
              <Link2 size={16} color="var(--sx-success)" style={{ marginTop: 1, flex: '0 0 auto' }} />
            ) : (
              <AlertCircle size={16} color="var(--sx-danger)" style={{ marginTop: 1, flex: '0 0 auto' }} />
            )}
            <div className="cx-small" style={{ minWidth: 0 }}>
              <div>{s.message}</div>
              {s.companyName && <div className="cx-muted cx-ellipsis">{s.companyName}</div>}
              <div className="cx-muted cx-ellipsis" title={s.url}>
                {s.url}
              </div>
            </div>
          </div>
          <button type="button" className="cx-task" onClick={() => openWindow('booksSync')}>
            {pending > 0 ? <AlertCircle size={14} color={s.errorCount ? 'var(--sx-danger)' : 'var(--sx-warning)'} /> : <CheckCircle2 size={14} color="var(--sx-success)" />}
            <span className="cx-task-text">
              {pending === 0 ? 'Everything is posted' : `${pending} not posted yet`}
              {s.errorCount > 0 && <span className="cx-muted cx-small"> ({s.errorCount} with problems)</span>}
            </span>
          </button>
          <div className="cx-row" style={{ gap: 6 }}>
            <Button size="sm" icon={BookOpen} label="Open SerieX Books" onClick={openSerieXBooks} />
            <Button size="sm" variant={pending ? 'primary' : 'secondary'} label="Books Sync" onClick={() => openWindow('booksSync')} />
          </div>
        </div>
      )}
    </Card>
  );
}
