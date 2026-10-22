// Home page: dashboard cards (Money in, Money out, Bank accounts, Profit &
// Loss, Tasks) above the everyday task cards (Sell, Buy, Bank, Books), with Account Balances and Backup status on the
// right and a "Get started" checklist for a new company. Tabs: Home | Insights.
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertCircle, ArrowDownLeft, ArrowUpRight, BellRing, CheckCircle2, Circle, HardDriveDownload, Landmark, LineChart, RefreshCw, X } from 'lucide-react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { invalidateAll, useAccounts, useCompanyInfo, useItems, useNames, usePrefs, usePrefValues, useTxnList } from '@/api/hooks';
import type { Account, ReminderGroup } from '@/api/types';
import { Button, Card, SegmentedControl, Spinner, msgBox, toast } from '@/components';
import { openWindow } from '@/windows/windowStore';
import type { WindowKind } from '@/windows/kinds';
import { addDays, startOfMonth, todayIso, addMonthsClamped, longDate } from '@/util/dates';
import { fmtDate } from '@/util/format';
import { Workflow } from './Workflow';
import { backUpNow, backupKindLabel, money0, money2, plTotals, timeAgo, useBackupStatus, useFeedAccounts, useReconciliations, useReminders, useWidgetReport } from './shared';
import './company.css';

const SnapshotView = lazy(() => import('./CompanySnapshot').then((m) => ({ default: m.SnapshotView })));

export interface HomePageProps {
  /** Start on the Insights tab. */
  tab?: 'home' | 'insights';
}

type Tab = 'home' | 'insights';

