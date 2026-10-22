// "Paycheck - <bank account>": a saved paycheck shown like the SerieX Books Write Checks form,
// titled "Paycheck". The check face (No., Date, Pay to the order of, amount, amount in words,
// address, memo), the PAYCHECK SUMMARY (earnings, additions, taxes, deductions, pay period,
// hours worked, Paycheck Details…) and the SerieX Books posting status with Retry.
// Toolbar: Save, Print, Delete ▾ (Void, Delete), Paycheck Details, Pay Stub; sticky bar: Revert,
// Print later, Save and close. The header (number, date, memo, bank account, print later) is
// saved with PUT /paychecks/{id} without lines (the amounts stay as they are).
import { useEffect, useMemo, useState } from 'react';
import { FileText, Landmark, ListChecks, RefreshCw } from 'lucide-react';
import { api } from '@/api/client';
import { useBooksAccounts, useEmployee, useItemsById, usePaycheck } from '@/api/hooks';
import type { Paycheck } from '@/api/types';
import { AccountPicker, Button, Checkbox, DateField, EmptyState, Spinner, StatusPill, TextField, msgBox, promptBox, toast } from '@/components';
import { CheckAccountBar, CheckFace, FormFrame } from '@/forms';
import { formatAddress } from '@/components/inputs';
import { fmtDate, fmtMoney, fmtQty } from '@/util/format';
import { useWindow } from '@/windows/WindowContext';
import { openWindow } from '@/windows/windowStore';
import { confirmPaychecksPrinted, previewHtml, printPayStubs, voucherHtml, fetchPayStubs, payStubPage, STUB_CSS } from './printing';
import { printHtml } from '@/util/print';
import {
  afterPaycheckSaved,
  checkNumberLabel,
  deletePaycheck,
  fmtHours,
  nextCheckNumber,
  rememberPaycheck,
  retryPosting,
  showError,
  showPostingProblems,
  sum2,
  syncInfo,
  voidPaycheck,
} from './shared';
import './payroll.css';

export interface PaycheckWindowProps {
  /** Saved paycheck. */
  id: number;
}

interface HeaderState {
  bankAccountId: number | null;
  checkNumber: string;
  toBePrinted: boolean;
  checkDate: string;
  memo: string;
}

const headerOf = (p: Paycheck): HeaderState => ({ bankAccountId: p.bankAccountId, checkNumber: p.checkNumber, toBePrinted: p.toBePrinted, checkDate: p.checkDate, memo: p.memo });

