// Shared helpers of the banking module (checks, deposits, registers, reconcile, bank feeds).
import { useMemo } from 'react';
import { api, qs } from '@/api/client';
import { DEFAULT_PREFS, queryClient, useAccounts } from '@/api/hooks';
import { DEBIT_NORMAL_TYPES, type Account, type AccountType, type ID, type Prefs, type Txn, type TxnLine } from '@/api/types';
import { fmtMoney, localIso, round2 } from '@/util/format';
import { isEmptyLine } from '@/forms';

/** Balance sheet types a register / reconcile / transfer can use (not A/R or A/P). */
export const TRANSFER_TYPES: AccountType[] = [
  'Bank',
  'Other Current Asset',
  'Fixed Asset',
  'Other Asset',
  'Credit Card',
  'Other Current Liability',
  'Long Term Liability',
  'Equity',
];

/** Account types that have a register (every balance sheet type). */
export const REGISTER_TYPES: AccountType[] = [
  'Bank',
  'Accounts Receivable',
  'Other Current Asset',
  'Fixed Asset',
  'Other Asset',
  'Accounts Payable',
  'Credit Card',
  'Other Current Liability',
  'Long Term Liability',
  'Equity',
];

/** Types allowed on expense / deposit lines (the server rejects A/R, A/P and non-posting). */
export const LINE_EXCLUDED_TYPES: AccountType[] = ['Accounts Receivable', 'Accounts Payable', 'Non-Posting'];

/** True when the account's balance grows with debits (banks, assets, expenses). */
export function isDebitNormal(type: AccountType | string | undefined): boolean {
  return !!type && DEBIT_NORMAL_TYPES.includes(type as AccountType);
}

/** Broad register family of an account type. */
export type RegisterKind = 'bank' | 'cc' | 'ar' | 'ap' | 'other';

export function registerKind(type: AccountType | string | undefined): RegisterKind {
  switch (type) {
    case 'Bank':
      return 'bank';
    case 'Credit Card':
      return 'cc';
    case 'Accounts Receivable':
      return 'ar';
    case 'Accounts Payable':
      return 'ap';
    default:
      return 'other';
  }
}

/** The Undeposited Funds account (special flag) of a chart of accounts. */
export function findUndeposited(accounts: readonly Account[] | undefined): Account | undefined {
  return accounts?.find((a) => a.special === 'UndepositedFunds');
}

/** Accounts of some types, active only, in chart order (cached query). */
export function useAccountsOfTypes(types: AccountType[]) {
  const { data, isLoading } = useAccounts({ active: 'all' });
  const list = useMemo(() => (data ?? []).filter((a) => types.includes(a.type)), [data, types]);
  return { all: data, list, active: list.filter((a) => a.active), loading: isLoading };
}

/** Fetches (or reads from the cache) every account; used by async "new form" builders. */
export function fetchAccounts(): Promise<Account[]> {
  return queryClient.fetchQuery({
    queryKey: ['accounts', { active: 'all' }],
    queryFn: () => api.get<Account[]>('/accounts?active=all'),
    staleTime: 30_000,
  });
}

/** First active account of a type (or of any of the types), in chart order. */
export function firstOfType(accounts: readonly Account[], types: AccountType[], exclude?: (a: Account) => boolean): Account | undefined {
  return accounts.find((a) => a.active && types.includes(a.type) && !(exclude && exclude(a)));
}

/** Picks a default account id: the wanted one when it exists and has an allowed type, else the first of the types. */
export function pickAccount(accounts: readonly Account[], wanted: ID | null | undefined, types: AccountType[], exclude?: (a: Account) => boolean): ID | null {
  if (wanted) {
    const a = accounts.find((x) => x.id === wanted);
    if (a && types.includes(a.type) && !(exclude && exclude(a))) return a.id;
  }
  return firstOfType(accounts, types, exclude)?.id ?? null;
}

/** Next check number of a bank account (same rule as the server's auto number). */
export async function nextCheckNumber(accountId: ID | null | undefined): Promise<string> {
  if (!accountId) return '';
  try {
    const r = await api.get<{ refNumber: string }>('/next-ref' + qs({ type: 'CHK', accountId }));
    return r.refNumber ?? '';
  } catch {
    return '';
  }
}

/** Sum of the amounts of the expense and item lines (the total of a check / charge). */
export function linesTotal(lines: TxnLine[]): number {
  return round2(lines.filter((l) => l.kind === 'expense' || l.kind === 'item').reduce((s, l) => s + (l.amount || 0), 0));
}

/**
 * Applies a new total typed in the amount field of a check / credit card charge: with no lines, one expense line gets the amount; with a single expense line, that
 * line changes; otherwise the difference goes to a new expense line at the end.
 */
