// SerieX Books Sync: the link between payroll and the SerieX Books company file.
//   header     SerieX Books address, running or not, company file, signed in, posting on/off
//   Not posted paychecks, tax payments and adjustments waiting to be posted or that failed,
//              with Retry Selected / Retry All. SerieX Books questions are answered here:
//              sign in again (books_auth), "post anyway?" (confirm, retried with force) and the
//              closing date password (closing_date).
//   Verify     compares every posted record with its SerieX Books transaction and ties the payroll
//              liability balances to the SerieX Books liability accounts.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, BookOpen, CheckCircle2, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { api } from '@/api/client';
import type { AccountTieOut, SyncItem, SyncProblem, VerifyProblem, VerifyResult } from '@/api/types';
import { queryClient, useBooksStatus, useBooksSync } from '@/api/hooks';
import { Badge, Button, DateField, ListView, Select, Spinner, Tabs, toast, type ListColumn } from '@/components';
import { useWindow } from '@/windows/WindowContext';
import { openRecord, type RecordKind } from '@/windows/windowStore';
import { openSerieXBooks } from '@/shell/booksLink';
import { fmtDate, fmtMoney } from '@/util/format';
import { todayIso } from '@/util/dates';
import { errText, fmtDateTime, retryPosting, retrySummary, type RetryOutcome } from './shared';
import './company.css';

export interface BooksSyncWindowProps {
  /** Tab to show first. */
  tab?: 'pending' | 'verify';
}

const keyOf = (r: { entity: string; id: number }) => `${r.entity}:${r.id}`;

const ENTITY_LABEL: Record<string, string> = { paycheck: 'Paycheck', liability_payment: 'Tax Payment', adjustment: 'Tax Balance Adjustment', employee: 'Employee' };

function StatusBadge({ s }: { s: SyncItem['status'] }) {
  if (s === 'error') return <Badge tone="danger" dot>Problem</Badge>;
  if (s === 'pending') return <Badge tone="warning" dot>Waiting</Badge>;
  if (s === 'posted') return <Badge tone="success" dot>Posted</Badge>;
  return <Badge tone="neutral">Not posted</Badge>;
}

