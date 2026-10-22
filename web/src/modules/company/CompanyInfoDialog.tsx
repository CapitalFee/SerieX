// Company > Company Information: name, address and contact details shown on forms and reports,
// legal information and the fiscal / income tax year. Read-only for users who are not administrators.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Building2, Landmark, CalendarRange, Lock } from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll, queryClient, useCompanyInfo } from '@/api/hooks';
import type { CompanyInfo } from '@/api/types';
import { EditDialog, Field, FieldRow, Select, Spinner, TextField, toast, useFormErrors, type EditDialogSection } from '@/components';
import { confirmBox } from '@/components/dialogs';
import { useOptionalWindow } from '@/windows/WindowContext';
import { useSession } from '@/state/session';
import { ADMIN_ONLY_NOTE, ENTITY_TYPES, MONTH_OPTIONS, useIsAdmin } from './shared';
import './company.css';

export interface CompanyInfoDialogProps {
  /** Section to open first: "contact" | "legal" | "report". */
  section?: string;
}

const SECTIONS: EditDialogSection[] = [
  {
    key: 'contact',
    label: 'Contact information',
    icon: Building2,
    fields: ['name', 'address1', 'address2', 'city', 'state', 'zip', 'country', 'phone', 'fax', 'email', 'website'],
  },
  { key: 'legal', label: 'Legal information', icon: Landmark, fields: ['legalName', 'taxId', 'entityType'] },
  { key: 'report', label: 'Report information', icon: CalendarRange, fields: ['fiscalYearStartMonth', 'taxYearStartMonth'] },
];

