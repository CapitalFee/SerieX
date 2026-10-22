// Sign-in box shown by App when the SerieX Books company has users with passwords, when a
// session expired, or before Set Up Payroll. Payroll has no users of its own: people sign in
// with their SerieX Books user name and password (POST /api/companies/{id}/login).
// Props: companyId, optional message, onDone(token | null, user?, isAdmin?).
import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { api, ApiError } from '@/api/client';
import type { AuthInfo, LoginResult, PayrollCompanyFile } from '@/api/types';
import { Button, Field, FormErrorsProvider, Select, TextField, useFormErrors } from '@/components';
import { AppIcon } from '@/shell/glyphs';
import './company.css';

export interface LoginDialogProps {
  companyId: string;
  /** Message to show (e.g. the session expired). */
  message?: string;
  /** Session token (with the user name and administrator flag) on success, null when cancelled. */
  onDone(token: string | null, user?: string, isAdmin?: boolean): void;
}

const lastUserKey = (companyId: string) => 'sxp.lastUser.' + companyId;

export default function LoginDialog({ companyId, message, onDone }: LoginDialogProps) {
  const [users, setUsers] = useState<string[] | null>(null);
  const [companyName, setCompanyName] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const fe = useFormErrors();
  const pwRef = useRef<HTMLInputElement>(null);
  const cid = encodeURIComponent(companyId);

  useEffect(() => {
    let alive = true;
    api.global
      .get<AuthInfo>(`/companies/${cid}/auth`, { noPrompt: true })
      .then((r) => {
        if (!alive) return;
        const list = r?.users ?? [];
        setUsers(list);
        let last = '';
        try {
          last = localStorage.getItem(lastUserKey(companyId)) ?? '';
        } catch {
          /* ignore */
        }
        setUser(list.includes(last) ? last : (list[0] ?? 'Admin'));
        setTimeout(() => pwRef.current?.focus(), 0);
      })
      .catch((e) => {
        if (!alive) return;
        setUsers([]);
        setUser('Admin');
        fe.setErrors({}, (e as Error).message || 'SerieX Books could not be reached.');
      });
    api.global
      .get<PayrollCompanyFile[]>('/companies', { noPrompt: true })
      .then((l) => alive && setCompanyName(l.find((c) => c.id === companyId)?.name ?? ''))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [cid, companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const ok = async () => {
    fe.clearAll();
    if (!user.trim()) {
      fe.setErrors({ user: 'Enter your SerieX Books user name.' });
      return;
    }
    setBusy(true);
    try {
      const r = await api.global.post<LoginResult>(`/companies/${cid}/login`, { user: user.trim(), password }, { noPrompt: true });
      try {
        localStorage.setItem(lastUserKey(companyId), r.user || user);
      } catch {
        /* ignore */
      }
      onDone(r.token, r.user || user.trim(), r.isAdmin);
    } catch (e) {
      const msg = (e as Error).message || 'You could not be signed in.';
      if (e instanceof ApiError && e.field === 'password') {
        // wrong user name or password: type it again
        fe.setErrors({ password: msg });
        setPassword('');
      } else {
        // signed in to SerieX Books but no access to payroll, or SerieX Books cannot be reached
        fe.setErrors({}, msg);
      }
      setTimeout(() => pwRef.current?.focus(), 0);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="cx-login"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cx-login-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onDone(null);
        }
      }}
    >
      <FormErrorsProvider value={fe}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ok();
          }}
        >
          <div className="cx-login-head">
            <AppIcon size={44} />
            <div style={{ minWidth: 0 }}>
              <div id="cx-login-title" className="cx-login-title">
                Sign in
              </div>
              <div className="cx-login-sub">{companyName || companyId}</div>
            </div>
          </div>
          <div className="cx-login-body">
            {message ? (
              <div className={'cx-note ' + (/expired|ended|no longer|signed out/i.test(message) ? 'cx-warn' : 'cx-info')}>{message}</div>
            ) : (
              <div className="cx-muted">Sign in with your SerieX Books user name and password.</div>
            )}
            {fe.message && <div className="cx-note cx-bad">{fe.message}</div>}
            <Field label="SerieX Books user name">
              {users && users.length > 0 ? (
                <Select name="user" value={user} onChange={setUser} options={users.map((u) => ({ value: u, label: u }))} aria-label="User name" />
              ) : (
                <TextField name="user" value={user} onChange={setUser} autoFocus aria-label="User name" />
              )}
            </Field>
            <Field label="Password">
              <div className="cx-pwwrap">
                <TextField
                  ref={pwRef}
                  name="password"
                  type={show ? 'text' : 'password'}
                  value={password}
                  onChange={setPassword}
                  autoComplete="current-password"
                  aria-label="Password"
                />
                <button
                  type="button"
                  className="cx-pweye"
                  tabIndex={-1}
                  aria-label={show ? 'Hide password' : 'Show password'}
                  title={show ? 'Hide password' : 'Show password'}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setShow((s) => !s)}
                >
                  {show ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </Field>
            <div className="cx-muted cx-small">
              Payroll uses the users of the SerieX Books company file. SerieX Books administrators can always use payroll; other users need access in
              Preferences &gt; Access.
            </div>
          </div>
          <div className="cx-login-foot">
            <Button label="Cancel" onClick={() => onDone(null)} disabled={busy} />
            <Button variant="primary" type="submit" label="Sign in" busy={busy} />
          </div>
        </form>
      </FormErrorsProvider>
    </div>
  );
}
