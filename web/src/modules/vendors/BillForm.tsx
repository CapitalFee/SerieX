// Enter Bills / vendor Credit / Create Item Receipts (one form for all three).
//
// - Bill | Credit switch (new transactions) and the "Bill received" check box: unchecked = Item
//   Receipt (items received, bill to follow). Checking it on a saved item receipt turns it into a
//   bill when saved (the server converts it).
// - VENDOR fills the address, terms, due date (terms or Preferences > Bills "due after N days").
// - Open purchase orders of the vendor are offered ("Receive against them?") and add item lines for
//   the quantities still to receive, linked to the PO lines (Select PO does the same later).
// - AMOUNT DUE always equals the lines; typing an amount puts the difference on an expense line.
// - Pay bill: pays a saved bill right away (one bill payment).
import { useEffect, useRef, useState } from 'react';
import { ShoppingCart, Wallet } from 'lucide-react';
import { api, qs } from '@/api/client';
import { usePrefValues } from '@/api/hooks';
import { emptyLine, emptyTxn, type ID, type LinkedTxn, type Name, type Txn, type TxnLine, type TxnListResult, type TxnSummary, type TxnType } from '@/api/types';
import { AddressBlock, Checkbox, DateField, MoneyField, NamePicker, SegmentedControl, TermsPicker, TextField, msgBox } from '@/components';
import { ExpenseItemTabs, TxnFormFrame, TxnHeaderField, copyAsNew, isEmptyLine, isOpeningBalanceTxn, stripEmptyLines, useTxnForm, type FooterTotal, type TxnProblem } from '@/forms';
import { useWindow } from '@/windows/WindowContext';
import { openWindow } from '@/windows/windowStore';
import { todayIso } from '@/util/dates';
import { fmtDate, fmtMoney, round2 } from '@/util/format';
import { billDueDate, billStatus, discountDateFor, discountPctOf, dueDateFor, fetchName, sum2, useTermsById, vendorAddressText } from './shared';
import { VendorHistoryPanel } from './VendorHistoryPanel';
import { payBillDialog, poLinesFor, selectPurchaseOrders } from './vendorDialogs';
import './vendors.css';

export interface BillFormProps {
  id?: number;
  vendorId?: number;
  /** Vendor credit mode. */
  credit?: boolean;
  /** Item receipt mode (Receive Items). */
  itemReceipt?: boolean;
  /** Prefill from this purchase order (Create bill / Receive items from a PO). */
  poId?: number;
  /** Receive items with their bill (a bill; the vendor's open POs are offered). */
  receiveItems?: boolean;
  /** Open an item receipt with "Bill received" checked (Bill for Received Items). */
  enterBill?: boolean;
  /** With enterBill: the bill date (default: keep the receipt date). */
  billDate?: string;
  /** Prefilled new transaction (memorized transactions, copies). */
  template?: Txn;
}

const RECEIPT_MEMO = 'Received items (bill to follow)';
const TITLES: Record<string, string> = { BILL: 'Bill', BILLCRED: 'Credit', ITEMRCPT: 'Item Receipt' };

function lineTotal(lines: TxnLine[]): number {
  return sum2(lines.filter((l) => l.kind === 'expense' || l.kind === 'item').map((l) => l.amount || 0));
}

