// New Vendor / Edit Vendor dialog (sections: Address Info, Payment Settings, Tax Settings,
// Account Settings, Additional Info) with the friendlier EditDialog layout and inline errors.
import { useEffect, useMemo, useRef, useState } from 'react';
import { BookUser, CreditCard, FileText, Landmark, ListChecks } from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll } from '@/api/hooks';
import { emptyAddress, type Address, type ID, type Name } from '@/api/types';
import {
  AccountPicker,
  Button,
  Checkbox,
  DateField,
  EditDialog,
  Field,
  FieldRow,
  ListPicker,
  MoneyField,
  Spinner,
  TermsPicker,
  TextArea,
  TextField,
  msgBox,
  newNameRecord,
  notifyCreated,
  toast,
  useFormErrors,
} from '@/components';
import { useWindow } from '@/windows/WindowContext';
import { todayIso } from '@/util/dates';
import { fmtMoney } from '@/util/format';
import './vendors.css';

export interface VendorEditDialogProps {
  id?: number;
  /** Name typed in a picker ("Add with details…"). */
  name?: string;
}

type Section = 'address' | 'payment' | 'tax' | 'accounts' | 'additional';

const SALUTATIONS = ['', 'Mr.', 'Ms.', 'Mrs.', 'Dr.'];

function blankVendor(name = ''): Name {
  const n = newNameRecord('vendor', name) as Name;
  return {
    ...n,
    fullName: name,
    level: 0,
    balance: 0,
    ownBalance: 0,
    hasTxns: false,
    openingBalance: 0,
    openingDate: todayIso(),
  };
}

/** Structured address editor (street lines, city / state / ZIP, country). */
function AddressEditor({ value, onChange, prefix }: { value: Address; onChange: (a: Address) => void; prefix: string }) {
  const set = (k: keyof Address, v: string) => onChange({ ...value, [k]: v });
  return (
    <div className="vx-addr">
      <TextField name={`${prefix}.line1`} aria-label="Street" placeholder="Street" value={value.line1} onChange={(v) => set('line1', v)} />
      <TextField name={`${prefix}.line2`} aria-label="Street line 2" placeholder="Street line 2" value={value.line2} onChange={(v) => set('line2', v)} />
      <div className="vx-addr-row">
        <TextField name={`${prefix}.city`} aria-label="City" placeholder="City" value={value.city} onChange={(v) => set('city', v)} />
        <TextField name={`${prefix}.state`} aria-label="State" placeholder="State" value={value.state} onChange={(v) => set('state', v)} width={64} />
        <TextField name={`${prefix}.zip`} aria-label="ZIP" placeholder="ZIP" value={value.zip} onChange={(v) => set('zip', v)} width={88} />
      </div>
      <TextField name={`${prefix}.country`} aria-label="Country" placeholder="Country" value={value.country} onChange={(v) => set('country', v)} />
    </div>
  );
}

