// Direct Deposit dialog (Payroll Info > Direct Deposit...). The routing and account numbers come
// back from the server masked ("****6789"); leaving them unchanged keeps the stored numbers, typing
// new digits replaces them. "Delete Direct Deposit Information" erases the stored bank name and
// numbers (sent as `clear: true` when the employee is saved) and pays the employee by check.
import { useState } from 'react';
import { Lock } from 'lucide-react';
import type { DirectDeposit } from '@/api/types';
import { Button, Checkbox, Field, Select, TextField, confirmBox, showDialog } from '@/components';

/** Shows the Direct Deposit dialog; resolves with the new settings, or null on Cancel. */
export function editDirectDeposit(name: string, value: DirectDeposit): Promise<DirectDeposit | null> {
  return showDialog<DirectDeposit | null>({
    title: 'Direct Deposit',
    width: 560,
    cancelValue: null,
    render: (close) => <DirectDepositForm name={name} value={value} onDone={close} />,
  });
}

const masked = (s: string) => /^[*•Xx]+[0-9]{0,4}$/.test(s.trim());

/** ABA routing number check digit. */
function validRouting(d: string): boolean {
  if (!/^\d{9}$/.test(d)) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  return d.split('').reduce((s, c, i) => s + Number(c) * w[i], 0) % 10 === 0;
}

function DirectDepositForm({ name, value, onDone }: { name: string; value: DirectDeposit; onDone(v: DirectDeposit | null): void }) {
  const [v, setV] = useState<DirectDeposit>({ ...value });
  const [err, setErr] = useState('');
  const set = (p: Partial<DirectDeposit>) => setV((x) => ({ ...x, ...p }));
  const ok = () => {
    const routing = v.routing.trim();
    const account = v.account.trim();
    if (routing && !masked(routing) && !validRouting(routing.replace(/[\s-]/g, ''))) {
      setErr('The routing number must be a valid 9-digit bank routing number.');
      return;
    }
    if (account && !masked(account) && !/^\d{4,17}$/.test(account.replace(/[\s-]/g, ''))) {
      setErr('The bank account number must have 4 to 17 digits.');
      return;
    }
    if (v.enabled && (!routing || !account)) {
      setErr('Enter the routing and account numbers to use direct deposit.');
      return;
    }
    // a deletion chosen earlier stands until new numbers are typed (the server would erase them too)
    const clear = value.clear && !routing && !account ? true : undefined;
    onDone({ ...v, routing, account, bankName: v.bankName.trim(), clear });
  };
  // Erases the stored bank name and numbers when the employee is saved (the server keeps stored
  // numbers when they are sent empty or masked, so the deletion is asked with `clear`).
  const onFile = !value.clear && (value.enabled || !!value.routing || !!value.account || !!value.bankName);
  const del = async () => {
    const ok = await confirmBox(
      `Delete the direct deposit information of ${name || 'this employee'}?\n\nThe bank name, routing number and account number are erased when you save the employee, and paychecks are printed again.`,
      'Delete Direct Deposit Information',
    );
    if (ok) onDone({ enabled: false, bankName: '', routing: '', account: '', accountType: 'checking', clear: true });
  };
  return (
    <div className="sxp-emp-dlg">
      <div className="sxp-emp-dlg-body">
        {err && <div className="sxp-emp-dlg-error">{err}</div>}
        <Checkbox checked={v.enabled} onChange={(x) => set({ enabled: x })} label={`Use Direct Deposit for: ${name || 'this employee'}`} />
        <div className="sxp-emp-hint">Deposit all of the net pay into one account.</div>
        <div className="sxp-emp-grid sxp-emp-g2">
          <Field label="Bank name">
            <TextField name="directDeposit.bankName" value={v.bankName} onChange={(x) => set({ bankName: x })} disabled={!v.enabled} />
          </Field>
          <Field label="Account type">
            <Select
              name="directDeposit.accountType"
              value={v.accountType}
              onChange={(x) => set({ accountType: x as DirectDeposit['accountType'] })}
              options={[
                { value: 'checking', label: 'Checking' },
                { value: 'savings', label: 'Savings' },
              ]}
              disabled={!v.enabled}
            />
          </Field>
          <Field label="Routing number" hint={masked(v.routing) ? 'On file. Type a new number to replace it.' : '9 digits.'}>
            <TextField name="directDeposit.routing" value={v.routing} onChange={(x) => set({ routing: x })} disabled={!v.enabled} inputMode="numeric" maxLength={11} />
          </Field>
          <Field label="Account number" hint={masked(v.account) ? 'On file. Type a new number to replace it.' : '4 to 17 digits.'}>
            <TextField name="directDeposit.account" value={v.account} onChange={(x) => set({ account: x })} disabled={!v.enabled} inputMode="numeric" maxLength={20} />
          </Field>
        </div>
        <div className="sxp-emp-notice">
          <Lock size={14} aria-hidden="true" />
          <span>Bank numbers are stored in the payroll file and shown masked. Only the last digits appear on pay stubs.</span>
        </div>
      </div>
      <div className="sx-dlg-buttons">
        {onFile && (
          <Button
            className="sxp-emp-dlg-buttons-left"
            variant="ghost"
            label="Delete Direct Deposit Information"
            title="Erase the bank name and numbers on file and pay this employee by check"
            onClick={() => void del()}
          />
        )}
        <Button label="Cancel" onClick={() => onDone(null)} />
        <Button variant="primary" label="OK" onClick={ok} />
      </div>
    </div>
  );
}
