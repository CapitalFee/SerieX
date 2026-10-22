// "Taxes for <employee>" dialog (Payroll Info > Taxes...): Federal (Form W-4 2020 or later /
// 2019 or earlier, exempt, nonresident alien, subject to Medicare / social security / FUTA),
// State (state worked, SUI / SDI, the state certificate: filing status from the tax tables,
// allowances, extra withholding, exempt, and the state specific inputs) and Other (local and
// other taxes). The Employee Defaults window uses the State part only ("Taxes Defaults").
import { useState } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { useMeta } from '@/api/hooks';
import type { EmployeeItem, StateInfo, StateW4, W4 } from '@/api/types';
import { Button, Checkbox, Field, FieldRow, GroupBox, MoneyField, NumberField, Select, StatePicker, Tabs, confirmBox, showDialog } from '@/components';
import { todayIso } from '@/util/dates';
import { fmtDate } from '@/util/format';
import { OtherTaxesGrid, realLines } from './EmployeeItemsGrids';

/** What the Taxes dialog edits. */
export interface TaxesValue {
  w4: W4;
  subjectSs: boolean;
  subjectMedicare: boolean;
  subjectFuta: boolean;
  workState: string;
  stateW4: StateW4;
  subjectSui: boolean;
  subjectSdi: boolean;
  /** The employee's Other Tax items (Taxes > Other). */
  otherTaxes: EmployeeItem[];
}

/** Options of {@link editTaxes}. */
export interface EditTaxesOptions {
  /** Employee name for the title ("Taxes for Ann Lee"). */
  name: string;
  value: TaxesValue;
  /** Employee Defaults: only the state worked and SUI / SDI ("Taxes Defaults"). */
  defaultsMode?: boolean;
  /** Tab to show first. */
  tab?: 'federal' | 'state' | 'other';
}

/** Shows the Taxes dialog; resolves with the changed values, or null on Cancel. */
export function editTaxes(opts: EditTaxesOptions): Promise<TaxesValue | null> {
  return showDialog<TaxesValue | null>({
    title: opts.defaultsMode ? 'Taxes Defaults' : `Taxes for ${opts.name || 'New Employee'}`,
    width: 660,
    cancelValue: null,
    render: (close) => <TaxesForm opts={opts} onDone={close} />,
  });
}

/** Date an exempt Form W-4 given in `year` expires (February 15 of the next year). */
export function exemptExpiry(year: number): string {
  return `${year + 1}-02-15`;
}

/** Read-only year of an exempt Form W-4 with its expiry date (and "renew" once it expired). */
function ExemptYearInfo({ year, today, onRenew }: { year: number; today: string; onRenew(): void }) {
  const expires = exemptExpiry(year);
  const expired = today > expires;
  const thisYear = +today.slice(0, 4);
  return (
    <div className={'sxp-emp-notice' + (expired ? ' sxp-warn' : '')} data-field="w4.exemptYear">
      {expired ? <AlertTriangle size={15} aria-hidden="true" /> : <Info size={15} aria-hidden="true" />}
      <span>
        <span className="sxp-emp-exyear">
          Exemption claimed for <b>{year}</b>.
        </span>{' '}
        {expired
          ? `It expired on ${fmtDate(expires)}: paychecks withhold federal income tax as Single with no adjustments until the employee gives you a new Form W-4.`
          : `It expires on ${fmtDate(expires)}; the employee must give you a new Form W-4 by then to stay exempt.`}
        {expired && year < thisYear && (
          <>
            {' '}
            <button type="button" className="sx-linkbtn" onClick={onRenew}>
              The employee gave a new exempt Form W-4 for {thisYear}
            </button>
          </>
        )}
      </span>
    </div>
  );
}

const NRA_OPTIONS = [
  { value: 'no', label: 'Does not apply' },
  { value: 'yes', label: 'Nonresident alien withholding applies' },
];

