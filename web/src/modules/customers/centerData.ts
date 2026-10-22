// Data of the money bar (Customer Center, Money In): open estimates,
// unbilled costs, overdue and open invoices, payments received in the last 30 days.
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useTxnList } from '@/api/hooks';
import type { BillableCost, ID, TxnSummary } from '@/api/types';
import { addDays, todayIso } from '@/util/dates';
import { round2 } from '@/util/format';
import { isOverdue } from './shared';

/** A billable cost with its customer:job. */
export type BillableRow = BillableCost;

/** One money bar bucket: total, number of documents and the customers/jobs involved. */
export interface MoneyBucket {
  amount: number;
  count: number;
  nameIds: Set<ID>;
}

/** Everything the money bar shows. */
export interface MoneyBarData {
  estimates: MoneyBucket;
  unbilled: MoneyBucket;
  overdue: MoneyBucket;
  open: MoneyBucket;
  paid: MoneyBucket;
  /** Open invoices / statement charges (for lists). */
  openDocs: TxnSummary[];
  estimateDocs: TxnSummary[];
  paidDocs: TxnSummary[];
  billables: BillableRow[];
  loading: boolean;
}

function bucket(rows: { amount: number; nameId: ID | null | undefined }[]): MoneyBucket {
  const nameIds = new Set<ID>();
  let amount = 0;
  for (const r of rows) {
    amount += r.amount;
    if (r.nameId) nameIds.add(r.nameId);
  }
  return { amount: round2(amount), count: rows.length, nameIds };
}

/** All unbilled billable costs (GET /billables). */
export function useBillables() {
  return useQuery({
    queryKey: ['billables', 'all'],
    queryFn: ({ signal }) => api.get<BillableRow[]>('/billables', { signal }),
  });
}

/** Money bar data of the whole company. */
export function useMoneyBar(): MoneyBarData {
  const today = todayIso();
  const from30 = addDays(today, -30);
  const est = useTxnList({ types: ['EST'], openOnly: true, limit: 5000, sort: '-date' });
  const open = useTxnList({ types: ['INV', 'STMTCHG'], openOnly: true, limit: 10000, sort: 'due' });
  const paid = useTxnList({ types: ['PMT', 'SALESRCPT'], from: from30, to: today, limit: 10000, sort: '-date' });
  const bill = useBillables();
  return useMemo(() => {
    const openRows = (open.data?.rows ?? []).filter((r) => !r.voided && !r.isPending && r.openBalance > 0);
    const overdueRows = openRows.filter((r) => isOverdue(r, today));
    const notDue = openRows.filter((r) => !isOverdue(r, today));
    const estRows = (est.data?.rows ?? []).filter((r) => !r.voided);
    const paidRows = (paid.data?.rows ?? []).filter((r) => !r.voided);
    const billRows = bill.data ?? [];
    return {
      estimates: bucket(estRows.map((r) => ({ amount: r.amount, nameId: r.nameId }))),
      unbilled: bucket(billRows.map((r) => ({ amount: r.amount, nameId: r.nameId }))),
      overdue: bucket(overdueRows.map((r) => ({ amount: r.openBalance, nameId: r.nameId }))),
      open: bucket(notDue.map((r) => ({ amount: r.openBalance, nameId: r.nameId }))),
      paid: bucket(paidRows.map((r) => ({ amount: r.amount, nameId: r.nameId }))),
      openDocs: openRows,
      estimateDocs: estRows,
      paidDocs: paidRows,
      billables: billRows,
      loading: est.isLoading || open.isLoading || paid.isLoading,
    };
  }, [est.data, open.data, paid.data, bill.data, today, est.isLoading, open.isLoading, paid.isLoading]);
}
