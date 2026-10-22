// Menu bar definitions. Labels use '&' before the access key letter.
import type { MemorizedReport, Prefs, ListName } from '@/api/types';
import {
  openWindow,
  closeAllWindows,
  closeOtherWindows,
  cascadeWindows,
  tileWindows,
  arrangeIcons,
  focusWindow,
  sendKeyToActiveWindow,
  sendMenuCommand,
  type WinState,
} from '@/windows/windowStore';
import { switchCompany, requestCloseCompany, type RecentCompany } from '@/state/session';
import { useView, type IconBarMode, type WindowMode, type IconBarTab } from '@/state/view';
import { reportsByCategory } from '@/state/catalog';
import { toast } from '@/components/toast';
import { backUpNow } from '@/modules/company/shared';
import { switchToPayroll } from './AppSwitcher';
import type { ReportInfo } from '@/api/types';

export interface MenuItem {
  /** Text with '&' before the access key letter ('&&' for a literal '&'). */
  label?: string;
  /** Right-aligned shortcut text. */
  shortcut?: string;
  action?: () => void;
  submenu?: MenuItem[];
  disabled?: boolean;
  /** Check mark (or bullet when radio) in the left gutter. */
  checked?: boolean;
  radio?: boolean;
  separator?: boolean;
  hidden?: boolean;
}

export interface TopMenu {
  label: string;
  items: MenuItem[];
}

export interface MenuContext {
  hasCompany: boolean;
  prefs: Prefs | null;
  recent: RecentCompany[];
  currentCompanyId: string | null;
  reports: Pick<ReportInfo, 'key' | 'title' | 'category'>[];
  memorizedReports: MemorizedReport[];
  windows: WinState[];
  activeId: string | null;
  iconBar: IconBarMode;
  windowMode: WindowMode;
  iconBarTab: IconBarTab;
  /** Left navigation shows icons only. */
  navCollapsed?: boolean;
}

export const SEP: MenuItem = { separator: true };

/** Split '&File' into text, access key and the index of the underlined letter. */
export function parseLabel(label: string): { text: string; key: string | null; index: number } {
  let text = '';
  let key: string | null = null;
  let index = -1;
  for (let i = 0; i < label.length; i++) {
    const ch = label[i];
    if (ch === '&' && i + 1 < label.length) {
      if (label[i + 1] === '&') {
        text += '&';
        i++;
        continue;
      }
      if (key === null) {
        key = label[i + 1].toLowerCase();
        index = text.length;
      }
      continue;
    }
    text += ch;
  }
  return { text, key, index };
}

/** Remove hidden items and duplicate / leading / trailing separators. */
export function visibleItems(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const it of items) {
    if (it.hidden) continue;
    if (it.separator) {
      if (!out.length || out[out.length - 1].separator) continue;
    }
    out.push(it);
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}

const open = (kind: Parameters<typeof openWindow>[0], props?: Record<string, any>, title?: string) => () => {
  openWindow(kind, props ?? {}, title ? { title } : {});
};
const report = (key: string) => open('report', { key });
/** File > Back Up Company > Back Up Now: the server copies the open company file into its backup folder. */
async function backUpNowFromMenu(): Promise<void> {
  try {
    const e = await backUpNow();
    toast(`Backup saved in the backup folder (${e.file}).`);
  } catch (err) {
    toast(`The backup could not be made. ${(err as Error).message}`, { kind: 'error', duration: 8000 });
  }
}
/** Window kinds that answer Ctrl+Q with the activity report of the selected account, name or item. */
const QUICKREPORT_KINDS: WinState['kind'][] = ['customerCenter', 'vendorCenter', 'chartOfAccounts', 'itemList', 'otherNames', 'register'];
/** Transaction forms: they answer Ctrl+H (Transaction History) and Ctrl+Y (Transaction Journal). */
const TXN_FORM_KINDS: WinState['kind'][] = [
  'invoice', 'salesReceipt', 'receivePayment', 'creditMemo', 'estimate', 'refund',
  'bill', 'billPayment', 'purchaseOrder', 'receiveItems', 'salesTaxPayment', 'inventoryAdjust',
  'writeCheck', 'makeDeposit', 'transferFunds', 'ccCharge', 'journalEntry',
];
/**
 * Windows with a Transaction History and a Transaction Journal of the shown / selected transaction
 * (forms, and registers for their selected row).
 */
const JOURNAL_KINDS: WinState['kind'][] = [...TXN_FORM_KINDS, 'register'];
const profile = (list: ListName) => open('profileList', { list });

