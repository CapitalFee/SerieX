// Definitions shared by the left navigation, the "+ New" panel and the global
// search actions: grouped navigation, the grouped "+ New" panel and the command list
// of the search box.
// Feature preferences hide entries (estimates, purchase orders, inventory, sales tax, classes).
import {
  ArrowLeftRight,
  Banknote,
  Bell,
  BookOpen,
  Bot,
  Boxes,
  Building2,
  CalendarDays,
  ChartColumn,
  ChartPie,
  ClipboardList,
  Copy,
  CreditCard,
  FileMinus,
  FileSpreadsheet,
  FileDown,
  FileText,
  FileUp,
  FolderOpen,
  HandCoins,
  House,
  Landmark,
  ListTree,
  Lock,
  Package,
  PackageCheck,
  Percent,
  PiggyBank,
  Receipt,
  Repeat,
  Save,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  ShoppingCart,
  SquareCheck,
  Tags,
  TrendingUp,
  Truck,
  Undo2,
  UserCog,
  UserPlus,
  Users,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { MemorizedReport, Prefs } from '@/api/types';
import { openWindow, type WinState } from '@/windows/windowStore';
import type { WindowKind } from '@/windows/kinds';

/** Feature switches derived from the preferences (all on while they load). */
export interface Features {
  estimates: boolean;
  purchaseOrders: boolean;
  inventory: boolean;
  salesTax: boolean;
  classes: boolean;
}

export function features(p: Prefs | null): Features {
  return {
    estimates: !p || p.estimatesEnabled,
    purchaseOrders: !p || p.purchaseOrdersEnabled,
    inventory: !p || p.inventoryEnabled,
    salesTax: !p || p.salesTaxEnabled,
    classes: !p || p.useClassTracking,
  };
}

// ------------------------------------------------------------ navigation

export interface NavEntry {
  id: string;
  label: string;
  /** Window kinds that make this entry look selected when active. */
  kinds: WindowKind[];
  /** Extra test on the active window (e.g. which report it shows). */
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
const reportEntry = (id: string, label: string, key: string): NavEntry => ({
  id,
  label,
  kinds: ['report'],
  match: (w) => w.props.key === key && !w.props.memorizedId,
  open: win('report', { key }),
});

/** A starred report (All Reports ★) shown in the Reports navigation group. */
export interface FavoriteReport {
  key: string;
  title: string;
}

/** Grouped left navigation. `favorites`: the starred reports (listed under Reports). */
export function buildNav(p: Prefs | null, memorized: MemorizedReport[], favorites: FavoriteReport[] = []): NavGroup[] {
  const f = features(p);
  const fixedReports = ['profit_loss', 'balance_sheet'];
  const groups: NavGroup[] = [
    { id: 'home', label: 'Home', icon: House, entries: [], open: win('home'), kinds: ['home'] },
    {
      id: 'sales',
      label: 'Customers & Sales',
      icon: Users,
      kinds: ['invoice', 'salesReceipt', 'creditMemo', 'estimate', 'statementCharges', 'createStatements', 'refund', 'customerEdit'],
      entries: [
        entry('customerCenter', 'Customers', 'customerCenter'),
        entry('incomeTracker', 'Money In', 'incomeTracker'),
        entry('receivePayment', 'Receive Payments', 'receivePayment'),
      ],
    },
    {
      id: 'expenses',
      label: 'Vendors & Expenses',
      icon: Truck,
      kinds: ['bill', 'billPayment', 'purchaseOrder', 'receiveItems', 'enterBillForReceived', 'paySalesTax', 'salesTaxPayment', 'inventoryAdjust', 'vendorEdit'],
      entries: [
        entry('vendorCenter', 'Vendors', 'vendorCenter'),
        entry('billTracker', 'Money Out', 'billTracker'),
        entry('payBills', 'Pay Bills', 'payBills'),
        ...(f.salesTax ? [entry('manageSalesTax', 'Sales Tax', 'manageSalesTax', ['paySalesTax'])] : []),
      ],
    },
    {
      id: 'banking',
      label: 'Banking',
      icon: Landmark,
      kinds: ['writeCheck', 'transferFunds', 'ccCharge', 'printChecks'],
      entries: [
        entry('bankFeeds', 'Bank Imports', 'bankFeeds', ['bankRules']),
        entry('registers', 'Registers', 'useRegister', ['register']),
        entry('reconcile', 'Reconcile', 'reconcileBegin', ['reconcile', 'reconcileReports', 'reconcileReport']),
        entry('deposits', 'Deposits', 'makeDeposit'),
      ],
    },
    {
      id: 'reports',
      label: 'Reports',
      icon: ChartColumn,
      kinds: ['report'],
      entries: [
        entry('reportCenter', 'All Reports', 'reportCenter'),
        reportEntry('pl', 'Profit and Loss', 'profit_loss'),
        reportEntry('bs', 'Balance Sheet', 'balance_sheet'),
        ...favorites.filter((r) => !fixedReports.includes(r.key)).map((r) => reportEntry(`fav:${r.key}`, r.title, r.key)),
        ...memorized.slice(0, 8).map<NavEntry>((m) => ({
          id: `mr${m.id}`,
          label: m.name,
          kinds: ['report'],
          match: (w) => w.props.memorizedId === m.id,
          open: win('report', { key: m.reportKey, params: m.params, memorizedId: m.id, title: m.name }, m.name),
        })),
        entry('memorizedReports', 'Memorized Reports', 'memorizedReports'),
      ],
    },
    {
      id: 'lists',
      label: 'Lists',
      icon: ListTree,
      kinds: ['accountEdit', 'itemEdit', 'otherNameEdit', 'profileList', 'listEntryEdit', 'memorizeTxn'],
      entries: [
        entry('coa', 'Chart of Accounts', 'chartOfAccounts'),
        entry('items', 'Products & Services', 'itemList'),
        entry('otherNames', 'Other Names', 'otherNames'),
        ...(f.classes ? [entry('classes', 'Classes', 'classList')] : []),
        {
          id: 'terms',
          label: 'Terms',
          kinds: ['profileList'],
          match: (w) => w.props.list === 'terms',
          open: win('profileList', { list: 'terms' }),
        },
        entry('memorizedTxns', 'Memorized Transactions', 'memorizedTxns'),
      ],
    },
    {
      id: 'company',
      label: 'Company',
      icon: Building2,
      kinds: ['closingDate', 'budgets', 'todos', 'reminders', 'verifyData'],
      entries: [
        entry('myCompany', 'Company Profile', 'myCompany'),
        entry('snapshot', 'Insights', 'snapshot'),
        entry('calendar', 'Calendar', 'calendar'),
        entry('companyInfo', 'Company Info', 'companyInfo'),
        entry('preferences', 'Preferences', 'preferences'),
        entry('users', 'Users', 'users'),
      ],
    },
    { id: 'ai', label: 'AI Assistants', icon: Bot, entries: [], open: win('aiAssistants'), kinds: ['aiAssistants'] },
  ];
  return groups;
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
export function buildNewGroups(p: Prefs | null): NewGroup[] {
  const f = features(p);
  const keep = (x: NewItem | false): x is NewItem => !!x;
  return [
    {
      id: 'customers',
      label: 'Customers',
      items: [
        ni('invoice', 'Invoice', FileText, 'invoice'),
        ni('receivePayment', 'Receive payment', HandCoins, 'receivePayment'),
        f.estimates && ni('estimate', 'Estimate', FileSpreadsheet, 'estimate'),
        ni('salesReceipt', 'Sales receipt', Receipt, 'salesReceipt'),
        ni('creditMemo', 'Credit memo', FileMinus, 'creditMemo'),
        ni('refund', 'Refund', Undo2, 'refund'),
        ni('statementCharge', 'Statement charge', ScrollText, 'statementCharges'),
      ].filter(keep),
    },
    {
      id: 'vendors',
      label: 'Vendors',
      items: [
        ni('bill', 'Bill', Receipt, 'bill'),
        ni('payBills', 'Pay bills', Wallet, 'payBills'),
        ni('check', 'Check / expense', Banknote, 'writeCheck'),
        f.purchaseOrders && ni('purchaseOrder', 'Purchase order', ShoppingCart, 'purchaseOrder'),
        ni('vendorCredit', 'Vendor credit', FileMinus, 'bill', { credit: true }),
        ni('ccCharge', 'Credit card charge', CreditCard, 'ccCharge'),
        (f.purchaseOrders || f.inventory) && ni('receiveItems', 'Receive items', PackageCheck, 'receiveItems'),
      ].filter(keep),
    },
    {
      id: 'other',
      label: 'Other',
      items: [
        ni('deposit', 'Bank deposit', PiggyBank, 'makeDeposit'),
        ni('transfer', 'Transfer', ArrowLeftRight, 'transferFunds'),
        ni('journal', 'Journal entry', BookOpen, 'journalEntry'),
        f.inventory && ni('inventoryAdjust', 'Inventory adjustment', Boxes, 'inventoryAdjust'),
        f.salesTax && ni('paySalesTax', 'Pay sales tax', Percent, 'paySalesTax'),
      ].filter(keep),
    },
    {
      id: 'lists',
      label: 'Lists',
      items: [
        ni('customer', 'Customer', UserPlus, 'customerEdit'),
        ni('vendor', 'Vendor', Truck, 'vendorEdit'),
        ni('item', 'Product / service', Package, 'itemEdit'),
        ni('account', 'Account', ListTree, 'accountEdit'),
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

/** Commands offered by the global search ("Create invoice", "Pay bills", "Profit and Loss"...). */
export function buildActions(p: Prefs | null): ActionDef[] {
  const f = features(p);
  const list: (ActionDef | false)[] = [
    act('invoice', 'Create invoice', 'new invoice bill customer sell sale', FileText, win('invoice')),
    act('receivePayment', 'Receive payment', 'customer payment collect deposit money in', HandCoins, win('receivePayment')),
    f.estimates && act('estimate', 'Create estimate', 'new estimate quote bid', FileSpreadsheet, win('estimate')),
    act('salesReceipt', 'Enter sales receipt', 'new cash sale receipt', Receipt, win('salesReceipt')),
    act('creditMemo', 'Create credit memo', 'new credit memo return', FileMinus, win('creditMemo')),
    act('refund', 'Issue a refund', 'refund customer money back', Undo2, win('refund')),
    act('statementCharges', 'Enter statement charges', 'statement charge', ScrollText, win('statementCharges')),
    act('createStatements', 'Create statements', 'customer statements print', ScrollText, win('createStatements')),
    act('bill', 'Enter bill', 'new bill vendor payable', Receipt, win('bill')),
    act('payBills', 'Pay bills', 'pay vendor bills payables', Wallet, win('payBills')),
    act('writeCheck', 'Write check', 'new check expense payment', Banknote, win('writeCheck')),
    act('vendorCredit', 'Enter vendor credit', 'bill credit vendor', FileMinus, win('bill', { credit: true })),
    act('ccCharge', 'Enter credit card charge', 'credit card charge expense', CreditCard, win('ccCharge')),
    f.purchaseOrders && act('purchaseOrder', 'Create purchase order', 'new po purchase order', ShoppingCart, win('purchaseOrder')),
    (f.purchaseOrders || f.inventory) && act('receiveItems', 'Receive items', 'item receipt inventory', PackageCheck, win('receiveItems')),
    f.inventory && act('inventoryAdjust', 'Adjust inventory', 'quantity value on hand inventory adjustment', Boxes, win('inventoryAdjust')),
    f.salesTax && act('paySalesTax', 'Pay sales tax', 'sales tax payment', Percent, win('paySalesTax')),
    f.salesTax && act('manageSalesTax', 'Manage sales tax', 'sales tax setup', Percent, win('manageSalesTax')),
    act('makeDeposit', 'Make deposit', 'bank deposit undeposited funds', PiggyBank, win('makeDeposit')),
    act('transferFunds', 'Transfer funds', 'transfer between accounts', ArrowLeftRight, win('transferFunds')),
    act('reconcile', 'Reconcile', 'reconcile bank statement', SquareCheck, win('reconcileBegin')),
    act('journalEntry', 'Make journal entry', 'general journal entry je', BookOpen, win('journalEntry')),
    act('register', 'Open a register', 'use register check register bank account', Landmark, win('useRegister')),
    act('bankFeeds', 'Bank Imports', 'bank imports feeds download transactions ofx qfx qbo csv', Landmark, win('bankFeeds')),
    act('customerCenter', 'Customers', 'customers list customer center', Users, win('customerCenter')),
    act('vendorCenter', 'Vendors', 'vendors list suppliers vendor center', Truck, win('vendorCenter')),
    act('incomeTracker', 'Money In', 'open invoices overdue unpaid paid', TrendingUp, win('incomeTracker')),
    act('billTracker', 'Money Out', 'open bills overdue paid purchase orders', ClipboardList, win('billTracker')),
    act('coa', 'Chart of Accounts', 'accounts list coa', ListTree, win('chartOfAccounts')),
    act('itemList', 'Products & Services', 'item list products services inventory', Package, win('itemList')),
    act('otherNames', 'Other Names List', 'other names employees owners', Users, win('otherNames')),
    f.classes && act('classList', 'Class List', 'classes', Tags, win('classList')),
    act('memorizedTxns', 'Memorized Transactions', 'recurring memorized transactions', Repeat, win('memorizedTxns')),
    act('newCustomer', 'New customer', 'add customer', UserPlus, win('customerEdit')),
    act('newVendor', 'New vendor', 'add vendor supplier', Truck, win('vendorEdit')),
    act('newItem', 'New product or service', 'add item product service', Package, win('itemEdit')),
    act('newAccount', 'New account', 'add account', ListTree, win('accountEdit')),
    act('reportCenter', 'All reports', 'reports report center', ChartColumn, win('reportCenter')),
    rep('pl', 'Profit and Loss', 'p&l pl income statement profit loss', 'profit_loss'),
    rep('bs', 'Balance Sheet', 'balance sheet bs assets liabilities', 'balance_sheet'),
    rep('tb', 'Trial Balance', 'trial balance tb', 'trial_balance'),
    rep('gl', 'General Ledger', 'general ledger gl', 'general_ledger'),
    rep('ar', 'A/R Aging Summary', 'ar aging receivables who owes me', 'ar_aging_summary'),
    rep('ap', 'A/P Aging Summary', 'ap aging payables what i owe', 'ap_aging_summary'),
    rep('salesCust', 'Sales by Customer Summary', 'sales by customer', 'sales_by_customer_summary'),
    act('home', 'Home', 'home page dashboard', House, win('home')),
    act('snapshot', 'Insights', 'insights charts overview', ChartPie, win('snapshot')),
    act('calendar', 'Calendar', 'calendar due dates', CalendarDays, win('calendar')),
    act('reminders', 'Reminders', 'reminders alerts', Bell, win('reminders')),
    act('todos', 'To Do List', 'todo to do tasks', ClipboardList, win('todos')),
    act('find', 'Find transactions', 'find search transactions', Search, win('find')),
    act('preferences', 'Preferences', 'settings options preferences', Settings, win('preferences')),
    act('companyInfo', 'Company information', 'company info address tax id', Building2, win('companyInfo')),
    act('users', 'Users and passwords', 'users passwords set up users', UserCog, win('users')),
    act('aiAssistants', 'AI Assistants', 'ai assistant assistants claude chatgpt codex grok cursor connect chat questions mcp model context protocol extension', Bot, win('aiAssistants')),
    // company file and data tasks
    act('backup', 'Back up company', 'backup back up save copy file sxb protect', Save, win('backupCompany')),
    act('backupSettings', 'Automatic backup settings', 'backup automatic backups folder keep schedule daily settings', Save, win('backupSettings')),
    act('restore', 'Restore company file', 'restore backup open file sxb recover', FolderOpen, win('openCompany', { mode: 'restore' })),
    act('copy', 'Create a copy of the company', 'copy duplicate save copy portable company file', Copy, win('backupCompany', { mode: 'copy' })),
    act('closingDate', 'Set closing date', 'closing date password lock period close books year end', Lock, win('closingDate')),
    act('verifyData', 'Check Company File', 'check company file verify integrity problems utilities', ShieldCheck, win('verifyData')),
    act('rebuildData', 'Repair Company File', 'repair company file rebuild fix utilities', Wrench, win('verifyData', { rebuild: true })),
    act('importCsv', 'Import lists from CSV', 'import csv excel spreadsheet lists customers vendors items accounts', FileUp, win('importData')),
    act('exportCsv', 'Export lists to CSV', 'export csv excel spreadsheet lists download', FileDown, win('exportData')),
    act('budgets', 'Budgets', 'budget budgets planning forecast set up budgets', PiggyBank, win('budgets')),
    act('reports', 'Memorized reports', 'memorized reports saved reports', ChartColumn, win('memorizedReports')),
    // profile lists
    act('terms', 'Terms List', 'terms net 30 due days discount payment terms profile list', Tags, win('profileList', { list: 'terms' })),
    act('paymentMethods', 'Payment Method List', 'payment methods cash check visa card profile list', Tags, win('profileList', { list: 'payment_method' })),
    act('customerTypes', 'Customer Type List', 'customer types categories profile list', Tags, win('profileList', { list: 'customer_type' })),
    act('vendorTypes', 'Vendor Type List', 'vendor types categories profile list', Tags, win('profileList', { list: 'vendor_type' })),
    act('jobTypes', 'Job Type List', 'job types profile list', Tags, win('profileList', { list: 'job_type' })),
    act('salesReps', 'Sales Rep List', 'sales reps representatives rep initials profile list', Tags, win('profileList', { list: 'sales_rep' })),
    act('customerMessages', 'Customer Message List', 'customer messages invoice message thank you profile list', Tags, win('profileList', { list: 'customer_message' })),
    act('shipVia', 'Shipping Methods', 'ship via shipping methods carriers ups fedex profile list', Tags, win('profileList', { list: 'ship_via' })),
  ];
  return list.filter((x): x is ActionDef => !!x);
}
