// Pay Bills: select bills (due on or before a date, or all; filter by vendor; sort), set the amount to
// pay, discounts and credits per bill, choose the payment date / method / account, then
// "Pay selected bills" creates one bill payment per vendor (POST /pay-bills) and shows a summary.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckSquare, Square, Wallet } from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll, queryClient, useAccounts, useNextRef, useOpenDocs, usePrefValues } from '@/api/hooks';
import type { ID, OpenDoc, OpenDocsResult, PayBillsRequest, PayBillsResult, TxnSummary } from '@/api/types';
import {
  AccountPicker,
  Button,
  DateField,
  EmptyState,
  ErrorBanner,
  Field,
  FormErrorsProvider,
  Grid,
  MoneyField,
  NamePicker,
  RadioGroup,
  SegmentedControl,
  Select,
  Spinner,
  TextField,
  showDialog,
  toast,
  useFormErrors,
  useHotkeys,
  type GridApi,
  type GridColumn,
} from '@/components';
import { useWindow } from '@/windows/WindowContext';
import { openTxn, openWindow } from '@/windows/windowStore';
import { addDays, todayIso } from '@/util/dates';
import { fmtDate, fmtMoney, round2 } from '@/util/format';
import { CheckTable } from './vendorDialogs';
import { sum2, useTermsById } from './shared';
import './vendors.css';

export interface PayBillsProps {
  /** Select this bill when the window opens. */
  billId?: number;
  /** Select these bills when the window opens (Money Out "Pay selected"). */
  billIds?: number[];
  /** Show only this vendor's bills. */
  vendorId?: number;
}

interface CreditUse {
  creditId: ID;
  amount: number;
}

interface PayState {
  sel: boolean;
  amount: number;
  discount: number;
  discountAccountId: ID | null;
  credits: CreditUse[];
  /** The discount was taken automatically (Preferences > Bills): it follows the payment date. */
  autoDiscount?: boolean;
}

/** One grid row (bill + what the user chose for it). */
interface PayRow extends PayState {
  id: ID;
  doc: OpenDoc;
}

type SortKey = 'dueDate' | 'discountDate' | 'vendor' | 'amount';

const EMPTY_STATE: PayState = { sel: false, amount: 0, discount: 0, discountAccountId: null, credits: [] };

function dueOf(d: OpenDoc): string {
  return d.dueDate || d.date;
}

