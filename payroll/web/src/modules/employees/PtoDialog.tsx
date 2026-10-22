// "Sick and Vacation for <employee>" dialog (Payroll Info > Sick/Vacation...). Two groups with
// the hours available today (changing it records a paid time off adjustment), the hours used
// this year, the accrual period and hours, the maximum, "reset hours each new year", the month
// the year begins and the date accruals begin. The Employee Defaults window uses it without
// the balances.
import { useState } from 'react';
import type { PTOSettings } from '@/api/types';
import { Button, Checkbox, DateField, Field, GroupBox, NumberField, Select, showDialog } from '@/components';
import { fmtDate } from '@/util/format';
import { ACCRUAL_OPTIONS, MONTHS, fmtHours } from './shared';

/** What the Sick and Vacation dialog edits. */
export interface PtoValue {
  sick: PTOSettings;
  vacation: PTOSettings;
  /** New "hours available as of today" (null = unchanged). */
  sickAvailable: number | null;
  vacationAvailable: number | null;
}

/** Options of {@link editPto}. */
export interface EditPtoOptions {
  name: string;
  value: PtoValue;
  /** Show "Hours available as of" and "Hours used" (employees, not the defaults). */
  showBalances?: boolean;
  /** Date of the balances (today). */
  asOf: string;
  /** Hint for "Begin accruing on" (the hire date). */
  hireDate?: string;
  /** Print names of the two kinds. */
  sickLabel?: string;
  vacationLabel?: string;
}

/** Shows the Sick and Vacation dialog; resolves with the new values, or null on Cancel. */
export function editPto(opts: EditPtoOptions): Promise<PtoValue | null> {
  return showDialog<PtoValue | null>({
    title: opts.showBalances ? `Sick and Vacation for ${opts.name || 'New Employee'}` : 'Sick and Vacation Defaults',
    width: 760,
    cancelValue: null,
    render: (close) => <PtoForm opts={opts} onDone={close} />,
  });
}

function accrualLabel(a: PTOSettings['accrual']): string {
  switch (a) {
    case 'beginning_of_year':
      return 'Hours accrued at beginning of year';
    case 'per_paycheck':
      return 'Hours accrued per paycheck';
    case 'per_hour':
      return 'Hours accrued';
    default:
      return 'Hours accrued';
  }
}

function PtoGroup({
  kind,
  title,
  s,
  onChange,
  available,
  onAvailable,
  opts,
}: {
  kind: 'sick' | 'vacation';
  title: string;
  s: PTOSettings;
  onChange(p: Partial<PTOSettings>): void;
  available: number | null;
  onAvailable(v: number | null): void;
  opts: EditPtoOptions;
}) {
  const off = s.accrual === 'none';
  const year = opts.asOf.slice(0, 4);
  return (
    <GroupBox title={title}>
      {opts.showBalances && (
        <div className="sxp-emp-grid sxp-emp-g2">
          <Field label={`Hours available as of ${fmtDate(opts.asOf)}`} help="Change it to set the balance; SerieX Payroll records the difference as an adjustment.">
            <NumberField name={`${kind}.available`} value={available ?? s.available} nullable={false} onChange={(v) => onAvailable(v ?? 0)} />
          </Field>
          <Field label={`Hours used in ${year}`}>
            <div className="sxp-emp-readout">{fmtHours(s.usedYtd)}</div>
          </Field>
        </div>
      )}
      <div className="sxp-emp-grid sxp-emp-g2">
        <Field label="Accrual period">
          <Select name={`${kind}.accrual`} value={s.accrual} options={ACCRUAL_OPTIONS} onChange={(v) => onChange({ accrual: v as PTOSettings['accrual'] })} />
        </Field>
        <Field label={accrualLabel(s.accrual)}>
          {s.accrual === 'per_hour' ? (
            <div className="sxp-emp-perhours">
              <NumberField name={`${kind}.hours`} value={s.hours} nullable={false} width={80} onChange={(v) => onChange({ hours: Math.max(0, v ?? 0) })} aria-label="Hours accrued" />
              <span>per</span>
              <NumberField name={`${kind}.perHoursWorked`} value={s.perHoursWorked} nullable={false} width={80} onChange={(v) => onChange({ perHoursWorked: Math.max(0, v ?? 0) })} aria-label="Hours worked" />
              <span>hours worked</span>
            </div>
          ) : (
            <NumberField name={`${kind}.hours`} value={s.hours} nullable={false} disabled={off} onChange={(v) => onChange({ hours: Math.max(0, v ?? 0) })} />
          )}
        </Field>
        <Field label="Maximum number of hours" hint="Blank for no maximum.">
          <NumberField name={`${kind}.maxHours`} value={s.maxHours} nullable disabled={off} onChange={(v) => onChange({ maxHours: v === null || v <= 0 ? null : v })} />
        </Field>
        <Field label="Year begins on">
          <Select
            name={`${kind}.yearBeginsMonth`}
            value={s.yearBeginsMonth}
            options={MONTHS.map((m, i) => ({ value: i + 1, label: m }))}
            onChange={(v) => onChange({ yearBeginsMonth: Number(v) })}
            disabled={off}
          />
        </Field>
        <Field label={`Begin accruing ${kind} time on`} hint={opts.hireDate ? `Blank: the hire date (${fmtDate(opts.hireDate)}).` : 'Blank: the hire date.'}>
          <DateField name={`${kind}.beginAccruingDate`} value={s.beginAccruingDate} onChange={(v) => onChange({ beginAccruingDate: v })} disabled={off} />
        </Field>
        <div style={{ paddingTop: 22 }}>
          <Checkbox checked={s.resetEachYear} onChange={(v) => onChange({ resetEachYear: v })} disabled={off} label="Reset hours each new year?" />
        </div>
      </div>
    </GroupBox>
  );
}

