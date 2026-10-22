// New / Edit Pay Schedule. Questions (name, how often, pay period end date, check
// date; semimonthly: the day the first pay period of the month ends), a live summary of the
// schedule, "Schedule is inactive". After saving a new schedule SerieX Payroll offers to assign it
// to the active employees paid at the same frequency who have no schedule yet.
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/api/client';
import { invalidateAll, useEmployees } from '@/api/hooks';
import { FREQUENCY_LABELS, type Frequency, type PaySchedule } from '@/api/types';
import { Button, Checkbox, DateField, EditDialog, FrequencyPicker, HelpTip, NumberField, Spinner, TextField, alertBox, confirmBox, msgBox, notifyCreated, toast, useFormErrors } from '@/components';
import { addDays, addMonthsClamped, daysBetween, endOfMonth } from '@/util/dates';
import { fmtDate } from '@/util/format';
import { useWindow } from '@/windows/WindowContext';
import { errMessage, plural, showError, useLatest } from './shared';

export interface PayScheduleDialogProps {
  /** Pay schedule to edit (new when missing). */
  id?: number;
}

function blank(): PaySchedule {
  return { id: 0, name: '', frequency: 'biweekly', nextPeriodEnd: '', nextCheckDate: '', semiFirstDay: 15, active: true, nextPeriodStart: '', employeeCount: 0 };
}

const isMonthEnd = (iso: string) => !!iso && endOfMonth(iso) === iso;

/** First day of the pay period ending on `end` (same rules as the server). */
export function periodStartOf(freq: Frequency, end: string, semiFirstDay: number): string {
  if (!end) return '';
  switch (freq) {
    case 'daily':
      return end;
    case 'weekly':
      return addDays(end, -6);
    case 'biweekly':
      return addDays(end, -13);
    case 'semimonthly': {
      const day = +end.slice(8, 10);
      if (day === semiFirstDay) return end.slice(0, 8) + '01';
      return addDays(end.slice(0, 8) + String(semiFirstDay).padStart(2, '0'), 1);
    }
    case 'monthly':
      return isMonthEnd(end) ? end.slice(0, 8) + '01' : addDays(addMonthsClamped(end, -1), 1);
    case 'quarterly':
      return isMonthEnd(end) ? addDays(endOfMonth(addMonthsClamped(end, -3)), 1) : addDays(addMonthsClamped(end, -3), 1);
    case 'semiannually':
      return isMonthEnd(end) ? addDays(endOfMonth(addMonthsClamped(end, -6)), 1) : addDays(addMonthsClamped(end, -6), 1);
    case 'annually':
      return isMonthEnd(end) ? addDays(endOfMonth(addMonthsClamped(end, -12)), 1) : addDays(addMonthsClamped(end, -12), 1);
  }
  return '';
}

