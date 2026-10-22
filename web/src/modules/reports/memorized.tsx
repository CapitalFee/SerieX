// Memorized reports: data hook, run, memorize / edit / delete dialogs (shared by the report
// window, the Report Center and the Memorized Report List).
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MemorizedReport } from '@/api/types';
import { ApiError, api } from '@/api/client';
import { invalidateAll, queryClient } from '@/api/hooks';
import { Button, Checkbox, Field, FormErrorsProvider, Select, TextField, confirmBox, msgBox, showDialog, toast, useFormErrors } from '@/components';
import { openWindow } from '@/windows/windowStore';
import { DEFAULT_GROUPS } from './reportMeta';

/** Query key of the memorized report list. */
export const MEMORIZED_KEY = ['memorized-reports'];

/** Memorized reports (GET /memorized-reports), sorted by group then name. */
export function useMemorizedReports() {
  return useQuery({
    queryKey: MEMORIZED_KEY,
    queryFn: ({ signal }) => api.get<MemorizedReport[]>('/memorized-reports', { signal }),
  });
}

async function loadList(): Promise<MemorizedReport[]> {
  return queryClient.fetchQuery({ queryKey: MEMORIZED_KEY, queryFn: () => api.get<MemorizedReport[]>('/memorized-reports'), staleTime: 0 });
}

/** Opens a memorized report in a report window. */
export function runMemorizedReport(m: MemorizedReport): void {
  openWindow('report', { key: m.reportKey, params: m.params, memorizedId: m.id, title: m.name }, { title: m.name });
}

/** Group names to offer: the default groups plus every group in use. */
export function groupNames(list: MemorizedReport[] | undefined): string[] {
  const s = new Set<string>(DEFAULT_GROUPS);
  for (const m of list ?? []) if (m.groupName) s.add(m.groupName);
  return [...s].sort((a, b) => a.localeCompare(b));
}

const NEW_GROUP = '\u0000new';

interface FormProps {
  title: string;
  okLabel: string;
  initialName: string;
  initialGroup: string;
  groups: string[];
  /** Saves; throws an ApiError on problems (shown inline). */
  onSave: (name: string, group: string) => Promise<MemorizedReport | null>;
  onDone: (m: MemorizedReport | null) => void;
  intro?: string;
}

/** Name + group form used by Memorize and Edit. */
function MemorizedForm({ okLabel, initialName, initialGroup, groups, onSave, onDone, intro }: FormProps) {
  const fe = useFormErrors();
  const [name, setName] = useState(initialName);
  const [useGroup, setUseGroup] = useState(!!initialGroup);
  const [group, setGroup] = useState(initialGroup || groups[0] || '');
  const [newGroup, setNewGroup] = useState('');
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);
  const submit = async () => {
    const n = name.trim();
    if (!n) {
      fe.setFieldError('name', 'Enter a name for the memorized report.');
      nameRef.current?.focus();
      return;
    }
    let g = '';
    if (useGroup) {
      g = group === NEW_GROUP ? newGroup.trim() : group;
      if (!g) {
        fe.setFieldError(group === NEW_GROUP ? 'newGroup' : 'groupName', 'Enter the name of the new group, or clear "Save in a memorized report group".');
        return;
      }
    }
    setBusy(true);
    try {
      const saved = await onSave(n, g);
      if (saved) onDone(saved);
    } catch (e) {
      fe.fromError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormErrorsProvider value={fe}>
      <form
        className="rpt-dlg"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="rpt-dlg-body">
          {intro && <p className="rpt-dlg-intro">{intro}</p>}
          {fe.message && <div className="rpt-dlg-error">{fe.message}</div>}
          <Field label="Name" required>
            <TextField ref={nameRef} name="name" value={name} onChange={setName} maxLength={80} />
          </Field>
          <Checkbox checked={useGroup} onChange={setUseGroup} label="Save in a memorized report group" />
          {useGroup && (
            <div className="rpt-dlg-group">
              <Select
                name="groupName"
                value={group}
                onChange={setGroup}
                aria-label="Group"
                options={[...groups.map((g) => ({ value: g, label: g })), { value: NEW_GROUP, label: 'New group…' }]}
              />
              {group === NEW_GROUP && <TextField name="newGroup" value={newGroup} onChange={setNewGroup} placeholder="Group name" autoFocus maxLength={60} />}
            </div>
          )}
        </div>
        <div className="sx-dlg-buttons">
          <Button type="button" label="Cancel" onClick={() => onDone(null)} />
          <Button type="submit" variant="primary" label={okLabel} busy={busy} />
        </div>
      </form>
    </FormErrorsProvider>
  );
}

