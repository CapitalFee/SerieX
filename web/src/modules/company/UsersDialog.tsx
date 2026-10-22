// The user list of the company file with Add / Edit / Delete.
// While no active user has a password the file opens without a login (as "Admin"); once a user
// has a password everybody logs in with a password when the file opens, a user without one cannot
// log in, and the server requires an administrator with a password first.
import { useEffect, useRef, useState } from 'react';
import { KeyRound, ShieldCheck, UserPlus } from 'lucide-react';
import { api, getCompanyId, getSessionToken, setSessionToken } from '@/api/client';
import { invalidateAll, queryClient, saveAiAssistants } from '@/api/hooks';
import type { AiAssistantsStatus, User } from '@/api/types';
import {
  Button,
  Checkbox,
  ErrorBanner,
  Field,
  FormErrorsProvider,
  ListView,
  StatusPill,
  TextField,
  confirmBox,
  msgBox,
  showDialog,
  toast,
  useFormErrors,
  type ListColumn,
} from '@/components';
import { useOptionalWindow } from '@/windows/WindowContext';
import { useSession } from '@/state/session';
import { useUsers } from './shared';
import './company.css';

export interface UsersDialogProps {}

/** Shortest password the server accepts. */
const MIN_PASSWORD = 8;

export default function UsersDialog(_props: UsersDialogProps) {
  const win = useOptionalWindow();
  const users = useUsers();
  const me = useSession((s) => s.user) || 'Admin';
  const [sel, setSel] = useState<number | null>(null);
  const rows = users.data ?? [];
  const selected = rows.find((u) => u.id === sel) ?? null;
  const meRec = rows.find((u) => u.name.toLowerCase() === me.toLowerCase());
  const iAmAdmin = !meRec || meRec.isAdmin;
  const anyPassword = rows.some((u) => u.active && u.hasPassword);

  useEffect(() => {
    if (sel === null && rows.length) setSel(rows[0].id);
  }, [rows, sel]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['users'] });
    void invalidateAll();
    // a password added or removed changes whether the file needs a login
    void useSession.getState().reloadCompany();
  };

  const edit = async (u: User | null) => {
    const hadPassword = anyPassword;
    const res = await showDialog<{ user: User; password: string } | null>({
      title: u ? `Edit User: ${u.name}` : 'Add User',
      cancelValue: null,
      render: (close) => <UserForm user={u} canAdmin={iAmAdmin} loginOn={anyPassword} onDone={close} />,
    });
    if (res) {
      const saved = res.user;
      // the first password turns logins on: stay signed in (as yourself) instead of being asked to log in
      const mine = saved.name.toLowerCase() === me.toLowerCase() || (u !== null && u.name.toLowerCase() === me.toLowerCase());
      await keepSignedIn(mine ? saved.name : me, mine ? res.password : null);
      await refresh();
      setSel(saved.id);
      toast(u ? `User ${saved.name} saved` : `User ${saved.name} added`);
      if (!hadPassword && res.password) await reviewAiSharing();
    }
  };

  const remove = async (u: User) => {
    if (!(await confirmBox(`Delete the user "${u.name}"? They will no longer be able to log in.`, 'Delete User'))) return;
    try {
      await api.del(`/users/${u.id}`);
      setSel(null);
      await refresh();
      toast(`User ${u.name} deleted`, { kind: 'info' });
    } catch (e) {
      if ((e as { code?: string }).code !== 'cancelled') toast((e as Error).message, { kind: 'error', duration: 7000 });
    }
  };

  const columns: ListColumn<User>[] = [
    {
      key: 'name',
      label: 'User name',
      width: 170,
      grow: true,
      render: (u) => (
        <span>
          {u.name}
          {u.name.toLowerCase() === me.toLowerCase() && <span className="cx-muted"> (you)</span>}
        </span>
      ),
    },
    { key: 'role', label: 'Role', width: 120, sortValue: (u) => (u.isAdmin ? 'Administrator' : 'User'), render: (u) => (u.isAdmin ? 'Administrator' : 'User') },
    {
      key: 'pw',
      label: 'Password',
      width: 100,
      sortValue: (u) => (u.hasPassword ? 1 : 0),
      render: (u) => (u.hasPassword ? 'Set' : <span className="cx-muted">None</span>),
    },
    {
      key: 'active',
      label: 'Status',
      width: 90,
      sortValue: (u) => (u.active ? 1 : 0),
      render: (u) => <StatusPill status={u.active ? 'Active' : 'Inactive'} tone={u.active ? 'success' : 'muted'} />,
    },
  ];

  const noPassword = rows.filter((u) => u.active && !u.hasPassword);
  // older company files: while no administrator has a password, an administrator without one
  // still logs in with an empty password (so somebody can manage the users)
  const adminWithPassword = rows.some((u) => u.active && u.isAdmin && u.hasPassword);
  const openAdmins = anyPassword && !adminWithPassword ? noPassword.filter((u) => u.isAdmin) : [];
  const lockedOut = noPassword.filter((u) => !openAdmins.includes(u));

  return (
    <div className="cx-dlg">
      <div className="cx-dlg-body cx-users">
        <div className={'cx-note ' + (anyPassword ? 'cx-ok' : 'cx-info')}>
          {anyPassword ? <ShieldCheck size={16} /> : <KeyRound size={16} />}
          <div>
            {anyPassword
              ? 'Users log in with their name and password when the company file opens.'
              : 'No user has a password yet, so the company file opens without a login: anyone who uses this computer, and any program on it, can open and change these books. Give the Admin user a password to protect them.'}
          </div>
        </div>
        {openAdmins.length > 0 && (
          <div className="cx-note cx-warn">
            <KeyRound size={16} />
            <div>
              {openAdmins.map((u) => u.name).join(', ')} {openAdmins.length === 1 ? 'has' : 'have'} no password, so anyone can log in as{' '}
              {openAdmins.length === 1 ? 'this administrator' : 'these administrators'} with an empty password. Give{' '}
              {openAdmins.length === 1 ? openAdmins[0].name : 'them'} a password now.
            </div>
          </div>
        )}
        {anyPassword && lockedOut.length > 0 && (
          <div className="cx-note cx-warn">
            <KeyRound size={16} />
            <div>
              {lockedOut.map((u) => u.name).join(', ')} {lockedOut.length === 1 ? 'has' : 'have'} no password and cannot log in. Edit the user to set a
              password.
            </div>
          </div>
        )}
        <ListView<User>
          columns={columns}
          rows={rows}
          loading={users.isLoading}
          selectedKey={sel}
          onSelect={(k) => setSel(Number(k))}
          onActivate={(u) => void edit(u)}
          isInactive={(u) => !u.active}
          contextMenu={(u) =>
            u
              ? [
                  { label: '&Edit User...', onClick: () => void edit(u) },
                  { label: '&Delete User', disabled: !iAmAdmin, onClick: () => void remove(u) },
                ]
              : [{ label: '&Add User...', disabled: !iAmAdmin, onClick: () => void edit(null) }]
          }
          aria-label="Users"
          autoFocus
        />
        {!iAmAdmin && <div className="cx-muted cx-small">Only an administrator can add or delete users. You can change your own password.</div>}
      </div>
      <div className="cx-dlg-foot">
        <div className="cx-grow">
          <Button icon={UserPlus} label="&Add User..." disabled={!iAmAdmin} onClick={() => void edit(null)} />
          <Button label="&Edit User..." disabled={!selected} onClick={() => selected && void edit(selected)} />
          <Button label="&Delete User" disabled={!selected || !iAmAdmin} onClick={() => selected && void remove(selected)} />
        </div>
        <Button variant="primary" label="Close" onClick={() => void win?.close()} />
      </div>
    </div>
  );
}

