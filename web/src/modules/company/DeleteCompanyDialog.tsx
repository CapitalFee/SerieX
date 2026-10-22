// Delete Company File: one box that confirms (type DELETE) and, for a file with passwords, asks for
// an administrator's user name and password unless the administrator is logged in to it now.
// Works for the company that is open (its windows are closed and it is closed after the delete)
// and for any other file of the list. Automatic backups of the file are kept.
import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/api/client';
import { queryClient } from '@/api/hooks';
import { ErrorBanner, Field, FormErrorsProvider, TextField, showDialog, toast, useFormErrors } from '@/components';
import { MsgBoxIcon } from '@/components/dialogs';
import { forgetRecentCompany, useSession } from '@/state/session';
import { closeAllWindows } from '@/windows/windowStore';

/** The company file to delete (a row of GET /companies). */
export interface DeleteTarget {
  id: string;
  name: string;
  fileName: string;
}

/** Asks for confirmation and deletes the company file. Resolves true when it was deleted. */
export async function deleteCompanyFile(c: DeleteTarget): Promise<boolean> {
  let auth: { required: boolean; users?: string[] } | null = null;
  try {
    auth = await api.global.get(`/companies/${encodeURIComponent(c.id)}/auth`, { noPrompt: true, quiet: true });
  } catch {
    auth = null; // the delete request says what is wrong
  }
  const s = useSession.getState();
  const isOpen = s.companyId === c.id;
  // the administrator logged in to the open company needs no password; the server says when the
  // user logged in is not one, and the box then asks for an administrator's password
  const askLogin = !!auth?.required && !isOpen;
  const deleted = await showDialog<boolean>({
    title: 'Delete Company File',
    width: 500,
    cancelValue: false,
    render: (close) => <DeleteBody target={c} isOpen={isOpen} askLogin={askLogin} users={auth?.users ?? []} onResult={close} />,
  });
  if (deleted) {
    forgetRecentCompany(c.id);
    await queryClient.invalidateQueries({ queryKey: ['global', 'companies'] });
    toast(`Company file "${c.name}" deleted`, { kind: 'info' });
  }
  return deleted;
}

function DeleteBody(props: { target: DeleteTarget; isOpen: boolean; askLogin: boolean; users: string[]; onResult: (deleted: boolean) => void }) {
  const { target: c, isOpen } = props;
  const [askLogin, setAskLogin] = useState(props.askLogin);
  const [typed, setTyped] = useState('');
  const [user, setUser] = useState(props.users.find((u) => u.toLowerCase() === 'admin') ?? props.users[0] ?? 'Admin');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const fe = useFormErrors();
  const typedRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  useEffect(() => typedRef.current?.focus(), []);

  const submit = async () => {
    if (typed.trim().toUpperCase() !== 'DELETE') {
      fe.setErrors({ confirm: 'Type the word DELETE to confirm, or click Cancel to keep the file.' });
      typedRef.current?.focus();
      return;
    }
    if (askLogin && !password) {
      fe.setErrors({ password: "Enter the administrator's password." });
      passwordRef.current?.focus();
      return;
    }
    // the open company: its windows are asked to save first (Cancel there keeps everything)
    if (isOpen && !(await closeAllWindows())) {
      fe.setErrors({}, 'The company file was not deleted because a window was not closed. Close it, then click Delete again.');
      return;
    }
    setBusy(true);
    fe.clearAll();
    try {
      await api.global.post(`/companies/${encodeURIComponent(c.id)}/delete`, askLogin ? { user: user.trim(), password } : {}, { noPrompt: true });
      // the file is gone: close it here without the backup on close and the logout
      if (useSession.getState().companyId === c.id) useSession.getState().closeCompany({ deleted: true });
      props.onResult(true);
    } catch (e) {
      setBusy(false);
      const err = e as ApiError;
      if (err instanceof ApiError && !askLogin && (err.status === 401 || err.status === 403)) {
        // not logged in as an administrator of this file: ask for one's user name and password
        setAskLogin(true);
        fe.setErrors({}, err.message);
        setTimeout(() => passwordRef.current?.focus(), 0);
        return;
      }
      fe.fromError(e);
      if (err instanceof ApiError && err.field === 'password') passwordRef.current?.focus();
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <FormErrorsProvider value={fe}>
        <div className="sx-msgbox-body">
          <div className="sx-msgbox-icon">
            <MsgBoxIcon icon="warning" />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, flex: 1 }}>
            <div className="sx-msgbox-text">
              Delete the company file <b>{c.name}</b> ({c.fileName})?
              {'\n\n'}
              {isOpen ? 'This company is open now. It is closed first. ' : ''}
              All of its data is removed from this computer for good. Its automatic backups are kept in the backup folder, so you can still
              restore it later from File &gt; Open or Restore Company &gt; Restore a backup &gt; A backup file.
            </div>
            <ErrorBanner message={fe.message} />
            <Field label="To confirm, type the word DELETE">
              <TextField ref={typedRef} name="confirm" value={typed} onChange={setTyped} width={200} aria-label="Type DELETE to confirm" />
            </Field>
            {askLogin && (
              <>
                <div className="cx-muted cx-small">This company file has passwords. Enter the user name and password of one of its administrators.</div>
                <Field label="Administrator user name">
                  <TextField name="user" value={user} onChange={setUser} width={200} autoComplete="username" aria-label="Administrator user name" />
                </Field>
                <Field label="Password">
                  <TextField ref={passwordRef} name="password" type="password" value={password} onChange={setPassword} width={200} autoComplete="current-password" aria-label="Administrator password" />
                </Field>
              </>
            )}
          </div>
        </div>
        <div className="sx-dlg-buttons">
          <button type="submit" className="sx-btn sx-btn-danger" disabled={busy}>
            {busy ? 'Deleting...' : 'Delete Company File'}
          </button>
          <button type="button" className="sx-btn sx-btn-secondary" onClick={() => props.onResult(false)} disabled={busy}>
            Cancel
          </button>
        </div>
      </FormErrorsProvider>
    </form>
  );
}
