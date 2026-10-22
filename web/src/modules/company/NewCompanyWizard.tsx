// File > New Company: short guided setup.
//   1 Business (name, industry, entity type, tax id) → 2 Contact (legal name, address, fiscal year)
//   → 3 What you want to track (estimates, purchase orders, inventory, sales tax, classes)
//   → 3b Sales tax (only when sales tax is ticked: the most common sales tax, its rate, the tax
//   agency and how often it is paid, required when sales tax is turned on)
//   → 4 Sign-in (optional admin password) → 5 Bank and credit card accounts with opening balances.
// "Create company" creates the file, applies the feature choices, creates the tax agency vendor and
// the Sales Tax Item (stored as the default sales tax), adds the accounts and their opening
// balances, then opens the company on the Home page (which shows a getting-started list).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Building2, Check, CreditCard, Landmark, ListChecks, MapPin, Percent, Plus, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '@/api/client';
import type { Account, AccountType, CompanyFile, IndustryTemplate, Item, Name, NewCompanyRequest, Prefs, Txn } from '@/api/types';
import { emptyLine, emptyTxn } from '@/api/types';
import { queryClient } from '@/api/hooks';
import {
  Button,
  Checkbox,
  DateField,
  ErrorBanner,
  Field,
  FieldRow,
  FormErrorsProvider,
  MoneyField,
  NumberField,
  Select,
  Spinner,
  TextField,
  confirmBox,
  newItemRecord,
  newNameRecord,
  toast,
  useFormErrors,
} from '@/components';
import { useOptionalWindow } from '@/windows/WindowContext';
import { switchCompany, type CompanySession } from '@/state/session';
import { todayIso } from '@/util/dates';
import { ENTITY_TYPES, MONTH_OPTIONS, SALES_TAX_FREQUENCIES } from './shared';
import './company.css';

export interface NewCompanyWizardProps {}

interface BankRow {
  key: number;
  name: string;
  type: AccountType;
  balance: number;
  date: string;
}

interface Track {
  estimates: boolean;
  purchaseOrders: boolean;
  inventory: boolean;
  salesTax: boolean;
  classes: boolean;
  defaultChart: boolean;
}

/** The company's most common sales tax (asked when sales tax is turned on). */
interface SalesTaxSetup {
  name: string;
  rate: number | null;
  agency: string;
  frequency: Prefs['salesTaxFrequency'];
}

const STEPS: { key: string; label: string; icon: typeof Building2 }[] = [
  { key: 'business', label: 'Your business', icon: Building2 },
  { key: 'contact', label: 'Contact details', icon: MapPin },
  { key: 'track', label: 'What you track', icon: ListChecks },
  { key: 'salesTax', label: 'Sales tax', icon: Percent },
  { key: 'signin', label: 'Sign-in', icon: ShieldCheck },
  { key: 'bank', label: 'Bank accounts', icon: Landmark },
];

const STEP_FIELDS: Record<string, string[]> = {
  business: ['name', 'industry', 'entityType', 'taxId'],
  contact: ['legalName', 'address1', 'address2', 'city', 'state', 'zip', 'country', 'phone', 'email', 'website', 'fiscalYearStartMonth'],
  track: [],
  salesTax: ['taxName', 'taxRate', 'taxAgency', 'salesTaxFrequency'],
  signin: ['adminPassword', 'adminPassword2'],
  bank: ['bank'],
};

let rowSeq = 1;
const bankRow = (name: string, type: AccountType): BankRow => ({ key: rowSeq++, name, type, balance: 0, date: todayIso() });

