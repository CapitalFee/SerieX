// Open Company or Backup (File menu): open a company file from the list, restore an automatic backup
// (as a new company file or in place of the current data) or a backup file (.sxb) as a new
// company file, or delete a company file for good (DeleteCompanyDialog).
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArchiveRestore, FolderOpen, History, Trash2, UploadCloud } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from '@/api/client';
import type { BackupEntry, BackupStatus, CompanyFile } from '@/api/types';
import { queryClient } from '@/api/hooks';
import {
  Badge,
  Button,
  ErrorBanner,
  Field,
  FormErrorsProvider,
  ListView,
  SearchBox,
  SegmentedControl,
  Select,
  TextField,
  confirmBox,
  msgBox,
  promptBox,
  toast,
  useFormErrors,
  type ListColumn,
} from '@/components';
import { useOptionalWindow } from '@/windows/WindowContext';
import { getLastCompanyId, switchCompany, useSession } from '@/state/session';
import { deleteCompanyFile } from './DeleteCompanyDialog';
import { closeAllWindows } from '@/windows/windowStore';
import { backupKindLabel, fmtBytes, fmtDateTime, useCompanyFiles } from './shared';
import './company.css';

export interface OpenCompanyDialogProps {
  mode?: 'open' | 'restore';
}

type Mode = 'open' | 'restore';

export default function OpenCompanyDialog({ mode }: OpenCompanyDialogProps) {
  const win = useOptionalWindow();
  const [tab, setTab] = useState<Mode>(mode === 'restore' ? 'restore' : 'open');
  useEffect(() => {
    if (mode) setTab(mode === 'restore' ? 'restore' : 'open');
  }, [mode]);
  useEffect(() => {
    win?.setTitle(tab === 'restore' ? 'Restore a Backup' : 'Open Company or Backup');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const openCompany = async (id: string) => {
    await win?.close(true);
    await switchCompany(id);
  };

  return (
    <div className="cx-dlg">
      <div style={{ padding: '12px 20px 0' }}>
        <SegmentedControl<Mode>
          value={tab}
          onChange={setTab}
          aria-label="What do you want to do?"
          options={[
            { value: 'open', label: 'Open a company file', icon: FolderOpen },
            { value: 'restore', label: 'Restore a backup', icon: ArchiveRestore },
          ]}
        />
      </div>
      {tab === 'open' ? (
        <OpenPane onOpen={openCompany} onClose={() => void win?.close()} />
      ) : (
        <RestorePane onOpen={openCompany} onClose={() => void win?.close()} onHide={async () => win?.close(true)} />
      )}
    </div>
  );
}

function OpenPane({ onOpen, onClose }: { onOpen: (id: string) => void; onClose: () => void }) {
  const files = useCompanyFiles();
  const current = useSession((s) => s.companyId);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const last = getLastCompanyId();
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (files.data ?? []).filter((c) => !t || c.name.toLowerCase().includes(t) || c.fileName.toLowerCase().includes(t));
  }, [files.data, q]);
  useEffect(() => {
    if (rows.length && (!sel || !rows.some((r) => r.id === sel))) setSel(rows[0].id);
  }, [rows, sel]);
  const selected = rows.find((r) => r.id === sel) ?? null;

  const del = async (c: CompanyFile) => {
    if (await deleteCompanyFile(c)) setSel(null);
  };

  // The fixed widths add up to 574px, so the list fits the dialog's 596px list area even with a
  // vertical scrollbar (11px here, up to 17px elsewhere); Company name takes the free width.
  const columns: ListColumn<CompanyFile>[] = [
    {
      key: 'name',
      label: 'Company name',
      width: 200,
      grow: true,
      render: (c) => (
        <span className="cx-row" style={{ gap: 6, minWidth: 0 }}>
          <span className="cx-ellipsis">{c.name}</span>
          {c.id === current && <Badge tone="success">Open now</Badge>}
          {c.id === last && c.id !== current && <Badge tone="accent">Last opened</Badge>}
        </span>
      ),
    },
    // a long file name may be cut here: hovering shows it whole, and the full location shows under the list
    { key: 'fileName', label: 'File', width: 148 },
    // fits the widest date and time, "12/28/2026, 10:48 PM" (about 134px), with the cell padding
    { key: 'modified', label: 'Last modified', width: 156, render: (c) => fmtDateTime(c.modified) },
    { key: 'size', label: 'Size', width: 70, align: 'right', render: (c) => fmtBytes(c.size), sortValue: (c) => c.size },
  ];

  return (
    <>
      <div className="cx-dlg-body" style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 12 }}>
        <div className="cx-row">
          <span className="cx-muted">Choose a company file and click Open.</span>
          <span className="cx-spacer" />
          <SearchBox value={q} onChange={setQ} placeholder="Find a company" width={200} />
        </div>
        <ListView<CompanyFile>
          columns={columns}
          rows={rows}
          getKey={(c) => c.id}
          loading={files.isLoading}
          selectedKey={sel}
          onSelect={(k) => setSel(String(k))}
          onActivate={(c) => onOpen(c.id)}
          emptyText={files.error ? (files.error as Error).message : 'No company files found.'}
          contextMenu={(c) =>
            c ? [{ label: '&Open', onClick: () => onOpen(c.id) }, { separator: true }, { label: '&Delete company file...', onClick: () => void del(c) }] : []
          }
          autoFocus
          aria-label="Company files"
        />
        {selected && (
          <div className="cx-muted cx-small cx-ellipsis" title={selected.path}>
            Location: {selected.path}
          </div>
        )}
      </div>
      <div className="cx-dlg-foot">
        <div className="cx-grow">
          <Button variant="ghost" icon={Trash2} label="Delete file..." disabled={!selected} onClick={() => selected && void del(selected)} />
        </div>
        <Button label="Cancel" onClick={onClose} />
        <Button variant="primary" label="Open" disabled={!selected} onClick={() => selected && onOpen(selected.id)} />
      </div>
    </>
  );
}

