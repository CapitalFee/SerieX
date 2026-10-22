// New / Edit Customer and New / Edit Job dialog (sections on the left, friendly
// layout and inline errors): Address info, Payment settings, Sales tax settings, Additional info,
// Job info, Notes. New customers may have an opening balance (an invoice dated "as of").
// props: { id?, parentId? (new job), name? (prefill from a picker), section? }
import { cloneElement, isValidElement, useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react';
import { BriefcaseBusiness, CreditCard, FileText, Info, MapPin, Percent } from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll, usePrefValues } from '@/api/hooks';
import { emptyAddress, type Address, type Name } from '@/api/types';
import {
  Button,
  Checkbox,
  DateField,
  EditDialog,
  Field,
  FieldRow,
  ItemPicker,
  ListPicker,
  MoneyField,
  NamePicker,
  PaymentMethodPicker,
  RepPicker,
  Select,
  Spinner,
  TermsPicker,
  TextArea,
  TextField,
  msgBox,
  newNameRecord,
  notifyCreated,
  toast,
  useFormErrors,
  type EditDialogSection,
} from '@/components';
import { useWindow } from '@/windows/WindowContext';
import { loadPrefs } from './salesForm';
import { todayIso } from '@/util/dates';
import './customers.css';

export interface CustomerEditDialogProps {
  id?: number;
  parentId?: number;
  /** Name typed in a picker ("Add with details…"). */
  name?: string;
  /** Section to open first (e.g. "notes"). */
  section?: string;
}

const JOB_STATUSES: Name['jobStatus'][] = ['', 'Pending', 'Awarded', 'In progress', 'Closed', 'Not awarded'];

type SectionKey = 'address' | 'payment' | 'tax' | 'additional' | 'job' | 'notes';

function blankCustomer(name: string, parent: Name | null): Name {
  const base = newNameRecord('customer', name) as Name;
  const n: Name = { ...base, fullName: '', level: 0, balance: 0, ownBalance: 0, hasTxns: false, printOnCheckAs: name };
  if (parent) {
    // a new job inherits the customer's contact, addresses, terms and tax settings
    return {
      ...n,
      parentId: parent.id,
      companyName: parent.companyName,
      salutation: parent.salutation,
      firstName: parent.firstName,
      middleName: parent.middleName,
      lastName: parent.lastName,
      jobTitle: parent.jobTitle,
      phone: parent.phone,
      altPhone: parent.altPhone,
      mobile: parent.mobile,
      fax: parent.fax,
      email: parent.email,
      ccEmail: parent.ccEmail,
      website: parent.website,
      billAddress: { ...parent.billAddress },
      shipAddress: { ...parent.shipAddress },
      termsId: parent.termsId,
      repId: parent.repId,
      paymentMethodId: parent.paymentMethodId,
      taxable: parent.taxable,
      taxItemId: parent.taxItemId,
      resaleNumber: parent.resaleNumber,
      typeId: parent.typeId,
      creditLimit: null,
      jobStatus: 'Pending',
    };
  }
  return n;
}

/** Address editor: three street lines, city / state / ZIP, country. */
function AddressEditor({ value, onChange, prefix }: { value: Address; onChange: (a: Address) => void; prefix: string }) {
  const set = (k: keyof Address) => (v: string) => onChange({ ...value, [k]: v });
  return (
    <div className="sx-cust-addr">
      <TextField name={`${prefix}.line1`} value={value.line1} onChange={set('line1')} placeholder="Street" aria-label="Street line 1" />
      <TextField name={`${prefix}.line2`} value={value.line2} onChange={set('line2')} placeholder="Street line 2" aria-label="Street line 2" />
      <TextField name={`${prefix}.line3`} value={value.line3} onChange={set('line3')} placeholder="Street line 3" aria-label="Street line 3" />
      <div className="sx-cust-addr-city">
        <TextField name={`${prefix}.city`} value={value.city} onChange={set('city')} placeholder="City" aria-label="City" />
        <TextField name={`${prefix}.state`} value={value.state} onChange={set('state')} placeholder="State" aria-label="State" width={50} />
        <TextField name={`${prefix}.zip`} value={value.zip} onChange={set('zip')} placeholder="ZIP" aria-label="ZIP" width={72} />
      </div>
      <TextField name={`${prefix}.country`} value={value.country} onChange={set('country')} placeholder="Country" aria-label="Country" />
    </div>
  );
}

