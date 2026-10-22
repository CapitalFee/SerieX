// Server data the shell itself shows (report catalog, memorized reports, account balances).
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '@/api/client';
import type { Account, MemorizedReport, ReportInfo } from '@/api/types';
import { useSession } from '@/state/session';
import { setReportCatalog } from '@/state/catalog';

/** GET /reports (catalog for the Reports menu); also feeds report window titles. */
export function useReportCatalog() {
  const cid = useSession((s) => s.companyId);
  const q = useQuery({
    queryKey: ['shell', 'reports', cid],
    queryFn: () => api.get<ReportInfo[]>('/reports', { noPrompt: true }),
    enabled: !!cid,
    staleTime: 10 * 60_000,
  });
  useEffect(() => {
    if (Array.isArray(q.data)) setReportCatalog(q.data);
  }, [q.data]);
  return q;
}

/** GET /memorized-reports (Reports > Memorized Reports, Run Favorite Reports). */
export function useMemorizedReports() {
  const cid = useSession((s) => s.companyId);
  return useQuery({
    queryKey: ['shell', 'memorized-reports', cid],
    queryFn: () => api.get<MemorizedReport[]>('/memorized-reports', { noPrompt: true }),
    enabled: !!cid,
  });
}

export const BALANCE_TYPES = ['Bank', 'Credit Card', 'Accounts Receivable', 'Accounts Payable'];

/** Bank, credit card, A/R and A/P accounts with balances (Balances tab). */
export function useBalanceAccounts(enabled = true) {
  const cid = useSession((s) => s.companyId);
  return useQuery({
    queryKey: ['shell', 'balances', cid],
    queryFn: () => api.get<Account[]>('/accounts' + qs({ types: BALANCE_TYPES.join(',') }), { noPrompt: true }),
    enabled: !!cid && enabled,
  });
}
