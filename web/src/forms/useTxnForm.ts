// State and actions of a transaction form (Create Invoices, Enter Bills, Write Checks...).
//
//   const form = useTxnForm({ type: 'INV', id: props.id, makeNew: () => ({ ...emptyTxn('INV', todayIso()), ... }) });
//   <TxnFormFrame form={form} title="Invoice" header={...} lines={...} footer={...} />
//
// Loads the transaction (or builds a new one), tracks changes, saves with POST/PUT (server
// "confirm" / closing-date questions are handled by the API client), refreshes every window
// (invalidateAll), asks whether to save unsaved changes before closing or navigating away,
// warns about dates far in the past/future (preferences), and handles Previous/Next, Delete,
// Void, Copy, Memorize, Transaction History and Transaction Journal. Escape closes the window.
//
// Inline validation: required fields (`required`, sensible defaults per type), the
// client `validate()` and server errors (ApiError.field) become `fieldErrors`; TxnFormFrame shows
// them as a red border + short message under the control whose `name` is that field (TextField,
// MoneyField, DateField, pickers...) and lists them in a banner at the top; the first invalid
// field is focused. Editing a field clears its error. Errors without a field (or with a field
// that has no control, e.g. "lines") go to the banner (`formError` / the "lines" entry).
// Message boxes remain only for real questions (date warnings, delete/void confirmations).
//
// After a save a toast says "Invoice 1042 saved" (with "Open" when the window closed or moved
// on to a new transaction); loaded/saved transactions are recorded in util/recent (the "+ New"
// panel's Recent list) and deleted ones are removed from it.
//
// Keyboard: after New / Save and new / Clear / Delete the cursor goes to the first header field
// (the field the form focused when it opened, else CUSTOMER/VENDOR/PAYEE, else the first one);
// after No to a server question it goes to the field the question is about (number, date...).
// A clean form reloads by itself when its transaction changes elsewhere (e.g. a PO after
// Receive Items). A window opened from a memorized transaction (prop `memorizedId`) advances
// that schedule after its first save (POST /memorized/{id}/advance).
// An inactive name / account / item the user chose to "Use Once" in a picker is not asked about
// again by the server when saving (accept=inactive, only when no other inactive record is new).
// A `template` (memorized transaction, copy) fills only the first new transaction of the window:
// New / Save and new / Clear afterwards start blank.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '@/api/client';
import { invalidateAll, queryClient, usePrefValues } from '@/api/hooks';
import { emptyTxn, TXN_TYPE_LABELS, type ID, type Prefs, type Txn, type TxnLine, type TxnType } from '@/api/types';
import { useOptionalWindow, type WindowApi } from '@/windows/WindowContext';
import { openTxn, openWindow } from '@/windows/windowStore';
import { alertBox, confirmBox, msgBox } from '@/components/dialogs';
import { commitActiveEditor, focusField, tabbables } from '@/components/focus';
import { findFieldElement, focusFirstError as focusFirstErrorIn, type FieldErrors } from '@/components/formErrors';
import { useHotkeys } from '@/components/hotkeys';
import { forgetInactiveUsedOnce, inactiveRecordKey, inactiveUsedOnce, type InactiveRecordKind } from '@/components/pickers';
import { toast } from '@/components/toast';
import { daysBetween, todayIso } from '@/util/dates';
import { fmtDate } from '@/util/format';
import { forgetRecentTxn, recordRecentTxn } from '@/util/recent';
import { showTransactionHistory } from './TransactionHistory';

/** Window props that fill only the first new transaction of a form window. */
const ONE_TIME_PROPS = ['template', 'memorizedId'];

/** How a save ends: close the window, start a new blank form, or stay on the saved transaction. */
export type SaveMode = 'close' | 'new' | 'stay';

/** A client-side validation problem: shown under the control named `field` and in the banner. */
export interface TxnProblem {
  /** Short plain-English message ("Choose a customer."). */
  message: string;
  /** name / data-field of the control (a Txn field such as "nameId", "date", or "lines"). */
  field?: string;
  /** (unused since inline errors; kept for compatibility) */
  title?: string;
}

/**
 * A required header field: the Txn field name (also the control's `name`) or a rule with its
 * own message / test. Defaults per type: see {@link defaultRequired}.
 */
export type RequiredField = string | { field: string; message?: string; test?: (txn: Txn) => boolean };

const NAME_REQUIRED: Partial<Record<TxnType, string>> = {
  INV: 'Choose a customer or job.',
  PMT: 'Choose the customer who paid.',
  CREDMEM: 'Choose a customer or job.',
  STMTCHG: 'Choose a customer or job.',
  EST: 'Choose a customer or job.',
  REFUND: 'Choose the customer to refund.',
  BILL: 'Choose a vendor.',
  BILLCRED: 'Choose a vendor.',
  BILLPMT: 'Choose a vendor.',
  ITEMRCPT: 'Choose a vendor.',
  PURCHORD: 'Choose a vendor.',
  TAXPMT: 'Choose the sales tax agency.',
};
const ACCOUNT_REQUIRED: Partial<Record<TxnType, string>> = {
  CHK: 'Choose the bank account.',
  CCCHARGE: 'Choose the credit card account.',
  CCCREDIT: 'Choose the credit card account.',
  DEP: 'Choose the account to deposit to.',
  TRANSFER: 'Choose the account to transfer from.',
  BILLPMT: 'Choose the account to pay from.',
  REFUND: 'Choose the account the refund comes from.',
  TAXPMT: 'Choose the bank account to pay from.',
  INVADJ: 'Choose the adjustment account.',
};