function TaxesForm({ opts, onDone }: { opts: EditTaxesOptions; onDone(v: TaxesValue | null): void }) {
  const meta = useMeta().data;
  const [v, setV] = useState<TaxesValue>(() => ({
    ...opts.value,
    w4: { ...opts.value.w4 },
    stateW4: { ...opts.value.stateW4, data: { ...(opts.value.stateW4.data ?? {}) } },
    otherTaxes: opts.value.otherTaxes.map((x) => ({ ...x })),
  }));
  const [tab, setTab] = useState<string>(opts.defaultsMode ? 'state' : (opts.tab ?? 'federal'));
  const [err, setErr] = useState('');
  const set = (p: Partial<TaxesValue>) => setV((x) => ({ ...x, ...p }));
  const setW4 = (p: Partial<W4>) => setV((x) => ({ ...x, w4: { ...x.w4, ...p } }));
  const setSW4 = (p: Partial<StateW4>) => setV((x) => ({ ...x, stateW4: { ...x.stateW4, ...p } }));
  const st: StateInfo | undefined = meta?.states.find((s) => s.code === v.workState);
  const w = v.w4;
  const today = todayIso();
  const thisYear = +today.slice(0, 4);

  const changeVersion = async (ver: string) => {
    if (ver === w.version) return;
    const ok =
      ver === '2020'
        ? await confirmBox(
            'Use the 2020 or later Form W-4 for this employee?\n\nUse it for employees hired in 2020 or later, and for anyone who gave you a new Form W-4. The withholding allowances of the old form are no longer used.',
            'Form W-4',
          )
        : await confirmBox(
            'Use the 2019 or earlier Form W-4?\n\nOnly employees hired before 2020 who never gave you a new Form W-4 keep the old form (allowances).',
            'Form W-4',
          );
    if (!ok) return;
    setW4({ version: ver as W4['version'], filingStatus: 'single' });
  };

  const ok = () => {
    if (!v.workState) {
      setTab('state');
      setErr('Choose the state where the employee works.');
      return;
    }
    onDone({ ...v, otherTaxes: realLines(v.otherTaxes) });
  };

  const federal = (
    <>
      <FieldRow>
        <Field label="Form W-4" width={230} help="The version of the federal Form W-4 the employee gave you. Employees hired in 2020 or later use the 2020 or later form.">
          <Select
            name="w4.version"
            value={w.version}
            onChange={(x) => void changeVersion(x)}
            options={[
              { value: '2020', label: '2020 or later' },
              { value: 'pre2020', label: '2019 or earlier' },
            ]}
          />
        </Field>
        <Field label={w.version === '2020' ? 'Filing status (Step 1c)' : 'Filing status'} width={340}>
          <Select
            name="w4.filingStatus"
            value={w.filingStatus}
            onChange={(x) => setW4({ filingStatus: x })}
            options={(w.version === '2020' ? meta?.fedStatus2020 : meta?.fedStatusPre2020) ?? [{ value: 'single', label: 'Single' }]}
            disabled={w.exempt}
          />
        </Field>
      </FieldRow>
      {w.version === '2020' ? (
        <>
          <Checkbox checked={w.step2} onChange={(x) => setW4({ step2: x })} disabled={w.exempt} label="Multiple jobs or spouse works (Step 2c checked)" />
          <div className="sxp-emp-grid sxp-emp-g2">
            <Field label="Claim dependents (Step 3)" help="The total dollar amount of Step 3 (not the number of dependents).">
              <MoneyField name="w4.dependents" value={w.dependents} onChange={(x) => setW4({ dependents: x ?? 0 })} disabled={w.exempt} />
            </Field>
            <Field label="Other income (Step 4a)">
              <MoneyField name="w4.otherIncome" value={w.otherIncome} onChange={(x) => setW4({ otherIncome: x ?? 0 })} disabled={w.exempt} />
            </Field>
            <Field label="Deductions (Step 4b)">
              <MoneyField name="w4.deductions" value={w.deductions} onChange={(x) => setW4({ deductions: x ?? 0 })} disabled={w.exempt} />
            </Field>
            <Field label="Extra withholding (Step 4c)" hint="Per pay period.">
              <MoneyField name="w4.extraWithholding" value={w.extraWithholding} onChange={(x) => setW4({ extraWithholding: x ?? 0 })} disabled={w.exempt} />
            </Field>
          </div>
        </>
      ) : (
        <div className="sxp-emp-grid sxp-emp-g2">
          <Field label="Allowances">
            <NumberField name="w4.allowances" value={w.allowances} nullable={false} decimals={0} onChange={(x) => setW4({ allowances: Math.max(0, Math.round(x ?? 0)) })} disabled={w.exempt} />
          </Field>
          <Field label="Extra withholding" hint="Per pay period.">
            <MoneyField name="w4.extraWithholding" value={w.extraWithholding} onChange={(x) => setW4({ extraWithholding: x ?? 0 })} disabled={w.exempt} />
          </Field>
        </div>
      )}
      <FieldRow>
        <Field label="Nonresident alien withholding" width={300} help="Nonresident alien employees get the extra wage amount of IRS Publication 15-T added before figuring federal withholding.">
          <Select name="w4.nonresidentAlien" value={w.nonresidentAlien ? 'yes' : 'no'} onChange={(x) => setW4({ nonresidentAlien: x === 'yes' })} options={NRA_OPTIONS} />
        </Field>
      </FieldRow>
      <Checkbox
        checked={w.exempt}
        // a new exemption is claimed for this year (the server keeps the year of a stored claim)
        onChange={(x) => setW4({ exempt: x, exemptYear: x ? (opts.value.w4.exempt && opts.value.w4.exemptYear ? opts.value.w4.exemptYear : thisYear) : 0 })}
        label="Exempt from federal income tax withholding (the employee wrote Exempt on Form W-4)"
      />
      {w.exempt && <ExemptYearInfo year={w.exemptYear || thisYear} today={today} onRenew={() => setW4({ exemptYear: thisYear })} />}
      <GroupBox title="Subject to">
        <div className="sxp-emp-checks">
          <Checkbox checked={v.subjectMedicare} onChange={(x) => set({ subjectMedicare: x })} label="Medicare" />
          <Checkbox checked={v.subjectSs} onChange={(x) => set({ subjectSs: x })} label="Social Security" />
          <Checkbox checked={v.subjectFuta} onChange={(x) => set({ subjectFuta: x })} label="Federal Unemployment Tax (Company Paid)" />
        </div>
      </GroupBox>
    </>
  );

  const programs = st?.programs.map((p) => p.label).join(', ') ?? '';
  const stateWorked = (
    <GroupBox title="State worked">
      <FieldRow>
        <Field label="State" width={260} help="The state where the employee works. It decides state withholding, unemployment and disability taxes.">
          <StatePicker
            name="workState"
            value={v.workState}
            onChange={(code) => {
              setErr('');
              set({ workState: code ?? '', stateW4: { filingStatus: '', allowances: 0, extraWithholding: 0, exempt: false, data: {} } });
            }}
            aria-label="State worked"
          />
        </Field>
      </FieldRow>
      <div className="sxp-emp-checks">
        <Checkbox checked={v.subjectSui} onChange={(x) => set({ subjectSui: x })} label={st?.hasEmployeeSui ? 'SUI (Company and Employee Paid)' : 'SUI (Company Paid)'} />
        <Checkbox
          checked={v.subjectSdi}
          onChange={(x) => set({ subjectSdi: x })}
          disabled={!!st && st.programs.length === 0}
          label={programs ? `SDI and state programs (${programs})` : 'SDI'}
        />
      </div>
    </GroupBox>
  );

  const sw = v.stateW4;
  const withholding = st && !opts.defaultsMode && (
    <>
      {st.hasIncomeTax ? (
        <GroupBox title="State subject to withholding">
          <FieldRow>
            <Field label="State" width={90}>
              <div className="sxp-emp-readout">{st.code}</div>
            </Field>
            {st.filingStatuses.length > 0 && (
              <Field label="Filing status" width={360}>
                <Select
                  name="stateW4.filingStatus"
                  value={sw.filingStatus}
                  onChange={(x) => setSW4({ filingStatus: x })}
                  options={[{ value: '', label: '(state default)' }, ...st.filingStatuses]}
                  disabled={sw.exempt}
                />
              </Field>
            )}
          </FieldRow>
          <div className="sxp-emp-grid sxp-emp-g2">
            <Field label={`Allowances${st.stateForm && !/^none/i.test(st.stateForm) ? ` (${st.stateForm.split('(')[0].trim()})` : ''}`}>
              <NumberField name="stateW4.allowances" value={sw.allowances} nullable={false} decimals={0} onChange={(x) => setSW4({ allowances: Math.max(0, Math.round(x ?? 0)) })} disabled={sw.exempt} />
            </Field>
            <Field label="Extra withholding" hint={st.code === 'CT' || st.code === 'LA' ? 'Per pay period. A negative amount reduces the withholding.' : 'Per pay period.'}>
              <MoneyField name="stateW4.extraWithholding" value={sw.extraWithholding} onChange={(x) => setSW4({ extraWithholding: x ?? 0 })} disabled={sw.exempt} />
            </Field>
          </div>
          <Checkbox checked={sw.exempt} onChange={(x) => setSW4({ exempt: x })} label="Exempt from state withholding" />
        </GroupBox>
      ) : (
        <div className="sxp-emp-notice">
          <Info size={15} aria-hidden="true" />
          <span>{st.name} has no state income tax withholding on wages.</span>
        </div>
      )}
      {st.inputs.length > 0 && (
        <GroupBox title="Miscellaneous data (depends on state selected)">
          <div className="sxp-emp-grid sxp-emp-g2">
            {st.inputs.map((inp) => (
              <Field key={inp.value} label={inp.label}>
                <NumberField
                  name={`stateW4.data.${inp.value}`}
                  value={typeof sw.data?.[inp.value] === 'number' ? (sw.data[inp.value] as number) : null}
                  onChange={(x) => {
                    const d = { ...(sw.data ?? {}) };
                    if (x === null) delete d[inp.value];
                    else d[inp.value] = x;
                    setSW4({ data: d });
                  }}
                />
              </Field>
            ))}
          </div>
        </GroupBox>
      )}
      {st.notes && <div className="sxp-emp-hint">{st.notes}</div>}
    </>
  );

  const other = (
    <>
      <div className="sxp-emp-hint">Add the local and other taxes this employee pays or the company pays for this employee (Other Tax payroll items). Leave the rate blank to use the rate of the payroll item.</div>
      <div className="sxp-emp-othergrid">
        <OtherTaxesGrid rows={v.otherTaxes} onChange={(rows) => set({ otherTaxes: rows })} />
      </div>
    </>
  );

  return (
    <div className="sxp-emp-dlg">
      <div className={'sxp-emp-dlg-body' + (opts.defaultsMode ? '' : ' sxp-emp-dlg-fixed')}>
        {err && <div className="sxp-emp-dlg-error">{err}</div>}
        {opts.defaultsMode ? (
          <>
            <div className="sxp-emp-hint">New employees start with these state settings. The federal Form W-4 is entered for each employee.</div>
            {stateWorked}
          </>
        ) : (
          <Tabs
            active={tab}
            onChange={setTab}
            aria-label="Taxes"
            tabs={[
              { key: 'federal', label: 'Federal', content: federal },
              { key: 'state', label: 'State', content: <>{stateWorked}{withholding}</> },
              { key: 'other', label: 'Other', content: other },
            ]}
          />
        )}
      </div>
      <div className="sx-dlg-buttons">
        <Button label="Cancel" onClick={() => onDone(null)} />
        <Button variant="primary" label="OK" onClick={ok} />
      </div>
    </div>
  );
}
