// Check printing (voucher style: the check on top, two stubs below) for Write Checks and
// Print Checks, plus the "Did the checks print correctly?" confirmation that assigns numbers.
import { api, qs } from '@/api/client';
import { invalidateAll, queryClient } from '@/api/hooks';
import type { Account, CompanyInfo, ID, Item, Name, Txn, TxnListResult } from '@/api/types';
import { msgBox } from '@/components/dialogs';
import { formatAddress } from '@/components/inputs';
import { escHtml, printHtml } from '@/util/print';
import { fmtDate, fmtMoney } from '@/util/format';
import { amountInWordsPadded, fetchAccounts, nextCheckNumber } from './shared';

interface StubLine {
  account: string;
  memo: string;
  amount: number;
}

interface PrintableCheck {
  number: string;
  date: string;
  payee: string;
  address: string;
  amount: number;
  memo: string;
  bankName: string;
  lines: StubLine[];
}

async function fetchItems(): Promise<Item[]> {
  return queryClient.fetchQuery({ queryKey: ['items', { active: 'all' }], queryFn: () => api.get<Item[]>('/items?active=all'), staleTime: 30_000 });
}

async function fetchCompany(): Promise<CompanyInfo> {
  return queryClient.fetchQuery({ queryKey: ['company'], queryFn: () => api.get<CompanyInfo>('/company'), staleTime: 60_000 });
}

/** Builds the printable data of a check-like transaction (CHK, BILLPMT, TAXPMT, REFUND). */
async function toPrintable(t: Txn, number: string, accounts: Map<number, Account>, items: Map<number, Item>): Promise<PrintableCheck> {
  let address = t.billAddress;
  let payee = t.nameFull;
  if (t.nameId) {
    try {
      const n = await api.get<Name>(`/names/${t.nameId}`);
      payee = n.printOnCheckAs || n.companyName || n.fullName || n.name;
      if (!address) address = formatAddress(payee, n.billAddress);
    } catch {
      /* the name is optional on a printed check */
    }
  }
  const acctName = (id: number | null) => (id ? accounts.get(id)?.fullName ?? '' : '');
  let lines: StubLine[];
  if (t.type === 'BILLPMT' || t.type === 'REFUND') {
    lines = (t.links ?? []).map((l) => ({
      account: `${l.toRefNumber ? '#' + l.toRefNumber : ''} ${fmtDate(l.toDate)}`.trim(),
      memo: l.discount ? `Discount ${fmtMoney(l.discount)}` : '',
      amount: l.amount,
    }));
  } else {
    lines = t.lines.map((l) => ({
      account: l.itemId ? items.get(l.itemId)?.fullName ?? '' : acctName(l.accountId),
      memo: l.description,
      amount: l.amount,
    }));
  }
  return {
    number,
    date: t.date,
    payee,
    address: address || payee,
    amount: t.amount,
    memo: t.memo.replace(/^VOID: /, ''),
    bankName: acctName(t.accountId),
    lines,
  };
}

const CHECK_CSS = `
  @page { size: letter; margin: 0.35in; }
  .voucher { height: 10.2in; display: flex; flex-direction: column; page-break-after: always; }
  .voucher:last-child { page-break-after: auto; }
  .check { height: 3.4in; position: relative; padding: 0.2in 0.3in; border-bottom: 1px dashed #999; }
  .co { font-weight: bold; font-size: 12px; }
  .co-addr { font-size: 10px; white-space: pre-line; color: #333; }
  .ckno { position: absolute; right: 0.3in; top: 0.2in; font-size: 13px; font-weight: bold; }
  .date { position: absolute; right: 0.3in; top: 0.75in; font-size: 12px; }
  .payto { position: absolute; left: 0.3in; right: 0.3in; top: 1.15in; display: flex; align-items: baseline; gap: 8px; }
  .payto .lbl { font-size: 9px; width: 0.8in; line-height: 1.1; }
  .payto .name { flex: 1; border-bottom: 1px solid #000; font-size: 13px; padding-left: 4px; }
  .payto .amt { width: 1.6in; border: 1px solid #000; padding: 2px 6px; text-align: right; font-size: 13px; font-weight: bold; }
  .words { position: absolute; left: 0.3in; right: 0.3in; top: 1.6in; border-bottom: 1px solid #000; font-size: 12px; overflow: hidden; white-space: nowrap; }
  .words .dl { float: right; font-size: 9px; background: #fff; padding-left: 4px; }
  .addr { position: absolute; left: 1.1in; top: 1.95in; font-size: 12px; white-space: pre-line; line-height: 1.3; }
  .memo { position: absolute; left: 0.3in; bottom: 0.25in; font-size: 11px; }
  .sig { position: absolute; right: 0.3in; bottom: 0.25in; width: 2.6in; border-top: 1px solid #000; font-size: 9px; text-align: center; padding-top: 2px; }
  .stub { flex: 1; padding: 0.25in 0.3in; border-bottom: 1px dashed #999; font-size: 11px; }
  .stub:last-child { border-bottom: 0; }
  .stub-head { display: flex; justify-content: space-between; font-weight: bold; margin-bottom: 8px; }
  .stub table { width: 100%; }
  .stub table td { padding: 2px 4px; font-size: 11px; }
  .stub .tot td { border-top: 1px solid #000; font-weight: bold; }
`;

