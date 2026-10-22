// Helpers shared by the payroll windows (Pay Employees, Paycheck, Paycheck Details, Find and
// Edit Paychecks, printing, Enter Year-to-Date Amounts): paycheck input building, check numbers, SerieX Books posting
// status and retry, void/delete with their confirmations.
import { useEffect, useRef, useState } from 'react';
import { api, qs, ApiError } from '@/api/client';
import { invalidateAll, queryClient } from '@/api/hooks';
import type { Category, Id, ItemType, Paycheck, PaycheckInput, PaycheckLine, PaycheckSummary, RetryResult, SyncProblem, SyncStatus } from '@/api/types';
import { Button, Checkbox, TextField, alertBox, confirmBox, msgBox, promptBox, showDialog, toast } from '@/components';
import { MsgBoxIcon } from '@/components/dialogs';
import { fmtDate, fmtMoney, round2 } from '@/util/format';
import { forgetRecent, recordRecent } from '@/util/recent';
import { closeWindow, openWindow, useWindowStore } from '@/windows/windowStore';

// ---------------------------------------------------------------------------
// Numbers

/** Hours with 2 decimals ("80.00"); blank for null. */
export function fmtHours(h: number | null | undefined, blankZero = false): string {
  if (h === null || h === undefined || Number.isNaN(h)) return '';
  if (blankZero && h === 0) return '';
  return h.toFixed(2);
}

/** Sum of amounts rounded to cents. */
export function sum2(values: number[]): number {
  return round2(values.reduce((s, v) => s + v, 0));
}

/** Deductions and taxes withheld are shown negative on paycheck screens and pay stubs. */
export function signedAmount(category: Category | '' | undefined, amount: number): number {
  return category === 'deduction' || category === 'employee_tax' ? -amount : amount;
}

/** Error text of an API call (cancelled questions return null: nothing to show). */
export function errorText(e: unknown): string | null {
  if (e instanceof ApiError && e.code === 'cancelled') return null;
  return e instanceof Error ? e.message : String(e);
}

/** Shows an API error in a message box (nothing for a cancelled question). */
export async function showError(e: unknown, title = 'SerieX Payroll'): Promise<void> {
  const t = errorText(e);
  if (t) await alertBox(t, title, 'error');
}

// ---------------------------------------------------------------------------
// Earnings cells of the Hours and Pay grid

/** What the Pay Employees cell of an earnings item holds. */
export type EarningCell = 'hours' | 'qty' | 'amount';

/** Hourly, overtime and salary items take hours; quantity commissions a quantity (sales); others an amount. */
export function earningCell(type: ItemType | '' | undefined, calc?: string): EarningCell {
  if (type === 'hourly' || type === 'overtime' || type === 'salary') return 'hours';
  if (type === 'commission' && calc === 'quantity') return 'qty';
  return 'amount';
}

/** Hours worked of earnings lines (hour based items). */
export function linesHours(lines: PaycheckLine[]): number {
  let h = 0;
  for (const l of lines) {
    if ((l.itemType === 'hourly' || l.itemType === 'overtime' || l.itemType === 'salary') && l.qty) h += l.qty;
  }
  return Math.round(h * 100) / 100;
}

// ---------------------------------------------------------------------------
// Paycheck inputs

/** An empty paycheck line for an item. */
export function newLine(itemId: Id = 0, patch: Partial<PaycheckLine> = {}): PaycheckLine {
  return {
    id: 0,
    itemId,
    rate: null,
    qty: null,
    amount: 0,
    wageBase: 0,
    subjectWages: 0,
    computed: 0,
    jobNameId: null,
    classId: null,
    manual: false,
    itemName: '',
    itemType: '',
    category: '',
    taxCode: '',
    pto: '',
    jobName: '',
    ytd: 0,
    ...patch,
  };
}