export default function CustomerEditDialog(props: CustomerEditDialogProps) {
  const win = useWindow();
  const prefs = usePrefValues();
  const fe = useFormErrors();
  const isNew = !props.id;
  const [rec, setRec] = useState<Name | null>(null);
  const [orig, setOrig] = useState<Name | null>(null);
  const [isJob, setIsJob] = useState(!!props.parentId);
  const [section, setSection] = useState<SectionKey>((props.section as SectionKey) || 'address');
  const [opening, setOpening] = useState<number>(0);
  const [openingDate, setOpeningDate] = useState(todayIso());
  const [loadError, setLoadError] = useState<string | null>(null);

  // load the record (or build a new one; a new job copies its customer)
  const load = async () => {
    setLoadError(null);
    try {
      if (props.id) {
        const n = await api.get<Name>(`/names/${props.id}`);
        setRec(n);
        setOrig(n);
        setIsJob(!!n.parentId);
      } else {
        const parent = props.parentId ? await api.get<Name>(`/names/${props.parentId}`) : null;
        const n = blankCustomer(props.name ?? '', parent);
        if (!parent) n.taxItemId = (await loadPrefs()).defaultSalesTaxItemId ?? null;
        setRec(n);
        setOrig(null);
        setOpening(0);
        setOpeningDate(todayIso());
      }
    } catch (e) {
      setLoadError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.id, props.parentId]);

  const dirty = useMemo(() => {
    if (!rec) return false;
    if (!orig) return !!rec.name.trim() || opening !== 0;
    return JSON.stringify(rec) !== JSON.stringify(orig);
  }, [rec, orig, opening]);
  useEffect(() => {
    win.setDirty(dirty);
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  const title = isNew ? (isJob ? 'New Job' : 'New Customer') : `${isJob ? 'Edit Job' : 'Edit Customer'}: ${orig?.fullName ?? ''}`;

  // ask before closing with changes, like the vendor dialog and the forms: Yes saves, No discards, Cancel stays
  useEffect(() => {
    win.setBeforeClose(async () => {
      if (!dirtyRef.current) return true;
      const r = await msgBox({
        title: isNew ? (isJob ? 'New Job' : 'New Customer') : isJob ? 'Edit Job' : 'Edit Customer',
        message: `You have changed this ${isJob ? 'job' : 'customer'}. Do you want to save your changes?`,
        buttons: ['Yes', 'No', 'Cancel'],
        icon: 'question',
      });
      if (r === 'Yes') return !!(await saveRef.current?.());
      return r === 'No';
    });
    return () => win.setBeforeClose(null);
  }, [isNew, isJob]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirtyRef = useMemoRef(dirty);
  /** Latest save function (the close question runs it). */
  const saveRef = useRef<(() => Promise<Name | null>) | null>(null);

  if (loadError)
    return (
      <div className="sx-cust-dlg-pad">
        <div className="sx-cust-dlg-error">{loadError}</div>
        <Button label="Try again" onClick={() => void load()} />
      </div>
    );
  if (!rec) return <Spinner center label="Loading..." />;

  const set = (patch: Partial<Name>) => setRec((r) => (r ? { ...r, ...patch } : r));

  const save = async (): Promise<Name | null> => {
    const r = rec;
    const errs: Record<string, string> = {};
    if (!r.name.trim()) errs.name = isJob ? 'Enter a name for the job.' : 'Enter a name for the customer.';
    if (isJob && !r.parentId) errs.parentId = 'Choose the customer this job belongs to.';
    if (r.creditLimit !== null && r.creditLimit < 0) errs.creditLimit = 'The credit limit cannot be negative.';
    if (isNew && opening !== 0 && !openingDate) errs.openingDate = 'Enter the date of the opening balance.';
    if (Object.keys(errs).length) {
      fe.setErrors(errs);
      return null;
    }
    const body: Name = { ...r, name: r.name.trim(), kind: 'customer', parentId: isJob ? r.parentId : null };
    if (isNew && opening) {
      body.openingBalance = opening;
      body.openingDate = openingDate;
    }
    try {
      const saved = isNew ? await api.post<Name>('/names', body) : await api.put<Name>(`/names/${r.id}`, body);
      void invalidateAll();
      if (isNew) notifyCreated({ kind: 'name', id: saved.id });
      toast(`${isJob ? 'Job' : 'Customer'} "${saved.fullName || saved.name}" saved`, { kind: 'success' });
      fe.clearAll();
      return saved;
    } catch (e) {
      fe.fromError(e, { nameField: 'name' });
      return null;
    }
  };

  saveRef.current = save;

  const onOk = async () => {
    const s = await save();
    if (s) {
      setOrig(s);
      setRec(s);
      win.setDirty(false);
      await win.close(true);
    }
  };
  const onSaveNew = async () => {
    const s = await save();
    if (!s) return;
    const parent = isJob && s.parentId ? await api.get<Name>(`/names/${s.parentId}`).catch(() => null) : null;
    setRec(blankCustomer('', parent));
    setOrig(null);
    setOpening(0);
    setSection('address');
    win.setDirty(false);
  };

  const sections: EditDialogSection[] = [
    { key: 'address', label: 'Address info', icon: MapPin, fields: ['companyName', 'firstName', 'lastName', 'email', 'phone'] },
    { key: 'payment', label: 'Payment settings', icon: CreditCard, fields: ['accountNumber', 'creditLimit', 'termsId', 'paymentMethodId'] },
    { key: 'tax', label: 'Sales tax', icon: Percent, fields: ['taxItemId', 'resaleNumber'], hidden: !prefs.salesTaxEnabled },
    { key: 'additional', label: 'Additional info', icon: Info, fields: ['typeId', 'repId'] },
    { key: 'job', label: 'Job info', icon: BriefcaseBusiness, fields: ['jobStatus', 'jobStartDate', 'jobProjectedEnd', 'jobEndDate', 'jobDescription', 'jobTypeId'] },
    { key: 'notes', label: 'Notes', icon: FileText, fields: ['notes'] },
  ];

  const top = (
    <div className="sx-cust-edit-top">
      <FieldRow>
        <LField label={isJob ? 'Job name' : 'Customer name'} required style={fw(isJob ? 220 : 320)}>
          <TextField name="name" value={rec.name} autoFocus onChange={(v) => set({ name: v, printOnCheckAs: v })} />
        </LField>
        {isJob && (
          <LField label="Customer" required style={fw(220)} help="The customer this job belongs to.">
            <NamePicker
              name="parentId"
              kinds={['customer']}
              includeJobs={false}
              value={rec.parentId}
              addNew={false}
              onChange={(id) => set({ parentId: id })}
              readOnly={!isNew && !!orig?.hasTxns}
            />
          </LField>
        )}
        {isNew ? (
          <>
            <LField label="Opening balance" style={fw(124)} help="What this customer owed you on the date below, before you started using SerieX Books. It is recorded as an invoice.">
              <MoneyField name="openingBalance" value={opening} onChange={(v) => setOpening(v ?? 0)} blankZero />
            </LField>
            <LField label="As of" style={fw(132)}>
              <DateField name="openingDate" value={openingDate} onChange={setOpeningDate} />
            </LField>
          </>
        ) : (
          <Field label={isJob ? 'Job balance' : 'Current balance'} style={fw(150)} hint="Change it with transactions.">
            <div className="sx-cust-balance">${(orig?.balance ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          </Field>
        )}
      </FieldRow>
      {isNew && !isJob && (
        <div className="sx-cust-jobtoggle">
          <Checkbox checked={isJob} onChange={(v) => setIsJob(v)} label="This is a job for an existing customer" />
        </div>
      )}
    </div>
  );

  return (
    <EditDialog
      title={title}
      errors={fe}
      top={top}
      sections={sections}
      section={section}
      onSectionChange={(k) => setSection(k as SectionKey)}
      onOk={onOk}
      okLabel="Save and close"
      onSaveNew={isNew ? onSaveNew : undefined}
      footerLeft={
        !isNew ? (
          <Checkbox checked={!rec.active} onChange={(v) => set({ active: !v })} label={isJob ? 'Job is inactive' : 'Customer is inactive'} title="Inactive customers are hidden from lists but keep their history" />
        ) : null
      }
      className="sx-cust-edit"
    >
      {section === 'address' && (
        <div className="sx-cust-edit-grid">
          <FieldRow>
            <LField label="Company name">
              <TextField name="companyName" value={rec.companyName} onChange={(v) => set({ companyName: v })} />
            </LField>
            <LField label="Job title" style={fw(170)}>
              <TextField name="jobTitle" value={rec.jobTitle} onChange={(v) => set({ jobTitle: v })} />
            </LField>
          </FieldRow>
          <FieldRow>
            <LField label="Mr./Ms." style={fw(66)}>
              <TextField name="salutation" value={rec.salutation} onChange={(v) => set({ salutation: v })} />
            </LField>
            <LField label="First name">
              <TextField name="firstName" value={rec.firstName} onChange={(v) => set({ firstName: v })} />
            </LField>
            <LField label="M.I." style={fw(48)}>
              <TextField name="middleName" value={rec.middleName} onChange={(v) => set({ middleName: v })} />
            </LField>
            <LField label="Last name">
              <TextField name="lastName" value={rec.lastName} onChange={(v) => set({ lastName: v })} />
            </LField>
          </FieldRow>
          <FieldRow className="sx-cust-4col">
            <LField label="Main phone">
              <TextField name="phone" value={rec.phone} onChange={(v) => set({ phone: v })} />
            </LField>
            <LField label="Alt. phone">
              <TextField name="altPhone" value={rec.altPhone} onChange={(v) => set({ altPhone: v })} />
            </LField>
            <LField label="Mobile">
              <TextField name="mobile" value={rec.mobile} onChange={(v) => set({ mobile: v })} />
            </LField>
            <LField label="Fax">
              <TextField name="fax" value={rec.fax} onChange={(v) => set({ fax: v })} />
            </LField>
          </FieldRow>
          <FieldRow className="sx-cust-3col">
            <LField label="Main email">
              <TextField name="email" value={rec.email} onChange={(v) => set({ email: v })} type="email" />
            </LField>
            <LField label="CC email">
              <TextField name="ccEmail" value={rec.ccEmail} onChange={(v) => set({ ccEmail: v })} type="email" />
            </LField>
            <LField label="Website">
              <TextField name="website" value={rec.website} onChange={(v) => set({ website: v })} />
            </LField>
          </FieldRow>
          <div className="sx-cust-addrpair">
            <Field label="Invoice / Bill to">
              <AddressEditor prefix="billAddress" value={rec.billAddress ?? emptyAddress()} onChange={(a) => set({ billAddress: a })} />
            </Field>
            <div className="sx-cust-copybtn">
              <Button small label="Copy >>" title="Copy the billing address to the shipping address" onClick={() => set({ shipAddress: { ...rec.billAddress } })} />
            </div>
            <Field label="Ship to">
              <AddressEditor prefix="shipAddress" value={rec.shipAddress ?? emptyAddress()} onChange={(a) => set({ shipAddress: a })} />
            </Field>
          </div>
        </div>
      )}
      {section === 'payment' && (
        <div className="sx-cust-edit-grid">
          <FieldRow>
            <LField label="Account no." style={fw(200)} help="Your own reference number for this customer (printed on statements).">
              <TextField name="accountNumber" value={rec.accountNumber} onChange={(v) => set({ accountNumber: v })} />
            </LField>
            <LField label="Credit limit" style={fw(160)} help="You are warned when an invoice would make the customer's balance go over this amount. Leave blank for no limit.">
              <MoneyField name="creditLimit" nullable value={rec.creditLimit} onChange={(v) => set({ creditLimit: v })} />
            </LField>
          </FieldRow>
          <FieldRow>
            <LField label="Payment terms" style={fw(200)} help="Terms">
              <TermsPicker name="termsId" value={rec.termsId} onChange={(id) => set({ termsId: id })} />
            </LField>
            <LField label="Preferred payment method" style={fw(220)}>
              <PaymentMethodPicker name="paymentMethodId" value={rec.paymentMethodId} onChange={(id) => set({ paymentMethodId: id })} />
            </LField>
          </FieldRow>
        </div>
      )}
      {section === 'tax' && (
        <div className="sx-cust-edit-grid">
          <FieldRow>
            <LField label="Tax code" style={fw(170)} help="Tax: sales to this customer are taxable. Non: the customer does not pay sales tax (e.g. a reseller or a tax-exempt organization).">
              <Select
                name="taxable"
                value={rec.taxable ? 'Tax' : 'Non'}
                options={[
                  { value: 'Tax', label: 'Tax - Taxable' },
                  { value: 'Non', label: 'Non - Non-taxable' },
                ]}
                onChange={(v) => set({ taxable: v === 'Tax' })}
              />
            </LField>
            <LField label="Tax item" style={fw(240)} help="Sales Tax Item">
              <ItemPicker name="taxItemId" compact types={['Sales Tax Item', 'Sales Tax Group']} value={rec.taxItemId} onChange={(id) => set({ taxItemId: id })} />
            </LField>
          </FieldRow>
          <FieldRow>
            <LField label="Resale no." style={fw(200)} help="The customer's resale certificate number (for non-taxable resellers).">
              <TextField name="resaleNumber" value={rec.resaleNumber} onChange={(v) => set({ resaleNumber: v })} />
            </LField>
          </FieldRow>
        </div>
      )}
      {section === 'additional' && (
        <div className="sx-cust-edit-grid">
          <FieldRow>
            <LField label="Customer type" style={fw(220)} help="Your own grouping of customers (Residential, Commercial...), used to filter reports and statements.">
              <ListPicker list="customer_type" name="typeId" value={rec.typeId} onChange={(id) => set({ typeId: id })} />
            </LField>
            <LField label="Rep" style={fw(200)} help="The sales rep who usually handles this customer.">
              <RepPicker name="repId" value={rec.repId} onChange={(id) => set({ repId: id })} listWidth={220} />
            </LField>
          </FieldRow>
        </div>
      )}
      {section === 'job' && (
        <div className="sx-cust-edit-grid">
          {!isJob && <p className="sx-cust-note">Use these fields when you do the work for this customer as one project. For several projects, add jobs to the customer instead.</p>}
          <FieldRow>
            <LField label="Job status" style={fw(170)}>
              <Select name="jobStatus" value={rec.jobStatus} options={JOB_STATUSES.map((s) => ({ value: s, label: s || 'None' }))} onChange={(v) => set({ jobStatus: v as Name['jobStatus'] })} />
            </LField>
            <LField label="Start date" style={fw(140)}>
              <DateField name="jobStartDate" value={rec.jobStartDate} onChange={(d) => set({ jobStartDate: d })} />
            </LField>
            <LField label="Projected end" style={fw(140)}>
              <DateField name="jobProjectedEnd" value={rec.jobProjectedEnd} onChange={(d) => set({ jobProjectedEnd: d })} />
            </LField>
            <LField label="End date" style={fw(140)}>
              <DateField name="jobEndDate" value={rec.jobEndDate} onChange={(d) => set({ jobEndDate: d })} />
            </LField>
          </FieldRow>
          <FieldRow>
            <LField label="Job description" style={fw(380)}>
              <TextField name="jobDescription" value={rec.jobDescription} onChange={(v) => set({ jobDescription: v })} />
            </LField>
            <LField label="Job type" style={fw(200)}>
              <ListPicker list="job_type" name="jobTypeId" value={rec.jobTypeId} onChange={(id) => set({ jobTypeId: id })} />
            </LField>
          </FieldRow>
        </div>
      )}
      {section === 'notes' && (
        <div className="sx-cust-edit-grid">
          <LField label="Notes" hint="Only you see these notes (they are not printed on forms).">
            <TextArea name="notes" value={rec.notes} onChange={(v) => set({ notes: v })} height={220} />
          </LField>
        </div>
      )}
    </EditDialog>
  );
}

/**
 * A dialog field whose label names its control: the control gets an id unique to this window and the
 * label points to it (screen readers read "Main phone", clicking the label focuses the field).
 */
function LField(props: React.ComponentProps<typeof Field>) {
  const autoId = useId();
  const child = props.children;
  if (props.htmlFor || !isValidElement(child)) return <Field {...props} />;
  const el = child as ReactElement<{ id?: string; 'aria-label'?: string }>;
  const id = el.props.id ?? autoId;
  // a text label also becomes the control's aria-label, so the help button is not read as part of the name
  const aria = el.props['aria-label'] ?? (typeof props.label === 'string' ? props.label : undefined);
  return (
    <Field {...props} htmlFor={id}>
      {cloneElement(el, { id, 'aria-label': aria })}
    </Field>
  );
}

/** Flex style of a dialog field of about `px` pixels (it may shrink on narrow dialogs). */
function fw(px: number): React.CSSProperties {
  return { flex: `0 1 ${px}px`, minWidth: Math.min(px, 60) };
}

/** A ref that always holds the latest value. */
function useMemoRef<T>(v: T): { current: T } {
  const [ref] = useState(() => ({ current: v }));
  ref.current = v;
  return ref;
}

