// Helpers shared by the payroll tax screens (Pay Payroll Taxes, Tax Payment, Adjust Tax
// Balances, Earlier Tax Payments, Tax Payment Schedule): period and status texts, the
// liability payroll items, and the "SerieX Books" posting status line with Retry.
import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, RefreshCw } from 'lucide-react';
import { ApiError, api } from '@/api/client';
import { invalidateAll, useItems, usePaymentSchedules } from '@/api/hooks';
import type { Id, ItemType, PaymentFrequency, PayrollItem, RetryResult, SyncStatus } from '@/api/types';
import { Button, alertBox, confirmBox, promptBox, toast } from '@/components';
import { openWindow } from '@/windows/windowStore';
import { MONTH_NAMES } from '@/util/dates';
import { fmtDate, localIso, round2 } from '@/util/format';
import './liabilities.css';

/** Payroll item types that accrue liabilities (taxes, deductions, company contributions). */
export const LIABILITY_TYPES: ItemType[] = ['deduction', 'contribution', 'federal_tax', 'state_tax', 'other_tax'];

/** Sum of amounts rounded to cents. */
export function sum2(values: number[]): number {
  return round2(values.reduce((s, v) => s + (v || 0), 0));
}

/** Labels of the payment (deposit) frequencies. */
export const PAY_FREQ_LABELS: Record<PaymentFrequency, string> = {
  semiweekly: 'Semiweekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annually: 'Annually',
  after_payroll: 'After each payroll',
};

/** Labels of the payment methods. */
export const METHOD_LABELS: Record<string, string> = { check: 'Check', 'e-pay': 'E-pay' };

/** "Due the 15th of the following month..." explanation of a frequency for a payment group. */
export function frequencyHelp(group: string, freq: string): string {
  const federal941 = group === 'federal_941';
  switch (freq) {
    case 'semiweekly':
      return 'Liabilities of paychecks dated Wednesday, Thursday or Friday are due the following Wednesday; those of paychecks dated Saturday through Tuesday are due the following Friday.';
    case 'monthly':
      return 'Due the 15th of the following month. Example: due Feb 15 for liabilities accrued in Jan.';
    case 'quarterly':
      return group === 'federal_940'
        ? 'Due the last day of the month after the quarter, when the undeposited FUTA tax is more than $500 (otherwise it carries into the next quarter; the fourth quarter is due Jan 31).'
        : 'Due the last day of the month after the quarter. Example: due Apr 30 for liabilities of Jan - Mar.';
    case 'annually':
      return 'Due January 31 for the liabilities of the previous year.';
    case 'after_payroll':
      return federal941 ? 'Due on the check date of every payroll.' : 'Due on the check date of every payroll (paid after each payroll).';
  }
  return '';
}

/** What a payment group includes ("Federal 941/944/943 payments include ..."). */
export function groupHelp(group: string, label: string, itemNames: string[]): string {
  if (group === 'federal_941') return 'Federal 941/944/943 payments include Federal Withholding, Social Security, and Medicare. IRS tax deposits of $100,000 or more must be made the next business day.';
  if (group === 'federal_940') return 'Federal 940 payments are the federal unemployment (FUTA) tax.';
  if (group === 'unassigned') return 'These payroll items have no payee yet. Choose the vendor you pay them to.';
  return `${label} payments include ${itemNames.join(', ') || 'no payroll items yet'}.`;
}

function lastDay(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * PERIOD column text: "Jul 2026" (a calendar month), "Q3 2026" (a calendar
 * quarter), "2026" (a calendar year), one date, or the dates of the period. `freq` is only a
 * hint (a period of one day of a monthly schedule is still shown as a date).
 */
export function periodText(_freq: string, start: string, end: string): string {
  if (!start || !end) return '';
  if (start === end) return fmtDate(start);
  const y = +start.slice(0, 4);
  const m = +start.slice(5, 7);
  const ey = +end.slice(0, 4);
  const em = +end.slice(5, 7);
  const fromFirst = start.slice(8) === '01';
  const toLast = +end.slice(8) === lastDay(ey, em);
  if (fromFirst && toLast && y === ey) {
    if (m === em) return `${MONTH_NAMES[m - 1].slice(0, 3)} ${y}`;
    if ((m - 1) % 3 === 0 && em === m + 2) return `Q${(m - 1) / 3 + 1} ${y}`;
    if (m === 1 && em === 12) return String(y);
  }
  return `${fmtDate(start)} - ${fmtDate(end)}`;
}

/** A server timestamp (UTC, RFC 3339) as a local MM/DD/YYYY date. */
export function localDate(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return fmtDate(ts.slice(0, 10));
  return fmtDate(localIso(d));
}

/** Days from today to a date (negative when past). */
export function daysUntil(iso: string, today: string): number {
  const a = Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10));
  const b = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

/** Countdown shown with a status ("in 5 days", "2 weeks", "12 days late"). */
export function countdown(due: string, today: string): string {
  const d = daysUntil(due, today);
  if (d === 0) return 'today';
  if (d < 0) return `${-d} day${d === -1 ? '' : 's'} late`;
  if (d < 14) return `${d} day${d === 1 ? '' : 's'}`;
  if (d < 60) return `${Math.floor(d / 7)} weeks`;
  return `${Math.floor(d / 30)} months`;
}

