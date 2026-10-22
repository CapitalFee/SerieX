// Save a backup copy (File menu; downloads a backup file of the open company; the
// server also makes automatic backups, see BackupSettingsDialog), and File > Create Copy (props.mode "copy": saves a copy of the company under a new name in the
// company list, or downloads a backup).
import { useEffect, useState } from 'react';
import { CheckCircle2, Copy, Download, HardDriveDownload } from 'lucide-react';
import { api } from '@/api/client';
import type { CompanyFile } from '@/api/types';
import { queryClient, useCompanyInfo } from '@/api/hooks';
import { Button, Field, FormErrorsProvider, SegmentedControl, Spinner, TextField, toast, useFormErrors } from '@/components';
import { useOptionalWindow } from '@/windows/WindowContext';
import { switchCompany } from '@/state/session';
import { openWindow } from '@/windows/windowStore';
import { backupKindLabel, fmtBytes, fmtDateTime, timeAgo, useBackupStatus, useCompanyFiles } from './shared';
import './company.css';

export interface BackupDialogProps {
  /** "copy": File > Create Copy (save a copy under a new name). */
  mode?: 'backup' | 'copy';
}

type Kind = 'backup' | 'copy';

export default function BackupDialog({ mode }: BackupDialogProps) {
  const win = useOptionalWindow();
  const info = useCompanyInfo();
  const company = info.data ?? null;
  const companyId = company?.companyId ?? null;
  const files = useCompanyFiles();
  const file = files.data?.find((f) => f.id === companyId) ?? null;
  const [kind, setKind] = useState<Kind>(mode === 'copy' ? 'copy' : 'backup');
  const [copyName, setCopyName] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const backups = useBackupStatus();
  const lastBackup = backups.data?.last ?? null;
  const fe = useFormErrors();

  useEffect(() => {
    if (company && !copyName) setCopyName(`${company.name} Copy`);
  }, [company, copyName]);
  useEffect(() => {
    win?.setTitle(kind === 'copy' ? 'Save Copy or Backup' : 'Back Up Company');
    setDone(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  if (!companyId) {
    return (
      <div className="cx-dlg" style={{ display: 'grid', placeItems: 'center' }}>
        {info.isLoading ? <Spinner label="Loading..." /> : <span className="cx-muted">Open a company file first.</span>}
      </div>
    );
  }

  const backup = async () => {
    setBusy(true);
    fe.clearAll();
    try {
      const today = new Date().toISOString().slice(0, 10);
      await api.global.download(`/companies/${encodeURIComponent(companyId)}/backup`, `${company?.name ?? companyId} ${today}.sxb`);
      // the server records the download as the last backup
      void queryClient.invalidateQueries({ queryKey: ['backups'] });
      setDone('backup');
      toast('Backup created. Keep the file somewhere safe, such as another drive or a cloud folder.');
    } catch (e) {
      fe.fromError(e);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    fe.clearAll();
    if (!copyName.trim()) {
      fe.setErrors({ copyName: 'Enter a name for the copy.' });
      return;
    }
    setBusy(true);
    try {
      const cf = await api.global.post<CompanyFile>(`/companies/${encodeURIComponent(companyId)}/copy`, { name: copyName.trim() }, { noPrompt: true });
      await queryClient.invalidateQueries({ queryKey: ['global', 'companies'] });
      setDone('copy');
      toast(`Copy saved as "${cf.name}"`, {
        action: {
          label: 'Open it',
          onClick: () => void switchCompany(cf.id),
        },
      });
      await win?.close(true);
    } catch (e) {
      fe.fromError(e, { nameField: 'copyName' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormErrorsProvider value={fe}>
      <div className="cx-dlg">
        {mode === 'copy' && (
          <div style={{ padding: '12px 20px 0' }}>
            <SegmentedControl<Kind>
              value={kind}
              onChange={setKind}
              aria-label="What do you want to save?"
              options={[
                { value: 'copy', label: 'Copy in my company list', icon: Copy },
                { value: 'backup', label: 'Backup file (download)', icon: HardDriveDownload },
              ]}
            />
          </div>
        )}
        <div className="cx-dlg-body cx-stack">
          {fe.message && <div className="cx-note cx-bad">{fe.message}</div>}
          {kind === 'backup' ? (
            <>
              <p className="cx-intro" style={{ margin: 0 }}>
                A backup is one file with all of your company data. Save it somewhere other than this computer, such as an external drive or a cloud folder, so
                you can restore it if something goes wrong.
              </p>
              <dl className="cx-kv">
                <dt>Company</dt>
                <dd>{company?.name}</dd>
                <dt>Company file</dt>
                <dd>{file ? `${file.fileName} (${fmtBytes(file.size)})` : files.isLoading ? <Spinner /> : companyId}</dd>
                <dt>Last backup</dt>
                <dd>
                  {lastBackup ? (
                    `${timeAgo(lastBackup.time)} (${fmtDateTime(lastBackup.time)}, ${backupKindLabel(lastBackup.kind).toLowerCase()})`
                  ) : backups.data ? (
                    <span style={{ color: 'var(--sx-warning)' }}>No backup made yet</span>
                  ) : (
                    '…'
                  )}
                </dd>
                <dt>Automatic backups</dt>
                <dd>
                  {backups.data ? (backups.data.enabled ? `On, in ${backups.data.folderInUse}` : 'Off') : '…'}{' '}
                  <button type="button" className="sx-linkbtn cx-small" onClick={() => void win?.close().then((ok) => ok && openWindow('backupSettings'))}>
                    Change
                  </button>
                </dd>
              </dl>
              {done === 'backup' && (
                <div className="cx-note cx-ok">
                  <CheckCircle2 size={16} />
                  <div>The backup file was downloaded to your Downloads folder.</div>
                </div>
              )}
            </>
          ) : (
            <>
              <p className="cx-intro" style={{ margin: 0 }}>
                Saves a full copy of "{company?.name}" as another company file in your company list, for example to try something out or to start a new year
                with the same lists.
              </p>
              <Field label="Name of the copy" required width={360}>
                <TextField name="copyName" value={copyName} onChange={setCopyName} autoFocus />
              </Field>
            </>
          )}
        </div>
        <div className="cx-dlg-foot">
          <span className="cx-grow" />
          <Button label={done ? 'Close' : 'Cancel'} variant={done ? 'primary' : 'secondary'} onClick={() => void win?.close()} disabled={busy} />
          {kind === 'backup' ? (
            !done && <Button variant="primary" icon={Download} label="Create backup" busy={busy} onClick={() => void backup()} />
          ) : (
            <Button variant="primary" icon={Copy} label="Save copy" busy={busy} onClick={() => void copy()} />
          )}
        </div>
      </div>
    </FormErrorsProvider>
  );
}