/** The editable part of a paycheck (what /paychecks/calculate, PUT and create take). */
export function toInput(pc: PaycheckInput, patch: Partial<PaycheckInput> = {}): PaycheckInput {
  return {
    id: pc.id,
    employeeId: pc.employeeId,
    kind: pc.kind,
    periodStart: pc.periodStart,
    periodEnd: pc.periodEnd,
    checkDate: pc.checkDate,
    bankAccountId: pc.bankAccountId,
    checkNumber: pc.checkNumber,
    toBePrinted: pc.toBePrinted,
    directDeposit: pc.directDeposit,
    memo: pc.memo,
    classId: pc.classId,
    noAccrual: pc.noAccrual,
    lines: pc.lines.filter((l) => l.itemId > 0).map((l) => ({ ...l })),
    recalculate: true,
    ...patch,
  };
}

/** Lines that can be sent (a chosen item). */
export function sendableLines(lines: PaycheckLine[]): PaycheckLine[] {
  return lines.filter((l) => l.itemId > 0);
}

/** Stable key of an input (to know whether a calculation is current). */
export function inputKey(input: PaycheckInput): string {
  return JSON.stringify({
    ...input,
    lines: sendableLines(input.lines).map((l) => [l.itemId, l.rate, l.qty, l.manual ? l.amount : null, l.manual, l.jobNameId, l.classId]),
  });
}

/** POST /paychecks/calculate (never saved). */
export function calculatePaycheck(input: PaycheckInput, signal?: AbortSignal): Promise<Paycheck> {
  return api.post<Paycheck>('/paychecks/calculate', { ...input, lines: sendableLines(input.lines) }, { signal });
}

// ---------------------------------------------------------------------------
// Check numbers

/** Next check number of a SerieX Books bank account ("" when SerieX Books cannot tell). */
export async function nextCheckNumber(bankAccountId: Id | null | undefined): Promise<string> {
  if (!bankAccountId) return '';
  try {
    const r = await api.get<{ refNumber: string }>('/books/next-check' + qs({ accountId: bankAccountId }), { noPrompt: true });
    return r?.refNumber ?? '';
  } catch {
    return '';
  }
}

/** Hook: next check number of the account (refreshed when the account or `refresh` changes). */
export function useNextCheckNumber(bankAccountId: Id | null | undefined, refresh: unknown = 0): string {
  const [n, setN] = useState('');
  useEffect(() => {
    let live = true;
    void nextCheckNumber(bankAccountId).then((v) => live && setN(v));
    return () => {
      live = false;
    };
  }, [bankAccountId, refresh]);
  return n;
}

/** Number shown for a paycheck ("To Print", "DD12", "1001"). */
export function checkNumberLabel(p: { checkNumber: string; toBePrinted: boolean; kind?: string; voided?: boolean }): string {
  if (p.kind === 'ytd') return 'YTD';
  if (p.toBePrinted && !p.voided) return 'To Print';
  return p.checkNumber;
}

// ---------------------------------------------------------------------------
// SerieX Books posting status

/** Text and color of a posting status. */
export function syncInfo(p: { syncStatus: SyncStatus; syncError: string; booksTxnId: Id | null; voided?: boolean; kind?: string }): {
  label: string;
  tone: 'success' | 'warning' | 'danger' | 'muted';
  detail: string;
} {
  switch (p.syncStatus) {
    case 'posted':
      return { label: p.voided ? 'Voided in SerieX Books' : 'Posted', tone: p.voided ? 'muted' : 'success', detail: p.voided ? 'The SerieX Books check is void.' : 'Posted to SerieX Books.' };
    case 'pending':
      return { label: 'Not posted', tone: 'warning', detail: 'Waiting to be posted to SerieX Books.' };
    case 'error':
      return { label: 'Problem', tone: 'danger', detail: p.syncError || 'The last attempt to post to SerieX Books failed.' };
    default:
      return {
        label: 'Not posted',
        tone: 'muted',
        detail: p.kind === 'ytd' ? 'Year-to-date amounts are never posted to SerieX Books.' : p.voided ? 'Void; nothing was posted to SerieX Books.' : 'Not posted to SerieX Books.',
      };
  }
}

