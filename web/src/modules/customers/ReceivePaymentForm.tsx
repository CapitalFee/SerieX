// Receive Payments (PMT), one simple screen with every payment field: pick the customer, type the
// amount and it is applied automatically (exact match first, else oldest first); open invoices
// with check boxes, editable payment amounts, discounts and credits per invoice; a plain-English
// line explains under- and over-payments and what will happen.
//
// Links: payment → invoice {fromTxnId: null, toTxnId, amount, discount, discountAccountId};
// credit applied {fromTxnId: credit memo / older payment, toTxnId: invoice, amount}.
import { useEffect, useMemo, useRef, useState } from 'react';
import { BadgePercent, Undo2 } from 'lucide-react';
import { useAccounts, useList, useOpenDocs } from '@/api/hooks';
import { emptyLink, emptyTxn, type ID, type Name, type OpenDoc, type OpenDocsResult, type Txn, type TxnLink } from '@/api/types';
import {
  AccountPicker,
  Button,
  Checkbox,
  DateField,
  EmptyState,
  MoneyField,
  NamePicker,
  Radio,
  Spinner,
  TextField,
  showDialog,
} from '@/components';
import { HeaderRow, HeaderSpacer, TxnFormFrame, TxnHeaderField, useTxnForm, type FooterTotal, type TxnProblem } from '@/forms';
import { openTxn, openWindow } from '@/windows/windowStore';
import { todayIso } from '@/util/dates';
import { fmtDate, fmtMoney, round2 } from '@/util/format';
import { escHtml, printHtml } from '@/util/print';
import { CustomerHistoryPanel } from './CustomerHistoryPanel';
import { companyInfo } from './printing';
import { loadCustomers, loadPrefs } from './salesForm';
import { MethodButtons } from './paymentMethods';
import { HeaderField, money$, useCustomers, useUndepositedFundsId } from './shared';

export interface ReceivePaymentFormProps {
  id?: number;
  customerId?: number;
  invoiceId?: number;
  template?: Txn;
}

/** Applications of the payment to one charge. */
interface Apply {
  payment: number;
  discount: number;
  discountAccountId: ID | null;
  /** credit id → amount used on this charge */
  credits: Record<ID, number>;
}

const EMPTY_APPLY: Apply = { payment: 0, discount: 0, discountAccountId: null, credits: {} };

/** Groups the payment's links by charge. */
function appliesOf(t: Txn): Record<ID, Apply> {
  const m: Record<ID, Apply> = {};
  for (const l of t.links ?? []) {
    const a = (m[l.toTxnId] ??= { payment: 0, discount: 0, discountAccountId: null, credits: {} });
    const own = !l.fromTxnId || l.fromTxnId === t.id;
    if (own) {
      a.payment = round2(a.payment + l.amount);
      a.discount = round2(a.discount + (l.discount || 0));
      if (l.discountAccountId) a.discountAccountId = l.discountAccountId;
    } else a.credits[l.fromTxnId!] = round2((a.credits[l.fromTxnId!] ?? 0) + l.amount);
  }
  return m;
}

/** Builds the links of the payment from the per-charge applications. */
function linksOf(applies: Record<ID, Apply>): TxnLink[] {
  const out: TxnLink[] = [];
  for (const [to, a] of Object.entries(applies)) {
    const toId = Number(to);
    if (a.payment > 0 || a.discount > 0) out.push({ ...emptyLink(toId), amount: round2(a.payment), discount: round2(a.discount), discountAccountId: a.discount > 0 ? a.discountAccountId : null });
    for (const [cid, amt] of Object.entries(a.credits)) if (amt > 0) out.push({ ...emptyLink(toId), fromTxnId: Number(cid), amount: round2(amt) });
  }
  return out;
}

const sumCredits = (a: Apply | undefined) => round2(Object.values(a?.credits ?? {}).reduce((s, v) => s + v, 0));
const byAge = (a: OpenDoc, b: OpenDoc) => (a.dueDate || a.date).localeCompare(b.dueDate || b.date) || a.date.localeCompare(b.date) || a.txnId - b.txnId;

/** Amount still to pay on a charge after its discount and credits (before the payment). */
const dueAfterDiscCredits = (d: OpenDoc, a: Apply | undefined) => round2(d.openBalance - (a?.discount ?? 0) - sumCredits(a));

/**
 * The row is "checked" when the payment pays part of it, or when its discount and credits alone
 * pay it in full (unchecking such a row removes them).
 */
function isPaid(d: OpenDoc, a: Apply | undefined): boolean {
  if (!a) return false;
  if (a.payment > 0) return true;
  return a.discount + sumCredits(a) > 0 && dueAfterDiscCredits(d, a) <= 0.004;
}

/**
 * Applies the available credits to the charges (the invoice the window was opened for first, then
 * the oldest), on top of the payments and discounts already chosen.
 */
function creditsToCharges(charges: OpenDoc[], credits: OpenDoc[], cur: Record<ID, Apply>, first?: ID | null): Record<ID, Apply> {
  const next: Record<ID, Apply> = {};
  for (const [k, v] of Object.entries(cur)) next[Number(k)] = { ...v, credits: {} };
  const left: Record<ID, number> = Object.fromEntries(credits.map((c) => [c.txnId, c.openBalance]));
  const order = [...charges].sort(byAge).sort((a, b) => Number(b.txnId === first) - Number(a.txnId === first));
  for (const d of order) {
    const a = next[d.txnId] ?? { ...EMPTY_APPLY };
    let due = round2(d.openBalance - a.payment - a.discount);
    const used: Record<ID, number> = {};
    for (const c of credits) {
      if (due <= 0) break;
      const take = Math.min(due, left[c.txnId]);
      if (take <= 0) continue;
      used[c.txnId] = round2(take);
      left[c.txnId] = round2(left[c.txnId] - take);
      due = round2(due - take);
    }
    if (Object.keys(used).length) next[d.txnId] = { ...a, credits: used };
  }
  return next;
}

