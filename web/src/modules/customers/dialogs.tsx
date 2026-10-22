// Dialogs of the customer forms: Add Time/Costs (billable costs → invoice lines), Apply Credits
// (open credits → this invoice), Apply credit memo to invoices, and the "Available Credit" question
// asked after saving a new credit memo.
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/api/client';
import { invalidateAll } from '@/api/hooks';
import { emptyLine, type BillableCost, type ID, type OpenDoc, type OpenDocsResult, type Txn, type TxnLine } from '@/api/types';
import { Button, EmptyState, MoneyField, Radio, showDialog, Spinner } from '@/components';
import { fmtDate, fmtMoney, round2 } from '@/util/format';
import { money$ } from './shared';

// ---------------------------------------------------------------------------
// Add Time/Costs

const SOURCE: Record<string, string> = { BILL: 'Bill', CHK: 'Check', CCCHARGE: 'Card charge', ITEMRCPT: 'Item receipt' };

/**
 * Opens "Choose Billable Time and Costs"; resolves with the invoice lines to add (empty when
 * cancelled). opts.selectAll starts with every cost checked (the invoice's "Add them" banner).
 */
export function chooseBillableCosts(customerId: ID, customerName: string, already: Set<ID>, customerTaxable: boolean, opts: { selectAll?: boolean } = {}): Promise<TxnLine[]> {
  return showDialog<TxnLine[]>({
    title: 'Choose Billable Time and Costs',
    width: 720,
    cancelValue: [],
    render: (close) => <BillablesBody customerId={customerId} customerName={customerName} already={already} customerTaxable={customerTaxable} selectAll={!!opts.selectAll} close={close} />,
  });
}

