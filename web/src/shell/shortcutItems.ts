// Shortcuts shown in the left and top icon bars.
import {
  House,
  Building2,
  TrendingUp,
  Receipt,
  CalendarDays,
  ChartPie,
  Users,
  Truck,
  Landmark,
  ChartColumn,
  ListTree,
  Package,
  SquareCheck,
  type LucideIcon,
} from 'lucide-react';
import { openWindow } from '@/windows/windowStore';
import type { WindowKind } from '@/windows/kinds';

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
  open(): void;
}

const sc = (id: string, label: string, icon: LucideIcon, color: string, colorLight: string, kind: WindowKind, extraKinds: WindowKind[] = []): Shortcut => ({
  id,
  label,
  icon,
  color,
  colorLight,
  kinds: [kind, ...extraKinds],
  open: () => {
    openWindow(kind);
  },
});

export const SHORTCUTS: Shortcut[] = [
  sc('home', 'Home', House, '#ffb547', '#e68a00', 'home'),
  sc('myCompany', 'Company Profile', Building2, '#7cc0f5', '#2a7bc8', 'myCompany'),
  sc('incomeTracker', 'Money In', TrendingUp, '#6fdc96', '#20984d', 'incomeTracker'),
  sc('billTracker', 'Money Out', Receipt, '#ffa070', '#d9622b', 'billTracker'),
  sc('calendar', 'Calendar', CalendarDays, '#ff7b7b', '#d63c3c', 'calendar'),
  sc('snapshot', 'Insights', ChartPie, '#c99af3', '#8a4cc9', 'snapshot'),
  sc('customers', 'Customers', Users, '#5fcdf9', '#1b8fc2', 'customerCenter'),
  sc('vendors', 'Vendors', Truck, '#5ad8c0', '#16967e', 'vendorCenter'),
  sc('bankFeeds', 'Bank Imports', Landmark, '#ffd85c', '#c49400', 'bankFeeds'),
  sc('reports', 'Reports', ChartColumn, '#ffae42', '#e07800', 'reportCenter', ['report']),
  sc('coa', 'Chart of Accounts', ListTree, '#bccad6', '#5b7184', 'chartOfAccounts'),
  sc('items', 'Item List', Package, '#e8b47a', '#b06f22', 'itemList'),
  sc('reconcile', 'Reconcile', SquareCheck, '#8fd694', '#3a9a41', 'reconcileBegin', ['reconcile']),
];
