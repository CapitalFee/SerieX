// App root: data provider, message boxes, toasts, startup flow (the company asked for by SerieX
// Books' app switcher, else reopen the last company, else the No Company Open screen), login
// dialog and the application frame.
import { lazy, Suspense, useEffect, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/api/hooks';
import { DialogHost } from '@/components/dialogs';
import { ToastHost } from '@/components/toast';
import { AppFrame } from '@/shell/AppFrame';
import { useSession, getLastCompanyId, listCompanies, switchCompany, handleAuthRequired, registerSetupPage, setUpPayroll } from '@/state/session';

const NoCompanyOpen = lazy(() => import('@/modules/company/NoCompanyOpen'));
const LoginDialog = lazy(() => import('@/modules/company/LoginDialog'));

// First page of Payroll Setup (state, EIN, first pay schedule...) shown by session.setUpPayroll();
// the page belongs to the Payroll Setup interview (modules/company) and is loaded when needed.
registerSetupPage((companyId, companyName) => import('@/modules/company/SetupFirstPage').then((m) => m.showFirstPage(companyId, companyName)));

let bootPromise: Promise<void> | null = null;

/** Takes ?company=<id> off the address (set by SerieX Books' app switcher) and returns it. */
function takeCompanyParam(): string | null {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('company')) return null;
    const id = (url.searchParams.get('company') ?? '').trim();
    url.searchParams.delete('company');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    return id || null;
  } catch {
    return null;
  }
}

/**
 * Startup (once per page load). A company asked for in the address (?company=, from SerieX Books'
 * app switcher) wins: it is opened when it has payroll, or the start screen shows with the first
 * Payroll Setup page for it when it has none; an unknown id leaves the start screen. Without
 * ?company= the company that was open last is reopened.
 */
function boot(): Promise<void> {
  if (!bootPromise) {
    bootPromise = (async () => {
      try {
        const wanted = takeCompanyParam();
        const last = getLastCompanyId();
        if (!wanted && !last) return;
        const list = await listCompanies();
        const find = (id: string | null) => (id && Array.isArray(list) ? list.find((c) => c.id === id) : undefined);
        if (wanted) {
          const c = find(wanted);
          if (c?.payrollSetUp) await useSession.getState().openCompany(c.id);
          // No payroll yet: the start screen shows (boot is over) with Set Up Payroll for this company.
          else if (c) window.setTimeout(() => void setUpPayroll(c.id, c.name), 0);
          return;
        }
        if (find(last)?.payrollSetUp) await useSession.getState().openCompany(last!);
      } catch {
        /* server unreachable: show the No Company Open screen */
      }
    })();
  }
  return bootPromise;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Root />
      <DialogHost />
      <ToastHost />
    </QueryClientProvider>
  );
}

function Root() {
  const companyId = useSession((s) => s.companyId);
  const opening = useSession((s) => s.opening);
  const login = useSession((s) => s.login);
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    let alive = true;
    boot().finally(() => alive && setBooted(true));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onAuth = (e: Event) => {
      const d = (e as CustomEvent<{ message?: string; books?: boolean }>).detail;
      void handleAuthRequired(d?.message, !!d?.books);
    };
    window.addEventListener('sx-auth-required', onAuth);
    return () => window.removeEventListener('sx-auth-required', onAuth);
  }, []);

  const showNoCompany = booted && !companyId && !opening && !login;

  return (
    <>
      <AppFrame>
        {showNoCompany && (
          <div className="sx-nocompany-layer">
            <Suspense fallback={null}>
              <NoCompanyOpen onOpened={(id: string) => void switchCompany(id)} />
            </Suspense>
          </div>
        )}
        {(opening || !booted) && !login && <div className="sx-opening">Opening company file...</div>}
      </AppFrame>
      {login && (
        <div className="sx-login-layer">
          <Suspense fallback={null}>
            <LoginDialog
              key={login.companyId}
              companyId={login.companyId}
              message={login.message}
              onDone={(token: string | null, user?: string, isAdmin?: boolean) => login.resolve(token ? { token, user, isAdmin } : null)}
            />
          </Suspense>
        </div>
      )}
    </>
  );
}
