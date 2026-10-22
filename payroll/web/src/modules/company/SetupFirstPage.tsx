// First page of Payroll Setup for a SerieX Books company that has no payroll file yet. App
// registers it with the session (registerSetupPage), so session.setUpPayroll() shows it after the
// SerieX Books sign-in; it asks the SetupRequest fields (state, EIN, deposit schedule, first pay
// schedule, bank account from GET /api/companies/{id}/bank-accounts, accounts and agencies to
// create in SerieX Books) and creates the payroll file (POST /api/companies/{id}/setup). The
// session then opens the company and the Payroll Setup window, which continues with step 2.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '@/api/client';
import { FREQUENCY_LABELS, type BooksAccount, type Frequency, type Meta, type SetupRequest } from '@/api/types';
import { Button, Checkbox, DateField, ErrorBanner, Field, FieldRow, FormErrorsProvider, NumberField, RadioGroup, Select, Spinner, TextField, showDialog, useFormErrors } from '@/components';
import { addDays, todayIso, weekday } from '@/util/dates';
import { fmtDate } from '@/util/format';
import { SetupRail, WizHead } from './setupSteps';
import './company.css';

/** Next Friday on or after today (default end of the first pay period). */
function nextFriday(): string {
  const t = todayIso();
  return addDays(t, (5 - weekday(t) + 7) % 7);
}

