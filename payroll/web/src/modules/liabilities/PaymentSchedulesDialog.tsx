// Tax Payment Schedule: one section per payment group in use (Federal 941/944/943, Federal
// 940, state withholding, state unemployment, benefit vendors, unassigned items) with "How and
// when you pay <payment>": how you pay (Check / E-pay), payee (vendor), and how often you pay
// with the due date rule. OK saves the changed groups with PUT /payment-schedules.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Landmark } from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll, queryClient, usePaymentSchedules } from '@/api/hooks';
import type { PaymentFrequency, PaymentSchedule } from '@/api/types';
import { EditDialog, EmptyState, Field, RadioGroup, Select, Spinner, VendorPicker, msgBox, toast, useFormErrors } from '@/components';
import { useWindow } from '@/windows/WindowContext';
import { PAY_FREQ_LABELS, errText, frequencyHelp, groupHelp, isCancelled } from './shared';

export interface PaymentSchedulesDialogProps {
  /** Payment group shown first (e.g. "federal_941"). */
  group?: string;
}

const FREQS: PaymentFrequency[] = ['semiweekly', 'monthly', 'quarterly', 'annually', 'after_payroll'];

/** The usual frequencies of a group (shown first, marked "usual"). */
function usual(group: string): PaymentFrequency[] {
  if (group === 'federal_941') return ['monthly', 'semiweekly'];
  if (group === 'federal_940') return ['quarterly'];
  if (group.startsWith('state_wh:')) return ['monthly', 'quarterly'];
  if (group.startsWith('state_ui:')) return ['quarterly'];
  return ['after_payroll', 'monthly'];
}

const same = (a: PaymentSchedule, b: PaymentSchedule) => a.frequency === b.frequency && a.method === b.method && (a.agencyVendorId ?? null) === (b.agencyVendorId ?? null);

