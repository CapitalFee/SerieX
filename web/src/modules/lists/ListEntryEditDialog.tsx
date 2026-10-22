// New / Edit entry of a simple list: class, customer / vendor / job type (with "Subentry of"),
// terms (Standard: net days, discount % and days; Date driven: due day, next-month window,
// discount % and day — with a plain-English example), payment method (payment type), sales rep
// (name, initials, linked name), ship via, customer message. props.name prefills (pickers).
// A save sends the entry's updatedAt as it was opened: when someone else changed it since, the
// server refuses and the dialog offers to reload the latest version (useStaleCopy).
import { useEffect, useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll, useList } from '@/api/hooks';
import { LIST_TITLES, type ID, type ListEntry, type ListName } from '@/api/types';
import {
  Checkbox,
  EditDialog,
  Field,
  ListPicker,
  NamePicker,
  notifyCreated,
  NumberField,
  SegmentedControl,
  Select,
  Spinner,
  TextArea,
  TextField,
  toast,
  useFormErrors,
} from '@/components';
import { addDays, todayIso } from '@/util/dates';
import { fmtDate } from '@/util/format';
import { useWindow } from '@/windows/WindowContext';
import { cap, descendantIds, errMessage, focusLater, snapshotOf, useStaleCopy } from './common';
import { ENTRY_WORD, HIERARCHICAL_LISTS, termsSummary } from './SimpleList';
import './lists.css';

export interface ListEntryEditDialogProps {
  list: ListName;
  id?: number;
  parentId?: number;
  /** Name typed in a picker ("Add with details…"). */
  name?: string;
}

const NAME_LABEL: Record<ListName, string> = {
  class: 'Class name',
  customer_type: 'Customer type',
  vendor_type: 'Vendor type',
  job_type: 'Job type',
  terms: 'Terms',
  payment_method: 'Payment method',
  ship_via: 'Shipping method',
  customer_message: 'Message',
  sales_rep: 'Sales rep name',
};

const PAYMENT_TYPES = ['Cash', 'Check', 'American Express', 'Discover', 'MasterCard', 'Visa', 'Other Credit Card', 'Debit Card', 'E-Check', 'Gift Card', 'Other'];

function defaultData(list: ListName): Record<string, any> {
  switch (list) {
    case 'terms':
      return { dateDriven: false, netDays: 30, discountPct: 0, discountDays: 0, dueDay: 31, discountDay: 10, dueNextMonthDays: 0 };
    case 'payment_method':
      return { type: 'Other' };
    case 'sales_rep':
      return { initials: '', nameId: null };
    default:
      return {};
  }
}

/** A new entry of `list` (optionally under `parentId`). */
function blankEntry(list: ListName, name = '', parentId: ID | null = null): ListEntry {
  return { id: 0, list, name, parentId, fullName: '', level: 0, active: true, data: defaultData(list) };
}

/** What the dialog compares to tell whether the user changed anything. */
const entrySnapshot = (rec: ListEntry, isSub: boolean) => snapshotOf({ rec, isSub });

/** Due date of an invoice dated `date` under date-driven or standard terms (same rule as the server). */
function dueDateFor(date: string, d: Record<string, any>): string {
  if (!d.dateDriven) return addDays(date, Number(d.netDays) || 0);
  const [y, m, day] = date.split('-').map(Number);
  const dueDay = Math.max(1, Number(d.dueDay) || 1);
  const clamp = (yy: number, mm: number) => {
    const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    const dd = Math.min(dueDay, last);
    return new Date(Date.UTC(yy, mm - 1, dd));
  };
  const issued = new Date(Date.UTC(y, m - 1, day));
  let due = clamp(y, m);
  const until = Math.round((due.getTime() - issued.getTime()) / 86400000);
  const within = Number(d.dueNextMonthDays) || 0;
  if (until < 0 || (within > 0 && until <= within)) due = clamp(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1);
  return due.toISOString().slice(0, 10);
}

