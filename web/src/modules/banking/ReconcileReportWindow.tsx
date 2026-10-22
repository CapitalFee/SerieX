// Reconciliation report (Summary / Detail / Both), formatted as a classic reconciliation report:
// Beginning Balance, Cleared Transactions (checks and payments, deposits and credits) with item
// counts, Cleared Balance, Uncleared Transactions, Register Balance as of the statement date,
// New Transactions after it, Ending Balance. Double-click a detail row to open the transaction.
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { History, Landmark, Printer } from 'lucide-react';
import { api } from '@/api/client';
import { useCompanyInfo, useRegister } from '@/api/hooks';
import { TXN_TYPE_LABELS, type ID, type ReconcileChange, type ReconcileEntry, type ReconcileReport, type TxnType } from '@/api/types';
import { EmptyState, SegmentedControl, Spinner, Toolbar, ToolbarButton, ToolbarSpacer } from '@/components';
import { addDays } from '@/util/dates';
import { fmtDate, fmtMoney, round2 } from '@/util/format';
import { localDay } from './shared';
import { escHtml, printHtml } from '@/util/print';
import { openTxn, openWindow } from '@/windows/windowStore';
import { useWindow } from '@/windows/WindowContext';
import { discrepanciesQuery, groupLabels } from './reconcileShared';
import { openRegister } from './UseRegisterDialog';
import './banking.css';

export type ReconcileReportMode = 'summary' | 'detail' | 'both';

export interface ReconcileReportWindowProps {
  /** The reconciliation to report (Summary / Detail / Both). */
  reconciliationId?: number;
  /** 'discrepancy': the account's Discrepancy report (reconciled transactions changed since), with `accountId`. */
  mode?: ReconcileReportMode | 'discrepancy';
  /** Account of the Discrepancy report. */
  accountId?: number;
  /**
   * Changes on every "Display" request (a timestamp): asking again for the same report type in a
   * window that is already open (and was switched to another type meanwhile) applies it again.
   */
  requestId?: number;
}

interface Line {
  txnId?: ID;
  type?: TxnType;
  typeLabel: string;
  date: string;
  num: string;
  name: string;
  clr: string;
  amount: number;
}

interface Row {
  kind: 'section' | 'data' | 'subtotal' | 'total' | 'grand' | 'blank';
  level: number;
  label?: string;
  amount?: number | null;
  line?: Line;
  balance?: number;
}

const fromEntry = (e: ReconcileEntry, clr: string): Line => ({ txnId: e.txnId, type: e.type, typeLabel: e.typeLabel, date: e.date, num: e.refNumber, name: e.nameFull, clr, amount: e.amount });
const items = (n: number) => `${n} item${n === 1 ? '' : 's'}`;
const sum = (l: Line[]) => round2(l.reduce((s, x) => s + x.amount, 0));