/**
 * Posts records again (POST /books/sync/retry) and answers the SerieX Books questions like the
 * Books Sync window: confirm → ask and retry with force; closing date → password; sign-in.
 * Returns the problems left (empty when everything was posted), or null when cancelled.
 */
export async function retryPosting(items: { entity: string; id: Id }[]): Promise<SyncProblem[] | null> {
  let opts: { force?: boolean; closingPassword?: string } = {};
  for (let round = 0; round < 3; round++) {
    const r = await api.post<RetryResult>('/books/sync/retry', { items }, { ...opts, noPrompt: true });
    const problems = r?.problems ?? [];
    const ask = problems.find((p) => p.code === 'confirm' || p.code === 'closing_date' || p.code === 'books_auth');
    if (!ask) return problems;
    if (ask.code === 'books_auth') {
      window.dispatchEvent(new CustomEvent('sx-auth-required', { detail: { message: ask.message, books: true } }));
      return problems;
    }
    if (ask.code === 'confirm') {
      if (opts.force) return problems;
      const yes = (await msgBox({ title: 'SerieX Books', message: `${ask.label}\n\n${ask.message}`, buttons: ['Yes', 'No'], icon: 'warning' })) === 'Yes';
      if (!yes) return null;
      opts = { ...opts, force: true };
    } else {
      if (opts.closingPassword) return problems;
      const pw = await promptBox(ask.message || 'Enter the SerieX Books closing date password.', { password: true, title: 'Closing Date Password' });
      if (!pw) return null;
      opts = { ...opts, closingPassword: pw };
    }
  }
  return [];
}

/** Message box listing posting problems, with a button that opens the Books Sync window. */
export async function showPostingProblems(problems: SyncProblem[], intro: string): Promise<void> {
  if (!problems.length) return;
  const text = problems
    .slice(0, 8)
    .map((p) => `• ${p.label}: ${p.message}`)
    .join('\n');
  const more = problems.length > 8 ? `\n…and ${problems.length - 8} more.` : '';
  const r = await msgBox({
    title: 'SerieX Books',
    message: `${intro}\n\n${text}${more}\n\nThe records are saved in SerieX Payroll. Fix the problem and post them again from the SerieX Books Sync window.`,
    buttons: ['&Open Books Sync', 'Close'],
    icon: 'warning',
    width: 520,
  });
  if (r === 'Open Books Sync') openWindow('booksSync', { tab: 'pending' });
}

// ---------------------------------------------------------------------------
// Recent records

/** Feeds the "+ New" Recent column and the search box. */
export function rememberPaycheck(p: Pick<PaycheckSummary, 'id' | 'checkNumber' | 'toBePrinted' | 'employeeName' | 'net' | 'checkDate' | 'kind'>): void {
  if (p.kind === 'ytd') return;
  recordRecent({ kind: 'paycheck', id: p.id, number: p.toBePrinted ? '' : p.checkNumber, name: p.employeeName, amount: p.net, date: p.checkDate });
}

// ---------------------------------------------------------------------------
// Void / delete

type VoidTarget = Pick<PaycheckSummary, 'id' | 'employeeName' | 'checkDate' | 'net' | 'checkNumber' | 'toBePrinted' | 'kind' | 'syncStatus'>;

function VoidBody({ p, close }: { p: VoidTarget; close: (ok: boolean) => void }) {
  const [yes, setYes] = useState('');
  const [agree, setAgree] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const ok = yes.trim().toUpperCase() === 'YES' && agree;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) close(true);
      }}
    >
      <div className="sx-msgbox-body">
        <div className="sx-msgbox-icon">
          <MsgBoxIcon icon="warning" />
        </div>
        <div className="py-void-main">
          <div className="sx-msgbox-text">
            You are about to void the paycheck to <b>{p.employeeName}</b> dated {fmtDate(p.checkDate)} for {fmtMoney(p.net)}
            {p.checkNumber && !p.toBePrinted ? ` (check ${p.checkNumber})` : ''}.
          </div>
          <div className="py-void-note">
            Voiding sets every amount of the paycheck to zero and cannot be undone. The SerieX Books check is voided too. Voiding a paycheck of a quarter you already filed
            means amending that quarter's forms.
          </div>
          <label className="py-void-label" htmlFor="py-void-yes">
            Type <b>YES</b> to confirm
          </label>
          <TextField id="py-void-yes" ref={ref} value={yes} onChange={setYes} width={120} aria-label="Type YES to confirm" />
          <Checkbox checked={agree} onChange={setAgree} label="I understand that voiding a paycheck cannot be undone." />
        </div>
      </div>
      <div className="sx-dlg-buttons sx-center">
        <Button type="submit" variant="danger" label="&Void Paycheck" disabled={!ok} />
        <Button label="Cancel" onClick={() => close(false)} />
      </div>
    </form>
  );
}

