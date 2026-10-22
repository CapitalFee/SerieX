// Helpers shared by Start Reconciling, Reconcile and the reconciliation reports.
import { api } from '@/api/client';
import type { Account, AccountType, ID, ReconcileAdj, ReconcileDiscrepancies, ReconcileStart } from '@/api/types';
import { round2 } from '@/util/format';
import { openWindow } from '@/windows/windowStore';
import { isDebitNormal } from './shared';

/** React-query options of GET /reconcile/{accountId}/discrepancies. */
export function discrepanciesQuery(accountId: ID | null | undefined) {
  return {
    queryKey: ['reconcile-discrepancies', accountId ?? 0] as const,
    queryFn: () => api.get<ReconcileDiscrepancies>(`/reconcile/${accountId}/discrepancies`),
    staleTime: 0,
  };
}

/** Beginning balance minus the last statement's ending balance (0 when they agree or it is unknown). */
export function beginningDifference(start: ReconcileStart | null | undefined): number {
  if (!start || start.lastEndingBalance === null || start.lastEndingBalance === undefined) return 0;
  return round2(start.beginningBalance - start.lastEndingBalance);
}

/** Opens the Discrepancy report of an account (reconciled transactions changed since they were reconciled). */
export function openDiscrepancyReport(accountId: ID, accountName?: string): void {
  openWindow('reconcileReport', { accountId, mode: 'discrepancy', requestId: Date.now() }, { title: `Discrepancy Report${accountName ? ' - ' + accountName : ''}` });
}

/** Accounts that can be reconciled (balance sheet accounts except A/R and A/P). */
export const RECONCILE_TYPES: AccountType[] = [
  'Bank',
  'Credit Card',
  'Other Current Asset',
  'Fixed Asset',
  'Other Asset',
  'Other Current Liability',
  'Long Term Liability',
  'Equity',
];

/** React-query options of GET /reconcile/{accountId} (key ['reconcile', accountId]). */
export function reconcileQuery(accountId: ID | null | undefined) {
  return {
    queryKey: ['reconcile', accountId ?? 0] as const,
    queryFn: () => api.get<ReconcileStart>(`/reconcile/${accountId}`),
    staleTime: 0,
  };
}

/** A sensible default account for the service charge or the interest of a reconciliation. */
export function adjAccountGuess(accounts: readonly Account[], what: 'service' | 'interest', accountType: AccountType): ID | null {
  const active = accounts.filter((a) => a.active);
  if (what === 'service') {
    // patterns in priority order (the first pattern that finds an account wins, whatever the chart
    // order): a card's finance charge is interest, a bank's service charge is a bank fee
    const fees = [/bank (service )?charge/i, /service charge/i];
    const patterns = accountType === 'Credit Card' ? [/finance charge/i, /interest expense/i, /interest/i, ...fees] : fees;
    const expenses = active.filter((a) => a.type === 'Expense' || a.type === 'Other Expense');
    for (const re of patterns) {
      const hit = expenses.find((a) => re.test(a.name));
      if (hit) return hit.id;
    }
    return null;
  }
  return active.find((a) => (a.type === 'Other Income' || a.type === 'Income') && /interest/i.test(a.name))?.id ?? null;
}

/** Effect (natural sign) of the service charge and interest on the account balance. */
export function adjustmentsEffect(accountType: string, sc: ReconcileAdj | null | undefined, int: ReconcileAdj | null | undefined): { sc: number; int: number } {
  const dn = isDebitNormal(accountType);
  const s = sc?.amount ?? 0;
  const i = int?.amount ?? 0;
  // service charge: the account is credited; interest: the account is debited
  return { sc: dn ? -s : s, int: dn ? i : -i };
}

/** Labels of the two groups of a reconciliation (amount < 0 group first). */
export interface GroupLabels {
  decrease: string;
  increase: string;
  tabDecrease: string;
  tabIncrease: string;
  /** Lower-case running text for a count: count(1) -> "1 check or payment", count(2) -> "2 checks and payments". */
  countDecrease: (n: number) => string;
  countIncrease: (n: number) => string;
}

const counter = (one: string, many: string) => (n: number) => `${n} ${n === 1 ? one : many}`;

export function groupLabels(accountType: string): GroupLabels {
  if (accountType === 'Bank')
    return {
      decrease: 'Checks and Payments',
      increase: 'Deposits and Credits',
      tabDecrease: 'Checks and payments',
      tabIncrease: 'Deposits and other credits',
      countDecrease: counter('check or payment', 'checks and payments'),
      countIncrease: counter('deposit or credit', 'deposits and credits'),
    };
  if (accountType === 'Credit Card')
    return {
      decrease: 'Payments and Credits',
      increase: 'Charges and Cash Advances',
      tabDecrease: 'Payments and credits',
      tabIncrease: 'Charges and cash advances',
      countDecrease: counter('payment or credit', 'payments and credits'),
      countIncrease: counter('charge or cash advance', 'charges and cash advances'),
    };
  return { decrease: 'Decreases', increase: 'Increases', tabDecrease: 'Decreases', tabIncrease: 'Increases', countDecrease: counter('decrease', 'decreases'), countIncrease: counter('increase', 'increases') };
}
