// The payroll workflow diagram of the Home page, drawn like the SerieX Books one (panels of icons
// joined by arrows on a fixed 740 x 412 canvas that scales to fit its card):
//   EMPLOYEES     Employee Center → Pay Employees → Pay Payroll Taxes → Tax Forms
//   LISTS         Payroll Items, Pay Schedules, Employee Defaults (+ setup, company info, tax tables)
//   REPORTS       Report Center and the payroll reports used most
//   SERIEX BOOKS  Open SerieX Books, Books Sync (records waiting to be posted), Verify
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  BookOpen,
  Building2,
  CalendarClock,
  ChartColumn,
  ClipboardCheck,
  FileSpreadsheet,
  FileText,
  HandCoins,
  History,
  Landmark,
  ListChecks,
  NotebookPen,
  Printer,
  ReceiptText,
  RefreshCw,
  Scale,
  ShieldCheck,
  SlidersHorizontal,
  Table2,
  UserCog,
  Users,
  WandSparkles,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { openWindow } from '@/windows/windowStore';
import type { WindowKind } from '@/windows/kinds';
import { openSerieXBooks } from '@/shell/booksLink';
import { startPayEmployees } from '@/shell/data';

const W = 740;
const H = 412;
const PANEL_H = 200;
const R1 = 34;
const R2 = 124;

type Group = 'employees' | 'lists' | 'reports' | 'books';

const GROUPS: Record<Group, { title: string; x: number; y: number; w: number; fg: string; bg: string }> = {
  employees: { title: 'Employees', x: 0, y: 0, w: 470, fg: '#15803d', bg: '#dcfce7' },
  lists: { title: 'Lists', x: 482, y: 0, w: 258, fg: '#6d28d9', bg: '#ede9fe' },
  reports: { title: 'Reports', x: 0, y: PANEL_H + 12, w: 470, fg: '#c2410c', bg: '#ffedd5' },
  books: { title: 'SerieX Books', x: 482, y: PANEL_H + 12, w: 258, fg: '#1d4ed8', bg: '#dbeafe' },
};

interface Tile {
  id: string;
  label: string;
  icon: LucideIcon;
  group: Group;
  x: number;
  y: number;
  open: () => void;
  title?: string;
  badge?: number;
}

const win = (kind: WindowKind, props?: Record<string, unknown>) => () => {
  openWindow(kind, props ?? {});
};
const report = (key: string) => win('report', { key });

/** Absolute icon box (40 x 40) of a tile on the canvas. */
function box(t: Tile) {
  const g = GROUPS[t.group];
  const x = g.x + t.x + 18;
  const y = g.y + t.y;
  return { l: x, r: x + 40, t: y, b: y + 40, cx: x + 20, cy: y + 20 };
}

function arrow(a: Tile, b: Tile): string {
  const p = box(a);
  const q = box(b);
  const x1 = p.r + 4;
  const x2 = q.l - 5;
  if (Math.abs(p.cy - q.cy) < 1) return `M${x1} ${p.cy} H${x2}`;
  const mx = Math.round((x1 + x2) / 2);
  return `M${x1} ${p.cy} H${mx} V${q.cy} H${x2}`;
}

export interface PayrollWorkflowProps {
  /** Records waiting to be posted to SerieX Books (badge on Books Sync). */
  pending: number;
  /** Payroll taxes overdue (badge on Pay Payroll Taxes). */
  overdue: number;
}

