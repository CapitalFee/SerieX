// Print Paychecks (File > Print > Paychecks, Pay Employees "Print Paychecks"):
// bank account, first check number (the next SerieX Books check number), the paychecks marked
// to be printed (all selected), a company message for the stubs; Preview / Print print voucher
// checks (the check on top, two stubs), then "Did the paychecks print correctly?" assigns the
// numbers (POST /paychecks/mark-printed, which also updates the SerieX Books checks).
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Eye, Printer } from 'lucide-react';
import { api, qs } from '@/api/client';
import { queryClient, useBooksAccounts, usePrefValues, usePrefs } from '@/api/hooks';
import type { Id, PaycheckSummary } from '@/api/types';
import { AccountPicker, Button, EmptyState, Field, TextArea, TextField, msgBox } from '@/components';
import { fmtDate, fmtMoney } from '@/util/format';
import { printHtml } from '@/util/print';
import { useWindow } from '@/windows/WindowContext';
import { openRecord, openWindow } from '@/windows/windowStore';
import { CheckList, type CheckColumn } from './CheckList';
import { STUB_CSS, confirmPaychecksPrinted, previewHtml, voucherHtml } from './printing';
import { nextCheckNumber, showError, sum2 } from './shared';
import './payroll.css';

export interface PrintPaychecksProps {
  /** Paychecks to preselect. */
  ids?: number[];
  /** Bank account to print from. */
  bankAccountId?: number;
}

const MSG_KEY = 'sxp.payStubMessage';

function loadMessage(): string {
  try {
    return localStorage.getItem(MSG_KEY) ?? '';
  } catch {
    return '';
  }
}
function saveMessage(m: string) {
  try {
    localStorage.setItem(MSG_KEY, m);
  } catch {
    /* ignore */
  }
}

