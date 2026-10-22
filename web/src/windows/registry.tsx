// Window registry: every window kind -> lazy component, title, default size,
// singleton key and modal flag.
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { LIST_TITLES, type ListName } from '@/api/types';
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

// Default sizes and the smallest sizes their layouts work at
// (resizing and Window > Tile never go below them).
const FORM = { width: 980, height: 660, minWidth: 620, minHeight: 420 };
const CENTER = { width: 1150, height: 680, minWidth: 700, minHeight: 420 };
const LIST = { width: 600, height: 480 };
/** Minimum size of forms and centers that do not use FORM / CENTER. */
const FORM_MIN = { minWidth: 620, minHeight: 420 };
const CENTER_MIN = { minWidth: 700, minHeight: 420 };
/** Minimum size of list windows (Chart of Accounts, Item List...). */
const LIST_MIN = { minWidth: 380, minHeight: 260 };
// Default sizes fit the floating desktop of a 1280x720 screen (about 1050x640 next to the navigation
// bar), and the lists and reports in them fit their default width without scrolling sideways.

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
/** Transaction forms: one window per transaction id; new forms keyed by their prefill props. */
const form = (kind: string) => (p: Props) => {
  if (p.id) return `${kind}:${p.id}`;
  const { id, ...rest } = p;
  const pre = stable(rest);
  return `${kind}:new${pre === '{}' ? '' : pre}`;
};
/** Edit dialogs: by id, else new (+ distinguishing props). */
const edit = (kind: string, ...extra: string[]) => (p: Props) =>
  p.id ? `${kind}:${p.id}` : `${kind}:new${extra.map((k) => ':' + (p[k] ?? '')).join('')}`;
const listTitle = (p: Props) => LIST_TITLES[p.list as ListName] ?? 'List';

