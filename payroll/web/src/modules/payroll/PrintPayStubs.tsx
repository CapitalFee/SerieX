// Print Pay Stubs (File > Print > Pay Stubs, Pay Employees "Print Pay Stubs"): bank
// account, checks dated from/thru, employee; the paychecks of the range (all selected, or the
// ones asked for), a company message; Preview shows the stubs, Print prints one page per stub
// (GET /paystubs: earnings and hours, taxes, deductions, adjustments, net pay, YTD, PTO).
import { useEffect, useMemo, useState } from 'react';
import { Eye, FileText, Printer } from 'lucide-react';
import { usePaychecks } from '@/api/hooks';
import type { Id, PaycheckSummary } from '@/api/types';
import { AccountPicker, Button, DateField, EmployeePicker, EmptyState, Field, RadioGroup, TextArea } from '@/components';
import { fmtDate, fmtMoney } from '@/util/format';
import { startOfMonth, todayIso } from '@/util/dates';
import { useWindow } from '@/windows/WindowContext';
import { openRecord } from '@/windows/windowStore';
import { CheckList, type CheckColumn } from './CheckList';
import { fetchPayStubs, payStubPage, previewHtml, printPayStubs } from './printing';
import { checkNumberLabel, showError, sum2 } from './shared';
import './payroll.css';

export interface PrintPayStubsProps {
  /** Paychecks to preselect. */
  ids?: number[];
}

const MSG_KEY = 'sxp.payStubMessage';

function loadMessage(): string {
  try {
    return localStorage.getItem(MSG_KEY) ?? '';
  } catch {
    return '';
  }
}

