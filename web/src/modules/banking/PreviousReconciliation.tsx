// Previous Reconciliation: choose an account and one of its statement dates, then display the
// Summary, Detail or Both reconciliation report.
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, SquareCheck } from 'lucide-react';
import { api } from '@/api/client';
import { useAccounts } from '@/api/hooks';
import type { ID, Reconciliation } from '@/api/types';
import { AccountPicker, Button, EmptyState, Field, ListView, RadioGroup, Spinner, type ListColumn } from '@/components';
import { fmtDate } from '@/util/format';
import { localDay } from './shared';
import { openWindow } from '@/windows/windowStore';
import { useWindow } from '@/windows/WindowContext';
import type { ReconcileReportMode } from './ReconcileReportWindow';
import { RECONCILE_TYPES } from './reconcileShared';
import './banking.css';

export interface PreviousReconciliationProps {
  accountId?: number;
}

// widths add up to less than the list of the default 640px window (with room for a scroll bar)
const COLUMNS: ListColumn<Reconciliation>[] = [
  { key: 'statementDate', label: 'Statement date', width: 124, type: 'date' },
  { key: 'endingBalance', label: 'Ending balance', width: 126, type: 'money' },
  { key: 'clearedBalance', label: 'Cleared balance', width: 134, type: 'money' },
  { key: 'completedAt', label: 'Reconciled on', width: 118, render: (r) => fmtDate(localDay(r.completedAt)), sortValue: (r) => r.completedAt },
  { key: 'completedBy', label: 'By', width: 72, grow: true },
];

export default function PreviousReconciliation(props: PreviousReconciliationProps) {
  const win = useWindow();
  const { data: accounts } = useAccounts({ active: 'all' });
  const { data: all, isLoading } = useQuery({ queryKey: ['reconciliations'], queryFn: () => api.get<Reconciliation[]>('/reconciliations'), staleTime: 0 });
  const withRecs = useMemo(() => new Set((all ?? []).map((r) => r.accountId)), [all]);
  const [accountId, setAccountId] = useState<ID | null>(props.accountId ?? null);
  const [selected, setSelected] = useState<ID | null>(null);
  const [mode, setMode] = useState<ReconcileReportMode>('summary');

  useEffect(() => {
    win.setTitle('Previous Reconciliation');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (props.accountId) setAccountId(props.accountId);
  }, [props.accountId]);
  // default: the first account that has reconciliations
  useEffect(() => {
    if (accountId || !all?.length) return;
    setAccountId(all[0].accountId);
  }, [all, accountId]);

  const list = useMemo(() => (all ?? []).filter((r) => r.accountId === accountId), [all, accountId]);
  useEffect(() => {
    if (!list.some((r) => r.id === selected)) setSelected(list[0]?.id ?? null);
  }, [list, selected]);

  const display = (id: ID | null = selected) => {
    const r = list.find((x) => x.id === id);
    if (!r) return;
    openWindow('reconcileReport', { reconciliationId: r.id, mode, requestId: Date.now() }, { title: `Reconciliation Report - ${r.accountName}` });
  };

  const account = accounts?.find((a) => a.id === accountId);

  return (
    <div className="bk-prev">
      <div className="bk-prev-top">
        <Field label="Account" htmlFor="bk-prev-acct" width={300}>
          <AccountPicker
            id="bk-prev-acct"
            name="accountId"
            types={RECONCILE_TYPES}
            filter={(a) => withRecs.has(a.id) || a.id === accountId}
            value={accountId}
            onChange={(id) => setAccountId(id)}
            addNew={false}
          />
        </Field>
        <Field label="Type of report">
          <RadioGroup<ReconcileReportMode>
            row
            value={mode}
            onChange={setMode}
            aria-label="Type of report"
            options={[
              { value: 'summary', label: 'Summary' },
              { value: 'detail', label: 'Detail' },
              { value: 'both', label: 'Both' },
            ]}
          />
        </Field>
      </div>
      <div className="bk-prev-list">
        {isLoading ? (
          <Spinner center />
        ) : list.length ? (
          <ListView<Reconciliation>
            columns={COLUMNS}
            rows={list}
            selectedKey={selected}
            onSelect={(k) => setSelected(k as ID)}
            onActivate={(r) => display(r.id)}
            autoFocus
            aria-label="Statement ending dates"
            persistKey="bk-prev"
          />
        ) : (
          <EmptyState
            compact
            icon={SquareCheck}
            title={account ? `${account.fullName} has not been reconciled yet` : 'No reconciliations yet'}
            message="After you finish a reconciliation, its report is kept here so you can look back at what was cleared."
            action={accountId ? { label: 'Reconcile now', onClick: () => openWindow('reconcileBegin', { accountId }) } : undefined}
          />
        )}
      </div>
      <div className="bk-prev-foot">
        <span className="bk-muted">Double-click a statement date to display its report.</span>
        <span className="bk-grow" />
        <Button label="Close" onClick={() => void win.close()} />
        <Button variant="primary" icon={FileText} label="Display" onClick={() => display()} disabled={!selected} />
      </div>
    </div>
  );
}