export default function PrintPaychecks(props: PrintPaychecksProps) {
  const win = useWindow();
  const { data: banks } = useBooksAccounts(['Bank']);
  const prefs = usePrefValues();
  const prefsLoaded = !!usePrefs().data;
  const [bankAccountId, setBankAccountId] = useState<Id | null>(props.bankAccountId ?? null);
  const [first, setFirst] = useState('');
  const [checked, setChecked] = useState<Set<Id>>(new Set());
  const [message, setMessage] = useState(loadMessage);
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);

  useEffect(() => {
    win.setTitle('Print Paychecks');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (props.bankAccountId) setBankAccountId(props.bankAccountId);
  }, [props.bankAccountId]);
  // default bank account: the payroll default, else the first bank account
  useEffect(() => {
    if (bankAccountId || !banks || !prefsLoaded) return;
    setBankAccountId(prefs.defaultBankAccountId ?? banks.find((b) => b.active)?.id ?? null);
  }, [banks, bankAccountId, prefs.defaultBankAccountId, prefsLoaded]);

  const { data, isLoading } = useQuery({
    queryKey: ['paychecks', 'to-print', bankAccountId ?? 0],
    queryFn: () => api.get<PaycheckSummary[]>('/paychecks/to-print' + qs({ bankAccountId })),
    enabled: !!bankAccountId,
    staleTime: 0,
  });
  const rows = useMemo(() => data ?? [], [data]);
  // every paycheck (or the ones asked for) is selected when the list changes
  const idsKey = (props.ids ?? []).join(',');
  useEffect(() => {
    const want = props.ids?.length ? new Set(props.ids) : null;
    setChecked(new Set(rows.filter((r) => !want || want.has(r.id)).map((r) => r.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, idsKey]);
  useEffect(() => {
    let live = true;
    void nextCheckNumber(bankAccountId).then((n) => live && setFirst(n || '1'));
    return () => {
      live = false;
    };
  }, [bankAccountId, round]);

  const sel = rows.filter((r) => checked.has(r.id));
  const total = sum2(sel.map((r) => r.net));
  const bank = banks?.find((b) => b.id === bankAccountId);
  const columns: CheckColumn<PaycheckSummary>[] = [
    { key: 'checkDate', label: 'Date', width: 100, type: 'date' },
    { key: 'employeeName', label: 'Employee', width: 220, grow: true },
    { key: 'period', label: 'Pay Period', width: 190, render: (r) => `${fmtDate(r.periodStart)} – ${fmtDate(r.periodEnd)}` },
    { key: 'net', label: 'Amount', width: 110, type: 'money' },
  ];

  const check = async (): Promise<boolean> => {
    if (!sel.length) return false;
    if (!/\d$/.test(first.trim())) {
      await msgBox({ title: 'Print Paychecks', message: 'Enter the number printed on the first check in the printer (it must end with a number).', icon: 'warning' });
      return false;
    }
    saveMessage(message);
    return true;
  };
  const print = async () => {
    if (!(await check())) return;
    setBusy(true);
    try {
      const ids = sel.map((r) => r.id);
      const { html } = await voucherHtml(ids, first, message);
      await printHtml(ids.length === 1 ? 'Paycheck' : 'Paychecks', html, STUB_CSS);
      if (await confirmPaychecksPrinted(ids, first.trim())) {
        await queryClient.invalidateQueries({ queryKey: ['paychecks'] });
        setRound((n) => n + 1);
      }
    } catch (e) {
      await showError(e, 'Print Paychecks');
    } finally {
      setBusy(false);
    }
  };
  const preview = async () => {
    if (!(await check())) return;
    try {
      const { html } = await voucherHtml(
        sel.map((r) => r.id),
        first,
        message,
      );
      await previewHtml('Print Preview - Paychecks', html, () => void print());
    } catch (e) {
      await showError(e, 'Print Paychecks');
    }
  };

  return (
    <div className="py-page py-print">
      <div className="py-print-top">
        <Field label="Bank account" htmlFor="py-pp-bank" width={250}>
          <AccountPicker id="py-pp-bank" name="bankAccountId" types={['Bank']} addNew={false} value={bankAccountId} onChange={(id) => setBankAccountId(id)} />
        </Field>
        <Field label="First check number" htmlFor="py-pp-first" width={150} help="The number printed on the first blank check in your printer. The next paychecks are numbered in order.">
          <TextField id="py-pp-first" name="firstNumber" value={first} onChange={setFirst} />
        </Field>
        {bank && <span className="py-muted py-print-bal">Ending balance {fmtMoney(bank.balance, { dollarSign: true })}</span>}
      </div>
      <p className="py-print-intro">
        Tick the paychecks you want, then click Print. {rows.length} paycheck{rows.length === 1 ? ' is' : 's are'} waiting to be printed (${fmtMoney(sum2(rows.map((r) => r.net)))} in all).
      </p>
      <div className="py-gridwrap">
        {!isLoading && !rows.length ? (
          <EmptyState
            compact
            icon={Printer}
            title="No paychecks to print"
            message={`Paychecks created with "Print paychecks on check stock" for ${bank?.fullName ?? 'this account'} appear here until they are printed. Direct deposit paychecks are never printed.`}
            action={{ label: 'Pay employees', onClick: () => openWindow('payEmployees', { kind: 'unscheduled' }) }}
          />
        ) : (
          <CheckList<PaycheckSummary>
            aria-label="Paychecks to print"
            rows={rows}
            getKey={(r) => r.id}
            columns={columns}
            checked={checked}
            autoFocus
            onToggle={(id) =>
              setChecked((c) => {
                const n = new Set(c);
                if (n.has(id)) n.delete(id);
                else n.add(id);
                return n;
              })
            }
            onToggleAll={(on) => setChecked(on ? new Set(rows.map((r) => r.id)) : new Set())}
            onActivate={(r) => openRecord('paycheck', r.id)}
            contextMenu={(r) => [{ label: '&Open Paycheck', onClick: () => openRecord('paycheck', r.id) }]}
          />
        )}
      </div>
      <div className="py-print-msg">
        <Field label="Company message to be printed on all pay stubs" htmlFor="py-pp-msg">
          <TextArea id="py-pp-msg" value={message} onChange={setMessage} height={44} maxLength={300} />
        </Field>
      </div>
      <div className="py-foot">
        <Button small variant="ghost" label="Select &All" disabled={!rows.length} onClick={() => setChecked(new Set(rows.map((r) => r.id)))} />
        <Button small variant="ghost" label="Select &None" disabled={!checked.size} onClick={() => setChecked(new Set())} />
        <span className="py-muted">
          {sel.length} of {rows.length} selected · ${fmtMoney(total)}
        </span>
        <span className="py-grow" />
        <Button label="Cancel" onClick={() => void win.close()} />
        <Button icon={Eye} label="Pre&view" disabled={!sel.length} onClick={() => void preview()} />
        <Button variant="primary" icon={Printer} label="&Print" busy={busy} disabled={!sel.length} onClick={() => void print()} />
      </div>
    </div>
  );
}
