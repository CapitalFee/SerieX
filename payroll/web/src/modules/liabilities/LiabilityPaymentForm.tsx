// Tax Payment (window title "Tax Payment - <Bank Account>"): the check face of the SerieX
// Books Write Checks form (No., Date, Pay to the order of = the agency, amount, amount in words,
// address, memo), PERIOD from/to and payment method under the check, and the "Expenses" /
// "Taxes and Deductions" tabs (PAYROLL ITEM / AMOUNT / MEMO and ACCOUNT / AMOUNT / MEMO).
// A new payment fills the Taxes and Deductions tab with the agency's unpaid balances as of
// the period end. Saving posts the check to SerieX Books (status line with Retry); Void and
// Delete remove it there first. Kind "prior" is a payment made before using SerieX Payroll
// (Record Earlier Tax Payments): no bank account, no check, never posted.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Calculator, Landmark, ListChecks } from 'lucide-react';
import { ApiError, api, qs } from '@/api/client';
import { invalidateAll, useBooksAccounts, useBooksVendors, usePrefValues } from '@/api/hooks';
import type { BooksName, Id, LiabilityBalance, LiabilityDue, LiabilityPayment, LiabilityPaymentLine, PaymentSchedule, PayrollItem } from '@/api/types';
import {
  AccountLabel,
  AccountPicker,
  Checkbox,
  DateField,
  Grid,
  PayrollItemLabel,
  PayrollItemPicker,
  SegmentedControl,
  Tabs,
  TextField,
  VendorPicker,
  alertBox,
  commitActiveEditor,
  confirmBox,
  msgBox,
  promptBox,
  toast,
  type FieldErrors,
  type GridColumn,
} from '@/components';
import { CheckAccountBar, CheckFace, FormFrame, type FooterTotal } from '@/forms';
import { useWindow } from '@/windows/WindowContext';
import { openWindow } from '@/windows/windowStore';
import { todayIso } from '@/util/dates';
import { escHtml, printHtml } from '@/util/print';
import { amountInWords } from '@/util/words';
import { fmtDate, fmtMoney, round2 } from '@/util/format';
import { forgetRecent, recordRecent } from '@/util/recent';
import { nextNumber } from './PayLiabilities';
import { BooksStatusLine, LIABILITY_TYPES, booksErr, errText, isCancelled, localDate, periodText, previousMonth, sum2, useItemAgencies } from './shared';

export interface LiabilityPaymentFormProps {
  /** Saved payment (new when missing). */
  id?: number;
  /** Agency of a new payment. */
  agencyVendorId?: number;
  /** Period start (YYYY-MM-DD) of a new payment. */
  periodStart?: string;
  /** Period end (YYYY-MM-DD) of a new payment. */
  periodEnd?: string;
  /** Kind of a new payment. */
  kind?: 'payment' | 'prior';
  /** Payments created together by Pay Payroll Taxes ("Payment 2 of 3", previous/next). */
  batch?: number[];
}

interface ItemRow {
  itemId: Id | null;
  amount: number;
  memo: string;
}
interface ExpRow {
  accountId: Id | null;
  amount: number;
  memo: string;
}

interface Draft {
  rec: LiabilityPayment;
  items: ItemRow[];
  expenses: ExpRow[];
}

const emptyItem = (): ItemRow => ({ itemId: null, amount: 0, memo: '' });
const emptyExp = (): ExpRow => ({ accountId: null, amount: 0, memo: '' });

function blankPayment(kind: 'payment' | 'prior', today: string): LiabilityPayment {
  const pm = previousMonth(today);
  return {
    id: 0,
    kind,
    date: today,
    periodStart: pm.start,
    periodEnd: pm.end,
    agencyVendorId: null,
    bankAccountId: null,
    checkNumber: '',
    toBePrinted: false,
    method: 'check',
    memo: '',
    lines: [],
    amount: 0,
    agencyName: '',
    bankAccountName: '',
    voided: false,
    booksTxnId: null,
    syncStatus: 'none',
    syncError: '',
    createdBy: '',
    createdAt: '',
  };
}

function toDraft(p: LiabilityPayment): Draft {
  return {
    rec: p,
    items: p.lines.filter((l) => l.kind === 'item').map((l) => ({ itemId: l.itemId, amount: l.amount, memo: l.memo })),
    expenses: p.lines.filter((l) => l.kind === 'expense').map((l) => ({ accountId: l.accountId, amount: l.amount, memo: l.memo })),
  };
}

