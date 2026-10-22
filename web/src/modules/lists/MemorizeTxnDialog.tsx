// Memorize Transaction dialog (Edit > Memorize, Ctrl+M on a form; Edit in the memorized list).
// Name, group, Remind me / Don't remind me / Enter automatically, how often, next date, number
// remaining, days in advance, with a plain-English summary of the schedule.
// props: txn (the form's transaction, new memorized entry) or memorizedId (edit an existing one).
import { useEffect, useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll, useNames } from '@/api/hooks';
import { TXN_TYPE_LABELS, type MemorizedFrequency, type MemorizedSchedule, type MemorizedTxn, type Txn } from '@/api/types';
import { DateField, EditDialog, Field, NumberField, SegmentedControl, Select, Spinner, TextField, toast, useFormErrors } from '@/components';
import { addDate, addDays, addMonthsClamped, todayIso } from '@/util/dates';
import { fmtDate } from '@/util/format';
import { openWindow } from '@/windows/windowStore';
import { useWindow } from '@/windows/WindowContext';
import { FREQUENCIES, frequencyLabel, useMemorized } from './memorized';
import './lists.css';

export interface MemorizeTxnDialogProps {
  /** Transaction to memorize (from a form). */
  txn?: Txn;
  /** Memorized transaction to edit. */
  memorizedId?: number;
}

interface Form {
  name: string;
  groupName: string;
  schedule: MemorizedSchedule;
  frequency: MemorizedFrequency;
  nextDate: string;
  remaining: number | null;
  daysInAdvance: number;
}

/** The date one period after `date` (like the server's schedule). */
function advance(date: string, f: MemorizedFrequency): string {
  switch (f) {
    case 'daily':
      return addDays(date, 1);
    case 'weekly':
      return addDays(date, 7);
    case 'biweekly':
      return addDays(date, 14);
    case 'semimonthly': {
      const d = Number(date.slice(8, 10));
      if (d <= 15) {
        const end = addDate(addMonthsClamped(date.slice(0, 8) + '01', 1), 0, 0, -1);
        const nd = Math.min(d + 15, Number(end.slice(8, 10)));
        return date.slice(0, 8) + String(nd).padStart(2, '0');
      }
      const next = addMonthsClamped(date.slice(0, 8) + '01', 1);
      return next.slice(0, 8) + String(d - 15).padStart(2, '0');
    }
    case 'monthly':
      return addMonthsClamped(date, 1);
    case 'quarterly':
      return addMonthsClamped(date, 3);
    case 'semiannually':
      return addMonthsClamped(date, 6);
    case 'annually':
      return addMonthsClamped(date, 12);
    default:
      return date;
  }
}