/** Calls a company endpoint of the new company directly (the app has not opened it yet). */
async function call<T>(cid: string, token: string | null, method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['X-Session'] = token;
  const res = await fetch(`/api/c/${encodeURIComponent(cid)}${path}${path.includes('?') ? '&' : '?'}force=1`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  return data as T;
}

export default function NewCompanyWizard(_props: NewCompanyWizardProps) {
  const win = useOptionalWindow();
  const fe = useFormErrors();
  const [step, setStep] = useState(0);
  const [templates, setTemplates] = useState<IndustryTemplate[] | null>(null);
  const [req, setReq] = useState<NewCompanyRequest>({
    name: '',
    legalName: '',
    industry: 'general_service',
    entityType: 'Sole Proprietorship',
    taxId: '',
    address1: '',
    address2: '',
    city: '',
    state: '',
    zip: '',
    country: 'US',
    phone: '',
    email: '',
    website: '',
    fiscalYearStartMonth: 1,
    adminPassword: '',
    createDefaultAccounts: true,
    salesTaxEnabled: false,
    inventoryEnabled: false,
  });
  const [pw2, setPw2] = useState('');
  const [track, setTrack] = useState<Track>({ estimates: true, purchaseOrders: false, inventory: false, salesTax: false, classes: false, defaultChart: true });
  const [banks, setBanks] = useState<BankRow[]>(() => [bankRow('Checking', 'Bank')]);
  const [tax, setTax] = useState<SalesTaxSetup>({ name: '', rate: null, agency: '', frequency: 'quarterly' });
  // the Sales tax step is only part of the setup when sales tax is turned on
  const steps = STEPS.filter((s) => s.key !== 'salesTax' || track.salesTax);
  const [busy, setBusy] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const touched = useRef(false);

  useEffect(() => {
    api.global
      .get<IndustryTemplate[]>('/companies/templates', { noPrompt: true })
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, []);

  // closing the wizard after typing asks first
  useEffect(() => {
    if (!win) return;
    win.setBeforeClose(async () =>
      touched.current && !busy ? confirmBox('Stop creating the new company? What you entered will be lost.', 'New Company') : true,
    );
    return () => win.setBeforeClose(null);
  }, [win?.id, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (patch: Partial<NewCompanyRequest>) => {
    touched.current = true;
    setReq((r) => ({ ...r, ...patch }));
  };
  const setT = (patch: Partial<Track>) => {
    touched.current = true;
    setTrack((t) => ({ ...t, ...patch }));
    // suggest a name for the sales tax ("CA Sales Tax") when sales tax is turned on
    if (patch.salesTax && !tax.name.trim()) {
      const st = req.state.trim().toUpperCase();
      setTax((x) => ({ ...x, name: st && st.length <= 3 ? `${st} Sales Tax` : 'Sales Tax' }));
    }
  };
  const setX = (patch: Partial<SalesTaxSetup>) => {
    touched.current = true;
    setTax((x) => ({ ...x, ...patch }));
  };

  const validate = (i: number): boolean => {
    fe.clearAll();
    const k = steps[i].key;
    if (k === 'business' && !req.name.trim()) {
      fe.setErrors({ name: 'Enter the name of your company.' });
      return false;
    }
    if (k === 'salesTax') {
      const errs: Record<string, string> = {};
      if (!tax.name.trim()) errs.taxName = 'Enter a name for your sales tax, for example "CA Sales Tax".';
      if (tax.rate === null || !(tax.rate > 0) || tax.rate > 100) errs.taxRate = 'Enter the tax rate as a percentage, for example 7.25.';
      if (!tax.agency.trim()) errs.taxAgency = 'Enter the tax agency you pay this sales tax to, for example "State Board of Equalization".';
      else if (tax.agency.trim().toLowerCase() === tax.name.trim().toLowerCase())
        errs.taxAgency = 'The tax agency is a vendor, so it needs a name different from the sales tax.';
      if (Object.keys(errs).length) {
        fe.setErrors(errs);
        return false;
      }
    }
    if (k === 'signin' && req.adminPassword && [...req.adminPassword].length < 8) {
      fe.setErrors({ adminPassword: 'Use a password of at least 8 characters.' });
      return false;
    }
    if (k === 'signin' && req.adminPassword !== pw2) {
      fe.setErrors({ adminPassword2: 'The passwords do not match. Type the same password twice.' });
      return false;
    }
    if (k === 'bank') {
      const bad = banks.findIndex((b) => !b.name.trim());
      if (bad >= 0) {
        fe.setErrors({ ['bank' + banks[bad].key]: 'Enter a name for the account, or remove the line.' });
        return false;
      }
      const names = banks.map((b) => b.name.trim().toLowerCase());
      const dup = names.findIndex((n, j) => names.indexOf(n) !== j);
      if (dup >= 0) {
        fe.setErrors({ ['bank' + banks[dup].key]: 'Two accounts have the same name. Give each account its own name.' });
        return false;
      }
    }
    return true;
  };

  const goto = (i: number) => {
    if (i > step) {
      for (let s = step; s < i; s++) {
        if (!validate(s)) {
          setStep(s);
          return;
        }
      }
    } else fe.clearAll();
    setStep(i);
  };

  const create = async () => {
    for (let s = 0; s < steps.length; s++) {
      if (!validate(s)) {
        setStep(s);
        return;
      }
    }
    setBusy('Creating your company file...');
    let cf: CompanyFile;
    try {
      cf = await api.global.post<CompanyFile>(
        '/companies',
        {
          ...req,
          legalName: req.legalName || req.name,
          salesTaxEnabled: track.salesTax,
          inventoryEnabled: track.inventory,
          createDefaultAccounts: track.defaultChart,
        },
        { noPrompt: true },
      );
    } catch (e) {
      setBusy(null);
      const err = e as { field?: string; message: string };
      const field = err.field ?? 'name';
      const at = steps.findIndex((s) => STEP_FIELDS[s.key].includes(field));
      setStep(at >= 0 ? at : 0);
      fe.setErrors({ [field]: err.message });
      return;
    }
    // finish the setup inside the new company file
    const problems: string[] = [];
    let session: CompanySession | undefined;
    try {
      setBusy('Setting up your preferences and accounts...');
      let token: string | null = null;
      if (req.adminPassword) {
        const r = await api.global.post<{ token: string; user: string }>(
          `/companies/${encodeURIComponent(cf.id)}/login`,
          { user: 'Admin', password: req.adminPassword },
          { noPrompt: true },
        );
        token = r.token;
        session = { token, user: r.user || 'Admin' };
      }
      const prefs: Partial<Prefs> = {
        estimatesEnabled: track.estimates,
        useClassTracking: track.classes,
        purchaseOrdersEnabled: track.purchaseOrders,
        inventoryEnabled: track.inventory,
      };
      try {
        await call(cf.id, token, 'PUT', '/prefs', prefs);
      } catch (e) {
        problems.push(`Preferences: ${(e as Error).message}`);
      }
      if (track.salesTax) {
        // the most common sales tax: its agency (a vendor), the Sales Tax Item, and the preference
        // that puts it on new invoices and sales receipts
        try {
          setBusy('Setting up your sales tax...');
          const agencyName = tax.agency.trim();
          const vendors = await call<Name[]>(cf.id, token, 'GET', '/names?kind=vendor&active=all');
          const agency =
            vendors.find((v) => v.kind === 'vendor' && v.name.toLowerCase() === agencyName.toLowerCase()) ??
            (await call<Name>(cf.id, token, 'POST', '/names', newNameRecord('vendor', agencyName)));
          const item = await call<Item>(
            cf.id,
            token,
            'POST',
            '/items',
            newItemRecord('Sales Tax Item', tax.name.trim(), { description: tax.name.trim(), taxRate: tax.rate ?? 0, taxAgencyId: agency.id }),
          );
          await call(cf.id, token, 'PUT', '/prefs', { defaultSalesTaxItemId: item.id, salesTaxFrequency: tax.frequency } satisfies Partial<Prefs>);
        } catch (e) {
          problems.push(`Sales tax: ${(e as Error).message}`);
        }
      }
      const accts = await call<Account[]>(cf.id, token, 'GET', '/accounts?active=all');
      const obe = accts.find((a) => a.special === 'OpeningBalanceEquity');
      for (const b of banks) {
        const name = b.name.trim();
        const existing = accts.find((a) => a.type === b.type && a.name.toLowerCase() === name.toLowerCase());
        try {
          if (!existing) {
            await call(cf.id, token, 'POST', '/accounts', {
              name,
              type: b.type,
              number: '',
              parentId: null,
              description: '',
              note: '',
              bankAcctNumber: '',
              routingNumber: '',
              taxLine: '',
              active: true,
              openingBalance: b.balance,
              openingDate: b.date || todayIso(),
            });
          } else if (b.balance !== 0 && obe) {
            // the account is already in the chart of accounts: record its opening balance like the server does
            const sign = b.type === 'Credit Card' ? -1 : 1;
            const je: Txn = {
              ...emptyTxn('GENJRNL', b.date || todayIso()),
              memo: 'Opening balance',
              lines: [
                { ...emptyLine('je', 1), accountId: existing.id, amount: sign * b.balance, description: 'Opening balance' },
                { ...emptyLine('je', 2), accountId: obe.id, amount: -sign * b.balance, description: 'Opening balance' },
              ],
            };
            await call(cf.id, token, 'POST', '/txns', je);
          }
        } catch (e) {
          problems.push(`${name}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      problems.push((e as Error).message);
    }
    void queryClient.invalidateQueries({ queryKey: ['global', 'companies'] });
    setBusy('Opening your company...');
    touched.current = false;
    await win?.close(true);
    // Opened with the administrator's session: the new owner is not asked to log in again.
    // false when the switch did not happen (Cancel in a "save your changes?" prompt, or the file
    // could not be opened): the open company stays, and switchCompany ends the unused session.
    const opened = await switchCompany(cf.id, session);
    const setupNote = problems.length ? ` Some setup steps did not finish: ${problems.join('; ')}` : '';
    if (!opened) {
      toast(`${cf.name} was created but is not open. To open it, use Open Company in the File menu.${setupNote}`, {
        kind: 'info',
        duration: problems.length ? 12000 : 8000,
        action: { label: 'Open', onClick: () => void switchCompany(cf.id) },
      });
    } else if (problems.length) toast(`Your company was created, but some setup steps did not finish: ${problems.join('; ')}`, { kind: 'warning', duration: 12000 });
    else toast(`${cf.name} is ready. Welcome!`);
  };

  const k = steps[Math.min(step, steps.length - 1)].key;
  const last = step >= steps.length - 1;
  const tpl = templates?.find((t) => t.key === req.industry);

  return (
    <FormErrorsProvider value={fe}>
      <div
        className="cx-wizard"
        ref={rootRef}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.defaultPrevented || busy) return;
          const t = e.target as HTMLElement;
          if (t.tagName === 'BUTTON' || t.tagName === 'TEXTAREA' || t.getAttribute('aria-expanded') === 'true') return;
          e.preventDefault();
          if (last) void create();
          else goto(step + 1);
        }}
      >
        <nav className="cx-wiz-rail" aria-label="Steps">
          <div className="cx-wiz-railtitle">Set up your company</div>
          {steps.map((s, i) => {
            const Icon = s.icon;
            return (
              <button
                key={s.key}
                type="button"
                className={'cx-wiz-step' + (i === step ? ' cx-on' : '') + (i < step ? ' cx-done' : '')}
                onClick={() => goto(i)}
                disabled={!!busy}
                aria-current={i === step ? 'step' : undefined}
              >
                <span className="cx-wiz-num">{i < step ? <Check size={13} /> : <Icon size={13} />}</span>
                {s.label}
              </button>
            );
          })}
          <div className="cx-wiz-railfoot cx-muted cx-small">You can change all of this later in Company Information and Preferences.</div>
        </nav>
        <div className="cx-wiz-main">
          {busy ? (
            <div style={{ flex: 1, display: 'grid', placeItems: 'center' }}>
              <Spinner label={busy} />
            </div>
          ) : (
            <div className="cx-wiz-body">
              {(fe.message || Object.keys(fe.errors).length > 0) && (
                <ErrorBanner errors={fe.errors} message={fe.message} root={rootRef.current} onDismiss={() => fe.clearAll()} />
              )}
              {k === 'business' && (
                <>
                  <WizHead title="Tell us about your business" sub="We use your industry to set up a chart of accounts that fits." />
                  <Field label="Company name" required hint="The name your customers know you by." width={380}>
                    <TextField name="name" value={req.name} onChange={(v) => set({ name: v })} autoFocus placeholder="e.g. Bayview Landscaping" />
                  </Field>
                  <Field label="Industry">
                    <div className="cx-industries" role="radiogroup" aria-label="Industry" data-field="industry">
                      {templates === null ? (
                        <div style={{ padding: 16 }}>
                          <Spinner label="Loading industries..." />
                        </div>
                      ) : (
                        templates.map((t) => (
                          <label key={t.key} className={'cx-industry' + (req.industry === t.key ? ' cx-on' : '')}>
                            <input type="radio" name="industry" checked={req.industry === t.key} onChange={() => set({ industry: t.key })} />
                            <span>
                              <b>{t.label}</b>
                              <span className="cx-muted cx-small">{t.description}</span>
                            </span>
                          </label>
                        ))
                      )}
                    </div>
                  </Field>
                  <FieldRow>
                    <Field label="Type of business entity" width={230} hint={ENTITY_TYPES.find((e) => e.value === req.entityType)?.help}>
                      <Select
                        name="entityType"
                        value={req.entityType}
                        onChange={(v) => set({ entityType: v })}
                        options={ENTITY_TYPES.map((e) => ({ value: e.value, label: e.label }))}
                      />
                    </Field>
                    <Field label="Federal tax ID (EIN)" help="The tax identification number printed on tax forms. Optional." width={170}>
                      <TextField name="taxId" value={req.taxId} onChange={(v) => set({ taxId: v })} placeholder="12-3456789" />
                    </Field>
                  </FieldRow>
                </>
              )}
              {k === 'contact' && (
                <>
                  <WizHead title="How can customers reach you?" sub="This information appears on your invoices, statements and reports." />
                  <Field label="Legal name" hint={`Leave empty to use "${req.name || 'the company name'}".`} width={380}>
                    <TextField name="legalName" value={req.legalName} onChange={(v) => set({ legalName: v })} autoFocus />
                  </Field>
                  <Field label="Address">
                    <TextField name="address1" value={req.address1} onChange={(v) => set({ address1: v })} placeholder="Street" />
                  </Field>
                  <FieldRow>
                    <Field label="City" width={170}>
                      <TextField name="city" value={req.city} onChange={(v) => set({ city: v })} />
                    </Field>
                    <Field label="State" width={64}>
                      <TextField name="state" value={req.state} onChange={(v) => set({ state: v })} />
                    </Field>
                    <Field label="ZIP" width={90}>
                      <TextField name="zip" value={req.zip} onChange={(v) => set({ zip: v })} />
                    </Field>
                    <Field label="Country" width={70}>
                      <TextField name="country" value={req.country} onChange={(v) => set({ country: v })} />
                    </Field>
                  </FieldRow>
                  <FieldRow>
                    <Field label="Phone" width={150}>
                      <TextField name="phone" value={req.phone} onChange={(v) => set({ phone: v })} />
                    </Field>
                    <Field label="Email" width={250}>
                      <TextField name="email" type="email" value={req.email} onChange={(v) => set({ email: v })} />
                    </Field>
                  </FieldRow>
                  <FieldRow>
                    <Field label="Website" width={250}>
                      <TextField name="website" value={req.website} onChange={(v) => set({ website: v })} />
                    </Field>
                    <Field label="First month of your fiscal year" help="Fiscal year" width={200}>
                      <Select
                        name="fiscalYearStartMonth"
                        value={req.fiscalYearStartMonth}
                        onChange={(v) => set({ fiscalYearStartMonth: Number(v) })}
                        options={MONTH_OPTIONS}
                      />
                    </Field>
                  </FieldRow>
                </>
              )}
              {k === 'track' && (
                <>
                  <WizHead title="What do you want to track?" sub="Turn on only what you need; the menus and forms stay simpler." />
                  <div className="cx-tracklist">
                    <TrackCard checked label="Invoices and bills" desc="Send invoices, receive payments, enter and pay bills. Always on." disabled />
                    <TrackCard
                      checked={track.estimates}
                      onChange={(v) => setT({ estimates: v })}
                      label="Estimates"
                      desc="Give customers quotes and turn them into invoices."
                    />
                    <TrackCard
                      checked={track.inventory}
                      onChange={(v) => setT({ inventory: v, purchaseOrders: v ? true : track.purchaseOrders })}
                      label="Inventory"
                      desc="Track quantities on hand and the cost of the products you sell."
                    />
                    <TrackCard
                      checked={track.purchaseOrders}
                      onChange={(v) => setT({ purchaseOrders: v })}
                      label="Purchase orders"
                      desc="Order from vendors and receive items against the order."
                    />
                    <TrackCard
                      checked={track.salesTax}
                      onChange={(v) => setT({ salesTax: v })}
                      label="Sales tax"
                      desc="Charge sales tax on sales and keep track of what you owe."
                    />
                    <TrackCard
                      checked={track.classes}
                      onChange={(v) => setT({ classes: v })}
                      label="Classes"
                      desc="Group income and expenses by department, location or program."
                    />
                  </div>
                  <Checkbox
                    checked={track.defaultChart}
                    onChange={(v) => setT({ defaultChart: v })}
                    label={`Start with the recommended chart of accounts for ${tpl ? tpl.label : 'my industry'}`}
                  />
                </>
              )}
              {k === 'salesTax' && (
                <>
                  <WizHead
                    title="Your most common sales tax"
                    sub="New invoices and sales receipts charge this tax on taxable items. You can add other rates later in the Item List."
                  />
                  <FieldRow>
                    <Field label="Sales tax name" required width={230} hint="Shown on invoices, e.g. CA Sales Tax.">
                      <TextField name="taxName" value={tax.name} onChange={(v) => setX({ name: v })} autoFocus />
                    </Field>
                    <Field label="Tax rate (%)" required width={150} hint="For example 7.25">
                      <NumberField name="taxRate" value={tax.rate} decimals={4} onChange={(v) => setX({ rate: v })} aria-label="Tax rate in percent" />
                    </Field>
                  </FieldRow>
                  <Field
                    label="Tax agency"
                    required
                    width={380}
                    hint="The government agency you pay the tax to. It is added to your vendors."
                  >
                    <TextField
                      name="taxAgency"
                      value={tax.agency}
                      onChange={(v) => setX({ agency: v })}
                      placeholder="e.g. State Board of Equalization"
                    />
                  </Field>
                  <Field label="How often do you pay sales tax?" width={200}>
                    <Select
                      name="salesTaxFrequency"
                      value={tax.frequency}
                      onChange={(v) => setX({ frequency: v as SalesTaxSetup['frequency'] })}
                      options={SALES_TAX_FREQUENCIES}
                    />
                  </Field>
                </>
              )}
              {k === 'signin' && (
                <>
                  <WizHead title="Protect your company file" sub="Recommended. With a password, everyone logs in when the company file opens." />
                  <div className="cx-note cx-info">
                    <ShieldCheck size={16} />
                    <div>
                      You are the administrator, user <b>Admin</b>. You can add more users later from the Company menu.
                    </div>
                  </div>
                  <FieldRow>
                    <Field label="Admin password" width={200} hint="At least 8 characters.">
                      <TextField
                        name="adminPassword"
                        type="password"
                        value={req.adminPassword}
                        onChange={(v) => set({ adminPassword: v })}
                        autoFocus
                        autoComplete="new-password"
                      />
                    </Field>
                    <Field label="Confirm password" width={200}>
                      <TextField name="adminPassword2" type="password" value={pw2} onChange={setPw2} autoComplete="new-password" />
                    </Field>
                  </FieldRow>
                  {!req.adminPassword && (
                    <div className="cx-note cx-warn">
                      <ShieldAlert size={16} />
                      <div>
                        Without a password, anyone who uses this computer, and any program running on it, can open and change these books. You can
                        add a password later from the Company menu.
                      </div>
                    </div>
                  )}
                </>
              )}
              {k === 'bank' && (
                <>
                  <WizHead
                    title="Add your bank and credit card accounts"
                    sub="Enter what each account had on the date you start using SerieX Books (your last statement balance is a good choice)."
                  />
                  <div className="cx-banktable" data-field="bank">
                    <div className="cx-bankhead">
                      <span>Account name</span>
                      <span>Type</span>
                      <span className="cx-right">Balance</span>
                      <span>As of</span>
                      <span />
                    </div>
                    {banks.map((b) => (
                      <div key={b.key} className="cx-bankrow">
                        <div>
                          <TextField
                            name={'bank' + b.key}
                            value={b.name}
                            onChange={(v) => {
                              touched.current = true;
                              setBanks((l) => l.map((x) => (x.key === b.key ? { ...x, name: v } : x)));
                            }}
                            aria-label="Account name"
                            title={b.name || undefined}
                          />
                        </div>
                        <Select
                          value={b.type}
                          onChange={(v) => setBanks((l) => l.map((x) => (x.key === b.key ? { ...x, type: v as AccountType } : x)))}
                          options={[
                            { value: 'Bank', label: 'Bank' },
                            { value: 'Credit Card', label: 'Credit card' },
                          ]}
                          aria-label="Account type"
                        />
                        <MoneyField
                          value={b.balance}
                          onChange={(v) => setBanks((l) => l.map((x) => (x.key === b.key ? { ...x, balance: v ?? 0 } : x)))}
                          aria-label="Opening balance"
                        />
                        <DateField value={b.date} onChange={(v) => setBanks((l) => l.map((x) => (x.key === b.key ? { ...x, date: v } : x)))} />
                        <button
                          type="button"
                          className="sx-iconbtn"
                          title="Remove this account"
                          aria-label="Remove this account"
                          onClick={() => setBanks((l) => l.filter((x) => x.key !== b.key))}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                    <div className="cx-row" style={{ gap: 8, paddingTop: 6 }}>
                      <Button size="sm" icon={Plus} label="Bank account" onClick={() => setBanks((l) => [...l, bankRow('', 'Bank')])} />
                      <Button size="sm" icon={CreditCard} label="Credit card" onClick={() => setBanks((l) => [...l, bankRow('', 'Credit Card')])} />
                    </div>
                  </div>
                  <div className="cx-hint">
                    For a credit card, enter the amount you owe. Opening balances go to Opening Balance Equity
                    {track.defaultChart && req.industry !== 'none'
                      ? '; Checking, Savings, Petty Cash and Credit Card are already in the recommended chart of accounts, so a line with one of these names uses it.'
                      : '.'}
                  </div>
                </>
              )}
            </div>
          )}
          <div className="cx-dlg-foot">
            <div className="cx-grow cx-muted cx-small">
              Step {step + 1} of {steps.length}
            </div>
            <Button label="Cancel" onClick={() => void win?.close()} disabled={!!busy} />
            {step > 0 && <Button label="Back" onClick={() => goto(step - 1)} disabled={!!busy} />}
            {last ? (
              <Button variant="primary" label="Create company" busy={!!busy} onClick={() => void create()} />
            ) : (
              <Button variant="primary" label="Next" disabled={!!busy} onClick={() => goto(step + 1)} />
            )}
          </div>
        </div>
      </div>
    </FormErrorsProvider>
  );
}

function WizHead({ title, sub }: { title: string; sub: ReactNode }) {
  return (
    <div className="cx-wiz-head">
      <h2>{title}</h2>
      <div className="cx-muted">{sub}</div>
    </div>
  );
}

function TrackCard({
  checked,
  onChange,
  label,
  desc,
  disabled,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  label: string;
  desc: string;
  disabled?: boolean;
}) {
  return (
    <label className={'cx-trackcard' + (checked ? ' cx-on' : '') + (disabled ? ' cx-locked' : '')}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange?.(e.target.checked)} />
      <span>
        <b>{label}</b>
        <span className="cx-muted cx-small">{desc}</span>
      </span>
    </label>
  );
}