export function applyTotal(lines: TxnLine[], total: number, makeLine: () => TxnLine): TxnLine[] {
  const real = lines.filter((l) => (l.kind === 'expense' || l.kind === 'item') && (!isEmptyLine(l) || (l.kind === 'expense' && l.accountId !== null)));
  const others = lines.filter((l) => l.kind !== 'expense' && l.kind !== 'item');
  const items = real.filter((l) => l.kind === 'item');
  const withAmount = real.filter((l) => l.kind === 'expense' && l.amount);
  const cur = linesTotal(real);
  const diff = round2(total - cur);
  if (diff === 0) return lines;
  if (!items.length && withAmount.length <= 1) {
    // the line that has the amount, else the first pre-filled account line, else a new line
    const target = withAmount[0] ?? real.find((l) => l.kind === 'expense') ?? makeLine();
    const rest = real.filter((l) => l !== target);
    return renumber([{ ...target, amount: round2(total) }, ...rest, ...others]);
  }
  return renumber([...real, { ...makeLine(), amount: diff }, ...others]);
}

function renumber(lines: TxnLine[]): TxnLine[] {
  return lines.map((l, i) => (l.seq === i + 1 ? l : { ...l, seq: i + 1 }));
}

/** A new transaction built from `props.template` (memorized transactions, Create a Copy). */
export function fromTemplate(template: Txn | undefined | null, date: string): Txn | null {
  if (!template) return null;
  return {
    ...template,
    id: 0,
    date: template.date || date,
    voided: false,
    status: '',
    cleared: '',
    links: [],
    linked: [],
    lines: (template.lines ?? []).map((l, i) => ({ ...l, id: 0, seq: i + 1 })),
  };
}

// ---------------------------------------------------------------------------
// Amount in words ("One thousand two hundred thirty-four and 56/100")

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];

function under1000(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h) parts.push(`${ONES[h]} hundred`);
  if (r) {
    if (r < 20) parts.push(ONES[r]);
    else parts.push(TENS[Math.floor(r / 10)] + (r % 10 ? '-' + ONES[r % 10] : ''));
  }
  return parts.join(' ');
}

/** Dollar amount in words as printed on checks: "One thousand two hundred and 00/100". */
export function amountInWords(amount: number): string {
  const cents = Math.round(Math.abs(round2(amount)) * 100);
  let dollars = Math.floor(cents / 100);
  const c = cents % 100;
  let words: string;
  if (dollars === 0) words = 'zero';
  else {
    const groups: string[] = [];
    let i = 0;
    while (dollars > 0 && i < SCALES.length) {
      const g = dollars % 1000;
      if (g) groups.unshift(under1000(g) + (SCALES[i] ? ' ' + SCALES[i] : ''));
      dollars = Math.floor(dollars / 1000);
      i++;
    }
    words = groups.join(' ');
  }
  const text = `${words} and ${String(c).padStart(2, '0')}/100`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Amount in words padded with asterisks like a printed check line. */
export function amountInWordsPadded(amount: number, width = 80): string {
  const w = amountInWords(amount);
  return w.length >= width ? w : w + '*'.repeat(width - w.length);
}

/**
 * Puts the cursor in a field of a form that just finished loading (a new check, charge or
 * transfer), so typing goes there. Waits (a few frames) until the field exists and is enabled,
 * and leaves the focus alone when the user already clicked into another field meanwhile.
 */
export function focusWhenReady(find: () => HTMLElement | null, frames = 30): void {
  const attempt = (left: number) => {
    const el = find();
    const input = el && (el.matches('input, textarea, select') ? el : el.querySelector<HTMLElement>('input, textarea, select'));
    const ae = document.activeElement as HTMLElement | null;
    // the user is already typing somewhere else (another window, a message box, global search);
    // a field of this same form (Save & New pressed from the memo) does not count
    const frame = input?.closest('[data-window-id]');
    if (ae && ae !== input && ae.matches('input, textarea, select, [contenteditable="true"]') && !(frame && frame.contains(ae))) return;
    if (input && !(input as HTMLInputElement).disabled && input.isConnected) {
      input.focus({ preventScroll: true });
      if (document.activeElement === input) {
        if (input instanceof HTMLInputElement) input.select();
        return;
      }
    }
    if (left > 0) requestAnimationFrame(() => attempt(left - 1));
  };
  requestAnimationFrame(() => attempt(frames));
}

/** Today's date in the browser (ISO). */
export { todayIso } from '@/util/dates';

/** Company preferences with defaults (cached query), for async "new form" builders. */
export async function fetchPrefs(): Promise<Prefs> {
  try {
    const p = await queryClient.fetchQuery({ queryKey: ['prefs'], queryFn: () => api.get<Prefs>('/prefs'), staleTime: 5 * 60_000 });
    return { ...DEFAULT_PREFS, ...p };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Local calendar day (ISO) of an RFC3339 timestamp ("2026-10-18T02:39:45Z" → "2026-10-17" in UTC-7). */
export function localDay(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts.slice(0, 10) : localIso(d);
}

/** "1 check", "3 checks" (the plural defaults to singular + "s"). */
export function plural(n: number, singular: string, pluralForm = singular + 's'): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

/** The verb form that agrees with a count: verbFor(1, 'needs', 'need') -> "needs". */
export function verbFor(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Dollar amount with the sign before the dollar sign: "-$5.00", "$1,234.56". */
export function dollars(n: number): string {
  const v = round2(n);
  return (v < 0 ? '-$' : '$') + fmtMoneyAbs(v);
}
function fmtMoneyAbs(v: number): string {
  return fmtMoney(Math.abs(v));
}
