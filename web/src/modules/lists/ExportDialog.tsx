// Export (File > Utilities > Export > Lists to CSV…): choose the lists to export; each one
// downloads as its own CSV file (the same columns the Import window reads).
import { useState } from 'react';
import { Info } from 'lucide-react';
import { api } from '@/api/client';
import { useAccounts, useItems, useNames } from '@/api/hooks';
import { Checkbox, EditDialog, toast, useFormErrors } from '@/components';
import { useWindow } from '@/windows/WindowContext';
import { errMessage, plural } from './common';
import './lists.css';

export interface ExportDialogProps {
  /** List to check first (default: all). */
  entity?: string;
}

type Entity = 'accounts' | 'customers' | 'vendors' | 'items' | 'other';

const CHOICES: { value: Entity; label: string; sub: string }[] = [
  { value: 'customers', label: 'Customers & jobs', sub: 'Names, contacts, addresses, terms' },
  { value: 'vendors', label: 'Vendors', sub: 'Names, contacts, addresses, terms' },
  { value: 'items', label: 'Items (products & services)', sub: 'Types, prices, costs, accounts' },
  { value: 'accounts', label: 'Chart of accounts', sub: 'Names, types, numbers, descriptions' },
  { value: 'other', label: 'Other names', sub: 'Names, contacts, addresses' },
];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function ExportDialog(props: ExportDialogProps) {
  const win = useWindow();
  const fe = useFormErrors();
  const [checked, setChecked] = useState<Set<Entity>>(() => new Set(props.entity && CHOICES.some((c) => c.value === props.entity) ? [props.entity as Entity] : CHOICES.map((c) => c.value)));
  const [busy, setBusy] = useState(false);
  const { data: accounts } = useAccounts({ active: 'all' });
  const { data: items } = useItems({ active: 'all' });
  const { data: names } = useNames(undefined, { active: 'all' });

  const count = (e: Entity): number | undefined =>
    e === 'accounts' ? accounts?.length : e === 'items' ? items?.length : names?.filter((n) => n.kind === (e === 'customers' ? 'customer' : e === 'vendors' ? 'vendor' : 'other')).length;

  const toggle = (e: Entity, on: boolean) =>
    setChecked((s) => {
      const n = new Set(s);
      if (on) n.add(e);
      else n.delete(e);
      return n;
    });

  const run = async () => {
    fe.clearAll();
    const list = CHOICES.filter((c) => checked.has(c.value));
    if (!list.length) {
      fe.setMessage('Check at least one list to export.');
      return;
    }
    setBusy(true);
    try {
      for (const c of list) {
        await api.download(`/export/${c.value}`, `${c.value}.csv`);
        await wait(250);
      }
      toast(list.length === 1 ? `${list[0].label} exported` : `${plural(list.length, 'list')} exported as CSV files`);
      await win.close(true);
    } catch (e) {
      const m = errMessage(e);
      if (m) fe.setMessage(m);
    } finally {
      setBusy(false);
    }
  };

  const all = checked.size === CHOICES.length;

  return (
    <EditDialog title="Export Lists to CSV" errors={fe} okLabel="Export" busy={busy} okDisabled={checked.size === 0} onOk={run}>
      <div className="fl-form">
        <div className="fl-note">Choose the lists to export. Each one downloads as a CSV file that opens in Excel and can be imported back.</div>
        <div className="fl-choices" role="group" aria-label="Lists to export">
          <div className="fl-choice" style={{ background: '#f8fafc' }}>
            <Checkbox checked={all} onChange={(v) => setChecked(new Set(v ? CHOICES.map((c) => c.value) : []))} label={<b>All lists</b>} />
          </div>
          {CHOICES.map((c) => (
            <div key={c.value} className="fl-choice">
              <Checkbox
                checked={checked.has(c.value)}
                onChange={(v) => toggle(c.value, v)}
                label={
                  <span>
                    {c.label} <span className="fl-choice-sub">· {c.sub}</span>
                  </span>
                }
              />
              <span className="fl-choice-sub fl-nowrap">{count(c.value) !== undefined ? plural(count(c.value)!, 'record') : ''}</span>
            </div>
          ))}
        </div>
        <div className="fl-info">
          <Info size={16} />
          <span>Your browser may ask once whether this site may download several files.</span>
        </div>
      </div>
    </EditDialog>
  );
}