/**
 * Voids a paycheck after the "type YES" confirmation (POST /paychecks/{id}/void). The SerieX
 * Books check is voided first by the server. Returns the voided paycheck or null.
 */
export async function voidPaycheck(p: VoidTarget): Promise<Paycheck | null> {
  if (p.kind === 'ytd') {
    await alertBox('Year-to-date amounts are not voided. Change or delete them with Enter Year-to-Date Amounts.', 'Void Paycheck');
    return null;
  }
  const ok = await showDialog<boolean>({ title: 'Void Paycheck', width: 500, cancelValue: false, render: (close) => <VoidBody p={p} close={close} /> });
  if (!ok) return null;
  try {
    const r = await api.post<Paycheck>(`/paychecks/${p.id}/void`);
    await invalidateAll();
    rememberPaycheck({ ...r });
    toast(`Paycheck to ${p.employeeName} voided`, { kind: 'success' });
    if (r.syncStatus === 'error') await showPostingProblems([{ entity: 'paycheck', id: r.id, label: `Paycheck - ${r.employeeName}`, code: 'error', message: r.syncError }], 'The paycheck is void in SerieX Payroll, but SerieX Books reported a problem:');
    return r;
  } catch (e) {
    await showError(e, 'Void Paycheck');
    return null;
  }
}

/** Deletes a paycheck after confirmation (DELETE /paychecks/{id}; the SerieX Books check is deleted first). */
export async function deletePaycheck(p: VoidTarget): Promise<boolean> {
  const what = p.kind === 'ytd' ? 'these year-to-date amounts' : 'this paycheck';
  const books = p.kind !== 'ytd' && p.syncStatus === 'posted' ? '\n\nThe check is also deleted from SerieX Books.' : '';
  if (!(await confirmBox(`Are you sure you want to delete ${what} (${p.employeeName}, ${fmtDate(p.checkDate)}, ${fmtMoney(p.net)})?${books}\n\nUsually a paycheck that was given to the employee should be voided instead.`, 'Delete Paycheck')))
    return false;
  try {
    await api.del(`/paychecks/${p.id}`);
    forgetRecent('paycheck', p.id);
    // the windows of the deleted paycheck close, and its record is not read again (it is gone)
    const mine = (q: { queryKey: readonly unknown[] }) => q.queryKey[0] === 'paycheck' && q.queryKey[1] === p.id;
    for (const w of useWindowStore.getState().windows) {
      if ((w.kind === 'paycheck' || w.kind === 'paycheckDetail') && w.props.id === p.id) void closeWindow(w.id, { force: true });
    }
    await queryClient.invalidateQueries({ predicate: (q) => !mine(q) });
    setTimeout(() => queryClient.removeQueries({ predicate: mine }), 0);
    toast(p.kind === 'ytd' ? 'Year-to-date amounts deleted' : `Paycheck to ${p.employeeName} deleted`, { kind: 'success' });
    return true;
  } catch (e) {
    await showError(e, 'Delete Paycheck');
    return false;
  }
}

/** Refreshes the cached paycheck data after a save. */
export function afterPaycheckSaved(pc: Paycheck): void {
  queryClient.setQueryData(['paycheck', pc.id], pc);
  void invalidateAll();
  rememberPaycheck(pc);
}
