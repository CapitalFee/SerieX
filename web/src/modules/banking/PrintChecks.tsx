// Select Checks to Print (and Select Invoices to Print when props.kind === 'invoices'):
// bank account, first check number, the list of transactions marked "to be printed" (all
// selected), Print (voucher checks: the check and two stubs), then "Did the checks print
// correctly?" assigns the check numbers (POST /mark-printed).
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { api, qs, type ApiError } from '@/api/client';
import { invalidateAll, queryClient, useAccounts, useCompanyInfo, useItemsById, usePrefValues } from '@/api/hooks';
import type { ID, Txn, TxnSummary } from '@/api/types';
import { AccountPicker, Button, EmptyState, Field, TextField, msgBox, toast } from '@/components';
import { fmtDate, fmtMoney, fmtQty, round2 } from '@/util/format';
import { escHtml, printHtml } from '@/util/print';
import { openTxn, openWindow } from '@/windows/windowStore';
import { useWindow } from '@/windows/WindowContext';
import { CheckTable, type CheckColumn } from './CheckTable';
import { confirmCheckNumbers, confirmPrinted, printCheckVouchers } from './checkPrint';
import { nextCheckNumber } from './shared';
import './banking.css';

export interface PrintChecksProps {
  accountId?: number;
  kind?: 'checks' | 'invoices';
}

export default function PrintChecks(props: PrintChecksProps) {
  const kind = props.kind ?? 'checks';
  return kind === 'invoices' ? <PrintInvoices /> : <SelectChecks accountId={props.accountId} />;
}

// ---------------------------------------------------------------------------
// Checks

