// New / Edit Name dialog for the Other Names List (owners, partners, employees paid by check...).
// Sections: Contact (company, Mr./Ms. first M.I. last, job title, phones, email, website),
// Address, Additional info (account no., print on check as, notes). Inactive check box (edit).
// A save sends the name's updatedAt as it was opened: when someone else changed it since, the
// server refuses and the dialog offers to reload the latest version (useStaleCopy).
import { useEffect, useState } from 'react';
import { Contact, Info, MapPin, StickyNote } from 'lucide-react';
import { api, ApiError } from '@/api/client';
import { invalidateAll, useNames } from '@/api/hooks';
import type { Address, Name } from '@/api/types';
import { Checkbox, EditDialog, Field, newNameRecord, notifyCreated, Spinner, TextArea, TextField, toast, useFormErrors } from '@/components';
import { useWindow } from '@/windows/WindowContext';
import { focusLater, snapshotOf, useStaleCopy } from './common';
import './lists.css';

export interface OtherNameEditDialogProps {
  id?: number;
  /** Name typed in a picker ("Add with details…"). */
  name?: string;
}

const SECTIONS = [
  { key: 'contact', label: 'Contact', icon: Contact, fields: ['companyName', 'salutation', 'firstName', 'middleName', 'lastName', 'jobTitle', 'phone', 'mobile', 'altPhone', 'fax', 'email', 'ccEmail', 'website'] },
  { key: 'address', label: 'Address', icon: MapPin, fields: ['billAddress'] },
  { key: 'more', label: 'Additional info', icon: StickyNote, fields: ['accountNumber', 'printOnCheckAs', 'notes'] },
];