/** Builds the report rows (shared by the screen and the printout). */
function buildRows(rep: ReconcileReport, newLines: Line[], endingBalance: number, accountType: string, detail: boolean): Row[] {
  const g = groupLabels(accountType);
  const rec = rep.reconciliation;
  const rows: Row[] = [];
  const block = (title: string, lines: Line[], totalLabel: string) => {
    const dec = lines.filter((l) => l.amount < 0);
    const inc = lines.filter((l) => l.amount >= 0);
    rows.push({ kind: 'section', level: 1, label: title });
    let bal = 0;
    for (const [label, list] of [
      [g.decrease, dec],
      [g.increase, inc],
    ] as [string, Line[]][]) {
      if (!detail) {
        rows.push({ kind: 'data', level: 2, label: `${label} - ${items(list.length)}`, amount: sum(list) });
        continue;
      }
      if (!list.length) continue;
      rows.push({ kind: 'section', level: 2, label: `${label} - ${items(list.length)}` });
      for (const l of list) {
        bal = round2(bal + l.amount);
        rows.push({ kind: 'data', level: 3, line: l, amount: l.amount, balance: bal });
      }
      rows.push({ kind: 'subtotal', level: 2, label: `Total ${label}`, amount: sum(list), balance: bal });
    }
    rows.push({ kind: 'subtotal', level: 1, label: totalLabel, amount: sum(lines), balance: detail ? sum(lines) : undefined });
  };
  const cleared = rep.cleared.map((e) => fromEntry(e, 'X'));
  const uncleared = rep.uncleared.map((e) => fromEntry(e, e.cleared === '*' ? '*' : ''));
  rows.push({ kind: 'total', level: 0, label: 'Beginning Balance', amount: rec.beginningBalance });
  block('Cleared Transactions', cleared, 'Total Cleared Transactions');
  rows.push({ kind: 'total', level: 0, label: 'Cleared Balance', amount: rec.clearedBalance });
  if (uncleared.length || !detail) {
    rows.push({ kind: 'blank', level: 0 });
    block('Uncleared Transactions', uncleared, 'Total Uncleared Transactions');
  }
  // the cleared amounts are as reconciled, the register balance is as it is now: the changes made
  // since (listed below the report) are the difference, so the report adds up
  const changes = rep.changes ?? [];
  if (changes.length) {
    rows.push({ kind: 'blank', level: 0 });
    rows.push({ kind: 'subtotal', level: 1, label: `Changes since this reconciliation - ${items(changes.length)}`, amount: round2(changes.reduce((t, c) => t + c.effect, 0)) });
  }
  rows.push({ kind: 'total', level: 0, label: `Register Balance as of ${fmtDate(rec.statementDate)}`, amount: rep.registerBalance });
  if (newLines.length) {
    rows.push({ kind: 'blank', level: 0 });
    block('New Transactions', newLines, 'Total New Transactions');
  }
  rows.push({ kind: 'grand', level: 0, label: 'Ending Balance', amount: endingBalance });
  return rows;
}

function rowsHtml(rows: Row[], detail: boolean): string {
  const head = detail
    ? '<tr><th></th><th>Type</th><th>Date</th><th>Num</th><th>Name</th><th>Clr</th><th class="num">Amount</th><th class="num">Balance</th></tr>'
    : '<tr><th></th><th class="num">' + '</th></tr>';
  const body = rows
    .map((r) => {
      const pad = `padding-left:${r.level * 16}px`;
      const cls = r.kind === 'data' ? '' : r.kind === 'grand' ? 'bold grand' : r.kind === 'blank' ? '' : 'bold';
      if (r.kind === 'blank') return `<tr><td colspan="${detail ? 8 : 2}">&nbsp;</td></tr>`;
      if (detail) {
        if (r.line)
          return `<tr><td style="${pad}"></td><td>${escHtml(r.line.typeLabel)}</td><td>${fmtDate(r.line.date)}</td><td>${escHtml(r.line.num)}</td><td>${escHtml(r.line.name)}</td><td>${escHtml(r.line.clr)}</td><td class="num">${fmtMoney(r.line.amount)}</td><td class="num">${fmtMoney(r.balance)}</td></tr>`;
        return `<tr class="${cls}"><td colspan="6" style="${pad}">${escHtml(r.label ?? '')}</td><td class="num ${r.kind === 'subtotal' ? 'sub' : ''}">${r.amount === undefined || r.amount === null ? '' : fmtMoney(r.amount)}</td><td class="num">${r.kind === 'total' || r.kind === 'grand' ? fmtMoney(r.amount) : r.balance !== undefined ? fmtMoney(r.balance) : ''}</td></tr>`;
      }
      return `<tr class="${cls}"><td style="${pad}">${escHtml(r.label ?? '')}</td><td class="num ${r.kind === 'subtotal' ? 'sub' : ''}">${r.amount === undefined || r.amount === null ? '' : fmtMoney(r.amount)}</td></tr>`;
    })
    .join('');
  return `<table>${detail ? `<thead>${head}</thead>` : ''}<tbody>${body}</tbody></table>`;
}