/** Build the menu bar from the current state. */
export function buildMenus(ctx: MenuContext): TopMenu[] {
  const { hasCompany: co, prefs } = ctx;
  const p = prefs;
  // Company-only items are disabled when no company file is open.
  const c = (it: MenuItem): MenuItem => (co ? it : { ...it, disabled: true });
  const activeWin = ctx.windows.find((w) => w.id === ctx.activeId) ?? null;
  const estimates = !p || p.estimatesEnabled;
  const pos = !p || p.purchaseOrdersEnabled;
  const inventory = !p || p.inventoryEnabled;
  const salesTax = !p || p.salesTaxEnabled;
  const classes = !p || p.useClassTracking;
  const view = useView.getState();

  const recentItems: MenuItem[] = ctx.recent.length
    ? ctx.recent.map((r, i) => ({
        label: `&${i + 1} ${r.name.replace(/&/g, '&&')}`,
        checked: r.id === ctx.currentCompanyId,
        action: () => void switchCompany(r.id),
      }))
    : [{ label: '(no previous companies)', disabled: true }];

  const file: TopMenu = {
    label: '&File',
    items: [
      { label: '&New Company...', action: open('newCompany') },
      { label: '&Open or Restore Company...', action: open('openCompany', { mode: 'open' }) },
      { label: 'Open Pre&vious Company', submenu: recentItems },
      SEP,
      c({
        label: '&Back Up Company',
        submenu: [
          { label: 'Back Up &Now', action: () => void backUpNowFromMenu() },
          { label: 'Create &Local Backup...', action: open('backupCompany') },
          SEP,
          { label: 'Automatic Backup &Settings...', action: open('backupSettings') },
        ],
      }),
      c({ label: 'Create Cop&y...', action: open('backupCompany', { mode: 'copy' }) }),
      c({ label: '&Close Company', action: () => void requestCloseCompany() }),
      SEP,
      { label: 'S&witch to SerieX Payroll...', action: () => void switchToPayroll() },
      SEP,
      c({
        label: '&Utilities',
        submenu: [
          {
            label: '&Import',
            submenu: [
              { label: '&Excel/CSV Files...', action: open('importData') },
              { label: '&QuickBooks® Desktop (IIF files)...', action: open('qbImport', { target: 'current' }) },
            ],
          },
          { label: '&Export', submenu: [{ label: '&Lists to CSV...', action: open('exportData') }] },
          SEP,
          { label: '&Check Company File', action: open('verifyData') },
          { label: 'Re&pair Company File', action: open('verifyData', { rebuild: true }) },
        ],
      }),
      SEP,
      c({
        label: '&Print Forms',
        submenu: [
          { label: '&Checks...', action: open('printChecks', { kind: 'checks' }) },
          { label: '&Invoices...', action: open('printChecks', { kind: 'invoices' }) },
        ],
      }),
      SEP,
      c({ label: 'E&xit', action: () => void requestCloseCompany() }),
    ],
  };

  const edit: TopMenu = {
    label: '&Edit',
    items: [
      c({ label: '&Revert', disabled: !activeWin?.dirty, action: () => sendMenuCommand('revert') }),
      SEP,
      c({ label: 'Use Re&gister', shortcut: 'Ctrl+R', action: open('useRegister') }),
      SEP,
      c({ label: '&Find...', shortcut: 'Ctrl+F', action: open('find') }),
      c({ label: '&Search...', action: open('search') }),
      SEP,
      c({ label: 'Pr&eferences...', action: open('preferences') }),
    ],
  };

  // Workspace: Tabs (default, windowMode 'one') or Floating windows (classic MDI, 'multiple').
  const viewMenu: TopMenu = {
    label: '&View',
    items: [
      {
        label: 'Open &Window List',
        checked: ctx.iconBar === 'left' && ctx.iconBarTab === 'windows',
        action: () => {
          if (ctx.iconBar === 'left' && ctx.iconBarTab === 'windows') view.setIconBarTab('shortcuts');
          else {
            view.setIconBar('left');
            view.setNavCollapsed(false);
            view.setIconBarTab('windows');
          }
        },
      },
      SEP,
      { label: '&Tabs', radio: true, checked: ctx.windowMode === 'one', action: () => view.setWindowMode('one') },
      { label: '&Floating Windows', radio: true, checked: ctx.windowMode === 'multiple', action: () => view.setWindowMode('multiple') },
      SEP,
      { label: '&Left Navigation', radio: true, checked: ctx.iconBar === 'left', action: () => view.setIconBar('left') },
      { label: 'Top &Icon Bar', radio: true, checked: ctx.iconBar === 'top', action: () => view.setIconBar('top') },
      { label: '&Hide Navigation', radio: true, checked: ctx.iconBar === 'hidden', action: () => view.setIconBar('hidden') },
      SEP,
      {
        label: '&Collapse Navigation to Icons',
        checked: !!ctx.navCollapsed,
        disabled: ctx.iconBar !== 'left',
        action: () => view.setNavCollapsed(!ctx.navCollapsed),
      },
    ],
  };

  const lists: TopMenu = {
    label: '&Lists',
    items: [
      c({ label: '&Chart of Accounts', shortcut: 'Ctrl+A', action: open('chartOfAccounts') }),
      c({ label: '&Item List', action: open('itemList') }),
      c({ label: 'C&lass List', action: open('classList'), hidden: !classes }),
      c({ label: '&Other Names List', action: open('otherNames') }),
      c({
        label: 'Customer && &Vendor Profile Lists',
        submenu: [
          { label: '&Sales Rep List...', action: profile('sales_rep') },
          { label: '&Customer Type List...', action: profile('customer_type') },
          { label: '&Vendor Type List...', action: profile('vendor_type') },
          { label: '&Job Type List...', action: profile('job_type') },
          { label: '&Terms List...', action: profile('terms') },
          { label: 'Customer &Message List...', action: profile('customer_message') },
          { label: '&Payment Method List...', action: profile('payment_method') },
          { label: 'S&hip Via List...', action: profile('ship_via') },
        ],
      }),
      SEP,
      c({ label: 'Memori&zed Transaction List', shortcut: 'Ctrl+T', action: open('memorizedTxns') }),
    ],
  };

  const favorites: TopMenu = {
    label: 'F&avorites',
    items: [
      c({ label: 'Create &Invoices', action: open('invoice') }),
      c({ label: '&Write Checks', action: open('writeCheck') }),
      c({ label: 'C&hart of Accounts', action: open('chartOfAccounts') }),
    ],
  };

  const company: TopMenu = {
    label: '&Company',
    items: [
      c({ label: '&Home Page', action: open('home') }),
      c({ label: 'I&nsights', action: open('snapshot') }),
      c({ label: 'C&alendar', action: open('calendar') }),
      c({ label: '&My Company', action: open('myCompany') }),
      SEP,
      c({ label: 'Company &Information...', action: open('companyInfo') }),
      c({ label: 'Set &Up Users and Passwords', submenu: [{ label: 'Set &Up Users...', action: open('users') }] }),
      c({ label: 'Set &Closing Date...', action: open('closingDate') }),
      c({ label: 'Bac&kup Settings...', action: open('backupSettings') }),
      SEP,
      c({ label: 'Planning && &Budgeting', submenu: [{ label: 'Set &Up Budgets...', action: open('budgets') }] }),
      c({ label: 'To D&o List', action: open('todos') }),
      c({ label: '&Reminders', action: open('reminders') }),
      SEP,
      c({ label: 'Char&t of Accounts', shortcut: 'Ctrl+A', action: open('chartOfAccounts') }),
      c({ label: 'Make General &Journal Entries...', action: open('journalEntry') }),
    ],
  };

  const customers: TopMenu = {
    label: 'C&ustomers',
    items: [
      c({ label: 'Customer &Center', shortcut: 'Ctrl+J', action: open('customerCenter') }),
      SEP,
      c({ label: 'Create &Estimates', action: open('estimate'), hidden: !estimates }),
      c({ label: 'Create &Invoices', shortcut: 'Ctrl+I', action: open('invoice') }),
      c({ label: 'Enter Sales &Receipts', action: open('salesReceipt') }),
      c({ label: 'Enter State&ment Charges', action: open('statementCharges') }),
      c({ label: 'Create &Statements...', action: open('createStatements') }),
      SEP,
      c({ label: 'Receive &Payments', action: open('receivePayment') }),
      c({ label: 'Create Cre&dit Memos/Refunds', action: open('creditMemo') }),
      SEP,
      c({ label: 'M&oney In', action: open('incomeTracker') }),
      SEP,
      c({ label: 'Item &List', action: open('itemList') }),
    ],
  };

  const vendors: TopMenu = {
    label: 'Ve&ndors',
    items: [
      c({ label: '&Vendor Center', action: open('vendorCenter') }),
      SEP,
      c({ label: '&Enter Bills', action: open('bill') }),
      c({ label: '&Pay Bills', action: open('payBills') }),
      c({
        label: '&Sales Tax',
        hidden: !salesTax,
        submenu: [
          { label: '&Manage Sales Tax...', action: open('manageSalesTax') },
          { label: '&Pay Sales Tax...', action: open('paySalesTax') },
          SEP,
          { label: 'Sales Tax &Liability', action: report('sales_tax_liability') },
        ],
      }),
      SEP,
      c({ label: 'Create Purchase &Orders', action: open('purchaseOrder'), hidden: !pos }),
      c({ label: 'Receive Items and Enter &Bill', action: open('bill', { receiveItems: true }), hidden: !(pos || inventory) }),
      c({ label: '&Receive Items', action: open('receiveItems'), hidden: !(pos || inventory) }),
      c({ label: 'Enter Bill for Recei&ved Items', action: open('enterBillForReceived'), hidden: !(pos || inventory) }),
      c({
        label: '&Inventory Activities',
        hidden: !inventory,
        submenu: [{ label: '&Adjust Quantity/Value On Hand...', action: open('inventoryAdjust') }],
      }),
      SEP,
      c({ label: 'Money Ou&t', action: open('billTracker') }),
      c({ label: 'Item &List', action: open('itemList') }),
    ],
  };

  const banking: TopMenu = {
    label: '&Banking',
    items: [
      c({ label: '&Write Checks', shortcut: 'Alt+W', action: open('writeCheck') }),
      c({ label: 'Enter &Credit Card Charges', action: open('ccCharge') }),
      c({ label: 'Use &Register', shortcut: 'Ctrl+R', action: open('useRegister') }),
      c({ label: 'Make &Deposits', action: open('makeDeposit') }),
      c({ label: '&Transfer Funds', action: open('transferFunds') }),
      c({ label: 'Rec&oncile...', action: open('reconcileBegin') }),
      SEP,
      c({
        label: '&Bank Feeds',
        submenu: [
          { label: '&Bank Feeds Center', action: open('bankFeeds') },
          { label: '&Import Bank File (OFX / CSV)...', action: open('bankFeeds', { importFile: true }) },
          { label: '&Manage Rules...', action: open('bankRules') },
        ],
      }),
      SEP,
      c({ label: '&Print Checks...', action: open('printChecks', { kind: 'checks' }) }),
      c({ label: 'Previous Reconci&liation reports...', action: open('reconcileReports') }),
      c({ label: 'Other &Names List', action: open('otherNames') }),
    ],
  };

  // Memorized reports submenu: the list window, then groups as submenus.
  const memItems: MenuItem[] = [{ label: '&Memorized Report List', action: open('memorizedReports') }];
  if (ctx.memorizedReports.length) {
    memItems.push(SEP);
    const groups = new Map<string, MemorizedReport[]>();
    const loose: MemorizedReport[] = [];
    for (const m of ctx.memorizedReports) {
      if (m.groupName) {
        if (!groups.has(m.groupName)) groups.set(m.groupName, []);
        groups.get(m.groupName)!.push(m);
      } else loose.push(m);
    }
    const memAction = (m: MemorizedReport) => open('report', { key: m.reportKey, params: m.params, memorizedId: m.id, title: m.name }, m.name);
    for (const [g, list] of Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      memItems.push({ label: g.replace(/&/g, '&&'), submenu: list.map((m) => ({ label: m.name.replace(/&/g, '&&'), action: memAction(m) })) });
    }
    for (const m of loose) memItems.push({ label: m.name.replace(/&/g, '&&'), action: memAction(m) });
    for (const it of memItems) if (it.submenu) assignAccessKeys(it.submenu);
    assignAccessKeys(memItems);
  }

  const reportGroups = reportsByCategory(ctx.reports).filter((g) => g.category !== 'Inventory' || inventory);
  const reports: TopMenu = {
    label: '&Reports',
    items: [
      c({ label: 'Report &Center', action: open('reportCenter') }),
      c({ label: '&Memorized Reports', submenu: memItems }),
      SEP,
      c({ label: '&Insights', action: open('snapshot') }),
      SEP,
      c({
        label: '&Activity Report',
        shortcut: 'Ctrl+Q',
        // only windows that have an activity report (lists, centers, registers)
        disabled: !activeWin || !QUICKREPORT_KINDS.includes(activeWin.kind),
        action: () => {
          if (!sendKeyToActiveWindow({ key: 'q', code: 'KeyQ', ctrlKey: true }))
            toast('Select an account, name or item first, then choose Activity Report.', { kind: 'info' });
        },
      }),
      SEP,
      ...reportGroups.map((g) =>
        c({
          label: g.category.replace(/&/g, '&&'),
          submenu: g.reports.map((r) => ({ label: r.title.replace(/&/g, '&&'), action: report(r.key) })),
        }),
      ),
      SEP,
      // only windows that show a transaction (forms, and registers for their selected row)
      c({
        label: 'Transaction &History',
        shortcut: 'Ctrl+H',
        disabled: !activeWin || !JOURNAL_KINDS.includes(activeWin.kind),
        action: () => {
          if (!sendKeyToActiveWindow({ key: 'h', code: 'KeyH', ctrlKey: true }))
            toast('Open or select a saved transaction first, then choose Transaction History.', { kind: 'info' });
        },
      }),
      c({
        label: 'Transaction &Journal',
        shortcut: 'Ctrl+Y',
        disabled: !activeWin || !JOURNAL_KINDS.includes(activeWin.kind),
        action: () => {
          if (!sendKeyToActiveWindow({ key: 'y', code: 'KeyY', ctrlKey: true }))
            toast('Open or select a saved transaction first, then choose Transaction Journal.', { kind: 'info' });
        },
      }),
    ],
  };
  // Access keys for the category submenus and their reports (first free letter).
  assignAccessKeys(reports.items);
  for (const it of reports.items) if (it.submenu && it.submenu !== memItems) assignAccessKeys(it.submenu);

  const tabsMode = ctx.windowMode === 'one';
  // Tabs workspace: the list follows the tab order; floating: the opening order.
  const docWindows = tabsMode ? [...ctx.windows] : [...ctx.windows].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const active = ctx.windows.find((w) => w.id === ctx.activeId && !w.modal);
  // Tiling or cascading from the Tabs workspace switches to Floating windows first.
  const floating = (fn: () => void) => () => {
    if (useView.getState().windowMode === 'one') view.setWindowMode('multiple');
    fn();
  };
  const windowMenu: TopMenu = {
    label: 'W&indow',
    items: [
      { label: 'Arrange &Icons', disabled: tabsMode || !ctx.windows.some((w) => w.minimized), action: arrangeIcons },
      { label: 'Close &All', disabled: !ctx.windows.length, action: () => void closeAllWindows() },
      { label: 'Close &Others', disabled: !active || ctx.windows.filter((w) => !w.modal).length < 2, action: () => active && void closeOtherWindows(active.id) },
      SEP,
      { label: 'Tile &Vertically', disabled: !ctx.windows.length, action: floating(() => tile('vertical')) },
      { label: 'Tile &Horizontally', disabled: !ctx.windows.length, action: floating(() => tile('horizontal')) },
      { label: '&Cascade', disabled: !ctx.windows.length, action: floating(cascadeWindows) },
      SEP,
      ...docWindows.map((w, i) => ({
        label: `${i < 9 ? `&${i + 1} ` : ''}${w.title.replace(/&/g, '&&')}`,
        checked: w.id === ctx.activeId,
        action: () => focusWindow(w.id),
      })),
    ],
  };

  // a menu of its own, so people looking for it find it at once ('a' and 'i' belong to Favorites and Window)
  const ai: TopMenu = {
    label: 'AI A&ssistants',
    items: [c({ label: '&Set Up AI Assistants...', action: open('aiAssistants') })],
  };

  const help: TopMenu = {
    label: '&Help',
    items: [
      { label: 'SerieX Books &Help', shortcut: 'F1', action: open('about', { help: true }) },
      SEP,
      { label: '&About SerieX Books...', action: open('about') },
    ],
  };

  return [file, edit, viewMenu, lists, favorites, company, customers, vendors, banking, reports, ai, windowMenu, help];
}

/** Window > Tile: when the windows do not fit side by side at a usable size they are cascaded; say so. */
function tile(mode: 'vertical' | 'horizontal') {
  if (!tileWindows(mode)) toast('Not enough room to tile these windows at a usable size, so they were cascaded. Close some windows or use a larger screen.', { kind: 'info', duration: 6000 });
}

/** Give items without an '&' the first letter not used by a sibling. */
function assignAccessKeys(items: MenuItem[]) {
  const used = new Set<string>();
  for (const it of items) {
    if (!it.label || it.separator) continue;
    const k = parseLabel(it.label).key;
    if (k) used.add(k);
  }
  for (const it of items) {
    if (!it.label || it.separator || it.label.replace(/&&/g, '').includes('&')) continue;
    const label = it.label;
    for (let i = 0; i < label.length; i++) {
      const ch = label[i].toLowerCase();
      if (label[i] === '&') {
        i++;
        continue;
      }
      if (/[a-z]/.test(ch) && !used.has(ch)) {
        used.add(ch);
        it.label = label.slice(0, i) + '&' + label.slice(i);
        break;
      }
    }
  }
}