export default function ListEntryEditDialog(props: ListEntryEditDialogProps) {
  const list: ListName = props.list;
  const win = useWindow();
  const fe = useFormErrors();
  const { data: entries, isLoading, refetch } = useList(list, { active: 'all' });
  const title = LIST_TITLES[list] ?? 'List';
  const word = ENTRY_WORD[list] ?? 'entry';
  const tree = HIERARCHICAL_LISTS.includes(list);
  const [isNew] = useState(!props.id);
  const [rec, setRec] = useState<ListEntry | null>(() => (props.id ? null : blankEntry(list, props.name ?? '', props.parentId ?? null)));
  const [isSub, setIsSub] = useState(!!props.parentId);
  const [originalName, setOriginalName] = useState('');
  /** An existing entry was looked up on the server (until then "no longer exists" is not shown). */
  const [checked, setChecked] = useState(!props.id);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The entry as it was opened (a new one without its name), to tell whether anything changed. */
  const [baseline, setBaseline] = useState<string | null>(() => (props.id ? null : entrySnapshot(blankEntry(list, '', props.parentId ?? null), !!props.parentId)));
  // EditDialog marks the window changed and asks "Do you want to save your changes?" on close
  const dirty = !!rec && baseline !== null && entrySnapshot(rec, isSub) !== baseline;

  /** Shows an existing entry as stored (its updatedAt is kept: it is sent back on save). */
  const load = (e: ListEntry) => {
    const loaded = { ...e, data: { ...defaultData(list), ...(e.data ?? {}) } };
    setRec(loaded);
    setIsSub(e.parentId !== null);
    setOriginalName(e.fullName);
    setBaseline(entrySnapshot(loaded, e.parentId !== null));
  };

  // an existing entry is read from the server when the dialog opens (the list in memory can be
  // older), so the version sent back on save is the one the user sees
  useEffect(() => {
    if (!props.id) return;
    let off = false;
    void refetch().then((r) => {
      if (off) return;
      const e = (r.data ?? []).find((x) => x.id === props.id);
      if (e) load(e);
      else if (r.error) setLoadError(errMessage(r.error) ?? 'Please try again.');
      setChecked(true);
    });
    return () => {
      off = true;
    };
  }, [props.id, list]); // eslint-disable-line react-hooks/exhaustive-deps

  // someone else saved the entry after it was opened: load their version (false: it is gone)
  const stale = useStaleCopy(fe, list === 'terms' ? 'terms entry' : word, async () => {
    const r = await refetch();
    if (r.error) throw r.error;
    const fresh = (r.data ?? []).find((x) => x.id === props.id);
    if (!fresh) {
      setRec(null); // shows "This entry no longer exists"
      return false;
    }
    load(fresh);
  });

  const excluded = useMemo(() => (rec?.id ? descendantIds(entries ?? [], rec.id) : new Set<ID>()), [entries, rec?.id]);

  if (!rec) {
    if (loadError || (props.id && checked && !isLoading && entries && !entries.some((x) => x.id === props.id))) {
      return (
        <EditDialog title={`Edit ${title}`} onOk={() => win.close(true)} okLabel="Close">
          <div className="fl-info">
            <Info size={16} />
            <span>{loadError ? `The ${word} could not be loaded: ${loadError}` : 'This entry no longer exists. It may have been deleted.'}</span>
          </div>
        </EditDialog>
      );
    }
    return (
      <div className="fl-page" style={{ alignItems: 'center', justifyContent: 'center', background: '#fff' }}>
        <Spinner label="Loading…" />
      </div>
    );
  }

  const e = rec;
  const d = e.data;
  const set = (patch: Partial<ListEntry>) => setRec((r) => (r ? { ...r, ...patch } : r));
  const setData = (patch: Record<string, any>) => setRec((r) => (r ? { ...r, data: { ...r.data, ...patch } } : r));
  const num = (key: string, label: string, opts: { suffix?: string; decimals?: number; width?: number } = {}) => (
    <Field label={label} width={opts.width}>
      <NumberField name={`data.${key}`} value={d[key] ?? 0} nullable={false} decimals={opts.decimals ?? 0} suffix={opts.suffix} onChange={(v) => setData({ [key]: v ?? 0 })} aria-label={label} />
    </Field>
  );

  const save = async (): Promise<ListEntry | null> => {
    fe.clearAll();
    const name = e.name.trim();
    const problems: Record<string, string> = {};
    const parent = tree && isSub ? e.parentId : null;
    const same = name ? (entries ?? []).find((x) => x.id !== e.id && x.parentId === parent && x.name.toLowerCase() === name.toLowerCase()) : undefined;
    if (!name) problems.name = list === 'customer_message' ? 'Enter the message.' : `Enter a name for the ${word}.`;
    else if (tree && name.includes(':')) problems.name = 'A name cannot contain a colon (:). Use "Subentry of" instead.';
    else if (same) problems.name = `"${same.fullName}" is already in the list${same.active ? '' : ' (inactive)'}. Use a different name.`;
    if (tree && isSub && !e.parentId) problems.parentId = 'Choose the entry this one goes under, or clear "Subentry of".';
    if (list === 'sales_rep' && String(d.initials ?? '').trim().length > 5) problems['data.initials'] = 'Use at most 5 characters for the initials.';
    if (Object.keys(problems).length) {
      fe.setErrors(problems);
      return null;
    }
    // updatedAt: the version opened (or reloaded); the server refuses the save if someone changed it since
    const body = { id: e.id, list, name, parentId: tree && isSub ? e.parentId : null, active: e.active, data: d, updatedAt: isNew ? undefined : e.updatedAt };
    try {
      const saved = isNew ? await api.post<ListEntry>(`/lists/${list}`, body) : await api.put<ListEntry>(`/lists/${list}/${e.id}`, body);
      await invalidateAll();
      if (isNew) notifyCreated({ kind: 'list', id: saved.id, list });
      toast(isNew ? `${cap(word)} "${saved.fullName || saved.name}" added` : `${cap(word)} "${saved.fullName || saved.name}" saved`);
      return saved;
    } catch (err) {
      if (!(await stale.handle(err))) fe.fromError(err);
      return null;
    }
  };

  const today = todayIso();
  const due = list === 'terms' ? dueDateFor(today, d) : '';

  return (
    <EditDialog
      title={isNew ? `New ${title}` : `Edit ${title}: ${originalName}`}
      errors={fe}
      dirty={dirty}
      okLabel="Save and close"
      onOk={async () => {
        if (!(await save())) return false;
        await win.close(true);
      }}
      onSaveNew={
        isNew
          ? async () => {
              if (!(await save())) return;
              const next = blankEntry(list, '', isSub ? e.parentId : null);
              setRec(next);
              setBaseline(entrySnapshot(next, isSub));
              focusLater(win.id, 'name');
            }
          : undefined
      }
      footerLeft={!isNew ? <Checkbox checked={!e.active} onChange={(v) => set({ active: !v })} label={`${cap(word)} is inactive`} /> : undefined}
      extraButtons={stale.button}
    >
      <div className="fl-form">
        {list === 'customer_message' ? (
          <Field label={NAME_LABEL[list]} required hint="Printed at the bottom of invoices, sales receipts and estimates.">
            <TextArea name="name" value={e.name} onChange={(v) => set({ name: v })} rows={3} autoFocus aria-label="Message" maxLength={300} />
          </Field>
        ) : list === 'terms' ? (
          <div className="fl-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'end' }}>
            <Field label={NAME_LABEL[list]} required help="Terms">
              <TextField name="name" value={e.name} onChange={(v) => set({ name: v })} autoFocus aria-label={NAME_LABEL[list]} maxLength={31} />
            </Field>
            <SegmentedControl<'std' | 'date'>
              name="data.dateDriven"
              value={d.dateDriven ? 'date' : 'std'}
              onChange={(v) => setData({ dateDriven: v === 'date' })}
              options={[
                { value: 'std', label: 'Standard', title: 'Due a number of days after the invoice date' },
                { value: 'date', label: 'Date driven', title: 'Due on a fixed day of the month' },
              ]}
              aria-label="Kind of terms"
            />
          </div>
        ) : (
          <Field label={NAME_LABEL[list]} required help={list === 'class' ? 'Class' : undefined}>
            <TextField name="name" value={e.name} onChange={(v) => set({ name: v })} autoFocus aria-label={NAME_LABEL[list]} maxLength={31} />
          </Field>
        )}

        {tree && (
          <div className="fl-sub-row">
            <Checkbox
              checked={isSub}
              onChange={(v) => {
                setIsSub(v);
                if (!v) set({ parentId: null });
              }}
              label="Subentry of"
            />
            <div className="fl-sub-picker">
              <ListPicker
                list={list}
                name="parentId"
                aria-label="Parent entry"
                addNew={false}
                showRecent={false}
                disabled={!isSub}
                filter={(x) => !excluded.has(x.id)}
                value={isSub ? e.parentId : null}
                onChange={(id) => set({ parentId: id })}
              />
            </div>
          </div>
        )}

        {list === 'terms' && (
          <>
            {d.dateDriven ? (
              <div className="fl-grid fl-g2">
                {num('dueDay', 'Due on day of month')}
                {num('dueNextMonthDays', 'Next month if within (days)')}
                {num('discountPct', 'Discount %', { decimals: 2 })}
                {num('discountDay', 'Discount if paid by day')}
              </div>
            ) : (
              <div className="fl-grid fl-g3">
                {num('netDays', 'Net due in (days)')}
                {num('discountPct', 'Discount %', { decimals: 2 })}
                {num('discountDays', 'Discount within (days)')}
              </div>
            )}
            <div className="fl-info">
              <Info size={16} />
              <span>
                {termsSummary(d)}. An invoice dated {fmtDate(today)} is due <b>{fmtDate(due)}</b>.
              </span>
            </div>
          </>
        )}

        {list === 'payment_method' && (
          <Field label="Payment type" help="Groups payments of this kind together, e.g. on the Make Deposits screen." width={240}>
            <Select name="data.type" value={d.type ?? 'Other'} onChange={(v) => setData({ type: v })} options={PAYMENT_TYPES.map((t) => ({ value: t, label: t }))} aria-label="Payment type" />
          </Field>
        )}

        {list === 'sales_rep' && (
          <div className="fl-grid" style={{ gridTemplateColumns: '110px minmax(0, 1fr)' }}>
            <Field label="Initials" help="Shown in the REP field of forms. Up to 5 characters; left empty, the first letters of the name are used.">
              <TextField name="data.initials" value={d.initials ?? ''} onChange={(v) => setData({ initials: v.toUpperCase() })} maxLength={5} aria-label="Initials" />
            </Field>
            <Field label="Linked name (optional)" help="The vendor or other name this sales rep is, for example to write their commission checks.">
              <NamePicker name="data.nameId" kinds={['vendor', 'other']} aria-label="Linked name" value={d.nameId ?? null} onChange={(id, n) => {
                  setData({ nameId: id });
                  if (n && !e.name.trim()) set({ name: n.name });
                }} />
            </Field>
          </div>
        )}
      </div>
    </EditDialog>
  );
}