export default function PaycheckWindow(props: PaycheckWindowProps) {
  const win = useWindow();
  const { data: pc, isLoading, error, refetch } = usePaycheck(props.id);
  const { data: emp } = useEmployee(pc?.employeeId);
  const { data: banks } = useBooksAccounts(['Bank']);
  const items = useItemsById();
  const [h, setH] = useState<HeaderState | null>(null);
  /** The saved header the form started from (the user's changes are compared with it). */
  const [base, setBase] = useState<HeaderState | null>(null);
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // the form follows the saved paycheck (also when it changes elsewhere, e.g. printed and
  // numbered) until the user changes something
  const dirty = !!(h && base && JSON.stringify(h) !== JSON.stringify(base));
  const load = (p: Paycheck) => {
    setH(headerOf(p));
    setBase(headerOf(p));
  };
  useEffect(() => {
    if (pc && (!h || !dirty)) load(pc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pc?.updatedAt, pc?.id]);
  useEffect(() => {
    if (pc) rememberPaycheck(pc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pc?.id]);

  const bank = banks?.find((a) => a.id === (h?.bankAccountId ?? pc?.bankAccountId));
  useEffect(() => {
    const name = bank?.fullName || bank?.name || pc?.bankAccountName;
    win.setTitle(pc?.kind === 'ytd' ? 'Year-to-Date Amounts' : name ? `Paycheck - ${name}` : 'Paycheck');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bank?.fullName, pc?.bankAccountName, pc?.kind]);
  useEffect(() => {
    win.setDirty(dirty);
    win.setBeforeClose(
      dirty
        ? async () => {
            const r = await msgBox({
              title: 'Unsaved Changes',
              message: 'This paycheck has changes that are not saved. Save them before you leave?',
              buttons: ['&Save', "&Don't Save", 'Cancel'],
              icon: 'question',
            });
            if (r === 'Save') return save();
            return r === "Don't Save";
          }
        : null,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, h]);

  // the address SerieX Books prints on this check: print-as name, address lines, "City, ST ZIP"
  // (a line that repeats the one above it is left out, as on the posted check)
  const address = useMemo(() => {
    if (!emp) return pc?.employeeName ?? '';
    const lines = formatAddress(emp.printAs || emp.displayName, emp.address).split('\n');
    return lines.filter((l, i) => i === 0 || l.toLowerCase() !== lines[i - 1].toLowerCase()).join('\n');
  }, [emp, pc?.employeeName]);

  if (isLoading || (pc && !h)) return <Spinner center label="Loading paycheck…" />;
  if (error || !pc || !h) return <EmptyState title="Paycheck not found" message={error instanceof Error ? error.message : 'This paycheck no longer exists. It may have been deleted.'} />;

  const update = (patch: Partial<HeaderState>) => setH((cur) => (cur ? { ...cur, ...patch } : cur));

  async function save(): Promise<boolean> {
    if (!pc || !h) return false;
    if (!h.toBePrinted && !pc.directDeposit && !h.checkNumber.trim()) {
      await msgBox({ title: 'Paycheck', message: 'Enter the check number, or check "Print later" to print the paycheck.', icon: 'warning' });
      return false;
    }
    setSaving(true);
    try {
      const body = {
        id: pc.id,
        employeeId: pc.employeeId,
        kind: pc.kind,
        periodStart: pc.periodStart,
        periodEnd: pc.periodEnd,
        checkDate: h.checkDate,
        bankAccountId: h.bankAccountId,
        checkNumber: h.toBePrinted ? '' : h.checkNumber.trim(),
        toBePrinted: h.toBePrinted,
        directDeposit: pc.directDeposit,
        memo: h.memo,
        classId: pc.classId,
        noAccrual: pc.noAccrual,
        recalculate: false,
        // no lines: only the check header changes, the amounts stay as they are
      };
      const r = await api.put<Paycheck>(`/paychecks/${pc.id}`, body);
      afterPaycheckSaved(r);
      load(r);
      toast(`Paycheck to ${r.employeeName} saved`, { kind: 'success' });
      if (r.syncStatus === 'error')
        await showPostingProblems([{ entity: 'paycheck', id: r.id, label: `Paycheck - ${r.employeeName}`, code: 'error', message: r.syncError }], 'The paycheck is saved, but SerieX Books reported a problem:');
      return true;
    } catch (e) {
      await showError(e, 'Paycheck');
      return false;
    } finally {
      setSaving(false);
    }
  }

  const togglePrintLater = async (on: boolean) => {
    if (on) update({ toBePrinted: true });
    else update({ toBePrinted: false, checkNumber: !pc.toBePrinted && pc.checkNumber ? pc.checkNumber : await nextCheckNumber(h.bankAccountId) });
  };

  const print = async () => {
    if (dirty && !(await save())) return;
    const cur = (await refetch()).data ?? pc;
    try {
      if (cur.directDeposit) {
        await printPayStubs([cur.id]);
        return;
      }
      let number = cur.checkNumber;
      if (cur.toBePrinted) {
        const v = await promptBox('Printed check number:', { defaultValue: (await nextCheckNumber(cur.bankAccountId)) || '1', title: 'Print Paycheck' });
        if (v === null || !v.trim()) return;
        number = v.trim();
      }
      const { html } = await voucherHtml([cur.id], number);
      await printHtml('Paycheck', html, STUB_CSS);
      if (cur.toBePrinted) await confirmPaychecksPrinted([cur.id], number);
    } catch (e) {
      await showError(e, 'Print Paycheck');
    }
  };
  const preview = async () => {
    try {
      const stubs = await fetchPayStubs([pc.id]);
      await previewHtml('Pay Stub', stubs.map((s) => payStubPage(s)).join(''), () => void printPayStubs([pc.id]));
    } catch (e) {
      await showError(e, 'Pay Stub');
    }
  };
  const retry = async () => {
    setRetrying(true);
    try {
      const problems = await retryPosting([{ entity: 'paycheck', id: pc.id }]);
      await refetch();
      if (problems === null) return;
      if (problems.length) await showPostingProblems(problems, 'SerieX Books could not post the paycheck:');
      else toast('Paycheck posted to SerieX Books', { kind: 'success' });
    } catch (e) {
      await showError(e, 'SerieX Books');
    } finally {
      setRetrying(false);
    }
  };

  const lines = pc.lines;
  /** Rate of an earnings, addition or deduction line ("25.00", "-5%", "-50.00"); blank for taxes. */
  const lineRate = (l: Paycheck['lines'][number]): string => {
    if (l.rate === null || !(l.category === 'earning' || l.category === 'addition' || l.category === 'deduction')) return '';
    const it = items.get(l.itemId);
    const pct = it?.calc === 'percent' || it?.calc === 'match' || (it?.type === 'commission' && it.calc === 'quantity');
    const s = pct ? fmtQty(l.rate) + '%' : fmtMoney(l.rate);
    return l.category === 'deduction' && l.rate ? '-' + s : s;
  };
  const total = (cat: string) => sum2(lines.filter((l) => l.category === cat).map((l) => l.amount));
  const sync = syncInfo(pc);
  const ytd = pc.kind === 'ytd';
  const readOnly = pc.voided || ytd;
  const status = pc.voided ? 'Void' : ytd ? 'Year-to-date amounts' : pc.toBePrinted ? 'To print' : pc.directDeposit ? 'Direct deposit' : null;
  const numberText = checkNumberLabel({ ...pc, toBePrinted: h.toBePrinted });

  return (
    <FormFrame
      title={ytd ? 'Year-to-Date Amounts' : 'Paycheck'}
      status={status}
      stamp={pc.voided ? 'VOID' : null}
      readOnly={readOnly}
      dirty={dirty}
      busy={saving}
      saving={saving}
      onSave={readOnly ? undefined : () => void save()}
      onSaveClose={
        readOnly
          ? undefined
          : async () => {
              if (!dirty || (await save())) await win.close(true);
            }
      }
      onRevert={readOnly ? undefined : () => load(pc)}
      onPrint={ytd || pc.voided ? undefined : () => void print()}
      onVoid={ytd || pc.voided ? undefined : () => void voidPaycheck(pc).then((r) => r && refetch())}
      onDelete={() => void deletePaycheck(pc).then((ok) => ok && win.close(true))}
      extraButtons={[
        { key: 'detail', label: 'Paycheck Details', icon: ListChecks, onClick: () => openWindow('paycheckDetail', { id: pc.id }), hidden: readOnly, primary: false },
        { key: 'stub', label: 'Pay Stub', icon: FileText, onClick: () => void preview(), hidden: readOnly },
        { key: 'ytd', label: 'Year-to-Date Amounts', icon: FileText, onClick: () => openWindow('ytdSetup', { employeeId: pc.employeeId }), hidden: !ytd },
      ]}
      titleRight={
        ytd ? undefined : (
          <CheckAccountBar
            htmlFor={`${win.id}-bank`}
            bankAccount={
              readOnly ? (
                <span className="py-ro">{pc.bankAccountName}</span>
              ) : (
                <AccountPicker id={`${win.id}-bank`} name="bankAccountId" types={['Bank']} addNew={false} value={h.bankAccountId} onChange={(id) => update({ bankAccountId: id })} width={250} />
              )
            }
            endingBalance={bank ? bank.balance : null}
          />
        )
      }
      header={
        ytd ? (
          <div className="py-ytdnote">
            Year-to-date amounts of <b>{pc.employeeName}</b> for {fmtDate(pc.periodStart)} – {fmtDate(pc.periodEnd)}, entered with Enter Year-to-Date Amounts. They count in year-to-date totals, amounts owed and
            tax forms, and are never posted to SerieX Books.
          </div>
        ) : (
          <CheckFace
            number={
              readOnly || h.toBePrinted || pc.directDeposit ? (
                numberText
              ) : (
                <TextField id={`${win.id}-no`} name="checkNumber" aria-label="Check number" value={h.checkNumber} onChange={(v) => update({ checkNumber: v })} width={96} />
              )
            }
            date={readOnly ? fmtDate(pc.checkDate) : <DateField id={`${win.id}-date`} name="checkDate" aria-label="Check date" required value={h.checkDate} onChange={(d) => d && update({ checkDate: d })} width={130} />}
            payee={emp?.printAs || pc.employeeName}
            amount={pc.net}
            address={address}
            memo={readOnly ? pc.memo : <TextField id={`${win.id}-memo`} name="memo" aria-label="Memo" value={h.memo} onChange={(v) => update({ memo: v })} />}
          />
        )
      }
      lines={
        <section className="py-panel py-pcsum" aria-label="Paycheck summary">
          <div className="py-panel-head">
            Paycheck Summary
            <span className="py-grow" />
            {!readOnly && <Button small icon={ListChecks} label="Paycheck &Detail…" onClick={() => openWindow('paycheckDetail', { id: pc.id })} />}
          </div>
          <div className="py-pcsum-body">
            <dl className="py-pcsum-amounts">
              <dt>Earnings</dt>
              <dd>{fmtMoney(total('earning'))}</dd>
              <dt>Additions</dt>
              <dd>{fmtMoney(total('addition'))}</dd>
              <dt>Taxes</dt>
              <dd>{fmtMoney(-pc.employeeTaxes)}</dd>
              <dt>Deductions</dt>
              <dd>{fmtMoney(-pc.deductions)}</dd>
              <dt className="py-strong">Check amount</dt>
              <dd className="py-strong">{fmtMoney(pc.net)}</dd>
            </dl>
            <dl className="py-pcsum-info">
              <dt>Pay period</dt>
              <dd>
                {fmtDate(pc.periodStart)} – {fmtDate(pc.periodEnd)}
              </dd>
              <dt>Hours worked</dt>
              <dd>{fmtHours(pc.totalHours)}</dd>
              <dt>Employer taxes</dt>
              <dd>{fmtMoney(pc.employerTaxes)}</dd>
              <dt>Contributions</dt>
              <dd>{fmtMoney(pc.contributions)}</dd>
              <dt>Created</dt>
              <dd>
                {pc.createdBy} {pc.createdAt ? fmtDate(pc.createdAt.slice(0, 10)) : ''}
              </dd>
            </dl>
            <table className="py-table py-pcsum-lines" aria-label="Paycheck lines">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="py-r">Rate</th>
                  <th className="py-r">Hours/Qty</th>
                  <th className="py-r">Amount</th>
                  <th className="py-r">YTD</th>
                </tr>
              </thead>
              <tbody>
                {lines
                  .filter((l) => l.amount !== 0 || l.category === 'earning' || l.category === 'employee_tax')
                  .map((l, i) => {
                    const neg = l.category === 'deduction' || l.category === 'employee_tax';
                    return (
                      <tr key={i} className={l.category === 'employer_tax' || l.category === 'contribution' ? 'py-muted' : undefined}>
                        <td>
                          {l.itemName}
                          {l.manual && <span className="py-man-flag" title="Amount entered by hand"> ✎</span>}
                        </td>
                        <td className="py-r">{lineRate(l)}</td>
                        <td className="py-r">{l.qty !== null ? fmtHours(l.qty) : ''}</td>
                        <td className="py-r">{fmtMoney(neg ? -l.amount : l.amount)}</td>
                        <td className="py-r">{fmtMoney(neg ? -l.ytd : l.ytd)}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </section>
      }
      footer={
        <div className={`py-sync py-sync-${sync.tone}`} role="status">
          <Landmark size={15} aria-hidden="true" />
          <span className="sx-label">SERIEX BOOKS</span>
          <StatusPill status={sync.label} tone={sync.tone} />
          <span className="py-sync-detail">
            {sync.detail}
            {pc.booksTxnId && pc.syncStatus === 'posted' ? ` (SerieX Books transaction #${pc.booksTxnId})` : ''}
          </span>
          <span className="py-grow" />
          {(pc.syncStatus === 'pending' || pc.syncStatus === 'error') && <Button small icon={RefreshCw} label="Retry" busy={retrying} onClick={() => void retry()} />}
          <Button small variant="ghost" label="Books Sync…" onClick={() => openWindow('booksSync', { tab: 'pending' })} />
        </div>
      }
      bottomLeft={
        !readOnly && !pc.directDeposit ? (
          <Checkbox label="Print later" checked={h.toBePrinted} onChange={(v) => void togglePrintLater(v)} title="Keep this paycheck in the list of checks to print (File > Print > Paychecks)" />
        ) : undefined
      }
      totals={[
        { key: 'gross', label: 'Gross pay', value: pc.gross },
        { key: 'net', label: 'Net pay', value: pc.net, strong: true },
      ]}
    />
  );
}
