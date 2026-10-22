// Server data the shell itself shows (report catalog for the menus, liabilities due for the
// left icon bar, SerieX Books web address) and the "Pay Employees" entry point.
import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { queryClient, useLiabilitiesDue, useReportCatalog } from '@/api/hooks';
import type { LiabilityDue, ScheduledPayroll } from '@/api/types';
import { useSession } from '@/state/session';
import { setReportCatalog } from '@/state/catalog';
import { openWindow } from '@/windows/windowStore';

/** GET /reports (catalog for the Reports menu); also feeds report window titles. */
export function useMenuReportCatalog() {
  const q = useReportCatalog();
  useEffect(() => {
    if (Array.isArray(q.data)) setReportCatalog(q.data);
  }, [q.data]);
  return q;
}

/** Amounts owed for one payment group (left navigation "Taxes Due" tab). */
export interface DueGroup {
  paymentGroup: string;
  label: string;
  agencyName: string;
  /** Earliest due date of the unpaid periods. */
  dueDate: string;
  /** Worst status of the unpaid periods. */
  status: 'Overdue' | 'Due' | 'Upcoming';
  amount: number;
}

const STATUS_RANK: Record<string, number> = { Overdue: 0, Due: 1, Upcoming: 2 };

function dueRange() {
  const y = new Date().getFullYear();
  return { from: `${y - 1}-01-01`, to: `${y}-12-31` };
}

/** Unpaid liabilities grouped by payment group (Overdue first, then Due, then Upcoming). */
export function useDueGroups(enabled = true) {
  const cid = useSession((s) => s.companyId);
  const range = useMemo(dueRange, []);
  const q = useLiabilitiesDue(range, { enabled: !!cid && enabled });
  const groups = useMemo(() => groupDue(Array.isArray(q.data) ? q.data : []), [q.data]);
  return { ...q, groups };
}

export function groupDue(rows: LiabilityDue[]): DueGroup[] {
  const map = new Map<string, DueGroup>();
  for (const r of rows) {
    if (r.status === 'Paid' || !(r.amountDue > 0)) continue;
    const g = map.get(r.paymentGroup);
    if (!g) {
      map.set(r.paymentGroup, {
        paymentGroup: r.paymentGroup,
        label: r.label || r.agencyName || r.paymentGroup,
        agencyName: r.agencyName,
        dueDate: r.dueDate,
        status: r.status,
        amount: r.amountDue,
      });
    } else {
      g.amount = Math.round((g.amount + r.amountDue) * 100) / 100;
      if (r.dueDate && (!g.dueDate || r.dueDate < g.dueDate)) g.dueDate = r.dueDate;
      if ((STATUS_RANK[r.status] ?? 9) < (STATUS_RANK[g.status] ?? 9)) g.status = r.status;
    }
  }
  return Array.from(map.values()).sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || a.dueDate.localeCompare(b.dueDate));
}

/** SerieX Books web address (GET /books/open-url), cached for the session. */
export function useBooksUrl() {
  const cid = useSession((s) => s.companyId);
  return useQuery({
    queryKey: ['shell', 'books-url', cid],
    queryFn: () => api.get<{ url: string }>('/books/open-url', { noPrompt: true }).then((r) => r?.url ?? ''),
    enabled: !!cid,
    staleTime: 10 * 60_000,
  });
}

/**
 * "Pay Employees" (navigation, icon bar, search): the Payroll Center
 * lists the payrolls of the pay schedules; a company without pay schedules gets an extra
 * paycheck right away. (Employees > Pay Employees > Run Payroll always opens the Payroll Center.)
 */
export function startPayEmployees(): void {
  queryClient
    .fetchQuery({
      queryKey: ['payroll', 'scheduled'],
      queryFn: ({ signal }) => api.get<ScheduledPayroll[]>('/payroll/scheduled', { signal, noPrompt: true }),
      staleTime: 30_000,
    })
    .then((rows) => {
      if (Array.isArray(rows) && rows.length === 0) openWindow('payEmployees', { kind: 'unscheduled' });
      else openWindow('employeeCenter', { tab: 'payroll' });
    })
    .catch(() => openWindow('employeeCenter', { tab: 'payroll' }));
}