export default function PrintPayStubs(props: PrintPayStubsProps) {
  const win = useWindow();
  const today = todayIso();
  const [bankAccountId, setBankAccountId] = useState<Id | null>(null);
  const [from, setFrom] = useState(startOfMonth(today));
  const [to, setTo] = useState(today);
  const [employeeId, setEmployeeId] = useState<Id | null>(null);
  /** Show: Both, Paychecks (printed checks) or Direct Deposit. */
  const [show, setShow] = useState<'both' | 'checks' | 'dd'>('both');
  const [checked, setChecked] = useState<Set<Id>>(new Set());
  const [message, setMessage] = useState(loadMessage);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    win.setTitle('Print Pay Stubs');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // paychecks asked for: widen the date range to include them
  const idsKey = (props.ids ?? []).join(',');
  const { data: wanted } = usePaychecks({ includeVoided: false }, { enabled: !!props.ids?.length });
  useEffect(() => {
    if (!props.ids?.length || !wanted) return;
    const mine = wanted.filter((p) => props.ids!.includes(p.id));
    if (!mine.length) return;
    const dates = mine.map((p) => p.checkDate).sort();
    setFrom((f) => (dates[0] < f ? dates[0] : f));
    setTo((t) => (dates[dates.length - 1] > t ? dates[dates.length - 1] : t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, wanted]);

  const { data, isLoading } = usePaychecks({ from, to, employeeId, kind: 'regular' });
  const rows = useMemo(
    () =>
      (data ?? [])
        .filter((p) => !p.voided && (!bankAccountId || p.bankAccountId === bankAccountId) && (show === 'both' || (show === 'dd') === p.directDeposit))
        .slice()
        .sort((a, b) => a.checkDate.localeCompare(b.checkDate) || a.employeeName.localeCompare(b.employeeName)),
    [data, bankAccountId, show],
  );
  const rowsKey = rows.map((r) => r.id).join(',');
  useEffect(() => {
    const want = props.ids?.length ? new Set(props.ids) : null;
    setChecked(new Set(rows.filter((r) => !want || want.has(r.id)).map((r) => r.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsKey, idsKey]);

  const sel = rows.filter((r) => checked.has(r.id));
  const columns: CheckColumn<PaycheckSummary>[] = [
    { key: 'checkDate', label: 'Date', width: 100, type: 'date' },
    { key: 'checkNumber', label: 'Num', width: 80, render: (r) => checkNumberLabel(r) },
    { key: 'employeeName', label: 'Employee', width: 220, grow: true },
    { key: 'net', label: 'Amount', width: 110, type: 'money' },
  ];

  const remember = () => {
    try {
      localStorage.setItem(MSG_KEY, message);
    } catch {
      /* ignore */
    }
  };
  const print = async () => {
    if (!sel.length) return;
    remember();
    setBusy(true);
    try {
      await printPayStubs(
        sel.map((r) => r.id),
        message,
      );
    } catch (e) {
      await showError(e, 'Print Pay Stubs');
    } finally {
      setBusy(false);
    }
  };
  const preview = async () => {
    if (!sel.length) return;
    remember();
    try {
      const stubs = await fetchPayStubs(sel.map((r) => r.id));
      await previewHtml('Print Preview - Pay Stubs', stubs.map((s) => payStubPage(s, message)).join(''), () => void print());
    } catch (e) {
      await showError(e, 'Print Pay Stubs');
    }
  };

  return (
    <div className="py-page py-print">
      <div className="py-print-top">
        <Field label="Bank account" htmlFor="py-ps-bank" width={230}>
          <AccountPicker id="py-ps-bank" types={['Bank']} addNew={false} value={bankAccountId} onChange={(id) => setBankAccountId(id)} placeholder="All bank accounts" />
        </Field>
        <Field label="Checks dated" htmlFor="py-ps-from" width={140}>
          <DateField id="py-ps-from" value={from} onChange={(d) => d && setFrom(d)} />
        </Field>
        <Field label="thru" htmlFor="py-ps-to" width={140}>
          <DateField id="py-ps-to" value={to} onChange={(d) => d && setTo(d)} />
        </Field>
        <Field label="Employee" htmlFor="py-ps-emp" width={210}>
          <EmployeePicker id="py-ps-emp" value={employeeId} onChange={(id) => setEmployeeId(id)} placeholder="All Employees" />
        </Field>
      </div>
      <div className="py-print-show">
        <span className="sx-label">SHOW</span>
        <RadioGroup
          row
          aria-label="Show"
          value={show}
          onChange={(v) => setShow(v as typeof show)}
          options={[
            { value: 'both', label: 'Both' },
            { value: 'checks', label: 'Paychecks' },
            { value: 'dd', label: 'Direct Deposit' },
          ]}
        />
      </div>
      <p className="py-print-intro">
        Tick the pay stubs you want, then click Print. {rows.length} pay stub{rows.length === 1 ? '' : 's'} listed (${fmtMoney(sum2(rows.map((r) => r.net)))} net pay in all).
      </p>
      <div className="py-gridwrap">
        {!isLoading && !rows.length ? (
          <EmptyState compact icon={FileText} title="No paychecks" message={`There are no paychecks dated ${fmtDate(from)} – ${fmtDate(to)}${employeeId ? ' for this employee' : ''}.`} />
        ) : (
          <CheckList<PaycheckSummary>
            aria-label="Pay stubs"
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
        <Field label="Company message to be printed on all pay stubs" htmlFor="py-ps-msg">
          <TextArea id="py-ps-msg" value={message} onChange={setMessage} height={44} maxLength={300} />
        </Field>
      </div>
      <div className="py-foot">
        <Button small variant="ghost" label="Select &All" disabled={!rows.length} onClick={() => setChecked(new Set(rows.map((r) => r.id)))} />
        <Button small variant="ghost" label="Select &None" disabled={!checked.size} onClick={() => setChecked(new Set())} />
        <span className="py-muted">
          {sel.length} of {rows.length} selected · ${fmtMoney(sum2(sel.map((r) => r.net)))}
        </span>
        <span className="py-grow" />
        <Button label="Close" onClick={() => void win.close()} />
        <Button icon={Eye} label="Pre&view" disabled={!sel.length} onClick={() => void preview()} />
        <Button variant="primary" icon={Printer} label="&Print" busy={busy} disabled={!sel.length} onClick={() => void print()} />
      </div>
    </div>
  );
}