export const REGISTRY: Record<WindowKind, WindowDef> = {
  // ---- company
  home: { kind: 'home', ...CENTER_MIN, title: 'Home', load: () => import('@/modules/company/HomePage'), width: 1060, height: 680, singleton: one('home') },
  snapshot: { kind: 'snapshot', ...CENTER_MIN, title: 'Insights', load: () => import('@/modules/company/CompanySnapshot'), width: 1040, height: 680, singleton: one('snapshot') },
  myCompany: { kind: 'myCompany', ...CENTER_MIN, title: 'My Company', load: () => import('@/modules/company/MyCompany'), width: 900, height: 600, singleton: one('myCompany') },
  newCompany: { kind: 'newCompany', title: 'New Company', load: () => import('@/modules/company/NewCompanyWizard'), width: 760, height: 560, modal: true, singleton: one('newCompany') },
  openCompany: { kind: 'openCompany', title: 'Open or Restore Company', load: () => import('@/modules/company/OpenCompanyDialog'), width: 640, height: 460, modal: true, singleton: one('openCompany') },
  backupCompany: {
    kind: 'backupCompany',
    title: (p) => (p.mode === 'copy' ? 'Save Copy or Backup' : 'Back Up Company'),
    load: () => import('@/modules/company/BackupDialog'),
    width: 560,
    height: 400,
    modal: true,
    singleton: one('backupCompany'),
  },
  backupSettings: {
    kind: 'backupSettings',
    title: 'Backup Settings',
    load: () => import('@/modules/company/BackupSettingsDialog'),
    width: 600,
    height: 460,
    modal: true,
    singleton: one('backupSettings'),
  },
  companyInfo: { kind: 'companyInfo', title: 'Company Information', load: () => import('@/modules/company/CompanyInfoDialog'), width: 720, height: 580, modal: true, singleton: one('companyInfo') },
  preferences: { kind: 'preferences', title: 'Preferences', load: () => import('@/modules/company/PreferencesDialog'), width: 840, height: 620, modal: true, singleton: one('preferences') },
  closingDate: { kind: 'closingDate', title: 'Set Closing Date and Password', load: () => import('@/modules/company/ClosingDateDialog'), width: 500, height: 340, modal: true, resizable: false, singleton: one('closingDate') },
  users: { kind: 'users', title: 'User List', load: () => import('@/modules/company/UsersDialog'), width: 580, height: 420, modal: true, singleton: one('users') },
  journalEntry: { kind: 'journalEntry', title: 'Make General Journal Entries', load: () => import('@/modules/company/JournalEntryForm'), ...FORM, height: 620, singleton: form('journalEntry') },
  find: { kind: 'find', ...LIST_MIN, title: 'Find', load: () => import('@/modules/company/FindWindow'), width: 1012, height: 560, singleton: one('find') },
  search: { kind: 'search', ...LIST_MIN, title: 'Search', load: () => import('@/modules/company/SearchWindow'), width: 840, height: 580, singleton: one('search') },
  reminders: { kind: 'reminders', ...LIST_MIN, title: 'Reminders', load: () => import('@/modules/company/RemindersWindow'), width: 580, height: 500, singleton: one('reminders') },
  todos: { kind: 'todos', ...LIST_MIN, title: 'To Do List', load: () => import('@/modules/company/TodoList'), width: 760, height: 480, singleton: one('todos') },
  calendar: { kind: 'calendar', ...CENTER_MIN, title: 'Calendar', load: () => import('@/modules/company/CalendarWindow'), width: 1000, height: 660, singleton: one('calendar') },
  budgets: { kind: 'budgets', ...CENTER_MIN, title: 'Set Up Budgets', load: () => import('@/modules/company/BudgetsWindow'), width: 1020, height: 620, singleton: one('budgets') },
  verifyData: {
    kind: 'verifyData',
    title: (p) => (p.rebuild ? 'Repair Company File' : 'Check Company File'),
    load: () => import('@/modules/company/VerifyDataDialog'),
    width: 460,
    height: 300,
    modal: true,
    resizable: false,
    singleton: one('verifyData'),
  },
  about: { kind: 'about', title: 'About SerieX Books', load: () => import('@/modules/company/AboutDialog'), width: 480, height: 340, modal: true, resizable: false, singleton: one('about') },
  aiAssistants: {
    kind: 'aiAssistants',
    title: 'AI Assistants',
    load: () => import('@/modules/company/AiAssistantsDialog'),
    width: 760,
    height: 640,
    minWidth: 520,
    minHeight: 400,
    modal: true,
    singleton: one('aiAssistants'),
  },

  // ---- customers
  customerCenter: { kind: 'customerCenter', title: 'Customer Center', load: () => import('@/modules/customers/CustomerCenter'), ...CENTER, singleton: one('customerCenter') },
  customerEdit: {
    kind: 'customerEdit',
    title: (p) => (p.id ? (p.parentId ? 'Edit Job' : 'Edit Customer') : p.parentId ? 'New Job' : 'New Customer'),
    load: () => import('@/modules/customers/CustomerEditDialog'),
    width: 780,
    height: 580,
    modal: true,
    singleton: edit('customerEdit', 'parentId'),
  },
  invoice: { kind: 'invoice', title: 'Create Invoices', load: () => import('@/modules/customers/InvoiceForm'), ...FORM, singleton: form('invoice') },
  salesReceipt: { kind: 'salesReceipt', title: 'Enter Sales Receipts', load: () => import('@/modules/customers/SalesReceiptForm'), ...FORM, singleton: form('salesReceipt') },
  receivePayment: { kind: 'receivePayment', title: 'Receive Payments', load: () => import('@/modules/customers/ReceivePaymentForm'), ...FORM, singleton: form('receivePayment') },
  creditMemo: { kind: 'creditMemo', title: 'Create Credit Memos/Refunds', load: () => import('@/modules/customers/CreditMemoForm'), ...FORM, singleton: form('creditMemo') },
  estimate: { kind: 'estimate', title: 'Create Estimates', load: () => import('@/modules/customers/EstimateForm'), ...FORM, singleton: form('estimate') },
  statementCharges: { kind: 'statementCharges', ...FORM_MIN, title: 'Enter Statement Charges', load: () => import('@/modules/customers/StatementCharges'), width: 980, height: 580, singleton: one('statementCharges') },
  createStatements: { kind: 'createStatements', ...FORM_MIN, title: 'Create Statements', load: () => import('@/modules/customers/CreateStatements'), width: 840, height: 620, singleton: one('createStatements') },
  incomeTracker: { kind: 'incomeTracker', ...CENTER_MIN, title: 'Money In', load: () => import('@/modules/customers/IncomeTracker'), width: 1100, height: 660, singleton: one('incomeTracker') },
  refund: { kind: 'refund', ...FORM_MIN, title: 'Issue a Refund', load: () => import('@/modules/customers/RefundForm'), width: 780, height: 540, singleton: form('refund') },

  // ---- vendors
  vendorCenter: { kind: 'vendorCenter', title: 'Vendor Center', load: () => import('@/modules/vendors/VendorCenter'), ...CENTER, singleton: one('vendorCenter') },
  vendorEdit: { kind: 'vendorEdit', title: (p) => (p.id ? 'Edit Vendor' : 'New Vendor'), load: () => import('@/modules/vendors/VendorEditDialog'), width: 780, height: 580, modal: true, singleton: edit('vendorEdit') },
  bill: { kind: 'bill', title: (p) => (p.itemReceipt ? 'Create Item Receipts' : 'Enter Bills'), load: () => import('@/modules/vendors/BillForm'), ...FORM, singleton: form('bill') },
  payBills: { kind: 'payBills', ...FORM_MIN, title: 'Pay Bills', load: () => import('@/modules/vendors/PayBills'), width: 1000, height: 660, singleton: one('payBills') },
  billPayment: { kind: 'billPayment', ...FORM_MIN, title: 'Bill Payment (Check)', load: () => import('@/modules/vendors/BillPaymentForm'), width: 920, height: 600, singleton: form('billPayment') },
  purchaseOrder: { kind: 'purchaseOrder', title: 'Create Purchase Orders', load: () => import('@/modules/vendors/PurchaseOrderForm'), ...FORM, singleton: form('purchaseOrder') },
  receiveItems: {
    kind: 'receiveItems',
    title: 'Create Item Receipts',
    // Same component as Enter Bills, always in item receipt mode.
    load: () =>
      import('@/modules/vendors/BillForm').then((m) => {
        const BillForm = m.default as ComponentType<any>;
        const ItemReceiptForm = (p: Props) => <BillForm {...p} itemReceipt />;
        return { default: ItemReceiptForm };
      }),
    ...FORM,
    singleton: form('receiveItems'),
  },
  enterBillForReceived: { kind: 'enterBillForReceived', title: 'Select Item Receipt', load: () => import('@/modules/vendors/SelectItemReceipt'), width: 640, height: 400, modal: true, singleton: one('enterBillForReceived') },
  billTracker: { kind: 'billTracker', ...CENTER_MIN, title: 'Money Out', load: () => import('@/modules/vendors/BillTracker'), width: 1100, height: 660, singleton: one('billTracker') },
  manageSalesTax: { kind: 'manageSalesTax', ...LIST_MIN, title: 'Manage Sales Tax', load: () => import('@/modules/vendors/ManageSalesTax'), width: 780, height: 580, singleton: one('manageSalesTax') },
  paySalesTax: { kind: 'paySalesTax', ...LIST_MIN, title: 'Pay Sales Tax', load: () => import('@/modules/vendors/PaySalesTax'), width: 840, height: 580, singleton: one('paySalesTax') },
  salesTaxPayment: { kind: 'salesTaxPayment', ...FORM_MIN, title: 'Sales Tax Payment', load: () => import('@/modules/vendors/SalesTaxPaymentForm'), width: 920, height: 600, singleton: form('salesTaxPayment') },
  inventoryAdjust: { kind: 'inventoryAdjust', title: 'Adjust Quantity/Value on Hand', load: () => import('@/modules/vendors/InventoryAdjustForm'), ...FORM, height: 620, singleton: form('inventoryAdjust') },

  // ---- banking
  writeCheck: { kind: 'writeCheck', title: 'Write Checks', load: () => import('@/modules/banking/WriteCheckForm'), ...FORM, singleton: form('writeCheck') },
  makeDeposit: { kind: 'makeDeposit', title: 'Make Deposits', load: () => import('@/modules/banking/MakeDepositForm'), ...FORM, height: 620, singleton: form('makeDeposit') },
  transferFunds: { kind: 'transferFunds', ...FORM_MIN, title: 'Transfer Funds Between Accounts', load: () => import('@/modules/banking/TransferFundsForm'), width: 780, height: 480, singleton: form('transferFunds') },
  ccCharge: { kind: 'ccCharge', title: 'Enter Credit Card Charges', load: () => import('@/modules/banking/CreditCardChargeForm'), ...FORM, singleton: form('ccCharge') },
  useRegister: { kind: 'useRegister', title: 'Use Register', load: () => import('@/modules/banking/UseRegisterDialog'), width: 400, height: 190, modal: true, resizable: false, singleton: one('useRegister') },
  register: {
    kind: 'register', ...FORM_MIN,
    title: (p) => p.accountName || 'Register',
    load: () => import('@/modules/banking/RegisterWindow'),
    width: 1000,
    height: 600,
    singleton: (p) => `register:${p.accountId ?? 'none'}`,
  },
  reconcileBegin: { kind: 'reconcileBegin', title: 'Begin Reconciliation', load: () => import('@/modules/banking/ReconcileBegin'), width: 640, height: 460, modal: true, singleton: one('reconcileBegin') },
  reconcile: { kind: 'reconcile', ...FORM_MIN, title: 'Reconcile', load: () => import('@/modules/banking/ReconcileWindow'), width: 1000, height: 660, singleton: (p) => `reconcile:${p.accountId ?? 'none'}` },
  reconcileReports: { kind: 'reconcileReports', ...LIST_MIN, title: 'Previous Reconciliation', load: () => import('@/modules/banking/PreviousReconciliation'), width: 640, height: 460, singleton: one('reconcileReports') },
  reconcileReport: {
    kind: 'reconcileReport',
    title: 'Reconciliation Report',
    load: () => import('@/modules/banking/ReconcileReportWindow'),
    width: 920,
    height: 660,
    singleton: (p) => `reconcileReport:${p.reconciliationId ?? 'none'}`,
  },
  bankFeeds: { kind: 'bankFeeds', ...CENTER_MIN, title: 'Bank Feeds', load: () => import('@/modules/banking/BankFeedsCenter'), width: 1100, height: 660, singleton: one('bankFeeds') },
  bankRules: { kind: 'bankRules', ...LIST_MIN, title: 'Bank Rules', load: () => import('@/modules/banking/BankRules'), width: 740, height: 500, singleton: one('bankRules') },
  printChecks: {
    kind: 'printChecks', ...FORM_MIN,
    title: (p) => (p.kind === 'invoices' ? 'Select Invoices to Print' : 'Select Checks to Print'),
    load: () => import('@/modules/banking/PrintChecks'),
    width: 640,
    height: 460,
    singleton: (p) => `printChecks:${p.kind ?? 'checks'}`,
  },

  // ---- lists
  chartOfAccounts: { kind: 'chartOfAccounts', ...LIST_MIN, title: 'Chart of Accounts', load: () => import('@/modules/lists/ChartOfAccounts'), width: 640, height: 520, singleton: one('chartOfAccounts') },
  accountEdit: { kind: 'accountEdit', title: (p) => (p.id ? 'Edit Account' : 'New Account'), load: () => import('@/modules/lists/AccountEditDialog'), width: 660, height: 540, modal: true, singleton: edit('accountEdit', 'type', 'parentId') },
  itemList: { kind: 'itemList', ...LIST_MIN, title: 'Item List', load: () => import('@/modules/lists/ItemList'), width: 820, height: 520, singleton: one('itemList') },
  itemEdit: { kind: 'itemEdit', title: (p) => (p.id ? 'Edit Item' : 'New Item'), load: () => import('@/modules/lists/ItemEditDialog'), width: 720, height: 560, modal: true, singleton: edit('itemEdit', 'type') },
  classList: { kind: 'classList', ...LIST_MIN, title: 'Class List', load: () => import('@/modules/lists/ClassList'), width: 440, height: 440, singleton: one('classList') },
  otherNames: { kind: 'otherNames', ...LIST_MIN, title: 'Other Names List', load: () => import('@/modules/lists/OtherNamesList'), width: 540, height: 460, singleton: one('otherNames') },
  otherNameEdit: { kind: 'otherNameEdit', title: (p) => (p.id ? 'Edit Name' : 'New Name'), load: () => import('@/modules/lists/OtherNameEditDialog'), width: 640, height: 500, modal: true, singleton: edit('otherNameEdit') },
  profileList: { kind: 'profileList', ...LIST_MIN, title: (p) => `${listTitle(p)} List`, load: () => import('@/modules/lists/ProfileList'), width: 440, height: 440, singleton: (p) => `profileList:${p.list}` },
  listEntryEdit: {
    kind: 'listEntryEdit',
    title: (p) => `${p.id ? 'Edit' : 'New'} ${listTitle(p)}`,
    load: () => import('@/modules/lists/ListEntryEditDialog'),
    width: 480,
    height: 380,
    modal: true,
    singleton: (p) => `listEntryEdit:${p.list}:${p.id ?? 'new'}`,
  },
  memorizedTxns: { kind: 'memorizedTxns', ...LIST_MIN, title: 'Memorized Transaction List', load: () => import('@/modules/lists/MemorizedTxnList'), width: 800, height: 500, singleton: one('memorizedTxns') },
  memorizeTxn: { kind: 'memorizeTxn', title: 'Memorize Transaction', load: () => import('@/modules/lists/MemorizeTxnDialog'), width: 540, height: 320, modal: true, singleton: one('memorizeTxn') },
  qbImport: {
    kind: 'qbImport',
    title: 'Import from QuickBooks® Desktop (IIF files)',
    load: () => import('@/modules/company/QuickBooksImport'),
    width: 1000,
    height: 680,
    minWidth: 760,
    minHeight: 520,
    modal: true,
    singleton: one('qbImport'),
  },
  importData: { kind: 'importData', title: 'Import', load: () => import('@/modules/lists/ImportDialog'), width: 580, height: 440, modal: true, singleton: one('importData') },
  exportData: { kind: 'exportData', title: 'Export', load: () => import('@/modules/lists/ExportDialog'), width: 540, height: 420, modal: true, singleton: one('exportData') },

  // ---- reports
  reportCenter: { kind: 'reportCenter', ...CENTER_MIN, title: 'Report Center', load: () => import('@/modules/reports/ReportCenter'), width: 1100, height: 680, singleton: one('reportCenter') },
  report: {
    kind: 'report',
    title: (p) => p.title || reportTitle(p.key) || 'Report',
    load: () => import('@/modules/reports/ReportWindow'),
    width: 1000,
    height: 640,
    minWidth: 420,
    singleton: (p) => (p.memorizedId ? `report:m${p.memorizedId}` : `report:${p.key}:${stable(p.params ?? {})}`),
  },
  memorizedReports: { kind: 'memorizedReports', ...LIST_MIN, title: 'Memorized Report List', load: () => import('@/modules/reports/MemorizedReportList'), width: 580, height: 480, singleton: one('memorizedReports') },
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
  return `${kind}:${props.id ?? props.accountId ?? props.key ?? 'new'}`;
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
