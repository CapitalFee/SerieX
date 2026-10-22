// Company > Set Closing Date: transactions dated on or before the closing date cannot be added,
// changed or deleted unless the closing date password is entered (or confirmed when there is none).
// Only an administrator can set it: for other users the dialog shows the date read-only.
import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { api } from '@/api/client';
import { invalidateAll, queryClient } from '@/api/hooks';
import { Checkbox, DateField, EditDialog, Field, Spinner, TextField, toast, useFormErrors } from '@/components';
import { useOptionalWindow } from '@/windows/WindowContext';
import { openWindow } from '@/windows/windowStore';
import { useSession } from '@/state/session';
import { fmtDate } from '@/util/format';
import { useClosingDate, useIsAdmin } from './shared';
import './company.css';

export interface ClosingDateDialogProps {}

export default function ClosingDateDialog(_props: ClosingDateDialogProps) {
  const win = useOptionalWindow();
  const cur = useClosingDate();
  const fe = useFormErrors();
  const [date, setDate] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [clear, setClear] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const admin = useIsAdmin();
  /** Not an administrator: the closing date is shown but cannot be changed. */
  const ro = admin === false;

  // The form starts from the closing date read when the dialog opens (not a remembered one, which
  // may be out of date when someone else changed it).
  useEffect(() => {
    if (cur.data && !loaded && !cur.isFetching) {
      setDate(cur.data.closingDate || '');
      setLoaded(true);
    }
  }, [cur.data, cur.isFetching, loaded]);

  const hasPassword = !!cur.data?.hasPassword;
  const dirty = loaded && (date !== (cur.data?.closingDate ?? '') || pw !== '' || clear);
  useEffect(() => {
    win?.setDirty(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  const save = async (): Promise<boolean> => {
    fe.clearAll();
    if (ro) {
      await win?.close(true);
      return true;
    }
    if (pw !== pw2) {
      fe.setErrors({ password2: 'The two passwords do not match. Type the same password in both fields.' });
      return false;
    }
    if (pw && !date) {
      fe.setErrors({ closingDate: 'Enter a closing date before setting a password.' });
      return false;
    }
    try {
      const r = await api.put<{ closingDate: string; hasPassword: boolean }>('/closing-date', {
        closingDate: date,
        password: clear ? '' : pw,
        clearPassword: clear,
      });
      queryClient.setQueryData(['closing-date'], r);
      void invalidateAll();
      void useSession.getState().reloadCompany();
      toast(r.closingDate ? `Books closed through ${fmtDate(r.closingDate)}` : 'Closing date removed');
      win?.setDirty(false);
      await win?.close(true);
      return true;
    } catch (e) {
      fe.fromError(e, { nameField: 'closingDate' });
      return false;
    }
  };

  if (cur.isLoading || !loaded || admin === undefined) {
    return (
      <div className="cx-dlg" style={{ display: 'grid', placeItems: 'center' }}>
        {cur.error ? <span className="cx-muted">{(cur.error as Error).message}</span> : <Spinner label="Loading..." />}
      </div>
    );
  }

  return (
    <EditDialog
      title="Closing Date"
      errors={fe}
      onOk={save}
      okLabel={ro ? 'Close' : 'OK'}
      footerLeft={
        // the audit trail is for administrators only
        !ro && (
          <button
            type="button"
            className="sx-linkbtn cx-small"
            onClick={() => {
              void win?.close().then((ok) => ok && openWindow('report', { key: 'audit_trail' }));
            }}
          >
            See changes in the Audit Trail
          </button>
        )
      }
    >
      <div className="cx-stack" style={{ gap: 12 }}>
        <div className="cx-note cx-info cx-small" role="note">
          <Lock size={15} />
          <div>
            {ro
              ? 'Only an administrator can set the closing date and its password.'
              : 'Nobody can add, change or delete transactions dated on or before the closing date without the password. Leave the date empty to keep the books open.'}
          </div>
        </div>
        {ro ? (
          <div>
            {date ? (
              <>
                The books are closed through <b>{fmtDate(date)}</b>
                {hasPassword ? ' (password protected).' : '.'}
              </>
            ) : (
              'No closing date is set: the books are open.'
            )}
          </div>
        ) : (
          <>
            <Field label="Closing date" help="Transactions on or before this date are locked." width={200}>
              <DateField name="closingDate" value={date} onChange={setDate} autoFocus />
            </Field>
            <div className="cx-row" style={{ gap: 12, alignItems: 'flex-start' }}>
              <Field label={hasPassword ? 'New password' : 'Password (recommended)'} width={200}>
                <TextField
                  name="password"
                  type="password"
                  value={pw}
                  disabled={clear}
                  onChange={setPw}
                  autoComplete="new-password"
                  placeholder={hasPassword ? 'Keep the current one' : ''}
                />
              </Field>
              <Field label="Confirm password" width={200}>
                <TextField name="password2" type="password" value={pw2} disabled={clear} onChange={setPw2} autoComplete="new-password" />
              </Field>
            </div>
            {hasPassword && <Checkbox checked={clear} onChange={setClear} label="Remove the closing date password" />}
          </>
        )}
      </div>
    </EditDialog>
  );
}
