// Company > Backup Settings: automatic backups of the open company file. The server copies the
// file into the backup folder once a day when it changed, and when the company is closed, and
// keeps the newest ones. Only an administrator can change the settings; others see them read-only.
import { useEffect, useState } from 'react';
import { ArchiveRestore, HardDriveDownload } from 'lucide-react';
import { api } from '@/api/client';
import { queryClient } from '@/api/hooks';
import type { BackupSettings } from '@/api/types';
import { Button, Checkbox, EditDialog, Field, NumberField, Spinner, TextField, msgBox, toast, useFormErrors } from '@/components';
import { useOptionalWindow } from '@/windows/WindowContext';
import { openWindow } from '@/windows/windowStore';
import { backUpNow, backupKindLabel, fmtDateTime, timeAgo, useBackupStatus } from './shared';
import './company.css';

export interface BackupSettingsDialogProps {}

/** "once a day", "every 6 hours", "every 20 seconds" */
function everyText(seconds: number): string {
  if (seconds === 86400) return 'once a day';
  if (seconds % 86400 === 0) return `every ${seconds / 86400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? 'every hour' : `every ${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? 'every minute' : `every ${seconds / 60} minutes`;
  return `every ${seconds} seconds`;
}

export default function BackupSettingsDialog(_props: BackupSettingsDialogProps) {
  const win = useOptionalWindow();
  const st = useBackupStatus();
  const fe = useFormErrors();
  const [enabled, setEnabled] = useState(true);
  const [folder, setFolder] = useState('');
  const [keep, setKeep] = useState<number | null>(14);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const s = st.data;
  const ro = !!s && !s.canChange;

  // the form starts from the settings read when the dialog opens
  useEffect(() => {
    if (s && !loaded) {
      setEnabled(s.enabled);
      setFolder(s.folder);
      setKeep(s.keep);
      setLoaded(true);
    }
  }, [s, loaded]);

  const dirty = loaded && !!s && (enabled !== s.enabled || folder.trim() !== s.folder || keep !== s.keep);
  useEffect(() => {
    win?.setDirty(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  const save = async (): Promise<boolean> => {
    fe.clearAll();
    if (ro || !dirty) {
      await win?.close(true);
      return true;
    }
    if (!keep || keep < 1 || keep > 365 || !Number.isInteger(keep)) {
      fe.setErrors({ keep: 'Keep between 1 and 365 backups.' });
      return false;
    }
    try {
      await api.put<BackupSettings>('/backups/settings', { enabled, folder: folder.trim(), keep }, { noPrompt: true });
      await queryClient.invalidateQueries({ queryKey: ['backups'] });
      toast(enabled ? 'Backup settings saved' : 'Automatic backups turned off', { kind: enabled ? 'success' : 'info' });
      win?.setDirty(false);
      await win?.close(true);
      return true;
    } catch (e) {
      fe.fromError(e, { nameField: 'folder' });
      return false;
    }
  };

  const now = async () => {
    setBusy(true);
    try {
      const e = await backUpNow();
      toast(`Backup saved in the backup folder (${e.file}).`);
    } catch (e) {
      await msgBox({ title: 'Back Up Now', icon: 'error', message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!s || !loaded) {
    return (
      <div className="cx-dlg" style={{ display: 'grid', placeItems: 'center' }}>
        {st.error ? <span className="cx-muted">{(st.error as Error).message}</span> : <Spinner label="Loading..." />}
      </div>
    );
  }

  const inFolder = s.backups.filter((b) => b.exists).length;
  return (
    <EditDialog
      title="Backup Settings"
      errors={fe}
      onOk={save}
      okLabel={ro ? 'Close' : 'OK'}
      footerLeft={<Button icon={HardDriveDownload} label="Back up now" busy={busy} onClick={() => void now()} />}
    >
      <div className="cx-stack" style={{ gap: 12 }}>
        <div className="cx-note cx-info cx-small" role="note">
          <HardDriveDownload size={15} />
          <div>
            {ro
              ? 'Only an administrator can change the backup settings.'
              : `SerieX Books copies the company file into the backup folder ${everyText(s.intervalSeconds)} when something changed, and when you close the company. Older backups are removed so only the newest ones are kept.`}
          </div>
        </div>
        <Checkbox checked={enabled} onChange={setEnabled} disabled={ro} label="Make automatic backups of this company" />
        <Field label="Backup folder" hint={folder.trim() ? 'The full location of the folder.' : `Default: ${s.defaultFolder}`} width="100%">
          <div className="cx-row" style={{ gap: 6 }}>
            <TextField name="folder" value={folder} onChange={setFolder} disabled={ro} placeholder="Default folder" style={{ flex: 1, minWidth: 0 }} />
            {!ro && folder.trim() !== '' && <Button size="sm" label="Use default" onClick={() => setFolder('')} />}
          </div>
        </Field>
        <Field label="Number of backups to keep" width={200}>
          <NumberField name="keep" value={keep} onChange={setKeep} decimals={0} disabled={ro} width={90} align="left" />
        </Field>
        <dl className="cx-kv cx-small" style={{ margin: 0 }}>
          <dt>Last backup</dt>
          <dd>
            {s.last ? (
              <>
                {timeAgo(s.last.time)} ({fmtDateTime(s.last.time)}, {backupKindLabel(s.last.kind).toLowerCase()})
              </>
            ) : (
              <span style={{ color: 'var(--sx-warning)' }}>No backup made yet</span>
            )}
          </dd>
          <dt>In the folder</dt>
          <dd>
            {inFolder === 1 ? '1 backup' : `${inFolder} backups`}{' '}
            {inFolder > 0 && (
              <button
                type="button"
                className="sx-linkbtn"
                onClick={() => void win?.close().then((ok) => ok && openWindow('openCompany', { mode: 'restore' }))}
              >
                <ArchiveRestore size={13} style={{ verticalAlign: '-2px' }} /> Restore one...
              </button>
            )}
          </dd>
          {s.error && (
            <>
              <dt>Problem</dt>
              <dd style={{ color: 'var(--sx-warning)' }}>
                The last automatic backup failed ({fmtDateTime(s.errorTime)}): {s.error}
              </dd>
            </>
          )}
        </dl>
      </div>
    </EditDialog>
  );
}
