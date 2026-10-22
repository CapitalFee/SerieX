// Login box shown by App when the company file has users with passwords (or a session expired).
// Props: companyId, optional message, onDone(token | null, user?).
import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Lock } from 'lucide-react';
import { api } from '@/api/client';
import { Button, Field, FormErrorsProvider, Select, TextField, useFormErrors } from '@/components';
import type { CompanyFile } from '@/api/types';
import './company.css';

export interface LoginDialogProps {
  companyId: string;
  /** Message to show (e.g. the session expired). */
  message?: string;
  /** token (and the user name) on success, null when cancelled. */
  onDone(token: string | null, user?: string): void;
}

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
      .get<{ required: boolean; users: string[] }>(`/companies/${cid}/auth`, { noPrompt: true })
      .then((r) => {
        if (!alive) return;
        const list = r?.users ?? [];
        setUsers(list);
        let last = '';
        try {
          last = localStorage.getItem('sx.lastUser.' + companyId) ?? '';
        } catch {
          /* ignore */
        }
        setUser(list.includes(last) ? last : (list[0] ?? 'Admin'));
        setTimeout(() => pwRef.current?.focus(), 0);
      })
      .catch(() => alive && setUsers([]));
    api.global
      .get<CompanyFile[]>('/companies', { noPrompt: true })
      .then((l) => alive && setCompanyName(l.find((c) => c.id === companyId)?.name ?? ''))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [cid, companyId]);

  const ok = async () => {
    fe.clearAll();
    if (!user.trim()) {
      fe.setErrors({ user: 'Enter your user name.' });
      return;
    }
    setBusy(true);
    try {
      const r = await api.global.post<{ token: string; user: string }>(`/companies/${cid}/login`, { user: user.trim(), password }, { noPrompt: true });
      try {
        localStorage.setItem('sx.lastUser.' + companyId, r.user || user);
      } catch {
        /* ignore */
      }
      onDone(r.token, r.user || user);
    } catch (e) {
      const msg = (e as Error).message || 'You could not be logged in.';
      fe.setErrors({ password: msg });
      setPassword('');
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
            <div className="cx-logo" aria-hidden="true">
              <Lock size={20} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div id="cx-login-title" className="cx-login-title">
                Log in
              </div>
              <div className="cx-login-sub">{companyName || companyId}</div>
            </div>
          </div>
          <div className="cx-login-body">
            {message && <div className="cx-note cx-warn">{message}</div>}
            <Field label="User name">
              {users && users.length > 0 ? (
                <Select name="user" value={user} onChange={setUser} options={users.map((u) => ({ value: u, label: u }))} />
              ) : (
                <TextField name="user" value={user} onChange={setUser} autoFocus />
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
            <div className="cx-muted cx-small">Forgot your password? Ask an administrator of this company file to set a new one.</div>
          </div>
          <div className="cx-login-foot">
            <Button label="Cancel" onClick={() => onDone(null)} disabled={busy} />
            <Button variant="primary" type="submit" label="Log in" busy={busy} />
          </div>
        </form>
      </FormErrorsProvider>
    </div>
  );
}
