// Company Payroll Information (Employees > Company Payroll Information): the employer details
// printed on the tax forms (legal name, DBA, address, EIN, the contact who signs), the federal
// deposit schedule and primary state, and the state settings: state withholding and unemployment
// account numbers, the unemployment (SUI) rate of each year and the company rates of the state
// programs (disability, training tax...). Saves PUT /company and PUT /state-settings/{state}.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Building2, Landmark, MapPin, Plus, RefreshCw, UserRound } from 'lucide-react';
import { api } from '@/api/client';
import type { PayrollCompany, StateSettings } from '@/api/types';
import { invalidateAll, queryClient, useCompany, useMeta, useStateSettings } from '@/api/hooks';
import {
  Button,
  EditDialog,
  Field,
  FieldRow,
  RadioGroup,
  Select,
  Spinner,
  StatePicker,
  TextField,
  confirmBox,
  toast,
  useFormErrors,
  type EditDialogSection,
} from '@/components';
import { HelpTip } from '@/components/HelpTip';
import { useOptionalWindow } from '@/windows/WindowContext';
import { useSession } from '@/state/session';
import { StateRatesEditor } from './StateRatesEditor';
import './company.css';

export interface CompanyPayrollDialogProps {
  /** Section to open: company, contact, federal, states. */
  section?: string;
  /** State to select in the state settings. */
  state?: string;
}

const SECTIONS: EditDialogSection[] = [
  { key: 'company', label: 'Company', icon: Building2, fields: ['name', 'legalName', 'tradeName', 'address', 'phone', 'email', 'ein'] },
  { key: 'contact', label: 'Contact person', icon: UserRound, fields: ['contactName', 'contactTitle', 'contactPhone'] },
  { key: 'federal', label: 'Federal & state', icon: MapPin, fields: ['federalDepositSchedule', 'firstPayrollYear', 'primaryState'] },
  { key: 'states', label: 'State settings', icon: Landmark, fields: ['uiRates', 'otherRates', 'withholdingId', 'uiId'] },
];