/**
 * Required header fields of a transaction type (as the server validates them): the customer/vendor where the
 * server requires one, and the header account where the server has no default. The date is
 * always required.
 */
export function defaultRequired(type: TxnType): RequiredField[] {
  const r: RequiredField[] = [];
  if (NAME_REQUIRED[type]) r.push({ field: 'nameId', message: NAME_REQUIRED[type] });
  if (ACCOUNT_REQUIRED[type]) r.push({ field: 'accountId', message: ACCOUNT_REQUIRED[type] });
  if (type === 'TRANSFER') r.push({ field: 'toAccountId', message: 'Choose the account to transfer to.' });
  return r;
}

const FRIENDLY: Record<TxnType, string> = {
  INV: 'Invoice',
  SALESRCPT: 'Sales receipt',
  PMT: 'Payment',
  CREDMEM: 'Credit memo',
  STMTCHG: 'Statement charge',
  EST: 'Estimate',
  DEP: 'Deposit',
  CHK: 'Check',
  REFUND: 'Refund',
  BILL: 'Bill',
  BILLCRED: 'Vendor credit',
  BILLPMT: 'Bill payment',
  ITEMRCPT: 'Item receipt',
  PURCHORD: 'Purchase order',
  CCCHARGE: 'Credit card charge',
  CCCREDIT: 'Credit card credit',
  TRANSFER: 'Transfer',
  GENJRNL: 'Journal entry',
  INVADJ: 'Inventory adjustment',
  TAXPMT: 'Sales tax payment',
};

/** Plain name of a transaction for messages: "Invoice 1042", "Check", "Journal entry 12". */
export function txnDisplayName(t: Pick<Txn, 'type' | 'refNumber'>): string {
  const base = FRIENDLY[t.type] ?? TXN_TYPE_LABELS[t.type] ?? 'Transaction';
  return t.refNumber ? `${base} ${t.refNumber}` : base;
}

/** Field a declined server question is about (the cursor goes there after No). */
function fieldOfWarning(e: ApiError): string | undefined {
  if (e.field) return e.field;
  switch (e.warning) {
    case 'dupnum':
      return 'refNumber';
    case 'creditlimit':
      return 'nameId';
    case 'closing':
      return 'date';
    case 'inventory':
      return 'lines';
    default:
  }
  const q = String(e.data?.question ?? '');
  if (/number\b.*\b(already|been) used|already in use|duplicate/i.test(q)) return 'refNumber';
  return undefined;
}

/** The accounts, names and items a transaction uses (keys "names:65"), as the server's inactive check reads them. */
function recordKeys(t: Txn): Set<string> {
  const out = new Set<string>();
  const add = (kind: InactiveRecordKind, id: ID | null | undefined) => {
    if (id) out.add(inactiveRecordKey(kind, id));
  };
  add('accounts', t.accountId);
  add('accounts', t.arApAccountId);
  add('accounts', t.toAccountId);
  add('accounts', t.cashBackAccountId);
  add('names', t.nameId);
  add('items', t.taxItemId);
  for (const l of t.lines ?? []) {
    add('accounts', l.accountId);
    add('names', l.nameId);
    add('items', l.itemId);
  }
  return out;
}

/** True when a loaded list (accounts / names / items queries) shows the record as inactive; unknown = active. */
function knownInactive(key: string): boolean {
  const [kind, idText] = key.split(':');
  const id = Number(idText);
  for (const [, data] of queryClient.getQueriesData<unknown>({ queryKey: [kind] })) {
    if (!Array.isArray(data)) continue;
    const r = (data as { id?: unknown; active?: unknown }[]).find((x) => !!x && x.id === id);
    if (r) return r.active === false;
  }
  return false;
}

/** What the server would ask before voiding / deleting (GET /txns/{id}/remove-check); null = no check available. */
interface RemoveCheck {
  question?: string;
  warning?: string;
}

function emptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === '' || v === 0 || (Array.isArray(v) && v.length === 0);
}

/** Options of {@link useTxnForm}. */
export interface UseTxnFormOptions {
  type: TxnType;
  /** Transaction to open (undefined/0 = new). */
  id?: number | null;
  /** Builds a new blank transaction (may be async, e.g. to fetch the next number or defaults). */
  makeNew: () => Txn | Promise<Txn>;
  /** Called after a transaction was loaded or a new one was created. */
  onLoaded?: (txn: Txn, isNew: boolean) => void;
  /**
   * Prepares the transaction for saving (drop empty lines, compute amounts...).
   * Default: removes empty lines (see {@link isEmptyLine}).
   */
  prepare?: (txn: Txn) => Txn;
  /**
   * Client-side checks before saving (after `prepare` and the required fields); return a
   * problem, a message, or a list of problems to stop. Each problem with a `field` is shown
   * under that control.
   */
  validate?: (txn: Txn) => TxnValidateResult | Promise<TxnValidateResult>;
  /** Required header fields (default {@link defaultRequired}(type); pass [] to turn off). */
  required?: RequiredField[];
  /** Called after a successful save (before closing / clearing). */
  afterSave?: (saved: Txn, mode: SaveMode) => void;
  /** Type used by Previous/Next and "Find" (default `type`; e.g. bills and credits share a form). */
  navType?: TxnType;
  /**
   * Toast after saving (default true: "Invoice 1042 saved"). A function returns the message
   * (null for none).
   */
  toastOnSave?: boolean | ((saved: Txn, mode: SaveMode) => string | null);
  /** Record opened/saved transactions in the Recent list (default true). */
  recordRecent?: boolean;
}