export default function PayBills(props: PayBillsProps) {
  const win = useWindow();
  const prefs = usePrefValues();
  const termsById = useTermsById();
  const fe = useFormErrors();
  const today = todayIso();
  const { data: payAccounts } = useAccounts({ types: ['Bank', 'Credit Card'], active: 'all' });

  const [mode, setMode] = useState<'due' | 'all'>(props.billId || props.billIds?.length || props.vendorId ? 'all' : 'due');
  const [dueBy, setDueBy] = useState(addDays(today, 10));
  const [vendorFilter, setVendorFilter] = useState<ID | null>(props.vendorId ?? null);
  const [sort, setSort] = useState<SortKey>('dueDate');
  const [state, setState] = useState<Map<ID, PayState>>(new Map());
  const [hl, setHl] = useState<ID | null>(props.billId ?? null);
  const [date, setDate] = useState(today);
  // early payment discounts are suggested for the payment date (the server checks each discount date)
  const docsQuery = useOpenDocs({ kind: 'payable', date: date || today });
  // keep showing the bills while they are read again for another payment date
  const lastDocs = useRef<OpenDocsResult | undefined>(undefined);
  if (docsQuery.data) lastDocs.current = docsQuery.data;
  const docs = { data: docsQuery.data ?? lastDocs.current, isLoading: docsQuery.isLoading && !lastDocs.current };
  const [method, setMethod] = useState<'check' | 'cc'>('check');
  const [toPrint, setToPrint] = useState<'print' | 'assign'>('assign');
  const [accountId, setAccountId] = useState<ID | null>(null);
  const [checkNo, setCheckNo] = useState('');
  const [checkTouched, setCheckTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const initDone = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const gridApi = useRef<GridApi | null>(null);
  const focusDone = useRef(false);

  const acct = payAccounts?.find((a) => a.id === accountId) ?? null;
  const nextRef = useNextRef('CHK', accountId, { enabled: method === 'check' && !!accountId });
  useEffect(() => {
    if (!checkTouched && nextRef.data) setCheckNo(nextRef.data.refNumber);
  }, [nextRef.data, checkTouched]);

  // default account for the method
  useEffect(() => {
    if (!payAccounts) return;
    const want = method === 'check' ? 'Bank' : 'Credit Card';
    if (acct && acct.type === want) return;
    const def = prefs.defaultBillPayAccountId ? payAccounts.find((a) => a.id === prefs.defaultBillPayAccountId && a.type === want) : undefined;
    setAccountId((def ?? payAccounts.find((a) => a.type === want && a.active))?.id ?? null);
    setCheckTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payAccounts, method, prefs.defaultBillPayAccountId]);

  const charges = docs.data?.charges ?? [];
  const credits = docs.data?.credits ?? [];

  // preselect the bills asked for (also when the open window is asked again with other bills)
  const want = JSON.stringify([props.billId ?? null, props.billIds ?? [], props.vendorId ?? null]);
  useEffect(() => {
    if (!docs.data || initDone.current === want) return;
    initDone.current = want;
    const ids = [...(props.billIds ?? []), ...(props.billId ? [props.billId] : [])];
    if (props.vendorId) setVendorFilter(props.vendorId);
    if (ids.length || props.vendorId) setMode('all');
    if (!ids.length) return;
    setState((m) => {
      const n = new Map(m);
      for (const id of ids) {
        const d = charges.find((c) => c.txnId === id);
        if (d) n.set(d.txnId, select(d, m.get(d.txnId)));
      }
      return n;
    });
    setHl(ids[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs.data, want]);

  // once the bills are loaded, put the keyboard on the first bill's check box (Space selects it),
  // or on the filter when no bill is listed — unless the user already clicked into a field
  // (the flag is set in the frame callback: an effect run again right away — React StrictMode in
  // development, or new data — cancels the frame and must schedule it again)
  useEffect(() => {
    if (focusDone.current || !docs.data) return;
    const id = requestAnimationFrame(() => {
      focusDone.current = true;
      const root = rootRef.current;
      const ae = document.activeElement as HTMLElement | null;
      if (!root || !win.isActive || (ae && root.contains(ae) && ae !== root && ae.matches('input, select, textarea, button, [role=combobox]'))) return;
      const list = rowsRef.current;
      if (gridApi.current && list.length) gridApi.current.activate(Math.max(0, list.findIndex((r) => r.id === hl)), 'sel');
      else root.querySelector<HTMLElement>('.vx-pb-filters input')?.focus();
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs.data]);

  const credUsedElsewhere = (creditId: ID, exceptBill: ID | null) => {
    let s = 0;
    state.forEach((st, billId) => {
      if (billId === exceptBill || !st.sel) return;
      for (const c of st.credits) if (c.creditId === creditId) s += c.amount;
    });
    return round2(s);
  };

  /** State of a bill when it gets checked: pay what is left after discount (auto discount pref) and credits. */
  function select(d: OpenDoc, cur?: PayState): PayState {
    const discAuto = prefs.autoUseVendorDiscounts && d.suggestedDiscount > 0 && (!d.discountDate || date <= d.discountDate);
    const discount = cur?.discount || (discAuto ? d.suggestedDiscount : 0);
    const creditsUsed = sum2((cur?.credits ?? []).map((c) => c.amount));
    return {
      sel: true,
      amount: Math.max(0, round2(d.openBalance - discount - creditsUsed)),
      discount,
      discountAccountId: cur?.discountAccountId ?? prefs.vendorDiscountAccountId ?? null,
      credits: cur?.credits ?? [],
      autoDiscount: cur?.discount ? cur.autoDiscount : discAuto,
    };
  }

  // a new payment date: discounts taken automatically follow it (dropped after the discount date)
  useEffect(() => {
    const data = docsQuery.data;
    if (!data) return;
    setState((m) => {
      let changed = false;
      const n = new Map(m);
      for (const [id, st] of m) {
        if (!st.sel || !st.autoDiscount) continue;
        const d = data.charges.find((c) => c.txnId === id);
        if (!d) continue;
        const disc = d.suggestedDiscount > 0 && (!d.discountDate || date <= d.discountDate) ? d.suggestedDiscount : 0;
        if (disc === st.discount) continue;
        const creditsUsed = sum2(st.credits.map((c) => c.amount));
        const full = round2(d.openBalance - st.discount - creditsUsed);
        const newFull = Math.max(0, round2(d.openBalance - disc - creditsUsed));
        n.set(id, { ...st, discount: disc, amount: st.amount === full ? newFull : Math.min(st.amount, newFull) });
        changed = true;
      }
      return changed ? n : m;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docsQuery.data]);

  const visible = useMemo(() => {
    let list = charges.filter((d) => d.openBalance > 0);
    if (mode === 'due') list = list.filter((d) => dueOf(d) <= dueBy || state.get(d.txnId)?.sel);
    if (vendorFilter) list = list.filter((d) => d.nameId === vendorFilter);
    const by: Record<SortKey, (a: OpenDoc, b: OpenDoc) => number> = {
      dueDate: (a, b) => dueOf(a).localeCompare(dueOf(b)) || a.nameFull.localeCompare(b.nameFull),
      discountDate: (a, b) => (a.discountDate || '9999').localeCompare(b.discountDate || '9999') || dueOf(a).localeCompare(dueOf(b)),
      vendor: (a, b) => a.nameFull.localeCompare(b.nameFull, undefined, { sensitivity: 'base' }) || dueOf(a).localeCompare(dueOf(b)),
      amount: (a, b) => b.openBalance - a.openBalance,
    };
    return [...list].sort(by[sort]);
  }, [charges, mode, dueBy, vendorFilter, sort, state]);

  const rows: PayRow[] = useMemo(() => visible.map((d) => ({ id: d.txnId, doc: d, ...(state.get(d.txnId) ?? EMPTY_STATE) })), [visible, state]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // bills checked stay checked when the filter hides them (they are paid too)
  const selected: PayRow[] = useMemo(
    () =>
      charges
        .filter((d) => d.openBalance > 0 && state.get(d.txnId)?.sel)
        .map((d) => ({ id: d.txnId, doc: d, ...(state.get(d.txnId) as PayState) }))
        .filter((r) => r.amount > 0 || r.discount > 0 || r.credits.length > 0),
    [charges, state],
  );
  const hiddenSelected = selected.filter((r) => !rows.some((x) => x.id === r.id)).length;
  const totalDue = sum2(rows.map((r) => r.doc.openBalance));
  const totalDisc = sum2(selected.map((r) => r.discount));
  const totalCred = sum2(selected.map((r) => sum2(r.credits.map((c) => c.amount))));
  const totalPay = sum2(selected.map((r) => r.amount));
  const vendorCount = new Set(selected.map((r) => r.doc.nameId)).size;

  const setRowState = (id: ID, st: PayState) => setState((m) => new Map(m).set(id, st));

  const onRowsChange = (next: PayRow[]) => {
    setState((m) => {
      const n = new Map(m);
      for (const r of next) n.set(r.id, { sel: r.sel, amount: r.amount, discount: r.discount, discountAccountId: r.discountAccountId, credits: r.credits, autoDiscount: r.autoDiscount });
      return n;
    });
  };
  const onRowChange = (next: PayRow, prev: PayRow, key: string): PayRow => {
    if (key === 'sel') {
      if (next.sel) return { ...next, ...select(next.doc, prev) };
      return { ...next, amount: 0, discount: 0, credits: [], autoDiscount: false };
    }
    if (key === 'amount') {
      const amount = Math.max(0, round2(next.amount || 0));
      return { ...next, amount, sel: amount > 0 || next.discount > 0 || next.credits.length > 0 };
    }
    return next;
  };

  const selectAll = () =>
    setState((m) => {
      const n = new Map(m);
      for (const r of rows) if (!r.sel) n.set(r.id, select(r.doc, m.get(r.id)));
      return n;
    });
  const clearAll = () => setState(new Map());

  const hlRow = rows.find((r) => r.id === hl) ?? null;
  const vendorCredits = hlRow ? credits.filter((c) => c.nameId === hlRow.doc.nameId && c.openBalance > 0) : [];
  const creditsAvail = hlRow ? sum2(vendorCredits.map((c) => Math.max(0, c.openBalance - credUsedElsewhere(c.txnId, hlRow.id)))) : 0;

  // ---- discount and credit dialogs
  const setDiscount = async () => {
    if (!hlRow) return;
    const r = await showDialog<{ discount: number; accountId: ID | null } | null>({
      title: 'Discount',
      width: 460,
      cancelValue: null,
      render: (close) => <DiscountBody row={hlRow} payDate={date} termsName={hlRow.doc.termsId ? termsById.get(hlRow.doc.termsId)?.name ?? '' : ''} defaultAccount={prefs.vendorDiscountAccountId} close={close} />,
    });
    if (!r) return;
    const creditsUsed = sum2(hlRow.credits.map((c) => c.amount));
    setRowState(hlRow.id, {
      sel: true,
      discount: r.discount,
      discountAccountId: r.accountId,
      autoDiscount: false,
      credits: hlRow.credits,
      amount: Math.max(0, round2(hlRow.doc.openBalance - r.discount - creditsUsed)),
    });
  };
  const setCredits = async () => {
    if (!hlRow) return;
    const avail = vendorCredits.map((c) => ({ doc: c, available: round2(c.openBalance - credUsedElsewhere(c.txnId, hlRow.id)) })).filter((c) => c.available > 0);
    const r = await showDialog<CreditUse[] | null>({
      title: 'Credits',
      width: 740,
      cancelValue: null,
      render: (close) => <CreditsBody row={hlRow} credits={avail} close={close} />,
    });
    if (!r) return;
    const used = sum2(r.map((c) => c.amount));
    setRowState(hlRow.id, {
      sel: true,
      discount: hlRow.discount,
      discountAccountId: hlRow.discountAccountId,
      autoDiscount: hlRow.autoDiscount,
      credits: r,
      amount: Math.max(0, round2(hlRow.doc.openBalance - hlRow.discount - used)),
    });
  };

  // ---- pay
  const pay = async () => {
    fe.clearAll();
    if (!selected.length) return fe.setErrors({}, 'Select at least one bill to pay (check the box in the first column).');
    if (!date) return fe.setErrors({ date: 'Enter the payment date.' });
    if (!accountId) return fe.setErrors({ accountId: method === 'check' ? 'Choose the bank account to pay from.' : 'Choose the credit card to pay with.' });
    for (const r of selected) {
      const applied = round2(r.amount + r.discount + sum2(r.credits.map((c) => c.amount)));
      if (applied > r.doc.openBalance + 0.0001) {
        setHl(r.id);
        return fe.setErrors({}, `The amount to pay, discount and credits for ${r.doc.nameFull} bill ${r.doc.refNumber || ''} (${fmtMoney(applied)}) are more than the ${fmtMoney(r.doc.openBalance)} due.`);
      }
      if (r.discount > 0 && !r.discountAccountId) {
        setHl(r.id);
        return fe.setErrors({}, `Choose the discount account for ${r.doc.nameFull} bill ${r.doc.refNumber || ''} (Set discount).`);
      }
    }
    const req: PayBillsRequest = {
      date,
      accountId,
      toBePrinted: method === 'check' && toPrint === 'print',
      firstCheckNumber: method === 'check' && toPrint === 'assign' ? checkNo.trim() : '',
      bills: selected.map((r) => ({ billId: r.id, amount: r.amount, discount: r.discount, discountAccountId: r.discount > 0 ? r.discountAccountId : null, credits: r.credits })),
    };
    // what stays open on each bill after this payment (partial payments)
    const stillOwed: StillOwed[] = selected
      .map((r) => ({
        ref: r.doc.refNumber,
        vendor: r.doc.nameFull,
        left: round2(r.doc.openBalance - r.amount - r.discount - sum2(r.credits.map((c) => c.amount))),
      }))
      .filter((x) => x.left > 0);
    setBusy(true);
    try {
      const res = await api.post<PayBillsResult>('/pay-bills', req);
      await invalidateAll();
      setState(new Map());
      setCheckTouched(false);
      const next = await showDialog<'more' | 'print' | 'done'>({
        title: 'Payment Summary',
        width: 600,
        cancelValue: 'done',
        render: (close) => (
          <SummaryBody payments={res.payments} stillOwed={stillOwed} billCount={req.bills.length} date={date} accountName={acct?.fullName ?? ''} method={method} printed={req.toBePrinted} close={close} />
        ),
      });
      toast(`${res.payments.length} bill payment${res.payments.length === 1 ? '' : 's'} saved (${fmtMoney(sum2(res.payments.map((p) => p.amount)))})`);
      if (next === 'print') openWindow('printChecks', { accountId });
      if (next === 'print' || next === 'done') await win.close(true);
      else void queryClient.invalidateQueries({ queryKey: ['open-docs'] });
    } catch (e) {
      fe.fromError(e);
    } finally {
      setBusy(false);
    }
  };

  useHotkeys({ 'alt+p': () => void pay() });

  const columns: GridColumn<PayRow>[] = [
    { key: 'sel', label: '✓', width: 34, editor: 'checkbox', title: 'Pay this bill' },
    { key: 'dueDate', label: 'DATE DUE', width: 92, render: (r) => <span className={dueOf(r.doc) < today ? 'vx-danger-text' : undefined}>{fmtDate(dueOf(r.doc))}</span> },
    { key: 'vendor', label: 'VENDOR', width: 200, grow: true, render: (r) => r.doc.nameFull },
    { key: 'ref', label: 'REF. NO.', width: 92, render: (r) => r.doc.refNumber || (r.doc.type === 'GENJRNL' ? 'Journal' : '') },
    { key: 'discDate', label: 'DISC. DATE', width: 90, render: (r) => fmtDate(r.doc.discountDate) },
    { key: 'due', label: 'AMT. DUE', width: 100, align: 'right', render: (r) => fmtMoney(r.doc.openBalance) },
    { key: 'discount', label: 'DISC. USED', width: 92, align: 'right', render: (r) => fmtMoney(r.discount, { blankZero: true }) },
    { key: 'creditsUsed', label: 'CREDITS USED', width: 104, align: 'right', render: (r) => fmtMoney(sum2(r.credits.map((c) => c.amount)), { blankZero: true }) },
    { key: 'amount', label: 'AMT. TO PAY', width: 110, align: 'right', editor: 'money', blankZero: true },
  ];

  const methodAccTypes = method === 'check' ? (['Bank'] as const) : (['Credit Card'] as const);

  return (
    <FormErrorsProvider value={fe}>
      <div className="vx-paybills" ref={rootRef}>
        <div className="vx-pb-filters">
          <span className="vx-pb-cap">Show bills</span>
          <RadioGroup
            row
            aria-label="Show bills"
            value={mode}
            onChange={(v) => setMode(v)}
            options={[
              { value: 'due', label: 'Due on or before' },
              { value: 'all', label: 'Show all bills' },
            ]}
          />
          <DateField value={dueBy} onChange={(d) => setDueBy(d)} width={130} disabled={mode !== 'due'} aria-label="Due on or before" />
          <span className="vx-pb-sep" />
          <span className="vx-pb-cap">Vendor</span>
          <NamePicker kinds={['vendor']} value={vendorFilter} onChange={(id) => setVendorFilter(id)} placeholder="All vendors" width={200} addNew={false} aria-label="Filter by vendor" />
          <span className="vx-pb-cap">Sort by</span>
          <Select
            value={sort}
            width={140}
            aria-label="Sort by"
            onChange={(v) => setSort(v as SortKey)}
            options={[
              { value: 'dueDate', label: 'Due date' },
              { value: 'discountDate', label: 'Discount date' },
              { value: 'vendor', label: 'Vendor' },
              { value: 'amount', label: 'Amount due' },
            ]}
          />
        </div>
        {(fe.message || Object.keys(fe.errors).length > 0) && <ErrorBanner className="vx-pb-banner" errors={fe.errors} message={fe.message} onDismiss={() => fe.clearAll()} />}
        <div className="vx-pb-grid">
          {docs.isLoading ? (
            <Spinner center label="Loading bills..." />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Wallet}
              title={charges.length ? 'No bills match' : 'No unpaid bills'}
              message={
                charges.length
                  ? mode === 'due'
                    ? `No bills are due on or before ${fmtDate(dueBy)}${vendorFilter ? ' for this vendor' : ''}.`
                    : 'This vendor has no unpaid bills.'
                  : 'Every bill is paid. Bills you enter (Vendors > Enter Bills) show up here until they are paid.'
              }
              action={charges.length && mode === 'due' ? { label: 'Show all bills', onClick: () => setMode('all') } : { label: 'Enter a bill', onClick: () => openWindow('bill') }}
            />
          ) : (
            <Grid<PayRow>
              aria-label="Bills to pay"
              columns={columns}
              rows={rows}
              onChange={onRowsChange}
              newRow={() => ({ id: 0, doc: rows[0].doc, ...EMPTY_STATE })}
              onRowChange={onRowChange}
              allowAdd={false}
              allowInsertDelete={false}
              minRows={6}
              persistKey="paybills"
              apiRef={gridApi}
              rowClassName={(r) => (r.sel ? 'vx-row-sel' : undefined)}
              onActiveRowChange={(i) => i !== null && rows[i] && setHl(rows[i].id)}
              contextMenu={(r) => (r ? [{ label: 'Open bill', onClick: () => openTxn(r.doc.type, r.id) }] : [])}
            />
          )}
        </div>
        <div className="vx-pb-totals">
          <Button small variant="ghost" icon={CheckSquare} label="Select all bills" disabled={!rows.length} onClick={selectAll} />
          <Button small variant="ghost" icon={Square} label="Clear selections" disabled={!selected.length && !rows.some((r) => r.sel)} onClick={clearAll} />
          <span className="vx-spacer" />
          <span className="vx-pb-tot">
            <span>Totals</span>
            <span className="vx-num" title="Amount due of the bills shown">{fmtMoney(totalDue)}</span>
            <span className="vx-num" title="Discounts used">{fmtMoney(totalDisc)}</span>
            <span className="vx-num" title="Credits used">{fmtMoney(totalCred)}</span>
            <span className="vx-num vx-strong" title="Amount to pay">{fmtMoney(totalPay)}</span>
          </span>
        </div>
        <div className="vx-pb-bottom">
          <section className="vx-panel vx-pb-info">
            <div className="vx-panel-head">Discount &amp; credit information for highlighted bill</div>
            {hlRow ? (
              <div className="vx-panel-body vx-pb-infobody">
                <dl className="vx-dlg-info">
                  <dt>Vendor</dt>
                  <dd>{hlRow.doc.nameFull}</dd>
                  <dt>Bill ref. no.</dt>
                  <dd>
                    <button type="button" className="sx-linkbtn" onClick={() => openTxn(hlRow.doc.type, hlRow.id)}>
                      {hlRow.doc.refNumber || 'Open bill'}
                    </button>
                  </dd>
                  <dt>Terms</dt>
                  <dd>{hlRow.doc.termsId ? termsById.get(hlRow.doc.termsId)?.name ?? '' : '—'}</dd>
                  <dt>Sugg. discount</dt>
                  <dd title={hlRow.doc.discountDate ? `For a payment dated ${fmtDate(date)} (discount date ${fmtDate(hlRow.doc.discountDate)})` : undefined}>
                    {fmtMoney(!hlRow.doc.discountDate || date <= hlRow.doc.discountDate ? hlRow.doc.suggestedDiscount : 0)}
                  </dd>
                </dl>
                <dl className="vx-dlg-info">
                  <dt>Number of credits</dt>
                  <dd>{vendorCredits.length}</dd>
                  <dt>Credits available</dt>
                  <dd>{fmtMoney(creditsAvail)}</dd>
                </dl>
                <div className="vx-pb-infobtns">
                  <Button small label="Set discount…" onClick={() => void setDiscount()} />
                  <Button small label="Set credits…" disabled={!vendorCredits.length} title={vendorCredits.length ? undefined : 'This vendor has no credits to use.'} onClick={() => void setCredits()} />
                </div>
              </div>
            ) : (
              <div className="vx-panel-body vx-muted">Click a bill to see its terms, discount and the vendor's available credits.</div>
            )}
          </section>
          <section className="vx-panel vx-pb-pay">
            <div className="vx-panel-head">Payment</div>
            <div className="vx-panel-body vx-pb-paybody">
              <Field label="Date" htmlFor="vx-pb-date" width={140}>
                <DateField id="vx-pb-date" name="date" value={date} onChange={setDate} />
              </Field>
              <Field label="Method" width={170}>
                <SegmentedControl
                  size="sm"
                  aria-label="Payment method"
                  value={method}
                  onChange={(v) => setMethod(v)}
                  options={[
                    { value: 'check', label: 'Check' },
                    { value: 'cc', label: 'Credit card' },
                  ]}
                />
              </Field>
              <Field label={method === 'check' ? 'Bank account' : 'Credit card'} htmlFor="vx-pb-acct" width={220} hint={acct ? `Ending balance ${fmtMoney(acct.balance)}` : undefined}>
                <AccountPicker id="vx-pb-acct" name="accountId" types={[...methodAccTypes]} value={accountId} addNew={false} onChange={(id) => { setAccountId(id); setCheckTouched(false); }} />
              </Field>
              {method === 'check' && (
                <div className="vx-pb-check">
                  <RadioGroup
                    aria-label="Check numbers"
                    value={toPrint}
                    onChange={(v) => setToPrint(v)}
                    options={[
                      { value: 'print', label: 'To be printed' },
                      { value: 'assign', label: 'Assign check no.' },
                    ]}
                  />
                  {toPrint === 'assign' && (
                    <TextField
                      name="firstCheckNumber"
                      aria-label="First check number"
                      title="First check number (the next payments are numbered in order)"
                      value={checkNo}
                      width={90}
                      onChange={(v) => {
                        setCheckNo(v);
                        setCheckTouched(true);
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
        <div className="vx-pb-actions">
          <span className="vx-muted">
            {selected.length
              ? `${selected.length} bill${selected.length === 1 ? '' : 's'} selected${hiddenSelected ? ` (${hiddenSelected} hidden by the filter)` : ''} for ${vendorCount} vendor${vendorCount === 1 ? '' : 's'}: ${vendorCount} payment${vendorCount === 1 ? '' : 's'} of ${fmtMoney(totalPay)} in total.`
              : 'Check the bills you want to pay.'}
          </span>
          <span className="vx-spacer" />
          <Button label="Cancel" onClick={() => void win.close()} />
          <Button variant="primary" icon={Wallet} label="&Pay selected bills" busy={busy} disabled={!selected.length} onClick={() => void pay()} />
        </div>
      </div>
    </FormErrorsProvider>
  );
}

// ---------------------------------------------------------------------------

function DiscountBody({
  row,
  payDate,
  termsName,
  defaultAccount,
  close,
}: {
  row: PayRow;
  /** Payment date: the suggested discount only applies when paying by the discount date. */
  payDate: string;
  termsName: string;
  defaultAccount: ID | null;
  close: (v: { discount: number; accountId: ID | null } | null) => void;
}) {
  const inTime = !row.doc.discountDate || (payDate || todayIso()) <= row.doc.discountDate;
  const suggested = inTime ? row.doc.suggestedDiscount : 0;
  const [disc, setDisc] = useState(() => (row.discount ? row.discount : suggested));
  const [acct, setAcct] = useState<ID | null>(row.discountAccountId ?? defaultAccount);
  const [err, setErr] = useState<string | null>(null);
  const ok = () => {
    if (disc < 0) return setErr('The discount cannot be negative.');
    if (disc > row.doc.openBalance) return setErr(`The discount cannot be more than the ${fmtMoney(row.doc.openBalance)} due.`);
    if (disc > 0 && !acct) return setErr('Choose the account to record the discount in.');
    close({ discount: round2(disc), accountId: acct });
  };
  return (
    <div className="vx-dlg">
      <dl className="vx-dlg-info">
        <dt>Vendor</dt>
        <dd>{row.doc.nameFull}</dd>
        <dt>Ref. no.</dt>
        <dd>{row.doc.refNumber || '—'}</dd>
        <dt>Date</dt>
        <dd>{fmtDate(row.doc.date)}</dd>
        <dt>Original amt.</dt>
        <dd>{fmtMoney(row.doc.amount)}</dd>
        <dt>Amount due</dt>
        <dd>{fmtMoney(row.doc.openBalance)}</dd>
        <dt>Discount date</dt>
        <dd>{fmtDate(row.doc.discountDate) || '—'}</dd>
        <dt>Terms</dt>
        <dd>{termsName || '—'}</dd>
        <dt>Suggested discount</dt>
        <dd>
          {fmtMoney(suggested)}
          {!inTime && row.doc.discountDate ? <span className="vx-muted"> (paid after the discount date)</span> : null}
        </dd>
      </dl>
      {err && <ErrorBanner message={err} onDismiss={() => setErr(null)} />}
      <Field label="Amount of discount" htmlFor="vx-disc-amt" width={180}>
        <MoneyField id="vx-disc-amt" value={disc} autoFocus onChange={(v) => setDisc(v ?? 0)} />
      </Field>
      <Field label="Discount account" htmlFor="vx-disc-acct" help="Usually an income account such as Purchase Discounts: the discount lowers what you pay.">
        <AccountPicker id="vx-disc-acct" value={acct} onChange={(id) => setAcct(id)} excludeTypes={['Accounts Receivable', 'Accounts Payable', 'Non-Posting']} />
      </Field>
      <div className="sx-dlg-buttons">
        <Button variant="primary" label="Done" onClick={ok} />
        <Button label="Cancel" onClick={() => close(null)} />
      </div>
    </div>
  );
}

function CreditsBody({ row, credits, close }: { row: PayRow; credits: { doc: OpenDoc; available: number }[]; close: (v: CreditUse[] | null) => void }) {
  const [use, setUse] = useState<Map<ID, number>>(() => new Map(row.credits.map((c) => [c.creditId, c.amount])));
  const roomFor = (id: ID) => {
    const others = sum2([...use.entries()].filter(([k]) => k !== id).map(([, v]) => v));
    return Math.max(0, round2(row.doc.openBalance - row.discount - others));
  };
  const toggle = (id: ID, on: boolean) =>
    setUse((m) => {
      const n = new Map(m);
      if (!on) n.delete(id);
      else {
        const c = credits.find((x) => x.doc.txnId === id);
        n.set(id, Math.min(c?.available ?? 0, roomFor(id)));
      }
      return n;
    });
  const total = sum2([...use.values()]);
  return (
    <div className="vx-dlg">
      <div>
        Credits from <strong>{row.doc.nameFull}</strong> for bill {row.doc.refNumber || ''} (amount due {fmtMoney(row.doc.openBalance)}). Check the credits to use; you can change the amount.
      </div>
      <CheckTable
        rows={credits}
        getKey={(c) => c.doc.txnId}
        checked={new Set(use.keys())}
        onToggle={toggle}
        empty="This vendor has no available credits."
        cols={[
          { key: 'date', label: 'DATE', width: 90, render: (c) => fmtDate(c.doc.date) },
          // vendor credits, and bill payments left unapplied when the bill they paid was voided
          { key: 'type', label: 'TYPE', width: 116, render: (c) => c.doc.typeLabel },
          { key: 'ref', label: 'REF. NO.', width: 80, render: (c) => c.doc.refNumber },
          { key: 'amt', label: 'CREDIT AMT.', width: 100, align: 'right', render: (c) => fmtMoney(c.doc.amount) },
          { key: 'avail', label: 'AVAILABLE', width: 100, align: 'right', render: (c) => fmtMoney(c.available) },
          {
            key: 'use',
            label: 'AMT. TO USE',
            width: 120,
            align: 'right',
            render: (c) =>
              use.has(c.doc.txnId) ? (
                <MoneyField
                  value={use.get(c.doc.txnId) ?? 0}
                  width={100}
                  aria-label="Amount to use"
                  onChange={(v) => setUse((m) => new Map(m).set(c.doc.txnId, Math.max(0, Math.min(round2(v ?? 0), c.available))))}
                />
              ) : (
                ''
              ),
          },
        ]}
      />
      <div className="vx-num">
        Credits used: <strong>{fmtMoney(total)}</strong>
        {total > round2(row.doc.openBalance - row.discount) && <span className="vx-danger-text"> (more than the amount due)</span>}
      </div>
      <div className="sx-dlg-buttons">
        <Button
          variant="primary"
          label="Done"
          disabled={total > round2(row.doc.openBalance - row.discount) + 0.0001}
          onClick={() => close([...use.entries()].filter(([, v]) => v > 0).map(([creditId, amount]) => ({ creditId, amount })))}
        />
        <Button label="Cancel" onClick={() => close(null)} />
      </div>
    </div>
  );
}

/** A bill that keeps an open balance after a partial payment. */
interface StillOwed {
  ref: string;
  vendor: string;
  left: number;
}

function SummaryBody({
  payments,
  stillOwed,
  billCount,
  date,
  accountName,
  method,
  printed,
  close,
}: {
  payments: TxnSummary[];
  stillOwed: StillOwed[];
  billCount: number;
  date: string;
  accountName: string;
  method: 'check' | 'cc';
  printed: boolean;
  close: (v: 'more' | 'print' | 'done') => void;
}) {
  const total = sum2(payments.map((p) => p.amount));
  const paidInFull = billCount - stillOwed.length;
  return (
    <div className="vx-dlg">
      <div className="vx-note vx-ok">
        {payments.length} payment{payments.length === 1 ? ' was' : 's were'} recorded and your {method === 'check' ? 'bank' : 'credit card'} balance is updated.{' '}
        {stillOwed.length === 0
          ? billCount === 1
            ? 'The bill is paid in full.'
            : `The ${billCount} bills are paid in full.`
          : paidInFull === 0
            ? billCount === 1
              ? 'The bill is partly paid.'
              : `The ${billCount} bills are partly paid.`
            : `${paidInFull} of the ${billCount} bills ${paidInFull === 1 ? 'is' : 'are'} paid in full.`}
      </div>
      {stillOwed.length > 0 && (
        <div className="vx-note vx-warn vx-owed">
          <ul>
            {stillOwed.map((o, i) => (
              <li key={i}>
                {fmtMoney(o.left)} is still owed on bill {o.ref || '(no number)'} from {o.vendor}.
              </li>
            ))}
          </ul>
        </div>
      )}
      <dl className="vx-dlg-info">
        <dt>Payment date</dt>
        <dd>{fmtDate(date)}</dd>
        <dt>Payment account</dt>
        <dd>{accountName}</dd>
        <dt>Payment method</dt>
        <dd>{method === 'check' ? (printed ? 'Check (to be printed)' : 'Check') : 'Credit card'}</dd>
      </dl>
      <table className="vx-ctable vx-summary">
        <thead>
          <tr>
            <th>{method === 'check' ? 'CHECK NO.' : 'NUM'}</th>
            <th>VENDOR</th>
            <th style={{ textAlign: 'right' }}>AMOUNT PAID</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((p) => (
            <tr key={p.id} onClick={() => openTxn(p.type, p.id)} title="Open this bill payment">
              <td>{p.toBePrinted ? 'To print' : p.refNumber}</td>
              <td>{p.nameFull}</td>
              <td className="vx-num">{fmtMoney(p.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2} className="vx-strong">
              Total
            </td>
            <td className="vx-num vx-strong">{fmtMoney(total)}</td>
          </tr>
        </tfoot>
      </table>
      <div className="sx-dlg-buttons">
        <Button variant="primary" label="Done" onClick={() => close('done')} />
        <Button label="Pay more bills" onClick={() => close('more')} />
        {printed && <Button label="Print checks" onClick={() => close('print')} />}
      </div>
    </div>
  );
}
