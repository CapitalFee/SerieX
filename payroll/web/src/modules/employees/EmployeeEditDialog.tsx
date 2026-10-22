// New / Edit Employee window. Top: the employee's name with the legal name. Sections (left):
// Personal (display name, print on checks as, social security number with "Show" for SerieX
// Books administrators, gender, date of birth), Address & Contact, Additional Info (employee ID,
// notes), Payroll Info (pay schedule, pay frequency, class, EARNINGS grid, ADDITIONS,
// DEDUCTIONS AND COMPANY CONTRIBUTIONS grid, Taxes... / Sick/Vacation... / Direct Deposit...)
// and Employment Info (hire, original hire and release dates, employee type).
// Saving creates/updates the employee's SerieX Books "other" name on the server.
import { useEffect, useMemo, useRef, useState } from 'react';
import { BriefcaseBusiness, Eye, Info, Landmark, MapPin, ReceiptText, StickyNote, User, Wallet } from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll, useEmployees, useItemsById, useMeta, usePaySchedules, usePrefValues } from '@/api/hooks';
import { FREQUENCY_LABELS, type Employee, type EmployeeDefaults, type EmployeeItem } from '@/api/types';
import {
  Button,
  Checkbox,
  ClassPicker,
  DateField,
  EditDialog,
  Field,
  FieldRow,
  FrequencyPicker,
  PaySchedulePicker,
  Select,
  Spinner,
  StatePicker,
  TextArea,
  TextField,
  confirmBox,
  notifyCreated,
  toast,
  useFormErrors,
  type EditDialogSection,
} from '@/components';
import { useSession } from '@/state/session';
import { todayIso } from '@/util/dates';
import { fmtDate, fmtMoney } from '@/util/format';
import { useWindow } from '@/windows/WindowContext';
import { editDirectDeposit } from './DirectDepositDialog';
import { EarningsGrid, OtherItemsGrid, realLines } from './EmployeeItemsGrids';
import { editPto } from './PtoDialog';
import { editTaxes, exemptExpiry } from './TaxesDialog';
import { EMPLOYMENT_TYPES, blankEmployee, defaultDisplayName, errMessage, fmtHours, shortBooksError, useLatest } from './shared';

export interface EmployeeEditDialogProps {
  /** Employee to edit (new employee when missing). */
  id?: number;
  /** Section to open first ("directDeposit": Payroll Info with the Direct Deposit dialog open, from "Set up Direct Deposit"). */
  section?: string;
}

type SectionKey = 'personal' | 'address' | 'additional' | 'payroll' | 'employment';

const SECTIONS: EditDialogSection[] = [
  { key: 'personal', label: 'Personal', icon: User, fields: ['displayName', 'printAs', 'ssn', 'gender', 'birthDate'] },
  { key: 'address', label: 'Address & Contact', icon: MapPin, fields: ['address.line1', 'address.line2', 'address.city', 'address.state', 'address.zip', 'phone', 'mobile', 'email'] },
  { key: 'additional', label: 'Additional Info', icon: StickyNote, fields: ['employeeNumber', 'notes'] },
  {
    key: 'payroll',
    label: 'Payroll Info',
    icon: Wallet,
    fields: [
      'payScheduleId',
      'payFrequency',
      'classId',
      'earnings',
      'items',
      'workState',
      'w4.version',
      'w4.filingStatus',
      'w4.allowances',
      'w4.dependents',
      'w4.otherIncome',
      'w4.deductions',
      'w4.extraWithholding',
      'stateW4.filingStatus',
      'stateW4.allowances',
      'stateW4.extraWithholding',
      'directDeposit',
      'directDeposit.routing',
      'directDeposit.account',
      'directDeposit.accountType',
      'sick.accrual',
      'sick.hours',
      'sick.perHoursWorked',
      'sick.beginAccruingDate',
      'vacation.accrual',
      'vacation.hours',
      'vacation.perHoursWorked',
      'vacation.beginAccruingDate',
    ],
  },
  { key: 'employment', label: 'Employment Info', icon: BriefcaseBusiness, fields: ['hireDate', 'originalHireDate', 'releaseDate', 'employmentType'] },
];