function PtoForm({ opts, onDone }: { opts: EditPtoOptions; onDone(v: PtoValue | null): void }) {
  const [v, setV] = useState<PtoValue>(() => ({ ...opts.value, sick: { ...opts.value.sick }, vacation: { ...opts.value.vacation } }));
  const [err, setErr] = useState('');
  const ok = () => {
    for (const k of ['sick', 'vacation'] as const) {
      const s = v[k];
      const name = k === 'sick' ? 'sick' : 'vacation';
      if (s.accrual !== 'none' && !(s.hours > 0)) {
        setErr(`Enter the ${name} hours accrued, or choose "Does not accrue".`);
        return;
      }
      if (s.accrual === 'per_hour' && !(s.perHoursWorked > 0)) {
        setErr(`Enter the hours worked for each ${name} accrual (for example 1 hour per 30 hours worked).`);
        return;
      }
    }
    const fix = (s: PTOSettings): PTOSettings => (s.accrual === 'per_hour' ? s : { ...s, perHoursWorked: 0 });
    onDone({ ...v, sick: fix(v.sick), vacation: fix(v.vacation) });
  };
  return (
    <div className="sxp-emp-dlg">
      <div className="sxp-emp-dlg-body">
        {err && <div className="sxp-emp-dlg-error">{err}</div>}
        <PtoGroup
          kind="sick"
          title={`Sick${opts.sickLabel ? ` (prints as: ${opts.sickLabel})` : ''}`}
          s={v.sick}
          onChange={(p) => setV((x) => ({ ...x, sick: { ...x.sick, ...p } }))}
          available={v.sickAvailable}
          onAvailable={(a) => setV((x) => ({ ...x, sickAvailable: a }))}
          opts={opts}
        />
        <PtoGroup
          kind="vacation"
          title={`Vacation${opts.vacationLabel ? ` (prints as: ${opts.vacationLabel})` : ''}`}
          s={v.vacation}
          onChange={(p) => setV((x) => ({ ...x, vacation: { ...x.vacation, ...p } }))}
          available={v.vacationAvailable}
          onAvailable={(a) => setV((x) => ({ ...x, vacationAvailable: a }))}
          opts={opts}
        />
      </div>
      <div className="sx-dlg-buttons">
        <Button label="Cancel" onClick={() => onDone(null)} />
        <Button variant="primary" label="OK" onClick={ok} />
      </div>
    </div>
  );
}