export default function VendorEditDialog(props: VendorEditDialogProps) {
  const win = useWindow();
  const fe = useFormErrors();
  const [rec, setRec] = useState<Name | null>(props.id ? null : blankVendor(props.name ?? ''));
  const [orig, setOrig] = useState<Name | null>(null);
  const [section, setSection] = useState<Section>('address');
  const [loadError, setLoadError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const [dirty, setDirtyState] = useState(false);
  const recRef = useRef(rec);
  recRef.current = rec;
  const nameRef = useRef<HTMLInputElement>(null);

  const setDirty = (d: boolean) => {
    dirtyRef.current = d;
    setDirtyState(d);
  };

  useEffect(() => {
    if (!props.id) return;
    api
      .get<Name>(`/names/${props.id}`)
      .then((n) => {
        setRec(n);
        setOrig(n);
      })
      .catch((e) => setLoadError((e as Error).message));
  }, [props.id]);

  useEffect(() => {
    win.setDirty(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  // "save changes?" when closing with changes
  useEffect(() => {
    win.setBeforeClose(async () => {
      if (!dirtyRef.current) return true;
      const r = await msgBox({
        title: props.id ? 'Edit Vendor' : 'New Vendor',
        message: 'You have changed this vendor. Do you want to save your changes?',
        buttons: ['Yes', 'No', 'Cancel'],
        icon: 'question',
      });
      if (r === 'Yes') return save();
      return r === 'No';
    });
    return () => win.setBeforeClose(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (rec && !props.id) setTimeout(() => nameRef.current?.focus(), 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!rec]);

  const update = (patch: Partial<Name>) => {
    setRec((r) => {
      if (!r) return r;
      const n = { ...r, ...patch };
      // "Print name on check as" follows the vendor name until it is edited
      if (patch.name !== undefined && (r.printOnCheckAs === r.name || !r.printOnCheckAs)) n.printOnCheckAs = patch.name;
      recRef.current = n;
      return n;
    });
    setDirty(true);
  };

  const title = props.id ? `Edit Vendor${orig ? ': ' + orig.name : ''}` : 'New Vendor';

  async function save(): Promise<boolean> {
    const r = recRef.current;
    if (!r) return false;
    const name = r.name.trim();
    if (!name) {
      fe.setErrors({ name: 'Enter a name for this vendor.' });
      return false;
    }
    if (name.includes(':')) {
      fe.setErrors({ name: 'A vendor name cannot contain a colon (:).' });
      return false;
    }
    if (r.creditLimit !== null && r.creditLimit < 0) {
      fe.setErrors({ creditLimit: 'The credit limit cannot be negative.' });
      setSection('payment');
      return false;
    }
    if (!r.id && r.openingBalance && !r.openingDate) {
      fe.setErrors({ openingDate: 'Enter the date of the opening balance.' });
      return false;
    }
    const body: Name = { ...r, name, kind: 'vendor', prefillAccountIds: (r.prefillAccountIds ?? []).filter((x) => !!x) };
    if (r.id) {
      delete body.openingBalance;
      delete body.openingDate;
    }
    try {
      const saved = r.id ? await api.put<Name>(`/names/${r.id}`, body) : await api.post<Name>('/names', body);
      setDirty(false);
      fe.clearAll();
      void invalidateAll();
      if (!r.id) notifyCreated({ kind: 'name', id: saved.id });
      toast(`Vendor "${saved.name}" saved`);
      setRec(saved);
      setOrig(saved);
      return true;
    } catch (e) {
      if (fe.fromError(e)) {
        const f = (e as { field?: string }).field;
        if (f === 'creditLimit' || f === 'termsId' || f === 'accountNumber') setSection('payment');
      }
      return false;
    }
  }

  const onOk = async () => {
    if (await save()) await win.close(true);
  };
  const onSaveNew = async () => {
    if (await save()) {
      setRec(blankVendor());
      setOrig(null);
      setSection('address');
      setDirty(false);
      setTimeout(() => nameRef.current?.focus(), 30);
    }
  };

  const sections = useMemo(
    () => [
      { key: 'address', label: 'Address info', icon: BookUser, fields: ['companyName', 'firstName', 'lastName', 'email', 'phone'] },
      { key: 'payment', label: 'Payment settings', icon: CreditCard, fields: ['accountNumber', 'termsId', 'printOnCheckAs', 'creditLimit'] },
      { key: 'tax', label: 'Tax settings', icon: Landmark, fields: ['taxIdent'] },
      { key: 'accounts', label: 'Account settings', icon: ListChecks, fields: ['prefillAccountIds'] },
      { key: 'additional', label: 'Additional info', icon: FileText, fields: ['typeId', 'notes'] },
    ],
    [],
  );

  if (loadError) {
    return (
      <div className="vx-dlg-error">
        <p>{loadError}</p>
        <Button label="Close" onClick={() => void win.close(true)} />
      </div>
    );
  }
  if (!rec) return <Spinner center label="Loading vendor..." />;

  const prefill: (ID | null)[] = [0, 1, 2].map((i) => rec.prefillAccountIds?.[i] ?? null);
  const setPrefill = (i: number, id: ID | null) => {
    const next = [...prefill];
    next[i] = id;
    update({ prefillAccountIds: next.filter((x): x is ID => !!x) });
  };

  const top = (
    <FieldRow align="start">
      <Field label="Vendor name" htmlFor="vx-vname" required width={300}>
        <TextField id="vx-vname" ref={nameRef} name="name" value={rec.name} onChange={(v) => update({ name: v })} maxLength={100} />
      </Field>
      {!rec.id ? (
        <>
          <Field label="Opening balance" htmlFor="vx-vob" help="What you owed this vendor on the date you start using SerieX Books. It is entered as one bill for that amount, so you can pay it later." width={150}>
            <MoneyField id="vx-vob" name="openingBalance" value={rec.openingBalance ?? 0} blankZero onChange={(v) => update({ openingBalance: v ?? 0 })} />
          </Field>
          <Field label="as of" htmlFor="vx-vobd" width={150}>
            <DateField id="vx-vobd" name="openingDate" value={rec.openingDate ?? ''} onChange={(v) => update({ openingDate: v })} />
          </Field>
        </>
      ) : (
        <div className="vx-balnote">
          <span className="sx-label-plain">Current balance</span>
          <strong>{fmtMoney(rec.balance)}</strong>
          <span className="sx-muted">Change it with bills, credits and bill payments.</span>
        </div>
      )}
    </FieldRow>
  );

  return (
    <EditDialog
      title={title}
      errors={fe}
      top={top}
      sections={sections}
      section={section}
      onSectionChange={(k) => setSection(k as Section)}
      onOk={onOk}
      onSaveNew={rec.id ? undefined : onSaveNew}
      okLabel="Save and close"
      footerLeft={
        rec.id ? <Checkbox label="Vendor is inactive" checked={!rec.active} onChange={(c) => update({ active: !c })} title="Inactive vendors are hidden from lists but keep their history." /> : null
      }
      className="vx-vendordlg"
      navWidth={186}
    >
      {section === 'address' && (
        <div className="vx-sec">
          <Field label="Company name" htmlFor="vx-comp">
            <TextField id="vx-comp" name="companyName" value={rec.companyName} onChange={(v) => update({ companyName: v })} />
          </Field>
          <div className="vx-fullname">
            <Field label="Mr./Ms." htmlFor="vx-sal" width={84}>
              <TextField id="vx-sal" name="salutation" list="vx-salutations" value={rec.salutation} onChange={(v) => update({ salutation: v })} />
              <datalist id="vx-salutations">
                {SALUTATIONS.filter(Boolean).map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </Field>
            <Field label="First name" htmlFor="vx-first">
              <TextField id="vx-first" name="firstName" value={rec.firstName} onChange={(v) => update({ firstName: v })} />
            </Field>
            <Field label="M.I." htmlFor="vx-mi" width={56}>
              <TextField id="vx-mi" name="middleName" value={rec.middleName} onChange={(v) => update({ middleName: v })} />
            </Field>
            <Field label="Last name" htmlFor="vx-last">
              <TextField id="vx-last" name="lastName" value={rec.lastName} onChange={(v) => update({ lastName: v })} />
            </Field>
          </div>
          <Field label="Job title" htmlFor="vx-job">
            <TextField id="vx-job" name="jobTitle" value={rec.jobTitle} onChange={(v) => update({ jobTitle: v })} />
          </Field>
          <div className="vx-grid2">
            <Field label="Main phone" htmlFor="vx-ph">
              <TextField id="vx-ph" name="phone" value={rec.phone} onChange={(v) => update({ phone: v })} />
            </Field>
            <Field label="Main email" htmlFor="vx-em">
              <TextField id="vx-em" name="email" value={rec.email} onChange={(v) => update({ email: v })} />
            </Field>
            <Field label="Mobile" htmlFor="vx-mob">
              <TextField id="vx-mob" name="mobile" value={rec.mobile} onChange={(v) => update({ mobile: v })} />
            </Field>
            <Field label="CC email" htmlFor="vx-cc">
              <TextField id="vx-cc" name="ccEmail" value={rec.ccEmail} onChange={(v) => update({ ccEmail: v })} />
            </Field>
            <Field label="Alt. phone" htmlFor="vx-alt">
              <TextField id="vx-alt" name="altPhone" value={rec.altPhone} onChange={(v) => update({ altPhone: v })} />
            </Field>
            <Field label="Website" htmlFor="vx-web">
              <TextField id="vx-web" name="website" value={rec.website} onChange={(v) => update({ website: v })} />
            </Field>
            <Field label="Fax" htmlFor="vx-fax">
              <TextField id="vx-fax" name="fax" value={rec.fax} onChange={(v) => update({ fax: v })} />
            </Field>
          </div>
          <div className="vx-addrs">
            <div className="vx-addrcol">
              <div className="vx-subhead">Billed from</div>
              <AddressEditor prefix="billAddress" value={rec.billAddress ?? emptyAddress()} onChange={(a) => update({ billAddress: a })} />
            </div>
            <div className="vx-addrcopy">
              <Button small label="Copy >>" title="Copy the billed-from address to shipped from" onClick={() => update({ shipAddress: { ...(rec.billAddress ?? emptyAddress()) } })} />
            </div>
            <div className="vx-addrcol">
              <div className="vx-subhead">Shipped from</div>
              <AddressEditor prefix="shipAddress" value={rec.shipAddress ?? emptyAddress()} onChange={(a) => update({ shipAddress: a })} />
            </div>
          </div>
        </div>
      )}
      {section === 'payment' && (
        <div className="vx-sec vx-sec-narrow">
          <Field label="Account no." htmlFor="vx-acno" help="Your account number with this vendor. It is printed in the memo of bill payment checks.">
            <TextField id="vx-acno" name="accountNumber" value={rec.accountNumber} onChange={(v) => update({ accountNumber: v })} />
          </Field>
          <Field label="Payment terms" htmlFor="vx-terms" help="Terms">
            <TermsPicker id="vx-terms" name="termsId" value={rec.termsId} onChange={(id) => update({ termsId: id })} />
          </Field>
          <Field label="Print name on check as" htmlFor="vx-poc" hint="The payee name printed on checks and bill payments.">
            <TextField id="vx-poc" name="printOnCheckAs" value={rec.printOnCheckAs} onChange={(v) => update({ printOnCheckAs: v })} />
          </Field>
          <Field label="Credit limit" htmlFor="vx-cl" help="The most this vendor lets you owe. Leave it blank for no limit." width={180}>
            <MoneyField id="vx-cl" name="creditLimit" nullable value={rec.creditLimit} onChange={(v) => update({ creditLimit: v })} />
          </Field>
        </div>
      )}
      {section === 'tax' && (
        <div className="vx-sec vx-sec-narrow">
          <Field label="Vendor tax ID" htmlFor="vx-tid" help="The vendor's federal tax ID (EIN) or social security number, needed for 1099 forms.">
            <TextField id="vx-tid" name="taxIdent" value={rec.taxIdent} onChange={(v) => update({ taxIdent: v })} />
          </Field>
          <Checkbox
            label="Vendor eligible for 1099"
            checked={rec.is1099}
            onChange={(c) => update({ is1099: c })}
            title="Track payments to this contractor for the year-end 1099-NEC form."
          />
          <p className="vx-hint">Turn this on for independent contractors you pay $600 or more in a year.</p>
        </div>
      )}
      {section === 'accounts' && (
        <div className="vx-sec vx-sec-narrow">
          <p className="vx-hint">
            Choose up to three expense accounts. When you enter a bill or write a check for this vendor, these accounts are filled in for you on the Expenses tab.
          </p>
          {prefill.map((id, i) => (
            <Field key={i} label={`Account ${i + 1}`} htmlFor={`vx-pf${i}`}>
              <AccountPicker
                id={`vx-pf${i}`}
                name={i === 0 ? 'prefillAccountIds' : undefined}
                value={id}
                excludeTypes={['Accounts Receivable', 'Accounts Payable', 'Non-Posting']}
                onChange={(v) => setPrefill(i, v)}
              />
            </Field>
          ))}
          {prefill.some(Boolean) && (
            <Button small variant="ghost" label="Clear all" style={{ alignSelf: 'flex-start' }} onClick={() => update({ prefillAccountIds: [] })} />
          )}
        </div>
      )}
      {section === 'additional' && (
        <div className="vx-sec vx-sec-narrow">
          <Field label="Vendor type" htmlFor="vx-vtype" help="Your own grouping of vendors (for example Suppliers, Subcontractors, Utilities). Reports can be filtered by it.">
            <ListPicker id="vx-vtype" list="vendor_type" name="typeId" value={rec.typeId} onChange={(id) => update({ typeId: id })} />
          </Field>
          <Field label="Notes" htmlFor="vx-notes">
            <TextArea id="vx-notes" name="notes" value={rec.notes} onChange={(v) => update({ notes: v })} height={120} />
          </Field>
        </div>
      )}
    </EditDialog>
  );
}
