// Window registry: every window kind -> lazy component, title, default size,
// singleton key and modal flag.
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { reportTitle } from '@/state/catalog';
import { WINDOW_KINDS, type WindowKind } from './kinds';

type Props = Record<string, any>;

export interface WindowDef {
  kind: WindowKind;
  /** Window title (a function when it depends on the props). setTitle() overrides it. */
  title: string | ((props: Props) => string);
  load: () => Promise<{ default: ComponentType<any> }>;
  width: number;
  height: number;
  /** Singleton key: opening a window with the same key focuses the existing one. */
  singleton?: (props: Props) => string;
  minWidth?: number;
  minHeight?: number;
  /** Modal dialog: centered, dims and blocks the rest of the app until closed. */
  modal?: boolean;
  /** Default true. */
  resizable?: boolean;
}

// Default sizes (desktop accounting proportions, same as SerieX Books).
const FORM = { width: 980, height: 660 };
const CENTER = { width: 1150, height: 680 };
const LIST = { width: 600, height: 480 };

/** Stable JSON (sorted keys) for keys built from props. */
function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  const o = v as Record<string, unknown>;
  return (
    '{' +
    Object.keys(o)
      .filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== '')
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stable(o[k]))
      .join(',') +
    '}'
  );
}

/** One window per kind. */
const one = (kind: string) => () => kind;
/** Record forms: one window per record id; new forms keyed by their prefill props. */
const form = (kind: string) => (p: Props) => {
  if (p.id) return `${kind}:${p.id}`;
  const { id, ...rest } = p;
  const pre = stable(rest);
  return `${kind}:new${pre === '{}' ? '' : pre}`;
};
/** Edit dialogs: by id, else new (+ distinguishing props). */
const edit = (kind: string, ...extra: string[]) => (p: Props) =>
  p.id ? `${kind}:${p.id}` : `${kind}:new${extra.map((k) => ':' + (p[k] ?? '')).join('')}`;
/** Windows keyed by a fixed list of props (year, quarter...). */
const by = (kind: string, ...keys: string[]) => (p: Props) => `${kind}:${keys.map((k) => p[k] ?? '').join(':')}`;

const quarterLabel = (p: Props) => (p.quarter ? `Q${p.quarter} ` : '') + (p.year ?? '');

