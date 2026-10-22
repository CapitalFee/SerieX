// Employee Defaults (Employee Center > Employee Settings > Defaults for New Employees,
// Employees > Employee Defaults...): the earnings, pay schedule / pay frequency,
// class, additions-deductions-contributions, state taxes and sick/vacation settings new employees
// start with. They apply to employees created afterwards only.
import { useEffect, useMemo, useState } from 'react';
import { Info, Landmark, ReceiptText } from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll, useItemsById, useMeta, usePaySchedules, usePrefValues } from '@/api/hooks';
import { FREQUENCY_LABELS, type EmployeeDefaults } from '@/api/types';
import { Button, ClassPicker, EditDialog, Field, FrequencyPicker, PaySchedulePicker, Spinner, confirmBox, toast, useFormErrors } from '@/components';
import { todayIso } from '@/util/dates';
import { useWindow } from '@/windows/WindowContext';
import { EarningsGrid, OtherItemsGrid, realLines } from './EmployeeItemsGrids';
import { editPto } from './PtoDialog';
import { editTaxes } from './TaxesDialog';
import { blankPTO, errMessage, fmtHours, useLatest } from './shared';

export interface EmployeeDefaultsDialogProps {}

const bodyOf = (d: EmployeeDefaults): EmployeeDefaults => ({ ...d, earnings: realLines(d.earnings), items: realLines(d.items) });

