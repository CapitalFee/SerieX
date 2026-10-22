// Pay Sales Tax: pay from account, check date, "show sales tax due through", starting check number
// (or to be printed); grid ✓ PAY / ITEM / VENDOR / AMT. DUE / AMT. PAID; Pay All Tax. OK creates
// one sales tax payment (TAXPMT) per tax agency with one line per tax item. Sales tax adjustments
// (changes to Sales Tax Payable without a tax item, e.g. a journal entry for a discount or a
// penalty, named with the agency) come from /sales-tax/due as rows with taxItemId null; they are
// paid as lines to Sales Tax Payable (no item) on that agency's payment.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckSquare, Percent, Square } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { invalidateAll, useAccounts, useNextRef, usePrefValues } from '@/api/hooks';
import { emptyLine, emptyTxn, type ID, type SalesTaxDue, type Txn } from '@/api/types';
import {
  AccountPicker,
  Button,
  Checkbox,
  DateField,
  EmptyState,
  ErrorBanner,
  Field,
  FormErrorsProvider,
  Grid,
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
import { addDays, startOfMonth, todayIso } from '@/util/dates';
import { fmtDate, fmtMoney, round2 } from '@/util/format';
import { fetchName, isTaxAdjustment, sum2, taxDueLabel, vendorAddressText } from './shared';
import './vendors.css';

export interface PaySalesTaxProps {}

interface TaxRow {
  /** Row key: "i<taxItemId>" for a tax item, "a<agencyId><row>" for an agency's adjustments. */
  id: string;
  due: SalesTaxDue;
  pay: boolean;
  amount: number;
}

function rowKey(d: SalesTaxDue, i: number): string {
  return isTaxAdjustment(d) ? `a${d.agencyId ?? 'none'}-${i}` : `i${d.taxItemId}`;
}

/** Last day of the previous tax period (monthly / quarterly / yearly). */
export function lastPeriodEnd(today: string, freq: string): string {
  const y = +today.slice(0, 4);
  const m = +today.slice(5, 7);
  if (freq === 'annually') return `${y - 1}-12-31`;
  if (freq === 'quarterly') {
    const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
    return addDays(`${y}-${String(qStartMonth).padStart(2, '0')}-01`, -1);
  }
  return addDays(startOfMonth(today), -1);
}

/** Increments the trailing number of a check number ("1009" → "1010", "A-9" → "A-10"). */
function incRef(s: string): string {
  const m = /^(.*?)(\d+)$/.exec(s);
  if (!m) return s;
  const n = String(Number(m[2]) + 1);
  return m[1] + (n.length < m[2].length ? n.padStart(m[2].length, '0') : n);
}

export default function PaySalesTax(_props: PaySalesTaxProps) {
  const win = useWindow();
  const prefs = usePrefValues();
  const fe = useFormErrors();
  const today = todayIso();
  const { data: banks } = useAccounts({ types: ['Bank'], active: 'all' });
  const { data: allAccounts } = useAccounts({ active: 'all' });
  const stpAccountId = allAccounts?.find((a) => a.special === 'SalesTaxPayable')?.id ?? null;
  const [accountId, setAccountId] = useState<ID | null>(null);
  const [date, setDate] = useState(today);
  const [through, setThrough] = useState(() => lastPeriodEnd(today, prefs.salesTaxFrequency));
  const [toPrint, setToPrint] = useState(false);
  const [checkNo, setCheckNo] = useState('');
  const [checkTouched, setCheckTouched] = useState(false);
  const [state, setState] = useState<Map<string, { pay: boolean; amount: number }>>(new Map());
  const [busy, setBusy] = useState(false);
  const acct = banks?.find((a) => a.id === accountId) ?? null;
  const next = useNextRef('CHK', accountId, { enabled: !!accountId });
  useEffect(() => {
    if (!checkTouched && next.data) setCheckNo(next.data.refNumber);
  }, [next.data, checkTouched]);
  useEffect(() => {
    if (accountId || !banks?.length) return;
    const def = prefs.defaultCheckAccountId ? banks.find((a) => a.id === prefs.defaultCheckAccountId) : undefined;
    setAccountId((def ?? banks.find((a) => a.active))?.id ?? null);
  }, [banks, accountId, prefs.defaultCheckAccountId]);

  const due = useQuery({ queryKey: ['sales-tax-due', through], queryFn: () => api.get<SalesTaxDue[]>(`/sales-tax/due?asOf=${through}`), enabled: !!through });
  useEffect(() => setState(new Map()), [through]);

  // once the tax due is loaded, put the keyboard on the first row's PAY box (Space checks it), or
  // on the Pay from account when nothing is due — unless the user already clicked into a field
  const rootRef = useRef<HTMLDivElement>(null);
  const gridApi = useRef<GridApi | null>(null);
  const focusDone = useRef(false);
  // (the flag is set in the frame callback: an effect run again right away — React StrictMode in
  // development, or new data — cancels the frame and must schedule it again)
  useEffect(() => {
    if (focusDone.current || !due.data) return;
    const id = requestAnimationFrame(() => {
      focusDone.current = true;
      const root = rootRef.current;
      const ae = document.activeElement as HTMLElement | null;
      if (!root || !win.isActive || (ae && root.contains(ae) && ae !== root && ae.matches('input, select, textarea, button, [role=combobox]'))) return;
      if (gridApi.current && due.data?.length) gridApi.current.activate(0, 'pay');
      else root.querySelector<HTMLElement>('#vx-pt-acct')?.focus();
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [due.data]);

  const rows: TaxRow[] = useMemo(
    () =>
      (due.data ?? []).map((d, i) => {
        const id = rowKey(d, isTaxAdjustment(d) ? i : 0);
        const st = state.get(id);
        return { id, due: d, pay: st?.pay ?? false, amount: st?.amount ?? 0 };
      }),
    [due.data, state],
  );
  const chosen = rows.filter((r) => r.pay && r.amount !== 0);
  const totalDue = sum2(rows.map((r) => r.due.amountDue));
  const totalPaid = sum2(chosen.map((r) => r.amount));

  const onRowsChange = (next: TaxRow[]) =>
    setState((m) => {
      const n = new Map(m);
      for (const r of next) n.set(r.id, { pay: r.pay, amount: r.amount });
      return n;
    });
  const onRowChange = (nextRow: TaxRow, prev: TaxRow, key: string): TaxRow => {
    if (key === 'pay') return { ...nextRow, amount: nextRow.pay ? nextRow.due.amountDue : 0 };
    if (key === 'amount') return { ...nextRow, amount: round2(nextRow.amount || 0), pay: (nextRow.amount || 0) !== 0 };
    return nextRow;
  };
  const payAll = () => setState(new Map(rows.map((r) => [r.id, { pay: true, amount: r.due.amountDue }])));

  const pay = async () => {
    fe.clearAll();
    if (!accountId) return fe.setErrors({ accountId: 'Choose the bank account to pay from.' });
    if (!date) return fe.setErrors({ date: 'Enter the check date.' });
    if (!chosen.length) return fe.setErrors({}, 'Check the sales tax items you want to pay.');
    const noAgency = chosen.find((r) => !r.due.agencyId);
    if (noAgency)
      return fe.setErrors(
        {},
        isTaxAdjustment(noAgency.due)
          ? `The sales tax adjustment of ${fmtMoney(noAgency.due.amountDue)} has no tax agency. Edit the journal entry that changed Sales Tax Payable and put the agency (vendor) in its Name column.`
          : `"${noAgency.due.taxItemName}" has no tax agency. Edit the sales tax item and choose the agency (vendor) you pay it to.`,
      );
    if (chosen.some((r) => isTaxAdjustment(r.due)) && !stpAccountId) return fe.setErrors({}, 'The Sales Tax Payable account was not found, so the adjustments cannot be paid.');
    const byAgency = new Map<ID, TaxRow[]>();
    for (const r of chosen) byAgency.set(r.due.agencyId!, [...(byAgency.get(r.due.agencyId!) ?? []), r]);
    for (const [, list] of byAgency) {
      if (sum2(list.map((r) => r.amount)) <= 0) return fe.setErrors({}, `The payment to ${list[0].due.agencyName} would be zero or less. A refund from the agency is entered as a deposit instead.`);
    }
    setBusy(true);
    const created: Txn[] = [];
    let num = checkNo.trim();
    try {
      for (const [agencyId, list] of byAgency) {
        const agency = await fetchName(agencyId).catch(() => null);
        const blank = emptyTxn('TAXPMT', date);
        const t: Txn = {
          ...blank,
          // the end of the period this pays (the server uses it for "tax due through" later dates)
          extra: { ...(blank.extra ?? {}), salesTaxThrough: through },
          accountId,
          nameId: agencyId,
          refNumber: toPrint ? '' : num,
          toBePrinted: toPrint,
          billAddress: agency ? vendorAddressText(agency) : '',
          memo: `Sales tax through ${fmtDate(through)}`,
          lines: list.map((r, i) =>
            isTaxAdjustment(r.due)
              ? // adjustments: straight to Sales Tax Payable (the payment's name is the agency)
                { ...emptyLine('item', i + 1), itemId: null, accountId: stpAccountId, description: `Sales tax adjustment - ${r.due.agencyName}`, amount: r.amount }
              : { ...emptyLine('item', i + 1), itemId: r.due.taxItemId, description: r.due.taxItemName, amount: r.amount },
          ),
          amount: sum2(list.map((r) => r.amount)),
        };
        const saved = await api.post<Txn>('/txns', t);
        created.push(saved);
        if (!toPrint && num) num = incRef(num);
      }
      await invalidateAll();
      setState(new Map());
      setCheckTouched(false);
      toast(`${created.length} sales tax payment${created.length === 1 ? '' : 's'} saved (${fmtMoney(sum2(created.map((c) => c.amount)))})`, {
        action: created.length === 1 ? { label: 'Open', onClick: () => openTxn('TAXPMT', created[0].id) } : undefined,
      });
      const r = await showDialog<'done' | 'print'>({
        title: 'Sales Tax Paid',
        width: 480,
        cancelValue: 'done',
        render: (close) => (
          <div className="vx-dlg">
            <div className="vx-note vx-ok">The sales tax payments were recorded and Sales Tax Payable is lower by {fmtMoney(sum2(created.map((c) => c.amount)))}.</div>
            <table className="vx-ctable vx-summary">
              <thead>
                <tr>
                  <th>CHECK NO.</th>
                  <th>TAX AGENCY</th>
                  <th style={{ textAlign: 'right' }}>AMOUNT</th>
                </tr>
              </thead>
              <tbody>
                {created.map((c) => (
                  <tr key={c.id} onClick={() => openTxn('TAXPMT', c.id)} title="Open this payment">
                    <td>{c.toBePrinted ? 'To print' : c.refNumber}</td>
                    <td>{c.nameFull}</td>
                    <td className="vx-num">{fmtMoney(c.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="sx-dlg-buttons">
              <Button variant="primary" label="Done" onClick={() => close('done')} />
              {toPrint && <Button label="Print checks" onClick={() => close('print')} />}
            </div>
          </div>
        ),
      });
      if (r === 'print') openWindow('printChecks', { accountId });
      await win.close(true);
    } catch (e) {
      fe.fromError(e);
      if (created.length) {
        void invalidateAll();
        fe.setErrors({}, `${(e as Error).message} (${created.length} payment${created.length === 1 ? ' was' : 's were'} already saved.)`);
      }
    } finally {
      setBusy(false);
    }
  };

  useHotkeys({ 'alt+p': () => void pay() });

  const columns: GridColumn<TaxRow>[] = [
    { key: 'pay', label: 'PAY', width: 44, editor: 'checkbox', title: 'Pay this tax item' },
    {
      key: 'item',
      label: 'ITEM',
      width: 180,
      grow: true,
      render: (r) =>
        isTaxAdjustment(r.due) ? (
          <span className="vx-taxadj" title="A change to Sales Tax Payable without a tax item (for example a journal entry for a discount, credit or penalty).">
            {taxDueLabel(r.due)}
          </span>
        ) : (
          r.due.taxItemName
        ),
    },
    { key: 'agency', label: 'VENDOR', width: 220, render: (r) => r.due.agencyName || <span className="vx-danger-text">No agency set</span> },
    { key: 'due', label: 'AMT. DUE', width: 110, align: 'right', render: (r) => fmtMoney(r.due.amountDue) },
    { key: 'amount', label: 'AMT. PAID', width: 120, align: 'right', editor: 'money', blankZero: true },
  ];

  if (!prefs.salesTaxEnabled) {
    return (
      <div className="vx-salestax">
        <EmptyState icon={Percent} title="Sales tax is turned off" message="Turn on sales tax in Preferences to collect and pay sales tax." action={{ label: 'Open preferences', onClick: () => openWindow('preferences', { section: 'salesTax' }) }} />
      </div>
    );
  }

  return (
    <FormErrorsProvider value={fe}>
      <div className="vx-paytax" ref={rootRef}>
        <div className="vx-paytax-head">
          <Field label="Pay from account" htmlFor="vx-pt-acct" width={230} hint={acct ? `Ending balance ${fmtMoney(acct.balance)}` : undefined}>
            <AccountPicker id="vx-pt-acct" name="accountId" types={['Bank']} value={accountId} addNew={false} onChange={(id) => { setAccountId(id); setCheckTouched(false); }} />
          </Field>
          <Field label="Check date" htmlFor="vx-pt-date" width={140}>
            <DateField id="vx-pt-date" name="date" value={date} onChange={setDate} />
          </Field>
          <Field label="Show tax due through" htmlFor="vx-pt-thru" width={170} help="Tax collected on sales up to this date (usually the end of your last tax period).">
            <DateField id="vx-pt-thru" name="through" value={through} onChange={setThrough} />
          </Field>
          <Field label="Starting check no." htmlFor="vx-pt-no" width={130}>
            <TextField
              id="vx-pt-no"
              name="refNumber"
              value={toPrint ? 'To print' : checkNo}
              disabled={toPrint}
              onChange={(v) => {
                setCheckNo(v);
                setCheckTouched(true);
              }}
            />
          </Field>
        </div>
        {(fe.message || Object.keys(fe.errors).length > 0) && <ErrorBanner errors={fe.errors} message={fe.message} onDismiss={() => fe.clearAll()} />}
        <div className="vx-pb-grid">
          {due.isLoading ? (
            <Spinner center />
          ) : rows.length === 0 ? (
            <EmptyState icon={Percent} title="No sales tax due" message={`No sales tax is owed for sales through ${fmtDate(through)}.`} />
          ) : (
            <Grid<TaxRow>
              aria-label="Sales tax due"
              columns={columns}
              rows={rows}
              onChange={onRowsChange}
              newRow={() => rows[0]}
              onRowChange={onRowChange}
              allowAdd={false}
              allowInsertDelete={false}
              minRows={5}
              persistKey="paytax"
              apiRef={gridApi}
              rowClassName={(r) => (r.pay ? 'vx-row-sel' : undefined)}
            />
          )}
        </div>
        <div className="vx-pb-totals">
          <Button small variant="ghost" icon={CheckSquare} label="Pay all tax" disabled={!rows.length} onClick={payAll} />
          <Button small variant="ghost" icon={Square} label="Clear selections" disabled={!chosen.length} onClick={() => setState(new Map())} />
          <span className="vx-spacer" />
          <span className="vx-paytax-tot">
            <span>Totals</span>
            <span className="vx-num">{fmtMoney(totalDue)}</span>
            <span className="vx-num vx-strong">{fmtMoney(totalPaid)}</span>
          </span>
        </div>
        <div className="vx-pb-actions">
          <Checkbox label="To be printed" checked={toPrint} onChange={setToPrint} />
          <span className="vx-muted vx-ml">
            {chosen.length ? `${new Set(chosen.map((r) => r.due.agencyId)).size} payment(s) of ${fmtMoney(totalPaid)} will be recorded.` : 'Check the tax you want to pay.'}
          </span>
          <span className="vx-spacer" />
          <Button label="Cancel" onClick={() => void win.close()} />
          <Button variant="primary" label="&Pay sales tax" busy={busy} disabled={!chosen.length} onClick={() => void pay()} />
        </div>
      </div>
    </FormErrorsProvider>
  );
}