export default function PaymentSchedulesDialog(props: PaymentSchedulesDialogProps) {
  const win = useWindow();
  const fe = useFormErrors();
  const q = usePaymentSchedules();
  const [rows, setRows] = useState<PaymentSchedule[] | null>(null);
  const [section, setSection] = useState<string>(props.group ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (rows || !q.data) return;
    setRows(q.data.map((r) => ({ ...r })));
    if (!props.group || !q.data.some((r) => r.paymentGroup === props.group)) setSection(q.data[0]?.paymentGroup ?? '');
  }, [q.data, rows, props.group]);
  useEffect(() => {
    if (props.group && rows?.some((r) => r.paymentGroup === props.group)) setSection(props.group);
  }, [props.group, rows]);

  const changed = useMemo(() => (rows && q.data ? rows.filter((r) => { const o = q.data!.find((x) => x.paymentGroup === r.paymentGroup); return !o || !same(o, r); }) : []), [rows, q.data]);
  const dirty = changed.length > 0;
  useEffect(() => {
    win.setDirty(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  const save = async (): Promise<boolean> => {
    fe.clearAll();
    if (!rows) return true;
    const missing = rows.find((r) => r.paymentGroup !== 'unassigned' && !r.agencyVendorId);
    if (missing) {
      setSection(missing.paymentGroup);
      fe.setFieldError(`payee:${missing.paymentGroup}`, `Choose who you pay ${missing.label} to.`);
      return false;
    }
    if (!changed.length) return true;
    setBusy(true);
    try {
      const list = await api.put<PaymentSchedule[]>('/payment-schedules', changed.map((r) => ({ ...r })));
      queryClient.setQueryData(['payment-schedules'], list);
      await invalidateAll();
      toast(`Payment schedule${changed.length === 1 ? '' : 's'} saved`);
      return true;
    } catch (e) {
      if (!isCancelled(e)) fe.fromError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  // the close question uses the latest values
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const before = async () => {
      if (!dirtyRef.current) return true;
      const r = await msgBox({
        title: 'Unsaved Changes',
        message: 'The tax payment schedule has changes that are not saved. Save them before you leave?',
        buttons: ['&Save', "&Don't Save", 'Cancel'],
        icon: 'question',
      });
      if (r === 'Save') return saveRef.current();
      return r === "Don't Save";
    };
    win.setBeforeClose(before);
    return () => win.setBeforeClose(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (q.isLoading || (!rows && !q.isError)) return <Spinner center label="Loading the tax payment schedule..." />;
  if (q.isError) return <EmptyState icon={CalendarClock} title="Could not load the tax payment schedule" message={errText(q.error)} action={{ label: 'Try again', onClick: () => void q.refetch() }} />;
  if (!rows || !rows.length)
    return <EmptyState icon={Landmark} title="Nothing to schedule yet" message="Each tax, deduction and contribution item of your payroll items gets a payment schedule here." />;

  const cur = rows.find((r) => r.paymentGroup === section) ?? rows[0];
  const set = (patch: Partial<PaymentSchedule>) => setRows((list) => (list ? list.map((r) => (r.paymentGroup === cur.paymentGroup ? { ...r, ...patch } : r)) : list));
  const us = usual(cur.paymentGroup);
  const freqOptions = [...us, ...FREQS.filter((f) => !us.includes(f))].map((f) => ({ value: f, label: PAY_FREQ_LABELS[f] + (us[0] === f ? ' (usual frequency)' : '') }));

  return (
    <EditDialog
      title="Tax Payment Schedule"
      errors={fe}
      busy={busy}
      sections={rows.map((r) => ({ key: r.paymentGroup, label: r.label, fields: [`payee:${r.paymentGroup}`] }))}
      section={cur.paymentGroup}
      onSectionChange={setSection}
      navWidth={210}
      onOk={async () => {
        if (await save()) await win.close(true);
      }}
      footerLeft={<span className="lx-muted">{dirty ? `${changed.length} schedule${changed.length === 1 ? '' : 's'} changed` : 'Choose a payment on the left to change it.'}</span>}
    >
      <div className="lx-sched">
        <div className="lx-sched-title">How and when you pay {cur.label}</div>
        <div className="lx-sched-help">{groupHelp(cur.paymentGroup, cur.label, cur.itemNames)}</div>
        <Field label="How you pay" help="E-pay payments get no check number; checks can be printed or numbered by hand.">
          <RadioGroup<'check' | 'e-pay'>
            row
            aria-label="Payment method"
            value={cur.method}
            onChange={(m) => set({ method: m })}
            options={[
              { value: 'check', label: 'Check' },
              { value: 'e-pay', label: 'E-pay' },
            ]}
          />
        </Field>
        <Field label="Payee (vendor)" htmlFor="lx-ps-payee" required={cur.paymentGroup !== 'unassigned'} width={340} hint={cur.paymentGroup === 'unassigned' ? 'Payroll items of this group are paid to this vendor.' : undefined}>
          <VendorPicker
            id="lx-ps-payee"
            name={`payee:${cur.paymentGroup}`}
            value={cur.agencyVendorId}
            fallbackLabel={cur.agencyName}
            placeholder="Choose the payee"
            onChange={(id, v) => {
              fe.clear(`payee:${cur.paymentGroup}`);
              set({ agencyVendorId: id, agencyName: v?.fullName ?? v?.name ?? '' });
            }}
          />
        </Field>
        <Field label="How often you pay" htmlFor="lx-ps-freq" required width={340} hint={frequencyHelp(cur.paymentGroup, cur.frequency)}>
          <Select id="lx-ps-freq" name="frequency" value={cur.frequency} options={freqOptions} onChange={(v) => set({ frequency: v as PaymentFrequency })} />
        </Field>
        <Field label="Payroll items in this payment">
          <div className="lx-sched-items">
            {cur.itemNames.map((n) => (
              <span key={n} className="lx-chip">
                {n}
              </span>
            ))}
          </div>
        </Field>
      </div>
    </EditDialog>
  );
}
