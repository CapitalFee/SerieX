// Payroll Setup interview (Employees > Payroll Setup), after the first page created the payroll
// file (SetupFirstPage, shown before the company opens):
//   2 Company information  employer details for the tax forms, contact, bank account, deposits
//   3 State taxes          state account numbers and the company rates of each year
//   4 Pay schedules        how often employees are paid (New / Edit open the schedule dialog)
//   5 Payroll items        wages, deductions, company contributions and taxes (default items)
//   6 Employees            New / Edit open the employee window
//   7 Year-to-date amounts paychecks and tax payments made this year before using payroll
//   8 Review and finish    what is missing, then PUT /company {setupDone: true}
// The interview can be left at any time (Finish Later) and resumed at the same
// step; the progress is kept in company.setupState ({step, done, ytd}).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Circle, Pencil, Plus, RefreshCw, Sparkles } from 'lucide-react';
import { api } from '@/api/client';
import type { Employee, Id, PaySchedule, PayrollCompany, PayrollItem, PayrollPrefs, StateSettings } from '@/api/types';
import { FREQUENCY_LABELS, ITEM_TYPE_LABELS } from '@/api/types';
import {
  invalidateAll,
  queryClient,
  useBooksStatus,
  useCompany,
  useEmployees,
  useItems,
  useLiabilityPayments,
  useMeta,
  usePaychecks,
  usePaySchedules,
  usePrefs,
  useStateSettings,
} from '@/api/hooks';
import {
  AccountPicker,
  Badge,
  Button,
  ErrorBanner,
  Field,
  FieldRow,
  FormErrorsProvider,
  ListView,
  RadioGroup,
  Select,
  Spinner,
  StatePicker,
  TextField,
  confirmBox,
  msgBox,
  toast,
  useFormErrors,
  type ListColumn,
} from '@/components';
import { useWindow } from '@/windows/WindowContext';
import { openWindow } from '@/windows/windowStore';
import { useSession } from '@/state/session';
import { fmtDate, fmtMoney } from '@/util/format';
import { SETUP_STEPS, SetupRail, WizHead, type SetupStepKey } from './setupSteps';
import { StateRatesEditor } from './StateRatesEditor';
import { errText } from './shared';
import './company.css';

export interface PayrollSetupWizardProps {}

interface SetupState {
  step?: SetupStepKey;
  done?: SetupStepKey[];
  ytd?: 'yes' | 'no';
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const COMPANY_KEYS: (keyof PayrollCompany)[] = [
  'name',
  'legalName',
  'tradeName',
  'address',
  'phone',
  'email',
  'ein',
  'contactName',
  'contactTitle',
  'contactPhone',
  'federalDepositSchedule',
  'primaryState',
];

export default function PayrollSetupWizard(_props: PayrollSetupWizardProps) {
  const w = useWindow();
  const isAdmin = useSession((s) => s.isAdmin);
  const cq = useCompany();
  const pq = usePrefs();
  const sq = useStateSettings();
  const fe = useFormErrors();
  const rootRef = useRef<HTMLDivElement>(null);

  const [step, setStep] = useState<number>(-1);
  const [done, setDone] = useState<SetupStepKey[]>([]);
  const [ytd, setYtd] = useState<'yes' | 'no' | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);

  // page 2 and 3 edit copies
  const [co, setCo] = useState<PayrollCompany | null>(null);
  const [bank, setBank] = useState<Id | null | undefined>(undefined);
  const [states, setStates] = useState<StateSettings[] | null>(null);

