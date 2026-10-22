// Company > Insights (also the Home page "Insights" tab): charts and lists about the
// business for a chosen period: income and expenses by month, this year and last year, best
// customers, biggest suppliers, where the money goes, balances, customers who owe money and
// vendors to pay. Clicking a bar or a row opens the matching report.
import { useMemo, useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAccounts, useCompanyInfo, useNames } from '@/api/hooks';
import type { ReportDrill, ReportResult } from '@/api/types';
import { Card, EmptyState, Select, Spinner } from '@/components';
import { openWindow } from '@/windows/windowStore';
import { addDate, presetLabel, resolvePreset, todayIso } from '@/util/dates';
import { fmtDate } from '@/util/format';
import { compactMoney, money0, money2, plTotals, useWidgetReport } from './shared';
import './company.css';

export interface CompanySnapshotProps {}

export default function CompanySnapshot(_props: CompanySnapshotProps) {
  return (
    <div className="cx-home">
      <SnapshotView />
    </div>
  );
}

const PERIODS = ['thisFiscalYearToDate', 'thisFiscalYear', 'lastFiscalYear', 'thisFiscalQuarterToDate', 'lastFiscalQuarter', 'thisMonthToDate', 'lastMonth'];
const C = { income: '#2a78d6', expenses: '#eb6834', prev: '#a3adb8', bar: '#2a78d6' };