export default function PayScheduleDialog(props: PayScheduleDialogProps) {
  const win = useWindow();
  const fe = useFormErrors();
  const employees = useEmployees({ active: 'active' }).data;
  const [rec, setRec] = useState<PaySchedule | null>(props.id ? null : blank());
  const [orig, setOrig] = useState(props.id ? '' : JSON.stringify(blank()));
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.id) return;
    let off = false;
    api
      .get<PaySchedule>(`/pay-schedules/${props.id}`)
      .then((s) => {
        if (off) return;
        setRec(s);
        setOrig(JSON.stringify(s));
      })
      .catch((e) => !off && setLoadError(errMessage(e)));
    return () => {
      off = true;
    };
  }, [props.id]);

  const dirty = useMemo(() => !!rec && JSON.stringify(rec) !== orig, [rec, orig]);
  const dirtyRef = useLatest(dirty);
  useEffect(() => {
    win.setDirty(dirty);
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    win.setBeforeClose(async () => (dirtyRef.current ? confirmBox('This pay schedule has changes that are not saved. Close it anyway?', 'Unsaved Changes') : true));
    return () => win.setBeforeClose(null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loadError) return <div className="sxp-emp-pad sxp-emp-dlg-error">{loadError}</div>;
  if (!rec)
    return (
      <div className="sxp-emp-page" style={{ alignItems: 'center', justifyContent: 'center', background: '#fff' }}>
        <Spinner label="Loading…" />
      </div>
    );

  const isNew = !rec.id;
  const set = (p: Partial<PaySchedule>) => setRec((r) => (r ? { ...r, ...p } : r));
  const semi = rec.frequency === 'semimonthly';
  const start = periodStartOf(rec.frequency, rec.nextPeriodEnd, rec.semiFirstDay || 15);
  const offset = rec.nextPeriodEnd && rec.nextCheckDate ? daysBetween(rec.nextPeriodEnd, rec.nextCheckDate) : null;
  const sameFreq = (employees ?? []).filter((e) => e.payFrequency === rec.frequency && !e.payScheduleId);

  const save = async (): Promise<PaySchedule | null> => {
    fe.clearAll();
    const errs: Record<string, string> = {};
    if (!rec.name.trim()) errs.name = 'Enter a name for the pay schedule.';
    if (!rec.nextPeriodEnd) errs.nextPeriodEnd = 'Enter the end date of the pay period.';
    if (!rec.nextCheckDate) errs.nextCheckDate = 'Enter the date that appears on the paychecks.';
    if (semi && (rec.semiFirstDay < 1 || rec.semiFirstDay > 27)) errs.semiFirstDay = 'The first pay period ends between day 1 and day 27.';
    if (Object.keys(errs).length) {
      fe.setErrors(errs);
      return null;
    }
    if (!isNew) {
      const before = JSON.parse(orig) as PaySchedule;
      if (before.frequency !== rec.frequency && before.employeeCount > 0) {
        const ok = await confirmBox(
          `${plural(before.employeeCount, 'employee')} on this schedule will be paid ${FREQUENCY_LABELS[rec.frequency].toLowerCase()} from now on. Continue?`,
          'Change Pay Frequency',
        );
        if (!ok) return null;
      }
    }
    try {
      const body = { ...rec, name: rec.name.trim(), semiFirstDay: semi ? rec.semiFirstDay : 15 };
      const saved = isNew ? await api.post<PaySchedule>('/pay-schedules', body) : await api.put<PaySchedule>(`/pay-schedules/${rec.id}`, body);
      // a new schedule keeps the "New Pay Schedule" look while the assign question shows (the window closes next)
      if (isNew) setOrig(JSON.stringify(rec));
      else {
        setRec(saved);
        setOrig(JSON.stringify(saved));
      }
      win.setDirty(false);
      if (isNew) notifyCreated({ kind: 'pay_schedule', id: saved.id });
      await invalidateAll();
      toast(`Pay schedule "${saved.name}" ${isNew ? 'created' : 'saved'}`, { kind: 'success' });
      return saved;
    } catch (e) {
      fe.fromError(e);
      return null;
    }
  };

  const assign = async (s: PaySchedule) => {
    if (sameFreq.length === 0) return;
    const r = await msgBox({
      title: 'Use This Schedule for Employees',
      message: `${plural(sameFreq.length, 'active employee')} paid ${FREQUENCY_LABELS[s.frequency].toLowerCase()} ${sameFreq.length === 1 ? 'has' : 'have'} no pay schedule yet.\n\nPut ${sameFreq.length === 1 ? 'this employee' : 'them'} on "${s.name}"?`,
      buttons: ['&Yes', '&No'],
      icon: 'question',
    });
    if (r !== 'Yes') return;
    try {
      const res = await api.post<{ assigned: number }>(`/pay-schedules/${s.id}/assign`, {});
      await invalidateAll();
      await alertBox(`${plural(res.assigned, 'employee')} ${res.assigned === 1 ? 'is' : 'are'} now on the pay schedule "${s.name}".`, 'SerieX Payroll');
    } catch (e) {
      await showError(e);
    }
  };

  return (
    <EditDialog
      title={isNew ? 'New Pay Schedule' : `Edit Pay Schedule: ${JSON.parse(orig || '{}').name ?? rec.name}`}
      errors={fe}
      okLabel="OK"
      onOk={async () => {
        const s = await save();
        if (!s) return;
        if (isNew) await assign(s);
        await win.close(true);
      }}
      footerLeft={!isNew ? <Checkbox checked={!rec.active} onChange={(v) => set({ active: !v })} label="Schedule is inactive" /> : undefined}
    >
      <div className="sxp-ps">
        <div className="sxp-ps-intro">
          A few questions about when this group of employees is paid.{' '}
          <HelpTip text="A pay schedule pays a group of employees at the same time. You can have several, for example one for salaried and one for hourly employees." />
        </div>
        <div className="sxp-emp-section-title">How this schedule works</div>
        <div className="sxp-ps-q">
          <label htmlFor="ps-name">
            Schedule name <span className="sxp-emp-note">(for example "Hourly staff" or "Every other Friday")</span>
          </label>
          <div className="sxp-ps-ctl">
            <TextField id="ps-name" name="name" value={rec.name} autoFocus onChange={(v) => set({ name: v })} maxLength={60} />
          </div>
          <label htmlFor="ps-freq">How often are these employees paid?</label>
          <div className="sxp-ps-ctl">
            <FrequencyPicker
              id="ps-freq"
              name="frequency"
              value={rec.frequency}
              onChange={(f) => f && set({ frequency: f })}
              frequencies={['daily', 'weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'annually']}
            />
          </div>
          {semi && (
            <>
              <label htmlFor="ps-semi">Day the first pay period of each month ends (the second one ends on the last day of the month)</label>
              <div className="sxp-ps-ctl">
                <NumberField id="ps-semi" name="semiFirstDay" value={rec.semiFirstDay} nullable={false} decimals={0} onChange={(v) => set({ semiFirstDay: Math.round(v ?? 15) })} />
              </div>
            </>
          )}
          <label htmlFor="ps-end">Last day of the next pay period</label>
          <div className="sxp-ps-ctl">
            <DateField id="ps-end" name="nextPeriodEnd" value={rec.nextPeriodEnd} onChange={(v) => set({ nextPeriodEnd: v, ...(isNew && !rec.nextCheckDate ? { nextCheckDate: v } : {}) })} />
          </div>
          <label htmlFor="ps-check">Payday (the date printed on those paychecks)</label>
          <div className="sxp-ps-ctl">
            <DateField id="ps-check" name="nextCheckDate" value={rec.nextCheckDate} onChange={(v) => set({ nextCheckDate: v })} />
          </div>
        </div>
        {rec.nextPeriodEnd && rec.nextCheckDate && (
          <div className="sxp-ps-summary">
            In short:
            <br />
            <b>
              {offset === 0
                ? 'Payday is the last day of each pay period.'
                : offset !== null && offset > 0
                  ? `Payday is ${plural(offset, 'day')} after each pay period ends.`
                  : `Payday is ${plural(Math.abs(offset ?? 0), 'day')} before each pay period ends.`}
            </b>
            <br />
            The next paychecks are dated <b>{fmtDate(rec.nextCheckDate)}</b> and pay for{' '}
            <b>
              {fmtDate(start)} - {fmtDate(rec.nextPeriodEnd)}
            </b>
            .
          </div>
        )}
        {!isNew && rec.employeeCount > 0 && <div className="sxp-emp-note">{plural(rec.employeeCount, 'active employee')} on this schedule.</div>}
        {isNew && sameFreq.length > 0 && (
          <div className="sxp-emp-note">
            After you click OK you can put the {plural(sameFreq.length, 'employee')} paid {FREQUENCY_LABELS[rec.frequency].toLowerCase()} without a schedule on this one.
          </div>
        )}
        {!isNew && (
          <div>
            <Button small label="Use for employees…" disabled={dirty || sameFreq.length === 0} title={sameFreq.length ? undefined : 'Every active employee with this pay frequency already has a schedule'} onClick={() => void assign(rec)} />
          </div>
        )}
      </div>
    </EditDialog>
  );
}