export default function BooksSyncWindow(props: BooksSyncWindowProps) {
  const w = useWindow();
  const [tab, setTab] = useState<'pending' | 'verify'>(props.tab ?? 'pending');
  useEffect(() => {
    if (props.tab) setTab(props.tab);
  }, [props.tab]);
  useEffect(() => {
    w.setTitle('SerieX Books Sync');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const st = useBooksStatus();
  const s = st.data;
  const notPosted = (s?.pendingCount ?? 0) + (s?.errorCount ?? 0);

  return (
    <div className="pc-sync">
      <div className="pc-sync-head">
        {st.isLoading ? (
          <Spinner label="Checking SerieX Books..." />
        ) : s ? (
          <>
            <span className="pc-sync-icon">
              {s.reachable && s.sessionOk ? <CheckCircle2 size={22} color="var(--sx-success)" /> : <XCircle size={22} color="var(--sx-danger)" />}
            </span>
            <div className="pc-sync-info">
              <div className="pc-sync-title">{s.message}</div>
              <div className="cx-muted cx-small pc-sync-kv">
                <span>
                  Address <b>{s.url}</b>
                </span>
                <span>
                  SerieX Books <b>{s.reachable ? 'running' : 'not reachable'}</b>
                </span>
                <span>
                  Company <b>{s.companyName || '—'}</b>
                </span>
                <span>
                  Signed in <b>{s.sessionOk ? 'yes' : 'no'}</b>
                </span>
                <span>
                  Posting <b>{s.postToBooks ? 'on' : 'off'}</b>
                </span>
              </div>
            </div>
          </>
        ) : (
          <div className="cx-muted">{errText(st.error)}</div>
        )}
        <span className="cx-spacer" />
        <Button
          icon={RefreshCw}
          label="Refresh"
          onClick={() => void queryClient.invalidateQueries({ queryKey: ['books'] })}
          busy={st.isFetching && !st.isLoading}
          title="Check SerieX Books again and reload the list"
        />
        <Button icon={BookOpen} label="Open SerieX Books" onClick={openSerieXBooks} />
      </div>
      <Tabs
        variant="strip"
        fill
        active={tab}
        onChange={(k) => setTab(k as 'pending' | 'verify')}
        tabs={[
          { key: 'pending', label: `Not posted${notPosted ? ` (${notPosted})` : ''}` },
          { key: 'verify', label: 'Verify' },
        ]}
        aria-label="SerieX Books Sync"
      >
        {tab === 'pending' ? <PendingTab notPosted={s ? notPosted : null} /> : <VerifyTab />}
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Not posted

function PendingTab({ notPosted }: { notPosted: number | null }) {
  const [show, setShow] = useState<'open' | 'all'>('open');
  const q = useBooksSync({ status: show });
  const rows = q.data ?? [];

  // the link status is checked every minute: when its count of records not posted changes
  // (a paycheck saved while SerieX Books was down, a retry from another window) reload the list
  const lastCount = useRef<number | null>(notPosted);
  useEffect(() => {
    if (notPosted === null || notPosted === lastCount.current) return;
    lastCount.current = notPosted;
    void q.refetch();
  }, [notPosted]); // eslint-disable-line react-hooks/exhaustive-deps
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState<'selected' | 'all' | null>(null);
  const [last, setLast] = useState<RetryOutcome | null>(null);

  // forget checks of rows that are gone (posted)
  useEffect(() => {
    setChecked((cur) => {
      const keep = new Set([...cur].filter((k) => rows.some((r) => keyOf(r) === k)));
      return keep.size === cur.size ? cur : keep;
    });
  }, [rows]);

  const openable = rows.filter((r) => r.status !== 'posted');
  const allChecked = openable.length > 0 && openable.every((r) => checked.has(keyOf(r)));
  const toggle = (k: string, on: boolean) =>
    setChecked((cur) => {
      const n = new Set(cur);
      if (on) n.add(k);
      else n.delete(k);
      return n;
    });

  const run = async (which: 'selected' | 'all') => {
    const items = which === 'all' ? null : rows.filter((r) => checked.has(keyOf(r))).map((r) => ({ entity: r.entity, id: r.id }));
    if (items && !items.length) {
      toast('Check the records to post first.', { kind: 'info' });
      return;
    }
    setBusy(which);
    try {
      const o = await retryPosting(items);
      setLast(o);
      toast(retrySummary(o), { kind: o.problems.length ? 'warning' : 'success', duration: 7000 });
      setChecked(new Set());
      await q.refetch();
    } catch (e) {
      toast(errText(e), { kind: 'error', duration: 8000 });
    } finally {
      setBusy(null);
    }
  };

  const columns: ListColumn<SyncItem>[] = [
    {
      key: 'check',
      label: (
        <input
          type="checkbox"
          aria-label="Check all"
          checked={allChecked}
          onChange={(e) => setChecked(e.target.checked ? new Set(openable.map(keyOf)) : new Set())}
          onClick={(e) => e.stopPropagation()}
        />
      ),
      width: 42,
      sortable: false,
      align: 'center',
      render: (r) =>
        r.status === 'posted' ? null : (
          <input
            type="checkbox"
            aria-label={`Post ${r.label}`}
            checked={checked.has(keyOf(r))}
            onChange={(e) => toggle(keyOf(r), e.target.checked)}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          />
        ),
    },
    { key: 'date', label: 'Date', type: 'date', width: 96 },
    { key: 'label', label: 'Record', width: 260, grow: true },
    { key: 'amount', label: 'Amount', type: 'money', width: 110, align: 'right' },
    { key: 'status', label: 'Status', width: 100, render: (r) => <StatusBadge s={r.status} />, sortValue: (r) => r.status },
    {
      key: 'error',
      label: 'Problem',
      width: 300,
      grow: true,
      render: (r) => (r.error ? <span className="pc-problem" title={r.error}>{r.error}</span> : r.status === 'posted' ? <span className="cx-muted cx-small">{r.syncedAt ? `Posted ${fmtDateTime(r.syncedAt)}` : ''}</span> : <span className="cx-muted cx-small">Waiting to be posted</span>),
    },
  ];

  return (
    <div className="pc-sync-tab">
      <div className="pc-sync-bar">
        <span className="cx-muted">Show</span>
        <Select
          value={show}
          width={290}
          aria-label="Show"
          onChange={(v) => setShow(v as 'open' | 'all')}
          options={[
            { value: 'open', label: 'Not posted (waiting or with a problem)' },
            { value: 'all', label: 'All records, posted ones too' },
          ]}
        />
        <span className="cx-spacer" />
        <Button label="Retry Selected" onClick={() => void run('selected')} busy={busy === 'selected'} disabled={!!busy || checked.size === 0} />
        <Button variant="primary" label="Retry All" onClick={() => void run('all')} busy={busy === 'all'} disabled={!!busy || (openable.length === 0 && !notPosted)} />
      </div>
      <ListView<SyncItem>
        columns={columns}
        rows={rows}
        getKey={keyOf}
        selectedKey={sel}
        onSelect={(k) => setSel(String(k))}
        onActivate={(r) => openRecord(r.entity as RecordKind, r.id)}
        loading={q.isLoading}
        persistKey="booksSync"
        aria-label="Records not posted to SerieX Books"
        emptyText={
          q.error ? (
            errText(q.error)
          ) : (
            <span className="pc-allposted">
              <CheckCircle2 size={16} color="var(--sx-success)" /> Everything is posted to SerieX Books.
            </span>
          )
        }
        className="pc-sync-list"
      />
      {last && last.problems.length > 0 && <ProblemsPanel problems={last.problems} onClose={() => setLast(null)} />}
      <div className="cx-muted cx-small pc-sync-foot">
        Double-click a record to open it. Paychecks and tax payments are posted when they are saved; records wait here while SerieX Books is not running
        or when it refused them.
      </div>
    </div>
  );
}

function ProblemsPanel({ problems, onClose }: { problems: SyncProblem[]; onClose: () => void }) {
  return (
    <div className="cx-note cx-bad pc-sync-problems" role="alert">
      <AlertCircle size={16} />
      <div className="pc-grow">
        <b>{problems.length === 1 ? 'This record was not posted:' : `${problems.length} records were not posted:`}</b>
        <ul className="pc-problist">
          {problems.slice(0, 20).map((p) => (
            <li key={`${p.entity}:${p.id}:${p.code}`}>
              <button type="button" className="sx-linkbtn" onClick={() => openRecord(p.entity as RecordKind, p.id)}>
                {p.label || `${ENTITY_LABEL[p.entity] ?? p.entity} ${p.id}`}
              </button>
              : {p.message}
            </li>
          ))}
        </ul>
      </div>
      <button type="button" className="sx-linkbtn cx-small" onClick={onClose}>
        Hide
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verify

function VerifyTab() {
  const y = todayIso().slice(0, 4);
  const [from, setFrom] = useState(`${y}-01-01`);
  const [to, setTo] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<VerifyResult | null>(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<string | null>(null);

  const verify = async () => {
    setErr('');
    if (from && to && from > to) {
      setErr('The From date must be on or before the To date.');
      return;
    }
    setBusy(true);
    try {
      setRes(await api.post<VerifyResult>('/books/verify', { from, to }, { noPrompt: true }));
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const off = useMemo(() => (res?.accounts ?? []).filter((a) => Math.abs(a.difference) >= 0.005), [res]);
  // records that are in payroll but not in SerieX Books on purpose (year-to-date entries, earlier tax payments,
  // adjustments that do not affect accounts) or that wait in Books Sync explain a payroll balance
  // that differs from SerieX Books
  const showNotIn = (res?.accounts ?? []).some((a) => Math.abs(a.notInBooks ?? 0) >= 0.005);
  const showNotPosted = (res?.accounts ?? []).some((a) => Math.abs(a.notPosted ?? 0) >= 0.005);
  const probCols: ListColumn<VerifyProblem>[] = [
    { key: 'entity', label: 'Type', width: 130, render: (p) => ENTITY_LABEL[p.entity] ?? p.entity },
    { key: 'label', label: 'Record', width: 240, grow: true },
    { key: 'booksTxnId', label: 'SerieX Books #', width: 110, align: 'right' },
    { key: 'problem', label: 'Problem', width: 340, grow: true, render: (p) => <span className="pc-problem" title={p.problem}>{p.problem}</span> },
  ];

  return (
    <div className="pc-sync-tab">
      <div className="pc-sync-bar">
        <span className="cx-muted">From</span>
        <DateField value={from} onChange={setFrom} width={124} aria-label="From" name="from" />
        <span className="cx-muted">To</span>
        <DateField value={to} onChange={setTo} width={124} aria-label="To" name="to" />
        <Button variant="primary" icon={ShieldCheck} label="Verify" onClick={() => void verify()} busy={busy} />
        <span className="cx-spacer" />
        {res && (
          <span className="cx-small">
            {res.checked} record{res.checked === 1 ? '' : 's'} checked ·{' '}
            {res.problems.length === 0 && off.length === 0 ? (
              <b style={{ color: 'var(--sx-success)' }}>no problems found</b>
            ) : (
              <b style={{ color: 'var(--sx-danger)' }}>
                {res.problems.length} problem{res.problems.length === 1 ? '' : 's'}
                {off.length ? `, ${off.length} account${off.length === 1 ? '' : 's'} out of balance` : ''}
              </b>
            )}
          </span>
        )}
      </div>
      {err && <div className="cx-note cx-bad">{err}</div>}
      {!res && !busy && !err && (
        <div className="cx-intro pc-verify-intro">
          Verify compares every paycheck, tax payment and adjustment posted in these dates with its transaction in SerieX Books (date, bank account,
          payee, amounts by account, voided), then compares the payroll liability balances with the balances of the liability accounts in SerieX Books as of
          the To date.
        </div>
      )}
      {busy && <Spinner label="Comparing payroll with SerieX Books..." />}
      {res && (
        <div className="pc-verify">
          <div className="cx-section-title">Problems</div>
          {res.problems.length === 0 ? (
            <div className="pc-allposted">
              <CheckCircle2 size={16} color="var(--sx-success)" /> Every posted record matches its SerieX Books transaction.
            </div>
          ) : (
            <ListView<VerifyProblem>
              columns={probCols}
              rows={res.problems}
              getKey={(p) => `${p.entity}:${p.id}:${p.problem}`}
              selectedKey={sel}
              onSelect={(k) => setSel(String(k))}
              onActivate={(p) => openRecord(p.entity as RecordKind, p.id)}
              className="pc-verify-list"
              aria-label="Verify problems"
            />
          )}
          <div className="cx-section-title">Account tie-out as of {fmtDate(to)}</div>
          <table className="pc-tieout">
            <thead>
              <tr>
                <th>SerieX Books account</th>
                <th className="cx-right">Payroll balance</th>
                {showNotIn && (
                  <th className="cx-right" title="Year-to-date entries, earlier tax payments and adjustments that do not affect accounts are never posted to SerieX Books">
                    Not in SerieX Books
                  </th>
                )}
                {showNotPosted && (
                  <th className="cx-right" title="Records waiting in Books Sync (not posted yet or with a problem)">
                    Waiting to post
                  </th>
                )}
                <th className="cx-right">SerieX Books balance</th>
                <th className="cx-right">Difference</th>
              </tr>
            </thead>
            <tbody>
              {res.accounts.map((a: AccountTieOut) => {
                const bad = Math.abs(a.difference) >= 0.005;
                return (
                  <tr key={a.accountId} className={bad ? 'pc-bad' : ''}>
                    <td>{a.accountName || `Account ${a.accountId}`}</td>
                    <td className="cx-right cx-num">{fmtMoney(a.payrollBalance)}</td>
                    {showNotIn && <td className="cx-right cx-num">{a.notInBooks ? fmtMoney(a.notInBooks) : ''}</td>}
                    {showNotPosted && <td className="cx-right cx-num">{a.notPosted ? fmtMoney(a.notPosted) : ''}</td>}
                    <td className="cx-right cx-num">{fmtMoney(a.booksBalance)}</td>
                    <td className="cx-right cx-num">{bad ? fmtMoney(a.difference) : <CheckCircle2 size={14} color="var(--sx-success)" />}</td>
                  </tr>
                );
              })}
              {res.accounts.length === 0 && (
                <tr>
                  <td colSpan={4 + (showNotIn ? 1 : 0) + (showNotPosted ? 1 : 0)} className="cx-muted">
                    No payroll liability accounts have a balance in these dates.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