/** First and last day of the month before the date. */
export function previousMonth(today: string): { start: string; end: string } {
  let y = +today.slice(0, 4);
  let m = +today.slice(5, 7) - 1;
  if (m === 0) {
    m = 12;
    y--;
  }
  const mm = String(m).padStart(2, '0');
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

/** Liability payroll items (taxes, deductions, contributions), active and inactive. */
export function useLiabilityItems(): PayrollItem[] {
  const { data } = useItems({ active: 'all' });
  return useMemo(() => (data ?? []).filter((i) => LIABILITY_TYPES.includes(i.type)), [data]);
}

/**
 * Agency (payee) of each liability item: its own agency, else the payee of its payment group
 * in Tax Payment Schedule.
 */
export function useItemAgencies(): Map<Id, Id | null> {
  const items = useLiabilityItems();
  const { data: sched } = usePaymentSchedules();
  return useMemo(() => {
    const byGroup = new Map((sched ?? []).map((s) => [s.paymentGroup, s.agencyVendorId]));
    return new Map(items.map((i) => [i.id, i.agencyVendorId ?? byGroup.get(i.effectiveGroup) ?? null]));
  }, [items, sched]);
}

/** True for an error the user cancelled (answered No to a server question). */
export function isCancelled(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'cancelled';
}

/** Message of an error for a message box. */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A SerieX Books posting error without its "SerieX Books: " prefix (the text around it already names SerieX Books). */
export function booksErr(msg: string): string {
  return (msg ?? '').replace(/^\s*SerieX Books:\s*/i, '');
}

// ---------------------------------------------------------------------------
// SerieX Books posting

type SyncEntity = 'paycheck' | 'liability_payment' | 'adjustment';

/**
 * Posts one record to SerieX Books again (POST /books/sync/retry), answering the Books
 * questions like the Books Sync window: a confirm question (duplicate check number, reconciled
 * transaction...) asks Yes/No and retries with force; the closing date asks for the password.
 * Returns true when the record is posted.
 */
export async function retryPosting(entity: SyncEntity, id: Id): Promise<boolean> {
  let force = false;
  let closingPassword: string | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await api.post<RetryResult>('/books/sync/retry', { items: [{ entity, id }] }, { force, closingPassword });
    await invalidateAll();
    const p = res.problems.find((x) => x.entity === entity && x.id === id) ?? res.problems[0];
    if (!p) {
      toast('Posted to SerieX Books');
      return true;
    }
    if (p.code === 'confirm' && !force) {
      if (!(await confirmBox(booksErr(p.message), 'SerieX Books'))) return false;
      force = true;
      continue;
    }
    if (p.code === 'closing_date' && closingPassword === undefined) {
      const pw = await promptBox(`${booksErr(p.message)}\n\nEnter the SerieX Books closing date password to post it anyway.`, { password: true, title: 'Closing Date Password' });
      if (!pw) return false;
      closingPassword = pw;
      continue;
    }
    if (p.code === 'books_auth') {
      window.dispatchEvent(new CustomEvent('sx-auth-required', { detail: { message: p.message, books: true } }));
      return false;
    }
    await alertBox(`${booksErr(p.message)}\n\nThe record is saved in SerieX Payroll; it is not in SerieX Books yet. You can post it later from the SerieX Books Sync window.`, 'SerieX Books', 'warning');
    return false;
  }
  return false;
}

/** Props of {@link BooksStatusLine}. */
export interface BooksStatusLineProps {
  entity: SyncEntity;
  id: Id;
  status: SyncStatus;
  error: string;
  booksTxnId: Id | null;
  /** Why the record is not posted when status is none ("Earlier tax payments are not posted"...). */
  noneText?: string;
  voided?: boolean;
  /** Called after a retry (posted or not) so the form shows the record's new posting status. */
  onRetried?: () => void | Promise<void>;
}

/** "Posted to SerieX Books" / "Not posted: <error>  [Retry]" line under a payroll form. */
export function BooksStatusLine({ entity, id, status, error, booksTxnId, noneText, voided, onRetried }: BooksStatusLineProps) {
  const [busy, setBusy] = useState(false);
  if (!id) return null;
  const retry = async () => {
    setBusy(true);
    try {
      await retryPosting(entity, id);
    } catch (e) {
      if (!isCancelled(e)) await alertBox(errText(e), 'SerieX Books', 'error');
    } finally {
      try {
        await onRetried?.();
      } catch {
        /* the form keeps the status it shows */
      }
      setBusy(false);
    }
  };
  const retryBtns = (
    <>
      <Button small variant="secondary" icon={RefreshCw} label="Retry" busy={busy} onClick={() => void retry()} />
      <Button small variant="link" label="Open SerieX Books Sync" onClick={() => openWindow('booksSync', { tab: 'pending' })} />
    </>
  );
  if (status === 'posted')
    return (
      <div className="lx-sync lx-sync-ok" role="status">
        <CheckCircle2 size={15} aria-hidden="true" />
        <span>
          {voided ? 'Voided in SerieX Books' : 'Posted to SerieX Books'}
          {booksTxnId ? <span className="lx-muted"> (transaction #{booksTxnId})</span> : null}
        </span>
      </div>
    );
  if (status === 'error')
    return (
      <div className="lx-sync lx-sync-err" role="alert">
        <AlertTriangle size={15} aria-hidden="true" />
        <span className="lx-sync-msg">Not posted to SerieX Books: {booksErr(error) || 'the last attempt failed.'}</span>
        {retryBtns}
      </div>
    );
  if (status === 'pending')
    return (
      <div className="lx-sync lx-sync-wait" role="status">
        <Clock3 size={15} aria-hidden="true" />
        <span className="lx-sync-msg">Waiting to be posted to SerieX Books.</span>
        {retryBtns}
      </div>
    );
  return (
    <div className="lx-sync lx-sync-none" role="status">
      <span>{noneText ?? 'Not posted to SerieX Books.'}</span>
    </div>
  );
}
