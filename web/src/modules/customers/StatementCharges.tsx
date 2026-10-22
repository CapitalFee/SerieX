// Enter Statement Charges: the customer's Accounts Receivable register (two-line rows:
// DATE / NUMBER / ITEM / QTY / RATE / AMT CHRG / AMT PAID / BALANCE, then TYPE /
// DESCRIPTION / CLASS / DUE DATE) with an entry row at the bottom that records a statement charge
// (STMTCHG). Clicking a statement charge loads it into the entry row to change or delete it;
// double-clicking any other row opens its form.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { RotateCcw, Save, Trash2, SquareArrowOutUpRight } from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll, queryClient, useAccounts, useItemsById, usePrefValues, useRegister } from '@/api/hooks';
import { emptyLine, emptyTxn, type ID, type Item, type Name, type RegisterRow, type Txn } from '@/api/types';
import {
  AccountPicker,
  Button,
  ClassPicker,
  DateField,
  EmptyState,
  ErrorBanner,
  FormErrorsProvider,
  ItemLabel,
  ItemPicker,
  ListEntryLabel,
  MoneyField,
  NamePicker,
  NumberField,
  Select,
  Spinner,
  TextField,
  confirmBox,
  toast,
  useFormErrors,
  useHotkeys,
} from '@/components';
import { useWindow } from '@/windows/WindowContext';
import { openTxn, openWindow } from '@/windows/windowStore';
import { resolvePreset, todayIso } from '@/util/dates';
import { fmtDate, fmtMoney, fmtQty, lineAmount, round2, roundTo } from '@/util/format';
import { dueDateFromTerms, money$, useCustomers, useTerms } from './shared';
import './customers.css';

export interface StatementChargesProps {
  customerId?: number;
  txnId?: number;
}

interface Entry {
  id: number;
  date: string;
  refNumber: string;
  itemId: ID | null;
  qty: number | null;
  rate: number | null;
  amount: number;
  description: string;
  classId: ID | null;
  dueDate: string;
  /** the loaded statement charge (when editing) */
  original: Txn | null;
}

const blankEntry = (date: string): Entry => ({ id: 0, date, refNumber: '', itemId: null, qty: null, rate: null, amount: 0, description: '', classId: null, dueDate: '', original: null });

const RANGES = [
  { value: 'all', label: 'All dates' },
  { value: 'thisFiscalYear', label: 'This fiscal year' },
  { value: 'last365', label: 'Last 12 months' },
  { value: 'lastFiscalYear', label: 'Last fiscal year' },
];

