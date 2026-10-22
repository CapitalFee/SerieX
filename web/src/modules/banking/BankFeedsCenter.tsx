// Bank Imports: bank and credit card accounts with the number of
// downloaded transactions to review; import a bank download file (OFX, QFX, QBO) or a CSV file; tabs For review /
// Categorized / Excluded; each row shows the bank description, the suggested payee and category
// (from rules or earlier choices) or the register transaction it matches, with Add / Match.
// Click a row to edit it inline (payee, category, class, memo, ref no., split into several
// lines), Exclude it or create a rule from it. Select several rows and Accept them at once.
// Categorized and excluded rows can be undone. When adds and matches bring new suggested rules (patterns
// classified the same way several times), a note above the list points to Bank Rules.
import { Fragment, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, CircleCheck, CreditCard, FileUp, Landmark, Lightbulb, Link2, ListFilter, Plus, Split, Trash2, Undo2, Wand2, X } from 'lucide-react';
import { api, getCompanyId, type ApiError } from '@/api/client';
import { invalidateAll, queryClient, useAccountsById, useNames, usePrefValues } from '@/api/hooks';
import { emptyLine, emptyTxn, type Account, type BankFeedAdd, type BankFeedImportResult, type BankFeedItem, type BankFeedMatch, type ID, type Txn, type TxnType } from '@/api/types';
import {
  AccountPicker,
  Button,
  Checkbox,
  ClassPicker,
  EmptyState,
  MoneyField,
  NamePicker,
  SearchBox,
  SegmentedControl,
  Select,
  Spinner,
  StatusPill,
  Tabs,
  statusTone,
  TextField,
  msgBox,
  showDialog,
} from '@/components';
import { longDate } from '@/util/dates';
import { fmtDate, fmtMoney, round2 } from '@/util/format';
import { openTxn, openWindow } from '@/windows/windowStore';
import { useWindow } from '@/windows/WindowContext';
import { editBankRule } from './bankRuleDialog';
import { loadRuleSuggestions, useRuleSuggestions } from './ruleSuggestions';
import { LINE_EXCLUDED_TYPES, localDay, plural, verbFor } from './shared';
import './banking.css';

export interface BankFeedsCenterProps {
  accountId?: number;
  /** Opened from the Banking menu import entry: show the import step first. */
  importFile?: boolean;
}

interface FeedAccount {
  accountId: ID;
  accountName: string;
  accountType: string;
  newCount: number;
  lastImport: string;
  /** How the last CSV file's numeric dates were read for this account ('' = nothing saved; absent on older servers). */
  dateOrder?: '' | 'mdy' | 'dmy';
  /** The saved "Flip signs" choice of the account (absent on older servers). */
  flipSigns?: boolean;
}

interface SplitLine {
  key: number;
  accountId: ID | null;
  amount: number;
  memo: string;
}

interface Draft {
  mode: 'add' | 'match';
  matchTxnId: ID | null;
  nameId: ID | null;
  accountId: ID | null;
  classId: ID | null;
  memo: string;
  refNumber: string;
  split: SplitLine[] | null;
}

type Tab = 'review' | 'categorized' | 'excluded';

interface Notice {
  kind: 'success' | 'info' | 'error';
  text: string;
  viewTxnId?: ID;
  undoIds?: ID[];
  rule?: { it: BankFeedItem; d: Draft };
}

let splitSeq = 1;

function initialDraft(it: BankFeedItem): Draft {
  return {
    mode: it.matches.length ? 'match' : 'add',
    matchTxnId: it.matches[0]?.txnId ?? null,
    nameId: it.suggestedNameId,
    accountId: it.suggestedAccountId,
    classId: null,
    memo: '',
    refNumber: it.checkNumber,
    split: null,
  };
}