const FREQS: Frequency[] = ['weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'annually', 'daily'];

function FirstPage({ companyId, companyName, onDone }: { companyId: string; companyName: string; onDone(created: boolean): void }) {
  const fe = useFormErrors();
  const rootRef = useRef<HTMLDivElement>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [banks, setBanks] = useState<BooksAccount[] | null>(null);
  const [bankErr, setBankErr] = useState('');
  const year = new Date().getFullYear();
  const [req, setReq] = useState<SetupRequest>(() => {
    const end = nextFriday();
    return {
      primaryState: '',
      ein: '',
      federalDepositSchedule: 'monthly',
      firstPayrollYear: year,
      defaultBankAccountId: null,
      createAccounts: true,
      createAgencies: true,
      payFrequency: 'biweekly',
      nextPeriodEnd: end,
      nextCheckDate: end,
      uiRate: null,
    };
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.global
      .get<Meta>('/meta', { noPrompt: true })
      .then(setMeta)
      .catch((e) => fe.setErrors({}, `The list of states could not be loaded: ${(e as Error).message}`));
    // SerieX Books bank accounts (the payroll file does not exist yet, so this is a global route)
    api.global
      .get<BooksAccount[]>(`/companies/${encodeURIComponent(companyId)}/bank-accounts`, { noPrompt: true })
      .then((list) => {
        const active = (list ?? []).filter((a) => a.active);
        setBanks(active);
        if (active.length) setReq((r) => (r.defaultBankAccountId ? r : { ...r, defaultBankAccountId: active[0].id }));
      })
      .catch((e) => {
        setBanks([]);
        setBankErr((e as Error).message);
      });
  }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (p: Partial<SetupRequest>) => setReq((r) => ({ ...r, ...p }));
  const states = useMemo(() => [...(meta?.states ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [meta]);
  const years = useMemo(() => {
    const ys = new Set<number>(meta?.taxYears?.length ? meta.taxYears : [year]);
    ys.add(year);
    ys.add(req.firstPayrollYear);
    return Array.from(ys).sort();
  }, [meta, year, req.firstPayrollYear]);
  const stateInfo = meta?.states.find((s) => s.code === req.primaryState);

  const submit = async () => {
    fe.clearAll();
    const errs: Record<string, string> = {};
    if (!req.primaryState) errs.primaryState = 'Choose the state where your employees work.';
    const digits = req.ein.replace(/\D/g, '');
    if (req.ein.trim() && digits.length !== 9) errs.ein = 'The federal employer identification number (EIN) has 9 digits, like 12-3456789.';
    if (!req.nextPeriodEnd) errs.nextPeriodEnd = 'Enter the last day of the next pay period.';
    if (!req.nextCheckDate) errs.nextCheckDate = 'Enter the date of the paychecks for that pay period.';
    if (req.uiRate !== null && (req.uiRate < 0 || req.uiRate > 20)) errs.uiRate = 'Enter your state unemployment rate as a percent, for example 3.4.';
    if (Object.keys(errs).length) {
      fe.setErrors(errs);
      return;
    }
    setBusy(true);
    try {
      const body: SetupRequest = { ...req, ein: digits ? `${digits.slice(0, 2)}-${digits.slice(2)}` : '' };
      await api.global.post(`/companies/${encodeURIComponent(companyId)}/setup`, body);
      onDone(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'cancelled') return;
      fe.fromError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormErrorsProvider value={fe}>
      <div className="cx-wizard pc-setup-first" ref={rootRef}>
        <SetupRail current={0} done={() => false} footer="Payroll keeps its own file for this company and posts every paycheck to SerieX Books." />
        <form
          className="cx-wiz-main"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="cx-wiz-body">
            {(fe.message || Object.keys(fe.errors).length > 0) && <ErrorBanner errors={fe.errors} message={fe.message} root={rootRef.current} onDismiss={() => fe.clearAll()} />}
            <WizHead
              title={`Set up payroll for ${companyName}`}
              sub="A few questions to create the payroll file. You can add employees, payroll items and year-to-date amounts on the next pages."
            />
            <FieldRow>
              <Field label="State where your employees work" required width={260} hint={stateInfo && !stateInfo.hasIncomeTax ? `${stateInfo.name} has no state income tax.` : undefined}>
                {meta ? (
                  <Select name="primaryState" value={req.primaryState} onChange={(v) => set({ primaryState: v })} autoFocus aria-label="State where your employees work">
                    <option value="">(choose a state)</option>
                    {states.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Spinner label="Loading states..." />
                )}
              </Field>
              <Field label="Federal employer ID (EIN)" width={200} help="EIN" hint="Blank: the tax ID of the SerieX Books company.">
                <TextField name="ein" value={req.ein} placeholder="12-3456789" onChange={(v) => set({ ein: v })} aria-label="Federal employer ID" />
              </Field>
            </FieldRow>
            <FieldRow>
              <Field label="Federal tax deposits (Form 941)" help="Deposit schedule" width={260}>
                <RadioGroup
                  row
                  name="federalDepositSchedule"
                  value={req.federalDepositSchedule}
                  options={[
                    { value: 'monthly', label: 'Monthly' },
                    { value: 'semiweekly', label: 'Semiweekly' },
                  ]}
                  onChange={(v) => set({ federalDepositSchedule: v })}
                />
              </Field>
              <Field label="First payroll year" width={120}>
                <Select name="firstPayrollYear" value={req.firstPayrollYear} onChange={(v) => set({ firstPayrollYear: Number(v) })} aria-label="First payroll year">
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="State unemployment rate" width={170} hint={req.uiRate === null ? 'Blank: the new employer rate.' : undefined}>
                <NumberField name="uiRate" value={req.uiRate} decimals={4} suffix="%" onChange={(v) => set({ uiRate: v })} aria-label="State unemployment rate" />
              </Field>
            </FieldRow>
            <div className="cx-section-title">Your first pay schedule</div>
            <FieldRow>
              <Field label="How often do you pay employees?" width={230}>
                <Select name="payFrequency" value={req.payFrequency} onChange={(v) => set({ payFrequency: v as Frequency })} aria-label="Pay frequency">
                  {FREQS.map((f) => (
                    <option key={f} value={f}>
                      {FREQUENCY_LABELS[f]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Next pay period ends" required width={150}>
                <DateField name="nextPeriodEnd" value={req.nextPeriodEnd} onChange={(v) => set({ nextPeriodEnd: v })} aria-label="Next pay period ends" />
              </Field>
              <Field label="Check date of that period" required width={150}>
                <DateField name="nextCheckDate" value={req.nextCheckDate} onChange={(v) => set({ nextCheckDate: v })} aria-label="Check date" />
              </Field>
            </FieldRow>
            {req.nextPeriodEnd && req.nextCheckDate && req.nextCheckDate < req.nextPeriodEnd && (
              <div className="cx-hint">The check date {fmtDate(req.nextCheckDate)} is before the end of the pay period: employees are paid in advance.</div>
            )}
            <div className="cx-section-title">SerieX Books</div>
            <Field label="Bank account for paychecks and tax payments" width={340} hint={bankErr ? `SerieX Books bank accounts are not available: ${bankErr}` : undefined}>
              {banks ? (
                <Select
                  name="defaultBankAccountId"
                  value={req.defaultBankAccountId ?? ''}
                  onChange={(v) => set({ defaultBankAccountId: v ? Number(v) : null })}
                  aria-label="Bank account for paychecks"
                >
                  <option value="">{banks.length ? '(choose later)' : '(no bank account in SerieX Books yet)'}</option>
                  {banks.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.fullName || a.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <Spinner label="Loading bank accounts..." />
              )}
            </Field>
            <div className="cx-checks pc-wrapchecks">
              <Checkbox
                name="createAccounts"
                checked={req.createAccounts}
                onChange={(v) => set({ createAccounts: v })}
                label="Create the payroll accounts in SerieX Books: Payroll Expenses (Wages, Payroll Taxes, Benefits...) and Payroll Liabilities (Federal Taxes (941), State Withholding...)"
              />
              <Checkbox
                name="createAgencies"
                checked={req.createAgencies}
                onChange={(v) => set({ createAgencies: v })}
                label="Create the tax agencies as SerieX Books vendors (United States Treasury and the state agencies)"
              />
              <div className="cx-hint" style={{ marginLeft: 24 }}>
                Accounts and vendors that already exist in SerieX Books are used as they are; nothing is created twice.
              </div>
            </div>
          </div>
          <div className="cx-dlg-foot">
            <div className="cx-grow cx-muted cx-small">Step 1 of 8</div>
            <Button label="Cancel" onClick={() => onDone(false)} disabled={busy} />
            <Button type="submit" variant="primary" label="Create payroll file" busy={busy} disabled={!meta} />
          </div>
        </form>
      </div>
    </FormErrorsProvider>
  );
}

/**
 * Shows the first page of Payroll Setup; resolves true when the payroll file was created.
 * App registers it with the session (registerSetupPage) and loads this file when it is needed.
 */
export function showFirstPage(companyId: string, companyName: string): Promise<boolean> {
  return showDialog<boolean>({
    title: 'Payroll Setup',
    width: 940,
    cancelValue: false,
    render: (close) => <FirstPage companyId={companyId} companyName={companyName} onDone={close} />,
  });
}