function checkHtml(c: PrintableCheck, co: CompanyInfo): string {
  const coAddr = [co.address1, co.address2, [co.city, [co.state, co.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join('\n');
  const stub = () => `
    <div class="stub">
      <div class="stub-head"><span>${escHtml(c.payee)}</span><span>${escHtml(fmtDate(c.date))}</span><span>${c.number ? 'No. ' + escHtml(c.number) : ''}</span></div>
      <table>
        ${c.lines.map((l) => `<tr><td>${escHtml(l.account)}</td><td>${escHtml(l.memo)}</td><td class="num">${fmtMoney(l.amount)}</td></tr>`).join('')}
        <tr class="tot"><td>${escHtml(c.bankName)}</td><td>${escHtml(c.memo)}</td><td class="num">${fmtMoney(c.amount)}</td></tr>
      </table>
    </div>`;
  return `
  <div class="voucher">
    <div class="check">
      <div class="co">${escHtml(co.name)}</div>
      <div class="co-addr">${escHtml(coAddr)}</div>
      <div class="ckno">${escHtml(c.number)}</div>
      <div class="date">${escHtml(fmtDate(c.date))}</div>
      <div class="payto"><span class="lbl">PAY TO THE ORDER OF</span><span class="name">${escHtml(c.payee)}</span><span class="amt">**${fmtMoney(c.amount)}</span></div>
      <div class="words">${escHtml(amountInWordsPadded(c.amount, 90))}<span class="dl">DOLLARS</span></div>
      <div class="addr">${escHtml(c.address)}</div>
      <div class="memo">MEMO ${escHtml(c.memo)}</div>
      <div class="sig">AUTHORIZED SIGNATURE</div>
    </div>
    ${stub()}
    ${stub()}
  </div>`;
}

/** Increments the numeric tail of a check number ("1009" → "1010", "A-9" → "A-10"). */
export function incNumber(n: string): string {
  const m = /^(.*?)(\d+)$/.exec(n.trim());
  if (!m) return n;
  const next = String(Number(m[2]) + 1).padStart(m[2].length, '0');
  return m[1] + next;
}

/** The numbers `count` checks get when the first one is `first` ("2283", 3 -> 2283, 2284, 2285). */
export function plannedNumbers(first: string, count: number): string[] {
  const out: string[] = [];
  let n = first.trim();
  for (let i = 0; i < count && n; i++) {
    out.push(n);
    n = incNumber(n);
  }
  return out;
}

/** Types whose number is a check number of the bank account (same rule as the server's duplicate check). */
const CHECK_NUMBER_TYPES = ['CHK', 'BILLPMT', 'REFUND', 'TAXPMT'];

/** The numbers of `numbers` already used by a check, bill payment, refund or tax payment of the bank account. */
export async function usedCheckNumbers(accountId: ID, numbers: string[]): Promise<string[]> {
  const found = await Promise.all(
    numbers.map(async (n) => {
      const r = await api.get<TxnListResult>('/txns' + qs({ types: CHECK_NUMBER_TYPES, accountId, ref: n, limit: 5 }));
      return r.rows.some((x) => x.accountId === accountId && !x.voided && x.refNumber.trim().toLowerCase() === n.toLowerCase()) ? n : null;
    }),
  );
  return found.filter((n): n is string => !!n);
}

function listText(items: string[]): string {
  if (items.length <= 1) return items.join('');
  const shown = items.slice(0, 5);
  const more = items.length - shown.length;
  return more ? `${shown.join(', ')} and ${more} more` : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/**
 * Before paper is used: compares the numbers the checks will get (first number + count) with the
 * check numbers already used in the account. When some are taken, offers to start at the next
 * free number, to keep the typed number, or to go back and change it. Resolves the first number to
 * print with, or null when the user wants to change it.
 */
export async function confirmCheckNumbers(accountId: ID, accountName: string, first: string, count: number): Promise<string | null> {
  const start = first.trim();
  if (!start || !count) return start;
  let used: string[];
  try {
    used = await usedCheckNumbers(accountId, plannedNumbers(start, count));
  } catch {
    return start; // the check is a convenience: print anyway
  }
  if (!used.length) return start;
  // the next free number: the server's next number, moved past any number already taken in the range
  let next = await nextCheckNumber(accountId);
  for (let i = 0; i < 5 && next; i++) {
    const taken = await usedCheckNumbers(accountId, plannedNumbers(next, count)).catch(() => []);
    if (!taken.length) break;
    next = incNumber(taken[taken.length - 1]);
  }
  const many = count > 1;
  const useNext = next && next !== start ? `Start at ${next}` : '';
  const keep = `Keep ${start}`;
  const r = await msgBox({
    title: 'Check Numbers Already Used',
    message:
      `Check number${used.length === 1 ? '' : 's'} ${listText(used)} ${used.length === 1 ? 'is' : 'are'} already used in ${accountName}. ` +
      `Printing ${many ? `these ${count} checks` : 'this check'} from ${start} would give two checks the same number.\n\n` +
      (useNext ? `Start at ${next} instead (the next unused number)?` : 'Change the first check number before you print.'),
    buttons: useNext ? [useNext, keep, 'Cancel'] : [keep, 'Cancel'],
    defaultButton: useNext || 'Cancel',
    cancelButton: 'Cancel',
    icon: 'warning',
  });
  if (r === useNext) return next;
  if (r === keep) return start;
  return null;
}

/**
 * Prints the given check-like transactions as vouchers. `firstNumber` numbers the checks that
 * are "to be printed" in order (the others keep their number). Returns the numbers used.
 */
export async function printCheckVouchers(txns: Txn[], firstNumber: string): Promise<string[]> {
  const [accts, items, co] = await Promise.all([fetchAccounts(), fetchItems(), fetchCompany()]);
  const accounts = new Map(accts.map((a) => [a.id, a]));
  const itemMap = new Map(items.map((i) => [i.id, i]));
  let next = firstNumber.trim();
  const numbers: string[] = [];
  const pages: string[] = [];
  for (const t of txns) {
    let num = t.refNumber;
    if (t.toBePrinted || !num) {
      num = next;
      next = next ? incNumber(next) : '';
    }
    numbers.push(num);
    pages.push(checkHtml(await toPrintable(t, num, accounts, itemMap), co));
  }
  await printHtml(txns.length === 1 ? 'Check' : 'Checks', pages.join(''), CHECK_CSS);
  return numbers;
}

/**
 * Asks whether the checks printed correctly; on Yes assigns the numbers (POST /mark-printed)
 * and clears "to be printed". Returns true when they were marked.
 */
export async function confirmPrinted(txnIds: number[], firstNumber: string): Promise<boolean> {
  if (!txnIds.length) return false;
  const many = txnIds.length > 1;
  const r = await msgBox({
    title: 'Print Checks - Confirmation',
    message: many
      ? `Did all ${txnIds.length} checks print correctly?\n\nYes assigns check numbers starting at ${firstNumber || 'the next number'} and removes them from the list of checks to print. No keeps them in the list so you can print them again.`
      : `Did the check print correctly?\n\nYes assigns check number ${firstNumber || 'the next number'} and removes it from the list of checks to print. No keeps it to print again.`,
    buttons: ['Yes', 'No'],
    icon: 'question',
  });
  if (r !== 'Yes') return false;
  await api.post('/mark-printed', { txnIds, firstNumber });
  void invalidateAll();
  return true;
}