/** Company fields edited here (sent as a partial PUT /company). */
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
  'firstPayrollYear',
  'primaryState',
];

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export default function CompanyPayrollDialog({ section, state: initialState }: CompanyPayrollDialogProps) {
  const win = useOptionalWindow();
  const isAdmin = useSession((s) => s.isAdmin);
  const cq = useCompany();
  const sq = useStateSettings();
  const meta = useMeta().data;
  const fe = useFormErrors();
  const [tab, setTab] = useState(section ?? 'company');
  const [co, setCo] = useState<PayrollCompany | null>(null);
  const [coBase, setCoBase] = useState<PayrollCompany | null>(null);
  const [states, setStates] = useState<StateSettings[] | null>(null);
  const [statesBase, setStatesBase] = useState<StateSettings[]>([]);
  const [selState, setSelState] = useState<string>(initialState ?? '');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (section) setTab(section);
  }, [section]);
  useEffect(() => {
    if (cq.data && !co) {
      setCo(cq.data);
      setCoBase(cq.data);
    }
  }, [cq.data, co]);
  useEffect(() => {
    if (sq.data && !states) {
      setStates(sq.data);
      setStatesBase(sq.data);
    }
  }, [sq.data, states]);
  useEffect(() => {
    if (!states || !co) return;
    if (!selState || !states.some((s) => s.state === selState)) setSelState(states.find((s) => s.state === co.primaryState)?.state ?? states[0]?.state ?? '');
  }, [states, co, selState]);

  const coDirty = !!co && !!coBase && COMPANY_KEYS.some((k) => !same(co[k], coBase[k]));
  const dirtyStates = useMemo(() => (states ?? []).filter((s) => !same(s, statesBase.find((b) => b.state === s.state))), [states, statesBase]);
  const dirty = coDirty || dirtyStates.length > 0;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  useEffect(() => {
    win?.setDirty(dirty);
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!win) return;
    win.setBeforeClose(async () => (dirtyRef.current ? confirmBox('Discard the changes you made to the company payroll information?', 'Company Payroll Information') : true));
    return () => win.setBeforeClose(null);
  }, [win?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!co || !states) {
    return (
      <div className="cx-dlg" style={{ display: 'grid', placeItems: 'center' }}>
        {cq.error || sq.error ? <span className="cx-muted">{((cq.error ?? sq.error) as Error).message}</span> : <Spinner label="Loading company payroll information..." />}
      </div>
    );
  }

  const ro = !isAdmin;
  const set = (p: Partial<PayrollCompany>) => setCo((c) => (c ? { ...c, ...p } : c));
  const setAddr = (p: Partial<PayrollCompany['address']>) => setCo((c) => (c ? { ...c, address: { ...c.address, ...p } } : c));
  const patchState = (code: string, p: Partial<StateSettings>) => setStates((list) => (list ?? []).map((s) => (s.state === code ? { ...s, ...p } : s)));

  const refresh = async () => {
    // the server saves the SerieX Books values right away (Cancel does not undo it), and blank
    // values in SerieX Books replace what was entered here: always ask first
    if (
      !(await confirmBox(
        'Replace the company name, legal name, address, phone, email and EIN with the information of the SerieX Books company file?\n\nThe payroll information is changed right away, also where SerieX Books has no value.',
        'Company Payroll Information',
      ))
    )
      return;
    setBusy('refresh');
    try {
      const fresh = await api.post<PayrollCompany>('/company/refresh', {});
      // keep what the user changed in the other sections
      setCo((c) => (c ? { ...c, name: fresh.name, legalName: fresh.legalName, address: fresh.address, phone: fresh.phone, email: fresh.email, ein: fresh.ein } : fresh));
      setCoBase((b) => (b ? { ...b, name: fresh.name, legalName: fresh.legalName, address: fresh.address, phone: fresh.phone, email: fresh.email, ein: fresh.ein } : fresh));
      queryClient.setQueryData(['company'], fresh);
      toast('Company information copied from SerieX Books');
    } catch (e) {
      fe.fromError(e);
    } finally {
      setBusy(null);
    }
  };

  const addState = (code: string | null) => {
    if (!code) return;
    if (!states.some((s) => s.state === code)) {
      const name = meta?.states.find((s) => s.code === code)?.name ?? code;
      setStates([...states, { state: code, withholdingId: '', uiId: '', uiRates: {}, otherRates: {}, stateName: name }].sort((a, b) => a.state.localeCompare(b.state)));
    }
    setSelState(code);
  };

  const save = async (): Promise<boolean> => {
    fe.clearAll();
    if (ro) {
      await win?.close(true);
      return true;
    }
    if (!co.name.trim()) {
      fe.setErrors({ name: 'Enter the company name.' });
      setTab('company');
      return false;
    }
    const ein = co.ein.replace(/\D/g, '');
    if (ein && ein.length !== 9) {
      fe.setErrors({ ein: 'The federal employer identification number (EIN) has 9 digits, like 12-3456789.' });
      setTab('company');
      return false;
    }
    setBusy('save');
    try {
      if (coDirty && coBase) {
        const patch: Record<string, unknown> = {};
        for (const k of COMPANY_KEYS) if (!same(co[k], coBase[k])) patch[k] = co[k];
        const saved = await api.put<PayrollCompany>('/company', patch);
        queryClient.setQueryData(['company'], saved);
        setCo(saved);
        setCoBase(saved);
      }
      for (const s of dirtyStates) {
        const saved = await api.put<StateSettings>(`/state-settings/${s.state}`, { withholdingId: s.withholdingId, uiId: s.uiId, uiRates: s.uiRates, otherRates: s.otherRates });
        setStatesBase((b) => [...b.filter((x) => x.state !== s.state), saved]);
      }
      dirtyRef.current = false;
      await useSession.getState().reloadCompany();
      void invalidateAll();
      toast('Company payroll information saved');
      await win?.close(true);
      return true;
    } catch (e) {
      const field = (e as { field?: string }).field;
      if (field && ['uiRates', 'otherRates', 'withholdingId', 'uiId'].includes(field)) setTab('states');
      fe.fromError(e);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const years = (() => {
    const ys = new Set<number>([...(meta?.taxYears ?? []), new Date().getFullYear()]);
    if (co.firstPayrollYear) ys.add(co.firstPayrollYear);
    return Array.from(ys).sort();
  })();
  const sel = states.find((s) => s.state === selState) ?? null;

  return (
    <EditDialog
      title="Company Payroll Information"
      errors={fe}
      sections={SECTIONS}
      section={tab}
      onSectionChange={setTab}
      onOk={save}
      busy={busy === 'save'}
      okLabel={ro ? 'Close' : 'Save and close'}
      navWidth={180}
      footerLeft={
        <span className="cx-muted cx-small">{ro ? 'Only a SerieX Books administrator can change this information.' : 'Printed on the payroll tax forms and pay stubs.'}</span>
      }
    >
      {tab === 'company' && (
        <div className="cx-stack" style={{ gap: 10 }}>
          <div className="cx-row pc-copyrow">
            <span className="cx-muted cx-small">Name, address and tax ID come from the SerieX Books company file when payroll is set up.</span>
            <Button size="sm" icon={RefreshCw} label="Copy from SerieX Books" onClick={() => void refresh()} busy={busy === 'refresh'} disabled={ro} />
          </div>
          <FieldRow>
            <Field label="Company name" required width={290}>
              <TextField name="name" value={co.name} onChange={(v) => set({ name: v })} readOnly={ro} />
            </Field>
            <Field label="Federal employer ID (EIN)" width={170} help="EIN">
              <TextField name="ein" value={co.ein} onChange={(v) => set({ ein: v })} placeholder="12-3456789" readOnly={ro} />
            </Field>
          </FieldRow>
          <FieldRow>
            <Field label="Legal name" width={290} hint="The name the IRS has for your business (Form 941 line “Name”).">
              <TextField name="legalName" value={co.legalName} onChange={(v) => set({ legalName: v })} readOnly={ro} />
            </Field>
            <Field label="Trade name (DBA)" width={170}>
              <TextField name="tradeName" value={co.tradeName} onChange={(v) => set({ tradeName: v })} readOnly={ro} />
            </Field>
          </FieldRow>
          <Field label="Address">
            <div className="cx-stack" style={{ gap: 6 }} data-field="address">
              <TextField name="address1" aria-label="Address line 1" value={co.address.line1} onChange={(v) => setAddr({ line1: v })} readOnly={ro} />
              <TextField name="address2" aria-label="Address line 2" value={co.address.line2} onChange={(v) => setAddr({ line2: v })} readOnly={ro} />
              <div className="cx-row" style={{ gap: 6 }}>
                <TextField name="city" aria-label="City" placeholder="City" value={co.address.city} onChange={(v) => setAddr({ city: v })} readOnly={ro} style={{ flex: '1 1 auto', minWidth: 0 }} />
                <StatePicker name="addrState" aria-label="State" value={co.address.state} onChange={(c) => setAddr({ state: c ?? '' })} width={90} hideName disabled={ro} />
                <TextField name="zip" aria-label="ZIP code" placeholder="ZIP" value={co.address.zip} onChange={(v) => setAddr({ zip: v })} width={110} readOnly={ro} />
              </div>
            </div>
          </Field>
          <FieldRow>
            <Field label="Phone" width={170}>
              <TextField name="phone" value={co.phone} onChange={(v) => set({ phone: v })} readOnly={ro} />
            </Field>
            <Field label="Email" width={290}>
              <TextField name="email" value={co.email} onChange={(v) => set({ email: v })} readOnly={ro} />
            </Field>
          </FieldRow>
        </div>
      )}

      {tab === 'contact' && (
        <div className="cx-stack" style={{ gap: 10 }}>
          <div className="cx-intro" style={{ margin: 0 }}>
            The person who signs the payroll tax forms and whom the tax agencies can call (Form 941 Part 5, W-3, state reports).
          </div>
          <FieldRow>
            <Field label="Name" width={260}>
              <TextField name="contactName" value={co.contactName} onChange={(v) => set({ contactName: v })} readOnly={ro} />
            </Field>
            <Field label="Title" width={200}>
              <TextField name="contactTitle" value={co.contactTitle} onChange={(v) => set({ contactTitle: v })} placeholder="Owner, President..." readOnly={ro} />
            </Field>
          </FieldRow>
          <Field label="Daytime phone" width={200}>
            <TextField name="contactPhone" value={co.contactPhone} onChange={(v) => set({ contactPhone: v })} readOnly={ro} />
          </Field>
        </div>
      )}

      {tab === 'federal' && (
        <div className="cx-checks pc-wraplabels" style={{ gap: 12 }}>
          <div className="cx-section-title">
            Federal tax deposits (Form 941) <HelpTip term="Deposit schedule" size={13} />
          </div>
          <RadioGroup
            name="federalDepositSchedule"
            disabled={ro}
            value={co.federalDepositSchedule}
            onChange={(v) => set({ federalDepositSchedule: v })}
            options={[
              { value: 'monthly', label: 'Monthly: federal withholding, social security and Medicare are due by the 15th of the next month' },
              { value: 'semiweekly', label: 'Semiweekly: due the Wednesday or Friday after each payday' },
            ]}
          />
          <div className="cx-hint" style={{ marginTop: -4 }}>
            The IRS tells you your schedule every year: monthly when you reported $50,000 or less of taxes in the lookback period. Changing it also changes the
            payment schedule of the 941 taxes in Pay Payroll Taxes.
          </div>
          <FieldRow>
            <Field label="State where most employees work" width={290}>
              <Select name="primaryState" value={co.primaryState} disabled={ro} onChange={(v) => set({ primaryState: v })} aria-label="Primary state">
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
            <Field label="First payroll year" width={170}>
              <Select name="firstPayrollYear" value={co.firstPayrollYear} disabled={ro} onChange={(v) => set({ firstPayrollYear: Number(v) })} aria-label="First payroll year">
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </Select>
            </Field>
          </FieldRow>
        </div>
      )}

      {tab === 'states' && (
        <div className="pc-states">
          <div className="pc-statelist" role="tablist" aria-label="States">
            {states.map((s) => (
              <button
                key={s.state}
                type="button"
                role="tab"
                aria-selected={s.state === selState}
                className={'pc-stateitem' + (s.state === selState ? ' pc-on' : '')}
                onClick={() => setSelState(s.state)}
                data-state={s.state}
                title={s.stateName}
              >
                <b>{s.state}</b>
                <span className="cx-muted cx-small cx-ellipsis">{s.stateName}</span>
                {dirtyStates.some((d) => d.state === s.state) && <span className="pc-dot" title="Changed" />}
              </button>
            ))}
            {!ro && (
              <div className="pc-addstate">
                <Plus size={14} className="cx-muted" />
                <StatePicker value={null} onChange={(c) => addState(c)} placeholder="Add a state" aria-label="Add a state" width={150} />
              </div>
            )}
          </div>
          <div className="pc-statedetail">
            {sel ? (
              <StateRatesEditor s={sel} years={years} ro={ro} onChange={(p) => patchState(sel.state, p)} />
            ) : (
              <div className="cx-muted">Add the states where your employees work.</div>
            )}
          </div>
        </div>
      )}
    </EditDialog>
  );
}