export default function MemorizeTxnDialog(props: MemorizeTxnDialogProps) {
  const win = useWindow();
  const fe = useFormErrors();
  const { data: memorized } = useMemorized();
  const { data: names } = useNames(undefined, { active: 'all' });
  const editing = props.memorizedId ? memorized?.find((m) => m.id === props.memorizedId) ?? null : null;
  const [form, setForm] = useState<Form | null>(null);
  const today = todayIso();

  // initial values: the memorized entry being edited, or defaults from the transaction
  useEffect(() => {
    if (form) return;
    if (props.memorizedId) {
      if (!editing) return;
      setForm({
        name: editing.name,
        groupName: editing.groupName,
        schedule: editing.schedule,
        frequency: editing.frequency,
        nextDate: editing.nextDate,
        remaining: editing.remaining,
        daysInAdvance: editing.daysInAdvance,
      });
      return;
    }
    const t = props.txn;
    if (t && t.nameId && !names) return; // wait for the payee's name
    const payee = t?.nameId ? names?.find((n) => n.id === t.nameId)?.fullName ?? t.nameFull : t?.nameFull;
    const label = t ? TXN_TYPE_LABELS[t.type] ?? 'Transaction' : 'Transaction';
    setForm({
      name: payee ? payee : t?.refNumber ? `${label} ${t.refNumber}` : label,
      groupName: '',
      schedule: 'remind',
      frequency: 'monthly',
      nextDate: advance(t?.date || today, 'monthly'),
      remaining: null,
      daysInAdvance: 0,
    });
  }, [form, props.memorizedId, props.txn, editing, names, today]);

  const groups = useMemo(() => [...new Set((memorized ?? []).map((m) => m.groupName).filter(Boolean))].sort(), [memorized]);

  if (props.memorizedId && memorized && !editing) {
    return (
      <EditDialog title="Memorize Transaction" onOk={() => win.close(true)} okLabel="Close">
        <div className="fl-info">
          <Info size={16} />
          <span>This memorized transaction no longer exists. It may have been deleted.</span>
        </div>
      </EditDialog>
    );
  }
  if (!props.memorizedId && !props.txn) {
    return (
      <EditDialog title="Memorize Transaction" onOk={() => win.close(true)} okLabel="Close">
        <div className="fl-info">
          <Info size={16} />
          <span>Open a transaction and click Memorize (Ctrl+M) to save it for reuse.</span>
        </div>
      </EditDialog>
    );
  }
  if (!form) {
    return (
      <div className="fl-page" style={{ alignItems: 'center', justifyContent: 'center', background: '#fff' }}>
        <Spinner label="Loading…" />
      </div>
    );
  }

  const f = form;
  const set = (patch: Partial<Form>) => setForm((x) => (x ? { ...x, ...patch } : x));
  const scheduled = f.schedule !== 'none';
  const typeName = (props.txn ? TXN_TYPE_LABELS[props.txn.type] : editing ? TXN_TYPE_LABELS[editing.txnType] : 'transaction')?.toLowerCase() ?? 'transaction';

  const summary = (() => {
    if (!scheduled) return 'SerieX Books keeps it in the Memorized Transaction List. Enter it from there whenever you need it.';
    if (!f.nextDate) return 'Enter the next date.';
    const when = f.frequency === 'never' ? `on ${fmtDate(f.nextDate)}` : `on ${fmtDate(f.nextDate)} and then ${frequencyLabel(f.frequency).toLowerCase()}`;
    const times = f.remaining ? ` (${f.remaining} more time${f.remaining === 1 ? '' : 's'})` : '';
    const early = f.daysInAdvance ? `, ${f.daysInAdvance} day${f.daysInAdvance === 1 ? '' : 's'} early` : '';
    return f.schedule === 'auto'
      ? `SerieX Books enters this ${typeName} for you ${when}${times}${early}.`
      : `SerieX Books reminds you to enter this ${typeName} ${when}${times}${early}.`;
  })();

  const save = async (): Promise<boolean> => {
    fe.clearAll();
    const problems: Record<string, string> = {};
    if (!f.name.trim()) problems.name = 'Enter a name for the memorized transaction.';
    if (scheduled && !f.nextDate) problems.nextDate = 'Enter the next date.';
    if (f.daysInAdvance < 0 || f.daysInAdvance > 365) problems.daysInAdvance = 'Use 0 to 365 days.';
    if (f.remaining !== null && f.remaining < 0) problems.remaining = 'The number remaining cannot be negative.';
    if (Object.keys(problems).length) {
      fe.setErrors(problems);
      return false;
    }
    const body: Record<string, unknown> = {
      name: f.name.trim(),
      groupName: f.groupName.trim(),
      schedule: f.schedule,
      frequency: f.frequency,
      nextDate: scheduled ? f.nextDate : '',
      remaining: f.remaining,
      daysInAdvance: Math.round(f.daysInAdvance),
    };
    try {
      let saved: MemorizedTxn;
      if (editing) {
        if (props.txn) body.template = props.txn;
        saved = await api.put<MemorizedTxn>(`/memorized/${editing.id}`, body);
      } else {
        saved = await api.post<MemorizedTxn>('/memorized', { ...body, id: 0, txnType: props.txn!.type, template: props.txn });
      }
      await invalidateAll();
      toast(editing ? `Memorized transaction "${saved.name}" saved` : `"${saved.name}" memorized`, {
        action: { label: 'Open list', onClick: () => openWindow('memorizedTxns', { selectId: saved.id }) },
      });
      return true;
    } catch (e) {
      fe.fromError(e);
      return false;
    }
  };

  return (
    <EditDialog
      title={editing ? `Memorized Transaction: ${editing.name}` : 'Memorize Transaction'}
      errors={fe}
      okLabel={editing ? 'Save and close' : 'Memorize'}
      onOk={async () => {
        if (await save()) await win.close(true);
      }}
    >
      <div className="fl-form" style={{ gap: 10 }}>
        <div className="fl-grid" style={{ gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)' }}>
          <Field label="Name" required>
            <TextField name="name" value={f.name} onChange={(v) => set({ name: v })} autoFocus aria-label="Memorized transaction name" maxLength={100} />
          </Field>
          <Field label="Group (optional)" help="Groups keep related memorized transactions together, e.g. Monthly bills.">
            <TextField name="groupName" value={f.groupName} onChange={(v) => set({ groupName: v })} list={`fl-memgroups-${win.id}`} aria-label="Group" />
            <datalist id={`fl-memgroups-${win.id}`}>
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </Field>
        </div>
        <SegmentedControl<MemorizedSchedule>
          name="schedule"
          block
          value={f.schedule}
          onChange={(v) => {
            const fr: MemorizedFrequency = v !== 'none' && f.schedule === 'none' && f.frequency === 'never' ? 'monthly' : f.frequency;
            set({ schedule: v, frequency: fr, ...(v !== 'none' && !f.nextDate ? { nextDate: advance(props.txn?.date || today, fr === 'never' ? 'monthly' : fr) } : {}) });
          }}
          options={[
            { value: 'remind', label: 'Remind me', title: 'Show it in the Reminders list when it is due' },
            { value: 'none', label: "Don't remind me", title: 'Just keep it in the list' },
            { value: 'auto', label: 'Enter automatically', title: 'SerieX Books saves it for you on the next date' },
          ]}
          aria-label="Schedule"
        />
        <div className="fl-grid fl-g4">
          <Field label="How often">
            <Select
              name="frequency"
              value={f.frequency}
              disabled={!scheduled}
              onChange={(v) => {
                const fr = v as MemorizedFrequency;
                set({ frequency: fr, ...(!f.nextDate ? { nextDate: advance(props.txn?.date || today, fr) } : {}) });
              }}
              options={FREQUENCIES.map((x) => ({ value: x.value, label: x.value === 'never' ? 'Only once' : x.label }))}
              aria-label="How often"
            />
          </Field>
          <Field label="Next date">
            <DateField name="nextDate" value={f.nextDate} disabled={!scheduled} onChange={(v) => set({ nextDate: v })} aria-label="Next date" />
          </Field>
          <Field label="Remaining" help="Number remaining: how many more times to enter it. Leave it empty for no limit.">
            <NumberField name="remaining" value={f.remaining} disabled={!scheduled} decimals={0} placeholder="No limit" onChange={(v) => set({ remaining: v === null ? null : Math.max(0, Math.round(v)) })} aria-label="Number remaining" />
          </Field>
          <Field label="Days ahead" help="Days in advance to enter: enter it (or remind you) this many days before the next date.">
            <NumberField name="daysInAdvance" value={f.daysInAdvance} nullable={false} decimals={0} disabled={!scheduled} onChange={(v) => set({ daysInAdvance: v ?? 0 })} aria-label="Days in advance to enter" />
          </Field>
        </div>
        <div className="fl-schedule-hint" aria-live="polite">
          {summary}
        </div>
      </div>
    </EditDialog>
  );
}