/** The Insights widgets (embedded: shown inside the Home page). */
export function SnapshotView({ embedded }: { embedded?: boolean }) {
  const info = useCompanyInfo();
  const fy = info.data?.fiscalYearStartMonth ?? 1;
  const [period, setPeriod] = useState('thisFiscalYearToDate');
  const range = useMemo(() => resolvePreset(period, todayIso(), fy), [period, fy]);
  const prevRange = useMemo(() => ({ from: addDate(range.from, -1, 0, 0), to: addDate(range.to, -1, 0, 0) }), [range]);

  const trend = useWidgetReport('profit_loss', { from: range.from, to: range.to, columns: 'month' });
  const prev = useWidgetReport('profit_loss', { from: prevRange.from, to: prevRange.to, columns: 'month' });
  const total = useWidgetReport('profit_loss', { from: range.from, to: range.to });
  const customers = useWidgetReport('sales_by_customer_summary', { from: range.from, to: range.to });
  const vendors = useWidgetReport('expenses_by_vendor_summary', { from: range.from, to: range.to });

  const months = useMemo(() => monthColumns(trend.data), [trend.data]);
  const trendData = months.map((m) => ({ name: m.label, ...plTotals(trend.data, m.key) }));
  const prevMonths = monthColumns(prev.data);
  const compareData = months.map((m, i) => ({
    name: m.label,
    current: plTotals(trend.data, m.key).income,
    previous: prevMonths[i] ? plTotals(prev.data, prevMonths[i].key).income : 0,
  }));
  const sums = plTotals(total.data, 'total');

  return (
    <div className={'cx-snap' + (embedded ? ' cx-embedded' : '')}>
      <div className="cx-snap-bar">
        {!embedded && (
          <h1 className="cx-page-title" style={{ fontSize: 18 }}>
            Insights
          </h1>
        )}
        <span className="cx-muted">Period</span>
        <Select value={period} onChange={setPeriod} width={220} aria-label="Period" options={PERIODS.map((p) => ({ value: p, label: presetLabel(p) }))} />
        <span className="cx-muted cx-small">
          {fmtDate(range.from)} - {fmtDate(range.to)}
        </span>
        <span className="cx-spacer" />
        {total.data && (
          <div className="cx-snap-kpis">
            <Kpi label="Income" value={sums.income} />
            <Kpi label="Expenses" value={sums.expenses} />
            <Kpi label="Net income" value={sums.net} strong />
          </div>
        )}
      </div>

      <div className="cx-snap-grid">
        <Widget title="Income and expenses by month" sub="Money in and money out" wide loading={trend.isLoading} error={trend.error}>
          {trendData.length === 0 ? (
            <EmptyState compact message="No income or expenses in this period." />
          ) : (
            <>
              <div className="cx-chart" style={{ height: 210 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={trendData} barGap={2} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
                    <CartesianGrid vertical={false} stroke="#eef0f3" />
                    <XAxis dataKey="name" tickLine={false} axisLine={{ stroke: '#d9dde3' }} tick={{ fontSize: 11, fill: '#6b7280' }} interval={0} />
                    <YAxis tickFormatter={compactMoney} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: '#6b7280' }} width={52} />
                    <Tooltip
                      cursor={{ fill: 'rgba(148,163,184,0.12)' }}
                      formatter={(v: number, n: string) => [money2(v), n === 'income' ? 'Income' : 'Expenses']}
                      contentStyle={{ fontSize: 12, borderRadius: 6, border: '1px solid #e3e6ea' }}
                    />
                    <Bar dataKey="income" fill={C.income} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />
                    <Bar dataKey="expenses" fill={C.expenses} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <Legend
                items={[
                  { color: C.income, label: 'Income' },
                  { color: C.expenses, label: 'Expenses' },
                ]}
              />
            </>
          )}
        </Widget>

        <Widget title="This year and last year" sub="Income by month" loading={trend.isLoading || prev.isLoading} error={trend.error || prev.error}>
          {compareData.length === 0 ? (
            <EmptyState compact message="No income in this period." />
          ) : (
            <>
              <div className="cx-chart" style={{ height: 190 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={compareData} margin={{ top: 8, right: 10, bottom: 0, left: 4 }}>
                    <CartesianGrid vertical={false} stroke="#eef0f3" />
                    <XAxis dataKey="name" tickLine={false} axisLine={{ stroke: '#d9dde3' }} tick={{ fontSize: 11, fill: '#6b7280' }} />
                    <YAxis tickFormatter={compactMoney} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: '#6b7280' }} width={52} />
                    <Tooltip
                      formatter={(v: number, n: string) => [money2(v), n === 'current' ? 'This period' : 'Previous year']}
                      contentStyle={{ fontSize: 12, borderRadius: 6, border: '1px solid #e3e6ea' }}
                    />
                    <Line type="linear" dataKey="previous" stroke={C.prev} strokeWidth={2} dot={false} isAnimationActive={false} />
                    <Line
                      type="linear"
                      dataKey="current"
                      stroke={C.income}
                      strokeWidth={2}
                      dot={{ r: 3.5, strokeWidth: 2, stroke: '#fff', fill: C.income }}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <Legend
                items={[
                  { color: C.income, label: 'This period' },
                  { color: C.prev, label: 'Same months last year' },
                ]}
              />
            </>
          )}
        </Widget>

        <Widget title="Where the money goes" sub="Largest expense accounts" loading={total.isLoading} error={total.error}>
          <BarList rows={expenseBreakdown(total.data)} empty="No expenses in this period." />
        </Widget>

        <Widget title="Best customers" sub="By sales" loading={customers.isLoading} error={customers.error}>
          <BarList rows={topNames(customers.data)} empty="No sales in this period." />
        </Widget>

        <Widget title="Biggest suppliers" sub="By spending" loading={vendors.isLoading} error={vendors.error}>
          <BarList rows={topNames(vendors.data)} empty="No expenses with a vendor in this period." color={C.expenses} />
        </Widget>

        <BalancesWidget />
        <OwesWidget kind="customer" />
        <OwesWidget kind="vendor" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces

function Kpi({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className={'cx-kpi' + (strong ? ' cx-strong' : '')}>
      <span>{label}</span>
      <b className={value < 0 ? 'cx-tone-danger' : undefined}>{money0(value)}</b>
    </div>
  );
}

function Widget({
  title,
  sub,
  wide,
  loading,
  error,
  children,
}: {
  title: string;
  sub?: string;
  wide?: boolean;
  loading?: boolean;
  error?: unknown;
  children: ReactNode;
}) {
  return (
    <Card title={title} subtitle={sub} className={'cx-widget' + (wide ? ' cx-wide' : '')}>
      {loading ? <Spinner label="Loading..." /> : error ? <div className="cx-muted cx-small">{(error as Error).message}</div> : children}
    </Card>
  );
}

function Legend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="cx-legend">
      {items.map((i) => (
        <span key={i.label}>
          <i style={{ background: i.color }} /> {i.label}
        </span>
      ))}
    </div>
  );
}

interface BarRow {
  key: string;
  label: string;
  value: number;
  drill?: ReportDrill;
}