export default function CompanyInfoDialog({ section }: CompanyInfoDialogProps) {
  const win = useOptionalWindow();
  const q = useCompanyInfo();
  const fe = useFormErrors();
  const [rec, setRec] = useState<CompanyInfo | null>(null);
  const [tab, setTab] = useState(section && SECTIONS.some((s) => s.key === section) ? section : 'contact');
  const admin = useIsAdmin();
  /** Not an administrator: the information is shown but cannot be changed. */
  const ro = admin === false;

  useEffect(() => {
    if (q.data && !rec) setRec(q.data);
  }, [q.data, rec]);

  const dirty = useMemo(() => !!rec && !!q.data && JSON.stringify(rec) !== JSON.stringify(q.data), [rec, q.data]);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  useEffect(() => {
    win?.setDirty(dirty);
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!win) return;
    win.setBeforeClose(async () => (dirtyRef.current ? confirmBox('Discard your changes to the company information?', 'Company Information') : true));
    return () => win.setBeforeClose(null);
  }, [win?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rec || admin === undefined) {
    return (
      <div className="cx-dlg" style={{ display: 'grid', placeItems: 'center' }}>
        {q.error ? <span className="cx-muted">{(q.error as Error).message}</span> : <Spinner label="Loading..." />}
      </div>
    );
  }

  const set = (patch: Partial<CompanyInfo>) => setRec((r) => (r ? { ...r, ...patch } : r));

  const save = async (): Promise<boolean> => {
    fe.clearAll();
    if (ro) {
      await win?.close(true);
      return true;
    }
    if (!rec.name.trim()) {
      fe.setErrors({ name: 'Enter the company name.' });
      return false;
    }
    try {
      const saved = await api.put<CompanyInfo>('/company', rec);
      queryClient.setQueryData(['company'], saved);
      setRec(saved);
      dirtyRef.current = false;
      void invalidateAll();
      await useSession.getState().reloadCompany();
      toast('Company information saved');
      await win?.close(true);
      return true;
    } catch (e) {
      fe.fromError(e);
      return false;
    }
  };

  const entityKnown = ENTITY_TYPES.some((e) => e.value === rec.entityType);

  return (
    <EditDialog
      title="Company Information"
      errors={fe}
      sections={SECTIONS}
      section={tab}
      onSectionChange={setTab}
      onOk={save}
      okLabel={ro ? 'Close' : 'Save and close'}
      navWidth={196}
      top={
        <>
          {ro && (
            <div className="cx-note cx-info cx-small" role="note" style={{ marginBottom: 10 }}>
              <Lock size={15} />
              <div>{ADMIN_ONLY_NOTE}</div>
            </div>
          )}
          <fieldset className="cx-fieldset" disabled={ro}>
            <Field label="Company name" required width={360} hint="Shown in the title bar, on forms and on reports.">
              <TextField name="name" value={rec.name} onChange={(v) => set({ name: v })} autoFocus={!ro} />
            </Field>
          </fieldset>
        </>
      }
    >
      <fieldset className="cx-fieldset" disabled={ro}>
        {tab === 'contact' && (
          <div className="cx-stack">
            <Field label="Address">
              <TextField name="address1" value={rec.address1} onChange={(v) => set({ address1: v })} placeholder="Street" />
            </Field>
            <TextField
              name="address2"
              value={rec.address2}
              onChange={(v) => set({ address2: v })}
              placeholder="Suite, building (optional)"
              aria-label="Address line 2"
            />
            <FieldRow>
              <Field label="City" width={190}>
                <TextField name="city" value={rec.city} onChange={(v) => set({ city: v })} />
              </Field>
              <Field label="State" width={70}>
                <TextField name="state" value={rec.state} onChange={(v) => set({ state: v })} />
              </Field>
              <Field label="ZIP" width={100}>
                <TextField name="zip" value={rec.zip} onChange={(v) => set({ zip: v })} />
              </Field>
              <Field label="Country" width={80}>
                <TextField name="country" value={rec.country} onChange={(v) => set({ country: v })} />
              </Field>
            </FieldRow>
            <FieldRow>
              <Field label="Phone" width={190}>
                <TextField name="phone" value={rec.phone} onChange={(v) => set({ phone: v })} />
              </Field>
              <Field label="Fax" width={190}>
                <TextField name="fax" value={rec.fax} onChange={(v) => set({ fax: v })} />
              </Field>
            </FieldRow>
            <FieldRow>
              <Field label="Email" width={250}>
                <TextField name="email" type="email" value={rec.email} onChange={(v) => set({ email: v })} />
              </Field>
              <Field label="Website" width={250}>
                <TextField name="website" value={rec.website} onChange={(v) => set({ website: v })} />
              </Field>
            </FieldRow>
          </div>
        )}
        {tab === 'legal' && (
          <div className="cx-stack">
            <Field label="Legal name" hint="The name you use with the government, if different from the company name." width={380}>
              <TextField name="legalName" value={rec.legalName} onChange={(v) => set({ legalName: v })} />
            </Field>
            <Field label="Federal employer ID (EIN) or SSN" help="The tax identification number printed on tax forms." width={240}>
              <TextField name="taxId" value={rec.taxId} onChange={(v) => set({ taxId: v })} placeholder="12-3456789" />
            </Field>
            <Field label="Type of business entity" width={260}>
              <Select
                name="entityType"
                value={rec.entityType}
                onChange={(v) => set({ entityType: v })}
                options={[
                  ...(entityKnown || !rec.entityType ? [] : [{ value: rec.entityType, label: rec.entityType }]),
                  ...(rec.entityType ? [] : [{ value: '', label: '(not set)' }]),
                  ...ENTITY_TYPES.map((e) => ({ value: e.value, label: e.label })),
                ]}
              />
            </Field>
          </div>
        )}
        {tab === 'report' && (
          <div className="cx-stack">
            <Field
              label="First month of your fiscal year"
              help="Fiscal year"
              width={240}
              hint="Reports such as 'This Fiscal Year' and the Balance Sheet's retained earnings use it."
            >
              <Select
                name="fiscalYearStartMonth"
                value={rec.fiscalYearStartMonth}
                onChange={(v) => set({ fiscalYearStartMonth: Number(v) })}
                options={MONTH_OPTIONS}
              />
            </Field>
            <Field label="First month of your income tax year" width={240}>
              <Select
                name="taxYearStartMonth"
                value={rec.taxYearStartMonth || 1}
                onChange={(v) => set({ taxYearStartMonth: Number(v) })}
                options={MONTH_OPTIONS}
              />
            </Field>
          </div>
        )}
      </fieldset>
    </EditDialog>
  );
}
