// Menu bar definitions. Labels use '&' before the access key letter.
import type { PayrollCompany } from '@/api/types';
import { openWindow, closeAllWindows, closeOtherWindows, cascadeWindows, tileWindows, arrangeIcons, focusWindow, type WinState } from '@/windows/windowStore';
import { switchCompany, requestCloseCompany, type RecentCompany } from '@/state/session';
import { useView, type IconBarMode, type WindowMode, type IconBarTab } from '@/state/view';
import { reportsByCategory, CATEGORY_PAYROLL, CATEGORY_TAX_FORMS, type CatalogEntry } from '@/state/catalog';
import { switchToBooks } from './AppSwitcher';

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
  company: PayrollCompany | null;
  recent: RecentCompany[];
  currentCompanyId: string | null;
  reports: CatalogEntry[];
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

/** Year and quarter a quarterly form is usually prepared for: the last quarter that ended. */
export function lastQuarter(d = new Date()): { year: number; quarter: number } {
  const q = Math.floor(d.getMonth() / 3) + 1;
  return q === 1 ? { year: d.getFullYear() - 1, quarter: 4 } : { year: d.getFullYear(), quarter: q - 1 };
}

/** Year an annual form (940, W-2) is usually prepared for: last year in January, else this year. */
export function formYear(d = new Date()): number {
  return d.getMonth() === 0 ? d.getFullYear() - 1 : d.getFullYear();
}