export default function StatementCharges(props: StatementChargesProps) {
  const win = useWindow();
  const prefs = usePrefValues();
  const itemsById = useItemsById();
  const customers = useCustomers().data;
  const terms = useTerms();
  const arAccounts = useAccounts({ types: ['Accounts Receivable'] }).data ?? [];
  const [custId, setCustId] = useState<ID | null>(props.customerId ?? null);
  const [arId, setArId] = useState<ID | null>(null);
  const [range, setRange] = useState('all');
  const [entry, setEntry] = useState<Entry>(() => blankEntry(todayIso()));
  const [selTxn, setSelTxn] = useState<ID | null>(null);
  const [busy, setBusy] = useState(false);
  const fe = useFormErrors();
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const customer = customers?.find((c) => c.id === custId) ?? null;
  const ar = arId ?? arAccounts.find((a) => a.special === 'AccountsReceivable')?.id ?? arAccounts[0]?.id ?? null;

  const dates = useMemo(() => {
    if (range === 'all') return {};
    const today = todayIso();
    if (range === 'last365') return { from: new Date(Date.parse(today) - 365 * 86400000).toISOString().slice(0, 10), to: today };
    const r = resolvePreset(range, today, 1);
    return { from: r.from || undefined, to: r.to || undefined };
  }, [range]);
  const reg = useRegister(custId ? ar : null, { ...dates, ...(custId ? { nameId: String(custId), includeJobs: '1' } : {}) } as { from?: string; to?: string });
  const rows = custId ? reg.data?.rows ?? [] : [];

  // statement charge details (item, qty, rate, description, class) for the two-line rows
  const [gone, setGone] = useState<Set<ID>>(new Set());
  const chargeIds = useMemo(() => rows.filter((r) => r.type === 'STMTCHG' && !gone.has(r.txnId)).map((r) => r.txnId), [rows, gone]);
  const details = useQueries({ queries: chargeIds.map((id) => ({ queryKey: ['txn', id], queryFn: () => api.get<Txn>(`/txns/${id}`), staleTime: 30_000 })) });
  const detailOf = (id: ID): Txn | undefined => {
    const i = chargeIds.indexOf(id);
    return i >= 0 ? (details[i]?.data as Txn | undefined) : undefined;
  };

  // a txnId to show (opened from a statement charge elsewhere)
  useEffect(() => {
    if (!props.txnId) return;
    void (async () => {
      const t = await api.get<Txn>(`/txns/${props.txnId}`);
      setCustId(t.nameId);
      if (t.arApAccountId || t.accountId) setArId(t.accountId);
      loadEntry(t);
      setSelTxn(t.id);
    })().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.txnId]);
  useEffect(() => {
    if (props.customerId) setCustId(props.customerId);
  }, [props.customerId]);

  useEffect(() => {
    win.setTitle(customer ? `Enter Statement Charges - ${customer.fullName}` : 'Enter Statement Charges');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer?.fullName]);

  // scroll to the end of the register when it loads (or to the charge being changed)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sel = selTxn ? el.querySelector<HTMLElement>(`[data-txn="${selTxn}"]`) : null;
    if (sel) sel.scrollIntoView({ block: 'center' });
    else if (!selTxn) el.scrollTop = el.scrollHeight;
  }, [rows.length, custId]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = entry.original ? entryChanged(entry) : !!(entry.itemId || entry.amount || entry.description);
  useEffect(() => {
    win.setDirty(dirty);
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    win.setBeforeClose(async () => (dirtyRef.current ? confirmBox('The statement charge you are entering is not recorded yet. Close without recording it?', 'Unrecorded Charge') : true));
    return () => win.setBeforeClose(null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function entryChanged(e: Entry): boolean {
    const o = e.original;
    if (!o) return false;
    const l = o.lines[0];
    return e.date !== o.date || e.refNumber !== o.refNumber || e.dueDate !== o.dueDate || e.itemId !== (l?.itemId ?? null) || e.qty !== (l?.qty ?? null) || e.rate !== (l?.rate ?? null) || e.amount !== o.amount || e.description !== (l?.description ?? '') || e.classId !== (l?.classId ?? o.classId);
  }

  function loadEntry(t: Txn) {
    const l = t.lines.find((x) => x.kind === 'item') ?? emptyLine('item');
    setEntry({ id: t.id, date: t.date, refNumber: t.refNumber, itemId: l.itemId, qty: l.qty, rate: l.rate, amount: t.amount, description: l.description, classId: l.classId ?? t.classId, dueDate: t.dueDate, original: t });
    fe.clearAll();
  }
  const restore = () => {
    if (entry.original) loadEntry(entry.original);
    else setEntry(blankEntry(entry.date || todayIso()));
    fe.clearAll();
  };
  const termsDue = (date: string) => dueDateFromTerms(date, terms?.find((x) => x.id === customer?.termsId) ?? null);

  const patch = (p: Partial<Entry>, key?: string, picked?: Item | null) => {
    setEntry((cur) => {
      let n = { ...cur, ...p };
      if (key === 'item') {
        // the picked record (a quick-created item is not in itemsById yet)
        const it = picked ?? (n.itemId ? itemsById.get(n.itemId) : undefined);
        if (it) {
          const rate = it.rateIsPercent ? 0 : it.salesPrice ?? 0;
          const qty = cur.qty ?? 1;
          n = { ...n, description: it.description, rate, qty, amount: lineAmount(qty, rate) };
        }
      } else if (key === 'qty' || key === 'rate') n = { ...n, amount: lineAmount(n.qty, n.rate) };
      else if (key === 'amount') n = { ...n, rate: n.qty ? roundTo(n.amount / n.qty, 5) : n.amount };
      else if (key === 'date' && (!cur.dueDate || cur.dueDate === termsDue(cur.date))) n = { ...n, dueDate: termsDue(n.date) };
      return n;
    });
  };

  const record = async () => {
    if (busy) return;
    const errs: Record<string, string> = {};
    if (!custId) errs.nameId = 'Choose the customer to charge.';
    if (!entry.date) errs.date = 'Enter the date of the charge.';
    if (!entry.itemId) errs.itemId = 'Choose the item you are charging for.';
    const it = entry.itemId ? itemsById.get(entry.itemId) : undefined;
    if (it && it.type === 'Payment') errs.itemId = 'Payment items cannot be used on statement charges. Use Receive Payments instead.';
    if (entry.amount <= 0 && !errs.itemId) errs.amount = 'Enter the amount to charge.';
    if (Object.keys(errs).length) {
      fe.setErrors(errs);
      return;
    }
    const base = entry.original ?? { ...emptyTxn('STMTCHG', entry.date), nameId: custId };
    const line = { ...(entry.original?.lines[0] ?? emptyLine('item', 1)), kind: 'item' as const, seq: 1, itemId: entry.itemId, qty: entry.qty, rate: entry.rate, amount: round2(entry.amount), description: entry.description, classId: entry.classId, taxable: false };
    const t: Txn = {
      ...base,
      type: 'STMTCHG',
      nameId: entry.original?.nameId ?? custId,
      date: entry.date,
      refNumber: entry.refNumber,
      dueDate: entry.dueDate || termsDue(entry.date),
      termsId: customer?.termsId ?? base.termsId ?? null,
      classId: entry.classId,
      accountId: ar,
      amount: round2(entry.amount),
      memo: entry.description,
      lines: [line],
    };
    setBusy(true);
    try {
      const saved = t.id ? await api.put<Txn>(`/txns/${t.id}`, t) : await api.post<Txn>('/txns', t);
      void invalidateAll();
      toast(`Statement charge of ${money$(saved.amount)} ${t.id ? 'updated' : 'recorded'}`, { kind: 'success' });
      setEntry({ ...blankEntry(entry.date), dueDate: termsDue(entry.date) });
      setSelTxn(null);
      fe.clearAll();
    } catch (e) {
      fe.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  const recordRef = useRef(record);
  recordRef.current = record;
  const remove = async () => {
    const o = entry.original;
    if (!o) return;
    if (!(await confirmBox(`Delete this statement charge of ${money$(o.amount)}? This cannot be undone.`, 'Delete Statement Charge'))) return;
    try {
      await api.del(`/txns/${o.id}`);
      // stop watching the deleted charge before everything refreshes (no request for a missing record)
      setGone((g) => new Set(g).add(o.id));
      await new Promise((r) => setTimeout(r, 0));
      queryClient.removeQueries({ queryKey: ['txn', o.id] });
      void invalidateAll();
      toast('Statement charge deleted', { kind: 'info' });
      setEntry(blankEntry(entry.date));
      setSelTxn(null);
    } catch (e) {
      fe.fromError(e);
    }
  };

  useHotkeys({
    'alt+r': () => void record(),
    'ctrl+d': () => {
      if (entry.original) void remove();
      else return false;
    },
  });

  const selectRow = (r: RegisterRow) => {
    setSelTxn(r.txnId);
    if (r.type === 'STMTCHG') {
      const d = detailOf(r.txnId);
      if (d) loadEntry(d);
      else void api.get<Txn>(`/txns/${r.txnId}`).then(loadEntry);
    } else if (!dirty) setEntry(blankEntry(entry.date));
  };

  const pickCustomer = (id: ID | null, n: Name | null) => {
    setCustId(id);
    setSelTxn(null);
    const date = entry.date || todayIso();
    setEntry({ ...blankEntry(date), dueDate: n ? dueDateFromTerms(date, terms?.find((x) => x.id === n.termsId) ?? null) : '' });
    fe.clearAll();
  };

  const itemOf = (id: ID | null): Item | undefined => (id ? itemsById.get(id) : undefined);
  const cls = prefs.useClassTracking;

  return (
    <div ref={rootRef} className="sx-cust-stmt">
      <FormErrorsProvider value={fe}>
        <div className="sx-cust-stmt-head">
          <label className="sx-cust-flabel">
            CUSTOMER OR JOB
            <NamePicker name="nameId" kinds={['customer']} value={custId} onChange={pickCustomer} width={280} autoFocus={!custId} aria-label="Customer or job" />
          </label>
          {arAccounts.length > 1 && (
            <label className="sx-cust-flabel">
              A/R ACCOUNT
              <AccountPicker types={['Accounts Receivable']} value={ar} onChange={(id) => setArId(id)} width={200} aria-label="A/R account" />
            </label>
          )}
          <label className="sx-cust-flabel">
            SHOW
            <Select value={range} options={RANGES} onChange={setRange} aria-label="Dates" />
          </label>
          <span className="sx-cust-stmt-spacer" />
          {customer && (
            <span className="sx-cust-stmt-bal">
              ENDING BALANCE <b>{money$(reg.data?.endingBalance ?? 0)}</b>
            </span>
          )}
        </div>
        {fe.hasErrors && (
          <div className="sx-cust-stmt-banner">
            <ErrorBanner errors={fe.errors} message={fe.message} root={rootRef.current} onDismiss={() => fe.clearAll()} />
          </div>
        )}
        {!custId ? (
          <EmptyState title="Choose a customer" message="Statement charges are amounts you add to a customer's account and bill later on a statement (for example a monthly fee). Pick the customer or job to see their account." />
        ) : (
          <div className="sx-cust-stmt-body">
            <div ref={scrollRef} className="sx-cust-stmt-scroll">
              <table className="sx-cust-reg" aria-label="Accounts receivable register">
                <thead>
                  <tr>
                    <th style={{ width: 96 }}>DATE</th>
                    <th style={{ width: 90 }}>NUMBER</th>
                    <th>ITEM</th>
                    <th style={{ width: 70 }} className="sx-num">QTY</th>
                    <th style={{ width: 90 }} className="sx-num">RATE</th>
                    <th style={{ width: 100 }} className="sx-num">AMT CHRG</th>
                    <th style={{ width: 100 }} className="sx-num">AMT PAID</th>
                    <th style={{ width: 106 }} className="sx-num">BALANCE</th>
                  </tr>
                  <tr className="sx-cust-reg-h2">
                    <th />
                    <th>TYPE</th>
                    <th colSpan={3}>DESCRIPTION{cls ? ' · CLASS' : ''}</th>
                    <th colSpan={2}>DUE DATE</th>
                    <th />
                  </tr>
                </thead>
                {reg.isLoading ? (
                  <tbody>
                    <tr>
                      <td colSpan={8}>
                        <Spinner label="Loading..." />
                      </td>
                    </tr>
                  </tbody>
                ) : (
                  rows.map((r, i) => {
                    const d = r.type === 'STMTCHG' ? detailOf(r.txnId) : undefined;
                    const l = d?.lines.find((x) => x.kind === 'item');
                    const sel = selTxn === r.txnId;
                    return (
                      <tbody
                        key={`${r.txnId}-${r.glId}`}
                        data-txn={r.txnId}
                        className={'sx-cust-reg-row' + (i % 2 ? ' sx-alt' : '') + (sel ? ' sx-sel' : '') + (r.voided ? ' sx-void' : '')}
                        onClick={() => selectRow(r)}
                        onDoubleClick={() => openTxn(r.type, r.txnId)}
                        title={r.type === 'STMTCHG' ? 'Click to change this charge below; double-click to open it' : 'Double-click to open'}
                      >
                        <tr>
                          <td>{fmtDate(r.date)}</td>
                          <td>{r.refNumber}</td>
                          <td>{l ? <ItemLabel id={l.itemId} /> : <span className="sx-muted">{r.otherAccount}</span>}</td>
                          <td className="sx-num">{l ? fmtQty(l.qty) : ''}</td>
                          <td className="sx-num">{l && l.rate !== null ? fmtMoney(l.rate) : ''}</td>
                          <td className="sx-num">{r.increase ? fmtMoney(r.increase) : ''}</td>
                          <td className="sx-num">{r.decrease ? fmtMoney(r.decrease) : ''}</td>
                          <td className="sx-num">{fmtMoney(r.balance)}</td>
                        </tr>
                        <tr className="sx-cust-reg-l2">
                          <td />
                          <td>{r.typeAbbrev}</td>
                          <td colSpan={3}>
                            {l?.description || r.memo}
                            {cls && l?.classId ? (
                              <span className="sx-muted">
                                {' '}
                                · <ListEntryLabel list="class" id={l.classId} />
                              </span>
                            ) : null}
                            {r.nameFull && customer && r.nameFull !== customer.fullName ? <span className="sx-muted"> · {r.nameFull.slice(customer.fullName.length + 1) || r.nameFull}</span> : null}
                          </td>
                          <td colSpan={2}>{r.dueDate ? fmtDate(r.dueDate) : ''}</td>
                          <td />
                        </tr>
                      </tbody>
                    );
                  })
                )}
                {!reg.isLoading && rows.length === 0 && (
                  <tbody>
                    <tr>
                      <td colSpan={8} className="sx-cust-paytable-empty">
                        No transactions for this customer{range !== 'all' ? ' in this period' : ''} yet.
                      </td>
                    </tr>
                  </tbody>
                )}
              </table>
            </div>
            <div
              className={'sx-cust-stmt-entry' + (entry.original ? ' sx-editing' : '')}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || e.defaultPrevented || (e.target as HTMLElement).tagName !== 'INPUT') return;
                e.preventDefault();
                // let the field commit its value first (combo / money fields commit on Enter)
                setTimeout(() => void recordRef.current(), 0);
              }}
            >
              <div className="sx-cust-stmt-entryhead">{entry.original ? `Change statement charge ${entry.original.refNumber || ''} (${fmtDate(entry.original.date)})` : 'New statement charge'}</div>
              <div className="sx-cust-stmt-grid">
                <label>
                  DATE
                  <DateField name="date" value={entry.date} onChange={(d) => patch({ date: d }, 'date')} />
                </label>
                <label>
                  NUMBER
                  <TextField name="refNumber" value={entry.refNumber} onChange={(v) => patch({ refNumber: v })} />
                </label>
                <label className="sx-cust-stmt-item">
                  ITEM
                  <ItemPicker name="itemId" value={entry.itemId} excludeTypes={['Payment', 'Sales Tax Group', 'Subtotal', 'Group']} onChange={(id, rec) => patch({ itemId: id }, 'item', rec)} listWidth={520} />
                </label>
                <label>
                  QTY
                  <NumberField name="qty" value={entry.qty} onChange={(v) => patch({ qty: v }, 'qty')} />
                </label>
                <label>
                  RATE
                  <NumberField name="rate" value={entry.rate} onChange={(v) => patch({ rate: v }, 'rate')} />
                </label>
                <label>
                  AMT CHRG
                  <MoneyField name="amount" value={entry.amount} onChange={(v) => patch({ amount: v ?? 0 }, 'amount')} />
                </label>
                {cls && (
                  <label className="sx-cust-stmt-class">
                    CLASS
                    <ClassPicker name="classId" value={entry.classId} onChange={(id) => patch({ classId: id })} />
                  </label>
                )}
                <label className="sx-cust-stmt-desc">
                  DESCRIPTION
                  <TextField name="description" value={entry.description} onChange={(v) => patch({ description: v })} />
                </label>
                <label className="sx-cust-stmt-due">
                  DUE DATE
                  <DateField name="dueDate" value={entry.dueDate} onChange={(d) => patch({ dueDate: d })} />
                </label>
              </div>
              <div className="sx-cust-stmt-buttons">
                {itemOf(entry.itemId)?.type === 'Inventory Part' && <span className="sx-cust-note">Inventory is not reduced by statement charges.</span>}
                <span className="sx-cust-stmt-spacer" />
                {entry.original && (
                  <>
                    <Button
                      variant="ghost"
                      icon={SquareArrowOutUpRight}
                      label="Journal"
                      onClick={() => entry.original && openWindow('report', { key: 'journal', params: { txnId: String(entry.original.id), dates: 'all' }, title: 'Transaction Journal' })}
                      title="See the accounting entries of this charge"
                    />
                    <Button variant="danger" icon={Trash2} label="Delete" onClick={() => void remove()} />
                  </>
                )}
                <Button variant="secondary" icon={RotateCcw} label={entry.original ? 'Restore' : 'Clear'} onClick={restore} disabled={!dirty && !entry.original} />
                <Button variant="primary" icon={Save} label="&Record" onClick={() => void record()} busy={busy} title="Record the charge (Enter or Alt+R)" />
              </div>
            </div>
            <div className="sx-cust-stmt-foot">
              <button type="button" className="sx-linkbtn" onClick={() => openWindow('createStatements', { customerIds: [custId] })}>
                Create a statement for this customer…
              </button>
              <button type="button" className="sx-linkbtn" onClick={() => openWindow('receivePayment', { customerId: custId })}>
                Receive a payment…
              </button>
              <button type="button" className="sx-linkbtn" onClick={() => openWindow('report', { key: 'name_quickreport', params: { nameId: String(custId), dates: 'all' } })}>
                Customer Activity
              </button>
            </div>
          </div>
        )}
      </FormErrorsProvider>
    </div>
  );
}
