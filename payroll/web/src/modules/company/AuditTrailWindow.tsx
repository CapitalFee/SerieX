// Audit Trail (Reports > Audit Trail): every change made to the payroll file (paychecks, tax
// payments and adjustments, employees, payroll items, preferences, tax tables, filed forms, social
// security numbers viewed...), newest first, with who made it and when. A row shows its details
// (the values before and after); double-click opens the record when it still exists.
import { useMemo, useState } from 'react';
import { Download, Printer, RefreshCw } from 'lucide-react';
import type { AuditRow } from '@/api/types';
import { Button, DateField, ListView, SearchBox, Select, Spinner, type ListColumn } from '@/components';
import { openRecord, type RecordKind } from '@/windows/windowStore';
import { DATE_PRESETS_WITH_CUSTOM, resolvePreset } from '@/util/dates';
import { downloadCsv } from '@/util/csv';
import { escHtml, printHtml } from '@/util/print';
import { today, useSession } from '@/state/session';
import { payrollPresetLabel } from '@/modules/reports/reportMeta';
import { errText, fmtDateTime, useAudit } from './shared';
// the filter bar uses the report window's filter bar styles (rpt-filterbar)
import '@/modules/reports/reports.css';
import './company.css';

export interface AuditTrailWindowProps {}

const ENTITIES: { value: string; label: string }[] = [
  { value: '', label: 'All records' },
  { value: 'paycheck', label: 'Paychecks' },
  { value: 'liability_payment', label: 'Tax payments' },
  { value: 'adjustment', label: 'Tax balance adjustments' },
  { value: 'employee', label: 'Employees' },
  { value: 'item', label: 'Payroll items' },
  { value: 'pay_schedule', label: 'Pay schedules' },
  { value: 'pto_adjustment', label: 'Sick and vacation adjustments' },
  { value: 'employee_defaults', label: 'Employee defaults' },
  { value: 'payment_schedule', label: 'Tax payment schedule' },
  { value: 'company', label: 'Company information' },
  { value: 'prefs', label: 'Preferences' },
  { value: 'state_settings', label: 'State settings' },
  { value: 'access', label: 'User access' },
  { value: 'tax_table', label: 'Tax tables' },
  { value: 'form', label: 'Tax forms' },
  { value: 'report', label: 'Reports' },
];

const ENTITY_LABEL: Record<string, string> = {
  paycheck: 'Paycheck',
  liability_payment: 'Tax payment',
  adjustment: 'Tax balance adjustment',
  employee: 'Employee',
  item: 'Payroll item',
  pay_schedule: 'Pay schedule',
  pto_adjustment: 'Sick/vacation adjustment',
  employee_defaults: 'Employee defaults',
  payment_schedule: 'Payment schedule',
  company: 'Company information',
  prefs: 'Preferences',
  state_settings: 'State settings',
  access: 'User access',
  tax_table: 'Tax table',
  form: 'Tax form',
  report: 'Report',
};

const ACTION_LABEL: Record<string, string> = {
  add: 'Added',
  modify: 'Changed',
  delete: 'Deleted',
  void: 'Voided',
  view_ssn: 'Viewed SSN',
  file_form: 'Filed',
  print: 'Printed',
  login: 'Signed in',
  setup: 'Set up',
  export: 'Exported',
};

const OPENABLE = new Set(['paycheck', 'liability_payment', 'adjustment', 'employee', 'item']);

/** "before"/"after" pairs of the details as rows (only values that differ). */
function changes(details: Record<string, unknown>): { field: string; before: string; after: string }[] {
  const b = details?.before as Record<string, unknown> | undefined;
  const a = details?.after as Record<string, unknown> | undefined;
  const fmt = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (!b && !a) {
    return Object.entries(details ?? {}).map(([k, v]) => ({ field: k, before: '', after: fmt(v) }));
  }
  if (!b || typeof b !== 'object' || !a || typeof a !== 'object') return [{ field: '', before: fmt(b), after: fmt(a) }];
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)]));
  return keys.filter((k) => fmt(b[k]) !== fmt(a[k])).map((k) => ({ field: k, before: fmt(b[k]), after: fmt(a[k]) }));
}

