// Find and Edit Paychecks (also Edit > Find Paychecks): paychecks dated in a range (search by
// employee, number or memo), with Edit (the Paycheck window), Paycheck Details, Void (type YES),
// Delete and Pay Stub. The info panel explains what can be done with the highlighted check.
import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, FileText, ListChecks, Pencil, Trash2, XCircle } from 'lucide-react';
import { usePaychecks } from '@/api/hooks';
import type { Id, PaycheckSummary } from '@/api/types';
import { Button, Checkbox, DateField, EmptyState, ListView, SearchBox, StatusPill } from '@/components';
import { fmtDate, fmtMoney } from '@/util/format';
import { endOfYear, startOfYear, todayIso } from '@/util/dates';
import { useWindow } from '@/windows/WindowContext';
import { openRecord, openWindow } from '@/windows/windowStore';
import { fetchPayStubs, payStubPage, previewHtml, printPayStubs } from './printing';
import { checkNumberLabel, deletePaycheck, showError, sum2, syncInfo, voidPaycheck } from './shared';
import './payroll.css';

export interface EditVoidPaychecksProps {
  /** Search text (global search "Find paychecks for ..."). */
  q?: string;
  /** Time of that search: the text is applied again when the same search is repeated. */
  qAt?: number;
}

export default function EditVoidPaychecks(props: EditVoidPaychecksProps) {
  const win = useWindow();
  const today = todayIso();
  const [from, setFrom] = useState(startOfYear(today));
  const [to, setTo] = useState(endOfYear(today));
  const [q, setQ] = useState(props.q ?? '');
  const [showVoid, setShowVoid] = useState(true);
  const [sel, setSel] = useState<Id | null>(null);
  useEffect(() => {
    if (props.q !== undefined) setQ(props.q);
  }, [props.q, props.qAt]);
  useEffect(() => {
    win.setTitle('Find and Edit Paychecks');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data, isLoading, isFetching } = usePaychecks({ from, to, q: q.trim() || undefined, includeVoided: showVoid, kind: 'regular' });
  const rows = useMemo(() => data ?? [], [data]);
  const cur = rows.find((r) => r.id === sel) ?? null;
  useEffect(() => {
    if (rows.length && !rows.some((r) => r.id === sel)) setSel(rows[0].id);
  }, [rows, sel]);

  const stub = async (p: PaycheckSummary) => {
    try {
      const stubs = await fetchPayStubs([p.id]);
      await previewHtml('Pay Stub', stubs.map((s) => payStubPage(s)).join(''), () => void printPayStubs([p.id]).catch((e) => showError(e, 'Pay Stub')));
    } catch (e) {
      await showError(e, 'Pay Stub');
    }
  };

  const info = !cur
    ? 'Select a paycheck.'
    : cur.voided
      ? 'This paycheck is void. Its amounts are zero; it stays in the list so the check number sequence is complete.'
      : cur.directDeposit
        ? 'This is a direct deposit paycheck. You may edit or void it; voiding does not cancel a deposit that was already processed.'
        : 'You may edit or void this check. If you have already given the check to the employee, change only the check information (number, date, memo) so the net check amount does not change.';

  return (
    <div className="py-page py-editvoid">
      <div className="py-important" role="note">
        <AlertTriangle size={16} aria-hidden="true" />
        <div>
          <b>Voiding cannot be undone.</b> Void a paycheck only when it was created by mistake. To replace a lost check, print it again with a new number. To fix amounts, edit
          the paycheck or adjust the tax balances.
        </div>
      </div>
      <div className="py-filters">
        <span className="sx-label">SHOW PAYCHECKS DATED FROM</span>
        <DateField value={from} onChange={(d) => d && setFrom(d)} width={130} aria-label="From" />
        <span className="sx-label">THROUGH</span>
        <DateField value={to} onChange={(d) => d && setTo(d)} width={130} aria-label="Through" />
        <SearchBox value={q} onChange={setQ} debounce={250} placeholder="Employee, number or memo" width={230} aria-label="Search paychecks" />
        <Checkbox label="Show voided" checked={showVoid} onChange={setShowVoid} />
        {isFetching && <span className="py-muted py-small">Loading…</span>}
      </div>
      <div className="py-gridwrap">
        {!isLoading && rows.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title="No paychecks"
            message={q ? `No paychecks dated ${fmtDate(from)} – ${fmtDate(to)} match "${q}".` : `There are no paychecks dated ${fmtDate(from)} – ${fmtDate(to)}.`}
            action={{ label: 'Pay employees', onClick: () => openWindow('payEmployees', { kind: 'unscheduled' }) }}
          />
        ) : (
          <ListView<PaycheckSummary>
            aria-label="Paychecks"
            loading={isLoading}
            rows={rows}
            selectedKey={sel}
            onSelect={(k) => setSel(k as Id)}
            onActivate={(r) => openRecord('paycheck', r.id)}
            autoFocus
            persistKey="py-editvoid"
            isInactive={(r) => r.voided}
            contextMenu={(r) =>
              r
                ? [
                    { label: '&Edit Paycheck', onClick: () => openRecord('paycheck', r.id) },
                    { label: 'Paycheck &Detail…', disabled: r.voided, onClick: () => openWindow('paycheckDetail', { id: r.id }) },
                    { label: 'Pay &Stub', disabled: r.voided, onClick: () => void stub(r) },
                    { separator: true },
                    { label: '&Void Paycheck', disabled: r.voided, onClick: () => void voidPaycheck(r) },
                    { label: 'De&lete Paycheck', onClick: () => void deletePaycheck(r) },
                  ]
                : []
            }
            columns={[
              { key: 'checkDate', label: 'Paycheck Date', width: 110, type: 'date' },
              { key: 'checkNumber', label: 'Check No.', width: 90, render: (r) => checkNumberLabel(r), sortValue: (r) => r.checkNumber },
              { key: 'employeeName', label: 'Employee', width: 190 },
              { key: 'period', label: 'Pay Period', width: 180, render: (r) => `${fmtDate(r.periodStart)} – ${fmtDate(r.periodEnd)}`, sortValue: (r) => r.periodEnd },
              { key: 'memo', label: 'Memo', width: 160, grow: true },
              { key: 'net', label: 'Net Amount', width: 110, type: 'money', align: 'right' },
              {
                key: 'syncStatus',
                label: 'SerieX Books',
                width: 120,
                render: (r) => {
                  const s = syncInfo(r);
                  return <StatusPill status={r.voided ? 'Void' : s.label} tone={r.voided ? 'muted' : s.tone} />;
                },
                sortValue: (r) => r.syncStatus,
              },
            ]}
          />
        )}
      </div>
      <div className="py-infopanel" aria-live="polite">
        {cur && (
          <div className="py-infopanel-head">
            {cur.employeeName} · {fmtDate(cur.checkDate)} · {checkNumberLabel(cur) || 'no number'} · {fmtMoney(cur.net)}
            {cur.syncStatus === 'error' && <span className="py-neg"> · SerieX Books: {cur.syncError}</span>}
          </div>
        )}
        <div>{info}</div>
      </div>
      <div className="py-foot">
        <Button icon={Pencil} label="&Edit" disabled={!cur} onClick={() => cur && openRecord('paycheck', cur.id)} />
        <Button icon={ListChecks} label="Paycheck &Detail…" disabled={!cur || cur.voided} onClick={() => cur && openWindow('paycheckDetail', { id: cur.id })} />
        <Button icon={XCircle} label="&Void" disabled={!cur || cur.voided} onClick={() => cur && void voidPaycheck(cur)} />
        <Button icon={Trash2} variant="ghost" label="De&lete" disabled={!cur} onClick={() => cur && void deletePaycheck(cur)} />
        <Button icon={FileText} label="Pay &Stub" disabled={!cur || cur.voided} onClick={() => cur && void stub(cur)} />
        <span className="py-grow" />
        <span className="py-muted">
          {rows.length} paycheck{rows.length === 1 ? '' : 's'} · net {fmtMoney(sum2(rows.map((r) => r.net)))}
        </span>
        <Button variant="primary" label="Done" onClick={() => void win.close()} />
      </div>
    </div>
  );
}