export default function EmployeeDefaultsDialog(_props: EmployeeDefaultsDialogProps) {
  const win = useWindow();
  const fe = useFormErrors();
  const prefs = usePrefValues();
  const meta = useMeta().data;
  const schedules = usePaySchedules({ active: 'all' }).data;
  const itemsById = useItemsById();
  const [d, setD] = useState<EmployeeDefaults | null>(null);
  const [orig, setOrig] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = async () => {
    setLoadError(null);
    try {
      const r = await api.get<EmployeeDefaults>('/employee-defaults');
      const v = { ...r, sick: { ...blankPTO(), ...r.sick }, vacation: { ...blankPTO(), ...r.vacation } };
      setD(v);
      setOrig(JSON.stringify(bodyOf(v)));
    } catch (e) {
      setLoadError(errMessage(e) ?? 'The employee defaults could not be loaded.');
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const dirty = useMemo(() => !!d && JSON.stringify(bodyOf(d)) !== orig, [d, orig]);
  const dirtyRef = useLatest(dirty);
  useEffect(() => {
    win.setDirty(dirty);
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    win.setBeforeClose(async () => (dirtyRef.current ? confirmBox('The employee defaults have changes that are not saved. Close anyway?', 'Unsaved Changes') : true));
    return () => win.setBeforeClose(null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loadError)
    return (
      <div className="sxp-emp-pad">
        <div className="sxp-emp-dlg-error">{loadError}</div>
        <div>
          <Button label="Try again" onClick={() => void load()} />
        </div>
      </div>
    );
  if (!d)
    return (
      <div className="sxp-emp-page" style={{ alignItems: 'center', justifyContent: 'center', background: '#fff' }}>
        <Spinner label="Loading…" />
      </div>
    );

  const set = (p: Partial<EmployeeDefaults>) => setD((x) => (x ? { ...x, ...p } : x));
  const schedule = schedules?.find((s) => s.id === d.payScheduleId) ?? null;
  const st = meta?.states.find((s) => s.code === d.workState);

  const openTaxes = async () => {
    const r = await editTaxes({
      name: '',
      defaultsMode: true,
      value: {
        w4: { version: '2020', filingStatus: 'single', step2: false, dependents: 0, otherIncome: 0, deductions: 0, extraWithholding: 0, allowances: 0, exempt: false, nonresidentAlien: false },
        subjectSs: true,
        subjectMedicare: true,
        subjectFuta: true,
        workState: d.workState,
        stateW4: { filingStatus: '', allowances: 0, extraWithholding: 0, exempt: false, data: {} },
        subjectSui: d.subjectSui,
        subjectSdi: d.subjectSdi,
        otherTaxes: [],
      },
    });
    if (r) set({ workState: r.workState, subjectSui: r.subjectSui, subjectSdi: r.subjectSdi });
  };
  const openPto = async () => {
    const r = await editPto({
      name: '',
      asOf: todayIso(),
      value: { sick: d.sick, vacation: d.vacation, sickAvailable: null, vacationAvailable: null },
      sickLabel: [...itemsById.values()].find((i) => i.pto === 'sick' && i.active)?.name,
      vacationLabel: [...itemsById.values()].find((i) => i.pto === 'vacation' && i.active)?.name,
    });
    if (r) set({ sick: r.sick, vacation: r.vacation });
  };

  const save = async () => {
    fe.clearAll();
    if (!d.workState) {
      fe.setFieldError('workState', 'Choose the state where new employees work (Taxes…).');
      return false;
    }
    try {
      const saved = await api.put<EmployeeDefaults>('/employee-defaults', bodyOf(d));
      setD(saved);
      setOrig(JSON.stringify(bodyOf(saved)));
      win.setDirty(false);
      await invalidateAll();
      toast('Employee defaults saved. They apply to employees you add from now on.', { kind: 'success' });
      return true;
    } catch (e) {
      fe.fromError(e);
      return false;
    }
  };

  const ptoText = (s: EmployeeDefaults['sick']) =>
    s.accrual === 'none' ? 'does not accrue' : `${fmtHours(s.hours)} h ${s.accrual === 'per_paycheck' ? 'per paycheck' : s.accrual === 'per_hour' ? `per ${fmtHours(s.perHoursWorked)} h worked` : 'at beginning of year'}`;

  return (
    <EditDialog
      title="Employee Defaults"
      errors={fe}
      okLabel="Save and close"
      onOk={async () => {
        if (await save()) await win.close(true);
      }}
      className="sxp-emp-edit"
    >
      <div className="sxp-def">
        <div className="sxp-emp-notice">
          <Info size={15} aria-hidden="true" />
          <span>New employees start with these settings. Changing them does not change employees you already added.</span>
        </div>
        <div className="sxp-emp-payhead">
          <Field label="Pay schedule" help="New employees are put on this schedule and paid at its frequency.">
            <PaySchedulePicker
              name="payScheduleId"
              value={d.payScheduleId}
              onChange={(sid, s) => set({ payScheduleId: sid, ...(s ? { payFrequency: s.frequency } : {}) })}
              filter={(s) => s.active || s.id === d.payScheduleId}
            />
          </Field>
          <Field label="Pay frequency" hint={schedule ? `Set by the schedule (${FREQUENCY_LABELS[schedule.frequency]}).` : undefined}>
            <FrequencyPicker name="payFrequency" value={schedule ? schedule.frequency : d.payFrequency} onChange={(f) => f && set({ payFrequency: f })} disabled={!!schedule} />
          </Field>
          {prefs.classTracking !== 'none' && (
            <Field label="Class">
              <ClassPicker name="classId" value={d.classId} onChange={(cid) => set({ classId: cid })} />
            </Field>
          )}
        </div>
        <div className="sxp-emp-grids">
          <div className="sxp-emp-gridbox" data-field="earnings">
            <div className="sxp-emp-section-title">Earnings</div>
            <EarningsGrid rows={d.earnings} onChange={(rows) => set({ earnings: rows })} />
          </div>
          <div className="sxp-emp-gridbox" data-field="items">
            <div className="sxp-emp-section-title">Additions, deductions and company contributions</div>
            <OtherItemsGrid rows={d.items} onChange={(rows) => set({ items: rows })} />
          </div>
        </div>
        <div className="sxp-emp-paybtns">
          <Button icon={ReceiptText} label="&Taxes…" onClick={() => void openTaxes()} />
          <Button icon={Landmark} label="Sick/&Vacation…" onClick={() => void openPto()} />
        </div>
        <div className="sxp-emp-taxsum" data-field="workState">
          <span>
            <b>State worked:</b> {d.workState ? `${st?.name ?? d.workState}` : <span className="sxp-emp-err">not set</span>} · <b>Subject to:</b>{' '}
            {[d.subjectSui && 'SUI', d.subjectSdi && 'SDI'].filter(Boolean).join(', ') || 'no state unemployment or disability'}
          </span>
          <span>
            <b>Sick:</b> {ptoText(d.sick)} · <b>Vacation:</b> {ptoText(d.vacation)}
          </span>
          {fe.errors.workState && <span className="sxp-emp-err">{fe.errors.workState}</span>}
        </div>
      </div>
    </EditDialog>
  );
}
