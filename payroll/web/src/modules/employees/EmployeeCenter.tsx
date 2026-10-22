// Employee Center: left tabs Employees | Transactions | Payroll (the Payroll tab is the Payroll
// Center). Employees: View (Active / All / Released employees), find box, NAME list; right side
// the Employee Information card (name, masked SSN with Show for administrators, address,
// phone, email, hire date, pay schedule, rate, sick/vacation available, year-to-date pay) with
// report links and the Transactions / Notes tabs. Transactions: Paychecks, Tax Payments, Tax
// Balance Adjustments and Year-to-Date Entries lists. Toolbar: New Employee, Employee Settings ▾,
// Print ▾, Excel ▾, Word.
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Banknote, BookOpen, ClipboardList, Eye, FilePlus2, FileSpreadsheet, FileText, Landmark, Mail, Pencil, Phone, Printer, ReceiptText, Settings, SlidersHorizontal, UserPlus, Users } from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll, queryClient, useBooksStatus, useEmployeeSummary, useEmployees, useLiabilityAdjustments, useLiabilityPayments, useMeta, usePaychecks } from '@/api/hooks';
import { FREQUENCY_LABELS, type BooksAccount, type Employee, type Id, type LiabilityAdjustment, type LiabilityPayment, type PaycheckSummary, type SyncStatus } from '@/api/types';
import {
  Button,
  Card,
  DropdownButton,
  EmptyState,
  ListView,
  SearchBox,
  Select,
  Spinner,
  Splitter,
  StatusPill,
  Tabs,
  TextArea,
  Toolbar,
  ToolbarSpacer,
  alertBox,
  toast,
  useHotkeys,
  type ListColumn,
  type MenuItem,
} from '@/components';
import { startPayEmployees } from '@/shell/data';
import { useSession } from '@/state/session';
import { downloadCsv } from '@/util/csv';
import { resolvePreset, todayIso } from '@/util/dates';
import { fmtDate, fmtMoney } from '@/util/format';
import { escHtml, printHtml } from '@/util/print';
import { useWindow } from '@/windows/WindowContext';
import { openRecord, openWindow } from '@/windows/windowStore';
import { PayrollCenterLeft, PayrollCenterMain, payrollToolbarItems } from './PayrollCenter';
import {
  addressText,
  deleteRecord,
  employeeStatus,
  errMessage,
  fmtHours,
  matchesSearch,
  money$,
  openReport,
  payRateText,
  plural,
  printList,
  setRecordActive,
  shortBooksError,
  showError,
  syncEmployeeToBooks,
  useCreatedListener,
} from './shared';

export interface EmployeeCenterProps {
  /** Tab to show (payroll = Payroll Center). */
  tab?: 'employees' | 'transactions' | 'payroll';
  /** Employee to select. */
  selectId?: number;
  /** Employee list filter typed in the icon bar search box. */
  q?: string;
}

type CenterTab = 'employees' | 'transactions' | 'payroll';
type View = 'active' | 'all' | 'released';
type TxnType = 'paychecks' | 'liabilityChecks' | 'adjustments' | 'ytd';

const VIEWS: { value: View; label: string }[] = [
  { value: 'active', label: 'Active Employees' },
  { value: 'all', label: 'All Employees' },
  { value: 'released', label: 'Released Employees' },
];

const TXN_TYPES: { type: TxnType; label: string }[] = [
  { type: 'paychecks', label: 'Paychecks' },
  { type: 'liabilityChecks', label: 'Tax Payments' },
  { type: 'adjustments', label: 'Tax Balance Adjustments' },
  { type: 'ytd', label: 'Year-to-Date Entries' },
];

/** DATE choices (payroll uses calendar periods). */
const DATE_CHOICES = [
  { value: 'all', label: 'All' },
  { value: 'thisMonth', label: 'This Month' },
  { value: 'thisFiscalQuarter', label: 'This Calendar Quarter' },
  { value: 'thisFiscalYear', label: 'This Calendar Year' },
  { value: 'lastMonth', label: 'Last Month' },
  { value: 'lastFiscalQuarter', label: 'Last Calendar Quarter' },
  { value: 'lastFiscalYear', label: 'Last Calendar Year' },
];

function dateRange(key: string): { from?: string; to?: string } {
  if (key === 'all') return {};
  const r = resolvePreset(key, todayIso(), 1);
  return { from: r.from || undefined, to: r.to || undefined };
}
const dateLabel = (key: string) => DATE_CHOICES.find((d) => d.value === key)?.label ?? key;

/** SerieX Books posting state of a record as a pill. */
function SyncPill({ status, voided, error }: { status: SyncStatus; voided?: boolean; error?: string }) {
  if (voided) return <StatusPill status="Void" />;
  switch (status) {
    case 'posted':
      return <StatusPill status="Posted" tone="success" />;
    case 'pending':
      return <StatusPill status="Pending" />;
    case 'error':
      return (
        <span title={error}>
          <StatusPill status="Error" />
        </span>
      );
    default:
      return <span className="sxp-emp-dim">Not posted</span>;
  }
}

/** SerieX Books posting state in words (exports). */
const SYNC_WORDS: Record<SyncStatus, string> = { posted: 'Posted', pending: 'Pending', error: 'Error', none: 'Not posted' };