/**
 * After a user change: when logins became required and this browser has no session yet, log in as
 * the current user (with the password just set for them, or none when they have no password), so
 * the administrator keeps working. If that fails the normal login box appears on the next request.
 */
async function keepSignedIn(user: string, newPassword: string | null): Promise<void> {
  const cid = getCompanyId();
  if (!cid || getSessionToken()) return;
  try {
    const auth = await api.global.get<{ required: boolean }>(`/companies/${encodeURIComponent(cid)}/auth`, { noPrompt: true });
    if (!auth.required) return;
    const r = await api.global.post<{ token: string; user: string }>(
      `/companies/${encodeURIComponent(cid)}/login`,
      { user, password: newPassword ?? '' },
      { noPrompt: true },
    );
    setSessionToken(r.token);
    try {
      sessionStorage.setItem('sx.session', JSON.stringify({ companyId: cid, token: r.token, user: r.user || user }));
    } catch {
      /* ignore */
    }
    useSession.setState({ user: r.user || user, authRequired: true });
  } catch {
    /* the login box will ask */
  }
}

/**
 * The company file just got its first password. When it is shared with AI assistants (Company >
 * AI Assistants), the password does not protect it from them: anyone who uses this computer
 * account can still use the file through an assistant. Ask whether to keep sharing it, and say
 * that the access key read before the password stopped working (the server no longer accepts a
 * key made while the file had no passwords).
 */