/** Preferred payment method of a customer, or of its customer when the job has none. */
function preferredMethod(id: ID | null, all: readonly Name[] | undefined): ID | null {
  let n = id ? all?.find((x) => x.id === id) : undefined;
  for (let i = 0; n && i < 10; i++) {
    if (n.paymentMethodId) return n.paymentMethodId;
    const pid = n.parentId;
    n = pid ? all?.find((x) => x.id === pid) : undefined;
  }
  return null;
}

/**
 * Auto-apply: an open charge whose amount due equals the payment gets it; otherwise the payment
 * pays the oldest charges first. Discounts and credits already chosen stay.
 */
function autoApply(amount: number, charges: OpenDoc[], cur: Record<ID, Apply>): Record<ID, Apply> {
  const next: Record<ID, Apply> = {};
  for (const [k, v] of Object.entries(cur)) next[Number(k)] = { ...v, payment: 0 };
  const due = (d: OpenDoc) => round2(d.openBalance - (next[d.txnId]?.discount ?? 0) - sumCredits(next[d.txnId]));
  let left = round2(amount);
  if (left <= 0) return next;
  const exact = charges.find((d) => due(d) === left);
  if (exact) {
    next[exact.txnId] = { ...(next[exact.txnId] ?? EMPTY_APPLY), payment: left };
    return next;
  }
  for (const d of [...charges].sort(byAge)) {
    if (left <= 0) break;
    const pay = Math.min(left, Math.max(0, due(d)));
    if (pay <= 0) continue;
    next[d.txnId] = { ...(next[d.txnId] ?? EMPTY_APPLY), payment: round2(pay) };
    left = round2(left - pay);
  }
  return next;
}

/** Discounts and Credits box for one charge. Resolves the new application, or null when cancelled. */
function discountsAndCredits(doc: OpenDoc, apply: Apply, credits: OpenDoc[], creditUsedElsewhere: (id: ID) => number, defaultDiscountAccount: ID | null): Promise<Apply | null> {
  return showDialog<Apply | null>({
    title: `Discounts and Credits - ${doc.typeLabel} ${doc.refNumber}`,
    width: 680,
    cancelValue: null,
    render: (close) => <DiscCreditBody doc={doc} apply={apply} credits={credits} usedElsewhere={creditUsedElsewhere} defaultAccount={defaultDiscountAccount} close={close} />,
  });
}