export default function AuditTrailWindow(_props: AuditTrailWindowProps) {
  const company = useSession((s) => s.company?.name ?? '');
  const [preset, setPreset] = useState('thisMonthToDate');
  const [range, setRange] = useState(() => resolvePreset('thisMonthToDate', today()));
  const [entity, setEntity] = useState('');
  const [user, setUser] = useState('');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<number | null>(null);
  const params = useMemo(() => ({ from: range.from || undefined, to: range.to || undefined, entity: entity || undefined }), [range, entity]);
  const aq = useAudit(params);
  const all = aq.data ?? [];
  const users = useMemo(() => Array.from(new Set(all.map((r) => r.user))).sort(), [all]);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return all.filter((r) => (!user || r.user === user) && (!t || r.summary.toLowerCase().includes(t) || r.entity.includes(t) || r.user.toLowerCase().includes(t)));
  }, [all, user, q]);
  const cur = rows.find((r) => r.id === sel) ?? null;

  const columns: ListColumn<AuditRow>[] = [
    { key: 'ts', label: 'Date / time', width: 146, render: (r) => fmtDateTime(r.ts), sortValue: (r) => r.ts },
    { key: 'user', label: 'User', width: 90 },
    { key: 'action', label: 'Action', width: 90, render: (r) => ACTION_LABEL[r.action] ?? r.action },
    { key: 'entity', label: 'Record', width: 140, render: (r) => ENTITY_LABEL[r.entity] ?? r.entity },
    { key: 'summary', label: 'Summary', width: 280, grow: true },
  ];

  const header = () => ['Date/Time', 'User', 'Action', 'Record', 'Summary'];
  const line = (r: AuditRow) => [fmtDateTime(r.ts), r.user, ACTION_LABEL[r.action] ?? r.action, ENTITY_LABEL[r.entity] ?? r.entity, r.summary];
  const subtitle = range.from ? `${range.from} to ${range.to}` : `Through ${range.to}`;

  const doPrint = () => {
    const body =
      `<div class="center bold" style="font-size:13px">${escHtml(company)}</div><h1 class="center">Audit Trail</h1><div class="center muted">${escHtml(subtitle)}</div><br/>` +
      `<table><thead><tr>${header()
        .map((h) => `<th>${escHtml(h)}</th>`)
        .join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${line(r).map((c) => `<td>${escHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    void printHtml('Audit Trail', body, 'td{border-bottom:1px solid #ddd} h1{text-align:center}');
  };

  return (
    <div className="pc-audit">
      <div className="rpt-filterbar pc-audit-bar">
        <div className="rpt-f">
          <span className="rpt-f-label">Dates</span>
          <div className="rpt-f-ctl">
            <Select
              width={190}
              aria-label="Dates"
              value={preset}
              options={DATE_PRESETS_WITH_CUSTOM.map((p) => ({ value: p.key, label: payrollPresetLabel(p.label) }))}
              onChange={(v) => {
                setPreset(v);
                if (v !== 'custom') setRange(resolvePreset(v, today()));
              }}
            />
          </div>
        </div>
        <div className="rpt-f">
          <span className="rpt-f-label">From</span>
          <div className="rpt-f-ctl">
            <DateField
              value={range.from}
              width={124}
              aria-label="From"
              onChange={(v) => {
                setPreset('custom');
                setRange((r) => ({ ...r, from: v }));
              }}
            />
          </div>
        </div>
        <div className="rpt-f">
          <span className="rpt-f-label">To</span>
          <div className="rpt-f-ctl">
            <DateField
              value={range.to}
              width={124}
              aria-label="To"
              onChange={(v) => {
                setPreset('custom');
                if (v) setRange((r) => ({ ...r, to: v }));
              }}
            />
          </div>
        </div>
        <div className="rpt-f">
          <span className="rpt-f-label">Records</span>
          <div className="rpt-f-ctl">
            <Select width={170} aria-label="Records" value={entity} options={ENTITIES} onChange={setEntity} />
          </div>
        </div>
        <div className="rpt-f">
          <span className="rpt-f-label">User</span>
          <div className="rpt-f-ctl">
            <Select width={130} aria-label="User" value={user} options={[{ value: '', label: 'All users' }, ...users.map((u) => ({ value: u, label: u }))]} onChange={setUser} />
          </div>
        </div>
        <div className="rpt-f">
          <span className="rpt-f-label">Find</span>
          <div className="rpt-f-ctl">
            <SearchBox value={q} onChange={setQ} placeholder="Find in the summary" width={180} aria-label="Find in the audit trail" />
          </div>
        </div>
        <span className="cx-spacer" />
        <div className="pc-audit-actions">
          <Button size="sm" icon={RefreshCw} label="Refresh" onClick={() => void aq.refetch()} busy={aq.isFetching && !aq.isLoading} />
          <Button size="sm" icon={Printer} label="Print" onClick={doPrint} disabled={!rows.length} />
          <Button size="sm" icon={Download} label="Export CSV" title="Download the list as a CSV file (opens in Excel)" onClick={() => downloadCsv(`Audit Trail ${today()}`, [header(), ...rows.map(line)])} disabled={!rows.length} />
        </div>
      </div>
      <div className="pc-audit-main">
        <ListView<AuditRow>
          columns={columns}
          rows={rows}
          selectedKey={sel}
          onSelect={(k) => setSel(Number(k))}
          onActivate={(r) => r.entityId && OPENABLE.has(r.entity) && openRecord(r.entity as RecordKind, r.entityId)}
          loading={aq.isLoading}
          emptyText={aq.error ? errText(aq.error) : 'No changes in these dates.'}
          persistKey="auditTrail"
          aria-label="Audit trail"
          className="pc-audit-list"
          autoFocus
        />
        <div className="pc-audit-detail">
          {aq.isLoading ? (
            <Spinner />
          ) : !cur ? (
            <div className="cx-muted cx-small">Select a row to see what changed.</div>
          ) : (
            <>
              <div className="cx-h2">{cur.summary}</div>
              <div className="cx-muted cx-small">
                {fmtDateTime(cur.ts)} · {cur.user} · {ACTION_LABEL[cur.action] ?? cur.action} {ENTITY_LABEL[cur.entity] ?? cur.entity}
                {cur.entityId ? ` #${cur.entityId}` : ''}
              </div>
              {cur.entityId && OPENABLE.has(cur.entity) && cur.action !== 'delete' && (
                <button type="button" className="sx-linkbtn cx-small" onClick={() => openRecord(cur.entity as RecordKind, cur.entityId!)}>
                  Open this {(ENTITY_LABEL[cur.entity] ?? 'record').toLowerCase()}
                </button>
              )}
              <table className="pc-changes">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Before</th>
                    <th>After</th>
                  </tr>
                </thead>
                <tbody>
                  {changes(cur.details).map((c, i) => (
                    <tr key={i}>
                      <td>{c.field}</td>
                      <td title={c.before}>{c.before}</td>
                      <td title={c.after}>{c.after}</td>
                    </tr>
                  ))}
                  {changes(cur.details).length === 0 && (
                    <tr>
                      <td colSpan={3} className="cx-muted">
                        No details were recorded.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
      <div className="cx-muted cx-small pc-audit-foot">
        {rows.length} change{rows.length === 1 ? '' : 's'}
        {all.length >= 2000 ? ' (the 2,000 most recent; choose shorter dates to see older ones)' : ''}
      </div>
    </div>
  );
}