export default function OtherNameEditDialog(props: OtherNameEditDialogProps) {
  const win = useWindow();
  const fe = useFormErrors();
  const { data: allNames } = useNames(undefined, { active: 'all' });
  const [isNew, setIsNew] = useState(!props.id);
  const [rec, setRec] = useState<Name | null>(() => (props.id ? null : (newNameRecord('other', props.name ?? '') as Name)));
  const [tab, setTab] = useState('contact');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [originalName, setOriginalName] = useState('');
  // "print on check as" follows the name until the user changes it
  const [printLinked, setPrintLinked] = useState(true);
  /** The record as it was opened (a new name without its name), to tell whether anything changed. */
  const [baseline, setBaseline] = useState<string | null>(() => (props.id ? null : snapshotOf({ rec: newNameRecord('other', ''), printLinked: true })));
  // EditDialog marks the window changed and asks "Do you want to save your changes?" on close
  const dirty = !!rec && baseline !== null && snapshotOf({ rec, printLinked }) !== baseline;

  /** Shows an existing name as stored (its updatedAt is kept: it is sent back on save). */
  const loadName = (n: Name) => {
    const linked = !n.printOnCheckAs || n.printOnCheckAs === n.name;
    setRec(n);
    setOriginalName(n.name);
    setPrintLinked(linked);
    setBaseline(snapshotOf({ rec: n, printLinked: linked }));
  };

  useEffect(() => {
    if (!props.id) return;
    let off = false;
    api
      .get<Name>(`/names/${props.id}`)
      .then((n) => {
        if (!off) loadName(n);
      })
      .catch((e) => !off && setLoadError((e as Error).message));
    return () => {
      off = true;
    };
  }, [props.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // someone else saved the name after it was opened: load their version (false: it is gone)
  const stale = useStaleCopy(fe, 'name', async () => {
    try {
      loadName(await api.get<Name>(`/names/${props.id}`));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
      setLoadError(`${e.message} It may have been deleted.`);
      return false;
    }
  });

  if (loadError) {
    return (
      <EditDialog title="Edit Name" onOk={() => win.close(true)} okLabel="Close">
        <div className="fl-info">
          <Info size={16} />
          <span>The name could not be loaded: {loadError}</span>
        </div>
      </EditDialog>
    );
  }
  if (!rec) {
    return (
      <div className="fl-page" style={{ alignItems: 'center', justifyContent: 'center', background: '#fff' }}>
        <Spinner label="Loading…" />
      </div>
    );
  }

  const n = rec;
  const set = (patch: Partial<Name>) => setRec((r) => (r ? { ...r, ...patch } : r));
  const setAddr = (patch: Partial<Address>) => set({ billAddress: { ...n.billAddress, ...patch } });
  const text = (field: keyof Name, label: string, extra: { width?: number; type?: string } = {}) => (
    <Field label={label} width={extra.width}>
      <TextField name={field} type={extra.type} value={n[field] as string} onChange={(v) => set({ [field]: v } as Partial<Name>)} aria-label={label} />
    </Field>
  );

  const save = async (): Promise<Name | null> => {
    fe.clearAll();
    const name = n.name.trim();
    if (!name) {
      fe.setFieldError('name', 'Enter the name.');
      return null;
    }
    if (name.includes(':')) {
      fe.setFieldError('name', 'A name cannot contain a colon (:).');
      return null;
    }
    const same = (allNames ?? []).find((x) => x.id !== n.id && x.parentId === null && x.name.toLowerCase() === name.toLowerCase());
    if (same) {
      const kind = same.kind === 'customer' ? 'a customer' : same.kind === 'vendor' ? 'a vendor' : 'another name';
      fe.setFieldError('name', `"${same.name}" is already used by ${kind}${same.active ? '' : ' (inactive)'}. Names must be unique across customers, vendors and other names.`);
      return null;
    }
    const body: Partial<Name> = { ...n, kind: 'other', name, parentId: null, printOnCheckAs: printLinked ? name : n.printOnCheckAs };
    try {
      const saved = isNew ? await api.post<Name>('/names', body) : await api.put<Name>(`/names/${n.id}`, body);
      await invalidateAll();
      if (isNew) notifyCreated({ kind: 'name', id: saved.id });
      toast(isNew ? `"${saved.name}" added to Other Names` : `"${saved.name}" saved`);
      return saved;
    } catch (e) {
      if (!(await stale.handle(e))) fe.fromError(e);
      return null;
    }
  };

  return (
    <EditDialog
      title={isNew ? 'New Name' : `Edit Name: ${originalName}`}
      errors={fe}
      dirty={dirty}
      sections={SECTIONS}
      section={tab}
      onSectionChange={setTab}
      navWidth={150}
      okLabel="Save and close"
      onOk={async () => {
        if (!(await save())) return false;
        await win.close(true);
      }}
      onSaveNew={
        isNew
          ? async () => {
              if (!(await save())) return;
              setIsNew(true);
              setRec(newNameRecord('other', '') as Name);
              setPrintLinked(true);
              setBaseline(snapshotOf({ rec: newNameRecord('other', ''), printLinked: true }));
              setTab('contact');
              focusLater(win.id, 'name');
            }
          : undefined
      }
      footerLeft={!isNew ? <Checkbox checked={!n.active} onChange={(v) => set({ active: !v })} label="Name is inactive" /> : undefined}
      extraButtons={stale.button}
      top={
        <Field label="Name" required width={340} hint="As it appears in lists and on checks.">
          <TextField
            name="name"
            value={n.name}
            onChange={(v) => set({ name: v, ...(printLinked ? { printOnCheckAs: v } : {}) })}
            autoFocus
            aria-label="Name"
            maxLength={100}
          />
        </Field>
      }
    >
      {tab === 'contact' && (
        <div className="fl-form">
          <div className="fl-grid fl-g2">
            {text('companyName', 'Company name')}
            {text('jobTitle', 'Job title')}
          </div>
          <div className="fl-grid" style={{ gridTemplateColumns: '70px minmax(0, 1fr) 50px minmax(0, 1fr)' }}>
            {text('salutation', 'Mr./Ms.')}
            {text('firstName', 'First name')}
            {text('middleName', 'M.I.')}
            {text('lastName', 'Last name')}
          </div>
          <div className="fl-grid fl-g2">
            {text('phone', 'Main phone', { type: 'tel' })}
            {text('mobile', 'Mobile', { type: 'tel' })}
            {text('altPhone', 'Alt. phone', { type: 'tel' })}
            {text('fax', 'Fax', { type: 'tel' })}
          </div>
          <div className="fl-grid fl-g2">
            {text('email', 'Main email', { type: 'email' })}
            {text('website', 'Website')}
          </div>
        </div>
      )}
      {tab === 'address' && (
        <div className="fl-form" data-field="billAddress">
          <Field label="Street">
            <TextField name="line1" value={n.billAddress.line1} onChange={(v) => setAddr({ line1: v })} aria-label="Street" />
          </Field>
          <Field label="Street, line 2">
            <TextField name="line2" value={n.billAddress.line2} onChange={(v) => setAddr({ line2: v })} aria-label="Street, line 2" />
          </Field>
          <div className="fl-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 90px 110px' }}>
            <Field label="City">
              <TextField name="city" value={n.billAddress.city} onChange={(v) => setAddr({ city: v })} aria-label="City" />
            </Field>
            <Field label="State">
              <TextField name="state" value={n.billAddress.state} onChange={(v) => setAddr({ state: v })} aria-label="State" />
            </Field>
            <Field label="ZIP">
              <TextField name="zip" value={n.billAddress.zip} onChange={(v) => setAddr({ zip: v })} aria-label="ZIP code" />
            </Field>
          </div>
          <Field label="Country" width={220}>
            <TextField name="country" value={n.billAddress.country} onChange={(v) => setAddr({ country: v })} aria-label="Country" />
          </Field>
        </div>
      )}
      {tab === 'more' && (
        <div className="fl-form">
          <div className="fl-grid fl-g2">
            {text('accountNumber', 'Account no.')}
            <Field label="Print on check as" help="The name printed on checks you write to this name. It follows the name unless you change it.">
              <TextField
                name="printOnCheckAs"
                value={printLinked ? n.name : n.printOnCheckAs}
                onChange={(v) => {
                  setPrintLinked(false);
                  set({ printOnCheckAs: v });
                }}
                aria-label="Print on check as"
              />
            </Field>
          </div>
          <Field label="Notes">
            <TextArea name="notes" value={n.notes} onChange={(v) => set({ notes: v })} rows={6} aria-label="Notes" />
          </Field>
        </div>
      )}
    </EditDialog>
  );
}
