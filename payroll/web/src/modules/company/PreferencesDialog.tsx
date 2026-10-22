// Edit > Preferences in the look of the SerieX Books Preferences dialog, with the payroll
// categories: Payroll & Employees (the company-wide payroll preferences plus
// pay stub printing), SerieX Books (posting and link status) and Access (which SerieX Books users
// may use payroll). props.section opens a category ("payroll", "books", "access").
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BookOpen, ShieldCheck, Users } from 'lucide-react';
import { api } from '@/api/client';
import type { PayrollPrefs } from '@/api/types';
import { DEFAULT_PREFS, invalidateAll, queryClient, useAccess, useBooksStatus, usePrefs } from '@/api/hooks';
import { AccountPicker, Badge, Button, Checkbox, EditDialog, Field, NumberField, RadioGroup, Spinner, confirmBox, toast, useFormErrors, type EditDialogSection } from '@/components';
import { HelpTip } from '@/components/HelpTip';
import { useOptionalWindow } from '@/windows/WindowContext';
import { openWindow } from '@/windows/windowStore';
import { useSession } from '@/state/session';
import { openSerieXBooks } from '@/shell/booksLink';
import './company.css';

export interface PreferencesDialogProps {
  /** Section to show first (e.g. "payroll", "books", "access"). */
  section?: string;
}

const SECTIONS: EditDialogSection[] = [
  {
    key: 'payroll',
    label: 'Payroll & Employees',
    icon: Users,
    fields: [
      'copyEarningsFromPrevious',
      'recallHours',
      'jobCosting',
      'classTracking',
      'displayNameOrder',
      'showSsnOnReports',
      'defaultBankAccountId',
      'warnDuplicateCheckNumbers',
      'dueSoonDays',
      'payStubShowCompanyAddress',
      'payStubShowPto',
      'payStubShowYtd',
      'payStubShowSsnLast4',
    ],
  },
  { key: 'books', label: 'SerieX Books', icon: BookOpen, fields: ['postToBooks'] },
  { key: 'access', label: 'Access', icon: ShieldCheck, fields: ['users'] },
];

function sectionKey(s: string | undefined): string {
  const k = (s ?? '').replace(/[^a-z]/gi, '').toLowerCase();
  if (k.startsWith('book') || k.startsWith('seriex') || k.startsWith('sync')) return 'books';
  if (k.startsWith('access') || k.startsWith('user') || k.startsWith('security')) return 'access';
  return 'payroll';
}