export const REGISTRY: Record<WindowKind, WindowDef> = {
  // ---- company
  home: { kind: 'home', title: 'Home', load: () => import('@/modules/company/HomePage'), width: 1060, height: 680, singleton: one('home') },
  payrollSetup: { kind: 'payrollSetup', title: 'Payroll Setup', load: () => import('@/modules/company/PayrollSetupWizard'), width: 980, height: 660, singleton: one('payrollSetup') },
  companyPayroll: {
    kind: 'companyPayroll',
    title: 'Company Payroll Information',
    load: () => import('@/modules/company/CompanyPayrollDialog'),
    width: 720,
    height: 580,
    modal: true,
    singleton: one('companyPayroll'),
  },
  preferences: { kind: 'preferences', title: 'Preferences', load: () => import('@/modules/company/PreferencesDialog'), width: 840, height: 620, modal: true, singleton: one('preferences') },
  booksSync: { kind: 'booksSync', title: 'SerieX Books Sync', load: () => import('@/modules/company/BooksSyncWindow'), width: 980, height: 600, singleton: one('booksSync') },
  auditTrail: { kind: 'auditTrail', title: 'Audit Trail', load: () => import('@/modules/company/AuditTrailWindow'), width: 1000, height: 620, singleton: one('auditTrail') },
  taxTables: { kind: 'taxTables', title: 'Tax Tables', load: () => import('@/modules/company/TaxTablesWindow'), width: 1000, height: 660, singleton: one('taxTables') },
  about: {
    kind: 'about',
    title: (p) => (p.help ? 'SerieX Payroll Help' : 'About SerieX Payroll'),
    load: () => import('@/modules/company/AboutDialog'),
    width: 480,
    height: 384,
    modal: true,
    resizable: false,
    singleton: one('about'),
  },

  // ---- employees & lists
  employeeCenter: {
    kind: 'employeeCenter',
    // The Payroll tab is the Payroll Center (the window content may set a more detailed title).
    title: (p) => (p.tab === 'payroll' ? 'Payroll Center' : 'Employee Center'),
    load: () => import('@/modules/employees/EmployeeCenter'),
    ...CENTER,
    singleton: one('employeeCenter'),
  },
  employeeEdit: {
    kind: 'employeeEdit',
    title: (p) => (p.id ? 'Edit Employee' : 'New Employee'),
    load: () => import('@/modules/employees/EmployeeEditDialog'),
    width: 820,
    height: 620,
    modal: true,
    singleton: edit('employeeEdit'),
  },
  employeeDefaults: {
    kind: 'employeeDefaults',
    title: 'Employee Defaults',
    load: () => import('@/modules/employees/EmployeeDefaultsDialog'),
    width: 720,
    height: 560,
    modal: true,
    singleton: one('employeeDefaults'),
  },
  payrollItemList: { kind: 'payrollItemList', title: 'Payroll Items', load: () => import('@/modules/employees/PayrollItemList'), width: 900, height: 520, singleton: one('payrollItemList') },
  payrollItemEdit: {
    kind: 'payrollItemEdit',
    title: (p) => (p.id ? 'Edit Payroll Item' : 'New Payroll Item'),
    load: () => import('@/modules/employees/PayrollItemWizard'),
    width: 720,
    height: 540,
    modal: true,
    singleton: edit('payrollItemEdit', 'type'),
  },
  paySchedules: { kind: 'paySchedules', title: 'Pay Schedules', load: () => import('@/modules/employees/PaySchedulesList'), ...LIST, width: 640, singleton: one('paySchedules') },
  payScheduleEdit: {
    kind: 'payScheduleEdit',
    title: (p) => (p.id ? 'Edit Pay Schedule' : 'New Pay Schedule'),
    load: () => import('@/modules/employees/PayScheduleDialog'),
    width: 560,
    height: 420,
    modal: true,
    singleton: edit('payScheduleEdit'),
  },

  // ---- payroll
  payEmployees: {
    kind: 'payEmployees',
    title: (p) => (p.kind === 'termination' ? 'Final Paycheck' : p.kind === 'unscheduled' ? 'Extra Paycheck' : 'Run Payroll'),
    load: () => import('@/modules/payroll/PayEmployees'),
    width: 1060,
    height: 680,
    minWidth: 640,
    minHeight: 360,
    singleton: (p) => `payEmployees:${p.kind ?? 'scheduled'}:${p.scheduleId ?? ''}`,
  },
  paycheckDetail: {
    kind: 'paycheckDetail',
    title: 'Paycheck Details',
    load: () => import('@/modules/payroll/PaycheckDetailWindow'),
    width: 980,
    height: 660,
    singleton: (p) => `paycheckDetail:${p.id ?? 'none'}`,
  },
  paycheck: { kind: 'paycheck', title: 'Paycheck', load: () => import('@/modules/payroll/PaycheckWindow'), ...FORM, singleton: (p) => `paycheck:${p.id ?? 'none'}` },
  editVoidPaychecks: { kind: 'editVoidPaychecks', title: 'Find and Edit Paychecks', load: () => import('@/modules/payroll/EditVoidPaychecks'), width: 900, height: 560, singleton: one('editVoidPaychecks') },
  printPaychecks: { kind: 'printPaychecks', title: 'Print Paychecks', load: () => import('@/modules/payroll/PrintPaychecks'), width: 680, height: 480, singleton: one('printPaychecks') },
  printPayStubs: { kind: 'printPayStubs', title: 'Print Pay Stubs', load: () => import('@/modules/payroll/PrintPayStubs'), width: 680, height: 480, singleton: one('printPayStubs') },
  ytdSetup: { kind: 'ytdSetup', title: 'Enter Year-to-Date Amounts', load: () => import('@/modules/payroll/YtdSetupWizard'), width: 900, height: 620, singleton: one('ytdSetup') },

  // ---- liabilities
  payLiabilities: { kind: 'payLiabilities', title: 'Pay Payroll Taxes', load: () => import('@/modules/liabilities/PayLiabilities'), width: 980, height: 600, singleton: one('payLiabilities') },
  liabilityPayment: { kind: 'liabilityPayment', title: 'Tax Payment', load: () => import('@/modules/liabilities/LiabilityPaymentForm'), ...FORM, singleton: form('liabilityPayment') },
  adjustLiabilities: {
    kind: 'adjustLiabilities',
    title: 'Adjust Tax Balances',
    load: () => import('@/modules/liabilities/AdjustLiabilitiesForm'),
    width: 900,
    height: 600,
    singleton: form('adjustLiabilities'),
  },
  paymentSchedules: {
    kind: 'paymentSchedules',
    title: 'Tax Payment Schedule',
    load: () => import('@/modules/liabilities/PaymentSchedulesDialog'),
    width: 760,
    height: 500,
    modal: true,
    singleton: one('paymentSchedules'),
  },
  priorPayments: { kind: 'priorPayments', title: 'Earlier Tax Payments', load: () => import('@/modules/liabilities/PriorPaymentsWindow'), width: 900, height: 580, singleton: one('priorPayments') },

  // ---- forms
  processForms: { kind: 'processForms', title: 'Tax Forms', load: () => import('@/modules/forms/ProcessPayrollForms'), width: 820, height: 560, singleton: one('processForms') },
  form941: { kind: 'form941', title: (p) => `Form 941 - ${quarterLabel(p)}`.trim(), load: () => import('@/modules/forms/Form941Window'), width: 960, height: 680, singleton: by('form941', 'year', 'quarter') },
  form940: { kind: 'form940', title: (p) => `Form 940 - ${p.year ?? ''}`.trim(), load: () => import('@/modules/forms/Form940Window'), width: 960, height: 680, singleton: by('form940', 'year') },
  formW2: { kind: 'formW2', title: (p) => `W-2/W-3 - ${p.year ?? ''}`.trim(), load: () => import('@/modules/forms/FormW2Window'), width: 1040, height: 680, singleton: by('formW2', 'year') },
  stateWageReport: {
    kind: 'stateWageReport',
    title: (p) => `${p.state ? p.state + ' ' : ''}Unemployment Report - ${quarterLabel(p)}`.trim(),
    load: () => import('@/modules/forms/StateWageReportWindow'),
    width: 1040,
    height: 660,
    singleton: by('stateWageReport', 'year', 'quarter', 'state'),
  },

  // ---- reports
  reportCenter: { kind: 'reportCenter', title: 'Report Center', load: () => import('@/modules/reports/ReportCenter'), width: 1100, height: 680, singleton: one('reportCenter') },
  report: {
    kind: 'report',
    title: (p) => p.title || reportTitle(p.key) || 'Report',
    load: () => import('@/modules/reports/ReportWindow'),
    width: 1000,
    height: 640,
    minWidth: 420,
    singleton: (p) => `report:${p.key}:${stable(p.params ?? {})}`,
  },
};

/** Registry entry of a kind. */
export function windowDef(kind: WindowKind): WindowDef {
  return REGISTRY[kind];
}

/** Default title of a window of this kind with these props. */
export function defaultTitle(kind: WindowKind, props: Props): string {
  const d = REGISTRY[kind];
  if (!d) return kind;
  return typeof d.title === 'function' ? d.title(props) : d.title;
}

/** Singleton key of a window of this kind with these props. */
export function windowKey(kind: WindowKind, props: Props): string {
  const d = REGISTRY[kind];
  if (d?.singleton) return d.singleton(props);
  return `${kind}:${props.id ?? props.key ?? 'new'}`;
}

const lazyCache = new Map<WindowKind, LazyExoticComponent<ComponentType<any>>>();

/** Lazy component of a kind (created once, so React keeps its state). */
export function windowComponent(kind: WindowKind): LazyExoticComponent<ComponentType<any>> {
  let c = lazyCache.get(kind);
  if (!c) {
    c = lazy(REGISTRY[kind].load);
    lazyCache.set(kind, c);
  }
  return c;
}

/** True when the string is a registered window kind. */
export function isWindowKind(k: string): k is WindowKind {
  return (WINDOW_KINDS as readonly string[]).includes(k);
}