/** Build the menu bar from the current state. */
export function buildMenus(ctx: MenuContext): TopMenu[] {
  const { hasCompany: co } = ctx;
  // Company-only items are disabled when no company is open.
  const c = (it: MenuItem): MenuItem => (co ? it : { ...it, disabled: true });
  const view = useView.getState();
  const lq = lastQuarter();

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
      // The company list (No Company Open screen) offers Open and Set Up Payroll.
      { label: '&Open or Set Up Company...', action: () => void requestCloseCompany() },
      { label: 'Open Pre&vious Company', submenu: recentItems },
      c({ label: '&Close Company', action: () => void requestCloseCompany() }),
      SEP,
      { label: 'S&witch to SerieX Books...', action: () => void switchToBooks() },
      SEP,
      c({
        label: '&Print',
        submenu: [
          { label: '&Paychecks...', action: open('printPaychecks') },
          { label: 'Pay &Stubs...', action: open('printPayStubs') },
        ],
      }),
      SEP,
      c({ label: 'E&xit', action: () => void requestCloseCompany() }),
    ],
  };

  const edit: TopMenu = {
    label: '&Edit',
    items: [
      c({ label: '&Find Paychecks...', shortcut: 'Ctrl+F', action: open('editVoidPaychecks') }),
      SEP,
      c({ label: 'Pr&eferences...', action: open('preferences') }),
    ],
  };

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
      // Workspace: Tabs (default, windowMode 'one') or Floating windows (classic MDI, 'multiple').
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
      c({ label: '&Payroll Items', action: open('payrollItemList') }),
      c({ label: 'Pay &Schedules', action: open('paySchedules') }),
      c({ label: '&Employee List', action: open('employeeCenter', { tab: 'employees' }) }),
    ],
  };

  const employees: TopMenu = {
    label: 'E&mployees',
    items: [
      c({ label: '&Employee Center', action: open('employeeCenter', { tab: 'employees' }) }),
      c({ label: 'Payroll &Center', action: open('employeeCenter', { tab: 'payroll' }) }),
      SEP,
      c({
        label: '&Pay Employees',
        submenu: [
          { label: '&Run Payroll...', action: open('employeeCenter', { tab: 'payroll' }) },
          { label: '&Extra Paycheck...', action: open('payEmployees', { kind: 'unscheduled' }) },
          { label: '&Final Paycheck...', action: open('payEmployees', { kind: 'termination' }) },
        ],
      }),
      c({ label: 'Find &and Edit Paychecks...', action: open('editVoidPaychecks') }),
      SEP,
      c({
        label: 'Payroll &Taxes',
        submenu: [
          { label: '&Pay Payroll Taxes...', action: open('payLiabilities') },
          { label: '&Record a Tax Payment...', action: open('liabilityPayment', {}) },
          { label: '&Adjust Tax Balances...', action: open('adjustLiabilities', {}) },
          { label: 'Record &Earlier Tax Payments...', action: open('priorPayments') },
          { label: 'Tax Payment &Schedule...', action: open('paymentSchedules') },
        ],
      }),
      c({
        label: 'Tax &Forms',
        submenu: [
          { label: '&All Tax Forms...', action: open('processForms') },
          SEP,
          { label: 'Form &941...', action: open('form941', { year: lq.year, quarter: lq.quarter }) },
          { label: 'Form 9&40...', action: open('form940', { year: formYear() }) },
          { label: '&W-2/W-3...', action: open('formW2', { year: formYear() }) },
          {
            label: '&State Unemployment Report...',
            action: open('stateWageReport', { year: lq.year, quarter: lq.quarter, state: ctx.company?.primaryState || undefined }),
          },
        ],
      }),
      SEP,
      c({
        label: 'Payroll &Items',
        submenu: [
          { label: '&All Payroll Items', action: open('payrollItemList') },
          { label: '&New Payroll Item...', action: open('payrollItemEdit', {}) },
        ],
      }),
      c({ label: 'Employee &Defaults...', action: open('employeeDefaults') }),
      c({ label: 'Enter &Year-to-Date Amounts...', action: open('ytdSetup') }),
      c({ label: 'Payroll &Setup...', action: open('payrollSetup') }),
      SEP,
      c({ label: 'Company Payroll I&nformation...', action: open('companyPayroll') }),
      c({ label: 'Ta&x Tables...', action: open('taxTables') }),
      c({ label: 'SerieX &Books Sync...', action: open('booksSync') }),
    ],
  };

  const groups = reportsByCategory(ctx.reports);
  const catSub = (category: string) => (groups.find((g) => g.category === category)?.reports ?? []).map((r) => ({ label: r.title.replace(/&/g, '&&'), action: report(r.key) }));
  const payrollReports = catSub(CATEGORY_PAYROLL);
  const formReports = catSub(CATEGORY_TAX_FORMS);
  const otherGroups = groups.filter((g) => g.category !== CATEGORY_PAYROLL && g.category !== CATEGORY_TAX_FORMS);
  const reports: TopMenu = {
    label: '&Reports',
    items: [
      c({ label: 'Report &Center', action: open('reportCenter') }),
      SEP,
      c({ label: 'Payroll and &Employees', submenu: payrollReports, hidden: !payrollReports.length }),
      c({ label: 'Tax &Forms', submenu: formReports, hidden: !formReports.length }),
      ...otherGroups.map((g) =>
        c({
          label: g.category.replace(/&/g, '&&'),
          submenu: g.reports.map((r) => ({ label: r.title.replace(/&/g, '&&'), action: report(r.key) })),
        }),
      ),
      SEP,
      c({ label: '&Audit Trail', action: open('auditTrail') }),
    ],
  };
  // Access keys for the category submenus and their reports (first free letter).
  assignAccessKeys(reports.items);
  for (const it of reports.items) if (it.submenu) assignAccessKeys(it.submenu);

  const tabsMode = ctx.windowMode === 'one';
  // Tabs workspace: the list follows the tab order; floating: the opening order.
  const docWindows = tabsMode ? [...ctx.windows] : [...ctx.windows].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const activeDoc = ctx.windows.find((w) => w.id === ctx.activeId && !w.modal);
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
      { label: 'Close &Others', disabled: !activeDoc || ctx.windows.filter((w) => !w.modal).length < 2, action: () => activeDoc && void closeOtherWindows(activeDoc.id) },
      SEP,
      { label: 'Tile &Vertically', disabled: !ctx.windows.length, action: floating(() => tileWindows('vertical')) },
      { label: 'Tile &Horizontally', disabled: !ctx.windows.length, action: floating(() => tileWindows('horizontal')) },
      { label: '&Cascade', disabled: !ctx.windows.length, action: floating(cascadeWindows) },
      SEP,
      ...docWindows.map((w, i) => ({
        label: `${i < 9 ? `&${i + 1} ` : ''}${w.title.replace(/&/g, '&&')}`,
        checked: w.id === ctx.activeId,
        action: () => focusWindow(w.id),
      })),
    ],
  };

  const help: TopMenu = {
    label: '&Help',
    items: [
      { label: 'SerieX Payroll &Help', shortcut: 'F1', action: open('about', { help: true }) },
      SEP,
      { label: '&About SerieX Payroll...', action: open('about') },
    ],
  };

  return [file, edit, viewMenu, lists, employees, reports, windowMenu, help];
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