async function reviewAiSharing(): Promise<void> {
  let st: AiAssistantsStatus;
  try {
    st = await api.get<AiAssistantsStatus>('/ai-assistants', { noPrompt: true });
  } catch {
    return;
  }
  void queryClient.invalidateQueries({ queryKey: ['ai-assistants'] });
  if (!st.available || !st.enabled || !st.isAdmin) return;
  const name = useSession.getState().company?.name || 'This company file';
  const r = await msgBox({
    title: 'AI Assistants',
    icon: 'warning',
    message:
      `${name} is shared with AI assistants, working as ${st.user || 'the administrator'}.\n\n` +
      'The new password does not apply to them: anyone who uses this computer account can still use this company file through an AI assistant, ' +
      'without a password, with the rights of that user.\n\n' +
      'Assistants set up with the web address and the old access key stop working now; give them the new key from AI Assistants.\n\n' +
      'Keep sharing it? To keep it shared with fewer rights, choose another user under AI Assistants.',
    buttons: ['Stop Sharing', 'Keep Sharing'],
    defaultButton: 'Stop Sharing',
    cancelButton: 'Keep Sharing',
    width: 540,
  });
  if (r !== 'Stop Sharing') return;
  try {
    await saveAiAssistants({ enabled: false, allowChanges: false, user: st.users.includes(st.user) ? st.user : '' });
    toast(`AI assistants can no longer use ${name}`, { kind: 'success' });
  } catch (e) {
    toast((e as Error).message, { kind: 'error', duration: 7000 });
  }
}

/** Add / edit user form shown in a message-box style dialog; resolves the saved user and the password typed (or null). */
function UserForm({
  user,
  canAdmin,
  loginOn,
  onDone,
}: {
  user: User | null;
  canAdmin: boolean;
  /** some user already has a password (everybody logs in) */
  loginOn: boolean;
  onDone: (r: { user: User; password: string } | null) => void;
}) {
  const fe = useFormErrors();
  const [name, setName] = useState(user?.name ?? '');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [clearPw, setClearPw] = useState(false);
  const [isAdmin, setIsAdmin] = useState(user?.isAdmin ?? false);
  const [active, setActive] = useState(user?.active ?? true);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLFormElement>(null);

  const submit = async () => {
    fe.clearAll();
    if (!name.trim()) return fe.setErrors({ name: 'Enter a user name.' });
    if (!clearPw && pw && [...pw].length < MIN_PASSWORD) return fe.setErrors({ password: `Use a password of at least ${MIN_PASSWORD} characters.` });
    if (pw !== pw2) return fe.setErrors({ password2: 'The passwords do not match. Type the same password twice.' });
    setBusy(true);
    try {
      const body = { name: name.trim(), password: clearPw ? '' : pw, isAdmin, active, clearPassword: clearPw };
      const saved = user ? await api.put<User>(`/users/${user.id}`, body) : await api.post<User>('/users', body);
      onDone({ user: saved, password: clearPw ? '' : pw });
    } catch (e) {
      fe.fromError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormErrorsProvider value={fe}>
      <form
        ref={root}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="cx-userform">
          {fe.message && <ErrorBanner message={fe.message} root={root.current} onDismiss={() => fe.setMessage(null)} />}
          <Field label="User name" required>
            <TextField name="name" value={name} onChange={setName} autoFocus disabled={!canAdmin} />
          </Field>
          <div className="cx-row" style={{ alignItems: 'flex-start', gap: 12 }}>
            <Field
              label={user?.hasPassword ? 'New password' : 'Password'}
              hint={
                user?.hasPassword
                  ? `At least ${MIN_PASSWORD} characters. Leave empty to keep the current one.`
                  : loginOn
                    ? `At least ${MIN_PASSWORD} characters. Without a password this user cannot log in.`
                    : `At least ${MIN_PASSWORD} characters. Leave empty for no password.`
              }
              width={175}
            >
              <TextField name="password" type="password" value={pw} onChange={setPw} disabled={clearPw} autoComplete="new-password" />
            </Field>
            <Field label="Confirm password" width={175}>
              <TextField name="password2" type="password" value={pw2} onChange={setPw2} disabled={clearPw} autoComplete="new-password" />
            </Field>
          </div>
          {user?.hasPassword && <Checkbox checked={clearPw} onChange={setClearPw} label="Remove this user's password" />}
          <div className="cx-checks">
            <Checkbox checked={isAdmin} onChange={setIsAdmin} disabled={!canAdmin} label="Administrator (full access, sets up users)" />
            <div className="cx-hint" style={{ marginLeft: 24 }}>
              A regular user can enter transactions, use lists and run reports, but cannot change Company Information, company
              preferences, the closing date or users, import lists, or see the audit trail.
            </div>
            <Checkbox checked={active} onChange={setActive} disabled={!canAdmin} label="Active (can log in)" />
          </div>
        </div>
        <div className="sx-dlg-buttons">
          <button type="submit" className="sx-btn sx-btn-primary" disabled={busy}>
            OK
          </button>
          <button type="button" className="sx-btn sx-btn-secondary" onClick={() => onDone(null)}>
            Cancel
          </button>
        </div>
      </form>
    </FormErrorsProvider>
  );
}