/** Splits the employee's items: Payroll Info grid vs Taxes > Other. */
function splitItems(items: EmployeeItem[]): { other: EmployeeItem[]; taxes: EmployeeItem[] } {
  return { other: items.filter((i) => i.itemType !== 'other_tax'), taxes: items.filter((i) => i.itemType === 'other_tax') };
}

interface Draft {
  rec: Employee;
  earnings: EmployeeItem[];
  other: EmployeeItem[];
  taxes: EmployeeItem[];
}

function draftOf(e: Employee): Draft {
  const s = splitItems(e.items);
  return { rec: e, earnings: e.earnings.map((x) => ({ ...x })), other: s.other.map((x) => ({ ...x })), taxes: s.taxes.map((x) => ({ ...x })) };
}

/** The record sent to the server (empty grid lines dropped). */
function bodyOf(d: Draft): Employee {
  return { ...d.rec, earnings: realLines(d.earnings), items: [...realLines(d.other), ...realLines(d.taxes)] };
}

const snapshot = (d: Draft | null, pto: { sick: number | null; vacation: number | null }) => (d ? JSON.stringify([bodyOf(d), pto]) : '');

export default function EmployeeEditDialog(props: EmployeeEditDialogProps) {
  const win = useWindow();
  const fe = useFormErrors();
  const prefs = usePrefValues();
  const meta = useMeta().data;
  const isAdmin = useSession((s) => s.isAdmin);
  const schedules = usePaySchedules({ active: 'all' }).data;
  const allEmployees = useEmployees({ active: 'all' }).data;
  const itemsById = useItemsById();
  const [id, setId] = useState<number>(props.id ?? 0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [orig, setOrig] = useState('');
  const [origName, setOrigName] = useState('');
  const [section, setSection] = useState<SectionKey>(props.section === 'directDeposit' ? 'payroll' : (props.section as SectionKey) || 'personal');
  const openDDOnce = useRef(props.section === 'directDeposit');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pto, setPto] = useState<{ sick: number | null; vacation: number | null }>({ sick: null, vacation: null });
  const [displayLinked, setDisplayLinked] = useState(true);
  const [printLinked, setPrintLinked] = useState(true);
  const [revealing, setRevealing] = useState(false);
  const defaultsRef = useRef<EmployeeDefaults | null>(null);
  const openDDRef = useRef<(() => Promise<void>) | null>(null);
  const today = todayIso();

  const load = async () => {
    setLoadError(null);
    try {
      if (props.id) {
        const e = await api.get<Employee>(`/employees/${props.id}`);
        const d = draftOf(e);
        setDraft(d);
        setOrig(snapshot(d, { sick: null, vacation: null }));
        setOrigName(e.displayName);
        setDisplayLinked(e.displayName === defaultDisplayName(e.firstName, e.lastName, prefs.displayNameOrder));
        setPrintLinked(!e.printAs || e.printAs === e.displayName);
      } else {
        const defs = await api.get<EmployeeDefaults>('/employee-defaults').catch(() => null);
        defaultsRef.current = defs;
        const d = draftOf(blankEmployee(defs));
        setDraft(d);
        setOrig(snapshot(d, { sick: null, vacation: null }));
      }
    } catch (e) {
      setLoadError(errMessage(e) ?? 'The employee could not be loaded.');
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.id]);

  // "Set up Direct Deposit" (Employee Center): the Direct Deposit dialog opens once the employee is loaded
  useEffect(() => {
    if (!draft || !openDDOnce.current) return;
    openDDOnce.current = false;
    void openDDRef.current?.();
  }, [draft]);

  const isNew = !id;
  const dirty = useMemo(() => !!draft && snapshot(draft, pto) !== orig, [draft, pto, orig]);
  const dirtyRef = useLatest(dirty);
  useEffect(() => {
    win.setDirty(dirty);
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    win.setBeforeClose(async () => {
      if (!dirtyRef.current) return true;
      return confirmBox('This employee has changes that are not saved. Close anyway?', 'Unsaved Changes');
    });
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
  if (!draft)
    return (
      <div className="sxp-emp-page" style={{ alignItems: 'center', justifyContent: 'center', background: '#fff' }}>
        <Spinner label="Loading…" />
      </div>
    );

  const rec = draft.rec;
  const set = (p: Partial<Employee>) => setDraft((d) => (d ? { ...d, rec: { ...d.rec, ...p } } : d));
  const setAddr = (p: Partial<Employee['address']>) => set({ address: { ...rec.address, ...p } });
  const name = rec.displayName || defaultDisplayName(rec.firstName, rec.lastName, prefs.displayNameOrder);

  /** First / last name typed: the display name and "print on checks as" follow while linked. */
  const setName = (p: Partial<Employee>) => {
    const next = { ...rec, ...p };
    const dn = displayLinked ? defaultDisplayName(next.firstName, next.lastName, prefs.displayNameOrder) : next.displayName;
    const pa = printLinked ? [next.firstName, next.middleName, next.lastName, next.suffix].map((s) => s.trim()).filter(Boolean).join(' ') : next.printAs;
    set({ ...p, displayName: dn, printAs: pa });
  };

  const schedule = schedules?.find((s) => s.id === rec.payScheduleId) ?? null;
  const st = meta?.states.find((s) => s.code === rec.workState);

  // ---- dialogs
  const openTaxes = async (tab?: 'federal' | 'state' | 'other') => {
    const r = await editTaxes({
      name,
      tab,
      value: {
        w4: rec.w4,
        subjectSs: rec.subjectSs,
        subjectMedicare: rec.subjectMedicare,
        subjectFuta: rec.subjectFuta,
        workState: rec.workState,
        stateW4: rec.stateW4,
        subjectSui: rec.subjectSui,
        subjectSdi: rec.subjectSdi,
        otherTaxes: draft.taxes,
      },
    });
    if (!r) return;
    for (const k of Object.keys(fe.errors)) if (k === 'workState' || k.startsWith('w4.') || k.startsWith('stateW4.')) fe.setFieldError(k, null);
    setDraft((d) =>
      d
        ? {
            ...d,
            taxes: r.otherTaxes,
            rec: {
              ...d.rec,
              w4: r.w4,
              subjectSs: r.subjectSs,
              subjectMedicare: r.subjectMedicare,
              subjectFuta: r.subjectFuta,
              workState: r.workState,
              stateW4: r.stateW4,
              subjectSui: r.subjectSui,
              subjectSdi: r.subjectSdi,
            },
          }
        : d,
    );
  };
  const openPto = async () => {
    const r = await editPto({
      name,
      showBalances: true,
      asOf: today,
      hireDate: rec.hireDate,
      value: { sick: rec.sick, vacation: rec.vacation, sickAvailable: pto.sick, vacationAvailable: pto.vacation },
      sickLabel: itemsById.size ? [...itemsById.values()].find((i) => i.pto === 'sick' && i.active)?.name : undefined,
      vacationLabel: itemsById.size ? [...itemsById.values()].find((i) => i.pto === 'vacation' && i.active)?.name : undefined,
    });
    if (!r) return;
    set({ sick: r.sick, vacation: r.vacation });
    setPto({
      sick: r.sickAvailable !== null && r.sickAvailable !== rec.sick.available ? r.sickAvailable : null,
      vacation: r.vacationAvailable !== null && r.vacationAvailable !== rec.vacation.available ? r.vacationAvailable : null,
    });
  };
  const openDD = async () => {
    const r = await editDirectDeposit(name, rec.directDeposit);
    if (!r) return;
    for (const k of Object.keys(fe.errors)) if (k.startsWith('directDeposit')) fe.setFieldError(k, null);
    set({ directDeposit: r });
  };
  openDDRef.current = openDD;
  const revealSsn = async () => {
    if (!id) return;
    setRevealing(true);
    try {
      const r = await api.get<{ ssn: string }>(`/employees/${id}/ssn`);
      set({ ssn: r.ssn });
      // the revealed number is the stored one: it does not count as a change
      setOrig((o) => {
        const d0 = JSON.parse(o) as [Employee, unknown];
        d0[0].ssn = r.ssn;
        return JSON.stringify(d0);
      });
    } catch (e) {
      fe.setFieldError('ssn', errMessage(e) ?? 'The number could not be shown.');
    } finally {
      setRevealing(false);
    }
  };

  // ---- save
  const save = async (): Promise<Employee | null> => {
    fe.clearAll();
    // checked in the order of the window (name, Personal, Address & Contact, Payroll Info, Employment Info)
    const errs: Record<string, string> = {};
    if (!rec.firstName.trim()) errs.firstName = "Enter the employee's first name.";
    if (!rec.lastName.trim()) errs.lastName = "Enter the employee's last name.";
    const dn = (rec.displayName.trim() || defaultDisplayName(rec.firstName, rec.lastName, prefs.displayNameOrder)).toLowerCase();
    const twin = dn && rec.firstName.trim() && rec.lastName.trim() ? allEmployees?.find((x) => x.id !== id && x.displayName.toLowerCase() === dn) : undefined;
    if (twin) errs.displayName = `There is already an employee named "${twin.displayName}". Use a different name (for example add a middle initial).`;
    const ssn = rec.ssn.trim();
    if (ssn && !ssnMasked) {
      if (/[^0-9\s-]/.test(ssn)) errs.ssn = 'The social security number can only contain digits.';
      else if (ssn.replace(/\D/g, '').length !== 9) errs.ssn = 'The social security number must have 9 digits.';
    }
    if (rec.birthDate && rec.birthDate > today) errs.birthDate = 'The birth date cannot be in the future.';
    const email = rec.email.trim();
    if (email && (!email.includes('@') || /[\s,;]/.test(email))) errs.email = 'The email address is not valid.';
    if (!rec.payScheduleId && !rec.payFrequency) errs.payFrequency = 'Choose how often the employee is paid.';
    if (!rec.workState) errs.workState = 'Choose the state where the employee works (Taxes... > State).';
    if (!rec.hireDate) errs.hireDate = 'Enter the hire date.';
    if (rec.hireDate && rec.releaseDate && rec.releaseDate < rec.hireDate) errs.releaseDate = 'The release date cannot be before the hire date.';
    if (Object.keys(errs).length) {
      fe.setErrors(errs, null);
      return null;
    }
    const body = bodyOf(draft);
    if (!body.displayName.trim()) body.displayName = defaultDisplayName(body.firstName, body.lastName, prefs.displayNameOrder);
    try {
      const saved = isNew ? await api.post<Employee>('/employees', body) : await api.put<Employee>(`/employees/${id}`, body);
      // "Hours available as of today" changes are recorded as paid time off adjustments
      const problems: string[] = [];
      for (const k of ['sick', 'vacation'] as const) {
        const avail = pto[k];
        if (avail === null) continue;
        try {
          await api.post(`/employees/${saved.id}/pto-adjustments`, { kind: k, date: today, available: avail });
        } catch (e) {
          problems.push(`${k === 'sick' ? 'Sick' : 'Vacation'} hours: ${errMessage(e)}`);
        }
      }
      if (isNew) notifyCreated({ kind: 'employee', id: saved.id });
      await invalidateAll();
      if (saved.booksSyncError)
        toast(`"${saved.displayName}" saved. Its SerieX Books name was not updated: ${shortBooksError(saved.booksSyncError)}`, { kind: 'warning', duration: 7000 });
      else toast(`Employee "${saved.displayName}" ${isNew ? 'added' : 'saved'}`, { kind: 'success' });
      if (problems.length) toast(problems.join(' · '), { kind: 'error', duration: 9000 });
      return saved;
    } catch (e) {
      fe.fromError(e, { nameField: 'displayName' });
      return null;
    }
  };

  const onOk = async () => {
    const s = await save();
    if (!s) return;
    win.setDirty(false);
    setOrig(snapshot(draft, pto));
    await win.close(true);
  };
  const onSaveNew = async () => {
    const s = await save();
    if (!s) return;
    const d = draftOf(blankEmployee(defaultsRef.current));
    setId(0);
    setDraft(d);
    setPto({ sick: null, vacation: null });
    setOrig(snapshot(d, { sick: null, vacation: null }));
    setDisplayLinked(true);
    setPrintLinked(true);
    setSection('personal');
    win.setDirty(false);
  };

  // ---- summaries of the Payroll Info dialogs
  const w4 = rec.w4;
  const fedStatus = (w4.version === '2020' ? meta?.fedStatus2020 : meta?.fedStatusPre2020)?.find((o) => o.value === w4.filingStatus)?.label ?? w4.filingStatus;
  const exemptYear = w4.exemptYear || +today.slice(0, 4);
  const fedText = w4.exempt
    ? `Exempt (claimed for ${exemptYear}${today > exemptExpiry(exemptYear) ? `, expired ${fmtDate(exemptExpiry(exemptYear))}` : ''})`
    : [
        fedStatus,
        w4.version === '2020' ? (w4.step2 ? 'Step 2 checked' : '') : `${w4.allowances} allowance${w4.allowances === 1 ? '' : 's'}`,
        w4.version === '2020' && w4.dependents ? `dependents $${fmtMoney(w4.dependents)}` : '',
        w4.extraWithholding ? `extra $${fmtMoney(w4.extraWithholding)}` : '',
      ]
        .filter(Boolean)
        .join(', ');
  const stStatus = st?.filingStatuses.find((o) => o.value === rec.stateW4.filingStatus)?.label;
  const stateText = !rec.workState
    ? ''
    : !st?.hasIncomeTax
      ? 'no state income tax'
      : rec.stateW4.exempt
        ? 'Exempt'
        : [stStatus ?? (rec.stateW4.filingStatus || 'state default status'), `${rec.stateW4.allowances} allowance${rec.stateW4.allowances === 1 ? '' : 's'}`, rec.stateW4.extraWithholding ? `extra $${fmtMoney(rec.stateW4.extraWithholding)}` : '']
            .filter(Boolean)
            .join(', ');
  const subjects = [rec.subjectSs && 'Social Security', rec.subjectMedicare && 'Medicare', rec.subjectFuta && 'FUTA', rec.subjectSui && 'SUI', rec.subjectSdi && st && st.programs.length > 0 && 'SDI'].filter(Boolean).join(', ');
  const ptoText = (k: 'sick' | 'vacation') => {
    const s = rec[k];
    const avail = pto[k] ?? s.available;
    const acc = s.accrual === 'none' ? 'no accrual' : `${fmtHours(s.hours)} h ${s.accrual === 'per_paycheck' ? 'per paycheck' : s.accrual === 'per_hour' ? `per ${fmtHours(s.perHoursWorked)} h worked` : 'at beginning of year'}`;
    return `${fmtHours(avail)} h available, ${acc}`;
  };
  const dd = rec.directDeposit;

  const ssnMasked = /^[Xx*•]{3}-?[Xx*•]{2}-?\d{0,4}$/.test(rec.ssn.trim());

  const top = (
    <div className="sxp-emp-edit-top">
      <div className="sxp-emp-for">
        Employee: <b>{name || 'new employee'}</b>
      </div>
      <FieldRow>
        <Field label="First name" required style={{ flex: '1 1 160px' }}>
          <TextField name="firstName" value={rec.firstName} autoFocus onChange={(v) => setName({ firstName: v })} maxLength={50} />
        </Field>
        <Field label="M.I." style={{ flex: '0 1 56px', minWidth: 48 }}>
          <TextField name="middleName" value={rec.middleName} onChange={(v) => setName({ middleName: v })} maxLength={20} />
        </Field>
        <Field label="Last name" required style={{ flex: '1 1 180px' }}>
          <TextField name="lastName" value={rec.lastName} onChange={(v) => setName({ lastName: v })} maxLength={50} />
        </Field>
        <Field label="Suffix" style={{ flex: '0 1 70px', minWidth: 56 }}>
          <TextField name="suffix" value={rec.suffix} onChange={(v) => setName({ suffix: v })} maxLength={10} placeholder="Jr." />
        </Field>
      </FieldRow>
    </div>
  );

  return (
    <EditDialog
      title={isNew ? 'New Employee' : `Edit Employee: ${origName}`}
      errors={fe}
      top={top}
      sections={SECTIONS}
      section={section}
      onSectionChange={(k) => setSection(k as SectionKey)}
      onOk={onOk}
      okLabel="Save and close"
      onSaveNew={isNew ? onSaveNew : undefined}
      navWidth={182}
      className="sxp-emp-edit"
      footerLeft={
        !isNew ? (
          <Checkbox checked={!rec.active} onChange={(v) => set({ active: !v })} label="Employee is inactive" title="Inactive employees are hidden from lists and payroll but keep their history" />
        ) : null
      }
    >
      {section === 'personal' && (
        <div className="sxp-emp-form">
          <div className="sxp-emp-grid sxp-emp-g2">
            <Field label="Employee name (in lists)" help="How the employee appears in lists, reports and SerieX Books. It follows the first and last name unless you change it.">
              <TextField
                name="displayName"
                value={rec.displayName}
                onChange={(v) => {
                  setDisplayLinked(false);
                  set({ displayName: v, ...(printLinked ? {} : {}) });
                }}
                maxLength={100}
              />
            </Field>
            <Field label="Print on checks as" help="The name printed on paychecks.">
              <TextField
                name="printAs"
                value={rec.printAs}
                onChange={(v) => {
                  setPrintLinked(false);
                  set({ printAs: v });
                }}
                maxLength={100}
              />
            </Field>
          </div>
          <div className="sxp-emp-grid sxp-emp-g3">
            <Field label="Social Security No." hint={rec.ssnOnFile && ssnMasked ? 'On file (masked). Type a new number to replace it.' : '9 digits, for example 123-45-6789.'}>
              <div className="sxp-emp-ssn">
                <TextField name="ssn" value={rec.ssn} onChange={(v) => set({ ssn: v })} maxLength={11} placeholder="XXX-XX-XXXX" autoComplete="off" />
                {isAdmin && !isNew && rec.ssnOnFile && ssnMasked && (
                  <Button icon={Eye} label="Show" title="Show the full number (recorded in the audit trail)" busy={revealing} onClick={() => void revealSsn()} />
                )}
              </div>
            </Field>
            <Field label="Gender">
              <Select
                name="gender"
                value={rec.gender}
                onChange={(v) => set({ gender: v })}
                options={[
                  { value: '', label: '' },
                  { value: 'Male', label: 'Male' },
                  { value: 'Female', label: 'Female' },
                ]}
              />
            </Field>
            <Field label="Date of birth">
              <DateField name="birthDate" value={rec.birthDate} onChange={(v) => set({ birthDate: v })} />
            </Field>
          </div>
        </div>
      )}

      {section === 'address' && (
        <div className="sxp-emp-form">
          <div className="sxp-emp-section">
            <div className="sxp-emp-section-title">Home address</div>
            <Field label="Address">
              <TextField name="address.line1" value={rec.address.line1} onChange={(v) => setAddr({ line1: v })} placeholder="Street" />
            </Field>
            <TextField name="address.line2" aria-label="Address line 2" value={rec.address.line2} onChange={(v) => setAddr({ line2: v })} placeholder="Apartment, suite (optional)" />
            <div className="sxp-emp-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 110px 120px' }}>
              <Field label="City">
                <TextField name="address.city" value={rec.address.city} onChange={(v) => setAddr({ city: v })} />
              </Field>
              <Field label="State">
                <StatePicker name="address.state" value={rec.address.state} onChange={(c) => setAddr({ state: c ?? '' })} hideName aria-label="Address state" />
              </Field>
              <Field label="ZIP">
                <TextField name="address.zip" value={rec.address.zip} onChange={(v) => setAddr({ zip: v })} maxLength={10} />
              </Field>
            </div>
          </div>
          <div className="sxp-emp-grid sxp-emp-g3">
            <Field label="Main phone">
              <TextField name="phone" type="tel" value={rec.phone} onChange={(v) => set({ phone: v })} />
            </Field>
            <Field label="Mobile">
              <TextField name="mobile" type="tel" value={rec.mobile} onChange={(v) => set({ mobile: v })} />
            </Field>
            <Field label="Main email">
              <TextField name="email" type="email" value={rec.email} onChange={(v) => set({ email: v })} />
            </Field>
          </div>
        </div>
      )}

      {section === 'additional' && (
        <div className="sxp-emp-form">
          <div className="sxp-emp-grid sxp-emp-g2">
            <Field label="Employee ID" help="Your own number for this employee (printed on pay stubs).">
              <TextField name="employeeNumber" value={rec.employeeNumber} onChange={(v) => set({ employeeNumber: v })} maxLength={30} />
            </Field>
          </div>
          <Field label="Notes" hint="Only you see these notes (they are not printed on paychecks).">
            <TextArea name="notes" value={rec.notes} onChange={(v) => set({ notes: v })} height={200} />
          </Field>
        </div>
      )}

      {section === 'payroll' && (
        <div className="sxp-emp-form">
          <div className="sxp-emp-payhead">
            <Field label="Pay schedule" help="Employees on a schedule are paid together (Pay Employees > Run Payroll). The schedule sets the pay frequency.">
              <PaySchedulePicker
                name="payScheduleId"
                value={rec.payScheduleId}
                onChange={(sid, s) => set({ payScheduleId: sid, ...(s ? { payFrequency: s.frequency } : {}) })}
                filter={(s) => s.active || s.id === rec.payScheduleId}
              />
            </Field>
            <Field label="Pay frequency" hint={schedule ? `Set by the schedule (${FREQUENCY_LABELS[schedule.frequency]}).` : undefined}>
              <FrequencyPicker name="payFrequency" value={schedule ? schedule.frequency : rec.payFrequency} onChange={(f) => f && set({ payFrequency: f })} disabled={!!schedule} />
            </Field>
            {prefs.classTracking !== 'none' && (
              <Field label="Class">
                <ClassPicker name="classId" value={rec.classId} onChange={(cid) => set({ classId: cid })} />
              </Field>
            )}
          </div>
          <div className="sxp-emp-grids">
            <div className="sxp-emp-gridbox" data-field="earnings">
              <div className="sxp-emp-section-title">Earnings</div>
              <EarningsGrid rows={draft.earnings} onChange={(rows) => setDraft((d) => (d ? { ...d, earnings: rows } : d))} />
            </div>
            <div className="sxp-emp-gridbox" data-field="items">
              <div className="sxp-emp-section-title">Additions, deductions and company contributions</div>
              <OtherItemsGrid rows={draft.other} onChange={(rows) => setDraft((d) => (d ? { ...d, other: rows } : d))} excludeIds={draft.taxes.map((t) => t.itemId)} />
            </div>
          </div>
          <div className="sxp-emp-paybtns">
            <Button icon={ReceiptText} label="&Taxes…" onClick={() => void openTaxes()} />
            <Button icon={Landmark} label="Sick/&Vacation…" onClick={() => void openPto()} />
            <Button icon={Wallet} label="Direct &Deposit…" onClick={() => void openDD()} />
          </div>
          <div className="sxp-emp-taxsum" data-field="workState">
            <span>
              <b>Federal (W-4 {w4.version === '2020' ? '2020 or later' : '2019 or earlier'}):</b> {fedText}
              {w4.nonresidentAlien ? ', nonresident alien' : ''}
            </span>
            <span>
              <b>State worked:</b>{' '}
              {rec.workState ? (
                <>
                  {st?.name ?? rec.workState} — {stateText}
                </>
              ) : (
                <span className="sxp-emp-err">not set — click Taxes… to choose it</span>
              )}
            </span>
            {draft.taxes.filter((t) => t.itemId).length > 0 && (
              <span>
                <b>Other taxes:</b> {draft.taxes.filter((t) => t.itemId).map((t) => itemsById.get(t.itemId)?.name ?? t.itemName).join(', ')}
              </span>
            )}
            <span>
              <b>Subject to:</b> {subjects || 'no payroll taxes'}
            </span>
            <span>
              <b>Sick:</b> {ptoText('sick')} · <b>Vacation:</b> {ptoText('vacation')}
            </span>
            <span>
              <b>Direct deposit:</b>{' '}
              {dd.clear ? 'not used; the bank information on file is deleted when you save' : dd.enabled ? `${dd.bankName || 'bank'} ${dd.accountType} ${dd.account}` : 'not used (paid by check)'}
            </span>
            {fe.errors.workState && <span className="sxp-emp-err">{fe.errors.workState}</span>}
          </div>
        </div>
      )}

      {section === 'employment' && (
        <div className="sxp-emp-form">
          <div className="sxp-emp-section">
            <div className="sxp-emp-section-title">Employment dates</div>
            <div className="sxp-emp-grid sxp-emp-g3">
              <Field label="Hire date" required>
                <DateField name="hireDate" value={rec.hireDate} onChange={(v) => set({ hireDate: v })} />
              </Field>
              <Field label="Original hire date" help="The first day the person ever worked for the company (when rehired).">
                <DateField name="originalHireDate" value={rec.originalHireDate} onChange={(v) => set({ originalHireDate: v })} />
              </Field>
              <Field label="Release date" help="Last date on payroll. Later payrolls of the pay schedule leave released employees out." hint="Last date on payroll.">
                <DateField name="releaseDate" value={rec.releaseDate} onChange={(v) => set({ releaseDate: v })} />
              </Field>
            </div>
          </div>
          <div className="sxp-emp-section">
            <div className="sxp-emp-section-title">Employment details</div>
            <div className="sxp-emp-grid sxp-emp-g2">
              <Field
                label="Employee type"
                help="Statutory employees have no federal income tax withheld (W-2 box 13). Officers and owners are reported like regular employees."
              >
                <Select name="employmentType" value={rec.employmentType} options={EMPLOYMENT_TYPES} onChange={(v) => set({ employmentType: v as Employee['employmentType'] })} />
              </Field>
            </div>
            {!isNew && (
              <div className="sxp-emp-notice">
                <Info size={15} aria-hidden="true" />
                <span>
                  {rec.hasPaychecks
                    ? `Last paycheck ${fmtDate(rec.lastCheckDate)} · year-to-date gross pay $${fmtMoney(rec.ytdGross)}.`
                    : 'This employee has not been paid yet.'}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </EditDialog>
  );
}