  useEffect(() => {
    w.setTitle('Payroll Setup');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // start where the interview was left
  useEffect(() => {
    if (!cq.data || step >= 0) return;
    const s = (cq.data.setupState ?? {}) as SetupState;
    const d = Array.isArray(s.done) ? s.done.filter((k) => SETUP_STEPS.some((x) => x.key === k)) : [];
    setDone(d);
    setYtd(s.ytd === 'yes' || s.ytd === 'no' ? s.ytd : undefined);
    const at = SETUP_STEPS.findIndex((x) => x.key === s.step);
    setStep(cq.data.setupDone ? SETUP_STEPS.length - 1 : at > 0 ? at : 1);
  }, [cq.data, step]);
  useEffect(() => {
    if (cq.data && !co) setCo(cq.data);
  }, [cq.data, co]);
  useEffect(() => {
    if (pq.data && bank === undefined) setBank(pq.data.defaultBankAccountId);
  }, [pq.data, bank]);
  useEffect(() => {
    if (sq.data && !states) setStates(sq.data);
  }, [sq.data, states]);

  const key: SetupStepKey = SETUP_STEPS[Math.max(0, step)]?.key ?? 'company';
  const last = step === SETUP_STEPS.length - 1;
  const setupDone = !!cq.data?.setupDone;

  // unsaved changes of the page being shown (company information, state settings)
  const pageDirty =
    isAdmin &&
    ((key === 'company' &&
      !!co &&
      !!cq.data &&
      (COMPANY_KEYS.some((k) => !same(co[k], cq.data![k])) || (bank !== undefined && !!pq.data && (bank ?? null) !== (pq.data.defaultBankAccountId ?? null)))) ||
      (key === 'state' && !!states && !!sq.data && states.some((x) => !same(x, sq.data!.find((b) => b.state === x.state)))));
  const dirtyRef = useRef(false);
  dirtyRef.current = pageDirty;
  const savePageRef = useRef<() => Promise<boolean>>(async () => true);
  useEffect(() => {
    w.setDirty(pageDirty);
  }, [pageDirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // closing the window with changes on the page: save them (like Finish Later), drop them or stay
    w.setBeforeClose(async () => {
      if (!dirtyRef.current) return true;
      const r = await msgBox({
        title: 'Payroll Setup',
        icon: 'question',
        message: 'Save the changes you made on this page of Payroll Setup?',
        buttons: ['&Yes', '&No', 'Cancel'],
      });
      if (r === 'No') return true;
      if (r !== 'Yes') return false;
      try {
        return await savePageRef.current();
      } catch (e) {
        fe.fromError(e);
        return false;
      }
    });
    return () => w.setBeforeClose(null);
  }, [w.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Saves the progress (step, done steps, YTD answer) in company.setupState. */
  const saveProgress = async (next: SetupState) => {
    if (!isAdmin) return;
    const cur = (cq.data?.setupState ?? {}) as SetupState;
    const merged = { ...cur, ...next };
    if (same(merged, cur)) return;
    const saved = await api.put<PayrollCompany>('/company', { setupState: merged }, { noPrompt: true });
    queryClient.setQueryData(['company'], saved);
  };

  /** Saves the page being left (company information, state settings). Returns false to stay. */
  const savePage = async (): Promise<boolean> => {
    fe.clearAll();
    if (!isAdmin) return true;
    if (key === 'company' && co && cq.data) {
      if (!co.name.trim()) {
        fe.setErrors({ name: 'Enter the company name.' });
        return false;
      }
      const ein = co.ein.replace(/\D/g, '');
      if (ein && ein.length !== 9) {
        fe.setErrors({ ein: 'The federal employer identification number (EIN) has 9 digits, like 12-3456789.' });
        return false;
      }
      const patch: Record<string, unknown> = {};
      for (const k of COMPANY_KEYS) if (!same(co[k], cq.data[k])) patch[k] = co[k];
      if (Object.keys(patch).length) {
        const saved = await api.put<PayrollCompany>('/company', patch);
        queryClient.setQueryData(['company'], saved);
        setCo(saved);
      }
      if (bank !== undefined && pq.data && (bank ?? null) !== (pq.data.defaultBankAccountId ?? null)) {
        const saved = await api.put<PayrollPrefs>('/prefs', { defaultBankAccountId: bank });
        queryClient.setQueryData(['prefs'], saved);
      }
    }
    if (key === 'state' && states && sq.data) {
      for (const s of states) {
        const before = sq.data.find((b) => b.state === s.state);
        if (same(s, before)) continue;
        const saved = await api.put<StateSettings>(`/state-settings/${s.state}`, { withholdingId: s.withholdingId, uiId: s.uiId, uiRates: s.uiRates, otherRates: s.otherRates });
        setStates((cur) => (cur ?? []).map((x) => (x.state === saved.state ? saved : x)));
      }
      await queryClient.invalidateQueries({ queryKey: ['state-settings'] });
    }
    return true;
  };

  savePageRef.current = async () => {
    const ok = await savePage();
    if (ok) {
      dirtyRef.current = false;
      await saveProgress({ step: key, done, ytd });
    }
    return ok;
  };

  const goto = async (i: number, markDone = false) => {
    if (i === step || busy) return;
    setBusy('page');
    try {
      if (!(await savePage())) return;
      const d = markDone && !done.includes(key) ? [...done, key] : done;
      setDone(d);
      setStep(i);
      await saveProgress({ step: SETUP_STEPS[i].key, done: d, ytd });
      rootRef.current?.querySelector('.cx-wiz-body')?.scrollTo({ top: 0 });
    } catch (e) {
      fe.fromError(e);
    } finally {
      setBusy(null);
    }
  };

  const finishLater = async () => {
    setBusy('later');
    try {
      if (await savePage()) {
        await saveProgress({ step: key, done, ytd });
        void invalidateAll();
        await w.close(true);
      }
    } catch (e) {
      fe.fromError(e);
    } finally {
      setBusy(null);
    }
  };

  const finish = async () => {
    setBusy('finish');
    try {
      const all = SETUP_STEPS.map((s) => s.key);
      const saved = await api.put<PayrollCompany>('/company', { setupDone: true, setupState: { step: 'review', done: all, ytd: ytd ?? 'no' } });
      queryClient.setQueryData(['company'], saved);
      await useSession.getState().reloadCompany();
      void invalidateAll();
      await w.close(true);
      openWindow('home');
      toast(setupDone ? 'Payroll setup saved.' : 'Payroll setup is finished. You are ready to pay your employees.', {
        kind: 'success',
        duration: 8000,
        action: { label: 'Payroll Center', onClick: () => openWindow('employeeCenter', { tab: 'payroll' }) },
      });
    } catch (e) {
      fe.fromError(e);
    } finally {
      setBusy(null);
    }
  };

  if (step < 0 || !co || !states) {
    return (
      <div className="cx-dlg" style={{ display: 'grid', placeItems: 'center' }}>
        {cq.error || sq.error ? <span className="cx-muted">{errText(cq.error ?? sq.error)}</span> : <Spinner label="Loading Payroll Setup..." />}
      </div>
    );
  }

  return (
    <FormErrorsProvider value={fe}>
      <div className="cx-wizard pc-setup" ref={rootRef} data-step={key}>
        <SetupRail
          current={step}
          done={(k) => k === 'file' || done.includes(k) || setupDone}
          onGo={(i) => void goto(i)}
          disabled={(k) => k === 'file' || !!busy}
          footer={setupDone ? 'Payroll setup is finished. You can come back here at any time.' : 'You can leave with Finish Later and continue where you stopped.'}
        />
        <div className="cx-wiz-main">
          <div className="cx-wiz-body">
            {(fe.message || Object.keys(fe.errors).length > 0) && <ErrorBanner errors={fe.errors} message={fe.message} root={rootRef.current} onDismiss={() => fe.clearAll()} />}
            {!isAdmin && <div className="cx-note cx-warn">Only a SerieX Books administrator can change the payroll setup. You can look at each step.</div>}
            {key === 'company' && <CompanyPage co={co} setCo={setCo} bank={bank ?? null} setBank={setBank} ro={!isAdmin} />}
            {key === 'state' && <StatePage states={states} setStates={setStates} primary={co.primaryState} firstYear={co.firstPayrollYear} ro={!isAdmin} />}
            {key === 'schedules' && <SchedulesPage />}
            {key === 'items' && <ItemsPage state={co.primaryState} year={co.firstPayrollYear} ro={!isAdmin} />}
            {key === 'employees' && <EmployeesPage />}
            {key === 'ytd' && <YtdPage ytd={ytd} setYtd={setYtd} />}
            {key === 'review' && <ReviewPage ytd={ytd} goto={(k) => void goto(SETUP_STEPS.findIndex((s) => s.key === k))} />}
          </div>
          <div className="cx-dlg-foot">
            <div className="cx-grow cx-muted cx-small">
              Step {step + 1} of {SETUP_STEPS.length}
            </div>
            {!last && (
              <Button
                label={setupDone ? 'Save and Close' : 'Finish Later'}
                onClick={() => void finishLater()}
                busy={busy === 'later'}
                disabled={!!busy}
                title={setupDone ? undefined : 'Save this page and continue Payroll Setup later from Employees > Payroll Setup'}
              />
            )}
            {step > 1 && <Button label="Back" onClick={() => void goto(step - 1)} disabled={!!busy} />}
            {last ? (
              isAdmin ? (
                <Button variant="primary" label={setupDone ? 'Done' : 'Finish'} onClick={() => void finish()} busy={busy === 'finish'} disabled={!!busy} />
              ) : (
                <Button variant="primary" label="Close" onClick={() => void w.close(true)} />
              )
            ) : (
              <Button variant="primary" label="Continue" onClick={() => void goto(step + 1, true)} busy={busy === 'page'} disabled={!!busy} />
            )}
          </div>
        </div>
      </div>
    </FormErrorsProvider>
  );
}

// ---------------------------------------------------------------------------
// 2 Company information

function CompanyPage({ co, setCo, bank, setBank, ro }: { co: PayrollCompany; setCo: (c: PayrollCompany) => void; bank: Id | null; setBank: (id: Id | null) => void; ro: boolean }) {
  const meta = useMeta().data;
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<PayrollCompany>) => setCo({ ...co, ...p });
  const setAddr = (p: Partial<PayrollCompany['address']>) => setCo({ ...co, address: { ...co.address, ...p } });
  const refresh = async () => {
    if (
      !(await confirmBox(
        'Replace the company name, legal name, address, phone, email and EIN with the information of the SerieX Books company file?\n\nThe payroll information is changed right away, also where SerieX Books has no value.',
        'Payroll Setup',
      ))
    )
      return;
    setBusy(true);
    try {
      const fresh = await api.post<PayrollCompany>('/company/refresh', {});
      queryClient.setQueryData(['company'], fresh);
      setCo({ ...co, name: fresh.name, legalName: fresh.legalName, address: fresh.address, phone: fresh.phone, email: fresh.email, ein: fresh.ein });
      toast('Company information copied from SerieX Books');
    } catch (e) {
      toast(errText(e), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <WizHead title="Company information" sub="The employer details printed on the tax forms, W-2s and pay stubs, and the account payroll pays from." />
      <div className="cx-row">
        <span className="cx-muted cx-small cx-spacer">Name, address and tax ID were copied from the SerieX Books company file.</span>
        <Button size="sm" icon={RefreshCw} label="Copy from SerieX Books again" onClick={() => void refresh()} busy={busy} disabled={ro} />
      </div>
      <FieldRow>
        <Field label="Company name" required width={290}>
          <TextField name="name" value={co.name} onChange={(v) => set({ name: v })} readOnly={ro} />
        </Field>
        <Field label="Legal name" width={250} hint="As the IRS knows your business.">
          <TextField name="legalName" value={co.legalName} onChange={(v) => set({ legalName: v })} readOnly={ro} />
        </Field>
        <Field label="Federal employer ID (EIN)" width={170} help="EIN">
          <TextField name="ein" value={co.ein} onChange={(v) => set({ ein: v })} placeholder="12-3456789" readOnly={ro} />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="Address" width={290}>
          <div className="cx-stack" style={{ gap: 6 }} data-field="address">
            <TextField name="address1" aria-label="Address line 1" value={co.address.line1} onChange={(v) => setAddr({ line1: v })} readOnly={ro} />
            <TextField
              name="address2"
              aria-label="Address line 2"
              placeholder="Suite, floor (optional)"
              value={co.address.line2}
              onChange={(v) => setAddr({ line2: v })}
              readOnly={ro}
            />
          </div>
        </Field>
        <Field label="City" width={160}>
          <TextField name="city" value={co.address.city} onChange={(v) => setAddr({ city: v })} readOnly={ro} />
        </Field>
        <Field label="State" width={86}>
          <StatePicker name="addrState" value={co.address.state} onChange={(c) => setAddr({ state: c ?? '' })} hideName disabled={ro} aria-label="Address state" />
        </Field>
        <Field label="ZIP" width={100}>
          <TextField name="zip" value={co.address.zip} onChange={(v) => setAddr({ zip: v })} readOnly={ro} />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label="Contact name (signs the forms)" width={290}>
          <TextField name="contactName" value={co.contactName} onChange={(v) => set({ contactName: v })} readOnly={ro} />
        </Field>
        <Field label="Title" width={160}>
          <TextField name="contactTitle" value={co.contactTitle} onChange={(v) => set({ contactTitle: v })} readOnly={ro} />
        </Field>
        <Field label="Phone" width={196}>
          <TextField name="contactPhone" value={co.contactPhone} onChange={(v) => set({ contactPhone: v })} readOnly={ro} />
        </Field>
      </FieldRow>
      <div className="cx-section-title">Paying</div>
      <FieldRow>
        <Field label="Bank account for paychecks and tax payments" width={290}>
          <AccountPicker name="defaultBankAccountId" types={['Bank']} value={bank} onChange={(id) => setBank(id)} quickCreate={false} disabled={ro} placeholder="Choose a bank account" />
        </Field>
        <Field label="Federal deposit schedule (941)" help="Deposit schedule" width={250}>
          <RadioGroup
            row
            name="federalDepositSchedule"
            disabled={ro}
            value={co.federalDepositSchedule}
            onChange={(v) => set({ federalDepositSchedule: v })}
            options={[
              { value: 'monthly', label: 'Monthly' },
              { value: 'semiweekly', label: 'Semiweekly' },
            ]}
          />
        </Field>
        <Field label="Main state" width={160}>
          <Select name="primaryState" value={co.primaryState} disabled={ro} onChange={(v) => set({ primaryState: v })} aria-label="Main state">
            {(meta?.states ?? [])
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
          </Select>
        </Field>
      </FieldRow>
    </>
  );
}

// ---------------------------------------------------------------------------
// 3 State taxes

function StatePage({ states, setStates, primary, firstYear, ro }: { states: StateSettings[]; setStates: (s: StateSettings[]) => void; primary: string; firstYear: number; ro: boolean }) {
  const meta = useMeta().data;
  const list = states.length ? states : [{ state: primary, withholdingId: '', uiId: '', uiRates: {}, otherRates: {}, stateName: primary }];
  const years = useMemo(() => {
    const ys = new Set<number>([firstYear || new Date().getFullYear(), new Date().getFullYear()]);
    return Array.from(ys).sort();
  }, [firstYear]);
  const [sel, setSel] = useState(list.find((s) => s.state === primary)?.state ?? list[0]?.state ?? '');
  const cur = list.find((s) => s.state === sel) ?? list[0];
  const info = meta?.states.find((s) => s.code === cur?.state);
  const patch = (p: Partial<StateSettings>) => setStates(list.map((s) => (s.state === cur.state ? { ...s, ...p } : s)));
  return (
    <>
      <WizHead
        title="State taxes"
        sub="Enter the account numbers the state gave you and your unemployment rate. A blank rate uses the standard rate shown in gray; you can change it later in Company Payroll Information."
      />
      {list.length > 1 && (
        <div className="cx-row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {list.map((s) => (
            <Button key={s.state} size="sm" variant={s.state === cur.state ? 'primary' : 'secondary'} label={s.stateName || s.state} onClick={() => setSel(s.state)} />
          ))}
        </div>
      )}
      {info && (
        <div className="cx-note cx-info cx-small">
          {info.name}: {info.hasIncomeTax ? `state income tax is withheld; employees fill in ${info.stateForm || 'the federal Form W-4'}` : 'no state income tax on wages'}
          {info.programs.length ? `; other state taxes: ${info.programs.map((p) => p.label).join(', ')}` : ''}
          {info.hasEmployeeSui ? '; employees also pay unemployment tax' : ''}.
        </div>
      )}
      {cur && <StateRatesEditor s={cur} years={years} ro={ro} onChange={patch} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// 4 Pay schedules

function SchedulesPage() {
  const q = usePaySchedules({ active: 'all' });
  const [sel, setSel] = useState<Id | null>(null);
  const cols: ListColumn<PaySchedule>[] = [
    { key: 'name', label: 'Pay schedule', width: 180, grow: true },
    { key: 'frequency', label: 'How often', width: 120, render: (s) => FREQUENCY_LABELS[s.frequency] ?? s.frequency },
    { key: 'nextPeriodEnd', label: 'Next pay period ends', width: 180, type: 'date' },
    { key: 'nextCheckDate', label: 'Next check date', width: 130, type: 'date' },
    { key: 'employeeCount', label: 'Employees', width: 90, align: 'right' },
  ];
  return (
    <>
      <WizHead
        title="Pay schedules"
        sub="A pay schedule says how often employees are paid, when the next pay period ends and when its paychecks are dated. The Payroll Center lists the payrolls of each schedule when they are due."
      />
      <div className="cx-row" style={{ gap: 6 }}>
        <Button size="sm" icon={Plus} label="New pay schedule..." onClick={() => openWindow('payScheduleEdit', {})} />
        <Button size="sm" icon={Pencil} label="Edit..." disabled={!sel} onClick={() => sel && openWindow('payScheduleEdit', { id: sel })} />
      </div>
      <ListView<PaySchedule>
        columns={cols}
        rows={q.data ?? []}
        selectedKey={sel}
        onSelect={(k) => setSel(Number(k))}
        onActivate={(s) => openWindow('payScheduleEdit', { id: s.id })}
        isInactive={(s) => !s.active}
        loading={q.isLoading}
        emptyText="No pay schedules yet. Click New pay schedule."
        className="pc-setup-list"
        aria-label="Pay schedules"
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// 5 Payroll items

/** True when the item lacks an account it needs to be posted to SerieX Books. */
function missingAccount(i: PayrollItem): string {
  const exp = ['earning', 'addition', 'contribution', 'employer_tax'].includes(i.category);
  const liab = ['deduction', 'contribution', 'employer_tax', 'employee_tax'].includes(i.category);
  if (exp && !i.expenseAccountId && !i.notPaid) return 'No expense account';
  if (liab && !i.liabilityAccountId) return 'No liability account';
  return '';
}

function ItemsPage({ state, year, ro }: { state: string; year: number; ro: boolean }) {
  const q = useItems({ active: 'active' });
  const [sel, setSel] = useState<Id | null>(null);
  const [busy, setBusy] = useState(false);
  const items = q.data ?? [];
  const problems = items.filter((i) => missingAccount(i));
  const addDefaults = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ created: number; warnings?: string[] }>('/items/defaults', { state, year: year || undefined });
      await queryClient.invalidateQueries({ queryKey: ['items'] });
      toast(r.created ? `${r.created} payroll item${r.created === 1 ? ' was' : 's were'} added.` : 'Every default payroll item already exists.', { kind: 'info' });
      if (r.warnings?.length) toast(r.warnings.join('\n'), { kind: 'warning', duration: 10000 });
    } catch (e) {
      toast(errText(e), { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const cols: ListColumn<PayrollItem>[] = [
    { key: 'name', label: 'Item name', width: 200, grow: true },
    { key: 'type', label: 'Type', width: 140, render: (i) => ITEM_TYPE_LABELS[i.type] ?? i.type },
    { key: 'rate', label: 'Amount', width: 90, align: 'right', render: (i) => (i.rate ? (i.calc === 'percent' || i.calc === 'match' ? `${i.rate}%` : i.type === 'overtime' ? `${i.rate}x` : fmtMoney(i.rate)) : '') },
    { key: 'expenseAccountName', label: 'Expense account', width: 170 },
    { key: 'liabilityAccountName', label: 'Liability account', width: 190 },
    { key: 'agencyName', label: 'Payable to', width: 170 },
    {
      key: 'problem',
      label: '',
      width: 140,
      sortable: false,
      render: (i) => {
        const m = missingAccount(i);
        return m ? <span className="pc-problem">{m}</span> : null;
      },
    },
  ];
  return (
    <>
      <WizHead
        title="Payroll items"
        sub="Payroll items are everything on a paycheck: wages, bonuses, deductions, company contributions and taxes. Setup created the usual ones with their SerieX Books accounts. Review them, change what you need, and add your own."
      />
      <div className="cx-row" style={{ gap: 6 }}>
        <Button size="sm" icon={Plus} label="New payroll item..." onClick={() => openWindow('payrollItemEdit', {})} disabled={ro} />
        <Button size="sm" icon={Pencil} label="Edit..." disabled={!sel} onClick={() => sel && openWindow('payrollItemEdit', { id: sel })} />
        <Button size="sm" icon={Sparkles} label="Add missing default items" onClick={() => void addDefaults()} busy={busy} disabled={ro} />
        <span className="cx-spacer" />
        <span className="cx-small cx-muted">{items.length} items</span>
      </div>
      {problems.length > 0 && (
        <div className="cx-note cx-warn cx-small">
          <AlertCircle size={15} />
          <span>
            {problems.length} item{problems.length === 1 ? ' has' : 's have'} no SerieX Books account yet ({problems.map((p) => p.name).slice(0, 4).join(', ')}
            {problems.length > 4 ? '...' : ''}). Paychecks using {problems.length === 1 ? 'it' : 'them'} cannot be posted until you choose the account.
          </span>
        </div>
      )}
      <ListView<PayrollItem>
        columns={cols}
        rows={items}
        selectedKey={sel}
        onSelect={(k) => setSel(Number(k))}
        onActivate={(i) => openWindow('payrollItemEdit', { id: i.id })}
        loading={q.isLoading}
        emptyText="No payroll items yet. Click Add missing default items."
        className="pc-setup-list"
        aria-label="Payroll items"
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// 6 Employees

function EmployeesPage() {
  const q = useEmployees({ active: 'all' });
  const [sel, setSel] = useState<Id | null>(null);
  const cols: ListColumn<Employee>[] = [
    { key: 'displayName', label: 'Employee', width: 190, grow: true },
    { key: 'ssn', label: 'SSN', width: 120, render: (e) => (e.ssnOnFile ? e.ssn : <span className="pc-problem">Missing</span>) },
    { key: 'payScheduleName', label: 'Pay schedule', width: 130, render: (e) => e.payScheduleName || FREQUENCY_LABELS[e.payFrequency] },
    {
      key: 'pay',
      label: 'Pay',
      width: 130,
      align: 'right',
      render: (e) => (e.annualSalary ? `${fmtMoney(e.annualSalary)} / year` : e.hourlyRate ? `${fmtMoney(e.hourlyRate)} / hour` : <span className="cx-muted">—</span>),
      sortValue: (e) => e.annualSalary || e.hourlyRate,
    },
    { key: 'workState', label: 'State', width: 60 },
    { key: 'hireDate', label: 'Hire date', width: 100, type: 'date' },
  ];
  const rows = q.data ?? [];
  return (
    <>
      <WizHead
        title="Employees"
        sub="Add each employee with the information from their Form W-4 and state withholding form, how you pay them, and their deductions and sick and vacation hours."
      />
      <div className="cx-row" style={{ gap: 6 }}>
        <Button size="sm" icon={Plus} label="New employee..." onClick={() => openWindow('employeeEdit', {})} />
        <Button size="sm" icon={Pencil} label="Edit..." disabled={!sel} onClick={() => sel && openWindow('employeeEdit', { id: sel })} />
        <Button size="sm" label="Employee defaults..." onClick={() => openWindow('employeeDefaults')} />
        <span className="cx-spacer" />
        <span className="cx-small cx-muted">
          {rows.filter((e) => e.active).length} active employee{rows.filter((e) => e.active).length === 1 ? '' : 's'}
        </span>
      </div>
      <ListView<Employee>
        columns={cols}
        rows={rows}
        selectedKey={sel}
        onSelect={(k) => setSel(Number(k))}
        onActivate={(e) => openWindow('employeeEdit', { id: e.id })}
        isInactive={(e) => !e.active}
        loading={q.isLoading}
        emptyText="No employees yet. Click New employee."
        className="pc-setup-list"
        aria-label="Employees"
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// 7 Year-to-date amounts

function YtdPage({ ytd, setYtd }: { ytd: 'yes' | 'no' | undefined; setYtd: (v: 'yes' | 'no') => void }) {
  const year = new Date().getFullYear();
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const emps = useEmployees({ active: 'all' });
  const pcs = usePaychecks({ from, to, kind: 'ytd' });
  const prior = useLiabilityPayments({ from, to, kind: 'prior' });
  const byEmp = useMemo(() => {
    const m = new Map<Id, { count: number; gross: number }>();
    for (const p of pcs.data ?? []) {
      if (p.voided) continue;
      const c = m.get(p.employeeId) ?? { count: 0, gross: 0 };
      c.count++;
      c.gross += p.gross;
      m.set(p.employeeId, c);
    }
    return m;
  }, [pcs.data]);
  const priorList = (prior.data ?? []).filter((p) => !p.voided);
  const cols: ListColumn<Employee>[] = [
    { key: 'displayName', label: 'Employee', width: 220, grow: true },
    { key: 'entered', label: 'Quarters', width: 100, align: 'right', render: (e) => byEmp.get(e.id)?.count ?? 0, sortValue: (e) => byEmp.get(e.id)?.count ?? 0 },
    { key: 'gross', label: 'Gross pay entered', width: 150, align: 'right', render: (e) => fmtMoney(byEmp.get(e.id)?.gross ?? 0) },
    {
      key: 'action',
      label: '',
      width: 170,
      sortable: false,
      render: (e) => (
        <button type="button" className="sx-linkbtn cx-small" onClick={() => openWindow('ytdSetup', { employeeId: e.id })}>
          Enter amounts...
        </button>
      ),
    },
  ];
  return (
    <>
      <WizHead
        title="Year-to-date amounts"
        sub={`Paychecks and tax payments made in ${year} before you started using SerieX Payroll count for the wage limits, the tax forms and the W-2s, so enter them now. They are not posted to SerieX Books.`}
      />
      <Field label={`Have you paid employees in ${year} before using SerieX Payroll?`}>
        <RadioGroup
          name="ytd"
          value={ytd ?? ''}
          onChange={(v) => setYtd(v as 'yes' | 'no')}
          options={[
            { value: 'no', label: 'No, this is our first payroll this year' },
            { value: 'yes', label: 'Yes, we paid employees earlier this year (by hand, with an accountant or another payroll service)' },
          ]}
        />
      </Field>
      {ytd === 'yes' && (
        <>
          <div className="cx-section-title">Paychecks paid earlier this year</div>
          <div className="cx-row" style={{ gap: 6 }}>
            <Button size="sm" label="Enter Year-to-Date Amounts..." onClick={() => openWindow('ytdSetup', {})} />
            <span className="cx-hint">Enter the totals of each quarter for every employee: wages, taxes withheld, deductions and company taxes.</span>
          </div>
          <ListView<Employee>
            columns={cols}
            rows={(emps.data ?? []).filter((e) => e.active || byEmp.has(e.id))}
            onActivate={(e) => openWindow('ytdSetup', { employeeId: e.id })}
            loading={emps.isLoading}
            emptyText="Add your employees first (previous step)."
            className="pc-setup-list pc-setup-short"
            aria-label="Year-to-date amounts by employee"
          />
          <div className="cx-section-title">Tax payments made earlier this year</div>
          <div className="cx-row" style={{ gap: 8 }}>
            <Button size="sm" label="Record Earlier Tax Payments..." onClick={() => openWindow('priorPayments')} />
            <span className="cx-small">
              {priorList.length === 0
                ? 'No earlier tax payments entered yet.'
                : `${priorList.length} earlier tax payment${priorList.length === 1 ? '' : 's'} entered, ${fmtMoney(priorList.reduce((s, p) => s + p.amount, 0))} in total.`}
            </span>
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 8 Review and finish

interface Check {
  ok: boolean | 'warn';
  label: ReactNode;
  step?: SetupStepKey;
}

function ReviewPage({ ytd, goto }: { ytd: 'yes' | 'no' | undefined; goto: (k: SetupStepKey) => void }) {
  const co = useCompany().data;
  const prefs = usePrefs().data;
  const meta = useMeta().data;
  const states = useStateSettings().data ?? [];
  const schedules = usePaySchedules({ active: 'active' }).data;
  const items = useItems({ active: 'active' }).data;
  const emps = useEmployees({ active: 'active' }).data;
  const books = useBooksStatus().data;
  const year = new Date().getFullYear();
  const ytdPcs = usePaychecks({ from: `${year}-01-01`, to: `${year}-12-31`, kind: 'ytd' }).data;
  if (!co || !schedules || !items || !emps) return <Spinner label="Checking your setup..." />;
  const st = states.find((s) => s.state === co.primaryState);
  const info = meta?.states.find((s) => s.code === co.primaryState);
  const noAcct = items.filter((i) => missingAccount(i));
  const noSchedule = emps.filter((e) => !e.payScheduleId);
  const noSsn = emps.filter((e) => !e.ssnOnFile);
  const checks: Check[] = [
    { ok: !!co.ein, label: co.ein ? `Federal employer ID ${co.ein}` : 'Enter your federal employer ID (EIN): it is required on every tax form.', step: 'company' },
    { ok: !!(co.address.line1 && co.address.city && co.address.zip), label: co.address.line1 ? 'Company address entered' : 'Enter the company address.', step: 'company' },
    { ok: co.contactName ? true : 'warn', label: co.contactName ? `Forms are signed by ${co.contactName}` : 'Enter the contact person who signs the tax forms.', step: 'company' },
    { ok: !!prefs?.defaultBankAccountId, label: prefs?.defaultBankAccountId ? 'Bank account for paychecks chosen' : 'Choose the bank account paychecks are written from.', step: 'company' },
    ...(info?.hasIncomeTax
      ? [{ ok: st?.withholdingId ? true : ('warn' as const), label: st?.withholdingId ? `${info.name} withholding account ${st.withholdingId}` : `Enter your ${info.name} withholding account number.`, step: 'state' as const }]
      : []),
    { ok: st?.uiId ? true : 'warn', label: st?.uiId ? `${info?.name ?? co.primaryState} unemployment account ${st.uiId}` : `Enter your ${info?.name ?? co.primaryState} unemployment account number.`, step: 'state' },
    { ok: schedules.length > 0, label: schedules.length ? `${schedules.length} pay schedule${schedules.length === 1 ? '' : 's'}` : 'Create a pay schedule.', step: 'schedules' },
    {
      ok: items.length > 0 && noAcct.length === 0 ? true : items.length ? 'warn' : false,
      label: noAcct.length ? `${noAcct.length} payroll item${noAcct.length === 1 ? ' has' : 's have'} no SerieX Books account.` : `${items.length} payroll items`,
      step: 'items',
    },
    { ok: emps.length > 0, label: emps.length ? `${emps.length} active employee${emps.length === 1 ? '' : 's'}` : 'Add your employees.', step: 'employees' },
    ...(noSchedule.length ? [{ ok: 'warn' as const, label: `${noSchedule.length} employee${noSchedule.length === 1 ? ' has' : 's have'} no pay schedule (paid with extra paychecks only).`, step: 'employees' as const }] : []),
    ...(noSsn.length ? [{ ok: 'warn' as const, label: `${noSsn.length} employee${noSsn.length === 1 ? ' has' : 's have'} no social security number (needed for the W-2).`, step: 'employees' as const }] : []),
    {
      ok: ytd === 'no' ? true : ytd === 'yes' ? ((ytdPcs?.length ?? 0) > 0 ? true : 'warn') : false,
      label:
        ytd === 'no'
          ? 'No paychecks earlier this year'
          : ytd === 'yes'
            ? (ytdPcs?.length ?? 0) > 0
              ? `${ytdPcs?.length} year-to-date quarter${ytdPcs?.length === 1 ? '' : 's'} entered`
              : 'Enter the year-to-date amounts of your employees.'
            : 'Tell us whether you paid employees earlier this year.',
      step: 'ytd',
    },
    {
      ok: books ? (books.reachable && books.sessionOk ? true : 'warn') : 'warn',
      label: books ? (books.reachable && books.sessionOk ? `Connected to SerieX Books (${books.companyName})` : books.message) : 'Checking the link to SerieX Books...',
    },
  ];
  const blocking = checks.filter((c) => c.ok === false).length;
  const warns = checks.filter((c) => c.ok === 'warn').length;
  return (
    <>
      <WizHead
        title="Review and finish"
        sub={
          blocking
            ? `${blocking} thing${blocking === 1 ? ' needs' : 's need'} your attention before your first payroll. You can finish now and complete ${blocking === 1 ? 'it' : 'them'} later.`
            : warns
              ? 'Your payroll is ready. A few details are still missing; you can add them now or later.'
              : co.setupDone
                ? 'Payroll setup is finished. Pay your employees from the Payroll Center.'
                : 'Everything is set up. Click Finish, then pay your employees from the Payroll Center.'
        }
      />
      <ul className="pc-review">
        {checks.map((c, i) => (
          <li key={i} className={c.ok === true ? 'pc-ok' : c.ok === 'warn' ? 'pc-warn' : 'pc-no'}>
            {c.ok === true ? (
              <CheckCircle2 size={17} color="var(--sx-success)" />
            ) : c.ok === 'warn' ? (
              <AlertCircle size={17} color="var(--sx-warning)" />
            ) : (
              <Circle size={17} color="var(--sx-danger)" />
            )}
            <span className="pc-review-text">{c.label}</span>
            {c.step && c.ok !== true && (
              <button type="button" className="sx-linkbtn cx-small" onClick={() => goto(c.step!)}>
                Fix
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="cx-hint">
        After you finish, the Home page and the Payroll Center show your next payroll. Change any of this later in Company Payroll Information, Payroll Items
        and the Employee Center.{' '}
        {co.setupDone && (
          <Badge tone="success" dot>
            Setup finished
          </Badge>
        )}
      </div>
      {co.firstPayrollYear && <div className="cx-hint">First payroll year: {co.firstPayrollYear}. First check date of the schedule: {fmtDate(schedules[0]?.nextCheckDate ?? '')}.</div>}
    </>
  );
}