export default function HomePage({ tab: initialTab }: HomePageProps) {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'home');
  const company = useCompanyInfo().data;
  const [spin, setSpin] = useState(false);
  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

  return (
    <div className="cx-home">
      <div className="cx-home-top">
        <SegmentedControl<Tab>
          value={tab}
          onChange={setTab}
          aria-label="Home page view"
          options={[
            { value: 'home', label: 'Home' },
            { value: 'insights', label: 'Insights' },
          ]}
        />
        <div className="cx-home-hello">
          <b>{company?.name}</b>
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
      {tab === 'home' ? (
        <HomeDashboard />
      ) : (
        <Suspense fallback={<Spinner center label="Loading insights..." />}>
          <SnapshotView embedded />
        </Suspense>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard

function HomeDashboard() {
  const prefs = usePrefValues();
  const companyId = useCompanyInfo().data?.companyId ?? null;
  const accounts = useAccounts({ types: ['Bank', 'Credit Card', 'Accounts Receivable', 'Accounts Payable'] });

  const openCheckRegister = () => {
    const banks = (accounts.data ?? []).filter((a) => a.type === 'Bank' && a.active);
    const id = prefs.defaultCheckAccountId ?? banks[0]?.id;
    if (id) openWindow('register', { accountId: id, accountName: banks.find((b) => b.id === id)?.name });
    else openWindow('useRegister');
  };

  return (
    <div className="cx-home-body">
      <GetStarted companyId={companyId} />
      <div className="cx-dash">
        <MoneyInCard />
        <MoneyOutCard />
        <BankCard accounts={accounts.data} />
        <ProfitCard />
        <TasksCard />
      </div>
      <div className="cx-home-lower">
        <Card title="Everyday tasks" subtitle="In the order they usually happen. Click a task to start." className="cx-wf-card">
          <Workflow prefs={prefs} onCheckRegister={openCheckRegister} />
        </Card>
        <div className="cx-home-side">
          <BalancesCard accounts={accounts.data} loading={accounts.isLoading} />
          <BackupCard />
        </div>
      </div>
    </div>
  );
}

/** "08/31/26". */
function shortDate(iso: string): string {
  return `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(2, 4)}`;
}

/** A dashboard card with a title row and a body. */
function DashCard({
  title,
  icon,
  onTitle,
  children,
  footer,
}: {
  title: string;
  icon: ReactNode;
  onTitle?: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
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

/** Two-part bar (e.g. overdue / not due yet) with clickable parts. */
function SplitBar({ parts }: { parts: { key: string; value: number; color: string; label: string; onClick?: () => void }[] }) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  return (
    <div className="cx-splitbar" role="group">
      {total <= 0 ? (
        <span className="cx-splitbar-empty" />
      ) : (
        parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <button
              key={p.key}
              type="button"
              className="cx-splitbar-part"
              style={{ flexGrow: Math.max(p.value / total, 0.04), background: p.color }}
              title={`${p.label}: ${money2(p.value)}`}
              aria-label={`${p.label}: ${money2(p.value)}`}
              onClick={p.onClick}
            />
          ))
      )}
    </div>
  );
}

/** "$1,234  OVERDUE" figure (clickable). */
function Figure({
  value,
  label,
  tone,
  align,
  onClick,
}: {
  value: number;
  label: string;
  tone?: 'danger' | 'success' | 'muted';
  align?: 'right';
  onClick?: () => void;
}) {
  return (
    <button type="button" className={'cx-figure' + (align === 'right' ? ' cx-right' : '')} onClick={onClick}>
      <span className="cx-figure-value">{money0(value)}</span>
      <span className={'cx-figure-label' + (tone ? ` cx-tone-${tone}` : '')}>{label}</span>
    </button>
  );
}

function useLast30() {
  const today = todayIso();
  return { from: addDays(today, -30), to: today, today };
}

function MoneyInCard() {
  const { from, to, today } = useLast30();
  const open = useTxnList({ types: ['INV', 'STMTCHG'], openOnly: true, limit: 10000 });
  const paid = useTxnList({ types: ['PMT', 'SALESRCPT'], from, to, limit: 10000 });
  const s = useMemo(() => {
    let overdue = 0;
    let notDue = 0;
    let nOverdue = 0;
    for (const r of open.data?.rows ?? []) {
      if (r.voided || r.isPending) continue;
      const due = r.dueDate || r.date;
      if (due < today) {
        overdue += r.openBalance;
        nOverdue++;
      } else notDue += r.openBalance;
    }
    const paidSum = (paid.data?.rows ?? []).reduce((t, r) => t + (r.voided || r.isPending ? 0 : r.amount), 0);
    return { overdue, notDue, nOverdue, unpaid: overdue + notDue, paid: paidSum };
  }, [open.data, paid.data, today]);
  const loading = open.isLoading || paid.isLoading;
  return (
    <DashCard title="Money in" icon={<ArrowDownLeft size={15} />} onTitle={() => openWindow('incomeTracker')}>
      {loading ? (
        <Spinner />
      ) : (
        <>
          <div className="cx-dcard-big">
            {money0(s.unpaid)} <span>unpaid</span>
          </div>
          <div className="cx-figrow">
            <Figure value={s.overdue} label={`${s.nOverdue} overdue`} tone="danger" onClick={() => openWindow('report', { key: 'collections' })} />
            <Figure value={s.notDue} label="Not due yet" tone="muted" align="right" onClick={() => openWindow('report', { key: 'open_invoices' })} />
          </div>
          <SplitBar
            parts={[
              { key: 'o', value: s.overdue, color: 'var(--sx-danger)', label: 'Overdue', onClick: () => openWindow('report', { key: 'collections' }) },
              { key: 'n', value: s.notDue, color: '#94a3b8', label: 'Not due yet', onClick: () => openWindow('report', { key: 'open_invoices' }) },
            ]}
          />
          <div className="cx-figrow" style={{ marginTop: 8 }}>
            <Figure value={s.paid} label="Received last 30 days" tone="success" onClick={() => openWindow('incomeTracker')} />
          </div>
          <SplitBar
            parts={[{ key: 'p', value: s.paid, color: 'var(--sx-success)', label: 'Received last 30 days', onClick: () => openWindow('incomeTracker') }]}
          />
        </>
      )}
    </DashCard>
  );
}

function MoneyOutCard() {
  const { from, to, today } = useLast30();
  const open = useTxnList({ types: ['BILL'], openOnly: true, limit: 10000 });
  const paid = useTxnList({ types: ['BILLPMT'], from, to, limit: 10000 });
  const s = useMemo(() => {
    let overdue = 0;
    let notDue = 0;
    let nOverdue = 0;
    for (const r of open.data?.rows ?? []) {
      if (r.voided) continue;
      const due = r.dueDate || r.date;
      if (due < today) {
        overdue += r.openBalance;
        nOverdue++;
      } else notDue += r.openBalance;
    }
    const paidSum = (paid.data?.rows ?? []).reduce((t, r) => t + (r.voided ? 0 : r.amount), 0);
    return { overdue, notDue, nOverdue, unpaid: overdue + notDue, paid: paidSum };
  }, [open.data, paid.data, today]);
  const loading = open.isLoading || paid.isLoading;
  return (
    <DashCard title="Money out" icon={<ArrowUpRight size={15} />} onTitle={() => openWindow('billTracker')}>
      {loading ? (
        <Spinner />
      ) : (
        <>
          <div className="cx-dcard-big">
            {money0(s.unpaid)} <span>to pay</span>
          </div>
          <div className="cx-figrow">
            <Figure value={s.overdue} label={`${s.nOverdue} overdue`} tone="danger" onClick={() => openWindow('report', { key: 'unpaid_bills_detail' })} />
            <Figure value={s.notDue} label="Not due yet" tone="muted" align="right" onClick={() => openWindow('payBills')} />
          </div>
          <SplitBar
            parts={[
              {
                key: 'o',
                value: s.overdue,
                color: 'var(--sx-danger)',
                label: 'Overdue bills',
                onClick: () => openWindow('report', { key: 'unpaid_bills_detail' }),
              },
              { key: 'n', value: s.notDue, color: '#94a3b8', label: 'Bills not due yet', onClick: () => openWindow('payBills') },
            ]}
          />
          <div className="cx-figrow" style={{ marginTop: 8 }}>
            <Figure value={s.paid} label="Paid last 30 days" tone="success" onClick={() => openWindow('billTracker')} />
          </div>
          <SplitBar
            parts={[{ key: 'p', value: s.paid, color: 'var(--sx-success)', label: 'Bills paid last 30 days', onClick: () => openWindow('billTracker') }]}
          />
        </>
      )}
    </DashCard>
  );
}

function BankCard({ accounts }: { accounts: Account[] | undefined }) {
  const feeds = useFeedAccounts();
  const recs = useReconciliations();
  const banks = (accounts ?? []).filter((a) => (a.type === 'Bank' || a.type === 'Credit Card') && a.active && a.level === 0);
  const lastRec = (id: number) =>
    (recs.data ?? []).filter((r) => r.accountId === id).sort((a, b) => b.statementDate.localeCompare(a.statementDate))[0]?.statementDate;
  const shown = banks.slice(0, 4);
  return (
    <DashCard
      title="Bank accounts"
      icon={<Landmark size={15} />}
      onTitle={() => openWindow('bankFeeds')}
      footer={
        banks.length > shown.length ? (
          <button type="button" className="sx-linkbtn cx-small" onClick={() => openWindow('chartOfAccounts')}>
            {banks.length - shown.length} more in the Chart of Accounts
          </button>
        ) : undefined
      }
    >
      {!accounts ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <div className="cx-muted cx-small">
          No bank accounts yet.{' '}
          <button type="button" className="sx-linkbtn" onClick={() => openWindow('accountEdit', { type: 'Bank' })}>
            Add one
          </button>
        </div>
      ) : (
        <ul className="cx-banklist">
          {shown.map((a) => {
            const feed = feeds.data?.find((f) => f.accountId === a.id);
            const rec = lastRec(a.id);
            return (
              <li key={a.id}>
                <div className="cx-row" style={{ gap: 6 }}>
                  <button
                    type="button"
                    className="sx-linkbtn cx-ellipsis cx-bank-name"
                    title={`Open the ${a.name} register`}
                    onClick={() => openWindow('register', { accountId: a.id, accountName: a.name })}
                  >
                    {a.name}
                  </button>
                  <span className="cx-spacer" />
                  <span className="cx-num cx-bank-bal">{money2(a.balance)}</span>
                </div>
                <div className="cx-row cx-small cx-muted" style={{ gap: 6 }}>
                  {feed && feed.newCount > 0 ? (
                    <button type="button" className="sx-linkbtn cx-small" onClick={() => openWindow('bankFeeds', { accountId: a.id })}>
                      {feed.newCount} to review
                    </button>
                  ) : (
                    <span>{a.type === 'Credit Card' ? 'Credit card' : 'Bank'}</span>
                  )}
                  <span className="cx-spacer" />
                  {rec ? (
                    <span className="cx-rec" title={`Reconciled through ${fmtDate(rec)}`}>
                      <CheckCircle2 size={11} /> {shortDate(rec)}
                    </span>
                  ) : (
                    <span title="This account has not been reconciled yet">Not reconciled</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </DashCard>
  );
}

const SERIES = { income: '#2a78d6', expenses: '#eb6834' };

function ProfitCard() {
  const today = todayIso();
  const thisStart = startOfMonth(today);
  const lastStart = startOfMonth(addMonthsClamped(thisStart, -1));
  const params = useMemo(() => ({ from: lastStart, to: today, columns: 'month' }), [lastStart, today]);
  const q = useWidgetReport('profit_loss', params);
  const last = plTotals(q.data, 'p0');
  const cur = plTotals(q.data, 'p1');
  const diff = cur.net - last.net;
  const data = [
    { name: 'Last month', income: last.income, expenses: last.expenses },
    { name: 'This month', income: cur.income, expenses: cur.expenses },
  ];
  const openPL = () => openWindow('report', { key: 'profit_loss', params: { dates: 'thisMonthToDate' } });
  return (
    <DashCard title="Profit and Loss" icon={<LineChart size={15} />} onTitle={openPL}>
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <div className="cx-muted cx-small">{(q.error as Error).message}</div>
      ) : (
        <>
          <button type="button" className="cx-figure" onClick={openPL} style={{ width: '100%' }}>
            <span className="cx-figure-label">Net income this month</span>
            <span className={'cx-dcard-big' + (cur.net < 0 ? ' cx-tone-danger' : '')} style={{ margin: 0 }}>
              {money0(cur.net)}
            </span>
          </button>
          <div className="cx-small cx-muted">
            {diff === 0 ? 'Same as' : diff > 0 ? `${money0(diff)} more than` : `${money0(-diff)} less than`} last month ({money0(last.net)})
          </div>
          {last.income === 0 && last.expenses === 0 && cur.income === 0 && cur.expenses === 0 ? (
            <div className="cx-muted cx-small" style={{ marginTop: 10 }}>
              No income or expenses yet. They appear here as you enter sales and expenses.
            </div>
          ) : (
            <>
              <div className="cx-plchart" aria-label="Income and expenses, last month and this month">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data} barGap={2} barCategoryGap="28%" margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                    <XAxis dataKey="name" tickLine={false} axisLine={{ stroke: '#e3e6ea' }} tick={{ fontSize: 11, fill: '#6b7280' }} height={18} />
                    <Tooltip
                      cursor={{ fill: 'rgba(148,163,184,0.12)' }}
                      formatter={(v: number, n: string) => [money2(v), n === 'income' ? 'Income' : 'Expenses']}
                      contentStyle={{ fontSize: 12, borderRadius: 6, border: '1px solid #e3e6ea', padding: '4px 8px' }}
                      labelStyle={{ fontWeight: 600 }}
                    />
                    <Bar dataKey="income" fill={SERIES.income} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} onClick={openPL} />
                    <Bar dataKey="expenses" fill={SERIES.expenses} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} onClick={openPL} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="cx-legend">
                <span>
                  <i style={{ background: SERIES.income }} /> Income
                </span>
                <span>
                  <i style={{ background: SERIES.expenses }} /> Expenses
                </span>
              </div>
            </>
          )}
        </>
      )}
    </DashCard>
  );
}

/** What a reminder group opens. */
const TASK_ACTIONS: Record<ReminderGroup['key'], { noun: string; open: () => void }> = {
  overdue_invoices: { noun: 'overdue invoice', open: () => openWindow('report', { key: 'collections' }) },
  bills_to_pay: { noun: 'bill to pay', open: () => openWindow('payBills') },
  checks_to_print: { noun: 'check to print', open: () => openWindow('printChecks') },
  invoices_to_print: { noun: 'invoice to print', open: () => openWindow('printChecks', { kind: 'invoices' }) },
  money_to_deposit: { noun: 'payment to deposit', open: () => openWindow('makeDeposit') },
  inventory_to_reorder: { noun: 'item to reorder', open: () => openWindow('report', { key: 'inventory_stock_status_by_item' }) },
  memorized_due: { noun: 'memorized transaction due', open: () => openWindow('memorizedTxns') },
  purchase_orders: { noun: 'open purchase order', open: () => openWindow('report', { key: 'open_purchase_orders' }) },
  todos: { noun: 'to do', open: () => openWindow('todos') },
  sales_tax_due: { noun: 'sales tax payment due', open: () => openWindow('paySalesTax') },
};

function plural(n: number, noun: string) {
  if (n === 1) return `1 ${noun}`;
  // "memorized transaction due" -> "memorized transactions due"; "to do" -> "to dos"
  const words = noun.split(' ');
  const i = noun.endsWith(' due')
    ? words.length - 2
    : noun.endsWith(' to pay') || noun.endsWith(' to print') || noun.endsWith(' to deposit') || noun.endsWith(' to reorder')
      ? 0
      : words.length - 1;
  words[i] = words[i] + (words[i].endsWith('s') ? 'es' : 's');
  return `${n} ${words.join(' ')}`;
}

/** Reminder groups by urgency: what costs money or is late comes first. */
const TASK_ORDER: ReminderGroup['key'][] = [
  'overdue_invoices',
  'sales_tax_due',
  'bills_to_pay',
  'money_to_deposit',
  'memorized_due',
  'checks_to_print',
  'invoices_to_print',
  'inventory_to_reorder',
  'purchase_orders',
  'todos',
];
const MAX_TASK_GROUPS = 5;

function isUrgent(g: ReminderGroup, today: string): boolean {
  return g.key === 'overdue_invoices' || g.key === 'sales_tax_due' || (g.key === 'bills_to_pay' && g.items.some((i) => i.date < today));
}

function TasksCard() {
  const q = useReminders();
  const today = todayIso();
  const rank = (g: ReminderGroup) => (isUrgent(g, today) ? 0 : 100) + (TASK_ORDER.indexOf(g.key) + 1 || 99);
  const groups = (q.data ?? []).filter((g) => g.items.length > 0).sort((a, b) => rank(a) - rank(b));
  const total = groups.reduce((s, g) => s + g.items.length, 0);
  const shown = groups.slice(0, MAX_TASK_GROUPS);
  const hidden = groups.slice(MAX_TASK_GROUPS);
  const more = hidden.reduce((s, g) => s + g.items.length, 0);
  const moreText =
    hidden.length === 1 && TASK_ACTIONS[hidden[0].key]
      ? `Also ${plural(more, TASK_ACTIONS[hidden[0].key].noun)}`
      : `Also ${more} more in ${hidden.length} other groups`;
  return (
    <DashCard
      title="Tasks"
      icon={<BellRing size={15} />}
      onTitle={() => openWindow('reminders')}
      footer={
        <button type="button" className="sx-linkbtn cx-small" onClick={() => openWindow('reminders')}>
          See all reminders
        </button>
      }
    >
      {q.isLoading ? (
        <Spinner />
      ) : groups.length === 0 ? (
        <div className="cx-alldone">
          <CheckCircle2 size={18} color="var(--sx-success)" />
          <span>You are all caught up.</span>
        </div>
      ) : (
        <>
          <div className="cx-small cx-muted" style={{ marginBottom: 4 }}>
            {total} thing{total === 1 ? '' : 's'} need{total === 1 ? 's' : ''} your attention
          </div>
          <ul className="cx-tasklist">
            {shown.map((g) => {
              const a = TASK_ACTIONS[g.key];
              const urgent = isUrgent(g, today);
              return (
                <li key={g.key}>
                  <button type="button" className="cx-task" onClick={a ? a.open : () => openWindow('reminders')}>
                    {urgent ? <AlertCircle size={14} color="var(--sx-danger)" /> : <Circle size={14} color="#94a3b8" />}
                    <span className="cx-task-text">{a ? plural(g.items.length, a.noun) : g.label}</span>
                    {g.total > 0 && <span className="cx-num cx-muted">{money0(g.total)}</span>}
                  </button>
                </li>
              );
            })}
            {more > 0 && (
              <li>
                <button type="button" className="cx-task" onClick={() => openWindow('reminders')}>
                  <Circle size={14} color="transparent" />
                  <span className="cx-task-text cx-muted">{moreText}</span>
                </button>
              </li>
            )}
          </ul>
        </>
      )}
    </DashCard>
  );
}

function BalancesCard({ accounts, loading }: { accounts: Account[] | undefined; loading: boolean }) {
  const order: Account['type'][] = ['Bank', 'Accounts Receivable', 'Credit Card', 'Accounts Payable'];
  const rows = (accounts ?? []).filter((a) => a.active && a.level === 0).sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  return (
    <Card title="Account balances" flush>
      {loading ? (
        <div style={{ padding: 12 }}>
          <Spinner />
        </div>
      ) : (
        <table className="cx-baltable">
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} onClick={() => openWindow('register', { accountId: a.id, accountName: a.name })} title={`Open the ${a.name} register`}>
                <td className="cx-ellipsis">{a.name}</td>
                <td className={'cx-num cx-right' + (a.balance < 0 ? ' cx-tone-danger' : '')}>{money2(a.balance)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="cx-muted">No accounts yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function BackupCard() {
  const st = useBackupStatus();
  const [busy, setBusy] = useState(false);
  const s = st.data;
  const last = s?.last ?? null;
  const stale = !!s && (!last || Date.now() - new Date(last.time).getTime() > 7 * 86400_000 || !!s.error || !s.enabled);
  const now = async () => {
    setBusy(true);
    try {
      const e = await backUpNow();
      toast(`Backup saved in the backup folder (${e.file}).`);
    } catch (e) {
      await msgBox({ title: 'Back Up Now', icon: 'error', message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Backup status">
      <div className="cx-row" style={{ alignItems: 'flex-start', gap: 8 }}>
        <HardDriveDownload size={16} color={!s || stale ? 'var(--sx-warning)' : 'var(--sx-success)'} style={{ marginTop: 1, flex: '0 0 auto' }} />
        <div className="cx-small">
          {!s ? (
            st.error ? (st.error as Error).message : 'Loading...'
          ) : last ? (
            <>
              Last backup {timeAgo(last.time)}
              {last.kind !== 'auto' && ` (${backupKindLabel(last.kind).toLowerCase()})`}.
            </>
          ) : (
            <>No backup made yet.</>
          )}
          {s && <div className="cx-muted">{s.enabled ? 'Automatic backups are on.' : 'Automatic backups are off.'}</div>}
          {s?.error && <div style={{ color: 'var(--sx-warning)' }}>The last automatic backup failed: {s.error}</div>}
        </div>
      </div>
      <div className="cx-row" style={{ marginTop: 8, gap: 6, flexWrap: 'wrap' }}>
        <Button size="sm" variant={stale ? 'primary' : 'secondary'} label="Back up now" busy={busy} onClick={() => void now()} />
        <Button size="sm" variant="ghost" label="Backup settings" onClick={() => openWindow('backupSettings')} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Get started checklist (new companies)

function GetStarted({ companyId }: { companyId: string | null }) {
  const key = `sx.getStarted.dismissed.${companyId}`;
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    if (!companyId) return;
    try {
      setDismissed(localStorage.getItem(key) === '1');
    } catch {
      setDismissed(false);
    }
  }, [key, companyId]);
  const prefs = usePrefs();
  const customers = useNames('customer');
  const items = useItems({ types: ['Service', 'Inventory Part', 'Non-inventory Part', 'Other Charge'] });
  const banks = useAccounts({ types: ['Bank'] });
  const invoices = useTxnList({ types: ['INV', 'SALESRCPT'], limit: 1 });
  const expenses = useTxnList({ types: ['BILL', 'CHK', 'CCCHARGE'], limit: 1 });
  const loaded = prefs.data && customers.data && items.data && banks.data && invoices.data && expenses.data;
  if (dismissed || !loaded) return null;
  const steps: { done: boolean; label: string; hint: string; action: string; kind: WindowKind; props?: Record<string, unknown> }[] = [
    {
      done: (banks.data ?? []).some((a) => a.hasTxns),
      label: 'Add your bank accounts',
      hint: 'With their opening balances, so your books start right.',
      action: 'Add account',
      kind: 'accountEdit',
      props: { type: 'Bank' },
    },
    {
      done: (customers.data ?? []).length > 0,
      label: 'Add your first customer',
      hint: 'The people and businesses you sell to.',
      action: 'Add customer',
      kind: 'customerEdit',
    },
    {
      done: (items.data ?? []).length > 0,
      label: 'Add a product or service',
      hint: 'What you sell, with its price and income account.',
      action: 'Add item',
      kind: 'itemEdit',
    },
    // with sales tax on, invoices charge no tax until the most common sales tax is set up
    ...(prefs.data?.salesTaxEnabled
      ? [
          {
            done: !!prefs.data.defaultSalesTaxItemId,
            label: 'Set up sales tax',
            hint: 'Add the sales tax you charge most often, with its rate and tax agency.',
            action: 'Set up sales tax',
            kind: 'preferences' as WindowKind,
            props: { section: 'salesTax' },
          },
        ]
      : []),
    {
      done: (invoices.data?.total ?? 0) > 0,
      label: 'Create your first invoice',
      hint: 'Or a sales receipt when you are paid on the spot.',
      action: 'Create invoice',
      kind: 'invoice',
    },
    {
      done: (expenses.data?.total ?? 0) > 0,
      label: 'Record an expense',
      hint: 'Enter a bill, write a check or a credit card charge.',
      action: 'Enter bill',
      kind: 'bill',
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(key, '1');
    } catch {
      /* ignore */
    }
  };
  return (
    <section className="cx-getstarted">
      <div className="cx-row" style={{ marginBottom: 10 }}>
        <div>
          <div className="cx-h2" style={{ margin: 0 }}>
            Get started
          </div>
          <div className="cx-muted cx-small">
            {doneCount} of {steps.length} done. A few steps to set up your books.
          </div>
        </div>
        <div className="cx-gs-progress" aria-hidden="true">
          <span style={{ width: `${(doneCount / steps.length) * 100}%` }} />
        </div>
        <span className="cx-spacer" />
        <button type="button" className="sx-iconbtn" title="Hide this checklist" aria-label="Hide this checklist" onClick={dismiss}>
          <X size={15} />
        </button>
      </div>
      <ol className="cx-gs-list">
        {steps.map((s) => (
          <li key={s.label} className={s.done ? 'cx-done' : ''}>
            {s.done ? <CheckCircle2 size={18} color="var(--sx-success)" /> : <Circle size={18} color="#94a3b8" />}
            <div className="cx-gs-text">
              <b>{s.label}</b>
              <span className="cx-muted cx-small">{s.hint}</span>
            </div>
            {!s.done && <Button size="sm" label={s.action} onClick={() => openWindow(s.kind, s.props ?? {})} />}
          </li>
        ))}
      </ol>
    </section>
  );
}