function BillablesBody({
  customerId,
  customerName,
  already,
  customerTaxable,
  selectAll,
  close,
}: {
  customerId: ID;
  customerName: string;
  already: Set<ID>;
  customerTaxable: boolean;
  selectAll: boolean;
  close: (v: TxnLine[]) => void;
}) {
  const [rows, setRows] = useState<BillableCost[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<ID>>(new Set());
  useEffect(() => {
    api
      .get<BillableCost[]>(`/billables?customerId=${customerId}`)
      .then((r) => {
        const list = r.filter((x) => !already.has(x.lineId));
        setRows(list);
        if (selectAll) setSel(new Set(list.map((x) => x.lineId)));
      })
      .catch((e) => setErr((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const total = useMemo(() => round2((rows ?? []).filter((r) => sel.has(r.lineId)).reduce((s, r) => s + r.amount, 0)), [rows, sel]);
  const toggle = (id: ID) => {
    const n = new Set(sel);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSel(n);
  };
  const ok = () => {
    const picked = (rows ?? []).filter((r) => sel.has(r.lineId));
    const lines: TxnLine[] = picked.map((r) => ({
      ...emptyLine('item'),
      itemId: r.itemId,
      accountId: r.itemId ? null : r.accountId,
      description: r.description || (r.vendorName ? `${r.vendorName}` : ''),
      qty: r.itemId ? r.qty ?? 1 : null,
      rate: r.itemId ? r.rate ?? r.amount : r.amount,
      amount: r.amount,
      classId: r.classId,
      taxable: r.itemId ? customerTaxable : false,
      linkedTxnId: r.txnId,
      linkedLineId: r.lineId,
    }));
    close(lines);
  };
  return (
    <div className="sx-cust-dlg">
      <p className="sx-cust-dlg-intro">
        Costs you recorded on bills, checks and credit card charges for <b>{customerName}</b> and marked <i>billable</i>. Check the ones to add to this invoice.
      </p>
      {err && <div className="sx-cust-dlg-error">{err}</div>}
      {!rows && !err && <Spinner label="Loading billable costs..." />}
      {rows && rows.length === 0 && <EmptyState compact title="Nothing to bill" message="This customer has no unbilled costs. Mark expense or item lines as billable on bills or checks to see them here." />}
      {rows && rows.length > 0 && (
        <div className="sx-cust-pick-table">
          <table>
            <thead>
              <tr>
                <th className="sx-cust-ck">
                  <input type="checkbox" aria-label="Select all" checked={sel.size === rows.length} onChange={(e) => setSel(e.target.checked ? new Set(rows.map((r) => r.lineId)) : new Set())} />
                </th>
                <th>Date</th>
                <th>Source</th>
                <th>Description</th>
                <th className="sx-num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.lineId} className={sel.has(r.lineId) ? 'sx-on' : undefined} onClick={() => toggle(r.lineId)}>
                  <td className="sx-cust-ck">
                    <input type="checkbox" aria-label={`Use ${r.description}`} checked={sel.has(r.lineId)} onChange={() => toggle(r.lineId)} onClick={(e) => e.stopPropagation()} />
                  </td>
                  <td>{fmtDate(r.date)}</td>
                  <td className="sx-cust-wrapcell">
                    {r.vendorName}
                    <div className="sx-muted">
                      {SOURCE[r.txnType] ?? r.txnType} {r.refNumber}
                      {r.nameFull && r.nameFull !== customerName ? ` · ${r.nameFull}` : ''}
                    </div>
                  </td>
                  <td className="sx-cust-wrapcell">{r.description}</td>
                  <td className="sx-num">{fmtMoney(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="sx-dlg-buttons sx-cust-dlg-buttons">
        <span className="sx-cust-dlg-total">Selected: {money$(total)}</span>
        <Button variant="secondary" label="Cancel" onClick={() => close([])} />
        <Button variant="primary" label="Add to invoice" disabled={!sel.size} onClick={ok} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Apply credits to an invoice

/** Applies an amount of a credit (credit memo, unapplied payment or journal entry credit) to an invoice by re-saving the credit with a link. */
export async function applyCreditTo(creditId: ID, invoiceId: ID, amount: number): Promise<void> {
  const c = await api.get<Txn>(`/txns/${creditId}`);
  const links = [...(c.links ?? [])];
  const own = (l: (typeof links)[number]) => !l.fromTxnId || l.fromTxnId === c.id;
  const i = links.findIndex((l) => own(l) && l.toTxnId === invoiceId);
  if (i >= 0) links[i] = { ...links[i], amount: round2(links[i].amount + amount) };
  else
    links.push({
      id: 0,
      fromTxnId: null,
      toTxnId: invoiceId,
      amount: round2(amount),
      discount: 0,
      discountAccountId: null,
      fromType: '',
      fromRefNumber: '',
      fromDate: '',
      toType: '',
      toRefNumber: '',
      toDate: '',
      toAmount: 0,
    });
  await api.put<Txn>(`/txns/${creditId}`, { ...c, links });
}

/** "Apply Credits" of an invoice: pick open credits of the customer; resolves true when something was applied. */
export function applyCreditsToInvoice(inv: Txn): Promise<boolean> {
  return showDialog<boolean>({
    title: `Apply Credits - Invoice ${inv.refNumber}`,
    width: 660,
    cancelValue: false,
    render: (close) => <ApplyCreditsBody inv={inv} close={close} />,
  });
}

function ApplyCreditsBody({ inv, close }: { inv: Txn; close: (v: boolean) => void }) {
  const [docs, setDocs] = useState<OpenDoc[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [amounts, setAmounts] = useState<Record<ID, number>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const top = inv.nameId;
    api
      .get<OpenDocsResult>(`/open-docs?kind=receivable&nameId=${top}&includeJobs=1&excludeTxnId=0`)
      // only credits of the invoice's own A/R account can pay it
      .then((r) => setDocs(r.credits.filter((c) => c.openBalance > 0 && (!inv.accountId || c.arApAccountId === inv.accountId))))
      .catch((e) => setErr((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const due = inv.openBalance;
  const used = round2(Object.values(amounts).reduce((s, v) => s + (v || 0), 0));
  const remaining = round2(due - used);
  const toggle = (d: OpenDoc, on: boolean) => {
    const n = { ...amounts };
    if (on) n[d.txnId] = Math.max(0, Math.min(d.openBalance, round2(due - used)));
    else delete n[d.txnId];
    setAmounts(n);
  };
  const ok = async () => {
    if (used <= 0) return close(false);
    if (used > due + 0.004) {
      setErr(`You applied ${money$(used)} but the invoice only has ${money$(due)} left to pay. Lower the amounts.`);
      return;
    }
    setBusy(true);
    try {
      for (const [id, amt] of Object.entries(amounts)) if (amt > 0) await applyCreditTo(Number(id), inv.id, amt);
      void invalidateAll();
      close(true);
    } catch (e) {
      if ((e as { code?: string }).code !== 'cancelled') setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="sx-cust-dlg">
      <div className="sx-cust-dlg-sum">
        <span>
          Customer: <b>{inv.nameFull}</b>
        </span>
        <span>
          Invoice balance: <b>{money$(due)}</b>
        </span>
        <span>
          Left after credits: <b className={remaining < 0 ? 'sx-tone-text-danger' : undefined}>{money$(remaining)}</b>
        </span>
      </div>
      {err && <div className="sx-cust-dlg-error">{err}</div>}
      {!docs && !err && <Spinner label="Loading credits..." />}
      {docs && docs.length === 0 && <EmptyState compact title="No credits available" message="This customer has no unused credit memos or payments to apply." />}
      {docs && docs.length > 0 && (
        <div className="sx-cust-pick-table">
          <table>
            <thead>
              <tr>
                <th className="sx-cust-ck" />
                <th>Date</th>
                <th>Credit</th>
                <th>Customer or Job</th>
                <th className="sx-num">Credit left</th>
                <th className="sx-num">Amount to use</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => {
                const on = d.txnId in amounts;
                return (
                  <tr key={d.txnId} className={on ? 'sx-on' : undefined}>
                    <td className="sx-cust-ck">
                      <input type="checkbox" aria-label={`Use credit ${d.refNumber}`} checked={on} onChange={(e) => toggle(d, e.target.checked)} />
                    </td>
                    <td>{fmtDate(d.date)}</td>
                    <td>
                      {d.typeLabel} {d.refNumber}
                    </td>
                    <td className="sx-cust-wrapcell">{d.nameFull}</td>
                    <td className="sx-num">{fmtMoney(d.openBalance)}</td>
                    <td className="sx-num sx-cust-amtcell">
                      <MoneyField
                        value={amounts[d.txnId] ?? 0}
                        blankZero
                        width={100}
                        aria-label="Amount to use"
                        onChange={(v) => {
                          const a = Math.max(0, Math.min(d.openBalance, v ?? 0));
                          const n = { ...amounts };
                          if (a > 0) n[d.txnId] = a;
                          else delete n[d.txnId];
                          setAmounts(n);
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
      <div className="sx-dlg-buttons sx-cust-dlg-buttons">
        <span className="sx-cust-dlg-total">Credits used: {money$(used)}</span>
        <Button variant="secondary" label="Cancel" onClick={() => close(false)} disabled={busy} />
        <Button variant="primary" label="Apply" onClick={() => void ok()} busy={busy} disabled={!used} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Apply a credit memo (or any credit) to invoices

/**
 * "Apply Credit to Invoices": lists the customer's open invoices with checkboxes; the chosen amounts
 * become the credit's links (PUT). Resolves true when saved.
 */
export function applyCreditToInvoices(credit: Txn): Promise<boolean> {
  return showDialog<boolean>({
    title: 'Apply Credit to Invoices',
    width: 700,
    cancelValue: false,
    render: (close) => <ApplyToInvoicesBody credit={credit} close={close} />,
  });
}

function ApplyToInvoicesBody({ credit, close }: { credit: Txn; close: (v: boolean) => void }) {
  const [docs, setDocs] = useState<OpenDoc[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // existing applications of this credit (owned links)
  const existing = useMemo(() => {
    const m: Record<ID, number> = {};
    for (const l of credit.links ?? []) if (!l.fromTxnId || l.fromTxnId === credit.id) m[l.toTxnId] = round2((m[l.toTxnId] ?? 0) + l.amount);
    return m;
  }, [credit]);
  const [amounts, setAmounts] = useState<Record<ID, number>>(existing);
  useEffect(() => {
    api
      .get<OpenDocsResult>(`/open-docs?kind=receivable&nameId=${credit.nameId}&includeJobs=1&excludeTxnId=${credit.id}`)
      // a credit pays the invoices of its own A/R account only
      .then((r) => {
        const own = credit.type === 'CREDMEM' ? credit.accountId : credit.arApAccountId;
        setDocs(r.charges.filter((d) => !own || d.arApAccountId === own || (credit.links ?? []).some((l) => l.toTxnId === d.txnId)));
      })
      .catch((e) => setErr((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // open balance of a charge without this credit's own application
  const openOf = (d: OpenDoc) => round2(d.openBalance + (existing[d.txnId] ?? 0));
  const avail = round2(credit.amount);
  const used = round2(Object.values(amounts).reduce((s, v) => s + (v || 0), 0));
  const left = round2(avail - used);
  const rows = (docs ?? []).filter((d) => openOf(d) > 0 || d.txnId in amounts);
  const toggle = (d: OpenDoc, on: boolean) => {
    const n = { ...amounts };
    if (on) n[d.txnId] = Math.max(0, Math.min(openOf(d), left));
    else delete n[d.txnId];
    setAmounts(n);
  };
  const ok = async () => {
    if (used > avail + 0.004) {
      setErr(`You applied ${money$(used)} but the credit is only ${money$(avail)}.`);
      return;
    }
    setBusy(true);
    try {
      const fresh = await api.get<Txn>(`/txns/${credit.id}`);
      const others = (fresh.links ?? []).filter((l) => l.fromTxnId && l.fromTxnId !== fresh.id);
      const mine = Object.entries(amounts)
        .filter(([, a]) => a > 0)
        .map(([to, a]) => ({
          id: 0,
          fromTxnId: null,
          toTxnId: Number(to),
          amount: round2(a),
          discount: 0,
          discountAccountId: null,
          fromType: '' as const,
          fromRefNumber: '',
          fromDate: '',
          toType: '' as const,
          toRefNumber: '',
          toDate: '',
          toAmount: 0,
        }));
      await api.put<Txn>(`/txns/${credit.id}`, { ...fresh, links: [...others, ...mine] });
      void invalidateAll();
      close(true);
    } catch (e) {
      if ((e as { code?: string }).code !== 'cancelled') setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="sx-cust-dlg">
      <div className="sx-cust-dlg-sum">
        <span>
          Customer: <b>{credit.nameFull}</b>
        </span>
        <span>
          Credit {credit.refNumber ? `#${credit.refNumber}` : ''}: <b>{money$(avail)}</b>
        </span>
        <span>
          Credit left: <b className={left < 0 ? 'sx-tone-text-danger' : undefined}>{money$(left)}</b>
        </span>
      </div>
      {err && <div className="sx-cust-dlg-error">{err}</div>}
      {!docs && !err && <Spinner label="Loading open invoices..." />}
      {docs && rows.length === 0 && <EmptyState compact title="No open invoices" message="This customer has no open invoices. The credit stays available for future invoices." />}
      {rows.length > 0 && (
        <div className="sx-cust-pick-table">
          <table>
            <thead>
              <tr>
                <th className="sx-cust-ck" />
                <th>Date</th>
                <th>Number</th>
                <th>Customer or Job</th>
                <th className="sx-num">Orig. Amt.</th>
                <th className="sx-num">Amt. Due</th>
                <th className="sx-num">Amount applied</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const on = d.txnId in amounts;
                return (
                  <tr key={d.txnId} className={on ? 'sx-on' : undefined}>
                    <td className="sx-cust-ck">
                      <input type="checkbox" aria-label={`Apply to ${d.refNumber}`} checked={on} onChange={(e) => toggle(d, e.target.checked)} />
                    </td>
                    <td>{fmtDate(d.date)}</td>
                    <td>
                      {d.type === 'INV' ? '' : d.typeLabel + ' '}
                      {d.refNumber}
                    </td>
                    <td className="sx-cust-wrapcell">{d.nameFull}</td>
                    <td className="sx-num">{fmtMoney(d.amount)}</td>
                    <td className="sx-num">{fmtMoney(openOf(d))}</td>
                    <td className="sx-num sx-cust-amtcell">
                      <MoneyField
                        value={amounts[d.txnId] ?? 0}
                        blankZero
                        width={100}
                        aria-label="Amount applied"
                        onChange={(v) => {
                          const a = Math.max(0, Math.min(openOf(d), v ?? 0));
                          const n = { ...amounts };
                          if (a > 0) n[d.txnId] = a;
                          else delete n[d.txnId];
                          setAmounts(n);
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
      <div className="sx-dlg-buttons sx-cust-dlg-buttons">
        <span className="sx-cust-dlg-total">Applied: {money$(used)}</span>
        <Button variant="secondary" label="Cancel" onClick={() => close(false)} disabled={busy} />
        <Button variant="primary" label="Done" onClick={() => void ok()} busy={busy} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Available Credit (after saving a new credit memo)

/** What to do with a new credit: keep it, refund it, or apply it to invoices. */
export type CreditChoice = 'retain' | 'refund' | 'apply';

/** "Available Credit" box shown after saving a new credit memo. */
export function askCreditUse(amount: number, customer: string): Promise<CreditChoice | null> {
  return showDialog<CreditChoice | null>({
    title: 'Available Credit',
    width: 460,
    cancelValue: null,
    render: (close) => <CreditUseBody amount={amount} customer={customer} close={close} />,
  });
}

function CreditUseBody({ amount, customer, close }: { amount: number; customer: string; close: (v: CreditChoice | null) => void }) {
  const [v, setV] = useState<CreditChoice>('retain');
  return (
    <div className="sx-cust-dlg sx-cust-credituse">
      <p>
        This credit memo of <b>{money$(amount)}</b> for <b>{customer}</b> is a credit you owe the customer. What would you like to do with it?
      </p>
      <div className="sx-cust-choice">
        <Radio name="credituse" checked={v === 'retain'} onChange={() => setV('retain')} label="Keep it as an available credit" />
        <div className="sx-cust-choice-help">
          Receive Payments uses it on this customer&apos;s oldest invoices the next time you receive a payment (untick &quot;Apply available credits&quot; there to keep it), or apply it
          later.
        </div>
        <Radio name="credituse" checked={v === 'refund'} onChange={() => setV('refund')} label="Give a refund" />
        <div className="sx-cust-choice-help">Opens the refund form to pay the money back by check or cash.</div>
        <Radio name="credituse" checked={v === 'apply'} onChange={() => setV('apply')} label="Apply to an invoice" />
        <div className="sx-cust-choice-help">Choose which open invoices this credit pays.</div>
      </div>
      <div className="sx-dlg-buttons">
        <Button variant="primary" label="OK" onClick={() => close(v)} />
      </div>
    </div>
  );
}