export default function ReconcileReportWindow(props: ReconcileReportWindowProps) {
  if (props.mode === 'discrepancy') return <DiscrepancyReport accountId={props.accountId ?? 0} />;
  return <ReconciliationReport reconciliationId={props.reconciliationId ?? 0} initialMode={props.mode ?? 'summary'} requestId={props.requestId} />;
}

/** Rows of the "Changes since this reconciliation" / discrepancy tables (screen and print). */
function changeCells(c: ReconcileChange) {
  return [c.typeLabel, fmtDate(c.date), c.refNumber, c.nameFull, fmtMoney(c.reconciledAmount), c.change === 'Deleted' || c.change === 'Uncleared' ? '' : fmtMoney(c.currentAmount), c.change, fmtMoney(c.effect)];
}
const CHANGE_HEAD = ['Type', 'Date', 'Num', 'Name', 'Reconciled amount', 'New amount', 'Type of change', 'Effect of change'];
const CHANGE_NUM = [false, false, false, false, true, true, false, true];

function changesHtml(changes: ReconcileChange[]): string {
  const head = `<tr>${CHANGE_HEAD.map((h, i) => `<th${CHANGE_NUM[i] ? ' class="num"' : ''}>${escHtml(h)}</th>`).join('')}</tr>`;
  const body = changes.map((c) => `<tr>${changeCells(c).map((v, i) => `<td${CHANGE_NUM[i] ? ' class="num"' : ''}>${escHtml(v)}</td>`).join('')}</tr>`).join('');
  const total = round2(changes.reduce((s, c) => s + c.effect, 0));
  return `<table><thead>${head}</thead><tbody>${body}<tr class="bold"><td colspan="7">Total effect of changes</td><td class="num sub">${fmtMoney(total)}</td></tr></tbody></table>`;
}