/** The words that identify a merchant in a bank description (for rule suggestions). */
function ruleKey(desc: string): string {
  return desc
    .toUpperCase()
    .split(/\s+/)
    .filter((w) => /^[A-Z&'.-]{2,}$/.test(w) && !['ACH', 'DEBIT', 'POS', 'PURCHASE', 'CARD', 'ONLINE', 'PAYMENT'].includes(w))
    .slice(0, 2)
    .join(' ');
}

const matchLabel = (m: BankFeedMatch) => `${m.typeLabel}${m.refNumber ? ' ' + m.refNumber : ''}`;


// ---------------------------------------------------------------------------
// Reading a bank file before it is sent (only to show what it holds: the server does the import)

interface PeekRow {
  date: string;
  description: string;
  amount: number; // + money in, - money out (as the file says, before any sign flip)
}

interface FilePeek {
  format: 'ofx' | 'csv';
  /** Account number in an OFX / QFX / QBO file (<ACCTID>), '' when none. */
  acctId: string;
  /** Transactions found (CSV: data rows with a date and an amount). */
  count: number;
  /** First rows of a CSV file. */
  rows: PeekRow[];
  /**
   * CSV dates written with numbers (10/03/2026): 'dmy' when a first part is above 12 somewhere
   * (day first), 'mdy' when a second part is, 'either' when every date reads both ways (the user
   * chooses); '' when the dates are not like that (2026-10-03, Oct 3 2026).
   */
  numericDates: '' | 'mdy' | 'dmy' | 'either';
  /**
   * CSV whose rows say which way the money went: separate Debit and Credit columns, or an Amount
   * column with a Debit/Credit type column. Flipping the signs does not apply (the server ignores it).
   */
  signsInFile: boolean;
}

/** Values of a CSV Type column that say which way the money went (as the server reads them). */
const SIGN_INDICATORS = new Set(['debit', 'dr', 'd', 'withdrawal', 'credit', 'cr', 'c', 'deposit']);

const NUMERIC_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:\D|$)/;

/** ISO date of a numeric CSV date read in the given order ('' when it is not one). */
function numericDateIso(text: string, order: 'mdy' | 'dmy'): string {
  const m = NUMERIC_DATE.exec(text.trim());
  if (!m) return '';
  const [a, b] = [Number(m[1]), Number(m[2])];
  const [mo, d] = order === 'mdy' ? [a, b] : [b, a];
  let y = Number(m[3]);
  if (m[3].length === 2) y += y < 70 ? 2000 : 1900;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Money text of a bank file: "1,234.56", "-45.00", "$45.00", "(45.00)", "45.00-", "45.00 DR", "45,00". */
function peekMoney(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  let neg = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    neg = true;
    s = s.slice(1, -1).trim();
  }
  if (/CR$/i.test(s)) s = s.slice(0, -2).trim();
  else if (/DR$/i.test(s)) {
    neg = !neg;
    s = s.slice(0, -2).trim();
  }
  if (s.endsWith('-')) {
    neg = !neg;
    s = s.slice(0, -1).trim();
  }
  s = s.replace(/[$\s]|USD/gi, '');
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if ((s.match(/,/g) ?? []).length === 1 && s.length - s.indexOf(',') === 3) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  if (!s || !Number.isFinite(n)) return null;
  return round2(neg ? -n : n);
}

const normHead = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** What a bank file holds (format, account number, number of rows, first rows), read in the browser. */
function peekBankFile(text: string): FilePeek {
  const body = text.replace(/^\uFEFF/, '');
  if (/<OFX>|OFXHEADER/i.test(body.slice(0, 4000))) {
    const acct = /<ACCTID>\s*([^<\s]+)/i.exec(body);
    return { format: 'ofx', acctId: acct ? acct[1].trim() : '', count: (body.match(/<STMTTRN>/gi) ?? []).length, rows: [], numericDates: '', signsInFile: false };
  }
  const lines = body.split(/\r?\n/);
  const first = lines[0] ?? '';
  const count = (c: string) => first.split(c).length - 1;
  let delim = count(';') > count(',') ? ';' : ',';
  if (count('\t') > count(delim)) delim = '\t';
  const find = (heads: string[], names: string[]) => {
    for (const n of names) {
      const i = heads.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  for (let h = 0; h < Math.min(lines.length, 20); h++) {
    const heads = splitCsvLine(lines[h], delim).map(normHead);
    let date = find(heads, ['date', 'transaction date', 'trans date', 'posted date', 'posting date', 'post date', 'effective date', 'booking date', 'value date']);
    if (date < 0) date = heads.findIndex((x) => x.includes('date'));
    const amount = find(heads, ['amount', 'transaction amount', 'amount usd', 'net amount']);
    const debit = find(heads, ['debit', 'debits', 'debit amount', 'amount debit', 'withdrawal', 'withdrawals', 'withdrawal amount', 'money out', 'paid out', 'outflow', 'charge', 'charges']);
    const credit = find(heads, ['credit', 'credits', 'credit amount', 'amount credit', 'deposit', 'deposits', 'deposit amount', 'money in', 'paid in', 'inflow', 'payment', 'payments']);
    if (date < 0 || (amount < 0 && debit < 0 && credit < 0)) continue;
    let desc = find(heads, ['description', 'payee', 'name', 'transaction description', 'payee name', 'merchant', 'merchant name', 'details', 'transaction details', 'original description', 'narrative']);
    if (desc < 0) desc = find(heads, ['memo', 'notes', 'note', 'reference', 'additional info']);
    const typ = find(heads, ['type', 'transaction type', 'debit credit', 'dr cr', 'cr dr', 'credit debit']);
    const rows: PeekRow[] = [];
    let n = 0;
    let numeric = true;
    let dayFirst = false;
    let monthFirst = false;
    // no Amount column (Debit / Credit columns), or a type column with Debit/Credit values
    let signsInFile = amount < 0;
    for (const line of lines.slice(h + 1)) {
      if (!line.trim()) continue;
      const c = splitCsvLine(line, delim);
      const cell = (i: number) => (i >= 0 ? c[i] ?? '' : '');
      if (typ >= 0 && SIGN_INDICATORS.has(cell(typ).toLowerCase())) signsInFile = true;
      let amt: number | null;
      if (amount >= 0) {
        amt = peekMoney(cell(amount));
        if (amt !== null && amt > 0 && ['debit', 'dr', 'd', 'withdrawal'].includes(cell(typ).toLowerCase())) amt = -amt;
      } else {
        const d = peekMoney(cell(debit));
        const cr = peekMoney(cell(credit));
        amt = d === null && cr === null ? null : round2(Math.abs(cr ?? 0) - Math.abs(d ?? 0));
      }
      const dm = NUMERIC_DATE.exec(cell(date));
      // rows the server cannot read either (no date, no amount) are not counted
      if (!cell(date) || amt === null || (!dm && Number.isNaN(Date.parse(cell(date))))) continue;
      n++;
      if (!dm) numeric = false;
      else if (Number(dm[1]) > 12) dayFirst = true;
      else if (Number(dm[2]) > 12) monthFirst = true;
      if (rows.length < 5) rows.push({ date: cell(date), description: cell(desc), amount: amt });
    }
    return { format: 'csv', acctId: '', count: n, rows, numericDates: n && numeric ? (dayFirst ? 'dmy' : monthFirst ? 'mdy' : 'either') : '', signsInFile };
  }
  return { format: 'csv', acctId: '', count: 0, rows: [], numericDates: '', signsInFile: false };
}

/** The account whose bank account number matches a file's ACCTID (whole number, or its last 4 digits). */
function accountForNumber(acctId: string, candidates: Account[]): Account | undefined {
  const digits = (x: string) => x.replace(/\D/g, '');
  const want = digits(acctId);
  if (!want) return undefined;
  return candidates.find((a) => digits(a.bankAcctNumber) === want) ?? (want.length >= 4 ? candidates.find((a) => digits(a.bankAcctNumber).length >= 4 && digits(a.bankAcctNumber).slice(-4) === want.slice(-4)) : undefined);
}

const lastDigits = (acctId: string) => (acctId.length > 4 ? '…' + acctId.slice(-4) : acctId);

const FLIP_KEY = 'sx.bk.flipSigns.';
/** The "Flip signs" choice of an account: this browser's, else the one the server keeps, else off. */
function readFlip(accountId: ID | null, saved?: boolean): boolean {
  if (!accountId) return false;
  try {
    const v = localStorage.getItem(FLIP_KEY + accountId);
    if (v === '1' || v === '0') return v === '1';
  } catch {
    /* no storage: use the server's */
  }
  return saved ?? false;
}
function saveFlip(accountId: ID, on: boolean) {
  try {
    localStorage.setItem(FLIP_KEY + accountId, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

const ANNOUNCED_KEY = 'sx.bk.announcedRuleSuggestions.';
/** Keys of the suggested rules already announced here (this browser, the open company). */
function readAnnounced(): string[] {
  try {
    return JSON.parse(localStorage.getItem(ANNOUNCED_KEY + getCompanyId()) ?? '[]') as string[];
  } catch {
    return [];
  }
}
function saveAnnounced(keys: string[]) {
  try {
    localStorage.setItem(ANNOUNCED_KEY + getCompanyId(), JSON.stringify([...readAnnounced(), ...keys].slice(-500)));
  } catch {
    /* ignore */
  }
}

interface ImportChoice {
  accountId: ID;
  /** CSV into a credit card: reverse the signs (sent as "1" / "0"); null: not asked. */
  flipSigns: boolean | null;
  /** CSV with numeric dates: how to read them (the user's choice, or the order the dates show); '' = let the server decide. */
  dateOrder: '' | 'mdy' | 'dmy';
}

interface ImportDialogProps {
  fileName: string;
  peek: FilePeek | null;
  feedAccounts: FeedAccount[];
  accounts: Map<ID, Account>;
  initial: ID | null;
  /** The account matching the file's account number (ACCTID). */
  matched: Account | undefined;
  onDone: (v: ImportChoice | null) => void;
}

/** "Import Bank File": which account the file goes into (and, for a card CSV, which sign is a charge). */
function ImportDialog({ fileName, peek, feedAccounts, accounts, initial, matched, onDone }: ImportDialogProps) {
  const feedOf = (id: ID | null) => feedAccounts.find((a) => a.accountId === id);
  const [target, setTarget] = useState<ID | null>(initial);
  const [flip, setFlip] = useState(() => readFlip(initial, feedOf(initial)?.flipSigns));
  // dates that read both ways (03/04/2026): the user says which, starting from the order chosen for the
  // account's last file; otherwise the file itself tells
  const savedOrder = (id: ID | null): 'mdy' | 'dmy' => (feedOf(id)?.dateOrder === 'dmy' ? 'dmy' : 'mdy');
  const [order, setOrder] = useState<'mdy' | 'dmy'>(() => (peek?.numericDates === 'dmy' ? 'dmy' : peek?.numericDates === 'mdy' ? 'mdy' : savedOrder(initial)));
  const [orderTouched, setOrderTouched] = useState(false);
  const askOrder = peek?.numericDates === 'either';
  const feedIds = useMemo(() => new Set(feedAccounts.map((a) => a.accountId)), [feedAccounts]);
  const acct = feedOf(target);
  const isCC = acct?.accountType === 'Credit Card';
  const csv = peek?.format === 'csv';
  // a file with Debit / Credit columns already says which way the money went: no flip to choose
  const showFlip = csv && isCC && !peek?.signsInFile;
  const sign = showFlip && flip ? -1 : 1;
  const name = acct?.accountName ?? 'the account';
  return (
    <div className="bk-dlg" style={{ width: 600 }}>
      <div className="bk-dlg-body">
        <p className="bk-dlg-intro">
          <b>{fileName}</b>
          {peek ? ` · ${peek.format === 'ofx' ? 'Bank download file (OFX)' : 'CSV file'}${peek.count ? ` · ${plural(peek.count, 'transaction')}` : ''}` : ''}
          {peek?.acctId ? ` · for account ${lastDigits(peek.acctId)}${matched ? ` (${matched.fullName})` : ''}` : ''}
        </p>
        <div className="bk-imp-target">
          <label className="bk-imp-target-label" htmlFor="bk-imp-acct">
            Import into
          </label>
          <AccountPicker
            id="bk-imp-acct"
            name="importAccount"
            types={['Bank', 'Credit Card']}
            filter={(a) => feedIds.has(a.id)}
            value={target}
            onChange={(id) => {
              setTarget(id);
              setFlip(readFlip(id, feedOf(id)?.flipSigns));
              if (askOrder && !orderTouched) setOrder(savedOrder(id));
            }}
            addNew={false}
            width={300}
            autoFocus
          />
        </div>
        {peek?.acctId && matched && target !== matched.id && (
          <p className="bk-warn-text bk-imp-warn">
            This file is for account {lastDigits(peek.acctId)} ({matched.fullName}), not {accounts.get(target ?? 0)?.fullName ?? 'this account'}.
          </p>
        )}
        {csv && peek && peek.rows.length > 0 && (
          <>
            <div className="bk-imp-preview" role="table" aria-label="First rows of the file">
              <div className="bk-imp-row bk-imp-head" role="row">
                <span role="columnheader">Date</span>
                <span role="columnheader">Description</span>
                <span role="columnheader" className="bk-num">
                  Spent
                </span>
                <span role="columnheader" className="bk-num">
                  Received
                </span>
              </div>
              {peek.rows.map((r, i) => {
                const v = r.amount * sign;
                const iso = peek.numericDates ? numericDateIso(r.date, order) : '';
                return (
                  <div key={i} className="bk-imp-row" role="row">
                    <span role="cell" title={iso ? `Read as ${longDate(iso)} (the file says ${r.date})` : r.date}>
                      {iso ? fmtDate(iso) : r.date}
                    </span>
                    <span role="cell" title={r.description}>
                      {r.description}
                    </span>
                    <span role="cell" className="bk-num">
                      {v < 0 ? fmtMoney(-v) : ''}
                    </span>
                    <span role="cell" className="bk-num">
                      {v > 0 ? fmtMoney(v) : ''}
                    </span>
                  </div>
                );
              })}
            </div>
            {askOrder && (
              <div className="bk-imp-order">
                <label className="sx-label-plain" htmlFor="bk-imp-order">
                  Dates in this file are
                </label>
                <Select
                  id="bk-imp-order"
                  value={order}
                  width={250}
                  onChange={(v) => {
                    setOrder(v as 'mdy' | 'dmy');
                    setOrderTouched(true);
                  }}
                  options={[
                    { value: 'mdy', label: 'Month/day/year (10/03 = Oct 3)' },
                    { value: 'dmy', label: 'Day/month/year (10/03 = 10 Mar)' },
                  ]}
                />
              </div>
            )}
            {showFlip ? (
              <Checkbox
                checked={flip}
                onChange={setFlip}
                label="Flip signs: this file lists the card's charges as positive amounts"
                title="Purchases on the card must show under Spent, payments under Received. The choice is remembered for this account."
              />
            ) : (
              <p className="bk-muted bk-imp-note">Money you spent shows under Spent, money you received under Received.</p>
            )}
          </>
        )}
      </div>
      <div className="sx-dlg-buttons">
        <Button label="Cancel" onClick={() => onDone(null)} />
        <Button
          variant="primary"
          label={`Import into ${name}`}
          disabled={!target}
          onClick={() => target && onDone({ accountId: target, flipSigns: showFlip ? flip : null, dateOrder: peek?.numericDates ? order : '' })}
        />
      </div>
    </div>
  );
}

/** Text after an import: how many came in, and the rows that could not be read. */
function importMessage(r: BankFeedImportResult, accountName: string): string {
  let text = `${plural(r.imported, 'transaction')} imported into ${accountName}${r.skipped ? ` (${r.skipped} already downloaded, skipped)` : ''}.`;
  const bad = r.invalid ?? r.problems?.length ?? 0;
  if (bad) {
    // "Row 4: the amount "N/A" could not be read" (row = the line of the file)
    const list = (r.problems ?? []).slice(0, 5).map((p) => `Row ${p.row}: ${p.reason}`);
    const more = bad - list.length;
    text += ` ${plural(bad, 'row')} could not be read${list.length ? `: ${list.join('; ')}${more > 0 ? `; and ${more} more` : ''}` : ''}.`;
  }
  return r.imported ? text + ' Review them below.' : text;
}

export default function BankFeedsCenter(props: BankFeedsCenterProps) {
  const win = useWindow();
  const prefs = usePrefValues();
  const accounts = useAccountsById();
  const { data: names } = useNames(undefined, { active: 'all' });
  const { data: feedAccounts, isLoading: loadingAccounts } = useQuery({ queryKey: ['bank-feed-accounts'], queryFn: () => api.get<FeedAccount[]>('/bank-feeds/accounts'), staleTime: 0 });
  const [accountId, setAccountId] = useState<ID | null>(props.accountId ?? null);
  const { data: items, isLoading: loadingItems, isFetching } = useQuery({
    queryKey: ['bank-feed-items', accountId ?? 0],
    queryFn: () => api.get<BankFeedItem[]>(`/bank-feeds/${accountId}/items?status=all`),
    enabled: !!accountId,
    staleTime: 0,
  });
  const [tab, setTab] = useState<Tab>('review');
  const [search, setSearch] = useState('');
  const [checked, setChecked] = useState<Set<ID>>(new Set());
  const [expanded, setExpanded] = useState<ID | null>(null);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [busy, setBusy] = useState<ID | 'bulk' | 'import' | null>(null);
  const [showImport, setShowImport] = useState(!!props.importFile);
  const [dragOver, setDragOver] = useState(false);
  /** Result of the last action, shown above the list (toasts would cover the row buttons). */
  const [notice, setNotice] = useState<Notice | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Working them out takes a while on a big company file, so they are not refreshed after every
  // change here: loaded when the window opens and again after adds and matches.
  const { data: suggestions } = useRuleSuggestions({ live: false });
  /** Suggested rules not to announce: the ones there when the window opened, and the ones announced. */
  const knownSuggestions = useRef<Set<string> | null>(null);
  /** Suggested rules the last adds and matches brought (keys), until the note is closed. */
  const [newSuggestions, setNewSuggestions] = useState<string[]>([]);
  const announceTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    let open = true;
    // a fresh list, not the one kept from an earlier window (it can miss suggestions made since)
    loadRuleSuggestions()
      .then((list) => {
        if (open && !knownSuggestions.current) knownSuggestions.current = new Set([...readAnnounced(), ...list.map((s) => s.key)]);
      })
      .catch(() => undefined);
    return () => {
      open = false;
      window.clearTimeout(announceTimer.current);
    };
  }, []);

  useEffect(() => {
    win.setTitle('Bank Imports');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // default account: the given one, else the first with transactions to review
  useEffect(() => {
    if (accountId || !feedAccounts?.length) return;
    setAccountId((feedAccounts.find((a) => a.newCount > 0) ?? feedAccounts[0]).accountId);
  }, [feedAccounts, accountId]);
  useEffect(() => {
    if (props.accountId) setAccountId(props.accountId);
  }, [props.accountId]);
  useEffect(() => {
    if (props.importFile) {
      setShowImport(true);
      // the menu click still counts as a user action, so the browser lets us open the picker
      setTimeout(() => fileRef.current?.click(), 50);
      // reset the request, so the next import from the menu (window still open) asks again
      openWindow('bankFeeds', { importFile: false });
    }
  }, [props.importFile]);

  useEffect(() => {
    setChecked(new Set());
    setExpanded(null);
  }, [accountId, tab]);
  // switching accounts clears the last message (except the switch an import makes to show its rows)
  const keepNotice = useRef(false);
  useEffect(() => {
    if (keepNotice.current) keepNotice.current = false;
    else setNotice(null);
  }, [accountId]);

  const account = feedAccounts?.find((a) => a.accountId === accountId);
  const isCC = account?.accountType === 'Credit Card';
  const nameOf = (id: ID | null | undefined) => (id ? names?.find((n) => n.id === id)?.fullName ?? '' : '');
  const acctOf = (id: ID | null | undefined) => (id ? accounts.get(id)?.fullName ?? '' : '');

  const byTab = useMemo(() => {
    const all = items ?? [];
    return {
      review: all.filter((i) => i.status === 'new'),
      categorized: all.filter((i) => i.status === 'added' || i.status === 'matched'),
      excluded: all.filter((i) => i.status === 'ignored'),
    };
  }, [items]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = byTab[tab].slice();
    // newest first, like the bank's own list
    list.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    if (!q) return list;
    return list.filter((i) => i.description.toLowerCase().includes(q) || i.suggestedPayee.toLowerCase().includes(q) || fmtMoney(Math.abs(i.amount)).includes(q) || String(Math.abs(i.amount)).includes(q));
  }, [byTab, tab, search]);

  // A split is stored as a transaction of its own that the downloaded row is matched to, marked
  // with extra.bankFeedSplit = row id: read those transactions so Categorized says "Added (split)".
  const matchedIds = useMemo(() => (tab === 'categorized' ? byTab.categorized.filter((i) => i.status === 'matched' && i.txnId).map((i) => i.txnId as ID) : []), [tab, byTab]);
  const matchedTxns = useQueries({
    queries: matchedIds.map((id) => ({ queryKey: ['txn', id], queryFn: () => api.get<Txn>(`/txns/${id}`), staleTime: 60_000 })),
  });
  const splitOf = useMemo(() => {
    const m = new Map<ID, ID>();
    for (const q of matchedTxns) {
      const split = q.data?.extra?.bankFeedSplit;
      if (q.data && typeof split === 'number') m.set(q.data.id, split);
    }
    return m;
  }, [matchedTxns]);
  const isSplit = (it: BankFeedItem) => !!it.txnId && splitOf.get(it.txnId) === it.id;

  const draftOf = (it: BankFeedItem): Draft => drafts[it.id] ?? initialDraft(it);
  const setDraft = (it: BankFeedItem, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [it.id]: { ...(d[it.id] ?? initialDraft(it)), ...patch } }));

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['bank-feed-items'] }),
      queryClient.invalidateQueries({ queryKey: ['bank-feed-accounts'] }),
    ]);
    void invalidateAll();
    // adds and matches can bring suggestions; undo, exclude and a new rule can take one away
    announceSuggestions();
  };

  /** After a change: reload the suggested rules once the clicks stop, and announce the new ones. */
  const announceSuggestions = () => {
    window.clearTimeout(announceTimer.current);
    announceTimer.current = window.setTimeout(() => void findNewSuggestions(), 500);
  };
  const findNewSuggestions = async () => {
    try {
      const list = await loadRuleSuggestions();
      const known = knownSuggestions.current;
      // the load when the window opened failed: start from this list (nothing to announce yet)
      if (!known) {
        knownSuggestions.current = new Set([...readAnnounced(), ...list.map((s) => s.key)]);
        return;
      }
      const fresh = list.map((s) => s.key).filter((k) => !known.has(k));
      if (!fresh.length) return;
      fresh.forEach((k) => known.add(k));
      saveAnnounced(fresh);
      setNewSuggestions((x) => [...x, ...fresh]);
    } catch {
      /* only a hint: Bank Rules lists them anyway */
    }
  };

  // ---- actions on one item (return an error message or null)
  const txnTypeFor = (it: BankFeedItem): TxnType => (isCC ? (it.amount < 0 ? 'CCCHARGE' : 'CCCREDIT') : it.amount < 0 ? 'CHK' : 'DEP');

  const applyOne = async (it: BankFeedItem, d: Draft): Promise<{ ok: boolean; message?: string; txnId?: ID }> => {
    try {
      if (d.mode === 'match') {
        if (!d.matchTxnId) return { ok: false, message: 'Choose the register transaction it matches.' };
        await api.post(`/bank-feed-items/${it.id}/match`, { txnId: d.matchTxnId });
        return { ok: true, txnId: d.matchTxnId };
      }
      if (d.split) {
        const lines = d.split.filter((l) => l.accountId || l.amount);
        if (!lines.length || lines.some((l) => !l.accountId)) return { ok: false, message: 'Choose an account on every split line.' };
        const total = round2(lines.reduce((s, l) => s + l.amount, 0));
        if (total !== round2(Math.abs(it.amount))) return { ok: false, message: `The split lines add up to ${fmtMoney(total)}; they must equal ${fmtMoney(Math.abs(it.amount))}.` };
        const type = txnTypeFor(it);
        const t: Txn = {
          ...emptyTxn(type, it.date),
          accountId: it.accountId,
          nameId: type === 'DEP' ? null : d.nameId,
          refNumber: d.refNumber,
          memo: d.memo || it.description,
          // lets Undo remove the transaction this split created (the server only removes its own)
          extra: { bankFeedSplit: it.id },
          lines: lines.map((l, i) => ({
            ...emptyLine(type === 'DEP' ? 'deposit' : 'expense', i + 1),
            accountId: l.accountId,
            amount: l.amount,
            description: l.memo || d.memo || it.description,
            classId: d.classId,
            nameId: type === 'DEP' ? d.nameId : null,
          })),
        };
        const saved = await api.post<Txn>('/txns', t);
        await api.post(`/bank-feed-items/${it.id}/match`, { txnId: saved.id });
        return { ok: true, txnId: saved.id };
      }
      if (!d.accountId) return { ok: false, message: 'Choose a category (the account this money is for).' };
      const body: BankFeedAdd = { nameId: d.nameId, accountId: d.accountId, memo: d.memo, classId: d.classId, refNumber: d.refNumber };
      const r = await api.post<{ txnId: ID }>(`/bank-feed-items/${it.id}/add`, body);
      return { ok: true, txnId: r.txnId };
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'cancelled') return { ok: false };
      return { ok: false, message: err.message };
    }
  };

  const [rowError, setRowError] = useState<Record<number, string>>({});

  const acceptOne = async (it: BankFeedItem) => {
    const d = draftOf(it);
    setBusy(it.id);
    const r = await applyOne(it, d);
    setBusy(null);
    if (!r.ok) {
      if (r.message) {
        setRowError((e) => ({ ...e, [it.id]: r.message! }));
        setExpanded(it.id);
      }
      return;
    }
    setRowError((e) => {
      const n = { ...e };
      delete n[it.id];
      return n;
    });
    setExpanded(null);
    setDrafts((x) => {
      const n = { ...x };
      delete n[it.id];
      return n;
    });
    await refresh();
    const similar = similarCount(it, d);
    setNotice({
      kind: 'success',
      text: `${it.description} ${d.mode === 'match' ? 'matched to the register transaction' : `added to ${account?.accountName ?? 'the register'}`}.${similar ? ` ${similar} more waiting ${verbFor(similar, 'looks', 'look')} the same: a rule can categorize ${verbFor(similar, 'it', 'them')} for you.` : ''}`,
      viewTxnId: r.txnId,
      undoIds: [it.id],
      rule: similar ? { it, d } : undefined,
    });
  };

  /** After categorizing: how many other waiting transactions look the same (a rule would help). */
  const similarCount = (it: BankFeedItem, d: Draft): number => {
    if (d.mode !== 'add' || d.split || !d.accountId) return 0;
    const key = ruleKey(it.description);
    if (!key) return 0;
    // rows that already match a register transaction do not need a rule
    return byTab.review.filter((x) => x.id !== it.id && !x.matches.length && ruleKey(x.description) === key && x.suggestedAccountId !== d.accountId).length;
  };

  const createRule = async (it: BankFeedItem, d: Draft = draftOf(it)) => {
    const key = ruleKey(it.description) || it.description;
    const payee = nameOf(d.nameId);
    const r = await editBankRule({
      name: payee || key,
      matchText: key,
      direction: it.amount < 0 ? 'out' : 'in',
      nameId: d.nameId,
      renameTo: payee,
      targetAccountId: d.mode === 'add' && !d.split ? d.accountId : null,
      accountId: null,
    });
    if (r) {
      // drop the drafts of waiting rows so the new suggestions show
      setDrafts({});
      await refresh();
    }
  };

  const exclude = async (list: BankFeedItem[]) => {
    setBusy(list.length === 1 ? list[0].id : 'bulk');
    try {
      for (const it of list) await api.post(`/bank-feed-items/${it.id}/ignore`);
      setNotice({ kind: 'info', text: list.length === 1 ? `${list[0].description} moved to Excluded.` : `${list.length} transactions moved to Excluded.`, undoIds: list.map((x) => x.id) });
    } catch (e) {
      if ((e as ApiError).code !== 'cancelled') setNotice({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
      setChecked(new Set());
      setExpanded(null);
      await refresh();
    }
  };

  const undo = async (list: BankFeedItem[]) => {
    setBusy(list.length === 1 ? list[0].id : 'bulk');
    let deleted = 0;
    try {
      for (const it of list) {
        // a split creates its own transaction and matches it: undo removes that transaction too
        let splitTxn: ID | null = null;
        if (it.status === 'matched' && it.txnId) {
          const t = await api.get<Txn>(`/txns/${it.txnId}`).catch(() => null);
          if (t && t.extra?.bankFeedSplit === it.id) splitTxn = t.id;
        }
        const r = await api.post<{ ok: boolean; deleted?: boolean }>(`/bank-feed-items/${it.id}/undo`);
        if (r.deleted) deleted++;
        if (splitTxn) {
          await api.del(`/txns/${splitTxn}`);
          deleted++;
        }
      }
      setNotice({
        kind: 'info',
        text: `${list.length === 1 ? 'Moved back' : `${list.length} transactions moved back`} to For review${deleted ? `; ${deleted === 1 ? 'the transaction it added was' : `${deleted} transactions it added were`} deleted from the register` : ''}.`,
      });
    } catch (e) {
      if ((e as ApiError).code !== 'cancelled') setNotice({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
      setChecked(new Set());
      await refresh();
    }
  };

  const acceptSelected = async () => {
    const list = rows.filter((r) => checked.has(r.id));
    setBusy('bulk');
    let done = 0;
    const skipped: string[] = [];
    for (const it of list) {
      const d = draftOf(it);
      const r = await applyOne(it, d);
      if (r.ok) done++;
      else skipped.push(`${fmtDate(it.date)} ${it.description}${r.message ? ': ' + r.message : ''}`);
    }
    setBusy(null);
    setChecked(new Set());
    setDrafts({});
    await refresh();
    const accepted = list.filter((it) => !skipped.some((x) => x.startsWith(`${fmtDate(it.date)} ${it.description}`))).map((it) => it.id);
    const need = verbFor(skipped.length, 'needs', 'need');
    setNotice({ kind: 'success', text: `${plural(done, 'transaction')} accepted.${skipped.length ? ` ${skipped.length} ${need} your attention.` : ''}`, undoIds: accepted });
    if (skipped.length)
      await msgBox({
        title: 'Accept Transactions',
        message: `${done} accepted. ${skipped.length} ${need} your attention first:\n\n${skipped.slice(0, 8).join('\n')}${skipped.length > 8 ? '\n…' : ''}`,
        icon: 'info',
      });
  };

  const openTxnById = async (id: ID) => {
    try {
      const t = await api.get<Txn>(`/txns/${id}`);
      openTxn(t.type, t.id);
    } catch (e) {
      setNotice({ kind: 'error', text: (e as Error).message });
    }
  };

  // ---- import
  const importFile = async (file: File | undefined | null) => {
    if (!file || !feedAccounts?.length) return;
    // which account: the one whose number is in the file (its ACCTID), else the one shown
    let peek: FilePeek | null = null;
    try {
      peek = peekBankFile(await file.text());
    } catch {
      /* unreadable here: the server says why */
    }
    const candidates = feedAccounts.map((a) => accounts.get(a.accountId)).filter((a): a is Account => !!a);
    const matched = peek?.acctId ? accountForNumber(peek.acctId, candidates) : undefined;
    const choice = await showDialog<ImportChoice | null>({
      title: 'Import Bank File',
      width: 600,
      cancelValue: null,
      render: (close) => (
        <ImportDialog fileName={file.name} peek={peek} feedAccounts={feedAccounts} accounts={accounts} initial={matched?.id ?? accountId} matched={matched} onDone={close} />
      ),
    });
    if (fileRef.current) fileRef.current.value = '';
    if (!choice) return;
    const target = feedAccounts.find((a) => a.accountId === choice.accountId);
    if (choice.flipSigns !== null) saveFlip(choice.accountId, choice.flipSigns);
    // the choices the user saw are sent as they are (the server remembers them for the account)
    const fields: Record<string, string> = {};
    if (choice.flipSigns !== null) fields.flipSigns = choice.flipSigns ? '1' : '0';
    if (choice.dateOrder) fields.dateOrder = choice.dateOrder;
    setBusy('import');
    try {
      // a file for another account makes the server ask first (code "confirm": Yes re-sends it with force)
      const r = await api.upload<BankFeedImportResult>(`/bank-feeds/${choice.accountId}/import`, file, fields);
      await refresh();
      if (choice.accountId !== accountId) {
        keepNotice.current = true;
        setAccountId(choice.accountId);
      }
      setTab('review');
      setShowImport(false);
      const bad = r.invalid ?? r.problems?.length ?? 0;
      setNotice({ kind: bad ? 'info' : 'success', text: importMessage(r, target?.accountName ?? 'the account') });
    } catch (e) {
      const err = e as ApiError;
      if (err.code !== 'cancelled') await msgBox({ title: 'Import File', message: `The file could not be imported.\n\n${err.message}`, icon: 'error' });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    void importFile(e.dataTransfer.files?.[0]);
  };

  // ---- render
  if (loadingAccounts) return <Spinner center label="Loading..." />;
  if (!feedAccounts?.length) {
    return (
      <div className="bk-feeds">
        <EmptyState
          icon={Landmark}
          title="Add a bank or credit card account first"
          message="Bank Imports bring in the transactions you download from your bank's website. Create the bank or credit card account in the Chart of Accounts, then import its file here."
          action={{ label: 'New account', onClick: () => openWindow('accountEdit', { type: 'Bank' }) }}
        />
      </div>
    );
  }

  const tabs = [
    { key: 'review', label: `For review (${byTab.review.length})` },
    { key: 'categorized', label: `Categorized (${byTab.categorized.length})` },
    { key: 'excluded', label: `Excluded (${byTab.excluded.length})` },
  ];
  const selCount = rows.filter((r) => checked.has(r.id)).length;
  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.id));
  // the ones still suggested (a rule added or a classification undone takes one away)
  const newRuleCount = suggestions?.filter((s) => newSuggestions.includes(s.key)).length ?? 0;

  return (
    <div
      className={'bk-feeds' + (dragOver ? ' bk-drag' : '')}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <input ref={fileRef} type="file" accept=".csv,.ofx,.qfx,.qbo,.txt" hidden onChange={(e) => void importFile(e.target.files?.[0])} />
      <div className="bk-feeds-accts">
        <div className="bk-feeds-tiles" role="tablist" aria-label="Accounts">
        {feedAccounts.map((a) => {
          const bal = accounts.get(a.accountId)?.balance;
          const on = a.accountId === accountId;
            const sub = `In SerieX ${bal !== undefined ? '$' + fmtMoney(bal) : ''}${a.lastImport ? ` · imported ${fmtDate(localDay(a.lastImport))}` : ' · nothing imported yet'}`;
            return (
            <button
              key={a.accountId}
              type="button"
              role="tab"
              aria-selected={on}
              className={'bk-feeds-acct' + (on ? ' bk-on' : '')}
              onClick={() => setAccountId(a.accountId)}
              title={`${a.accountName}\n${sub}${a.newCount ? `\n${plural(a.newCount, 'transaction')} to review` : ''}`}
            >
              <span className="bk-feeds-acct-icon">{a.accountType === 'Credit Card' ? <CreditCard size={16} /> : <Landmark size={16} />}</span>
              <span className="bk-feeds-acct-main">
                <span className="bk-feeds-acct-name">{a.accountName}</span>
                <span className="bk-feeds-acct-sub">{sub}</span>
              </span>
              {a.newCount > 0 && <span className="bk-feeds-count">{a.newCount}</span>}
            </button>
          );
        })}
        </div>
        <div className="bk-feeds-actions">
          <Button icon={FileUp} label="Import file" onClick={() => setShowImport((v) => !v)} variant={showImport ? 'primary' : 'secondary'} />
          <Button icon={ListFilter} label="Rules" onClick={() => openWindow('bankRules')} />
        </div>
      </div>
      {showImport && (
        <div className="bk-feeds-import">
          <FileUp size={22} className="bk-feeds-import-icon" />
          <div className="bk-feeds-import-text">
            <div className="bk-imp-target">
              <label className="bk-imp-target-label" htmlFor={`${win.id}-imp-acct`}>
                Import transactions into
              </label>
              <AccountPicker
                id={`${win.id}-imp-acct`}
                name="importAccount"
                types={['Bank', 'Credit Card']}
                filter={(a) => feedAccounts.some((f) => f.accountId === a.id)}
                value={accountId}
                onChange={(id) => id && setAccountId(id)}
                addNew={false}
                width={280}
              />
            </div>
            <span className="bk-muted">
              Download a bank transaction file (.ofx, .qfx, .qbo) or a spreadsheet (.csv) from your bank's website, then choose it here or drop it on this window. You confirm the account
              before anything is imported; transactions already downloaded are skipped.
            </span>
          </div>
          <Button variant="primary" label="Choose file…" className="bk-feeds-import-btn" busy={busy === 'import'} onClick={() => fileRef.current?.click()} />
          <button type="button" className="sx-iconbtn bk-feeds-import-close" aria-label="Close import" onClick={() => setShowImport(false)}>
            <X size={16} />
          </button>
        </div>
      )}
      <Tabs
        tabs={tabs}
        active={tab}
        onChange={(k) => setTab(k as Tab)}
        variant="strip"
        className="bk-feeds-tabs"
        right={
          <div className="bk-feeds-tools">
            {isFetching && <Spinner size={14} />}
            <SearchBox value={search} onChange={setSearch} placeholder="Search description or amount" width={230} debounce={120} />
          </div>
        }
      >
        <div className="bk-feeds-body">
          {notice && (
            <div className={'bk-feeds-notice bk-' + notice.kind} role="status">
              {notice.kind === 'error' ? <X size={15} /> : <CircleCheck size={15} />}
              <span className="bk-feeds-notice-text">{notice.text}</span>
              {notice.rule && (
                <button type="button" className="sx-linkbtn" onClick={() => void createRule(notice.rule!.it, notice.rule!.d)}>
                  Create rule
                </button>
              )}
              {notice.viewTxnId && (
                <button type="button" className="sx-linkbtn" onClick={() => void openTxnById(notice.viewTxnId!)}>
                  View
                </button>
              )}
              {notice.undoIds?.length ? (
                <button
                  type="button"
                  className="sx-linkbtn"
                  onClick={() => {
                    const list = (items ?? []).filter((x) => notice.undoIds!.includes(x.id));
                    setNotice(null);
                    void undo(list);
                  }}
                >
                  Undo
                </button>
              ) : null}
              <button type="button" className="sx-iconbtn bk-feeds-notice-x" aria-label="Dismiss" onClick={() => setNotice(null)}>
                <X size={14} />
              </button>
            </div>
          )}
          {newRuleCount > 0 && (
            <div className="bk-feeds-notice bk-info" role="status">
              <Lightbulb size={15} />
              <span className="bk-feeds-notice-text">{plural(newRuleCount, 'rule')} suggested from how you classified these transactions.</span>
              <button
                type="button"
                className="sx-linkbtn"
                onClick={() => {
                  openWindow('bankRules', { highlight: newSuggestions });
                  setNewSuggestions([]);
                }}
              >
                Review in Bank Rules
              </button>
              <button type="button" className="sx-iconbtn bk-feeds-notice-x" aria-label="Dismiss" onClick={() => setNewSuggestions([])}>
                <X size={14} />
              </button>
            </div>
          )}
          {selCount > 0 && (
            <div className="bk-feeds-bulk" role="toolbar" aria-label="Selected transactions">
              <b>{selCount} selected</b>
              {tab === 'review' ? (
                <>
                  <Button variant="primary" small icon={CircleCheck} label="Accept" busy={busy === 'bulk'} onClick={() => void acceptSelected()} title="Add or match every selected transaction with its suggestion" />
                  <Button small icon={Trash2} label="Exclude" disabled={busy === 'bulk'} onClick={() => void exclude(rows.filter((r) => checked.has(r.id)))} />
                </>
              ) : (
                <Button small icon={Undo2} label="Undo" busy={busy === 'bulk'} onClick={() => void undo(rows.filter((r) => checked.has(r.id)))} />
              )}
              <Button small variant="ghost" label="Clear selection" onClick={() => setChecked(new Set())} />
            </div>
          )}
          {loadingItems ? (
            <Spinner center />
          ) : !rows.length ? (
            <EmptyState
              icon={tab === 'review' && (items?.length ?? 0) > 0 ? CircleCheck : FileUp}
              title={
                search
                  ? 'No transactions match your search'
                  : tab === 'review'
                    ? (items?.length ?? 0) > 0
                      ? 'All caught up'
                      : 'No downloaded transactions yet'
                    : tab === 'categorized'
                      ? 'Nothing categorized yet'
                      : 'Nothing excluded'
              }
              message={
                search
                  ? undefined
                  : tab === 'review'
                    ? (items?.length ?? 0) > 0
                      ? `Every downloaded transaction of ${account?.accountName} has been reviewed.`
                      : `Import a file from your bank to see the transactions of ${account?.accountName} here and add them to your books in a few clicks.`
                    : tab === 'categorized'
                      ? 'Transactions you add or match appear here. You can undo them if you made a mistake.'
                      : 'Transactions you exclude (duplicates, personal purchases) appear here. Undo puts them back in For review.'
              }
              action={tab === 'review' && !search ? { label: 'Import file', icon: FileUp, onClick: () => setShowImport(true) } : undefined}
            />
          ) : (
            <div className="bk-feeds-table" role="grid" aria-label="Downloaded transactions">
              <div className={'bk-feeds-row bk-feeds-head bk-t-' + tab} role="row">
                <span className="bk-fc bk-fc-check">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={allChecked}
                    onChange={() => setChecked(allChecked ? new Set() : new Set(rows.map((r) => r.id)))}
                  />
                </span>
                <span className="bk-fc">Date</span>
                <span className="bk-fc">Bank description</span>
                {tab !== 'excluded' && <span className="bk-fc">Payee</span>}
                {tab !== 'excluded' && <span className="bk-fc">{tab === 'review' ? 'Category or match' : 'Added or matched to'}</span>}
                <span className="bk-fc bk-num">Spent</span>
                <span className="bk-fc bk-num">Received</span>
                <span className="bk-fc bk-fc-act">Action</span>
              </div>
              {rows.map((it) => {
                const d = draftOf(it);
                const open = expanded === it.id;
                const on = checked.has(it.id);
                const match = it.matches.find((m) => m.txnId === d.matchTxnId) ?? it.matches[0];
                const payee = tab === 'review' ? (d.mode === 'match' && match ? match.nameFull : nameOf(d.nameId) || it.suggestedPayee) : it.matches[0]?.nameFull || '';
                const err = rowError[it.id];
                return (
                  <Fragment key={it.id}>
                    <div
                      role="row"
                      aria-expanded={tab === 'review' ? open : undefined}
                      className={'bk-feeds-row bk-t-' + tab + (open ? ' bk-open' : '') + (on ? ' bk-on' : '') + (err ? ' bk-err' : '')}
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest('button, input')) return;
                        if (tab === 'review') setExpanded(open ? null : it.id);
                      }}
                    >
                      <span className="bk-fc bk-fc-check">
                        <input
                          type="checkbox"
                          aria-label="Select"
                          checked={on}
                          onChange={() =>
                            setChecked((c) => {
                              const n = new Set(c);
                              if (n.has(it.id)) n.delete(it.id);
                              else n.add(it.id);
                              return n;
                            })
                          }
                        />
                      </span>
                      <span className="bk-fc">{fmtDate(it.date)}</span>
                      <span className="bk-fc bk-fc-desc" title={it.description}>
                        {it.amount < 0 ? <ArrowUpRight size={13} className="bk-out" /> : <ArrowDownLeft size={13} className="bk-in" />}
                        <span className="bk-chip-text">
                          {it.description}
                          {it.checkNumber && !it.description.includes(it.checkNumber) ? <span className="bk-muted"> #{it.checkNumber}</span> : null}
                        </span>
                      </span>
                      {tab !== 'excluded' && (
                        <span className="bk-fc" title={payee}>
                          {payee || <span className="bk-muted">—</span>}
                        </span>
                      )}
                      {tab === 'review' && (
                        <span className="bk-fc">
                          {d.mode === 'match' && match ? (
                            <span className="bk-chip bk-chip-match" title={`Already in your register: ${matchLabel(match)} dated ${fmtDate(match.date)}${it.matches.length > 1 ? ` (${it.matches.length} possible matches)` : ''}`}>
                              <Link2 size={12} />
                              <span className="bk-chip-text">
                                {matchLabel(match)} · {fmtDate(match.date).slice(0, 5)}
                                {it.matches.length > 1 ? ` (+${it.matches.length - 1})` : ''}
                              </span>
                            </span>
                          ) : d.split ? (
                            <span className="bk-chip" title={`Split into ${d.split.length} lines`}>
                              <Split size={12} /> <span className="bk-chip-text">Split ({d.split.length} lines)</span>
                            </span>
                          ) : d.accountId ? (
                            <span className="bk-chip bk-chip-cat" title={acctOf(d.accountId)}>
                              <span className="bk-chip-text">{acctOf(d.accountId)}</span>
                            </span>
                          ) : (
                            <span className="bk-chip bk-chip-need">Choose a category</span>
                          )}
                        </span>
                      )}
                      {tab === 'categorized' && (
                        <span className="bk-fc bk-fc-flex">
                          <StatusPill status={it.status === 'added' ? 'Added' : isSplit(it) ? 'Added (split)' : 'Matched'} tone={isSplit(it) ? statusTone('Added') : undefined} />{' '}
                          {it.matches[0] ? (
                            <button
                              type="button"
                              className="sx-linkbtn"
                              onClick={() => openTxn(it.matches[0].type, it.matches[0].txnId)}
                              title={`${isSplit(it) ? 'Added' : 'Matched'}: ${matchLabel(it.matches[0])} dated ${fmtDate(it.matches[0].date)}`}
                            >
                              {matchLabel(it.matches[0])} · {fmtDate(it.matches[0].date)}
                            </button>
                          ) : (
                            <span className="bk-muted">transaction deleted</span>
                          )}
                        </span>
                      )}
                      <span className="bk-fc bk-num">{it.amount < 0 ? fmtMoney(-it.amount) : ''}</span>
                      <span className="bk-fc bk-num">{it.amount > 0 ? fmtMoney(it.amount) : ''}</span>
                      <span className="bk-fc bk-fc-act">
                        {tab === 'review' ? (
                          <Button
                            small
                            variant={d.mode === 'match' || d.accountId || d.split ? 'primary' : 'secondary'}
                            label={d.mode === 'match' ? 'Match' : d.accountId || d.split ? 'Add' : 'Review'}
                            busy={busy === it.id}
                            onClick={() => (d.mode === 'match' || d.accountId || d.split ? void acceptOne(it) : setExpanded(it.id))}
                          />
                        ) : (
                          <Button small icon={Undo2} label="Undo" busy={busy === it.id} onClick={() => void undo([it])} />
                        )}
                      </span>
                    </div>
                    {open && tab === 'review' && (
                      <FeedEditor
                        it={it}
                        d={d}
                        isCC={isCC}
                        error={err}
                        accountName={account?.accountName ?? ''}
                        category={d.accountId ? accounts.get(d.accountId) : undefined}
                        useClasses={prefs.useClassTracking}
                        busy={busy === it.id}
                        onChange={(p) => {
                          setDraft(it, p);
                          if (err)
                            setRowError((e) => {
                              const n = { ...e };
                              delete n[it.id];
                              return n;
                            });
                        }}
                        onAccept={() => void acceptOne(it)}
                        onExclude={() => void exclude([it])}
                        onRule={() => void createRule(it)}
                        onClose={() => setExpanded(null)}
                        onReset={() =>
                          setDrafts((x) => {
                            const n = { ...x };
                            delete n[it.id];
                            return n;
                          })
                        }
                      />
                    )}
                  </Fragment>
                );
              })}
            </div>
          )}
        </div>
      </Tabs>
      {dragOver && (
        <div className="bk-feeds-drop">
          <FileUp size={28} /> Drop the file to import it into {account?.accountName}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline editor of a downloaded transaction (For review)

interface FeedEditorProps {
  it: BankFeedItem;
  d: Draft;
  isCC: boolean;
  error?: string;
  accountName: string;
  /** The chosen category account (to tell a transfer from a purchase or deposit). */
  category: Account | undefined;
  useClasses: boolean;
  busy: boolean;
  onChange: (p: Partial<Draft>) => void;
  onAccept: () => void;
  onExclude: () => void;
  onRule: () => void;
  onClose: () => void;
  onReset: () => void;
}

/** Categories that make the add a transfer between two of the company's accounts. */
const TRANSFER_CATEGORY_TYPES: string[] = ['Bank', 'Credit Card'];

function FeedEditor({ it, d, isCC, error, accountName, category, useClasses, busy, onChange, onAccept, onExclude, onRule, onClose, onReset }: FeedEditorProps) {
  const amount = Math.abs(it.amount);
  const what = isCC ? (it.amount < 0 ? 'credit card charge' : 'credit card credit') : it.amount < 0 ? 'check' : 'deposit';
  const splitTotal = round2((d.split ?? []).reduce((s, l) => s + l.amount, 0));
  const startSplit = () =>
    onChange({
      split: [
        { key: splitSeq++, accountId: d.accountId, amount: amount, memo: '' },
        { key: splitSeq++, accountId: null, amount: 0, memo: '' },
      ],
    });
  const setLine = (key: number, p: Partial<SplitLine>) => onChange({ split: (d.split ?? []).map((l) => (l.key === key ? { ...l, ...p } : l)) });

  return (
    <div className="bk-feed-edit" role="group" aria-label="Edit downloaded transaction" onKeyDown={(e) => e.key === 'Escape' && !e.defaultPrevented && (e.preventDefault(), onClose())}>
      <div className="bk-feed-edit-top">
        <SegmentedControl<'add' | 'match'>
          size="sm"
          value={d.mode}
          onChange={(v) => onChange({ mode: v })}
          aria-label="What to do"
          options={[
            { value: 'add', label: 'Categorize', title: `Add it as a new ${what}` },
            { value: 'match', label: `Find match${it.matches.length ? ` (${it.matches.length})` : ''}`, disabled: !it.matches.length, title: it.matches.length ? 'It is already in your register' : 'No register transaction has this amount' },
          ]}
        />
        <span className="bk-muted bk-feed-edit-desc">
          {it.description} · {fmtDate(it.date)} · <b>{it.amount < 0 ? 'spent' : 'received'} ${fmtMoney(amount)}</b>
        </span>
        <span className="bk-grow" />
        <button type="button" className="sx-iconbtn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      {d.mode === 'match' ? (
        <div className="bk-feed-matches" role="radiogroup" aria-label="Register transactions with the same amount">
          {it.matches.map((m) => (
            <label key={m.txnId} className={'bk-feed-match' + (d.matchTxnId === m.txnId ? ' bk-on' : '')}>
              <input type="radio" name={`bk-match-${it.id}`} checked={d.matchTxnId === m.txnId} onChange={() => onChange({ matchTxnId: m.txnId })} autoFocus={d.matchTxnId === m.txnId} />
              <span className="bk-feed-match-main">
                <b>{matchLabel(m)}</b> · {fmtDate(m.date)} · {m.nameFull || 'No payee'}
              </span>
              <span className="bk-num">${fmtMoney(Math.abs(m.amount))}</span>
              <button type="button" className="sx-linkbtn" onClick={() => openTxn(m.type, m.txnId)}>
                Open
              </button>
            </label>
          ))}
          <p className="bk-muted bk-feed-note">Matching links the bank's copy to the transaction already in your register, so nothing is entered twice.</p>
        </div>
      ) : (
        <div className="bk-feed-cat">
          <div className="bk-feed-fields">
            <label className="bk-feed-field">
              <span className="sx-label">{it.amount < 0 ? 'PAYEE' : 'RECEIVED FROM'}</span>
              <NamePicker
                value={d.nameId}
                onChange={(id) => onChange({ nameId: id })}
                placeholder={it.suggestedPayee || 'Optional'}
                aria-label="Payee"
                autoFocus
                defaultKind={it.amount < 0 ? 'vendor' : 'customer'}
              />
            </label>
            {!d.split && (
              <label className="bk-feed-field bk-w2">
                <span className="sx-label">CATEGORY</span>
                <AccountPicker value={d.accountId} onChange={(id) => onChange({ accountId: id })} excludeTypes={LINE_EXCLUDED_TYPES} excludeIds={[it.accountId]} placeholder="Choose an account" aria-label="Category" />
              </label>
            )}
            {useClasses && (
              <label className="bk-feed-field">
                <span className="sx-label">CLASS</span>
                <ClassPicker value={d.classId} onChange={(id) => onChange({ classId: id })} aria-label="Class" />
              </label>
            )}
            <label className="bk-feed-field bk-w2">
              <span className="sx-label">MEMO</span>
              <TextField value={d.memo} onChange={(v) => onChange({ memo: v })} placeholder={it.description} aria-label="Memo" />
            </label>
            <label className="bk-feed-field bk-w1">
              <span className="sx-label">REF NO.</span>
              <TextField value={d.refNumber} onChange={(v) => onChange({ refNumber: v })} aria-label="Ref no." />
            </label>
          </div>
          {d.split && (
            <div className="bk-feed-split">
              {d.split.map((l) => (
                <div key={l.key} className="bk-feed-split-row">
                  <AccountPicker value={l.accountId} onChange={(id) => setLine(l.key, { accountId: id })} excludeTypes={LINE_EXCLUDED_TYPES} excludeIds={[it.accountId]} placeholder="Account" aria-label="Split account" />
                  <MoneyField value={l.amount} blankZero onChange={(v) => setLine(l.key, { amount: v ?? 0 })} aria-label="Split amount" width={120} />
                  <TextField value={l.memo} onChange={(v) => setLine(l.key, { memo: v })} placeholder="Memo" aria-label="Split memo" />
                  <button type="button" className="sx-iconbtn" aria-label="Remove line" onClick={() => onChange({ split: (d.split ?? []).filter((x) => x.key !== l.key) })}>
                    <X size={14} />
                  </button>
                </div>
              ))}
              <div className="bk-feed-split-foot">
                <Button small variant="ghost" icon={Plus} label="Add line" onClick={() => onChange({ split: [...(d.split ?? []), { key: splitSeq++, accountId: null, amount: round2(amount - splitTotal), memo: '' }] })} />
                <span className={splitTotal === round2(amount) ? 'bk-ok-text' : 'bk-warn-text'}>
                  {splitTotal === round2(amount) ? 'Split adds up' : `Left to assign: $${fmtMoney(round2(amount - splitTotal))}`}
                </span>
              </div>
            </div>
          )}
          <p className="bk-muted bk-feed-note">
            {category && TRANSFER_CATEGORY_TYPES.includes(category.type) && !d.split
              ? // money between two of the company's own accounts is a transfer, not a purchase or a deposit
                `Records a transfer from ${it.amount < 0 ? accountName : category.fullName} to ${it.amount < 0 ? category.fullName : accountName} for $${fmtMoney(amount)} dated ${fmtDate(it.date)}.`
              : `Adds a ${what} ${it.amount < 0 ? 'from' : 'to'} ${accountName} for $${fmtMoney(amount)} dated ${fmtDate(it.date)}.`}
          </p>
        </div>
      )}
      {error && (
        <div className="bk-feed-error" role="alert">
          {error}
        </div>
      )}
      <div className="bk-feed-edit-foot">
        {d.mode === 'add' && <Button small variant="ghost" icon={Split} label={d.split ? 'Single category' : 'Split'} onClick={() => (d.split ? onChange({ split: null }) : startSplit())} />}
        <Button small variant="ghost" icon={Wand2} label="Create rule from this" onClick={onRule} />
        <Button small variant="ghost" label="Reset" onClick={onReset} title="Back to the suggestion" />
        <span className="bk-grow" />
        <Button small icon={Trash2} label="Exclude" onClick={onExclude} disabled={busy} title="Not a business transaction, or a duplicate: keep it out of your books" />
        <Button small variant="primary" label={d.mode === 'match' ? 'Match' : 'Add'} busy={busy} onClick={onAccept} />
      </div>
    </div>
  );
}