/** The payroll workflow diagram. */
export function PayrollWorkflow({ pending, overdue }: PayrollWorkflowProps) {
  const t: Record<string, Tile> = {};
  const add = (x: Tile) => (t[x.id] = x);

  // employees: the pay period cycle
  add({ id: 'ec', label: 'Employee Center', icon: Users, group: 'employees', x: 12, y: R1, open: win('employeeCenter') });
  add({ id: 'pe', label: 'Pay Employees', icon: Wallet, group: 'employees', x: 124, y: R1, open: startPayEmployees });
  add({ id: 'pl', label: 'Pay Payroll Taxes', icon: HandCoins, group: 'employees', x: 236, y: R1, open: win('payLiabilities'), badge: overdue });
  add({ id: 'pf', label: 'Tax Forms', icon: FileText, group: 'employees', x: 348, y: R1, open: win('processForms') });
  add({ id: 'pc', label: 'Payroll Center', icon: ClipboardCheck, group: 'employees', x: 12, y: R2, open: win('employeeCenter', { tab: 'payroll' }) });
  add({ id: 'ev', label: 'Find and Edit Paychecks', icon: ReceiptText, group: 'employees', x: 124, y: R2, open: win('editVoidPaychecks') });
  add({ id: 'al', label: 'Adjust Tax Balances', icon: Scale, group: 'employees', x: 236, y: R2, open: win('adjustLiabilities') });
  add({ id: 'pp', label: 'Print Paychecks', icon: Printer, group: 'employees', x: 348, y: R2, open: win('printPaychecks') });

  // lists
  add({ id: 'pi', label: 'Payroll Items', icon: ListChecks, group: 'lists', x: 8, y: R1, open: win('payrollItemList') });
  add({ id: 'ps', label: 'Pay Schedules', icon: CalendarClock, group: 'lists', x: 92, y: R1, open: win('paySchedules') });
  add({ id: 'ed', label: 'Employee Defaults', icon: UserCog, group: 'lists', x: 176, y: R1, open: win('employeeDefaults') });
  add({ id: 'su', label: 'Payroll Setup', icon: WandSparkles, group: 'lists', x: 8, y: R2, open: win('payrollSetup') });
  add({ id: 'ci', label: 'Company Payroll Info', icon: Building2, group: 'lists', x: 92, y: R2, open: win('companyPayroll') });
  add({ id: 'tt', label: 'Tax Tables', icon: Table2, group: 'lists', x: 176, y: R2, open: win('taxTables') });

  // reports
  add({ id: 'rc', label: 'Report Center', icon: ChartColumn, group: 'reports', x: 12, y: R1, open: win('reportCenter') });
  add({ id: 'rs', label: 'Payroll Summary', icon: FileSpreadsheet, group: 'reports', x: 124, y: R1, open: report('payroll_summary') });
  add({ id: 'rr', label: 'Payroll Register', icon: NotebookPen, group: 'reports', x: 236, y: R1, open: report('payroll_register') });
  add({ id: 'rl', label: 'Liability Balances', icon: Landmark, group: 'reports', x: 348, y: R1, open: report('payroll_liability_balances') });
  add({ id: 're', label: 'Employee Earnings', icon: Users, group: 'reports', x: 12, y: R2, open: report('employee_earnings_summary') });
  add({ id: 'rd', label: 'Payroll Item Detail', icon: ListChecks, group: 'reports', x: 124, y: R2, open: report('payroll_item_detail') });
  add({ id: 'rp', label: 'Paid Time Off', icon: CalendarClock, group: 'reports', x: 236, y: R2, open: report('paid_time_off_list') });
  add({ id: 'ra', label: 'Audit Trail', icon: History, group: 'reports', x: 348, y: R2, open: win('auditTrail') });

  // SerieX Books
  add({ id: 'ob', label: 'Open SerieX Books', icon: BookOpen, group: 'books', x: 8, y: R1, open: openSerieXBooks });
  add({ id: 'bs', label: 'Books Sync', icon: RefreshCw, group: 'books', x: 92, y: R1, open: win('booksSync'), badge: pending, title: pending ? `${pending} not posted to SerieX Books` : 'Everything is posted to SerieX Books' });
  add({ id: 'vf', label: 'Verify Postings', icon: ShieldCheck, group: 'books', x: 176, y: R1, open: win('booksSync', { tab: 'verify' }) });
  add({ id: 'pj', label: 'Payroll Journal', icon: NotebookPen, group: 'books', x: 8, y: R2, open: report('payroll_journal') });
  add({ id: 'pr', label: 'Preferences', icon: SlidersHorizontal, group: 'books', x: 92, y: R2, open: win('preferences', { section: 'books' }) });

  const arrows: string[] = [];
  const link = (a: string, b: string) => t[a] && t[b] && arrows.push(arrow(t[a], t[b]));
  link('ec', 'pe');
  link('pe', 'pl');
  link('pl', 'pf');

  const outer = useRef<HTMLDivElement>(null);
  const [fitTo, setFitTo] = useState({ scale: 1, left: 0 });
  const scale = fitTo.scale;
  useLayoutEffect(() => {
    const el = outer.current;
    if (!el) return;
    const fit = () => {
      const sc = Math.max(0.6, Math.min(1.15, el.clientWidth / W));
      setFitTo({ scale: sc, left: Math.max(0, Math.round((el.clientWidth - W * sc) / 2)) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={outer} className="cx-wf-outer" style={{ height: H * scale }}>
      <div className="cx-wf" style={{ width: W, height: H, left: fitTo.left, transform: `scale(${scale})` }}>
        {(Object.keys(GROUPS) as Group[]).map((g) => (
          <Panel key={g} group={g} />
        ))}
        <svg className="cx-wf-arrows" width={W} height={H} aria-hidden="true">
          <defs>
            <marker id="pc-wf-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill="#94a3b8" />
            </marker>
          </defs>
          {arrows.map((d, i) => (
            <path key={i} d={d} fill="none" stroke="#a5b1bf" strokeWidth="1.6" markerEnd="url(#pc-wf-head)" />
          ))}
        </svg>
        {Object.values(t).map((x) => (
          <TileButton key={x.id} tile={x} />
        ))}
      </div>
    </div>
  );
}

function Panel({ group }: { group: Group }) {
  const g = GROUPS[group];
  return (
    <div className="cx-wf-panel" style={{ left: g.x, top: g.y, width: g.w, height: PANEL_H }}>
      <div className="cx-wf-panelhead" style={{ color: g.fg }}>
        {g.title}
      </div>
    </div>
  );
}

function TileButton({ tile }: { tile: Tile }): ReactNode {
  const g = GROUPS[tile.group];
  const Icon = tile.icon;
  return (
    <button
      type="button"
      className="cx-wf-tile"
      data-tile={tile.id}
      style={{ left: g.x + tile.x - 4, top: g.y + tile.y }}
      onClick={tile.open}
      title={tile.title ?? tile.label}
    >
      <span className="cx-wf-icon" style={{ background: g.bg, color: g.fg }}>
        <Icon size={21} strokeWidth={1.8} />
        {!!tile.badge && tile.badge > 0 && <span className="pc-wf-badge">{tile.badge > 99 ? '99+' : tile.badge}</span>}
      </span>
      <span className="cx-wf-label">{tile.label}</span>
    </button>
  );
}