/** What `validate` may return. */
export type TxnValidateResult = TxnProblem | TxnProblem[] | string | null | undefined;

/** Everything a form needs (see {@link useTxnForm}). */
export interface TxnForm {
  txn: Txn;
  /** Replaces the transaction (marks the form changed). */
  setTxn(next: Txn | ((t: Txn) => Txn)): void;
  /** Merges fields into the transaction (marks the form changed). */
  update(patch: Partial<Txn>): void;
  /** Replaces the lines (marks the form changed). */
  setLines(lines: TxnLine[]): void;
  /** Replaces the transaction without marking it changed (e.g. defaults filled after load). */
  reset(txn: Txn): void;
  dirty: boolean;
  loading: boolean;
  saving: boolean;
  isNew: boolean;
  /** The transaction as loaded / last saved (null for a new form). */
  original: Txn | null;
  /** Saves; resolves true on success. */
  save(mode?: SaveMode): Promise<boolean>;
  /** Deletes after confirmation (a new form is just cleared). */
  remove(): Promise<boolean>;
  /** Voids after confirmation. */
  voidTxn(): Promise<boolean>;
  goPrev(): Promise<void>;
  goNext(): Promise<void>;
  /** "Create a Copy": the same content as a new unsaved transaction. */
  copy(): Promise<void>;
  memorize(): void;
  /** Transaction History (linked transactions). */
  history(): void;
  /** Transaction Journal report of this transaction. */
  journal(): void;
  /** New form → blank form; existing → revert to the saved version. */
  clear(): Promise<void>;
  /** "New": asks to save changes, then shows a blank new transaction. */
  newTxn(): Promise<void>;
  /** Discards changes (reloads the saved version). */
  revert(): void;
  /** Opens another transaction in this form (asks to save changes first). */
  load(id: number): Promise<void>;
  /** Closes the window (asks to save changes). */
  close(): Promise<boolean>;
  /** Attach to the form's root element (TxnFormFrame does it) — used to focus error fields. */
  rootRef: React.MutableRefObject<HTMLDivElement | null>;
  prefs: Prefs;
  win: WindowApi | null;
  type: TxnType;
  /** Inline errors by field name (TxnFormFrame provides them to the controls and the banner). */
  fieldErrors: FieldErrors;
  /** General problem without a field (shown in the banner), e.g. a failed delete. */
  formError: string | null;
  /** True when there is any field error or a form error. */
  hasErrors: boolean;
  /** Sets (or clears with null) one field's error. */
  setFieldError(field: string, message: string | null): void;
  /** Replaces all errors (and the form error); focuses the first invalid field. */
  setFieldErrors(errors: FieldErrors, formError?: string | null): void;
  /** Sets (or clears) the general banner message. */
  setFormError(message: string | null): void;
  /** Removes every error. */
  clearErrors(): void;
  /** Focuses the first field with an error (true when one was focused). */
  focusFirstError(): boolean;
}

/**
 * A line with nothing in it: no item, no amount, no quantity/rate, no description and no links.
 * An account alone does not count (vendor pre-fill lines left at zero are dropped).
 */
export function isEmptyLine(l: TxnLine): boolean {
  return (
    l.itemId === null &&
    !l.amount &&
    l.nameId === null &&
    (l.qty === null || l.qty === 0) &&
    (l.rate === null || l.rate === 0) &&
    !(l.description ?? '').trim() &&
    l.linkedTxnId === null &&
    l.linkedLineId === null
  );
}

/** Default preparation: drop empty lines and renumber `seq`. */
export function stripEmptyLines(t: Txn): Txn {
  const lines = t.lines.filter((l) => !isEmptyLine(l)).map((l, i) => (l.seq === i + 1 ? l : { ...l, seq: i + 1 }));
  return { ...t, lines };
}

/** Copy of a transaction as a new one (ids cleared, number blank, links dropped). */
export function copyAsNew(t: Txn): Txn {
  return {
    ...t,
    id: 0,
    refNumber: '',
    status: '',
    voided: false,
    openBalance: 0,
    links: [],
    linked: [],
    cleared: '',
    createdBy: '',
    createdAt: '',
    updatedAt: '',
    memo: t.memo.replace(/^VOID: /, ''),
    lines: t.lines.map((l) => ({ ...l, id: 0, linkedTxnId: null, linkedLineId: null, billedTxnId: null, receivedQty: 0, cogs: 0 })),
  };
}

