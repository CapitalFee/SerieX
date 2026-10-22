// Shortcuts shown in the left and top icon bars.
import {
  House,
  Users,
  ClipboardList,
  Banknote,
  Landmark,
  FileText,
  ListChecks,
  ChartColumn,
  RefreshCw,
  BookOpen,
  type LucideIcon,
} from 'lucide-react';
import { openWindow } from '@/windows/windowStore';
import type { WindowKind } from '@/windows/kinds';
import { openSerieXBooks } from './booksLink';
import { startPayEmployees } from './data';

export interface Shortcut {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Icon color on the dark left bar. */
  color: string;
  /** Icon color on the light top bar. */
  colorLight: string;
  /** Window kinds that make this shortcut look selected when active. */
  kinds: WindowKind[];
  /** Finer check of the active window (e.g. Employee Center on its Payroll tab). */
  match?: (kind: WindowKind, props: Record<string, any>) => boolean;
  open(): void;
}

const sc = (
  id: string,
  label: string,
  icon: LucideIcon,
  color: string,
  colorLight: string,
  kind: WindowKind,
  extra: { props?: Record<string, any>; kinds?: WindowKind[]; match?: Shortcut['match'] } = {},
): Shortcut => ({
  id,
  label,
  icon,
  color,
  colorLight,
  kinds: [kind, ...(extra.kinds ?? [])],
  match: extra.match,
  open: () => {
    openWindow(kind, extra.props ?? {});
  },
});

const payrollTab = (k: WindowKind, p: Record<string, any>) => k === 'employeeCenter' && p.tab === 'payroll';

export const SHORTCUTS: Shortcut[] = [
  sc('home', 'Home', House, '#ffb547', '#e68a00', 'home'),
  sc('employees', 'Employees', Users, '#5fcdf9', '#1b8fc2', 'employeeCenter', {
    props: { tab: 'employees' },
    kinds: ['employeeEdit'],
    match: (k, p) => !payrollTab(k, p),
  }),
  sc('payrollCenter', 'Payroll Center', ClipboardList, '#7cc0f5', '#2a7bc8', 'employeeCenter', { props: { tab: 'payroll' }, match: payrollTab }),
  { ...sc('payEmployees', 'Pay Employees', Banknote, '#6fdc96', '#20984d', 'payEmployees', { kinds: ['paycheckDetail', 'paycheck'] }), open: startPayEmployees },
  sc('payLiabilities', 'Pay Taxes', Landmark, '#ffd85c', '#c49400', 'payLiabilities', { kinds: ['liabilityPayment', 'adjustLiabilities'] }),
  sc('payrollForms', 'Tax Forms', FileText, '#ffa070', '#d9622b', 'processForms', { kinds: ['form941', 'form940', 'formW2', 'stateWageReport'] }),
  sc('payrollItems', 'Payroll Items', ListChecks, '#e8b47a', '#b06f22', 'payrollItemList', { kinds: ['payrollItemEdit'] }),
  sc('reports', 'Reports', ChartColumn, '#ffae42', '#e07800', 'reportCenter', { kinds: ['report'] }),
  sc('booksSync', 'Books Sync', RefreshCw, '#8fd694', '#3a9a41', 'booksSync'),
  {
    id: 'openBooks',
    label: 'Open SerieX Books',
    icon: BookOpen,
    color: '#c99af3',
    colorLight: '#8a4cc9',
    kinds: [],
    open: openSerieXBooks,
  },
];

/** True when the shortcut matches the active window. */
export function shortcutSelected(s: Shortcut, kind: WindowKind | null, props: Record<string, any> | null): boolean {
  if (!kind || !s.kinds.includes(kind)) return false;
  return s.match && kind === s.kinds[0] ? s.match(kind, props ?? {}) : true;
}