type Source = 'auto' | 'file';

function RestorePane({ onOpen, onClose, onHide }: { onOpen: (id: string) => void; onClose: () => void; onHide: () => Promise<unknown> }) {
  const [source, setSource] = useState<Source>('auto');
  return (
    <>
      <div style={{ padding: '10px 20px 0' }}>
        <SegmentedControl<Source>
          size="sm"
          value={source}
          onChange={setSource}
          aria-label="Restore from"
          options={[
            { value: 'auto', label: 'Automatic backups', icon: History },
            { value: 'file', label: 'A backup file', icon: UploadCloud },
          ]}
        />
      </div>
      {source === 'auto' ? <AutoBackupsPane onOpen={onOpen} onClose={onClose} onHide={onHide} /> : <FileRestorePane onOpen={onOpen} onClose={onClose} />}
    </>
  );
}

/** Local date of an RFC3339 timestamp as YYYY-MM-DD. */
function localDay(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts.slice(0, 10);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The automatic backups of a company file (its backup folder), restored as a new file or in its place. */
function AutoBackupsPane({ onOpen, onClose, onHide }: { onOpen: (id: string) => void; onClose: () => void; onHide: () => Promise<unknown> }) {
  const files = useCompanyFiles();
  const current = useSession((s) => s.companyId);
  const [cid, setCid] = useState<string | null>(null);
  useEffect(() => {
    const list = files.data ?? [];
    if (list.length && (!cid || !list.some((f) => f.id === cid))) setCid(current && list.some((f) => f.id === current) ? current : list[0].id);
  }, [files.data, current, cid]);
  const company = files.data?.find((f) => f.id === cid) ?? null;
  const path = (id: string) => `/c/${encodeURIComponent(id)}/backups`;
  const status = useQuery({
    queryKey: ['backups', 'of', cid],
    queryFn: async () => {
      // The login of the open company does not cover another file: ask first instead of being
      // refused (a refused request would ask to log in to the open company again).
      if (cid !== current) {
        const auth = await api.global.get<{ required: boolean }>(`/companies/${encodeURIComponent(cid!)}/auth`, { noPrompt: true, quiet: true });
        if (auth?.required) throw new ApiError(401, 'auth', 'This company file has passwords. Open it and log in to see its backups.');
      }
      return api.global.get<BackupStatus>(path(cid!), { noPrompt: true, quiet: true });
    },
    enabled: !!cid,
    staleTime: 0,
  });
  const rows = status.data?.backups ?? [];
  const [sel, setSel] = useState<number | null>(null);
  useEffect(() => {
    if (rows.length && (sel === null || !rows.some((r) => r.id === sel))) setSel((rows.find((r) => r.exists) ?? rows[0]).id);
  }, [rows, sel]);
  const selected = rows.find((r) => r.id === sel) ?? null;
  const [busy, setBusy] = useState(false);

  const restoreNew = async (b: BackupEntry) => {
    if (!cid) return;
    const name = await promptBox('Name of the new company file. The company name stored in the backup is kept.', {
      title: 'Restore as a New Company File',
      defaultValue: `${company?.name ?? cid} ${localDay(b.time)}`,
    });
    if (name === null) return;
    setBusy(true);
    try {
      const cf = await api.global.post<CompanyFile>(`${path(cid)}/${b.id}/restore`, { mode: 'new', name: name.trim() }, { noPrompt: true });
      await queryClient.invalidateQueries({ queryKey: ['global', 'companies'] });
      const r = await msgBox({
        title: 'Restore Company',
        icon: 'info',
        message: `The backup from ${fmtDateTime(b.time)} was restored as "${cf.name}" (${cf.fileName}).\n\nDo you want to open it now?`,
        buttons: ['Open it', 'Not now'],
      });
      if (r === 'Open it') onOpen(cf.id);
    } catch (e) {
      await msgBox({ title: 'Restore Company', icon: 'error', message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const replace = async (b: BackupEntry) => {
    if (!cid) return;
    const url = `${path(cid)}/${b.id}/restore`;
    const isOpen = cid === current;
    setBusy(true);
    try {
      // the server asks first (and checks that the user is an administrator)
      try {
        await api.global.post(url, { mode: 'replace' }, { noPrompt: true });
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'confirm')) throw e;
        if (!(await confirmBox(e.message, 'Replace Company Data'))) return;
      }
      if (isOpen) {
        // windows of the open company save their changes (or the user cancels) before its data is replaced
        await onHide();
        if (!(await closeAllWindows())) return;
      }
      await api.global.post(url, { mode: 'replace' }, { noPrompt: true, accept: ['restore'] });
      await queryClient.invalidateQueries({ queryKey: ['global', 'companies'] });
      if (isOpen) {
        // everybody was logged out of the replaced file: open it again (asks for the password when it has one)
        const s = useSession.getState();
        s.closeCompany();
        await s.openCompany(cid);
      } else {
        void status.refetch();
      }
      toast(`"${company?.name ?? cid}" was restored from the backup of ${fmtDateTime(b.time)}.`);
    } catch (e) {
      await msgBox({ title: 'Replace Company Data', icon: 'error', message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const columns: ListColumn<BackupEntry>[] = [
    { key: 'time', label: 'Made', width: 170, render: (b) => fmtDateTime(b.time) },
    { key: 'kind', label: 'How', width: 130, render: (b) => backupKindLabel(b.kind) },
    { key: 'size', label: 'Size', width: 80, align: 'right', render: (b) => fmtBytes(b.size), sortValue: (b) => b.size },
    {
      key: 'file',
      label: 'File',
      width: 160,
      grow: true,
      render: (b) => (
        <span className="cx-row" style={{ gap: 6, minWidth: 0 }}>
          <span className="cx-ellipsis">{b.file}</span>
          {!b.exists && <Badge tone="warning">Missing</Badge>}
        </span>
      ),
    },
  ];
  const err = status.error as Error | null;
  const emptyText = err
    ? err instanceof ApiError && err.code === 'auth'
      ? 'This company file has passwords. Open it and log in to see its backups.'
      : err.message
    : status.data && !status.data.enabled
      ? 'Automatic backups are off for this company (Company > Backup Settings).'
      : 'No automatic backups yet. The first one is made within a minute of opening the company.';

  return (
    <>
      <div className="cx-dlg-body" style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 10 }}>
        <div className="cx-row" style={{ gap: 8 }}>
          <span className="cx-muted">Company</span>
          <Select
            name="company"
            value={cid ?? ''}
            onChange={(v) => setCid(v)}
            options={(files.data ?? []).map((f) => ({ value: f.id, label: f.id === current ? `${f.name} (open now)` : f.name }))}
            width={300}
            aria-label="Company"
          />
        </div>
        <ListView<BackupEntry>
          columns={columns}
          rows={rows}
          getKey={(b) => b.id}
          loading={status.isLoading || files.isLoading}
          selectedKey={sel}
          onSelect={(k) => setSel(Number(k))}
          onActivate={(b) => b.exists && !busy && void restoreNew(b)}
          isInactive={(b) => !b.exists}
          emptyText={emptyText}
          contextMenu={(b) =>
            b && b.exists
              ? [
                  { label: 'Restore as a &new company file...', onClick: () => void restoreNew(b) },
                  { label: '&Replace the company data...', onClick: () => void replace(b) },
                ]
              : []
          }
          aria-label="Automatic backups"
        />
        {status.data && (
          <div className="cx-muted cx-small cx-ellipsis" title={selected?.path || status.data.folderInUse}>
            {selected ? `Location: ${selected.path}` : `Backup folder: ${status.data.folderInUse}`}
          </div>
        )}
      </div>
      <div className="cx-dlg-foot">
        <span className="cx-grow" />
        <Button label="Cancel" onClick={onClose} disabled={busy} />
        <Button label="Replace company data..." disabled={!selected?.exists || busy} onClick={() => selected && void replace(selected)} />
        <Button variant="primary" label="Restore as new..." busy={busy} disabled={!selected?.exists} onClick={() => selected && void restoreNew(selected)} />
      </div>
    </>
  );
}

function FileRestorePane({ onOpen, onClose }: { onOpen: (id: string) => void; onClose: () => void }) {
  const fe = useFormErrors();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);

  const pick = (f: File | null | undefined) => {
    if (!f) return;
    fe.clearAll();
    setFile(f);
    if (!name) setName(f.name.replace(/\.sxb$/i, '').replace(/\s+\d{4}-\d{2}-\d{2}$/, ''));
  };

  const restore = async () => {
    fe.clearAll();
    if (!file) {
      fe.setErrors({ file: 'Choose the backup file to restore.' });
      return;
    }
    setBusy(true);
    try {
      const cf = await api.global.upload<CompanyFile>('/companies/restore', file, name.trim() ? { name: name.trim() } : {}, { noPrompt: true });
      await queryClient.invalidateQueries({ queryKey: ['global', 'companies'] });
      const r = await msgBox({
        title: 'Restore Company',
        icon: 'info',
        message: `The backup was restored as "${cf.name}" (${cf.fileName}).\n\nDo you want to open it now?`,
        buttons: ['Open it', 'Not now'],
      });
      if (r === 'Open it') onOpen(cf.id);
      else onClose();
    } catch (e) {
      fe.fromError(e, { nameField: 'name' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormErrorsProvider value={fe}>
      <div className="cx-dlg-body cx-stack" ref={root} style={{ paddingTop: 12 }}>
        {fe.message && <ErrorBanner message={fe.message} errors={fe.errors} root={root.current} onDismiss={() => fe.setMessage(null)} />}
        <p className="cx-intro" style={{ margin: 0 }}>
          Restoring creates a new company file from a backup (.sxb). Your existing company files are not changed.
        </p>
        <div
          className={'cx-drop' + (drag ? ' cx-drag' : '') + (fe.errors.file ? ' cx-invalid' : '')}
          data-field="file"
          tabIndex={0}
          role="button"
          onClick={() => input.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              input.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            pick(e.dataTransfer.files?.[0]);
          }}
        >
          <UploadCloud size={26} />
          {file ? (
            <div>
              <b>{file.name}</b>
              <div className="cx-muted cx-small">{fmtBytes(file.size)} · click to choose another file</div>
            </div>
          ) : (
            <div>
              <b>Choose a backup file</b>
              <div className="cx-muted cx-small">or drop it here</div>
            </div>
          )}
          <input
            ref={input}
            type="file"
            accept=".sxb,application/octet-stream"
            name="file"
            style={{ display: 'none' }}
            onChange={(e) => {
              pick(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
        {fe.errors.file && (
          <div className="sx-field-msg" role="alert">
            {fe.errors.file}
          </div>
        )}
        <Field label="Save it as" hint="The name of the new company file. The company name stored in the backup is kept." width={360}>
          <TextField name="name" value={name} onChange={setName} placeholder="Company file name" />
        </Field>
      </div>
      <div className="cx-dlg-foot">
        <span className="cx-grow" />
        <Button label="Cancel" onClick={onClose} disabled={busy} />
        <Button variant="primary" label="Restore" busy={busy} onClick={() => void restore()} />
      </div>
    </FormErrorsProvider>
  );
}