/** Horizontal bars with labels and amounts; a row with a drill opens that report. */
function BarList({ rows, empty, color = C.bar }: { rows: BarRow[]; empty: string; color?: string }) {
  if (!rows.length) return <EmptyState compact message={empty} />;
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  return (
    <ul className="cx-barlist">
      {rows.map((r) => (
        <li key={r.key}>
          <button
            type="button"
            className="cx-barrow"
            disabled={!r.drill}
            title={r.drill ? `${r.label}: ${money2(r.value)} (click for details)` : `${r.label}: ${money2(r.value)}`}
            onClick={() => r.drill && openWindow('report', { key: r.drill.report, params: r.drill.params })}
          >
            <span className="cx-barrow-label cx-ellipsis">{r.label}</span>
            <span className="cx-barrow-track">
              <span className="cx-barrow-fill" style={{ width: `${Math.max(2, (Math.abs(r.value) / max) * 100)}%`, background: color }} />
            </span>
            <span className="cx-barrow-value cx-num">{money0(r.value)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Month columns of a P&L with columns=month (without the TOTAL column). */
function monthColumns(r: ReportResult | undefined): { key: string; label: string }[] {
  if (!r) return [];
  return r.columns
    .filter((c) => /^p\d+$/.test(c.key))
    .map((c) => {
      // "Jan 26" stays; partial months ("Oct 1 - Oct 17, 26") become "Oct 26"
      const m = /^([A-Z][a-z]{2})\b.*?(\d{2})$/.exec(c.label);
      return { key: c.key, label: m ? `${m[1]} ${m[2]}` : c.label };
    });
}

/** Top 6 names of a summary report by customer/vendor (jobs folded into their customer). */
function topNames(r: ReportResult | undefined): BarRow[] {
  if (!r) return [];
  const out: BarRow[] = [];
  for (const row of r.rows) {
    if (row.level !== 0 || (row.kind !== 'data' && row.kind !== 'subtotal')) continue;
    const label = String(row.cells.label ?? '').replace(/^Total /, '');
    const v = typeof row.cells.total === 'number' ? row.cells.total : 0;
    if (!label || label === 'TOTAL' || v <= 0) continue;
    out.push({ key: label, label, value: v, drill: row.cellDrills?.total ?? row.drill });
  }
  out.sort((a, b) => b.value - a.value);
  return out.slice(0, 6);
}

/** Largest expense accounts (top-level accounts of Cost of Goods Sold, Expense and Other Expense). */
function expenseBreakdown(r: ReportResult | undefined): BarRow[] {
  if (!r) return [];
  const sections = new Set(['Cost of Goods Sold', 'Expense', 'Other Expense']);
  let inExpense = false;
  const out: BarRow[] = [];
  for (const row of r.rows) {
    const label = String(row.cells.label ?? '');
    if (row.kind === 'section' && row.level === 1) inExpense = sections.has(label);
    if (row.kind === 'subtotal' && row.level === 1) inExpense = false;
    if (!inExpense || row.level !== 2) continue;
    if (row.kind !== 'data' && row.kind !== 'subtotal') continue;
    const v = typeof row.cells.total === 'number' ? row.cells.total : 0;
    if (v <= 0) continue;
    out.push({ key: label, label: label.replace(/^Total /, ''), value: v, drill: row.cellDrills?.total ?? row.drill });
  }
  out.sort((a, b) => b.value - a.value);
  if (out.length > 6) {
    const rest = out.slice(5).reduce((s, x) => s + x.value, 0);
    return [...out.slice(0, 5), { key: '__other', label: 'All other expenses', value: rest }];
  }
  return out;
}

function BalancesWidget() {
  const q = useAccounts({ types: ['Bank', 'Credit Card', 'Accounts Receivable', 'Accounts Payable', 'Other Current Asset', 'Other Current Liability'] });
  const rows = (q.data ?? []).filter((a) => a.active && a.level === 0 && (a.balance !== 0 || a.type === 'Bank'));
  return (
    <Widget title="Balances" loading={q.isLoading} error={q.error}>
      <table className="cx-baltable cx-inwidget">
        <tbody>
          {rows.map((a) => (
            <tr key={a.id} onClick={() => openWindow('register', { accountId: a.id, accountName: a.name })} title={`Open the ${a.name} register`}>
              <td className="cx-ellipsis">{a.name}</td>
              <td className="cx-muted cx-small">{a.type}</td>
              <td className={'cx-num cx-right' + (a.balance < 0 ? ' cx-tone-danger' : '')}>{money2(a.balance)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Widget>
  );
}

function OwesWidget({ kind }: { kind: 'customer' | 'vendor' }) {
  const q = useNames(kind);
  const rows = (q.data ?? [])
    .filter((n) => n.level === 0 && n.balance > 0.004)
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 6)
    .map((n) => ({
      key: String(n.id),
      label: n.name,
      value: n.balance,
      drill: {
        report: kind === 'customer' ? 'customer_balance_detail' : 'vendor_balance_detail',
        params: { nameIds: String(n.id), includeJobs: '1', dates: 'all' },
      },
    }));
  return (
    <Widget title={kind === 'customer' ? 'Customers who owe money' : 'Vendors to pay'} loading={q.isLoading} error={q.error}>
      <BarList
        rows={rows}
        empty={kind === 'customer' ? 'Nobody owes you money right now.' : 'You do not owe any vendor right now.'}
        color={kind === 'customer' ? C.income : C.expenses}
      />
    </Widget>
  );
}