function SelectChecks({ accountId: initial }: { accountId?: number }) {
  const win = useWindow();
  const prefs = usePrefValues();
  const { data: accounts } = useAccounts({ active: 'all' });
  const [accountId, setAccountId] = useState<ID | null>(initial ?? null);
  const [first, setFirst] = useState('');
  const [checked, setChecked] = useState<Set<ID>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    win.setTitle('Select Checks to Print');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (accountId || !accounts) return;
    const ok = (id: ID | null | undefined) => !!id && accounts.some((a) => a.id === id && a.type === 'Bank');
    setAccountId(ok(prefs.defaultCheckAccountId) ? prefs.defaultCheckAccountId : accounts.find((a) => a.active && a.type === 'Bank')?.id ?? null);
  }, [accounts, accountId, prefs.defaultCheckAccountId]);

  const { data: rows, isLoading } = useQuery({
    queryKey: ['to-print', 'checks', accountId ?? 0],
    queryFn: () => api.get<TxnSummary[]>('/to-print' + qs({ kind: 'checks', accountId })),
    enabled: !!accountId,
    staleTime: 0,
  });
  // every check is selected when the list changes; the first number follows the account
  useEffect(() => {
    setChecked(new Set((rows ?? []).map((r) => r.id)));
  }, [rows]);
  useEffect(() => {
    let live = true;
    void nextCheckNumber(accountId).then((n) => live && setFirst(n || '1'));
    return () => {
      live = false;
    };
  }, [accountId, rows]);

  const account = accounts?.find((a) => a.id === accountId);
  const sel = (rows ?? []).filter((r) => checked.has(r.id));
  const total = round2(sel.reduce((s, r) => s + r.amount, 0));
  const columns: CheckColumn<TxnSummary>[] = [
    { key: 'date', label: 'Date', width: 96, type: 'date' },
    { key: 'typeLabel', label: 'Type', width: 120 },
    { key: 'nameFull', label: 'Payee', width: 200, grow: true },
    { key: 'amount', label: 'Amount', width: 110, type: 'money' },
  ];

  const print = async () => {
    if (!sel.length) return;
    if (!first.trim()) {
      await msgBox({ title: 'Print Checks', message: 'Enter the number printed on the first check in the printer.', icon: 'warning' });
      return;
    }
    setBusy(true);
    try {
      // before paper is used: the numbers these checks will get must not be taken already
      const start = accountId ? await confirmCheckNumbers(accountId, account?.fullName ?? 'this account', first, sel.length) : first;
      if (start === null) {
        document.getElementById('bk-pc-first')?.focus();
        return;
      }
      if (start !== first) setFirst(start);
      const txns = await Promise.all(sel.map((r) => api.get<Txn>(`/txns/${r.id}`)));
      await printCheckVouchers(txns, start);
      if (await confirmPrinted(sel.map((r) => r.id), start)) {
        toast(`${sel.length} check${sel.length === 1 ? '' : 's'} printed and numbered from ${start}`, { kind: 'success' });
        await queryClient.invalidateQueries({ queryKey: ['to-print'] });
      }
    } catch (e) {
      if ((e as ApiError).code !== 'cancelled') await msgBox({ title: 'Print Checks', message: (e as Error).message, icon: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bk-pc">
      <div className="bk-pc-top">
        <Field label="Bank account" htmlFor="bk-pc-acct" width={260}>
          <AccountPicker id="bk-pc-acct" name="accountId" types={['Bank']} value={accountId} onChange={(id) => setAccountId(id)} addNew={false} />
        </Field>
        <Field label="First check number" htmlFor="bk-pc-first" width={150} help="The number printed on the first blank check in your printer. The next checks are numbered in order.">
          <TextField id="bk-pc-first" name="firstNumber" value={first} onChange={setFirst} />
        </Field>
        {account && <span className="bk-muted bk-pc-bal">Ending balance ${fmtMoney(account.balance)}</span>}
      </div>
      <div className="bk-pc-list">
        {!isLoading && !(rows ?? []).length ? (
          <EmptyState
            compact
            icon={Printer}
            title="No checks to print"
            message={`Checks, bill payments and sales tax payments marked "Print later" for ${account?.fullName ?? 'this account'} appear here.`}
            action={{ label: 'Write a check', onClick: () => openWindow('writeCheck', { accountId: accountId ?? undefined }) }}
          />
        ) : (
          <CheckTable<TxnSummary>
            rows={rows ?? []}
            getKey={(r) => r.id}
            columns={columns}
            checked={checked}
            onToggle={(id) =>
              setChecked((c) => {
                const n = new Set(c);
                if (n.has(id)) n.delete(id);
                else n.add(id);
                return n;
              })
            }
            onToggleAll={(on) => setChecked(on ? new Set((rows ?? []).map((r) => r.id)) : new Set())}
            contextMenu={(r) => [{ label: '&Open', onClick: () => openTxn(r.type, r.id) }]}
            aria-label="Checks to print"
            autoFocus
          />
        )}
      </div>
      <div className="bk-pc-foot">
        <span className="bk-muted">
          {sel.length} of {(rows ?? []).length} selected · ${fmtMoney(total)}
        </span>
        <span className="bk-grow" />
        <Button label="Cancel" onClick={() => void win.close()} />
        <Button variant="primary" icon={Printer} label="Print" busy={busy} disabled={!sel.length} onClick={() => void print()} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invoices (File > Print Forms > Invoices)

function PrintInvoices() {
  const win = useWindow();
  const items = useItemsById();
  const { data: company } = useCompanyInfo();
  const { data: rows, isLoading } = useQuery({ queryKey: ['to-print', 'invoices'], queryFn: () => api.get<TxnSummary[]>('/to-print?kind=invoices'), staleTime: 0 });
  const [checked, setChecked] = useState<Set<ID>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    win.setTitle('Select Invoices to Print');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => setChecked(new Set((rows ?? []).map((r) => r.id))), [rows]);
  const sel = (rows ?? []).filter((r) => checked.has(r.id));
  const columns = useMemo<CheckColumn<TxnSummary>[]>(
    () => [
      { key: 'date', label: 'Date', width: 96, type: 'date' },
      { key: 'refNumber', label: 'No.', width: 80 },
      { key: 'nameFull', label: 'Customer', width: 220, grow: true },
      { key: 'amount', label: 'Amount', width: 110, type: 'money' },
    ],
    [],
  );

  const invoiceHtml = (t: Txn) => {
    // every value from the company file is escaped: the print frame has the app's origin
    const coAddr = [company?.address1, company?.address2, [company?.city, [company?.state, company?.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')]
      .filter(Boolean)
      .map((s) => escHtml(String(s)))
      .join('<br>');
    const lines = t.lines
      .map((l) => {
        const it = l.itemId ? items.get(l.itemId) : undefined;
        if (it?.type === 'Subtotal') return `<tr class="bold"><td></td><td>${escHtml(l.description || 'Subtotal')}</td><td></td><td></td><td class="num">${fmtMoney(l.amount)}</td></tr>`;
        return `<tr><td>${escHtml(it?.fullName ?? '')}</td><td>${escHtml(l.description)}</td><td class="num">${l.qty === null ? '' : fmtQty(l.qty)}</td><td class="num">${l.rate === null ? '' : l.rateIsPercent ? l.rate + '%' : fmtMoney(l.rate)}</td><td class="num">${fmtMoney(l.amount)}</td></tr>`;
      })
      .join('');
    const paid = round2(t.amount - t.openBalance);
    return `<div class="inv">
      <div class="hd"><div><h2>${escHtml(company?.name ?? '')}</h2><div class="muted">${coAddr}</div></div>
        <div class="right"><h1>Invoice</h1><table class="meta"><tr><td>Date</td><td>${fmtDate(t.date)}</td></tr><tr><td>Invoice #</td><td>${escHtml(t.refNumber)}</td></tr>${t.dueDate ? `<tr><td>Due date</td><td>${fmtDate(t.dueDate)}</td></tr>` : ''}${t.poNumber ? `<tr><td>P.O. No.</td><td>${escHtml(t.poNumber)}</td></tr>` : ''}</table></div></div>
      <div class="addr"><div><b>Bill To</b><br>${escHtml(t.billAddress || t.nameFull).replace(/\n/g, '<br>')}</div>${t.shipAddress ? `<div><b>Ship To</b><br>${escHtml(t.shipAddress).replace(/\n/g, '<br>')}</div>` : ''}</div>
      <table class="lines"><thead><tr><th>Item</th><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead><tbody>${lines}</tbody></table>
      <table class="tot"><tr><td>Subtotal</td><td class="num">${fmtMoney(t.subtotal)}</td></tr>${t.taxAmount ? `<tr><td>Sales tax (${t.taxRate}%)</td><td class="num">${fmtMoney(t.taxAmount)}</td></tr>` : ''}<tr class="bold"><td>Total</td><td class="num">$${fmtMoney(t.amount)}</td></tr>${paid ? `<tr><td>Payments/credits</td><td class="num">-${fmtMoney(paid)}</td></tr>` : ''}<tr class="bold"><td>Balance due</td><td class="num">$${fmtMoney(t.openBalance)}</td></tr></table>
      ${t.memo ? `<p class="muted">${escHtml(t.memo)}</p>` : ''}
    </div>`;
  };

  const print = async () => {
    if (!sel.length) return;
    setBusy(true);
    try {
      const txns = await Promise.all(sel.map((r) => api.get<Txn>(`/txns/${r.id}`)));
      await printHtml(
        'Invoices',
        txns.map(invoiceHtml).join('<div class="page-break"></div>'),
        `.hd{display:flex;justify-content:space-between;margin-bottom:18px} .meta td{padding:1px 6px} .addr{display:flex;gap:60px;margin-bottom:16px;line-height:1.4} .lines th,.lines td{border-bottom:1px solid #ccc} .tot{width:260px;margin:12px 0 0 auto} .inv{min-height:9.5in}`,
      );
      const r = await msgBox({ title: 'Print Invoices - Confirmation', message: `Did ${sel.length === 1 ? 'the invoice' : `all ${sel.length} invoices`} print correctly?\n\nYes removes them from the list of invoices to print.`, buttons: ['Yes', 'No'], icon: 'question' });
      if (r === 'Yes') {
        await api.post('/mark-printed', { txnIds: sel.map((x) => x.id), firstNumber: '' });
        void invalidateAll();
        toast(`${sel.length} invoice${sel.length === 1 ? '' : 's'} marked as printed`, { kind: 'success' });
      }
    } catch (e) {
      if ((e as ApiError).code !== 'cancelled') await msgBox({ title: 'Print Invoices', message: (e as Error).message, icon: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bk-pc">
      <p className="bk-pc-intro">Invoices marked "Print later" are listed here. Choose the ones to print.</p>
      <div className="bk-pc-list">
        {!isLoading && !(rows ?? []).length ? (
          <EmptyState compact icon={Printer} title="No invoices to print" message='Invoices saved with "Print later" turned on appear here.' action={{ label: 'Create invoice', onClick: () => openWindow('invoice') }} />
        ) : (
          <CheckTable<TxnSummary>
            rows={rows ?? []}
            getKey={(r) => r.id}
            columns={columns}
            checked={checked}
            onToggle={(id) =>
              setChecked((c) => {
                const n = new Set(c);
                if (n.has(id)) n.delete(id);
                else n.add(id);
                return n;
              })
            }
            onToggleAll={(on) => setChecked(on ? new Set((rows ?? []).map((r) => r.id)) : new Set())}
            contextMenu={(r) => [{ label: '&Open', onClick: () => openTxn(r.type, r.id) }]}
            aria-label="Invoices to print"
            autoFocus
          />
        )}
      </div>
      <div className="bk-pc-foot">
        <span className="bk-muted">
          {sel.length} of {(rows ?? []).length} selected · ${fmtMoney(sel.reduce((s, r) => s + r.amount, 0))}
        </span>
        <span className="bk-grow" />
        <Button label="Cancel" onClick={() => void win.close()} />
        <Button variant="primary" icon={Printer} label="Print" busy={busy} disabled={!sel.length} onClick={() => void print()} />
      </div>
    </div>
  );
}
