// Definitions shared by the left navigation, the "+ New" panel and the global search actions
// (same design as SerieX Books): grouped navigation, the grouped "+ New" panel and the command
// list of the search box, for payroll.
import {
  Banknote,
  BookOpen,
  Building2,
  CalendarClock,
  ChartColumn,
  ClipboardList,
  FileCheck2,
  FileText,
  Files,
  History,
  House,
  Landmark,
  ListChecks,
  ListTree,
  Printer,
  RefreshCw,
  Scale,
  Settings,
  SlidersHorizontal,
  Table2,
  Truck,
  UserMinus,
  UserPlus,
  Users,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react';
import type { PayrollCompany } from '@/api/types';
import { openWindow, type WinState } from '@/windows/windowStore';
import type { WindowKind } from '@/windows/kinds';
import { FAVORITE_REPORTS, reportTitle } from '@/state/catalog';
import { newBooksAccount, newBooksVendor } from '@/components/pickers';
import { openSerieXBooks } from './booksLink';
import { startPayEmployees } from './data';
import { formYear, lastQuarter } from './menus';

// ------------------------------------------------------------ navigation

export interface NavEntry {
  id: string;
  label: string;
  /** Window kinds that make this entry look selected when active. */
  kinds: WindowKind[];
  /** Extra test on the active window (e.g. which report or tab it shows). */
  match?: (w: WinState) => boolean;
  open(): void;
}

export interface NavGroup {
  id: string;
  label: string;
  icon: LucideIcon;
  entries: NavEntry[];
  /** Direct link (Home): the group has no entries. */
  open?: () => void;
  /** Kinds (besides the entries') that belong to the group: its icon is tinted when one is active. */
  kinds?: WindowKind[];
}

const win = (kind: WindowKind, props: Record<string, any> = {}, title?: string) => () => {
  openWindow(kind, props, title ? { title } : {});
};
const entry = (id: string, label: string, kind: WindowKind, extraKinds: WindowKind[] = [], props: Record<string, any> = {}): NavEntry => ({
  id,
  label,
  kinds: [kind, ...extraKinds],
  open: win(kind, props),
});
const reportEntry = (key: string): NavEntry => ({
  id: `r:${key}`,
  label: reportTitle(key) || key,
  kinds: ['report'],
  match: (w) => w.props.key === key,
  open: win('report', { key }),
});
const isPayrollTab = (w: WinState) => w.props?.tab === 'payroll';

/** Grouped left navigation. */
export function buildNav(): NavGroup[] {
  return [
    { id: 'home', label: 'Home', icon: House, entries: [], open: win('home'), kinds: ['home'] },
    {
      id: 'employees',
      label: 'Employees',
      icon: Users,
      kinds: ['employeeEdit', 'employeeDefaults'],
      entries: [
        { id: 'employeeCenter', label: 'Employee Center', kinds: ['employeeCenter'], match: (w) => !isPayrollTab(w), open: win('employeeCenter', { tab: 'employees' }) },
        { id: 'payrollCenter', label: 'Payroll Center', kinds: ['employeeCenter'], match: isPayrollTab, open: win('employeeCenter', { tab: 'payroll' }) },
      ],
    },
    {
      id: 'payroll',
      label: 'Payroll',
      icon: Banknote,
      kinds: ['paycheck', 'paycheckDetail'],
      entries: [
        { id: 'payEmployees', label: 'Pay Employees', kinds: ['payEmployees'], open: startPayEmployees },
        entry('editVoid', 'Find and Edit Paychecks', 'editVoidPaychecks'),
        entry('printPaychecks', 'Print Paychecks', 'printPaychecks'),
        entry('printPayStubs', 'Print Pay Stubs', 'printPayStubs'),
        entry('ytdSetup', 'Year-to-Date Amounts', 'ytdSetup'),
      ],
    },
    {
      id: 'liabilities',
      label: 'Taxes & Forms',
      icon: Landmark,
      kinds: ['liabilityPayment', 'paymentSchedules', 'form941', 'form940', 'stateWageReport'],
      entries: [
        entry('payLiabilities', 'Pay Payroll Taxes', 'payLiabilities', ['liabilityPayment']),
        entry('adjustLiabilities', 'Adjust Tax Balances', 'adjustLiabilities'),
        entry('priorPayments', 'Earlier Tax Payments', 'priorPayments'),
        entry('processForms', 'Tax Forms', 'processForms', ['form941', 'form940', 'stateWageReport']),
        entry('w2', 'W-2/W-3', 'formW2', [], { year: formYear() }),
      ],
    },
    {
      id: 'reports',
      label: 'Reports',
      icon: ChartColumn,
      kinds: ['report'],
      entries: [entry('reportCenter', 'Report Center', 'reportCenter'), ...FAVORITE_REPORTS.slice(0, 5).map(reportEntry)],
    },
    {
      id: 'lists',
      label: 'Lists',
      icon: ListTree,
      kinds: ['payrollItemEdit', 'payScheduleEdit'],
      entries: [entry('payrollItems', 'Payroll Items', 'payrollItemList', ['payrollItemEdit']), entry('paySchedules', 'Pay Schedules', 'paySchedules', ['payScheduleEdit'])],
    },
    {
      id: 'company',
      label: 'Company',
      icon: Building2,
      kinds: ['about'],
      entries: [
        entry('companyPayroll', 'Company Payroll Info', 'companyPayroll'),
        entry('preferences', 'Preferences', 'preferences'),
        entry('taxTables', 'Tax Tables', 'taxTables'),
        entry('payrollSetup', 'Payroll Setup', 'payrollSetup'),
        entry('auditTrail', 'Audit Trail', 'auditTrail'),
      ],
    },
    {
      id: 'books',
      label: 'SerieX Books',
      icon: BookOpen,
      kinds: [],
      entries: [entry('booksSync', 'Books Sync', 'booksSync'), { id: 'openBooks', label: 'Open SerieX Books', kinds: [], open: openSerieXBooks }],
    },
  ];
}

/** True when the navigation entry matches the active window. */
export function entryMatches(e: NavEntry, w: WinState | null): boolean {
  if (!w || !e.kinds.includes(w.kind)) return false;
  return e.match ? e.match(w) : true;
}

// ------------------------------------------------------------ + New panel

export interface NewItem {
  id: string;
  label: string;
  icon: LucideIcon;
  open(): void;
}

export interface NewGroup {
  id: string;
  label: string;
  items: NewItem[];
}

const ni = (id: string, label: string, icon: LucideIcon, kind: WindowKind, props: Record<string, any> = {}): NewItem => ({
  id,
  label,
  icon,
  open: win(kind, props),
});

/** Grouped "+ New" panel. */
export function buildNewGroups(): NewGroup[] {
  return [
    {
      id: 'payroll',
      label: 'Payroll',
      items: [
        ni('scheduled', 'Run payroll', Banknote, 'employeeCenter', { tab: 'payroll' }),
        ni('unscheduled', 'Extra paycheck', Banknote, 'payEmployees', { kind: 'unscheduled' }),
        ni('termination', 'Final paycheck', UserMinus, 'payEmployees', { kind: 'termination' }),
        ni('ytd', 'Year-to-date amounts', BookOpen, 'ytdSetup'),
      ],
    },
    {
      id: 'liabilities',
      label: 'Payroll Taxes',
      items: [
        ni('liabilityPayment', 'Tax payment', Landmark, 'liabilityPayment'),
        ni('adjustment', 'Tax balance adjustment', Scale, 'adjustLiabilities'),
        ni('prior', 'Earlier tax payments', History, 'priorPayments'),
      ],
    },
    {
      id: 'lists',
      label: 'Lists',
      items: [
        ni('employee', 'Employee', UserPlus, 'employeeEdit'),
        ni('item', 'Payroll item', ListChecks, 'payrollItemEdit'),
        ni('schedule', 'Pay schedule', CalendarClock, 'payScheduleEdit'),
        { id: 'account', label: 'Account in Books', icon: ListTree, open: () => void newBooksAccount() },
        { id: 'vendor', label: 'Vendor in Books', icon: Truck, open: () => void newBooksVendor() },
      ],
    },
  ];
}

// ------------------------------------------------------------ search actions

export interface ActionDef {
  id: string;
  label: string;
  /** Extra words that find the action (lower case). */
  keywords: string;
  icon: LucideIcon;
  run(): void;
  /** Report key opened by the action (the report results skip it). */
  reportKey?: string;
}

const act = (id: string, label: string, keywords: string, icon: LucideIcon, run: () => void, reportKey?: string): ActionDef => ({
  id,
  label,
  keywords,
  icon,
  run,
  reportKey,
});
const rep = (id: string, label: string, keywords: string, key: string) => act(id, label, keywords, ChartColumn, win('report', { key }), key);

/** Commands offered by the global search ("Pay employees", "Pay payroll taxes", "Payroll Summary"...). */
export function buildActions(company: PayrollCompany | null): ActionDef[] {
  const lq = lastQuarter();
  return [
    act('payrollCenter', 'Payroll Center', 'pay employees run payroll schedules', ClipboardList, win('employeeCenter', { tab: 'payroll' })),
    act('payEmployees', 'Pay employees', 'run payroll paychecks schedule', Banknote, startPayEmployees),
    act('unscheduled', 'Extra paycheck', 'bonus off cycle one time paycheck', Banknote, win('payEmployees', { kind: 'unscheduled' })),
    act('termination', 'Final paycheck', 'last paycheck leaving release fired quit', UserMinus, win('payEmployees', { kind: 'termination' })),
    act('editVoid', 'Find and edit paychecks', 'find paychecks void edit delete', ClipboardList, win('editVoidPaychecks')),
    act('printPaychecks', 'Print paychecks', 'print checks', Printer, win('printPaychecks')),
    act('printStubs', 'Print pay stubs', 'pay stub earnings statement', Printer, win('printPayStubs')),
    act('payLiabilities', 'Pay payroll taxes', 'pay taxes deposit liabilities owed 941 940 eftps', Landmark, win('payLiabilities')),
    act('liabilityPayment', 'Record a tax payment', 'tax payment agency check e-pay', Landmark, win('liabilityPayment')),
    act('adjust', 'Adjust tax balances', 'tax adjustment correction balance owed', Scale, win('adjustLiabilities')),
    act('prior', 'Record earlier tax payments', 'earlier tax payments before history', History, win('priorPayments')),
    act('dueDates', 'Tax payment schedule', 'payment schedule due dates method deposit frequency', CalendarClock, win('paymentSchedules')),
    act('forms', 'Tax forms', 'tax forms file filing', Files, win('processForms')),
    act('f941', 'Form 941', '941 quarterly federal tax return', FileText, win('form941', { year: lq.year, quarter: lq.quarter })),
    act('f940', 'Form 940', '940 futa annual federal unemployment', FileText, win('form940', { year: formYear() })),
    act('w2', 'W-2/W-3', 'w2 w3 wage statements year end', FileCheck2, win('formW2', { year: formYear() })),
    act('sui', 'State unemployment report', 'state ui wage report quarterly', FileText, win('stateWageReport', { year: lq.year, quarter: lq.quarter, state: company?.primaryState || undefined })),
    act('employeeCenter', 'Employee Center', 'employees list staff', Users, win('employeeCenter', { tab: 'employees' })),
    act('newEmployee', 'New employee', 'add hire employee', UserPlus, win('employeeEdit')),
    act('employeeDefaults', 'Employee defaults', 'new employee default settings', SlidersHorizontal, win('employeeDefaults')),
    act('items', 'Payroll items', 'payroll items wages deductions taxes list', ListChecks, win('payrollItemList')),
    act('newItem', 'New payroll item', 'add payroll item deduction addition', ListChecks, win('payrollItemEdit')),
    act('schedules', 'Pay schedules', 'pay schedule frequency', CalendarClock, win('paySchedules')),
    act('ytd', 'Enter year-to-date amounts', 'ytd year to date history earlier wages', BookOpen, win('ytdSetup')),
    act('setup', 'Payroll Setup', 'setup wizard interview', WandSparkles, win('payrollSetup')),
    act('companyPayroll', 'Company payroll information', 'ein state id deposit schedule', Building2, win('companyPayroll')),
    act('preferences', 'Preferences', 'settings options preferences', Settings, win('preferences')),
    act('taxTables', 'Tax tables', 'withholding rates brackets', Table2, win('taxTables')),
    act('booksSync', 'SerieX Books Sync', 'posting sync verify books', RefreshCw, win('booksSync')),
    act('openBooks', 'Open SerieX Books', 'books accounting', BookOpen, openSerieXBooks),
    act('auditTrail', 'Audit trail', 'history changes log', History, win('auditTrail')),
    act('reportCenter', 'Report Center', 'reports', ChartColumn, win('reportCenter')),
    rep('summary', 'Payroll Summary', 'payroll summary wages taxes', 'payroll_summary'),
    rep('register', 'Payroll Register', 'payroll register paychecks', 'payroll_register'),
    rep('balances', 'Payroll Liability Balances', 'liability balances owed', 'payroll_liability_balances'),
    act('home', 'Home', 'home page dashboard', House, win('home')),
  ];
}