function ChangesTable({ changes }: { changes: ReconcileChange[] }) {
  const total = round2(changes.reduce((s, c) => s + c.effect, 0));
  return (
    <table className="bk-rr-table bk-rr-detail">
      <thead>
        <tr>
          {CHANGE_HEAD.map((h, i) => (
            <th key={h} className={CHANGE_NUM[i] ? 'bk-num' : undefined}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {changes.map((c, n) => (
          <tr
            key={`${c.reconciliationId}-${c.txnId}-${n}`}
            className={'bk-rr-data' + (c.change === 'Deleted' ? '' : ' bk-rr-click')}
            onDoubleClick={() => c.change !== 'Deleted' && openTxn(c.type, c.txnId)}
            title={c.change === 'Deleted' ? 'This transaction was deleted' : 'Double-click to open the transaction'}
          >
            {changeCells(c).map((v, i) => (
              <td key={i} className={CHANGE_NUM[i] ? 'bk-num' : undefined}>
                {v}
              </td>
            ))}
          </tr>
        ))}
        <tr className="bk-rr-subtotal">
          <td colSpan={7}>Total effect of changes</td>
          <td className="bk-num bk-rr-line">{fmtMoney(total)}</td>
        </tr>
      </tbody>
    </table>
  );
}

/** Previous Reconciliation Discrepancy report: reconciled transactions changed, unmarked, voided or deleted since. */
function DiscrepancyReport({ accountId }: { accountId: number }) {
  const win = useWindow();
  const { data: company } = useCompanyInfo();
  const { data, isLoading, error } = useQuery({ ...discrepanciesQuery(accountId), enabled: !!accountId });
  useEffect(() => {
    if (data) win.setTitle(`Discrepancy Report - ${data.accountName}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.accountName]);
  if (isLoading) return <Spinner center label="Loading report..." />;
  if (error || !data) return <EmptyState title="The report could not be loaded" message={(error as Error | null)?.message ?? 'Account not found.'} />;

  // one group per reconciliation (latest statement first)
  const groups: { date: string; changes: ReconcileChange[] }[] = [];
  for (const c of data.changes) {
    let g = groups.find((x) => x.date === c.statementDate);
    if (!g) groups.push((g = { date: c.statementDate, changes: [] }));
    g.changes.push(c);
  }
  groups.sort((a, b) => b.date.localeCompare(a.date));
  const facts = (
    <>
      <span>
        Last statement ending balance{data.lastStatementDate ? ` (${fmtDate(data.lastStatementDate)})` : ''} <b>{fmtMoney(data.lastEndingBalance)}</b>
      </span>
      <span>
        Beginning balance now <b>{fmtMoney(data.beginningBalance)}</b>
      </span>
      <span>
        Difference <b>{fmtMoney(data.difference)}</b>
      </span>
    </>
  );
  const print = () => {
    void printHtml(
      `Discrepancy Report - ${data.accountName}`,
      `<div class="hdr"><h2>${escHtml(company?.name ?? '')}</h2><h1>Previous Reconciliation Discrepancy Report</h1><div class="bold">${escHtml(data.accountName)}</div></div>
       <p class="center">Last statement ending balance ${fmtMoney(data.lastEndingBalance)} · Beginning balance now ${fmtMoney(data.beginningBalance)} · Difference ${fmtMoney(data.difference)}</p>
       ${groups.length ? groups.map((g) => `<h2>Statement Date ${fmtDate(g.date)}</h2>${changesHtml(g.changes)}`).join('') : '<p class="center muted">No reconciled transaction was changed.</p>'}`,
      `.hdr{text-align:center;margin-bottom:12px} td.sub{border-top:1px solid #000} h2{margin-top:14px}`,
    );
  };
  return (
    <div className="bk-rr">
      <Toolbar aria-label="Discrepancy report">
        <ToolbarButton label="Print" icon={Printer} onClick={print} />
        <ToolbarButton label="Previous reports" icon={History} onClick={() => openWindow('reconcileReports', { accountId })} />
        <ToolbarButton label="Open register" icon={Landmark} onClick={() => openRegister(accountId, data.accountName)} />
        <ToolbarSpacer />
      </Toolbar>
      <div className="bk-rr-scroll">
        <div className="bk-rr-paper">
          <div className="bk-rr-header">
            <div className="bk-rr-co">{company?.name}</div>
            <div className="bk-rr-title">Previous Reconciliation Discrepancy Report</div>
            <div className="bk-rr-sub">{data.accountName}</div>
          </div>
          <div className="bk-rr-facts">{facts}</div>
          {groups.length ? (
            groups.map((g) => (
              <div key={g.date} className="bk-rr-changes">
                <div className="bk-rr-changes-title">Statement Date {fmtDate(g.date)}</div>
                <ChangesTable changes={g.changes} />
              </div>
            ))
          ) : (
            <p className="bk-rr-empty">
              {data.difference
                ? 'The difference comes from reconciliations finished before changes were tracked: open the register and compare the reconciled (R) transactions with your statements.'
                : 'No discrepancies: every reconciled transaction is as it was when it was reconciled.'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ReconciliationReport({ reconciliationId, initialMode, requestId }: { reconciliationId: number; initialMode: ReconcileReportMode; requestId?: number }) {
  const win = useWindow();
  const [mode, setMode] = useState<ReconcileReportMode>(initialMode);
  // the window is reused when the same report is asked for again: show the requested type
  useEffect(() => {
    setMode(initialMode);
  }, [initialMode, requestId]);
  const { data: company } = useCompanyInfo();
  const { data: rep, isLoading, error } = useQuery({
    queryKey: ['reconcile-report', reconciliationId],
    queryFn: () => api.get<ReconcileReport>(`/reconciliations/${reconciliationId}/report`),
  });
  const changes = rep?.changes ?? [];
  const rec = rep?.reconciliation;
  const { data: after } = useRegister(rec?.accountId, rec ? { from: addDays(rec.statementDate, 1) } : {});
  const accountType = after?.account.type ?? 'Bank';

  useEffect(() => {
    if (rec) win.setTitle(`Reconciliation Report - ${rec.accountName}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec?.accountName]);

  const newLines = useMemo<Line[]>(
    () =>
      (after?.rows ?? [])
        .filter((r) => !r.voided)
        .map((r) => ({ txnId: r.txnId, type: r.type, typeLabel: TXN_TYPE_LABELS[r.type] ?? r.typeAbbrev, date: r.date, num: r.refNumber, name: r.nameFull, clr: r.cleared === 'R' ? 'X' : r.cleared, amount: round2(r.increase - r.decrease) })),
    [after],
  );
  const ending = after?.endingBalance ?? rep?.registerBalance ?? 0;
  const summaryRows = useMemo(() => (rep ? buildRows(rep, newLines, ending, accountType, false) : []), [rep, newLines, ending, accountType]);
  const detailRows = useMemo(() => (rep ? buildRows(rep, newLines, ending, accountType, true) : []), [rep, newLines, ending, accountType]);

  if (isLoading) return <Spinner center label="Loading report..." />;
  if (error || !rep || !rec) return <EmptyState title="The report could not be loaded" message={(error as Error | null)?.message ?? 'Reconciliation not found.'} />;

  const header = (title: string) => (
    <div className="bk-rr-header">
      <div className="bk-rr-meta">
        Reconciled {fmtDate(localDay(rec.completedAt))}
        {rec.completedBy ? ` by ${rec.completedBy}` : ''}
      </div>
      <div className="bk-rr-co">{company?.name}</div>
      <div className="bk-rr-title">{title}</div>
      <div className="bk-rr-sub">
        {rec.accountName}, Period Ending {fmtDate(rec.statementDate)}
      </div>
    </div>
  );

  const print = () => {
    const part = (title: string, rows: Row[], detail: boolean) =>
      `<div class="hdr"><div class="muted small">Reconciled ${escHtml(fmtDate(localDay(rec.completedAt)))}</div><h2>${escHtml(company?.name ?? '')}</h2><h1>${escHtml(title)}</h1><div class="bold">${escHtml(rec.accountName)}, Period Ending ${fmtDate(rec.statementDate)}</div></div>${rowsHtml(rows, detail)}`;
    const parts: string[] = [];
    const changesPart = changes.length
      ? `<h2 style="margin-top:16px">Changes since this reconciliation</h2><p class="muted">These reconciled transactions were changed after the reconciliation was finished. The amounts above are as they were reconciled.</p>${changesHtml(changes)}`
      : '';
    if (mode !== 'detail') parts.push(part('Reconciliation Summary', summaryRows, false) + (mode === 'summary' ? changesPart : ''));
    if (mode !== 'summary') parts.push(part('Reconciliation Detail', detailRows, true) + changesPart);
    void printHtml(
      `Reconciliation Report - ${rec.accountName}`,
      parts.join('<div class="page-break"></div>'),
      `.hdr{text-align:center;margin-bottom:12px} .small{font-size:9px;text-align:left} td.sub{border-top:1px solid #000} tr.grand td.num{border-top:1px solid #000;border-bottom:3px double #000} table{max-width:${mode === 'summary' ? '480px' : '100%'};margin:0 auto}`,
    );
  };

  const changesBlock = changes.length ? (
    <div className="bk-rr-changes">
      <div className="bk-rr-changes-title">Changes since this reconciliation</div>
      <p className="bk-rr-changes-note">
        {changes.length === 1 ? 'This reconciled transaction was' : `These ${changes.length} reconciled transactions were`} changed after the reconciliation was finished. The amounts above are as they
        were reconciled; the next reconciliation starts from a beginning balance that differs by the total effect.
      </p>
      <ChangesTable changes={changes} />
    </div>
  ) : null;

  const renderSummary = () => (
    <div className="bk-rr-paper">
      {header('Reconciliation Summary')}
      <table className="bk-rr-table bk-rr-summary">
        <tbody>
          {summaryRows.map((r, i) =>
            r.kind === 'blank' ? (
              <tr key={i} className="bk-rr-blank">
                <td colSpan={2} />
              </tr>
            ) : (
              <tr key={i} className={`bk-rr-${r.kind}`}>
                <td style={{ paddingLeft: 8 + r.level * 18 }}>{r.label}</td>
                <td className={'bk-num' + (r.kind === 'subtotal' ? ' bk-rr-line' : '') + (r.kind === 'grand' ? ' bk-rr-dbl' : '')}>{r.amount === undefined || r.amount === null ? '' : fmtMoney(r.amount)}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      {mode === 'summary' && changesBlock}
    </div>
  );

  const renderDetail = () => (
    <div className="bk-rr-paper">
      {header('Reconciliation Detail')}
      <table className="bk-rr-table bk-rr-detail">
        <thead>
          <tr>
            <th />
            <th>Type</th>
            <th>Date</th>
            <th>Num</th>
            <th>Name</th>
            <th>Clr</th>
            <th className="bk-num">Amount</th>
            <th className="bk-num">Balance</th>
          </tr>
        </thead>
        <tbody>
          {detailRows.map((r, i) => {
            if (r.kind === 'blank')
              return (
                <tr key={i} className="bk-rr-blank">
                  <td colSpan={8} />
                </tr>
              );
            if (r.line) {
              const l = r.line;
              return (
                <tr key={i} className="bk-rr-data bk-rr-click" onDoubleClick={() => l.txnId && l.type && openTxn(l.type, l.txnId)} title="Double-click to open the transaction">
                  <td style={{ width: 8 + r.level * 18 }} />
                  <td>{l.typeLabel}</td>
                  <td>{fmtDate(l.date)}</td>
                  <td>{l.num}</td>
                  <td>{l.name}</td>
                  <td>{l.clr}</td>
                  <td className="bk-num">{fmtMoney(l.amount)}</td>
                  <td className="bk-num">{fmtMoney(r.balance)}</td>
                </tr>
              );
            }
            const isTot = r.kind === 'total' || r.kind === 'grand';
            return (
              <tr key={i} className={`bk-rr-${r.kind}`}>
                <td colSpan={6} style={{ paddingLeft: 8 + r.level * 18 }}>
                  {r.label}
                </td>
                <td className={'bk-num' + (r.kind === 'subtotal' ? ' bk-rr-line' : '')}>{r.kind === 'section' || isTot ? '' : r.amount === undefined || r.amount === null ? '' : fmtMoney(r.amount)}</td>
                <td className={'bk-num' + (r.kind === 'subtotal' ? ' bk-rr-line' : '') + (r.kind === 'grand' ? ' bk-rr-dbl' : '')}>{isTot ? fmtMoney(r.amount) : r.balance !== undefined ? fmtMoney(r.balance) : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {changesBlock}
    </div>
  );

  return (
    <div className="bk-rr">
      <Toolbar aria-label="Reconciliation report">
        <SegmentedControl<ReconcileReportMode>
          size="sm"
          value={mode}
          onChange={setMode}
          aria-label="Report type"
          options={[
            { value: 'summary', label: 'Summary' },
            { value: 'detail', label: 'Detail' },
            { value: 'both', label: 'Both' },
          ]}
        />
        <ToolbarButton label="Print" icon={Printer} onClick={print} />
        <ToolbarButton label="Previous reports" icon={History} onClick={() => openWindow('reconcileReports', { accountId: rec.accountId })} />
        <ToolbarButton label="Open register" icon={Landmark} onClick={() => openRegister(rec.accountId, rec.accountName)} />
        <ToolbarSpacer />
      </Toolbar>
      <div className="bk-rr-scroll">
        {mode !== 'detail' && renderSummary()}
        {mode !== 'summary' && renderDetail()}
      </div>
    </div>
  );
}