function DiscCreditBody({
  doc,
  apply,
  credits,
  usedElsewhere,
  defaultAccount,
  close,
}: {
  doc: OpenDoc;
  apply: Apply;
  credits: OpenDoc[];
  usedElsewhere: (id: ID) => number;
  defaultAccount: ID | null;
  close: (v: Apply | null) => void;
}) {
  const [discount, setDiscount] = useState(apply.discount || 0);
  const [acct, setAcct] = useState<ID | null>(apply.discountAccountId ?? defaultAccount);
  const [used, setUsed] = useState<Record<ID, number>>({ ...apply.credits });
  const [err, setErr] = useState<string | null>(null);
  const creditTotal = round2(Object.values(used).reduce((s, v) => s + v, 0));
  // what the discount and credits leave to pay; the payment on the invoice is lowered to it when needed
  const room = round2(doc.openBalance - discount - creditTotal);
  const payAfter = Math.max(0, Math.min(apply.payment, room));
  const balance = round2(room - payAfter);
  const ok = () => {
    if (discount > 0 && !acct) {
      setErr('Choose the account the discount is recorded in (for example "Sales Discounts").');
      return;
    }
    if (room < -0.004) {
      setErr(`The discount and credits add up to more than the ${money$(doc.openBalance)} due. Lower one of them.`);
      return;
    }
    close({ ...apply, discount: round2(discount), discountAccountId: discount > 0 ? acct : null, credits: Object.fromEntries(Object.entries(used).filter(([, v]) => v > 0)) });
  };
  return (
    <div className="sx-cust-dlg">
      <div className="sx-cust-dlg-sum">
        <span>
          Customer: <b>{doc.nameFull}</b>
        </span>
        <span>
          {doc.typeLabel} #{doc.refNumber} · {fmtDate(doc.date)}
        </span>
        <span>
          Amount due: <b>{money$(doc.openBalance)}</b>
        </span>
        <span>
          Balance after: <b className={balance < 0 ? 'sx-tone-text-danger' : undefined}>{money$(balance)}</b>
        </span>
      </div>
      {err && <div className="sx-cust-dlg-error">{err}</div>}
      {apply.payment > 0 && payAfter < apply.payment - 0.004 && (
        <div className="sx-cust-note">
          The payment on this {doc.typeLabel.toLowerCase()} will be lowered from {money$(apply.payment)} to {money$(payAfter)}.
        </div>
      )}
      <fieldset className="sx-group">
        <legend>Discount</legend>
        <div className="sx-cust-inline sx-cust-wrap">
          <label className="sx-cust-flabel">
            AMOUNT OF DISCOUNT
            <MoneyField value={discount} onChange={(v) => setDiscount(Math.max(0, v ?? 0))} width={110} aria-label="Amount of discount" />
          </label>
          <label className="sx-cust-flabel">
            DISCOUNT ACCOUNT
            <AccountPicker value={acct} onChange={(id) => setAcct(id)} types={['Income', 'Other Income', 'Expense', 'Other Expense', 'Cost of Goods Sold']} width={220} aria-label="Discount account" />
          </label>
          {doc.suggestedDiscount > 0 && (
            <Button small label={`Use suggested ${money$(doc.suggestedDiscount)}`} title={`Early payment discount from the terms (pay by ${fmtDate(doc.discountDate)})`} onClick={() => setDiscount(doc.suggestedDiscount)} />
          )}
        </div>
        {doc.discountDate && <div className="sx-cust-note">Discount date: {fmtDate(doc.discountDate)}</div>}
      </fieldset>
      <fieldset className="sx-group">
        <legend>Credits</legend>
        {credits.length === 0 ? (
          <div className="sx-muted">This customer has no available credits.</div>
        ) : (
          <div className="sx-cust-pick-table">
            <table>
              <thead>
                <tr>
                  <th className="sx-cust-ck" />
                  <th>Date</th>
                  <th>Type</th>
                  <th>Num</th>
                  <th className="sx-num">Credit available</th>
                  <th className="sx-num">Amount to use</th>
                </tr>
              </thead>
              <tbody>
                {credits.map((c) => {
                  const avail = round2(c.openBalance - usedElsewhere(c.txnId));
                  const on = (used[c.txnId] ?? 0) > 0;
                  return (
                    <tr key={c.txnId} className={on ? 'sx-on' : undefined}>
                      <td className="sx-cust-ck">
                        <input
                          type="checkbox"
                          aria-label={`Use credit ${c.refNumber}`}
                          checked={on}
                          onChange={(e) => {
                            const n = { ...used };
                            if (e.target.checked) n[c.txnId] = Math.max(0, Math.min(avail, round2(room + (used[c.txnId] ?? 0))));
                            else delete n[c.txnId];
                            setUsed(n);
                          }}
                        />
                      </td>
                      <td>{fmtDate(c.date)}</td>
                      <td>{c.typeLabel}</td>
                      <td>{c.refNumber}</td>
                      <td className="sx-num">{fmtMoney(avail)}</td>
                      <td className="sx-num sx-cust-amtcell">
                        <MoneyField
                          value={used[c.txnId] ?? 0}
                          blankZero
                          width={100}
                          aria-label="Amount to use"
                          onChange={(v) => {
                            const n = { ...used };
                            const a = Math.max(0, Math.min(avail, v ?? 0));
                            if (a > 0) n[c.txnId] = a;
                            else delete n[c.txnId];
                            setUsed(n);
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </fieldset>
      <div className="sx-dlg-buttons">
        <Button variant="secondary" label="Cancel" onClick={() => close(null)} />
        <Button variant="primary" label="Done" onClick={ok} />
      </div>
    </div>
  );
}

async function printPaymentReceipt(t: Txn, docs: OpenDoc[], methodName: string) {
  const co = await companyInfo();
  const rows = (t.links ?? [])
    .filter((l) => !l.fromTxnId || l.fromTxnId === t.id)
    .map((l) => {
      const d = docs.find((x) => x.txnId === l.toTxnId);
      return `<tr><td>${escHtml(fmtDate(d?.date ?? l.toDate))}</td><td>${escHtml(d?.typeLabel ?? 'Invoice')} ${escHtml(d?.refNumber ?? l.toRefNumber)}</td><td class="num">${fmtMoney(d?.amount ?? l.toAmount)}</td><td class="num">${fmtMoney(l.amount)}</td></tr>`;
    })
    .join('');
  const applied = round2((t.links ?? []).filter((l) => !l.fromTxnId || l.fromTxnId === t.id).reduce((s, l) => s + l.amount, 0));
  await printHtml(
    'Payment Receipt',
    `<div style="display:flex;justify-content:space-between"><div><b style="font-size:15px">${escHtml(co?.name ?? '')}</b><br>${escHtml(co?.address1 ?? '')}<br>${escHtml([co?.city, co?.state, co?.zip].filter(Boolean).join(' '))}</div><h1>Payment Receipt</h1></div>
     <p><b>Received from:</b> ${escHtml(t.nameFull)}<br><b>Date:</b> ${escHtml(fmtDate(t.date))}<br><b>Payment method:</b> ${escHtml(methodName)} ${t.refNumber ? '#' + escHtml(t.refNumber) : ''}<br><b>Amount received:</b> $${fmtMoney(t.amount)}</p>
     <table><thead><tr><th>Date</th><th>Description</th><th class="num">Original amount</th><th class="num">Payment</th></tr></thead><tbody>${rows}</tbody></table>
     <p style="text-align:right"><b>Applied: $${fmtMoney(applied)}</b>${t.amount - applied > 0.004 ? `<br>Credit remaining: $${fmtMoney(t.amount - applied)}` : ''}</p>
     ${t.memo ? `<p>Memo: ${escHtml(t.memo)}</p>` : ''}`,
  );
}

export default function ReceivePaymentForm(props: ReceivePaymentFormProps) {
  const [overChoice, setOverChoice] = useState<'credit' | 'refund'>('credit');
  const [underChoice, setUnderChoice] = useState<'leave' | 'writeoff'>('leave');
  const [writeOffAcct, setWriteOffAcct] = useState<ID | null>(null);
  const [autoCredits, setAutoCredits] = useState(false);
  const preselect = useRef<ID | null>(props.invoiceId ?? null);
  /** Customer whose open invoices were already set up (A/R account, credits, amount); null = set them up when they load. */
  const setUpFor = useRef<ID | null>(null);
  /** The A/R account was chosen by hand (it is no longer defaulted from the customer's invoices). */
  const arPicked = useRef(false);
  /** The payment method came from the customer (it follows when the customer changes). */
  const methodFromCustomer = useRef(false);

  const form = useTxnForm({
    type: 'PMT',
    id: props.id,
    makeNew: async () => {
      if (props.template) return { ...props.template, id: 0, links: [], linked: [] };
      const prefs = await loadPrefs();
      const t = emptyTxn('PMT', todayIso());
      t.nameId = props.customerId ?? null;
      if (!prefs.useUndepositedFunds && prefs.defaultDepositAccountId) t.accountId = prefs.defaultDepositAccountId;
      if (t.nameId) t.paymentMethodId = preferredMethod(t.nameId, await loadCustomers());
      return t;
    },
    onLoaded: (loaded, isNew) => {
      setOverChoice('credit');
      setUnderChoice('leave');
      setAutoCredits(false);
      setUpFor.current = isNew ? null : loaded.nameId;
      arPicked.current = !isNew;
      methodFromCustomer.current = isNew && !!loaded.paymentMethodId && !props.template;
    },
    prepare: (t) => preparePayment(t),
    validate: (t) => validatePayment(t),
    required: [{ field: 'nameId', message: 'Choose the customer who paid.' }],
    afterSave: (saved) => {
      if (overChoice === 'refund' && saved.openBalance > 0) openWindow('refund', { creditId: saved.id, customerId: saved.nameId ?? undefined });
    },
    toastOnSave: (s) => `Payment of ${money$(s.amount)} from ${s.nameFull} saved`,
  });
  const t = form.txn;
  const prefs = form.prefs;
  const ro = t.voided;
  const customers = useCustomers().data;
  const customer = customers?.find((c) => c.id === t.nameId) ?? null;
  const hasJobs = !!customers?.some((c) => c.parentId && (c.parentId === t.nameId || customers.find((p) => p.id === c.parentId)?.parentId === t.nameId));
  const arQ = useAccounts({ types: ['Accounts Receivable'], active: 'all' });
  const arAccounts = arQ.data ?? [];
  const defaultAr = (arAccounts.find((a) => a.special === 'AccountsReceivable') ?? arAccounts[0])?.id ?? null;
  const ufId = useUndepositedFundsId();
  const methods = useList('payment_method', { active: 'all' }).data;
  const docsQ = useOpenDocs({ nameId: t.nameId, kind: 'receivable', includeJobs: true, excludeTxnId: t.id || undefined, date: t.date || undefined }, { enabled: !!t.nameId });
  // A/R accounts: with more than one, the payment pays the invoices of ONE account
  const multiAr =
    arAccounts.filter((a) => a.active).length > 1 ||
    (!!t.arApAccountId && t.arApAccountId !== defaultAr) ||
    [...(docsQ.data?.charges ?? []), ...(docsQ.data?.credits ?? [])].some((d) => d.openBalance > 0 && d.arApAccountId !== defaultAr);
  const effAr = t.arApAccountId ?? defaultAr;
  const inAr = (d: OpenDoc, ar: ID | null = effAr) => !multiAr || !ar || d.arApAccountId === ar;
  const chargesOf = (data: OpenDocsResult | undefined, ar: ID | null) => (data?.charges ?? []).filter((d) => d.openBalance > 0 && inAr(d, ar));
  const creditsOf = (data: OpenDocsResult | undefined, ar: ID | null) => (data?.credits ?? []).filter((d) => d.openBalance > 0 && d.txnId !== t.id && inAr(d, ar));
  const charges = useMemo(
    () => (docsQ.data?.charges ?? []).filter((d) => (d.openBalance > 0 && inAr(d)) || (t.links ?? []).some((l) => l.toTxnId === d.txnId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docsQ.data, t.links, effAr, multiAr],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const credits = useMemo(() => creditsOf(docsQ.data, effAr), [docsQ.data, t.id, effAr, multiAr]);
  /** Open invoices of the customer in the other A/R accounts (not payable with this payment). */
  const otherAr = useMemo(() => {
    if (!multiAr) return [];
    const m = new Map<ID, { count: number; amount: number }>();
    for (const d of docsQ.data?.charges ?? []) {
      if (d.openBalance <= 0 || d.arApAccountId === effAr) continue;
      const e = m.get(d.arApAccountId) ?? { count: 0, amount: 0 };
      m.set(d.arApAccountId, { count: e.count + 1, amount: round2(e.amount + d.openBalance) });
    }
    return [...m.entries()].map(([id, v]) => ({ id, name: arAccounts.find((a) => a.id === id)?.name ?? 'another A/R account', ...v }));
  }, [docsQ.data, effAr, multiAr, arAccounts]);
  const applies = useMemo(() => appliesOf(t), [t]);
  const [hi, setHi] = useState<ID | null>(null);

  useEffect(() => {
    form.win?.setTitle(form.isNew ? 'Receive Payments' : `Payment${t.refNumber ? ' ' + t.refNumber : ''} - ${t.nameFull}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.isNew, t.id, t.refNumber, t.nameFull]);

  // When the customer's open invoices arrive (customer picked, or the window opened for a customer
  // or an invoice): choose the A/R account of those invoices, use the available credits (new
  // payments: "Apply available credits" starts on), pay the invoice the window was opened for and
  // apply an amount already typed.
  useEffect(() => {
    const data = docsQ.data;
    // wait for fresh data: cached open invoices may miss a credit memo saved a moment ago
    if (!data || docsQ.isFetching || !t.nameId || form.loading || !arQ.data || setUpFor.current === t.nameId) return;
    setUpFor.current = t.nameId;
    const cur = form.txn;
    const inv = preselect.current ? data.charges.find((x) => x.txnId === preselect.current && x.openBalance > 0) : undefined;
    preselect.current = null;
    let ar = cur.arApAccountId ?? defaultAr;
    if (multiAr && !arPicked.current) {
      const accts = new Set(data.charges.filter((d) => d.openBalance > 0).map((d) => d.arApAccountId));
      ar = inv ? inv.arApAccountId : accts.size === 1 ? [...accts][0] : defaultAr;
    }
    const ch = chargesOf(data, ar);
    const cr = creditsOf(data, ar);
    const nothingTyped = form.isNew && round2(cur.amount) === 0 && !(cur.links ?? []).length;
    const useCredits = nothingTyped && cr.length > 0 && ch.length > 0;
    let next: Record<ID, Apply> = useCredits ? creditsToCharges(ch, cr, {}, inv?.txnId) : {};
    let amount = cur.amount;
    if (inv && form.isNew) {
      const pay = Math.max(0, dueAfterDiscCredits(inv, next[inv.txnId]));
      next = { ...next, [inv.txnId]: { ...(next[inv.txnId] ?? EMPTY_APPLY), payment: pay } };
      amount = pay;
      setHi(inv.txnId);
    } else if (amount > 0 && prefs.autoApplyPayments) next = autoApply(amount, ch, next);
    setAutoCredits(useCredits);
    const updated: Txn = { ...cur, amount, links: linksOf(next), arApAccountId: multiAr ? ar : cur.arApAccountId };
    // a form nobody has touched yet (opened for a customer or an invoice) stays "unchanged"
    if (form.dirty) form.setTxn(updated);
    else form.reset(updated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docsQ.data, docsQ.isFetching, t.nameId, form.loading, arQ.data]);

  // ---- derived totals
  const totalDue = round2(charges.reduce((s, d) => s + d.openBalance, 0));
  const applied = round2(Object.values(applies).reduce((s, a) => s + a.payment, 0));
  const discCred = round2(Object.values(applies).reduce((s, a) => s + a.discount + sumCredits(a), 0));
  const unapplied = round2(t.amount - applied);
  const creditAvail = round2(credits.reduce((s, c) => s + c.openBalance, 0));
  const usedOf = (creditId: ID, exceptDoc?: ID) =>
    round2(Object.entries(applies).reduce((s, [doc, a]) => (Number(doc) === exceptDoc ? s : s + (a.credits[creditId] ?? 0)), 0));
  const short = charges.find((d) => {
    const a = applies[d.txnId];
    return a && a.payment > 0 && round2(d.openBalance - a.payment - a.discount - sumCredits(a)) > 0.004;
  });
  const shortBy = short ? round2(short.openBalance - applies[short.txnId].payment - applies[short.txnId].discount - sumCredits(applies[short.txnId])) : 0;

  const setApplies = (next: Record<ID, Apply>, amount?: number) => {
    form.setTxn((cur) => ({ ...cur, links: linksOf(next), ...(amount !== undefined ? { amount } : {}) }));
  };
  /**
   * With "calculate payment" on, the amount of a NEW payment follows the checked invoices (while it
   * was not typed bigger); a saved payment keeps the amount received (un-applying leaves a credit).
   */
  const followAmount = (next: Record<ID, Apply>): number | undefined => {
    const newApplied = round2(Object.values(next).reduce((s, x) => s + x.payment, 0));
    const follow = prefs.autoCalcPayments && (form.isNew ? t.amount === 0 || t.amount === applied || newApplied > t.amount : newApplied > t.amount);
    return follow ? newApplied : undefined;
  };

  // ---- customer / amount changes
  const setCustomer = (id: ID | null) => {
    // the customer's preferred payment method (or its customer's, for a job) unless one was chosen by hand
    const fillMethod = form.isNew && (!t.paymentMethodId || methodFromCustomer.current);
    const pm = fillMethod ? preferredMethod(id, customers) : null;
    form.setTxn((cur) => ({ ...cur, nameId: id, links: [], ...(fillMethod ? { paymentMethodId: pm } : {}) }));
    if (fillMethod) methodFromCustomer.current = !!pm;
    setUpFor.current = null;
    setAutoCredits(false);
    setHi(null);
  };
  const setAmount = (v: number) => {
    const amount = Math.max(0, round2(v));
    if (prefs.autoApplyPayments) setApplies(autoApply(amount, charges, applies), amount);
    else form.update({ amount });
  };
  /** Another A/R account: the open invoices and credits of that account are listed instead. */
  const setArAccount = (id: ID | null) => {
    arPicked.current = true;
    const ar = id ?? defaultAr;
    const ch = chargesOf(docsQ.data, ar);
    const cr = creditsOf(docsQ.data, ar);
    let next: Record<ID, Apply> = autoCredits && cr.length ? creditsToCharges(ch, cr, {}) : {};
    if (t.amount > 0 && prefs.autoApplyPayments) next = autoApply(t.amount, ch, next);
    setAutoCredits(autoCredits && cr.length > 0);
    form.setTxn((cur) => ({ ...cur, arApAccountId: ar, links: linksOf(next) }));
    setHi(null);
  };

  /** Payment that "check this invoice" puts on a charge (what is left of the amount, or all that is due). */
  const paymentFor = (d: OpenDoc, a: Apply) => {
    const left = round2(t.amount - (applied - (applies[d.txnId]?.payment ?? 0)));
    const due = dueAfterDiscCredits(d, a);
    const pay = prefs.autoCalcPayments && (t.amount === 0 || left <= 0) ? due : Math.max(0, Math.min(due, left));
    return round2(Math.max(0, pay > 0 ? pay : due));
  };
  const toggle = (d: OpenDoc, on: boolean) => {
    const next = { ...applies };
    const a = next[d.txnId] ?? EMPTY_APPLY;
    if (on) next[d.txnId] = { ...a, payment: paymentFor(d, a) };
    // unchecking removes the payment but keeps a discount or credits chosen for the invoice; an
    // invoice paid only by its discount and credits loses them
    else next[d.txnId] = a.payment > 0 ? { ...a, payment: 0 } : { ...a, payment: 0, discount: 0, credits: {} };
    setApplies(next, followAmount(next));
    setHi(d.txnId);
  };
  const setPayment = (d: OpenDoc, v: number) => {
    const next = { ...applies, [d.txnId]: { ...(applies[d.txnId] ?? EMPTY_APPLY), payment: Math.max(0, round2(v)) } };
    const newApplied = round2(Object.values(next).reduce((s, x) => s + x.payment, 0));
    setApplies(next, prefs.autoCalcPayments && ((form.isNew && t.amount === applied) || newApplied > t.amount) ? newApplied : undefined);
  };
  const selectAll = (on: boolean) => {
    if (!on) {
      setAutoCredits(false);
      setApplies({}, prefs.autoCalcPayments && form.isNew ? 0 : undefined);
      return;
    }
    const next: Record<ID, Apply> = {};
    for (const d of charges) {
      const a = applies[d.txnId] ?? EMPTY_APPLY;
      next[d.txnId] = { ...a, payment: Math.max(0, dueAfterDiscCredits(d, a)) };
    }
    const total = round2(Object.values(next).reduce((s, x) => s + x.payment, 0));
    setApplies(next, prefs.autoCalcPayments && (form.isNew || total > t.amount) ? total : undefined);
  };
  const openDiscCredits = async (d: OpenDoc) => {
    setHi(d.txnId);
    const r = await discountsAndCredits(d, applies[d.txnId] ?? EMPTY_APPLY, credits, (id) => usedOf(id, d.txnId), prefs.customerDiscountAccountId);
    if (!r) return;
    const due = Math.max(0, dueAfterDiscCredits(d, r));
    let pay = r.payment;
    // the discount and credits lower what is left to pay on the invoice
    if (pay > due) pay = due;
    // "calculate payment": an invoice that gets a discount or credit is checked and paid in full
    else if (pay === 0 && prefs.autoCalcPayments && (r.discount > 0 || sumCredits(r) > 0)) pay = paymentFor(d, r);
    const next = { ...applies, [d.txnId]: { ...r, payment: round2(pay) } };
    setApplies(next, followAmount(next));
  };
  // apply every available credit to the oldest invoices (the "apply credits" toggle)
  const applyAllCredits = (on: boolean) => {
    setAutoCredits(on);
    setApplies(on ? creditsToCharges(charges, credits, applies) : creditsToCharges(charges, [], applies));
  };

  function preparePayment(x: Txn): Txn {
    let links = (x.links ?? []).filter((l) => l.amount > 0 || l.discount > 0);
    // "Write off the extra amount": the rest of the short invoice becomes a discount
    if (underChoice === 'writeoff' && short && shortBy > 0) {
      const acct = writeOffAcct ?? prefs.customerDiscountAccountId;
      links = links.map((l) => (!l.fromTxnId && l.toTxnId === short.txnId ? { ...l, discount: round2(l.discount + shortBy), discountAccountId: l.discountAccountId ?? acct } : l));
    }
    // with several A/R accounts the payment is saved in the account whose invoices it pays
    return { ...x, lines: [], links, amount: round2(x.amount), arApAccountId: multiAr ? x.arApAccountId ?? defaultAr : x.arApAccountId };
  }
  function validatePayment(x: Txn): TxnProblem[] {
    const out: TxnProblem[] = [];
    const ap = appliesOf(x);
    const app = round2(Object.values(ap).reduce((s, a) => s + a.payment, 0));
    const cr = round2(Object.values(ap).reduce((s, a) => s + sumCredits(a) + a.discount, 0));
    if (x.amount <= 0 && cr <= 0) out.push({ field: 'amount', message: 'Enter the amount you received.' });
    if (app > x.amount + 0.004) out.push({ field: 'amount', message: `You applied ${money$(app)} to invoices but the payment is only ${money$(x.amount)}. Increase the payment amount or lower the amounts applied.` });
    for (const [doc, a] of Object.entries(ap)) {
      if (a.discount > 0 && !a.discountAccountId) out.push({ field: 'lines', message: 'Choose the account for the discount (Discounts and credits).' });
      const d = charges.find((c) => c.txnId === Number(doc));
      if (d && a.payment + a.discount + sumCredits(a) > d.openBalance + 0.004)
        out.push({ field: 'lines', message: `${d.typeLabel} ${d.refNumber} is paid more than it owes (${money$(d.openBalance)}). Lower the payment or credits on it.` });
    }
    if (underChoice === 'writeoff' && short && !writeOffAcct && !prefs.customerDiscountAccountId) out.push({ field: 'lines', message: 'Choose the account to write the underpayment off to.' });
    // a payment pays (and uses credits of) the invoices of its own A/R account only
    if (multiAr) {
      const ar = x.arApAccountId ?? defaultAr;
      const arName = (id: ID | null) => arAccounts.find((a) => a.id === id)?.name ?? 'another A/R account';
      const docs = [...(docsQ.data?.charges ?? []), ...(docsQ.data?.credits ?? [])];
      const seen = new Set<ID>();
      for (const l of x.links ?? []) {
        for (const id of [l.toTxnId, l.fromTxnId && l.fromTxnId !== x.id ? l.fromTxnId : null]) {
          const d = id ? docs.find((c) => c.txnId === id) : undefined;
          if (!d || d.arApAccountId === ar || seen.has(d.txnId)) continue;
          seen.add(d.txnId);
          const what = [d.typeLabel, d.refNumber].filter(Boolean).join(' ');
          out.push({ field: 'arApAccountId', message: `${what} is in ${arName(d.arApAccountId)}, but this payment goes to ${arName(ar)}. Choose ${arName(d.arApAccountId)} in A/R ACCOUNT, or un-check it.` });
        }
      }
    }
    return out;
  }

  const methodName = methods?.find((m) => m.id === t.paymentMethodId)?.name ?? '';
  const isCheck = /check/i.test(methodName) && !/e-?check/i.test(methodName);
  const deposited = (t.linked ?? []).find((l) => l.relation === 'deposit');
  const status = t.voided ? 'Void' : form.isNew ? null : deposited ? 'Deposited' : form.original && form.original.openBalance > 0 ? 'Unapplied' : null;

  const totals: FooterTotal[] = [
    { key: 'due', label: 'Amount due', value: totalDue },
    { key: 'applied', label: 'Applied', value: applied },
    { key: 'dc', label: 'Discounts & credits', value: discCred },
    { key: 'amt', label: 'Payment amount', value: t.amount, strong: true },
  ];

  const allChecked = charges.length > 0 && charges.every((d) => isPaid(d, applies[d.txnId]));

  return (
    <TxnFormFrame
      form={form}
      title="Customer Payment"
      status={status}
      stamp={t.voided ? 'VOID' : null}
      readOnly={ro}
      hideSaveNew={false}
      onPrint={() => void printPaymentReceipt(preparePayment(t), charges, methodName)}
      extraButtons={[
        {
          key: 'disc',
          label: 'Discounts and credits',
          icon: BadgePercent,
          disabled: ro || !hi || !charges.find((d) => d.txnId === hi),
          onClick: () => {
            const d = charges.find((x) => x.txnId === hi);
            if (d) void openDiscCredits(d);
          },
          title: 'Give a discount or use credits on the highlighted invoice',
        },
        {
          key: 'unapply',
          label: 'Un-apply payment',
          icon: Undo2,
          disabled: ro || (t.links ?? []).length === 0,
          onClick: () => {
            setAutoCredits(false);
            setApplies({});
          },
          title: 'Remove all applications (the payment stays as a credit)',
        },
      ]}
      header={
        <>
          <HeaderRow>
            <HeaderField label="RECEIVED FROM" width={300} required help="Customer or Job">
              <NamePicker name="nameId" kinds={['customer']} value={t.nameId} fallbackLabel={t.nameFull} autoFocus={form.isNew && !t.nameId} onChange={(id) => setCustomer(id)} readOnly={ro} aria-label="Received from" />
            </HeaderField>
            <TxnHeaderField label="CUSTOMER BALANCE" width={150}>
              <div className="sx-cust-readout">{money$(customer?.balance ?? 0)}</div>
            </TxnHeaderField>
            <HeaderSpacer />
            <HeaderField label="PAYMENT AMOUNT" width={150} required>
              <MoneyField name="amount" value={t.amount} onChange={(v) => setAmount(v ?? 0)} readOnly={ro} className="sx-cust-bigamount" aria-label="Payment amount" />
            </HeaderField>
            <HeaderField label="DATE" width={140} required>
              <DateField name="date" value={t.date} onChange={(d) => form.update({ date: d })} readOnly={ro} />
            </HeaderField>
          </HeaderRow>
          <HeaderRow>
            <TxnHeaderField label="PAYMENT METHOD" width="auto">
              <MethodButtons
                value={t.paymentMethodId}
                onChange={(id) => {
                  methodFromCustomer.current = false;
                  form.update({ paymentMethodId: id });
                }}
                disabled={ro}
              />
            </TxnHeaderField>
            <HeaderField label={isCheck ? 'CHECK #' : 'REFERENCE #'} width={130}>
              <TextField name="refNumber" value={t.refNumber} onChange={(v) => form.update({ refNumber: v })} readOnly={ro} />
            </HeaderField>
            {(!prefs.useUndepositedFunds || (!!t.accountId && !!ufId && t.accountId !== ufId)) && (
              <HeaderField label="DEPOSIT TO" width={220} help="Undeposited Funds">
                <AccountPicker name="accountId" types={['Bank', 'Other Current Asset']} value={t.accountId} onChange={(id) => form.update({ accountId: id })} readOnly={ro} placeholder="Undeposited Funds" />
              </HeaderField>
            )}
            {multiAr && (
              <HeaderField label="A/R ACCOUNT" width={200} help="A/R account">
                <AccountPicker name="arApAccountId" types={['Accounts Receivable']} value={effAr} onChange={(id) => setArAccount(id)} readOnly={ro} aria-label="A/R account" />
              </HeaderField>
            )}
            <HeaderField label="MEMO" width={240} help="Memo">
              <TextField name="memo" value={t.memo} onChange={(v) => form.update({ memo: v })} readOnly={ro} />
            </HeaderField>
          </HeaderRow>
        </>
      }
      lines={
        !t.nameId ? (
          <EmptyState compact title="Choose a customer" message="Pick the customer who paid. Their open invoices appear here and the payment is applied automatically." />
        ) : docsQ.isLoading ? (
          <Spinner center label="Loading open invoices..." />
        ) : (
          <div className="sx-cust-paytable-wrap">
            <div className="sx-cust-paytable-scroll">
              <table className="sx-cust-paytable" aria-label="Open invoices">
                <thead>
                  <tr>
                    <th className="sx-cust-ck">
                      <input type="checkbox" aria-label="Pay all" checked={allChecked} disabled={ro || !charges.length} onChange={(e) => selectAll(e.target.checked)} />
                    </th>
                    <th className="sx-cust-c-date">DATE</th>
                    <th className="sx-cust-c-num">NUMBER</th>
                    {hasJobs && <th className="sx-cust-c-job">JOB</th>}
                    <th className="sx-num sx-cust-c-amt">ORIG. AMT.</th>
                    <th className="sx-num sx-cust-c-amt">AMT. DUE</th>
                    <th className="sx-cust-c-ddate">DISC. DATE</th>
                    <th className="sx-num sx-cust-c-dc">DISC. &amp; CREDITS</th>
                    <th className="sx-num sx-cust-amtcell">PAYMENT</th>
                  </tr>
                </thead>
                <tbody>
                  {charges.length === 0 && (
                    <tr>
                      <td colSpan={9} className="sx-cust-paytable-empty">
                        This customer has no open invoices. The payment will be kept as a credit.
                      </td>
                    </tr>
                  )}
                  {charges.map((d) => {
                    const a = applies[d.txnId];
                    const on = isPaid(d, a);
                    const dc = a ? round2(a.discount + sumCredits(a)) : 0;
                    const job = customer && d.nameFull.startsWith(customer.fullName + ':') ? d.nameFull.slice(customer.fullName.length + 1) : '';
                    const overdue = (d.dueDate || d.date) < todayIso();
                    return (
                      <tr key={d.txnId} className={(on ? 'sx-on' : '') + (hi === d.txnId ? ' sx-hi' : '')} onMouseDown={() => setHi(d.txnId)}>
                        <td className="sx-cust-ck">
                          <input type="checkbox" aria-label={`Pay ${d.typeLabel} ${d.refNumber}`} checked={on} disabled={ro} onChange={(e) => toggle(d, e.target.checked)} />
                        </td>
                        <td>{fmtDate(d.date)}</td>
                        <td>
                          <span className="sx-cust-numcell">
                            <button type="button" className="sx-linkbtn" title={`Open ${d.typeLabel} ${d.refNumber || '(no number)'}`} onClick={() => openTxn(d.type, d.txnId)}>
                              {d.type === 'INV' ? d.refNumber || '(no number)' : d.refNumber ? `${d.typeLabel} ${d.refNumber}` : d.typeLabel}
                            </button>
                            {overdue && <span className="sx-cust-overdue-dot" title={`Overdue since ${fmtDate(d.dueDate || d.date)}`} />}
                          </span>
                        </td>
                        {hasJobs && (
                          <td className="sx-cust-jobcell" title={job || undefined}>
                            {job}
                          </td>
                        )}
                        <td className="sx-num">{fmtMoney(d.amount)}</td>
                        <td className="sx-num">{fmtMoney(d.openBalance)}</td>
                        <td className="sx-cust-c-ddate">{d.discountDate ? fmtDate(d.discountDate) : ''}</td>
                        <td className="sx-num">
                          <button
                            type="button"
                            className="sx-linkbtn"
                            disabled={ro}
                            onClick={() => void openDiscCredits(d)}
                            title={d.discountDate ? `Discounts and credits (early payment discount until ${fmtDate(d.discountDate)})` : 'Discounts and credits'}
                          >
                            {dc ? fmtMoney(dc) : d.suggestedDiscount > 0 ? `Disc. ${fmtMoney(d.suggestedDiscount)}?` : 'Add'}
                          </button>
                        </td>
                        <td className="sx-num sx-cust-amtcell">
                          <MoneyField value={a?.payment ?? 0} blankZero width={110} readOnly={ro} aria-label={`Payment on ${d.refNumber}`} onChange={(v) => setPayment(d, v ?? 0)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {charges.length > 0 && (
                  <tfoot>
                    <tr>
                      <td colSpan={hasJobs ? 4 : 3} className="sx-cust-tfoot-label">
                        Totals
                      </td>
                      <td className="sx-num">{fmtMoney(charges.reduce((s, d) => s + d.amount, 0))}</td>
                      <td className="sx-num">{fmtMoney(totalDue)}</td>
                      <td className="sx-cust-c-ddate" />
                      <td className="sx-num">{fmtMoney(discCred)}</td>
                      <td className="sx-num">{fmtMoney(applied)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            {creditAvail > 0 && (
              <div className="sx-cust-creditline">
                <Checkbox checked={autoCredits} onChange={applyAllCredits} disabled={ro} label={`Apply available credits (${money$(creditAvail)}) to the oldest invoices`} />
                <span className="sx-cust-note">{credits.map((c) => `${c.typeLabel} ${c.refNumber || ''} ${money$(c.openBalance)}`).join(' · ')}</span>
              </div>
            )}
            {otherAr.length > 0 && !ro && (
              <div className="sx-cust-note sx-cust-otherar">
                {otherAr.map((o) => `${o.count} open ${o.count === 1 ? 'invoice' : 'invoices'} (${money$(o.amount)}) in ${o.name}`).join(' and ')} not listed: a payment pays the invoices of
                one A/R account. Choose that account in A/R ACCOUNT to pay {otherAr.length === 1 && otherAr[0].count === 1 ? 'it' : 'them'}.
              </div>
            )}
          </div>
        )
      }
      footer={
        t.nameId ? (
          <div className="sx-cust-explain" role="status">
            {unapplied > 0.004 ? (
              <>
                <p>
                  <b>{money$(unapplied)}</b> of this payment is not applied to an invoice. What do you want to do with it?
                </p>
                <Radio name="over" checked={overChoice === 'credit'} onChange={() => setOverChoice('credit')} label={`Keep it as a credit for ${customer?.fullName || t.nameFull || 'this customer'} (used on a later invoice)`} />
                <Radio name="over" checked={overChoice === 'refund'} onChange={() => setOverChoice('refund')} label="Refund the amount to the customer (opens the refund form after you save)" />
              </>
            ) : short ? (
              <>
                <p>
                  This payment does not pay {short.typeLabel.toLowerCase()} <b>{short.refNumber}</b> in full: <b>{money$(shortBy)}</b> will still be owed.
                </p>
                <Radio name="under" checked={underChoice === 'leave'} onChange={() => setUnderChoice('leave')} label="Leave this as an underpayment (the rest stays open on the invoice)" />
                <div className="sx-cust-inline">
                  <Radio name="under" checked={underChoice === 'writeoff'} onChange={() => setUnderChoice('writeoff')} label="Write off the extra amount as a discount to" />
                  {underChoice === 'writeoff' && (
                    <AccountPicker value={writeOffAcct ?? prefs.customerDiscountAccountId} onChange={(id) => setWriteOffAcct(id)} types={['Income', 'Other Income', 'Expense', 'Other Expense']} width={220} aria-label="Write-off account" />
                  )}
                </div>
              </>
            ) : applied > 0 ? (
              <p className="sx-cust-ok">The payment is fully applied.{discCred > 0 ? ` Discounts and credits of ${money$(discCred)} are used too.` : ''}</p>
            ) : (
              <p className="sx-muted">Type the amount received, or check the invoices it pays.</p>
            )}
            {deposited && (
              <p className="sx-cust-note">
                This payment was deposited on {fmtDate(deposited.date)}.{' '}
                <button type="button" className="sx-linkbtn" onClick={() => openTxn('DEP', deposited.txnId)}>
                  Open the deposit
                </button>
              </p>
            )}
          </div>
        ) : null
      }
      totals={totals}
      sidePanel={<CustomerHistoryPanel nameId={t.nameId} txn={form.original} persistKey="payment" />}
    />
  );
}
