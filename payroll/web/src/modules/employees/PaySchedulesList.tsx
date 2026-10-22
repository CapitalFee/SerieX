// Pay Schedules (Lists > Pay Schedules, Payroll Center > Pay Schedules). Columns: schedule
// name, pay frequency, next pay period, next check date, employees. Bottom menus
// Pay Schedule ▾ / Activities ▾ and Include inactive, like the other list windows.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Plus } from 'lucide-react';
import { api } from '@/api/client';
import { usePaySchedules } from '@/api/hooks';
import { FREQUENCY_LABELS, type Id, type PaySchedule } from '@/api/types';
import { Button, Checkbox, DropdownButton, EmptyState, ListView, SearchBox, useHotkeys, type ListColumn, type MenuItem } from '@/components';
import { downloadCsv } from '@/util/csv';
import { fmtDate } from '@/util/format';
import { openWindow } from '@/windows/windowStore';
import { ListPage, deleteRecord, matchesSearch, plural, printList, setRecordActive, useCreatedListener, useLocalState, useRevealRow } from './shared';

export interface PaySchedulesListProps {}

export default function PaySchedulesList(_props: PaySchedulesListProps) {
  const { data, isLoading, error, refetch } = usePaySchedules({ active: 'all' });
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useLocalState('sxp.emp.schedules.inactive', false);
  const [selId, setSelId] = useState<Id | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);


  const all = data ?? [];
  const rows = useMemo(
    () => all.filter((s) => (showInactive || s.active) && matchesSearch(q, s.name, FREQUENCY_LABELS[s.frequency])),
    [all, showInactive, q],
  );
  const sel = rows.find((s) => s.id === selId) ?? null;
  const reveal = useRevealRow(rootRef, rows, (s) => s.id, (k) => setSelId(k as Id));
  useCreatedListener('pay_schedule', (d) => {
    setQ('');
    reveal.pick(d.id);
  });
  useEffect(() => {
    if (!sel && rows.length && !reveal.pending()) setSelId(rows[0].id);
  }, [sel, rows, reveal]);

  const newSchedule = () => openWindow('payScheduleEdit', {});
  const edit = (s: PaySchedule | null = sel) => s && openWindow('payScheduleEdit', { id: s.id });
  const del = (s: PaySchedule | null = sel) =>
    s &&
    deleteRecord({
      what: 'pay schedule',
      name: s.name,
      blocked: s.employeeCount > 0 ? `The pay schedule "${s.name}" is assigned to ${plural(s.employeeCount, 'active employee')}. Give them another schedule (or none) before deleting it, or make the schedule inactive.` : null,
      request: () => api.del(`/pay-schedules/${s.id}`),
      makeInactive: () => api.put(`/pay-schedules/${s.id}`, { ...s, active: false }),
    });
  const toggleActive = (s: PaySchedule | null = sel) => s && setRecordActive(s.name, !s.active, () => api.put(`/pay-schedules/${s.id}`, { ...s, active: !s.active }));
  const start = (s: PaySchedule | null = sel) => s && openWindow('payEmployees', { kind: 'scheduled', scheduleId: s.id });

  useHotkeys({
    'ctrl+e': () => (sel ? void edit() : false),
    'ctrl+d': () => (sel ? void del() : false),
    'ctrl+n': () => newSchedule(),
  });

  const print = () =>
    printList(
      'Pay Schedules',
      [{ label: 'Schedule' }, { label: 'Pay Frequency' }, { label: 'Next Pay Period' }, { label: 'Next Check Date' }, { label: 'Employees', align: 'right' }],
      rows.map((s) => ({
        cells: [s.name, FREQUENCY_LABELS[s.frequency], `${fmtDate(s.nextPeriodStart)} - ${fmtDate(s.nextPeriodEnd)}`, fmtDate(s.nextCheckDate), String(s.employeeCount)],
        inactive: !s.active,
      })),
    );

  const scheduleMenu: MenuItem[] = [
    { label: '&New', shortcut: 'Ctrl+N', onClick: newSchedule },
    { label: '&Edit Pay Schedule', shortcut: 'Ctrl+E', disabled: !sel, onClick: () => edit() },
    { label: '&Delete Pay Schedule', shortcut: 'Ctrl+D', disabled: !sel, onClick: () => void del() },
    { label: sel && !sel.active ? 'Make Pay Schedule &Active' : 'Make Pay Schedule &Inactive', disabled: !sel, onClick: () => void toggleActive() },
    { separator: true },
    { label: 'Show Inacti&ve Schedules', checked: showInactive, onClick: () => setShowInactive(!showInactive) },
    { label: '&Print List...', onClick: () => void print() },
    {
      label: 'E&xport to CSV',
      onClick: () =>
        downloadCsv('pay-schedules', [
          ['Schedule', 'Pay Frequency', 'Next Period Start', 'Next Period End', 'Next Check Date', 'Employees', 'Active'],
          ...rows.map((s) => [s.name, FREQUENCY_LABELS[s.frequency], s.nextPeriodStart, s.nextPeriodEnd, s.nextCheckDate, s.employeeCount, s.active ? 'Yes' : 'No']),
        ]),
    },
  ];
  const activitiesMenu: MenuItem[] = [
    { label: '&Start Payroll', disabled: !sel || !sel.active, onClick: () => start() },
    { label: 'E&xtra Paycheck...', onClick: () => openWindow('payEmployees', { kind: 'unscheduled' }) },
    { separator: true },
    { label: '&Payroll Center', onClick: () => openWindow('employeeCenter', { tab: 'payroll' }) },
    { label: '&Employee Defaults...', onClick: () => openWindow('employeeDefaults') },
  ];
  const rowMenu = (s: PaySchedule | null): MenuItem[] =>
    s
      ? [
          { label: '&Edit Pay Schedule', shortcut: 'Ctrl+E', onClick: () => edit(s) },
          { label: '&Start Payroll', disabled: !s.active, onClick: () => start(s) },
          { separator: true },
          { label: '&New', onClick: newSchedule },
          { label: '&Delete Pay Schedule', onClick: () => void del(s) },
          { label: s.active ? 'Make &Inactive' : 'Make &Active', onClick: () => void toggleActive(s) },
        ]
      : [{ label: '&New', onClick: newSchedule }];

  const columns: ListColumn<PaySchedule>[] = [
    { key: 'name', label: 'Schedule name', width: 170, grow: true },
    { key: 'frequency', label: 'Pay frequency', width: 120, render: (s) => FREQUENCY_LABELS[s.frequency] ?? s.frequency },
    { key: 'nextPeriodEnd', label: 'Next pay period', width: 180, sortValue: (s) => s.nextPeriodEnd, render: (s) => `${fmtDate(s.nextPeriodStart)} - ${fmtDate(s.nextPeriodEnd)}` },
    { key: 'nextCheckDate', label: 'Next check date', width: 120, type: 'date' },
    { key: 'employeeCount', label: 'Employees', width: 90, type: 'number' },
  ];

  const empty = !isLoading && !error && data && all.length === 0;
  const total = showInactive ? all.length : all.filter((s) => s.active).length;

  return (
    <ListPage
      rootRef={rootRef}
      toolbar={<SearchBox value={q} onChange={setQ} placeholder="Search schedules" aria-label="Search pay schedules" />}
      actions={<Button variant="primary" icon={Plus} label="New schedule" onClick={newSchedule} />}
      footer={
        <>
          <DropdownButton label="Pay &Schedule" items={scheduleMenu} up />
          <DropdownButton label="Ac&tivities" items={activitiesMenu} up />
          <Checkbox checked={showInactive} onChange={setShowInactive} label="Include inactive" style={{ marginLeft: 8 }} />
        </>
      }
      status={data ? (rows.length === total ? plural(total, 'schedule') : `${rows.length} of ${plural(total, 'schedule')}`) : undefined}
    >
      {error ? (
        <div className="sxp-emp-emptywrap">
          <EmptyState icon={CalendarClock} title="The pay schedules could not be loaded" message={(error as Error).message} action={{ label: 'Try again', onClick: () => void refetch() }} />
        </div>
      ) : empty ? (
        <div className="sxp-emp-emptywrap">
          <EmptyState
            icon={CalendarClock}
            title="No pay schedules yet"
            message="A pay schedule pays a group of employees on the same days (for example every other Friday). Its payrolls then show up in the Payroll Center when they are due."
            action={{ label: 'Add a pay schedule', onClick: newSchedule, icon: Plus }}
          />
        </div>
      ) : (
        <ListView<PaySchedule>
          className="sxp-emp-list"
          aria-label="Pay schedules"
          columns={columns}
          rows={rows}
          loading={isLoading}
          selectedKey={sel?.id ?? null}
          onSelect={(k) => setSelId(k as Id)}
          onActivate={(s) => edit(s)}
          contextMenu={rowMenu}
          isInactive={(s) => !s.active}
          showInactiveColumn={showInactive}
          persistKey="emp-schedules"
          autoFocus
          emptyText="No pay schedules match your search."
        />
      )}
    </ListPage>
  );
}