export default function PreferencesDialog({ section }: PreferencesDialogProps) {
  const win = useOptionalWindow();
  const q = usePrefs();
  const access = useAccess();
  const books = useBooksStatus();
  const isAdmin = useSession((s) => s.isAdmin);
  const fe = useFormErrors();
  const [p, setP] = useState<PayrollPrefs | null>(null);
  const [base, setBase] = useState<PayrollPrefs | null>(null);
  const [users, setUsers] = useState<string[] | null>(null);
  const [tab, setTab] = useState(() => sectionKey(section));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (section) setTab(sectionKey(section));
  }, [section]);

  useEffect(() => {
    if (q.data && !p) {
      const start = { ...DEFAULT_PREFS, ...q.data };
      setP(start);
      setBase(start);
    }
  }, [q.data, p]);
  useEffect(() => {
    if (access.data && users === null) setUsers(access.data.users ?? []);
  }, [access.data, users]);

  const prefsDirty = useMemo(() => !!p && !!base && JSON.stringify(p) !== JSON.stringify(base), [p, base]);
  const accessDirty = useMemo(() => {
    if (!users || !access.data) return false;
    const a = [...users].sort().join('|');
    const b = [...(access.data.users ?? [])].sort().join('|');
    return a !== b;
  }, [users, access.data]);
  const dirty = prefsDirty || accessDirty;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  useEffect(() => {
    win?.setDirty(dirty);
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!win) return;
    win.setBeforeClose(async () => (dirtyRef.current ? confirmBox('Discard the changes you made to your preferences?', 'Preferences') : true));
    return () => win.setBeforeClose(null);
  }, [win?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!p) {
    return (
      <div className="cx-dlg" style={{ display: 'grid', placeItems: 'center' }}>
        {q.error ? <span className="cx-muted">{(q.error as Error).message}</span> : <Spinner label="Loading preferences..." />}
      </div>
    );
  }

  const ro = !isAdmin;
  const set = (patch: Partial<PayrollPrefs>) => setP((cur) => (cur ? { ...cur, ...patch } : cur));
  const chk = (key: keyof PayrollPrefs, label: ReactNode, opts: { help?: string; disabled?: boolean; hint?: ReactNode } = {}) => (
    <div>
      <div className="cx-row" style={{ gap: 4 }}>
        <Checkbox name={key} checked={!!p[key]} disabled={opts.disabled || ro} onChange={(v) => set({ [key]: v } as Partial<PayrollPrefs>)} label={label} />
        {opts.help && <HelpTip {...(opts.help.includes(' ') && opts.help.length > 30 ? { text: opts.help } : { term: opts.help })} />}
      </div>
      {opts.hint && (
        <div className="cx-hint" style={{ marginLeft: 24 }}>
          {opts.hint}
        </div>
      )}
    </div>
  );

  const save = async (): Promise<boolean> => {
    fe.clearAll();
    if (ro) {
      await win?.close(true);
      return true;
    }
    if (p.dueSoonDays < 0 || p.dueSoonDays > 90) {
      fe.setErrors({ dueSoonDays: 'Enter a number of days between 0 and 90.' });
      setTab('payroll');
      return false;
    }
    setBusy(true);
    try {
      if (prefsDirty && base) {
        // only the preferences that changed are sent (the server accepts partial bodies)
        const patch: Partial<PayrollPrefs> = {};
        for (const k of Object.keys(p) as (keyof PayrollPrefs)[]) if (JSON.stringify(p[k]) !== JSON.stringify(base[k])) (patch as Record<string, unknown>)[k] = p[k];
        const saved = await api.put<PayrollPrefs>('/prefs', patch);
        queryClient.setQueryData(['prefs'], saved);
        setBase(saved);
        setP(saved);
      }
      if (accessDirty && users) {
        const saved = await api.put<{ users: string[]; booksUsers: { name: string; isAdmin: boolean }[] }>('/access', { users });
        queryClient.setQueryData(['access'], saved);
        setUsers(saved.users);
      }
      dirtyRef.current = false;
      await useSession.getState().reloadCompany();
      void invalidateAll();
      toast('Preferences saved');
      await win?.close(true);
      return true;
    } catch (e) {
      fe.fromError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const bs = books.data;
  const booksUsers = access.data?.booksUsers ?? [];

  return (
    <EditDialog
      title="Preferences"
      errors={fe}
      sections={SECTIONS}
      section={tab}
      onSectionChange={setTab}
      onOk={save}
      busy={busy}
      okLabel={ro ? 'Close' : 'Save and close'}
      navWidth={200}
      footerLeft={
        <span className="cx-muted cx-small">
          {ro ? 'Only a SerieX Books administrator can change the payroll preferences.' : 'These preferences apply to everyone who uses payroll for this company.'}
        </span>
      }
    >
      {tab === 'payroll' && (
        <div className="cx-checks" style={{ gap: 10 }}>
          <div className="cx-section-title">Paychecks</div>
          {chk('copyEarningsFromPrevious', 'Copy earnings details from previous paycheck', {
            hint: 'Pay Employees starts each paycheck with the earnings items and rates of the employee’s last paycheck.',
          })}
          <div className="cx-sub">{chk('recallHours', 'Recall hour field on paychecks', { disabled: !p.copyEarningsFromPrevious })}</div>
          {chk('jobCosting', 'Job costing, class and item tracking for paycheck expenses', {
            hint: 'Paycheck earnings lines get a Customer:Job, so wages show in job profitability reports in SerieX Books.',
          })}
          <div className="cx-row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <span style={{ paddingTop: 2 }}>Assign one class per</span>
            <RadioGroup
              name="classTracking"
              row
              disabled={ro}
              value={p.classTracking}
              onChange={(v) => set({ classTracking: v })}
              options={[
                { value: 'none', label: 'No classes' },
                { value: 'paycheck', label: 'Entire paycheck' },
                { value: 'earnings', label: 'Earnings item' },
              ]}
            />
          </div>
          {chk('warnDuplicateCheckNumbers', 'Warn about duplicate check numbers')}
          <Field label="Bank account for paychecks and tax payments" width={340} hint="Pay Employees and Pay Payroll Taxes start with this SerieX Books bank account.">
            <AccountPicker
              name="defaultBankAccountId"
              types={['Bank']}
              disabled={ro}
              value={p.defaultBankAccountId}
              onChange={(id) => set({ defaultBankAccountId: id })}
              quickCreate={false}
              placeholder="Choose a bank account"
            />
          </Field>

          <div className="cx-section-title">Employees</div>
          <div className="cx-row" style={{ gap: 10 }}>
            <span>Display employee list by</span>
            <RadioGroup
              name="displayNameOrder"
              row
              disabled={ro}
              value={p.displayNameOrder}
              onChange={(v) => set({ displayNameOrder: v })}
              options={[
                { value: 'first', label: 'First name' },
                { value: 'last', label: 'Last name' },
              ]}
            />
          </div>
          {base && p.displayNameOrder !== base.displayNameOrder && (
            <div className="cx-note cx-warn cx-small">The employee lists and the SerieX Books names of new employees use the new order. Finish paying your employees before you change it.</div>
          )}
          {chk('showSsnOnReports', 'Display employee social security numbers on reports', {
            hint: 'Otherwise reports show only the last four digits (XXX-XX-1234).',
          })}
          <div>
            <Button size="sm" label="Employee Defaults..." onClick={() => openWindow('employeeDefaults')} />
            <span className="cx-hint" style={{ marginLeft: 8 }}>
              Pay schedule, earnings, deductions, taxes and sick and vacation settings of new employees.
            </span>
          </div>

          <div className="cx-section-title">Payroll taxes</div>
          <div className="cx-row" style={{ gap: 6 }}>
            <span>Show payroll taxes as due</span>
            <NumberField
              name="dueSoonDays"
              value={p.dueSoonDays}
              width={64}
              decimals={0}
              nullable={false}
              disabled={ro}
              onChange={(v) => set({ dueSoonDays: Math.round(v ?? 0) })}
              aria-label="Days before the due date"
            />
            <span>days before the due date</span>
          </div>

          <div className="cx-section-title">Pay stubs and paycheck vouchers</div>
          {chk('payStubShowCompanyAddress', 'Company address')}
          {chk('payStubShowPto', 'Sick and vacation hours used and available')}
          {chk('payStubShowYtd', 'Year-to-date amounts')}
          {chk('payStubShowSsnLast4', 'Only the last four digits of the social security number')}
        </div>
      )}

      {tab === 'books' && (
        <div className="cx-checks" style={{ gap: 12 }}>
          {chk('postToBooks', 'Post paychecks, tax payments and adjustments to SerieX Books', {
            help: 'Books Sync',
            hint: 'Turn this off only while you enter history. Records saved while it is off wait in Books Sync and are posted when you turn it back on.',
          })}
          <div className="cx-section-title">Link to SerieX Books</div>
          {books.isLoading ? (
            <Spinner />
          ) : bs ? (
            <dl className="cx-kv">
              <dt>Address</dt>
              <dd>{bs.url}</dd>
              <dt>SerieX Books</dt>
              <dd>
                <Badge tone={bs.reachable ? 'success' : 'danger'} dot>
                  {bs.reachable ? 'Running' : 'Not reachable'}
                </Badge>
              </dd>
              <dt>Company file</dt>
              <dd>{bs.companyName || '—'}</dd>
              <dt>Signed in</dt>
              <dd>{bs.sessionOk ? 'Yes' : 'No'}</dd>
              <dt>Not posted yet</dt>
              <dd>
                {bs.pendingCount + bs.errorCount}
                {bs.errorCount > 0 && ` (${bs.errorCount} with problems)`}
              </dd>
              <dt>Status</dt>
              <dd>{bs.message}</dd>
            </dl>
          ) : (
            <div className="cx-muted">{(books.error as Error | null)?.message}</div>
          )}
          <div className="cx-row" style={{ gap: 8 }}>
            <Button size="sm" icon={BookOpen} label="Open SerieX Books" onClick={openSerieXBooks} />
            <Button size="sm" label="Books Sync..." onClick={() => openWindow('booksSync')} />
            <Button size="sm" label="Verify postings..." onClick={() => openWindow('booksSync', { tab: 'verify' })} />
          </div>
        </div>
      )}

      {tab === 'access' && (
        <div className="cx-checks" style={{ gap: 10 }}>
          <div className="cx-intro" style={{ margin: 0 }}>
            People sign in to payroll with their SerieX Books user name and password. SerieX Books administrators can always use payroll; check the other users who
            may use it too.
          </div>
          {access.isLoading ? (
            <Spinner />
          ) : access.error ? (
            <div className="cx-note cx-bad">{(access.error as Error).message}</div>
          ) : (
            <table className="cx-baltable pc-access" data-field="users">
              <thead>
                <tr>
                  <th>SerieX Books user</th>
                  <th>Role</th>
                  <th className="cx-right">Can use payroll</th>
                </tr>
              </thead>
              <tbody>
                {booksUsers.map((u) => {
                  const on = u.isAdmin || (users ?? []).some((x) => x.toLowerCase() === u.name.toLowerCase());
                  return (
                    <tr key={u.name}>
                      <td>{u.name}</td>
                      <td className="cx-muted">{u.isAdmin ? 'Administrator' : 'User'}</td>
                      <td className="cx-right">
                        <input
                          type="checkbox"
                          aria-label={`${u.name} can use payroll`}
                          checked={on}
                          disabled={u.isAdmin || ro}
                          onChange={(e) =>
                            setUsers((cur) => {
                              const list = (cur ?? []).filter((x) => x.toLowerCase() !== u.name.toLowerCase());
                              return e.target.checked ? [...list, u.name] : list;
                            })
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
                {booksUsers.length === 0 && (
                  <tr>
                    <td colSpan={3} className="cx-muted">
                      {books.data && !books.data.reachable
                        ? 'SerieX Books is not running, so its users cannot be listed.'
                        : 'This SerieX Books company has no users with passwords: everyone uses payroll as Admin.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
          <div className="cx-hint">Add users and change passwords in SerieX Books (Company &gt; Set Up Users). Removing a user here signs them out of payroll.</div>
        </div>
      )}
    </EditDialog>
  );
}