function isDuplicateName(e: unknown): boolean {
  return e instanceof ApiError && e.field === 'name' && /already exists/i.test(e.message);
}

/** Options of {@link memorizeReport}. */
export interface MemorizeOptions {
  reportKey: string;
  /** Server params and "ui.*" display options to remember. */
  params: Record<string, string>;
  defaultName: string;
  /** The window shows this memorized report: offer to replace it. */
  memorizedId?: number | null;
}

/**
 * Memorize Report dialog (Ctrl+M on a report). Resolves with the saved memorized report, or
 * null when cancelled. A window that already shows a memorized report is asked Replace / New.
 */
export async function memorizeReport(o: MemorizeOptions): Promise<MemorizedReport | null> {
  let list: MemorizedReport[] = [];
  try {
    list = await loadList();
  } catch {
    /* the dialog still works; the server checks names */
  }
  const existing = o.memorizedId ? list.find((m) => m.id === o.memorizedId) : undefined;
  if (existing) {
    const r = await msgBox({
      title: 'Memorize Report',
      message: `This report was opened from the memorized report "${existing.name}".\nDo you want to replace it with the current settings, or save a new memorized report?`,
      buttons: ['&Replace', '&New', 'Cancel'],
      icon: 'question',
    });
    if (r === 'Cancel') return null;
    if (r === 'Replace') {
      const saved = await api.put<MemorizedReport>(`/memorized-reports/${existing.id}`, { ...existing, reportKey: o.reportKey, params: o.params });
      await invalidateAll();
      toast(`Memorized report "${saved.name}" updated`);
      return saved;
    }
  }
  const save = async (name: string, groupName: string): Promise<MemorizedReport | null> => {
    const body = { id: 0, name, reportKey: o.reportKey, params: o.params, groupName };
    try {
      return await api.post<MemorizedReport>('/memorized-reports', body);
    } catch (e) {
      if (!isDuplicateName(e)) throw e;
      const dup = (await loadList()).find((m) => m.name.toLowerCase() === name.toLowerCase());
      if (!dup) throw e;
      const yes = await confirmBox(`A memorized report named "${dup.name}" already exists.\nDo you want to replace it with this report?`, 'Memorize Report');
      if (!yes) throw e;
      return api.put<MemorizedReport>(`/memorized-reports/${dup.id}`, { ...body, id: dup.id });
    }
  };
  const saved = await showDialog<MemorizedReport | null>({
    title: 'Memorize Report',
    width: 420,
    cancelValue: null,
    render: (close) => (
      <MemorizedForm
        title="Memorize Report"
        okLabel="Memorize"
        initialName={existing ? `${existing.name} (copy)` : o.defaultName}
        initialGroup={existing?.groupName ?? ''}
        groups={groupNames(list)}
        intro="Save this report with its dates, filters and layout so you can run it again with one click."
        onSave={save}
        onDone={close}
      />
    ),
  });
  if (saved) {
    await invalidateAll();
    toast(`Memorized report "${saved.name}" saved`, { action: { label: 'Show list', onClick: () => openWindow('memorizedReports') } });
  }
  return saved;
}

/** Edit Memorized Report dialog (name and group). Resolves true when saved. */
export async function editMemorizedReport(m: MemorizedReport, list?: MemorizedReport[]): Promise<boolean> {
  const saved = await showDialog<MemorizedReport | null>({
    title: 'Edit Memorized Report',
    width: 420,
    cancelValue: null,
    render: (close) => (
      <MemorizedForm
        title="Edit Memorized Report"
        okLabel="Save"
        initialName={m.name}
        initialGroup={m.groupName}
        groups={groupNames(list)}
        onSave={(name, groupName) => api.put<MemorizedReport>(`/memorized-reports/${m.id}`, { ...m, name, groupName })}
        onDone={close}
      />
    ),
  });
  if (!saved) return false;
  await invalidateAll();
  toast(`Memorized report "${saved.name}" saved`);
  return true;
}

/** Asks, then deletes a memorized report. Resolves true when deleted. */
export async function deleteMemorizedReport(m: MemorizedReport): Promise<boolean> {
  const yes = await confirmBox(`Delete the memorized report "${m.name}"?\nThe report itself is not affected; only this saved version is removed.`, 'Delete Memorized Report');
  if (!yes) return false;
  try {
    await api.del(`/memorized-reports/${m.id}`);
  } catch (e) {
    toast(e instanceof Error ? e.message : 'The memorized report could not be deleted.', { kind: 'error' });
    return false;
  }
  await invalidateAll();
  toast(`Memorized report "${m.name}" deleted`);
  return true;
}