/** Form state + actions for a transaction window. See {@link TxnForm}. */
export function useTxnForm(opts: UseTxnFormOptions): TxnForm {
  const { type } = opts;
  const win = useOptionalWindow();
  const winRef = useRef(win);
  winRef.current = win;
  const prefs = usePrefValues();
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  // placeholder until makeNew() / the load finishes
  const blank = useMemo(() => emptyTxn(type, todayIso()), [type]);
  const [txn, setTxnState] = useState<Txn>(blank);
  const txnRef = useRef<Txn>(blank);
  const [dirty, setDirtyState] = useState(false);
  const dirtyRef = useRef(false);
  const [loading, setLoadingState] = useState(true);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const originalRef = useRef<Txn | null>(null);
  const [original, setOriginal] = useState<Txn | null>(null);
  const loadSeq = useRef(0);
  const loadingRef = useRef(true);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** Put the cursor in the first header field once the next load finishes (New, Save and new...). */
  const wantFieldFocus = useRef(false);
  /** name of the field the form focused when it opened (its own initial focus, e.g. CUSTOMER OR JOB). */
  const initialField = useRef<string | null>(null);
  /** Memorized transaction this window was opened from: its schedule advances after the first save. */
  const memorizedId = useRef<number | null>(Number(win?.props?.memorizedId) || null);
  /**
   * The window has shown its first transaction: window props that fill only the first new one
   * (`template` of a memorized transaction or copy, `memorizedId`) are dropped before the next
   * new transaction is built, so New / Save and new start blank (no duplicate of the template).
   */
  const firstShown = useRef(false);
  /** Element to return to when no field can be focused (the editor blurred to commit may be gone). */
  const focusBack = useRef<HTMLElement | null>(null);

  // ---- inline errors
  const [fieldErrors, setFieldErrorsState] = useState<FieldErrors>({});
  const errorsRef = useRef<FieldErrors>({});
  const [formError, setFormErrorState] = useState<string | null>(null);
  const putErrors = (e: FieldErrors) => {
    errorsRef.current = e;
    setFieldErrorsState(e);
  };
  const setFieldError = useCallback((field: string, message: string | null) => {
    const cur = errorsRef.current;
    if (message) {
      if (cur[field] !== message) putErrors({ ...cur, [field]: message });
    } else if (field in cur) {
      const n = { ...cur };
      delete n[field];
      putErrors(n);
    }
  }, []);
  const clearErrors = useCallback(() => {
    if (Object.keys(errorsRef.current).length) putErrors({});
    setFormErrorState(null);
  }, []);
  const focusFirstError = useCallback((): boolean => {
    const errs = errorsRef.current;
    if (focusFirstErrorIn(rootRef.current, errs)) return true;
    return false;
  }, []);
  const pendingFocus = useRef(false);
  const setFieldErrors = useCallback((errs: FieldErrors, message: string | null = null) => {
    putErrors(errs);
    setFormErrorState(message);
    pendingFocus.current = true;
  }, []);
  // focus the first invalid field once the errors are rendered
  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    if (!focusFirstErrorIn(rootRef.current, fieldErrors)) {
      const el = focusBack.current;
      if (el && el.isConnected && el !== document.body) el.focus();
      else rootRef.current?.focus({ preventScroll: true });
    }
  }, [fieldErrors, formError]);

  const setDirty = (d: boolean) => {
    dirtyRef.current = d;
    setDirtyState(d);
  };
  const setLoading = (v: boolean) => {
    loadingRef.current = v;
    setLoadingState(v);
  };

  /**
   * Puts the cursor in the first header field of the form (after New / Save and new...): the
   * field the form focused when it opened, else the customer / vendor / payee, else the first
   * editable header field. Leaves the focus alone when a field of this form already has it, or
   * a message box / another window has it.
   */
  const focusFirstField = (): boolean => {
    const root = rootRef.current;
    if (!root || !root.isConnected) return false;
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae !== root && root.contains(ae) && ae.matches('input, select, textarea')) return true;
    if (ae && ae !== document.body && !root.contains(ae)) {
      // a message box / popup outside the windows, or another window: not ours to move
      if (!ae.closest('[data-window-id]') || ae.closest('[data-window-id]') !== root.closest('[data-window-id]')) return false;
    }
    const ok = (el: Element | null): el is HTMLElement =>
      !!el && el instanceof HTMLElement && el.matches('input, select, textarea') && !(el as HTMLInputElement).disabled && !(el as HTMLInputElement).readOnly && tabbables(el.parentElement ?? root).includes(el);
    const header = root.querySelector<HTMLElement>('.sx-txnform-header') ?? root;
    const byName = (n: string) => root.querySelector(`[name="${n}"]`);
    let target: HTMLElement | null = null;
    if (initialField.current && ok(byName(initialField.current))) target = byName(initialField.current) as HTMLElement;
    if (!target) {
      const n = header.querySelector('[name="nameId"]');
      if (ok(n)) target = n;
    }
    if (!target) target = tabbables(header).find((el) => ok(el)) ?? null;
    if (!target) return false;
    target.focus();
    if (target instanceof HTMLInputElement) target.select();
    return true;
  };

  const reset = useCallback((t: Txn) => {
    txnRef.current = t;
    setTxnState(t);
    setDirty(false);
    if (Object.keys(errorsRef.current).length) putErrors({});
    setFormErrorState(null);
    originalRef.current = t.id ? t : null;
    setOriginal(t.id ? t : null);
    // the window now shows this record: opening it elsewhere focuses this window
    const w = winRef.current;
    if (w && typeof w.setKeyProps === 'function') w.setKeyProps({ id: t.id || undefined });
  }, []);

  const setTxn = useCallback((next: Txn | ((t: Txn) => Txn)) => {
    const prev = txnRef.current;
    const v = typeof next === 'function' ? next(prev) : next;
    if (v === prev) return;
    txnRef.current = v;
    setTxnState(v);
    setDirty(true);
    // editing a field clears its error
    const errs = errorsRef.current;
    const keys = Object.keys(errs);
    if (keys.length) {
      const changed = keys.filter((k) => k in v && (v as unknown as Record<string, unknown>)[k] !== (prev as unknown as Record<string, unknown>)[k]);
      if (changed.length) {
        const n = { ...errs };
        for (const k of changed) delete n[k];
        putErrors(n);
      }
    }
  }, []);
  const update = useCallback((patch: Partial<Txn>) => setTxn((t) => ({ ...t, ...patch })), [setTxn]);
  const setLines = useCallback((lines: TxnLine[]) => setTxn((t) => ({ ...t, lines })), [setTxn]);

  const remember = (t: Txn) => {
    if (optsRef.current.recordRecent === false || !t.id) return;
    recordRecentTxn({ id: t.id, type: t.type, refNumber: t.refNumber, nameFull: t.nameFull, amount: t.amount, date: t.date });
  };

  /** Removes the one-time prefill props (template, memorizedId) and waits until the form re-rendered without them. */
  const dropOneTimeProps = async () => {
    memorizedId.current = null;
    const w = winRef.current;
    if (!w || typeof w.setProps !== 'function') return;
    const keys = ONE_TIME_PROPS.filter((k) => w.props?.[k] !== undefined);
    if (!keys.length) return;
    w.setProps(Object.fromEntries(keys.map((k) => [k, undefined])));
    // makeNew reads the props of the latest render
    for (let i = 0; i < 50 && keys.some((k) => winRef.current?.props?.[k] !== undefined); i++) await new Promise((r) => setTimeout(r, 0));
  };

  // ---- loading
  const loadNew = useCallback(async () => {
    const seq = ++loadSeq.current;
    forgetInactiveUsedOnce(winRef.current?.id);
    setLoading(true);
    try {
      if (firstShown.current) await dropOneTimeProps();
      const t = await optsRef.current.makeNew();
      if (seq !== loadSeq.current) return;
      reset(t);
      firstShown.current = true;
      optsRef.current.onLoaded?.(t, true);
    } catch (e) {
      if (seq === loadSeq.current) await alertBox((e as Error).message, 'Error');
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [reset]);

  const loadId = useCallback(
    async (id: number) => {
      const seq = ++loadSeq.current;
      forgetInactiveUsedOnce(winRef.current?.id);
      setLoading(true);
      try {
        const t = await queryClient.fetchQuery({ queryKey: ['txn', id], queryFn: () => api.get<Txn>(`/txns/${id}`), staleTime: 0 });
        if (seq !== loadSeq.current) return;
        reset(t);
        firstShown.current = true;
        remember(t);
        optsRef.current.onLoaded?.(t, false);
      } catch (e) {
        if (seq !== loadSeq.current) return;
        await alertBox((e as Error).message, 'Error');
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [reset],
  );

  useEffect(() => {
    if (opts.id) void loadId(opts.id);
    else void loadNew();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.id]);

  // Remember which field the form put the cursor in when it opened (autoFocus or its own logic),
  // and put the cursor back in the first field after New / Save and new / Clear / Delete.
  const firstLoadDone = useRef(false);
  useEffect(() => {
    if (loading) return;
    if (!firstLoadDone.current) {
      firstLoadDone.current = true;
      const t = window.setTimeout(() => {
        const root = rootRef.current;
        const ae = document.activeElement as HTMLElement | null;
        if (root && ae && root.contains(ae) && ae.matches('input, select, textarea')) initialField.current = ae.getAttribute('name');
      }, 0);
      return () => window.clearTimeout(t);
    }
    if (!wantFieldFocus.current) return;
    wantFieldFocus.current = false;
    // after the form's own effects (some forms focus a field themselves once loaded)
    const t = window.setTimeout(() => focusFirstField(), 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, txn]);

  /** Loads a blank new transaction and puts the cursor in its first field. */
  const loadNewFocused = useCallback(async () => {
    wantFieldFocus.current = true;
    await loadNew();
  }, [loadNew]);

  const refreshRef = useRef<((id: number) => Promise<void>) | null>(null);
  // Back to this window (tab): reload a clean form whose transaction changed meanwhile.
  useEffect(() => {
    const id = txnRef.current.id;
    if (!win?.isActive || !id || dirtyRef.current || savingRef.current || loadingRef.current) return;
    if (queryClient.getQueryState(['txn', id])?.isInvalidated) void refreshRef.current?.(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win?.isActive]);

  // A clean form follows changes made elsewhere (another window saved a transaction that changes
  // this one, e.g. Receive Items updates the PO's RCV'D quantities): when its transaction query
  // is invalidated (every save refreshes all queries), it reloads quietly.
  useEffect(() => {
    let busy = false;
    const refresh = async (id: number) => {
      if (busy) return;
      busy = true;
      try {
        const t = await queryClient.fetchQuery({ queryKey: ['txn', id], queryFn: () => api.get<Txn>(`/txns/${id}`, { noPrompt: true }), staleTime: 0 });
        if (txnRef.current.id !== id || dirtyRef.current || savingRef.current || loadingRef.current) return;
        if (originalRef.current && JSON.stringify(originalRef.current) === JSON.stringify(t)) return;
        reset(t);
        optsRef.current.onLoaded?.(t, false);
      } catch {
        /* deleted or unreachable: keep what is shown */
      } finally {
        busy = false;
      }
    };
    refreshRef.current = refresh;
    return queryClient.getQueryCache().subscribe((ev) => {
      if (ev.type !== 'updated' || ev.action.type !== 'invalidate') return;
      const key = ev.query.queryKey;
      const id = txnRef.current.id;
      if (!id || key[0] !== 'txn' || key[1] !== id) return;
      if (dirtyRef.current || savingRef.current || loadingRef.current) return;
      window.setTimeout(() => void refresh(id), 50);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- window integration
  useEffect(() => {
    winRef.current?.setDirty(dirty);
  }, [dirty]);

  /** Asks to record changes; true when it is fine to continue (saved or discarded). */
  const confirmLeave = useCallback(async (): Promise<boolean> => {
    await commitActiveEditor(rootRef.current);
    if (!dirtyRef.current) return true;
    const r = await msgBox({
      title: 'Unsaved Changes',
      message: 'This transaction has changes that are not saved. Save them before you leave?',
      buttons: ['&Save', "&Don't Save", 'Cancel'],
      icon: 'question',
    });
    if (r === 'Save') return doSave('stay', true);
    return r === "Don't Save";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!win) return;
    win.setBeforeClose(() => confirmLeave());
    const id = win.id;
    return () => {
      win.setBeforeClose(null);
      forgetInactiveUsedOnce(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win?.id]);

  // ---- save
  const problemsOf = (p: TxnValidateResult): TxnProblem[] => {
    if (!p) return [];
    if (typeof p === 'string') return [{ message: p }];
    return Array.isArray(p) ? p.filter((x) => x && x.message) : [p];
  };

  /** Shows problems inline (field errors) and in the banner; focuses the first invalid field. */
  const showProblems = (list: TxnProblem[]) => {
    const errs: FieldErrors = {};
    const general: string[] = [];
    for (const p of list) {
      if (p.field && !(p.field in errs)) errs[p.field] = p.message;
      else if (!p.field) general.push(p.message);
    }
    // a field without a control on screen is still listed in the banner (by its error entry)
    setFieldErrors(errs, general.length ? general.join(' ') : null);
  };
  const showProblem = (p: TxnProblem) => showProblems([p]);

  const requiredProblems = (t: Txn): TxnProblem[] => {
    const rules = optsRef.current.required ?? defaultRequired(optsRef.current.type);
    const out: TxnProblem[] = [];
    for (const r of rules) {
      const rule = typeof r === 'string' ? { field: r } : r;
      const ok = rule.test ? rule.test(t) : !emptyValue((t as unknown as Record<string, unknown>)[rule.field]);
      if (!ok) out.push({ field: rule.field, message: rule.message ?? 'This field is required.' });
    }
    return out;
  };

  const doSave = async (mode: SaveMode, fromPrompt = false): Promise<boolean> => {
    if (savingRef.current) return false;
    focusBack.current = document.activeElement as HTMLElement | null;
    await commitActiveEditor(rootRef.current);
    // a field still holds text it could not accept (e.g. a date like 2/30): fix it first
    const badEntry = rootRef.current?.querySelector<HTMLInputElement>('[data-invalid-entry]');
    if (badEntry) {
      badEntry.focus();
      badEntry.select?.();
      return false;
    }
    const o = optsRef.current;
    let t = txnRef.current;
    const p = prefsRef.current;
    if (!t.date) {
      showProblems([{ message: 'Enter a date for this transaction.', field: 'date' }, ...requiredProblems(t)]);
      return false;
    }
    const prepared = o.prepare ? o.prepare(t) : stripEmptyLines(t);
    const problems = [...requiredProblems(prepared), ...problemsOf(o.validate ? await o.validate(prepared) : null)];
    if (problems.length) {
      showProblems(problems);
      return false;
    }
    const dateChanged = !originalRef.current || originalRef.current.date !== t.date;
    if (dateChanged) {
      const diff = daysBetween(todayIso(), t.date);
      if (p.datePastWarnDays > 0 && -diff > p.datePastWarnDays) {
        const ok = await confirmBox(
          `The date ${fmtDate(t.date)} is more than ${p.datePastWarnDays} days in the past.\n\nAre you sure you want to use this date?`,
          'Check the date',
        );
        if (!ok) {
          focusField(rootRef.current, 'date');
          return false;
        }
      } else if (p.dateFutureWarnDays > 0 && diff > p.dateFutureWarnDays) {
        const ok = await confirmBox(
          `The date ${fmtDate(t.date)} is more than ${p.dateFutureWarnDays} days in the future.\n\nAre you sure you want to use this date?`,
          'Check the date',
        );
        if (!ok) {
          focusField(rootRef.current, 'date');
          return false;
        }
      }
    }
    t = prepared;
    clearErrors();
    savingRef.current = true;
    setSaving(true);
    let failure: TxnProblem | null = null;
    let declined: ApiError | null = null;
    try {
      const created = !t.id;
      const accept = inactiveAccept(t);
      const reqOpts = accept ? { accept } : undefined;
      const saved = t.id ? await api.put<Txn>(`/txns/${t.id}`, t, reqOpts) : await api.post<Txn>('/txns', t, reqOpts);
      forgetInactiveUsedOnce(winRef.current?.id);
      queryClient.setQueryData(['txn', saved.id], saved);
      if (created && memorizedId.current) {
        // entered from a memorized transaction: its schedule moves to the next date (once per window)
        const mid = memorizedId.current;
        memorizedId.current = null;
        void api
          .post(`/memorized/${mid}/advance`, { txnId: saved.id }, { noPrompt: true })
          .catch(() => undefined)
          .finally(() => {
            void queryClient.invalidateQueries({ queryKey: ['memorized'] });
            void queryClient.invalidateQueries({ queryKey: ['reminders'] });
          });
      }
      void invalidateAll();
      remember(saved);
      o.afterSave?.(saved, mode);
      announceSaved(saved, mode);
      if (mode === 'close') {
        setDirty(false);
        if (!fromPrompt) await winRef.current?.close(true);
        else reset(saved);
      } else if (mode === 'new') {
        setDirty(false);
        await loadNewFocused();
      } else {
        reset(saved);
      }
      return true;
    } catch (e) {
      const err = e as ApiError;
      if (err.code !== 'cancelled') failure = { message: err.message || 'The transaction could not be saved.', field: err.field };
      else declined = err;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
    // shown after the buttons are enabled again, so focus can return to them
    if (failure) {
      // a server error about a field without a control on screen goes to the banner as text
      if (failure.field && !findFieldElement(rootRef.current, failure.field) && failure.field !== 'lines') failure = { message: failure.message };
      showProblem(failure);
    } else {
      // The user answered No to a server question: to the field it is about (a used number ->
      // the number...), else back to where they were (once the buttons are enabled again), else
      // the first field.
      const about = declined ? fieldOfWarning(declined) : undefined;
      window.setTimeout(() => {
        const root = rootRef.current;
        if (!root || !root.isConnected) return;
        if (about && focusField(root, about)) return;
        const el = focusBack.current;
        if (el && el.isConnected && el !== document.body && root.contains(el) && !(el as HTMLButtonElement).disabled) {
          el.focus();
          if (document.activeElement === el) return;
        }
        if (!focusFirstField()) root.focus({ preventScroll: true });
      }, 0);
    }
    return false;
  };

  /**
   * accept=inactive when the user already chose "Use Once" for an inactive record this save adds
   * (the server would ask "X is inactive. Use it anyway?" again). Not when another record new to
   * the transaction is inactive too: the server still asks about that one.
   */
  const inactiveAccept = (t: Txn): string[] | undefined => {
    const once = inactiveUsedOnce(winRef.current?.id);
    if (!once.size) return undefined;
    const before = originalRef.current ? recordKeys(originalRef.current) : new Set<string>();
    const fresh = [...recordKeys(t)].filter((k) => !before.has(k));
    if (!fresh.some((k) => once.has(k))) return undefined;
    if (fresh.some((k) => !once.has(k) && knownInactive(k))) return undefined;
    return ['inactive'];
  };

  const announceSaved = (saved: Txn, mode: SaveMode) => {
    const opt = optsRef.current.toastOnSave;
    if (opt === false) return;
    const msg = typeof opt === 'function' ? opt(saved, mode) : `${txnDisplayName(saved)} saved`;
    if (!msg) return;
    toast(msg, mode === 'stay' ? { kind: 'success' } : { kind: 'success', action: { label: 'Open', onClick: () => openTxn(saved.type, saved.id) } });
  };

  const save = useCallback((mode: SaveMode = 'close') => doSave(mode), []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- other actions
  /**
   * Asks the server what it would ask before removing (one question only): its own,
   * more specific question replaces the generic one. Returns undefined when the check is not
   * available (older server), null when the action cannot be done (the problem is shown).
   */
  const removeCheck = async (t: Txn, verb: 'void' | 'delete'): Promise<RemoveCheck | null | undefined> => {
    try {
      const r = await api.get<RemoveCheck>(`/txns/${t.id}/remove-check?verb=${verb}`, { noPrompt: true });
      return r && typeof r === 'object' ? r : {};
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'conflict' || err.code === 'validation' || err.code === 'forbidden') {
        setFieldErrors({}, err.message);
        return null;
      }
      return undefined;
    }
  };

  const remove = useCallback(async () => {
    const t = txnRef.current;
    if (!t.id) {
      await loadNewFocused();
      return true;
    }
    const label = TXN_TYPE_LABELS[t.type] ?? 'transaction';
    const chk = await removeCheck(t, 'delete');
    if (chk === null) return false;
    let accept: string[] | undefined;
    let force = false;
    if (chk?.question) {
      // the server's own question (payments applied, deposited, reconciled) is the only one
      if (!(await confirmBox(`${chk.question}\n\nThis cannot be undone.`, `Delete ${label}`))) return false;
      if (chk.warning) accept = [chk.warning];
      else force = true;
    } else if (!(await confirmBox(`Delete ${txnDisplayName(t)}? This cannot be undone. (To keep a record of it, void it instead.)`, `Delete ${label}`))) return false;
    try {
      await api.del(`/txns/${t.id}`, { accept, force, headers: t.updatedAt ? { 'If-Match': t.updatedAt } : undefined });
      queryClient.removeQueries({ queryKey: ['txn', t.id] });
      forgetRecentTxn(t.id);
      void invalidateAll();
      toast(`${txnDisplayName(t)} deleted`, { kind: 'info' });
      await loadNewFocused();
      return true;
    } catch (e) {
      const err = e as ApiError;
      if (err.code !== 'cancelled') setFieldErrors({}, err.message);
      return false;
    }
  }, [loadNewFocused, setFieldErrors]); // eslint-disable-line react-hooks/exhaustive-deps

  const voidTxn = useCallback(async () => {
    const t = txnRef.current;
    if (!t.id || t.voided) return false;
    const chk = await removeCheck(t, 'void');
    if (chk === null) return false;
    let accept: string[] | undefined;
    let force = false;
    const changed = dirtyRef.current ? '\n\nThe transaction has unsaved changes: voiding it discards them.' : '';
    if (chk?.question) {
      // the server's own question (payments applied, deposited, reconciled) is the only one
      if (!(await confirmBox(chk.question + changed, 'Void Transaction'))) return false;
      if (chk.warning) accept = [chk.warning];
      else force = true;
    } else if (dirtyRef.current) {
      const r = await msgBox({
        title: 'Void Transaction',
        message: 'The transaction has unsaved changes. Voiding it discards them.\n\nVoid it anyway?',
        buttons: ['Yes', 'No'],
        icon: 'question',
      });
      if (r !== 'Yes') return false;
    } else if (!(await confirmBox(`Void ${txnDisplayName(t)}? Its amounts become zero but it stays on record.`, 'Void Transaction'))) return false;
    try {
      const v = await api.post<Txn>(`/txns/${t.id}/void`, {}, { accept, force, headers: t.updatedAt ? { 'If-Match': t.updatedAt } : undefined });
      queryClient.setQueryData(['txn', v.id], v);
      void invalidateAll();
      reset(v);
      remember(v);
      toast(`${txnDisplayName(v)} voided`, { kind: 'info' });
      return true;
    } catch (e) {
      const err = e as ApiError;
      if (err.code !== 'cancelled') setFieldErrors({}, err.message);
      return false;
    }
  }, [reset, setFieldErrors]); // eslint-disable-line react-hooks/exhaustive-deps

  const navType = opts.navType ?? type;
  const go = async (dir: 'prev' | 'next') => {
    if (savingRef.current) return;
    if (!(await confirmLeave())) return;
    const t = txnRef.current;
    try {
      let target: number | null = null;
      if (t.id) target = (await api.get<{ id: number | null }>(`/txns/${t.id}/adjacent?dir=${dir}`)).id;
      else if (dir === 'prev') target = (await api.get<{ id: number | null }>(`/txns-last?type=${navType}`)).id;
      if (target) await loadId(target);
      else if (dir === 'next' && t.id) await loadNewFocused();
      else toast(dir === 'prev' ? `There is no earlier ${(FRIENDLY[navType] ?? 'transaction').toLowerCase()}.` : `This is the last ${(FRIENDLY[navType] ?? 'transaction').toLowerCase()}.`, { kind: 'info', duration: 2500 });
    } catch (e) {
      setFieldErrors({}, (e as Error).message);
    }
  };
  const goPrev = useCallback(() => go('prev'), []); // eslint-disable-line react-hooks/exhaustive-deps
  const goNext = useCallback(() => go('next'), []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(
    async (id: number) => {
      if (!(await confirmLeave())) return;
      await loadId(id);
    },
    [confirmLeave, loadId],
  );

  const copy = useCallback(async () => {
    if (!(await confirmLeave())) return;
    const c = copyAsNew(txnRef.current);
    reset(c);
    setDirty(true);
  }, [confirmLeave, reset]);

  const memorize = useCallback(() => {
    const o = optsRef.current;
    const t = o.prepare ? o.prepare(txnRef.current) : stripEmptyLines(txnRef.current);
    openWindow('memorizeTxn', { txn: t });
  }, []);

  const history = useCallback(() => {
    const t = txnRef.current;
    if (!t.id) {
      toast('Save the transaction first to see its history.', { kind: 'info' });
      return;
    }
    void showTransactionHistory(t);
  }, []);

  const journal = useCallback(() => {
    const t = txnRef.current;
    if (!t.id) {
      toast('Save the transaction first to see its journal entries.', { kind: 'info' });
      return;
    }
    openWindow('report', { key: 'journal', params: { txnId: String(t.id), dates: 'all' }, title: 'Transaction Journal' }, { title: 'Transaction Journal' });
  }, []);

  const revert = useCallback(() => {
    if (originalRef.current) reset(originalRef.current);
  }, [reset]);

  const clear = useCallback(async () => {
    if (txnRef.current.id && originalRef.current) revert();
    else await loadNewFocused();
  }, [loadNewFocused, revert]);

  // Edit > Revert from the menu bar
  useEffect(() => {
    const onCmd = (e: Event) => {
      const d = (e as CustomEvent<{ command: string; windowId: string | null }>).detail;
      if (!d || !winRef.current || d.windowId !== winRef.current.id) return;
      if (d.command === 'revert') {
        if (originalRef.current) reset(originalRef.current);
        else void loadNew();
      }
    };
    window.addEventListener('sx-menu-command', onCmd);
    return () => window.removeEventListener('sx-menu-command', onCmd);
  }, [reset, loadNew]);

  const newTxn = useCallback(async () => {
    if (!(await confirmLeave())) return;
    await loadNewFocused();
  }, [confirmLeave, loadNewFocused]);

  const close = useCallback(async () => {
    const w = winRef.current;
    if (w) return w.close();
    return true;
  }, []);

  // Escape runs after the controls (a drop-down or a field may use it first)
  useHotkeys(
    {
      escape: () => {
        void close();
      },
    },
    [],
    { phase: 'bubble' },
  );
  useHotkeys({
    'ctrl+s': () => {
      void save('stay');
    },
    'meta+s': () => {
      void save('stay');
    },
    'ctrl+h': () => history(),
    'ctrl+y': () => journal(),
    'ctrl+m': () => memorize(),
    'ctrl+d': () => {
      void remove();
    },
  });

  return {
    txn,
    setTxn,
    update,
    setLines,
    reset,
    dirty,
    loading,
    saving,
    isNew: !txn.id,
    original,
    save,
    remove,
    voidTxn,
    goPrev,
    goNext,
    copy,
    memorize,
    history,
    journal,
    clear,
    newTxn,
    revert,
    load,
    close,
    rootRef,
    prefs,
    win,
    type,
    fieldErrors,
    formError,
    hasErrors: !!formError || Object.keys(fieldErrors).length > 0,
    setFieldError,
    setFieldErrors,
    setFormError: setFormErrorState,
    clearErrors,
    focusFirstError,
  };
}