const adjAmount = (a: LiabilityAdjustment) => Math.round(a.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;

export default function EmployeeCenter(props: EmployeeCenterProps) {
  const win = useWindow();
  const tab: CenterTab = props.tab ?? 'employees';
  const setTab = (k: CenterTab) => openWindow('employeeCenter', { tab: k });
  const today = todayIso();
  const isAdmin = useSession((s) => s.isAdmin);
  const [view, setView] = useState<View>('active');
  const [search, setSearch] = useState(props.q ?? '');
  const [selId, setSelId] = useState<Id | null>(props.selectId ?? null);
  const [txnType, setTxnType] = useState<TxnType>('paychecks');
  const employees = useEmployees({ active: 'all' });
  const all = employees.data ?? [];

  // follow props.selectId / props.q (the center is a singleton window): the employee to select
  // is shown even when the find box or the View filter would hide it
  // (a just-created employee is announced before the list is refetched: wait for it a moment)
  const [reveal, setReveal] = useState<{ id: Id; at: number } | null>(props.selectId ? { id: props.selectId, at: Date.now() } : null);
  useEffect(() => {
    if (!props.selectId) return;
    setSelId(props.selectId);
    setReveal({ id: props.selectId, at: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.selectId]);
  useEffect(() => {
    if (!reveal || !employees.data) return;
    const e = all.find((x) => x.id === reveal.id);
    if (!e && Date.now() - reveal.at < 5000) return;
    setReveal(null);
    if (!e) return;
    setSelId(e.id);
    if (search && !matchesSearch(search, e.displayName, e.firstName, e.lastName, e.employeeNumber, e.phone, e.mobile, e.email)) setSearch('');
    if ((view === 'active' && !e.active) || (view === 'released' && !e.releaseDate)) setView('all');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, employees.data]);
  useEffect(() => {
    if (props.q !== undefined) setSearch(props.q);
  }, [props.q]);
  useCreatedListener('employee', (d) => {
    setSelId(d.id);
    setReveal({ id: d.id, at: Date.now() });
  });

  const rows = useMemo(() => {
    let list = all;
    if (view === 'active') list = list.filter((e) => e.active);
    else if (view === 'released') list = list.filter((e) => !!e.releaseDate);
    const q = search.trim();
    if (q) list = list.filter((e) => matchesSearch(q, e.displayName, e.firstName, e.lastName, e.employeeNumber, e.phone, e.mobile, e.email));
    return list;
  }, [all, view, search]);
  const selected = (selId ? all.find((e) => e.id === selId) : null) ?? null;
  useEffect(() => {
    if (tab !== 'employees' || reveal) return;
    if (selId && rows.some((r) => r.id === selId)) return;
    if (rows.length) setSelId(rows[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, tab, reveal]);

  // window title: Employee Center: <name> / Payroll Center
  useEffect(() => {
    if (tab === 'payroll') win.setTitle('Payroll Center');
    else if (tab === 'transactions') win.setTitle('Employee Center: Transactions');
    else win.setTitle(selected ? `Employee Center: ${selected.displayName}` : 'Employee Center');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, selected?.displayName]);

  // ---- actions
  const newEmployee = () => openWindow('employeeEdit', {});
  const edit = (e: Employee | null = selected, section?: string) => e && openWindow('employeeEdit', section ? { id: e.id, section } : { id: e.id });
  const toggleActive = (e: Employee | null = selected) => e && setRecordActive(e.displayName, !e.active, () => api.put(`/employees/${e.id}/active`, { active: !e.active }));
  const remove = (e: Employee | null = selected) =>
    e &&
    deleteRecord({
      what: 'employee',
      name: e.displayName,
      blocked: e.hasPaychecks ? `${e.displayName} has paychecks, so the employee cannot be deleted (the payroll history would be lost).\n\nMake the employee inactive instead? Inactive employees keep their history but are hidden from lists and payroll.` : null,
      request: async () => {
        await api.del(`/employees/${e.id}`);
        // drop the deleted employee at once so nothing asks the server for it again
        queryClient.setQueriesData<Employee[]>({ queryKey: ['employees'] }, (old) => old?.filter((x) => x.id !== e.id));
        queryClient.removeQueries({ queryKey: ['employee-summary', e.id] });
        setSelId(null);
      },
      makeInactive: () => api.put(`/employees/${e.id}/active`, { active: false }),
    });
  const payOne = (e: Employee | null = selected) => e && openWindow('payEmployees', { kind: 'unscheduled', employeeIds: [e.id] });
  const quickReport = (e: Employee | null = selected) =>
    e && openReport('payroll_transactions_by_payee', { employeeId: String(e.id), dates: 'thisFiscalYear' }, `Employee Activity: ${e.displayName}`);

  useHotkeys({
    'ctrl+e': () => (tab === 'employees' && selected ? void edit() : false),
    'ctrl+q': () => (tab === 'employees' && selected ? void quickReport() : false),
  });

  const rowMenu = (e: Employee | null): MenuItem[] => {
    if (!e) return [{ label: '&New Employee…', onClick: newEmployee }];
    return [
      { label: '&Edit Employee', shortcut: 'Ctrl+E', onClick: () => edit(e) },
      { label: '&New Employee…', onClick: newEmployee },
      { label: e.active ? 'Make Employee &Inactive' : 'Make Employee &Active', onClick: () => void toggleActive(e) },
      { label: '&Delete Employee', onClick: () => void remove(e) },
      { separator: true },
      { label: '&Pay This Employee…', disabled: !e.active, onClick: () => payOne(e) },
      { label: '&Final Paycheck…', disabled: !e.active, onClick: () => openWindow('payEmployees', { kind: 'termination', employeeIds: [e.id] }) },
      { label: '&Year-to-Date Amounts…', onClick: () => openWindow('ytdSetup', { employeeId: e.id }) },
      { separator: true },
      { label: 'Ac&tivity Report', shortcut: 'Ctrl+Q', onClick: () => quickReport(e) },
    ];
  };

  // ---- print / export
  const statusText = (e: Employee) => employeeStatus(e, today) || 'Active';
  const printEmployees = () =>
    printList(
      'Employee List',
      [{ label: 'Employee' }, { label: 'SSN' }, { label: 'Phone' }, { label: 'Email' }, { label: 'Hire Date' }, { label: 'Pay Schedule' }, { label: 'Status' }],
      rows.map((e) => ({ cells: [e.displayName, e.ssn, e.phone || e.mobile, e.email, fmtDate(e.hireDate), e.payScheduleName || FREQUENCY_LABELS[e.payFrequency] || '', statusText(e)], inactive: !e.active })),
    );
  const printInfo = () => {
    const e = selected;
    if (!e) return;
    const r = (k: string, v: string) => (v ? `<tr><td class="bold">${escHtml(k)}</td><td>${escHtml(v).replace(/\n/g, '<br>')}</td></tr>` : '');
    void printHtml(
      `Employee ${e.displayName}`,
      `<h1>${escHtml(e.displayName)}</h1><table style="width:auto"><tbody>` +
        r('Legal name', [e.firstName, e.middleName, e.lastName, e.suffix].filter(Boolean).join(' ')) +
        r('Social security no.', e.ssn) +
        r('Address', addressText(e.address)) +
        r('Phone', e.phone) +
        r('Mobile', e.mobile) +
        r('Email', e.email) +
        r('Employee ID', e.employeeNumber) +
        r('Hire date', fmtDate(e.hireDate)) +
        r('Release date', fmtDate(e.releaseDate)) +
        r('Pay schedule', e.payScheduleName || FREQUENCY_LABELS[e.payFrequency]) +
        r('Pay rate', payRateText(e)) +
        r('Work state', e.workState) +
        r('Status', statusText(e)) +
        `</tbody></table>`,
    );
  };
  const loadTxns = async (e: Employee) => api.get<PaycheckSummary[]>(`/paychecks?employeeId=${e.id}&includeVoided=1`);
  const printTxns = async () => {
    const e = selected;
    if (!e) return;
    try {
      const list = await loadTxns(e);
      void printHtml(
        `Transactions - ${e.displayName}`,
        `<h1>${escHtml(e.displayName)}</h1><h2>Employee Transaction List</h2><table><thead><tr><th>Type</th><th>Num</th><th>Date</th><th>Pay Period</th><th class="num">Gross</th><th class="num">Net</th></tr></thead><tbody>${list
          .map(
            (p) =>
              `<tr><td>${p.kind === 'ytd' ? 'Year-to-Date Entry' : 'Paycheck'}${p.voided ? ' (void)' : ''}</td><td>${escHtml(p.checkNumber)}</td><td>${fmtDate(p.checkDate)}</td><td>${fmtDate(p.periodStart)} - ${fmtDate(p.periodEnd)}</td><td class="num">${fmtMoney(p.gross)}</td><td class="num">${fmtMoney(p.net)}</td></tr>`,
          )
          .join('')}</tbody></table>`,
      );
    } catch (err) {
      await showError(err);
    }
  };
  const exportEmployees = () =>
    downloadCsv('Employee List', [
      ['Employee', 'First Name', 'Middle', 'Last Name', 'SSN', 'Address', 'City', 'State', 'ZIP', 'Phone', 'Mobile', 'Email', 'Employee ID', 'Hire Date', 'Release Date', 'Pay Schedule', 'Pay Frequency', 'Hourly Rate', 'Annual Salary', 'Work State', 'Status'],
      ...rows.map((e) => [
        e.displayName,
        e.firstName,
        e.middleName,
        e.lastName,
        e.ssn,
        [e.address.line1, e.address.line2].filter(Boolean).join(', '),
        e.address.city,
        e.address.state,
        e.address.zip,
        e.phone,
        e.mobile,
        e.email,
        e.employeeNumber,
        e.hireDate,
        e.releaseDate,
        e.payScheduleName,
        FREQUENCY_LABELS[e.payFrequency] ?? e.payFrequency,
        e.hourlyRate || '',
        e.annualSalary || '',
        e.workState,
        statusText(e),
      ]),
    ]);
  const exportTxns = async () => {
    const e = selected;
    if (!e) return;
    try {
      const list = await loadTxns(e);
      downloadCsv(`${e.displayName} transactions`, [
        ['Type', 'Num', 'Date', 'Period Start', 'Period End', 'Gross', 'Taxes', 'Deductions', 'Net', 'Voided', 'SerieX Books'],
        ...list.map((p) => [p.kind === 'ytd' ? 'Year-to-Date Entry' : 'Paycheck', p.checkNumber, p.checkDate, p.periodStart, p.periodEnd, p.gross, p.employeeTaxes, p.deductions, p.net, p.voided ? 'Yes' : 'No', SYNC_WORDS[p.syncStatus] ?? p.syncStatus]),
      ]);
    } catch (err) {
      await showError(err);
    }
  };

  const nameColumns: ListColumn<Employee>[] = [
    {
      key: 'displayName',
      label: 'Name',
      width: 150,
      grow: true,
      render: (e) => {
        const s = employeeStatus(e, today);
        return (
          <span className="sxp-emp-namecell">
            <span>{e.displayName}</span>
            {s && <span className="sxp-emp-tag">{s}</span>}
            {e.booksSyncError && (
              <span className="sxp-emp-syncwarn" role="img" aria-label="SerieX Books problem" title={`SerieX Books: ${shortBooksError(e.booksSyncError)}`}>
                <AlertTriangle size={13} aria-hidden="true" />
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: 'act',
      label: '',
      width: 30,
      sortable: false,
      render: (e) =>
        e.active ? (
          <button
            type="button"
            className="sxp-emp-rowicon"
            title={`Pay ${e.displayName} (extra paycheck)`}
            aria-label={`Pay ${e.displayName}`}
            onMouseDown={(ev) => ev.stopPropagation()}
            onClick={() => payOne(e)}
          >
            <Banknote size={14} aria-hidden="true" />
          </button>
        ) : null,
    },
  ];

  const toolbar =
    tab === 'payroll' ? (
      <Toolbar aria-label="Payroll Center">
        {payrollToolbarItems().map((b) => (
          <Button key={b.label} variant="ghost" icon={b.icon} label={b.label} onClick={b.onClick} />
        ))}
        <Button variant="ghost" icon={Settings} label="Preferences" onClick={() => openWindow('preferences', {})} />
        <ToolbarSpacer />
        <Button variant="primary" icon={Banknote} label="Pay employees" onClick={() => openWindow('payEmployees', { kind: 'unscheduled' })} />
        <Button variant="secondary" icon={Landmark} label="Pay payroll taxes" onClick={() => openWindow('payLiabilities')} />
      </Toolbar>
    ) : (
      <Toolbar aria-label="Employee Center">
        <Button variant="ghost" icon={UserPlus} label="New Employee…" onClick={newEmployee} />
        <DropdownButton
          flat
          label="Employee Settings"
          icon={SlidersHorizontal}
          items={[
            { label: 'Defaults for &New Employees…', onClick: () => openWindow('employeeDefaults') },
            { separator: true },
            { label: '&Edit Employee', shortcut: 'Ctrl+E', disabled: !selected, onClick: () => edit() },
            { label: selected && !selected.active ? 'Make Employee &Active' : 'Make Employee &Inactive', disabled: !selected, onClick: () => void toggleActive() },
            { label: '&Delete Employee', disabled: !selected, onClick: () => void remove() },
            { separator: true },
            { label: 'Payroll &Items', onClick: () => openWindow('payrollItemList') },
            { label: 'Pay &Schedules', onClick: () => openWindow('paySchedules') },
          ]}
        />
        <DropdownButton
          flat
          label="Print"
          icon={Printer}
          items={[
            { label: 'Employee &List', onClick: () => void printEmployees() },
            { label: 'Employee &Information', disabled: !selected, onClick: printInfo },
            { label: 'Employee &Transaction List', disabled: !selected, onClick: () => void printTxns() },
            { separator: true },
            { label: '&Paychecks…', onClick: () => openWindow('printPaychecks', {}) },
            { label: 'Pay &Stubs…', onClick: () => openWindow('printPayStubs', {}) },
          ]}
        />
        <DropdownButton
          flat
          label="Excel"
          icon={FileSpreadsheet}
          items={[
            { label: '&Export Employee List', onClick: exportEmployees },
            { label: 'Export &Transactions', disabled: !selected, onClick: () => void exportTxns() },
          ]}
        />
        <Button variant="ghost" icon={FileText} label="Word" disabled title="Employee letters are not available in SerieX Payroll" />
        <ToolbarSpacer />
        <Button variant="primary" icon={Banknote} label="Pay employees" onClick={startPayEmployees} />
        <Button variant="secondary" icon={Landmark} label="Pay payroll taxes" onClick={() => openWindow('payLiabilities')} />
      </Toolbar>
    );

  return (
    <div className="sxp-emp-center">
      {toolbar}
      <Splitter initial={290} min={230} minSecond={480} persistKey="emp-center">
        <div className="sxp-emp-left">
          <Tabs
            variant="strip"
            fill
            active={tab}
            onChange={(k) => setTab(k as CenterTab)}
            tabs={[
              { key: 'employees', label: 'Employees' },
              { key: 'transactions', label: 'Transactions' },
              { key: 'payroll', label: 'Payroll' },
            ]}
          >
            {tab === 'employees' ? (
              <div className="sxp-emp-leftbody">
                <div className="sxp-emp-filters">
                  <Select value={view} options={VIEWS} onChange={(v) => setView(v as View)} aria-label="View" />
                  <SearchBox value={search} onChange={setSearch} placeholder="Find an employee" debounce={150} />
                </div>
                <div className="sxp-emp-listwrap">
                  {employees.isLoading ? (
                    <Spinner center label="Loading employees..." />
                  ) : all.length === 0 ? (
                    <EmptyState icon={Users} title="No employees yet" message="Add the people you pay. Their pay rates, taxes and deductions fill in every paycheck." action={{ label: 'Add employee', onClick: newEmployee }} />
                  ) : (
                    <ListView<Employee>
                      aria-label="Employees"
                      columns={nameColumns}
                      rows={rows}
                      selectedKey={selId}
                      onSelect={(k) => setSelId(k as Id)}
                      onActivate={(e) => edit(e)}
                      contextMenu={rowMenu}
                      isInactive={(e) => !e.active}
                      showInactiveColumn={view !== 'active'}
                      persistKey="emp-names"
                      emptyText={<div className="sxp-emp-empty-small">No employees match these filters.</div>}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Delete' && selected) {
                          ev.preventDefault();
                          void remove();
                        }
                      }}
                    />
                  )}
                </div>
                <div className="sxp-emp-leftfoot">{plural(rows.length, 'employee')}</div>
              </div>
            ) : tab === 'transactions' ? (
              <div className="sxp-emp-typelist" role="listbox" aria-label="Transaction types">
                {TXN_TYPES.map((t) => (
                  <button key={t.type} type="button" role="option" aria-selected={txnType === t.type} className={'sxp-emp-typeitem' + (txnType === t.type ? ' sxp-on' : '')} onClick={() => setTxnType(t.type)}>
                    {t.label}
                  </button>
                ))}
              </div>
            ) : (
              <PayrollCenterLeft />
            )}
          </Tabs>
        </div>
        <div className="sxp-emp-right">
          {tab === 'payroll' ? (
            <PayrollCenterMain />
          ) : tab === 'transactions' ? (
            <TypeTransactions type={txnType} />
          ) : selected ? (
            <EmployeeDetail key={selected.id} e={selected} isAdmin={isAdmin} rowMenu={rowMenu} onEdit={(section) => edit(selected, section)} onQuickReport={() => quickReport()} />
          ) : (
            <EmptyState icon={Users} title="Select an employee" message="Choose an employee on the left to see their information and paychecks." />
          )}
        </div>
      </Splitter>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right pane: one employee

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  if (children === null || children === undefined || children === '' || children === false) return null;
  return (
    <div className="sxp-emp-info-row">
      <span className="sxp-emp-info-label">{label}</span>
      <span className="sxp-emp-info-value">{children}</span>
    </div>
  );
}

function EmployeeDetail({
  e,
  isAdmin,
  rowMenu,
  onEdit,
  onQuickReport,
}: {
  e: Employee;
  isAdmin: boolean;
  rowMenu: (e: Employee | null) => MenuItem[];
  onEdit: (section?: string) => void;
  onQuickReport: () => void;
}) {
  const today = todayIso();
  const sum = useEmployeeSummary(e.id).data;
  const meta = useMeta().data;
  const [tab, setTab] = useState<'txns' | 'notes'>('txns');
  const [ssn, setSsn] = useState<string | null>(null);
  const status = employeeStatus(e, today);
  const legal = [e.firstName, e.middleName, e.lastName, e.suffix].filter(Boolean).join(' ');
  const sick = sum?.sick ?? e.sick;
  const vac = sum?.vacation ?? e.vacation;
  const reveal = async () => {
    try {
      const r = await api.get<{ ssn: string }>(`/employees/${e.id}/ssn`);
      setSsn(r.ssn);
    } catch (err) {
      await showError(err);
    }
  };
  const stName = meta?.states.find((s) => s.code === e.workState)?.name ?? e.workState;
  const [syncing, setSyncing] = useState(false);
  const syncBooks = async () => {
    setSyncing(true);
    try {
      await syncEmployeeToBooks(e);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="sxp-emp-detail">
      <Card
        className="sxp-emp-infocard"
        title={
          <span className="sxp-emp-info-title">
            {e.displayName}
            {status && <StatusPill status={status} tone={status === 'Released' ? 'warning' : undefined} />}
          </span>
        }
        subtitle={[e.employmentType !== 'regular' ? e.employmentType[0].toUpperCase() + e.employmentType.slice(1) : '', e.employeeNumber ? `ID ${e.employeeNumber}` : ''].filter(Boolean).join(' · ') || undefined}
        actions={
          <>
            <Button small variant="ghost" icon={Pencil} label="Edit" onClick={() => onEdit()} title="Edit employee (Ctrl+E)" />
            <DropdownButton label="More" items={rowMenu(e)} alignEnd />
          </>
        }
      >
        <div className="sxp-emp-info">
          <div className="sxp-emp-info-col">
            <InfoRow label="Full name">{legal}</InfoRow>
            <InfoRow label="SSN">
              {e.ssn ? (
                <span className="sxp-emp-iconline">
                  {ssn ?? e.ssn}
                  {isAdmin && !ssn && e.ssnOnFile && (
                    <button type="button" className="sx-linkbtn" title="Show the full number (recorded in the audit trail)" onClick={() => void reveal()}>
                      <Eye size={12} aria-hidden="true" /> Show
                    </button>
                  )}
                </span>
              ) : (
                <span className="sxp-emp-dim">Not entered</span>
              )}
            </InfoRow>
            <InfoRow label="Address">{addressText(e.address) ? <span className="sxp-emp-pre">{addressText(e.address)}</span> : ''}</InfoRow>
            <InfoRow label="Main phone">
              {e.phone && (
                <span className="sxp-emp-iconline">
                  <Phone size={13} aria-hidden="true" />
                  {e.phone}
                </span>
              )}
            </InfoRow>
            <InfoRow label="Mobile">{e.mobile}</InfoRow>
            <InfoRow label="Main email">
              {e.email && (
                <a className="sxp-emp-iconline" href={`mailto:${e.email}`} title={e.email}>
                  <Mail size={13} aria-hidden="true" />
                  {e.email}
                </a>
              )}
            </InfoRow>
          </div>
          <div className="sxp-emp-info-col">
            <InfoRow label="Hire date">{fmtDate(e.hireDate)}</InfoRow>
            <InfoRow label="Release date">{fmtDate(e.releaseDate)}</InfoRow>
            <InfoRow label="Pay schedule">
              {e.payScheduleName
                ? e.payScheduleName === FREQUENCY_LABELS[e.payFrequency]
                  ? e.payScheduleName
                  : `${e.payScheduleName} (${FREQUENCY_LABELS[e.payFrequency]})`
                : `${FREQUENCY_LABELS[e.payFrequency] ?? e.payFrequency}, no schedule`}
            </InfoRow>
            <InfoRow label="Pay rate">{payRateText(e)}</InfoRow>
            <InfoRow label="Work state">{stName}</InfoRow>
            <InfoRow label="Paid by">{e.directDeposit.enabled ? `Direct deposit ${e.directDeposit.account}` : 'Check'}</InfoRow>
            <InfoRow label="Last paycheck">{e.lastCheckDate ? fmtDate(e.lastCheckDate) : ''}</InfoRow>
          </div>
          <div className="sxp-emp-info-side">
            <div className="sxp-emp-balbox">
              <span>Gross pay {today.slice(0, 4)}</span>
              <b>{money$(sum?.ytdGross ?? e.ytdGross)}</b>
              {sum && (
                <span className="sxp-emp-dim">
                  Net {money$(sum.ytdNet)} · Taxes {money$(sum.ytdTaxes)}
                </span>
              )}
            </div>
            <div className="sxp-emp-balbox">
              <span className="sxp-emp-ptoline">
                <span>Sick available</span>
                <b style={{ fontSize: 13 }}>{fmtHours(sick.available)} h</b>
              </span>
              <span className="sxp-emp-ptoline">
                <span>Vacation available</span>
                <b style={{ fontSize: 13 }}>{fmtHours(vac.available)} h</b>
              </span>
            </div>
          </div>
        </div>
        {(e.booksSyncError || !e.booksNameId) && (
          <div className="sxp-emp-notice sxp-warn" style={{ marginTop: 8 }}>
            <BookOpen size={15} aria-hidden="true" />
            <span>
              {e.booksSyncError
                ? e.booksNameId
                  ? `The SerieX Books name of this employee was not updated: ${shortBooksError(e.booksSyncError)}`
                  : `This employee could not be added to SerieX Books: ${shortBooksError(e.booksSyncError)}`
                : 'This employee is not in SerieX Books yet (SerieX Books was not reachable when the employee was saved). Paychecks add the name when they are posted.'}{' '}
              <button type="button" className="sx-linkbtn" disabled={syncing} onClick={() => void syncBooks()}>
                {syncing ? 'Updating…' : 'Update SerieX Books now'}
              </button>
            </span>
          </div>
        )}
        <div className="sxp-emp-reports">
          <span className="sxp-emp-caps">Reports for this employee</span>
          <button type="button" className="sx-linkbtn" onClick={onQuickReport}>
            Employee Activity
          </button>
          <button type="button" className="sx-linkbtn" onClick={() => openReport('payroll_summary', { employeeId: String(e.id), dates: 'thisFiscalYearToDate' }, `Payroll Summary: ${e.displayName}`)}>
            Payroll Summary
          </button>
          <button type="button" className="sx-linkbtn" onClick={() => openReport('paid_time_off_list', { employeeId: String(e.id) }, `Paid Time Off: ${e.displayName}`)}>
            Paid Time Off Report
          </button>
          <button type="button" className="sx-linkbtn" onClick={() => openReport('payroll_transaction_detail', { employeeId: String(e.id), dates: 'thisFiscalYearToDate' }, `Payroll Transaction Detail: ${e.displayName}`)}>
            Payroll Transaction Detail
          </button>
          <button type="button" className="sx-linkbtn" onClick={() => openReport('employee_withholding', { employeeId: String(e.id) }, `Employee Withholding: ${e.displayName}`)}>
            Employee Withholding
          </button>
          {!e.directDeposit.enabled && (
            <button type="button" className="sx-linkbtn" onClick={() => onEdit('directDeposit')}>
              Set up Direct Deposit
            </button>
          )}
        </div>
      </Card>
      <Tabs
        className="sxp-emp-detailtabs"
        fill
        active={tab}
        onChange={(k) => setTab(k as typeof tab)}
        tabs={[
          { key: 'txns', label: 'Transactions' },
          { key: 'notes', label: 'Notes' },
        ]}
      >
        {tab === 'txns' && <EmployeeTransactions e={e} />}
        {tab === 'notes' && <NotesTab e={e} />}
      </Tabs>
    </div>
  );
}

/** One line of the employee's transaction list. */
interface TxnRow {
  key: string;
  kind: 'paycheck' | 'ytd' | 'adjustment';
  id: number;
  type: string;
  num: string;
  date: string;
  account: string;
  amount: number;
  memo: string;
  voided: boolean;
  sync: SyncStatus;
  syncError: string;
}

const SHOW = [
  { value: 'all', label: 'All Transactions' },
  { value: 'paycheck', label: 'Paychecks' },
  { value: 'adjustment', label: 'Tax Balance Adjustments' },
  { value: 'ytd', label: 'Year-to-Date Entries' },
];

/**
 * Names of the SerieX Books accounts (same cache as useBooksAccounts()), asked only while SerieX
 * Books is reachable: the list shows no account names instead of failing requests when it is down.
 */
function useBankNames(): Map<Id, BooksAccount> {
  const reachable = useBooksStatus().data?.reachable === true;
  const { data } = useQuery({
    queryKey: ['books', 'accounts', null],
    queryFn: ({ signal }) => api.get<BooksAccount[]>('/books/accounts', { signal }),
    enabled: reachable,
  });
  return useMemo(() => new Map((data ?? []).map((a) => [a.id, a])), [data]);
}

function openTxn(r: TxnRow) {
  if (r.kind === 'paycheck') openRecord('paycheck', r.id);
  else if (r.kind === 'ytd') openWindow('paycheckDetail', { id: r.id });
  else openRecord('adjustment', r.id);
}

function EmployeeTransactions({ e }: { e: Employee }) {
  const [show, setShow] = useState('all');
  const [dates, setDates] = useState('thisFiscalYear');
  const range = dateRange(dates);
  const accounts = useBankNames();
  const pcs = usePaychecks({ employeeId: e.id, ...range, includeVoided: true }, { enabled: show !== 'adjustment' });
  const adjs = useLiabilityAdjustments(range);
  const [sel, setSel] = useState<string | null>(null);
  const rows = useMemo(() => {
    const out: TxnRow[] = [];
    if (show !== 'adjustment')
      for (const p of pcs.data ?? []) {
        if (p.employeeId !== e.id) continue;
        const kind = p.kind === 'ytd' ? 'ytd' : 'paycheck';
        if (show !== 'all' && show !== kind) continue;
        out.push({
          key: `p${p.id}`,
          kind,
          id: p.id,
          type: kind === 'ytd' ? 'Year-to-Date Entry' : 'Paycheck',
          num: p.checkNumber,
          date: p.checkDate,
          account: kind === 'ytd' ? '' : (p.bankAccountId ? accounts.get(p.bankAccountId)?.fullName ?? '' : ''),
          amount: kind === 'ytd' ? p.gross : p.net,
          memo: p.memo,
          voided: p.voided,
          sync: p.syncStatus,
          syncError: p.syncError,
        });
      }
    if (show === 'all' || show === 'adjustment')
      for (const a of adjs.data ?? []) {
        if (a.employeeId !== e.id) continue;
        out.push({ key: `a${a.id}`, kind: 'adjustment', id: a.id, type: 'Tax Balance Adjustment', num: '', date: a.date, account: '', amount: adjAmount(a), memo: a.memo, voided: false, sync: a.syncStatus, syncError: a.syncError });
      }
    return out.sort((a, b) => b.date.localeCompare(a.date) || b.key.localeCompare(a.key));
  }, [pcs.data, adjs.data, show, e.id, accounts]);
  const r = resolvePreset(dates, todayIso(), 1);
  const columns: ListColumn<TxnRow>[] = [
    { key: 'type', label: 'Transaction type', width: 140 },
    { key: 'num', label: 'Num', width: 70, sortValue: (x) => (/^\d+$/.test(x.num) ? Number(x.num) : x.num) },
    { key: 'date', label: 'Date', width: 92, type: 'date' },
    { key: 'account', label: 'Account', width: 130, grow: true },
    { key: 'amount', label: 'Amount', width: 100, type: 'money' },
    { key: 'sync', label: 'SerieX Books', width: 110, sortable: false, render: (x) => <SyncPill status={x.sync} voided={x.voided} error={x.syncError} /> },
  ];
  const label = SHOW.find((s) => s.value === show)?.label ?? show;
  return (
    <div className="sxp-emp-txns">
      <div className="sxp-emp-txnfilters">
        <label className="sxp-emp-flabel">
          SHOW
          <Select value={show} options={SHOW} onChange={setShow} aria-label="Show" />
        </label>
        <label className="sxp-emp-flabel">
          DATE
          <Select value={dates} options={DATE_CHOICES} onChange={setDates} aria-label="Date" />
        </label>
        {dates !== 'all' && (
          <span className="sxp-emp-range">
            {fmtDate(r.from)} - {fmtDate(r.to)}
          </span>
        )}
        <span className="sxp-emp-txncount">{plural(rows.length, 'transaction')}</span>
      </div>
      <ListView<TxnRow>
        aria-label="Employee transactions"
        className="sxp-emp-txnlist"
        columns={columns}
        rows={rows}
        getKey={(x) => x.key}
        loading={pcs.isLoading || adjs.isLoading}
        selectedKey={sel}
        onSelect={(k) => setSel(k as string)}
        onActivate={openTxn}
        rowClassName={(x) => (x.voided ? 'sxp-emp-voidrow' : undefined)}
        contextMenu={(x) =>
          x
            ? [
                { label: '&Open', onClick: () => openTxn(x) },
                { label: '&Paycheck Details…', hidden: x.kind === 'adjustment', onClick: () => openWindow('paycheckDetail', { id: x.id }) },
                { label: 'Print Pay &Stub…', hidden: x.kind !== 'paycheck', onClick: () => openWindow('printPayStubs', { ids: [x.id] }) },
                { label: 'Find and &Edit Paychecks…', hidden: x.kind !== 'paycheck', onClick: () => openWindow('editVoidPaychecks', { q: e.displayName }) },
              ]
            : []
        }
        persistKey="emp-txns"
        emptyText={
          <EmptyState
            compact
            icon={ReceiptText}
            title="No transactions"
            message={`There are no transactions of type "${label}" in date range "${dateLabel(dates)}".`}
            action={e.active ? { label: 'Pay this employee', onClick: () => openWindow('payEmployees', { kind: 'unscheduled', employeeIds: [e.id] }) } : undefined}
          />
        }
      />
    </div>
  );
}

function NotesTab({ e }: { e: Employee }) {
  const [text, setText] = useState(e.notes);
  const [busy, setBusy] = useState(false);
  const dirty = text !== e.notes;
  const save = async () => {
    setBusy(true);
    try {
      const fresh = await api.get<Employee>(`/employees/${e.id}`);
      await api.put<Employee>(`/employees/${e.id}`, { ...fresh, notes: text });
      await invalidateAll();
      toast('Notes saved', { kind: 'success' });
    } catch (err) {
      const m = errMessage(err);
      if (m) await alertBox(m, 'Warning');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sxp-emp-pad sxp-emp-notes">
      <TextArea value={text} onChange={setText} aria-label="Notes" placeholder="Notes about this employee (not printed on paychecks)." />
      <div className="sxp-emp-inline">
        <Button variant="primary" label="Save notes" onClick={() => void save()} disabled={!dirty} busy={busy} />
        {dirty && <Button variant="ghost" label="Discard" onClick={() => setText(e.notes)} />}
        <span className="sxp-emp-note">{dirty ? 'Unsaved changes' : ''}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right pane: all transactions of one type (Transactions tab)

interface AnyRow {
  key: string;
  id: number;
  date: string;
  num: string;
  name: string;
  period: string;
  memo: string;
  method: string;
  amount: number;
  gross: number;
  voided: boolean;
  sync: SyncStatus;
  syncError: string;
  open: () => void;
}

function TypeTransactions({ type }: { type: TxnType }) {
  const [dates, setDates] = useState('thisFiscalYear');
  const [search, setSearch] = useState('');
  const range = dateRange(dates);
  const pcs = usePaychecks({ ...range, kind: type === 'ytd' ? 'ytd' : 'regular', includeVoided: true }, { enabled: type === 'paychecks' || type === 'ytd' });
  const pays = useLiabilityPayments(range);
  const adjs = useLiabilityAdjustments(range);
  const [sel, setSel] = useState<string | null>(null);
  const label = TXN_TYPES.find((t) => t.type === type)?.label ?? '';

  const rows = useMemo<AnyRow[]>(() => {
    let out: AnyRow[] = [];
    if (type === 'paychecks' || type === 'ytd') {
      out = (pcs.data ?? []).map((p: PaycheckSummary) => ({
        key: `p${p.id}`,
        id: p.id,
        date: p.checkDate,
        num: p.checkNumber,
        name: p.employeeName,
        period: `${fmtDate(p.periodStart)} - ${fmtDate(p.periodEnd)}`,
        memo: p.memo,
        method: p.directDeposit ? 'Direct deposit' : p.toBePrinted ? 'To print' : 'Check',
        amount: p.net,
        gross: p.gross,
        voided: p.voided,
        sync: p.syncStatus,
        syncError: p.syncError,
        open: () => (type === 'ytd' ? openWindow('paycheckDetail', { id: p.id }) : openRecord('paycheck', p.id)),
      }));
    } else if (type === 'liabilityChecks') {
      out = (pays.data ?? []).map((p: LiabilityPayment) => ({
        key: `l${p.id}`,
        id: p.id,
        date: p.date,
        num: p.checkNumber,
        name: p.agencyName,
        period: `${fmtDate(p.periodStart)} - ${fmtDate(p.periodEnd)}`,
        memo: p.memo,
        method: p.kind === 'prior' ? 'Earlier payment' : p.method === 'e-pay' ? 'E-pay' : 'Check',
        amount: p.amount,
        gross: 0,
        voided: p.voided,
        sync: p.syncStatus,
        syncError: p.syncError,
        open: () => openRecord('liability_payment', p.id),
      }));
    } else {
      out = (adjs.data ?? []).map((a: LiabilityAdjustment) => ({
        key: `a${a.id}`,
        id: a.id,
        date: a.date,
        num: '',
        name: a.employeeName || 'Company',
        period: fmtDate(a.effectiveDate),
        memo: a.memo,
        method: a.affectsAccounts ? 'Changes accounts' : 'Payroll only',
        amount: adjAmount(a),
        gross: 0,
        voided: false,
        sync: a.syncStatus,
        syncError: a.syncError,
        open: () => openRecord('adjustment', a.id),
      }));
    }
    const q = search.trim();
    if (q) out = out.filter((r) => matchesSearch(q, r.num, r.name, r.memo, fmtMoney(r.amount)));
    return out.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  }, [type, pcs.data, pays.data, adjs.data, search]);

  const total = rows.filter((r) => !r.voided).reduce((s, r) => s + r.amount, 0);
  const cols: ListColumn<AnyRow>[] = [
    { key: 'date', label: 'Date', width: 88, type: 'date' },
    ...(type === 'ytd' ? [] : [{ key: 'num', label: 'Num', width: 64, sortValue: (x: AnyRow) => (/^\d+$/.test(x.num) ? Number(x.num) : x.num) } as ListColumn<AnyRow>]),
    { key: 'name', label: type === 'liabilityChecks' ? 'Payee' : type === 'adjustments' ? 'Name' : 'Employee', width: 132 },
    { key: 'period', label: type === 'adjustments' ? 'Effective date' : 'Period', width: type === 'adjustments' ? 100 : 170 },
    ...(type === 'paychecks' || type === 'liabilityChecks' || type === 'adjustments' ? [{ key: 'method', label: type === 'adjustments' ? 'Accounts' : 'Method', width: 104 } as ListColumn<AnyRow>] : []),
    { key: 'memo', label: 'Memo', width: 70, grow: true, render: (x: AnyRow) => <span title={x.memo}>{x.memo}</span> },
    ...(type === 'ytd' ? [{ key: 'gross', label: 'Gross', width: 96, type: 'money' } as ListColumn<AnyRow>] : []),
    { key: 'amount', label: type === 'paychecks' || type === 'ytd' ? 'Net amount' : 'Amount', width: 108, type: 'money' },
    ...(type === 'ytd' ? [] : [{ key: 'sync', label: 'SerieX Books', width: 104, sortable: false, render: (x: AnyRow) => <SyncPill status={x.sync} voided={x.voided} error={x.syncError} /> } as ListColumn<AnyRow>]),
  ];
  const newOf: Record<TxnType, { label: string; run: () => void }> = {
    paychecks: { label: 'New paycheck', run: () => openWindow('payEmployees', { kind: 'unscheduled' }) },
    liabilityChecks: { label: 'New tax payment', run: () => openWindow('liabilityPayment', {}) },
    adjustments: { label: 'New adjustment', run: () => openWindow('adjustLiabilities', {}) },
    ytd: { label: 'Enter year-to-date amounts', run: () => openWindow('ytdSetup', {}) },
  };
  const loading = type === 'liabilityChecks' ? pays.isLoading : type === 'adjustments' ? adjs.isLoading : pcs.isLoading;
  const error = (type === 'liabilityChecks' ? pays.error : type === 'adjustments' ? adjs.error : pcs.error) as Error | null;
  return (
    <div className="sxp-emp-detail">
      <div className="sxp-emp-typehead">
        <h2>{label}</h2>
        <Button variant="primary" icon={type === 'ytd' ? ClipboardList : FilePlus2} label={newOf[type].label} onClick={newOf[type].run} />
      </div>
      <div className="sxp-emp-txnfilters">
        <label className="sxp-emp-flabel">
          DATE
          <Select value={dates} options={DATE_CHOICES} onChange={setDates} aria-label="Date" />
        </label>
        <SearchBox value={search} onChange={setSearch} placeholder="Search number, name or amount" debounce={250} width={230} />
        <span className="sxp-emp-txncount">
          {plural(rows.length, 'transaction')} · {money$(total)}
        </span>
      </div>
      {error && <div className="sxp-emp-notice sxp-warn">The list could not be loaded: {error.message}</div>}
      <ListView<AnyRow>
        aria-label={label}
        className="sxp-emp-txnlist"
        columns={cols}
        rows={rows}
        getKey={(x) => x.key}
        loading={loading}
        selectedKey={sel}
        onSelect={(k) => setSel(k as string)}
        onActivate={(x) => x.open()}
        rowClassName={(x) => (x.voided ? 'sxp-emp-voidrow' : undefined)}
        contextMenu={(x) => (x ? [{ label: '&Open', onClick: x.open }] : [])}
        persistKey={`emp-type-${type}`}
        emptyText={
          <EmptyState
            compact
            icon={ReceiptText}
            title="No transactions"
            message={search.trim() ? 'Nothing matches the search.' : `There are no transactions of type "${label}" in date range "${dateLabel(dates)}".`}
          />
        }
      />
    </div>
  );
}
