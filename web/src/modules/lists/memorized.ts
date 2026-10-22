// Memorized transactions: data hook, labels and "enter" actions shared by the Memorized
// Transaction List and the Memorize Transaction dialog.
import { useQuery } from '@tanstack/react-query';
import { api, getCompanyId } from '@/api/client';
import { invalidateAll } from '@/api/hooks';
import { TXN_TYPE_LABELS, type ID, type MemorizedFrequency, type MemorizedSchedule, type MemorizedTxn, type Txn } from '@/api/types';
import { alertBox, toast } from '@/components';
import { addDays, todayIso } from '@/util/dates';
import { fmtDate } from '@/util/format';
import { openTxn, openWindow } from '@/windows/windowStore';
import { errMessage, TXN_FORMS } from './common';

/** Memorized transactions (GET /memorized), key ['memorized']. */
export function useMemorized() {
  return useQuery({
    queryKey: ['memorized'],
    queryFn: ({ signal }) => api.get<MemorizedTxn[]>('/memorized', { signal }),
    enabled: !!getCompanyId(),
  });
}

export const FREQUENCIES: { value: MemorizedFrequency; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Every two weeks' },
  { value: 'semimonthly', label: 'Twice a month' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'semiannually', label: 'Twice a year' },
  { value: 'annually', label: 'Annually' },
];

export const frequencyLabel = (f: MemorizedFrequency) => FREQUENCIES.find((x) => x.value === f)?.label ?? f;

export const SCHEDULE_LABEL: Record<MemorizedSchedule, string> = {
  remind: 'Remind me',
  none: "Don't remind me",
  auto: 'Enter automatically',
};

/**
 * True when the next scheduled transaction is due: its date is today or earlier, or within its
 * "days in advance" window (the same rule the server uses for reminders and automatic entry).
 */
export function isDue(m: MemorizedTxn, today = todayIso()): boolean {
  if (m.schedule === 'none' || !m.nextDate || (m.remaining !== null && m.remaining <= 0)) return false;
  return m.nextDate <= addDays(today, Math.max(0, Math.round(m.daysInAdvance || 0)));
}

/** Plain name of the type ("Bill", "Check"...). */
export const typeLabel = (m: Pick<MemorizedTxn, 'txnType'>) => TXN_TYPE_LABELS[m.txnType] ?? m.txnType;

/** Saves one transaction from the memorized template now (POST /memorized/{id}/enter). */
export async function enterNow(m: MemorizedTxn, date?: string): Promise<boolean> {
  try {
    const r = await api.post<{ txnId: ID; nextDate?: string }>(`/memorized/${m.id}/enter`, date ? { date } : {});
    await invalidateAll();
    toast(`${typeLabel(m)} "${m.name}" entered${r.nextDate ? ` · next on ${fmtDate(r.nextDate)}` : ''}`, {
      action: { label: 'Open', onClick: () => openTxn(m.txnType, r.txnId) },
    });
    return true;
  } catch (e) {
    const msg = errMessage(e);
    if (msg) await alertBox(msg, 'Warning');
    return false;
  }
}

/**
 * "Enter Transaction": opens the transaction form filled from the memorized template. When the
 * scheduled transaction is due (see {@link isDue}) the form is dated on its scheduled date and
 * gets `memorizedId`, so saving it moves the schedule to the next date (and the reminder goes
 * away); otherwise it is an extra one dated today and the schedule is left alone. Types whose
 * window cannot start from a template (bill payments, sales tax payments, statement charges) are
 * saved directly instead.
 */
export async function enterTransaction(m: MemorizedTxn): Promise<void> {
  const form = TXN_FORMS[m.txnType];
  const today = todayIso();
  const scheduled = isDue(m, today);
  const date = scheduled ? m.nextDate : today;
  if (!form || form.needsId) {
    await enterNow(m, date);
    return;
  }
  try {
    const t = await api.get<Txn>(`/memorized/${m.id}/template?date=${date}`);
    const extra: Record<string, unknown> = { ...(form.props ?? {}), template: t };
    if (scheduled) extra.memorizedId = m.id;
    openWindow(form.kind, extra);
  } catch (e) {
    const msg = errMessage(e);
    if (msg) await alertBox(msg, 'Warning');
  }
}

/**
 * "Enter Transaction" for a memorized transaction known by id (e.g. a Reminders entry): opens
 * its form filled and dated as {@link enterTransaction} does. Resolves false when it no longer exists.
 */
export async function enterMemorizedById(id: ID): Promise<boolean> {
  try {
    const list = await api.get<MemorizedTxn[]>('/memorized');
    const m = list.find((x) => x.id === id);
    if (!m) {
      await alertBox('This memorized transaction no longer exists. It may have been deleted.', 'Warning');
      return false;
    }
    await enterTransaction(m);
    return true;
  } catch (e) {
    const msg = errMessage(e);
    if (msg) await alertBox(msg, 'Warning');
    return false;
  }
}