export default function BillForm(props: BillFormProps) {
  const win = useWindow();
  const termsById = useTermsById();
  const termsRef = useRef(termsById);
  termsRef.current = termsById;
  const prefsNow = usePrefValues();
  const prefsRef = useRef(prefsNow);
  prefsRef.current = prefsNow;
  const initialType: TxnType = props.credit ? 'BILLCRED' : props.itemReceipt ? 'ITEMRCPT' : 'BILL';
  const [tabsKey, setTabsKey] = useState(0);
  const [tabPref, setTabPref] = useState<'expenses' | 'items' | undefined>(props.itemReceipt || props.poId || props.receiveItems ? 'items' : undefined);
  const enterBillDone = useRef(false);
  // purchase orders received on this (unsaved) form: their numbers show in the PO NO. column
  const [poLinked, setPoLinked] = useState<LinkedTxn[]>([]);
  const rememberPOs = (pos: Txn[]) =>
    setPoLinked((cur) => [
      ...cur.filter((c) => !pos.some((p) => p.id === c.txnId)),
      ...pos.map((p) => ({ txnId: p.id, type: p.type, typeLabel: 'Purchase Order', date: p.date, refNumber: p.refNumber, amount: p.amount, relation: 'purchase order' })),
    ]);
  const askedPOFor = useRef<ID | null>(null);

  const dueFor = (type: TxnType, date: string, termsId: ID | null, billsDueDays: number) =>
    type === 'BILL' ? dueDateFor(date, termsId ? termsRef.current.get(termsId) : null, billsDueDays) : '';

  const form = useTxnForm({
    type: initialType,
    id: props.id,
    navType: initialType,
    makeNew: async () => {
      setPoLinked([]);
      const today = todayIso();
      let t: Txn;
      if (props.template) {
        t = { ...copyAsNew(props.template), date: props.template.date || today };
      } else {
        t = emptyTxn(initialType, today);
      }
      if (!props.template) t.type = initialType;
      let vendorId: ID | null = props.vendorId ?? t.nameId ?? null;
      if (props.poId) {
        const po = await api.get<Txn>(`/txns/${props.poId}`);
        vendorId = po.nameId;
        t.lines = await poLinesFor([po.id], []);
        rememberPOs([po]);
      }
      if (vendorId) {
        const v = await fetchName(vendorId).catch(() => null);
        if (v) {
          t.nameId = v.id;
          t.nameFull = v.fullName;
          if (!t.billAddress) t.billAddress = vendorAddressText(v);
          if (t.type !== 'BILLCRED' && !props.template) t.termsId = v.termsId;
        }
      }
      askedPOFor.current = props.poId ? vendorId : null;
      autoLines.current = null;
      if (t.type === 'BILL') t.dueDate = await billDueDate(t.date, t.termsId);
      return t;
    },
    onLoaded: (t, isNew) => {
      // opened for a vendor (Vendor Center): offer its POs / recall its last bill, as when choosing it
      if (isNew && t.nameId && !props.poId && !props.template) {
        const vid = t.nameId;
        void fetchName(vid)
          .then((n) => afterVendor(vid, n))
          .catch(() => undefined);
      }
      // Items tab for item-only documents, item receipts and the receive-items flows;
      // otherwise the Expenses tab.
      const receiving = isNew && !!(props.itemReceipt || props.poId || props.receiveItems);
      setTabPref(
        (t.lines.some((l) => l.kind === 'item') && !t.lines.some((l) => l.kind === 'expense')) || t.type === 'ITEMRCPT' || receiving
          ? 'items'
          : undefined,
      );
      setTabsKey((k) => k + 1);
      if (!isNew && props.enterBill && !enterBillDone.current && t.type === 'ITEMRCPT') {
        enterBillDone.current = true;
        const date = props.billDate || t.date;
        void (async () => {
          // item receipts have no terms (and often no address): use the vendor's, as a new bill does
          let { termsId, billAddress } = t;
          if (t.nameId && (!termsId || !(billAddress ?? '').trim())) {
            const v = await fetchName(t.nameId).catch(() => null);
            if (v) {
              if (!termsId) termsId = v.termsId;
              if (!(billAddress ?? '').trim()) billAddress = vendorAddressText(v);
            }
          }
          const dueDate = await billDueDate(date, termsId);
          formRef.current.setTxn({
            ...t,
            type: 'BILL',
            date,
            termsId,
            billAddress,
            memo: t.memo === RECEIPT_MEMO ? '' : t.memo,
            dueDate,
          });
        })();
      }
    },
    prepare: (t) => {
      const s = stripEmptyLines(t);
      return { ...s, lines: s.lines.map((l) => ({ ...l, amount: round2(l.amount || 0) })), amount: lineTotal(s.lines) };
    },
    validate: (t) => {
      const problems: TxnProblem[] = [];
      if (!t.lines.length) problems.push({ field: 'lines', message: 'Add at least one expense or item line.' });
      t.lines
        .filter((l) => l.kind === 'expense')
        .forEach((l, i) => {
          if (!l.accountId && l.amount) problems.push({ field: 'lines', message: `Line ${i + 1} on the Expenses tab needs an account.` });
        });
      t.lines
        .filter((l) => l.kind === 'item')
        .forEach((l, i) => {
          if (!l.itemId && l.amount) problems.push({ field: 'lines', message: `Line ${i + 1} on the Items tab needs an item.` });
        });
      if (lineTotal(t.lines) < 0) problems.push({ field: 'lines', message: 'The total cannot be less than zero. Enter a vendor credit instead.' });
      return problems;
    },
  });
  const formRef = useRef(form);
  formRef.current = form;
  const { txn, prefs } = form;
  const type = txn.type;
  const saved = !!txn.id;
  const readOnly = txn.voided;
  const original = form.original;
  const usesReceipts = prefs.inventoryEnabled || prefs.purchaseOrdersEnabled;
  const total = lineTotal(txn.lines);
  const terms = txn.termsId ? termsById.get(txn.termsId) : undefined;

  // window title: the record once saved ("Bill 61-8867 - Coastal Nursery Wholesale"), else the mode
  useEffect(() => {
    if (saved) {
      const label = type === 'ITEMRCPT' ? 'Item Receipt' : type === 'BILLCRED' ? 'Vendor Credit' : 'Bill';
      win.setTitle(`${label}${txn.refNumber ? ' ' + txn.refNumber : ''}${txn.nameFull ? ' - ' + txn.nameFull : ''}`);
    } else win.setTitle(type === 'ITEMRCPT' ? 'Create Item Receipts' : type === 'BILLCRED' ? 'Enter Bills - Credit' : 'Enter Bills');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, saved, txn.refNumber, txn.nameFull]);

  // ---- header changes
  const setDate = (d: string) => form.update({ date: d, dueDate: type === 'BILL' ? dueFor('BILL', d, txn.termsId, prefs.billsDueDays) : txn.dueDate });
  const setTerms = (id: ID | null) => form.update({ termsId: id, dueDate: type === 'BILL' ? dueFor('BILL', txn.date, id, prefs.billsDueDays) : txn.dueDate });

  const setMode = (next: TxnType) => {
    if (next === type) return;
    const patch: Partial<Txn> = { type: next };
    if (next === 'BILL') {
      patch.dueDate = dueFor('BILL', txn.date, txn.termsId, prefs.billsDueDays);
      if (txn.memo === RECEIPT_MEMO) patch.memo = '';
    } else {
      patch.dueDate = '';
    }
    if (next === 'BILLCRED') patch.termsId = null;
    form.update(patch);
  };

  /** Adds item lines for open purchase orders of the vendor; true when lines were added. */
  const receivePOs = async (vendorId: ID, vendorName: string, replace: boolean): Promise<boolean> => {
    const pos = await api.get<TxnSummary[]>(`/open-pos?vendorId=${vendorId}`).catch(() => [] as TxnSummary[]);
    if (!pos.length) {
      if (!replace) await msgBox({ title: 'Select PO', message: `${vendorName} has no open purchase orders.`, icon: 'info' });
      return false;
    }
    const ids = await selectPurchaseOrders(vendorName, pos);
    if (!ids || !ids.length) return false;
    const cur = formRef.current.txn.lines;
    const seen: Txn[] = [];
    const add = await poLinesFor(ids, replace ? [] : cur, seen);
    rememberPOs(seen);
    if (!add.length) {
      await msgBox({ title: 'Select PO', message: 'Everything on the selected purchase orders has already been received.', icon: 'info' });
      return false;
    }
    // right after choosing the vendor the PO lines replace what was filled in automatically
    const keep = replace && replaceable() ? [] : cur.filter((l) => !isEmptyLine(l));
    setAutoLines([...keep, ...add], 'items');
    return true;
  };

  /** Lines filled in automatically (recall, pre-fill accounts, PO): replaced when the vendor changes again. */
  const autoLines = useRef<TxnLine[] | null>(null);
  const vendorSeq = useRef(0);
  const replaceable = () => {
    const l = formRef.current.txn.lines;
    return l === autoLines.current || l.every((x) => isEmptyLine(x) || (x.kind === 'expense' && !x.amount && !(x.description ?? '').trim() && x.nameId === null));
  };
  const setAutoLines = (lines: TxnLine[], tab?: 'expenses' | 'items') => {
    const l = lines.map((x, i) => ({ ...x, seq: i + 1 }));
    autoLines.current = l;
    formRef.current.setLines(l);
    setTabPref(tab ?? (l.length && l.every((x) => x.kind === 'item') ? 'items' : 'expenses'));
    setTabsKey((k) => k + 1);
  };

  /**
   * After choosing the vendor of a new transaction: offer its open purchase orders ("Open
   * purchase orders exist..."), else recall its last transaction of this type (Preferences > Bills
   * "automatically recall", opening balances skipped) or fill its pre-fill accounts.
   */
  const afterVendor = async (id: ID, n: Name) => {
    const seq = ++vendorSeq.current;
    const t = formRef.current.txn.type;
    if (t !== 'BILLCRED' && prefsRef.current.purchaseOrdersEnabled && askedPOFor.current !== id) {
      askedPOFor.current = id;
      const pos = await api.get<TxnSummary[]>(`/open-pos?vendorId=${id}`).catch(() => [] as TxnSummary[]);
      if (seq !== vendorSeq.current) return;
      if (pos.length) {
        const r = await msgBox({
          title: 'Open POs Exist',
          message: `Open purchase orders exist for ${n.name}.\n\nDo you want to receive against one or more of these orders?`,
          buttons: ['Yes', 'No'],
          icon: 'question',
        });
        if (r === 'Yes' && (await receivePOs(id, n.name, true))) return;
      }
    }
    if (!replaceable()) return;
    let lines: TxnLine[] = [];
    if (prefsRef.current.autoRecall) {
      const res = await api.get<TxnListResult>('/txns' + qs({ nameId: id, types: [t], limit: 6, sort: '-date' })).catch(() => null);
      for (const r of res?.rows ?? []) {
        if (r.voided) continue;
        const full = await api.get<Txn>(`/txns/${r.id}`).catch(() => null);
        if (!full || isOpeningBalanceTxn(full)) continue;
        lines = full.lines
          .filter((l) => l.kind === 'expense' || l.kind === 'item')
          .map((l) => ({ ...l, id: 0, linkedTxnId: null, linkedLineId: null, billedTxnId: null, receivedQty: 0, cogs: 0 }));
        break;
      }
    }
    if (!lines.length) lines = (n.prefillAccountIds ?? []).map((a, i) => ({ ...emptyLine('expense', i + 1), accountId: a }));
    if (seq !== vendorSeq.current || formRef.current.txn.nameId !== id || !replaceable()) return;
    setAutoLines(lines);
  };

  const onVendor = async (id: ID | null, n: Name | null) => {
    const patch: Partial<Txn> = { nameId: id, nameFull: n?.fullName ?? '' };
    if (n) {
      patch.billAddress = vendorAddressText(n);
      if (type !== 'BILLCRED') {
        patch.termsId = n.termsId;
        patch.dueDate = dueFor(type, txn.date, n.termsId, prefs.billsDueDays);
      }
    } else patch.billAddress = '';
    form.update(patch);
    if (id && n && !saved) await afterVendor(id, n);
  };

  // AMOUNT DUE typed by the user: the difference goes on an expense line
  const setAmountDue = (v: number | null) => {
    const target = round2(v ?? 0);
    const diff = round2(target - total);
    if (!diff) return;
    const lines = [...txn.lines];
    const idx = lines.findIndex((l) => l.kind === 'expense' && !l.amount && !l.itemId);
    if (idx >= 0) lines[idx] = { ...lines[idx], amount: diff };
    else lines.push({ ...emptyLine('expense', lines.length + 1), amount: diff });
    form.setLines(lines.map((l, i) => ({ ...l, seq: i + 1 })));
    setTabPref('expenses');
    setTabsKey((k) => k + 1);
  };
  const missingAccount = txn.lines.some((l) => l.kind === 'expense' && l.amount && !l.accountId);

  // ---- status, stamp, totals
  const status = saved && original ? billStatus({ ...original, voided: original.voided }) : null;
  const paid = saved && type === 'BILL' && original?.type === 'BILL' && !txn.voided && txn.openBalance <= 0 && txn.amount > 0;
  const appliedAmt = saved && original && original.type === type ? round2(original.amount - original.openBalance) : 0;
  const totals: FooterTotal[] = [];
  if (type === 'BILLCRED') {
    totals.push({ key: 'amt', label: 'Credit amount', value: total, strong: !appliedAmt });
    if (appliedAmt) {
      totals.push({ key: 'used', label: 'Used', value: appliedAmt });
      totals.push({ key: 'left', label: 'Credit remaining', value: round2(total - appliedAmt), strong: true });
    }
  } else if (type === 'ITEMRCPT') {
    totals.push({ key: 'amt', label: 'Total', value: total, strong: true });
  } else {
    totals.push({ key: 'amt', label: 'Amount due', value: total, strong: !appliedAmt });
    if (appliedAmt) {
      totals.push({ key: 'paid', label: 'Paid', value: appliedAmt });
      totals.push({ key: 'bal', label: 'Balance due', value: round2(total - appliedAmt), strong: true, tone: round2(total - appliedAmt) > 0 ? undefined : 'success' });
    }
  }

  const discDate = type === 'BILL' && terms ? discountDateFor(txn.date, terms) : '';
  const canPay = saved && original?.type === 'BILL' && !txn.voided && txn.openBalance > 0 && !form.dirty;

  const payNow = async () => {
    if (!original || !txn.nameId) return;
    const p = await payBillDialog({
      id: original.id,
      vendorId: txn.nameId,
      vendorName: original.nameFull,
      refNumber: original.refNumber,
      dueDate: original.dueDate,
      openBalance: original.openBalance,
    });
    if (p) await form.load(original.id);
  };

  const header = (
    <div className="vx-formhead">
      <div className="vx-formhead-left">
        <TxnHeaderField label="Vendor" required htmlFor="vx-bill-vendor" width={360}>
          <NamePicker
            id="vx-bill-vendor"
            name="nameId"
            kinds={['vendor']}
            value={txn.nameId}
            fallbackLabel={txn.nameFull}
            readOnly={readOnly}
            autoFocus={!props.id && !props.vendorId && !props.poId}
            onChange={(id, n) => void onVendor(id, n)}
          />
        </TxnHeaderField>
        <TxnHeaderField label="Address" htmlFor="vx-bill-addr" width={360}>
          <AddressBlock id="vx-bill-addr" name="billAddress" rows={4} value={txn.billAddress} readOnly={readOnly} onChange={(v) => form.update({ billAddress: v })} />
        </TxnHeaderField>
      </div>
      <div className="vx-formhead-right">
        <TxnHeaderField label="Date" required htmlFor="vx-bill-date">
          <DateField id="vx-bill-date" name="date" value={txn.date} readOnly={readOnly} onChange={setDate} />
        </TxnHeaderField>
        <TxnHeaderField label="Ref. no." htmlFor="vx-bill-ref" help="The vendor's bill or invoice number, so you can find this bill later.">
          <TextField id="vx-bill-ref" name="refNumber" value={txn.refNumber} readOnly={readOnly} onChange={(v) => form.update({ refNumber: v })} maxLength={20} />
        </TxnHeaderField>
        <TxnHeaderField label={type === 'BILLCRED' ? 'Credit amount' : type === 'ITEMRCPT' ? 'Total' : 'Amount due'} htmlFor="vx-bill-amt">
          <MoneyField id="vx-bill-amt" name="amount" value={total} readOnly={readOnly} onChange={setAmountDue} title="Type the total to fill an expense line with the rest" />
        </TxnHeaderField>
        {type === 'BILL' ? (
          <TxnHeaderField label="Bill due" htmlFor="vx-bill-due" help={terms ? 'Calculated from the terms. You can change it.' : `With no terms, bills are due ${prefs.billsDueDays} days after the bill date (Preferences > Bills).`}>
            <DateField id="vx-bill-due" name="dueDate" value={txn.dueDate} readOnly={readOnly} onChange={(v) => form.update({ dueDate: v })} />
          </TxnHeaderField>
        ) : (
          <div />
        )}
        {type === 'BILL' && (
          <TxnHeaderField label="Terms" htmlFor="vx-bill-terms" help="Terms">
            <TermsPicker id="vx-bill-terms" name="termsId" value={txn.termsId} readOnly={readOnly} onChange={(id) => setTerms(id)} />
          </TxnHeaderField>
        )}
        {type === 'BILL' && (
          <TxnHeaderField label="Discount date" help="Pay by this date to take the early payment discount of the terms.">
            <div className={'vx-readval' + (discDate ? '' : ' vx-muted')}>{discDate ? `${fmtDate(discDate)} (${discountPctOf(terms)}%)` : 'No discount'}</div>
          </TxnHeaderField>
        )}
      </div>
    </div>
  );

  const titleRight = (
    <div className="vx-titletoggles">
      {type !== 'ITEMRCPT' && (
        <SegmentedControl
          size="sm"
          aria-label="Bill or credit"
          value={type === 'BILLCRED' ? 'BILLCRED' : 'BILL'}
          disabled={saved || readOnly}
          options={[
            { value: 'BILL', label: 'Bill', title: 'A bill you owe the vendor' },
            { value: 'BILLCRED', label: 'Credit', title: 'A credit from the vendor (a refund or return) that lowers what you owe' },
          ]}
          onChange={(v) => setMode(v as TxnType)}
        />
      )}
      {usesReceipts && type !== 'BILLCRED' && (
        <Checkbox
          label="Bill received"
          checked={type === 'BILL'}
          disabled={readOnly || (saved && original?.type === 'BILL')}
          title={type === 'BILL' ? 'Uncheck when you received the items but not the bill yet (item receipt).' : 'Check when the bill arrives: this item receipt becomes a bill.'}
          onChange={(c) => setMode(c ? 'BILL' : 'ITEMRCPT')}
        />
      )}
    </div>
  );

  const lineNote =
    type === 'ITEMRCPT' ? (
      <div className="vx-note">Items received, bill to follow. This adds the items to inventory and to Accounts Payable; check "Bill received" when the bill arrives.</div>
    ) : saved && original?.type === 'ITEMRCPT' && type === 'BILL' ? (
      <div className="vx-note vx-ok">This item receipt becomes a bill when you save. Check the date, due date and reference number.</div>
    ) : missingAccount ? (
      <div className="vx-note vx-warn">Choose an account for the expense line that holds the rest of the amount.</div>
    ) : null;

  const extraButtons = [
    {
      key: 'po',
      label: 'Select PO',
      icon: ShoppingCart,
      color: '#7c3aed',
      hidden: !prefs.purchaseOrdersEnabled || type === 'BILLCRED',
      disabled: !txn.nameId || readOnly,
      title: 'Receive items against an open purchase order of this vendor',
      onClick: () => void receivePOs(txn.nameId!, txn.nameFull || 'This vendor', false),
    },
    {
      key: 'pay',
      label: 'Pay bill',
      icon: Wallet,
      color: '#16a34a',
      hidden: !saved || original?.type !== 'BILL',
      disabled: !canPay,
      title: txn.openBalance <= 0 ? 'This bill is paid.' : form.dirty ? 'Save your changes first.' : 'Pay this bill now',
      onClick: () => void payNow(),
    },
  ];

  const reportButtons = [
    { label: 'Pay bills…', onClick: () => openWindow('payBills') },
    { label: 'Vendors', onClick: () => openWindow('vendorCenter', { selectId: txn.nameId ?? undefined }) },
  ];

  const stampKind = txn.voided ? 'VOID' : paid ? 'PAID' : null;

  return (
    <TxnFormFrame
      form={form}
      title={TITLES[type] ?? 'Bill'}
      status={txn.voided ? 'Void' : status}
      titleRight={titleRight}
      header={header}
      stamp={stampKind}
      readOnly={readOnly}
      extraButtons={extraButtons}
      reportButtons={reportButtons}
      lines={
        <>
          {lineNote}
          <ExpenseItemTabs
            key={tabsKey}
            lines={txn.lines}
            onChange={form.setLines}
            txnType={type}
            payeeId={txn.nameId}
            isNew={false}
            linked={poLinked.length ? [...(txn.linked ?? []), ...poLinked] : txn.linked}
            readOnly={readOnly}
            defaultTab={tabPref}
          />
        </>
      }
      footer={
        <div className="vx-memo-row">
          <TxnHeaderField label="Memo" htmlFor="vx-bill-memo" help="Memo">
            <TextField id="vx-bill-memo" name="memo" value={txn.memo} readOnly={readOnly} onChange={(v) => form.update({ memo: v })} maxLength={4000} />
          </TxnHeaderField>
        </div>
      }
      totals={totals}
      sidePanel={<VendorHistoryPanel vendorId={txn.nameId} txn={saved ? txn : null} persistKey="bill" />}
    />
  );
}