/** The editable part of a draft, for the "unsaved changes" comparison. */
function snapshot(d: Draft): string {
  const r = d.rec;
  return JSON.stringify([
    r.kind,
    r.date,
    r.periodStart,
    r.periodEnd,
    r.agencyVendorId,
    r.bankAccountId,
    r.toBePrinted || r.method === 'e-pay' || r.kind === 'prior' ? '' : r.checkNumber,
    r.toBePrinted,
    r.method,
    r.memo,
    d.items.filter((l) => l.itemId || l.amount || l.memo).map((l) => [l.itemId, round2(l.amount), l.memo]),
    d.expenses.filter((l) => l.accountId || l.amount || l.memo).map((l) => [l.accountId, round2(l.amount), l.memo]),
  ]);
}

/** Maps a server field ("lines[2]", "agencyVendorId") to the form control that shows it. */
function fieldOf(f: string | undefined): string | null {
  if (!f) return null;
  if (f.startsWith('lines')) return 'lines';
  return f;
}

export default function LiabilityPaymentForm(props: LiabilityPaymentFormProps) {
  const win = useWindow();
  const prefs = usePrefValues();
  const today = todayIso();
  const banksQ = useBooksAccounts(['Bank']);
  const banks = banksQ.data;
  const agencies = useItemAgencies();
  const [curId, setCurId] = useState<number>(props.id ?? 0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [base, setBase] = useState<string>('');
  const [tab, setTab] = useState<'items' | 'expenses'>('items');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  /** The lines were filled automatically (or not touched): picking another agency refills them. */
  const autoLines = useRef(true);
  const fillSeq = useRef(0);
  const skipLoad = useRef(false);
  const agenciesRef = useRef(agencies);
  agenciesRef.current = agencies;

  const rec = draft?.rec ?? null;
  const isNew = !curId;
  const prior = rec?.kind === 'prior';
  const readOnly = !!rec?.voided;
  const itemTotal = sum2((draft?.items ?? []).map((l) => l.amount));
  const expTotal = sum2((draft?.expenses ?? []).map((l) => l.amount));
  const total = round2(itemTotal + expTotal);
  const dirty = !!draft && snapshot(draft) !== base;
  const bank = banks?.find((a) => a.id === rec?.bankAccountId) ?? null;
  // the agency's check address from SerieX Books (name, address lines, "City, ST ZIP")
  const vendors = useBooksVendors().data;
  const addressOf = (p: Pick<LiabilityPayment, 'agencyVendorId' | 'agencyName'>) => (p.agencyVendorId ? vendors?.find((v) => v.id === p.agencyVendorId)?.address : '') || p.agencyName;

  const nextCheckNumber = useCallback(async (bankId: Id | null): Promise<string> => {
    if (!bankId) return '';
    try {
      const r = await api.get<{ refNumber: string }>('/books/next-check' + qs({ accountId: bankId }), { noPrompt: true });
      return r?.refNumber ?? '';
    } catch {
      return '';
    }
  }, []);

  // ---- loading
  const loadNew = useCallback(
    async (opts: { agencyVendorId?: number; periodStart?: string; periodEnd?: string; kind?: 'payment' | 'prior' }) => {
      const p = blankPayment(opts.kind ?? 'payment', today);
      if (opts.periodStart) p.periodStart = opts.periodStart;
      if (opts.periodEnd) p.periodEnd = opts.periodEnd;
      if (opts.periodEnd && !opts.periodStart) p.periodStart = opts.periodEnd.slice(0, 8) + '01';
      p.agencyVendorId = opts.agencyVendorId ?? null;
      if (p.kind === 'payment') {
        const list = banks ?? (await api.get<{ id: Id; active: boolean }[]>('/books/accounts?types=Bank', { noPrompt: true }).catch(() => []));
        const def = prefs.defaultBankAccountId && list.find((a) => a.id === prefs.defaultBankAccountId);
        // SerieX Books not reachable (no bank list): the default bank account of the payroll preferences
        p.bankAccountId = (def || list.find((a) => a.active) || list[0])?.id ?? prefs.defaultBankAccountId ?? null;
        p.checkNumber = await nextCheckNumber(p.bankAccountId);
      }
      const d: Draft = { rec: p, items: [], expenses: [] };
      autoLines.current = true;
      setDraft(d);
      setBase(snapshot(d));
      setTab('items');
      setFieldErrors({});
      setFormError(null);
      return d;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [banks, prefs.defaultBankAccountId, today],
  );

  const loadSaved = useCallback(async (id: number) => {
    const p = await api.get<LiabilityPayment>(`/liability-payments/${id}`);
    const d = toDraft(p);
    autoLines.current = false;
    setDraft(d);
    setBase(snapshot(d));
    setTab(d.items.length || !d.expenses.length ? 'items' : 'expenses');
    setFieldErrors({});
    setFormError(null);
    recordRecent({ kind: 'liability_payment', id: p.id, number: p.checkNumber, name: p.agencyName, amount: p.amount, date: p.date });
    return d;
  }, []);

  useEffect(() => {
    if (skipLoad.current) {
      // the record was just saved: the draft is already current
      skipLoad.current = false;
      return;
    }
    let alive = true;
    setLoading(true);
    (curId ? loadSaved(curId) : loadNew({ agencyVendorId: props.agencyVendorId, periodStart: props.periodStart, periodEnd: props.periodEnd, kind: props.kind }))
      .then((d) => {
        if (alive && !curId && d.rec.agencyVendorId) void fill(d.rec.agencyVendorId, d.rec.periodEnd, false, props.periodStart && props.periodEnd ? props.periodStart : undefined);
      })
      .catch(async (e) => {
        if (alive) await alertBox(errText(e), 'Tax Payment', 'error');
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curId]);

  // window title, dirty flag and the "save changes?" question
  useEffect(() => {
    if (!rec) return;
    if (rec.kind === 'prior') win.setTitle(isNew ? 'Earlier Tax Payment' : `Earlier Tax Payment - ${rec.agencyName || fmtDate(rec.date)}`);
    else {
      const bankName = bank?.fullName || rec.bankAccountName;
      win.setTitle(bankName ? `Tax Payment - ${bankName}` : 'Tax Payment');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec?.kind, bank?.fullName, rec?.bankAccountName, isNew, rec?.agencyName]);
  useEffect(() => {
    win.setDirty(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // ---- editing
  const update = (patch: Partial<LiabilityPayment>) => setDraft((d) => (d ? { ...d, rec: { ...d.rec, ...patch } } : d));
  const clearError = (f: string) =>
    setFieldErrors((e) => {
      if (!(f in e)) return e;
      const n = { ...e };
      delete n[f];
      return n;
    });

  /** Fills the Taxes and Deductions tab with the agency's unpaid balances as of the period end. */
  /**
   * Fills the Taxes and Deductions tab: with `periodStart` (a payment due opened from the
   * Payroll Center) the remaining amounts the agency is owed for exactly that period, else the
   * agency's unpaid balances as of the period end (a payment entered by hand).
   */
  const fill = async (vendorId: Id | null, periodEnd: string, force = false, periodStart?: string) => {
    if (!vendorId || !periodEnd) return;
    if (!force && !autoLines.current) return;
    const my = ++fillSeq.current;
    try {
      let rows: ItemRow[] | null = null;
      if (periodStart) {
        const due = await api.get<LiabilityDue[]>('/liabilities/due' + qs({ from: periodStart, to: periodEnd, showPaid: 0 }), { noPrompt: true });
        const match = due.filter((r) => r.agencyVendorId === vendorId && r.periodStart === periodStart && r.periodEnd === periodEnd);
        if (match.length) {
          const by = new Map<Id, number>();
          for (const r of match) for (const it of r.items) by.set(it.itemId, round2((by.get(it.itemId) ?? 0) + it.amount));
          rows = [...by.entries()].filter(([, a]) => a !== 0).map(([itemId, amount]) => ({ itemId, amount, memo: '' }));
        }
      }
      if (!rows) {
        const bals = await api.get<LiabilityBalance[]>('/liabilities/balances' + qs({ to: periodEnd }), { noPrompt: true });
        let agencyOf = agenciesRef.current;
        if (!agencyOf.size) agencyOf = await loadAgencies();
        rows = bals.filter((b) => agencyOf.get(b.itemId) === vendorId && b.balance > 0.004).map((b) => ({ itemId: b.itemId, amount: b.balance, memo: '' }));
      }
      if (my !== fillSeq.current) return;
      const list = rows;
      setDraft((d) => (d ? { ...d, items: list } : d));
      autoLines.current = true;
      if (force && !list.length) toast('Nothing is owed to this payee as of ' + fmtDate(periodEnd), { kind: 'info' });
    } catch (e) {
      if (force) await alertBox(errText(e), 'Recalculate', 'error');
    }
  };

  const changeBank = async (id: Id | null) => {
    if (!rec || id === rec.bankAccountId) return;
    clearError('bankAccountId');
    const patch: Partial<LiabilityPayment> = { bankAccountId: id };
    if (isNew && rec.method === 'check' && !rec.toBePrinted) patch.checkNumber = await nextCheckNumber(id);
    update(patch);
  };
  const changeAgency = (id: Id | null, n: BooksName | null) => {
    if (!rec) return;
    clearError('agencyVendorId');
    update({ agencyVendorId: id, agencyName: n?.fullName ?? n?.name ?? '' });
    if (isNew && id) void fill(id, rec.periodEnd);
  };
  const changeMethod = async (m: 'check' | 'e-pay') => {
    if (!rec || m === rec.method) return;
    if (m === 'e-pay') update({ method: m, toBePrinted: false });
    else update({ method: m, checkNumber: rec.checkNumber || (isNew ? await nextCheckNumber(rec.bankAccountId) : '') });
  };
  const togglePrint = async (on: boolean) => {
    if (!rec) return;
    if (on) update({ toBePrinted: true });
    else update({ toBePrinted: false, checkNumber: rec.checkNumber || (await nextCheckNumber(rec.bankAccountId)) });
  };

  // ---- saving
  const validate = (d: Draft): { errors: FieldErrors; message: string | null } => {
    const e: FieldErrors = {};
    const r = d.rec;
    if (!r.date) e.date = 'Enter the payment date.';
    if (r.kind === 'payment' && !r.agencyVendorId) e.agencyVendorId = 'Choose the agency (payee) of the tax payment.';
    if (r.kind === 'payment' && !r.bankAccountId) e.bankAccountId = 'Choose the bank account the check is paid from.';
    if (r.periodStart && r.periodEnd && r.periodStart > r.periodEnd) e.periodStart = 'The period start must be on or before the period end.';
    if (d.items.some((l) => !l.itemId && l.amount)) e.lines = 'Choose the payroll item of every line.';
    else if (d.expenses.some((l) => !l.accountId && l.amount)) e.lines = 'Choose the account of every expense line.';
    else if (d.expenses.some((l) => l.amount < 0)) e.lines = 'Expense amounts must be greater than zero.';
    else if (sum2([...d.items, ...d.expenses].map((l) => l.amount)) <= 0) e.lines = 'Enter the amounts to pay on the Taxes and Deductions tab.';
    return { errors: e, message: null };
  };

  const save = async (): Promise<LiabilityPayment | null> => {
    await commitActiveEditor(rootRef.current);
    const d = draftRef.current;
    if (!d || readOnly) return null;
    const v = validate(d);
    setFieldErrors(v.errors);
    setFormError(v.message);
    if (Object.keys(v.errors).length) {
      if (v.errors.lines) setTab(d.expenses.some((l) => !l.accountId && l.amount) ? 'expenses' : 'items');
      return null;
    }
    const lines: LiabilityPaymentLine[] = [
      ...d.items.filter((l) => l.itemId && l.amount).map((l) => ({ kind: 'item' as const, itemId: l.itemId, accountId: null, amount: round2(l.amount), memo: l.memo, itemName: '', accountName: '' })),
      ...d.expenses.filter((l) => l.accountId && l.amount).map((l) => ({ kind: 'expense' as const, itemId: null, accountId: l.accountId, amount: round2(l.amount), memo: l.memo, itemName: '', accountName: '' })),
    ];
    const body: LiabilityPayment = { ...d.rec, lines, checkNumber: d.rec.method === 'e-pay' || d.rec.toBePrinted || d.rec.kind === 'prior' ? '' : d.rec.checkNumber };
    setSaving(true);
    try {
      const saved = curId ? await api.put<LiabilityPayment>(`/liability-payments/${curId}`, body) : await api.post<LiabilityPayment>('/liability-payments', body);
      const nd = toDraft(saved);
      autoLines.current = false;
      setDraft(nd);
      setBase(snapshot(nd));
      if (!curId) {
        win.setKeyProps({ id: saved.id });
        setCurIdSilently(saved.id);
      }
      recordRecent({ kind: 'liability_payment', id: saved.id, number: saved.checkNumber, name: saved.agencyName, amount: saved.amount, date: saved.date });
      void invalidateAll();
      toast(`${saved.kind === 'prior' ? 'Earlier tax payment' : 'Tax payment'} saved (${fmtMoney(saved.amount)})`);
      if (saved.kind === 'payment' && saved.syncStatus === 'error')
        await alertBox(
          `The tax payment was saved in SerieX Payroll, but it is not in SerieX Books yet:\n${booksErr(saved.syncError)}\n\nUse Retry under the check (or the SerieX Books Sync window) after fixing the problem.`,
          'SerieX Books',
          'warning',
        );
      return saved;
    } catch (e) {
      if (isCancelled(e)) return null;
      const f = e instanceof ApiError ? fieldOf(e.field) : null;
      if (f) setFieldErrors({ [f]: errText(e) });
      else setFormError(errText(e));
      return null;
    } finally {
      setSaving(false);
    }
  };

  /** Switches to the saved record without reloading it. */
  const setCurIdSilently = (id: number) => {
    skipLoad.current = true;
    setCurId(id);
  };

  const askSave = async (): Promise<boolean> => {
    if (!dirtyRef.current) return true;
    const r = await msgBox({
      title: 'Unsaved Changes',
      message: `This ${draftRef.current?.rec.kind === 'prior' ? 'earlier tax payment' : 'tax payment'} has changes that are not saved. Save them before you leave?`,
      buttons: ['&Save', "&Don't Save", 'Cancel'],
      icon: 'question',
    });
    if (r === 'Save') return !!(await save());
    return r === "Don't Save";
  };
  useEffect(() => {
    win.setBeforeClose(askSave);
    return () => win.setBeforeClose(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveClose = async () => {
    if (await save()) await win.close(true);
  };
  const saveNew = async () => {
    if (await save()) goNew();
  };
  const goNew = () => {
    win.setKeyProps({ id: undefined, new: Date.now() });
    if (curId) setCurId(0);
    else void loadNew({ kind: rec?.kind ?? 'payment' });
  };
  const revert = async () => {
    if (!curId) return;
    setLoading(true);
    try {
      await loadSaved(curId);
    } finally {
      setLoading(false);
    }
  };
  const clear = () => void loadNew({ kind: rec?.kind ?? 'payment' });

  /** Reads the posting status again after a SerieX Books retry (keeps the user's unsaved edits). */
  const refreshSync = async () => {
    if (!curId) return;
    const p = await api.get<LiabilityPayment>(`/liability-payments/${curId}`, { noPrompt: true });
    if (!dirtyRef.current) {
      const d = toDraft(p);
      setDraft(d);
      setBase(snapshot(d));
      return;
    }
    update({ syncStatus: p.syncStatus, syncError: p.syncError, booksTxnId: p.booksTxnId });
  };

  const voidIt = async () => {
    if (!rec || !curId) return;
    if (dirty && !(await confirmBox('The tax payment has unsaved changes. Voiding it discards them.\n\nVoid it anyway?', 'Void Tax Payment'))) return;
    if (
      !(await confirmBox(
        `Void this ${prior ? 'earlier tax payment' : `tax payment to ${rec.agencyName}`} for ${fmtMoney(rec.amount)}? The amounts become zero${rec.booksTxnId ? ' and the check is voided in SerieX Books' : ''}; the taxes it paid are owed again.`,
        'Void Tax Payment',
      ))
    )
      return;
    try {
      const p = await api.post<LiabilityPayment>(`/liability-payments/${curId}/void`);
      const d = toDraft(p);
      setDraft(d);
      setBase(snapshot(d));
      void invalidateAll();
      toast('Tax payment voided');
    } catch (e) {
      if (!isCancelled(e)) await alertBox(errText(e), 'Void', 'error');
    }
  };
  const deleteIt = async () => {
    if (!rec) return;
    if (!curId) return clear();
    if (!(await confirmBox(`Delete this ${prior ? 'earlier tax payment' : 'tax payment'}?${rec.booksTxnId ? ' It is also deleted from SerieX Books.' : ''}`, 'Delete Tax Payment'))) return;
    try {
      await api.del(`/liability-payments/${curId}`);
      forgetRecent('liability_payment', curId);
      void invalidateAll();
      toast('Tax payment deleted');
      await win.close(true);
    } catch (e) {
      if (!isCancelled(e)) await alertBox(errText(e), 'Delete', 'error');
    }
  };

  // ---- printing (voucher check: check on top, two stubs)
  const print = async () => {
    let p: LiabilityPayment | null = rec && curId && !dirty ? { ...rec } : await save();
    if (!p) return;
    if (p.kind === 'prior' || p.method === 'e-pay') {
      await alertBox(p.kind === 'prior' ? 'An earlier tax payment has no check to print.' : 'This payment is made electronically (e-pay); there is no check to print.', 'Print');
      return;
    }
    let number = p.checkNumber;
    if (p.toBePrinted) {
      const v = await promptBox('Check number to print on this check:', { defaultValue: await nextCheckNumber(p.bankAccountId), title: 'Print Tax Payment Check' });
      if (v === null) return;
      number = v.trim();
    }
    await printHtml(`Tax Payment Check ${number}`, checkHtml(p, number, addressOf(p)), CHECK_CSS);
    if (p.toBePrinted && number && (await confirmBox(`Did check ${number} print correctly?`, 'Print Tax Payment Check'))) {
      try {
        p = await api.put<LiabilityPayment>(`/liability-payments/${p.id}`, { ...p, toBePrinted: false, checkNumber: number });
        const d = toDraft(p);
        setDraft(d);
        setBase(snapshot(d));
        void invalidateAll();
        toast(`Check ${number} marked as printed`);
      } catch (e) {
        if (!isCancelled(e)) await alertBox(errText(e), 'Print', 'error');
      }
    }
  };

  // ---- batch (Pay Payroll Taxes): Payment i of n
  const batch = props.batch && props.batch.length > 1 && curId ? props.batch : null;
  const pos = batch ? batch.indexOf(curId) : -1;
  const goBatch = (i: number) => {
    if (!batch || i < 0 || i >= batch.length) return;
    openWindow('liabilityPayment', { id: batch[i], batch });
  };

  // ---- grids
  const itemCols = useMemo<GridColumn<ItemRow>[]>(
    () => [
      {
        key: 'itemId',
        label: 'PAYROLL ITEM',
        width: 260,
        editor: (p) => (
          <PayrollItemPicker
            inGrid
            autoFocus
            aria-label="Payroll item"
            types={LIABILITY_TYPES}
            value={p.value as Id | null}
            onChange={(id) => p.onChange(id)}
          />
        ),
        render: (r) => <PayrollItemLabel id={r.itemId} />,
      },
      { key: 'amount', label: 'AMOUNT', width: 120, editor: 'money', align: 'right', blankZero: true },
      { key: 'memo', label: 'MEMO', width: 240, grow: true, editor: 'text' },
    ],
    [],
  );
  const expCols = useMemo<GridColumn<ExpRow>[]>(
    () => [
      {
        key: 'accountId',
        label: 'ACCOUNT',
        width: 260,
        editor: (p) => <AccountPicker inGrid autoFocus aria-label="Account" value={p.value as Id | null} onChange={(id) => p.onChange(id)} />,
        render: (r) => <AccountLabel id={r.accountId} />,
      },
      { key: 'amount', label: 'AMOUNT', width: 120, editor: 'money', align: 'right', blankZero: true },
      { key: 'memo', label: 'MEMO', width: 240, grow: true, editor: 'text' },
    ],
    [],
  );

  if (!rec || !draft) {
    return <FormFrame title="Tax Payment" loading />;
  }

  const status = rec.voided ? 'Void' : prior ? 'Earlier payment' : rec.method === 'e-pay' ? 'E-pay' : rec.toBePrinted ? 'To print' : null;
  const numberSlot = prior ? (
    '—'
  ) : rec.method === 'e-pay' ? (
    'E-pay'
  ) : rec.toBePrinted ? (
    'To Print'
  ) : readOnly ? (
    rec.checkNumber
  ) : (
    <TextField id={`${win.id}-no`} name="checkNumber" aria-label="Check number" value={rec.checkNumber} width={96} onChange={(v) => update({ checkNumber: v })} />
  );

  const totals: FooterTotal[] = [
    ...(expTotal ? [{ key: 'exp', label: 'Expenses', value: expTotal }, { key: 'liab', label: 'Taxes and deductions', value: itemTotal }] : []),
    { key: 'total', label: prior ? 'Payment amount' : 'Check amount', value: total, strong: true },
  ];

  return (
    <FormFrame
      rootRef={rootRef}
      title={prior ? 'Earlier Tax Payment' : 'Tax Payment'}
      status={status}
      isNew={isNew}
      dirty={dirty}
      busy={saving || loading}
      saving={saving}
      loading={loading}
      fieldErrors={fieldErrors}
      formError={formError}
      onClearError={clearError}
      onClearErrors={() => {
        setFieldErrors({});
        setFormError(null);
      }}
      onPrev={batch && pos > 0 ? () => goBatch(pos - 1) : undefined}
      onNext={batch && pos < batch.length - 1 ? () => goBatch(pos + 1) : undefined}
      onNew={() => void (async () => (await askSave()) && goNew())()}
      onSave={readOnly ? undefined : () => void save()}
      onSaveClose={readOnly ? undefined : () => void saveClose()}
      onSaveNew={readOnly ? undefined : () => void saveNew()}
      hideSaveNew={!!batch}
      onRevert={() => void revert()}
      onClear={clear}
      onVoid={curId && !rec.voided ? () => void voidIt() : undefined}
      onDelete={() => void deleteIt()}
      onPrint={prior ? undefined : () => void print()}
      extraButtons={[
        {
          key: 'recalc',
          label: 'Recalculate',
          icon: Calculator,
          title: "Fill the Taxes and Deductions tab with the payee's unpaid balances as of the period end",
          hidden: !isNew || readOnly,
          disabled: !rec.agencyVendorId,
          onClick: () => void fill(rec.agencyVendorId, rec.periodEnd, true),
        },
        { key: 'pay', label: 'Pay Taxes', icon: Landmark, title: 'Pay the payroll taxes that are due', onClick: () => openWindow('payLiabilities') },
      ]}
      reportButtons={[
        { label: 'Payroll Liability Balances', onClick: () => openWindow('report', { key: 'payroll_liability_balances', params: { to: rec.periodEnd } }) },
        { label: 'Payroll Transactions by Payee', onClick: () => openWindow('report', { key: 'payroll_transactions_by_payee' }) },
      ]}
      titleRight={
        <div className="lx-titleright">
          {batch && (
            <span className="lx-batch">
              <ListChecks size={15} aria-hidden="true" /> Payment {pos + 1} of {batch.length}
            </span>
          )}
          {!prior && (
            <CheckAccountBar
              htmlFor={`${win.id}-acct`}
              bankAccount={
                readOnly ? (
                  <span className="lx-readval">{bank?.fullName ?? rec.bankAccountName}</span>
                ) : (
                  <AccountPicker
                    id={`${win.id}-acct`}
                    name="bankAccountId"
                    types={['Bank']}
                    addNew={false}
                    value={rec.bankAccountId}
                    fallbackLabel={rec.bankAccountName || (banksQ.isError && rec.bankAccountId ? 'Default payroll bank account' : undefined)}
                    onChange={(id) => void changeBank(id)}
                    width={250}
                  />
                )
              }
              endingBalance={bank ? bank.balance : null}
            />
          )}
        </div>
      }
      header={
        <CheckFace
          number={numberSlot}
          date={
            readOnly ? (
              fmtDate(rec.date)
            ) : (
              <DateField id={`${win.id}-date`} name="date" aria-label="Date" required value={rec.date} onChange={(v) => update({ date: v })} width={130} />
            )
          }
          payee={
            readOnly ? (
              rec.agencyName
            ) : (
              <VendorPicker
                id={`${win.id}-payee`}
                name="agencyVendorId"
                aria-label="Pay to the order of"
                placeholder={prior ? 'Agency (optional)' : 'Choose the agency'}
                value={rec.agencyVendorId}
                fallbackLabel={rec.agencyName}
                onChange={changeAgency}
              />
            )
          }
          amount={total}
          address={addressOf(rec)}
          memo={readOnly ? rec.memo : <TextField id={`${win.id}-memo`} name="memo" aria-label="Memo" value={rec.memo} onChange={(v) => update({ memo: v })} />}
          stamp={rec.voided ? 'VOID' : null}
        >
          <div className="lx-cf-extra">
            <div className="lx-period">
              <span className="sx-label">PERIOD</span>
              {readOnly ? (
                <span className="lx-readval">{periodText('', rec.periodStart, rec.periodEnd)}</span>
              ) : (
                <>
                  <DateField name="periodStart" aria-label="Period from" value={rec.periodStart} required width={128} onChange={(v) => update({ periodStart: v })} />
                  <span aria-hidden="true">–</span>
                  <DateField
                    name="periodEnd"
                    aria-label="Period to"
                    value={rec.periodEnd}
                    required
                    width={128}
                    onChange={(v) => {
                      update({ periodEnd: v });
                      if (isNew && rec.agencyVendorId && v) void fill(rec.agencyVendorId, v);
                    }}
                  />
                </>
              )}
            </div>
            {!prior && (
              <div className="lx-method">
                <span className="sx-label">METHOD</span>
                <SegmentedControl
                  size="sm"
                  aria-label="Payment method"
                  disabled={readOnly}
                  value={rec.method}
                  onChange={(m) => void changeMethod(m)}
                  options={[
                    { value: 'check', label: 'Check' },
                    { value: 'e-pay', label: 'E-pay' },
                  ]}
                />
              </div>
            )}
            {prior && <span className="lx-muted lx-prior-note">Kept for the amounts owed and the tax forms only: no check is printed and nothing is posted to SerieX Books.</span>}
          </div>
        </CheckFace>
      }
      lines={
        <Tabs
          fill
          className="lx-linetabs"
          aria-label="Expenses, taxes and deductions"
          active={tab}
          onChange={(k) => setTab(k as 'items' | 'expenses')}
          tabs={[
            ...(prior ? [] : [{ key: 'expenses', label: `Expenses  $${fmtMoney(expTotal)}` }]),
            { key: 'items', label: `Taxes and Deductions  $${fmtMoney(itemTotal)}` },
          ]}
        >
          {tab === 'expenses' && !prior ? (
            <Grid<ExpRow>
              aria-label="Expenses"
              columns={expCols}
              rows={draft.expenses}
              readOnly={readOnly}
              onChange={(rows) => {
                clearError('lines');
                setDraft((d) => (d ? { ...d, expenses: rows } : d));
              }}
              newRow={emptyExp}
              minRows={5}
              persistKey="liabcheck-exp"
            />
          ) : (
            <Grid<ItemRow>
              aria-label="Taxes and deductions"
              columns={itemCols}
              rows={draft.items}
              readOnly={readOnly}
              onChange={(rows) => {
                clearError('lines');
                autoLines.current = false;
                setDraft((d) => (d ? { ...d, items: rows } : d));
              }}
              newRow={emptyItem}
              minRows={5}
              persistKey="liabcheck-items"
            />
          )}
        </Tabs>
      }
      footer={
        curId ? (
          <div className="lx-footer">
            <BooksStatusLine
              entity="liability_payment"
              id={curId}
              status={rec.syncStatus}
              error={rec.syncError}
              booksTxnId={rec.booksTxnId}
              voided={rec.voided}
              onRetried={refreshSync}
              noneText={
                prior
                  ? 'Earlier tax payments are not posted to SerieX Books (they were entered in your books when you paid them).'
                  : prefs.postToBooks
                    ? 'Not in SerieX Books.'
                    : 'Not posted: posting to SerieX Books is turned off in Preferences.'
              }
            />
            {rec.createdBy && (
              <span className="lx-muted lx-created">
                Entered by {rec.createdBy}
                {rec.createdAt ? ` on ${localDate(rec.createdAt)}` : ''}
              </span>
            )}
          </div>
        ) : null
      }
      bottomLeft={
        !prior && rec.method === 'check' ? (
          <Checkbox label="Print later" checked={rec.toBePrinted} disabled={readOnly} onChange={(v) => void togglePrint(v)} title="Print this check later (no check number until it is printed)" />
        ) : undefined
      }
      totals={totals}
    />
  );
}

/** Agency of every liability item (when the item list is not loaded yet). */
async function loadAgencies(): Promise<Map<Id, Id | null>> {
  const [items, sched] = await Promise.all([
    api.get<PayrollItem[]>('/items?active=all', { noPrompt: true }),
    api.get<PaymentSchedule[]>('/payment-schedules', { noPrompt: true }),
  ]);
  const byGroup = new Map(sched.map((s) => [s.paymentGroup, s.agencyVendorId]));
  return new Map(items.map((i) => [i.id, i.agencyVendorId ?? byGroup.get(i.effectiveGroup) ?? null]));
}

// ---------------------------------------------------------------------------
// Printed check

const CHECK_CSS = `
  .chk { position: relative; height: 3.2in; border-bottom: 1px dashed #888; padding: 0.25in 0.3in 0; }
  .chk .date { position: absolute; right: 0.4in; top: 0.45in; }
  .chk .no { position: absolute; right: 0.4in; top: 0.2in; font-weight: bold; }
  .chk .payee { position: absolute; left: 0.3in; top: 0.95in; font-size: 12px; }
  .chk .amt { position: absolute; right: 0.4in; top: 0.95in; font-size: 13px; font-weight: bold; }
  .chk .words { position: absolute; left: 0.3in; top: 1.3in; right: 0.4in; border-bottom: 1px solid #999; }
  .chk .addr { position: absolute; left: 0.6in; top: 1.65in; white-space: pre-line; }
  .chk .memo { position: absolute; left: 0.3in; top: 2.65in; }
  .chk .lbl { color: #555; font-size: 9px; margin-right: 6px; }
  .stub { height: 3.3in; padding: 0.2in 0.3in; border-bottom: 1px dashed #888; }
  .stub:last-child { border-bottom: none; }
  .stub h2 { display: flex; justify-content: space-between; font-size: 12px; border-bottom: 1px solid #000; padding-bottom: 3px; }
  .stub table { margin-top: 6px; }
  .stub td.num, .stub th.num { text-align: right; }
  .stub tfoot td { border-top: 1px solid #000; font-weight: bold; }
`;

function checkHtml(p: LiabilityPayment, number: string, address: string): string {
  const lines = p.lines.filter((l) => l.amount);
  const rows = lines
    .map((l) => `<tr><td>${escHtml(l.kind === 'item' ? l.itemName : l.accountName || 'Expense')}</td><td>${escHtml(l.memo)}</td><td class="num">${fmtMoney(l.amount)}</td></tr>`)
    .join('');
  const stub = `<div class="stub"><h2><span>${escHtml(p.agencyName)}</span><span>Tax Payment ${escHtml(number)}</span><span>${fmtDate(p.date)}</span></h2>
    <div>Period: ${fmtDate(p.periodStart)} - ${fmtDate(p.periodEnd)}${p.memo ? ` &nbsp; Memo: ${escHtml(p.memo)}` : ''}</div>
    <table><thead><tr><th>Payroll item / account</th><th>Memo</th><th class="num">Amount</th></tr></thead><tbody>${rows}</tbody>
    <tfoot><tr><td colspan="2">Total</td><td class="num">${fmtMoney(p.amount)}</td></tr></tfoot></table></div>`;
  return `<div class="chk"><div class="no">${escHtml(number)}</div><div class="date">${fmtDate(p.date)}</div>
    <div class="payee"><span class="lbl">PAY TO THE ORDER OF</span>${escHtml(p.agencyName)}</div>
    <div class="amt">**${fmtMoney(p.amount)}</div>
    <div class="words">${escHtml(amountInWords(p.amount))}${'*'.repeat(20)}</div>
    <div class="addr">${escHtml(address)}</div>
    <div class="memo"><span class="lbl">MEMO</span>${escHtml(p.memo)}</div></div>${stub}${stub}`;
}
